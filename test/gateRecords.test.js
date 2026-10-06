import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import '../src/db_iteration.js';
import { openProjectDb, initCoreSchema, closeProjectDb } from '../src/db.js';
import { startIteration, updateIteration, getIteration, listIterations } from '../src/db_iteration.js';
import { compactCoverage, coverageVerdict } from '../src/iteration/changedLineCoverage.js';

/**
 * A gate verdict has to survive being written and read back.
 *
 * This is the failure the behaviour gate actually had: its result was computed, assigned to a
 * variable, described in a comment as "recorded on the iteration", and then dropped — for months,
 * silently, because nothing ever tried to read it. A column, a field-name map and a summariser all
 * have to agree here, and a typo in any one of them fails exactly that quietly.
 */

let dbFile;

before(() => {
  dbFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'isl-gates-')), 'p.sqlite');
  openProjectDb(dbFile);
  initCoreSchema();
});

after(() => {
  closeProjectDb();
  for (const s of ['', '-wal', '-shm']) { try { fs.rmSync(dbFile + s, { force: true }); } catch { /* held by the OS */ } }
});

const thinCoverage = {
  applicable: true, suiteGreen: true, pct: 25, executable: 4, covered: 1, missed: 3,
  unmeasuredFiles: [],
  files: [{ file: 'src/pay.js', pct: 25, executable: 4, covered: 1, missedLines: Array.from({ length: 40 }, (_, i) => i + 10) }],
  runners: [{ id: 'vitest', dir: '.', suiteGreen: true, ms: 1200, error: null, output: 'x'.repeat(5000) }],
};

test('a coverage verdict survives the round-trip', () => {
  const id = startIteration('loop', 'abc');
  const verdict = coverageVerdict(thinCoverage, { minPct: 50 });
  updateIteration(id, { coverageJson: JSON.stringify(compactCoverage(thinCoverage, { mode: 'enforce', floor: 50, verdict })) });

  const detail = getIteration(id, { withDiff: true });
  assert.equal(detail.gates.coverage.pct, 25);
  assert.equal(detail.gates.coverage.pass, false);
  assert.equal(detail.gates.coverage.mode, 'enforce');
  assert.equal(detail.gateDetail.coverage.files[0].file, 'src/pay.js');
});

test('a behaviour verdict survives the round-trip', () => {
  const id = startIteration('loop', 'abc');
  updateIteration(id, { behaviourJson: JSON.stringify({
    checked: true, veto: true, summary: 'behaviour changed',
    reason: 'backend: 12 → 9 passing', violations: ['backend: 12 → 9 passing'], notes: [], projects: ['backend'],
  }) });

  const detail = getIteration(id, { withDiff: true });
  assert.equal(detail.gates.behaviour.veto, true);
  assert.equal(detail.gates.behaviour.checked, true);
  assert.deepEqual(detail.gateDetail.behaviour.violations, ['backend: 12 → 9 passing']);
});

test('"the gate never ran" stays distinguishable from "the gate was happy"', () => {
  // The entire reason for persisting these. An absent field reads as reassurance; null does not.
  const untouched = getIteration(startIteration('loop', 'x'));
  assert.equal(untouched.gates.coverage, null);
  assert.equal(untouched.gates.behaviour, null);
});

test('list rows stay small — detail rides with the detail fetch', () => {
  const id = startIteration('loop', 'abc');
  const verdict = coverageVerdict(thinCoverage, { minPct: 50 });
  updateIteration(id, { coverageJson: JSON.stringify(compactCoverage(thinCoverage, { mode: 'advisory', floor: 50, verdict })) });

  const row = listIterations(1)[0];
  assert.equal(row.id, id);
  assert.equal(row.gates.coverage.pct, 25, 'the summary a Runs row needs is there');
  assert.equal('gateDetail' in row, false, 'the per-line breakdown is not sent for every row');
});

test('the stored record is bounded, and says so when it truncates', () => {
  const compact = compactCoverage(thinCoverage, { mode: 'advisory', floor: 50 });
  const file = compact.files[0];
  assert.equal(file.missedLines.length, 20);
  // A truncated list that does not announce itself is a lie about how bad the coverage was.
  assert.equal(file.missedTotal, 40);
  // Runner stdout can be megabytes; it has no business on a permanent record.
  assert.equal(compact.runners[0].output, undefined);
  assert.ok(JSON.stringify(compact).length < 2000, 'a run record must not grow without bound');
});

test('an unmeasurable run records WHY, not nothing', () => {
  const id = startIteration('loop', 'abc');
  const raw = { applicable: false, reason: 'no coverage-capable test runner for the changed areas' };
  updateIteration(id, { coverageJson: JSON.stringify(compactCoverage(raw, { mode: 'advisory', floor: 50 })) });

  const row = getIteration(id);
  assert.equal(row.gates.coverage.applicable, false);
  assert.match(row.gates.coverage.reason, /no coverage-capable/);
});
