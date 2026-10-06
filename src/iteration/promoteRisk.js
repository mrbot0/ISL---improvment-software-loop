import { git } from '../sandbox/worktree.js';
import { db } from '../db.js';
import { log } from '../logger.js';

/**
 * WHICH OF THESE COMMITS IS SAFE TO PROMOTE?
 *
 * Promotion was all-or-nothing up to a chosen commit, and the only thing that could stop it was a
 * merge conflict. Everything ISL already knew about a commit — the score it landed with, whether a
 * suite was red at the time, whether a single test exercises the lines it added — existed in the
 * run record and reached no part of the decision. The operator promoted twenty commits on the
 * strength of them having been committed at all.
 *
 * **The contiguity constraint is the whole shape of this problem.** Promotion is a fast-forward, so
 * what lands is a PREFIX of the work branch: you cannot skip a bad commit in the middle and take
 * the good ones after it. So "promote only the safe commits" cannot mean cherry-picking — it means
 * finding the longest prefix with nothing risky in it. Saying that plainly matters, because an
 * operator who thinks they excluded commit 5 while promoting commit 9 has promoted commit 5.
 */

const lg = log.for('promote-risk');
const RUN_SUBJECT = /\[ai-iter#(\d+)\]/i;

/**
 * Every risk a commit can carry, with what it means and how it is resolved.
 *
 * **What blocks, and why so little does.**
 *
 * The first version of this blocked on a commit's historical scores, and it made promotion
 * *unusable*: on a real branch it stopped at the 8th of 57 commits because that one had landed with
 * a red suite — months ago, in a suite a later commit had since fixed. A gate that is correct about
 * history and wrong about the present blocks work for no benefit, and an operator who cannot
 * promote stops caring what the loop produces.
 *
 * A fast-forward promotes a **range**, and the only state that reaches the base branch is the state
 * at the END of that range. Whether commit 8 was green in isolation is a fact about the past;
 * whether commit 57 is green is the question. So per-commit history is **advisory** — it is context
 * for choosing how far to go — and the authoritative check is `verifyAtCommit()`, which runs the
 * real suite at the chosen tip.
 *
 * Two things still block, because neither is undone by a later commit:
 *   - a security finding, since a secret that entered history stays in history;
 *   - nothing else. Conflicts with your own edits are now resolved by stashing them around the
 *     fast-forward, so they are a warning about what will happen, not a wall.
 */
export const RISKS = {
  'low-score': {
    blocks: false,
    label: 'landed below the quality bar',
    fixable: false,
    why: 'the run scored under the rollback threshold — worth reading before promoting, but a later commit may well have improved it',
  },
  'broke-tests': {
    blocks: false,
    label: 'a suite was failing when it landed',
    fixable: true,
    why: 'the tests were red at the moment this committed. A later commit may have fixed them — verify the tip to find out, because that is the state that actually lands',
  },
  'app-broken': {
    blocks: false,
    label: 'the app did not boot',
    fixable: true,
    why: 'the workbench check failed on this commit. What matters is whether it boots at the tip you promote to',
  },
  'security-finding': {
    blocks: true,
    label: 'the security scan flagged it',
    fixable: false,
    why: 'a secret or a weakened control was reported and not cleared — and unlike a broken test, a secret that enters history is not undone by a later commit',
  },
  'untested-change': {
    blocks: false,
    label: 'its new lines are barely exercised',
    fixable: true,
    why: 'the coverage gate measured little or none of what this commit added — a real risk, but not a defect on its own',
  },
  'conflict': {
    blocks: false,
    label: 'overlaps your uncommitted edits',
    fixable: true,
    why: 'you have local changes to a file this commit touches. Promoting with "set my edits aside" stashes just those files, fast-forwards, and restores them',
  },
  'unknown-origin': {
    blocks: false,
    label: 'not produced by ISL',
    fixable: false,
    why: 'no run record for this commit, so none of the gate history applies to it — judge it yourself',
  },
};

/** The iteration behind a commit, or null when the commit did not come from a run. */
function runFor(sha, subject) {
  const m = RUN_SUBJECT.exec(subject || '');
  if (!m) return null;
  try {
    return db.prepare(
      `SELECT id, status, total_score, review_score, security_score, test_score, workbench_score,
              coverage_json, behaviour_json, files_changed
         FROM iterations WHERE id = ?`,
    ).get(Number(m[1])) || null;
  } catch {
    return null;
  }
}

const rollbackThreshold = () => {
  try { return Number(db.prepare("SELECT value FROM kpi WHERE key = 'rollback_threshold'").get()?.value ?? 60); }
  catch { return 60; }
};

/** Everything wrong with one commit, worst first. */
function assess(sha, subject, run, conflictFiles, threshold) {
  const risks = [];
  const add = (code, detail) => risks.push({ code, detail, ...RISKS[code] });

  if (conflictFiles?.length) add('conflict', `you have edited ${conflictFiles.join(', ')}`);

  if (!run) {
    add('unknown-origin', 'no [ai-iter#N] in the subject');
    return risks;
  }

  if (run.total_score != null && run.total_score < threshold) {
    add('low-score', `scored ${run.total_score}, below the ${threshold} bar`);
  }
  /*
   * THRESHOLDS FROM THIS REPO'S OWN DISTRIBUTION, NOT FROM A ROUND NUMBER.
   *
   * The first version blocked anything under 100 on every signal, and measuring it against the 102
   * committed runs showed why that is useless: 59 of them have a security score below 100, but only
   * 3 are below 90 — the median is **95**, so a five-point deduction is the normal passing value,
   * not a finding. Blocking at <100 would have marked 58% of the history dangerous, which trains an
   * operator to promote past the warning without reading it.
   *
   * These also must not re-litigate a decision the engine already made. Every one of these commits
   * cleared the security veto, the test veto and the score threshold at the time it landed. What is
   * worth surfacing here is the outlier, not the deduction.
   *
   *   security  < 90   →  3 of 102   (median 95)
   *   test      < 70   →  23 of 102  (and they cluster at 0 — real failures, not gradual ones)
   *   workbench < 90   →  0 of 102   (it has never fired; kept for the case where it should)
   */
  if (run.test_score != null && run.test_score < 70) {
    add('broke-tests', `test score ${run.test_score} — a suite was red when this landed`);
  }
  if (run.workbench_score != null && run.workbench_score < 90) {
    add('app-broken', `workbench score ${run.workbench_score} — the app did not fully come up`);
  }
  if (run.security_score != null && run.security_score < 90) {
    add('security-finding', `security score ${run.security_score}, well below the usual 95`);
  }

  // The coverage gate ships advisory, so a commit can land with almost none of its new lines
  // exercised. That is exactly the thing worth knowing before it reaches the base branch.
  try {
    const cov = run.coverage_json ? JSON.parse(run.coverage_json) : null;
    if (cov?.applicable && cov.pct != null && cov.pct < (cov.floor ?? 50)) {
      add('untested-change', `${cov.pct}% of the ${cov.executable} line(s) it added are exercised`);
    }
  } catch { /* an unreadable record is simply not a risk signal */ }

  try {
    const beh = run.behaviour_json ? JSON.parse(run.behaviour_json) : null;
    if (beh?.veto) add('broke-tests', beh.reason || 'the behaviour gate vetoed it');
  } catch { /* same */ }

  return risks;
}

/**
 * Assess every commit ahead of the base branch, and work out how far it is safe to promote.
 *
 * @param {object} opts
 * @param {string[]} opts.commits    `git log --oneline` lines, NEWEST FIRST (as git prints them).
 * @param {object}   opts.conflicts  sha (short) → files, from `conflictingCommits()`.
 * @returns {{commits: Array, safeCount: number, safeUpTo: string|null, blockedAt: object|null}}
 */
export function assessPromotion({ commits = [], conflicts = {} } = {}) {
  const threshold = rollbackThreshold();

  const assessed = commits.map((line) => {
    const sha = line.slice(0, line.indexOf(' '));
    const subject = line.slice(line.indexOf(' ') + 1);
    const run = runFor(sha, subject);
    const risks = assess(sha, subject, run, conflicts[sha], threshold);
    return {
      sha,
      subject,
      runId: run?.id ?? null,
      score: run?.total_score ?? null,
      filesChanged: run?.files_changed ?? null,
      risks,
      blocking: risks.some((r) => r.blocks),
      fixable: risks.some((r) => r.blocks && r.fixable),
    };
  });

  /*
   * OLDEST FIRST for the prefix walk.
   *
   * `git log` prints newest first, but a fast-forward lands the oldest commit first. Walking the
   * list as printed would compute a "safe prefix" from the wrong end — and would confidently offer
   * to promote a set whose FIRST commit is the broken one.
   */
  const oldestFirst = [...assessed].reverse();
  let safeCount = 0;
  let blockedAt = null;
  for (const c of oldestFirst) {
    if (c.blocking) { blockedAt = c; break; }
    safeCount++;
  }

  return {
    commits: assessed,
    threshold,
    safeCount,
    safeUpTo: safeCount > 0 ? oldestFirst[safeCount - 1].sha : null,
    blockedAt: blockedAt
      ? { sha: blockedAt.sha, subject: blockedAt.subject, runId: blockedAt.runId, risks: blockedAt.risks, fixable: blockedAt.fixable }
      : null,
    // Stated rather than implied: an operator who believes they can exclude a middle commit will
    // promote it without realising.
    note: blockedAt
      ? `Promotion is a fast-forward, so only a contiguous prefix can land. ${safeCount} commit(s) are safe; the ${safeCount + 1}th (${blockedAt.sha}) is not, and nothing after it can be promoted without it.`
      : 'Every commit ahead passes the checks recorded for it.',
  };
}

/**
 * Does the code actually work at the commit you are about to promote to?
 *
 * This is the authoritative check, and the only one that answers the real question. A fast-forward
 * installs the state at ONE commit — the tip of the range — so running the suite and the boot check
 * there settles it, whatever any individual commit's history says. It routinely CLEARS commits the
 * historical record flags: a suite that was red at commit 8 and green at commit 57 makes promoting
 * to 57 perfectly safe, and the old per-commit gate refused it anyway.
 *
 * Runs entirely in a detached worktree; the operator's checkout is not touched.
 */
export async function verifyAtCommit(sha, { signal } = {}) {
  // `runVerified` lives in worktree.js, not container.js — importing it from the wrong module gave
  // "runVerified is not a function" at the moment the operator pressed verify.
  const { createSandbox, removeWorktree, runVerified } = await import('../sandbox/worktree.js');
  const { verifyLocalExecution } = await import('../workbench/workbench.js');
  const { testCommandFor, isToolMissing } = await import('./langRunners.js');

  let sandbox = null;
  const started = Date.now();
  try {
    sandbox = createSandbox([], sha);
  } catch (err) {
    return { ok: false, error: `could not create a worktree at ${String(sha).slice(0, 8)}: ${err.message}` };
  }

  try {
    const suites = [];
    // The same directories the pipeline tests: the repo root plus each top-level project.
    const dirs = new Set(['.']);
    try {
      for (const line of git(['ls-tree', '--name-only', sha]).split('\n')) {
        const d = line.trim();
        if (d && !d.includes('.')) dirs.add(d);
      }
    } catch { /* fall back to the root alone */ }

    for (const dir of dirs) {
      const suite = testCommandFor(sandbox, dir);
      if (!suite) continue;
      const res = await runVerified({ worktree: sandbox, projectDir: dir, command: suite.bin, args: suite.args, timeoutMs: 300_000 })
        .catch((e) => ({ exitCode: 127, output: String(e.message) }));
      if (isToolMissing(res.output)) { suites.push({ dir, id: suite.id, skipped: true, reason: `${suite.id} not installed` }); continue; }
      suites.push({ dir, id: suite.id, ok: res.exitCode === 0, exitCode: res.exitCode, output: res.exitCode === 0 ? undefined : String(res.output || '').slice(-2000) });
    }

    const boots = await verifyLocalExecution({ sandboxRoot: sandbox, iterationId: null, signal }).catch((e) => ({ ok: false, summary: e.message, checks: {} }));
    const red = suites.filter((s) => !s.ok && !s.skipped);

    return {
      ok: red.length === 0 && boots.ok,
      sha: String(sha).slice(0, 8),
      ms: Date.now() - started,
      // Stated separately: "no suite exists here" and "every suite passed" are not the same claim,
      // and reporting the first as the second is how a gate certifies something it never checked.
      suitesRun: suites.filter((s) => !s.skipped).length,
      suites,
      boots: { ok: boots.ok, summary: boots.summary, score: boots.score },
      summary: red.length
        ? `${red.length} suite(s) fail at ${String(sha).slice(0, 8)}: ${red.map((s) => `${s.dir} (${s.id})`).join(', ')}`
        : !boots.ok
          ? `the app does not come up at ${String(sha).slice(0, 8)} — ${boots.summary}`
          : suites.filter((s) => !s.skipped).length
            ? `verified at ${String(sha).slice(0, 8)}: ${suites.filter((s) => !s.skipped).length} suite(s) green and the app boots`
            : `the app boots at ${String(sha).slice(0, 8)}, but no test suite was found to run`,
    };
  } finally {
    if (sandbox) removeWorktree(sandbox);
  }
}

/** A one-line verdict for a single commit, for the API and the tooltip. */
export function riskSummary(commit) {
  if (!commit.risks.length) return 'no recorded risk';
  return commit.risks.map((r) => r.label).join(' · ');
}
