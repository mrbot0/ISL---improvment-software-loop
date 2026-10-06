import { competenceMatrix } from './decisionNetwork.js';
import { db } from '../db.js';
import { postDeployBreaches } from '../deploy/dora.js';

/**
 * PER-AGENT TRUST (ISL_IMPROVE "Human review queue with per-agent trust", P0).
 *
 * Not every agent has earned the same latitude. Trust is the honest, learned answer to "how
 * often does THIS agent's work actually survive?" — computed straight from the Decision Network's
 * land history (attempts vs. landed), the same signal that routes work. A proven agent's low-risk
 * changes can auto-land; a probationary agent's work waits for a human. Trust rises and falls with
 * the real track record, so it self-corrects.
 *
 * A HUMAN decision in the review queue is a stronger signal than the automated gates, so rejections
 * count directly against trust: an agent a human keeps rejecting cannot stay `proven`/`trusted`
 * however well its work passes the machine gates (ISL_IMPROVE "Rejection-driven learning").
 *
 * Levels (by smoothed land rate + volume):
 *   - probation : new or shaky (few attempts, or land rate < 45%) — always route to human review
 *   - trusted   : a solid majority of its work lands (≥ 55% over ≥ 5 attempts)
 *   - proven    : reliably lands (≥ 75% over ≥ 10 attempts) — widest auto-land latitude
 */

// Laplace-smoothed land rate so a 1/1 agent isn't treated as flawless.
function smoothRate(landed, attempts) {
  return (landed + 1) / (attempts + 2);
}

function levelFor(rate, attempts) {
  if (attempts >= 10 && rate >= 0.75) return 'proven';
  if (attempts >= 5 && rate >= 0.55) return 'trusted';
  return 'probation';
}

/** Human approve/reject tallies for an agent from the review queue (best-effort). */
function humanDecisions(agentId) {
  try {
    const r = db
      .prepare(
        `SELECT SUM(CASE WHEN status='approved' THEN 1 ELSE 0 END) approved,
                SUM(CASE WHEN status='rejected' THEN 1 ELSE 0 END) rejected
         FROM review_queue WHERE agent = ?`,
      )
      .get(agentId);
    return { approved: r?.approved || 0, rejected: r?.rejected || 0 };
  } catch {
    return { approved: 0, rejected: 0 };
  }
}

/** Trust for one agent, from its land history AND human review decisions. */
export function agentTrust(agentId, m = competenceMatrix()) {
  const a = m.byAgent.get(agentId) || { attempts: 0, landed: 0, failed: 0 };
  const rate = a.attempts ? smoothRate(a.landed, a.attempts) : 0.5;
  let level = levelFor(rate, a.attempts);

  // Fold in the human verdict. A rejection rate a human keeps hitting is a demotion — it can't be
  // outvoted by the machine gates the change already passed.
  const human = humanDecisions(agentId);
  const humanTotal = human.approved + human.rejected;
  const rejectRate = humanTotal ? human.rejected / humanTotal : 0;
  if (rejectRate >= 0.5 && human.rejected >= 2) level = 'probation'; // majority-rejected → no latitude
  else if (rejectRate >= 0.25 && level === 'proven') level = 'trusted'; // notable rejections cap it

  // Then the strongest signal of all: work that passed every gate, SHIPPED, and then broke. Land
  // rate cannot see this — a change that lands and later degrades production still counts as landed
  // — and neither can the review queue, because a human may well have approved it in good faith.
  // A single such breach caps latitude; two put the agent back on probation.
  const breaches = postDeployBreaches(agentId);
  if (breaches >= 2) level = 'probation';
  else if (breaches === 1 && level === 'proven') level = 'trusted';

  return {
    agent: agentId,
    level,
    landRate: Math.round(rate * 100),
    attempts: a.attempts,
    landed: a.landed,
    approved: human.approved,
    rejected: human.rejected,
    postDeployBreaches: breaches,
    // How much latitude this level grants the review policy (0 = none → always review).
    latitude: level === 'proven' ? 2 : level === 'trusted' ? 1 : 0,
  };
}

/** The full trust ledger (every agent seen in history), strongest first — for the dashboard. */
export function trustLedger() {
  const m = competenceMatrix();
  const agents = [...m.byAgent.keys()].map((id) => agentTrust(id, m));
  const rank = { proven: 3, trusted: 2, probation: 1 };
  agents.sort((a, b) => rank[b.level] - rank[a.level] || b.landRate - a.landRate || b.attempts - a.attempts);
  return agents;
}
