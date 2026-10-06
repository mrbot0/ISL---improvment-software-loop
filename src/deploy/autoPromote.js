import { db, getSetting, setSetting } from '../db.js';
import { git } from '../sandbox/worktree.js';
import { WORK_BRANCH, BASE_BRANCH } from '../config.js';
import { agentTrust } from '../core/trust.js';
import { autonomyMode } from '../core/autonomy.js';
import { deployStatus, promoteToMain } from '../iteration/promote.js';
import { log } from '../logger.js';

/**
 * TRUST-GATED AUTO-PROMOTION (ISL_IMPROVE "Next wave", P2).
 *
 * The review queue's approvals only bless a change on the WORK branch — shipping it still needs a
 * manual promote. This closes that last step for the changes that have genuinely earned it: a
 * commit may auto-promote only if EVERY gate agrees it is safe.
 *
 * A commit is PROMOTABLE when:
 *   1. a human explicitly APPROVED it in the review queue, or it auto-approved under a `proven`-trust
 *      agent (never a `probation` one, never anything a human rejected or left pending);
 *   2. its recorded risk is low (or medium for an explicitly human-approved change);
 *   3. autonomy is not in stabilise mode (health trending down suspends everything).
 *
 * Because promotion is a fast-forward, only a CONTIGUOUS PREFIX of the work branch can move: we walk
 * base→tip and stop at the first commit that isn't promotable. That is deliberate — it can never
 * "skip over" an unapproved change to ship a later one.
 *
 * OFF BY DEFAULT. `plan()` is a pure dry-run (no writes) so the operator can see exactly what would
 * ship and why before enabling anything.
 */

const lg = log.for('auto-promote');

export function isAutoPromoteEnabled() {
  return !!getSetting('autoPromoteEnabled', false);
}
export function setAutoPromoteEnabled(on) {
  const v = !!on;
  setSetting('autoPromoteEnabled', v);
  return v;
}

/** Commits ahead of the base on the work branch, OLDEST first (fast-forward order). */
function commitsAhead() {
  try {
    const out = git(['log', `${BASE_BRANCH}..${WORK_BRANCH}`, '--reverse', '--format=%H\x1f%s']);
    if (!out) return [];
    return out.split('\n').filter(Boolean).map((line) => {
      const [sha, subject] = line.split('\x1f');
      return { sha, shortSha: sha.slice(0, 8), title: subject || '' };
    });
  } catch {
    return [];
  }
}

/** The review-queue record for a commit, if any. */
function reviewFor(sha) {
  try {
    const r = db.prepare('SELECT agent, risk, status, decided_by FROM review_queue WHERE commit_sha = ? ORDER BY id DESC LIMIT 1').get(sha);
    return r || null;
  } catch {
    return null;
  }
}

/** Decide whether one commit may auto-promote. @returns {{ok:boolean, reason:string}} */
function judge(sha) {
  const r = reviewFor(sha);
  if (!r) return { ok: false, reason: 'no review record — never classified' };
  if (r.status === 'rejected') return { ok: false, reason: 'a human rejected this change' };
  if (r.status === 'pending') return { ok: false, reason: 'still awaiting human review' };

  const trust = agentTrust(r.agent || 'implementer');
  if (r.status === 'approved') {
    // A human said yes — allow low and medium risk (high risk still wants a deliberate promote).
    if (r.risk === 'high') return { ok: false, reason: 'human-approved but high risk — promote manually' };
    return { ok: true, reason: `human-approved (${r.risk} risk) by ${r.decided_by || 'operator'}` };
  }
  // status 'auto': it never needed a human. Require a PROVEN agent and low risk.
  if (trust.level !== 'proven') return { ok: false, reason: `auto-approved but agent '${r.agent}' is ${trust.level}, not proven` };
  if (r.risk !== 'low') return { ok: false, reason: `auto-approved but ${r.risk} risk` };
  return { ok: true, reason: `low-risk auto-approved change by a proven agent (${r.agent})` };
}

/**
 * Dry-run: what would auto-promote right now, and why it stops where it stops. No writes.
 * @returns {{ enabled, ahead, promotable, blockedBy, upTo, autonomy, commits }}
 */
export function plan() {
  const autonomy = autonomyMode();
  const ahead = commitsAhead();
  const commits = [];
  let upTo = null;
  let blockedBy = null;

  for (const c of ahead) {
    const verdict = judge(c.sha);
    commits.push({ ...c, ...verdict });
    if (verdict.ok && !blockedBy) upTo = c.sha; // extend the promotable prefix
    else if (!blockedBy) blockedBy = { sha: c.shortSha, title: c.title, reason: verdict.reason };
  }

  // Stabilise mode overrides everything — health trending down means nothing ships automatically.
  if (autonomy.mode === 'stabilize') {
    upTo = null;
    blockedBy = blockedBy || { reason: autonomy.reason };
  }

  const promotable = upTo ? commits.filter((c) => c.ok).length : 0;
  return {
    enabled: isAutoPromoteEnabled(),
    ahead: ahead.length,
    promotable,
    upTo,
    upToShort: upTo ? upTo.slice(0, 8) : null,
    blockedBy,
    autonomy: { mode: autonomy.mode, health: autonomy.health },
    commits: commits.slice(0, 25),
  };
}

/**
 * Promote the earned prefix, if auto-promotion is enabled and anything qualifies.
 * Safe by construction: it delegates to `promoteToMain`, which refuses a non-fast-forward, a dirty
 * tree, or a checkout that isn't on the base branch.
 */
export function runAutoPromote({ force = false } = {}) {
  if (!force && !isAutoPromoteEnabled()) return { promoted: false, reason: 'auto-promotion is disabled' };
  const p = plan();
  if (!p.upTo) return { promoted: false, reason: p.blockedBy?.reason || 'nothing has earned promotion', plan: p };
  try {
    const r = promoteToMain(p.upTo);
    lg.info(`auto-promoted ${p.promotable} commit(s) up to ${p.upToShort}`);
    return { promoted: true, upTo: p.upToShort, count: p.promotable, result: r };
  } catch (e) {
    // A refusal here is the safety net doing its job (not on base branch, diverged, dirty…).
    lg.warn(`auto-promote refused: ${e.message}`);
    return { promoted: false, reason: e.message, plan: p };
  }
}

/** Convenience for the dashboard: the current promote picture. */
export function autoPromoteStatus() {
  let deploy = null;
  try { deploy = deployStatus(); } catch { /* repo not ready */ }
  return { ...plan(), deploy };
}
