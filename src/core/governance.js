import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { db, registerSchema, getSetting, setSetting } from '../db.js';
import { REPO_ROOT, PRODUCT_DIRS } from '../config.js';
import { scanFiles } from '../iteration/structuralScan.js';
import { bus } from '../bus.js';
import { log } from '../logger.js';

/**
 * ENTERPRISE GOVERNANCE — the controls an organisation needs before it lets an autonomous agent
 * near its code. Five capabilities, all deterministic:
 *
 *   1. QUALITY GATES      — per-project thresholds (min score, max risk, required checks) that a
 *                           change must clear. The organisation's bar, not the model's opinion.
 *   2. PROTECTED PATHS    — globs the fleet may never touch autonomously (payments, migrations,
 *                           infra, licences). A hard boundary, independent of any LLM.
 *   3. REPO SECRET SCAN   — the whole working tree, not just the diff: finds credentials that were
 *                           already committed before ISL arrived.
 *   4. LICENCE INVENTORY  — every dependency licence, flagged by policy (copyleft/unknown), so a
 *                           legal review has real data.
 *   5. WEBHOOKS           — outbound notifications so ISL fits an existing ops stack (Slack, CI,
 *                           ticketing) instead of demanding people watch a dashboard.
 */

const lg = log.for('governance');

registerSchema(() => {
  db.exec(`
  CREATE TABLE IF NOT EXISTS webhooks (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    url        TEXT NOT NULL,
    events     TEXT NOT NULL DEFAULT '[]',
    secret     TEXT,
    enabled    INTEGER NOT NULL DEFAULT 1,
    created_at INTEGER NOT NULL,
    last_status TEXT,
    last_at    INTEGER
  );`);
});

/* ───────────────────────────── 1. quality gates ───────────────────────────── */

const DEFAULT_GATES = {
  minScore: 60,          // a change below this never commits
  maxRisk: 'medium',     // highest blast risk allowed to auto-land
  requireTests: false,   // the change must touch or add a test
  requireGreenBuild: true,
  blockOnHighCve: false, // refuse to promote while a critical CVE is open
};

export function getQualityGates() {
  const s = getSetting('qualityGates', null) || {};
  return {
    minScore: Number.isFinite(Number(s.minScore)) ? Number(s.minScore) : DEFAULT_GATES.minScore,
    maxRisk: ['low', 'medium', 'high'].includes(s.maxRisk) ? s.maxRisk : DEFAULT_GATES.maxRisk,
    requireTests: s.requireTests != null ? !!s.requireTests : DEFAULT_GATES.requireTests,
    requireGreenBuild: s.requireGreenBuild != null ? !!s.requireGreenBuild : DEFAULT_GATES.requireGreenBuild,
    blockOnHighCve: s.blockOnHighCve != null ? !!s.blockOnHighCve : DEFAULT_GATES.blockOnHighCve,
  };
}
export function setQualityGates(patch = {}) {
  setSetting('qualityGates', { ...getQualityGates(), ...patch });
  return getQualityGates();
}

/* ──────────────────────────── 2. protected paths ──────────────────────────── */

const DEFAULT_PROTECTED = [
  '**/migrations/**', '**/*.env*', '**/secrets/**', 'LICENSE', 'LICENSE.*', '**/terraform/**',
];

export function getProtectedPaths() {
  const s = getSetting('protectedPaths', null);
  return Array.isArray(s) ? s : DEFAULT_PROTECTED;
}
export function setProtectedPaths(list) {
  const clean = (Array.isArray(list) ? list : []).map((p) => String(p).trim()).filter(Boolean).slice(0, 200);
  setSetting('protectedPaths', clean);
  return clean;
}

/** Turn a glob into a RegExp (supports **, * and ?) — no dependency needed. */
function globToRe(glob) {
  const esc = glob.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  // One pass, so no sentinel character is needed. The previous version used a literal NUL byte to
  // park `**` between passes — functionally fine, but an invisible control character in source that
  // made the whole file read as binary to grep and every other text tool.
  const re = esc.replace(/\*\*|\*|\?/g, (m) => (m === '**' ? '.*' : m === '*' ? '[^/]*' : '.'));
  return new RegExp(`^${re}$`, 'i');
}

/** Which of these files are protected (and by which rule). Empty = the change is allowed. */
export function protectedViolations(files = []) {
  const rules = getProtectedPaths().map((g) => ({ glob: g, re: globToRe(g) }));
  const hits = [];
  for (const f of files) {
    const rel = String(f).replace(/\\/g, '/');
    const rule = rules.find((r) => r.re.test(rel));
    if (rule) hits.push({ file: rel, rule: rule.glob });
  }
  return hits;
}

/* ─────────────────────────── 3. repo-wide secret scan ─────────────────────── */

const SECRET_PATTERNS = [
  { id: 'private-key', re: /-----BEGIN (?:RSA |EC |OPENSSH |PGP )?PRIVATE KEY-----/, severity: 'critical' },
  { id: 'aws-key', re: /\bAKIA[0-9A-Z]{16}\b/, severity: 'critical' },
  { id: 'aws-secret', re: /\baws_secret_access_key\s*[=:]\s*['"][A-Za-z0-9/+=]{40}['"]/i, severity: 'critical' },
  { id: 'stripe-live', re: /\bsk_live_[0-9a-zA-Z]{16,}\b/, severity: 'critical' },
  { id: 'github-token', re: /\bgh[pousr]_[A-Za-z0-9]{36,}\b/, severity: 'critical' },
  { id: 'slack-token', re: /\bxox[baprs]-[0-9A-Za-z-]{10,}\b/, severity: 'high' },
  { id: 'google-api-key', re: /\bAIza[0-9A-Za-z_-]{35}\b/, severity: 'high' },
  { id: 'jwt', re: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/, severity: 'medium' },
  { id: 'generic-password', re: /\b(password|passwd|pwd|secret|api_?key|token)\s*[=:]\s*['"][^'"\s]{8,}['"]/i, severity: 'medium' },
  { id: 'connection-string', re: /\b(mongodb(\+srv)?|postgres(ql)?|mysql|redis):\/\/[^\s'"]*:[^\s'"@]+@/i, severity: 'high' },
];

// Sample/example files legitimately contain placeholder credentials.
const SECRET_IGNORE = /(\.example|\.sample|\.template|\.md$|test|spec|fixture|mock|__tests__)/i;

/** Scan the whole working tree for committed credentials (not just the current diff). */
export function scanRepoSecrets({ root = REPO_ROOT, maxFindings = 200 } = {}) {
  const files = scanFiles({ root, dirs: PRODUCT_DIRS });
  const findings = [];
  let scanned = 0;
  for (const f of files) {
    if (findings.length >= maxFindings) break;
    if (SECRET_IGNORE.test(f.file)) continue;
    let text;
    try {
      const abs = path.join(root, f.file);
      if (fs.statSync(abs).size > 400_000) continue;
      text = fs.readFileSync(abs, 'utf8');
    } catch { continue; }
    scanned++;
    const lines = text.split('\n');
    for (const p of SECRET_PATTERNS) {
      for (let i = 0; i < lines.length; i++) {
        if (!p.re.test(lines[i])) continue;
        findings.push({
          file: f.file, line: i + 1, kind: p.id, severity: p.severity,
          // Never echo the secret itself — just enough context to locate it.
          excerpt: lines[i].trim().slice(0, 40).replace(/[A-Za-z0-9_\-+/=]{12,}/g, '••••'),
        });
        break; // one finding per pattern per file is enough to act on
      }
    }
  }
  const bySeverity = findings.reduce((a, f) => ({ ...a, [f.severity]: (a[f.severity] || 0) + 1 }), {});
  return { scanned, total: findings.length, bySeverity, findings: findings.slice(0, maxFindings), scannedAt: Date.now() };
}

/* ───────────────────────────── 4. licence inventory ───────────────────────── */

const COPYLEFT = /^(GPL|AGPL|LGPL|SSPL|EUPL|CDDL|MPL)/i;
const PERMISSIVE = /^(MIT|ISC|BSD|Apache|Unlicense|CC0|0BSD|Python|Zlib)/i;

/**
 * Package roots are where `node_modules` actually lives — NOT the product source dirs
 * (`backend/server`, `frontend/app`), which never contain one. Discover them by walking shallowly
 * for a directory that has both a package.json and an installed tree.
 */
function npmRoots(root, depth = 0, out = []) {
  if (depth > 3 || out.length >= 12) return out;
  let entries;
  try { entries = fs.readdirSync(root, { withFileTypes: true }); } catch { return out; }
  const names = new Set(entries.filter((e) => e.isDirectory() || e.isFile()).map((e) => e.name));
  if (names.has('package.json') && names.has('node_modules')) out.push(path.relative(REPO_ROOT, root).split(path.sep).join('/') || '.');
  for (const e of entries) {
    if (e.isDirectory() && e.name !== 'node_modules' && !e.name.startsWith('.') && !['dist', 'build', 'coverage'].includes(e.name)) {
      npmRoots(path.join(root, e.name), depth + 1, out);
    }
  }
  return out;
}

/** Read installed dependency licences from node_modules (no network). */
export function licenceInventory({ root = REPO_ROOT, maxDirs = 8 } = {}) {
  const projects = [];
  const seen = new Map(); // licence → count
  const flagged = [];

  const dirs = npmRoots(root).slice(0, maxDirs);
  for (const d of [...new Set(dirs)]) {
    const nm = path.join(root, d, 'node_modules');
    if (!fs.existsSync(nm)) continue;
    let pkgs = 0;
    let entries;
    try { entries = fs.readdirSync(nm, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      const scoped = e.name.startsWith('@');
      const subdirs = scoped ? (() => { try { return fs.readdirSync(path.join(nm, e.name)); } catch { return []; } })() : [null];
      for (const sub of subdirs) {
        const pkgDir = sub ? path.join(nm, e.name, sub) : path.join(nm, e.name);
        try {
          const pj = JSON.parse(fs.readFileSync(path.join(pkgDir, 'package.json'), 'utf8'));
          const lic = typeof pj.license === 'string' ? pj.license : (pj.license?.type || pj.licenses?.[0]?.type || 'UNKNOWN');
          pkgs++;
          seen.set(lic, (seen.get(lic) || 0) + 1);
          if (COPYLEFT.test(lic)) flagged.push({ name: pj.name, version: pj.version, license: lic, why: 'copyleft — review before shipping' });
          else if (!PERMISSIVE.test(lic)) flagged.push({ name: pj.name, version: pj.version, license: lic, why: 'unrecognised licence — needs review' });
        } catch { /* not a package */ }
      }
    }
    if (pkgs) projects.push({ dir: d, packages: pkgs });
  }

  const byLicence = [...seen.entries()].map(([license, count]) => ({ license, count, category: COPYLEFT.test(license) ? 'copyleft' : PERMISSIVE.test(license) ? 'permissive' : 'unknown' }))
    .sort((a, b) => b.count - a.count);
  return { projects, byLicence, flagged: flagged.slice(0, 100), flaggedCount: flagged.length, scannedAt: Date.now() };
}

/* ──────────────────────────────── 5. webhooks ─────────────────────────────── */

export const WEBHOOK_EVENTS = ['iteration.committed', 'iteration.rolled_back', 'review.pending', 'cve.critical', 'health.dropped', 'promotion'];

export function listWebhooks() {
  try {
    return db.prepare('SELECT * FROM webhooks ORDER BY id DESC').all().map((r) => ({
      id: r.id, url: r.url, events: JSON.parse(r.events || '[]'), enabled: !!r.enabled,
      hasSecret: !!r.secret, createdAt: r.created_at, lastStatus: r.last_status, lastAt: r.last_at,
    }));
  } catch { return []; }
}

export function addWebhook({ url, events = [], secret = '' }) {
  const u = String(url || '').trim();
  if (!/^https?:\/\//i.test(u)) throw new Error('a http(s) URL is required');
  const ev = (Array.isArray(events) ? events : []).filter((e) => WEBHOOK_EVENTS.includes(e));
  const info = db.prepare('INSERT INTO webhooks (url, events, secret, enabled, created_at) VALUES (?,?,?,1,?)')
    .run(u, JSON.stringify(ev.length ? ev : WEBHOOK_EVENTS), String(secret || '') || null, Date.now());
  return { id: Number(info.lastInsertRowid) };
}

export function deleteWebhook(id) {
  return db.prepare('DELETE FROM webhooks WHERE id = ?').run(Number(id)).changes;
}

/**
 * Deliver an event to every subscribed webhook. Fire-and-forget and fully guarded: a webhook that
 * is slow or down must never affect the loop. Signed with HMAC-SHA256 when a secret is set.
 */
/**
 * WIRING THE WEBHOOKS TO THE BUS — the step that was missing entirely.
 *
 * `dispatchWebhook` was complete and correct: it signed the body, recorded the delivery status, and
 * handled failures. It had **zero callers**. So an operator could open Governance → Webhooks, add a
 * URL, choose events, see it saved — and nothing was ever sent. A feature that looks configured and
 * does nothing is worse than one that is absent, because the absence is at least visible.
 *
 * Mapped in ONE place, from the bus, rather than sprinkling `dispatchWebhook(...)` through the
 * emitters. Every one of those call sites would be a chance to forget the next one, which is
 * precisely how this arrived at zero.
 *
 * `iteration.finished` carries the outcome in its status, so it fans out to two different webhook
 * events; the others are one-to-one.
 */
function webhookEventsFor(e) {
  switch (e.type) {
    case 'iteration.finished':
      if (e.status === 'committed' || e.status === 'promoted') return ['iteration.committed'];
      if (e.status === 'rolled_back') return ['iteration.rolled_back'];
      return [];
    case 'deploy.promoted': return ['promotion'];
    case 'proposal.created': return ['review.pending'];
    case 'health.dropped': return ['health.dropped'];
    case 'cve.critical': return ['cve.critical'];
    default: return [];
  }
}

/** Subscribe once. Safe to call again — a second subscription would double every delivery. */
let webhooksWired = false;
export function wireWebhooks() {
  if (webhooksWired) return false;
  webhooksWired = true;
  bus.on('event', (e) => {
    for (const name of webhookEventsFor(e)) {
      // Never let a webhook take down the run that triggered it.
      try { dispatchWebhook(name, e); } catch (err) { lg.warn(`webhook dispatch for ${name} failed: ${err.message}`); }
    }
  });
  return true;
}

export function dispatchWebhook(event, payload = {}) {
  let hooks;
  try { hooks = listWebhooks().filter((h) => h.enabled && h.events.includes(event)); } catch { return; }
  if (!hooks.length) return;
  const body = JSON.stringify({ event, at: Date.now(), payload });
  for (const h of hooks) {
    const headers = { 'content-type': 'application/json', 'x-isl-event': event };
    try {
      const row = db.prepare('SELECT secret FROM webhooks WHERE id = ?').get(h.id);
      if (row?.secret) headers['x-isl-signature'] = `sha256=${crypto.createHmac('sha256', row.secret).update(body).digest('hex')}`;
    } catch { /* no secret */ }
    fetch(h.url, { method: 'POST', headers, body, signal: AbortSignal.timeout(8000) })
      .then((r) => { try { db.prepare('UPDATE webhooks SET last_status = ?, last_at = ? WHERE id = ?').run(`HTTP ${r.status}`, Date.now(), h.id); } catch { /* ignore */ } })
      .catch((e) => {
        lg.warn(`webhook ${h.id} failed: ${e.message}`);
        try { db.prepare('UPDATE webhooks SET last_status = ?, last_at = ? WHERE id = ?').run(String(e.message).slice(0, 80), Date.now(), h.id); } catch { /* ignore */ }
      });
  }
}
