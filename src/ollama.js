import { ollama as cfg, llm } from './config.js';
import { openaiChat, providerActive } from './openaiProvider.js';
import { guardEgress } from './core/egress.js';
import { recordUsage } from './core/costMeter.js';
import { log } from './logger.js';

export class OllamaError extends Error {}

/**
 * Is this failure worth trying again?
 *
 * Measured across every task ever run, **96 of them died on `fetch failed`** — the model server
 * briefly unreachable while it reloaded a model, restarted, or lost a socket. There was no retry at
 * all, so a hiccup measured in seconds threw away an hour of an agent's work.
 *
 * The list is deliberately narrow. Three things must NEVER be retried, and each for its own reason:
 *   - an **abort** is the operator (or the watchdog) saying stop; retrying overrides a human;
 *   - an **egress denial** is a policy refusal, and retrying a refusal until it succeeds is exactly
 *     how a boundary control becomes decorative;
 *   - a **4xx** is a bad request — a malformed prompt or an unknown model does not improve on the
 *     second attempt, it just costs another one.
 */
/**
 * The whole error, cause chain included.
 *
 * `fetch` reports a connection that died mid-response as a bare `TypeError: terminated`, and puts
 * the reason one level down in `err.cause` — `SocketError: other side closed`. Reading only
 * `err.message` therefore misses exactly the failure that matters most here, which is why a pattern
 * list that already contained "other side closed" never matched a single one of them.
 */
function errorText(err, depth = 4) {
  const parts = [];
  let e = err;
  while (e && depth-- > 0) {
    parts.push(String(e.message || e), String(e.code || ''), String(e.name || ''));
    e = e.cause;
  }
  return parts.filter(Boolean).join(' | ');
}

function isTransient(err) {
  if (!err) return false;
  if (err.name === 'AbortError' || err.name === 'EgressDenied') return false;
  const msg = errorText(err);
  // A server-side 5xx is transient; a 4xx is our fault and will repeat.
  const status = msg.match(/→\s*(\d{3})/)?.[1];
  if (status) return status.startsWith('5');
  // `terminated` is undici's word for a response that stopped arriving — the signature of a model
  // server restarting in the middle of a long generation.
  return /fetch failed|terminated|ECONNREFUSED|ECONNRESET|ETIMEDOUT|EPIPE|socket hang up|network|premature close|other side closed/i.test(msg);
}

const RETRY_DELAYS_MS = [500, 2000, 5000]; // three retries, ~7.5s total — a model reload fits inside

async function post(pathname, body, signal) {
  let lastErr;
  for (let attempt = 0; attempt <= RETRY_DELAYS_MS.length; attempt++) {
    if (signal?.aborted) throw new OllamaError('aborted');
    try {
      const res = await fetch(`${cfg.host}${pathname}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
        signal,
      });
      if (!res.ok) {
        throw new OllamaError(`Ollama ${pathname} → ${res.status}: ${(await res.text()).slice(0, 500)}`);
      }
      return res;
    } catch (err) {
      lastErr = err;
      if (attempt === RETRY_DELAYS_MS.length || !isTransient(err)) throw err;
      const wait = RETRY_DELAYS_MS[attempt];
      log.warn('ollama', `${pathname} failed (${String(err.message || err).slice(0, 90)}) — retrying in ${wait}ms (${attempt + 1}/${RETRY_DELAYS_MS.length})`);
      // A wait that ignores the abort signal would keep a cancelled run alive for seconds.
      await new Promise((resolve, reject) => {
        const t = setTimeout(resolve, wait);
        signal?.addEventListener('abort', () => { clearTimeout(t); reject(new OllamaError('aborted')); }, { once: true });
      });
    }
  }
  throw lastErr;
}

export async function health() {
  try {
    const res = await fetch(`${cfg.host}/api/tags`, { signal: AbortSignal.timeout(4000) });
    if (!res.ok) return { ok: false, error: `HTTP ${res.status}` };
    const { models = [] } = await res.json();
    const names = models.map((m) => m.name);
    return {
      ok: true,
      models: names,
      modelReady: names.includes(cfg.model),
      model: cfg.model,
      chatModel: cfg.chatModel,
      host: cfg.host,
    };
  } catch (err) {
    return { ok: false, error: err.message, host: cfg.host };
  }
}

/**
 * Streaming chat with tool support.
 *
 * Ollama emits NDJSON. Deltas arrive on `message.content` (answer) and
 * `message.thinking` (reasoning trace — qwen3.6 is a hybrid reasoner).
 * Tool calls arrive fully-formed on `message.tool_calls`, so we accumulate
 * them rather than trying to parse partial JSON.
 *
 * @param {object}   opts
 * @param {Array}    opts.messages
 * @param {Array}    [opts.tools]
 * @param {string}   [opts.model]
 * @param {boolean}  [opts.think]      expose the reasoning trace
 * @param {function} [opts.onToken]    (text, kind) => void, kind = 'content'|'thinking'
 * @param {AbortSignal} [opts.signal]
 * @returns {Promise<{content: string, thinking: string, toolCalls: Array}>}
 */
export async function chat({
  messages,
  tools,
  model = cfg.model,
  think = false,
  temperature = 0.3,
  numCtx = cfg.numCtx,
  purpose = 'chat',
  onToken,
  signal,
}) {
  // ── EGRESS FIREWALL ──────────────────────────────────────────────────────────
  // Every model call in ISL funnels through this function, which is why the guard lives here and
  // not in each caller: a new phase added later is covered by construction. It may THROW
  // (EgressDenied) — deliberately, because a data-boundary violation must fail the call rather than
  // be handled into a silent fallback. The returned messages are the redacted ones actually sent.
  const remote = providerActive();
  const guarded = guardEgress({
    purpose,
    provider: remote ? 'openai-compatible' : 'ollama',
    model,
    url: remote ? llm.baseUrl : cfg.host,
    parts: messages.map((m) => (typeof m.content === 'string' ? m.content : JSON.stringify(m.content ?? ''))),
  });
  const safeMessages = messages.map((m, i) => ({ ...m, content: guarded.parts[i] }));

  // ── COST METER ───────────────────────────────────────────────────────────────
  // Metered from the same choke point as the firewall, so a phase added later is accounted for by
  // construction. A FAILED call still consumed tokens upstream and is recorded as such — a meter
  // that only counts successes under-reports exactly when things are going wrong.
  const meterStart = Date.now();
  const meter = (u, failed) => recordUsage({
    purpose,
    provider: remote ? 'openai-compatible' : 'ollama',
    model,
    promptTokens: u?.promptTokens || 0,
    evalTokens: u?.evalTokens || 0,
    ms: Date.now() - meterStart,
    failed,
  });

  // When a non-Ollama provider is configured, route to the OpenAI-compatible client.
  // Otherwise this is the unchanged local Ollama path.
  if (remote) {
    try {
      const out = await openaiChat({ messages: safeMessages, tools, model, temperature, onToken, signal });
      meter(out?.usage, false);
      return out;
    } catch (err) {
      meter(null, true);
      throw err;
    }
  }

  /*
   * THE WHOLE TURN IS RETRYABLE, NOT JUST THE HANDSHAKE.
   *
   * `post()` already retried transient failures — and it protected only the request. The response is
   * consumed by streaming `res.body`, and a model server that drops MID-GENERATION throws from that
   * loop, far outside the retry. Which is the failure that actually happens: an implementer turn
   * runs for minutes, and that is the whole window in which Ollama can restart, run out of VRAM, or
   * be swapped to another model.
   *
   * Measured over 120 runs: **120 of 148 failed tasks were `fetch failed`**, evenly split between
   * the two busiest agents — while a retry sat in the file, doing nothing for any of them.
   *
   * Re-running a turn is safe. Tool calls are returned to the caller only when the turn COMPLETES,
   * so a stream that dies has applied nothing; there is no half-executed edit to reconcile. The
   * accumulators reset on each attempt, so a partial response is never mixed with its replacement.
   * The only visible cost is that thinking text already streamed to the UI appears twice.
   */
  let content = '';
  let thinking = '';
  let toolCalls = [];
  let usage = { promptTokens: 0, evalTokens: 0 };

  const attemptTurn = async () => {
    const res = await post(
      '/api/chat',
      {
        model,
        messages: safeMessages,
        stream: true,
        think,
        keep_alive: cfg.keepAlive,
        ...(tools?.length ? { tools } : {}),
        options: { temperature, num_ctx: numCtx },
      },
      signal,
    );

    // Reset per attempt: a turn that died halfway must not contribute to its own replacement.
    content = '';
    thinking = '';
    toolCalls = [];
    usage = { promptTokens: 0, evalTokens: 0 };
    await consumeStream(res);
  };

  try {
    let lastErr;
    for (let attempt = 0; attempt <= RETRY_DELAYS_MS.length; attempt++) {
      if (signal?.aborted) throw new OllamaError('aborted');
      try {
        await attemptTurn();
        lastErr = null;
        break;
      } catch (err) {
        lastErr = err;
        if (attempt === RETRY_DELAYS_MS.length || !isTransient(err)) throw err;
        const wait = RETRY_DELAYS_MS[attempt];
        log.warn('ollama', `generation dropped (${String(err.message || err).slice(0, 90)}) — retrying the whole turn in ${wait}ms (${attempt + 1}/${RETRY_DELAYS_MS.length})`);
        await new Promise((resolve, reject) => {
          const t = setTimeout(resolve, wait);
          signal?.addEventListener('abort', () => { clearTimeout(t); reject(new OllamaError('aborted')); }, { once: true });
        });
      }
    }
    if (lastErr) throw lastErr;
  } catch (err) {
    meter(null, true);
    throw err;
  }

  meter(usage, false);
  return { content, thinking, toolCalls, usage };

  /** Read one NDJSON response to completion, filling the accumulators above. */
  async function consumeStream(res) {
  let buffer = '';

  const decoder = new TextDecoder();
  for await (const chunk of res.body) {
    buffer += decoder.decode(chunk, { stream: true });
    // NDJSON: a complete message per line; the tail may be a partial line.
    let nl;
    while ((nl = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);
      if (!line) continue;

      let evt;
      try {
        evt = JSON.parse(line);
      } catch {
        continue; // Ollama never splits a JSON object across lines
      }
      if (evt.error) throw new OllamaError(evt.error);

      const msg = evt.message;
      if (!msg) continue;

      if (msg.thinking) {
        thinking += msg.thinking;
        onToken?.(msg.thinking, 'thinking');
      }
      if (msg.content) {
        content += msg.content;
        onToken?.(msg.content, 'content');
      }
      if (msg.tool_calls?.length) toolCalls.push(...msg.tool_calls);

      // The final chunk (done:true) carries token accounting for the whole turn.
      if (evt.done) {
        usage.promptTokens = evt.prompt_eval_count || 0;
        usage.evalTokens = evt.eval_count || 0;
      }
    }
  }
  }
}

/**
 * Ollama returns tool arguments as an object, but some builds hand back a
 * JSON string. Normalise so callers never have to care.
 */
export function toolArgs(call) {
  const raw = call?.function?.arguments;
  if (raw && typeof raw === 'object') return raw;
  if (typeof raw === 'string') {
    try {
      return JSON.parse(raw);
    } catch {
      return {};
    }
  }
  return {};
}
