import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import '../src/db_iteration.js';
import { openProjectDb, initCoreSchema, closeProjectDb, db } from '../src/db.js';
import { assessPromotion, RISKS } from '../src/iteration/promoteRisk.js';

/**
 * Which commits are safe to promote, and — the part that is dangerous to get wrong — how far.
 *
 * Promotion is a fast-forward, so what lands is a contiguous PREFIX of the work branch. An operator
 * who believes they excluded a bad commit in the middle while promoting one after it has promoted
 * the bad one. The prefix walk therefore has to run oldest-first, against a list git prints
 * newest-first, and that inversion is the single easiest thing here to get backwards.
 */

let dbFile;

before(() => {
  dbFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'isl-promote-')), 'p.sqlite');
  openProjectDb(dbFile);
  initCoreSchema();
});
after(() => {
  closeProjectDb();
  for (const s of ['', '-wal', '-shm']) { try { fs.rmSync(dbFile + s, { force: true }); } catch { /* held */ } }
});
beforeEach(() => { db.prepare('DELETE FROM iterations').run(); });

/** A committed run with the scores given. */
const run = (id, scores = {}) => {
  db.prepare("INSERT INTO iterations (id, status, trigger, base_commit, started_at) VALUES (?, 'committed', 'loop', 'x', ?)").run(id, Date.now());
  const cols = { total_score: 95, review_score: 95, security_score: 95, test_score: 100, workbench_score: 100, ...scores };
  for (const [k, v] of Object.entries(cols)) {
    if (v === null) continue;
    db.prepare(`UPDATE iterations SET ${k} = ? WHERE id = ?`).run(v, id);
  }
};

/** `git log --oneline` order: NEWEST FIRST. */
const log = (...ids) => ids.map((id) => `sha${id} [ai-iter#${id}] change ${id}`);

test('a clean history is entirely promotable', () => {
  run(1); run(2); run(3);
  const r = assessPromotion({ commits: log(3, 2, 1) });
  assert.equal(r.safeCount, 3);
  assert.equal(r.blockedAt, null);
  assert.equal(r.safeUpTo, 'sha3');
});

test('THE PREFIX RULE: the walk runs oldest-first, not as git prints it', () => {
  /*
   * The oldest commit carries a blocking risk. A fast-forward lands it first, so NOTHING is
   * promotable — even though the two newest commits are clean and appear first in the log. Walking
   * the printed order would report "2 safe" and offer to promote a set whose first commit is the
   * bad one.
   */
  run(1, { security_score: 40 }); // oldest
  run(2); run(3);
  const r = assessPromotion({ commits: log(3, 2, 1) });
  assert.equal(r.safeCount, 0, 'a blocking oldest commit makes the whole prefix unsafe');
  assert.equal(r.blockedAt.sha, 'sha1');
});

test('a blocker in the middle caps the prefix below it', () => {
  run(1); run(2); run(3, { security_score: 40 }); run(4); run(5);
  const r = assessPromotion({ commits: log(5, 4, 3, 2, 1) });
  assert.equal(r.safeCount, 2);
  assert.equal(r.safeUpTo, 'sha2');
  assert.equal(r.blockedAt.sha, 'sha3');
  // Said out loud, because the constraint is not obvious and assuming otherwise promotes the break.
  assert.match(r.note, /contiguous prefix/);
});

test('A RED SUITE IN HISTORY DOES NOT BLOCK — the tip is what lands', () => {
  /*
   * The change that made promotion usable again.
   *
   * On a real branch the old rule stopped at the 8th of 57 commits because that one had landed with
   * a red suite months earlier, in a suite a later commit had since fixed. A fast-forward installs
   * the state at the END of the range, so whether commit 8 was green in isolation is a fact about
   * the past; whether the tip is green is the question — and `verifyAtCommit` answers it for real.
   *
   * A gate that is right about history and wrong about the present blocks work for no benefit, and
   * an operator who cannot promote stops caring what the loop produces.
   */
  run(1); run(2, { test_score: 0 }); run(3); run(4);
  const r = assessPromotion({ commits: log(4, 3, 2, 1) });
  assert.equal(r.safeCount, 4, 'a historically red suite must not wall off everything after it');
  assert.equal(r.blockedAt, null);
  // Still reported — it is real context for deciding how far to go.
  const flagged = r.commits.find((c) => c.sha === 'sha2');
  assert.equal(flagged.risks[0].code, 'broke-tests');
  assert.equal(flagged.blocking, false);
});

test('a non-booting commit in history does not block either', () => {
  run(1); run(2, { workbench_score: 20 }); run(3);
  const r = assessPromotion({ commits: log(3, 2, 1) });
  assert.equal(r.safeCount, 3);
  assert.equal(r.commits.find((c) => c.sha === 'sha2').risks[0].code, 'app-broken');
});

test('an ordinary security deduction is NOT a risk', () => {
  /*
   * Measured against 102 committed runs in a real repo: 59 scored under 100 on security, but only 3
   * under 90 — the median is 95. Treating <100 as a finding marked 58% of the history dangerous,
   * which teaches an operator to promote past the warning without reading it.
   */
  run(1, { security_score: 95 });
  const r = assessPromotion({ commits: log(1) });
  assert.equal(r.safeCount, 1);
  assert.deepEqual(r.commits[0].risks, []);
});

test('a real security outlier IS a risk', () => {
  run(1, { security_score: 55 });
  const r = assessPromotion({ commits: log(1) });
  assert.equal(r.safeCount, 0);
  assert.equal(r.commits[0].risks[0].code, 'security-finding');
});

test('a conflict with the operator\'s own edits is reported, not a wall', () => {
  /*
   * It used to block, and it was the actual reason promotion was unusable: four overlapping files
   * out of twenty-one local edits stopped all fifty-seven commits, with "commit or stash them
   * first" as the only way out — a manual chore the product can simply perform.
   *
   * `promoteToMain(sha, { stash: true })` stashes ONLY the overlapping files, fast-forwards, and
   * restores them. Nothing is discarded on any path, so the worst case is an ordinary git conflict
   * with the work still in the stash.
   */
  run(1);
  const r = assessPromotion({ commits: log(1), conflicts: { sha1: ['package-lock.json'] } });
  assert.equal(r.commits[0].risks[0].code, 'conflict');
  assert.equal(r.safeCount, 1, 'a conflict is resolvable, so it must not stop the promotion');
  assert.equal(RISKS.conflict.blocks, false);
});

test('only a security finding blocks, and the table says why', () => {
  // The blocking set is deliberately tiny. Everything else is either superseded by verifying the
  // tip, or resolvable — and a secret that entered history is neither.
  const blocking = Object.entries(RISKS).filter(([, r]) => r.blocks).map(([code]) => code);
  assert.deepEqual(blocking, ['security-finding']);
  assert.match(RISKS['security-finding'].why, /not undone by a later commit/);
});

test('thin coverage is reported but does not block', () => {
  run(1);
  db.prepare('UPDATE iterations SET coverage_json = ? WHERE id = 1')
    .run(JSON.stringify({ applicable: true, pct: 8, executable: 25, floor: 50 }));
  const r = assessPromotion({ commits: log(1) });
  assert.equal(r.commits[0].risks[0].code, 'untested-change');
  assert.equal(r.safeCount, 1, 'a real risk, but not a defect — blocking on it would stop everything');
});

test('a commit ISL did not produce is flagged, not blocked', () => {
  // A human commit has no gate history, so none of these checks apply to it. Refusing to promote
  // everything a person wrote by hand would make the feature unusable.
  const r = assessPromotion({ commits: ['abc1234 fix a typo by hand'] });
  assert.equal(r.commits[0].risks[0].code, 'unknown-origin');
  assert.equal(r.safeCount, 1);
});

test('a missing run record does not throw', () => {
  const r = assessPromotion({ commits: log(999) }); // no such iteration
  assert.equal(r.commits[0].runId, null);
  assert.equal(r.commits[0].risks[0].code, 'unknown-origin');
});

test('an empty branch is a clean answer, not an error', () => {
  const r = assessPromotion({ commits: [] });
  assert.equal(r.safeCount, 0);
  assert.equal(r.safeUpTo, null);
  assert.equal(r.blockedAt, null);
});

test('every risk declares whether it blocks and whether it can be repaired', () => {
  // The UI decides what to offer from these two flags; an undefined one silently offers nothing,
  // or offers a repair that cannot exist.
  for (const [code, r] of Object.entries(RISKS)) {
    assert.equal(typeof r.blocks, 'boolean', `${code}.blocks`);
    assert.equal(typeof r.fixable, 'boolean', `${code}.fixable`);
    assert.ok(r.label && r.why, `${code} must explain itself`);
  }
});
