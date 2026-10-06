import { log } from '../logger.js';
import { mountCodeIntelRoutes } from './routes/codeIntelRoutes.js';
import { mountGovernanceRoutes } from './routes/governanceRoutes.js';
import {
  onboardingStatus,
  buildContext,
  answerContextQuestion,
  verifyDocumentation,
} from '../context/contextManager.js';
import { ingestDocuments } from '../context/ingest.js';
import { refreshCodeStats } from '../context/codeScan.js';
import { listDocuments, getDocument, listFindings, resolveFinding } from '../context/contextDb.js';
import { reliabilityReport, distillImprovements, setSignalStatus, applySignal } from '../reliability/reliabilityManager.js';
import { researchProposals } from '../iteration/researcher.js';
import { landedCommits, describeCommits, commitDetail } from '../summary.js';
import { listPractices, practicesByLanguage, addPractice, deletePractice } from '../bestpractices/bestPracticesDb.js';
import { runComplianceCheck, complianceReport } from '../bestpractices/complianceManager.js';
import { resolveComplianceFinding } from '../bestpractices/complianceDb.js';
import { deployReport, defineReleaseStrategy, checkTerraformDrift } from '../deploy/deployManager.js';
import { resolveTerraformFinding } from '../deploy/deployDb.js';
import { listMemory, memoryStats, remember, pinMemory, deleteMemory } from '../memory/memoryDb.js';
import { lessonImpact } from '../memory/lessonImpact.js';
import { situationSnapshot, areaMap } from '../context/contextAgent.js';
import { networkSnapshot } from '../core/decisionNetwork.js';
import { getLastDependencyScan, startDependencyScan, isDependencyScanRunning } from '../deploy/depScan.js';
import { startRemediation, getLastRemediation, isRemediationRunning } from '../deploy/cveRemediate.js';
import { fleetCommits, startBisect, getLastBisect, isBisectRunning, revertCommit } from '../iteration/bisect.js';
import { getChangeBudget, setChangeBudget } from '../iteration/changeBudget.js';
import { listFlakyEvents, flakyStats, getFlakyRetries, setFlakyRetries, startFlakyScan, getLastFlakyScan, isFlakyScanRunning } from '../iteration/flaky.js';
import { coverageGateMode, setCoverageGateMode, coverageGateFloor, setCoverageGateFloor, DEFAULT_MIN_PCT } from '../iteration/changedLineCoverage.js';
import { scopeGateMode, setScopeGateMode } from '../iteration/scopeGate.js';
import { analyseTree, applyCleanup } from '../workbench/treeCleaner.js';
import { pullModel, cancelPull, pullStatus, adoptModel, pullAndAdopt, currentAssignment, topLocalModels } from '../core/modelPull.js';
import { diagnose, repair, lastDiagnosis } from '../repair/repair.js';
import { deployStatus, promoteToMain } from '../iteration/promote.js';
import { verifyAtCommit } from '../iteration/promoteRisk.js';
import { planPromotion, applyPlan, dropPromotionBranch } from '../iteration/promoteAgent.js';
import { unlandedWork, recoveryDiff, parkAndRecut, listParked } from '../iteration/parkWork.js';
import { ROLE_KEYS } from '../config.js';
import { crossProjectPlan, applyCrossProjectTransfer } from '../core/crossProject.js';
import { scheduleStatus, setSchedule, runWindowNow } from '../core/improvementWindows.js';
import { queryIndex, knowledgeStats, startEmbeddingBuild, similarChanges } from '../context/knowledgeIndex.js';
import { buildDigest } from '../iteration/digest.js';
import { generateChangelog } from '../iteration/changelog.js';
import { listReviewQueue, decideReview, reviewStats } from '../core/reviewQueue.js';
import { can, roleFor } from './rbac.js';
import { audit } from './platformDb.js';
import { ACTIVE_PROJECT_ID } from '../config.js';
import { trustLedger } from '../core/trust.js';
import { autonomyMode, getHealthGuard, setHealthGuard } from '../core/autonomy.js';
import { autoPromoteStatus, runAutoPromote, isAutoPromoteEnabled, setAutoPromoteEnabled } from '../deploy/autoPromote.js';
import {
  doraMetrics, listDeployments, checkBakeWindows, resolveBreach,
  getBakeWindowMinutes, setBakeWindowMinutes, isAutoRevertEnabled, setAutoRevertEnabled,
} from '../deploy/dora.js';
import { getScope, setScope, resetScope, scopeBrief, focusShare, THEMES, THEME_KEYS, themeForAgent } from '../core/scope.js';
import { detectModels, getDetected, getModelConfig, setModelConfig, resetModelConfig, effectiveModels, testModel } from '../core/models.js';
import { getSetting, setSetting, db } from '../db.js';

const wrap = (fn) => (req, res) => {
  new Promise((resolve) => resolve(fn(req, res))).catch((err) => {
    res.status(err.status ?? 400).json({ error: err.message });
  });
};

// Long LLM tasks run in the background; the dashboard learns they finished from
// the WebSocket events they emit. A per-key guard prevents overlapping runs.
const inflight = {};
function background(key, fn, label) {
  if (inflight[key]) return { started: false, busy: true };
  inflight[key] = true;
  Promise.resolve()
    .then(fn)
    .catch((e) => log.error('feature', `${label} failed: ${e.message}`))
    .finally(() => {
      inflight[key] = false;
    });
  return { started: true };
}

export function mountFeatureRoutes(app, { reanalyzeManagers } = {}) {
  // Code-intelligence endpoints live in their own module (health, structure, coverage, impact,
  // blast radius, refactor preview, a11y audit, dedup, toolchain capability).
  mountCodeIntelRoutes(app, { wrap });
  // Enterprise governance: quality gates, protected paths, secret scan, licences, webhooks.
  mountGovernanceRoutes(app, { wrap });

  const refresh = () => reanalyzeManagers?.();

  /* ------------------------------ context ------------------------------- */

  app.get('/api/context', wrap((_req, res) => res.json(onboardingStatus())));

  app.post(
    '/api/context/build',
    wrap((req, res) => {
      const force = !!req.body?.force;
      res.json(background('context', async () => {
        await buildContext({ force });
        refresh();
      }, 'context build'));
    }),
  );

  app.post(
    '/api/context/ingest',
    wrap((_req, res) => {
      res.json(background('ingest', async () => {
        await ingestDocuments({ force: false });
        refresh();
      }, 'doc ingest'));
    }),
  );

  app.post(
    '/api/context/verify',
    wrap((_req, res) => {
      res.json(background('verify', async () => {
        await verifyDocumentation({});
        refresh();
      }, 'doc verify'));
    }),
  );

  app.post(
    '/api/context/questions/:id',
    wrap((req, res) => {
      const r = answerContextQuestion(Number(req.params.id), String(req.body?.answer ?? ''));
      refresh();
      res.json(r);
    }),
  );

  app.post(
    '/api/context/scan',
    wrap((_req, res) => {
      res.json(background('scan', async () => {
        refreshCodeStats();
        refresh();
      }, 'code scan'));
    }),
  );

  app.get('/api/context/documents', wrap((_req, res) => res.json(listDocuments())));
  app.get(
    '/api/context/documents/:id',
    wrap((req, res) => {
      const doc = getDocument(Number(req.params.id), { withText: true });
      if (!doc) return res.status(404).json({ error: 'Document not found' });
      res.json(doc);
    }),
  );
  app.get('/api/context/findings', wrap((_req, res) => res.json(listFindings({ onlyOpen: false, limit: 200 }))));

  // The Context Agent: live situational awareness fed to every other agent.
  app.get('/api/context/situation', wrap((_req, res) => res.json({ snapshot: situationSnapshot(), areas: areaMap() })));

  // The Decision Network: the learned (agent × area) competence graph driving routing.
  app.get('/api/decisions', wrap((_req, res) => res.json(networkSnapshot())));

  // Dependency & CVE scan: known vulnerabilities in the target app's dependencies (npm audit).
  // Slow + needs network, so the result is cached and refreshed by a background trigger.
  app.get('/api/dependencies', wrap((_req, res) => {
    res.json({ scan: getLastDependencyScan(), running: isDependencyScanRunning() });
  }));
  app.post('/api/dependencies/scan', wrap((_req, res) => {
    const started = startDependencyScan();
    res.json({ started, running: true });
  }));

  // CVE auto-remediation: compute the semver-SAFE upgrades (lockfile-only, isolated worktree,
  // never --force, never touches the real checkout) and report which CVEs they close.
  app.get('/api/dependencies/remediate', wrap((_req, res) => {
    res.json({ result: getLastRemediation(), running: isRemediationRunning() });
  }));
  app.post('/api/dependencies/remediate', wrap((req, res) => {
    const projectDir = req.body?.projectDir ? String(req.body.projectDir) : null;
    res.json({ started: startRemediation(projectDir ? { projectDir } : {}), running: true });
  }));


  // Regression bisect & auto-revert: find the fleet commit that introduced a break and undo it.
  app.get('/api/regression/commits', wrap((_req, res) => res.json({ commits: fleetCommits({ limit: 25 }) })));
  app.get('/api/regression/bisect', wrap((_req, res) => res.json({ result: getLastBisect(), running: isBisectRunning() })));
  app.post('/api/regression/bisect', wrap((req, res) => {
    const { command, args, projectDir, limit } = req.body || {};
    const verify = command ? { command: String(command), args: Array.isArray(args) ? args : String(args || '').split(' ').filter(Boolean), projectDir: projectDir || '.' } : { projectDir: projectDir || '.' };
    const started = startBisect({ verify, limit: Math.min(30, Math.max(4, Number(limit) || 25)) });
    res.json({ started, running: true });
  }));
  app.post('/api/regression/revert', wrap((req, res) => {
    const sha = String(req.body?.sha || '').trim();
    if (!sha) return res.status(400).json({ error: 'sha required' });
    const r = revertCommit({ sha });
    if (!r.ok) return res.status(409).json(r);
    res.json(r);
  }));

  // Auto-changelog: theme-grouped release notes from the landed commits.
  app.get('/api/changelog', wrap((_req, res) => res.json(generateChangelog({ limit: 150 }))));

  // Digest: a plain-language "what improved" summary over a time window (default 24h).
  app.get('/api/digest', wrap((req, res) => {
    const hours = Math.min(24 * 90, Math.max(1, Number(req.query?.hours) || 24));
    res.json(buildDigest({ hours }));
  }));

  // Knowledge index: BM25 retrieval over code symbols + shared memory — grounded search for the
  // agents and Alfred (the symbol-graph + lexical half of RAG; no embedding model required).
  app.get('/api/knowledge', wrap(async (req, res) => {
    const q = String(req.query?.q || '').trim();
    if (!q) return res.json({ query: '', results: [], stats: knowledgeStats() });
    const r = await queryIndex(q, { k: 10 });
    res.json({ ...r, stats: knowledgeStats() });
  }));
  app.post('/api/knowledge/embed', wrap((_req, res) => {
    const started = startEmbeddingBuild();
    res.json({ started, stats: knowledgeStats() });
  }));
  app.get('/api/similar-changes', wrap(async (req, res) => {
    const q = String(req.query?.q || '').trim();
    res.json(q ? await similarChanges(q, { k: 6 }) : { query: '', changes: [] });
  }));

  // Scheduled improvement windows: heavier passes (CVE scan, seeds, health, transfer) in quiet hours.
  app.get('/api/schedule', wrap((_req, res) => res.json(scheduleStatus())));
  app.post('/api/schedule', wrap((req, res) => { setSchedule(req.body || {}); res.json(scheduleStatus()); }));
  app.post('/api/schedule/run-now', wrap((_req, res) => res.json(runWindowNow())));

  // Cross-project learning transfer: promote proven patterns from one project to stack-compatible
  // others, so every project benefits from what any project learned.
  app.get('/api/cross-project', wrap((_req, res) => res.json(crossProjectPlan())));
  app.post('/api/cross-project/apply', wrap((req, res) => {
    const { from, to, max } = req.body || {};
    res.json(applyCrossProjectTransfer({ from, to, max: Math.min(20, Math.max(1, Number(max) || 10)) }));
  }));

  // Flaky-test detection & quarantine: a failing suite that passes on retry is a flake, not a
  // regression — it must not reject good changes. Surface the flakes + tune the retry guard.
  app.get('/api/flaky', wrap((_req, res) => res.json({ events: listFlakyEvents(), stats: flakyStats(), retries: getFlakyRetries(), scan: getLastFlakyScan(), running: isFlakyScanRunning() })));
  app.post('/api/flaky/retries', wrap((req, res) => res.json({ retries: setFlakyRetries(req.body?.retries) })));
  /* ── Models: obtain one, then hand it to the agents ───────────────────────── */
  app.get('/api/models/pulls', wrap((_req, res) => res.json({
    ...pullStatus(),
    assignment: currentAssignment(),
    roles: ROLE_KEYS,
    // The strongest models already installed, so the page opens on what is usable rather than on an
    // empty text field. Cached detection — this must not probe Ollama on every poll.
    top: topLocalModels(getDetected(), 5),
  })));
  app.post('/api/models/pull', wrap((req, res) => {
    const { model, adopt, roles, chat } = req.body || {};
    if (!model) return res.status(400).json({ error: 'model is required' });
    // The adopting form resolves only when the download AND the test are done, which can be many
    // minutes; the plain form returns immediately and the UI follows `model.pull` on the socket.
    if (adopt) {
      return pullAndAdopt(model, { roles, alsoChat: !!chat }).then((r) => res.json(r), (e) => res.status(500).json({ error: e.message }));
    }
    res.json(pullModel(model));
  }));
  app.post('/api/models/pull/cancel', wrap((req, res) => res.json(cancelPull(req.body?.model))));
  app.post('/api/models/adopt', wrap(async (req, res) => {
    const { model, roles, chat, verify } = req.body || {};
    if (!model) return res.status(400).json({ error: 'model is required' });
    res.json(await adoptModel(model, { roles, alsoChat: !!chat, verify: verify !== false }));
  }));

  /* ── Repair: is the app working, and can it be made to work ───────────────── */
  // Both run in a detached worktree and neither writes to the operator's checkout — a repair
  // produces a diff to review, applied through the same path as any other change.
  app.get('/api/repair', wrap((_req, res) => res.json({ last: lastDiagnosis() })));
  app.post('/api/repair/diagnose', wrap(async (_req, res) => res.json(await diagnose())));
  app.post('/api/repair/run', wrap(async (req, res) => res.json(await repair({ commit: req.body?.commit || 'HEAD' }))));

  /*
   * Auto-fix a commit that is blocking a promotion.
   *
   * Only meaningful for a risk the repair loop can actually address — a commit that does not boot.
   * A merge conflict against the operator's own uncommitted edits is NOT one of those, and offering
   * to "fix" it would mean deciding on their behalf which version of their work to discard.
   */
  /*
   * Verify the commit you are about to promote TO.
   *
   * The authoritative gate. A fast-forward installs one state — the tip of the range — so running
   * the real suite and the boot check there answers the question, whatever any individual commit's
   * history says. It clears commits the historical record flags, which is the common case and the
   * whole reason promotion had become unusable.
   */
  /*
   * THE PROMOTE AGENT: plan → approve → apply.
   *
   * A fast-forward can only land a contiguous prefix, so one bad commit walls off everything after
   * it — measured on a real branch: 49 commits ahead, the OLDEST carrying a security finding,
   * therefore nothing promotable at all. Cherry-picking the chosen commits onto a fresh branch off
   * the base lifts that, at the cost of having to reason about dependencies, which is what the plan
   * does. Planning touches nothing; applying is a separate, explicit call.
   */
  app.post('/api/deploy/plan', wrap(async (req, res) => {
    const status = deployStatus();
    const assessed = status.risk?.commits || [];
    const alsoExclude = new Set((req.body?.exclude || []).map(String));

    const plan = await planPromotion({
      commits: assessed,
      isBroken: (c) => {
        if (alsoExclude.has(c.sha)) return 'you excluded it';
        const blocking = c.risks.filter((r) => r.blocks);
        return blocking.length ? blocking.map((r) => r.label).join('; ') : null;
      },
    });
    res.json(plan);
  }));

  app.post('/api/deploy/apply-plan', wrap(async (req, res) => {
    const shas = (req.body?.shas || []).map(String).filter(Boolean);
    if (!shas.length) return res.status(400).json({ error: 'no commits approved' });
    const built = await applyPlan(shas);
    if (!built.ok) return res.json(built);

    // The main checkout still only ever fast-forwards — onto a branch containing exactly what was
    // approved. `stash` handles the operator's overlapping edits the same way as a normal promote.
    try {
      // `from` names the assembled branch: the approved commits live there, cut from the base, not
      // on the work branch. The fast-forward itself is unchanged.
      const promoted = promoteToMain(built.tip, { stash: !!req.body?.stash, from: built.branch });
      dropPromotionBranch(built.branch);
      res.json({ ...promoted, plan: { applied: built.applied, shas: built.shas } });
    } catch (err) {
      // The branch is left in place deliberately: it holds the assembled work, and discarding it
      // because the fast-forward was refused would throw away the only copy.
      res.json({ ok: false, error: err.message, branch: built.branch, hint: `the assembled commits are on ${built.branch}` });
    }
  }));

  /*
   * Park the work branch and re-cut it from the base.
   *
   * NOT "delete the broken commits": 102 iteration records and 58 deployment rows reference those
   * SHAs, and dropping them orphans the link between a commit and the run that produced it. Parking
   * keeps every commit reachable under a dated name while the counter at the top of the page goes
   * back to meaning something.
   */
  app.get('/api/deploy/unlanded', wrap((req, res) => res.json({ ...unlandedWork(req.query?.branch || null), parked: listParked() })));
  // `?branch=` targets a parked branch — after a re-cut that is the only place the unlanded work is.
  app.get('/api/deploy/recovery-patch', wrap((req, res) => res.json(recoveryDiff({ branch: req.query?.branch || null }))));
  app.post('/api/deploy/park', wrap((req, res) => res.json(parkAndRecut({ force: !!req.body?.force, dryRun: !!req.body?.dryRun }))));

  app.post('/api/deploy/verify', wrap(async (req, res) => {
    const sha = String(req.body?.sha || '').trim();
    if (!sha) return res.status(400).json({ error: 'sha is required' });
    res.json(await verifyAtCommit(sha));
  }));

  /*
   * Repair a commit that does not BOOT.
   *
   * Narrower than it first was, deliberately. It was routed at any "fixable" risk including a red
   * test suite, and `repair()` only ever checks whether the app comes up — so on a commit whose
   * tests had failed it answered "every check already passes — there is nothing to repair", which
   * is a true statement about a question nobody asked. A tool that answers confidently off-target
   * is worse than one that declines.
   */
  app.post('/api/deploy/autofix', wrap(async (req, res) => {
    const sha = String(req.body?.sha || '').trim();
    if (!sha) return res.status(400).json({ error: 'sha is required' });
    const status = deployStatus();
    const commit = status.risk?.commits?.find((c) => c.sha === sha);
    if (!commit) return res.status(404).json({ error: `${sha} is not among the commits ahead` });

    const codes = new Set(commit.risks.map((r) => r.code));
    if (!codes.has('app-broken')) {
      return res.json({
        ok: false,
        notFixable: true,
        reason: codes.has('broke-tests')
          ? 'a failing test suite is not something the boot repair can address — verify the tip instead: a later commit may already have fixed it, and that is the state that actually lands'
          : codes.has('conflict')
            ? 'this overlaps your own uncommitted edits — promote with "set my edits aside", which stashes just those files and restores them afterwards'
            : `nothing here is repairable by booting the app (${[...codes].join(', ') || 'no recorded risk'})`,
      });
    }
    res.json({ ...(await repair({ commit: sha })), sha, risks: commit.risks });
  }));

  // Coverage of the lines a change ADDS — the gate the repo-wide percentage cannot express. Ships
  // advisory: the number is recorded on every run so the choice to enforce is made against this
  // repo's real distribution, not a guess. See changedLineCoverage.js.
  app.get('/api/coverage-gate', wrap((_req, res) => res.json({
    mode: coverageGateMode(),
    minPct: coverageGateFloor(),
    modes: ['off', 'advisory', 'enforce'],
    defaultMinPct: DEFAULT_MIN_PCT,
  })));
  app.post('/api/coverage-gate', wrap((req, res) => {
    const mode = req.body?.mode == null ? coverageGateMode() : setCoverageGateMode(req.body.mode);
    const minPct = req.body?.minPct == null ? coverageGateFloor() : setCoverageGateFloor(req.body.minPct);
    res.json({ mode, minPct });
  }));

  /*
   * Identificatori usati e legati da nessuna parte, sui soli file toccati dalla modifica.
   *
   * Stessa forma della rotta di coverage e per lo stesso motivo: parte consultivo, e la decisione di
   * portarlo a `enforce` si prende guardando quante volte ha parlato su diff veri, non a intuito.
   * Su 220 file sani di questo progetto ne segnala 3 a torto — troppo pochi per essere rumore,
   * troppi per bloccare una run. Vedi scopeGate.js.
   */
  app.get('/api/scope-gate', wrap((_req, res) => res.json({
    mode: scopeGateMode(),
    modes: ['off', 'advisory', 'enforce'],
  })));
  app.post('/api/scope-gate', wrap((req, res) => {
    const mode = req.body?.mode == null ? scopeGateMode() : setScopeGateMode(req.body.mode);
    res.json({ mode });
  }));

  /*
   * L'albero di lavoro sporco, spiegato invece che solo segnalato.
   *
   * GET classifica e non tocca niente; POST agisce solo sui percorsi scelti, rifiuta tutto ciò che
   * contiene lavoro vero e lascia sempre una via di recupero. Vedi treeCleaner.js.
   */
  app.get('/api/tree/clean', wrap((_req, res) => res.json(analyseTree())));
  app.post('/api/tree/clean', wrap((req, res) => {
    const paths = Array.isArray(req.body?.paths) ? req.body.paths : [];
    if (!paths.length) return res.status(400).json({ error: 'indica quali percorsi ripulire' });
    res.json(applyCleanup(paths, { dryRun: !!req.body?.dryRun }));
  }));

  app.post('/api/flaky/scan', wrap((req, res) => {
    const { projectDir, runs } = req.body || {};
    const started = startFlakyScan({ projectDir: projectDir || '.', runs: Math.min(8, Math.max(2, Number(runs) || 4)) });
    res.json({ started, running: true });
  }));

  // Change-size budget: caps how much one iteration may change (soft → review, hard → veto).
  app.get('/api/change-budget', wrap((_req, res) => res.json(getChangeBudget())));
  app.post('/api/change-budget', wrap((req, res) => res.json(setChangeBudget(req.body || {}))));

  // Human review queue + per-agent trust: risky/low-trust changes wait for a human, the rest
  // auto-land. Advisory on the commit (the loop never stalls); the queue governs human blessing.
  app.get('/api/review-queue', wrap((req, res) => {
    const status = req.query?.status ? String(req.query.status) : null;
    res.json({ items: listReviewQueue({ status }), stats: reviewStats(), trust: trustLedger(), autonomy: autonomyMode() });
  }));
  // Trust-gated auto-promotion: which earned commits could fast-forward to the base branch.
  // GET is a pure dry-run; the promote itself is off by default and operator-gated.
  app.get('/api/auto-promote', wrap((_req, res) => res.json({ ...autoPromoteStatus(), enabled: isAutoPromoteEnabled() })));
  app.post('/api/auto-promote/enabled', wrap((req, res) => res.json({ enabled: setAutoPromoteEnabled(req.body?.enabled) })));
  app.post('/api/auto-promote/run', wrap((req, res) => res.json(runAutoPromote({ force: !!req.body?.force }))));

  // DORA + the post-deploy guardrail. The metrics are split ISL vs human and reported whichever way
  // they come out; `autoRevert` is standing authorisation to EXECUTE a revert rather than propose
  // one, so it is a deliberate, separately-named switch.
  // `recent`, not `deployments` — the metrics object already has a `deployments` COUNT, and
  // spreading a list over it would silently turn a number into an array for every reader.
  app.get('/api/dora', wrap((req, res) => res.json({
    ...doraMetrics({ days: Math.min(365, Math.max(1, Number(req.query?.days) || 30)) }),
    recent: listDeployments(25),
  })));
  app.post('/api/dora/check', wrap((_req, res) => res.json(checkBakeWindows())));
  app.post('/api/dora/bake-window', wrap((req, res) => { setBakeWindowMinutes(req.body?.minutes); res.json({ minutes: getBakeWindowMinutes() }); }));
  app.post('/api/dora/auto-revert', wrap((req, res) => { setAutoRevertEnabled(req.body?.enabled); res.json({ enabled: isAutoRevertEnabled() }); }));
  app.post('/api/dora/:id/resolve', wrap((req, res) => res.json(resolveBreach(Number(req.params.id), { revertedSha: req.body?.sha || null }))));

  // Health-gated autonomy: the drop threshold below a recent health peak that suspends auto-land.
  app.get('/api/autonomy', wrap((_req, res) => res.json({ ...autonomyMode(), guardDrop: getHealthGuard() })));
  app.post('/api/autonomy', wrap((req, res) => { setHealthGuard(req.body?.guardDrop); res.json({ ...autonomyMode(), guardDrop: getHealthGuard() }); }));
  app.post('/api/review-queue/:id/decide', wrap((req, res) => {
    const verdict = req.body?.verdict === 'approve' ? 'approve' : 'reject';
    // The decision must be attributable to a person. `'operator'` as a fallback would have made
    // every anonymous approval indistinguishable — and segregation of duties needs an identity to
    // compare against, so an unidentified approver is refused rather than defaulted.
    const by = req.user?.email || req.user?.id;
    if (!by) return res.status(401).json({ error: 'an approval must be attributable to an identified user' });
    if (!can(ACTIVE_PROJECT_ID, req.user, 'review.decide')) {
      audit('review.denied_no_capability', { actor: by, target: String(req.params.id), detail: { role: roleFor(ACTIVE_PROJECT_ID, req.user) } });
      return res.status(403).json({ error: 'your role in this project cannot decide reviews', role: roleFor(ACTIVE_PROJECT_ID, req.user) });
    }
    try {
      const item = decideReview(Number(req.params.id), verdict, by);
      if (!item) return res.status(404).json({ error: 'not found or already decided' });
      res.json(item);
    } catch (err) {
      // 409, not 403: the identity IS permitted to approve changes — just not this one.
      if (err.name === 'SodViolation') return res.status(409).json({ error: err.reason, control: 'segregation-of-duties' });
      throw err;
    }
  }));

  // MODELS & LLM — detect what's actually available and let the operator pick per role, live.
  app.get('/api/models', wrap((_req, res) => {
    res.json({ detected: getDetected(), config: getModelConfig(), effective: effectiveModels() });
  }));
  app.post('/api/models/detect', wrap(async (_req, res) => {
    res.json({ detected: await detectModels(), config: getModelConfig(), effective: effectiveModels() });
  }));
  app.post('/api/models/config', wrap((req, res) => {
    res.json({ config: setModelConfig(req.body || {}), effective: effectiveModels() });
  }));
  app.post('/api/models/reset', wrap((_req, res) => res.json({ config: resetModelConfig(), effective: effectiveModels() })));
  app.post('/api/models/test', wrap(async (req, res) => {
    const id = String(req.body?.model || '').trim();
    if (!id) return res.status(400).json({ error: 'model required' });
    res.json(await testModel(id, { embedding: !!req.body?.embedding }));
  }));

  // IMPROVEMENT SCOPE — the human's steering wheel: the focus mix, caps, directives, exclusions and
  // research topics that the planner, every agent, the managers and the online research must follow.
  app.get('/api/scope', wrap((_req, res) => {
    const scope = getScope();
    const share = focusShare(scope);
    // What the fleet has ACTUALLY been doing lately, so the operator can see drift vs. their intent.
    let actual = null;
    try {
      const rows = db.prepare(
        `SELECT t.agent AS agent, COUNT(*) n FROM tasks t
         JOIN iterations i ON i.id = t.iteration_id
         WHERE i.status IN ('committed','promoted') GROUP BY t.agent`,
      ).all();
      const byTheme = {};
      let total = 0;
      for (const r of rows) { const th = themeForAgent(r.agent); byTheme[th] = (byTheme[th] || 0) + r.n; total += r.n; }
      if (total) actual = Object.fromEntries(THEME_KEYS.map((k) => [k, Math.round(((byTheme[k] || 0) / total) * 100)]));
    } catch { /* history not ready */ }
    res.json({
      scope,
      share: Object.fromEntries(THEME_KEYS.map((k) => [k, Math.round(share[k] * 100)])),
      actual,
      themes: THEMES,
      brief: scopeBrief(scope),
    });
  }));
  app.post('/api/scope', wrap((req, res) => res.json({ scope: setScope(req.body || {}), brief: scopeBrief() })));
  app.post('/api/scope/reset', wrap((_req, res) => res.json({ scope: resetScope(), brief: scopeBrief() })));

  // Goal-setting: the operator's current objective the fleet plans toward.
  app.get('/api/goal', wrap((_req, res) => res.json(getSetting('projectGoal', null) || { text: '', area: '' })));
  app.post('/api/goal', wrap((req, res) => {
    const text = String(req.body?.text || '').slice(0, 400).trim();
    const area = ['backend', 'frontend', 'services', 'infra', ''].includes(req.body?.area) ? req.body.area : '';
    const goal = text ? { text, area, setAt: Date.now() } : null;
    setSetting('projectGoal', goal);
    res.json(goal || { text: '', area: '' });
  }));
  app.post('/api/context/findings/:id/resolve', wrap((req, res) => {
    resolveFinding(Number(req.params.id));
    refresh();
    res.json({ ok: true });
  }));

  /* ------------------------------ summary ------------------------------- */
  // What actually landed: the committed iterations, selectable, with an on-demand
  // plain-English summary of a chosen subset.
  app.get('/api/summary/commits', wrap((_req, res) => res.json(landedCommits())));
  app.get('/api/summary/commits/:id', wrap((req, res) => {
    const d = commitDetail(req.params.id);
    if (!d) return res.status(404).json({ error: 'Commit not found' });
    res.json(d);
  }));
  app.post('/api/summary/describe', wrap(async (req, res) => {
    const ids = Array.isArray(req.body?.ids) ? req.body.ids : [];
    if (!ids.length) return res.status(400).json({ error: 'Select at least one commit' });
    res.json(await describeCommits(ids));
  }));

  /* -------------------------- best practices ---------------------------- */
  app.get('/api/bestpractices', wrap((req, res) => {
    res.json({
      byLanguage: practicesByLanguage(),
      list: listPractices({ language: req.query.language || null, category: req.query.category || null }),
    });
  }));
  app.post('/api/bestpractices', wrap((req, res) => {
    const { language, category, title, rule, severity, rationale } = req.body ?? {};
    if (!language || !title || !rule) throw new Error('language, title and rule are required');
    res.json({ id: addPractice({ language, category: category || 'maintainability', title, rule, severity, rationale }) });
  }));
  app.delete('/api/bestpractices/:id', wrap((req, res) => res.json({ deleted: deletePractice(Number(req.params.id)) })));

  /* ---------------------------- compliance ------------------------------ */
  app.get('/api/compliance', wrap((_req, res) => res.json(complianceReport())));
  app.post('/api/compliance/check', wrap((req, res) => {
    const languages = Array.isArray(req.body?.languages) ? req.body.languages : null;
    res.json(background('compliance', async () => {
      await runComplianceCheck({ languages });
      refresh();
    }, 'compliance check'));
  }));
  app.post('/api/compliance/findings/:id/resolve', wrap((req, res) => {
    resolveComplianceFinding(Number(req.params.id));
    refresh();
    res.json({ ok: true });
  }));

  /* ------------------------------- deploy ------------------------------- */
  app.get('/api/deploy/cloud', wrap((_req, res) => res.json(deployReport())));
  app.post('/api/deploy/strategy', wrap((req, res) => {
    const cloud = ['gcp', 'aws', 'generic'].includes(req.body?.cloud) ? req.body.cloud : 'gcp';
    res.json(background(`strategy-${cloud}`, async () => {
      await defineReleaseStrategy({ cloud });
      refresh();
    }, `${cloud} release strategy`));
  }));
  app.post('/api/deploy/terraform-check', wrap((_req, res) => {
    res.json(background('tf-check', async () => {
      await checkTerraformDrift({});
      refresh();
    }, 'terraform drift check'));
  }));
  app.post('/api/deploy/terraform-findings/:id/resolve', wrap((req, res) => {
    resolveTerraformFinding(Number(req.params.id));
    refresh();
    res.json({ ok: true });
  }));

  /* ------------------------- shared memory ------------------------------ */
  // `impact` answers the question a memory page could never answer before: is any of this WORKING?
  // A lesson that has not reduced its failure is the one an operator needs to see — it usually means
  // the diagnosis is wrong, not that the fleet is ignoring instruction.
  app.get('/api/memory', wrap((req, res) => res.json({
    stats: memoryStats(),
    list: listMemory({ scope: req.query.scope || null, limit: 400 }),
    impact: lessonImpact(),
  })));
  app.post('/api/memory', wrap((req, res) => {
    const { scope, kind, title, content } = req.body ?? {};
    if (!title?.trim()) throw new Error('title is required');
    const id = remember({ scope: scope || 'global', kind: kind || 'lesson', title, content, source: 'operator' });
    refresh();
    res.json({ id });
  }));
  app.post('/api/memory/:id/pin', wrap((req, res) => {
    pinMemory(Number(req.params.id), req.body?.pinned !== false);
    res.json({ ok: true });
  }));
  app.delete('/api/memory/:id', wrap((req, res) => res.json({ deleted: deleteMemory(Number(req.params.id)) })));

  /* ------------------------------ research ------------------------------ */
  // On-demand: search the web for the best features for this project's stack and
  // land concrete ideas in the backlog.
  app.post(
    '/api/research',
    wrap((_req, res) => {
      res.json(background('research', async () => {
        await researchProposals({ count: 8 });
        refresh();
      }, 'feature research'));
    }),
  );

  /* ---------------------------- reliability ----------------------------- */

  app.get('/api/reliability', wrap((_req, res) => res.json(reliabilityReport())));

  app.post(
    '/api/reliability/distill',
    wrap((_req, res) => {
      res.json(background('distill', async () => {
        await distillImprovements({});
        refresh();
      }, 'reliability distill'));
    }),
  );

  app.post(
    '/api/reliability/signals/:id/:action',
    wrap(async (req, res) => {
      const action = req.params.action;
      const id = Number(req.params.id);
      if (action === 'apply') {
        // Actually apply the fix (update the agent / run params / manager), not just mark it.
        const r = await applySignal(id);
        refresh();
        return res.json({ ok: true, applied: r.applied ?? null });
      }
      if (action === 'dismiss') {
        setSignalStatus(id, 'dismissed');
        refresh();
        return res.json({ ok: true });
      }
      return res.status(400).json({ error: 'Unknown action' });
    }),
  );
}
