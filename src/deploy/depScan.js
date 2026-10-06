import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { REPO_ROOT } from '../config.js';

/**
 * DEPENDENCY & CVE SCAN (ISL_IMPROVE "New high-value functions").
 *
 * Finds the npm projects in the target repo and runs `npm audit` in each, so the fleet knows
 * about known vulnerabilities in the app's dependencies — the highest-severity issues are often
 * NOT in the code the agents write, but in what it depends on. Results feed a security surface
 * and (later) a "safe upgrade" backlog. Best-effort and tolerant: no lockfile, no npm, or no
 * network just yields "unavailable" for that project instead of an error.
 *
 * Node ecosystem for v1 (npm audit); pip-audit / govulncheck / bundler-audit are the same shape.
 */

const IGNORE = new Set(['node_modules', '.git', 'dist', 'build', 'coverage', '.data', '.next']);

/** Directories with a package.json + lockfile, up to a shallow depth. */
function findNpmProjects(root, depth = 0, out = []) {
  if (depth > 3) return out;
  let entries;
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return out;
  }
  const hasPkg = entries.some((e) => e.isFile() && e.name === 'package.json');
  const hasLock = entries.some((e) => e.isFile() && (e.name === 'package-lock.json' || e.name === 'npm-shrinkwrap.json'));
  if (hasPkg && hasLock) out.push(root);
  for (const e of entries) {
    if (e.isDirectory() && !IGNORE.has(e.name) && !e.name.startsWith('.')) findNpmProjects(path.join(root, e.name), depth + 1, out);
  }
  return out;
}

function npmAudit(cwd, timeoutMs = 60_000) {
  return new Promise((resolve) => {
    let out = '';
    let done = false;
    const finish = (v) => {
      if (done) return;
      done = true;
      resolve(v);
    };
    let child;
    try {
      // shell:true so the OS resolves `npm` (npm.cmd on Windows — Node 22 blocks spawning a
      // .cmd directly). The args are fixed and safe, so shell quoting isn't a concern here.
      child = spawn('npm audit --json', { cwd, windowsHide: true, shell: true });
    } catch {
      return finish(null);
    }
    const timer = setTimeout(() => {
      try { child.kill(); } catch { /* ignore */ }
      finish(null);
    }, timeoutMs);
    if (timer.unref) timer.unref();
    child.stdout?.on('data', (d) => (out += d));
    child.on('error', () => { clearTimeout(timer); finish(null); }); // npm not found, etc.
    child.on('close', () => {
      clearTimeout(timer);
      try {
        const j = JSON.parse(out);
        const v = j.metadata?.vulnerabilities || null;
        // npm v7+ advisory map: package -> { severity, via: [{title,url,...}] }
        const top = [];
        for (const [name, info] of Object.entries(j.vulnerabilities || {})) {
          const via = (info.via || []).find((x) => typeof x === 'object');
          if (info.severity === 'critical' || info.severity === 'high') {
            top.push({ name, severity: info.severity, title: via?.title || '', url: via?.url || '' });
          }
        }
        finish({ vulnerabilities: v, top: top.slice(0, 12) });
      } catch {
        finish(null);
      }
    });
  });
}

// A dependency scan runs npm audit across several projects (slow, needs network), so the last
// result is cached and served instantly; the dashboard triggers a fresh scan in the background.
let _lastScan = null;
export function getLastDependencyScan() {
  return _lastScan;
}

/** Scan every npm project in the repo. Returns per-project vulnerability counts + top advisories. */
export async function scanDependencies({ root = REPO_ROOT } = {}) {
  const dirs = findNpmProjects(root).slice(0, 8); // bound the work
  const projects = [];
  const totals = { critical: 0, high: 0, moderate: 0, low: 0, info: 0, total: 0 };

  for (const dir of dirs) {
    const rel = path.relative(root, dir).split(path.sep).join('/') || '.';
    const res = await npmAudit(dir);
    if (!res?.vulnerabilities) {
      projects.push({ dir: rel, status: 'unavailable' });
      continue;
    }
    for (const k of Object.keys(totals)) totals[k] += res.vulnerabilities[k] || 0;
    projects.push({ dir: rel, status: 'ok', vulnerabilities: res.vulnerabilities, top: res.top });
  }
  _lastScan = { projects, totals, scannedAt: Date.now() };
  return _lastScan;
}

// Background scan guard so overlapping triggers don't stack npm-audit runs.
let _scanning = false;
export function isDependencyScanRunning() {
  return _scanning;
}
export function startDependencyScan(opts = {}) {
  if (_scanning) return false;
  _scanning = true;
  scanDependencies(opts)
    .catch(() => {})
    .finally(() => { _scanning = false; });
  return true;
}
