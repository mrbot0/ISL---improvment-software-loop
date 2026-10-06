import { db, registerSchema } from '../db.js';

/**
 * Per-project compliance store: the findings from checking the project's code
 * against the best-practices knowledge base, per language, plus a rolling record
 * of check runs. Registered so it lives in the active project's database.
 */
registerSchema(() => {
  db.exec(`
  CREATE TABLE IF NOT EXISTS compliance_findings (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    ts         INTEGER NOT NULL,
    language   TEXT NOT NULL,
    rel_path   TEXT,
    line       INTEGER,
    category   TEXT NOT NULL DEFAULT 'maintainability',
    severity   TEXT NOT NULL DEFAULT 'medium',
    title      TEXT NOT NULL,
    message    TEXT NOT NULL,
    practice   TEXT,
    resolved   INTEGER NOT NULL DEFAULT 0
  );
  CREATE INDEX IF NOT EXISTS idx_comp_lang ON compliance_findings(language);
  CREATE INDEX IF NOT EXISTS idx_comp_resolved ON compliance_findings(resolved);

  CREATE TABLE IF NOT EXISTS compliance_runs (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    ts            INTEGER NOT NULL,
    languages     TEXT,
    files_checked INTEGER NOT NULL DEFAULT 0,
    violations    INTEGER NOT NULL DEFAULT 0,
    score         INTEGER
  );
  `);
});

const now = () => Date.now();
const J = (v) => JSON.stringify(v ?? null);
const P = (v, d = null) => {
  if (v == null) return d;
  try {
    return JSON.parse(v);
  } catch {
    return d;
  }
};

export function clearOpenComplianceFindings(language = null) {
  if (language) db.prepare('DELETE FROM compliance_findings WHERE resolved = 0 AND language = ?').run(language);
  else db.exec('DELETE FROM compliance_findings WHERE resolved = 0');
}

export function addComplianceFinding(f) {
  db.prepare(
    `INSERT INTO compliance_findings (ts, language, rel_path, line, category, severity, title, message, practice)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    now(),
    f.language,
    f.relPath ?? null,
    f.line ?? null,
    f.category || 'maintainability',
    f.severity || 'medium',
    String(f.title || 'Best-practice violation').slice(0, 200),
    String(f.message || '').slice(0, 1000),
    f.practice ?? null,
  );
}

const rowToFinding = (r) => ({
  id: r.id,
  ts: r.ts,
  language: r.language,
  relPath: r.rel_path,
  line: r.line,
  category: r.category,
  severity: r.severity,
  title: r.title,
  message: r.message,
  practice: r.practice,
  resolved: !!r.resolved,
});

export function listComplianceFindings({ onlyOpen = true, language = null, limit = 300 } = {}) {
  const where = [];
  const args = [];
  if (onlyOpen) where.push('resolved = 0');
  if (language) {
    where.push('language = ?');
    args.push(language);
  }
  args.push(limit);
  return db
    .prepare(`SELECT * FROM compliance_findings ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY id DESC LIMIT ?`)
    .all(...args)
    .map(rowToFinding);
}

export function resolveComplianceFinding(id) {
  db.prepare('UPDATE compliance_findings SET resolved = 1 WHERE id = ?').run(id);
}

export function recordComplianceRun({ languages, filesChecked, violations, score }) {
  db.prepare('INSERT INTO compliance_runs (ts, languages, files_checked, violations, score) VALUES (?, ?, ?, ?, ?)').run(
    now(),
    J(languages),
    filesChecked,
    violations,
    score,
  );
}

export function lastComplianceRun() {
  const r = db.prepare('SELECT * FROM compliance_runs ORDER BY id DESC LIMIT 1').get();
  return r ? { id: r.id, ts: r.ts, languages: P(r.languages, []), filesChecked: r.files_checked, violations: r.violations, score: r.score } : null;
}

export function complianceByLanguage() {
  const rows = db
    .prepare(
      `SELECT language,
              COUNT(*) violations,
              SUM(CASE WHEN severity IN ('high','critical') THEN 1 ELSE 0 END) severe
       FROM compliance_findings WHERE resolved = 0 GROUP BY language ORDER BY violations DESC`,
    )
    .all();
  return rows.map((r) => ({ language: r.language, violations: r.violations, severe: r.severe }));
}

export const countOpenViolations = () => db.prepare('SELECT COUNT(*) n FROM compliance_findings WHERE resolved = 0').get().n;
