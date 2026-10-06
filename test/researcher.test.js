import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import '../src/db_iteration.js';
import { openProjectDb, initCoreSchema, closeProjectDb } from '../src/db.js';
import { setActiveProjectConfig, REPO_ROOT } from '../src/config.js';
import { chooseTopics, usable, groundFiles, tooSimilar } from '../src/iteration/researcher.js';

/**
 * The filters that decide what research actually proposes.
 *
 * Every one of these is a way to waste a whole run. An idea with no build steps reaches the planner,
 * becomes tasks the implementer cannot ground, and the run ends "the implementer produced no edits".
 * An idea naming an invented file path is worse: it looks specific, survives review, and fails the
 * moment an agent tries to open it. And a filter that is too eager throws away good work silently,
 * which is why these test the passing cases as hard as the failing ones.
 */

let dir;
let dbFile;

before(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'isl-research-'));
  fs.mkdirSync(path.join(dir, 'app', 'components'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'app', 'components', 'Existing.jsx'), 'x');
  dbFile = path.join(dir, 'p.sqlite');
  openProjectDb(dbFile);
  initCoreSchema();
  // Point the live REPO_ROOT binding at the fixture, which is what grounding resolves against.
  setActiveProjectConfig({ repoRoot: dir });
});

after(() => {
  closeProjectDb();
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* held */ }
});

/* ── query selection ──────────────────────────────────────────────────────── */

test('the operator\'s pinned topics always survive the sampling', () => {
  /*
   * The bug this replaces: `topicsFor` unshifts the improvement-scope themes to the front so they
   * get searched, and the old sampler shuffled the whole list and took five — discarding them at
   * random. A scope the operator had explicitly set could produce proposals ignoring it entirely,
   * with nothing on screen suggesting anything had gone wrong.
   */
  const all = ['SCOPE A', 'SCOPE B', 'generic 1', 'generic 2', 'generic 3', 'generic 4', 'generic 5', 'generic 6'];
  for (let i = 0; i < 40; i++) {
    const chosen = chooseTopics(all, 4, 2);
    assert.equal(chosen[0], 'SCOPE A');
    assert.equal(chosen[1], 'SCOPE B');
    assert.equal(chosen.length, 4);
  }
});

test('more pinned topics than the budget keeps them all rather than truncating the operator', () => {
  const chosen = chooseTopics(['A', 'B', 'C', 'D', 'x'], 2, 4);
  assert.deepEqual(chosen, ['A', 'B', 'C', 'D']);
});

test('with nothing pinned it still returns the requested number', () => {
  assert.equal(chooseTopics(['a', 'b', 'c', 'd'], 2, 0).length, 2);
  assert.deepEqual(chooseTopics([], 3, 0), []);
});

/* ── idea quality ─────────────────────────────────────────────────────────── */

const good = {
  title: 'Add optimistic offer confirmation',
  steps: ['Add a POST /offers/:id/confirm endpoint returning the updated offer', 'Wire the OfferDialog button to it with an optimistic update'],
  acceptance: 'Clicking confirm updates the row without a full refetch',
  files: ['app/components/Existing.jsx'],
};

test('a complete idea passes', () => {
  assert.equal(usable(good), null);
});

test('an idea with no build steps is rejected', () => {
  assert.match(usable({ ...good, steps: [] }), /build steps/);
  assert.match(usable({ ...good, steps: ['do it'] }), /build steps/, 'one step, and a vague one, is not a plan');
});

test('an idea with no way to verify it is rejected', () => {
  assert.match(usable({ ...good, acceptance: '' }), /verify/);
});

test('an idea naming no files is rejected', () => {
  assert.match(usable({ ...good, files: [] }), /target files/);
});

test('a title too short to mean anything is rejected', () => {
  assert.match(usable({ ...good, title: 'Fix' }), /title/);
});

/* ── grounding ────────────────────────────────────────────────────────────── */

test('an existing file is grounded', () => {
  const g = groundFiles({ files: ['app/components/Existing.jsx'] });
  assert.deepEqual(g.grounded, ['app/components/Existing.jsx']);
  assert.equal(g.ratio, 1);
});

test('a NEW file in a real directory is grounded — that is what a feature looks like', () => {
  // The filter must not demand that the file already exists, or it rejects every new feature.
  const g = groundFiles({ files: ['app/components/BrandNew.jsx'] });
  assert.deepEqual(g.grounded, ['app/components/BrandNew.jsx']);
  assert.deepEqual(g.invented, []);
});

test('a path in a directory that does not exist is invented', () => {
  const g = groundFiles({ files: ['totally/made/up/File.jsx'] });
  assert.deepEqual(g.grounded, []);
  assert.equal(g.invented.length, 1);
  assert.equal(g.ratio, 0);
});

test('mixed paths keep the real ones and report the rest', () => {
  const g = groundFiles({ files: ['app/components/Existing.jsx', 'nowhere/at/all/X.js'] });
  assert.deepEqual(g.grounded, ['app/components/Existing.jsx']);
  assert.deepEqual(g.invented, ['nowhere/at/all/X.js']);
  assert.equal(g.ratio, 0.5);
});

test('leading ./ and backslashes are normalised, not treated as invented', () => {
  // A model writes paths both ways, and rejecting an idea over a path separator would be absurd.
  assert.equal(groundFiles({ files: ['./app/components/Existing.jsx'] }).ratio, 1);
  assert.equal(groundFiles({ files: ['app\\components\\Existing.jsx'] }).ratio, 1);
});

test('grounding resolves against the ACTIVE project, not a captured path', () => {
  // REPO_ROOT is a live binding; capturing it at import time is what breaks multi-project support.
  assert.equal(REPO_ROOT, dir);
});

/* ── de-duplication ───────────────────────────────────────────────────────── */

test('a restatement of an existing backlog item is caught', () => {
  const existing = ['Add optimistic confirmation to the offer dialog'];
  assert.equal(tooSimilar('Optimistic offer dialog confirmation', existing), existing[0]);
});

test('a genuinely different idea is not caught', () => {
  const existing = ['Add optimistic confirmation to the offer dialog'];
  assert.equal(tooSimilar('Rate-limit the password reset endpoint', existing), null);
});

test('a title with too few substantial words is never judged a duplicate', () => {
  // Two short words overlap by chance constantly; declaring those duplicates would silently
  // suppress real proposals.
  assert.equal(tooSimilar('Add cache', ['Add cache headers to the media CDN responses']), null);
});
