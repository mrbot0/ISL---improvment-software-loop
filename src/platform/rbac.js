import { pdb, audit } from './platformDb.js';
import { checkpointDDL } from './hashChain.js';

/**
 * ROLE-BASED ACCESS CONTROL + SEGREGATION OF DUTIES (ISL_IMPROVE "Enterprise wave", P0).
 *
 * Before this, ISL had two roles — `admin` and everyone else — and, more seriously, **nothing
 * prevented the same identity from proposing a change and then approving it**. The review queue's
 * trust model assumed good faith, which is precisely the assumption an auditor rejects: a control
 * that the controlled party can satisfy alone is not a control.
 *
 * Two mechanisms, deliberately separate:
 *
 *   - **Capabilities per role**, scoped per project. A role is not a label on a person; it is a set
 *     of capabilities checked at the point of action. `auditor` exists specifically to let a reviewer
 *     read the audit trail and evidence packs while being blind to source and diffs — an outside
 *     auditor should not need read access to the customer's code to verify the controls.
 *   - **Segregation of duties**, which is NOT a capability. Having `review.decide` says you may
 *     approve changes; it never says you may approve *this* change. Authorship is compared at the
 *     moment of the decision, so no combination of roles can be assembled into self-approval.
 *
 * Both denials are audited. A refused approval attempt is exactly the event an investigation needs.
 */

pdb.exec(`
-- Per-project role grants. A user's platform role (admin/user/viewer) still governs the platform
-- itself; this is who may do what INSIDE a given project.
CREATE TABLE IF NOT EXISTS project_roles (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id TEXT NOT NULL,
  user_id    TEXT NOT NULL,
  role       TEXT NOT NULL,
  granted_at INTEGER NOT NULL,
  granted_by TEXT,
  UNIQUE(project_id, user_id)
);
CREATE INDEX IF NOT EXISTS idx_project_roles_user ON project_roles(user_id);
`);
pdb.exec(checkpointDDL('audit_checkpoints')); // idempotent; keeps this module loadable standalone

/**
 * Capabilities, most-restrictive first. Deliberately explicit rather than hierarchical: an
 * `auditor` is NOT a weaker `owner`, it is a different shape — more access to the record, none to
 * the code. Modelling that as a level would have silently granted source access.
 */
export const ROLE_CAPS = {
  viewer: ['project.read', 'code.read'],
  operator: ['project.read', 'code.read', 'loop.run', 'backlog.write', 'scope.write'],
  approver: ['project.read', 'code.read', 'loop.run', 'backlog.write', 'scope.write', 'review.decide', 'deploy.promote'],
  owner: ['project.read', 'code.read', 'loop.run', 'backlog.write', 'scope.write', 'review.decide', 'deploy.promote', 'governance.write', 'roles.write'],
  // Sees the controls and the record, never the code. `audit.read` without `code.read`.
  auditor: ['project.read', 'audit.read', 'evidence.read'],
};

export const ROLES = Object.keys(ROLE_CAPS);

/** Everyone can read the audit trail their own role permits; owners and auditors get the full one. */
const IMPLICIT = { owner: ['audit.read', 'evidence.read'], approver: ['audit.read', 'evidence.read'] };

const capsOf = (role) => new Set([...(ROLE_CAPS[role] || []), ...(IMPLICIT[role] || [])]);

/**
 * The role a user holds in a project.
 *
 * A platform `admin` is an `owner` everywhere — an escape hatch a single-operator install depends
 * on, and the reason SoD is enforced separately: being owner must not imply being allowed to
 * approve your own work.
 */
export function roleFor(projectId, user) {
  if (!user) return null;
  if (user.role === 'admin') return 'owner';
  const row = pdb.prepare('SELECT role FROM project_roles WHERE project_id = ? AND user_id = ?').get(String(projectId), user.id);
  if (row?.role && ROLE_CAPS[row.role]) return row.role;
  // No explicit grant: platform `viewer` reads, everyone else operates. Never an approver by
  // default — approval must always be granted deliberately.
  return user.role === 'viewer' ? 'viewer' : 'operator';
}

export function can(projectId, user, capability) {
  const role = roleFor(projectId, user);
  return role ? capsOf(role).has(capability) : false;
}

export function grantRole(projectId, userId, role, actor = 'system') {
  if (!ROLE_CAPS[role]) throw new Error(`unknown role: ${role}`);
  pdb.prepare(
    `INSERT INTO project_roles (project_id, user_id, role, granted_at, granted_by) VALUES (?,?,?,?,?)
     ON CONFLICT(project_id, user_id) DO UPDATE SET role = excluded.role, granted_at = excluded.granted_at, granted_by = excluded.granted_by`,
  ).run(String(projectId), userId, role, Date.now(), actor);
  audit('rbac.granted', { actor, target: userId, detail: { projectId: String(projectId), role } });
  return { projectId: String(projectId), userId, role };
}

export function revokeRole(projectId, userId, actor = 'system') {
  const n = pdb.prepare('DELETE FROM project_roles WHERE project_id = ? AND user_id = ?').run(String(projectId), userId).changes;
  if (n) audit('rbac.revoked', { actor, target: userId, detail: { projectId: String(projectId) } });
  return { removed: Number(n) };
}

export const listProjectRoles = (projectId) =>
  pdb.prepare(
    `SELECT pr.user_id AS userId, pr.role, pr.granted_at AS grantedAt, pr.granted_by AS grantedBy,
            u.email, u.name
     FROM project_roles pr LEFT JOIN users u ON u.id = pr.user_id
     WHERE pr.project_id = ? ORDER BY pr.granted_at DESC`,
  ).all(String(projectId));

/* ------------------------- segregation of duties -------------------------- */

/**
 * May THIS identity decide on THIS change?
 *
 * Separate from capabilities on purpose. `review.decide` says you may approve changes; it never says
 * you may approve *this* one. Authorship is compared here, at the moment of the decision, so no
 * combination of role grants can be assembled into self-approval.
 *
 * A change with no human author (the autonomous loop) has no conflict: the approver is not
 * reviewing their own work, they are reviewing the fleet's.
 *
 * @returns {{allowed:boolean, reason?:string}}
 */
export function sodCheck({ authoredBy, decidedBy }) {
  const author = norm(authoredBy);
  const approver = norm(decidedBy);
  if (!approver) return { allowed: false, reason: 'an approval must be attributable to an identified person' };
  if (!author) return { allowed: true }; // authored by the autonomous loop — no conflict
  if (author === approver) {
    return { allowed: false, reason: 'segregation of duties: the identity that authored this change cannot approve it' };
  }
  return { allowed: true };
}

const norm = (v) => (v == null ? null : String(v).trim().toLowerCase() || null);

/* ---------------------------- step-up auth -------------------------------- */

/**
 * How recently an identity must have proven itself for a high-consequence action. A session that
 * has been open for a week is evidence that someone logged in a week ago, not that the person at
 * the keyboard now is them.
 */
export const STEP_UP_MAX_AGE_MS = 15 * 60_000;

export function needsStepUp(session, maxAgeMs = STEP_UP_MAX_AGE_MS) {
  const at = session?.authenticatedAt ?? session?.createdAt ?? 0;
  return !at || Date.now() - at > maxAgeMs;
}
