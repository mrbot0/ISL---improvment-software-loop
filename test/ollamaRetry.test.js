import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

/**
 * A model server that drops MID-GENERATION must not lose the turn.
 *
 * This is the single largest source of lost work in the system: measured over 120 runs, **120 of
 * 148 failed tasks were `fetch failed`**, split evenly between the two busiest agents. A retry
 * already existed — and wrapped only the request. The response is consumed by streaming the body,
 * so a server that dies after the first token throws from the stream loop, outside the retry
 * entirely. And that is the window that matters: an implementer turn runs for minutes, which is all
 * the time Ollama needs to restart, hit its VRAM limit, or be swapped to another model.
 *
 * The fake server here reproduces exactly that: attempt one sends a token and then destroys the
 * socket; attempt two answers properly.
 */

let server;
let port;
let attempts = 0;
let chat;

const line = (o) => `${JSON.stringify(o)}\n`;

before(async () => {
  server = http.createServer((req, res) => {
    attempts++;
    res.writeHead(200, { 'content-type': 'application/x-ndjson' });
    if (attempts === 1) {
      // A partial turn, then the connection dies — what a mid-generation restart looks like.
      res.write(line({ message: { content: 'par' } }));
      setTimeout(() => res.socket.destroy(), 15);
      return;
    }
    // Shaped like a real Ollama stream: the FINAL chunk carries both the message and `done` with
    // the token counts. An earlier version of this fixture sent `done` on its own, which the parser
    // skips along with every other message-less event — the fixture was wrong, not the parser.
    res.write(line({ message: { content: 'complete ' } }));
    res.write(line({ message: { content: 'answer' }, done: true, prompt_eval_count: 11, eval_count: 22 }));
    res.end();
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  port = server.address().port;

  // The host is read from the environment when config loads, so it must be set before the import.
  process.env.OLLAMA_HOST = `http://127.0.0.1:${port}`;
  ({ chat } = await import('../src/ollama.js'));
});

after(() => new Promise((r) => server.close(r)));

test('a turn that dies mid-stream is retried and returns the complete answer', async () => {
  attempts = 0;
  const out = await chat({ messages: [{ role: 'user', content: 'hi' }], purpose: 'test' });

  assert.equal(attempts, 2, 'the dropped turn must be retried');
  // The decisive assertion: the caller gets the WHOLE second answer, with no trace of the first.
  assert.equal(out.content, 'complete answer');
  assert.ok(!out.content.includes('par'), 'a partial response must never be mixed into its replacement');
  assert.equal(out.usage.promptTokens, 11);
  assert.equal(out.usage.evalTokens, 22);
});

test('the accumulators reset per attempt rather than concatenating', async () => {
  // Without the reset the caller would receive "parcomplete answer" — a response no model produced,
  // which for a tool-calling turn is corrupt input to whatever parses it next.
  attempts = 0;
  const out = await chat({ messages: [{ role: 'user', content: 'hi' }], purpose: 'test' });
  assert.equal(out.content, 'complete answer');
});
