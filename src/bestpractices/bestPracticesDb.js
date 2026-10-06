import { pdb } from '../platform/platformDb.js';
import { SEED_PRACTICES } from './seed.js';
import { EXTENDED_PRACTICES } from './seedExtended.js';
import { DEPTH_PRACTICES } from './seedDepth.js';

/**
 * The best-practices knowledge base — a shared, cross-language reference that
 * lives in the platform DB (it describes languages, not any one project). The
 * compliance checker measures a project's code against the rules here, so ISL
 * can tell you whether best practices are respected for JavaScript, Python,
 * Java, Go, SQL, and enterprise languages like ABAP, Apex and COBOL alike.
 */

pdb.exec(`
CREATE TABLE IF NOT EXISTS best_practices (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  language   TEXT NOT NULL,          -- language key ('javascript','abap','general', …)
  category   TEXT NOT NULL,          -- security | performance | maintainability | reliability | style | testing
  title      TEXT NOT NULL,
  rule       TEXT NOT NULL,
  severity   TEXT NOT NULL DEFAULT 'medium',
  rationale  TEXT,
  source     TEXT,
  UNIQUE(language, title)
);
CREATE INDEX IF NOT EXISTS idx_bp_lang ON best_practices(language);
`);

const now = () => Date.now();

/** Seed the catalog once (idempotent — INSERT OR IGNORE on language+title). */
export function seedBestPractices() {
  const stmt = pdb.prepare(
    'INSERT OR IGNORE INTO best_practices (language, category, title, rule, severity, rationale, source) VALUES (?, ?, ?, ?, ?, ?, ?)',
  );
  let added = 0;
  /*
   * Three layers, in the order they were needed.
   *
   * SEED gave the essentials, EXTENDED gave breadth across 36 languages — and measuring that breadth
   * showed it was thin exactly where it fires: the stack under management had 9 JavaScript rules, no
   * React rules at all, and the whole catalogue held 2 for testing, 1 for accessibility and 1 for
   * API design. DEPTH fills that, weighted to what a web application is actually made of.
   */
  for (const p of [...SEED_PRACTICES, ...EXTENDED_PRACTICES, ...DEPTH_PRACTICES]) {
    const r = stmt.run(p.language, p.category, p.title, p.rule, p.severity || 'medium', p.rationale || null, p.source || null);
    added += Number(r.changes);
  }
  return { added, total: countPractices() };
}

export const countPractices = () => pdb.prepare('SELECT COUNT(*) n FROM best_practices').get().n;

const rowToPractice = (r) => ({
  id: r.id,
  language: r.language,
  category: r.category,
  title: r.title,
  rule: r.rule,
  severity: r.severity,
  rationale: r.rationale,
  source: r.source,
});

export function listPractices({ language = null, category = null } = {}) {
  const where = [];
  const args = [];
  if (language) {
    where.push('language = ?');
    args.push(language);
  }
  if (category) {
    where.push('category = ?');
    args.push(category);
  }
  const sql = `SELECT * FROM best_practices ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY language, category, id`;
  return pdb.prepare(sql).all(...args).map(rowToPractice);
}

/** Practices for a set of language keys, plus the always-relevant 'general' set. */
export function practicesForLanguages(keys = []) {
  const set = new Set([...keys, 'general']);
  const all = pdb.prepare('SELECT * FROM best_practices').all().map(rowToPractice);
  return all.filter((p) => set.has(p.language));
}

/** Summary: which languages have practices, and how many. */
export function practicesByLanguage() {
  const rows = pdb.prepare('SELECT language, COUNT(*) n FROM best_practices GROUP BY language ORDER BY n DESC').all();
  return rows.map((r) => ({ language: r.language, count: r.n }));
}

export function addPractice(p) {
  const r = pdb
    .prepare('INSERT OR IGNORE INTO best_practices (language, category, title, rule, severity, rationale, source) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(p.language, p.category, p.title, p.rule, p.severity || 'medium', p.rationale || null, p.source || 'custom');
  return Number(r.lastInsertRowid);
}

export function deletePractice(id) {
  return Number(pdb.prepare('DELETE FROM best_practices WHERE id = ?').run(id).changes) > 0;
}
