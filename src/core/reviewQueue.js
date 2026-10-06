import { db, registerSchema } from '../db.js';
import { notifyOnce } from '../db_iteration.js';
import { agentTrust } from './trust.js';
import { getChangeBudget } from '../iteration/changeBudget.js';
import { remember } from '../memory/memoryDb.js';
import { autonomyMode } from './autonomy.js';
import { sodCheck } from '../platform/rbac.js';
import { audit } from '../platform/platformDb.js';
import { applyPolicy, getPolicy } from './policy.js';
import { contractVerdict } from '../iteration/contractDiff.js';

/** Thrown when an approval would violate segregation of duties. */
export class SodViolation extends Error {
  constructor(reason) {
    super(reason);
    this.name = 'SodViolation';
    this.reason = reason;
  }
}

/**
 * HUMAN REVIEW QUEUE (ISL_IMPROVE "New high-value functions", P0).
 *
 * A batched approval surface. Every landed change is classified by RISK (its blast radius,
 * whether it touches a sensitive area, and its size) against the acting agent's earned TRUST:
 *   - low-risk work by a trusted agent → auto-approved (recorded, no human needed)
 *   - risky work, or any work by a probationary agent → held as PENDING for a human to approve/reject
 *
 * By design this is ADVISORY on the commit itself — the autonomous loop must never stall waiting for
 * a human (a hard project rule), so the change still lands on the work branch and the queue governs
 * whether a human has *blessed* it (the gate that matters for promotion/trust). A rejection is a
 * strong human signal: it's surfaced, and it feeds back as a pitfall the fleet learns from.
 */

registerSchema(() => {
  db.exec(`
  CREATE TABLE IF NOT EXISTS review_queue (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    iteration_id  INTEGER,
    agent         TEXT,
    area          TEXT,
    title         TEXT,
    commit_sha    TEXT,
    risk          TEXT NOT NULL,
    sensitive     INTEGER NOT NULL DEFAULT 0,
    files_changed INTEGER NOT NULL DEFAULT 0,
    additions     INTEGER NOT NULL DEFAULT 0,
    deletions     INTEGER NOT NULL DEFAULT 0,
    trust_level   TEXT,
    land_rate     INTEGER,
    decision      TEXT NOT NULL,
    reasons       TEXT,
    status        TEXT NOT NULL,
    created_at    INTEGER NOT NULL,
    decided_at    INTEGER,
    decided_by    TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_review_status ON review_queue(status, id DESC);
  `);
  // Segregation of duties needs to know who ORIGINATED the change, not just which agent wrote it.
  // Added by migration so existing queues keep working; NULL means "the autonomous loop", which is
  // the honest reading for every item created before this column existed.
  try { db.exec('ALTER TABLE review_queue ADD COLUMN authored_by TEXT'); } catch { /* already migrated */ }
  // Which policy rules held this change, and the policy version that was in force. Without this the
  // evidence pack could say a human approved it but not WHICH organisational rule required them to.
  try { db.exec('ALTER TABLE review_queue ADD COLUMN policy_json TEXT'); } catch { /* already migrated */ }
});

/**
 * Decide whether a landed change needs a human, given its risk and the acting agent's trust.
 * @returns {{ decision:'auto'|'review', risk:'low'|'medium'|'high', reasons:string[] }}
 */
export function classifyChange({ agent, blast = null, filesChanged = 0, additions = 0, deletions = 0, files = [], area = null, contract = null, declaredBreaking = false } = {}) {
  const trust = agentTrust(agent || 'implementer');
  const blastRisk = blast?.risk || 'low';
  const sensitive = !!blast?.sensitive;
  // "Big" uses the same operator-configurable soft budget the engine enforces (single source).
  const budget = getChangeBudget();
  const big = filesChanged > budget.softFiles || additions > budget.softAdditions;

  const reasons = [];
  if (sensitive) reasons.push('touches a sensitive area (auth / payment / migration)');
  if (blastRisk === 'high') reasons.push(`high blast radius (${blast?.dependentCount ?? '?'} dependents)`);
  else if (blastRisk === 'medium') reasons.push('moderate blast radius');
  if (big) reasons.push(`large diff (${filesChanged} files, +${additions})`);
  if (trust.level === 'probation') reasons.push(`agent on probation (${trust.landRate}% land rate over ${trust.attempts})`);

  // A proven/trusted agent earns latitude: it can auto-land medium risk (proven) or low risk
  // (trusted). Sensitive changes and high blast radius always want a human, regardless of trust.
  let needsReview;
  if (sensitive || blastRisk === 'high') needsReview = true;
  else if (trust.level === 'proven') needsReview = false; // may auto-land up to medium risk + big
  else if (trust.level === 'trusted') needsReview = blastRisk === 'medium' || big;
  else needsReview = true; // probation → always review

  // HEALTH-GATED AUTONOMY: when the codebase health is trending down, revoke all auto-land latitude —
  // every change waits for a human until health recovers.
  const autonomy = autonomyMode();
  if (autonomy.mode === 'stabilize' && !needsReview) {
    needsReview = true;
    reasons.push('stabilise mode: codebase health is dropping — auto-land suspended');
  }

  // PUBLIC-CONTRACT GATE: a change that removes a route, an export or a database column breaks
  // consumers OUTSIDE this repo, which no test here can observe. An undeclared breaking change
  // always wants a human, whatever the agent has earned; a declared one is surfaced, not blocked.
  const contractVerdictResult = contract ? contractVerdict(contract, { declaredBreaking }) : null;
  if (contractVerdictResult?.reasons?.length) reasons.push(...contractVerdictResult.reasons);
  if (contractVerdictResult?.needsReview) needsReview = true;

  const contractBreaking = contract?.counts?.breaking > 0;
  const risk = sensitive || blastRisk === 'high' || (contractBreaking && !declaredBreaking)
    ? 'high'
    : blastRisk === 'medium' || big || contract?.counts?.behavioural > 0 ? 'medium' : 'low';
  const decision = needsReview ? 'review' : 'auto';
  if (!needsReview && !reasons.length) reasons.push(`low-risk change by a ${trust.level} agent`);

  // ORGANISATIONAL POLICY, layered on top. It can only TIGHTEN — a rule may force a human review or
  // bar promotion, but nothing in a policy document can grant latitude the logic above withheld.
  // A gap in a config file must never become a gap in the guardrails.
  return applyPolicy(
    { decision, risk, reasons, trust },
    { risk, sensitive, files, area, agent: agent || 'implementer', agentTrust: trust.level, filesChanged, additions },
  );
}

/** Record a landed change in the queue (pending if it needs a human, else auto-approved). */
export function enqueueReview({ iterationId, agent, area, title, commitSha, blast, filesChanged = 0, additions = 0, deletions = 0, files = [], authoredBy = null } = {}) {
  const cls = classifyChange({ agent, blast, filesChanged, additions, deletions, files, area });
  const { decision, risk, reasons, trust } = cls;
  const status = decision === 'review' ? 'pending' : 'auto';
  const policyRecord = cls.policy?.matched?.length
    ? { version: getPolicy().version, outcome: cls.policy.outcome, blocked: !!cls.policyBlocked, approvals: cls.requiredApprovals || 1, matched: cls.policy.matched }
    : null;
  const info = db
    .prepare(
      `INSERT INTO review_queue
       (iteration_id, agent, area, title, commit_sha, risk, sensitive, files_changed, additions, deletions,
        trust_level, land_rate, decision, reasons, status, created_at, authored_by, policy_json)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    )
    .run(
      iterationId ?? null, agent ?? null, area ?? null, (title || '').slice(0, 200), commitSha ?? null,
      risk, blast?.sensitive ? 1 : 0, filesChanged, additions, deletions,
      trust.level, trust.landRate, decision, JSON.stringify(reasons), status, Date.now(),
      // Null = the autonomous loop originated it, so no human can be self-approving.
      authoredBy ? String(authoredBy).slice(0, 120) : null,
      policyRecord ? JSON.stringify(policyRecord) : null,
    );
  return { id: info.lastInsertRowid, decision, risk, status, reasons, policy: policyRecord };
}

function rowToItem(r) {
  return {
    id: r.id,
    iterationId: r.iteration_id,
    agent: r.agent,
    area: r.area,
    title: r.title,
    commitSha: r.commit_sha,
    risk: r.risk,
    sensitive: !!r.sensitive,
    filesChanged: r.files_changed,
    additions: r.additions,
    deletions: r.deletions,
    trustLevel: r.trust_level,
    landRate: r.land_rate,
    decision: r.decision,
    reasons: JSON.parse(r.reasons || '[]'),
    status: r.status,
    createdAt: r.created_at,
    decidedAt: r.decided_at,
    decidedBy: r.decided_by,
    // Null = originated by the autonomous loop. Shown in the UI so a reviewer knows up front
    // whether they are eligible to decide, instead of finding out when the control refuses them.
    authoredBy: r.authored_by ?? null,
    // Which organisational rules held this change, and under which policy version.
    policy: r.policy_json ? JSON.parse(r.policy_json) : null,
  };
}

/** List queue items, optionally filtered by status ('pending' | 'approved' | 'rejected' | 'auto'). */
export function listReviewQueue({ status = null, limit = 100 } = {}) {
  const rows = status
    ? db.prepare('SELECT * FROM review_queue WHERE status = ? ORDER BY id DESC LIMIT ?').all(status, limit)
    : db.prepare('SELECT * FROM review_queue ORDER BY id DESC LIMIT ?').all(limit);
  return rows.map(rowToItem);
}

/**
 * Approve or reject a pending item.
 *
 * SEGREGATION OF DUTIES is enforced here rather than at the route, because this is the only place
 * every path to a decision passes through — a future caller that forgets the check cannot exist.
 * The refusal is thrown, not returned as a soft failure: a self-approval that "didn't work" but
 * returned normally would look like a bug and get retried, when it is a control firing.
 *
 * @throws {SodViolation} when the approver authored the change
 * @returns {object|null} the updated item, or null if it was not found or no longer pending
 */
export function decideReview(id, verdict, by = 'operator') {
  const pending = db.prepare("SELECT * FROM review_queue WHERE id = ? AND status = 'pending'").get(id);
  if (!pending) return null;

  const sod = sodCheck({ authoredBy: pending.authored_by, decidedBy: by });
  if (!sod.allowed) {
    // A refused approval is exactly the event an investigation needs — record it, then refuse.
    audit('review.self_approval_denied', {
      actor: String(by),
      target: String(id),
      detail: { reason: sod.reason, authoredBy: pending.authored_by, verdict, commit: pending.commit_sha },
    });
    // Also surfaced to a human: a refused approval attempt is the kind of event that must not live
    // only in a log nobody reads.
    notifyOnce({
      kind: 'governance',
      severity: 'warn',
      title: `Self-approval refused for "${(pending.title || '').slice(0, 60)}"`,
      body: `${by} authored this change and cannot ${verdict} it. Another eligible reviewer must decide.`,
      link: 'review',
    });
    throw new SodViolation(sod.reason);
  }

  const status = verdict === 'approve' ? 'approved' : 'rejected';
  const changed = db
    .prepare(`UPDATE review_queue SET status = ?, decided_at = ?, decided_by = ? WHERE id = ? AND status = 'pending'`)
    .run(status, Date.now(), String(by).slice(0, 80), id).changes;
  if (!changed) return null;

  audit(`review.${status}`, { actor: String(by), target: String(id), detail: { commit: pending.commit_sha, risk: pending.risk } });
  const item = rowToItem(db.prepare('SELECT * FROM review_queue WHERE id = ?').get(id));

  // REJECTION-DRIVEN LEARNING: a human "no" is the strongest signal ISL gets. Turn it into a
  // durable, agent-scoped pitfall so the fleet stops repeating the shape of change that got
  // rejected. (An approval needs no memory — it's the expected, silent outcome.) The rejection
  // also counts against the agent's trust, handled in trust.js.
  if (verdict === 'reject') {
    try {
      remember({
        scope: `agent:${item.agent || 'implementer'}`,
        kind: 'pitfall',
        title: `Human rejected: ${item.title}`.slice(0, 110),
        content:
          `A human REJECTED this change (${item.risk} risk${item.reasons?.length ? `; ${item.reasons.join('; ')}` : ''}). ` +
          `Avoid this shape of change${item.area ? ` in ${item.area}` : ''}, or make it smaller/safer and wire it in properly.`,
        source: 'review:rejected',
      });
    } catch { /* memory best-effort */ }
  }
  return item;
}

/** Summary counts for the dashboard. */
export function reviewStats() {
  const rows = db.prepare('SELECT status, COUNT(*) n FROM review_queue GROUP BY status').all();
  const by = { pending: 0, approved: 0, rejected: 0, auto: 0 };
  for (const r of rows) by[r.status] = r.n;
  return { ...by, total: Object.values(by).reduce((a, b) => a + b, 0) };
}
