/**
 * SCHEMA INTEGRITY: DOES THE MODEL STILL MATCH THE DATABASE?
 *
 * Prisma checks a model field against the real table only when a query runs. That single fact is
 * why a whole class of change gets past every gate this pipeline has: the schema file parses, it is
 * not JavaScript so nothing can vanish from its exports, no test suite covers it, and the service
 * BOOTS perfectly. The failure waits for the first production read.
 *
 * It has already happened here. Run #91 added `trustScore Int? @default(0)` to the `User` model in
 * the listings service — a model whose own comment says it is a read-only mirror of a table the
 * service does not own — and shipped no migration. Weeks later it surfaced as "business users have
 * disappeared": every `User` read from that service was asking Postgres for a column that has never
 * existed.
 *
 * `schemaGuard.js` catches the diff that introduces such a field. This catches the STATE — drift
 * that is already there, whatever produced it: a migration that failed halfway, a schema edited by
 * hand, a database restored from an older dump. Running it after every commit turns "we find out in
 * production" into "we find out in the run that caused it".
 *
 * STRICTLY READ-ONLY. It issues one `information_schema` SELECT and writes nothing — no DDL, no
 * migration, no edit to any `.prisma` file. A tool that repairs drift by altering either side would
 * be able to destroy exactly what it is here to protect.
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { REPO_ROOT } from '../config.js';
import { log } from '../logger.js';

const DOCKER = process.env.DOCKER_BIN || 'docker';

/** Prisma's scalar types. Anything else in type position is a relation to another model. */
const SCALAR = /^(String|Int|BigInt|Float|Decimal|Boolean|DateTime|Json|Bytes|Unsupported)$/;

const SKIP_DIR = new Set(['node_modules', 'dist', 'build', 'coverage']);

/**
 * Directories that hold a schema no longer bound to the live database.
 *
 * Measured on this repo: `backend/prisma_legacy_v1_archived/` holds the pre-migration schema, and
 * comparing it against today's database produces a dozen "missing table" findings that are all
 * correct and all meaningless. A check whose output is mostly noise is a check nobody reads, so the
 * rule is to trust the directory name — a folder that calls itself archived is telling the truth.
 */
const ARCHIVED = /(^|[_.-])(legacy|archive[d]?|backup|old|deprecated|snapshot)([_.-]|$)/i;

/** Every `.prisma` file under the repo, excluding vendored and generated trees. */
export function findSchemaFiles(root = REPO_ROOT, out = [], depth = 0) {
  if (depth > 6) return out;
  let entries;
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    // Dot directories are tooling, not product — `.git`, `.next`, and `.claude/worktrees`, which
    // holds full copies of the repo and would multiply every finding by the number of worktrees.
    if (e.name.startsWith('.')) continue;
    const full = path.join(root, e.name);
    if (e.isDirectory()) {
      if (SKIP_DIR.has(e.name) || ARCHIVED.test(e.name)) continue;
      findSchemaFiles(full, out, depth + 1);
    } else if (e.name.endsWith('.prisma')) {
      out.push(full);
    }
  }
  return out;
}

/**
 * Models and their scalar fields.
 *
 * Relations are skipped deliberately: `owner User @relation(...)` and `items Item[]` are virtual —
 * Prisma resolves them through foreign keys, and no column bears their name. Reporting them as
 * missing would bury the one real finding under a dozen false ones, which is how a check like this
 * ends up switched off.
 */
export function parsePrismaModels(src = '') {
  const models = [];
  for (const m of String(src).matchAll(/model\s+(\w+)\s*\{([\s\S]*?)\n\}/g)) {
    const [, name, body] = m;
    const mapped = /@@map\("([^"]+)"\)/.exec(body);
    const fields = [];
    for (const line of body.split('\n')) {
      const t = line.trim();
      if (!t || t.startsWith('//') || t.startsWith('@@')) continue;
      const f = /^(\w+)\s+(\w+)(\[\])?(\?)?\s*(.*)$/.exec(t);
      if (!f) continue;
      const [, field, type, isList, optional, rest] = f;
      if (isList || /@relation/.test(rest) || !SCALAR.test(type)) continue;
      // `@map("db_name")` renames the column; the database knows it by that name.
      const colMap = /@map\("([^"]+)"\)/.exec(rest);
      fields.push({ field, column: colMap ? colMap[1] : field, type, optional: !!optional });
    }
    models.push({ model: name, table: mapped ? mapped[1] : name, fields });
  }
  return models;
}

const run = (args, timeoutMs = 15_000) =>
  new Promise((resolve) => {
    execFile(DOCKER, args, { timeout: timeoutMs, windowsHide: true }, (err, stdout) => {
      resolve({ ok: !err, out: String(stdout || '').trim() });
    });
  });

/** The running Postgres container, found by image rather than by a name we would have to guess. */
export async function findPostgresContainer() {
  const r = await run(['ps', '--format', '{{.Names}}\t{{.Image}}']);
  if (!r.ok) return null;
  for (const line of r.out.split('\n').filter(Boolean)) {
    const [name, image = ''] = line.split('\t');
    if (/postgres|pgvector|timescale/i.test(image)) return name;
  }
  return null;
}

/**
 * Column names per table, straight from `information_schema`.
 *
 * One query, no DDL, no transaction. Credentials come from the container's own environment, so
 * nothing has to be configured here and no password is ever handled by ISL.
 */
export async function inspectDatabase(container) {
  const user = (await run(['exec', container, 'printenv', 'POSTGRES_USER'])).out || 'postgres';
  const dbName = (await run(['exec', container, 'printenv', 'POSTGRES_DB'])).out || user;
  const sql = "SELECT table_name || '\t' || column_name FROM information_schema.columns WHERE table_schema NOT IN ('pg_catalog','information_schema')";
  const r = await run(['exec', container, 'psql', '-U', user, '-d', dbName, '-tAc', sql], 25_000);
  if (!r.ok) return null;
  const tables = new Map();
  for (const line of r.out.split('\n').filter(Boolean)) {
    const [table, column] = line.split('\t');
    if (!table || !column) continue;
    if (!tables.has(table)) tables.set(table, new Set());
    tables.get(table).add(column);
  }
  return { database: dbName, tables };
}

/**
 * Compare every Prisma model in the repo against the live database.
 *
 * @returns {{checked:boolean, ok:boolean, reason?:string, database?:string,
 *            models:number, drift:Array, summary:string}}
 */
export async function checkSchemaIntegrity({ root = REPO_ROOT } = {}) {
  const files = findSchemaFiles(root);
  if (!files.length) {
    return { checked: false, ok: true, reason: 'no .prisma files in this project', models: 0, drift: [], summary: 'nothing to check' };
  }

  const container = await findPostgresContainer();
  if (!container) {
    // Not a failure: plenty of projects have no database running while ISL works on them. Saying
    // "unknown" beats reporting a clean bill of health nobody verified.
    return { checked: false, ok: true, reason: 'no Postgres container is running', models: 0, drift: [], summary: 'database not reachable — integrity unknown' };
  }

  const db = await inspectDatabase(container);
  if (!db) {
    return { checked: false, ok: true, reason: `could not read the schema of ${container}`, models: 0, drift: [], summary: 'database not readable — integrity unknown' };
  }

  const drift = [];
  let models = 0;
  for (const file of files) {
    let src;
    try {
      src = fs.readFileSync(file, 'utf8');
    } catch {
      continue;
    }
    const rel = path.relative(root, file).replace(/\\/g, '/');
    for (const m of parsePrismaModels(src)) {
      models++;
      const columns = db.tables.get(m.table);
      if (!columns) {
        // A model with no table is only a problem if the table should exist. Views, models bound to
        // another database and freshly-added models awaiting a migration all land here, so it is
        // reported at a lower severity than a column that is simply absent.
        drift.push({ file: rel, model: m.model, table: m.table, kind: 'missing_table', fields: [], severity: 'warn' });
        continue;
      }
      const missing = m.fields.filter((f) => !columns.has(f.column)).map((f) => f.column);
      if (missing.length) {
        drift.push({ file: rel, model: m.model, table: m.table, kind: 'missing_columns', fields: missing, severity: 'error' });
      }
    }
  }

  const errors = drift.filter((d) => d.severity === 'error');
  return {
    checked: true,
    ok: errors.length === 0,
    database: db.database,
    container,
    models,
    files: files.length,
    drift,
    summary: errors.length
      ? `${errors.length} model(s) name columns the database does not have: ${errors.map((d) => `${d.model}.${d.fields.join('/')}`).join(', ')}`
      : `${models} model(s) across ${files.length} schema file(s) match the database`,
  };
}

/**
 * The post-commit check. Logs, and returns the result for the caller to record and surface.
 * Never throws: a diagnostic that can fail a run it was only meant to observe is a liability.
 */
export async function verifyAfterCommit({ iterationId = null, commitSha = null } = {}) {
  const lg = log.for('schema');
  try {
    const r = await checkSchemaIntegrity();
    if (!r.checked) lg.debug(`schema integrity not checked: ${r.reason}`, { runId: iterationId });
    else if (r.ok) lg.info(`schema integrity after ${commitSha?.slice(0, 8) || 'commit'}: ${r.summary}`, { runId: iterationId });
    else lg.error(`schema drift after ${commitSha?.slice(0, 8) || 'commit'}: ${r.summary}`, { runId: iterationId });
    return r;
  } catch (err) {
    lg.warn(`schema integrity check errored: ${err.message}`, { runId: iterationId });
    return { checked: false, ok: true, reason: err.message, models: 0, drift: [], summary: 'check errored' };
  }
}
