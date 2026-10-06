import fs from 'node:fs';
import { projectCache } from '../core/projectCache.js';
import path from 'node:path';
import { PRODUCT_DIRS, REPO_ROOT } from '../config.js';
import { scanFiles } from './structuralScan.js';

/**
 * CHANGE BLAST-RADIUS ANALYSIS (ISL_IMPROVE "New high-value functions", P0).
 *
 * Before ISL changes a file, it should know what that change can break: which other modules
 * import it (the callers that must keep working), which tests cover it, and whether it feeds
 * routes or touches a sensitive area (auth / payment / migrations). That answer does two jobs:
 *   1. it routes big-radius / sensitive changes toward human review instead of silent auto-land, and
 *   2. it hands the implementer the exact list of callers it must not break.
 *
 * The signal is a deterministic reverse-dependency graph built from the target repo's own
 * imports (import/from/require) — no LLM, no guessing. Language-agnostic-ish, JS/TS-first with
 * Python `def`/import support; unknown languages simply yield an empty (harmless) radius.
 */

const TEST_RE = /(\.test\.|\.spec\.|(^|\/)__tests__\/)/;
const IMPORT_RE = /(?:from\s*|require\s*\(\s*|import\s*\(\s*|import\s+)['"]([^'"]+)['"]/g;
// Python: `from x import y` / `import x` — captured separately (dotted module paths).
const PY_IMPORT_RE = /^\s*(?:from\s+([.\w]+)\s+import|import\s+([.\w]+))/gm;
const SENSITIVE_RE = /(auth|login|session|token|password|secret|payment|billing|invoice|ledger|checkout|migration|permission|(^|\/)role|security)/i;
const ROUTE_RE = /(route|controller|(^|\/)api(\/|\.)|endpoint|handler|middleware)/i;

const toPosix = (p) => p.split(path.sep).join('/');
const stripExt = (p) => p.replace(/\.(js|mjs|cjs|jsx|ts|tsx|vue|svelte|py)$/, '');

/** A module key: repo-relative posix path, extension and trailing /index removed. */
function moduleKey(relPosix) {
  return stripExt(relPosix).replace(/\/index$/, '');
}

/** Resolve a relative import specifier from `fromRel` to a repo-relative module key (or null). */
function resolveSpec(fromRel, spec) {
  if (!spec || !spec.startsWith('.')) return null; // package import → not a local dependency
  const fromDir = path.posix.dirname(fromRel);
  const resolved = path.posix.normalize(path.posix.join(fromDir, spec));
  return moduleKey(resolved);
}

/** Top-level / exported symbol names of a source file (its public surface). */
function extractSymbols(src) {
  const names = new Set();
  let m;
  const push = (n) => { if (n && /^[A-Za-z_$][\w$]*$/.test(n) && n !== 'default') names.add(n); };
  const reFn = /export\s+(?:default\s+)?(?:async\s+)?function\*?\s+([A-Za-z_$][\w$]*)/g;
  while ((m = reFn.exec(src))) push(m[1]);
  const reDecl = /export\s+(?:const|let|var|class)\s+([A-Za-z_$][\w$]*)/g;
  while ((m = reDecl.exec(src))) push(m[1]);
  const reNamed = /export\s*\{([^}]+)\}/g;
  while ((m = reNamed.exec(src))) m[1].split(',').forEach((s) => push(s.trim().split(/\s+as\s+/).pop().trim()));
  const rePy = /^\s*def\s+([A-Za-z_]\w*)/gm;
  while ((m = rePy.exec(src))) push(m[1]);
  return [...names];
}

// The reverse-dependency graph is expensive (reads every code file), so it's cached briefly and
// rebuilt on demand — a change to the repo shows up within the TTL. Project-STAMPED: switching
// project can no longer serve the previous codebase's import graph, whether or not anyone
// remembered to call the invalidator.
const _graph = projectCache('blast-graph', { ttlMs: 60_000 });

function buildGraph() {
  const files = scanFiles({ root: REPO_ROOT, dirs: PRODUCT_DIRS });
  const byTarget = new Map(); // moduleKey → Set<importer relPosix>
  for (const f of files) {
    let src;
    try { src = fs.readFileSync(path.join(REPO_ROOT, f.file), 'utf8'); } catch { continue; }
    const seen = new Set();
    let m;
    IMPORT_RE.lastIndex = 0;
    while ((m = IMPORT_RE.exec(src))) {
      const key = resolveSpec(f.file, m[1]);
      if (key) seen.add(key);
    }
    PY_IMPORT_RE.lastIndex = 0;
    while ((m = PY_IMPORT_RE.exec(src))) {
      const spec = (m[1] || m[2] || '').replace(/\./g, '/');
      if (spec) { const key = resolveSpec(f.file, spec.startsWith('.') ? spec : './' + spec); if (key) seen.add(key); }
    }
    for (const key of seen) {
      if (!byTarget.has(key)) byTarget.set(key, new Set());
      byTarget.get(key).add(f.file);
    }
  }
  return { byTarget };
}

function graph() {
  return _graph.get(buildGraph);
}

/** Force a rebuild on the next read (e.g. after the fleet commits). */
export function invalidateBlastGraph() {
  _graph.invalidate();
}

/**
 * The blast radius of changing one file.
 * @returns {{file, exists, exports, exportCount, dependents, dependentCount, tests, testCount,
 *            routes, routeCount, sensitive, risk}}
 */
export function blastRadius(relFile) {
  const rel = toPosix(String(relFile || ''));
  let src = null;
  try { src = fs.readFileSync(path.join(REPO_ROOT, rel), 'utf8'); } catch { /* missing/new file */ }
  const importers = [...(graph().byTarget.get(moduleKey(rel)) || [])].filter((f) => toPosix(f) !== rel);
  const tests = importers.filter((f) => TEST_RE.test(f));
  const dependents = importers.filter((f) => !TEST_RE.test(f));
  const routes = dependents.filter((f) => ROUTE_RE.test(f));
  const exportsList = src ? extractSymbols(src) : [];
  const sensitive = SENSITIVE_RE.test(rel);
  const count = dependents.length;
  const risk = sensitive || count >= 12 ? 'high' : count >= 4 ? 'medium' : 'low';
  return {
    file: rel,
    exists: src != null,
    exports: exportsList.slice(0, 24),
    exportCount: exportsList.length,
    dependents: dependents.slice(0, 40),
    dependentCount: dependents.length,
    tests: tests.slice(0, 40),
    testCount: tests.length,
    routes: routes.slice(0, 20),
    routeCount: routes.length,
    sensitive,
    risk,
  };
}

/** Combined blast radius across all files a task targets. */
export function blastRadiusForTask(task) {
  const files = (task?.files || []).filter((f) => typeof f === 'string' && f.trim());
  if (!files.length) return null;
  const per = files.slice(0, 6).map(blastRadius);
  const dependentCount = per.reduce((s, r) => s + r.dependentCount, 0);
  const testCount = per.reduce((s, r) => s + r.testCount, 0);
  const routeCount = per.reduce((s, r) => s + r.routeCount, 0);
  const sensitive = per.some((r) => r.sensitive);
  const risk = per.some((r) => r.risk === 'high') ? 'high' : per.some((r) => r.risk === 'medium') ? 'medium' : 'low';
  const callers = [...new Set(per.flatMap((r) => r.dependents))].slice(0, 20);
  return { files: per, dependentCount, testCount, routeCount, sensitive, risk, callers };
}

/**
 * A compact brief handed to the implementer: the callers it must not break and the risk of the
 * change, so behaviour-preserving edits stay behaviour-preserving. Null when nothing to say.
 */
export function blastRadiusBlurb(task) {
  const b = blastRadiusForTask(task);
  if (!b) return null;
  const known = b.files.filter((r) => r.exists && (r.dependentCount || r.exportCount || r.testCount));
  if (!known.length && b.risk === 'low') return null;
  const lines = ['BLAST RADIUS — what this change can break:'];
  for (const r of known) {
    const api = r.exports.length ? ` public API: ${r.exports.slice(0, 8).join(', ')}${r.exports.length > 8 ? '…' : ''};` : '';
    lines.push(`- ${r.file} —${api} imported by ${r.dependentCount} module(s)${r.testCount ? `, covered by ${r.testCount} test(s)` : ', not directly tested'}${r.routeCount ? `, feeds ${r.routeCount} route module(s)` : ''}.`);
  }
  if (b.callers.length) lines.push(`Callers that must keep working: ${b.callers.slice(0, 10).join(', ')}${b.callers.length > 10 ? '…' : ''}.`);
  lines.push(
    b.risk === 'high'
      ? `Risk: HIGH${b.sensitive ? ' (sensitive area — auth/payment/migration)' : ' (wide reach)'}. Preserve every exported signature and its behaviour exactly; do not rename or remove exports.`
      : b.risk === 'medium'
        ? 'Risk: medium. Keep the exported API stable — several modules depend on it.'
        : 'Keep the exported API stable.',
  );
  return lines.join('\n');
}
