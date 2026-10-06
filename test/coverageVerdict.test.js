import { test } from 'node:test';
import assert from 'node:assert/strict';
import { coverageVerdict, DEFAULT_MIN_PCT } from '../src/iteration/changedLineCoverage.js';

/**
 * The decision the coverage gate makes, separated from the machinery that measures.
 *
 * `coverageVerdict` is deliberately pure so this can be pinned without a git worktree or a test
 * suite run — the measurement half is verified end-to-end against a real vitest run, which is slow
 * and cannot cover every branch of the decision.
 */

const measured = (over) => ({
  applicable: true,
  suiteGreen: true,
  pct: 100,
  executable: 10,
  covered: 10,
  missed: 0,
  files: [{ file: 'src/a.js', pct: 100, missedLines: [], executable: 10, covered: 10 }],
  ...over,
});

test('a well-covered change passes', () => {
  const v = coverageVerdict(measured());
  assert.equal(v.pass, true);
  assert.match(v.reason, /100% of 10/);
});

test('a change under the floor fails and says which lines', () => {
  const v = coverageVerdict(measured({
    pct: 20, covered: 2, missed: 8,
    files: [{ file: 'src/pay.js', pct: 20, missedLines: [11, 12, 13], executable: 10, covered: 2 }],
  }));
  assert.equal(v.pass, false);
  assert.match(v.reason, /only 20%/);
  // A verdict an operator cannot act on is a verdict they learn to ignore.
  assert.match(v.reason, /src\/pay\.js/);
  assert.match(v.reason, /11, 12, 13/);
});

test('THE FALSE GREEN: a new function nothing calls must not pass', () => {
  /*
   * This is the case that made the original design wrong, and it is the reason the gate is a
   * threshold rather than "did any line run?".
   *
   * Measured, not imagined: a brand-new exported function that no test ever calls reports
   * covered: 1 of 4 under vitest's v8 provider, because its `export function …` declaration line
   * executes when the module is imported. A `covered === 0` rule therefore passes the exact change
   * it exists to stop.
   */
  const wholly = measured({ pct: 25, covered: 1, executable: 4, missed: 3, files: [{ file: 'src/new.js', pct: 25, missedLines: [10, 11, 12], executable: 4, covered: 1 }] });
  assert.equal(coverageVerdict(wholly).pass, false, 'a function no test calls must be caught');
  assert.ok(DEFAULT_MIN_PCT > 25, 'the default floor must sit above the declaration-only case');
});

test('an unmeasurable change is skipped, never guessed', () => {
  for (const r of [
    { applicable: false, reason: 'no coverage-capable test runner for the changed areas' },
    { applicable: false, reason: 'the change adds no executable source lines to judge' },
    null,
    undefined,
  ]) {
    const v = coverageVerdict(r);
    assert.equal(v.pass, true);
    assert.equal(v.skipped, true);
  }
});

test('a red suite is skipped — the test gate owns that failure', () => {
  // Coverage from a partially-failing run is a floor, not a measurement. Vetoing on it would blame
  // a change twice for one problem, and blame it for a number that is not true.
  const v = coverageVerdict(measured({ suiteGreen: false, pct: 4, covered: 1, executable: 25 }));
  assert.equal(v.pass, true);
  assert.equal(v.skipped, true);
  assert.match(v.reason, /red/);
});

test('a floor of 0 disables the threshold without disabling the measurement', () => {
  const v = coverageVerdict(measured({ pct: 0, covered: 0 }), { minPct: 0 });
  assert.equal(v.pass, true);
  assert.equal(v.skipped, undefined, 'it still measured — it simply had no floor to enforce');
});

test('the verdict carries the measurement for the run record', () => {
  const m = measured({ pct: 10, covered: 1, executable: 10 });
  assert.equal(coverageVerdict(m).detail, m);
});
