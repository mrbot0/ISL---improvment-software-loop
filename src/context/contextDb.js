import { db, registerSchema } from '../db.js';

/**
 * Per-project context store: the document index the Context Manager builds, the
 * project profile it derives, the (max 10) onboarding questions, and the doc
 * findings raised by the doc-verifier. Registered so it is created in whichever
 * project database is active.
 */
registerSchema(() => {
  db.exec(`
  CREATE TABLE IF NOT EXISTS documents (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    rel_path   TEXT NOT NULL UNIQUE,
    type       TEXT NOT NULL,             -- md | pdf | docx | doc | txt | rst | adoc | other
    title      TEXT,
    size       INTEGER NOT NULL DEFAULT 0,
    chars      INTEGER NOT NULL DEFAULT 0,
    hash       TEXT,
    text       TEXT,                      -- extracted plain text (bounded)
    mtime      INTEGER,
    stale      INTEGER NOT NULL DEFAULT 0,
    error      TEXT,
    indexed_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_docs_type ON documents(type);

  CREATE TABLE IF NOT EXISTS context_kv (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS context_questions (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    ord        INTEGER NOT NULL DEFAULT 0,
    question   TEXT NOT NULL,
    answer     TEXT,
    source     TEXT NOT NULL DEFAULT 'pending', -- auto | user | pending
    rationale  TEXT,
    updated_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS doc_findings (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    rel_path   TEXT,
    kind       TEXT NOT NULL,             -- stale | missing | coverage | drift | quality
    severity   TEXT NOT NULL DEFAULT 'medium',
    message    TEXT NOT NULL,
    detail     TEXT,
    resolved   INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_findings_resolved ON doc_findings(resolved);
  `);
});

const now = () => Date.now();
const J = (v) => JSON.stringify(v ?? null);
const P = (v, dflt = null) => {
  if (v == null) return dflt;
  try {
    return JSON.parse(v);
  } catch {
    return dflt;
  }
};

/* ------------------------------- documents -------------------------------- */

export function upsertDocument(doc) {
  db.prepare(
    `INSERT INTO documents (rel_path, type, title, size, chars, hash, text, mtime, stale, error, indexed_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)
     ON CONFLICT(rel_path) DO UPDATE SET
       type = excluded.type, title = excluded.title, size = excluded.size,
       -- A failed re-read must not destroy a good extraction. Degrading to the last known text is
       -- strictly better than degrading to nothing, and the error column still records what
       -- happened, so the retry on the next pass is unaffected.
       text = CASE WHEN excluded.error IS NOT NULL AND COALESCE(excluded.text, '') = ''
                   THEN documents.text ELSE excluded.text END,
       chars = CASE WHEN excluded.error IS NOT NULL AND COALESCE(excluded.text, '') = ''
                    THEN documents.chars ELSE excluded.chars END,
       hash = excluded.hash, mtime = excluded.mtime, stale = 0,
       error = excluded.error, indexed_at = excluded.indexed_at`,
  ).run(
    doc.relPath,
    doc.type,
    doc.title ?? null,
    doc.size ?? 0,
    doc.chars ?? 0,
    doc.hash ?? null,
    doc.text ?? null,
    doc.mtime ?? null,
    doc.error ?? null,
    now(),
  );
}

const rowToDoc = (r, withText = false) => ({
  id: r.id,
  relPath: r.rel_path,
  type: r.type,
  title: r.title,
  size: r.size,
  chars: r.chars,
  hash: r.hash,
  mtime: r.mtime,
  stale: !!r.stale,
  error: r.error,
  indexedAt: r.indexed_at,
  ...(withText ? { text: r.text } : {}),
});

export const listDocuments = () =>
  db.prepare('SELECT * FROM documents ORDER BY rel_path').all().map((r) => rowToDoc(r));

export function getDocument(id, { withText = true } = {}) {
  const r = db.prepare('SELECT * FROM documents WHERE id = ?').get(id);
  return r ? rowToDoc(r, withText) : null;
}

export function getDocumentByPath(relPath, { withText = true } = {}) {
  const r = db.prepare('SELECT * FROM documents WHERE rel_path = ?').get(relPath);
  return r ? rowToDoc(r, withText) : null;
}

/**
 * What the ingester needs in order to decide whether a file still has to be read: its last-seen
 * mtime and whether the last attempt actually produced anything. `error` is part of that answer —
 * a skip that cannot see a past failure caches that failure for ever.
 */
export const documentHashes = () =>
  Object.fromEntries(
    db
      .prepare('SELECT rel_path, hash, mtime, error FROM documents')
      .all()
      .map((r) => [r.rel_path, { hash: r.hash, mtime: r.mtime, error: r.error }]),
  );

export function pruneDocumentsNotIn(relPaths) {
  const keep = new Set(relPaths);
  const all = db.prepare('SELECT id, rel_path FROM documents').all();
  let removed = 0;
  for (const r of all) if (!keep.has(r.rel_path)) {
    db.prepare('DELETE FROM documents WHERE id = ?').run(r.id);
    removed++;
  }
  return removed;
}

export function markDocumentsStale(relPaths) {
  const stmt = db.prepare('UPDATE documents SET stale = 1 WHERE rel_path = ?');
  for (const p of relPaths) stmt.run(p);
}

export function documentStats() {
  const rows = db.prepare('SELECT type, COUNT(*) n, SUM(chars) chars FROM documents GROUP BY type').all();
  const byType = Object.fromEntries(rows.map((r) => [r.type, r.n]));
  const total = rows.reduce((a, r) => a + r.n, 0);
  const stale = db.prepare('SELECT COUNT(*) n FROM documents WHERE stale = 1').get().n;
  // Documents we could not read. Without this number the fleet reported "documentation healthy"
  // over a corpus whose architecture documents were all empty — an operator cannot act on a
  // failure nobody counts, and a silently absent document reads exactly like one that says nothing.
  const failed = db.prepare("SELECT COUNT(*) n FROM documents WHERE error IS NOT NULL AND error <> ''").get().n;
  return { total, byType, stale, failed, chars: rows.reduce((a, r) => a + (r.chars || 0), 0) };
}

/* -------------------------------- profile --------------------------------- */

export function setContext(key, value) {
  db.prepare('INSERT INTO context_kv (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, J(value));
  return value;
}
export function getContext(key, dflt = null) {
  const r = db.prepare('SELECT value FROM context_kv WHERE key = ?').get(key);
  return r ? P(r.value, dflt) : dflt;
}
export const getProfile = () => getContext('profile', null);
export const setProfile = (profile) => setContext('profile', { ...profile, updatedAt: now() });

/* ------------------------------- questions -------------------------------- */

/** Same question, differently typed: whitespace and case must not create a second row. */
const questionKey = (s) => String(s || '').replace(/\s+/g, ' ').trim().toLowerCase();

/**
 * Install a freshly generated question set, preserving everything a human answered.
 *
 * A question carries `source: 'pending'` precisely because the documentation does NOT answer it,
 * so the operator's reply is the only fact here that no rebuild can reproduce — and it feeds the
 * "Known constraints" block of every planner, implementer and reviewer prompt. This used to open
 * with a bare `DELETE`, so a second "Build context" silently erased it.
 *
 * The rule: a rebuild owns the model's rows and may replace them freely; it never discards the
 * operator's. A question the model has stopped asking is carried over rather than dropped, because
 * losing the answer is worse than keeping a question that has outlived its list.
 */
export function replaceQuestions(questions) {
  const human = new Map();
  for (const r of db
    .prepare("SELECT question, answer, source, rationale FROM context_questions WHERE source = 'user' AND answer IS NOT NULL AND TRIM(answer) <> ''")
    .all()) {
    human.set(questionKey(r.question), r);
  }

  // Build the whole set before touching the table, so a malformed payload cannot leave it empty.
  const rows = [];
  const carried = new Set();
  for (const q of questions ?? []) {
    const key = questionKey(q.question);
    const prior = human.get(key);
    if (prior) {
      carried.add(key);
      rows.push({ question: q.question, answer: prior.answer, source: 'user', rationale: prior.rationale ?? q.rationale ?? null });
    } else {
      // 'user' is never accepted from the model: it is the marker that makes an answer immortal,
      // so only answerQuestion() may set it.
      const source = q.source === 'auto' || q.source === 'pending' ? q.source : q.answer ? 'auto' : 'pending';
      rows.push({ question: q.question, answer: q.answer ?? null, source, rationale: q.rationale ?? null });
    }
  }
  for (const [key, r] of human) {
    if (!carried.has(key)) rows.push({ question: r.question, answer: r.answer, source: 'user', rationale: r.rationale ?? null });
  }

  db.exec('BEGIN');
  try {
    db.exec('DELETE FROM context_questions');
    const stmt = db.prepare(
      'INSERT INTO context_questions (ord, question, answer, source, rationale, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
    );
    rows.forEach((r, i) => stmt.run(i, r.question, r.answer, r.source, r.rationale, now()));
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

const rowToQ = (r) => ({
  id: r.id,
  ord: r.ord,
  question: r.question,
  answer: r.answer,
  source: r.source,
  rationale: r.rationale,
  updatedAt: r.updated_at,
});

export const listQuestions = () =>
  db.prepare('SELECT * FROM context_questions ORDER BY ord, id').all().map(rowToQ);

export function answerQuestion(id, answer) {
  db.prepare('UPDATE context_questions SET answer = ?, source = ?, updated_at = ? WHERE id = ?').run(
    answer,
    answer && answer.trim() ? 'user' : 'pending',
    now(),
    id,
  );
  return rowToQ(db.prepare('SELECT * FROM context_questions WHERE id = ?').get(id));
}

export function countPendingQuestions() {
  return db.prepare("SELECT COUNT(*) n FROM context_questions WHERE source = 'pending' OR answer IS NULL OR TRIM(answer) = ''").get().n;
}

/* ------------------------------- findings --------------------------------- */

export function addDocFinding(f) {
  db.prepare(
    'INSERT INTO doc_findings (rel_path, kind, severity, message, detail, created_at) VALUES (?, ?, ?, ?, ?, ?)',
  ).run(f.relPath ?? null, f.kind, f.severity ?? 'medium', f.message, f.detail ?? null, now());
}

export function clearOpenFindings(kinds = null) {
  if (kinds) {
    const stmt = db.prepare('DELETE FROM doc_findings WHERE resolved = 0 AND kind = ?');
    for (const k of kinds) stmt.run(k);
  } else {
    db.exec('DELETE FROM doc_findings WHERE resolved = 0');
  }
}

export const listFindings = ({ onlyOpen = true, limit = 100 } = {}) =>
  db
    .prepare(`SELECT * FROM doc_findings ${onlyOpen ? 'WHERE resolved = 0' : ''} ORDER BY id DESC LIMIT ?`)
    .all(limit)
    .map((r) => ({
      id: r.id,
      relPath: r.rel_path,
      kind: r.kind,
      severity: r.severity,
      message: r.message,
      detail: r.detail,
      resolved: !!r.resolved,
      createdAt: r.created_at,
    }));

export function resolveFinding(id) {
  db.prepare('UPDATE doc_findings SET resolved = 1 WHERE id = ?').run(id);
}

/**
 * Wipe all derived context for the active project — documents, profile, questions
 * and findings. Used when the source folder changes and the project must be
 * analysed from scratch. Preserves nothing; the next build starts clean.
 */
export function clearAllContext() {
  db.exec('DELETE FROM documents');
  db.exec('DELETE FROM context_kv');
  db.exec('DELETE FROM context_questions');
  db.exec('DELETE FROM doc_findings');
}
