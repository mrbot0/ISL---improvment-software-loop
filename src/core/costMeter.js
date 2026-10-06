import { pdb, getPlatformSetting, setPlatformSetting, audit } from '../platform/platformDb.js';
import { ACTIVE_PROJECT_ID } from '../config.js';

/**
 * COST & CAPACITY GOVERNANCE (ISL_IMPROVE "Enterprise wave", P1).
 *
 * ISL burns model tokens and wall-clock time continuously, and per-role model overrides let an
 * operator quietly point the expensive phases at an expensive model. Nothing measured it and nothing
 * capped it: **health-gated autonomy governs quality, but no governor existed for spend.**
 *
 * One honesty decision shapes this whole module. On a local Ollama the currency cost is
 * approximately zero, so a dashboard reporting "€0.00 spent" would be true and completely useless —
 * the real constraint is TOKENS and TIME. So three resources are metered unconditionally (calls,
 * tokens, milliseconds) and money is derived only where the operator has configured a rate for that
 * model. A budget can be set on any of them, and a budget in a currency nobody configured rates for
 * says so rather than silently never triggering.
 *
 * The meter is written from the same choke point as the egress firewall — every model call in ISL
 * funnels through `ollama.chat()` — so a phase added later is metered by construction.
 */

pdb.exec(`
CREATE TABLE IF NOT EXISTS model_usage (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  ts            INTEGER NOT NULL,
  project_id    TEXT,
  purpose       TEXT NOT NULL,      -- implement | review | chat | embed | …
  provider      TEXT NOT NULL,
  model         TEXT,
  prompt_tokens INTEGER NOT NULL DEFAULT 0,
  eval_tokens   INTEGER NOT NULL DEFAULT 0,
  ms            INTEGER NOT NULL DEFAULT 0,
  failed        INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_usage_ts ON model_usage(ts DESC);
CREATE INDEX IF NOT EXISTS idx_usage_project ON model_usage(project_id, ts DESC);
`);

const RATES_KEY = 'cost.rates';
const BUDGET_KEY = 'cost.budget';

/* --------------------------------- metering -------------------------------- */

/**
 * Record one model call. Never throws — a metering failure must not break the call it is metering,
 * and a loop that died because its accountant fell over would be an absurd failure mode.
 */
export function recordUsage({ purpose = 'unknown', provider = 'ollama', model = null, promptTokens = 0, evalTokens = 0, ms = 0, failed = false } = {}) {
  try {
    pdb.prepare(
      `INSERT INTO model_usage (ts, project_id, purpose, provider, model, prompt_tokens, eval_tokens, ms, failed)
       VALUES (?,?,?,?,?,?,?,?,?)`,
    ).run(Date.now(), ACTIVE_PROJECT_ID, purpose, provider, model, promptTokens | 0, evalTokens | 0, ms | 0, failed ? 1 : 0);
  } catch { /* accounting must never break the work */ }
}

/* ---------------------------------- rates ---------------------------------- */

/**
 * Per-model prices, per 1000 tokens. Absent = that model has no configured price, which is reported
 * as "unpriced" rather than counted as free — a local model IS free, but an unconfigured cloud model
 * is unknown, and conflating the two is how a budget silently never fires.
 */
export function getRates() {
  return getPlatformSetting(RATES_KEY, { currency: 'EUR', models: {} });
}

export function setRates(patch = {}, actor = 'system') {
  const next = { currency: patch.currency || getRates().currency || 'EUR', models: patch.models || {} };
  setPlatformSetting(RATES_KEY, next);
  audit('cost.rates_changed', { actor, detail: { currency: next.currency, priced: Object.keys(next.models).length } });
  return next;
}

/** Cost of one usage row, or null when this model has no configured rate. */
export function costOf(row, rates = getRates()) {
  const r = rates.models?.[row.model];
  if (!r) return null;
  return ((row.prompt_tokens || 0) / 1000) * (r.inPer1k || 0) + ((row.eval_tokens || 0) / 1000) * (r.outPer1k || 0);
}

/* --------------------------------- budgets --------------------------------- */

const DEFAULT_BUDGET = {
  period: 'day', // day | month
  // Null = no cap on that resource. Everything off by default: a control plane that started
  // refusing to work on upgrade because of a guessed budget would be indefensible.
  softTokens: null,
  hardTokens: null,
  softCost: null,
  hardCost: null,
};

export const getBudget = () => ({ ...DEFAULT_BUDGET, ...(getPlatformSetting(BUDGET_KEY, null) || {}) });

export function setBudget(patch = {}, actor = 'system') {
  const next = { ...getBudget(), ...patch };
  if (!['day', 'month'].includes(next.period)) throw new Error(`unknown period: ${next.period}`);
  for (const k of ['softTokens', 'hardTokens', 'softCost', 'hardCost']) {
    if (next[k] != null && !(Number(next[k]) > 0)) throw new Error(`${k} must be a positive number or null`);
    if (next[k] != null) next[k] = Number(next[k]);
  }
  // A hard cap below the soft one would make the soft warning unreachable — almost certainly a typo.
  if (next.softTokens != null && next.hardTokens != null && next.hardTokens < next.softTokens) {
    throw new Error('hardTokens must be greater than or equal to softTokens');
  }
  if (next.softCost != null && next.hardCost != null && next.hardCost < next.softCost) {
    throw new Error('hardCost must be greater than or equal to softCost');
  }
  setPlatformSetting(BUDGET_KEY, next);
  audit('cost.budget_changed', { actor, detail: next });
  return next;
}

const periodStart = (period) => {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  if (period === 'month') d.setDate(1);
  return d.getTime();
};

/** Raw usage rows since a timestamp, for the active project. */
const rowsSince = (since) =>
  pdb.prepare('SELECT * FROM model_usage WHERE ts >= ? AND (project_id IS ? OR ? IS NULL) ORDER BY id DESC')
    .all(since, ACTIVE_PROJECT_ID ?? null, ACTIVE_PROJECT_ID ?? null);

/**
 * What has been consumed this period, and whether a budget threshold is breached.
 *
 * `unpricedCalls` is reported prominently: a cost budget that looks unbreached while most calls went
 * to a model with no configured rate is not a reassurance, it is a measurement gap.
 */
export function budgetState() {
  const budget = getBudget();
  const rates = getRates();
  const since = periodStart(budget.period);
  const rows = rowsSince(since);

  let tokens = 0;
  let ms = 0;
  let cost = 0;
  let unpricedCalls = 0;
  for (const r of rows) {
    tokens += (r.prompt_tokens || 0) + (r.eval_tokens || 0);
    ms += r.ms || 0;
    const c = costOf(r, rates);
    if (c == null) unpricedCalls++;
    else cost += c;
  }

  const over = (used, cap) => cap != null && used >= cap;
  const softBreached = over(tokens, budget.softTokens) || over(cost, budget.softCost);
  const hardBreached = over(tokens, budget.hardTokens) || over(cost, budget.hardCost);

  // Straight-line forecast to the end of the period. Crude on purpose: a sophisticated model of a
  // number the operator can already see trending would be false precision.
  const elapsed = Math.max(1, Date.now() - since);
  const periodMs = budget.period === 'month' ? 30 * 86400_000 : 86400_000;
  const project = (v) => Math.round(v * (periodMs / elapsed));

  return {
    period: budget.period,
    since,
    calls: rows.length,
    tokens,
    ms,
    cost: Math.round(cost * 100) / 100,
    currency: rates.currency,
    unpricedCalls,
    pricedModels: Object.keys(rates.models || {}).length,
    budget,
    softBreached,
    hardBreached,
    forecast: { tokens: project(tokens), cost: Math.round(project(cost) * 100) / 100 },
    reason: hardBreached
      ? `hard budget reached for this ${budget.period} (${tokens.toLocaleString()} tokens${cost ? `, ${cost.toFixed(2)} ${rates.currency}` : ''})`
      : softBreached
        ? `soft budget reached — degrading to cheaper models for the rest of this ${budget.period}`
        : null,
  };
}

/**
 * The gate the engine asks before starting an iteration. Hard breach stops NEW work; anything
 * already running finishes, because killing an iteration mid-flight would leave a half-applied
 * change behind — a far worse outcome than one iteration's worth of overspend.
 */
export function canStartIteration() {
  const s = budgetState();
  return s.hardBreached ? { allowed: false, reason: s.reason, state: s } : { allowed: true, state: s };
}

/* --------------------------------- showback -------------------------------- */

/** Usage split by a dimension, newest period first — what a chargeback report is built from. */
export function usageBreakdown({ period = null, groupBy = 'purpose', limit = 20 } = {}) {
  const p = period || getBudget().period;
  const rows = rowsSince(periodStart(p));
  const rates = getRates();
  const col = { purpose: 'purpose', model: 'model', provider: 'provider' }[groupBy] || 'purpose';

  const by = new Map();
  for (const r of rows) {
    const k = r[col] || '(none)';
    const e = by.get(k) || { key: k, calls: 0, tokens: 0, ms: 0, cost: 0, unpriced: 0 };
    e.calls++;
    e.tokens += (r.prompt_tokens || 0) + (r.eval_tokens || 0);
    e.ms += r.ms || 0;
    const c = costOf(r, rates);
    if (c == null) e.unpriced++;
    else e.cost += c;
    by.set(k, e);
  }
  return [...by.values()]
    .map((e) => ({ ...e, cost: Math.round(e.cost * 100) / 100 }))
    .sort((a, b) => b.tokens - a.tokens)
    .slice(0, limit);
}

/**
 * The two numbers a sponsor actually asks for.
 *
 * Both are honest about their denominators: with no landed change or no health movement in the
 * period, the answer is null — "we spent X and produced nothing measurable yet" — rather than a
 * division that manufactures a reassuring figure.
 */
export function efficiency({ landedChanges = 0, healthDelta = 0 } = {}) {
  const s = budgetState();
  return {
    period: s.period,
    tokens: s.tokens,
    cost: s.cost,
    currency: s.currency,
    landedChanges,
    healthDelta,
    tokensPerLandedChange: landedChanges > 0 ? Math.round(s.tokens / landedChanges) : null,
    costPerLandedChange: landedChanges > 0 && s.cost > 0 ? Math.round((s.cost / landedChanges) * 100) / 100 : null,
    tokensPerHealthPoint: healthDelta > 0 ? Math.round(s.tokens / healthDelta) : null,
    note: s.unpricedCalls
      ? `${s.unpricedCalls} of ${s.calls} call(s) went to a model with no configured rate — the cost figures cover only the priced ones.`
      : null,
  };
}
