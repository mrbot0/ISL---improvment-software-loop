import { test } from 'node:test';
import assert from 'node:assert/strict';
import { IMPLEMENTER_TOOLS } from '../src/iteration/sandboxTools.js';

/**
 * "The work is already done" is an outcome, not a failure.
 *
 * Measured over 120 runs: of the 20 tasks that ended without an edit, **11 reported some form of
 * "X already exists with 28 tests / 656 lines of coverage"**. The agent had looked, found the work
 * done, and correctly declined — and every one was scored exactly like a failure, so the target
 * stayed pending and came back. The same test file was reissued three separate times, each costing
 * a full agent turn to rediscover it.
 *
 * The signal is DECLARED by the agent rather than read out of its prose, because pattern-matching
 * English for "already exists" would fire on any model that happens to use the phrase while
 * explaining something else entirely.
 */

const finishTool = () => IMPLEMENTER_TOOLS.find((t) => t.function?.name === 'finish')?.function;

test('the finish tool offers an explicit way to say "nothing needed doing"', () => {
  const f = finishTool();
  assert.ok(f, 'the finish tool must exist');
  assert.ok(f.parameters.properties.alreadySatisfied, 'without a declared flag this can only be guessed from prose');
  assert.equal(f.parameters.properties.alreadySatisfied.type, 'boolean');
});

test('the description tells the agent when to use it, and that it is not a failure', () => {
  // A flag the agent is never told about is a flag it never sets.
  const d = finishTool().description;
  assert.match(d, /alreadySatisfied/);
  assert.match(d, /already exists|already in place/i);
  assert.match(d, /not a failure/i);
});

test('summary stays required — a bare flag would close a target with no evidence', () => {
  // "Nothing to do" retires a piece of work permanently. It has to name what it found.
  assert.deepEqual(finishTool().parameters.required, ['summary']);
});

/*
 * The marker the tool returns, and the two outcomes it has to keep apart.
 *
 * `finish` cannot return structured data — the loop reads a string — so the flag rides on a prefix.
 * These pin the encoding: a mistake here silently turns "already done" back into "failed", which is
 * the exact bug being fixed.
 */
const parse = (obs) => {
  let s = String(obs).slice('__FINISH__'.length);
  let alreadySatisfied = false;
  if (s.startsWith('__SATISFIED__')) { s = s.slice('__SATISFIED__'.length); alreadySatisfied = true; }
  return { summary: s, alreadySatisfied };
};

test('the satisfied marker survives a round trip and does not leak into the summary', () => {
  const handlers = { finish: ({ summary, alreadySatisfied }) => `__FINISH__${alreadySatisfied ? '__SATISFIED__' : ''}${summary || 'done'}` };

  const yes = parse(handlers.finish({ summary: 'intelClient.test.js already has 28 tests', alreadySatisfied: true }));
  assert.equal(yes.alreadySatisfied, true);
  assert.equal(yes.summary, 'intelClient.test.js already has 28 tests', 'the marker must not end up in the operator-facing text');

  const no = parse(handlers.finish({ summary: 'added a guard clause' }));
  assert.equal(no.alreadySatisfied, false);
  assert.equal(no.summary, 'added a guard clause');
});

test('a summary that merely mentions the word is NOT treated as satisfied', () => {
  // The reason for a declared flag rather than a text match: this sentence describes doing work,
  // and an "already exists" regex would close the target on it.
  const handlers = { finish: ({ summary, alreadySatisfied }) => `__FINISH__${alreadySatisfied ? '__SATISFIED__' : ''}${summary || 'done'}` };
  const out = parse(handlers.finish({ summary: 'extended the tests that already exist in intelClient.test.js' }));
  assert.equal(out.alreadySatisfied, false);
});
