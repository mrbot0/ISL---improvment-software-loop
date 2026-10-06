import { db } from '../db.js';
import { recall } from '../memory/memoryDb.js';

/**
 * THE DECISION NETWORK — the fleet's choice brain.
 *
 * Every agent is good at some things and bad at others, and the only honest measure is
 * what actually LANDS. This module learns, from real outcomes, a competence graph over
 * (agent × area): how often each specialist's work in each area survived review, tests
 * and the workbench and got committed. That learned signal then drives the two choices
 * that decide whether an iteration produces value:
 *
 *   1. ROUTING   — which specialist should own a given change (chooseAgent)
 *   2. PRIORITY  — which backlog item is worth doing now (scoreCandidate)
 *
 * It is a learning network, but an explainable one: the "weights" are land-rates you can
 * read straight off the table, updated by every iteration. New (agent, area) pairs start
 * neutral (Laplace-smoothed) so the network explores before it exploits, then it leans
 * into what works — e.g. it learns that resilience/services lands ~100% while
 * refactor/frontend lands ~0%, and routes accordingly.
 */

const AGENTS = [
  'security', 'performance', 'tests', 'quality', 'frontend', 'services', 'workbench',
  'resilience', 'compliance', 'docs', 'infra', 'refactor', 'ux',
];

/* ----------------------------- static fitness ----------------------------- */
// The prior: which specialists are even PLAUSIBLE for a file, before we look at history.
function candidateAgentsFor(files = []) {
  const f = files.join(' ');
  if (/\.md$|(^|\s)docs\//.test(f)) return ['docs'];
  if (/\.tf$|\.tfvars$|docker|compose|\.github\//i.test(f)) return ['infra'];
  if (/tests?\//.test(f) || /\.(test|spec)\./.test(f)) return ['tests'];
  if (/(^|\s)services\//.test(f)) return ['services', 'resilience', 'security', 'performance', 'quality', 'refactor'];
  if (/(^|\s)frontend\//.test(f)) return ['frontend', 'ux', 'performance', 'refactor', 'quality'];
  // backend / everything else
  return ['quality', 'security', 'performance', 'resilience', 'tests', 'refactor', 'compliance'];
}

export function inferArea(files = []) {
  const f = files.join(' ');
  if (/services\//.test(f)) return 'services';
  if (/frontend\//.test(f)) return 'frontend';
  if (/backend\//.test(f)) return 'backend';
  return 'backend';
}

/* --------------------------- learned competence --------------------------- */

/** Raw (agent, area) outcome counts from history, joined to whether the iteration landed. */
function outcomeRows() {
  try {
    return db
      .prepare(
        `SELECT t.agent AS agent, COALESCE(t.area,'backend') AS area,
                COUNT(*) AS attempts,
                SUM(CASE WHEN t.status='done' AND i.status IN ('committed','promoted') THEN 1 ELSE 0 END) AS landed,
                SUM(CASE WHEN t.status='failed' OR i.status IN ('rolled_back','empty') THEN 1 ELSE 0 END) AS failed
         FROM tasks t JOIN iterations i ON i.id = t.iteration_id
         WHERE t.agent IS NOT NULL
         GROUP BY t.agent, area`,
      )
      .all();
  } catch {
    return [];
  }
}

// Laplace-smoothed land rate: (landed + a) / (attempts + a + b). New pairs sit near a
// neutral prior so the network doesn't over-commit on one lucky (or unlucky) sample.
const A = 1;
const B = 2;
const smoothRate = (landed, attempts) => (landed + A) / (attempts + A + B);

/**
 * The competence matrix: for each (agent, area), the learned land rate and its evidence.
 * Consumed by routing, prioritisation, the managers and the dashboard.
 */
export function competenceMatrix() {
  const byPair = new Map(); // `${agent}:${area}` -> {attempts,landed,failed}
  const byAgent = new Map();
  const byArea = new Map();
  for (const r of outcomeRows()) {
    byPair.set(`${r.agent}:${r.area}`, { attempts: r.attempts, landed: r.landed, failed: r.failed });
    const a = byAgent.get(r.agent) || { attempts: 0, landed: 0, failed: 0 };
    a.attempts += r.attempts; a.landed += r.landed; a.failed += r.failed;
    byAgent.set(r.agent, a);
    const ar = byArea.get(r.area) || { attempts: 0, landed: 0, failed: 0 };
    ar.attempts += r.attempts; ar.landed += r.landed; ar.failed += r.failed;
    byArea.set(r.area, ar);
  }
  return { byPair, byAgent, byArea };
}

/** Learned land rate for one (agent, area), backing off to the agent's overall rate, then neutral. */
function landRate(m, agent, area) {
  const pair = m.byPair.get(`${agent}:${area}`);
  if (pair && pair.attempts >= 2) return { rate: smoothRate(pair.landed, pair.attempts), n: pair.attempts, level: 'area' };
  const ag = m.byAgent.get(agent);
  if (ag && ag.attempts >= 3) return { rate: smoothRate(ag.landed, ag.attempts), n: ag.attempts, level: 'agent' };
  return { rate: 0.5, n: (pair?.attempts || 0) + (ag?.attempts || 0), level: 'prior' };
}

/* -------------------------------- routing --------------------------------- */

/**
 * Choose the specialist most likely to LAND this change. Blends the static prior (is this
 * agent even plausible for these files?) with the learned land rate in this area. The
 * planner may pass the agent the LLM suggested as a hint; a strong track record can still
 * override a weak suggestion, and a proven-bad pairing is avoided.
 */
export function chooseAgent({ files = [], kind = 'improvement', hint = null } = {}) {
  const m = competenceMatrix();
  const area = inferArea(files);
  const plausible = candidateAgentsFor(files);
  // The LLM's hint is considered, but only if it's plausible for these files.
  const pool = [...new Set([...(hint && plausible.includes(hint) ? [hint] : []), ...plausible])];

  const scored = pool.map((agent) => {
    const lr = landRate(m, agent, area);
    // Static prior: first plausible agent is the canonical owner (weight it a bit).
    const staticFit = agent === plausible[0] ? 1 : 0.55;
    const hintBonus = agent === hint ? 0.1 : 0;
    const score = 0.45 * staticFit + 0.55 * lr.rate + hintBonus;
    return { agent, score, rate: lr.rate, n: lr.n, level: lr.level };
  });
  scored.sort((a, b) => b.score - a.score);
  const best = scored[0] || { agent: plausible[0] || 'quality' };
  return {
    agent: best.agent,
    area,
    why: `land-rate ${(best.rate * 100 | 0)}% in ${area} over ${best.n} attempt(s) [${best.level}]`,
    alternatives: scored.slice(1, 4).map((s) => s.agent),
  };
}

/* ------------------------------ prioritisation ---------------------------- */

/**
 * Expected value of a backlog candidate = how much it matters × how likely the fleet is
 * to actually land it. This pushes high-impact work the fleet can execute to the top and
 * de-prioritises items that keep bouncing (a fantasy the model re-imagines every run).
 */
export function scoreCandidate(candidate, m = competenceMatrix()) {
  const files = candidate.file ? [candidate.file] : [];
  const area = inferArea(files);
  const owner = chooseAgent({ files, kind: candidate.kind });
  const likelihood = landRate(m, owner.agent, area).rate;

  // Impact proxy from the catalog signals the candidate carries.
  const impact = Math.min(1, ((candidate.complexity || 0) / 20) + ((candidate.fanIn || 0) / 30) + (candidate.todos ? 0.1 : 0) + 0.2);
  const failPenalty = Math.max(0, 1 - (candidate.failures || 0) * 0.25); // stop retrying a doomed item
  const ev = impact * likelihood * failPenalty;
  return { ...candidate, area, owner: owner.agent, ev, likelihood };
}

/** Re-rank candidates by expected value, best first. */
export function prioritise(candidates = []) {
  const m = competenceMatrix();
  return candidates
    .map((c) => scoreCandidate(c, m))
    .sort((a, b) => b.ev - a.ev);
}

/* --------------------------- prompt-injected brief ------------------------ */

/**
 * The decision brief an agent gets in its prompt: its own measured track record in this
 * area, and the fleet's proven/avoid notes. Turns "you are the security agent" into "you
 * are the security agent, whose last changes here landed 1 in 8 — be surgical and make
 * sure it survives review".
 */
export function decisionBrief({ agentId, area }) {
  if (!agentId) return '';
  const m = competenceMatrix();
  const pair = m.byPair.get(`${agentId}:${area}`);
  const ag = m.byAgent.get(agentId);
  const lines = [];
  if (pair && pair.attempts >= 2) {
    lines.push(`Your track record in ${area}: ${pair.landed}/${pair.attempts} changes landed, ${pair.failed} failed.`);
    if (pair.landed / pair.attempts < 0.35) lines.push('That land-rate is LOW — the fleet keeps failing here. Make the smallest fully-wired, test-passing change you can; do not over-reach.');
  } else if (ag && ag.attempts >= 3) {
    lines.push(`Your overall record: ${ag.landed}/${ag.attempts} landed.`);
  }
  if (!lines.length) return '';
  return `DECISION NETWORK (learned from real outcomes):\n${lines.join('\n')}`;
}

/* ------------------------------- snapshot --------------------------------- */

/** The whole learned network, shaped for the dashboard and for managers. */
export function networkSnapshot() {
  const m = competenceMatrix();
  const areas = [...m.byArea.keys()].sort();
  const cells = [];
  for (const [key, v] of m.byPair) {
    const [agent, area] = key.split(':');
    cells.push({ agent, area, attempts: v.attempts, landed: v.landed, failed: v.failed, landRate: v.attempts ? +(v.landed / v.attempts).toFixed(2) : null });
  }
  const agents = AGENTS.map((agent) => {
    const a = m.byAgent.get(agent) || { attempts: 0, landed: 0, failed: 0 };
    return { agent, attempts: a.attempts, landed: a.landed, failed: a.failed, landRate: a.attempts ? +(a.landed / a.attempts).toFixed(2) : null };
  }).sort((x, y) => (y.landRate ?? -1) - (x.landRate ?? -1));

  // The standout facts a human (or a manager) should act on.
  const strong = cells.filter((c) => c.attempts >= 3 && c.landRate >= 0.6).sort((a, b) => b.landRate - a.landRate).slice(0, 5);
  const weak = cells.filter((c) => c.attempts >= 4 && c.landRate <= 0.2).sort((a, b) => a.landRate - b.landRate).slice(0, 5);
  return { agents, areas, cells, strong, weak };
}

/** A compact insight string for managers to surface in their briefs. */
export function networkInsight() {
  const s = networkSnapshot();
  const parts = [];
  if (s.strong[0]) parts.push(`Strongest: ${s.strong[0].agent} in ${s.strong[0].area} (${Math.round(s.strong[0].landRate * 100)}% land).`);
  if (s.weak[0]) parts.push(`Weakest: ${s.weak[0].agent} in ${s.weak[0].area} (${Math.round(s.weak[0].landRate * 100)}% land) — reroute or retrain.`);
  return parts.join(' ');
}

export { AGENTS };
