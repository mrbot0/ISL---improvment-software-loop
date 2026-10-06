/**
 * Failure triage.
 *
 * When an iteration dies, the single most useful question is: *was the work
 * wrong, or was it merely stopped?* Those two have opposite remedies. An
 * interruption (you hit cancel, the server restarted, Ollama dropped the
 * connection) says nothing about the quality of the change — the right move is to
 * resume from exactly where it left off, keeping the edits already made. An
 * implementation error (the tests fail, the code doesn't parse, a public export
 * vanished) means the change itself is broken — resuming means going back to the
 * implementer with the failure in hand so it can fix its own work.
 *
 * Everything downstream (the restart button, the resume-from-phase logic, what we
 * tell the operator) keys off this classification, so it is deliberately explicit
 * rather than a regex buried in a catch block.
 */

export const KIND = {
  INTERRUPTION: 'interruption',
  IMPLEMENTATION: 'implementation',
  INFRASTRUCTURE: 'infrastructure',
};

/** Signatures that mean "stopped", not "wrong". */
const INTERRUPTION = [
  { re: /\binterrupted\b|\baborted\b|abort(?:error)?/i, why: 'The run was cancelled — either from the dashboard or because the server was stopped mid-iteration.' },
  // The stale-iteration reaper writes this verbatim. It sets its own verdict, so this signature is
  // belt-and-braces — but the default for an unrecognised message is "implementation error", and
  // blaming the change for a server restart is exactly the wrong answer to reach by accident.
  { re: /stopped while this iteration was running|server (?:stopped|restarted|died|crashed) (?:while|mid|during)/i, why: 'The agent server stopped while the iteration was in flight. Nothing about the work was judged — it simply never finished.' },
  { re: /econnrefused|econnreset|socket hang up|fetch failed|network|enotfound/i, why: 'The connection to Ollama dropped mid-generation. The model server was unreachable, not wrong.' },
  { re: /timed? ?out|etimedout|killed after \d+ms/i, why: 'A step exceeded its time budget and was killed. The work was cut short, not rejected.' },
  { re: /model .*not found|no such model/i, why: 'The configured model is not loaded in Ollama. Nothing was actually attempted.' },
];

/** Signatures that mean the produced change is genuinely broken. */
const IMPLEMENTATION = [
  // ── the vetoes that ACTUALLY fire ────────────────────────────────────────
  // These were missing, so the most common real failures fell through to "cause not recognised":
  // the operator got a generic explanation, and — worse — nothing scoped was learned from them.
  // Measured over 60 runs: refactor 7, security 3, boot 3, dead-code 1.
  {
    re: /refactor veto|added code but deleted nothing|duplicated instead of replacing/i,
    code: 'refactor-duplication',
    why: 'The change was framed as a refactor but only ADDED code — it deleted nothing, so the original still exists alongside the replacement. That is duplication, not a refactor.',
    remedy: 'Restart: the implementer gets its edits back and is told to DELETE the code it replaced in the same change, or to make the edit inline instead.',
  },
  {
    re: /security veto|weakened-security|removes a security control|introduces a secret/i,
    code: 'security-veto',
    why: 'The deterministic security gate refused the change: it either introduced a credential or removed an existing security control. No score overrides this.',
    remedy: 'Restart: the implementer is told exactly which control it removed and must preserve it, or move it rather than delete it.',
  },
  {
    re: /behaviour veto|behaviour NOT preserved|fewer test\(s\) ran|more test\(s\) fail/i,
    code: 'behaviour',
    why: 'The change claimed to be a refactor, but the test suite behaves differently than it did at the base commit. A refactor that changes what the software does is a bug wearing the name of a refactor.',
    remedy: 'Restart: the implementer is told exactly which suite diverged and must preserve the existing behaviour, or declare the change as a fix rather than a refactor.',
  },
  {
    re: /test veto|broke \d+ previously-passing/i,
    code: 'broke-tests',
    why: 'The change turned a test suite that was passing into one that fails. Unlike a pre-existing failure, this one is attributable: the suite was green at the base commit and is red after the change.',
    remedy: 'Restart: the implementer is told exactly which suite it broke and must make it pass again — or, if the test encoded the old behaviour deliberately, update the test and say so.',
  },
  {
    re: /parse veto|do not compile/i,
    code: 'parse',
    why: 'One or more changed files are not valid source — they do not parse. Nothing downstream can mean anything about code the language itself rejects.',
    remedy: 'Restart: the implementer gets the exact syntax error and its location, and must produce a file that compiles before anything else is judged.',
  },
  {
    re: /dead-code veto|nothing imports|nothing calls/i,
    code: 'dead-code',
    why: 'The change added code that nothing references — a helper, hook or file with no caller. Unused code is a maintenance cost with no benefit.',
    remedy: 'Restart: the implementer must wire the new code into a real caller in the SAME change, or make the edit inline.',
  },
  {
    re: /does not (?:boot|run locally)|exited on boot|build fails/i,
    code: 'boot',
    why: 'The application no longer starts. Every test can pass and still leave an app that does not come up — this is the check that catches it.',
    remedy: 'Restart: the implementer gets the boot error itself, which usually names the exact missing import or bad config.',
  },
  {
    re: /change budget|diff too large|exceeds .*budget/i,
    code: 'too-big',
    why: 'The diff exceeded the configured change budget. A large change is harder to review and riskier to land than several small ones.',
    remedy: 'Restart: the task is split, or the budget is raised deliberately in Review → change budget.',
  },
  {
    re: /contract|breaking change|route-removed|column-dropped|exports-removed/i,
    code: 'contract',
    why: 'The change breaks the public surface something outside this repository depends on — a route, an exported symbol or a database column. A green test suite cannot see this.',
    remedy: 'Restart: keep the old surface working (deprecate rather than delete), or declare the breaking change deliberately.',
  },
  { re: /regression veto|public (?:api|item)s? removed|removed \d+ public/i, code: 'regression', why: 'The change deleted or renamed something the rest of the codebase still depends on (an exported function or a route). Callers would break.' },
  { re: /test(?:s)? failed|\d+ failed|assertion|expect\(|vitest|jest/i, code: 'tests', why: 'The test suite failed against the change. The edit compiles but it broke behaviour the tests protect.' },
  { re: /syntaxerror|unexpected token|parse error|cannot parse|unterminated/i, code: 'syntax', why: 'The generated code does not parse. The model produced malformed JavaScript — usually a truncated edit or an unbalanced brace.' },
  { re: /cannot find module|module not found|is not defined|is not a function|referenceerror|typeerror/i, code: 'binding', why: 'The change references something that does not exist — a missing import, a renamed symbol, or a function that was never defined.' },
  { re: /score \d+ < threshold|below threshold|rolled back/i, code: 'quality', why: 'The change was produced, but it scored below the quality bar the graders enforce. It was rolled back on purpose.' },
  { re: /eslint|lint(?:ing)? failed/i, code: 'lint', why: 'The change violates the project lint rules.' },
  { re: /conflict|does not apply|patch failed|could not apply/i, code: 'conflict', why: 'The edit no longer applies to the current code — the base moved underneath it while the iteration was running.' },
  { re: /no changes produced|made no edits|zero edits/i, code: 'empty', why: 'The implementer finished without editing a single file. It could not turn the plan into a concrete change.' },
];

/** Signatures that are about the machine, not the code and not the operator. */
const INFRASTRUCTURE = [
  { re: /enospc|no space left|disk full/i, why: 'The disk is full. Nothing could be written.' },
  { re: /worktree|git .*(failed|error)|not a git repository|index\.lock/i, why: 'A git operation failed while preparing or committing the sandbox.' },
  { re: /eacces|eperm|permission denied/i, why: 'A filesystem permission was denied.' },
  { re: /docker|compose/i, why: 'The local runtime (docker compose) could not be driven.' },
];

/**
 * Classify a failure.
 *
 * @param {Error|string} err
 * @param {{phase?: string, filesChanged?: number, aborted?: boolean}} ctx
 * @returns {{kind, code, title, explanation, resumable, resumeFrom, remedy}}
 */
export function classify(err, ctx = {}) {
  const message = String(err?.message ?? err ?? '').trim();
  const phase = ctx.phase || null;
  const hasWork = (ctx.filesChanged ?? 0) > 0;

  // An explicit abort beats every heuristic — we know we stopped it.
  if (ctx.aborted) {
    return build({
      kind: KIND.INTERRUPTION,
      code: 'cancelled',
      title: 'Interrupted — the run was cancelled',
      explanation:
        'This iteration was stopped on purpose, so nothing is known to be wrong with the work it had done. ' +
        (hasWork
          ? 'The edits it had already made are preserved and can be replayed.'
          : 'It had not produced any edits yet.'),
      phase,
      hasWork,
    });
  }

  for (const m of INTERRUPTION) {
    if (m.re.test(message)) {
      return build({
        kind: KIND.INTERRUPTION,
        code: 'interrupted',
        title: 'Interrupted — the run was stopped, not rejected',
        explanation: m.why,
        phase,
        hasWork,
      });
    }
  }

  for (const m of IMPLEMENTATION) {
    if (m.re.test(message)) {
      return build({
        kind: KIND.IMPLEMENTATION,
        code: m.code,
        title: `Implementation error — ${implTitle(m.code)}`,
        explanation: m.why,
        remedy: m.remedy ?? null,
        phase,
        hasWork,
      });
    }
  }

  for (const m of INFRASTRUCTURE) {
    if (m.re.test(message)) {
      return build({
        kind: KIND.INFRASTRUCTURE,
        code: 'infra',
        title: 'Infrastructure error — the machine got in the way',
        explanation: m.why,
        phase,
        hasWork,
      });
    }
  }

  // Unknown. Assume the work is suspect rather than fine: a silent wrong answer is
  // worse than an unnecessary re-check.
  return build({
    kind: KIND.IMPLEMENTATION,
    code: 'unknown',
    title: 'Failed — cause not recognised',
    explanation:
      `The iteration failed during the ${phase || 'run'} phase with an error we do not have a signature for: "${message.slice(0, 200)}". ` +
      'Treated as an implementation problem, so a restart will re-run the change through the graders rather than blindly trusting it.',
    phase,
    hasWork,
  });
}

function implTitle(code) {
  return (
    {
      regression: 'the change breaks existing callers',
      tests: 'the test suite fails',
      syntax: 'the generated code does not parse',
      binding: 'the change references something that does not exist',
      quality: 'the change scored below the quality bar',
      lint: 'the change violates lint rules',
      conflict: 'the edit no longer applies to the current code',
      empty: 'the implementer produced no edits',
      'refactor-duplication': 'a refactor that duplicated instead of replacing',
      'security-veto': 'the change weakened security',
      'dead-code': 'the change added code nothing calls',
      boot: 'the application no longer starts',
      'too-big': 'the diff exceeded the change budget',
      contract: 'the change breaks the public surface',
      behaviour: 'a refactor changed what the software does',
      'broke-tests': 'the change broke a test suite that was passing',
      parse: 'the change produced code that does not compile',
      unknown: 'cause not recognised',
    }[code] || code
  );
}

/**
 * Where a restart should pick up, and what it should carry forward.
 *
 * - Interruption: the work is innocent. Replay the diff into a fresh sandbox and
 *   continue from the phase that was cut short — no need to re-plan or re-implement.
 * - Implementation error: the work is guilty. Replay the diff so the implementer
 *   starts from what it already wrote, but send it back to `implement` with the
 *   failure quoted, so it fixes the actual defect instead of starting from zero.
 * - Infrastructure: nothing is known about the work. Fix the machine, then replay
 *   from the same phase.
 */
function build({ kind, code, title, explanation, phase, hasWork, remedy: specific = null }) {
  const resumable = hasWork || kind === KIND.INTERRUPTION || kind === KIND.INFRASTRUCTURE;

  let resumeFrom;
  let remedy;
  if (kind === KIND.IMPLEMENTATION) {
    resumeFrom = 'implement';
    remedy = hasWork
      ? 'Restart: the implementer gets its own edits back plus the exact failure, and is told to fix it.'
      : 'Restart: the plan is re-implemented from scratch, since no edits survived.';
  } else if (kind === KIND.INTERRUPTION) {
    resumeFrom = hasWork ? phase || 'review' : 'implement';
    remedy = hasWork
      ? `Restart: the edits are replayed into a fresh sandbox and the run continues from the "${resumeFrom}" phase.`
      : 'Restart: nothing was written yet, so the plan is implemented from the top.';
  } else {
    resumeFrom = phase || 'implement';
    remedy = 'Fix the underlying machine problem (disk, git, docker), then restart — the run resumes from where it stopped.';
  }

  // A signature that knows its own remedy wins. Several do — "delete the code you replaced",
  // "make the suite pass again", "move the guard, do not remove it" — and they were being
  // overwritten here by the generic "restart and fix it", which told the operator nothing the word
  // "failed" had not already said. The generic line remains the fallback for the signatures that
  // genuinely have nothing more specific to add.
  return { kind, code, title, explanation, resumable, resumeFrom, remedy: specific || remedy, phase };
}

/** One-line label for the UI. */
export const label = (kind) =>
  ({
    [KIND.INTERRUPTION]: 'Interruption',
    [KIND.IMPLEMENTATION]: 'Implementation error',
    [KIND.INFRASTRUCTURE]: 'Infrastructure',
  })[kind] || 'Failure';
