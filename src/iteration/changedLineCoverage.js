import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR, ACTIVE_PROJECT_ID } from '../config.js';
import { getSetting, setSetting } from '../db.js';
import { run } from '../sandbox/worktree.js';
import { coverageRunnerFor, coverageBlockers } from './coverageRun.js';
import { judgedChangedLines } from './changedLines.js';
import { isToolMissing } from './langRunners.js';
import { log } from '../logger.js';

/**
 * COVERAGE OF THE LINES THIS CHANGE ADDED (ISL_IMPROVE §1, P0).
 *
 * The repo-wide percentage is the wrong instrument for judging a change. A module at 92% can absorb
 * twenty new lines that no test touches and still report 91.8% — the number moves less than the
 * noise, and the one part of the codebase that just became risky is the one part it says nothing
 * about. This measures the change itself: of the executable lines it added, how many does the suite
 * actually run?
 *
 * Two properties keep it from becoming a gate people learn to bypass:
 *
 *   - **Non-executable lines are excluded, not counted as misses.** A `+` line in a diff is often a
 *     closing brace, a blank, an import or a comment; counting those against a change would score
 *     every diff at roughly half, permanently, regardless of how well it was tested. Two filters do
 *     this, because one is not enough: the coverage report itself omits most non-code lines, but
 *     **it cannot be trusted to omit all of them** — measured against vitest's v8 provider, a
 *     comment line inside a covered function is reported as a covered line, since v8 attributes it
 *     to the enclosing executed range. Blank and comment-only lines are therefore dropped here,
 *     from the source, before the report is ever consulted.
 *   - **It degrades to "not applicable", never to a guess.** No coverage tooling, an ecosystem with
 *     no adapter, a report that does not mention the file — each yields an explicit reason and no
 *     verdict. A gate that invents a number when it cannot measure is worse than no gate.
 */

const outDirFor = (id) => path.join(DATA_DIR, 'changed-coverage', String(ACTIVE_PROJECT_ID ?? 'default'), id);

/**
 * Drop added lines that hold no code — blanks, and lines that are only a comment.
 *
 * The coverage report is not a reliable filter for these on its own (v8 reports a comment inside a
 * covered function as a covered line), and a change is not better tested because it added
 * documentation. Deliberately syntactic and conservative: `//`, `#`, `--`, and `/* … *␘/` block
 * bodies cover every language the coverage adapters support. A line that merely *contains* a
 * trailing comment still holds code and is kept.
 *
 * Being wrong here is safe in one direction only, so it errs that way: a missed exclusion adds a
 * line to the denominator, which can only make the gate stricter, never falsely green.
 */
function stripNonCode(sandboxRoot, file, lines) {
  let src;
  try { src = fs.readFileSync(path.join(sandboxRoot, file), 'utf8').split(/\r?\n/); }
  catch { return lines; } // unreadable → judge every line rather than silently excusing the file
  return lines.filter((n) => {
    const text = (src[n - 1] ?? '').trim();
    if (!text) return false;
    return !/^(\/\/|#|--|\*|\/\*)/.test(text);
  });
}

/** The judged change confined to one project directory, with paths made relative to it. */
function scopeToDir(judged, dir) {
  if (dir === '.') return judged;
  const prefix = `${dir}/`;
  return judged.filter((f) => f.file.startsWith(prefix));
}

/**
 * Measure how much of a change's own added code the test suite exercises.
 *
 * @param {object}   opts
 * @param {string}   opts.sandboxRoot  A worktree with the change ALREADY applied — measuring HEAD
 *                                     would describe the code before the change, which is the exact
 *                                     mistake this replaces.
 * @param {string}   opts.diff         Unified diff of the change.
 * @param {string[]} opts.changedPaths Repo-relative paths, used to pick project dirs.
 * @param {number}   opts.timeoutMs
 * @returns {Promise<{applicable, reason?, pct?, executable?, covered?, files?, runners?}>}
 */
export async function changedLineCoverage({
  sandboxRoot,
  diff,
  changedPaths = [],
  timeoutMs = 600_000,
  logger = log.for('coverage-gate'),
} = {}) {
  const judged = judgedChangedLines(diff);
  if (!judged.length) {
    return { applicable: false, reason: 'the change adds no executable source lines to judge' };
  }

  // Same derivation the test grader uses, so the gate measures the suites that actually cover the
  // changed areas rather than the whole monorepo.
  const dirs = new Set(['.']);
  for (const p of changedPaths) {
    const top = String(p).split('/')[0];
    if (top && !top.includes('.')) dirs.add(top);
  }

  /** file → Map<line, hits>, merged across every suite that measured it. */
  const perLine = new Map();
  const runners = [];
  const seen = new Set();
  // Every directory considered and what became of it. Without this, "no coverage was produced" is
  // indistinguishable from "no directory was even looked at", and the two have opposite fixes.
  const triedDirs = [];

  for (const dir of dirs) {
    // Nothing this change touched lives here — running the suite would cost minutes and tell us
    // nothing about the diff.
    if (!scopeToDir(judged, dir).length && dir !== '.') {
      triedDirs.push({ dir, outcome: 'no changed lines here' });
      continue;
    }

    const adapter = coverageRunnerFor(sandboxRoot, dir);
    if (!adapter) { triedDirs.push({ dir, outcome: 'no coverage-capable runner detected' }); continue; }
    if (!adapter.readLines) { triedDirs.push({ dir, outcome: `${adapter.id} cannot report per-line coverage` }); continue; }
    triedDirs.push({ dir, outcome: `running ${adapter.id}` });
    const key = `${adapter.id}:${adapter.root}`;
    if (seen.has(key)) continue;
    seen.add(key);

    const out = outDirFor(`${adapter.id}-${dir.replace(/[^\w.-]+/g, '_')}`);
    fs.rmSync(out, { recursive: true, force: true });
    fs.mkdirSync(out, { recursive: true });

    const [bin, args] = adapter.cmd(adapter.root, out);
    const res = await run(bin, args, { cwd: adapter.root, timeoutMs })
      .catch((e) => ({ exitCode: 127, output: String(e.message), ms: 0 }));

    let read = null;
    let error = null;
    try {
      /*
       * READ RELATIVE TO THE PROJECT, THEN RE-PREFIX WITH IT.
       *
       * The runner executes inside `adapter.root` (e.g. `<sandbox>/frontend`), so LCOV's `SF:`
       * paths are either absolute or relative to THAT directory — `app/components/OfferDialog.jsx`,
       * not `frontend/app/components/OfferDialog.jsx`. The changed lines are keyed repo-relative.
       * Reading against the sandbox root left the two keyed differently, so for any project in a
       * subdirectory the intersection was ALWAYS empty and the gate reported "the suite never
       * loaded" a file whose coverage it had just measured.
       *
       * Verified on a real run: 171 files of per-line data read, zero of them matching. It went
       * unnoticed because the fixture this was first tested against had its project AT the repo
       * root, where the two conventions coincide.
       */
      read = adapter.readLines(out, adapter.root);
    } catch (err) {
      error = isToolMissing(res.output)
        ? `${adapter.id} is not installed on this host`
        : `no per-line coverage report (${err.code === 'ENOENT' ? 'report not produced' : err.message})`;
    }

    if (read) {
      for (const [rel, lines] of read) {
        // Back to repo-relative, which is what the diff speaks.
        const file = dir === '.' ? rel : `${dir}/${rel}`;
        if (!perLine.has(file)) perLine.set(file, new Map());
        const dest = perLine.get(file);
        // Merged by MAX across suites: a line exercised by any suite is exercised.
        for (const [n, hits] of lines) dest.set(n, Math.max(dest.get(n) || 0, hits));
      }
    }

    runners.push({
      id: adapter.id,
      dir,
      exitCode: res.exitCode,
      suiteGreen: res.exitCode === 0,
      ms: res.ms,
      files: read ? read.size : 0,
      error,
      // Kept only when the read failed. "The report was not produced" is not a diagnosis; the tail
      // of what the runner actually printed usually is — and it is the difference between fixing
      // this and guessing at it.
      output: error ? String(res.output || '').slice(-1500) : undefined,
      reportDir: error ? out : undefined,
    });
    logger.info?.(`${dir} (${adapter.id}) per-line coverage ${read ? `read for ${read.size} files` : `unavailable — ${error}`}`);
  }

  if (!runners.length) {
    const blockers = coverageBlockers(sandboxRoot, [...dirs]);
    return {
      applicable: false,
      reason: blockers.length
        ? `${blockers[0].reason} — install it with: ${blockers[0].install}`
        : `no coverage-capable test runner for the changed areas (looked in ${[...dirs].join(', ')})`,
      blockers,
      triedDirs,
    };
  }
  if (!perLine.size) {
    return {
      applicable: false,
      reason: runners.map((r) => r.error).filter(Boolean)[0] || 'the suite produced no per-line coverage data',
      runners,
      triedDirs,
    };
  }

  /*
   * ATTRIBUTION.
   *
   * `executable` counts only lines the coverage tool itself recorded. A changed line with no record
   * is not an uncovered line — it is a line with nothing to execute (a brace, a blank, an import) —
   * and folding those into the denominator is what turns a coverage gate into background noise.
   *
   * A judged FILE the report never mentions is a different matter: it means the suite never loaded
   * the file at all. That is reported separately as `unmeasured`, never silently as covered.
   */
  const files = [];
  let executable = 0;
  let covered = 0;

  for (const { file, lines: added } of judged) {
    const lines = stripNonCode(sandboxRoot, file, added);
    if (!lines.length) continue; // the change added only comments and blanks to this file
    const measured = perLine.get(file);
    if (!measured) {
      files.push({ file, unmeasured: true, added: lines.length });
      continue;
    }
    const exec = lines.filter((n) => measured.has(n));
    const miss = exec.filter((n) => (measured.get(n) || 0) === 0);
    executable += exec.length;
    covered += exec.length - miss.length;
    if (exec.length) {
      files.push({
        file,
        added: lines.length,
        executable: exec.length,
        covered: exec.length - miss.length,
        missedLines: miss,
        pct: Math.round(((exec.length - miss.length) / exec.length) * 1000) / 10,
      });
    }
  }

  const unmeasured = files.filter((f) => f.unmeasured);
  if (!executable) {
    return {
      applicable: false,
      reason: unmeasured.length
        ? `the suite never loaded ${unmeasured.map((f) => f.file).join(', ')} — no per-line data for the changed files`
        : 'none of the added lines are executable statements',
      files,
      runners,
    };
  }

  return {
    applicable: true,
    // Coverage from a red suite is a floor, not a measurement — the caller must not veto on it.
    suiteGreen: runners.every((r) => r.suiteGreen),
    pct: Math.round((covered / executable) * 1000) / 10,
    executable,
    covered,
    missed: executable - covered,
    unmeasuredFiles: unmeasured.map((f) => f.file),
    files: files.filter((f) => !f.unmeasured).sort((a, b) => a.pct - b.pct),
    runners,
  };
}

/**
 * The measurement reduced to what is worth keeping on the run record forever.
 *
 * The raw result carries a per-suite runner log and every missed line number in every file, which
 * on a large change is kilobytes of detail that answers no question anyone asks months later. What
 * does get asked is "how covered was this change, did the gate block it, and where was it worst?" —
 * so the ten least-covered files survive, with their first twenty missed lines each.
 */
export function compactCoverage(result, { mode, floor, verdict } = {}) {
  if (!result) return null;
  if (!result.applicable) {
    /*
     * The unmeasurable case keeps its diagnostics, and that is the whole point.
     *
     * The first version dropped `runners` and `blockers` here — so on the first real run, where the
     * gate reported "no per-line coverage report (report not produced)", there was no way to tell
     * WHICH project directory had been tried, whether its suite had even started, or what it
     * printed. The one record written specifically to explain a failure explained nothing.
     */
    return {
      applicable: false,
      reason: result.reason,
      mode,
      floor,
      measuredAt: new Date().toISOString(),
      triedDirs: result.triedDirs || [],
      runners: (result.runners || []).map((r) => ({
        id: r.id, dir: r.dir, exitCode: r.exitCode, ms: r.ms, files: r.files, error: r.error,
        output: r.output ? String(r.output).slice(-1200) : undefined,
      })),
      blockers: (result.blockers || []).map((b) => ({ dir: b.dir, runner: b.runner, install: b.install })),
    };
  }
  return {
    applicable: true,
    measuredAt: new Date().toISOString(),
    mode,
    floor,
    suiteGreen: result.suiteGreen,
    pct: result.pct,
    executable: result.executable,
    covered: result.covered,
    missed: result.missed,
    unmeasuredFiles: (result.unmeasuredFiles || []).slice(0, 10),
    files: (result.files || []).slice(0, 10).map((f) => ({
      file: f.file, pct: f.pct, executable: f.executable, covered: f.covered,
      missedLines: (f.missedLines || []).slice(0, 20),
      // Stated explicitly so a truncated list is never mistaken for the whole of it.
      missedTotal: (f.missedLines || []).length,
    })),
    runners: (result.runners || []).map((r) => ({ id: r.id, dir: r.dir, suiteGreen: r.suiteGreen, ms: r.ms, error: r.error })),
    verdict: verdict ? { pass: verdict.pass, skipped: !!verdict.skipped, reason: verdict.reason } : undefined,
  };
}

/**
 * The default floor: more than half of what a change adds must actually run under test.
 *
 * This is a threshold and NOT the "did any line run at all?" test the roadmap first described,
 * because that test does not work. Measured against vitest's v8 provider, a brand-new function that
 * no test ever calls still reports one covered line — its `export function …` declaration, which
 * executes when the module is imported. `covered === 0` therefore never fires for exactly the case
 * it was written to catch, and a gate that reports "pass" on a wholly untested function is worse
 * than no gate, because it certifies something it did not check.
 *
 * 50% is the point where the claim is defensible in plain words: most of what this change added is
 * never executed by any test.
 */
export const DEFAULT_MIN_PCT = 50;

/**
 * How the gate behaves: `off` | `advisory` | `enforce`.
 *
 * It ships **advisory**, and that is a deliberate choice rather than timidity. This gate costs a
 * full instrumented test run per iteration, and it is the first gate whose verdict depends on a
 * project's own test discipline rather than on something ISL can verify unilaterally. Turning it
 * straight to blocking on an unknown repo would stall a loop the operator is relying on, and they
 * would rightly switch it off — permanently. Advisory records the number on every run, so the
 * decision to enforce is made against this repo's real distribution instead of a guess.
 */
export function coverageGateMode() {
  const v = String(getSetting('coverageGate.mode', 'advisory'));
  return ['off', 'advisory', 'enforce'].includes(v) ? v : 'advisory';
}
export function setCoverageGateMode(mode) {
  const v = ['off', 'advisory', 'enforce'].includes(String(mode)) ? String(mode) : 'advisory';
  setSetting('coverageGate.mode', v);
  return v;
}
export function coverageGateFloor() {
  const v = Number(getSetting('coverageGate.minPct', DEFAULT_MIN_PCT));
  return Number.isFinite(v) ? Math.max(0, Math.min(100, v)) : DEFAULT_MIN_PCT;
}
export function setCoverageGateFloor(pct) {
  const v = Math.max(0, Math.min(100, Number(pct) || 0));
  setSetting('coverageGate.minPct', v);
  return v;
}

/**
 * Turn a measurement into a gate decision.
 *
 * The threshold applies to the change's OWN lines, which is both stricter and fairer than a
 * repo-wide target: it asks an author to test what they wrote, and never asks them to pay down
 * coverage debt somebody else created.
 */
export function coverageVerdict(result, { minPct = DEFAULT_MIN_PCT } = {}) {
  if (!result?.applicable) return { pass: true, skipped: true, reason: result?.reason || 'not applicable' };
  // A failing suite under-reports coverage; the test gate already owns that failure.
  if (result.suiteGreen === false) return { pass: true, skipped: true, reason: 'the suite is red — coverage is a floor, not a measurement' };

  if (minPct > 0 && result.pct < minPct) {
    const worst = result.files[0];
    const where = worst ? ` — least covered: ${worst.file} (${worst.pct}%, missed lines ${worst.missedLines.slice(0, 8).join(', ')}${worst.missedLines.length > 8 ? '…' : ''})` : '';
    return {
      pass: false,
      reason: `only ${result.pct}% of the ${result.executable} executable line(s) this change added are exercised by tests (floor: ${minPct}%)${where}`,
      detail: result,
    };
  }
  return { pass: true, reason: `${result.pct}% of ${result.executable} added executable line(s) exercised`, detail: result };
}
