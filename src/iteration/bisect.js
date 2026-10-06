import path from 'node:path';
import { WORK_BRANCH, PRODUCT_DIRS } from '../config.js';
import { git, createSandbox, removeWorktree, moveBranch, run } from '../sandbox/worktree.js';
import { testCommandFor } from './langRunners.js';
import { log } from '../logger.js';

/**
 * REGRESSION BISECT & AUTO-REVERT (ISL_IMPROVE "Safer, self-correcting changes", P0).
 *
 * A change can pass its own gates and still be discovered bad later — by a subsequent run, the
 * workbench, or a human. Left alone, every commit stacked on top inherits the break. This module
 * lets ISL undo its own mistakes: bisect the fleet's own recent commits to find the one that
 * introduced a regression, then revert JUST that commit — cleanly, on the work branch, without
 * disturbing the main checkout (same detached-worktree discipline the engine commits with).
 *
 * The verification at each bisect step runs in an isolated worktree checked out at that commit, so
 * the live branch is never mutated during the search. `git revert` (not reset) preserves history
 * and is safe on a branch other commits may descend from.
 */

const lg = log.for('bisect');

/** Recent commits the fleet itself made on the work branch, newest first. */
export function fleetCommits({ branch = WORK_BRANCH, limit = 25 } = {}) {
  let out;
  try {
    out = git(['log', branch, '--grep=ai-iter#', `-n${limit}`, '--format=%H\x1f%s\x1f%ct']);
  } catch {
    return [];
  }
  if (!out) return [];
  return out.split('\n').filter(Boolean).map((line) => {
    const [sha, subject, ct] = line.split('\x1f');
    const m = /ai-iter#(\d+)/.exec(subject || '');
    return { sha, shortSha: sha.slice(0, 8), title: subject || '', iterationId: m ? Number(m[1]) : null, ts: Number(ct) * 1000 };
  });
}

/**
 * Run the verify command inside a worktree checked out at `sha`.
 * @returns {Promise<{ok:boolean, exitCode:number, output:string}>}  ok = exit code 0
 */
async function verifyAt(sha, { projectDir = '.', command, args, timeoutMs = 240_000 } = {}) {
  const dir = createSandbox([], sha); // detached worktree at sha, node_modules linked
  try {
    let bin = command;
    let cmdArgs = args;
    let cwd = path.join(dir, projectDir);
    if (!bin) {
      const detected = testCommandFor(dir, projectDir);
      if (!detected) return { ok: true, exitCode: 0, output: '(no test suite detected — treated as good)' };
      bin = detected.bin;
      cmdArgs = detected.args;
      cwd = detected.cwd;
    }
    const res = await run(bin, cmdArgs, { cwd, timeoutMs });
    return { ok: res.exitCode === 0, exitCode: res.exitCode, output: (res.output || '').slice(-1500) };
  } finally {
    removeWorktree(dir);
  }
}

/**
 * Binary-search the fleet's commits for the first one that fails verification — the culprit.
 * Assumes the range transitions good→bad exactly once (a single regression), which is the
 * common case; the boundary it returns is the first commit at which verify fails.
 *
 * @param {{branch?:string, verify?:object, limit?:number, onStep?:function}} opts
 *   verify: { projectDir, command, args, timeoutMs } passed to verifyAt (omit → auto test suite)
 * @returns {Promise<{culprit, checked, steps, commits}>}
 */
export async function bisectRegression({ branch = WORK_BRANCH, verify = {}, limit = 25, onStep } = {}) {
  const newestFirst = fleetCommits({ branch, limit });
  if (!newestFirst.length) return { culprit: null, checked: [], steps: 0, reason: 'no fleet commits on the work branch' };
  const commits = [...newestFirst].reverse(); // oldest → newest for the search

  let lo = 0;
  let hi = commits.length - 1;
  let culprit = null;
  const checked = [];
  let steps = 0;

  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const c = commits[mid];
    steps++;
    lg.info(`bisect step ${steps}: verifying ${c.shortSha} (iter #${c.iterationId ?? '?'})`);
    onStep?.({ step: steps, sha: c.shortSha, iterationId: c.iterationId });
    let res;
    try {
      res = await verifyAt(c.sha, verify);
    } catch (e) {
      res = { ok: true, exitCode: -1, output: `verify errored (${e.message}) — treated as good` };
    }
    checked.push({ sha: c.shortSha, iterationId: c.iterationId, ok: res.ok, exitCode: res.exitCode });
    if (res.ok) {
      lo = mid + 1; // good here → regression is later
    } else {
      culprit = { ...c, output: res.output };
      hi = mid - 1; // bad here → look earlier for the first bad one
    }
  }

  // A binary search only finds a real culprit if the range actually contains a good→bad BOUNDARY.
  // If every commit we checked fails, the regression predates this window — reporting the oldest
  // checked commit as "the culprit" would send the operator to revert an innocent change. Say so.
  const anyGood = checked.some((c) => c.ok);
  if (culprit && !anyGood) {
    return {
      culprit: null,
      checked,
      steps,
      commits: newestFirst,
      reason:
        `every one of the ${checked.length} commit(s) checked (back to ${checked[checked.length - 1]?.sha}) already fails — ` +
        `the regression predates this window. Widen the limit, or the break pre-dates the fleet's history.`,
    };
  }
  return { culprit, checked, steps, commits: newestFirst };
}

/**
 * Does this suite ALSO fail at `baseCommit` (the state the iteration started from)?
 *
 * If yes, the failure is PRE-EXISTING — an earlier commit broke it, not the change under review.
 * That distinction matters twice: the current agent shouldn't be blamed for it, and the real
 * culprit is worth bisecting for. Runs in an isolated worktree, so nothing live is touched.
 */
export async function failsAtBase({ projectDir = '.', baseCommit } = {}) {
  if (!baseCommit) return false;
  let dir;
  try {
    dir = createSandbox([], baseCommit);
  } catch {
    return false; // can't check → don't claim pre-existing
  }
  try {
    const detected = testCommandFor(dir, projectDir);
    if (!detected) return false;
    const { exitCode } = await run(detected.bin, detected.args, { cwd: detected.cwd, timeoutMs: 300_000 });
    return exitCode !== 0;
  } catch {
    return false;
  } finally {
    removeWorktree(dir);
  }
}

// A bisect runs the target's test suite several times (once per step), so it's slow — the last
// result is cached and a background trigger runs it, mirroring the dependency-scan pattern.
let _lastBisect = null;
let _bisecting = false;
export const getLastBisect = () => _lastBisect;
export const isBisectRunning = () => _bisecting;
export function startBisect(opts = {}) {
  if (_bisecting) return false;
  _bisecting = true;
  _lastBisect = { running: true, startedAt: Date.now(), steps: 0, checked: [] };
  bisectRegression({
    ...opts,
    onStep: (s) => { if (_lastBisect) { _lastBisect.steps = s.step; _lastBisect.current = s; } },
  })
    .then((r) => { _lastBisect = { running: false, finishedAt: Date.now(), ...r }; })
    .catch((e) => { _lastBisect = { running: false, finishedAt: Date.now(), error: e.message, checked: [] }; })
    .finally(() => { _bisecting = false; });
  return true;
}

/**
 * Revert a single commit on the work branch, cleanly, without checking the branch out in the
 * main repo. Uses a detached worktree at the branch tip; on a revert conflict it aborts and
 * reports (the change is too entangled to auto-undo — a human must).
 * @returns {{ok:boolean, sha?:string, reason?:string}}
 */
export function revertCommit({ branch = WORK_BRANCH, sha } = {}) {
  if (!sha) return { ok: false, reason: 'no sha given' };
  const dir = createSandbox([], branch); // worktree at the branch tip
  try {
    try {
      git(['-c', 'user.name=ISL Agents', '-c', 'user.email=agents@isl.local', 'revert', '--no-edit', sha], dir);
    } catch (e) {
      try { git(['revert', '--abort'], dir); } catch { /* nothing to abort */ }
      return { ok: false, reason: `revert did not apply cleanly: ${String(e.message).split('\n')[0]}` };
    }
    const newSha = git(['rev-parse', 'HEAD'], dir);
    moveBranch(branch, newSha); // advance the branch ref to the revert commit
    lg.info(`reverted ${sha.slice(0, 8)} on ${branch} → ${newSha.slice(0, 8)}`);
    return { ok: true, sha: newSha };
  } finally {
    removeWorktree(dir);
  }
}
