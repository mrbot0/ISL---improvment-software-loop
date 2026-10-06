import { getSetting, setSetting } from '../db.js';
import { ollama, llm, setModelOverrides, ROLE_KEYS } from '../config.js';
import { log } from '../logger.js';

/**
 * MODEL & LLM REGISTRY — pick the brain from the UI, not from env vars.
 *
 * Until now the model for each phase was fixed at boot by environment variables, so changing the
 * planner's model meant editing `.env` and restarting. This makes them first-class settings:
 *
 *   - `detectModels()` probes what is ACTUALLY available (Ollama's installed models, plus any
 *     OpenAI-compatible endpoint that is configured) and reports size, family and whether a model
 *     can embed — so the operator picks from reality instead of typing a name and hoping.
 *   - `getModelConfig()` / `setModelConfig()` persist the choice per ROLE (implement, review,
 *     security, plan, research) plus the chat and embedding models.
 *   - `applyModelConfig()` pushes the saved choice into `config.js`'s live bindings, so a change
 *     takes effect on the NEXT llm call — no restart.
 *
 * Precedence is explicit and shown in the UI: saved setting → environment variable → default.
 */

const lg = log.for('models');

/** Names that are embedding-only models (they cannot chat). Used to keep the UI honest. */
const EMBED_HINT = /(embed|bge|gte|minilm|e5-|nomic-embed)/i;

/** "14B" → 14, "7.6B" → 7.6, "800M" → 0.8. Null when Ollama did not report one. */
function parseParams(s) {
  const m = /^([\d.]+)\s*([BbMm])/.exec(String(s || '').trim());
  if (!m) return null;
  const n = Number(m[1]);
  if (!Number.isFinite(n)) return null;
  return /[Mm]/.test(m[2]) ? Math.round((n / 1000) * 100) / 100 : n;
}

/** Ask Ollama what is installed. */
async function detectOllama() {
  const out = { ok: false, host: ollama.host, models: [], error: null };
  try {
    const res = await fetch(`${ollama.host}/api/tags`, { signal: AbortSignal.timeout(6000) });
    if (!res.ok) { out.error = `HTTP ${res.status}`; return out; }
    const j = await res.json();
    out.ok = true;
    out.models = (j.models || []).map((m) => {
      const d = m.details || {};
      return {
        id: m.name,
        provider: 'ollama',
        sizeGB: m.size ? Math.round((m.size / 1e9) * 10) / 10 : null,
        family: d.family || d.families?.[0] || null,
        params: d.parameter_size || null,
        // The parameter count as a NUMBER, for ranking. Ollama reports it as a string ("14B",
        // "7.6B"), which sorts lexicographically into nonsense — "7.6B" above "14B".
        paramsB: parseParams(d.parameter_size),
        quant: d.quantization_level || null,
        // When this model was last pulled or updated. Kept because "the best local models" is only
        // answerable with it: a model nobody has refreshed in a year is not a current one.
        modifiedAt: m.modified_at || null,
        embedding: EMBED_HINT.test(m.name),
        chat: !EMBED_HINT.test(m.name),
      };
    });
  } catch (e) {
    out.error = e.message;
  }
  return out;
}

/** Ask an OpenAI-compatible endpoint what it serves (only when one is configured). */
async function detectOpenAICompat() {
  if (!llm.baseUrl) return null;
  const out = { ok: false, baseUrl: llm.baseUrl, models: [], error: null };
  try {
    const res = await fetch(`${llm.baseUrl}/models`, {
      headers: llm.apiKey ? { authorization: `Bearer ${llm.apiKey}` } : {},
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) { out.error = `HTTP ${res.status}`; return out; }
    const j = await res.json();
    out.ok = true;
    out.models = (j.data || j.models || []).slice(0, 100).map((m) => ({
      id: m.id || m.name,
      provider: 'openai-compat',
      sizeGB: null,
      family: m.owned_by || null,
      params: null,
      quant: null,
      embedding: EMBED_HINT.test(m.id || m.name || ''),
      chat: !EMBED_HINT.test(m.id || m.name || ''),
    }));
  } catch (e) {
    out.error = e.message;
  }
  return out;
}

/** Which models are currently LOADED in Ollama (warm = fast first token). */
async function loadedModels() {
  try {
    const res = await fetch(`${ollama.host}/api/ps`, { signal: AbortSignal.timeout(4000) });
    if (!res.ok) return [];
    const j = await res.json();
    return (j.models || []).map((m) => ({ id: m.name, vramGB: m.size_vram ? Math.round((m.size_vram / 1e9) * 10) / 10 : null }));
  } catch {
    return [];
  }
}

// Detection touches the network, so the last result is cached and refreshed on demand.
let _cache = null;
export const getDetected = () => _cache;

/** Probe every configured backend for available models. */
export async function detectModels() {
  const [ollamaRes, compat, loaded] = await Promise.all([detectOllama(), detectOpenAICompat(), loadedModels()]);
  const loadedIds = new Set(loaded.map((l) => l.id));
  const models = [
    ...ollamaRes.models.map((m) => ({ ...m, loaded: loadedIds.has(m.id), vramGB: loaded.find((l) => l.id === m.id)?.vramGB ?? null })),
    ...(compat?.models || []),
  ];
  _cache = {
    detectedAt: Date.now(),
    providers: {
      ollama: { ok: ollamaRes.ok, host: ollamaRes.host, error: ollamaRes.error, count: ollamaRes.models.length },
      openaiCompat: compat ? { ok: compat.ok, baseUrl: compat.baseUrl, error: compat.error, count: compat.models.length } : null,
    },
    activeProvider: llm.provider,
    models,
    chatModels: models.filter((m) => m.chat).map((m) => m.id),
    embedModels: models.filter((m) => m.embedding).map((m) => m.id),
  };
  lg.info(`detected ${models.length} model(s) — ${_cache.chatModels.length} chat, ${_cache.embedModels.length} embedding`);
  return _cache;
}

/* ------------------------------- selection -------------------------------- */

const EMPTY = { chat: '', embed: '', roles: {} };

/** The operator's saved model choice (empty string = "use the default"). */
export function getModelConfig() {
  const s = getSetting('modelConfig', null) || {};
  const roles = {};
  for (const r of ROLE_KEYS) roles[r] = typeof s.roles?.[r] === 'string' ? s.roles[r] : '';
  return {
    default: typeof s.default === 'string' ? s.default : '',
    chat: typeof s.chat === 'string' ? s.chat : '',
    embed: typeof s.embed === 'string' ? s.embed : '',
    roles,
  };
}

export function setModelConfig(patch = {}) {
  const cur = getModelConfig();
  const next = {
    default: patch.default != null ? String(patch.default) : cur.default,
    chat: patch.chat != null ? String(patch.chat) : cur.chat,
    embed: patch.embed != null ? String(patch.embed) : cur.embed,
    roles: { ...cur.roles },
  };
  for (const r of ROLE_KEYS) if (patch.roles?.[r] != null) next.roles[r] = String(patch.roles[r]);
  setSetting('modelConfig', next);
  applyModelConfig();
  return getModelConfig();
}

export function resetModelConfig() {
  setSetting('modelConfig', EMPTY);
  applyModelConfig();
  return getModelConfig();
}

/** Push the saved choice into config's live bindings so the next call uses it. */
export function applyModelConfig() {
  try {
    const c = getModelConfig();
    setModelOverrides({ default: c.default, chat: c.chat, embed: c.embed, roles: c.roles });
  } catch (e) {
    lg.warn(`could not apply model config: ${e.message}`);
  }
}

/**
 * What is actually in force for each role, and WHY (setting / env / default) — so the Settings page
 * can show the precedence instead of a bare name.
 */
export function effectiveModels() {
  const c = getModelConfig();
  const envRole = {
    implement: process.env.ISL_MODEL_IMPLEMENT,
    review: process.env.ISL_MODEL_REVIEW,
    security: process.env.ISL_MODEL_SECURITY,
    plan: process.env.ISL_MODEL_PLAN,
    research: process.env.ISL_MODEL_RESEARCH,
  };
  const baseDefault = c.default || process.env.OLLAMA_MODEL || ollama.model;
  const pick = (setting, env, fallback) =>
    setting ? { model: setting, from: 'setting' } : env ? { model: env, from: 'env' } : { model: fallback, from: 'default' };

  const roles = {};
  for (const r of ROLE_KEYS) roles[r] = pick(c.roles[r], envRole[r], baseDefault);
  return {
    default: pick(c.default, process.env.OLLAMA_MODEL, ollama.model),
    chat: pick(c.chat, process.env.OLLAMA_CHAT_MODEL, baseDefault),
    embed: pick(c.embed, process.env.OLLAMA_EMBED_MODEL, ollama.embedModel || ''),
    roles,
    provider: llm.provider,
  };
}

/** Quick liveness probe for one model: can it actually answer? */
export async function testModel(id, { embedding = false } = {}) {
  const started = Date.now();
  try {
    if (embedding) {
      const res = await fetch(`${ollama.host}/api/embeddings`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ model: id, prompt: 'ping' }), signal: AbortSignal.timeout(25_000),
      });
      const j = await res.json();
      const dim = Array.isArray(j.embedding) ? j.embedding.length : 0;
      return { ok: dim > 0, ms: Date.now() - started, detail: dim ? `${dim}-dim embedding` : (j.error || 'no embedding returned') };
    }
    const res = await fetch(`${ollama.host}/api/chat`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: id, stream: false, messages: [{ role: 'user', content: 'Reply with the single word: ok' }] }),
      signal: AbortSignal.timeout(60_000),
    });
    const j = await res.json();
    const text = (j.message?.content || '').trim();
    return { ok: !!text, ms: Date.now() - started, detail: text ? text.slice(0, 60) : (j.error || 'no reply') };
  } catch (e) {
    return { ok: false, ms: Date.now() - started, detail: e.message };
  }
}
