import { run, runVerified } from '../sandbox/worktree.js';
import { llmText } from './llm.js';
import { findDeadCode } from './deadCode.js';
import { scanDiff, scorePenalty } from './securityGate.js';
import { scanSafety } from './safetyGate.js';
import { parseCheckAll, testCommandFor, isToolMissing } from './langRunners.js';
import { confirmFlaky, recordFlakyEvent, getFlakyRetries } from './flaky.js';
import { failsAtBase } from './bisect.js';
import { memoryBlurb } from '../memory/memoryDb.js';
import { briefingFor } from '../context/fleetBriefing.js';
import { changedPaths as diffPaths } from './changedLines.js';
import { modelFor } from '../config.js';
import { log } from '../logger.js';

const clamp = (n) => Math.max(0, Math.min(100, Math.round(n)));

/** Pull the first 0-100 integer out of a grader's reply. */
function scoreFrom(text, dflt = 70) {
  const m = String(text).match(/\b(100|\d{1,2})\b/);
  return m ? clamp(Number(m[1])) : dflt;
}

/** Trim a diff so a grader prompt stays inside the context window. */
const trimDiff = (diff, n = 12000) => (diff.length <= n ? diff : diff.slice(0, n) + `\n…[diff truncated, ${diff.length - n} chars]`);

/* --------------------------------- review --------------------------------- */

export async function review({ diff, sandboxRoot, signal, logger = log.for('reviewer') }) {
  // Fast structural gate first — POLYGLOT: syntax-check every changed file in whatever
  // language it is (JS, Python, Ruby, PHP, Go…), skipping languages whose toolchain isn't
  // installed rather than failing them.
  const { issues: parseIssues, skipped } = await parseCheckAll(sandboxRoot, changedFiles(diff));
  if (skipped.length) logger.info?.(`parse-check skipped (toolchain absent): ${skipped.join(', ')}`);
  if (parseIssues.length) {
    const summary = `Parse errors in ${parseIssues.length} file(s): ${parseIssues[0]}`;
    logger.warn?.(summary);
    return { score: 0, summary, parseIssues };
  }

  if (!diff.trim()) return { score: 100, summary: 'No changes to review.' };

  // Structural DEAD-CODE gate (deterministic, before the LLM): a new file nobody
  // imports, or a new export nobody uses, is not an improvement — it is cruft. The
  // LLM reviewer used to miss this and hand out 99s for it. We catch it for real.
  const dead = findDeadCode({ diff, sandboxRoot });

  /*
   * WHAT MUST NOT BREAK, GIVEN TO THE ONE GRADER THAT COULD ACT ON IT.
   *
   * Review is the only grader that asks whether a change is the RIGHT change, and it was doing so
   * with no knowledge of the application: not what it is, not which area the diff touches, and not
   * the invariants the Context Manager had already recorded — among them "the API contract must
   * never change" and "a microservice outage must never block user access". Scoped to the files in
   * the diff, so the block stays short enough to be read rather than skimmed.
   */
  const briefing = briefingFor('reviewer', { files: diffPaths(diff), includeSituation: false });
  const memHint = memoryBlurb({ extraScopes: ['area:review'], limit: 6 });
  const system =
    'You are a demanding senior code reviewer. Grade this diff HONESTLY for whether it is a real, ' +
    'complete improvement. Reply with a single integer 0-100 on the first line (100 = merge as-is, ' +
    'below 60 = do not merge), then one sentence of justification.\n\n' +
    'Judge harshly, in this order:\n' +
    '1. DEAD CODE / NO-OP: does it add a function, hook, helper or file that nothing calls or imports? ' +
    'Does a "refactor" ADD a new abstraction without deleting/replacing the original code it duplicates ' +
    '(additions but ~no deletions)? That is NOT an improvement — score it below 40.\n' +
    '2. COMPLETENESS: does the change actually do what its task claims, wired end-to-end — not a stub, ' +
    'not a TODO, not a definition left unused?\n' +
    '3. CORRECTNESS & conventions: bugs, broken callers, error handling, matching the surrounding style.\n' +
    'A small change that is fully wired in beats a large one that adds unused scaffolding.' +
    (briefing ? `\n\n${briefing}` : '') +
    (memHint ? `\n\n${memHint}` : '');

  let text = '';
  let usage = { promptTokens: 0, evalTokens: 0 };
  try {
    const deadNote = dead.length
      ? `\n\nSTATIC ANALYSIS ALREADY FOUND DEAD CODE in this diff (treat as fact):\n${dead.map((d) => `- ${d.message}`).join('\n')}`
      : '';
    const r = await llmText({ system, user: trimDiff(diff) + deadNote, model: modelFor('review'), temperature: 0.2, signal });
    text = r.text;
    usage = r.usage || usage;
  } catch (err) {
    logger.warn?.(`review LLM failed: ${err.message}`);
    // Even if the LLM is unavailable, the deterministic dead-code gate still bites.
    return dead.length
      ? { score: 35, summary: `Dead code: ${dead[0].message}`, dead }
      : { score: 70, summary: `review skipped: ${err.message}` };
  }
  let score = scoreFrom(text);
  // The LLM cannot overrule the structural finding: dead code caps the score below the
  // merge threshold no matter how the prose reads.
  if (dead.length) score = Math.min(score, 38);
  const deadPrefix = dead.length ? `[dead code: ${dead.length}] ` : '';
  const summary = `Review ${score}/100 — ${deadPrefix}${text.replace(/\n/g, ' ').slice(0, 200)}`;
  logger[dead.length ? 'warn' : 'info']?.(summary);
  return { score, summary, dead, tokensIn: usage.promptTokens, tokensOut: usage.evalTokens };
}

/* -------------------------------- security -------------------------------- */

export async function security({ diff, signal, logger = log.for('security-grade') }) {
  if (!diff.trim()) return { score: 100, summary: 'No changes to audit.' };

  // DETERMINISTIC gates first: secrets/weakened controls (security) AND irreversible
  // destruction (safety) are facts, not opinions, and they VETO no matter what the LLM says.
  const secScan = scanDiff(diff);
  const safeScan = scanSafety(diff);
  const scan = {
    findings: [...secScan.findings, ...safeScan.findings],
    veto: secScan.veto || safeScan.veto,
    summary: [secScan.findings.length ? secScan.summary : '', safeScan.findings.length ? safeScan.summary : ''].filter(Boolean).join(' | ') || 'No security/safety issues found.',
  };

  const system =
    'You are a security auditor. Inspect this diff for introduced vulnerabilities: injection, ' +
    'missing authorization, secrets, unsafe input handling, broken auth, data exposure. ' +
    'Reply with a single integer 0-100 on the first line (100 = no concerns, below 60 = a real ' +
    'vulnerability was introduced), then one sentence naming the top concern if any.';
  let text = '';
  let usage = { promptTokens: 0, evalTokens: 0 };
  try {
    const deadNote = scan.findings.length ? `\n\nSTATIC SECURITY SCAN FOUND (treat as fact):\n${scan.findings.map((f) => `- [${f.severity}] ${f.message}`).join('\n')}` : '';
    const r = await llmText({ system, user: trimDiff(diff) + deadNote, model: modelFor('security'), temperature: 0.2, signal });
    text = r.text;
    usage = r.usage || usage;
  } catch (err) {
    // Even with no LLM, the deterministic scan still bites.
    return scan.findings.length
      ? { score: scan.veto ? 0 : Math.max(0, 70 - scorePenalty(scan.findings)), summary: `Security: ${scan.summary}`, findings: scan.findings, veto: scan.veto }
      : { score: 75, summary: `security grade skipped: ${err.message}` };
  }
  let score = scoreFrom(text);
  if (scan.findings.length) score = Math.max(0, Math.min(score, 100 - scorePenalty(scan.findings)));
  if (scan.veto) score = 0;
  const prefix = scan.findings.length ? `[scan: ${scan.findings.length}${scan.veto ? ', VETO' : ''}] ` : '';
  const summary = `Security ${score}/100 — ${prefix}${text.replace(/\n/g, ' ').slice(0, 180)}`;
  logger[score < 60 ? 'warn' : 'info']?.(summary);
  return { score, summary, findings: scan.findings, veto: scan.veto, tokensIn: usage.promptTokens, tokensOut: usage.evalTokens };
}

/* ---------------------------------- test ---------------------------------- */

export async function test({ sandboxRoot, changedPaths = [], iterationId = null, baseCommit = null, logger = log.for('tester') }) {
  // POLYGLOT: derive candidate project dirs from the changed files (their top folder) plus
  // the repo root, and run whatever test suite each one actually has — vitest, pytest,
  // go test, cargo — not just Node. A missing toolchain is skipped, never failed.
  const dirs = new Set(['.']);
  for (const p of changedPaths) {
    const top = p.split('/')[0];
    if (top && !top.includes('.')) dirs.add(top);
  }

  const results = [];
  const seenSuites = new Set();
  // Whether the suites actually ran in isolation. Reported alongside the score so a green
  // result never implies a guarantee the machine could not give.
  let lastIsolation = null;
  for (const dir of dirs) {
    const suite = testCommandFor(sandboxRoot, dir);
    if (!suite) continue;
    const key = `${suite.id}:${suite.cwd}`;
    if (seenSuites.has(key)) continue;
    seenSuites.add(key);
    // The test suite executes the TARGET project's code — the one step most able to touch the
    // operator's machine — so it goes through the hermetic runner. With a container runtime present
    // it runs isolated with the network off; without one it behaves exactly as before and reports
    // `isolated: false` with the reason, which is what reaches the run record.
    const { exitCode, output, ms, isolated, isolationReason } = await runVerified({
      worktree: sandboxRoot,
      projectDir: dir,
      command: suite.bin,
      args: suite.args,
      timeoutMs: 300000,
    }).catch((e) => ({ exitCode: 127, output: String(e.message), ms: 0, isolated: false, isolationReason: e.message }));
    if (isolated === false && isolationReason) lastIsolation = { isolated: false, reason: isolationReason };
    else if (isolated) lastIsolation = { isolated: true, reason: null };
    if (isToolMissing(output)) {
      results.push({ project: dir, id: suite.id, ok: true, skipped: true, summary: `${suite.id} not installed` });
      continue;
    }
    let ok = exitCode === 0;
    let flaky = false;
    let preExisting = false;
    // FLAKY GUARD: a failing suite is re-run a bounded number of times. If it then passes, the
    // failure was non-deterministic — don't reject a good change for it; record the flake instead.
    if (!ok) {
      const retries = getFlakyRetries();
      if (retries > 0) {
        const conf = await confirmFlaky(suite, retries).catch(() => ({ flaky: false, attempts: 0 }));
        if (conf.flaky) {
          ok = true;
          flaky = true;
          recordFlakyEvent({ project: dir, suite: suite.id, iterationId, attempts: conf.attempts, detail: tail(output) });
          logger.warn?.(`${dir} (${suite.id}) FAILED then passed on retry — treated as FLAKY, not blocking`);
        }
      }
      // PRE-EXISTING CHECK: a genuine failure might not be THIS change's fault. Re-run the suite at
      // the commit the iteration started from — if it fails there too, an earlier commit broke it.
      // We still don't land onto a broken base, but the blame (and the bisect) go to the real culprit.
      if (!ok && baseCommit) {
        preExisting = await failsAtBase({ projectDir: dir, baseCommit }).catch(() => false);
        if (preExisting) {
          logger.warn?.(`${dir} (${suite.id}) also fails at base ${String(baseCommit).slice(0, 8)} — PRE-EXISTING regression, not caused by this change`);
        }
      }
    }
    results.push({ project: dir, id: suite.id, ok, flaky, preExisting, exitCode, ms, output: tail(output) });
    if (!flaky) logger[ok ? 'info' : 'warn']?.(`${dir} (${suite.id}) tests ${ok ? 'passed' : 'FAILED'} (${ms}ms)`);
  }

  if (!results.length) return { score: 100, summary: 'No test suite detected for the changed areas.', results };

  const failed = results.filter((r) => !r.ok && !r.skipped);
  const suites = [...new Set(results.map((r) => r.id))].join('/');

  /*
   * ATTRIBUTION. The pre-existing check already knew which failures this change did not cause — and
   * then scored them against it anyway. Measured over 25 runs, six committed with `test = 0` while
   * their own summary said "also fails at base; an earlier commit is the culprit".
   *
   * Two harms came from that, and the second is the dangerous one:
   *   1. A good change scored 83 instead of 98, because a suite someone else broke dragged a zero
   *      through the weighted average.
   *   2. `test = 0` became the NORMAL state — so a change that genuinely broke the suite looked
   *      exactly like one that didn't, and nobody could tell them apart from the number.
   *
   * So the score is computed over the ATTRIBUTABLE suites only. A suite that was already red stays
   * loudly reported (and still feeds the auto-bisect) but no longer votes on this change's grade.
   */
  const broke = failed.filter((r) => !r.preExisting); // passed at base, fails now — this change did it
  const inherited = failed.filter((r) => r.preExisting); // already red before this change existed
  const attributable = results.filter((r) => !r.skipped && !r.preExisting);
  const score = attributable.length
    ? clamp((attributable.filter((r) => r.ok).length / attributable.length) * 100)
    // Every failure was inherited and nothing else ran: there is nothing here to grade. 100 would
    // claim a pass nobody earned, 0 would blame the wrong change — so it is neutral, and the
    // summary carries the truth.
    : 100;

  const summary = broke.length
    ? `${broke.length} test suite(s) BROKEN by this change (${suites})`
    : inherited.length
      ? `${inherited.length} suite(s) already failing before this change (${suites}) — an earlier commit is the culprit; this change broke nothing`
      : `All test suites pass (${suites})`;

  return {
    score,
    summary,
    results,
    // `broke` is what the engine vetoes on: a change that turns a green suite red must not land,
    // whatever the weighted average says.
    broke: broke.map((r) => ({ project: r.project, id: r.id, output: r.output })),
    inherited: inherited.map((r) => ({ project: r.project, id: r.id })),
    preExisting: inherited.length > 0,
    isolation: lastIsolation,
  };
}

/* -------------------------------- helpers --------------------------------- */

/*
 * One parser for "which files does this diff touch", owned by changedLines.js.
 *
 * There were four copies, none of which agreed on the edge cases: a deleted file's "/dev/null"
 * path, the trailing tab some git configurations append, the leading "a/" or "b/". Aliased on
 * import as diffPaths because the `test()` grader below takes a parameter named `changedPaths`,
 * which would otherwise shadow the imported function inside it.
 */
const changedFiles = (diff) => diffPaths(diff);

const tail = (s, n = 3000) => (s.length <= n ? s : '…\n' + s.slice(-n));
