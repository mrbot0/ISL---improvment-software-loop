import fs from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { ACTIVE_PROJECT_ID, projectDbPath } from '../config.js';
import { listProjects } from '../platform/projects.js';
import { remember } from '../memory/memoryDb.js';
import { log } from '../logger.js';

/**
 * CROSS-PROJECT LEARNING TRANSFER (ISL_IMPROVE "Deeper capability", P1).
 *
 * Every project's shared memory accumulates hard-won, PROVEN know-how — patterns that landed, fixes
 * that worked. A pattern proven on one project is usually valid on another with the same stack, yet
 * today it stays siloed. This promotes the best patterns from one project into the others whose tech
 * stack matches, so every project benefits from what any project learned.
 *
 * Only PROVEN memories move (kind pattern/lesson/fix/insight, reinforced ≥ 2×), only between
 * stack-compatible projects (language-overlap ≥ threshold), and each transferred entry is tagged
 * with its origin so provenance is never lost. Reads use isolated read-only handles; the only write
 * to the live active project's DB goes through the normal `remember()` path (dedup-safe), so a
 * running loop is never disturbed.
 */

const lg = log.for('cross-project');
const TRANSFERABLE_KINDS = new Set(['pattern', 'lesson', 'fix', 'insight']);
const MIN_USES = 2; // "proven" — reinforced at least twice
const SIM_THRESHOLD = 0.34; // language-set Jaccard overlap to call two stacks compatible

function openReadOnly(projectId) {
  const p = projectDbPath(projectId);
  if (!fs.existsSync(p)) return null;
  try {
    return new DatabaseSync(p, { readOnly: true });
  } catch {
    try { return new DatabaseSync(p); } catch { return null; }
  }
}

/** The set of real (code) language keys a project is meaningfully built from. */
function projectStack(handle) {
  try {
    const row = handle.prepare("SELECT value FROM context_kv WHERE key = 'codeStats'").get();
    if (!row) return new Set();
    const stats = JSON.parse(row.value);
    return new Set((stats.byLanguage || []).filter((l) => l.pct != null && l.pct >= 5).map((l) => l.key));
  } catch {
    return new Set();
  }
}

/** Proven, transferable memories from a project. */
function projectPatterns(handle, limit = 40) {
  try {
    const kinds = [...TRANSFERABLE_KINDS];
    const rows = handle
      .prepare(`SELECT scope, kind, title, content, uses FROM memory
                WHERE kind IN (${kinds.map(() => '?').join(',')}) AND uses >= ?
                ORDER BY uses DESC LIMIT ?`)
      .all(...kinds, MIN_USES, limit);
    return rows.map((r) => ({ scope: r.scope, kind: r.kind, title: r.title, content: r.content, uses: r.uses }));
  } catch {
    return [];
  }
}

function jaccard(a, b) {
  if (!a.size || !b.size) return 0;
  let inter = 0;
  for (const x of a) if (b.has(x)) inter++;
  return inter / (a.size + b.size - inter);
}

const memKey = (scope, title) => `${scope}${title}`;

function titlesInTarget(handle) {
  try {
    return new Set(handle.prepare('SELECT scope, title FROM memory').all().map((r) => memKey(r.scope, r.title)));
  } catch {
    // no memory table (a brand-new project) — nothing to compare against.
    try { return new Set(handle.prepare('SELECT scope, title FROM memory').all().map((r) => `${r.scope}${r.title}`)); } catch { return new Set(); }
  }
}

/**
 * Compute what could transfer between every ordered pair of active projects — a preview, no writes.
 * @returns {{ projects, pairs }}
 */
export function crossProjectPlan() {
  const projects = listProjects().filter((p) => p.status !== 'archived');
  const info = new Map();
  for (const p of projects) {
    const h = openReadOnly(p.id);
    if (!h) { info.set(p.id, { name: p.name, stack: new Set(), patterns: [], titles: new Set() }); continue; }
    try {
      info.set(p.id, { name: p.name, stack: projectStack(h), patterns: projectPatterns(h), titles: titlesInTarget(h) });
    } finally { h.close(); }
  }

  const pairs = [];
  for (const from of projects) {
    for (const to of projects) {
      if (from.id === to.id) continue;
      const a = info.get(from.id);
      const b = info.get(to.id);
      const similarity = jaccard(a.stack, b.stack);
      if (similarity < SIM_THRESHOLD) continue;
      const candidates = a.patterns.filter((p) => !b.titles.has(`${p.scope}${p.title}`));
      if (!candidates.length) continue;
      pairs.push({
        from: from.id, fromName: a.name, to: to.id, toName: b.name,
        similarity: Math.round(similarity * 100),
        sharedStack: [...a.stack].filter((k) => b.stack.has(k)),
        candidates: candidates.slice(0, 20).map((c) => ({ scope: c.scope, kind: c.kind, title: c.title, uses: c.uses })),
        candidateCount: candidates.length,
      });
    }
  }
  return { projects: projects.map((p) => ({ id: p.id, name: p.name, stack: [...(info.get(p.id)?.stack || [])], patterns: info.get(p.id)?.patterns.length || 0 })), pairs };
}

/** Insert one transferred memory into a project's DB (dedup-safe), tagged with its origin. */
function transferInto(projectId, fromName, mem) {
  const content = `[learned in ${fromName}] ${mem.content || ''}`.slice(0, 2000);
  const source = `cross-project:${fromName}`;
  if (projectId === ACTIVE_PROJECT_ID) {
    // Active project → go through the live handle so we never open a second writer on it.
    remember({ scope: mem.scope, kind: mem.kind, title: mem.title, content, source });
    return true;
  }
  const p = projectDbPath(projectId);
  if (!fs.existsSync(p)) return false;
  let wdb;
  try {
    wdb = new DatabaseSync(p);
    // The target may never have had its memory table created (a project ISL hasn't run yet).
    // Mirror the memoryDb schema so a transfer can seed a fresh project's know-how.
    wdb.exec(`CREATE TABLE IF NOT EXISTS memory (
      id INTEGER PRIMARY KEY AUTOINCREMENT, scope TEXT NOT NULL DEFAULT 'global', kind TEXT NOT NULL DEFAULT 'lesson',
      title TEXT NOT NULL, content TEXT NOT NULL DEFAULT '', source TEXT, uses INTEGER NOT NULL DEFAULT 1,
      pinned INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, UNIQUE(scope, title));`);
    const now = Date.now();
    const existing = wdb.prepare('SELECT id FROM memory WHERE scope = ? AND title = ?').get(mem.scope, mem.title);
    if (existing) {
      wdb.prepare('UPDATE memory SET uses = uses + 1, content = ?, source = ?, updated_at = ? WHERE id = ?').run(content, source, now, existing.id);
    } else {
      wdb.prepare('INSERT INTO memory (scope, kind, title, content, source, uses, created_at, updated_at) VALUES (?,?,?,?,?,1,?,?)')
        .run(mem.scope, mem.kind, mem.title, content, source, now, now);
    }
    return true;
  } catch (e) {
    lg.warn(`transfer into ${projectId} failed: ${e.message}`);
    return false;
  } finally {
    try { wdb?.close(); } catch { /* ignore */ }
  }
}

/**
 * Apply the transfer for one source→target pair. Re-derives the candidates fresh (so it's safe to
 * call after the preview) and moves up to `max` proven patterns.
 */
export function applyCrossProjectTransfer({ from, to, max = 10 } = {}) {
  if (!from || !to || from === to) return { transferred: 0, error: 'from and to (distinct) required' };
  const fromH = openReadOnly(from);
  const toH = openReadOnly(to);
  if (!fromH || !toH) { fromH?.close(); toH?.close(); return { transferred: 0, error: 'project db not found' }; }
  let candidates, targetTitles, fromName;
  try {
    fromName = listProjects().find((p) => p.id === from)?.name || from;
    const patterns = projectPatterns(fromH);
    targetTitles = titlesInTarget(toH);
    candidates = patterns.filter((p) => !targetTitles.has(`${p.scope}${p.title}`)).slice(0, max);
  } finally {
    fromH.close();
    toH.close();
  }
  let transferred = 0;
  for (const c of candidates) if (transferInto(to, fromName, c)) transferred++;
  lg.info(`transferred ${transferred} proven pattern(s) from ${from} → ${to}`);
  return { transferred, considered: candidates.length };
}
