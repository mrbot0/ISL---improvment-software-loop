import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { REPO_ROOT, iteration as iterCfg } from '../config.js';
import { getSetting, setSetting } from '../db.js';
import { git, revParse } from '../sandbox/worktree.js';
import { emit } from '../bus.js';
import { log } from '../logger.js';

/**
 * Runs the target project's app locally via docker compose, for one of two targets:
 *   - 'main' → the working tree (REPO_ROOT), current code.
 *   - 'work' → a persistent git worktree checked out at the work branch tip, so
 *              you can boot exactly what the agents have committed.
 *
 * A compose file pins container names and host ports, so only ONE target can run
 * at a time — switching always tears the other down first.
 */

const WORK_BRANCH = iterCfg.workBranch;
const RUNTIME_WORKTREE = path.join(os.tmpdir(), 'isl-runtime-work');

/* --------------------------- compose file selection ----------------------- */

const COMPOSE_RE = /^(docker-)?compose.*\.ya?ml$/i;
const COMPOSE_IGNORE = new Set(['node_modules', '.git', 'dist', 'build', '.data', 'coverage', '.next', 'vendor', '.claude', 'tmp', '.cache']);

/** Find every docker-compose file in the project (root + subfolders). */
export function discoverComposeFiles(root = REPO_ROOT) {
  const found = [];
  const walk = (dir, depth) => {
    if (depth > 7) return;
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (e.isDirectory()) {
        if (COMPOSE_IGNORE.has(e.name) || e.name.startsWith('.')) continue;
        walk(path.join(dir, e.name), depth + 1);
      } else if (e.isFile() && COMPOSE_RE.test(e.name)) {
        const abs = path.join(dir, e.name);
        found.push({ rel: path.relative(root, abs).split(path.sep).join('/'), name: e.name });
      }
    }
  };
  walk(root, 0);
  // Root files first, then by depth, then alphabetically.
  return found.sort((a, b) => a.rel.split('/').length - b.rel.split('/').length || a.rel.localeCompare(b.rel));
}

/** The compose file the runtime should use — the operator's choice, or a sensible default. */
export function getComposeFile() {
  const saved = getSetting('composeFile', null);
  if (saved) return saved;
  const found = discoverComposeFiles();
  const preferred =
    found.find((f) => f.rel === 'docker-compose.yml') ||
    found.find((f) => f.rel === 'compose.yml' || f.rel === 'compose.yaml') ||
    found.find((f) => !f.rel.includes('/')) ||
    found[0];
  return preferred ? preferred.rel : 'docker-compose.yml';
}

export function setComposeFile(rel) {
  setSetting('composeFile', rel ? String(rel).replace(/\\/g, '/') : null);
  return getComposeFile();
}

/**
 * Browse a directory inside the project (path-guarded), listing subfolders and
 * YAML/compose files so the operator can pick a compose file that discovery
 * didn't surface (an unusually named one, for example).
 */
export function browseDir(relDir = '') {
  const rootAbs = path.resolve(REPO_ROOT);
  const abs = path.resolve(rootAbs, relDir || '.');
  if (abs !== rootAbs && !abs.startsWith(rootAbs + path.sep)) throw new Error('Path is outside the project');
  const entries = fs.readdirSync(abs, { withFileTypes: true });
  const dirs = [];
  const files = [];
  for (const e of entries) {
    if (e.name.startsWith('.')) continue;
    if (e.isDirectory()) {
      if (!COMPOSE_IGNORE.has(e.name)) dirs.push(e.name);
    } else if (e.isFile() && /\.ya?ml$/i.test(e.name)) {
      files.push({ name: e.name, isCompose: COMPOSE_RE.test(e.name) });
    }
  }
  const relNorm = path.relative(rootAbs, abs).split(path.sep).join('/');
  return {
    cwd: relNorm,
    parent: relNorm ? relNorm.split('/').slice(0, -1).join('/') : null,
    dirs: dirs.sort(),
    files: files.sort((a, b) => (b.isCompose ? 1 : 0) - (a.isCompose ? 1 : 0) || a.name.localeCompare(b.name)),
  };
}

/** Locate the docker binary — PATH first, then the standard Docker Desktop path. */
function resolveDocker() {
  const candidates = [
    'docker',
    'C:\\Program Files\\Docker\\Docker\\resources\\bin\\docker.exe',
    '/usr/local/bin/docker',
    '/usr/bin/docker',
  ];
  for (const c of candidates) {
    try {
      execFileSync(c, ['--version'], { stdio: 'ignore' });
      return c;
    } catch {
      /* try next */
    }
  }
  return null;
}

let DOCKER = resolveDocker();

/** Is docker installed and is the daemon actually running? */
export function dockerStatus() {
  if (!DOCKER) DOCKER = resolveDocker();
  if (!DOCKER) return { installed: false, running: false, error: 'docker not found — install Docker Desktop' };
  try {
    execFileSync(DOCKER, ['info'], { stdio: 'ignore', timeout: 8000 });
    return { installed: true, running: true, bin: DOCKER };
  } catch {
    return { installed: true, running: false, bin: DOCKER, error: 'Docker Desktop is installed but not running — start it first' };
  }
}

/** Ensure the work-branch worktree exists at the current tip, and carry over untracked env files. */
export function ensureWorkCheckout() {
  const tip = revParse(WORK_BRANCH);
  if (!tip) throw new Error(`work branch ${WORK_BRANCH} does not exist yet — run an iteration first`);

  if (!fs.existsSync(path.join(RUNTIME_WORKTREE, '.git'))) {
    fs.mkdirSync(path.dirname(RUNTIME_WORKTREE), { recursive: true });
    git(['worktree', 'add', '--detach', '--quiet', RUNTIME_WORKTREE, tip]);
  } else {
    // Fast-forward the worktree to the current work-branch tip.
    try {
      git(['checkout', '--detach', '--quiet', tip], RUNTIME_WORKTREE);
    } catch {
      /* leave as-is if checkout fails */
    }
  }
  // .env / node_modules are gitignored — copy the env files the compose needs.
  for (const rel of ['backend/.env', 'frontend/.env']) {
    const src = path.join(REPO_ROOT, rel);
    const dst = path.join(RUNTIME_WORKTREE, rel);
    if (fs.existsSync(src) && !fs.existsSync(dst)) {
      fs.mkdirSync(path.dirname(dst), { recursive: true });
      try {
        fs.copyFileSync(src, dst);
      } catch {
        /* best effort */
      }
    }
  }
  return RUNTIME_WORKTREE;
}

export function targetDir(target) {
  return target === 'work' ? ensureWorkCheckout() : REPO_ROOT;
}

/** Run a compose subcommand, capture output, never throw. */
function compose(target, args, { timeoutMs = 600_000 } = {}) {
  const st = dockerStatus();
  if (!st.running) return Promise.resolve({ ok: false, output: st.error || 'docker unavailable', exitCode: -1 });
  const cwd = targetDir(target);
  const composeAbs = path.join(cwd, getComposeFile());
  const composeDir = path.dirname(composeAbs);
  return new Promise((resolve) => {
    let output = '';
    const child = spawn(DOCKER, ['compose', '-f', composeAbs, ...args], { cwd: composeDir, env: process.env });
    const cap = (b) => {
      if (output.length < 40_000) output += b.toString();
    };
    child.stdout.on('data', cap);
    child.stderr.on('data', cap);
    const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
    child.on('error', (e) => {
      clearTimeout(timer);
      resolve({ ok: false, output: e.message, exitCode: -1 });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ ok: code === 0, output: output.trim(), exitCode: code ?? -1 });
    });
  });
}

/** `docker compose ps` parsed into services with state. */
export async function services(target) {
  const st = dockerStatus();
  if (!st.running) return [];
  const r = await compose(target, ['ps', '--format', 'json'], { timeoutMs: 15000 });
  if (!r.ok) return [];
  const out = [];
  for (const line of r.output.split('\n').filter(Boolean)) {
    try {
      const j = JSON.parse(line);
      out.push({ name: j.Service || j.Name, state: j.State || j.Status, health: j.Health || '', ports: j.Publishers?.map((p) => p.PublishedPort).filter(Boolean).join(',') || '' });
    } catch {
      /* non-JSON line */
    }
  }
  return out;
}

export const up = (target) => compose(target, ['up', '-d', '--build']);
export const down = (target) => compose(target, ['down']);

/**
 * PER-SERVICE CONTROLS, AND THE ONE FLAG THAT MUST NEVER APPEAR.
 *
 * `docker compose down -v` removes the named volumes, and the database lives in one. Losing it
 * means losing every row — users, listings, bookings — with no undo and no warning beyond a line of
 * compose output. Nothing in this file may pass that flag, so rather than trusting every future
 * caller to remember, the guard below refuses to run any command carrying it.
 *
 * `stopService` uses `stop`, not `down`: stop halts the container and leaves it, its volumes and
 * its network in place, so `startService` brings back the same instance. `down` tears down the
 * whole project — restarting one service is not a reason to do that to the others.
 */
const VOLUME_DESTROYING = /^(-v|--volumes|--remove-orphans)$/;

export function assertNonDestructive(args) {
  const bad = args.find((a) => VOLUME_DESTROYING.test(a));
  if (bad) throw new Error(`refusing to run docker compose with "${bad}" — it would delete the database volume`);
  return args;
}

/** One service name, validated: compose takes it as an argument, so it must not look like a flag. */
export function serviceArg(name) {
  const s = String(name || '').trim();
  if (!s || !/^[a-zA-Z0-9][\w.-]*$/.test(s)) throw new Error(`invalid service name: ${JSON.stringify(name)}`);
  return s;
}

export const stopService = (target, name) =>
  compose(target, assertNonDestructive(['stop', serviceArg(name)]), { timeoutMs: 60_000 });

export const startService = (target, name) =>
  compose(target, assertNonDestructive(['start', serviceArg(name)]), { timeoutMs: 60_000 });

/** Restart in place. No `--build`: rebuilding is a different, much slower operation with its own button. */
export const restartService = (target, name) =>
  compose(target, assertNonDestructive(['restart', serviceArg(name)]), { timeoutMs: 120_000 });

/** Rebuild and recreate one service — needed when a Dockerfile step (e.g. `prisma generate`) must re-run. */
export const rebuildService = (target, name) =>
  compose(target, assertNonDestructive(['up', '-d', '--build', serviceArg(name)]), { timeoutMs: 600_000 });

export const serviceLogs = (target, name, lines = 200) =>
  compose(target, ['logs', '--no-color', '--tail', String(lines), serviceArg(name)], { timeoutMs: 20_000 });
export const logsTail = (target, lines = 200) => compose(target, ['logs', '--no-color', '--tail', String(lines)], { timeoutMs: 20000 });

/**
 * Follow compose logs, emitting each line as a `runtime.log` bus event. Returns a
 * stop() handle. Used to stream live output to the dashboard and feed the ops agent.
 */
export function followLogs(target, onLine) {
  const st = dockerStatus();
  if (!st.running) return { stop: () => {} };
  const cwd = targetDir(target);
  const composeAbs = path.join(cwd, getComposeFile());
  const child = spawn(DOCKER, ['compose', '-f', composeAbs, 'logs', '--no-color', '-f', '--tail', '40'], { cwd: path.dirname(composeAbs), env: process.env });
  let buf = '';
  const handle = (b) => {
    buf += b.toString();
    let nl;
    while ((nl = buf.indexOf('\n')) !== -1) {
      const line = buf.slice(0, nl);
      buf = buf.slice(nl + 1);
      if (line.trim()) onLine(line);
    }
  };
  child.stdout.on('data', handle);
  child.stderr.on('data', handle);
  return { stop: () => child.kill('SIGKILL') };
}

export { WORK_BRANCH, RUNTIME_WORKTREE };
