import crypto from 'node:crypto';

/**
 * TAMPER-EVIDENT HASH CHAIN (ISL_IMPROVE "Enterprise wave", P0).
 *
 * A shared, table-agnostic append-only chain. Each row commits to the previous row's hash, so any
 * later edit, deletion or reordering makes verification fail at the exact row where history was
 * changed. It is the mechanism behind both the egress ledger and the platform audit trail — one
 * implementation, because two copies of "is this history intact?" would eventually disagree, and the
 * copy that drifted would be the one quietly declaring a tampered log clean.
 *
 * It proves INTEGRITY, not secrecy: anyone who can write the database can still append. What they
 * cannot do is rewrite what is already there without it showing. For a change-control record that is
 * the property that matters — an auditor needs to know the log was not edited after the fact.
 *
 * Retention is part of the design, not an afterthought. A chain that can never be truncated grows
 * without bound and makes any retention policy break verification permanently, so `sealChain` records
 * the head hash before archiving rows and verification resumes from the seal. A gap with no seal
 * behind it is still reported as tampering.
 */

export const GENESIS = '0'.repeat(64);

export const chainHash = (prevHash, canonical) =>
  crypto.createHash('sha256').update(`${prevHash} ${canonical}`).digest('hex');

/**
 * The hash the next appended row must chain onto.
 * @param {object} db          a node:sqlite handle
 * @param {string} table
 * @param {string} [seals]     checkpoint table, consulted when every row has been archived
 */
export function headHash(db, table, seals = null) {
  const last = db.prepare(`SELECT row_hash FROM ${table} WHERE row_hash IS NOT NULL ORDER BY id DESC LIMIT 1`).get();
  if (last?.row_hash) return last.row_hash;
  if (seals) {
    const cp = db.prepare(`SELECT head_hash FROM ${seals} ORDER BY id DESC LIMIT 1`).get();
    if (cp?.head_hash) return cp.head_hash;
  }
  return GENESIS;
}

/**
 * Walk a chain and confirm every link.
 *
 * @param {object}   o
 * @param {object}   o.db
 * @param {string}   o.table
 * @param {function} o.canonical   row → the exact string that was hashed
 * @param {string}   [o.seals]     checkpoint table name, if this chain supports sealing
 * @returns {{ok, rows, head?, brokenAt?, reason?, sealedFrom?, unchainedLegacy?}}
 */
export function verifyChain({ db, table, canonical, seals = null }) {
  const all = db.prepare(`SELECT * FROM ${table} ORDER BY id ASC`).all();
  // Rows written before chaining was introduced carry no hash. They are reported, never silently
  // counted as verified — "we started proving integrity on this date" is an honest answer; implying
  // the whole history is covered is not.
  const legacy = all.filter((r) => !r.row_hash).length;
  const rows = all.filter((r) => r.row_hash);

  if (!rows.length) {
    const cp = seals ? db.prepare(`SELECT * FROM ${seals} ORDER BY id DESC LIMIT 1`).get() : null;
    return { ok: true, rows: 0, head: cp?.head_hash || GENESIS, sealedFrom: cp?.up_to_id ?? null, unchainedLegacy: legacy };
  }

  let prevHash = GENESIS;
  let sealedFrom = null;
  const first = rows[0];
  if (first.prev_hash !== GENESIS) {
    const cp = seals
      ? db.prepare(`SELECT * FROM ${seals} WHERE head_hash = ? ORDER BY id DESC LIMIT 1`).get(first.prev_hash)
      : null;
    if (!cp) {
      return { ok: false, rows: rows.length, brokenAt: first.id, unchainedLegacy: legacy,
        reason: 'rows before this one were removed without a sealed checkpoint' };
    }
    prevHash = cp.head_hash;
    sealedFrom = cp.up_to_id;
  }

  for (const r of rows) {
    if (r.prev_hash !== prevHash) {
      return { ok: false, rows: rows.length, brokenAt: r.id, unchainedLegacy: legacy,
        reason: 'a row is missing or was reordered' };
    }
    if (chainHash(prevHash, canonical(r)) !== r.row_hash) {
      return { ok: false, rows: rows.length, brokenAt: r.id, unchainedLegacy: legacy,
        reason: 'row contents were altered after the fact' };
    }
    prevHash = r.row_hash;
  }
  return { ok: true, rows: rows.length, head: prevHash, sealedFrom, unchainedLegacy: legacy };
}

/**
 * Seal a chain up to `upToId` and archive everything at or before it.
 *
 * Refuses on a chain that does not verify: sealing a tampered history would launder it into a
 * trusted checkpoint, which is the one thing this mechanism must never permit.
 */
export function sealChain({ db, table, seals, canonical, upToId = null, actor = 'system', note = null, now = Date.now() }) {
  const check = verifyChain({ db, table, canonical, seals });
  if (!check.ok) return { sealed: false, reason: `the chain does not verify (${check.reason}) — refusing to seal a tampered history` };

  const target = upToId
    ? db.prepare(`SELECT * FROM ${table} WHERE id <= ? AND row_hash IS NOT NULL ORDER BY id DESC LIMIT 1`).get(upToId)
    : db.prepare(`SELECT * FROM ${table} WHERE row_hash IS NOT NULL ORDER BY id DESC LIMIT 1`).get();
  if (!target) return { sealed: false, reason: 'no chained rows to seal' };

  const covered = db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE id <= ?`).get(target.id)?.n || 0;
  db.prepare(`INSERT INTO ${seals} (sealed_at, up_to_id, rows, head_hash, actor, note) VALUES (?,?,?,?,?,?)`)
    .run(now, target.id, covered, target.row_hash, actor, note);
  const res = db.prepare(`DELETE FROM ${table} WHERE id <= ?`).run(target.id);

  return { sealed: true, upToId: target.id, archived: Number(res.changes), headHash: target.row_hash };
}

/** The DDL for a checkpoint table, so every chain's seals have the same shape. */
export const checkpointDDL = (name) => `
CREATE TABLE IF NOT EXISTS ${name} (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  sealed_at  INTEGER NOT NULL,
  up_to_id   INTEGER NOT NULL,
  rows       INTEGER NOT NULL,
  head_hash  TEXT NOT NULL,
  actor      TEXT,
  note       TEXT
);`;
