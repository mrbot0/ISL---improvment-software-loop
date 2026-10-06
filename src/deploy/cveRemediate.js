import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { REPO_ROOT, WORKTREE_DIR, BASE_BRANCH } from '../config.js';
import { git } from '../sandbox/worktree.js';
import { log } from '../logger.js';

/**
 * CVE AUTO-REMEDIATION (ISL_IMPROVE "Next wave", P0).
 *
 * The dependency scan already names the vulnerable packages; this computes the FIX. For a project
 * it runs `npm audit fix --package-lock-only` in an ISOLATED worktree and reports the resulting
 * package.json/package-lock diff plus the before/after vulnerability counts — i.e. exactly which
 * safe, semver-compatible bumps close which CVEs.
 *
 * SAFETY — two deliberate choices:
 *  - The worktree is created RAW (no `node_modules` junction). `createSandbox` links node_modules
 *    back to the real checkout, so running an installer there would mutate the user's actual
 *    dependencies. We never do that.
 *  - `--package-lock-only` means NOTHING is installed: only the manifest + lockfile are resolved.
 *    Fast, safe, and side-effect free. `--force` (breaking major bumps) is never used.
 *
 * The trade-off is honest: because nothing is installed, the upgrade is NOT test-verified here.
 * The output is a proposed, evidence-backed patch for a human (or a follow-up install+test run).
 */

const lg = log.for('cve-fix');
const IGNORE = new Set(['node_modules', '.git', 'dist', 'build', 'coverage', '.data', '.next']);

/** Run a shell command, capture output, never throw. */
function sh(command, cwd, timeoutMs = 180_000) {
  return new Promise((resolve) => {
    let out = '';
    let done = false;
    const finish = (v) => { if (!done) { done = true; resolve(v); } };
    let child;
    try {
      child = spawn(command, { cwd, shell: true, windowsHide: true });
    } catch (e) {
      return finish({ code: -1, out: e.message });
    }
    const timer = setTimeout(() => { try { child.kill(); } catch { /* ignore */ } finish({ code: -1, out: out + '\n[timed out]' }); }, timeoutMs);
    if (timer.unref) timer.unref();
    child.stdout?.on('data', (d) => { if (out.length < 40_000) out += d; });
    child.stderr?.on('data', (d) => { if (out.length < 40_000) out += d; });
    child.on('error', (e) => { clearTimeout(timer); finish({ code: -1, out: out + '\n' + e.message }); });
    child.on('close', (code) => { clearTimeout(timer); finish({ code: code ?? -1, out }); });
  });
}

function auditTotals(raw) {
  try {
    const j = JSON.parse(raw);
    const v = j.metadata?.vulnerabilities;
    return v ? { critical: v.critical || 0, high: v.high || 0, moderate: v.moderate || 0, low: v.low || 0, total: v.total || 0 } : null;
  } catch {
    return null;
  }
}

/** npm projects (package.json + lockfile) in the repo, shallow. */
function findNpmProjects(root, depth = 0, out = []) {
  if (depth > 3) return out;
  let entries;
  try { entries = fs.readdirSync(root, { withFileTypes: true }); } catch { return out; }
  const hasPkg = entries.some((e) => e.isFile() && e.name === 'package.json');
  const hasLock = entries.some((e) => e.isFile() && (e.name === 'package-lock.json' || e.name === 'npm-shrinkwrap.json'));
  if (hasPkg && hasLock) out.push(path.relative(REPO_ROOT, root).split(path.sep).join('/') || '.');
  for (const e of entries) {
    if (e.isDirectory() && !IGNORE.has(e.name) && !e.name.startsWith('.')) findNpmProjects(path.join(root, e.name), depth + 1, out);
  }
  return out;
}

/**
 * Compute the safe upgrade for ONE npm project.
 * @returns {{ projectDir, before, after, closed, changed, diff, error? }}
 */
export async function remediateProject({ projectDir, commit = BASE_BRANCH, timeoutMs = 240_000 } = {}) {
  // RAW worktree — deliberately NOT createSandbox (which junctions node_modules to the real repo).
  fs.mkdirSync(WORKTREE_DIR, { recursive: true });
  const dir = path.join(WORKTREE_DIR, `cve-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`);
  try {
    git(['worktree', 'add', '--detach', '--quiet', dir, commit]);
  } catch (e) {
    return { projectDir, error: `could not create worktree: ${e.message}` };
  }
  const cwd = path.join(dir, projectDir);
  try {
    if (!fs.existsSync(path.join(cwd, 'package.json'))) return { projectDir, error: 'no package.json at that path' };

    const before = auditTotals((await sh('npm audit --json', cwd, timeoutMs)).out);
    // The fix itself: semver-safe only (never --force), and lockfile-only (installs nothing).
    const fix = await sh('npm audit fix --package-lock-only', cwd, timeoutMs);
    const after = auditTotals((await sh('npm audit --json', cwd, timeoutMs)).out);

    // What actually changed in the manifest/lockfile.
    let diff = '';
    let changed = [];
    try {
      const names = git(['diff', '--name-only', '--', projectDir], dir);
      changed = names ? names.split('\n').filter(Boolean) : [];
      if (changed.length) diff = git(['diff', '--stat', '--', projectDir], dir);
    } catch { /* no change */ }

    const closed = before && after
      ? {
        critical: Math.max(0, before.critical - after.critical),
        high: Math.max(0, before.high - after.high),
        moderate: Math.max(0, before.moderate - after.moderate),
        low: Math.max(0, before.low - after.low),
        total: Math.max(0, before.total - after.total),
      }
      : null;

    lg.info(`${projectDir}: ${closed ? `${closed.total} vuln(s) closable` : 'audit unavailable'}${changed.length ? ` · ${changed.length} file(s) would change` : ' · no change'}`);
    return { projectDir, before, after, closed, changed, diff, fixOutput: (fix.out || '').slice(-800) };
  } finally {
    try { git(['worktree', 'remove', '--force', dir]); } catch {
      try { fs.rmSync(dir, { recursive: true, force: true }); git(['worktree', 'prune']); } catch { /* best effort */ }
    }
  }
}

// Slow + networked, so cached and run in the background like the other scanners.
let _last = null;
let _running = false;
export const getLastRemediation = () => _last;
export const isRemediationRunning = () => _running;

/** Compute safe upgrades for every npm project (or just one). */
export async function remediateAll({ projectDir = null } = {}) {
  const dirs = projectDir ? [projectDir] : findNpmProjects(REPO_ROOT).slice(0, 8);
  const projects = [];
  for (const d of dirs) {
    projects.push(await remediateProject({ projectDir: d }));
  }
  const totalClosed = projects.reduce((n, p) => n + (p.closed?.total || 0), 0);
  const criticalClosed = projects.reduce((n, p) => n + (p.closed?.critical || 0), 0);
  _last = { projects, totalClosed, criticalClosed, testVerified: false, computedAt: Date.now() };
  return _last;
}

export function startRemediation(opts = {}) {
  if (_running) return false;
  _running = true;
  _last = { running: true, startedAt: Date.now() };
  remediateAll(opts)
    .catch((e) => { _last = { running: false, error: e.message }; })
    .finally(() => { _running = false; });
  return true;
}
