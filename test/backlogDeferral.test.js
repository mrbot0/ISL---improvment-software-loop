import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import '../src/db_iteration.js';
import { openProjectDb, initCoreSchema, closeProjectDb, db } from '../src/db.js';
import { bumpFunctionFailure, bumpFeatureFailure, autoDeferFailing, pickFunctionsToImprove, chargeFailureToTargets } from '../src/db_iteration.js';

/**
 * A target that keeps failing has to stop being offered.
 *
 * The rule itself was never in doubt and the code implementing it was correct — it simply ran only
 * on the success path, so a vetoed run charged nothing to anything. Measured on a real repo:
 * `services/listings/src/hardening.js` failed the parse gate on **nine consecutive runs** while
 * every function in it still read `failures = 0`, and across 1639 functions exactly one had ever
 * reached the deferral threshold. Nine whole runs spent rediscovering the same broken change.
 *
 * These pin the arithmetic and the threshold. That the engine's failure path now performs it is a
 * separate wiring question, but without these the rule can regress silently — which is exactly how
 * it went unnoticed the first time.
 */

let dbFile;

before(() => {
  dbFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'isl-defer-')), 'p.sqlite');
  openProjectDb(dbFile);
  initCoreSchema();
});
after(() => {
  closeProjectDb();
  for (const s of ['', '-wal', '-shm']) { try { fs.rmSync(dbFile + s, { force: true }); } catch { /* held */ } }
});
beforeEach(() => {
  db.prepare('DELETE FROM functions').run();
  db.prepare('DELETE FROM features').run();
});

const addFn = (name, weight = 50) => Number(
  db.prepare("INSERT INTO functions (path, name, kind, weight, status, updated_at) VALUES (?, ?, 'function', ?, 'pending', ?)")
    .run(`src/${name}.js`, name, weight, Date.now()).lastInsertRowid,
);

const statusOf = (id) => db.prepare('SELECT status, failures FROM functions WHERE id = ?').get(id);

test('a failure raises the counter and leaves the target queued', () => {
  const id = addFn('a');
  bumpFunctionFailure(id, 1);
  // Field by field: `node:sqlite` returns null-prototype rows, which never deep-equal a literal.
  const row = statusOf(id);
  assert.equal(row.status, 'pending');
  assert.equal(row.failures, 1);
  // One bad run is not evidence of a hopeless target — the next attempt may well land it.
  assert.equal(autoDeferFailing().functions, 0);
});

test('THREE failures and it stops being offered', () => {
  const id = addFn('b');
  bumpFunctionFailure(id, 1);
  bumpFunctionFailure(id, 2);
  assert.equal(autoDeferFailing().functions, 0, 'two is still worth another try');
  bumpFunctionFailure(id, 3);
  assert.equal(autoDeferFailing().functions, 1);
  assert.equal(statusOf(id).status, 'deferred');
});

test('a deferred target is not handed out again', () => {
  // The point of the whole mechanism. `pickFunctionsToImprove` selects pending work; a deferred item must fall
  // out of it, or the queue keeps spending runs on something that has failed three times.
  const stuck = addFn('stuck', 99); // the highest weight — it would be picked first
  const fine = addFn('fine', 10);
  for (const i of [1, 2, 3]) bumpFunctionFailure(stuck, i);
  autoDeferFailing();

  const ids = pickFunctionsToImprove(5).map((t) => t.id);
  assert.ok(!ids.includes(stuck), 'a target that failed three times must not be offered again');
  assert.ok(ids.includes(fine));
});

test('a target that succeeds has its counter cleared', () => {
  // Two unrelated bad runs months apart must not add up to a permanent ban.
  const id = addFn('recovers');
  bumpFunctionFailure(id, 1);
  bumpFunctionFailure(id, 2);
  db.prepare("UPDATE functions SET status = 'improved', failures = 0 WHERE id = ?").run(id);
  assert.equal(statusOf(id).failures, 0);
  assert.equal(autoDeferFailing().functions, 0);
});

test('deferral never touches a target that is already improved', () => {
  const id = addFn('done');
  for (const i of [1, 2, 3]) bumpFunctionFailure(id, i);
  db.prepare("UPDATE functions SET status = 'improved' WHERE id = ?").run(id);
  assert.equal(autoDeferFailing().functions, 0, 'only pending work is deferred');
  assert.equal(statusOf(id).status, 'improved');
});

/*
 * THE ENTRY POINT, not just the arithmetic.
 *
 * Everything above pinned `bumpFunctionFailure` and `autoDeferFailing` — and both were already
 * correct while the feature was dead, because nothing called them. Tests on the pieces cannot
 * notice that. `chargeFailureToTargets` is what the engine's failure path actually invokes, and it
 * exists as a named function specifically so this can reach it: the logic used to live inline in a
 * catch block inside a 900-line function, where no test could.
 */
test('one failed run charges every target its tasks touched', () => {
  const a = addFn('a');
  const b = addFn('b');
  const out = chargeFailureToTargets(
    [{ functionId: a, title: 'x' }, { functionId: b, title: 'y' }],
    42,
    'parse veto — hardening.js does not compile',
  );
  assert.equal(out.charged, 2);
  assert.equal(statusOf(a).failures, 1);
  assert.equal(statusOf(b).failures, 1);
});

test('three failed runs on the same target retire it', () => {
  const id = addFn('repeat');
  for (const n of [1, 2]) {
    const out = chargeFailureToTargets([{ functionId: id }], n, 'parse veto');
    assert.equal(out.deferred.functions, 0, `run ${n} should not retire it yet`);
  }
  const third = chargeFailureToTargets([{ functionId: id }], 3, 'parse veto');
  assert.equal(third.deferred.functions, 1);
  assert.equal(statusOf(id).status, 'deferred');
});

test('a target already closed as satisfied is NOT reopened', () => {
  /*
   * `bumpFunctionFailure` sets the status back to `pending`. The run that discovers "nothing to do"
   * always ends in the failure path — there is no diff to commit — so without this skip the charge
   * would undo the very close that stops the task being reissued.
   */
  const id = addFn('satisfied');
  db.prepare("UPDATE functions SET status = 'improved' WHERE id = ?").run(id);
  const out = chargeFailureToTargets([{ functionId: id }], 7, 'nothing to do', new Set([`fn:${id}`]));
  assert.equal(out.charged, 0);
  assert.equal(statusOf(id).status, 'improved', 'a closed target must stay closed');
  assert.equal(statusOf(id).failures, 0);
});

test('a task with no backlog target charges nothing and does not throw', () => {
  // Exploratory tasks carry neither id. The accounting runs on every failed run, so it has to be
  // safe on them rather than take the run down with it.
  const out = chargeFailureToTargets([{ title: 'explore something' }, {}], 9, 'veto');
  assert.equal(out.charged, 0);
});

test('features follow the same rule and keep the reason', () => {
  const id = Number(
    db.prepare("INSERT INTO features (title, description, area, source, priority, status, created_at, updated_at) VALUES ('F', '', 'backend', 'research', 50, 'pending', ?, ?)")
      .run(Date.now(), Date.now()).lastInsertRowid,
  );
  for (const i of [1, 2, 3]) bumpFeatureFailure(id, i, 'parse veto — hardening.js does not compile');
  assert.equal(autoDeferFailing().features, 1);
  const row = db.prepare('SELECT status, failures, last_reason FROM features WHERE id = ?').get(id);
  assert.equal(row.status, 'deferred');
  assert.equal(row.failures, 3);
  // The reason has to survive: "deferred" with no explanation is not something an operator can act on.
  assert.match(row.last_reason, /parse veto/);
});
