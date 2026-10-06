import crypto from 'node:crypto';
import { pdb, audit } from './platformDb.js';
import { authCfg } from '../config.js';

const now = () => Date.now();
const id = () => crypto.randomBytes(9).toString('hex');

/* ------------------------------ password hash ----------------------------- */
// scrypt via node:crypto — no external dependency. Format: salt:hash (both hex).

export function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(String(password), salt, 64);
  return `${salt.toString('hex')}:${hash.toString('hex')}`;
}

export function verifyPassword(password, stored) {
  if (!stored || !stored.includes(':')) return false;
  const [saltHex, hashHex] = stored.split(':');
  const salt = Buffer.from(saltHex, 'hex');
  const expected = Buffer.from(hashHex, 'hex');
  const actual = crypto.scryptSync(String(password), salt, expected.length);
  return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
}

/* --------------------------------- users ---------------------------------- */

const rowToUser = (r) =>
  r && {
    id: r.id,
    email: r.email,
    name: r.name,
    role: r.role,
    status: r.status,
    hasPassword: !!r.pass_hash,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    lastLogin: r.last_login,
  };

export const listUsers = () => pdb.prepare('SELECT * FROM users ORDER BY created_at').all().map(rowToUser);
export const getUser = (uid) => rowToUser(pdb.prepare('SELECT * FROM users WHERE id = ?').get(uid));
export const getUserByEmail = (email) =>
  rowToUser(pdb.prepare('SELECT * FROM users WHERE email = ?').get(String(email || '').toLowerCase()));

const rawByEmail = (email) => pdb.prepare('SELECT * FROM users WHERE email = ?').get(String(email || '').toLowerCase());
const rawById = (uid) => pdb.prepare('SELECT * FROM users WHERE id = ?').get(uid);

export function createUser({ email, name = '', role = 'user', password = null, status, createdBy = 'system' }) {
  const em = String(email || '').trim().toLowerCase();
  if (!em || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(em)) throw new Error('A valid email is required');
  if (getUserByEmail(em)) throw new Error('A user with that email already exists');
  const uid = id();
  const passHash = password ? hashPassword(password) : null;
  const st = status || (passHash ? 'active' : 'pending');
  pdb.prepare(
    `INSERT INTO users (id, email, name, role, status, pass_hash, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(uid, em, name || '', role, st, passHash, now(), now());
  audit('user.created', { actor: createdBy, target: em, detail: { role, status: st } });
  return getUser(uid);
}

export function updateUser(uid, patch = {}, actor = 'system') {
  const cur = getUser(uid);
  if (!cur) throw new Error('Unknown user');
  const next = {
    name: patch.name ?? cur.name,
    role: patch.role ?? cur.role,
    status: patch.status ?? cur.status,
  };
  pdb.prepare('UPDATE users SET name = ?, role = ?, status = ?, updated_at = ? WHERE id = ?').run(
    next.name,
    next.role,
    next.status,
    now(),
    uid,
  );
  if (patch.password) setPassword(uid, patch.password);
  audit('user.updated', { actor, target: cur.email, detail: patch.password ? { ...patch, password: '***' } : patch });
  return getUser(uid);
}

export function setPassword(uid, password) {
  const hash = hashPassword(password);
  pdb.prepare('UPDATE users SET pass_hash = ?, status = ?, updated_at = ? WHERE id = ?').run(hash, 'active', now(), uid);
  return getUser(uid);
}

export function deleteUser(uid, actor = 'system') {
  const cur = getUser(uid);
  if (!cur) return false;
  pdb.prepare('DELETE FROM users WHERE id = ?').run(uid); // cascades sessions
  audit('user.deleted', { actor, target: cur.email });
  return true;
}

/**
 * Seed the bootstrap admin from config. Created "pending" (no password) so the
 * first person to log in with that email sets the password and claims it.
 */
export function seedAdmin() {
  const email = authCfg.seedAdminEmail;
  if (!getUserByEmail(email)) {
    createUser({ email, name: 'Administrator', role: 'admin', status: 'pending', createdBy: 'system' });
    return { seeded: email };
  }
  return { seeded: null };
}

/* -------------------------- authentication flow --------------------------- */

/**
 * Authenticate. A `pending` account (the seeded admin, or any admin-invited
 * user) has no password yet: the first login *claims* the account by setting
 * the supplied password. An `active` account verifies normally.
 *
 * @returns {{ok:boolean, claimed?:boolean, user?:object, error?:string}}
 */
export function authenticate(email, password) {
  const raw = rawByEmail(email);
  if (!raw) return { ok: false, error: 'Invalid email or password' };
  if (raw.status === 'disabled') return { ok: false, error: 'This account is disabled' };
  if (!password || String(password).length < 8) return { ok: false, error: 'Password must be at least 8 characters' };

  if (raw.status === 'pending' || !raw.pass_hash) {
    setPassword(raw.id, password); // claim
    audit('user.claimed', { actor: raw.email, target: raw.email });
    return { ok: true, claimed: true, user: getUser(raw.id) };
  }
  if (!verifyPassword(password, raw.pass_hash)) return { ok: false, error: 'Invalid email or password' };
  pdb.prepare('UPDATE users SET last_login = ? WHERE id = ?').run(now(), raw.id);
  audit('user.login', { actor: raw.email, target: raw.email });
  return { ok: true, user: getUser(raw.id) };
}

/** Let a signed-in user change their own password (requires current one). */
export function changePassword(uid, currentPassword, newPassword) {
  const raw = rawById(uid);
  if (!raw) throw new Error('Unknown user');
  if (raw.pass_hash && !verifyPassword(currentPassword, raw.pass_hash)) throw new Error('Current password is incorrect');
  if (!newPassword || String(newPassword).length < 8) throw new Error('New password must be at least 8 characters');
  setPassword(uid, newPassword);
  return { ok: true };
}

/* -------------------------------- sessions -------------------------------- */

export function createSession(uid, { ip = null, agent = null } = {}) {
  const token = crypto.randomBytes(32).toString('hex');
  pdb.prepare('INSERT INTO sessions (token, user_id, created_at, expires_at, ip, agent) VALUES (?, ?, ?, ?, ?, ?)').run(
    token,
    uid,
    now(),
    now() + authCfg.sessionTtlMs,
    ip,
    agent,
  );
  return token;
}

/** Resolve a session token to its live user, or null. Expired tokens are reaped. */
export function resolveSession(token) {
  if (!token) return null;
  const s = pdb.prepare('SELECT * FROM sessions WHERE token = ?').get(token);
  if (!s) return null;
  if (s.expires_at < now()) {
    pdb.prepare('DELETE FROM sessions WHERE token = ?').run(token);
    return null;
  }
  const user = getUser(s.user_id);
  if (!user || user.status === 'disabled') return null;
  return user;
}

export function destroySession(token) {
  if (token) pdb.prepare('DELETE FROM sessions WHERE token = ?').run(token);
}

export function destroyUserSessions(uid) {
  pdb.prepare('DELETE FROM sessions WHERE user_id = ?').run(uid);
}

export function reapSessions() {
  return Number(pdb.prepare('DELETE FROM sessions WHERE expires_at < ?').run(now()).changes);
}

/** Active sessions for the admin panel — safe fields only, never the raw token. */
export function listSessions() {
  return pdb
    .prepare(
      `SELECT s.user_id, s.created_at, s.expires_at, s.ip, s.agent, u.email, u.role
       FROM sessions s JOIN users u ON u.id = s.user_id
       WHERE s.expires_at > ? ORDER BY s.created_at DESC`,
    )
    .all(now())
    .map((r) => ({
      userId: r.user_id,
      email: r.email,
      role: r.role,
      createdAt: r.created_at,
      expiresAt: r.expires_at,
      ip: r.ip,
      agent: (r.agent || '').slice(0, 80),
    }));
}

export const countActiveSessions = () => pdb.prepare('SELECT COUNT(*) n FROM sessions WHERE expires_at > ?').get(now()).n;
