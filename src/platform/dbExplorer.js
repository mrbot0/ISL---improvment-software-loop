import fs from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { PLATFORM_DB_PATH, projectDbPath } from '../config.js';
import { listProjects } from './projects.js';

/**
 * Read-only DATABASE EXPLORER for administrators. It lets an admin inspect every
 * SQLite database ISL keeps — the shared platform DB and each project's own DB —
 * without touching the live handles the app runs on. We open a SEPARATE read-only
 * connection per request (WAL makes concurrent readers safe), list tables, page
 * through rows, and run guarded SELECT-only queries. Nothing here can mutate data.
 */

const MAX_LIMIT = 500;

/** Every database the admin can browse: the platform DB + one per project. */
export function listDatabases() {
  const size = (p) => {
    try {
      return fs.statSync(p).size;
    } catch {
      return 0;
    }
  };
  const dbs = [{ id: 'platform', label: 'Platform (users, projects, sessions, audit)', path: PLATFORM_DB_PATH, exists: fs.existsSync(PLATFORM_DB_PATH), sizeBytes: size(PLATFORM_DB_PATH) }];
  for (const p of listProjects({ includeArchived: true })) {
    const path = projectDbPath(p.id);
    dbs.push({ id: `project:${p.id}`, label: `${p.name} — project data`, project: p.id, path, exists: fs.existsSync(path), sizeBytes: size(path) });
  }
  return dbs;
}

/** Resolve a database id ('platform' | 'project:<id>') to a file path we allow. */
function pathFor(dbId) {
  if (dbId === 'platform') return PLATFORM_DB_PATH;
  if (typeof dbId === 'string' && dbId.startsWith('project:')) {
    const id = dbId.slice('project:'.length);
    if (!listProjects({ includeArchived: true }).some((p) => p.id === id)) throw httpError(404, `Unknown project database: ${id}`);
    return projectDbPath(id);
  }
  throw httpError(400, `Unknown database: ${dbId}`);
}

function httpError(status, message) {
  const e = new Error(message);
  e.status = status;
  return e;
}

/** Open a read-only connection, run fn, always close. */
function withDb(dbId, fn) {
  const p = pathFor(dbId);
  if (!fs.existsSync(p)) throw httpError(404, 'That database file does not exist yet.');
  let db;
  try {
    db = new DatabaseSync(p, { readOnly: true });
  } catch {
    // Older node builds may not accept readOnly — fall back to a normal open (we only ever run SELECTs).
    db = new DatabaseSync(p);
  }
  try {
    return fn(db);
  } finally {
    try {
      db.close();
    } catch {
      /* ignore */
    }
  }
}

/** The tables in a database, each with its row count. */
export function listTables(dbId) {
  return withDb(dbId, (db) => {
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
      .all()
      .map((r) => r.name);
    return tables.map((name) => {
      let rows = 0;
      try {
        rows = db.prepare(`SELECT COUNT(*) n FROM "${name}"`).get().n;
      } catch {
        /* view or virtual table */
      }
      return { name, rows };
    });
  });
}

const isValidTable = (db, table) =>
  !!db.prepare("SELECT 1 FROM sqlite_master WHERE type IN ('table','view') AND name = ?").get(table);

/** A page of rows from one table, with its column definitions. Newest first when an id exists. */
export function readTable(dbId, table, { limit = 50, offset = 0 } = {}) {
  const lim = Math.min(MAX_LIMIT, Math.max(1, Number(limit) || 50));
  const off = Math.max(0, Number(offset) || 0);
  return withDb(dbId, (db) => {
    if (!isValidTable(db, table)) throw httpError(404, `Unknown table: ${table}`);
    const columns = db.prepare(`PRAGMA table_info("${table}")`).all().map((c) => ({ name: c.name, type: c.type, pk: !!c.pk }));
    const hasId = columns.some((c) => c.name === 'id');
    const total = db.prepare(`SELECT COUNT(*) n FROM "${table}"`).get().n;
    const rows = db.prepare(`SELECT * FROM "${table}" ORDER BY ${hasId ? '"id" DESC' : 'ROWID DESC'} LIMIT ? OFFSET ?`).all(lim, off);
    return { table, columns, rows: rows.map(clampRow), total, limit: lim, offset: off };
  });
}

// Big blobs (a 200KB diff, a full document body) would swamp the UI — clamp long
// text values for the grid; the admin can still page/scope to see specifics.
function clampRow(row) {
  const out = {};
  for (const [k, v] of Object.entries(row)) {
    out[k] = typeof v === 'string' && v.length > 2000 ? `${v.slice(0, 2000)}… (${v.length} chars)` : v;
  }
  return out;
}

/** Run an admin-supplied query — SELECT only, single statement, capped. */
export function runQuery(dbId, sql) {
  const q = String(sql || '').trim().replace(/;+\s*$/, '');
  if (!q) throw httpError(400, 'Empty query.');
  if (/;/.test(q)) throw httpError(400, 'Only a single statement is allowed.');
  if (!/^(select|with|pragma\s+table_info|explain)\b/i.test(q)) throw httpError(400, 'Only read-only SELECT / WITH / PRAGMA table_info / EXPLAIN queries are allowed.');
  if (/\b(attach|detach|insert|update|delete|drop|alter|create|replace|reindex|vacuum)\b/i.test(q)) throw httpError(400, 'That query contains a write/DDL keyword and was blocked.');
  return withDb(dbId, (db) => {
    const capped = /\blimit\b/i.test(q) ? q : `${q} LIMIT ${MAX_LIMIT}`;
    const rows = db.prepare(capped).all().map(clampRow);
    const columns = rows.length ? Object.keys(rows[0]) : [];
    return { rows, columns, count: rows.length, capped: capped !== q };
  });
}
