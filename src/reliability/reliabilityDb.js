import { db, registerSchema } from '../db.js';

/**
 * Per-project reliability store. This is where the platform watches its OWN
 * agents: every error they raise, every anomalous iteration, and the improvement
 * signals distilled from those patterns. Registered so it lives in the active
 * project's database alongside the work it observes.
 */
registerSchema(() => {
  db.exec(`
  CREATE TABLE IF NOT EXISTS error_events (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    ts           INTEGER NOT NULL,
    source       TEXT NOT NULL,            -- agent id / 'iteration' / 'verifier' / 'manager:X' / log source
    agent_id     TEXT,
    run_id       INTEGER,
    iteration_id INTEGER,
    category     TEXT NOT NULL DEFAULT 'error', -- error | failure | verify | apply | anomaly | infra
    severity     TEXT NOT NULL DEFAULT 'error', -- info | warn | error | critical
    signature    TEXT NOT NULL,            -- normalised message, for clustering
    message      TEXT NOT NULL,
    detail       TEXT,
    resolved     INTEGER NOT NULL DEFAULT 0
  );
  CREATE INDEX IF NOT EXISTS idx_err_ts ON error_events(id DESC);
  CREATE INDEX IF NOT EXISTS idx_err_sig ON error_events(signature);
  CREATE INDEX IF NOT EXISTS idx_err_agent ON error_events(agent_id);

  CREATE TABLE IF NOT EXISTS anomalies (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    ts           INTEGER NOT NULL,
    kind         TEXT NOT NULL,            -- no_output | repeated_failure | phase_stuck | token_burn | verify_collapse | slow_run
    agent_id     TEXT,
    iteration_id INTEGER,
    severity     TEXT NOT NULL DEFAULT 'warn',
    message      TEXT NOT NULL,
    detail       TEXT,
    resolved     INTEGER NOT NULL DEFAULT 0
  );
  CREATE INDEX IF NOT EXISTS idx_anom_ts ON anomalies(id DESC);

  CREATE TABLE IF NOT EXISTS improvement_signals (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    ts           INTEGER NOT NULL,
    agent_id     TEXT,
    kind         TEXT NOT NULL,            -- objective | scope | reliability | prompt | disable
    recommendation TEXT NOT NULL,
    evidence     TEXT,
    confidence   INTEGER,
    patch        TEXT,                     -- JSON: the concrete change to apply
    apply_to     TEXT NOT NULL DEFAULT 'none', -- agent | control | manager | none
    status       TEXT NOT NULL DEFAULT 'open', -- open | applied | dismissed
    updated_at   INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_sig_status ON improvement_signals(status);
  `);
  // Idempotent migration for DBs created before patch/apply_to existed.
  const cols = new Set(db.prepare('PRAGMA table_info(improvement_signals)').all().map((c) => c.name));
  if (!cols.has('patch')) db.exec('ALTER TABLE improvement_signals ADD COLUMN patch TEXT');
  if (!cols.has('apply_to')) db.exec("ALTER TABLE improvement_signals ADD COLUMN apply_to TEXT NOT NULL DEFAULT 'none'");
});

const now = () => Date.now();

/** Collapse a raw error message to a stable signature for clustering. */
export function signatureOf(message) {
  return String(message || '')
    .toLowerCase()
    .replace(/\b0x[0-9a-f]+\b/g, '0x#')
    .replace(/\b\d+\b/g, '#')
    .replace(/["'`].*?["'`]/g, '"…"')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 200);
}

/* ------------------------------ error events ------------------------------ */

export function recordError(e) {
  const message = String(e.message || 'unknown error').slice(0, 2000);
  db.prepare(
    `INSERT INTO error_events (ts, source, agent_id, run_id, iteration_id, category, severity, signature, message, detail)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    now(),
    e.source || 'unknown',
    e.agentId ?? null,
    e.runId ?? null,
    e.iterationId ?? null,
    e.category || 'error',
    e.severity || 'error',
    signatureOf(e.signature || message),
    message,
    e.detail ? (typeof e.detail === 'string' ? e.detail : JSON.stringify(e.detail)) : null,
  );
}

export const listErrors = ({ limit = 200 } = {}) =>
  db.prepare('SELECT * FROM error_events ORDER BY id DESC LIMIT ?').all(limit);

export function errorClusters({ sinceMs = 0, limit = 20 } = {}) {
  const rows = db
    .prepare(
      `SELECT signature, category,
              COUNT(*) n,
              MAX(ts) last_ts,
              MIN(ts) first_ts,
              GROUP_CONCAT(DISTINCT agent_id) agents,
              MAX(message) sample
       FROM error_events
       WHERE ts >= ? AND resolved = 0
       GROUP BY signature
       ORDER BY n DESC
       LIMIT ?`,
    )
    .all(sinceMs, limit);
  return rows.map((r) => ({
    signature: r.signature,
    category: r.category,
    count: r.n,
    lastTs: r.last_ts,
    firstTs: r.first_ts,
    agents: (r.agents || '').split(',').filter(Boolean),
    sample: r.sample,
  }));
}

export function errorsByAgent({ sinceMs = 0 } = {}) {
  const rows = db
    .prepare(
      `SELECT COALESCE(agent_id, source) k, COUNT(*) n, MAX(ts) last_ts
       FROM error_events WHERE ts >= ? GROUP BY k ORDER BY n DESC`,
    )
    .all(sinceMs);
  return rows.map((r) => ({ agent: r.k, count: r.n, lastTs: r.last_ts }));
}

export const countErrors = ({ sinceMs = 0 } = {}) =>
  db.prepare('SELECT COUNT(*) n FROM error_events WHERE ts >= ?').get(sinceMs).n;

export function resolveErrorsBySignature(signature) {
  return Number(db.prepare('UPDATE error_events SET resolved = 1 WHERE signature = ? AND resolved = 0').run(signature).changes);
}

/* -------------------------------- anomalies ------------------------------- */

export function recordAnomaly(a) {
  db.prepare(
    `INSERT INTO anomalies (ts, kind, agent_id, iteration_id, severity, message, detail)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    now(),
    a.kind,
    a.agentId ?? null,
    a.iterationId ?? null,
    a.severity || 'warn',
    String(a.message || a.kind).slice(0, 1000),
    a.detail ? (typeof a.detail === 'string' ? a.detail : JSON.stringify(a.detail)) : null,
  );
}

export const listAnomalies = ({ onlyOpen = true, limit = 100 } = {}) =>
  db.prepare(`SELECT * FROM anomalies ${onlyOpen ? 'WHERE resolved = 0' : ''} ORDER BY id DESC LIMIT ?`).all(limit);

export const countAnomalies = ({ sinceMs = 0 } = {}) =>
  db.prepare('SELECT COUNT(*) n FROM anomalies WHERE ts >= ? AND resolved = 0').get(sinceMs).n;

/* --------------------------- improvement signals -------------------------- */

const J = (v) => (v == null ? null : JSON.stringify(v));
const P = (v) => {
  if (v == null) return null;
  try {
    return JSON.parse(v);
  } catch {
    return null;
  }
};

export function upsertSignal(s) {
  // Dedupe open signals for the same agent+kind so we advise once, not each tick.
  const existing = db
    .prepare("SELECT id FROM improvement_signals WHERE status = 'open' AND IFNULL(agent_id,'') = IFNULL(?,'') AND kind = ?")
    .get(s.agentId ?? null, s.kind);
  if (existing) {
    db.prepare('UPDATE improvement_signals SET recommendation = ?, evidence = ?, confidence = ?, patch = ?, apply_to = ?, updated_at = ? WHERE id = ?').run(
      s.recommendation,
      s.evidence ?? null,
      s.confidence ?? null,
      J(s.patch),
      s.applyTo || 'none',
      now(),
      existing.id,
    );
    return existing.id;
  }
  const r = db
    .prepare(
      `INSERT INTO improvement_signals (ts, agent_id, kind, recommendation, evidence, confidence, patch, apply_to, status, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'open', ?)`,
    )
    .run(now(), s.agentId ?? null, s.kind, s.recommendation, s.evidence ?? null, s.confidence ?? null, J(s.patch), s.applyTo || 'none', now());
  return Number(r.lastInsertRowid);
}

const rowToSignal = (r) => ({
  id: r.id,
  agentId: r.agent_id,
  kind: r.kind,
  recommendation: r.recommendation,
  evidence: r.evidence,
  confidence: r.confidence,
  patch: P(r.patch),
  applyTo: r.apply_to,
  status: r.status,
  ts: r.ts,
  updatedAt: r.updated_at,
});

export const listSignals = ({ status = 'open', limit = 50 } = {}) =>
  db
    .prepare(`SELECT * FROM improvement_signals ${status ? 'WHERE status = ?' : ''} ORDER BY id DESC LIMIT ?`)
    .all(...(status ? [status, limit] : [limit]))
    .map(rowToSignal);

export function getSignal(id) {
  const r = db.prepare('SELECT * FROM improvement_signals WHERE id = ?').get(id);
  return r ? rowToSignal(r) : null;
}

export function setSignalStatus(id, status) {
  db.prepare('UPDATE improvement_signals SET status = ?, updated_at = ? WHERE id = ?').run(status, now(), id);
}
