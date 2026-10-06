import crypto from 'node:crypto';
import os from 'node:os';
import { db, registerSchema } from '../db.js';
import { log } from '../logger.js';

/**
 * DURABLE WORK QUEUE + LEADER ELECTION (ISL_IMPROVE enterprise wave, P1).
 *
 * The control plane is one Node process holding module-level singletons. Three consequences, all
 * real: a crash loses in-flight work, no second process can share the load, and — the one that
 * actually bites first — nothing stops TWO processes from both deciding they are the loop.
 *
 * That last one is not hypothetical here. The supervisor restarts the server on a clean exit, and a
 * slow shutdown racing a fast restart puts two servers on the same SQLite file for a few seconds.
 * Both would tick, both would plan, and both would drive the same work branch.
 *
 * This module provides the two primitives that make more than one process safe:
 *
 *   LEASES — a claim on work that EXPIRES. A worker that dies stops renewing, the lease lapses, and
 *   another worker may take the job. No heartbeat protocol, no distributed consensus: expiry is the
 *   protocol, and it is the one that survives the worker being killed rather than asked to stop.
 *
 *   IDEMPOTENCY KEYS — at-least-once delivery means a job WILL sometimes run twice. The key makes
 *   the second run a no-op rather than a second effect. (For the commit itself the stronger,
 *   git-level guard lives in `iteration/idempotency.js`; this is the general case.)
 *
 * ── What this is NOT ────────────────────────────────────────────────────────────────────────────
 * It is not a rewrite of the ten-phase pipeline into distributed steps. The phases share a sandbox
 * directory and a git worktree, so moving them across machines needs shared storage that does not
 * exist yet. What it does give is the substrate that makes such a move possible, and the leader
 * election that makes the CURRENT single-writer assumption enforced instead of merely hoped for.
 */

const lg = log.for('queue');
const now = () => Date.now();

/** This process, for the lifetime of this process. Restarting gives a new identity — deliberately. */
export const WORKER_ID = `${os.hostname()}:${process.pid}:${crypto.randomBytes(3).toString('hex')}`;

registerSchema(() => {
  db.exec(`
  CREATE TABLE IF NOT EXISTS work_queue (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    kind            TEXT NOT NULL,
    payload_json    TEXT,
    idempotency_key TEXT UNIQUE,
    status          TEXT NOT NULL DEFAULT 'ready',  -- ready | leased | done | failed | dead
    attempts        INTEGER NOT NULL DEFAULT 0,
    max_attempts    INTEGER NOT NULL DEFAULT 3,
    leased_by       TEXT,
    lease_until     INTEGER,
    result_json     TEXT,
    last_error      TEXT,
    run_after       INTEGER NOT NULL DEFAULT 0,
    created_at      INTEGER NOT NULL,
    updated_at      INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_wq_claim ON work_queue(status, run_after, id);

  -- One row per named role. The holder is whoever last won it and is still renewing.
  CREATE TABLE IF NOT EXISTS leadership (
    role        TEXT PRIMARY KEY,
    holder      TEXT NOT NULL,
    lease_until INTEGER NOT NULL,
    since       INTEGER NOT NULL
  );
  `);
});

/* -------------------------------- the queue ------------------------------- */

/**
 * Enqueue a job. An `idempotencyKey` makes this call safe to repeat: the second enqueue returns the
 * FIRST job rather than creating a duplicate, which is what makes an at-least-once producer harmless.
 *
 * @returns {{id:number, kind:string, duplicate:boolean}}
 */
export function enqueue({ kind, payload = null, idempotencyKey = null, maxAttempts = 3, runAfter = 0 }) {
  if (!kind) throw new Error('a job needs a kind');
  const t = now();
  if (idempotencyKey) {
    const existing = db.prepare('SELECT id, kind FROM work_queue WHERE idempotency_key = ?').get(idempotencyKey);
    if (existing) return { id: existing.id, kind: existing.kind, duplicate: true };
  }
  try {
    const id = Number(
      db
        .prepare(
          `INSERT INTO work_queue (kind, payload_json, idempotency_key, max_attempts, run_after, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(kind, payload == null ? null : JSON.stringify(payload), idempotencyKey, maxAttempts, runAfter, t, t).lastInsertRowid,
    );
    return { id, kind, duplicate: false };
  } catch (err) {
    // Two processes enqueuing the same key at once: the UNIQUE constraint decides, and the loser
    // reads back the winner's row. Catching this is the whole point of the constraint being there.
    if (/UNIQUE/i.test(err.message) && idempotencyKey) {
      const existing = db.prepare('SELECT id, kind FROM work_queue WHERE idempotency_key = ?').get(idempotencyKey);
      if (existing) return { id: existing.id, kind: existing.kind, duplicate: true };
    }
    throw err;
  }
}

/**
 * Claim the next runnable job of the given kinds, for `leaseMs`.
 *
 * The claim is a single conditional UPDATE, not a SELECT followed by an UPDATE: two workers reaching
 * for the same row both run the UPDATE, and SQLite's write lock means exactly one of them changes a
 * row. Reading first and writing second would let both believe they won.
 *
 * @returns {object|null} the claimed job, or null if there is nothing to do
 */
export function claim({ kinds = null, leaseMs = 300_000 } = {}) {
  const t = now();
  const kindFilter = kinds?.length ? ` AND kind IN (${kinds.map(() => '?').join(',')})` : '';
  const params = kinds?.length ? kinds : [];

  // Reclaim first: a lapsed lease means its worker died mid-job.
  const reclaimed = db
    .prepare(`UPDATE work_queue SET status = 'ready', leased_by = NULL, lease_until = NULL, updated_at = ?
              WHERE status = 'leased' AND lease_until < ?`)
    .run(t, t).changes;
  if (reclaimed) lg.warn(`reclaimed ${reclaimed} job(s) from a worker that stopped renewing`);

  const changed = db
    .prepare(
      `UPDATE work_queue
         SET status = 'leased', leased_by = ?, lease_until = ?, attempts = attempts + 1, updated_at = ?
       WHERE id = (
         SELECT id FROM work_queue
         WHERE status = 'ready' AND run_after <= ?${kindFilter}
         ORDER BY id LIMIT 1
       )`,
    )
    .run(WORKER_ID, t + leaseMs, t, t, ...params).changes;
  if (!changed) return null;

  const row = db.prepare('SELECT * FROM work_queue WHERE leased_by = ? AND status = ? ORDER BY updated_at DESC LIMIT 1').get(WORKER_ID, 'leased');
  return row ? toJob(row) : null;
}

/** Extend a lease held by THIS worker. A long job must renew or it will be taken from under it. */
export function renew(jobId, leaseMs = 300_000) {
  const changed = db
    .prepare("UPDATE work_queue SET lease_until = ?, updated_at = ? WHERE id = ? AND leased_by = ? AND status = 'leased'")
    .run(now() + leaseMs, now(), jobId, WORKER_ID).changes;
  return !!changed;
}

/** Finish a job successfully. Only the lease holder may complete it. */
export function complete(jobId, result = null) {
  const changed = db
    .prepare("UPDATE work_queue SET status = 'done', result_json = ?, lease_until = NULL, updated_at = ? WHERE id = ? AND leased_by = ?")
    .run(result == null ? null : JSON.stringify(result), now(), jobId, WORKER_ID).changes;
  return !!changed;
}

/**
 * Fail a job. It returns to `ready` for another attempt until `max_attempts` is spent, then becomes
 * `dead` — a job that retries forever is a queue that never drains, and a poison message would take
 * every worker with it.
 */
export function fail(jobId, error, { retryDelayMs = 30_000 } = {}) {
  const job = db.prepare('SELECT * FROM work_queue WHERE id = ? AND leased_by = ?').get(jobId, WORKER_ID);
  if (!job) return { retried: false, dead: false };
  const dead = job.attempts >= job.max_attempts;
  db.prepare(
    `UPDATE work_queue SET status = ?, last_error = ?, leased_by = NULL, lease_until = NULL, run_after = ?, updated_at = ?
     WHERE id = ?`,
  ).run(dead ? 'dead' : 'ready', String(error?.message || error).slice(0, 500), dead ? 0 : now() + retryDelayMs, now(), jobId);
  if (dead) lg.error(`job #${jobId} (${job.kind}) is dead after ${job.attempts} attempt(s): ${String(error?.message || error).slice(0, 160)}`);
  return { retried: !dead, dead };
}

const toJob = (r) => ({
  id: r.id,
  kind: r.kind,
  payload: (() => { try { return JSON.parse(r.payload_json || 'null'); } catch { return null; } })(),
  idempotencyKey: r.idempotency_key,
  attempts: r.attempts,
  maxAttempts: r.max_attempts,
  leasedBy: r.leased_by,
  leaseUntil: r.lease_until,
  status: r.status,
  lastError: r.last_error,
});

/** Queue depth by status, for the dashboard and for deciding whether a second worker would help. */
export function queueStats() {
  try {
    const rows = db.prepare('SELECT status, COUNT(*) n FROM work_queue GROUP BY status').all();
    const by = { ready: 0, leased: 0, done: 0, failed: 0, dead: 0 };
    for (const r of rows) by[r.status] = r.n;
    return { ...by, worker: WORKER_ID };
  } catch {
    return { ready: 0, leased: 0, done: 0, failed: 0, dead: 0, worker: WORKER_ID };
  }
}

/** Recent jobs, newest first. */
export const listJobs = (limit = 50) => {
  try {
    return db.prepare('SELECT * FROM work_queue ORDER BY id DESC LIMIT ?').all(limit).map(toJob);
  } catch {
    return [];
  }
};

/* ----------------------------- leader election ---------------------------- */

/**
 * Is the holder of a lease a process that no longer exists?
 *
 * A holder is `host:pid:nonce`. Only a holder on THIS host can be checked, and `process.kill(pid, 0)`
 * signals nothing — it only asks whether the process is there.
 *
 * The two ways to be wrong are not symmetric, and that is what makes this safe:
 *
 *   - The OS has recycled the pid onto an unrelated process → this reports "alive", the lease is
 *     left alone, and a successor waits out the TTL exactly as it does today. Slow, correct.
 *   - The process is genuinely gone → this reports "dead", which it is.
 *
 * There is no path from "the process is running" to "dead", so this can never produce two leaders.
 * Anything unparseable, any other host, any error: treated as alive.
 */
function holderIsGone(holder) {
  const parts = String(holder || '').split(':');
  if (parts.length < 2) return false;
  const [host, pid] = parts;
  if (host !== os.hostname()) return false; // another machine — not ours to judge
  const n = Number(pid);
  if (!Number.isInteger(n) || n <= 0) return false;
  try {
    process.kill(n, 0);
    return false; // it answered — alive, or a recycled pid we must treat as alive
  } catch (err) {
    return err.code === 'ESRCH'; // no such process. EPERM means it exists but is not ours.
  }
}

/**
 * Try to become (or stay) the holder of a named role.
 *
 * The same expiry-as-protocol idea: the leader renews, and a leader that stops renewing loses the
 * role to whoever asks next. `ttlMs` must comfortably exceed the renewal interval, or a leader that
 * is merely busy will lose the role it still holds.
 *
 * A lease is ALSO reclaimed when its holder is a dead process on this host. Expiry alone is correct
 * but slow: a crash or a hard kill skips the clean handback, so the successor stands by for the full
 * TTL — fifteen minutes of a stopped loop, with a log line naming a pid that does not exist. Measured
 * on a real restart, that was the entire reason iterations "stopped starting".
 *
 * @returns {boolean} whether THIS process holds the role now
 */
export function acquireLeadership(role, ttlMs = 90_000) {
  const t = now();
  try {
    // Checked before the upsert rather than inside it: SQLite cannot ask the OS about a pid.
    const cur = db.prepare('SELECT holder, lease_until FROM leadership WHERE role = ?').get(role);
    if (cur && cur.holder !== WORKER_ID && cur.lease_until >= t && holderIsGone(cur.holder)) {
      lg.info(`reclaiming "${role}" from ${cur.holder} — that process is gone (${Math.round((cur.lease_until - t) / 1000)}s of lease left)`);
      db.prepare('DELETE FROM leadership WHERE role = ? AND holder = ?').run(role, cur.holder);
    }
    // Take it if it is free, expired, or already ours. One statement, so two processes racing for a
    // vacant role cannot both succeed.
    const changed = db
      .prepare(
        `INSERT INTO leadership (role, holder, lease_until, since) VALUES (?, ?, ?, ?)
         ON CONFLICT(role) DO UPDATE SET
           holder = excluded.holder,
           lease_until = excluded.lease_until,
           since = CASE WHEN leadership.holder = excluded.holder THEN leadership.since ELSE excluded.since END
         WHERE leadership.holder = excluded.holder OR leadership.lease_until < ?`,
      )
      .run(role, WORKER_ID, t + ttlMs, t, t).changes;
    return !!changed;
  } catch (err) {
    // A leadership table we cannot read must not silently make everyone a leader. Refusing the role
    // is the safe direction: worst case the loop pauses; the alternative is two loops on one branch.
    lg.warn(`leadership check for "${role}" failed (${err.message}) — declining the role`);
    return false;
  }
}

/** Give up a role deliberately (a clean shutdown), so a successor does not wait out the TTL. */
export function releaseLeadership(role) {
  try {
    return !!db.prepare('DELETE FROM leadership WHERE role = ? AND holder = ?').run(role, WORKER_ID).changes;
  } catch {
    return false;
  }
}

/** Who holds a role right now, if anyone. */
export function leadershipStatus(role) {
  try {
    const r = db.prepare('SELECT * FROM leadership WHERE role = ?').get(role);
    if (!r || r.lease_until < now()) return { role, holder: null, isMe: false, expired: !!r };
    return { role, holder: r.holder, isMe: r.holder === WORKER_ID, since: r.since, leaseUntil: r.lease_until, expired: false };
  } catch {
    return { role, holder: null, isMe: false, expired: false };
  }
}
