import { ollama, ROLE_KEYS } from '../config.js';
import { emit } from '../bus.js';
import { log } from '../logger.js';
import { detectModels, getModelConfig, setModelConfig, applyModelConfig, testModel } from './models.js';

/**
 * PULLING A MODEL, AND PUTTING IT TO WORK.
 *
 * `core/models.js` can already see what is installed and route each role to one of them, but it had
 * no way to obtain a model that is not there yet: the operator had to leave the product, run
 * `ollama pull` in a terminal, and come back. That is the one step where a control plane for an
 * autonomous system should not be sending people to a shell.
 *
 * Two things make this more than a button that shells out:
 *
 *   - **Progress is real.** Ollama streams NDJSON while it downloads; a multi-gigabyte pull with a
 *     spinner and no bytes is indistinguishable from a hang, and the operator's only recourse is to
 *     kill it and lose the download.
 *   - **A model is not adopted until it has answered.** "Applied automatically" must not mean
 *     "assigned on the strength of its name". A pulled model is TESTED with a real completion first;
 *     if it does not answer, it stays installed and unassigned, and the roles keep the model that
 *     works. Handing every agent an untested model is how a working system becomes a broken one in
 *     a single click.
 */

const lg = log.for('model-pull');

/** In-flight pulls by model name. One pull per model; a second request joins the first. */
const active = new Map();

/** A finished pull's last state, kept so the UI can show an outcome after the stream ends. */
const finished = new Map();

const pct = (completed, total) => (total > 0 ? Math.round((completed / total) * 1000) / 10 : null);

/**
 * Download a model into the local Ollama.
 *
 * The request goes to the configured Ollama host — normally 127.0.0.1 — which then fetches the
 * weights from its own registry. ISL itself makes no outbound connection here, and does not choose
 * where the bytes come from; that is Ollama's configuration, not ours.
 */
export function pullModel(name) {
  const model = String(name || '').trim();
  if (!model) return { started: false, error: 'no model name given' };
  if (active.has(model)) return { started: false, already: true, state: active.get(model).state };

  const state = {
    model, status: 'starting', pct: null, completed: 0, total: 0,
    startedAt: Date.now(), finishedAt: null, ok: null, error: null, layer: null,
  };
  const entry = { state, controller: new AbortController() };
  active.set(model, entry);
  finished.delete(model);
  emit('model.pull', { ...state });

  entry.promise = (async () => {
    try {
      const res = await fetch(`${ollama.host}/api/pull`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: model, stream: true }),
        signal: entry.controller.signal,
      });
      if (!res.ok || !res.body) throw new Error(`Ollama answered HTTP ${res.status}`);

      const decoder = new TextDecoder();
      let buffer = '';
      let lastEmit = 0;
      for await (const chunk of res.body) {
        buffer += decoder.decode(chunk, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';
        for (const line of lines) {
          if (!line.trim()) continue;
          let j;
          try { j = JSON.parse(line); } catch { continue; }
          if (j.error) throw new Error(j.error);
          state.status = j.status || state.status;
          // A digest identifies WHICH layer is downloading; without it a multi-layer pull looks
          // like a progress bar that keeps restarting for no reason.
          state.layer = j.digest ? String(j.digest).slice(7, 19) : null;
          if (typeof j.total === 'number') state.total = j.total;
          if (typeof j.completed === 'number') state.completed = j.completed;
          state.pct = pct(state.completed, state.total);
          // Throttled: Ollama emits progress far faster than any UI needs, and every event is a
          // websocket frame to every connected client.
          if (Date.now() - lastEmit > 700) { lastEmit = Date.now(); emit('model.pull', { ...state }); }
        }
      }
      state.ok = true;
      state.status = 'downloaded';
      lg.info(`pulled ${model}`);
    } catch (err) {
      state.ok = false;
      state.error = entry.controller.signal.aborted ? 'cancelled' : err.message;
      state.status = entry.controller.signal.aborted ? 'cancelled' : 'failed';
      lg.warn(`pull of ${model} ${state.status}: ${state.error}`);
    } finally {
      state.finishedAt = Date.now();
      active.delete(model);
      finished.set(model, { ...state });
      emit('model.pull', { ...state });
      // The installed list has changed either way — a failed pull may still have left layers.
      detectModels().catch(() => {});
    }
    return { ...state };
  })();

  return { started: true, state: { ...state } };
}

/** Stop a download in flight. Ollama keeps the layers it already has, so a retry resumes. */
export function cancelPull(name) {
  const entry = active.get(String(name || '').trim());
  if (!entry) return { cancelled: false, reason: 'no pull in flight for that model' };
  entry.controller.abort();
  return { cancelled: true };
}

/** Everything the UI needs to render the pull area: what is downloading and what just finished. */
export function pullStatus() {
  return {
    active: [...active.values()].map((e) => ({ ...e.state })),
    recent: [...finished.values()].sort((a, b) => b.finishedAt - a.finishedAt).slice(0, 8),
  };
}

/**
 * Give a model to the agents — but only after it has demonstrably answered.
 *
 * `roles` defaults to every role. `verify: false` skips the completion test, which exists for the
 * case where the operator has already tested it and wants the assignment anyway; the default is to
 * refuse to assign a model that cannot produce a response, because the failure mode of getting this
 * wrong is every agent in the fleet failing at once, on the next run, for a reason the run record
 * reports as "fetch failed".
 */
export async function adoptModel(name, { roles = ROLE_KEYS, verify = true, alsoChat = false } = {}) {
  const model = String(name || '').trim();
  if (!model) return { adopted: false, error: 'no model name given' };

  const wanted = (Array.isArray(roles) ? roles : [roles]).filter((r) => ROLE_KEYS.includes(r));
  if (!wanted.length) return { adopted: false, error: 'no valid role named' };

  let test = null;
  if (verify) {
    // `testModel` reports its reason in `detail`, not `error` — reading the wrong field here would
    // have put the word "undefined" in front of the operator at the moment they most need to know why.
    test = await testModel(model).catch((e) => ({ ok: false, detail: e.message }));
    if (!test?.ok) {
      return {
        adopted: false,
        tested: test,
        error: `"${model}" did not answer a test prompt (${test?.detail || test?.error || 'no response'}) — the agents keep the model they have`,
      };
    }
  }

  const patch = Object.fromEntries(wanted.map((r) => [r, model]));
  if (alsoChat) patch.chat = model;
  const config = setModelConfig(patch);
  applyModelConfig(); // live bindings — the next call uses it, no restart

  lg.info(`adopted ${model} for ${wanted.join(', ')}${alsoChat ? ' + chat' : ''}`);
  emit('model.adopted', { model, roles: wanted, chat: !!alsoChat });
  return { adopted: true, model, roles: wanted, tested: test, config };
}

/**
 * Pull a model and, once it lands, hand it to the agents — the one-click path.
 *
 * Deliberately sequential and deliberately gated on the test: the whole value of automating this is
 * that the operator does not have to remember the second half, and the whole risk is doing the
 * second half when the first half did not really work.
 */
export async function pullAndAdopt(name, opts = {}) {
  const started = pullModel(name);
  const entry = active.get(String(name || '').trim());
  if (!started.started && !entry) return { ok: false, error: started.error || 'could not start the pull' };

  const state = await (entry?.promise || Promise.resolve(started.state));
  if (!state.ok) return { ok: false, pulled: false, state, error: state.error };

  const adoption = await adoptModel(name, opts);
  return { ok: adoption.adopted, pulled: true, state, adoption };
}

/** The current role → model mapping, for the UI to show what a change would replace. */
export const currentAssignment = () => getModelConfig();

/**
 * The strongest local models you already have, best first.
 *
 * **This does not claim to know which model is better at the work.** It cannot: quality on a given
 * codebase is not a property Ollama reports, and inventing a score out of a name would be a
 * confident guess dressed as a measurement. So the rule is stated rather than hidden, and it is
 * built only from facts the runtime actually provides:
 *
 *   - **Parameter count first.** The one broadly reliable capability proxy, and the reason it needs
 *     parsing rather than sorting: Ollama reports "14B" and "7.6B" as strings, which sort into
 *     nonsense with the smaller model on top.
 *   - **Then how recently it was pulled.** "Aggiornati" is the other half of the question — a model
 *     nobody has refreshed in a year is not a current one, however large.
 *   - **Chat models only.** An embedding model has no parameter count worth comparing and cannot do
 *     any of the roles this page assigns.
 *
 * A model with no reported parameter count is not dropped — it sorts below the ones that have one,
 * because absent information is not evidence of being small.
 */
export function topLocalModels(detected, limit = 5) {
  // `detectModels()` returns `{ models, chatModels, embedModels, providers, … }` — `models` is the
  // array of objects and `chatModels` is a list of ID STRINGS. Reading `detected.ollama.models`
  // (the shape this was first written against, which does not exist) yielded zero every time, on a
  // host with models installed and answering.
  const models = (detected?.models || []).filter((m) => m.chat);
  const ranked = [...models].sort((a, b) => {
    const pa = a.paramsB ?? -1;
    const pb = b.paramsB ?? -1;
    if (pb !== pa) return pb - pa;
    return String(b.modifiedAt || '').localeCompare(String(a.modifiedAt || ''));
  });
  return {
    rule: 'ranked by parameter count, then by how recently it was pulled — not by measured quality, which Ollama does not report',
    models: ranked.slice(0, limit).map((m, i) => ({
      ...m,
      rank: i + 1,
      why: m.paramsB
        ? `${m.paramsB}B parameters${m.modifiedAt ? `, pulled ${new Date(m.modifiedAt).toISOString().slice(0, 10)}` : ''}`
        : 'parameter count not reported by Ollama',
    })),
    total: models.length,
  };
}
