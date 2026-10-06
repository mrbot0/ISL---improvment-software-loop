import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { DATA_DIR } from './config.js';

fs.mkdirSync(DATA_DIR, { recursive: true });

/**
 * The active project's SQLite handle. `db` is a Proxy that forwards to it, so
 * every `db.prepare(...)` / `db.exec(...)` call in this codebase (all created
 * per-call, never cached at import) automatically targets whichever project is
 * active. Switching projects is just `openProjectDb(otherProjectsDbPath)`.
 */
let _handle = null;

export const db = new Proxy(
  {},
  {
    get(_t, prop) {
      if (!_handle) throw new Error('No project database is open — call openProjectDb() first.');
      const v = _handle[prop];
      return typeof v === 'function' ? v.bind(_handle) : v;
    },
  },
);

/** Schema initialisers other modules register (e.g. db_iteration.js). */
const _schemaInits = [];
export function registerSchema(fn) {
  _schemaInits.push(fn);
  if (_handle) fn(); // a late registration still applies to an already-open DB
}

/** Open (or switch to) a project database, creating its schema if needed. */
export function openProjectDb(dbPath) {
  closeProjectDb();
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  _handle = new DatabaseSync(dbPath);
  _handle.exec('PRAGMA journal_mode = WAL');
  _handle.exec('PRAGMA foreign_keys = ON');
  initCoreSchema();
  for (const fn of _schemaInits) fn();
  return _handle;
}

export function closeProjectDb() {
  if (_handle) {
    try {
      _handle.close();
    } catch {
      /* already closed */
    }
    _handle = null;
  }
}

export function initCoreSchema() {
  db.exec(`
CREATE TABLE IF NOT EXISTS agents (
  id            TEXT PRIMARY KEY,
  name          TEXT NOT NULL,
  emoji         TEXT NOT NULL DEFAULT '',
  description   TEXT NOT NULL DEFAULT '',
  objective     TEXT NOT NULL DEFAULT '',
  system_prompt TEXT NOT NULL DEFAULT '',
  include_globs TEXT NOT NULL DEFAULT '[]',
  exclude_globs TEXT NOT NULL DEFAULT '[]',
  enabled       INTEGER NOT NULL DEFAULT 1,
  max_proposals INTEGER NOT NULL DEFAULT 2,
  updated_at    INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS runs (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  agent_id     TEXT NOT NULL,
  status       TEXT NOT NULL,              -- running | done | error | cancelled
  trigger      TEXT NOT NULL DEFAULT 'loop', -- loop | manual | chat
  instruction  TEXT,
  summary      TEXT,
  error        TEXT,
  steps        INTEGER NOT NULL DEFAULT 0,
  started_at   INTEGER NOT NULL,
  finished_at  INTEGER
);

CREATE TABLE IF NOT EXISTS proposals (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id        INTEGER NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  agent_id      TEXT NOT NULL,
  title         TEXT NOT NULL,
  rationale     TEXT NOT NULL DEFAULT '',
  severity      TEXT NOT NULL DEFAULT 'medium', -- low | medium | high | critical
  files         TEXT NOT NULL,              -- JSON [{path,newContent,oldContent,isNew}]
  diff          TEXT NOT NULL DEFAULT '',
  additions     INTEGER NOT NULL DEFAULT 0,
  deletions     INTEGER NOT NULL DEFAULT 0,
  status        TEXT NOT NULL DEFAULT 'verifying',
     -- verifying | verified | failed | approved | rejected | applied | apply_failed | stale
  verification  TEXT,                       -- JSON {ok, checks:[{name,ok,exitCode,output,ms}]}
  base_commit   TEXT NOT NULL DEFAULT '',
  applied_ref   TEXT,                       -- branch name or 'working-tree'
  review_note   TEXT,
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_proposals_status ON proposals(status);

CREATE TABLE IF NOT EXISTS events (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  type      TEXT NOT NULL,
  run_id    INTEGER,
  agent_id  TEXT,
  payload   TEXT NOT NULL DEFAULT '{}',
  ts        INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_events_ts ON events(ts DESC);

CREATE TABLE IF NOT EXISTS messages (
  id       INTEGER PRIMARY KEY AUTOINCREMENT,
  role     TEXT NOT NULL,      -- user | assistant | tool
  content  TEXT NOT NULL,
  meta     TEXT NOT NULL DEFAULT '{}',
  ts       INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- Implementation plans an agent commits to BEFORE it edits: the critical task it
-- picked, its approach, the weighed pros/cons and risks. Surfaced in the Plans tab.
CREATE TABLE IF NOT EXISTS plans (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id       INTEGER,
  agent_id     TEXT NOT NULL,
  title        TEXT NOT NULL,
  criticality  TEXT NOT NULL DEFAULT 'medium',  -- low | medium | high | critical
  approach     TEXT NOT NULL DEFAULT '',
  steps        TEXT NOT NULL DEFAULT '[]',
  files        TEXT NOT NULL DEFAULT '[]',
  pros         TEXT NOT NULL DEFAULT '[]',
  cons         TEXT NOT NULL DEFAULT '[]',
  risks        TEXT NOT NULL DEFAULT '',
  status       TEXT NOT NULL DEFAULT 'proposed', -- proposed | executed | abandoned
  proposal_id  INTEGER,
  created_at   INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_plans_run ON plans(run_id);

-- Supervisory manager layer: each manager keeps one live brief and exchanges
-- coordination messages with its peers. Both are durable so the dashboard can
-- render them after a restart.
CREATE TABLE IF NOT EXISTS manager_briefs (
  name       TEXT PRIMARY KEY,
  brief      TEXT NOT NULL,       -- JSON {status, headline, summary, stats, ...}
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS manager_messages (
  id       INTEGER PRIMARY KEY AUTOINCREMENT,
  sender   TEXT NOT NULL,
  target   TEXT NOT NULL,         -- peer name or 'broadcast'
  kind     TEXT NOT NULL,         -- alert | report | request | recommendation | heartbeat | decision
  severity TEXT NOT NULL DEFAULT 'info', -- info | warn | error | critical
  title    TEXT,
  payload  TEXT NOT NULL DEFAULT '{}',
  ts       INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_mgrmsg_ts ON manager_messages(ts DESC);

-- Structured application log — separate from the semantic event feed. This is
-- the "logs" tab: level-filterable, source-tagged lines for operators.
CREATE TABLE IF NOT EXISTS logs (
  id       INTEGER PRIMARY KEY AUTOINCREMENT,
  ts       INTEGER NOT NULL,
  level    TEXT NOT NULL,         -- debug | info | warn | error
  source   TEXT NOT NULL,         -- agent id, 'orchestrator', 'verifier', 'manager:Quality', …
  message  TEXT NOT NULL,
  agent_id TEXT,
  run_id   INTEGER,
  data     TEXT
);
CREATE INDEX IF NOT EXISTS idx_logs_ts ON logs(id DESC);
CREATE INDEX IF NOT EXISTS idx_logs_level ON logs(level);
`);

/**
 * Idempotent column migrations. node:sqlite has no "ADD COLUMN IF NOT EXISTS",
 * so we diff against table_info and add what is missing. Safe to run every boot.
 */
function ensureColumns(table, columns) {
  const have = new Set(db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name));
  for (const [name, decl] of Object.entries(columns)) {
    if (!have.has(name)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${decl}`);
  }
}

ensureColumns('runs', {
  tokens_in: 'INTEGER NOT NULL DEFAULT 0',
  tokens_out: 'INTEGER NOT NULL DEFAULT 0',
  llm_calls: 'INTEGER NOT NULL DEFAULT 0',
});
ensureColumns('proposals', {
  confidence: 'INTEGER', // agent self-rated 0-100, nullable
});
}

const now = () => Date.now();
const J = (v) => JSON.stringify(v ?? null);
const P = (v, dflt = null) => {
  if (v === null || v === undefined) return dflt;
  try {
    return JSON.parse(v);
  } catch {
    return dflt;
  }
};

/* ------------------------------- settings -------------------------------- */

export function getSetting(key, dflt = null) {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
  return row ? P(row.value, dflt) : dflt;
}

export function setSetting(key, value) {
  db.prepare(
    'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
  ).run(key, J(value));
  return value;
}

/* -------------------------------- agents --------------------------------- */

const rowToAgent = (r) => ({
  id: r.id,
  name: r.name,
  emoji: r.emoji,
  description: r.description,
  objective: r.objective,
  systemPrompt: r.system_prompt,
  scope: { include: P(r.include_globs, []), exclude: P(r.exclude_globs, []) },
  enabled: !!r.enabled,
  maxProposals: r.max_proposals,
  updatedAt: r.updated_at,
});

export function upsertAgent(a) {
  db.prepare(
    `INSERT INTO agents (id, name, emoji, description, objective, system_prompt,
                         include_globs, exclude_globs, enabled, max_proposals, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       name = excluded.name,
       emoji = excluded.emoji,
       description = excluded.description,
       system_prompt = excluded.system_prompt,
       updated_at = excluded.updated_at`,
  ).run(
    a.id,
    a.name,
    a.emoji ?? '',
    a.description ?? '',
    a.objective ?? '',
    a.systemPrompt ?? '',
    J(a.scope?.include ?? []),
    J(a.scope?.exclude ?? []),
    a.enabled === false ? 0 : 1,
    a.maxProposals ?? 2,
    now(),
  );
}

export const listAgents = () =>
  db.prepare('SELECT * FROM agents ORDER BY id').all().map(rowToAgent);

export function getAgent(id) {
  const r = db.prepare('SELECT * FROM agents WHERE id = ?').get(id);
  return r ? rowToAgent(r) : null;
}

/** Runtime-editable fields — this is what the dashboard and the chatbot mutate. */
export function updateAgent(id, patch) {
  const cur = getAgent(id);
  if (!cur) throw new Error(`Unknown agent: ${id}`);
  const next = {
    objective: patch.objective ?? cur.objective,
    enabled: patch.enabled ?? cur.enabled,
    maxProposals: patch.maxProposals ?? cur.maxProposals,
    include: patch.scope?.include ?? cur.scope.include,
    exclude: patch.scope?.exclude ?? cur.scope.exclude,
  };
  db.prepare(
    `UPDATE agents SET objective = ?, enabled = ?, max_proposals = ?,
       include_globs = ?, exclude_globs = ?, updated_at = ? WHERE id = ?`,
  ).run(
    next.objective,
    next.enabled ? 1 : 0,
    next.maxProposals,
    J(next.include),
    J(next.exclude),
    now(),
    id,
  );
  return getAgent(id);
}

/* --------------------------------- runs ---------------------------------- */

export function createRun(agentId, trigger, instruction = null) {
  const r = db
    .prepare('INSERT INTO runs (agent_id, status, trigger, instruction, started_at) VALUES (?, ?, ?, ?, ?)')
    .run(agentId, 'running', trigger, instruction, now());
  return Number(r.lastInsertRowid);
}

export function finishRun(id, { status, summary = null, error = null, steps = 0, tokensIn = 0, tokensOut = 0, llmCalls = 0 }) {
  db.prepare(
    `UPDATE runs SET status = ?, summary = ?, error = ?, steps = ?,
       tokens_in = ?, tokens_out = ?, llm_calls = ?, finished_at = ? WHERE id = ?`,
  ).run(status, summary, error, steps, tokensIn, tokensOut, llmCalls, now(), id);
}

export const listRuns = (limit = 50) =>
  db
    .prepare('SELECT * FROM runs ORDER BY id DESC LIMIT ?')
    .all(limit)
    .map((r) => ({
      id: r.id,
      agentId: r.agent_id,
      status: r.status,
      trigger: r.trigger,
      instruction: r.instruction,
      summary: r.summary,
      error: r.error,
      steps: r.steps,
      tokensIn: r.tokens_in,
      tokensOut: r.tokens_out,
      llmCalls: r.llm_calls,
      startedAt: r.started_at,
      finishedAt: r.finished_at,
      durationMs: r.finished_at ? r.finished_at - r.started_at : null,
    }));

/** A crashed process can leave runs stuck in `running`. Clear them on boot. */
export const reapStaleRuns = () =>
  db.prepare("UPDATE runs SET status = 'error', error = 'interrupted by restart', finished_at = ? WHERE status = 'running'").run(now())
    .changes;

/* ------------------------------- proposals -------------------------------- */

const rowToProposal = (r, { withFiles = false } = {}) => ({
  id: r.id,
  runId: r.run_id,
  agentId: r.agent_id,
  title: r.title,
  rationale: r.rationale,
  severity: r.severity,
  confidence: r.confidence ?? null,
  status: r.status,
  additions: r.additions,
  deletions: r.deletions,
  verification: P(r.verification),
  baseCommit: r.base_commit,
  appliedRef: r.applied_ref,
  reviewNote: r.review_note,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
  paths: P(r.files, []).map((f) => f.path),
  // The full unified diff is heavy (kilobytes each) and the list views never render
  // it — it's shown only when a proposal is opened, which fetches the detail. Sending
  // it for all 60 proposals on every /api/state refetch was ~185 KB of pure waste on
  // the hot path. Include it only with the detail.
  ...(withFiles ? { diff: r.diff, files: P(r.files, []) } : {}),
});

export function createProposal(p) {
  const t = now();
  const r = db
    .prepare(
      `INSERT INTO proposals (run_id, agent_id, title, rationale, severity, confidence, files, diff,
                              additions, deletions, status, base_commit, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'verifying', ?, ?, ?)`,
    )
    .run(
      p.runId,
      p.agentId,
      p.title,
      p.rationale ?? '',
      p.severity ?? 'medium',
      p.confidence ?? null,
      J(p.files),
      p.diff ?? '',
      p.additions ?? 0,
      p.deletions ?? 0,
      p.baseCommit ?? '',
      t,
      t,
    );
  return Number(r.lastInsertRowid);
}

export function setProposalStatus(id, status, extra = {}) {
  const fields = ['status = ?', 'updated_at = ?'];
  const values = [status, now()];
  if ('verification' in extra) {
    fields.splice(1, 0, 'verification = ?');
    values.splice(1, 0, J(extra.verification));
  }
  if ('appliedRef' in extra) {
    fields.splice(1, 0, 'applied_ref = ?');
    values.splice(1, 0, extra.appliedRef);
  }
  if ('reviewNote' in extra) {
    fields.splice(1, 0, 'review_note = ?');
    values.splice(1, 0, extra.reviewNote);
  }
  db.prepare(`UPDATE proposals SET ${fields.join(', ')} WHERE id = ?`).run(...values, id);
  return getProposal(id);
}

export function getProposal(id, opts) {
  const r = db.prepare('SELECT * FROM proposals WHERE id = ?').get(id);
  return r ? rowToProposal(r, opts) : null;
}

export function listProposals({ status, agentId, limit = 100 } = {}) {
  const where = [];
  const args = [];
  if (status) {
    const list = Array.isArray(status) ? status : [status];
    where.push(`status IN (${list.map(() => '?').join(',')})`);
    args.push(...list);
  }
  if (agentId) {
    where.push('agent_id = ?');
    args.push(agentId);
  }
  const sql = `SELECT * FROM proposals ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY id DESC LIMIT ?`;
  return db
    .prepare(sql)
    .all(...args, limit)
    .map((r) => rowToProposal(r));
}

/** Proposals awaiting a human decision (this is what gates further agent work). */
export const countPending = () =>
  db.prepare("SELECT COUNT(*) AS n FROM proposals WHERE status IN ('verifying','verified','failed')").get().n;

/* --------------------------------- plans ---------------------------------- */

export function createPlan(p) {
  const r = db
    .prepare(
      `INSERT INTO plans (run_id, agent_id, title, criticality, approach, steps, files, pros, cons, risks, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      p.runId ?? null,
      p.agentId,
      p.title,
      p.criticality || 'medium',
      p.approach || '',
      J(p.steps || []),
      J(p.files || []),
      J(p.pros || []),
      J(p.cons || []),
      p.risks || '',
      now(),
    );
  return Number(r.lastInsertRowid);
}

export function linkPlanProposal(planId, proposalId) {
  db.prepare("UPDATE plans SET proposal_id = ?, status = 'executed' WHERE id = ?").run(proposalId, planId);
}

const rowToPlan = (r) => ({
  id: r.id,
  runId: r.run_id,
  agentId: r.agent_id,
  title: r.title,
  criticality: r.criticality,
  approach: r.approach,
  steps: P(r.steps, []),
  files: P(r.files, []),
  pros: P(r.pros, []),
  cons: P(r.cons, []),
  risks: r.risks,
  status: r.status,
  proposalId: r.proposal_id,
  createdAt: r.created_at,
});

export const listPlans = (limit = 50) =>
  db.prepare('SELECT * FROM plans ORDER BY id DESC LIMIT ?').all(limit).map(rowToPlan);

const CRITICALITY_RANK = { critical: 3, high: 2, medium: 1, low: 0 };
export const countPlansByCriticality = () => {
  const out = { critical: 0, high: 0, medium: 0, low: 0 };
  for (const r of db.prepare('SELECT criticality, COUNT(*) n FROM plans GROUP BY criticality').all()) out[r.criticality] = r.n;
  return out;
};

/**
 * Reflection memory: short lessons distilled from this agent's recent rejected
 * proposals (the human's review note) and failed verifications (the failing check).
 * Injected into the agent's prompt so it stops repeating the same mistakes.
 */
export function getAgentLessons(agentId, limit = 5) {
  const lessons = [];
  const rejected = db
    .prepare("SELECT title, review_note FROM proposals WHERE agent_id = ? AND status = 'rejected' AND review_note IS NOT NULL AND review_note != '' ORDER BY id DESC LIMIT 3")
    .all(agentId);
  for (const r of rejected) lessons.push(`A proposal "${r.title}" was rejected: ${String(r.review_note).slice(0, 160)}`);

  const failed = db
    .prepare("SELECT title, verification FROM proposals WHERE agent_id = ? AND status = 'failed' ORDER BY id DESC LIMIT 3")
    .all(agentId);
  for (const r of failed) {
    const v = P(r.verification);
    const bad = v?.checks?.find((c) => !c.ok);
    if (bad) lessons.push(`"${r.title}" failed verification at ${bad.name} — verify with verify_change before proposing.`);
  }
  return lessons.slice(0, limit);
}

/**
 * Playbooks: the positive counterpart to lessons. What kinds of change this agent
 * has gotten APPROVED — so it leans into the patterns that land, not just away
 * from the ones that don't.
 */
export function getAgentPlaybooks(agentId, limit = 4) {
  return db
    .prepare("SELECT title FROM proposals WHERE agent_id = ? AND status IN ('approved','applied') ORDER BY id DESC LIMIT ?")
    .all(agentId, limit)
    .map((r) => r.title);
}

/**
 * A proposal built against an old commit can no longer be trusted to apply
 * cleanly. Mark everything not based on `commit` as stale.
 */
export const markStaleProposals = (commit) =>
  db
    .prepare(
      "UPDATE proposals SET status = 'stale', updated_at = ? WHERE base_commit != ? AND status IN ('verifying','verified','failed')",
    )
    .run(now(), commit).changes;

/* -------------------------------- events ---------------------------------- */

export function recordEvent(type, runId, agentId, payload) {
  const r = db
    .prepare('INSERT INTO events (type, run_id, agent_id, payload, ts) VALUES (?, ?, ?, ?, ?)')
    .run(type, runId, agentId, J(payload), now());
  return Number(r.lastInsertRowid);
}

export const listEvents = (limit = 200) =>
  db
    .prepare('SELECT * FROM events ORDER BY id DESC LIMIT ?')
    .all(limit)
    .map((r) => ({ id: r.id, type: r.type, runId: r.run_id, agentId: r.agent_id, ts: r.ts, ...P(r.payload, {}) }))
    .reverse();

/* ------------------------------- messages --------------------------------- */

export function addMessage(role, content, meta = {}) {
  const r = db
    .prepare('INSERT INTO messages (role, content, meta, ts) VALUES (?, ?, ?, ?)')
    .run(role, content, J(meta), now());
  return Number(r.lastInsertRowid);
}

export const listMessages = (limit = 100) =>
  db
    .prepare('SELECT * FROM messages ORDER BY id DESC LIMIT ?')
    .all(limit)
    .map((r) => ({ id: r.id, role: r.role, content: r.content, meta: P(r.meta, {}), ts: r.ts }))
    .reverse();

export const clearMessages = () => db.prepare('DELETE FROM messages').run().changes;

/* ---------------------------- manager briefs ------------------------------ */

export function publishManagerBrief(name, brief) {
  db.prepare(
    `INSERT INTO manager_briefs (name, brief, updated_at) VALUES (?, ?, ?)
     ON CONFLICT(name) DO UPDATE SET brief = excluded.brief, updated_at = excluded.updated_at`,
  ).run(name, J(brief), now());
}

const rowToBrief = (r) => ({ ...P(r.brief, {}), name: r.name, updatedAt: r.updated_at });

export const getManagerBrief = (name) => {
  const r = db.prepare('SELECT * FROM manager_briefs WHERE name = ?').get(name);
  return r ? rowToBrief(r) : null;
};

export const getAllManagerBriefs = () =>
  db.prepare('SELECT * FROM manager_briefs ORDER BY name').all().map(rowToBrief);

export function sendManagerMessage(sender, target, kind, payload, opts = {}) {
  const r = db
    .prepare(
      'INSERT INTO manager_messages (sender, target, kind, severity, title, payload, ts) VALUES (?, ?, ?, ?, ?, ?, ?)',
    )
    .run(sender, target, kind, opts.severity || 'info', opts.title || null, J(payload ?? {}), now());
  return Number(r.lastInsertRowid);
}

export const listManagerMessages = (limit = 60) =>
  db
    .prepare('SELECT * FROM manager_messages ORDER BY id DESC LIMIT ?')
    .all(limit)
    .map((r) => ({
      id: r.id,
      from: r.sender,
      to: r.target,
      kind: r.kind,
      severity: r.severity,
      title: r.title,
      payload: P(r.payload, {}),
      ts: r.ts,
    }));

/* -------------------------------- logs ------------------------------------ */

export function writeLog({ level, source, message, agentId = null, runId = null, data = null }) {
  const r = db
    .prepare('INSERT INTO logs (ts, level, source, message, agent_id, run_id, data) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(now(), level, source, String(message).slice(0, 2000), agentId, runId, data ? J(data) : null);
  return Number(r.lastInsertRowid);
}

export function listLogs({ level, source, sinceId = 0, limit = 300 } = {}) {
  const where = ['id > ?'];
  const args = [sinceId];
  if (level && level !== 'all') {
    // level filter is a floor: warn shows warn+error
    const order = { debug: 0, info: 1, warn: 2, error: 3 };
    const floor = order[level] ?? 0;
    const allowed = Object.entries(order).filter(([, v]) => v >= floor).map(([k]) => k);
    where.push(`level IN (${allowed.map(() => '?').join(',')})`);
    args.push(...allowed);
  }
  if (source) {
    where.push('source = ?');
    args.push(source);
  }
  return db
    .prepare(`SELECT * FROM logs WHERE ${where.join(' AND ')} ORDER BY id DESC LIMIT ?`)
    .all(...args, limit)
    .map((r) => ({
      id: r.id,
      ts: r.ts,
      level: r.level,
      source: r.source,
      message: r.message,
      agentId: r.agent_id,
      runId: r.run_id,
      data: P(r.data),
    }))
    .reverse();
}

/** Keep the logs table from growing without bound. Called periodically. */
export const trimLogs = (keep = 5000) =>
  db.prepare('DELETE FROM logs WHERE id <= (SELECT MAX(id) FROM logs) - ?').run(keep).changes;

/**
 * Keep the events table bounded too. Left ungoverned it grows for the life of the process
 * (every durable event is inserted forever), which over long autonomous runs bloats the DB
 * file and the WAL — a slow contributor to the "server dies after hours" failure. Called
 * periodically alongside trimLogs.
 */
export const trimEvents = (keep = 20000) =>
  db.prepare('DELETE FROM events WHERE id <= (SELECT MAX(id) FROM events) - ?').run(keep).changes;

/* ------------------------------- metrics ---------------------------------- */

/**
 * Aggregate numbers for the dashboard's charts and KPI tiles. One round-trip
 * of cheap COUNT/SUM/GROUP BY queries — the UI polls this alongside the socket.
 */
export function computeMetrics({ sinceMs = 24 * 3600_000 } = {}) {
  const since = now() - sinceMs;

  const proposalsByStatus = Object.fromEntries(
    db.prepare('SELECT status, COUNT(*) n FROM proposals GROUP BY status').all().map((r) => [r.status, r.n]),
  );

  const byAgent = db
    .prepare(
      `SELECT a.id AS agent_id,
              COUNT(p.id) AS proposals,
              SUM(CASE WHEN p.status='applied' THEN 1 ELSE 0 END) AS applied,
              SUM(CASE WHEN p.status='rejected' THEN 1 ELSE 0 END) AS rejected,
              SUM(CASE WHEN p.status IN ('verified','failed','verifying') THEN 1 ELSE 0 END) AS pending
         FROM agents a LEFT JOIN proposals p ON p.agent_id = a.id
        GROUP BY a.id`,
    )
    .all()
    .map((r) => ({
      agentId: r.agent_id,
      proposals: r.proposals || 0,
      applied: r.applied || 0,
      rejected: r.rejected || 0,
      pending: r.pending || 0,
    }));

  const runStats = db
    .prepare(
      `SELECT COUNT(*) AS runs,
              SUM(CASE WHEN status='error' THEN 1 ELSE 0 END) AS errors,
              COALESCE(SUM(tokens_in),0) AS tokens_in,
              COALESCE(SUM(tokens_out),0) AS tokens_out,
              COALESCE(SUM(llm_calls),0) AS llm_calls,
              COALESCE(AVG(CASE WHEN finished_at IS NOT NULL THEN finished_at - started_at END),0) AS avg_ms
         FROM runs`,
    )
    .get();

  const verify = db
    .prepare(
      `SELECT SUM(CASE WHEN status IN ('verified','approved','applied') THEN 1 ELSE 0 END) AS passed,
              SUM(CASE WHEN status='failed' THEN 1 ELSE 0 END) AS failed
         FROM proposals`,
    )
    .get();

  // Hourly proposal + run counts for the last 24h (time-series for the area chart).
  const buckets = [];
  const hourMs = 3600_000;
  const startHour = Math.floor(since / hourMs) * hourMs;
  const nowHour = Math.floor(now() / hourMs) * hourMs;
  const propRows = db
    .prepare("SELECT (created_at/3600000)*3600000 AS h, COUNT(*) n FROM proposals WHERE created_at >= ? GROUP BY h")
    .all(startHour);
  const runRows = db
    .prepare('SELECT (started_at/3600000)*3600000 AS h, COUNT(*) n FROM runs WHERE started_at >= ? GROUP BY h')
    .all(startHour);
  const propMap = Object.fromEntries(propRows.map((r) => [r.h, r.n]));
  const runMap = Object.fromEntries(runRows.map((r) => [r.h, r.n]));
  for (let h = startHour; h <= nowHour; h += hourMs) {
    buckets.push({ t: h, proposals: propMap[h] || 0, runs: runMap[h] || 0 });
  }

  const totalDecided = (verify.passed || 0) + (verify.failed || 0);

  return {
    generatedAt: now(),
    proposalsByStatus,
    totals: {
      proposals: Object.values(proposalsByStatus).reduce((a, b) => a + b, 0),
      applied: proposalsByStatus.applied || 0,
      pendingReview: (proposalsByStatus.verified || 0) + (proposalsByStatus.failed || 0) + (proposalsByStatus.verifying || 0),
      rejected: proposalsByStatus.rejected || 0,
    },
    runs: {
      total: runStats.runs || 0,
      errors: runStats.errors || 0,
      avgDurationMs: Math.round(runStats.avg_ms || 0),
      tokensIn: runStats.tokens_in || 0,
      tokensOut: runStats.tokens_out || 0,
      llmCalls: runStats.llm_calls || 0,
    },
    verification: {
      passed: verify.passed || 0,
      failed: verify.failed || 0,
      passRate: totalDecided ? Math.round(((verify.passed || 0) / totalDecided) * 100) : null,
    },
    byAgent,
    timeline: buckets,
  };
}
