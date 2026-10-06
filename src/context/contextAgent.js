import {
  listIterations,
  listTasks,
  listPhases,
  countFunctionsByStatus,
  countFeaturesByStatus,
} from '../db_iteration.js';
import { landedCommits } from '../summary.js';
import { listFindings, getProfile } from './contextDb.js';
import { projectContextBlurb, areaBrief } from './contextManager.js';
import { scopeBrief } from '../core/scope.js';

/**
 * THE CONTEXT AGENT.
 *
 * The Context MANAGER knows what the *application* is (its profile, stack, areas,
 * invariants — built from the docs and the code). The Context AGENT is the layer
 * that keeps every other agent aware of what the *fleet* is doing RIGHT NOW: which
 * mission this iteration is pursuing, what its peers are changing in parallel, what
 * just landed on the base branch, and how healthy the codebase context is.
 *
 * It hooks straight into the Context Manager (it reuses the manager's app profile
 * and per-area briefs) and layers live situational awareness on top. The result is
 * a single injected block so no agent ever works blind — it always has both the
 * "what this app is" context and the "what we're all doing" context.
 *
 * Every read here is best-effort: situational context enriches a run, it must never
 * be able to break one. If a query fails (no project DB open yet, empty tables) the
 * agent simply contributes less context, never an error.
 */

/** Best-effort: the single most recent iteration, whatever its state. */
function latestIteration() {
  try {
    return listIterations(1)[0] || null;
  } catch {
    return null;
  }
}

/**
 * A live snapshot of what the fleet is doing. Pure, cheap DB reads — safe to call
 * on every agent run and to poll from the dashboard.
 */
export function situationSnapshot() {
  const snap = {
    activeIteration: null,
    runningTasks: [],
    recentlyLanded: [],
    backlog: { functions: 0, features: 0 },
    contextFindings: 0,
    contextReady: false,
  };

  try {
    const it = latestIteration();
    if (it) {
      const phases = (() => { try { return listPhases(it.id); } catch { return []; } })();
      const running = phases.find((p) => p.status === 'running');
      snap.activeIteration = {
        id: it.id,
        status: it.status,
        title: it.planTitle || null,
        phase: running?.phase || (it.status === 'running' ? 'starting' : null),
        live: it.status === 'running',
      };
      // The peers: what every task in the current iteration is doing. On a live
      // iteration these are literally running alongside the caller.
      try {
        snap.runningTasks = listTasks(it.id).map((t) => ({
          agent: t.agent,
          title: t.title,
          area: t.area,
          status: t.status,
        }));
      } catch { /* no tasks yet */ }
    }
  } catch { /* no iterations */ }

  try {
    snap.recentlyLanded = landedCommits()
      .slice(0, 5)
      .map((c) => ({ sha: c.sha, title: c.title || c.planTitle || c.summary || 'change', score: c.score ?? c.totalScore ?? null }));
  } catch { /* no history */ }

  try {
    const fn = countFunctionsByStatus();
    const ft = countFeaturesByStatus();
    snap.backlog = {
      functions: (fn.pending || 0) + (fn.improving || 0),
      features: (ft.pending || 0) + (ft.in_progress || 0),
    };
  } catch { /* no backlog */ }

  try {
    snap.contextFindings = listFindings({ onlyOpen: true, limit: 100 }).length;
  } catch { /* none */ }

  try {
    snap.contextReady = !!getProfile();
  } catch { /* none */ }

  return snap;
}

/** The area map the Context Manager derived, surfaced for the dashboard. */
export function areaMap() {
  try {
    return getProfile()?.areas || [];
  } catch {
    return [];
  }
}

/**
 * A compact, human-readable block describing the current mission and what recently
 * landed — the shared "where we are" every agent gets, whether it runs inside an
 * iteration or standalone.
 */
function situationBlurb(snap = situationSnapshot()) {
  const lines = [];
  if (snap.activeIteration?.title) {
    const it = snap.activeIteration;
    lines.push(`Current mission (iteration #${it.id}${it.live ? `, live in phase "${it.phase}"` : `, ${it.status}`}): ${it.title}`);
  }
  if (snap.recentlyLanded.length) {
    lines.push(
      'Recently landed on the base branch (do not redo these; mind conflicts with them):\n' +
        snap.recentlyLanded.map((c) => `  - ${String(c.sha).slice(0, 8)} · ${c.title}${c.score != null ? ` (score ${c.score})` : ''}`).join('\n'),
    );
  }
  if (snap.backlog.functions || snap.backlog.features) {
    lines.push(`Backlog waiting: ${snap.backlog.functions} code hotspot(s), ${snap.backlog.features} feature(s).`);
  }
  return lines.join('\n');
}

/** The peers list — what the OTHER tasks in this iteration are doing right now. */
function peersBlurb(siblings = []) {
  const peers = siblings.filter((s) => s && s.title);
  if (!peers.length) return '';
  return (
    'Working alongside you in THIS iteration (coordinate — do not touch their files or duplicate their work):\n' +
    peers.slice(0, 8).map((s) => `  - [${s.agent || 'agent'}] ${s.title}${s.area ? ` · ${s.area}` : ''}`).join('\n')
  );
}

/**
 * The full working-context block for an implementer task. Combines, in order:
 *  1. the app context (from the Context Manager — what this project IS),
 *  2. the mission + area brief for this specific task,
 *  3. the live peers (what the rest of the fleet is doing in parallel),
 *  4. what recently landed.
 * This is the "so agents always know what they're doing" payload.
 */
export function taskWorkingContext({ agent, area, task, iterationBrief = null, siblings = [] } = {}) {
  const app = projectContextBlurb();
  const parts = [];

  const missionLine = iterationBrief?.title
    ? `Mission this iteration: ${iterationBrief.title}${iterationBrief.theme ? ` — ${iterationBrief.theme}` : ''}`
    : null;
  const yourLine = task?.title ? `Your part: [${agent || 'agent'}] ${task.title}${area ? ` · area: ${area}` : ''}` : null;
  const ab = area ? areaBrief(area) : '';

  const situational = [missionLine, yourLine, ab, peersBlurb(siblings), situationBlurb()]
    .filter(Boolean)
    .join('\n');

  // The operator's improvement scope comes FIRST — it is the direction every agent must follow,
  // ahead of its own specialist instincts.
  try {
    const sb = scopeBrief();
    if (sb) parts.push(sb);
  } catch { /* scope not ready */ }

  if (situational) parts.push(`SITUATIONAL CONTEXT (from the Context Agent — know what you and the fleet are doing):\n${situational}`);
  if (app) parts.push(app);
  return parts.join('\n\n');
}

/**
 * The working-context block for a STANDALONE agent run (the proposal runner), which
 * has no sibling tasks. App context + current mission + what recently landed, so
 * even an ad-hoc run is aware of the fleet's state.
 */
export function fleetContextBlurb() {
  const app = projectContextBlurb();
  const sit = situationBlurb();
  const parts = [];
  if (sit) parts.push(`SITUATIONAL CONTEXT (from the Context Agent — what the fleet is doing now):\n${sit}`);
  if (app) parts.push(app);
  return parts.join('\n\n');
}
