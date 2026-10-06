import { test, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import '../src/db_iteration.js';
import { openProjectDb, initCoreSchema, db } from '../src/db.js';
import { addFeature, backlogClaims, pickFeatures, releaseStuckClaims, setFeatureStatus } from '../src/db_iteration.js';

/**
 * LEAKED CLAIMS STARVE THE PLANNER.
 *
 * A run marks what it is about to work on: features become `in_progress`, functions `improving`.
 * Finishing releases them; being interrupted does not — and interruption is how 134 of 435 runs on
 * the real database ended. `pickFeatures` selects only `pending`, so each interrupted run
 * permanently removes its targets from consideration.
 *
 * Measured before this was fixed: 67 of 160 features and 149 functions were reserved by runs that
 * had ended, leaving the planner **two** features to choose between. The symptom an operator sees
 * is not an empty backlog — the counts still look busy — but a stream of runs ending in "the
 * implementer produced no edits", because there was nothing substantial left to propose.
 */

before(() => {
  const dbFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'isl-claims-')), 'p.sqlite');
  openProjectDb(dbFile);
  initCoreSchema();
});

beforeEach(() => {
  db.exec('DELETE FROM features; DELETE FROM functions; DELETE FROM iterations;');
});

const seedFunction = (name, status) =>
  db
    .prepare('INSERT INTO functions (path, name, kind, signature, start_line, loc, complexity, fan_in, todos, weight, status, updated_at) VALUES (?, ?, ?, ?, 0, 0, 0, 0, 0, 10, ?, 0)')
    .run(`src/${name}.js`, name, 'function', '()', status);

test('counts what is reserved but has no run behind it', () => {
  const a = addFeature({ title: 'claimed feature' });
  addFeature({ title: 'free feature' });
  setFeatureStatus(a, 'in_progress');
  seedFunction('claimed', 'improving');
  seedFunction('free', 'pending');

  const claims = backlogClaims();
  assert.equal(claims.features, 1);
  assert.equal(claims.functions, 1);
  assert.equal(claims.total, 2);
  assert.equal(claims.running, 0);
});

test('a claimed feature is invisible to the planner until it is handed back', () => {
  const stuck = addFeature({ title: 'stuck' });
  setFeatureStatus(stuck, 'in_progress');

  // This is the starvation: the item exists, the count says "in progress", and the planner cannot
  // see it. With enough of them the planner runs out of anything to propose.
  assert.deepEqual(pickFeatures(10).map((f) => f.title), []);

  const released = releaseStuckClaims();
  assert.equal(released.released, 1);
  assert.deepEqual(pickFeatures(10).map((f) => f.title), ['stuck']);
});

test('hands back features and functions together and reports each', () => {
  const a = addFeature({ title: 'f1' });
  const b = addFeature({ title: 'f2' });
  setFeatureStatus(a, 'in_progress');
  setFeatureStatus(b, 'in_progress');
  seedFunction('x', 'improving');

  const r = releaseStuckClaims();
  assert.equal(r.features, 2);
  assert.equal(r.functions, 1);
  assert.equal(r.released, 3);
  assert.equal(backlogClaims().total, 0);
});

test('leaves finished and deferred work alone', () => {
  const done = addFeature({ title: 'done' });
  const deferred = addFeature({ title: 'deferred' });
  setFeatureStatus(done, 'done');
  setFeatureStatus(deferred, 'deferred');
  seedFunction('improved', 'improved');

  assert.equal(releaseStuckClaims().released, 0);
  // Releasing must not resurrect completed work as something to do again.
  assert.deepEqual(pickFeatures(10).map((f) => f.title), []);
});

test('refuses while a run is in progress, because those claims are real', () => {
  const a = addFeature({ title: 'being worked on right now' });
  setFeatureStatus(a, 'in_progress');
  db.prepare("INSERT INTO iterations (id, status, started_at) VALUES (1, 'running', 0)").run();

  const r = releaseStuckClaims();
  assert.equal(r.released, 0);
  assert.match(r.refused, /in progress/);
  // Handing these back would let the next plan pick the same targets and edit the same files.
  assert.deepEqual(pickFeatures(10).map((f) => f.title), []);

  // `force` exists for the case where a crash left the row marked running with nothing executing.
  assert.equal(releaseStuckClaims({ force: true }).released, 1);
});

test('is safe to run when there is nothing to release', () => {
  assert.equal(releaseStuckClaims().released, 0);
  assert.deepEqual(backlogClaims(), { features: 0, functions: 0, total: 0, running: 0 });
});
