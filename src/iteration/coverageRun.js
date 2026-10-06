import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR, ACTIVE_PROJECT_ID, PRODUCT_DIRS } from '../config.js';
import { createSandbox, removeWorktree, run, headCommit, git } from '../sandbox/worktree.js';
import { projectCache } from '../core/projectCache.js';
import { REPO_ROOT } from '../config.js';
import { getSetting, setSetting } from '../db.js';
import { isToolMissing } from './langRunners.js';

/**
 * REAL PER-LINE COVERAGE (ISL_IMPROVE "New high-value functions", P1).
 *
 * `coverageScan.js` answers "which critical files does no test even import?" — a static proxy that
 * needs no test run and is never wrong about zero. It cannot, however, tell a file whose tests
 * touch 8% of its lines from one covered at 95%: both "have tests". That blind spot is exactly
 * where the dangerous gaps live, because a file with a token smoke test looks safe.
 *
 * This module produces the measured number by RUNNING the target's own suite with its own coverage
 * tooling and parsing the machine-readable report. Three properties make it safe to run from a
 * control plane:
 *
 *   - **It never touches the real checkout.** The suite runs inside a detached git worktree at HEAD
 *     (the same sandbox the iteration pipeline uses), so a test that writes files or seeds a dev
 *     database cannot corrupt the operator's working tree.
 *   - **It never writes into the target repo.** Report output goes to ISL's own .data directory.
 *   - **It degrades to nothing.** Missing coverage tooling, a failing suite or an unknown ecosystem
 *     yield `available: false` with a reason — the static proxy stays in charge and no caller breaks.
 *
 * A run is expensive (it is a full test suite), so the result is cached in the per-project settings
 * table with the commit it was measured at, and is re-used until explicitly refreshed.
 */

const NODE = process.execPath;
const SETTING_KEY = 'coverage.lastRun';
const toPosix = (p) => p.split(path.sep).join('/');

const outDirFor = (id) => path.join(DATA_DIR, 'coverage', String(ACTIVE_PROJECT_ID ?? 'default'), id);

/* ────────────────────────────── report parsers ────────────────────────────── */

/**
 * Istanbul `coverage-summary.json`: { "/abs/file.js": { lines: { total, covered, pct } }, total: … }.
 * Emitted by both vitest (v8/istanbul providers) and jest.
 */
export function parseJsonSummary(file, base) {
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  const out = [];
  for (const [abs, entry] of Object.entries(raw)) {
    if (abs === 'total' || !entry?.lines) continue;
    const rel = relativize(abs, base);
    if (rel) out.push({ file: rel, lines: entry.lines.total || 0, covered: entry.lines.covered || 0 });
  }
  return out;
}

/**
 * LCOV — the lingua franca of coverage. `SF:` starts a file, `DA:<line>,<hits>` is one line.
 * Written by nyc, jest, vitest, pytest-cov, karma, and most CI tooling, so this one parser covers
 * far more ecosystems than any single runner's native format.
 */
export function parseLcov(file, base) {
  const out = [];
  let cur = null;
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    if (line.startsWith('SF:')) {
      cur = { file: relativize(line.slice(3).trim(), base), lines: 0, covered: 0 };
    } else if (line.startsWith('DA:') && cur) {
      const [, hits] = line.slice(3).split(',');
      cur.lines++;
      if (Number(hits) > 0) cur.covered++;
    } else if (line.startsWith('end_of_record')) {
      if (cur?.file) out.push(cur);
      cur = null;
    }
  }
  return out;
}

/**
 * The same LCOV, kept at full resolution: `file → Map<lineNumber, hitCount>`.
 *
 * `parseLcov` above collapses `DA:` records into a total the moment it reads them, which answers
 * "how covered is this file?" and nothing else. The changed-lines gate needs the opposite shape —
 * whether one specific line ran — so the per-line detail is preserved here rather than recomputed
 * from a number it was already thrown away to produce.
 */
export function parseLcovLines(file, base) {
  const out = new Map();
  let cur = null;
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    if (line.startsWith('SF:')) {
      const rel = relativize(line.slice(3).trim(), base);
      cur = rel ? (out.get(rel) || new Map()) : null;
      if (rel) out.set(rel, cur);
    } else if (line.startsWith('DA:') && cur) {
      const [n, hits] = line.slice(3).split(',');
      // A file measured by two suites merges by MAX: a line exercised anywhere is exercised.
      cur.set(Number(n), Math.max(cur.get(Number(n)) || 0, Number(hits) || 0));
    } else if (line.startsWith('end_of_record')) {
      cur = null;
    }
  }
  return out;
}

/**
 * Go coverage profile: `path/file.go:12.34,18.2 3 1` — a BLOCK spanning lines with a hit count.
 * Lines are attributed per block; a line inside any executed block counts as covered.
 */
export function parseGoProfile(file, base) {
  const byFile = new Map();
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/).slice(1)) {
    const m = /^(.+):(\d+)\.\d+,(\d+)\.\d+\s+\d+\s+(\d+)$/.exec(line.trim());
    if (!m) continue;
    const rel = relativize(m[1], base);
    if (!rel) continue;
    if (!byFile.has(rel)) byFile.set(rel, new Map());
    const lines = byFile.get(rel);
    const hit = Number(m[4]) > 0;
    for (let n = Number(m[2]); n <= Number(m[3]); n++) lines.set(n, (lines.get(n) || false) || hit);
  }
  return [...byFile].map(([f, lines]) => ({
    file: f,
    lines: lines.size,
    covered: [...lines.values()].filter(Boolean).length,
  }));
}

/** The Go profile at full resolution — same block walk, without collapsing to a total. */
export function parseGoProfileLines(file, base) {
  const out = new Map();
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/).slice(1)) {
    const m = /^(.+):(\d+)\.\d+,(\d+)\.\d+\s+\d+\s+(\d+)$/.exec(line.trim());
    if (!m) continue;
    const rel = relativize(m[1], base);
    if (!rel) continue;
    if (!out.has(rel)) out.set(rel, new Map());
    const lines = out.get(rel);
    const hits = Number(m[4]);
    for (let n = Number(m[2]); n <= Number(m[3]); n++) lines.set(n, Math.max(lines.get(n) || 0, hits));
  }
  return out;
}

/**
 * Report paths may be absolute (istanbul), relative to the run cwd (lcov), or module paths (go).
 * Everything is normalised to a REPO_ROOT-relative posix path; anything outside the repo — a
 * dependency, a generated file — is dropped by returning null.
 */
export function relativize(p, base) {
  let s = toPosix(String(p || '').trim());
  if (!s) return null;
  const baseP = toPosix(base);
  if (path.posix.isAbsolute(s) || /^[A-Za-z]:/.test(s)) {
    const lower = s.toLowerCase();
    const lowerBase = baseP.toLowerCase();
    if (!lower.startsWith(lowerBase)) return null; // outside the sandbox → not our code
    s = s.slice(baseP.length);
  }
  s = s.replace(/^\/+/, '');
  if (!s || s.includes('node_modules/') || s.startsWith('..')) return null;
  return s;
}

/* ───────────────────────────── coverage adapters ──────────────────────────── */

const has = (root, ...names) => names.some((n) => fs.existsSync(path.join(root, n)));

/** The version of an installed package, or null — used to pin an install hint to what's here. */
function installedVersion(root, pkg) {
  try { return JSON.parse(fs.readFileSync(path.join(root, 'node_modules', pkg, 'package.json'), 'utf8')).version || null; }
  catch { return null; }
}

/**
 * Per-ecosystem: how to ask the project's own test runner for a machine-readable coverage report.
 *
 * `runner` detects the test runner; `plugin` detects the *coverage* tooling, which in several
 * ecosystems ships as a separate package. Splitting the two is what lets ISL say "vitest is here
 * but @vitest/coverage-v8 is not — install it with X" instead of the useless "no coverage support",
 * and it avoids burning minutes on a full suite that was always going to produce no report.
 */
const COVERAGE_RUNNERS = [
  {
    id: 'vitest',
    runner: (r) => fs.existsSync(path.join(r, 'node_modules/vitest/vitest.mjs')),
    plugin: (r) => has(r, 'node_modules/@vitest/coverage-v8', 'node_modules/@vitest/coverage-istanbul'),
    // The provider is version-LOCKED to vitest by a peer dependency, and a bare
    // `npm i -D @vitest/coverage-v8` resolves to the newest major — which fails with ERESOLVE on any
    // repo not already on that major. Pin the hint to the vitest actually installed here.
    install: (r) => {
      const v = installedVersion(r, 'vitest');
      return `npm install -D @vitest/coverage-v8${v ? `@${v}` : ''}`;
    },
    // `lcov` is requested ALONGSIDE json-summary, not instead of it: the summary is what the
    // whole-file percentage already reads, while lcov is the only one of the two carrying per-line
    // detail, which the changed-lines gate cannot work without.
    cmd: (r, out) => [NODE, [
      path.join(r, 'node_modules/vitest/vitest.mjs'), 'run',
      '--coverage.enabled=true', '--coverage.all=true',
      '--coverage.reporter=json-summary', '--coverage.reporter=lcov',
      `--coverage.reportsDirectory=${out}`,
    ]],
    read: (out, base) => parseJsonSummary(path.join(out, 'coverage-summary.json'), base),
    readLines: (out, base) => parseLcovLines(path.join(out, 'lcov.info'), base),
  },
  {
    id: 'jest',
    // Jest ships coverage in the box — no separate plugin to check for.
    runner: (r) => fs.existsSync(path.join(r, 'node_modules/jest/bin/jest.js')),
    cmd: (r, out) => [NODE, [
      path.join(r, 'node_modules/jest/bin/jest.js'), '--ci', '--silent',
      '--coverage', '--coverageReporters=json-summary', '--coverageReporters=lcov',
      `--coverageDirectory=${out}`,
    ]],
    read: (out, base) => parseJsonSummary(path.join(out, 'coverage-summary.json'), base),
    readLines: (out, base) => parseLcovLines(path.join(out, 'lcov.info'), base),
  },
  {
    id: 'pytest',
    runner: (r) => has(r, 'pytest.ini', 'pyproject.toml', 'setup.cfg', 'tox.ini', 'conftest.py'),
    // pytest-cov lives in the interpreter's site-packages, not in the repo, so it cannot be
    // detected from the filesystem — a missing plugin surfaces as a run failure with its reason.
    install: 'pip install pytest-cov',
    cmd: (r, out) => ['pytest', ['-q', '--cov=.', `--cov-report=lcov:${path.join(out, 'lcov.info')}`]],
    read: (out, base) => parseLcov(path.join(out, 'lcov.info'), base),
    readLines: (out, base) => parseLcovLines(path.join(out, 'lcov.info'), base),
  },
  {
    id: 'go',
    runner: (r) => has(r, 'go.mod'),
    cmd: (r, out) => ['go', ['test', `-coverprofile=${path.join(out, 'cover.out')}`, './...']],
    read: (out, base) => parseGoProfile(path.join(out, 'cover.out'), base),
    readLines: (out, base) => parseGoProfileLines(path.join(out, 'cover.out'), base),
  },
  {
    id: 'cargo-llvm-cov',
    runner: (r) => has(r, 'Cargo.toml'),
    install: 'cargo install cargo-llvm-cov',
    cmd: (r, out) => ['cargo', ['llvm-cov', '--lcov', '--output-path', path.join(out, 'lcov.info')]],
    read: (out, base) => parseLcov(path.join(out, 'lcov.info'), base),
    readLines: (out, base) => parseLcovLines(path.join(out, 'lcov.info'), base),
  },
];

const safely = (fn, root) => { try { return !!fn(root); } catch { return false; } };

/** The coverage adapter for a project directory, or null when none is usable there. */
export function coverageRunnerFor(sandboxRoot, projectDir = '.') {
  const root = path.join(sandboxRoot, projectDir);
  for (const c of COVERAGE_RUNNERS) {
    if (!safely(c.runner, root)) continue;
    if (c.plugin && !safely(c.plugin, root)) continue; // runner present, coverage tooling absent
    return { ...c, root, projectDir };
  }
  return null;
}

/**
 * Directories where a test runner IS present but its coverage tooling is not — each with the exact
 * command that would unblock it. This is the difference between "ISL can't measure your coverage"
 * and "ISL can, after you run this one command".
 */
export function coverageBlockers(sandboxRoot, dirs) {
  const out = [];
  for (const dir of dirs) {
    const root = path.join(sandboxRoot, dir);
    for (const c of COVERAGE_RUNNERS) {
      if (!c.plugin || !safely(c.runner, root) || safely(c.plugin, root)) continue;
      // `install` may be a function so the command can be pinned to what this dir actually has.
      const install = typeof c.install === 'function' ? c.install(root) : c.install;
      out.push({ dir, runner: c.id, install, reason: `${c.id} is installed in ${dir} but its coverage provider is not` });
    }
  }
  return out;
}

/* ──────────────────────────────── the run ─────────────────────────────────── */

/**
 * Mirror the working tree's uncommitted changes into the sandbox.
 *
 * The sandbox is created at HEAD, which is reproducible but is NOT what the operator is looking at:
 * with a dirty checkout — say, a batch of test fixes not yet committed — a HEAD-only run would
 * measure a codebase nobody has, and report it as the truth. Tracked modifications, additions and
 * deletions are replayed here so the number describes the code as it actually is; `dirty` is
 * recorded in the result so the provenance is never ambiguous.
 *
 * Untracked files are deliberately excluded: `git status --untracked-files=no` avoids walking every
 * node_modules in the repo (tens of thousands of files), and a brand-new uncommitted source file
 * changing a coverage percentage is not worth that cost.
 */
function overlayWorkingTree(sandbox) {
  let entries;
  try { entries = git(['status', '--porcelain', '--untracked-files=no']).split('\n').filter(Boolean); }
  catch { return { dirty: false, applied: 0 }; }

  let applied = 0;
  for (const line of entries) {
    const status = line.slice(0, 2);
    // Renames report "old -> new"; only the destination matters for the file contents.
    const rel = line.slice(3).replace(/^"|"$/g, '').split(' -> ').pop();
    if (!rel) continue;
    const target = path.join(sandbox, rel);
    try {
      if (status.includes('D')) {
        fs.rmSync(target, { force: true });
      } else {
        const src = path.join(REPO_ROOT, rel);
        if (!fs.existsSync(src)) continue;
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.copyFileSync(src, target);
      }
      applied++;
    } catch { /* one unreadable path must not abort the whole measurement */ }
  }
  return { dirty: applied > 0, applied };
}

/** Directories worth measuring: the product dirs' nearest project roots, deduped. */
function candidateDirs(sandboxRoot, explicit) {
  if (explicit?.length) return explicit;
  const dirs = new Set(['.']);
  for (const d of PRODUCT_DIRS) {
    // Walk up from a source dir (backend/server) to the nearest dir holding a manifest.
    let cur = d;
    while (cur && cur !== '.') {
      if (has(path.join(sandboxRoot, cur), 'package.json', 'go.mod', 'Cargo.toml', 'pyproject.toml', 'setup.cfg')) {
        dirs.add(cur);
        break;
      }
      cur = path.posix.dirname(toPosix(cur));
    }
  }
  return [...dirs];
}

/**
 * Measure per-line coverage by running the target's suite in a sandbox at HEAD, with the working
 * tree's uncommitted changes replayed on top (see `overlayWorkingTree`).
 *
 * @param {{ dirs?: string[], timeoutMs?: number, includeWorkingTree?: boolean }} opts
 * @returns {Promise<{available, reason?, commit, dirty, measuredAt, runners, files, totals}>}
 */
export async function runCoverage({ dirs, timeoutMs = 900_000, includeWorkingTree = true } = {}) {
  let sandbox = null;
  const runners = [];
  const merged = new Map(); // repo-relative file → { lines, covered }

  try {
    sandbox = createSandbox([], 'HEAD');
  } catch (err) {
    return unavailable(`could not create the sandbox worktree: ${err.message}`);
  }

  const overlay = includeWorkingTree ? overlayWorkingTree(sandbox) : { dirty: false, applied: 0 };
  const targets = candidateDirs(sandbox, dirs);
  const blockers = coverageBlockers(sandbox, targets);

  try {
    for (const dir of targets) {
      const adapter = coverageRunnerFor(sandbox, dir);
      if (!adapter) continue;

      const out = outDirFor(`${adapter.id}-${dir.replace(/[^\w.-]+/g, '_')}`);
      fs.rmSync(out, { recursive: true, force: true });
      fs.mkdirSync(out, { recursive: true });

      const [bin, args] = adapter.cmd(adapter.root, out);
      const res = await run(bin, args, { cwd: adapter.root, timeoutMs });

      // A red suite still produces a coverage report for whatever DID run, so the report is read
      // regardless of exit code — but the caller is told the suite failed, because coverage
      // measured from a partially-failing run is a floor, not a truth.
      let files = [];
      let readError = null;
      try {
        files = adapter.read(out, sandbox).filter((f) => f.file && f.lines > 0);
      } catch (err) {
        readError = isToolMissing(res.output)
          ? `${adapter.id} is not installed on this host`
          : `no readable coverage report (${err.code === 'ENOENT' ? 'report not produced' : err.message})`;
      }

      for (const f of files) {
        const prev = merged.get(f.file);
        // Same file measured by two suites → keep the better-covered measurement.
        if (!prev || f.covered / f.lines > prev.covered / prev.lines) merged.set(f.file, { lines: f.lines, covered: f.covered });
      }

      runners.push({
        id: adapter.id,
        dir,
        exitCode: res.exitCode,
        suiteGreen: res.exitCode === 0,
        ms: res.ms,
        files: files.length,
        error: readError,
        output: readError && !files.length ? String(res.output || '').slice(-600) : undefined,
      });
    }

    if (!runners.length) {
      return unavailable(
        blockers.length
          ? `${blockers[0].reason} — install it with: ${blockers[0].install}`
          : 'no coverage-capable test runner detected in this repo',
        runners, blockers,
      );
    }
    if (!merged.size) {
      const why = runners.map((r) => r.error).filter(Boolean)[0] || 'the suite produced no coverage data';
      return unavailable(why, runners, blockers);
    }

    const files = {};
    let totalLines = 0;
    let totalCovered = 0;
    for (const [file, m] of merged) {
      files[file] = { lines: m.lines, covered: m.covered, pct: Math.round((m.covered / m.lines) * 1000) / 10 };
      totalLines += m.lines;
      totalCovered += m.covered;
    }

    const result = {
      available: true,
      commit: headCommit(),
      // Provenance: HEAD alone would not identify what was measured on a dirty checkout.
      dirty: overlay.dirty,
      uncommittedFiles: overlay.applied,
      measuredAt: new Date().toISOString(),
      suiteGreen: runners.every((r) => r.suiteGreen),
      runners,
      // Dirs that could ALSO be measured once their coverage tooling is installed.
      blockers,
      totals: {
        files: merged.size,
        lines: totalLines,
        covered: totalCovered,
        pct: totalLines ? Math.round((totalCovered / totalLines) * 1000) / 10 : 0,
      },
      files,
    };
    setSetting(SETTING_KEY, JSON.stringify(result));
    _memo.set(result);
    return result;
  } finally {
    if (sandbox) removeWorktree(sandbox);
  }
}

/**
 * A failed attempt is persisted exactly like a successful one. "Why is there no coverage number?"
 * is the question an operator actually has, and dropping the reason on the floor left the UI
 * showing an indistinguishable "never measured" for a repo that had just tried and been blocked.
 */
function unavailable(reason, runners = [], blockers = []) {
  const result = {
    available: false,
    reason,
    attemptedAt: new Date().toISOString(),
    runners,
    blockers,
    files: {},
    totals: null,
  };
  try { setSetting(SETTING_KEY, JSON.stringify(result)); } catch { /* never fail a run over its own bookkeeping */ }
  _memo.set(result);
  return result;
}

/* ─────────────────────────────── cached reads ─────────────────────────────── */

// Project-STAMPED, so one project's coverage numbers can never be served for another — the setting
// this reads is per-project, but the memo in front of it was not.
const _memo = projectCache('coverage');

/** The last measured coverage, or null when none was ever run for this project. */
export function lastCoverage() {
  const cached = _memo.peek();
  if (cached) return cached;
  const raw = getSetting(SETTING_KEY, null);
  if (!raw) return null;
  try { return _memo.set(JSON.parse(raw)); } catch { return null; }
}

/** Drop the cache — for when the numbers change rather than the project. */
export function invalidateCoverage() {
  _memo.invalidate();
}

/**
 * Measured line coverage for one file, or null when it was never measured.
 * Null is meaningfully different from 0: "unknown" must not be reported as "uncovered".
 */
export function coverageForFile(relFile) {
  const cov = lastCoverage();
  if (!cov?.available) return null;
  const rel = toPosix(String(relFile || ''));
  return cov.files[rel] ?? null;
}

/**
 * Whether the cached measurement can still be trusted to describe the current code.
 * A measurement taken on a DIRTY checkout is always treated as stale: the commit it recorded no
 * longer identifies what was measured, so there is no way to tell whether the working tree moved
 * since. Reporting "fresh" there would be a guess dressed up as a fact.
 */
export function coverageIsStale() {
  const cov = lastCoverage();
  if (!cov?.available) return true;
  if (cov.dirty) return true;
  try { return cov.commit !== headCommit(); } catch { return true; }
}
