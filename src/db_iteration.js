/**
 * Schema + queries for the autonomous iteration engine: the code catalog, the
 * feature backlog, iterations, their phases and tasks, tunable KPI weights, and
 * notifications. Shares the same SQLite handle as db.js.
 */
import { db, registerSchema } from './db.js';

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

/**
 * A stored gate record reduced to what a list row needs, or null when the gate never ran.
 *
 * Null and "ran but found nothing" must stay distinguishable: the whole point of persisting these
 * is to be able to tell "the coverage was fine" from "nobody measured it".
 */
const summarise = (raw, pick) => {
  const parsed = P(raw);
  return parsed ? pick(parsed) : null;
};

registerSchema(() => {
db.exec(`
-- One row per code unit the cataloger finds. Drives what the planner improves.
CREATE TABLE IF NOT EXISTS functions (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  path         TEXT NOT NULL,
  name         TEXT NOT NULL,
  kind         TEXT NOT NULL DEFAULT 'function', -- function | route | component
  signature    TEXT,
  start_line   INTEGER,
  loc          INTEGER NOT NULL DEFAULT 0,
  complexity   INTEGER NOT NULL DEFAULT 0,   -- rough cyclomatic proxy
  fan_in       INTEGER NOT NULL DEFAULT 0,   -- how many files reference the name
  todos        INTEGER NOT NULL DEFAULT 0,
  weight       INTEGER NOT NULL DEFAULT 0,   -- priority score
  status       TEXT NOT NULL DEFAULT 'pending', -- pending | improving | improved | deferred
  failures     INTEGER NOT NULL DEFAULT 0,
  last_iter    INTEGER,
  updated_at   INTEGER NOT NULL,
  UNIQUE(path, name)
);
CREATE INDEX IF NOT EXISTS idx_fn_status ON functions(status);
CREATE INDEX IF NOT EXISTS idx_fn_weight ON functions(weight DESC);

-- The feature backlog: ideas from research + operator, worked by the planner.
CREATE TABLE IF NOT EXISTS features (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  title        TEXT NOT NULL,
  description  TEXT NOT NULL DEFAULT '',
  area         TEXT,                          -- backend | frontend | docs
  source       TEXT NOT NULL DEFAULT 'research', -- research | operator | manager
  priority     INTEGER NOT NULL DEFAULT 50,
  status       TEXT NOT NULL DEFAULT 'pending', -- pending | in_progress | done | deferred
  failures     INTEGER NOT NULL DEFAULT 0,
  last_reason  TEXT,
  done_iter    INTEGER,
  created_at   INTEGER NOT NULL,
  updated_at   INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_feat_status ON features(status);

CREATE TABLE IF NOT EXISTS iterations (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  status         TEXT NOT NULL DEFAULT 'running', -- running | scored | committed | rolled_back | rejected | promoted | error | interrupted
  trigger        TEXT NOT NULL DEFAULT 'loop',
  plan_title     TEXT,
  plan_json      TEXT,
  research_json  TEXT,
  review_score   INTEGER,
  security_score INTEGER,
  regression_score INTEGER,
  test_score     INTEGER,
  total_score    INTEGER,
  files_changed  INTEGER NOT NULL DEFAULT 0,
  additions      INTEGER NOT NULL DEFAULT 0,
  deletions      INTEGER NOT NULL DEFAULT 0,
  diff           TEXT,
  improvements   INTEGER NOT NULL DEFAULT 0,
  features_done  INTEGER NOT NULL DEFAULT 0,
  base_commit    TEXT,
  commit_sha     TEXT,               -- commit on the work branch (hybrid autocommit)
  branch         TEXT,
  rolled_back    INTEGER NOT NULL DEFAULT 0,
  error          TEXT,
  tokens_in      INTEGER NOT NULL DEFAULT 0,
  tokens_out     INTEGER NOT NULL DEFAULT 0,
  started_at     INTEGER NOT NULL,
  finished_at    INTEGER
);
CREATE INDEX IF NOT EXISTS idx_iter_status ON iterations(status);

CREATE TABLE IF NOT EXISTS phases (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  iteration_id INTEGER NOT NULL REFERENCES iterations(id) ON DELETE CASCADE,
  phase        TEXT NOT NULL,
  status       TEXT NOT NULL DEFAULT 'running', -- running | ok | error | skipped
  score        INTEGER,
  summary      TEXT,
  result       TEXT,
  started_at   INTEGER NOT NULL,
  finished_at  INTEGER
);
CREATE INDEX IF NOT EXISTS idx_phase_iter ON phases(iteration_id);

CREATE TABLE IF NOT EXISTS tasks (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  iteration_id INTEGER NOT NULL REFERENCES iterations(id) ON DELETE CASCADE,
  kind         TEXT NOT NULL,        -- improvement | feature
  title        TEXT NOT NULL,
  rationale    TEXT,
  function_id  INTEGER,
  feature_id   INTEGER,
  files        TEXT,
  steps        TEXT,
  status       TEXT NOT NULL DEFAULT 'pending', -- pending | running | done | failed
  files_changed TEXT,
  summary      TEXT,
  started_at   INTEGER,
  finished_at  INTEGER
);
CREATE INDEX IF NOT EXISTS idx_task_iter ON tasks(iteration_id);

CREATE TABLE IF NOT EXISTS kpi (
  key   TEXT PRIMARY KEY,
  value REAL NOT NULL
);

CREATE TABLE IF NOT EXISTS notifications (
  id       INTEGER PRIMARY KEY AUTOINCREMENT,
  ts       INTEGER NOT NULL,
  kind     TEXT NOT NULL,       -- iteration | regression | rollback | promotion | system
  severity TEXT NOT NULL DEFAULT 'info',
  title    TEXT NOT NULL,
  body     TEXT,
  link     TEXT,
  read     INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_notif_ts ON notifications(id DESC);

-- Golden surface snapshot for regression detection (single-row, id=1).
CREATE TABLE IF NOT EXISTS golden_surface (
  id         INTEGER PRIMARY KEY CHECK (id = 1),
  surface    TEXT NOT NULL,      -- JSON [{file, name}]
  taken_at   INTEGER NOT NULL,
  commit_sha TEXT
);
`);

/**
 * Idempotent column migrations (node:sqlite has no ADD COLUMN IF NOT EXISTS).
 * Safe to run on every boot — existing databases pick up the new columns.
 */
function ensureColumns(table, columns) {
  const have = new Set(db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name));
  for (const [name, decl] of Object.entries(columns)) {
    if (!have.has(name)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${decl}`);
  }
}

// Failure triage + restart support: a failed run records WHY it failed (was it
// merely interrupted, or is the change genuinely broken?) and keeps the diff it
// had produced, so a restart can replay the work instead of starting over.
ensureColumns('iterations', {
  failure_kind: 'TEXT', //  interruption | implementation | infrastructure
  failure_code: 'TEXT', //  tests | syntax | regression | cancelled | …
  failure_title: 'TEXT',
  failure_explanation: 'TEXT',
  failure_remedy: 'TEXT',
  resume_from: 'TEXT', //  phase a restart should pick up at
  resumable: 'INTEGER NOT NULL DEFAULT 0',
  pending_diff: 'TEXT', //  the edits the failed run had produced (replayed on restart)
  restart_of: 'INTEGER', //  parent iteration this one is a restart of
  restarts: 'INTEGER NOT NULL DEFAULT 0',
  isolation: 'TEXT', //  whether verification ran in a container, and if not, why not
  // What the two gates that produce a JUDGEMENT rather than a score actually found. Both were
  // computed and then dropped on the floor: the behaviour gate's result was assigned to a variable
  // nobody read, under a comment claiming it was "recorded on the iteration". A gate whose verdict
  // survives only as a log line cannot be reviewed after the fact, cannot be charted, and cannot
  // answer "was this run's coverage low, or did the gate not run?" — the question an operator
  // actually has when a change turns out to be wrong.
  behaviour_json: 'TEXT', //  refactor runs: did the suite behave the same before and after?
  coverage_json: 'TEXT', //  coverage of the lines THIS change added, plus the gate's verdict
  waves_json: 'TEXT', //  the parallel execution plan actually used
  workbench_score: 'INTEGER', //  does the app actually boot and serve?
  parallel_saved_ms: 'INTEGER NOT NULL DEFAULT 0',
  dismissed: 'INTEGER NOT NULL DEFAULT 0', //  operator cleared this failed/empty run from the Runs board
});

// Tasks now know which specialist agent owns them and which parallel wave they ran in.
ensureColumns('tasks', {
  agent: 'TEXT',
  wave: 'INTEGER',
  error: 'TEXT',
  area: 'TEXT', //  backend | frontend | services | infra
});

/* Default KPI weights + thresholds, inserted once. */
const KPI_DEFAULTS = {
  'weight.review': 0.2,
  'weight.security': 0.2,
  'weight.regression': 0.3,
  'weight.test': 0.15,
  'weight.workbench': 0.15,
  rollback_threshold: 60,
  /*
   * The reviewer's own veto, independent of the weighted average.
   *
   * Review is the only grader that compares the change to what was ASKED FOR; the rest measure
   * mechanical properties of the result. At weight 0.2 its opinion cannot stop anything on its
   * own: 55 alongside four near-perfect mechanical scores totals 90 against a threshold of 60.
   * Measured across this project's history, 31 of 115 commits — 27% — carried a review below 70,
   * four of them a review of 0. One of those, #426, silently deleted the search personalisation
   * it had been asked to finish wiring up.
   *
   * 70 is not arbitrary. The committed scores fall in two clusters, 0–55 and 75–100, with nothing
   * in between; the floor sits in that gap, so it separates the reviewer's objections from its
   * approvals rather than cutting through either.
   */
  review_floor: 70,
  // Smaller batches land faster and risk less: on a slow local model a 5-task iteration
  // can take the better part of an hour, so a 3-task batch that COMMITS beats a big one
  // that drags. Tune up via the KPI page once runs are landing comfortably.
  improvements_per_iter: 2,
  features_per_iter: 1,
  max_parallel_tasks: 2,
  /*
   * How many generations may run at once, independent of task parallelism.
   *
   * One by default. Two concurrent generations against a single local Ollama holding one resident
   * model kill each other: 216 of 420 recorded task failures were 'fetch failed', and 105 of the
   * 109 iterations that hit it lost exactly two tasks — with parallelism at two. Raise it only for
   * a model server that genuinely serves concurrent requests.
   */
  max_parallel_llm: 1,
  survey_every_runs: 10,
};
for (const [k, v] of Object.entries(KPI_DEFAULTS)) {
  db.prepare('INSERT OR IGNORE INTO kpi (key, value) VALUES (?, ?)').run(k, v);
}

/**
 * One-time re-tune. The batch size was set when tasks ran strictly one after
 * another, so a small batch was the right call — a big one just made a long
 * iteration longer. Tasks now run in parallel waves, which inverts that: a batch of
 * one leaves the parallelism completely unused. Raise existing installs to a batch
 * that can actually fill a wave, once, and never touch the operator's choice again.
 */
const BATCH_V2 = 'migrated.parallel_batch';
if (!db.prepare('SELECT value FROM kpi WHERE key = ?').get(BATCH_V2)) {
  const bump = (key, floor) => {
    const cur = db.prepare('SELECT value FROM kpi WHERE key = ?').get(key)?.value ?? 0;
    if (cur < floor) db.prepare('UPDATE kpi SET value = ? WHERE key = ?').run(floor, key);
  };
  bump('improvements_per_iter', 3);
  bump('features_per_iter', 2);
  db.prepare('INSERT INTO kpi (key, value) VALUES (?, 1)').run(BATCH_V2);
}
});

/* --------------------------------- KPI ------------------------------------ */

export const getKpi = () =>
  Object.fromEntries(db.prepare('SELECT key, value FROM kpi').all().map((r) => [r.key, r.value]));

export function setKpi(patch) {
  const stmt = db.prepare('INSERT INTO kpi (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value');
  for (const [k, v] of Object.entries(patch)) if (typeof v === 'number' && Number.isFinite(v)) stmt.run(k, v);
  return getKpi();
}

/* ------------------------------- functions -------------------------------- */

const rowToFn = (r) => ({
  id: r.id,
  path: r.path,
  name: r.name,
  kind: r.kind,
  signature: r.signature,
  loc: r.loc,
  complexity: r.complexity,
  fanIn: r.fan_in,
  todos: r.todos,
  weight: r.weight,
  status: r.status,
  failures: r.failures,
});

export function upsertFunction(f) {
  db.prepare(
    `INSERT INTO functions (path, name, kind, signature, start_line, loc, complexity, fan_in, todos, weight, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(path, name) DO UPDATE SET
       signature = excluded.signature, start_line = excluded.start_line, loc = excluded.loc,
       complexity = excluded.complexity, fan_in = excluded.fan_in, todos = excluded.todos,
       weight = excluded.weight, updated_at = excluded.updated_at`,
  ).run(f.path, f.name, f.kind || 'function', f.signature || '', f.startLine || 0, f.loc || 0, f.complexity || 0, f.fanIn || 0, f.todos || 0, f.weight || 0, now());
}

export const countFunctionsByStatus = () => {
  const out = { pending: 0, improving: 0, improved: 0, deferred: 0 };
  for (const r of db.prepare('SELECT status, COUNT(*) n FROM functions GROUP BY status').all()) out[r.status] = r.n;
  return out;
};

export const topFunctions = (limit = 20) =>
  db.prepare("SELECT * FROM functions WHERE status IN ('pending','improving') ORDER BY weight DESC, complexity DESC LIMIT ?").all(limit).map(rowToFn);

/**
 * WHY THE SAME TARGET CAME BACK EVERY RUN.
 *
 * The order was `weight DESC, failures ASC`, which makes failures a TIE-BREAK — it only separates
 * candidates of identical weight, and weight is a wide continuous score, so in practice it never
 * separated anything. A high-weight target that failed went back to `pending` (that is what
 * `bumpFunctionFailure` does) and reappeared at the top of the very next batch, unchanged.
 *
 * Measured: `removeUser` in Admin.jsx, weight 238, planned in four consecutive runs — 437 through
 * 440 — under near-identical titles, failing each time. `autoDeferFailing` does eventually retire a
 * target, but only at three failures, so three runs are spent rediscovering the same wall first.
 *
 * Failures now DIVIDE the weight, quadratically: one failure halves a candidate, two leaves a
 * fifth, three a tenth. `removeUser` drops from 238 to 119 and sits below the untouched work
 * instead of above it. Nothing is banned — a heavy target still outranks a trivial one — but it
 * stops being able to monopolise the batch by being heavy.
 *
 * `cooldown` is the second half: a target that failed in the last few runs is skipped outright, so
 * a failure is never retried in the immediately following batch with the same information that
 * produced it.
 */
export const pickFunctionsToImprove = (n, { currentIter = null, cooldown = 3 } = {}) => {
  const floor = currentIter != null ? currentIter - cooldown : null;
  return db
    .prepare(
      `SELECT * FROM functions
        WHERE status = 'pending'
          AND NOT (failures > 0 AND ? IS NOT NULL AND last_iter IS NOT NULL AND last_iter > ?)
        ORDER BY (weight * 1.0) / (1 + failures * failures) DESC, complexity DESC
        LIMIT ?`,
    )
    .all(floor, floor, n)
    .map(rowToFn);
};

export const setFunctionStatus = (id, status) =>
  db.prepare('UPDATE functions SET status = ?, updated_at = ? WHERE id = ?').run(status, now(), id);

export function bumpFunctionFailure(id, iter) {
  db.prepare('UPDATE functions SET failures = failures + 1, status = ?, last_iter = ?, updated_at = ? WHERE id = ?').run('pending', iter, now(), id);
}
export const markFunctionImproved = (id, iter) =>
  db.prepare("UPDATE functions SET status = 'improved', failures = 0, last_iter = ?, updated_at = ? WHERE id = ?").run(iter, now(), id);

/* -------------------------------- features -------------------------------- */

const rowToFeat = (r) => ({
  id: r.id,
  title: r.title,
  description: r.description,
  area: r.area,
  source: r.source,
  priority: r.priority,
  status: r.status,
  failures: r.failures,
  lastReason: r.last_reason,
  createdAt: r.created_at,
});

export function addFeature(f) {
  // De-dup on title to stop research re-adding the same idea every iteration.
  const existing = db.prepare('SELECT id FROM features WHERE title = ?').get(f.title);
  if (existing) return existing.id;
  const r = db
    .prepare('INSERT INTO features (title, description, area, source, priority, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
    .run(f.title, f.description || '', f.area || null, f.source || 'research', f.priority ?? 50, 'pending', now(), now());
  return Number(r.lastInsertRowid);
}

export const listFeatures = ({ status, limit = 100 } = {}) => {
  const sql = status
    ? 'SELECT * FROM features WHERE status = ? ORDER BY priority DESC, id DESC LIMIT ?'
    : "SELECT * FROM features ORDER BY (status = 'pending') DESC, priority DESC, id DESC LIMIT ?";
  return (status ? db.prepare(sql).all(status, limit) : db.prepare(sql).all(limit)).map(rowToFeat);
};

export const countFeaturesByStatus = () => {
  const out = { pending: 0, in_progress: 0, done: 0, deferred: 0 };
  for (const r of db.prepare('SELECT status, COUNT(*) n FROM features GROUP BY status').all()) out[r.status] = r.n;
  return out;
};

/** The same correction on the feature side, where `priority DESC, failures ASC` had the same flaw. */
export const pickFeatures = (n) =>
  db
    .prepare(
      `SELECT * FROM features WHERE status = 'pending'
        ORDER BY (priority * 1.0) / (1 + failures * failures) DESC, id DESC LIMIT ?`,
    )
    .all(n)
    .map(rowToFeat);

export const setFeatureStatus = (id, status) =>
  db.prepare('UPDATE features SET status = ?, updated_at = ? WHERE id = ?').run(status, now(), id);

export const setFeaturePriority = (id, priority) =>
  db.prepare('UPDATE features SET priority = ?, updated_at = ? WHERE id = ?').run(Math.min(100, Math.max(1, priority)), now(), id);

export const deleteFeature = (id) => db.prepare('DELETE FROM features WHERE id = ?').run(id).changes;

/**
 * Wipe the pending backlog so it can be rebuilt from a real analysis of the code.
 *
 * The old backlog was generated by a web-research phase that invented marketplace
 * features from its imagination — none grounded in what this repository actually
 * contains. Keeping them is worse than starting over: they poison every plan. This
 * clears the pending ones (done/in-progress history is preserved). Optionally scoped
 * to a source, so "reset the research fantasies but keep what I added by hand" works.
 */
export function resetBacklog({ source = null, keepOperator = true } = {}) {
  let sql = "DELETE FROM features WHERE status = 'pending'";
  const args = [];
  if (source) {
    sql += ' AND source = ?';
    args.push(source);
  } else if (keepOperator) {
    sql += " AND source != 'operator'";
  }
  return db.prepare(sql).run(...args).changes;
}

/**
 * LEAKED CLAIMS — why a healthy-looking backlog stops producing sensible work.
 *
 * A run claims what it is about to work on: functions become `improving`, features `in_progress`
 * (engine.js). Finishing releases them. Being interrupted does not — and interruptions are the
 * single most common way a run ends here.
 *
 * `pickFeatures` only ever selects `pending`, so every interrupted run permanently shrinks the pool
 * the planner chooses from. Measured on this database after 435 runs: 67 of 160 features and 149
 * functions sat claimed with no run behind them, leaving the planner **2 pending features**. It did
 * not start proposing nonsense — it ran out of anything to propose, and fell back to micro-edits on
 * whatever was left, which is what produced the run of "the implementer produced no edits" failures.
 *
 * These two functions expose that state and hand it back.
 */
export function backlogClaims() {
  const feats = db.prepare("SELECT COUNT(*) n FROM features WHERE status = 'in_progress'").get().n;
  const fns = db.prepare("SELECT COUNT(*) n FROM functions WHERE status = 'improving'").get().n;
  const running = db.prepare("SELECT COUNT(*) n FROM iterations WHERE status = 'running'").get().n;
  return { features: feats, functions: fns, total: feats + fns, running };
}

/**
 * Hand every claimed item back to the pool.
 *
 * Refuses while a run is in progress: that run holds real claims, and releasing them would let the
 * next plan pick the same targets and edit the same files concurrently. `force` is for the case
 * where a crashed run left the row marked `running` and nothing is actually executing.
 */
export function releaseStuckClaims({ force = false } = {}) {
  const before = backlogClaims();
  if (before.running && !force) return { released: 0, ...before, refused: 'a run is in progress' };
  const features = db.prepare("UPDATE features SET status = 'pending', updated_at = ? WHERE status = 'in_progress'").run(now()).changes;
  const functions = db.prepare("UPDATE functions SET status = 'pending', updated_at = ? WHERE status = 'improving'").run(now()).changes;
  return { released: features + functions, features, functions, refused: null };
}

/** Total iterations ever run — drives the "survey every N runs" cadence. */
export const totalIterations = () => db.prepare('SELECT COUNT(*) n FROM iterations').get().n;

export const markFeatureDone = (id, iter) =>
  db.prepare("UPDATE features SET status = 'done', failures = 0, done_iter = ?, updated_at = ? WHERE id = ?").run(iter, now(), id);

export function bumpFeatureFailure(id, iter, reason) {
  db.prepare("UPDATE features SET failures = failures + 1, status = 'pending', last_reason = ?, updated_at = ? WHERE id = ?").run((reason || '').slice(0, 240), now(), id);
}

/**
 * Charge one failed run to the targets its tasks were working on, and retire the hopeless ones.
 *
 * Extracted from the engine's catch block so it can be TESTED. The arithmetic below was correct and
 * complete for months while nothing called it — a mechanism that only runs inside a `catch` in a
 * 900-line function is one nobody can exercise, and that is precisely how it stayed dead. A test
 * pinning the pieces would not have noticed; a test pinning this entry point would.
 *
 * @param {Array}  tasks     the batch's tasks (each may carry functionId / featureId)
 * @param {number} iteration the run id, recorded as `last_iter`
 * @param {string} reason    why it failed, kept on the feature for the operator
 * @param {Set}    skip      targets already closed as satisfied — reopening them would undo that
 * @returns {{charged:number, deferred:{features:number, functions:number}}}
 */
export function chargeFailureToTargets(tasks = [], iteration = null, reason = '', skip = new Set()) {
  let charged = 0;
  for (const t of tasks) {
    if (t?.functionId && !skip.has(`fn:${t.functionId}`)) { bumpFunctionFailure(t.functionId, iteration); charged++; }
    if (t?.featureId && !skip.has(`ft:${t.featureId}`)) { bumpFeatureFailure(t.featureId, iteration, reason); charged++; }
  }
  return { charged, deferred: autoDeferFailing() };
}

/** After 3 failures an item stops blocking the queue. */
export function autoDeferFailing() {
  const f = db.prepare("UPDATE features SET status = 'deferred', updated_at = ? WHERE failures >= 3 AND status = 'pending'").run(now()).changes;
  const fn = db.prepare("UPDATE functions SET status = 'deferred', updated_at = ? WHERE failures >= 3 AND status = 'pending'").run(now()).changes;
  return { features: f, functions: fn };
}

/* ------------------------------ iterations -------------------------------- */

const rowToIter = (r, { withDiff = false } = {}) => ({
  id: r.id,
  status: r.status,
  trigger: r.trigger,
  planTitle: r.plan_title,
  // The full plan JSON (every task, its steps, files, acceptance) is only read on the
  // detail view — sending it for 15 iterations on every /api/state refetch was tens of
  // KB of dead weight. Ships with the detail (withDiff), which is fetched by id.
  ...(withDiff ? { plan: P(r.plan_json) } : {}),
  scores: {
    review: r.review_score,
    security: r.security_score,
    regression: r.regression_score,
    test: r.test_score,
    workbench: r.workbench_score,
    total: r.total_score,
  },
  /*
   * The verdicts of the two gates that judge rather than score.
   *
   * A one-line summary always — it is what a Runs row needs, and it is the difference between
   * "coverage was low on this run" and "the gate never ran here", which look identical when the
   * field is simply absent. The full breakdown (which lines were missed, which suites were
   * compared) rides with the detail fetch, for the same reason `plan_json` does: sending it for
   * every row of every /api/state refetch is tens of KB nobody reads.
   */
  gates: {
    behaviour: summarise(r.behaviour_json, (b) => ({ checked: b.checked, veto: b.veto, summary: b.summary })),
    coverage: summarise(r.coverage_json, (c) => ({
      applicable: c.applicable, pct: c.pct, executable: c.executable,
      mode: c.mode, pass: c.verdict?.pass, reason: c.applicable ? undefined : c.reason,
    })),
  },
  ...(withDiff
    ? { gateDetail: { behaviour: P(r.behaviour_json), coverage: P(r.coverage_json) } }
    : {}),
  filesChanged: r.files_changed,
  additions: r.additions,
  deletions: r.deletions,
  improvements: r.improvements,
  featuresDone: r.features_done,
  baseCommit: r.base_commit,
  commitSha: r.commit_sha,
  branch: r.branch,
  rolledBack: !!r.rolled_back,
  error: r.error,
  // Why it failed, and what a restart would do about it.
  failure: r.failure_kind
    ? {
        kind: r.failure_kind,
        code: r.failure_code,
        title: r.failure_title,
        explanation: r.failure_explanation,
        remedy: r.failure_remedy,
        resumeFrom: r.resume_from,
      }
    : null,
  resumable: !!r.resumable,
  restartOf: r.restart_of,
  restarts: r.restarts,
  isolation: (() => { try { return JSON.parse(r.isolation || 'null'); } catch { return null; } })(),
  waves: P(r.waves_json),
  parallelSavedMs: r.parallel_saved_ms,
  tokensIn: r.tokens_in,
  tokensOut: r.tokens_out,
  startedAt: r.started_at,
  finishedAt: r.finished_at,
  durationMs: r.finished_at ? r.finished_at - r.started_at : null,
  ...(withDiff ? { diff: r.diff, pendingDiff: r.pending_diff } : {}),
});

export function startIteration(trigger = 'loop', baseCommit = null, restartOf = null) {
  const r = db
    .prepare('INSERT INTO iterations (status, trigger, base_commit, restart_of, started_at) VALUES (?, ?, ?, ?, ?)')
    .run('running', trigger, baseCommit, restartOf, now());
  return Number(r.lastInsertRowid);
}

export function updateIteration(id, patch) {
  const map = {
    status: 'status', planTitle: 'plan_title', planJson: 'plan_json', researchJson: 'research_json',
    reviewScore: 'review_score', securityScore: 'security_score', regressionScore: 'regression_score',
    testScore: 'test_score', workbenchScore: 'workbench_score', totalScore: 'total_score',
    filesChanged: 'files_changed',
    additions: 'additions', deletions: 'deletions', diff: 'diff', improvements: 'improvements',
    featuresDone: 'features_done', commitSha: 'commit_sha', branch: 'branch', rolledBack: 'rolled_back',
    error: 'error', tokensIn: 'tokens_in', tokensOut: 'tokens_out', finishedAt: 'finished_at',
    failureKind: 'failure_kind', failureCode: 'failure_code', failureTitle: 'failure_title',
    failureExplanation: 'failure_explanation', failureRemedy: 'failure_remedy',
    resumeFrom: 'resume_from', resumable: 'resumable', pendingDiff: 'pending_diff',
    restarts: 'restarts', wavesJson: 'waves_json', parallelSavedMs: 'parallel_saved_ms',
    isolation: 'isolation', behaviourJson: 'behaviour_json', coverageJson: 'coverage_json',
  };
  const sets = [];
  const vals = [];
  for (const [k, col] of Object.entries(map)) {
    if (k in patch) {
      sets.push(`${col} = ?`);
      vals.push(typeof patch[k] === 'boolean' ? (patch[k] ? 1 : 0) : patch[k]);
    }
  }
  if (!sets.length) return;
  db.prepare(`UPDATE iterations SET ${sets.join(', ')} WHERE id = ?`).run(...vals, id);
}

export const getIteration = (id, opts) => {
  const r = db.prepare('SELECT * FROM iterations WHERE id = ?').get(id);
  return r ? rowToIter(r, opts) : null;
};

export const listIterations = (limit = 40) =>
  db.prepare('SELECT * FROM iterations ORDER BY id DESC LIMIT ?').all(limit).map((r) => rowToIter(r));

export const countTodayIterations = () => {
  const dayStart = new Date();
  dayStart.setHours(0, 0, 0, 0);
  return db.prepare('SELECT COUNT(*) n FROM iterations WHERE started_at >= ?').get(dayStart.getTime()).n;
};

/**
 * An iteration that was still 'running' when the server died was, by definition,
 * interrupted — not wrong. Mark it as such (and resumable, if it had produced a
 * diff) so the operator can pick it straight back up instead of losing the work.
 */
export const reapStaleIterations = () => {
  const changes = db
    .prepare(
      `UPDATE iterations SET
         status = 'interrupted',
         error = 'the server stopped while this iteration was running',
         failure_kind = 'interruption',
         failure_code = 'server_restart',
         failure_title = 'Interrupted — the server stopped mid-run',
         failure_explanation = 'The agent server was stopped or crashed while this iteration was in flight. Nothing is known to be wrong with the work it had done; it simply never finished.',
         failure_remedy = 'Restart it: the edits it had already produced are replayed into a fresh sandbox and the run continues.',
         -- Resume where it actually stopped, not from the top. The phase that was still 'running'
         -- when the process died is the one that never finished; every phase before it DID finish,
         -- against the very diff a restart replays, so re-running them buys nothing but GPU time.
         -- Falling back to 'implement' meant a run cut short during, say, tests threw away its
         -- review and security passes as well. The engine ignores a phase it cannot resume from,
         -- so a bad value here costs nothing.
         resume_from = COALESCE(
           resume_from,
           (SELECT p.phase FROM phases p WHERE p.iteration_id = iterations.id AND p.status = 'running' ORDER BY p.id DESC LIMIT 1),
           'implement'),
         resumable = CASE WHEN files_changed > 0 THEN 1 ELSE 0 END,
         finished_at = ?
       -- A run that already has a commit LANDED; it is not interrupted work, whatever its status
       -- column still said when the process died. Claiming it here is what would let the salvage
       -- path replay a diff that is already on the branch and commit it a second time.
       WHERE status = 'running' AND (commit_sha IS NULL OR commit_sha = '')`,
    )
    .run(now()).changes;

  // Those landed-but-unrecorded runs get the status they earned instead.
  const rescued = db
    .prepare(
      `UPDATE iterations SET status = 'committed', resumable = 0, finished_at = COALESCE(finished_at, ?)
       WHERE status = 'running' AND commit_sha IS NOT NULL AND commit_sha <> ''`,
    )
    .run(now()).changes;
  if (rescued) {
    // Worth saying out loud: it means a process died between the commit and its bookkeeping.
    // eslint-disable-next-line no-console
    console.warn(`[reaper] ${rescued} iteration(s) had committed before the server stopped — recorded as committed, not interrupted`);
  }

  // A phase row left 'running' by a dead process would spin forever in the Runs board. It is
  // closed AFTER the statement above, which reads it to decide where to resume.
  if (changes) {
    db.prepare(
      `UPDATE phases SET status = 'interrupted', summary = COALESCE(summary, 'cut short — the server stopped'), finished_at = ?
       WHERE status = 'running'`,
    ).run(now());
  }
  return changes;
};

/** Persist the triage verdict for a failed iteration. */
export function recordFailure(id, verdict, pendingDiff = null) {
  updateIteration(id, {
    failureKind: verdict.kind,
    failureCode: verdict.code,
    failureTitle: verdict.title,
    failureExplanation: verdict.explanation,
    failureRemedy: verdict.remedy,
    resumeFrom: verdict.resumeFrom,
    resumable: verdict.resumable ? 1 : 0,
    ...(pendingDiff ? { pendingDiff } : {}),
  });
}

/** Iterations the operator could restart right now, newest first. */
export const listRestartable = (limit = 20) =>
  db
    .prepare(
      `SELECT * FROM iterations
       WHERE status IN ('error', 'interrupted', 'rolled_back', 'empty')
         AND resumable = 1
       ORDER BY id DESC LIMIT ?`,
    )
    .all(limit)
    .map((r) => rowToIter(r));

/**
 * Interrupted work the loop should pick back up on its own, newest first.
 *
 * This is deliberately NARROWER than `listRestartable`. That list is what the operator may choose
 * to resume, judgement included; this one is what the loop may resume with no judgement at all, so
 * every condition here exists to make an unattended restart safe:
 *
 *   - `failure_code = 'server_restart'` — only work the stale-iteration reaper marked. A run that
 *     was JUDGED and rejected must never be re-run unattended: that is how a bad change gets
 *     retried forever. Only "nobody finished looking at this" qualifies.
 *   - `files_changed > 0` and a stored diff — without real work to replay there is nothing to
 *     salvage, and a fresh plan is strictly better than replaying nothing.
 *   - `restarts < 2` — the restart counter is written BEFORE the run starts, so it survives even a
 *     hard crash. If a run has already taken two attempts, it is the likely cause of the crash and
 *     stops being eligible. This is the crash-loop brake.
 *   - no successor — a run someone already restarted (by hand or by loop) is spoken for. Without
 *     this the same interrupted run would be salvaged again after every single restart.
 */
export const listSalvageable = (limit = 1) =>
  db
    .prepare(
      `SELECT * FROM iterations i
       WHERE i.status = 'interrupted'
         AND i.failure_code = 'server_restart'
         AND i.resumable = 1
         AND i.files_changed > 0
         AND i.restarts < 2
         AND i.pending_diff IS NOT NULL AND i.pending_diff <> ''
         -- Belt and braces with the reaper's own guard: work that already produced a commit is on
         -- the branch, and replaying its diff would commit it twice.
         AND (i.commit_sha IS NULL OR i.commit_sha = '')
         AND NOT EXISTS (SELECT 1 FROM iterations c WHERE c.restart_of = i.id)
       ORDER BY i.id DESC LIMIT ?`,
    )
    .all(limit)
    .map((r) => rowToIter(r));

/** The stored diff a restart replays into its fresh sandbox. */
export const getPendingDiff = (id) =>
  db.prepare('SELECT pending_diff FROM iterations WHERE id = ?').get(id)?.pending_diff || null;

/**
 * Runs that ended badly and are not yet cleared: error, interrupted, empty or
 * rolled_back. Each carries a task breakdown so the Runs board can show, at a
 * glance, how much of the plan landed vs failed. Newest first.
 */
export function listProblemRuns({ status = null, limit = 60 } = {}) {
  const states = status ? [status] : ['error', 'interrupted', 'empty', 'rolled_back'];
  const placeholders = states.map(() => '?').join(',');
  const rows = db
    .prepare(
      `SELECT * FROM iterations
       WHERE status IN (${placeholders}) AND COALESCE(dismissed, 0) = 0
       ORDER BY id DESC LIMIT ?`,
    )
    .all(...states, limit);

  const taskAgg = db.prepare(
    "SELECT status, COUNT(*) n FROM tasks WHERE iteration_id = ? GROUP BY status",
  );
  return rows.map((r) => {
    const it = rowToIter(r);
    const counts = { done: 0, failed: 0, pending: 0, running: 0 };
    for (const t of taskAgg.all(r.id)) counts[t.status] = t.n;
    return {
      ...it,
      taskCounts: counts,
      totalTasks: counts.done + counts.failed + counts.pending + counts.running,
    };
  });
}

/** How many problem runs are on the board — for the nav badge. */
export const countProblemRuns = () =>
  db
    .prepare(
      "SELECT COUNT(*) n FROM iterations WHERE status IN ('error','interrupted','empty','rolled_back') AND COALESCE(dismissed,0) = 0",
    )
    .get().n;

/** Clear a run from the board (it stays in history, just hidden from the Runs view). */
export const dismissRun = (id) => db.prepare('UPDATE iterations SET dismissed = 1 WHERE id = ?').run(id).changes;
export const dismissAllProblemRuns = () =>
  db
    .prepare(
      "UPDATE iterations SET dismissed = 1 WHERE status IN ('error','interrupted','empty','rolled_back') AND COALESCE(dismissed,0) = 0",
    )
    .run().changes;

/* -------------------------------- phases ---------------------------------- */

export function startPhase(iterationId, phase) {
  const r = db.prepare('INSERT INTO phases (iteration_id, phase, status, started_at) VALUES (?, ?, ?, ?)').run(iterationId, phase, 'running', now());
  return Number(r.lastInsertRowid);
}

export function finishPhase(id, status, summary, result, score = null) {
  db.prepare('UPDATE phases SET status = ?, summary = ?, result = ?, score = ?, finished_at = ? WHERE id = ?').run(
    status, (summary || '').slice(0, 500), result ? J(result) : null, score, now(), id,
  );
}

export const listPhases = (iterationId) =>
  db.prepare('SELECT * FROM phases WHERE iteration_id = ? ORDER BY id').all(iterationId).map((r) => ({
    id: r.id,
    phase: r.phase,
    status: r.status,
    score: r.score,
    summary: r.summary,
    result: P(r.result),
    startedAt: r.started_at,
    finishedAt: r.finished_at,
    durationMs: r.finished_at ? r.finished_at - r.started_at : null,
  }));

/* --------------------------------- tasks ---------------------------------- */

export function startTask(iterationId, t) {
  const r = db
    .prepare(
      'INSERT INTO tasks (iteration_id, kind, title, rationale, function_id, feature_id, files, steps, agent, wave, area, status, started_at) ' +
        'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    )
    .run(
      iterationId, t.kind, t.title, t.rationale || '', t.functionId || null, t.featureId || null,
      J(t.files || []), J(t.steps || []), t.agent || null, t.wave ?? null, t.area || null, 'pending', now(),
    );
  return Number(r.lastInsertRowid);
}

export function finishTask(id, status, summary, filesChanged, error = null) {
  db.prepare('UPDATE tasks SET status = ?, summary = ?, files_changed = ?, error = ?, finished_at = ? WHERE id = ?').run(
    status, (summary || '').slice(0, 400), J(filesChanged || []), error ? String(error).slice(0, 400) : null, now(), id,
  );
}

export const markTaskRunning = (id) => db.prepare("UPDATE tasks SET status = 'running' WHERE id = ?").run(id);

export const listTasks = (iterationId) =>
  db.prepare('SELECT * FROM tasks WHERE iteration_id = ? ORDER BY id').all(iterationId).map((r) => ({
    id: r.id,
    kind: r.kind,
    title: r.title,
    rationale: r.rationale,
    status: r.status,
    agent: r.agent,
    wave: r.wave,
    area: r.area,
    files: P(r.files, []),
    steps: P(r.steps, []),
    filesChanged: P(r.files_changed, []),
    summary: r.summary,
    error: r.error,
  }));

/* ------------------------------ notifications ----------------------------- */

export function notify({ kind, severity = 'info', title, body = null, link = null }) {
  const r = db.prepare('INSERT INTO notifications (ts, kind, severity, title, body, link) VALUES (?, ?, ?, ?, ?, ?)').run(now(), kind, severity, title, body, link);
  return Number(r.lastInsertRowid);
}

/**
 * Notify unless the same title already appeared recently.
 *
 * A control that fires on every loop tick — a budget stop, a refused egress call — would otherwise
 * bury the feed under thousands of identical rows, which destroys the one property that makes the
 * feed worth having: that nothing important scrolls away. The event is still recorded in full by the
 * audit chain and the egress ledger; this governs only how often a HUMAN is told about it.
 *
 * @returns {number|null} the new notification id, or null when suppressed as a duplicate
 */
export function notifyOnce({ windowMs = 15 * 60_000, ...n }) {
  const since = now() - windowMs;
  const dup = db.prepare('SELECT id FROM notifications WHERE title = ? AND ts >= ? LIMIT 1').get(n.title, since);
  if (dup) return null;
  return notify(n);
}

export const listNotifications = (limit = 50) =>
  db.prepare('SELECT * FROM notifications ORDER BY id DESC LIMIT ?').all(limit).map((r) => ({
    id: r.id, ts: r.ts, kind: r.kind, severity: r.severity, title: r.title, body: r.body, link: r.link, read: !!r.read,
  }));

export const markNotificationsRead = () => db.prepare('UPDATE notifications SET read = 1 WHERE read = 0').run().changes;
export const countUnreadNotifications = () => db.prepare('SELECT COUNT(*) n FROM notifications WHERE read = 0').get().n;

/* ----------------------------- golden surface ----------------------------- */

export function saveGoldenSurface(surface, commitSha) {
  db.prepare('INSERT INTO golden_surface (id, surface, taken_at, commit_sha) VALUES (1, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET surface = excluded.surface, taken_at = excluded.taken_at, commit_sha = excluded.commit_sha').run(J(surface), now(), commitSha);
}

export const getGoldenSurface = () => {
  const r = db.prepare('SELECT * FROM golden_surface WHERE id = 1').get();
  return r ? { surface: P(r.surface, []), takenAt: r.taken_at, commitSha: r.commit_sha } : null;
};
