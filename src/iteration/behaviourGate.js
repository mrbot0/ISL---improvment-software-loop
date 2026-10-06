import { createSandbox, removeWorktree, runVerified } from '../sandbox/worktree.js';
import { testCommandFor, isToolMissing } from './langRunners.js';
import { log } from '../logger.js';

/**
 * BEHAVIOUR-PRESERVATION GATE (ISL_IMPROVE "The architecture gap", pillar C, P0).
 *
 * The evidence review found refactoring is where the fleet fails hardest — a 0% land rate for
 * `refactor/frontend` — and this session's failure census put "a refactor that added code and
 * deleted none" at the top of the list, 8 of 56 recorded failures. The existing gates catch the
 * *shape* of a bad refactor (no deletions, dead code). None of them catch the thing that actually
 * makes a refactor wrong: **it changed what the software does.**
 *
 * "The tests pass" cannot catch that, and it is the only question the test grader asks. A refactor
 * that breaks a test which was ALREADY broken looks identical to one that breaks a healthy test; a
 * refactor that silently starts passing a test nobody expected it to touch looks like success. So
 * this gate runs the full suite at the BASE commit and compares it, suite by suite, with the run
 * against the change.
 *
 * ── What counts as a violation ──────────────────────────────────────────────────────────────────
 *   pass → fail   VETO. A refactor broke something that worked. This is the whole point.
 *   fail → pass   REPORTED, not vetoed. It is still a behaviour change and the operator should see
 *                 it, but refusing an accidental fix would be perverse — and a human reading
 *                 "this refactor also fixed 3 tests" learns something a veto would have hidden.
 *   counts moved  REPORTED. Same pass/fail verdict but a different number of tests ran, which
 *                 usually means a test file stopped being collected — a real and easily-missed way
 *                 to "keep the suite green" while deleting coverage.
 *
 * ── Why it is only applied to refactors ─────────────────────────────────────────────────────────
 * Behaviour preservation is the definition of a refactor and NOT the goal of a feature. Running the
 * base suite doubles verification time, so paying that cost on every iteration would slow the loop
 * for a guarantee most tasks do not want. The engine applies it exactly where the claim is made.
 */

const lg = log.for('behaviour');

/**
 * Test counts, parsed polyglot-ly from a runner's output.
 *
 * Deliberately returns null rather than zeros when nothing matches: an unparsed suite must fall back
 * to comparing exit codes and SAY so, because a confident "0 tests, unchanged" from a runner we
 * could not read would be the gate lying about having checked.
 */
export function parseCounts(output) {
  const s = String(output || '');
  let m;

  // vitest / jest — "Tests  12 passed | 2 failed (14)"
  if ((m = s.match(/Tests\s+(?:(\d+)\s+failed\s*\|\s*)?(\d+)\s+passed(?:\s*\|\s*(\d+)\s+skipped)?/i))) {
    return { passed: Number(m[2]), failed: Number(m[1] || 0), skipped: Number(m[3] || 0) };
  }
  // jest classic — "Tests: 2 failed, 12 passed, 14 total"
  if ((m = s.match(/Tests:\s*(?:(\d+)\s+failed,\s*)?(?:(\d+)\s+skipped,\s*)?(\d+)\s+passed/i))) {
    return { passed: Number(m[3]), failed: Number(m[1] || 0), skipped: Number(m[2] || 0) };
  }
  // pytest — "3 failed, 12 passed, 1 skipped in 2.3s"
  if (/\b\d+\s+(?:passed|failed)\b/.test(s) && /in\s+[\d.]+s/.test(s)) {
    const passed = Number(s.match(/(\d+)\s+passed/)?.[1] || 0);
    const failed = Number(s.match(/(\d+)\s+failed/)?.[1] || 0);
    const skipped = Number(s.match(/(\d+)\s+skipped/)?.[1] || 0);
    if (passed || failed) return { passed, failed, skipped };
  }
  // node --test — a summary block of "ℹ tests 3 / ℹ pass 2 / ℹ fail 1". Matched on the words alone
  // so the leading glyph (which varies with the reporter and the terminal) is never load-bearing.
  if (/^\s*\W?\s*tests\s+\d+\s*$/m.test(s) && /^\s*\W?\s*pass\s+\d+\s*$/m.test(s)) {
    return {
      passed: Number(s.match(/^\s*\W?\s*pass\s+(\d+)\s*$/m)?.[1] || 0),
      failed: Number(s.match(/^\s*\W?\s*fail\s+(\d+)\s*$/m)?.[1] || 0),
      skipped: Number(s.match(/^\s*\W?\s*skipped\s+(\d+)\s*$/m)?.[1] || 0),
    };
  }
  // go test — one "--- PASS/FAIL" line per test
  const goPass = (s.match(/^--- PASS:/gm) || []).length;
  const goFail = (s.match(/^--- FAIL:/gm) || []).length;
  if (goPass || goFail) return { passed: goPass, failed: goFail, skipped: (s.match(/^--- SKIP:/gm) || []).length };

  // cargo — "test result: ok. 12 passed; 0 failed; 1 ignored"
  if ((m = s.match(/test result:.*?(\d+)\s+passed;\s*(\d+)\s+failed(?:;\s*(\d+)\s+ignored)?/i))) {
    return { passed: Number(m[1]), failed: Number(m[2]), skipped: Number(m[3] || 0) };
  }
  return null;
}

/** Run one project's suite in a given tree. */
async function runSuite(root, projectDir) {
  const suite = testCommandFor(root, projectDir);
  if (!suite) return { ran: false, reason: 'no test suite detected' };
  const { exitCode, output } = await runVerified({
    worktree: root, projectDir, command: suite.bin, args: suite.args, timeoutMs: 300_000,
  }).catch((e) => ({ exitCode: 127, output: String(e.message) }));
  if (isToolMissing(output)) return { ran: false, reason: `${suite.id} is not installed` };
  return { ran: true, id: suite.id, ok: exitCode === 0, exitCode, counts: parseCounts(output) };
}

/**
 * Compare the suite before and after the change.
 *
 * @param {{sandboxRoot:string, baseCommit:string, projectDirs?:string[], logger?:object}} opts
 * @returns {Promise<{checked:boolean, veto:boolean, summary:string, reason:string|null,
 *                    violations:Array, notes:Array, projects:Array}>}
 */
export async function checkBehaviourPreserved({ sandboxRoot, baseCommit, projectDirs = ['.'], logger = lg }) {
  if (!baseCommit) {
    return { checked: false, veto: false, summary: 'behaviour gate skipped — no base commit to compare against', reason: null, violations: [], notes: [], projects: [] };
  }

  let baseTree;
  try {
    baseTree = createSandbox([], baseCommit);
  } catch (err) {
    // Failing OPEN is right: this gate exists to catch a regression, and refusing every refactor
    // because a worktree could not be made would block work it has no evidence against. It says so.
    return { checked: false, veto: false, summary: `behaviour gate skipped — could not check out the base (${err.message})`, reason: null, violations: [], notes: [], projects: [] };
  }

  const violations = [];
  const notes = [];
  const projects = [];
  try {
    for (const dir of projectDirs) {
      const before = await runSuite(baseTree, dir);
      const after = await runSuite(sandboxRoot, dir);

      if (!before.ran || !after.ran) {
        notes.push(`${dir}: not compared — ${before.ran ? after.reason : before.reason}`);
        projects.push({ dir, compared: false, reason: before.ran ? after.reason : before.reason });
        continue;
      }

      const entry = { dir, compared: true, before: { ok: before.ok, counts: before.counts }, after: { ok: after.ok, counts: after.counts } };
      projects.push(entry);

      // The violation that matters: something that worked, stopped working.
      if (before.ok && !after.ok) {
        violations.push(`${dir}: the suite passed at the base commit and FAILS after this change`);
        continue;
      }
      // A behaviour change in the other direction — surfaced, never vetoed.
      if (!before.ok && after.ok) {
        notes.push(`${dir}: the suite was failing at the base and now passes — a behaviour change, not a regression`);
      }

      // Counts. A suite can stay green while quietly collecting fewer tests, which is how coverage
      // disappears without anything going red.
      if (before.counts && after.counts) {
        const beforeRan = before.counts.passed + before.counts.failed;
        const afterRan = after.counts.passed + after.counts.failed;
        if (afterRan < beforeRan) {
          violations.push(`${dir}: ${beforeRan - afterRan} fewer test(s) ran after the change (${beforeRan} → ${afterRan}) — tests stopped being collected`);
        } else if (afterRan > beforeRan) {
          notes.push(`${dir}: ${afterRan - beforeRan} more test(s) ran after the change (${beforeRan} → ${afterRan})`);
        }
        if (after.counts.failed > before.counts.failed) {
          violations.push(`${dir}: ${after.counts.failed - before.counts.failed} more test(s) fail after the change (${before.counts.failed} → ${after.counts.failed})`);
        }
      } else {
        // Say it plainly rather than implying a check that did not happen.
        notes.push(`${dir}: test counts could not be parsed from this runner — compared by exit code only`);
      }
    }
  } finally {
    try { removeWorktree(baseTree); } catch { /* best-effort */ }
  }

  const compared = projects.filter((p) => p.compared).length;
  const veto = violations.length > 0;
  const summary = !compared
    ? 'behaviour gate could not compare any suite — nothing was verified'
    : veto
      ? `behaviour NOT preserved: ${violations[0]}`
      : `behaviour preserved across ${compared} suite(s)${notes.length ? ` (${notes.length} note(s))` : ''}`;

  logger[veto ? 'warn' : 'info']?.(summary);
  return { checked: compared > 0, veto, summary, reason: veto ? violations.join('; ') : null, violations, notes, projects };
}

/**
 * Does this iteration CLAIM to be a refactor?
 *
 * Shares its wording with the engine's duplicating-refactor veto on purpose: a task that is held to
 * the "must delete something" rule must be held to the "must not change behaviour" rule too, or an
 * agent could dodge one by phrasing around the other.
 */
export function isRefactorIntent(batchPlan) {
  if (!batchPlan) return false;
  const tasks = batchPlan.tasks || [];
  if (tasks.some((t) => t.agent === 'refactor')) return true;
  const text = `${batchPlan.title || ''} ${tasks.map((t) => t.title || '').join(' ')}`;
  return /\b(refactor|split|extract|dedupe|god-file|hoist|consolidat|unif)\w*/i.test(text);
}
