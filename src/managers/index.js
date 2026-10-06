import { BaseManager } from './baseManager.js';
import { ContextManager } from '../context/contextManager.js';
import { ReliabilityManager } from '../reliability/reliabilityManager.js';
import { ComplianceManager } from '../bestpractices/complianceManager.js';
import { DeploymentManager } from '../deploy/deployManager.js';
import { computeMetrics, listProposals } from '../db.js';
import { listIterations, countFeaturesByStatus, countFunctionsByStatus, listRestartable, addFeature } from '../db_iteration.js';
import { controller } from '../core/controller.js';
import { inventoryServices, integrationBacklog } from '../services/inventory.js';

/** Debounce recompute so a burst of events collapses into one analysis pass. */
function debounced(fn, ms = 400) {
  let t = null;
  return () => {
    if (t) return;
    t = setTimeout(() => {
      t = null;
      fn();
    }, ms);
    if (t.unref) t.unref();
  };
}

/* ─────────────────────────── Quality ──────────────────────────────────── */
// Owns verification and review health: are proposals passing checks, and are
// they good enough that you approve them?
class QualityManager extends BaseManager {
  constructor() {
    super('Quality', { icon: '🛡', accent: 'emerald', role: 'Verification, review & iteration quality' });
    const recompute = debounced(() => this.analyze());
    for (const e of ['verify.finished', 'proposal.approved', 'proposal.rejected', 'proposal.applied', 'agent.finished', 'iteration.finished']) {
      this.on(e, recompute);
    }
  }
  analyze() {
    const m = computeMetrics();
    const { passed, failed, passRate } = m.verification;
    const decided = m.totals.applied + m.totals.rejected;
    const applied = m.totals.applied;
    const approvalRate = decided ? Math.round((applied / decided) * 100) : null;

    // Iteration quality: average total score + rollback rate over recent iterations.
    const iters = listIterations(20).filter((i) => i.scores.total != null);
    const avgScore = iters.length ? Math.round(iters.reduce((a, b) => a + b.scores.total, 0) / iters.length) : null;
    const rolledBack = iters.filter((i) => i.rolledBack).length;
    const stats = { passRate, passed, failed, approvalRate, applied, rejected: m.totals.rejected, avgIterationScore: avgScore, iterationsRolledBack: rolledBack };

    let status = 'watching';
    let headline = `Pass rate ${passRate ?? '—'}%, ${applied} landed${avgScore != null ? ` · avg iteration ${avgScore}/100` : ''}.`;
    if (avgScore != null && avgScore < 60 && iters.length >= 3) {
      status = 'alert';
      headline = `Iteration quality low (avg ${avgScore}/100, ${rolledBack} rolled back) — the model is producing weak changes.`;
    } else if (passRate !== null && passRate < 50 && passed + failed >= 4) {
      status = 'alert';
      headline = `Only ${passRate}% of proposals pass verification — agents are producing broken changes.`;
      this.send('Insights', 'request', { ask: 'agents_failing_verification', passRate }, {
        severity: 'warn',
        title: 'Low verification pass rate — check which agents are failing',
      });
    } else if (approvalRate !== null && approvalRate < 25 && decided >= 4) {
      status = 'watching';
      headline = `${approvalRate}% approval rate — proposals verify but you reject most of them.`;
    } else if (passRate !== null && passRate >= 80) {
      status = 'idle';
      headline = `Healthy: ${passRate}% verification pass rate, ${applied} landed.`;
    }
    const recommendations = [];
    if (approvalRate !== null && approvalRate < 25 && decided >= 4)
      recommendations.push('Approval rate is low — consider tightening agent objectives so they propose less speculative changes.');
    this.setBrief({ status, headline, stats, recommendations });
  }
}

/* ─────────────────────────── Throughput ───────────────────────────────── */
// Owns velocity: how much work the fleet produces and how fast.
class ThroughputManager extends BaseManager {
  constructor() {
    super('Throughput', { icon: '⚡', accent: 'amber', role: 'Fleet velocity & cost' });
    const recompute = debounced(() => this.analyze());
    for (const e of ['agent.finished', 'proposal.created', 'agent.started']) this.on(e, recompute);
  }
  analyze() {
    const m = computeMetrics();
    const recent = m.timeline.slice(-6).reduce((a, b) => a + b.proposals, 0);
    const tokens = m.runs.tokensIn + m.runs.tokensOut;
    const perRun = m.runs.total ? (m.totals.proposals / m.runs.total).toFixed(2) : '0';
    const stats = {
      runs: m.runs.total,
      proposals: m.totals.proposals,
      proposalsPerRun: Number(perRun),
      avgRunSec: Math.round(m.runs.avgDurationMs / 1000),
      tokens,
      llmCalls: m.runs.llmCalls,
      recent6h: recent,
    };
    let status = 'watching';
    let headline = `${m.totals.proposals} proposals across ${m.runs.total} runs · ${perRun}/run · avg ${stats.avgRunSec}s.`;
    if (m.runs.total >= 3 && m.totals.proposals === 0) {
      status = 'alert';
      headline = `${m.runs.total} runs, zero proposals — agents are exploring but never committing.`;
      this.send('Insights', 'report', { reason: 'no_output', runs: m.runs.total }, {
        severity: 'warn',
        title: 'Agents produce no proposals — objectives may be too narrow',
      });
    } else if (stats.avgRunSec > 600) {
      status = 'watching';
      headline = `Runs are slow (avg ${stats.avgRunSec}s) — the model is CPU-bound. ${m.totals.proposals} proposals so far.`;
    }
    this.setBrief({ status, headline, stats });
  }
}

/* ─────────────────────────── Risk ─────────────────────────────────────── */
// Owns exposure: severity of what's queued, security findings, failed applies.
class RiskManager extends BaseManager {
  constructor() {
    super('Risk', { icon: '🔒', accent: 'rose', role: 'Severity & security exposure' });
    this.recentFindings = []; // security/safety findings from the deterministic gates
    this.gateVetoes = 0; // how many changes the security/safety gate blocked
    const recompute = debounced(() => this.analyze());
    for (const e of ['proposal.created', 'proposal.apply_failed', 'verify.finished', 'proposal.approved']) this.on(e, recompute);
    // The deterministic security/safety gate is the first line of defence — track what it
    // catches and blocked, and record blocked attacks/destruction as durable insights.
    this.on('iteration.finished', (e) => {
      const f = e?.securityFindings || [];
      if (!f.length) return;
      this.recentFindings = [...f, ...this.recentFindings].slice(0, 12);
      if (e.rolledBack && f.some((x) => x.severity === 'critical')) {
        this.gateVetoes++;
        /*
         * Shared, not filed away. This was `remember(...)`, which writes to `manager:Quality` — a
         * scope `recall()` never reads for an agent, so the one fact worth knowing (the gate keeps
         * rejecting this kind of change) reached the Memory page and no decision. `shareFinding`
         * puts it where the planner, the implementer and the reviewer already look.
         */
        this.shareFinding('risk', `The security gate blocked a change: ${f[0].kind}`, f[0].message, { severity: 'critical' });
        this.broadcast('alert', { reason: 'security_gate_veto', finding: f[0] }, { severity: 'critical', title: `Security/safety gate blocked a change: ${f[0].kind}` });
      }
      this.analyze();
    });
  }
  analyze() {
    const open = listProposals({ status: ['verified', 'failed', 'verifying'], limit: 200 });
    const sev = { critical: 0, high: 0, medium: 0, low: 0 };
    for (const p of open) sev[p.severity] = (sev[p.severity] || 0) + 1;
    const fromSecurity = open.filter((p) => p.agentId === 'security').length;
    const failedApplies = listProposals({ status: 'apply_failed', limit: 50 }).length;
    const stats = {
      ...sev, openSecurity: fromSecurity, failedApplies, openTotal: open.length,
      gateVetoes: this.gateVetoes, recentGateFindings: this.recentFindings.length,
    };

    let status = 'watching';
    let headline = `${open.length} open · ${sev.critical} critical, ${sev.high} high.`;
    if (sev.critical > 0) {
      status = 'alert';
      headline = `${sev.critical} CRITICAL proposal(s) awaiting review — triage these first.`;
      this.broadcast('alert', { reason: 'critical_open', count: sev.critical }, {
        severity: 'critical',
        title: `${sev.critical} critical proposal(s) need review`,
      });
    } else if (this.recentFindings.length) {
      status = 'watching';
      headline = `Security/safety gate active — blocked ${this.gateVetoes} unsafe change(s); ${this.recentFindings.length} recent finding(s).`;
    } else if (sev.high >= 3) {
      status = 'watching';
      headline = `${sev.high} high-severity proposals queued — review load is building.`;
    } else if (open.length === 0) {
      status = 'idle';
      headline = 'No open proposals. The security/safety gate is guarding every change.';
    }
    const recommendations = [];
    if (this.recentFindings[0]) recommendations.push(`Latest gate finding: ${this.recentFindings[0].message}`);
    if (failedApplies > 0) recommendations.push(`${failedApplies} approved change(s) failed to apply — likely a moved base commit; re-verify them.`);
    this.setBrief({ status, headline, stats, recommendations, gateFindings: this.recentFindings, gateVetoes: this.gateVetoes, summary: this.gateVetoes ? `The gate has blocked ${this.gateVetoes} secret/destructive/weakening change(s).` : '' });
  }
}

/* ─────────────────────────── Insights ─────────────────────────────────── */
// Owns intelligence: which agents are effective, where proposals cluster.
class InsightsManager extends BaseManager {
  constructor() {
    super('Insights', { icon: '🔭', accent: 'sky', role: 'Effectiveness & focus' });
    const recompute = debounced(() => this.analyze());
    for (const e of ['proposal.created', 'proposal.approved', 'proposal.rejected', 'agent.finished', 'manager.message']) this.on(e, recompute);
  }
  analyze() {
    const m = computeMetrics();
    const ranked = [...m.byAgent]
      .map((a) => ({
        ...a,
        decided: a.applied + a.rejected,
        effectiveness: a.applied + a.rejected ? Math.round((a.applied / (a.applied + a.rejected)) * 100) : null,
      }))
      .sort((a, b) => (b.effectiveness ?? -1) - (a.effectiveness ?? -1));

    const best = ranked.find((a) => a.effectiveness !== null);
    const worst = [...ranked].reverse().find((a) => a.effectiveness !== null && a.decided >= 2);

    // Hot files: which paths attract the most proposals.
    const all = listProposals({ limit: 300 });
    const fileHits = {};
    for (const p of all) for (const f of p.paths) fileHits[f] = (fileHits[f] || 0) + 1;
    const hotFiles = Object.entries(fileHits)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([path, n]) => ({ path, n }));

    const stats = {
      bestAgent: best ? { id: best.agentId, effectiveness: best.effectiveness } : null,
      worstAgent: worst ? { id: worst.agentId, effectiveness: worst.effectiveness } : null,
      hotFiles,
      ranked: ranked.map((a) => ({ id: a.agentId, proposals: a.proposals, applied: a.applied, effectiveness: a.effectiveness })),
    };
    const recommendations = [];
    if (worst && worst.effectiveness < 20)
      recommendations.push(`The ${worst.agentId} agent's proposals are almost always rejected — refine its objective or disable it.`);
    if (hotFiles[0]?.n >= 3)
      recommendations.push(`${hotFiles[0].path} attracts the most proposals — it may be a genuine hotspot worth a focused pass.`);

    const headline = best
      ? `${best.agentId} is most effective (${best.effectiveness}% landed). ${hotFiles.length} hotspot file(s) identified.`
      : 'Gathering data — no decided proposals yet to rank agents by.';
    this.setBrief({ status: 'watching', headline, stats, recommendations });
  }
}

/* ─────────────────────────── Operations (active) ──────────────────────── */
// Owns runtime health. The only manager permitted to act: it can pause the loop
// when the fleet is unhealthy, and always records why.
class OperationsManager extends BaseManager {
  constructor() {
    super('Operations', { icon: '⚙', accent: 'violet', role: 'Runtime health & control' });
    this.errorStreak = 0;
    this.alerted = false; // have we already broadcast the current failure streak?
    this.on('agent.error', () => {
      this.errorStreak++;
      this.analyze();
    });
    this.on('iteration.finished', (e) => {
      // Only an implementation/infrastructure failure counts against the fleet —
      // a run the operator cancelled says nothing about the system's health.
      if (e?.failure?.kind && e.failure.kind !== 'interruption') this.errorStreak++;
      else if (e?.status === 'committed') this.errorStreak = 0;
      this.analyze();
    });
    this.on('control.tick', () => this.analyze());
    this.on('control.loop', () => {
      this.alerted = false;
      this.analyze();
    });
  }
  analyze() {
    const s = controller.state();
    const stats = {
      loopRunning: s.looping,
      iterating: s.running,
      pending: s.fleet.pending,
      maxPending: s.fleet.maxPending,
      errorStreak: this.errorStreak,
      backpressure: s.fleet.pending >= s.fleet.maxPending,
      parallel: s.parallel.maxTasks,
      llmQueued: s.parallel.llmQueued,
      restartable: s.restartable.length,
    };
    let status = s.looping ? 'watching' : 'idle';
    let headline = s.looping
      ? `Loop running · ${s.parallel.maxTasks} task(s) in parallel · ${s.fleet.pending}/${s.fleet.maxPending} pending review.`
      : 'Loop stopped.';

    // Repeated failures raise a loud ALERT but never stop the loop: an autonomous
    // control plane must keep running until an operator explicitly stops it. Pausing
    // itself was the "everything froze for no reason" behaviour — the loop would halt
    // on a streak (often a transient one) and sit idle until someone noticed. Now it
    // keeps going, surfaces the problem, and — since Reliability learns from every
    // failure — tends to climb back out on its own.
    if (this.errorStreak >= 3 && s.looping) {
      status = 'alert';
      headline = `${this.errorStreak} consecutive failed iterations — the loop is STILL running and will keep trying. Investigate if it persists.`;
      if (!this.alerted) {
        this.alerted = true;
        this.send('broadcast', 'decision', { action: 'error_streak', reason: 'error_streak', streak: this.errorStreak }, {
          severity: 'error',
          title: 'Operations: repeated failures (loop kept running)',
        });
        this.log.error(`${this.errorStreak} consecutive failures — alerting, but the loop keeps running (never auto-pauses)`);
      }
    } else if (stats.backpressure) {
      status = 'alert';
      headline = `Backpressure: ${s.fleet.pending} proposals awaiting review (cap ${s.fleet.maxPending}). The loop keeps producing (it commits to the work branch).`;
    }
    if (this.errorStreak < 3) this.alerted = false;

    const recommendations = [];
    if (stats.backpressure) recommendations.push('Review or clear the pending queue when you can — the loop is not blocked by it.');
    if (this.errorStreak >= 3) recommendations.push('Repeated failures: check the Runs board and logs. The loop is still running on its own.');
    if (stats.restartable > 0)
      recommendations.push(`${stats.restartable} failed run(s) can be restarted from the changes they already made.`);
    this.setBrief({ status, headline, stats, recommendations });
  }
}

/* ─────────────────────────── Services (active) ─────────────────────────── */
// Owns the seams between the microservices. This is the manager the system was
// missing: nothing else was watching whether the services a project is split into
// actually work TOGETHER — which is where a distributed system really fails.
class ServicesManager extends BaseManager {
  constructor() {
    super('Services', { icon: '🔗', accent: 'cyan', role: 'Microservice integration & contracts' });
    this.inv = null;
    this.lastSeeded = 0;
    const recompute = debounced(() => this.analyze(), 800);
    for (const e of ['iteration.finished', 'proposal.applied', 'catalog.finished', 'control.loop']) this.on(e, recompute);
  }

  analyze() {
    let inv;
    try {
      inv = inventoryServices();
    } catch (err) {
      this.setBrief({ status: 'idle', headline: `Could not scan services/: ${err.message}`, stats: {} });
      return;
    }
    this.inv = inv;
    const { totals, health, services } = inv;

    const implemented = services.filter((s) => s.state === 'implemented');
    const scaffolds = services.filter((s) => s.state === 'scaffold');
    const worst = [...implemented].sort((a, b) => a.health - b.health)[0];

    const stats = {
      services: totals.services,
      implemented: totals.implemented,
      scaffolds: totals.scaffolds,
      health,
      critical: totals.critical,
      high: totals.high,
      noTimeout: totals.noTimeout,
      unsafeRetry: totals.unsafeRetry,
      weakest: worst ? { name: worst.name, health: worst.health } : null,
      graph: services.map((s) => ({ name: s.name, dependsOn: s.dependsOn, health: s.health, state: s.state })),
    };

    let status = 'watching';
    let headline = `${totals.services} services · integration health ${health}/100 · ${totals.findings} finding(s).`;
    const recommendations = [];

    // The loudest fact first: services that exist on paper and nowhere else.
    if (scaffolds.length) {
      status = 'alert';
      headline =
        `${scaffolds.length} of ${totals.services} services are EMPTY SCAFFOLDS — ` +
        `${scaffolds.map((s) => s.name).join(', ')} have their dependencies installed but no source code at all.`;
      recommendations.push(
        `The microservice architecture is declared but not built: ${scaffolds.map((s) => s.name).join(', ')} contain no code. ` +
          `Either implement them, or fold their responsibilities back into the backend and delete the directories — ` +
          `an empty service is a lie in the architecture diagram.`,
      );
    } else if (totals.unsafeRetry > 0) {
      status = 'alert';
      headline = `${totals.unsafeRetry} retry loop(s) sit on non-idempotent operations — this can double-charge a customer.`;
      this.broadcast('alert', { reason: 'unsafe_retry', count: totals.unsafeRetry }, {
        severity: 'critical',
        title: 'Retry on a non-idempotent operation — risk of double charge',
      });
    } else if (totals.noTimeout >= 3) {
      status = 'alert';
      headline = `${totals.noTimeout} cross-service call(s) have no timeout — one hung dependency can take the whole request down.`;
    } else if (worst && worst.health < 60) {
      status = 'watching';
      headline = `${worst.name} is the weakest seam (${worst.health}/100). ${totals.findings} integration finding(s) overall.`;
    } else if (totals.findings === 0) {
      status = 'idle';
      headline = `${totals.implemented} implemented service(s), no integration defects detected.`;
    }

    // Active: feed the worst seams into the backlog so the planner actually fixes
    // them, rather than leaving them as an observation nobody acts on. Throttled —
    // we are seeding a backlog, not spamming it.
    if ((totals.critical || totals.high) && Date.now() - this.lastSeeded > 30 * 60_000) {
      this.lastSeeded = Date.now();
      let seeded = 0;
      for (const seed of integrationBacklog(3)) {
        try {
          addFeature({ ...seed, source: 'services-manager' });
          seeded++;
        } catch {
          /* already queued */
        }
      }
      if (seeded) {
        status = 'acting';
        this.log.info(`seeded ${seeded} integration fix(es) into the backlog`);
        this.send('Implementation', 'report', { seeded, reason: 'integration_debt' }, {
          severity: 'warn',
          title: `Services queued ${seeded} integration fix(es)`,
        });
      }
    }

    if (totals.noTimeout) recommendations.push(`${totals.noTimeout} outbound call(s) need an explicit timeout and a defined failure path.`);
    if (worst && worst.health < 60) recommendations.push(`Give ${worst.name} a focused pass — it is the weakest seam in the mesh.`);
    this.setBrief({ status, headline, stats, recommendations });
  }
}

/* ─────────────────────────── Workbench (active) ────────────────────────── */
// Owns the question no test answers: does the application still RUN? It watches
// the boot verdict of every iteration and the state of the local runtime.
class WorkbenchManager extends BaseManager {
  constructor() {
    super('Workbench', { icon: '🔧', accent: 'orange', role: 'Local execution & boot health' });
    this.lastBoot = null;
    this.bootFailures = 0;
    this.healed = 0;
    this.on('workbench.finished', (e) => {
      this.lastBoot = e;
      if (!e?.ok) this.bootFailures++;
      this.analyze();
    });
    this.on('workbench.healed', () => {
      this.healed++;
      this.analyze();
    });
    this.on('iteration.finished', () => this.analyze());
  }

  analyze() {
    const iters = listIterations(20);
    const scored = iters.filter((i) => i.scores.workbench != null);
    const avgBoot = scored.length ? Math.round(scored.reduce((a, b) => a + b.scores.workbench, 0) / scored.length) : null;
    const brokeBoot = iters.filter((i) => i.scores.workbench != null && i.scores.workbench < 100).length;

    const stats = {
      lastBootOk: this.lastBoot ? !!this.lastBoot.ok : null,
      lastBootScore: this.lastBoot?.score ?? null,
      avgBootScore: avgBoot,
      bootFailures: this.bootFailures,
      autoHealed: this.healed,
      iterationsThatBrokeBoot: brokeBoot,
    };

    let status = 'watching';
    let headline = this.lastBoot
      ? this.lastBoot.ok
        ? `The app boots and serves. ${avgBoot != null ? `Boot health ${avgBoot}/100 across recent iterations.` : ''}`
        : `The app does NOT boot — ${this.lastBoot.summary}`
      : 'No iteration has been booted yet.';

    if (this.lastBoot && !this.lastBoot.ok) {
      status = 'alert';
      /*
       * The single most useful thing any manager knows, and it used to reach only its peers. The
       * app not starting changes what every agent should do next: it is not the moment to refactor
       * a helper, and a reviewer grading an unrelated diff should know the build underneath it is
       * broken. Shared into memory as well, so the next planner sees it.
       */
      this.shareFinding('blocker', 'The application does not start', this.lastBoot.summary, { severity: 'critical' });
    } else if (this.healed > 0) {
      status = 'acting';
      headline = `The app boots. The workbench agent repaired ${this.healed} boot failure(s) that would otherwise have shipped.`;
    } else if (!this.lastBoot) {
      status = 'idle';
    }

    const recommendations = [];
    if (brokeBoot >= 2)
      recommendations.push(`${brokeBoot} recent iteration(s) broke startup — the model is producing changes that pass tests but do not run.`);
    this.setBrief({ status, headline, stats, recommendations });
  }
}

/* ─────────────────────────── bootstrap ────────────────────────────────── */

/* ─────────────────────────── Implementation (active) ─────────────────────── */
// Owns the iteration pipeline: which phase is live, how iterations are landing,
// and the state of the backlog the engine draws from.
class ImplementationManager extends BaseManager {
  constructor() {
    super('Implementation', { icon: '🛠', accent: 'teal', role: 'Iteration pipeline & backlog flow' });
    this.phase = null;
    this.on('iteration.started', () => {
      this.phase = 'catalog';
      this.analyze();
    });
    this.on('iteration.phase', (e) => {
      if (e?.status === 'running') this.phase = e.phase;
      this.analyze();
    });
    this.on('iteration.finished', () => {
      this.phase = null;
      this.analyze();
    });
    this.on('iteration.loop', () => this.analyze());
  }
  analyze() {
    const ctrl = controller.state();
    const fn = countFunctionsByStatus();
    const feat = countFeaturesByStatus();
    const iters = listIterations(20);
    const committed = iters.filter((i) => i.status === 'committed' && !i.rolledBack).length;
    const restartable = listRestartable(10);
    const savedMs = iters.reduce((a, i) => a + (i.parallelSavedMs || 0), 0);

    const stats = {
      loopRunning: ctrl.looping,
      iterating: ctrl.running,
      phase: this.phase || '—',
      today: ctrl.todayCount,
      committed,
      backlogFeatures: feat.pending,
      hotspots: fn.pending,
      improved: fn.improved,
      parallel: ctrl.parallel.maxTasks,
      batch: `${ctrl.batch.improvements} impr + ${ctrl.batch.features} feat`,
      restartable: restartable.length,
      timeSavedMin: Math.round(savedMs / 60000),
    };
    let status = ctrl.running ? 'acting' : ctrl.looping ? 'watching' : 'idle';
    let headline = ctrl.running
      ? `Iteration in progress — phase: ${this.phase || 'starting'}. ${ctrl.parallel.maxTasks} task(s) running in parallel.`
      : ctrl.looping
        ? `Loop armed (${ctrl.todayCount}/${ctrl.maxPerDay} today). ${committed} iteration(s) committed.`
        : `Loop idle. ${feat.pending} features + ${fn.pending} hotspots waiting.`;

    const recommendations = [];
    if (feat.pending === 0 && fn.pending === 0 && ctrl.looping)
      recommendations.push('Backlog is empty — the Surveyor will refill it from a codebase analysis on the next due run, or press “survey” in the Backlog tab.');
    if (restartable.length)
      recommendations.push(`${restartable.length} failed run(s) are restartable from the changes they already produced.`);
    if (savedMs > 300_000)
      recommendations.push(`Running tasks in parallel has saved roughly ${Math.round(savedMs / 60000)} minutes so far.`);
    // Decision-network intelligence: surface who ships where, and reroute away from a
    // pairing that keeps failing (this is what the planner already does automatically).
    const net = this.decisions();
    if (net.weak?.length) {
      const w = net.weak[0];
      recommendations.push(`Decision network: ${w.agent} lands only ${Math.round(w.landRate * 100)}% in ${w.area} (${w.landed}/${w.attempts}) — routing is steering that work to a stronger specialist.`);
      stats.weakestPairing = `${w.agent}/${w.area} ${Math.round(w.landRate * 100)}%`;
    }
    if (net.strong?.length) stats.strongestPairing = `${net.strong[0].agent}/${net.strong[0].area} ${Math.round(net.strong[0].landRate * 100)}%`;
    this.setBrief({ status, headline, stats, recommendations });
  }
}

/* ─────────────────────────── Director (active) ────────────────────────── */
// The orchestration lead. Unlike the observers, it decides what the fleet should
// work on NEXT: it identifies the single most critical task in the system and,
// when the loop is running, actively dispatches the right agent to it.
class DirectorManager extends BaseManager {
  constructor() {
    super('Director', { icon: '🧭', accent: 'sky', role: 'Critical task & dispatch' });
    this.lastDispatch = 0;
    const recompute = debounced(() => this.analyze(), 600);
    for (const e of ['proposal.created', 'verify.finished', 'agent.finished', 'iteration.finished', 'proposal.rejected', 'proposal.applied']) {
      this.on(e, recompute);
    }
  }

  /** The single most critical piece of work right now, with who should own it. */
  critical() {
    // 1. An unreviewed critical/high proposal is the most urgent thing.
    const open = listProposals({ status: ['verified', 'failed', 'verifying'], limit: 200 });
    const bySev = { critical: [], high: [], medium: [], low: [] };
    for (const p of open) (bySev[p.severity] || bySev.low).push(p);
    if (bySev.critical.length) return { kind: 'review', headline: `Review the ${bySev.critical.length} CRITICAL proposal(s) awaiting you`, owner: null, criticality: 'critical' };
    if (bySev.high.length >= 3) return { kind: 'review', headline: `${bySev.high.length} high-severity proposals need review`, owner: null, criticality: 'high' };

    // 2. Otherwise the critical task is to strengthen the weakest domain.
    const m = computeMetrics();
    const ranked = m.byAgent
      .map((a) => ({ id: a.agentId, decided: a.applied + a.rejected, eff: a.applied + a.rejected ? a.applied / (a.applied + a.rejected) : null, proposals: a.proposals }))
      .filter((a) => a.id);
    // Security always matters; then whichever domain has produced the least.
    const leastCovered = [...ranked].sort((a, b) => a.proposals - b.proposals)[0];
    const owner = leastCovered?.proposals === 0 ? leastCovered.id : 'security';
    return { kind: 'improve', headline: `Strengthen the ${owner} surface next`, owner, criticality: 'medium' };
  }

  analyze() {
    const crit = this.critical();
    const s = controller.state();
    const stats = {
      criticalTask: crit.headline,
      owner: crit.owner || 'you',
      criticality: crit.criticality,
      loopRunning: s.looping,
      iterating: s.running,
    };

    let status = crit.criticality === 'critical' ? 'alert' : 'watching';
    let headline = `Critical task: ${crit.headline}.`;
    const recommendations = [];

    // Active dispatch: when the loop is idle and the critical task is a review pass a
    // specific specialist owns, send that specialist in — throttled so we never thrash.
    const canDispatch = s.looping && !s.running && crit.owner && crit.owner !== 'you';
    if (canDispatch && Date.now() - this.lastDispatch > 60_000) {
      this.lastDispatch = Date.now();
      status = 'acting';
      headline = `Dispatching ${crit.owner}: ${crit.headline}.`;
      try {
        controller.runAgent(crit.owner);
        this.send('broadcast', 'decision', { action: 'dispatch', agent: crit.owner, reason: crit.headline }, { severity: 'info', title: `Director dispatched ${crit.owner}` });
        this.log.info(`dispatched ${crit.owner} for the critical task: ${crit.headline}`);
      } catch {
        /* agent busy/unknown — skip */
      }
    }
    if (crit.owner === 'you') recommendations.push('The critical task is yours: review the queued proposals.');
    this.setBrief({ status, headline, stats, recommendations });
  }
}

let managers = null;

export function startManagers() {
  if (managers) return managers;
  const all = [
    new DirectorManager(),
    new QualityManager(),
    new ThroughputManager(),
    new ImplementationManager(),
    new ServicesManager(),
    new WorkbenchManager(),
    new ContextManager(),
    new ReliabilityManager(),
    new ComplianceManager(),
    new DeploymentManager(),
    new RiskManager(),
    new InsightsManager(),
    new OperationsManager(),
  ];
  const names = all.map((m) => m.name);
  for (const m of all) {
    m.setPeers(names);
    m.start();
  }
  // Prime each brief once so the dashboard has content immediately.
  setTimeout(() => all.forEach((m) => m.analyze?.()), 300);

  managers = { all, names, byName: Object.fromEntries(all.map((m) => [m.name, m])) };
  return managers;
}

export function stopManagers() {
  managers?.all.forEach((m) => m.stop());
  managers = null;
}

/** Enable/disable a manager by name (used by Reliability to fix a misbehaving one). */
export function setManagerEnabled(name, on) {
  const m = managers?.byName?.[name];
  if (!m) return null;
  return { name, enabled: m.setEnabled(on) };
}

export function listManagerStates() {
  return (managers?.all || []).map((m) => ({ name: m.name, enabled: m.isEnabled() }));
}
