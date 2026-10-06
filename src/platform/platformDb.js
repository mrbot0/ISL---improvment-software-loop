import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { DATA_DIR, PLATFORM_DB_PATH } from '../config.js';
import { chainHash, headHash, verifyChain, sealChain, checkpointDDL } from './hashChain.js';

/**
 * The PLATFORM database — one, shared across every project.
 *
 * It holds the things that live *above* any single project: the project registry
 * (which code folders ISL manages), the user directory, and login sessions. Each
 * project's own working data (agents, iterations, proposals, context, …) lives in
 * a separate per-project SQLite file under .data/projects/<id>/ and is reached
 * through the swappable handle in db.js. Keeping the two apart is what lets you
 * switch the active project without dropping who is logged in.
 */

fs.mkdirSync(DATA_DIR, { recursive: true });
fs.mkdirSync(path.dirname(PLATFORM_DB_PATH), { recursive: true });

export const pdb = new DatabaseSync(PLATFORM_DB_PATH);
pdb.exec('PRAGMA journal_mode = WAL');
pdb.exec('PRAGMA foreign_keys = ON');

pdb.exec(`
CREATE TABLE IF NOT EXISTS projects (
  id           TEXT PRIMARY KEY,               -- slug, also the data-dir name
  name         TEXT NOT NULL,
  code_path    TEXT NOT NULL,                  -- absolute folder ISL analyses & improves
  base_branch  TEXT,                           -- override; NULL = detect from checkout
  description  TEXT NOT NULL DEFAULT '',
  color        TEXT NOT NULL DEFAULT 'brand',
  archived     INTEGER NOT NULL DEFAULT 0,
  context_ready INTEGER NOT NULL DEFAULT 0,    -- has the Context Manager onboarded it?
  created_by   TEXT,
  created_at   INTEGER NOT NULL,
  updated_at   INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS users (
  id           TEXT PRIMARY KEY,
  email        TEXT NOT NULL UNIQUE,
  name         TEXT NOT NULL DEFAULT '',
  role         TEXT NOT NULL DEFAULT 'user',   -- admin | user | viewer
  status       TEXT NOT NULL DEFAULT 'pending',-- pending (no password yet) | active | disabled
  pass_hash    TEXT,                           -- scrypt: salt:hash (hex)
  created_at   INTEGER NOT NULL,
  updated_at   INTEGER NOT NULL,
  last_login   INTEGER
);

CREATE TABLE IF NOT EXISTS sessions (
  token      TEXT PRIMARY KEY,                 -- opaque random id (hex)
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  ip         TEXT,
  agent      TEXT
);
CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);

-- Cross-project audit trail (logins, project switches, admin actions). The
-- per-project logs stay per project; this is the platform-level record.
CREATE TABLE IF NOT EXISTS audit (
  id       INTEGER PRIMARY KEY AUTOINCREMENT,
  ts       INTEGER NOT NULL,
  actor    TEXT,                               -- user id / email / 'system'
  action   TEXT NOT NULL,
  target   TEXT,
  detail   TEXT
);
CREATE INDEX IF NOT EXISTS idx_audit_ts ON audit(id DESC);

-- Platform-wide settings (not per user).
CREATE TABLE IF NOT EXISTS platform_settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- PER-USER PREFERENCES. Theme, density, locale and landing view lived in localStorage, which means
-- they were per BROWSER: a second machine, a private window or a cleared cache lost them, and an
-- administrator could not set a sensible default for anyone. One JSON document per user rather than
-- a key/value row each — preferences are always read as a set, and a partial read is never useful.
CREATE TABLE IF NOT EXISTS user_prefs (
  user_id    TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  prefs      TEXT NOT NULL DEFAULT '{}',
  updated_at INTEGER NOT NULL
);

-- EGRESS LEDGER — one row per model call ISL makes, anywhere, for any purpose.
--
-- This is the answer to the question a security review always asks: "what of our code left the
-- building, and to whom?". It is hash-CHAINED (row_hash covers prev_hash) so an operator with
-- database access cannot quietly delete or rewrite a call after the fact without the chain failing
-- verification. The payload itself is NOT stored by default — only its SHA-256, which proves what
-- was sent without becoming a second copy of the source code to protect.
CREATE TABLE IF NOT EXISTS egress_ledger (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  ts          INTEGER NOT NULL,
  project_id  TEXT,
  purpose     TEXT NOT NULL,                  -- implement | review | chat | embed | research | …
  provider    TEXT NOT NULL,                  -- ollama | openai-compatible
  model       TEXT,
  host        TEXT NOT NULL,
  destination TEXT NOT NULL,                  -- local | remote
  decision    TEXT NOT NULL,                  -- allow | deny
  reason      TEXT,
  bytes       INTEGER NOT NULL DEFAULT 0,
  parts       INTEGER NOT NULL DEFAULT 0,     -- messages / inputs in the payload
  redactions  INTEGER NOT NULL DEFAULT 0,
  tripwires   TEXT NOT NULL DEFAULT '[]',     -- excluded files whose content was found in the payload
  payload_sha TEXT NOT NULL,
  payload     TEXT,                           -- only when the operator opts into full capture
  prev_hash   TEXT NOT NULL,
  row_hash    TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_egress_ts ON egress_ledger(id DESC);

`);

// Sealed checkpoints for each chain — see hashChain.js for why a chain that cannot be truncated is
// not operable. Same shape for every chain, so one verifier handles them all.
pdb.exec(checkpointDDL('egress_checkpoints'));
pdb.exec(checkpointDDL('audit_checkpoints'));

/**
 * The audit table predates hash chaining, so its integrity columns are added by migration and are
 * NULL for everything written before this version. Those rows are reported as `unchainedLegacy`
 * rather than counted as verified: "integrity is proven from this date" is honest, "the whole
 * history is intact" would not be.
 */
for (const col of ['prev_hash', 'row_hash']) {
  try { pdb.exec(`ALTER TABLE audit ADD COLUMN ${col} TEXT`); } catch { /* already migrated */ }
}

const now = () => Date.now();
const J = (v) => JSON.stringify(v ?? null);
const P = (v, dflt = null) => {
  if (v == null) return dflt;
  try {
    return JSON.parse(v);
  } catch {
    return dflt;
  }
};

/* -------------------------------- settings -------------------------------- */

export function getPlatformSetting(key, dflt = null) {
  const row = pdb.prepare('SELECT value FROM platform_settings WHERE key = ?').get(key);
  return row ? P(row.value, dflt) : dflt;
}
export function setPlatformSetting(key, value) {
  pdb.prepare(
    'INSERT INTO platform_settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
  ).run(key, J(value));
  return value;
}

/* ---------------------------- user preferences ---------------------------- */

/**
 * What a user may store, and what the value must look like.
 *
 * An allow-list rather than a free-form blob: preferences are written by the client and read back
 * into the DOM (`data-theme`, `data-density`), so accepting arbitrary keys and values would let one
 * user's stored string become another surface's input. Anything unrecognised is dropped silently —
 * a rejected preference is not worth failing a request over, but it must not be persisted either.
 */
const PREF_SCHEMA = {
  theme: (v) => (['dark', 'light'].includes(v) ? v : null),
  density: (v) => (['comfortable', 'compact'].includes(v) ? v : null),
  locale: (v) => (typeof v === 'string' && /^[a-z]{2}(-[A-Z]{2})?$/.test(v) ? v : null),
  defaultView: (v) => (typeof v === 'string' && /^[a-z][a-z0-9-]{0,30}$/.test(v) ? v : null),
  // Dismissing the first-run tour is a preference like any other: per user, and it must not come
  // back on another machine. Only `true` is storable — "un-dismiss" is not a thing the UI offers,
  // and accepting `false` would let a stale client resurrect it.
  tourDismissed: (v) => (v === true ? true : null),
};

export const PREF_KEYS = Object.keys(PREF_SCHEMA);

export function getUserPrefs(userId) {
  if (!userId) return {};
  const row = pdb.prepare('SELECT prefs FROM user_prefs WHERE user_id = ?').get(userId);
  return P(row?.prefs, {}) || {};
}

/**
 * Merge a patch into a user's preferences. Merge, not replace: a client that knows about three
 * preferences must not wipe a fourth that a newer build added.
 */
export function setUserPrefs(userId, patch = {}) {
  if (!userId) return {};
  const current = getUserPrefs(userId);
  const next = { ...current };
  for (const [k, raw] of Object.entries(patch)) {
    const validate = PREF_SCHEMA[k];
    if (!validate) continue;
    const v = validate(raw);
    if (v != null) next[k] = v;
  }
  pdb.prepare(
    `INSERT INTO user_prefs (user_id, prefs, updated_at) VALUES (?,?,?)
     ON CONFLICT(user_id) DO UPDATE SET prefs = excluded.prefs, updated_at = excluded.updated_at`,
  ).run(userId, J(next), now());
  return next;
}

/* --------------------------------- audit ---------------------------------- */

/** The fields the audit chain commits to, in a fixed order. */
const auditCanonical = (r) =>
  [r.ts, r.actor ?? '', r.action, r.target ?? '', r.detail ?? ''].join(' ');

/**
 * Record a platform action. Hash-chained, so an operator with database access can still APPEND but
 * cannot rewrite what an approver did last week without verification failing at that row — which is
 * the whole point of a change-control record.
 */
export function audit(action, { actor = 'system', target = null, detail = null } = {}) {
  try {
    const row = {
      ts: now(),
      actor,
      action,
      target,
      detail: detail == null ? null : typeof detail === 'string' ? detail : J(detail),
    };
    const prevHash = headHash(pdb, 'audit', 'audit_checkpoints');
    const rowHash = chainHash(prevHash, auditCanonical(row));
    pdb.prepare(
      'INSERT INTO audit (ts, actor, action, target, detail, prev_hash, row_hash) VALUES (?,?,?,?,?,?,?)',
    ).run(row.ts, row.actor, row.action, row.target, row.detail, prevHash, rowHash);
  } catch {
    /* audit must never throw — a failed record must not break the action it was recording */
  }
}

export function listAudit(limit = 100) {
  return pdb.prepare('SELECT * FROM audit ORDER BY id DESC LIMIT ?').all(limit);
}

/** Is the platform audit trail intact? Reports rows written before chaining separately. */
export function verifyAuditChain() {
  return verifyChain({ db: pdb, table: 'audit', canonical: auditCanonical, seals: 'audit_checkpoints' });
}

export function sealAuditSegment({ upToId = null, actor = 'system', note = null } = {}) {
  const r = sealChain({ db: pdb, table: 'audit', seals: 'audit_checkpoints', canonical: auditCanonical, upToId, actor, note, now: now() });
  if (r.sealed) audit('audit.sealed', { actor, target: String(r.upToId), detail: { archived: r.archived, headHash: r.headHash, note } });
  return r;
}

/* ----------------------------- egress ledger ------------------------------ */

/** The fields the egress chain commits to, in a fixed order — the canonical form hashed. */
const egressCanonical = (r) => [
  r.ts, r.project_id ?? '', r.purpose, r.provider, r.model ?? '', r.host, r.destination,
  r.decision, r.reason ?? '', r.bytes, r.parts, r.redactions, r.tripwires, r.payload_sha,
].join(' ');

/**
 * Append one call to the ledger. Never throws: an accounting failure must not break the call it is
 * accounting for — but it is reported, because a ledger with silent holes is worse than none.
 * @returns {{id:number, row_hash:string}|{error:string}}
 */
export function appendEgress(row) {
  try {
    const prevHash = headHash(pdb, 'egress_ledger', 'egress_checkpoints');
    const r = {
      ts: now(),
      project_id: row.projectId ?? null,
      purpose: row.purpose || 'unknown',
      provider: row.provider || 'unknown',
      model: row.model ?? null,
      host: row.host || '',
      destination: row.destination || 'unknown',
      decision: row.decision || 'allow',
      reason: row.reason ?? null,
      bytes: row.bytes | 0,
      parts: row.parts | 0,
      redactions: row.redactions | 0,
      tripwires: J(row.tripwires || []),
      payload_sha: row.payloadSha || '',
      payload: row.payload ?? null,
    };
    const rowHash = chainHash(prevHash, egressCanonical(r));
    const res = pdb
      .prepare(
        `INSERT INTO egress_ledger
           (ts, project_id, purpose, provider, model, host, destination, decision, reason,
            bytes, parts, redactions, tripwires, payload_sha, payload, prev_hash, row_hash)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(r.ts, r.project_id, r.purpose, r.provider, r.model, r.host, r.destination, r.decision,
        r.reason, r.bytes, r.parts, r.redactions, r.tripwires, r.payload_sha, r.payload,
        prevHash, rowHash);
    return { id: Number(res.lastInsertRowid), row_hash: rowHash };
  } catch (err) {
    return { error: err.message };
  }
}

/** Is the egress ledger intact? Delegates to the shared chain verifier. */
export function verifyEgressChain() {
  return verifyChain({ db: pdb, table: 'egress_ledger', canonical: egressCanonical, seals: 'egress_checkpoints' });
}

export function listEgressCheckpoints(limit = 20) {
  return pdb.prepare('SELECT * FROM egress_checkpoints ORDER BY id DESC LIMIT ?').all(limit);
}

/** Seal the ledger up to a given row and archive it. See hashChain.js for why this exists. */
export function sealEgressSegment({ upToId = null, actor = 'system', note = null } = {}) {
  const r = sealChain({ db: pdb, table: 'egress_ledger', seals: 'egress_checkpoints', canonical: egressCanonical, upToId, actor, note, now: now() });
  if (r.sealed) audit('egress.sealed', { actor, target: String(r.upToId), detail: { archived: r.archived, headHash: r.headHash, note } });
  return r;
}

export function listEgress({ limit = 100, decision = null, destination = null } = {}) {
  const where = [];
  const args = [];
  if (decision) { where.push('decision = ?'); args.push(decision); }
  if (destination) { where.push('destination = ?'); args.push(destination); }
  const sql = `SELECT id, ts, project_id, purpose, provider, model, host, destination, decision,
                      reason, bytes, parts, redactions, tripwires, payload_sha
               FROM egress_ledger ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
               ORDER BY id DESC LIMIT ?`;
  return pdb.prepare(sql).all(...args, limit).map((r) => ({ ...r, tripwires: P(r.tripwires, []) }));
}

/** Aggregate view for the dashboard: volume and denials, split by destination. */
export function egressSummary() {
  const row = pdb.prepare(
    `SELECT COUNT(*) AS calls,
            SUM(CASE WHEN destination = 'remote' THEN 1 ELSE 0 END) AS remoteCalls,
            SUM(CASE WHEN decision = 'deny' THEN 1 ELSE 0 END) AS denied,
            SUM(CASE WHEN destination = 'remote' THEN bytes ELSE 0 END) AS remoteBytes,
            SUM(redactions) AS redactions,
            MIN(ts) AS since
     FROM egress_ledger`,
  ).get();
  return {
    calls: row?.calls || 0,
    remoteCalls: row?.remoteCalls || 0,
    denied: row?.denied || 0,
    remoteBytes: row?.remoteBytes || 0,
    redactions: row?.redactions || 0,
    since: row?.since || null,
  };
}
