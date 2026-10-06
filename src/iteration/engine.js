import { iteration as cfg, ollama as ollamaCfg, AGENT_IDENTITY } from '../config.js';
import { emit } from '../bus.js';
import { log } from '../logger.js';
import {
  applyDiff,
  createSandbox,
  ensureWorkBranch,
  commitStaged,
  moveBranch,
  removeWorktree,
  stageProductAndDiff,
} from '../sandbox/worktree.js';
import {
  startIteration,
  updateIteration,
  getIteration,
  getPendingDiff,
  countTodayIterations,
  countFeaturesByStatus,
  totalIterations,
  recordFailure,
  startPhase,
  finishPhase,
  startTask,
  finishTask,
  markTaskRunning,
  getKpi,
  markFunctionImproved,
  bumpFunctionFailure,
  setFunctionStatus,
  markFeatureDone,
  bumpFeatureFailure,
  setFeatureStatus,
  autoDeferFailing,
  chargeFailureToTargets,
  notify,
  notifyOnce,
} from '../db_iteration.js';
import { classify, KIND } from '../core/failure.js';
import { assertNotAlreadyCommitted } from './idempotency.js';
import { checkBehaviourPreserved, isRefactorIntent } from './behaviourGate.js';
import { changedLineCoverage, coverageVerdict, coverageGateMode, coverageGateFloor, compactCoverage } from './changedLineCoverage.js';
import { remember } from '../memory/memoryDb.js';
import { FAILURE_LESSONS } from '../memory/lessons.js';
import { publishPullRequest } from '../deploy/prPublisher.js';
import { recordHealthSnapshot } from './healthIndex.js';
import { invalidateBlastGraph, blastRadiusForTask } from './blastRadius.js';
import { startBisect } from './bisect.js';
import { invalidateKnowledgeIndex } from '../context/knowledgeIndex.js';
import { enqueueReview } from '../core/reviewQueue.js';
import { canStartIteration } from '../core/costMeter.js';
import { checkChangeBudget } from './changeBudget.js';
import { checkIntentPreserved, reviewFloorVeto } from './intentGate.js';
import { checkSchemaMigrations } from './schemaGuard.js';
import { checkScope, scopeGateMode } from './scopeGate.js';
import { checkConflictMarkers } from './conflictGate.js';
import { verifyAfterCommit } from '../runtime/schemaAgent.js';
import { catalog } from './cataloger.js';
import { survey } from './surveyor.js';
import { plan } from './planner.js';
import { implementParallel } from './parallelImplementer.js';
import { review, security, test } from './graders.js';
import { check as regressionCheck } from './regression.js';
import { verifyLocalExecution } from '../workbench/workbench.js';
import { healBoot } from '../workbench/workbenchAgent.js';

/**
 * The pipeline. `workbench` is the phase that earns its keep: it boots the app in
 * the sandbox and refuses to let an iteration land if the thing no longer starts —
 * the failure mode that every unit test in the world sails straight past.
 */
export const PHASES = [
  'catalog',
  'survey',
  'plan',
  'implement',
  'review',
  'security',
  'regression',
  'test',
  'workbench',
  'finalize',
];

/** Phases that a restart is allowed to resume from (everything before is replay). */
const RESUMABLE_FROM = new Set(['implement', 'review', 'security', 'regression', 'test', 'workbench', 'finalize']);

/**
 * Save the sandbox's work-so-far after every task, mid-`implement`.
 *
 * `implement` is by far the longest phase — measured runs spend anywhere from two minutes to
 * eighty-eight in it — and it is where 66 of the last 73 interruptions landed. Until now the diff
 * was only captured AFTER the phase returned, so every one of those runs recorded
 * `files_changed = 0` and had nothing to replay: an hour of generated code, already written to the
 * worktree on disk, that the restart path could not see and therefore threw away. That, not the
 * agents failing, is why so few iterations reached a commit.
 *
 * Checkpointing per task turns "the server restarted, start over" into "the server restarted,
 * carry on from task 3".
 *
 * Deliberately best-effort and silent about its own failures: with tasks running in parallel this
 * can race another `git add` for the index lock, and a checkpoint that took down the run it exists
 * to protect would be worse than no checkpoint at all. A partial snapshot is fine too — the replay
 * already tolerates a diff that only partly applies, and the authoritative capture after the phase
 * overwrites whatever this wrote.
 */
// Exported so a test can drive the real function. Verifying a checkpoint by re-implementing its
// three lines in the test would prove only that the copy works — and the copy is what drifts.
export function checkpointDiff(iterationId, sandbox, lg) {
  try {
    const d = stageProductAndDiff(sandbox);
    if (!d.files.length) return;
    updateIteration(iterationId, {
      filesChanged: d.files.length,
      additions: d.additions,
      deletions: d.deletions,
      pendingDiff: d.diff.slice(0, 400_000),
    });
  } catch (err) {
    lg?.debug?.(`checkpoint skipped: ${err.message}`, { runId: iterationId });
  }
}

function aggregate(scores, kpi) {
  const w = {
    review: kpi['weight.review'] ?? 0.2,
    security: kpi['weight.security'] ?? 0.2,
    regression: kpi['weight.regression'] ?? 0.3,
    test: kpi['weight.test'] ?? 0.15,
    workbench: kpi['weight.workbench'] ?? 0.15,
  };
  // Only weigh the dimensions we actually measured, so a skipped phase doesn't
  // silently drag the score toward zero.
  let sum = 0;
  let total = 0;
  for (const [k, weight] of Object.entries(w)) {
    const v = scores[k];
    if (v == null) continue;
    total += v * weight;
    sum += weight;
  }
  return sum ? Math.round(total / sum) : null;
}

/**
 * Run one iteration in an isolated sandbox cut from the tip of the work branch.
 * On success the accumulated change is committed and the work branch advances;
 * `main` and your working tree are never touched.
 *
 * @param {object} opts
 * @param {string} opts.trigger
 * @param {AbortSignal} opts.signal
 * @param {object} [opts.resume]  restart context: { of, from, diff, failure, plan }
 */
export async function runIteration({ trigger = 'loop', signal, resume = null } = {}) {
  const kpi = getKpi();
  if (!resume && countTodayIterations() >= cfg.maxPerDay) {
    throw new Error(`daily iteration cap reached (${cfg.maxPerDay})`);
  }

  // BUDGET GOVERNOR. A hard breach stops NEW work only — a resumed run is allowed through, because
  // abandoning an iteration mid-flight leaves a half-applied change behind, which is a far worse
  // outcome than one run's worth of overspend. Off unless an operator sets a budget.
  if (!resume) {
    const budget = canStartIteration();
    if (!budget.allowed) {
      // Deduped: the loop retries on every tick, and an operator needs to be told once, not hourly.
      notifyOnce({
        kind: 'governance',
        severity: 'warn',
        title: 'Iterations stopped: budget reached',
        body: `${budget.reason}. Raise or clear the budget in ⚖ Governance → Cost, or wait for the next period.`,
        link: 'governance',
      });
      throw new Error(`budget stop: ${budget.reason}`);
    }
  }

  const base = ensureWorkBranch(cfg.workBranch);
  const iterationId = startIteration(trigger, base, resume?.of ?? null);
  // Captured for the idempotency guard: a commit only counts as THIS run's work if it was made
  // after the run began. Read back from the row rather than `Date.now()` so the two agree exactly.
  const startedAt = getIteration(iterationId)?.startedAt ?? Date.now();
  const lg = log.for('iteration');
  const maxParallel = Math.max(1, Math.round(kpi.max_parallel_tasks ?? 2));

  emit('iteration.started', {
    iterationId,
    trigger,
    base: base.slice(0, 8),
    restartOf: resume?.of ?? null,
    resumeFrom: resume?.from ?? null,
  });
  lg.info(
    resume
      ? `#${iterationId} restarting #${resume.of} from the "${resume.from}" phase`
      : `#${iterationId} started on ${cfg.workBranch}@${base.slice(0, 8)} (up to ${maxParallel} task(s) in parallel)`,
    { runId: iterationId },
  );

  let sandbox = null;
  let tokensIn = 0;
  let tokensOut = 0;
  const scores = {};
  let batchPlan = resume?.plan || null;
  // Coverage of the lines THIS change added. Kept because the provenance line reads it after the
  // gate has run; the behaviour gate needs no equivalent, since it writes its record where it runs.
  let coverageResult = null;
  // Targets closed because the codebase already satisfied them. Kept at run scope so the failure
  // path can tell them apart from work that genuinely did not land.
  const satisfiedTargets = new Set();
  let taskIds = [];
  let implResult = null;
  let diffInfo = { diff: '', files: [], additions: 0, deletions: 0 };
  let status = 'error';
  let commitSha = null;
  let rolledBack = false;
  let provenanceStr = '';
  let currentPhase = null;

  // A restart skips every phase before the one it resumes at — the work those
  // phases produced is being replayed, not recomputed.
  const skipTo = resume?.from && RESUMABLE_FROM.has(resume.from) ? resume.from : null;
  const shouldRun = (name) => !skipTo || PHASES.indexOf(name) >= PHASES.indexOf(skipTo);

  const phase = async (name, fn) => {
    if (signal?.aborted) throw new Error('interrupted');
    if (!shouldRun(name)) {
      emit('iteration.phase', { iterationId, phase: name, status: 'skipped', summary: 'replayed from the restarted run' });
      return null;
    }
    currentPhase = name;
    const pid = startPhase(iterationId, name);
    emit('iteration.phase', { iterationId, phase: name, status: 'running' });
    try {
      const res = await fn();
      tokensIn += res?.tokensIn || 0;
      tokensOut += res?.tokensOut || 0;
      finishPhase(pid, 'ok', res?.summary, res, res?.score ?? null);
      emit('iteration.phase', { iterationId, phase: name, status: 'ok', summary: res?.summary, score: res?.score ?? null });
      return res;
    } catch (err) {
      finishPhase(pid, 'error', err.message);
      emit('iteration.phase', { iterationId, phase: name, status: 'error', summary: err.message });
      throw err;
    }
  };

  try {
    /* ---------------------------- plan the batch --------------------------- */
    await phase('catalog', () => catalog());

    // Rebuild the backlog from a real analysis of the code, but not every run — a deep
    // survey is expensive and the codebase doesn't change that fast. Every N iterations
    // (default 10) the Surveyor reads the actual repo and refreshes the backlog with
    // grounded items; the other runs just draw from what it found.
    const surveyEvery = Math.max(1, Math.round(kpi.survey_every_runs ?? 10));
    const nRun = totalIterations();
    const backlog = countFeaturesByStatus();
    const dueSurvey = backlog.pending < 3 || nRun % surveyEvery === 0;
    await phase('survey', async () => {
      if (!dueSurvey) return { summary: `skipped — next survey in ${surveyEvery - (nRun % surveyEvery)} run(s); ${backlog.pending} items queued` };
      return survey({ signal });
    });

    if (shouldRun('plan')) {
      batchPlan = await phase('plan', () => plan({ signal, iterationId }));
    }

    // Tasks the planner produced but that reference paths this repo doesn't have are
    // recorded — visibly, with the reason — rather than silently dropped, so the
    // operator can see exactly what the model got wrong about the codebase. And the
    // backlog item behind a doomed task gets a failure bump, so a fantasy feature the
    // model keeps re-imagining is eventually deferred instead of dropped every run.
    for (const rj of batchPlan?.rejected || []) {
      const tid = startTask(iterationId, rj);
      finishTask(tid, 'failed', rj.pathIssue, [], rj.pathIssue);
      if (rj.featureId) bumpFeatureFailure(rj.featureId, iterationId, rj.pathIssue);
      if (rj.functionId) bumpFunctionFailure(rj.functionId, iterationId);
      emit('impl.task_finished', { iterationId, title: rj.title, ok: false, files: 0, agent: rj.agent, reason: rj.pathIssue });
    }

    if (!batchPlan?.tasks?.length) {
      const why = batchPlan?.rejected?.length
        ? `every planned task targeted files that don't exist in this repo (e.g. ${batchPlan.rejected[0].pathIssue})`
        : 'the planner returned no tasks';
      throw new Error(`no changes produced — ${why}`);
    }

    taskIds = batchPlan.tasks.map((t) => startTask(iterationId, t));
    for (const t of batchPlan.tasks) {
      if (t.functionId) setFunctionStatus(t.functionId, 'improving');
      if (t.featureId) setFeatureStatus(t.featureId, 'in_progress');
    }
    updateIteration(iterationId, { planTitle: batchPlan.title, planJson: JSON.stringify(batchPlan) });
    emit('iteration.plan', { iterationId, title: batchPlan.title, tasks: batchPlan.tasks.length, byAgent: batchPlan.byAgent });

    /* ------------------------------- sandbox ------------------------------- */
    sandbox = createSandbox([], base);

    // A restart replays the failed run's edits so the implementer picks up its own
    // work rather than starting from an empty tree.
    if (resume?.diff) {
      const applied = applyDiff(sandbox, resume.diff);
      if (applied.applied) {
        lg.info(`#${iterationId} replayed ${resume.diff.length} bytes of the failed run's changes${applied.partial ? ' (partially — the base had drifted)' : ''}`, { runId: iterationId });
        emit('iteration.replayed', { iterationId, of: resume.of, partial: !!applied.partial });
      } else {
        lg.warn(`#${iterationId} could not replay the previous changes (${applied.reason}) — implementing from scratch`, { runId: iterationId });
      }
    }

    /* ----------------------------- implement ------------------------------- */
    if (shouldRun('implement')) {
      implResult = await phase('implement', () =>
        implementParallel({
          accumulator: sandbox,
          base,
          tasks: batchPlan.tasks,
          taskIds,
          iterationId,
          iterationBrief: { title: batchPlan.title, theme: batchPlan.theme },
          maxParallel,
          // When we're restarting because the change was BROKEN, every task gets the
          // failure in hand so it fixes its own defect instead of re-deriving one.
          onTaskStart: ({ index }) => markTaskRunning(taskIds[index]),
          onTaskFinish: ({ index, result }) => {
            finishTask(taskIds[index], result.ok ? 'done' : 'failed', result.summary, result.filesChanged, result.error);
            checkpointDiff(iterationId, sandbox, lg);
          },
          signal,
        }),
      );
      updateIteration(iterationId, {
        wavesJson: JSON.stringify(implResult.waves),
        parallelSavedMs: implResult.savedMs,
      });
    }

    diffInfo = stageProductAndDiff(sandbox);
    updateIteration(iterationId, {
      filesChanged: diffInfo.files.length,
      additions: diffInfo.additions,
      deletions: diffInfo.deletions,
      diff: diffInfo.diff.slice(0, 200_000),
      // Persist the change as it stands RIGHT NOW: if anything below throws, this is
      // what a restart replays. Saving it here — before the graders can reject it —
      // is what makes a failed run recoverable at all.
      pendingDiff: diffInfo.diff.slice(0, 400_000),
    });

    /*
     * WORK THAT WAS ALREADY DONE IS CLOSED HERE, NOT LEFT IN THE QUEUE.
     *
     * An agent that inspects the codebase and reports the task already satisfied produces no diff,
     * so the run ends `empty` and never reaches the accounting at the bottom — the target stays
     * `pending` and is proposed again on the next run. Measured: the same test file was reissued
     * three separate times, each costing a full agent turn to rediscover it already had 28 tests.
     *
     * Marked improved here, before the empty-run throw, because there is genuinely nothing to
     * commit and waiting for a commit that cannot happen is what created the loop.
     */
    const satisfied = (implResult?.results || [])
      .map((r, i) => ({ r, t: batchPlan.tasks[i] }))
      .filter(({ r }) => r?.alreadySatisfied);
    for (const { r, t } of satisfied) {
      if (t?.functionId) { markFunctionImproved(t.functionId, iterationId); satisfiedTargets.add(`fn:${t.functionId}`); }
      if (t?.featureId) { markFeatureDone(t.featureId, iterationId); satisfiedTargets.add(`ft:${t.featureId}`); }
      lg.info(`"${t?.title || 'task'}" needed no change — ${r.summary}`, { runId: iterationId });
    }

    if (!diffInfo.files.length) {
      if (satisfied.length === (batchPlan.tasks || []).length && satisfied.length > 0) {
        // Every task was already done. That is a correct, complete outcome — reporting it as a
        // failed run would be false, and would put the targets back in the queue via the failure path.
        throw new Error(`nothing to do — ${satisfied.length} task(s) were already satisfied by the existing code`);
      }
      throw new Error('no changes produced — the implementer made no edits');
    }

    /* ------------------------------- grade --------------------------------- */
    const reviewRes = await phase('review', () => review({ diff: diffInfo.diff, sandboxRoot: sandbox, signal }));
    if (reviewRes) scores.review = reviewRes.score;
    // A new module that nothing imports is dead code — the exact "refactor that adds an
    // unused hook" hole. It's a hard veto: we do not commit cruft.
    const deadFindings = reviewRes?.dead || [];
    const unusedNewFiles = deadFindings.filter((d) => d.kind === 'unused-file');

    const secRes = await phase('security', () => security({ diff: diffInfo.diff, signal }));
    if (secRes) scores.security = secRes.score;
    // A change that introduces a secret or strips a security control is a hard veto — an
    // autonomous agent must never weaken security, no matter its overall score.
    const securityVeto = secRes?.veto ? secRes.findings || [] : [];

    const regRes = await phase('regression', () => regressionCheck({ root: sandbox }));
    if (regRes) scores.regression = regRes.score;

    const testRes = await phase('test', () => test({ sandboxRoot: sandbox, changedPaths: diffInfo.files, iterationId, baseCommit: base }));

    // Was the suite actually run in isolation? Recorded on the run, because "the tests passed" and
    // "the tests passed in a sandbox that could not touch this machine" are different claims, and
    // only one of them is true on a host with no container runtime.
    if (testRes?.isolation) {
      updateIteration(iterationId, { isolation: JSON.stringify(testRes.isolation) });
      if (!testRes.isolation.isolated) {
        lg.info(`verification was NOT isolated — ${testRes.isolation.reason}`, { runId: iterationId });
      }
    }

    // AUTO-BISECT: the suite fails AND it already failed at the base — an earlier fleet commit broke
    // it, not this change. Kick off a background bisect so the real culprit (and its one-click
    // revert) is waiting on the Reliability page instead of a human having to notice.
    if (testRes?.preExisting) {
      const started = startBisect({ limit: 20 });
      lg.warn(
        `pre-existing regression detected (also fails at base ${String(base).slice(0, 8)}) — ` +
        `${started ? 'auto-bisect started to find the culprit commit' : 'a bisect is already running'}`,
        { runId: iterationId },
      );
    }
    if (testRes) scores.test = testRes.score;

    /* ----------------------------- workbench ------------------------------- */
    // Does the application still actually run? If not, the workbench agent gets two
    // shots at repairing what the iteration broke before we call it a failure.
    const wbRes = await phase('workbench', async () => {
      let wb = await verifyLocalExecution({ sandboxRoot: sandbox, iterationId, signal });
      if (!wb.ok) {
        const healed = await healBoot({
          sandboxRoot: sandbox,
          iterationId,
          diff: diffInfo.diff,
          diffFiles: diffInfo.files,
          initial: wb,
          signal,
        });
        wb = healed.result;
        if (healed.healed) {
          // The repair changed files — re-stage so the commit and the graders see them.
          diffInfo = stageProductAndDiff(sandbox);
          updateIteration(iterationId, {
            filesChanged: diffInfo.files.length,
            additions: diffInfo.additions,
            deletions: diffInfo.deletions,
            diff: diffInfo.diff.slice(0, 200_000),
            pendingDiff: diffInfo.diff.slice(0, 400_000),
          });
        }
      }
      return { score: wb.score, summary: wb.summary, ok: wb.ok, checks: wb.checks };
    });
    if (wbRes) scores.workbench = wbRes.score;

    const total = aggregate(scores, kpi);
    updateIteration(iterationId, {
      reviewScore: scores.review ?? null,
      securityScore: scores.security ?? null,
      regressionScore: scores.regression ?? null,
      testScore: scores.test ?? null,
      workbenchScore: scores.workbench ?? null,
      totalScore: total,
    });

    /* ------------------------------ finalize ------------------------------- */
    await phase('finalize', async () => {
      const threshold = kpi.rollback_threshold ?? 60;

      if (regRes?.veto) {
        rolledBack = true;
        status = 'rolled_back';
        throw new Error(`regression veto — ${regRes.removed.length} public item(s) removed`);
      }
      // CODE THAT DOES NOT PARSE.
      //
      // The review grader returns 0 with the parse errors attached, and 0 was all it did: review
      // weighs 0.2, so a file that does not compile still totalled ~80 against a threshold of 60 and
      // committed. Two runs landed syntactically broken files on the work branch that way.
      //
      // This is not a matter of degree like a style opinion — the file is not valid source. Nothing
      // downstream (tests, boot, a human review) can mean anything about code that cannot be parsed.
      const parseIssues = reviewRes?.parseIssues || [];
      if (parseIssues.length) {
        rolledBack = true;
        status = 'rolled_back';
        throw new Error(`parse veto — ${parseIssues.length} file(s) do not compile: ${parseIssues.slice(0, 3).join(' | ')}`);
      }

      if (unusedNewFiles.length) {
        rolledBack = true;
        status = 'rolled_back';
        throw new Error(`dead-code veto — ${unusedNewFiles.map((d) => d.file).join(', ')} imported by nothing`);
      }
      if (securityVeto.length) {
        rolledBack = true;
        status = 'rolled_back';
        throw new Error(`security veto — ${securityVeto[0].message}`);
      }

      // TESTS THAT THIS CHANGE BROKE.
      //
      // There was no veto here at all — a failing suite only lowered a WEIGHTED AVERAGE, and the
      // arithmetic made that meaningless: test carries 0.15, so a change with every test red and
      // everything else near-perfect scores 83 against a threshold of 60. It commits. Six runs in
      // the last twenty-five committed with `test = 0`.
      //
      // Only suites this change actually broke veto. A suite that was already red is someone else's
      // regression and is reported (and bisected) rather than blamed on whoever touched the repo
      // next — see the attribution in `graders.test`.
      if (testRes?.broke?.length) {
        rolledBack = true;
        status = 'rolled_back';
        const names = testRes.broke.map((b) => `${b.project} (${b.id})`).join(', ');
        throw new Error(`test veto — this change broke ${testRes.broke.length} previously-passing suite(s): ${names}`);
      }
      // REFACTOR SAFETY (Architecture Gap C): a structural/refactor change that adds code but
      // deletes NOTHING has duplicated instead of replacing — the #54 failure. Zero deletions on
      // a refactor is the unambiguous signature (a real refactor always removes the moved code).
      // One definition of "this claims to be a refactor", shared with the behaviour gate. Two copies
      // would let an agent dodge one rule by phrasing its way around the other.
      const refactorIntent = isRefactorIntent(batchPlan);
      if (refactorIntent && diffInfo.deletions === 0 && diffInfo.additions >= 30) {
        rolledBack = true;
        status = 'rolled_back';
        throw new Error('refactor veto — a structural change added code but deleted nothing (it duplicated instead of replacing)');
      }
      // CHANGE-SIZE BUDGET (ISL_IMPROVE): a diff past the hard cap is a runaway, not a reviewable
      // improvement — veto it. Refactors get a larger allowance since they legitimately move code.
      const budget = checkChangeBudget({ filesChanged: diffInfo.files.length, additions: diffInfo.additions, refactor: refactorIntent });
      if (budget.level === 'veto') {
        rolledBack = true;
        status = 'rolled_back';
        throw new Error(budget.reason);
      }
      if (wbRes && !wbRes.ok) {
        rolledBack = true;
        status = 'rolled_back';
        throw new Error(`the app does not boot — ${wbRes.summary}`);
      }

      /*
       * DID THE CHANGE DO WHAT THE TASK SAID? (see intentGate.js for the run that motivated this)
       *
       * Run #426's task was "Resolve TODO in routes/search.js regarding userPrefs". The implementer
       * resolved it by deleting the personalisation block the TODO referred to. Every mechanical
       * gate passed — it compiles, exports nothing new, breaks no suite, boots fine — because none
       * of them asks whether this is the change that was requested. The reviewer did object, with a
       * 55, and was outvoted by arithmetic: review weighs 0.2, so the total came to 90 and it
       * committed. A live search feature lost its personalisation in production.
       *
       * Both rules below are deterministic and both are about intent rather than mechanics.
       */
      /*
       * SCOPE: un identificatore usato e legato da nessuna parte.
       *
       * Nessun altro gate lo vede. Il parse gate esegue node --check e t(...) e sintassi valida;
       * i test coprono quella riga solo se una suite la esercita; il boot riesce, perche il throw
       * arriva quando un utente apre il pannello. Il reviewer ha dato 95/100 al cambio che ha
       * rotto la barra di ricerca: leggere lo scope fra componenti sorelle e proprio cio che un
       * modello non fa in modo affidabile e una macchina fa perfettamente.
       *
       * Consultivo di default: su 220 file sani ne segnala 3 a torto, e una veto che blocca
       * lavoro buono viene disattivata portandosi via anche i ritrovamenti veri.
       */
      /*
       * Marcatori di conflitto: veto duro, senza modalità consultiva.
       *
       * Gli altri gate partono consultivi perché sbagliano qualche volta e una veto che blocca
       * lavoro buono viene disattivata. Questo non ha quel problema: sette `<` a inizio riga seguiti
       * da un nome non compaiono in nessun codice valido. E il costo di lasciarlo passare è già
       * misurato — un file di test è rimasto in HEAD con i marcatori dentro per oltre duecento
       * iterazioni, invalido alla prima riga, senza che nessun gate se ne accorgesse.
       */
      const conflicts = checkConflictMarkers(diffInfo.diff);
      if (conflicts.veto) {
        rolledBack = true;
        status = 'rolled_back';
        throw new Error(`conflict veto — ${conflicts.summary}`);
      }
      if (scopeGateMode() !== 'off') {
        const scope = checkScope(diffInfo.diff, { root: sandbox });
        if (scope.veto && scopeGateMode() === 'enforce') {
          rolledBack = true;
          status = 'rolled_back';
          throw new Error(`scope veto — ${scope.summary}`);
        }
        if (scope.veto) lg.warn(`scope (advisory, non blocca): ${scope.summary}`, { runId: iterationId });
        else if (scope.checked) lg.info(`scope: ${scope.summary}`, { runId: iterationId });
      }
      const intent = checkIntentPreserved(batchPlan, diffInfo.diff);
      if (intent.veto) {
        rolledBack = true;
        status = 'rolled_back';
        throw new Error(`intent veto — ${intent.summary}`);
      }
      /*
       * A SCHEMA FIELD WITH NO MIGRATION. Run #91 added  to the listings service's
       * read-only User mirror and shipped no migration. It parses, it exports nothing, no suite
       * covers it, and the app BOOTS — Prisma only checks a field against the database when a query
       * runs. Weeks later it surfaced as "business users have disappeared": every User read from
       * that service was asking Postgres for a column that has never existed.
       */
      const schemaCheck = checkSchemaMigrations(diffInfo.diff, diffInfo.files);
      if (schemaCheck.veto) {
        rolledBack = true;
        status = 'rolled_back';
        throw new Error(`schema veto — ${schemaCheck.summary}`);
      }
      const reviewVeto = reviewFloorVeto(scores.review, { floor: kpi.review_floor ?? 70 });
      if (reviewVeto) {
        rolledBack = true;
        status = 'rolled_back';
        throw new Error(reviewVeto);
      }

      // BEHAVIOUR-PRESERVATION GATE. A refactor that changes what the software does is a bug wearing
      // a refactor's name, and "the tests pass" cannot tell the two apart: it never asks what the
      // tests did BEFORE. Only refactors pay the cost of a second full suite run, because behaviour
      // preservation is their definition and not a feature's goal.
      if (refactorIntent) {
        const behaviour = await checkBehaviourPreserved({
          sandboxRoot: sandbox,
          baseCommit: base,
          projectDirs: [...new Set(diffInfo.files.map((f) => f.split('/')[0]).filter(Boolean))].slice(0, 4),
          logger: lg,
        });
        // Written here, before the veto below can throw. This result used to live only in a local
        // variable and a log line, under a comment claiming it was recorded on the iteration — so
        // the one run it mattered most for, the vetoed one, kept no trace of what the gate saw.
        updateIteration(iterationId, {
          behaviourJson: JSON.stringify({
            checked: behaviour.checked,
            veto: behaviour.veto,
            summary: behaviour.summary,
            reason: behaviour.reason,
            violations: behaviour.violations,
            notes: behaviour.notes,
            projects: behaviour.projects,
          }),
        });
        for (const n of behaviour.notes) lg.info(`behaviour: ${n}`, { runId: iterationId });
        if (behaviour.veto) {
          rolledBack = true;
          status = 'rolled_back';
          throw new Error(`behaviour veto — ${behaviour.reason}`);
        }
        if (!behaviour.checked) {
          // Not a veto, but it must not read as a pass either.
          lg.warn(`${behaviour.summary}`, { runId: iterationId });
        }
      }
      /*
       * COVERAGE OF THE LINES THIS CHANGE ADDED (ISL_IMPROVE §1, P0).
       *
       * The whole-repo percentage cannot see a change: twenty new untested lines inside a module at
       * 92% move it to 91.8%, which is less than the noise. This measures the diff itself.
       *
       * It runs LAST among the gates on purpose. It is the most expensive check in the pipeline — a
       * second, instrumented pass over the suite — so it is only worth paying for on a change that
       * has already survived review, security, regression, dead-code and the tests.
       */
      if (coverageGateMode() !== 'off') {
        coverageResult = await changedLineCoverage({
          sandboxRoot: sandbox,
          diff: diffInfo.diff,
          changedPaths: diffInfo.files,
          logger: lg,
        }).catch((e) => ({ applicable: false, reason: `coverage gate errored: ${e.message}` }));

        const verdict = coverageVerdict(coverageResult, { minPct: coverageGateFloor() });
        coverageResult.verdict = verdict;

        // Persisted BEFORE the veto below, not after: a change rolled back for thin coverage is
        // precisely the run whose coverage record someone will want to read, and a `throw` on the
        // next line would take it with it.
        updateIteration(iterationId, {
          coverageJson: JSON.stringify(compactCoverage(coverageResult, {
            mode: coverageGateMode(), floor: coverageGateFloor(), verdict,
          })),
        });

        if (verdict.pass) {
          lg.info(`coverage of changed lines: ${verdict.reason}`, { runId: iterationId });
        } else if (coverageGateMode() === 'enforce') {
          rolledBack = true;
          status = 'rolled_back';
          throw new Error(`coverage veto — ${verdict.reason}`);
        } else {
          // Advisory: the number is recorded and surfaced, but it does not stop the change. Saying
          // "advisory" out loud matters — a warning an operator reads as a veto is a lie either way.
          lg.warn(`coverage of changed lines is low (advisory, not blocking) — ${verdict.reason}`, { runId: iterationId });
        }
      }

      if (total != null && total < threshold) {
        rolledBack = true;
        status = 'rolled_back';
        throw new Error(`score ${total} < threshold ${threshold} — rolled back`);
      }

      // PROVENANCE (ISL_IMPROVE §1): every commit records exactly what produced it — the
      // model, the specialists that worked, and the gates it passed — so any change is
      // explainable and auditable after the fact.
      const byAgent = Object.entries(batchPlan.byAgent || {}).map(([a, n]) => `${a}×${n}`).join(' ');
      const provenance =
        `Provenance: model ${ollamaCfg.model} · agents ${byAgent || '—'} · ` +
        `gates passed [review ${scores.review ?? '—'} · security ${scores.security ?? '—'}${secRes?.findings?.length ? ` (${secRes.findings.length} scan finding(s))` : ''} · ` +
        `regression ${scores.regression ?? '—'} · tests ${testRes?.summary || scores.test} · dead-code ${deadFindings.length ? deadFindings.length : 'clean'}` +
        // Coverage of the change's OWN lines. `n/a` states plainly that it could not be measured;
        // omitting it would let a reader assume the gate ran and was satisfied.
        ` · changed-line coverage ${coverageResult?.applicable ? `${coverageResult.pct}% of ${coverageResult.executable}${coverageGateMode() === 'advisory' ? ' (advisory)' : ''}` : 'n/a'}]`;
      const msg =
        `[ai-iter#${iterationId}] ${batchPlan.title}\n\n` +
        `Score ${total}/100 (review ${scores.review ?? '—'} · sec ${scores.security ?? '—'} · ` +
        `reg ${scores.regression ?? '—'} · test ${scores.test ?? '—'} · workbench ${scores.workbench ?? '—'})\n` +
        `${diffInfo.files.length} file(s) changed across ${batchPlan.tasks.length} task(s).\n\n` +
        `${provenance}\n\n` +
        `Generated autonomously by ISL. Co-Authored-By: ${AGENT_IDENTITY.name} <${AGENT_IDENTITY.email}>`;
      // IDEMPOTENCY (ISL_IMPROVE "durable queue", the at-least-once half). A replayed run must
      // never produce a second commit. `assertNotAlreadyCommitted` refuses if this iteration's work
      // is already on the branch — see idempotency.js for why the check is time-scoped.
      assertNotAlreadyCommitted(iterationId, startedAt);

      commitSha = commitStaged(sandbox, msg);
      moveBranch(cfg.workBranch, commitSha);
      status = 'committed';
      provenanceStr = provenance;

      // Persist the landing IMMEDIATELY, before any bookkeeping.
      //
      // This used to be written ~100 lines later, after the health snapshot, the review-queue
      // enqueue, the PR publisher and the whole memory-learning block. A process death anywhere in
      // that window left a row still saying `running` for a change that HAD landed — so the reaper
      // would call it interrupted, and the salvage path would replay its diff and commit the same
      // work twice. Two synchronous statements right after the git write shrink that window to
      // approximately nothing, and the guards in the reaper and the salvage query close what is left.
      updateIteration(iterationId, { status: 'committed', commitSha, branch: cfg.workBranch, resumable: 0 });
      return { summary: `Committed ${commitSha.slice(0, 8)} to ${cfg.workBranch} (score ${total})` };
    });

    /* --------------------------- backlog bookkeeping ----------------------- */
    const landed = status === 'committed';

    // Codebase health snapshot on every commit → the trend line shows whether ISL is
    // actually improving the codebase over time (honest, deterministic metric).
    if (landed && commitSha) {
      try { recordHealthSnapshot({ commitSha }); } catch { /* best-effort */ }

      /*
       * SCHEMA INTEGRITY AFTER THE COMMIT.
       *
       * Prisma validates a model field against the real table only when a query runs, so a schema
       * that no longer matches the database passes every gate: it parses, it exports nothing, no
       * suite covers it, and the service boots. Run #91 landed `trustScore` on a model with no
       * migration behind it, and the damage appeared weeks later as "business users have
       * disappeared" — every `User` read from that service asking for a column that never existed.
       *
       * Deliberately AFTER the commit and non-blocking. The pre-commit `schemaGuard` is what stops
       * a bad diff; this answers a different question — is the deployed state consistent RIGHT NOW,
       * whatever put it that way — and it needs a live database, which is not something a run may
       * depend on. A drift is reported, never silently repaired: a tool that "fixes" this by
       * editing a schema or altering a table could destroy exactly what it exists to protect.
       */
      try {
        const integrity = await verifyAfterCommit({ iterationId, commitSha });
        if (integrity.checked && !integrity.ok) {
          notify({
            kind: 'regression',
            severity: 'critical',
            title: 'Schema drift after this commit',
            body: `${integrity.summary}. Queries selecting those columns fail at runtime, however healthy the service looks.`,
            link: 'runtime',
          });
        }
      } catch { /* a diagnostic must never fail the run it observes */ }

      // HUMAN REVIEW QUEUE: classify the landed change by its blast radius + the acting agent's
      // trust. Low-risk work by a trusted agent is auto-approved; risky or probationary work is
      // held as PENDING for a human. Advisory (the change already landed) so the loop never stalls.
      try {
        const blast = blastRadiusForTask({ files: diffInfo.files }); // uses the pre-commit graph
        const dominantAgent = Object.entries(batchPlan.byAgent || {}).sort((a, b) => b[1] - a[1])[0]?.[0]
          || batchPlan.tasks[0]?.agent || 'implementer';
        const area = batchPlan.tasks.find((t) => t.area)?.area || null;
        enqueueReview({
          iterationId, agent: dominantAgent, area, title: batchPlan.title, commitSha, blast,
          filesChanged: diffInfo.files.length, additions: diffInfo.additions, deletions: diffInfo.deletions,
        });
      } catch (e) { lg.warn?.(`review-queue enqueue failed: ${e.message}`, { runId: iterationId }); }

      invalidateBlastGraph(); // the import graph changed — next blast-radius query rebuilds it
      invalidateKnowledgeIndex(); // files changed — next knowledge query rebuilds the index
    }

    // PULL-REQUEST PUBLISHER (ISL_IMPROVE §4): a landed change becomes a reviewable PR
    // (opened on GitHub when configured, else a draft file) — fire-and-forget, never blocks.
    if (landed && commitSha) {
      publishPullRequest({
        iterationId, commitSha, title: batchPlan.title, total: getIteration(iterationId).scores.total,
        scores, provenance: provenanceStr, filesChanged: diffInfo.files.length, plan: batchPlan,
      }).catch(() => {});
    }
    let improvements = 0;
    let featuresDone = 0;
    batchPlan.tasks.forEach((t, i) => {
      const r = implResult?.results?.[i];
      const taskLanded = (r ? r.ok : true) && landed;
      if (taskLanded && t.functionId) {
        markFunctionImproved(t.functionId, iterationId);
        improvements++;
      } else if (taskLanded && t.featureId) {
        markFeatureDone(t.featureId, iterationId);
        featuresDone++;
      } else {
        const reason = rolledBack ? 'iteration rolled back' : r?.summary || 'no change produced';
        if (t.functionId) bumpFunctionFailure(t.functionId, iterationId);
        if (t.featureId) bumpFeatureFailure(t.featureId, iterationId, reason);
      }
    });
    const deferred = autoDeferFailing();
    if (deferred.functions || deferred.features) {
      lg.info(`auto-deferred ${deferred.functions} function(s) + ${deferred.features} feature(s) after repeated failures`, { runId: iterationId });
    }

    /* --------------------------- shared memory: learn ---------------------- */
    // Memory is not just an error log — it is the fleet's accumulated know-how. Record
    // what WORKED (per specialist, as a reusable pattern) and turn any dead-code finding
    // into a durable pitfall, so the next run reuses wins and stops repeating mistakes.
    try {
      if (landed) {
        batchPlan.tasks.forEach((t, i) => {
          const r = implResult?.results?.[i];
          if (!r?.ok || !r.filesChanged?.length) return;
          remember({
            scope: `agent:${t.agent}`,
            kind: 'pattern',
            title: `Shipped: ${String(t.title).slice(0, 110)}`,
            content: `Landed in ${r.filesChanged.slice(0, 4).join(', ')}${t.area ? ` (${t.area})` : ''}. Approach that passed review+tests.`,
            source: 'engine:committed',
          });
        });
        if (batchPlan.theme) {
          remember({ scope: 'global', kind: 'insight', title: `Theme that landed: ${String(batchPlan.theme).slice(0, 110)}`, content: `Iteration #${iterationId} committed (score ${total}).`, source: 'engine:committed' });
        }
      }
      if (deadFindings.length) {
        // One durable, universal lesson (deduped) — every agent sees this on its next run.
        remember({
          scope: 'global',
          kind: 'pitfall',
          title: 'Never leave new code unused (dead code)',
          content: 'A new file/hook/helper/export that nothing imports or calls is dead code and gets vetoed. Wire it into a real caller in the SAME change (use search_code), or make the change inline. A refactor must REPLACE the original code (show deletions), not add alongside it.',
          source: 'engine:deadcode',
        });
      }
      if (securityVeto.length) {
        remember({
          scope: 'global',
          kind: 'pitfall',
          title: 'Never introduce secrets or weaken security',
          content: `A change was vetoed by the security gate: ${securityVeto[0].message} Never hardcode secrets, disable TLS verification, use Math.random for tokens, or remove an auth/authorization/ownership check. Strengthen security, never weaken it.`,
          source: 'engine:security',
        });
      }

    } catch (memErr) {
      lg.warn?.(`memory learning skipped: ${memErr.message}`, { runId: iterationId });
    }

    updateIteration(iterationId, {
      status,
      commitSha,
      branch: cfg.workBranch,
      rolledBack,
      improvements,
      featuresDone,
      tokensIn,
      tokensOut,
      resumable: 0,
      finishedAt: Date.now(),
    });

    const totalScore = getIteration(iterationId).scores.total;
    emit('iteration.finished', {
      iterationId, status, total: totalScore, rolledBack, commitSha, improvements, featuresDone,
      // Feed the Risk manager: security/safety findings and dead-code from this run.
      securityFindings: secRes?.findings || [],
      deadCode: deadFindings.length,
    });
    notify({
      kind: 'iteration',
      severity: 'info',
      title: `Iteration #${iterationId} committed (score ${totalScore})`,
      body: batchPlan.title,
      link: `iteration:${iterationId}`,
    });
    lg.info(
      `#${iterationId} ${status} · score ${totalScore} · +${improvements} impr/+${featuresDone} feat` +
        (implResult ? ` · saved ~${Math.round(implResult.savedMs / 1000)}s via parallelism` : ''),
      { runId: iterationId },
    );
    return { iterationId, status, total: totalScore, commitSha, rolledBack };
  } catch (err) {
    /* ------------------------------ triage --------------------------------- */
    // The whole point: say WHY it failed — was the run merely stopped, or is the
    // change genuinely broken? — and leave behind everything a restart needs.
    const verdict = classify(err, {
      phase: currentPhase,
      filesChanged: diffInfo.files.length,
      aborted: !!signal?.aborted,
    });

    status =
      verdict.kind === KIND.INTERRUPTION
        ? 'interrupted'
        : rolledBack
          ? 'rolled_back'
          : diffInfo.files.length === 0
            ? 'empty'
            : 'error';

    /* ------------------- charge the failure to what it targeted ------------- */
    /*
     * A VETOED RUN MUST COUNT AGAINST ITS TARGETS, OR IT WILL BE ATTEMPTED FOREVER.
     *
     * The accounting — `bumpFunctionFailure` per task, then `autoDeferFailing()` at three strikes —
     * already existed, correct and complete, at the END of the success path. A veto throws straight
     * past it, so the one outcome that should raise a counter was the one that never did.
     *
     * Measured: `services/listings/src/hardening.js` failed the parse gate on **nine consecutive
     * runs**, and every function in it still read `failures = 0`. Across 1639 functions exactly one
     * had ever reached the deferral threshold. The queue could not learn that a target was hopeless,
     * so it kept spending whole runs rediscovering it.
     *
     * ONLY IMPLEMENTATION FAILURES COUNT. This is not a detail — it is most of the data.
     *
     * Measured over 120 runs: of 148 failed tasks, **120 were `fetch failed`** — the model server
     * dropping mid-generation, split evenly between two agents. Those classify as INTERRUPTION (the
     * run was stopped, not judged), and charging them would mean three network blips permanently
     * retire a piece of work that nothing is wrong with — the queue would quietly shrink every time
     * Ollama restarted.
     *
     * A target earns a strike when the change itself was refused — a veto, a broken file, a
     * duplicating refactor. That is evidence about the work. Everything else is weather.
     *
     * The accounting itself lives in `chargeFailureToTargets` so it can be tested. This block is
     * inside a catch inside a 900-line function; the identical logic sat here, correct and never
     * executed, for months precisely because nothing could reach it.
     */
    if (verdict.kind === KIND.IMPLEMENTATION) {
      try {
        const { deferred } = chargeFailureToTargets(
          batchPlan?.tasks || [],
          iterationId,
          String(err.message || '').slice(0, 240),
          satisfiedTargets,
        );
        if (deferred.functions || deferred.features) {
          lg.warn(
            `stopped retrying ${deferred.functions} function(s) + ${deferred.features} feature(s) — `
            + 'three runs each and none of them landed',
            { runId: iterationId },
          );
        }
      } catch (e) {
        // Accounting must never be the reason a failed run fails differently.
        lg.debug?.(`could not record the failure against the backlog: ${e.message}`, { runId: iterationId });
      }
    }

    /* ------------------------ learn from the FAILURE ----------------------- */
    // The success path already writes lessons; the failure path did not, because a veto `throw`s
    // straight past it. So the most frequent genuine failure — a "refactor" that added code and
    // deleted none — fired 7 times in 60 runs and taught the fleet nothing each time. A gate that
    // only refuses is a gate nobody learns from.
    //
    // Interruptions are excluded on purpose: the run was stopped, not judged, and there is nothing
    // to learn from someone restarting the server.
    if (verdict.kind === KIND.IMPLEMENTATION) {
      try {
        const lesson = FAILURE_LESSONS[verdict.code];
        if (lesson) {
          remember({ scope: 'global', kind: 'pitfall', title: lesson.title, content: lesson.content, source: `engine:${verdict.code}` });
          // Also scoped per acting agent, because these are habits rather than one-off slips.
          for (const agent of new Set((batchPlan?.tasks || []).map((t) => t.agent).filter(Boolean))) {
            remember({ scope: `agent:${agent}`, kind: 'pitfall', title: lesson.agentTitle, content: lesson.content, source: `engine:${verdict.code}` });
          }
        }
      } catch (memErr) {
        lg.warn?.(`failure learning skipped: ${memErr.message}`, { runId: iterationId });
      }
    }

    // Keep the plan so a restart doesn't have to re-derive it, and the diff so it
    // can replay the work.
    updateIteration(iterationId, {
      status,
      error: err.message,
      rolledBack,
      tokensIn,
      tokensOut,
      ...(batchPlan ? { planJson: JSON.stringify(batchPlan) } : {}),
      // An empty run has no diff to score — null the scores so it can't average in as a 100.
      ...(status === 'empty'
        ? { totalScore: null, reviewScore: null, securityScore: null, regressionScore: null, testScore: null, workbenchScore: null }
        : {}),
      finishedAt: Date.now(),
    });
    recordFailure(iterationId, verdict, diffInfo.diff ? diffInfo.diff.slice(0, 400_000) : null);

    // Release the backlog items this run had claimed.
    for (const t of batchPlan?.tasks || []) {
      if (t.functionId) setFunctionStatus(t.functionId, 'pending');
      if (t.featureId) setFeatureStatus(t.featureId, 'pending');
    }

    emit('iteration.finished', {
      iterationId,
      status,
      error: err.message,
      failure: verdict,
      resumable: verdict.resumable,
    });
    notify({
      kind: verdict.kind === KIND.INTERRUPTION ? 'system' : 'rollback',
      severity: verdict.kind === KIND.INTERRUPTION ? 'warn' : 'error',
      title: `Iteration #${iterationId} — ${verdict.title}`,
      body: verdict.explanation,
      link: `iteration:${iterationId}`,
    });
    lg.error(`#${iterationId} ${status} — ${verdict.title}: ${verdict.explanation}`, { runId: iterationId });

    return { iterationId, status, error: err.message, failure: verdict, resumable: verdict.resumable };
  } finally {
    if (sandbox) removeWorktree(sandbox);
  }
}

/**
 * Restart a failed iteration from the changes it had already produced.
 *
 * This is not "run it again". The failed run's plan and its diff are both carried
 * forward: the diff is replayed into the fresh sandbox so the implementer is looking
 * at its own work, and where it resumes depends on WHY it died —
 *
 *   interrupted   → the work is innocent. Continue from the phase that was cut short.
 *   implementation→ the work is broken. Go back to `implement`, with the failure quoted,
 *                   so the defect gets fixed rather than rediscovered.
 */
export async function restartIteration(id, { trigger = 'restart', signal } = {}) {
  const prev = getIteration(id, { withDiff: true });
  if (!prev) throw new Error(`iteration #${id} not found`);
  if (!prev.failure) throw new Error(`iteration #${id} did not fail — there is nothing to restart`);

  const diff = getPendingDiff(id) || prev.diff || null;
  const from = prev.failure.resumeFrom || 'implement';

  updateIteration(id, { restarts: (prev.restarts || 0) + 1 });
  log.for('iteration').info(`restarting #${id} (${prev.failure.kind}) from the "${from}" phase`);

  return runIteration({
    trigger,
    signal,
    resume: {
      of: id,
      from,
      diff,
      plan: prev.plan,
      failure: prev.failure,
    },
  });
}
