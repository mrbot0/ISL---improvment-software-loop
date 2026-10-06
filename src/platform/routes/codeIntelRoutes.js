import { healthReport, recordHealthSnapshot } from '../../iteration/healthIndex.js';
import { scanStructure, seedStructuralBacklog } from '../../iteration/structuralScan.js';
import { scanCoverage, seedCoverageBacklog } from '../../iteration/coverageScan.js';
import { runCoverage, lastCoverage, coverageIsStale } from '../../iteration/coverageRun.js';
import { snapshotContract, contractDiffAgainst, contractVerdict } from '../../iteration/contractDiff.js';
import { impactRanked } from '../../iteration/impactRank.js';
import { blastRadius } from '../../iteration/blastRadius.js';
import { planRefactor } from '../../iteration/refactorPlan.js';
import { auditFrontend, seedFrontendBacklog } from '../../iteration/frontendAudit.js';
import { findDuplicates, dedupBacklog } from '../../iteration/backlogDedup.js';
import fs from 'node:fs';
import path from 'node:path';
import { toolchainFor, SUPPORTED } from '../../iteration/langRunners.js';
import { REPO_ROOT, PRODUCT_DIRS } from '../../config.js';

/** Any manifest that marks a directory as a buildable/testable project, in any ecosystem. */
const MANIFESTS = [
  'package.json', 'pyproject.toml', 'setup.py', 'requirements.txt', 'go.mod', 'Cargo.toml',
  'pom.xml', 'build.gradle', 'build.gradle.kts', 'composer.json', 'Gemfile', 'mix.exs',
  'build.sbt', 'stack.yaml', 'pubspec.yaml', 'Package.swift', 'CMakeLists.txt', '*.sln', '*.csproj',
];
const IGNORE_DIR = new Set(['node_modules', '.git', 'dist', 'build', 'coverage', '.data', '.next', 'vendor', 'target', '.terraform']);

/** Shallow-walk for directories that hold a project manifest (any language). */
function projectRoots(root, depth = 0, out = []) {
  if (depth > 3 || out.length >= 20) return out;
  let entries;
  try { entries = fs.readdirSync(root, { withFileTypes: true }); } catch { return out; }
  const files = entries.filter((e) => e.isFile()).map((e) => e.name);
  const hit = MANIFESTS.some((m) => (m.startsWith('*') ? files.some((f) => f.endsWith(m.slice(1))) : files.includes(m)));
  if (hit) out.push(path.relative(REPO_ROOT, root).split(path.sep).join('/') || '.');
  for (const e of entries) {
    if (e.isDirectory() && !IGNORE_DIR.has(e.name) && !e.name.startsWith('.')) projectRoots(path.join(root, e.name), depth + 1, out);
  }
  return out;
}

/**
 * CODE-INTELLIGENCE ROUTES — everything that reads the target codebase and tells the operator
 * where the leverage is: health, structure, coverage, blast radius, impact, refactor previews,
 * the a11y/i18n audit, backlog dedup, and which toolchains ISL can actually verify here.
 *
 * Split out of the former single `featureRoutes.js` so each domain is independently readable and
 * testable — the module boundary ISL's own refactor agent would recommend.
 */
export function mountCodeIntelRoutes(app, { wrap }) {
  // Codebase health index + trend — the honest "is ISL improving this?" number over time.
  app.get('/api/health-index', wrap((_req, res) => res.json(healthReport())));
  app.post('/api/health-index/snapshot', wrap((_req, res) => res.json({ score: recordHealthSnapshot({ commitSha: 'manual' }) })));

  // Structural backlog: god-files / over-complex files as refactor recipes, each enriched with its
  // blast radius so risky refactors are visible up front.
  app.get('/api/structural', wrap((_req, res) => {
    const r = scanStructure();
    r.candidates = r.candidates.map((c) => {
      const b = blastRadius(c.file);
      return { ...c, blast: { dependentCount: b.dependentCount, testCount: b.testCount, risk: b.risk, sensitive: b.sensitive } };
    });
    res.json(r);
  }));
  app.post('/api/structural/seed', wrap((req, res) => {
    res.json(seedStructuralBacklog({ max: Math.min(10, Math.max(1, Number(req.body?.max) || 5)) }));
  }));

  // Coverage-driven backlog: critical files (high blast radius) with no tests — or, once a real
  // coverage run exists, with too few of their lines actually exercised.
  app.get('/api/coverage', wrap((_req, res) => res.json(scanCoverage())));
  app.post('/api/coverage/seed', wrap((req, res) => {
    res.json(seedCoverageBacklog({ max: Math.min(10, Math.max(1, Number(req.body?.max) || 5)) }));
  }));

  /**
   * MEASURED coverage. The run executes the target's entire suite in a sandbox and takes minutes,
   * far longer than any sane HTTP timeout, so POST starts it and returns immediately; GET reports
   * the state. A second POST while one is in flight is a no-op rather than a second full suite.
   */
  let coverageRunInFlight = null;
  app.get('/api/coverage/measured', wrap((_req, res) => {
    const cov = lastCoverage();
    res.json({
      running: !!coverageRunInFlight,
      stale: cov ? coverageIsStale() : true,
      // The per-file map can hold thousands of entries; the dashboard reads files via /api/coverage.
      // A failed attempt is reported too — its `reason` and `blockers` are what unblock the operator.
      last: cov ? { ...cov, files: undefined, fileCount: Object.keys(cov.files || {}).length } : null,
    });
  }));
  app.post('/api/coverage/measure', wrap((_req, res) => {
    if (coverageRunInFlight) return res.json({ started: false, running: true, reason: 'a coverage run is already in progress' });
    coverageRunInFlight = runCoverage()
      .catch((err) => ({ available: false, reason: err.message }))
      .finally(() => { coverageRunInFlight = null; });
    res.json({ started: true, running: true });
  }));

  // Unified impact ranking: composite leverage (blast × untested × routes × sensitivity × size).
  app.get('/api/impact', wrap((_req, res) => res.json(impactRanked({ limit: 30 }))));

  /**
   * PUBLIC-CONTRACT SURFACE + DIFF. `GET /api/contract` is the snapshot (what consumers outside the
   * repo depend on); `GET /api/contract/diff?base=<ref>` compares it against a commit, reading the
   * base side from a sandbox worktree so nothing touches the operator's checkout.
   */
  app.get('/api/contract', wrap((_req, res) => {
    const s = snapshotContract();
    res.json({
      counts: {
        routes: Object.keys(s.routes).length,
        mounts: Object.keys(s.mounts).length,
        modules: Object.keys(s.exports).length,
        exportedSymbols: Object.values(s.exports).reduce((n, a) => n + a.length, 0),
        dbModels: Object.keys(s.db.models).length,
        dbEnums: Object.keys(s.db.enums).length,
        graphqlTypes: Object.keys(s.graphql).length,
      },
      routes: Object.entries(s.routes).slice(0, 300).map(([k, file]) => ({ route: k, file })),
      dbModels: Object.keys(s.db.models),
    });
  }));

  app.get('/api/contract/diff', wrap((req, res) => {
    const base = String(req.query?.base || 'HEAD').trim();
    const r = contractDiffAgainst(base);
    if (!r.ok) return res.status(400).json(r);
    res.json({ ...r, verdict: contractVerdict(r.diff, { declaredBreaking: req.query?.declared === '1' }) });
  }));

  // Blast radius: what changing a given file can break (callers, tests, routes, sensitivity).
  app.get('/api/blast-radius', wrap((req, res) => {
    const file = String(req.query?.file || '').trim();
    if (!file) return res.status(400).json({ error: 'file query param required' });
    res.json(blastRadius(file));
  }));

  // Interactive refactor dry-run: preview how a god-file would split (modules, symbols, rewires).
  app.get('/api/refactor/plan', wrap((req, res) => {
    const file = String(req.query?.file || '').trim();
    if (!file) return res.status(400).json({ error: 'file query param required' });
    res.json(planRefactor(file));
  }));

  // Frontend audit: apply ISL's own a11y/i18n gates TO the target app.
  app.get('/api/frontend-audit', wrap((_req, res) => res.json(auditFrontend())));
  app.post('/api/frontend-audit/seed', wrap((req, res) => {
    res.json(seedFrontendBacklog({ max: Math.min(10, Math.max(1, Number(req.body?.max) || 5)) }));
  }));

  // Backlog dedup: near-duplicate pending features (same file + intent) → defer the weaker.
  app.get('/api/backlog/duplicates', wrap((_req, res) => res.json(findDuplicates())));
  app.post('/api/backlog/dedup', wrap((_req, res) => res.json(dedupBacklog())));

  /**
   * TOOLCHAIN CAPABILITY — what ISL can actually verify in THIS repo, per product directory, plus
   * every ecosystem this build knows. The honest answer to "can ISL manage my software?".
   */
  app.get('/api/toolchain', wrap((_req, res) => {
    // Look at real PROJECT roots (a dir holding a manifest), plus the product dirs and the repo
    // root. PRODUCT_DIRS alone are source folders (`backend/server`) and never hold a manifest.
    const dirs = [...new Set(['.', ...projectRoots(REPO_ROOT), ...PRODUCT_DIRS])];
    const detected = [];
    for (const d of dirs) {
      const t = toolchainFor(REPO_ROOT, d);
      if (t.test || t.build || t.lint) {
        detected.push({
          dir: d,
          test: t.test ? { id: t.test.id, cmd: `${t.test.bin} ${t.test.args.join(' ')}`.slice(0, 160) } : null,
          build: t.build ? { id: t.build.id } : null,
          lint: t.lint ? { id: t.lint.id } : null,
        });
      }
    }
    res.json({
      detected,
      supported: SUPPORTED,
      counts: {
        syntax: SUPPORTED.syntax.length, test: SUPPORTED.test.length,
        build: SUPPORTED.build.length, lint: SUPPORTED.lint.length,
      },
    });
  }));
}
