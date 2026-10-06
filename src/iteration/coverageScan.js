import { scanFiles } from './structuralScan.js';
import { blastRadius } from './blastRadius.js';
import { addFeature } from '../db_iteration.js';
import { lastCoverage, coverageForFile } from './coverageRun.js';

/**
 * COVERAGE-DRIVEN BACKLOG (ISL_IMPROVE "New high-value functions", P0).
 *
 * ISL's single strongest skill is writing tests — but it aims that skill at random files. This
 * points it where it matters: the CRITICAL files that nothing tests. Criticality and coverage are
 * both read deterministically off the blast-radius graph ISL already builds:
 *
 *   - criticality : how much depends on a file (dependents), whether it feeds user-facing routes,
 *                   and whether it's a sensitive area (auth / payment / migration)
 *   - coverage    : whether ANY test file imports it (a static coverage proxy — 0 = untested)
 *
 * A high-criticality, zero-test file is exactly a "lowest-covered critical path". These become
 * characterization-test tasks the `tests` agent picks up.
 *
 * MEASURED COVERAGE (coverageRun.js) is used the moment it exists, because the static proxy has one
 * blind spot that matters: a file whose only test asserts that it imports cleanly counts as
 * "covered" and disappears from the backlog, while being just as dangerous as an untested one.
 * When a real run is available a file is a gap if its measured line coverage is thin, not merely if
 * nothing imports it — and files never exercised at all still surface, now with the number attached.
 * Without a run, everything below behaves exactly as before.
 */

const CRITICAL_MIN = 25; // below this a file isn't important enough to force-test
/** Measured line coverage under this is treated as a gap even when tests nominally exist. */
const THIN_COVERAGE_PCT = 50;

/** Criticality 0-100 of a source file from its blast radius. */
function criticality(b) {
  let s = 0;
  s += Math.min(60, b.dependentCount * 3); // reach — how much breaks if it's wrong
  s += Math.min(20, b.routeCount * 4); // feeds user-facing routes
  if (b.sensitive) s += 25; // auth / payment / migration
  return Math.min(100, s);
}

function areaOf(file) {
  return /frontend/.test(file) ? 'frontend' : /services/.test(file) ? 'services' : 'backend';
}

/**
 * Scan the codebase for coverage gaps.
 * @returns {{ scanned, totalCritical, coveredCritical, criticalCoverage, gaps }}
 */
export function scanCoverage({ root, dirs } = {}) {
  const measured = lastCoverage();
  const hasMeasured = !!measured?.available;
  const files = scanFiles({ root, dirs }).filter((f) => !f.isTest);
  const rows = [];
  for (const f of files) {
    const b = blastRadius(f.file);
    const m = hasMeasured ? coverageForFile(f.file) : null;
    rows.push({
      file: f.file,
      lines: f.lines,
      dependents: b.dependentCount,
      routes: b.routeCount,
      sensitive: b.sensitive,
      testCount: b.testCount,
      criticality: criticality(b),
      // null = never measured (unknown), which is NOT the same as measured-at-zero.
      linePct: m ? m.pct : null,
      coveredLines: m ? m.covered : null,
      measuredLines: m ? m.lines : null,
    });
  }
  const critical = rows.filter((r) => r.criticality >= CRITICAL_MIN);
  // "Covered" means measured above the thin threshold when we have a number, and falls back to the
  // static "some test imports it" signal for files the run never reached.
  const isCovered = (r) => (r.linePct == null ? r.testCount > 0 : r.linePct >= THIN_COVERAGE_PCT);
  const covered = critical.filter(isCovered);
  const gaps = critical
    .filter((r) => !isCovered(r))
    .sort((a, b) => {
      // Thin-but-measured files rank against untested ones by how little is actually covered.
      const ap = a.linePct == null ? 0 : a.linePct;
      const bp = b.linePct == null ? 0 : b.linePct;
      return b.criticality - a.criticality || ap - bp;
    })
    .slice(0, 30);
  return {
    scanned: rows.length,
    totalCritical: critical.length,
    coveredCritical: covered.length,
    criticalCoverage: critical.length ? Math.round((covered.length / critical.length) * 100) : 100,
    // How the numbers above were obtained, so the UI never presents a proxy as a measurement.
    source: hasMeasured ? 'measured' : 'static',
    measured: hasMeasured
      ? {
          commit: measured.commit,
          // `dirty` belongs to the provenance: without it a measurement of uncommitted work looks
          // like a measurement of the commit it names.
          dirty: !!measured.dirty,
          uncommittedFiles: measured.uncommittedFiles || 0,
          measuredAt: measured.measuredAt,
          suiteGreen: measured.suiteGreen,
          totals: measured.totals,
          runners: measured.runners,
        }
      : null,
    gaps,
  };
}

/** Seed the top coverage gaps as characterization-test tasks for the `tests` agent. */
export function seedCoverageBacklog({ max = 5 } = {}) {
  const { gaps } = scanCoverage();
  let added = 0;
  for (const g of gaps.slice(0, max)) {
    const base = g.file.split('/').pop();
    const context = `${g.dependents} module(s) depend on it${g.routes ? `, feeds ${g.routes} route module(s)` : ''}${g.sensitive ? ', sensitive area' : ''}`;
    // Three genuinely different situations, and the task text must not confuse them. In
    // particular a file can be EXECUTED by the suite without any test file importing it — RentAll's
    // auth.js is reached transitively through route tests and sits at 27%, while `testCount` is 0.
    // Keying the wording off `testCount` there produced a task claiming "has NO tests" directly
    // above the measured 27%. The measurement, when present, is the only thing that decides.
    const kind = g.linePct == null ? 'untested' : g.linePct === 0 ? 'never-executed' : 'thin';
    const evidence = {
      untested: `no test file imports it (static analysis — no coverage run available)`,
      'never-executed': `the suite never executes a single one of its ${g.measuredLines} lines, measured by a real coverage run`,
      thin: `the suite reaches only ${g.linePct}% of its lines (${g.coveredLines}/${g.measuredLines}), measured by a real coverage run${g.testCount ? ` across ${g.testCount} test file(s)` : ' — reached only indirectly, no test targets it directly'}`,
    }[kind];
    const title = kind === 'thin'
      ? `Cover the untested paths in ${base} (${g.linePct}% of lines covered)`.slice(0, 160)
      : `Add characterization tests for ${base} (${g.dependents} dependents)`.slice(0, 160);
    const description = [
      `COVERAGE GAP — ${g.file} is critical (${context}) and ${evidence}.`,
      kind === 'thin'
        ? `Extend coverage to the unexercised branches — error paths, guard clauses and edge cases are what a thin suite misses. Do not change the source: this is about proving current behaviour, not altering it.`
        : `Write characterization tests in the nearest __tests__ convention that capture its CURRENT behaviour (do not change the source). Cover the main exported functions and their edge cases.`,
      `Target file: ${g.file}`,
      kind === 'thin'
        ? `Acceptance: measured line coverage for this file rises meaningfully above ${g.linePct}% and the whole suite stays green.`
        : `Acceptance: new tests pass against current behaviour and meaningfully exercise the file's public API.`,
    ].join('\n');
    // Priority scales with criticality so the most-depended-on untested files go first.
    const id = addFeature({ title, description, area: areaOf(g.file), source: 'coverage', priority: Math.min(85, 45 + Math.round(g.criticality / 4)) });
    if (id) added++;
  }
  return { added, candidates: gaps.length };
}
