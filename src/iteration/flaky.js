import { db, registerSchema, getSetting, setSetting } from '../db.js';
import { createSandbox, removeWorktree, run } from '../sandbox/worktree.js';
import { testCommandFor } from './langRunners.js';
import { log } from '../logger.js';

/**
 * FLAKY-TEST DETECTION & QUARANTINE (ISL_IMPROVE "New high-value functions", P1).
 *
 * A flaky test — one that passes and fails without any code change — is worse than useless: it
 * makes the fleet reject GOOD changes at random, poisoning the land rate and the trust signal.
 * This module gives ISL two defences:
 *
 *   1. Re-run confirmation (in the test grader): when a suite fails, re-run it a bounded number of
 *      times; if it then passes, the failure was non-deterministic — the change is NOT rejected for
 *      it, and the flake is recorded. Genuine failures re-run and stay failed, so nothing real slips
 *      through. Controlled by the `flakyRetries` setting (default 1; 0 disables).
 *   2. On-demand detection: run a suite N times at the current commit and report whether its outcome
 *      is inconsistent — the deterministic way to confirm a suite is flaky before acting on it.
 *
 * Confirmed flakes are logged (a durable event stream) and the worst offenders can be filed as fix
 * tasks. This is the polyglot, suite-level v1; per-test quarantine is the natural next step.
 */

registerSchema(() => {
  db.exec(`
  CREATE TABLE IF NOT EXISTS flaky_events (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    project      TEXT,
    suite        TEXT,
    iteration_id INTEGER,
    attempts     INTEGER NOT NULL DEFAULT 0,
    detail       TEXT,
    ts           INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_flaky_ts ON flaky_events(id DESC);
  `);
});

const lg = log.for('flaky');

/** How many times a failed suite is re-run to see if it's flaky (0 = feature off). */
export function getFlakyRetries() {
  const v = Number(getSetting('flakyRetries', 1));
  return Number.isFinite(v) ? Math.max(0, Math.min(3, v)) : 1;
}
export function setFlakyRetries(n) {
  const v = Math.max(0, Math.min(3, Number(n) || 0));
  setSetting('flakyRetries', v);
  return v;
}

export function recordFlakyEvent({ project, suite, iterationId = null, attempts = 0, detail = '' }) {
  db.prepare('INSERT INTO flaky_events (project, suite, iteration_id, attempts, detail, ts) VALUES (?,?,?,?,?,?)')
    .run(project ?? null, suite ?? null, iterationId, attempts, String(detail).slice(0, 300), Date.now());
  lg.warn(`flaky suite confirmed: ${project}/${suite} (passed on retry after ${attempts} attempt(s))`);
}

export function listFlakyEvents(limit = 60) {
  return db.prepare('SELECT * FROM flaky_events ORDER BY id DESC LIMIT ?').all(limit)
    .map((r) => ({ id: r.id, project: r.project, suite: r.suite, iterationId: r.iteration_id, attempts: r.attempts, detail: r.detail, ts: r.ts }));
}

export function flakyStats() {
  const total = db.prepare('SELECT COUNT(*) n FROM flaky_events').get().n;
  const since = Date.now() - 7 * 24 * 3600_000;
  const week = db.prepare('SELECT COUNT(*) n FROM flaky_events WHERE ts >= ?').get(since).n;
  const bySuite = db.prepare('SELECT project, suite, COUNT(*) n FROM flaky_events GROUP BY project, suite ORDER BY n DESC LIMIT 5').all();
  return { total, week, topOffenders: bySuite.map((r) => ({ project: r.project, suite: r.suite, count: r.n })) };
}

/**
 * Re-run a suite that just failed, up to `retries` times, to see if it passes non-deterministically.
 * @returns {Promise<{flaky:boolean, attempts:number}>}
 */
export async function confirmFlaky(suite, retries = getFlakyRetries()) {
  for (let i = 1; i <= retries; i++) {
    const { exitCode } = await run(suite.bin, suite.args, { cwd: suite.cwd, timeoutMs: 300_000 }).catch(() => ({ exitCode: 1 }));
    if (exitCode === 0) return { flaky: true, attempts: i };
  }
  return { flaky: false, attempts: retries };
}

// On-demand detection runs a command several times at HEAD and reports inconsistency. Cached +
// background, like the other scanners.
let _lastScan = null;
let _scanning = false;
export const getLastFlakyScan = () => _lastScan;
export const isFlakyScanRunning = () => _scanning;

/**
 * Run `command` (or an auto-detected suite for `projectDir`) `runs` times in an isolated worktree
 * at HEAD; a mix of pass and fail means it's flaky.
 */
export async function detectFlaky({ projectDir = '.', command, args, runs = 4, commit = 'HEAD' } = {}) {
  const dir = createSandbox([], commit);
  try {
    let bin = command;
    let cmdArgs = args;
    let cwd = dir;
    if (!bin) {
      const detected = testCommandFor(dir, projectDir);
      if (!detected) return { ran: 0, flaky: false, reason: 'no test suite detected' };
      bin = detected.bin; cmdArgs = detected.args; cwd = detected.cwd;
    }
    const codes = [];
    for (let i = 0; i < runs; i++) {
      const { exitCode } = await run(bin, cmdArgs, { cwd, timeoutMs: 300_000 }).catch(() => ({ exitCode: 1 }));
      codes.push(exitCode);
    }
    const passes = codes.filter((c) => c === 0).length;
    const flaky = passes > 0 && passes < codes.length;
    return { ran: codes.length, passes, fails: codes.length - passes, flaky, codes };
  } finally {
    removeWorktree(dir);
  }
}

export function startFlakyScan(opts = {}) {
  if (_scanning) return false;
  _scanning = true;
  _lastScan = { running: true, startedAt: Date.now() };
  detectFlaky(opts)
    .then((r) => { _lastScan = { running: false, finishedAt: Date.now(), ...r }; })
    .catch((e) => { _lastScan = { running: false, finishedAt: Date.now(), error: e.message }; })
    .finally(() => { _scanning = false; });
  return true;
}
