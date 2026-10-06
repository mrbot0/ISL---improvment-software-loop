import { test, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import '../src/db_iteration.js';
import { openProjectDb, initCoreSchema, db } from '../src/db.js';
import { addFeature, bumpFeatureFailure, pickFeatures, pickFunctionsToImprove } from '../src/db_iteration.js';

/**
 * WHY THE PLANNER KEPT PROPOSING THE SAME FAILING WORK.
 *
 * The candidate order was `weight DESC, failures ASC`. That makes failure a TIE-BREAK: it separates
 * two candidates of identical weight and nothing else, and weight is a wide continuous score, so it
 * separated nothing at all. A heavy target that failed was set back to `pending` by
 * `bumpFunctionFailure` and returned to the top of the very next batch, unchanged.
 *
 * Measured on the real database: `removeUser` in Admin.jsx, weight 238, planned in runs #437, #438,
 * #439 and #440 under near-identical titles, failing every time. Across 1644 catalogued functions
 * only 23 carried a single recorded failure — the signal existed and did nothing.
 *
 * Two corrections, pinned here: failures divide the weight, and a recent failure is skipped outright
 * so the next batch cannot retry it with exactly the information that already failed.
 */

before(() => {
  const dbFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'isl-pick-')), 'p.sqlite');
  openProjectDb(dbFile);
  initCoreSchema();
});

beforeEach(() => {
  db.exec('DELETE FROM functions; DELETE FROM features;');
});

const fn = (name, { weight, failures = 0, lastIter = null, status = 'pending' } = {}) =>
  db
    .prepare(
      `INSERT INTO functions (path, name, kind, signature, start_line, loc, complexity, fan_in, todos, weight, status, failures, last_iter, updated_at)
       VALUES (?, ?, 'function', '()', 0, 0, 1, 0, 0, ?, ?, ?, ?, 0)`,
    )
    .run(`src/${name}.js`, name, weight, status, failures, lastIter);

test('a heavy target that keeps failing sinks below untouched work', () => {
  // removeUser's real numbers: weight 238 with one failure, against ordinary weight-200 candidates.
  fn('removeUser', { weight: 238, failures: 1 });
  fn('untouched', { weight: 200, failures: 0 });

  const picked = pickFunctionsToImprove(2).map((f) => f.name);
  assert.deepEqual(picked, ['untouched', 'removeUser'], 'one failure must halve a candidate, not merely tie-break it');
});

test('weight still decides between candidates that have never failed', () => {
  fn('heavy', { weight: 300 });
  fn('light', { weight: 100 });
  assert.deepEqual(pickFunctionsToImprove(2).map((f) => f.name), ['heavy', 'light']);
});

test('repeated failure sinks a target further each time', () => {
  fn('once', { weight: 240, failures: 1 }); // 240/2  = 120
  fn('twice', { weight: 240, failures: 2 }); // 240/5  =  48
  fn('thrice', { weight: 240, failures: 3 }); // 240/10 =  24
  fn('clean', { weight: 130, failures: 0 }); // 130

  assert.deepEqual(pickFunctionsToImprove(4).map((f) => f.name), ['clean', 'once', 'twice', 'thrice']);
});

test('a target that failed in the last few runs is skipped entirely', () => {
  // The #437-#440 case: the failure of run 439 must not be retried by run 440 with the same inputs.
  fn('justFailed', { weight: 500, failures: 1, lastIter: 439 });
  fn('other', { weight: 100 });

  assert.deepEqual(pickFunctionsToImprove(2, { currentIter: 440 }).map((f) => f.name), ['other']);
});

test('the cooldown expires, so nothing is banned forever', () => {
  fn('failedLongAgo', { weight: 500, failures: 1, lastIter: 430 });
  fn('other', { weight: 100 });

  const picked = pickFunctionsToImprove(2, { currentIter: 440 }).map((f) => f.name);
  assert.ok(picked.includes('failedLongAgo'), 'a failure from ten runs ago is fair game again');
});

test('the cooldown does not touch work that has never failed', () => {
  // `last_iter` is also set by a SUCCESS, and succeeding must not exclude a function from the pool.
  fn('improvedRecently', { weight: 500, failures: 0, lastIter: 439 });
  assert.deepEqual(pickFunctionsToImprove(2, { currentIter: 440 }).map((f) => f.name), ['improvedRecently']);
});

test('without a current iteration the cooldown is inert rather than wrong', () => {
  fn('justFailed', { weight: 500, failures: 1, lastIter: 439 });
  assert.equal(pickFunctionsToImprove(2).length, 1);
});

test('only pending work is offered', () => {
  fn('claimed', { weight: 900, status: 'improving' });
  fn('done', { weight: 800, status: 'improved' });
  fn('free', { weight: 10 });
  assert.deepEqual(pickFunctionsToImprove(5).map((f) => f.name), ['free']);
});

test('features sink on failure the same way', () => {
  const hot = addFeature({ title: 'keeps failing', priority: 90 });
  addFeature({ title: 'never tried', priority: 60 });
  bumpFeatureFailure(hot, 100, 'did not compile');
  bumpFeatureFailure(hot, 101, 'did not compile');

  // 90/5 = 18 against 60: the one that has failed twice must not lead the batch again.
  assert.deepEqual(pickFeatures(2).map((f) => f.title), ['never tried', 'keeps failing']);
});
