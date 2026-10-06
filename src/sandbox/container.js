import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { REPO_FACTS } from '../config.js';
import { log } from '../logger.js';

/**
 * HERMETIC CONTAINERISED VERIFICATION (ISL_IMPROVE enterprise wave, P0).
 *
 * Verification runs in a git worktree whose `node_modules` is junctioned back to the real checkout —
 * documented in `worktree.js` as a performance necessity, and already the reason `cveRemediate` had
 * to bypass `createSandbox` entirely to avoid mutating the operator's actual dependencies. Two
 * consequences follow, and both are real today:
 *
 *   1. Any test or install with a side effect reaches the developer's machine, and two parallel
 *      iterations share one dependency tree.
 *   2. Of the 53 language adapters, only those already installed on the host can run — so polyglot
 *      support is theoretical on a bare machine.
 *
 * This module runs a verification step inside a per-project container instead: the worktree mounted
 * and nothing else, **network off by default** with opt-in per step for dependency resolution, and a
 * dependency cache keyed by the lockfile so a warm run stays near the current speed.
 *
 * ── The rule that matters most ──────────────────────────────────────────────────────────────────
 * When no container runtime exists, this falls back to running on the host exactly as before — and
 * SAYS SO. `isolationStatus()` reports `isolated: false` with the reason, and that flows into the
 * run record. A verification that quietly ran on the host while the UI implied a sandbox would be
 * worse than no isolation at all, because the operator would trust a guarantee they did not have.
 */

const lg = log.for('container');

/* --------------------------- runtime detection ---------------------------- */

// A CLI on PATH is not a runtime: `docker` is installed on plenty of machines whose daemon is not
// running (this one included). Both facts have to be checked, and the daemon probe is what actually
// decides — so the answer is cached briefly rather than paid on every step of every phase.
let _probe = null;
let _probedAt = 0;
const PROBE_TTL_MS = 60_000;

function probeRuntime() {
  for (const bin of ['docker', 'podman']) {
    try {
      execFileSync(bin, ['info', '--format', '{{.ServerVersion}}'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 8000 });
      return { available: true, runtime: bin, reason: null };
    } catch (err) {
      const msg = String(err?.stderr || err?.message || '');
      // Distinguish "not installed" from "installed but not running" — the operator's fix differs.
      if (/ENOENT|not recognized|not found/i.test(msg)) continue;
      return { available: false, runtime: bin, reason: `${bin} is installed but its daemon is not reachable` };
    }
  }
  return { available: false, runtime: null, reason: 'no container runtime (docker or podman) is installed' };
}

/** Is a container runtime usable right now, and if not, why not? */
export function containerRuntime({ force = false } = {}) {
  if (!force && _probe && Date.now() - _probedAt < PROBE_TTL_MS) return _probe;
  _probe = probeRuntime();
  _probedAt = Date.now();
  return _probe;
}

/**
 * What the operator is actually getting, in words that do not overclaim.
 * Recorded on the run so "was this verified in isolation?" has an auditable answer.
 */
export function isolationStatus() {
  const rt = containerRuntime();
  return rt.available
    ? { isolated: true, runtime: rt.runtime, detail: `verification runs in a ${rt.runtime} container with the worktree mounted and the network off` }
    : { isolated: false, runtime: null, detail: `NOT isolated — ${rt.reason}; verification runs directly on this machine, so a test with a side effect can reach it` };
}

/* ---------------------------- image resolution ---------------------------- */

// Base images by detected toolchain. Deliberately the slim official images: they are what a CI
// pipeline for that language would use, and pulling a 2GB image to run a unit test is its own
// failure mode.
const TOOLCHAIN_IMAGES = {
  javascript: 'node:22-slim',
  typescript: 'node:22-slim',
  python: 'python:3.12-slim',
  go: 'golang:1.22',
  rust: 'rust:1-slim',
  java: 'eclipse-temurin:21-jdk',
  ruby: 'ruby:3.3-slim',
  php: 'php:8.3-cli',
  dotnet: 'mcr.microsoft.com/dotnet/sdk:8.0',
  csharp: 'mcr.microsoft.com/dotnet/sdk:8.0',
  elixir: 'elixir:1.16-slim',
};

/**
 * The image a project should be verified in, preferring what the repository itself declares.
 *
 * A repo that ships a devcontainer or a Dockerfile has already answered "what does this need to
 * build?" — and its answer is better than any guess from a file extension.
 */
export function resolveImage(repoRoot, { language = REPO_FACTS?.language } = {}) {
  // 1. devcontainer — the closest thing to a declared dev environment.
  for (const rel of ['.devcontainer/devcontainer.json', '.devcontainer.json']) {
    const p = path.join(repoRoot, rel);
    if (!fs.existsSync(p)) continue;
    try {
      // devcontainer.json permits comments and trailing commas; strip both before parsing.
      const raw = fs.readFileSync(p, 'utf8')
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/(^|[^:])\/\/.*$/gm, '$1')
        .replace(/,(\s*[}\]])/g, '$1');
      const cfg = JSON.parse(raw);
      if (cfg.image) return { image: cfg.image, source: rel };
      const dockerFile = cfg.build?.dockerfile || cfg.dockerFile;
      if (dockerFile) return { build: path.posix.join(path.dirname(rel), dockerFile), source: rel };
    } catch (err) {
      lg.warn(`${rel} could not be parsed (${err.message}) — falling back to the toolchain image`);
    }
  }

  // 2. a plain Dockerfile at the root.
  if (fs.existsSync(path.join(repoRoot, 'Dockerfile'))) return { build: 'Dockerfile', source: 'Dockerfile' };

  // 3. the detected toolchain.
  const image = TOOLCHAIN_IMAGES[String(language || '').toLowerCase()];
  if (image) return { image, source: `detected toolchain (${language})` };

  return { image: null, source: null, reason: `no devcontainer, no Dockerfile, and no base image is mapped for "${language || 'unknown'}"` };
}

/* ------------------------------ dep caching ------------------------------- */

// Lockfiles, in the order they identify a dependency tree. The cache volume is keyed by the CONTENT
// of whichever exists: change a dependency and you get a cold volume; change application code and
// you keep the warm one. That is the whole point — a warm run has to stay near host speed or nobody
// will leave isolation on.
const LOCKFILES = [
  'package-lock.json', 'pnpm-lock.yaml', 'yarn.lock', 'bun.lockb',
  'poetry.lock', 'requirements.txt', 'Pipfile.lock', 'uv.lock',
  'go.sum', 'Cargo.lock', 'Gemfile.lock', 'composer.lock', 'mix.lock',
  'gradle.lockfile', 'pom.xml',
];

/** A content-addressed cache key for this project's dependency tree, or null if it has no lockfile. */
export function depCacheKey(repoRoot, projectDir = '.') {
  const dir = path.join(repoRoot, projectDir);
  const h = crypto.createHash('sha256');
  let found = 0;
  for (const name of LOCKFILES) {
    const p = path.join(dir, name);
    if (!fs.existsSync(p)) continue;
    try {
      h.update(name).update(fs.readFileSync(p));
      found++;
    } catch { /* unreadable — treated as absent */ }
  }
  return found ? h.digest('hex').slice(0, 16) : null;
}

/** Where a toolchain keeps its downloaded dependencies inside the container. */
const CACHE_MOUNTS = {
  javascript: '/root/.npm',
  typescript: '/root/.npm',
  python: '/root/.cache/pip',
  go: '/root/go/pkg/mod',
  rust: '/usr/local/cargo/registry',
  java: '/root/.m2',
  ruby: '/usr/local/bundle',
  php: '/root/.composer',
};

/* --------------------------- command construction -------------------------- */

/**
 * Build the runtime argv for one verification step.
 *
 * Exported separately from execution so the exact arguments can be asserted in a test — on a machine
 * with no daemon, the argv IS the testable surface, and "network off by default" is a claim that
 * deserves an assertion rather than a comment.
 *
 * @param {{runtime:string, image:string, worktree:string, projectDir?:string, command:string,
 *          args?:string[], network?:boolean, cacheKey?:string|null, language?:string,
 *          memory?:string, cpus?:string}} spec
 */
export function buildRunArgs(spec) {
  const {
    runtime, image, worktree, projectDir = '.', command, args = [],
    network = false, cacheKey = null, language = REPO_FACTS?.language,
    memory = '4g', cpus = '2',
  } = spec;

  const workdir = projectDir === '.' ? '/work' : `/work/${String(projectDir).replace(/\\/g, '/').replace(/^\.\//, '')}`;
  const out = [
    'run', '--rm',
    // Nothing survives the step, and nothing outside the worktree is visible.
    '--network', network ? 'bridge' : 'none',
    '--mount', `type=bind,src=${worktree},dst=/work`,
    '--workdir', workdir,
    // A runaway test must not take the operator's machine with it.
    '--memory', memory,
    '--cpus', cpus,
    '--env', 'CI=true',
    '--env', 'FORCE_COLOR=0',
  ];

  // The dependency cache is a NAMED VOLUME, not a bind mount: a bind would write installed packages
  // back into the operator's filesystem, which is exactly the leak this module exists to close.
  const cacheDir = CACHE_MOUNTS[String(language || '').toLowerCase()];
  if (cacheKey && cacheDir) out.push('--mount', `type=volume,src=isl-deps-${cacheKey},dst=${cacheDir}`);

  out.push(image, command, ...args);
  return out;
}

/**
 * Run one verification step, hermetically when possible and honestly when not.
 *
 * Returns the same `{ exitCode, output, ms }` shape as the host runner, plus `isolated` and — when
 * it is false — `isolationReason`. Callers that ignore those two fields still work exactly as
 * before; callers that report to a human should not ignore them.
 *
 * @param {{worktree:string, projectDir?:string, command:string, args?:string[], network?:boolean,
 *          timeoutMs?:number, language?:string}} spec
 * @param {(cmd:string, args:string[], opts:object) => Promise<{exitCode:number,output:string,ms:number}>} hostRun
 *   the existing host runner, used verbatim as the fallback
 */
export async function runVerification(spec, hostRun) {
  const { worktree, projectDir = '.', command, args = [], network = false, timeoutMs = 300_000, language } = spec;
  const cwd = projectDir === '.' ? worktree : path.join(worktree, projectDir);

  const rt = containerRuntime();
  if (!rt.available) {
    const r = await hostRun(command, args, { cwd, timeoutMs });
    return { ...r, isolated: false, isolationReason: rt.reason };
  }

  const img = resolveImage(worktree, { language });
  if (!img.image) {
    // A Dockerfile that still needs building is a real case, but building it silently on the
    // critical path of a verification step is not something to do behind the operator's back.
    const reason = img.build
      ? `${img.source} defines a Dockerfile that has not been built into an image yet`
      : img.reason;
    const r = await hostRun(command, args, { cwd, timeoutMs });
    return { ...r, isolated: false, isolationReason: reason };
  }

  const runArgs = buildRunArgs({
    runtime: rt.runtime,
    image: img.image,
    worktree,
    projectDir,
    command,
    args,
    network,
    cacheKey: depCacheKey(worktree, projectDir),
    language,
  });

  const r = await hostRun(rt.runtime, runArgs, { cwd: worktree, timeoutMs });
  // An image that is not present locally fails before the step ever runs. Falling back is right —
  // refusing to verify at all would be worse — but it must be reported as a non-isolated run.
  if (r.exitCode !== 0 && /Unable to find image|manifest unknown|pull access denied/i.test(r.output || '')) {
    lg.warn(`image ${img.image} is not available — falling back to host verification`);
    const host = await hostRun(command, args, { cwd, timeoutMs });
    return { ...host, isolated: false, isolationReason: `the image ${img.image} could not be pulled` };
  }
  return { ...r, isolated: true, runtime: rt.runtime, image: img.image, imageSource: img.source };
}
