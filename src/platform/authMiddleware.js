import { resolveSession } from './users.js';

export const SESSION_COOKIE = 'isl_session';

/** Parse a Cookie header into a plain object (no external dependency). */
export function parseCookies(header = '') {
  const out = {};
  for (const part of String(header || '').split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    const k = part.slice(0, i).trim();
    const v = part.slice(i + 1).trim();
    if (k) out[k] = decodeURIComponent(v);
  }
  return out;
}

export function setSessionCookie(res, token, maxAgeMs) {
  const attrs = [
    `${SESSION_COOKIE}=${token}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${Math.floor(maxAgeMs / 1000)}`,
  ];
  res.setHeader('Set-Cookie', attrs.join('; '));
}

export function clearSessionCookie(res) {
  res.setHeader('Set-Cookie', `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`);
}

/** Attach req.user (or null) from the session cookie. Never blocks. */
export function attachUser(req, _res, next) {
  const token = parseCookies(req.headers.cookie)[SESSION_COOKIE];
  req.sessionToken = token || null;
  req.user = token ? resolveSession(token) : null;
  next();
}

export function requireAuth(req, res, next) {
  if (!req.user) return res.status(401).json({ error: 'Not authenticated' });
  next();
}

export function requireAdmin(req, res, next) {
  if (!req.user) return res.status(401).json({ error: 'Not authenticated' });
  if (req.user.role !== 'admin') return res.status(403).json({ error: 'Administrator access required' });
  next();
}

/** Resolve the user behind a raw Cookie header — used to gate the WebSocket. */
export function userFromCookieHeader(header) {
  const token = parseCookies(header)[SESSION_COOKIE];
  return token ? resolveSession(token) : null;
}
