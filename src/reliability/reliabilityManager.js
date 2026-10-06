import { BaseManager } from '../managers/baseManager.js';
import { computeMetrics, updateAgent, getAgent } from '../db.js';
import { listIterations } from '../db_iteration.js';
import { emit } from '../bus.js';
import { log } from '../logger.js';
import { llmJson } from '../iteration/llm.js';
import { briefingFor } from '../context/fleetBriefing.js';
import { controller } from '../core/controller.js';
import { remember } from '../memory/memoryDb.js';
import { lessonFor } from '../memory/lessons.js';
import { getProposal } from '../db.js';
import {
  signatureOf,
  recordError,
  recordAnomaly,
  errorClusters,
  errorsByAgent,
  countErrors,
  countAnomalies,
  listAnomalies,
  listErrors,
  listSignals,
  upsertSignal,
  setSignalStatus,
  getSignal,
} from './reliabilityDb.js';

const HOUR = 3600_000;
const DAY = 24 * HOUR;

/**
 * The Reliability Manager — the platform's self-monitoring layer.
 *
 * Everything the other agents get wrong flows here: raised errors, failed
 * verifications, failed applies, and iterations that fail or behave strangely.
 * It clusters those into recurring signatures, flags anomalies (an agent that
 * never produces output, a phase that keeps failing, a verification pass-rate
 * collapse), and distils the patterns into concrete improvement signals for
 * tuning the fleet. Three internal "agents" cooperate under it:
 *   • collector  — captures + normalises every error into a clusterable signature
 *   • detective  — spots anomalous runs the raw error stream doesn't show
 *   • advisor    — turns clusters + stats into recommendations (LLM-assisted)
 */
export class ReliabilityManager extends BaseManager {
  constructor() {
    super('Reliability', { icon: '🩺', accent: 'rose', role: 'Agent errors, anomalies & self-improvement' });
    this.failureStreak = 0;
    this.zeroOutputStreak = 0;

    // collector: capture every error-shaped event.
    this.on('agent.error', (e) => this.collect({ source: e.agentId || 'agent', agentId: e.agentId, runId: e.runId, category: 'error', message: e.error || e.message || 'agent error' }));
    this.on('proposal.apply_failed', (e) => this.collect({ source: 'apply', agentId: e.agentId, category: 'apply', message: e.error || e.reason || 'apply failed' }));
    this.on('log.error', (e) => {
      // Ignore our own noise; capture everything else.
      if (String(e.source || '').startsWith('manager:Reliability')) return;
      this.collect({ source: e.source || 'log', agentId: e.agentId, runId: e.runId, category: 'error', message: e.message });
    });
    this.on('verify.finished', (e) => {
      if (e && e.ok === false) this.collect({ source: 'verifier', category: 'verify', message: e.summary || 'verification failed', detail: e.checks });
    });

    // detective: iteration outcomes → streaks + anomalies.
    this.on('iteration.finished', (e) => this.onIteration(e));
    // learner: turn rejections into shared-memory pitfalls the agents will read.
    this.on('proposal.rejected', (e) => this.learnFromRejection(e));
    for (const ev of ['iteration.finished', 'verify.finished', 'proposal.rejected', 'control.loop']) this.on(ev, () => this.analyze());
  }

  collect(err) {
    try {
      recordError(err);
      this.learn(err);
    } catch {
      /* the project DB may be between switches */
    }
  }

  /**
   * Record an error. It becomes a shared-memory PITFALL only if there is something an agent could
   * do differently — see `memory/lessons.js`.
   *
   * This used to write a pitfall for every error it saw, which is how the top of every prompt came
   * to read "Recurring error: fetch failed" and "Recurring failure: cause not recognised". Neither
   * changes an agent's behaviour, and the memory block has a budget: a line spent on a network
   * hiccup is a line not spent on something the agent could have done better. The error itself is
   * still recorded, clustered and shown on the Reliability page — it is simply not taught.
   */
  learn(err) {
    try {
      const lesson = lessonFor({ kind: err.failureKind, code: err.failureCode }, { agentId: err.agentId });
      if (lesson) remember(lesson);
    } catch {
      /* memory is best-effort */
    }
  }

  learnFromRejection(e = {}) {
    try {
      const p = e.proposalId ? getProposal(e.proposalId) : null;
      const agentId = e.agentId || p?.agentId || null;
      const reason = e.reason || p?.reviewNote || p?.review_note || 'rejected in review';
      const title = p?.title || e.title || 'a proposed change';
      remember({
        scope: agentId ? `agent:${agentId}` : 'global',
        kind: 'pitfall',
        title: `Rejected: ${String(title).slice(0, 110)}`,
        content: `Why: ${String(reason).slice(0, 180)}. Avoid proposing this kind of change.`,
        source: 'reliability:rejection',
      });
    } catch {
      /* best-effort */
    }
  }

  onIteration(e = {}) {
    const failure = e.failure;
    if (failure && failure.kind && failure.kind !== 'interruption') {
      this.failureStreak++;
      this.collect({
        source: 'iteration',
        iterationId: e.iterationId,
        category: 'failure',
        severity: 'error',
        message: failure.title || failure.code || 'iteration failed',
        detail: failure,
      });
      // Learn from the failure — but only when there IS a lesson. Restating the failure's own title
      // back to the fleet ("Iteration failure: Implementation error") taught nothing and crowded out
      // the lessons that do.
      const lesson = lessonFor(failure);
      if (lesson) remember(lesson);
      if (this.failureStreak >= 3) {
        recordAnomaly({
          kind: 'repeated_failure',
          iterationId: e.iterationId,
          severity: 'critical',
          message: `${this.failureStreak} consecutive iterations failed`,
          detail: failure,
        });
      }
    } else if (e.status === 'committed') {
      this.failureStreak = 0;
      // No-output detection: a committed iteration that changed nothing is odd.
      if ((e.improvements ?? e.total ?? null) != null && e.filesChanged === 0) {
        this.zeroOutputStreak++;
        if (this.zeroOutputStreak >= 2) {
          recordAnomaly({ kind: 'no_output', iterationId: e.iterationId, message: 'Iterations committing with zero file changes' });
        }
      } else {
        this.zeroOutputStreak = 0;
      }
    }
  }

  /**
   * Deterministic advisor pass: turn clusters + agent stats into signals, each
   * carrying a CONCRETE, APPLICABLE patch where one is safe to derive.
   */
  deriveSignals() {
    const clusters = errorClusters({ sinceMs: Date.now() - 7 * DAY, limit: 10 });
    for (const c of clusters) {
      if (c.count >= 3) {
        upsertSignal({
          agentId: c.agents[0] || null,
          kind: 'reliability',
          recommendation: `Recurring error (${c.count}×): "${c.sample?.slice(0, 140)}". Needs investigation${c.agents.length ? ` in ${c.agents.join(', ')}` : ''}.`,
          evidence: c.signature,
          confidence: Math.min(95, 50 + c.count * 5),
          applyTo: 'none', // a recurring error needs a human/agent to diagnose the root cause
        });
      }
    }

    const m = computeMetrics();
    for (const a of m.byAgent || []) {
      const decided = a.applied + a.rejected;
      if (decided < 3) continue;
      const ratio = a.applied / decided;
      if (ratio < 0.1) {
        upsertSignal({
          agentId: a.agentId,
          kind: 'disable',
          recommendation: `The ${a.agentId} agent's proposals are rejected ${Math.round((a.rejected / decided) * 100)}% of the time — disable it until its objective is reworked.`,
          evidence: `applied ${a.applied} / rejected ${a.rejected}`,
          confidence: 80,
          applyTo: 'agent',
          patch: { enabled: false },
        });
      } else if (ratio < 0.25) {
        upsertSignal({
          agentId: a.agentId,
          kind: 'objective',
          recommendation: `The ${a.agentId} agent is rejected ${Math.round((a.rejected / decided) * 100)}% of the time — cap it at 1 proposal per run so it only proposes its most confident change.`,
          evidence: `applied ${a.applied} / rejected ${a.rejected}`,
          confidence: 70,
          applyTo: 'agent',
          patch: { maxProposals: 1 },
        });
      }
    }

    const { passed, failed, passRate } = m.verification || {};
    if (passRate != null && passRate < 50 && passed + failed >= 4) {
      upsertSignal({
        agentId: null,
        kind: 'reliability',
        recommendation: `Verification pass rate is ${passRate}% — the fleet is producing broken changes. Reduce parallelism to 1 and the batch to 2 improvements until quality recovers.`,
        evidence: `${passed} passed / ${failed} failed`,
        confidence: 75,
        applyTo: 'control',
        patch: { parallelism: 1, improvements: 2 },
      });
    }
  }

  analyze() {
    let stats;
    try {
      const sinceDay = Date.now() - DAY;
      const clusters = errorClusters({ sinceMs: Date.now() - 7 * DAY, limit: 8 });
      const byAgent = errorsByAgent({ sinceMs: sinceDay });
      const anomalies = listAnomalies({ onlyOpen: true, limit: 50 });
      const errors24h = countErrors({ sinceMs: sinceDay });
      const openAnoms = countAnomalies({ sinceMs: 0 });
      const iters = listIterations(20);
      const failed = iters.filter((i) => i.failure && i.failure.kind && i.failure.kind !== 'interruption').length;
      const health = Math.max(0, 100 - errors24h * 3 - openAnoms * 8 - failed * 5);
      this.deriveSignals();
      const signals = listSignals({ status: 'open', limit: 20 });
      stats = {
        errors24h,
        openAnomalies: openAnoms,
        clusters: clusters.length,
        topCluster: clusters[0] ? { signature: clusters[0].sample?.slice(0, 80), count: clusters[0].count } : null,
        failedIterations: failed,
        openSignals: signals.length,
        health,
        worstAgent: byAgent[0] ? { agent: byAgent[0].agent, errors: byAgent[0].count } : null,
      };

      let status = 'idle';
      let headline = `No agent errors in the last 24h. Fleet reliability ${health}/100.`;
      const recommendations = signals.slice(0, 3).map((s) => s.recommendation);
      if (anomalies.some((a) => a.severity === 'critical') || this.failureStreak >= 3) {
        status = 'alert';
        headline = `Reliability alert: ${this.failureStreak >= 3 ? `${this.failureStreak} consecutive failed iterations` : 'critical anomaly detected'}. ${errors24h} error(s) in 24h.`;
      } else if (errors24h > 0 || openAnoms > 0) {
        status = 'watching';
        headline = `${errors24h} error(s)/24h across ${clusters.length} pattern(s), ${openAnoms} open anomaly(ies). Reliability ${health}/100.`;
      }
      this.setBrief({ status, headline, stats, recommendations });
    } catch {
      this.setBrief({ status: 'idle', headline: 'Reliability monitor initialising…', stats: {} });
    }
  }
}

/* ------------------------------ report + advisor -------------------------- */

export function reliabilityReport() {
  const sinceDay = Date.now() - DAY;
  return {
    errors24h: countErrors({ sinceMs: sinceDay }),
    clusters: errorClusters({ sinceMs: Date.now() - 7 * DAY, limit: 20 }),
    byAgent: errorsByAgent({ sinceMs: sinceDay }),
    anomalies: listAnomalies({ onlyOpen: true, limit: 50 }),
    recentErrors: listErrors({ limit: 60 }),
    signals: listSignals({ status: 'open', limit: 40 }),
  };
}

export { setSignalStatus };

const AGENT_IDS = ['security', 'tests', 'performance', 'quality', 'frontend', 'services', 'workbench', 'resilience', 'compliance', 'docs', 'infra', 'refactor', 'ux'];

const ADVISOR_SYSTEM = `You are the Reliability Advisor for a fleet of autonomous code-improvement agents.
Given clusters of recurring errors and per-agent failure statistics, produce concrete, APPLICABLE
fixes to the agents themselves and the run parameters. Each fix carries a machine-applicable patch.
Return ONLY JSON:
{"signals":[{"agentId":"id or null","kind":"objective|scope|prompt|reliability|disable","recommendation":"one line","evidence":"the data","confidence":0-100,"applyTo":"agent|control|manager|none","patch":{...}}]}
- applyTo "agent": patch may set {"objective":"a rewritten objective for this agent","maxProposals":1-3,"enabled":true|false}. When an agent's proposals are rejected a lot, prefer REWRITING its objective to be narrower/clearer.
- applyTo "control": patch may set {"parallelism":1-4,"improvements":0-6,"features":0-4} to steady the loop.
- applyTo "manager": patch is {"manager":"ManagerName","enabled":false} to pause a misbehaving manager.
- applyTo "none": no patch — the fix needs a human (e.g. a recurring root-cause error).
Valid agent ids: ${AGENT_IDS.join(', ')}. Be specific and grounded. Max 8 signals.`;

/** On-demand LLM distillation of applicable improvement signals from the error data. */
export async function distillImprovements({ signal } = {}) {
  const report = reliabilityReport();
  /*
   * The advisor was reasoning about failures in an application it had never been described. "Agent
   * X keeps failing on services/" is a different diagnosis once you know those are extracted
   * microservices whose outage must never block user access — and once you know the fleet has
   * already been caught assuming models that do not exist.
   */
  const briefing = briefingFor('manager', { includeSituation: false });
  const user = (briefing ? `${briefing}

` : '') + `ERROR CLUSTERS\n${JSON.stringify(report.clusters.slice(0, 12), null, 2)}\n\nERRORS BY AGENT\n${JSON.stringify(report.byAgent, null, 2)}\n\nOPEN ANOMALIES\n${JSON.stringify(report.anomalies.slice(0, 12), null, 2)}`;
  const r = await llmJson({ system: ADVISOR_SYSTEM, user, temperature: 0.3, signal });
  const out = Array.isArray(r.data?.signals) ? r.data.signals.slice(0, 8) : [];
  for (const s of out) {
    const applyTo = ['agent', 'control', 'manager', 'none'].includes(s.applyTo) ? s.applyTo : 'none';
    // Only accept patches for agents that exist.
    let patch = s.patch && typeof s.patch === 'object' ? s.patch : null;
    if (applyTo === 'agent' && (!s.agentId || !AGENT_IDS.includes(s.agentId))) continue;
    upsertSignal({
      agentId: s.agentId && AGENT_IDS.includes(s.agentId) ? s.agentId : null,
      kind: s.kind || 'reliability',
      recommendation: s.recommendation,
      evidence: s.evidence || null,
      confidence: s.confidence ?? null,
      applyTo,
      patch: applyTo === 'none' ? null : patch,
    });
  }
  emit('reliability.distilled', { produced: out.length });
  return { produced: out.length, signals: listSignals({ status: 'open', limit: 40 }) };
}

/**
 * Actually APPLY a signal's fix (on operator approval): update the agent, adjust
 * the run parameters, or pause a manager — not just mark it as advice. This is
 * what makes Reliability *fix* the fleet, not merely suggest changes to it.
 */
export async function applySignal(id) {
  const s = getSignal(id);
  if (!s) throw new Error(`Unknown signal #${id}`);
  if (s.status !== 'open') return { alreadyDone: true, signal: s };

  let applied = null;
  if (s.applyTo === 'agent' && s.agentId && s.patch) {
    if (!getAgent(s.agentId)) throw new Error(`Unknown agent: ${s.agentId}`);
    updateAgent(s.agentId, s.patch);
    applied = `agent ${s.agentId} ← ${JSON.stringify(s.patch)}`;
  } else if (s.applyTo === 'control' && s.patch) {
    if (s.patch.parallelism != null) controller.setParallelism(s.patch.parallelism);
    if (s.patch.improvements != null || s.patch.features != null) {
      controller.setBatch({ improvements: s.patch.improvements, features: s.patch.features });
    }
    applied = `control ← ${JSON.stringify(s.patch)}`;
  } else if (s.applyTo === 'manager' && s.patch?.manager) {
    const { setManagerEnabled } = await import('../managers/index.js');
    setManagerEnabled(s.patch.manager, s.patch.enabled !== false);
    applied = `manager ${s.patch.manager} ${s.patch.enabled === false ? 'disabled' : 'enabled'}`;
  }

  setSignalStatus(id, 'applied');
  // Record the fix in shared memory so the fleet knows what was changed and why.
  if (applied) {
    remember({
      scope: s.agentId ? `agent:${s.agentId}` : 'global',
      kind: 'fix',
      title: `Applied fix: ${String(s.recommendation).slice(0, 110)}`,
      content: applied,
      source: 'reliability:applied',
    });
  }
  emit('reliability.applied', { id, applied });
  log.info('reliability', `applied signal #${id}${applied ? ' — ' + applied : ' (acknowledged, no auto-change)'}`);
  return { applied, signal: getSignal(id) };
}
