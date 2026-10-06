import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { run } from '../sandbox/worktree.js';
import { emit } from '../bus.js';
import { log } from '../logger.js';

/**
 * The workbench.
 *
 * Tests tell you the units behave. They do not tell you the application still
 * STARTS. An agent can add a beautiful, fully-tested module and simultaneously
 * break the import graph, the Prisma client, or a route registration — every unit
 * test passes and `npm start` dies on boot. That class of failure is the one that
 * actually costs you an afternoon, and nothing upstream of here catches it.
 *
 * So before an iteration is allowed to land, we boot the thing. In the sandbox, on
 * throwaway ports: start the backend, wait for it to answer, hit its health route,
 * type-check the frontend build, and lint every service's entrypoint for
 * import-time explosions. If the app doesn't come up, the iteration does not land,
 * no matter how good its diff looked.
 */

const lg = log.for('workbench');

/** A free port, asked of the OS rather than guessed. */
function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

/** Poll a URL until it answers or we run out of patience. */
async function waitForHttp(url, { timeoutMs = 30_000, intervalMs = 400 } = {}) {
  const deadline = Date.now() + timeoutMs;
  let lastErr = 'never attempted';
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(2500) });
      return { ok: true, status: res.status, body: (await res.text()).slice(0, 500) };
    } catch (err) {
      lastErr = err.message;
      await new Promise((r) => setTimeout(r, intervalMs));
    }
  }
  return { ok: false, error: lastErr };
}

/**
 * Boot the backend in the sandbox and see whether it serves.
 * Always kills the child — a leaked node process holding a port would poison
 * every subsequent iteration.
 */
async function bootBackend(sandboxRoot, { signal } = {}) {
  // Ask package.json first — it is the only authoritative answer to "how does this
  // thing start?", and it differs between branches (`server/index.js` here, not
  // `src/server.js`). Guessing the path is how you end up "skipping" the boot check
  // on every run and never noticing.
  const candidates = [];
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(sandboxRoot, 'backend', 'package.json'), 'utf8'));
    const start = pkg.scripts?.start || pkg.main;
    const m = String(start || '').match(/([\w./-]+\.js)/);
    if (m) candidates.push(m[1]);
  } catch {
    /* no manifest — fall through to the conventional locations */
  }
  candidates.push('server/index.js', 'src/server.js', 'src/index.js', 'server.js', 'index.js');

  const entry = candidates.map((p) => path.join(sandboxRoot, 'backend', p)).find((p) => fs.existsSync(p));

  if (!entry) return { ok: false, skipped: true, detail: 'no backend entrypoint found in the sandbox' };

  const port = await freePort();
  const child = spawn(process.execPath, [entry], {
    cwd: path.join(sandboxRoot, 'backend'),
    env: {
      ...process.env,
      NODE_ENV: 'test',
      PORT: String(port),
      // Boot must not depend on real infrastructure being up.
      SKIP_DB_CONNECT: 'true',
      CI: 'true',
    },
  });

  let output = '';
  const cap = (b) => {
    if (output.length < 8000) output += b.toString();
  };
  child.stdout.on('data', cap);
  child.stderr.on('data', cap);

  const died = new Promise((resolve) => {
    child.on('exit', (code) => resolve(code));
    child.on('error', (e) => {
      output += `\n${e.message}`;
      resolve(-1);
    });
  });

  try {
    // Whichever comes first: it answers, or it dies on boot.
    const health = await Promise.race([
      waitForHttp(`http://127.0.0.1:${port}/api/health`, { timeoutMs: 25_000 }),
      died.then((code) => ({ ok: false, crashed: true, exitCode: code })),
    ]);

    if (health.crashed) {
      return {
        ok: false,
        detail: `the backend exited on boot (code ${health.exitCode})`,
        output: output.slice(-2000),
      };
    }
    if (!health.ok) {
      // It didn't crash, but it never answered either — hung on boot.
      return {
        ok: false,
        detail: `the backend started but never answered /api/health (${health.error})`,
        output: output.slice(-2000),
      };
    }
    // Answering with a 5xx is still a boot failure in spirit.
    if (health.status >= 500) {
      return { ok: false, detail: `/api/health returned ${health.status}`, output: output.slice(-2000) };
    }
    return { ok: true, detail: `backend booted and answered /api/health (${health.status})`, port };
  } finally {
    if (!child.killed) child.kill('SIGKILL');
    if (signal?.aborted) throw new Error('interrupted');
  }
}

/** Does the frontend still build? A broken import only shows up here. */
async function buildFrontend(sandboxRoot) {
  const dir = path.join(sandboxRoot, 'frontend');
  if (!fs.existsSync(path.join(dir, 'package.json'))) return { ok: true, skipped: true, detail: 'no frontend' };
  const vite = path.join(dir, 'node_modules', 'vite', 'bin', 'vite.js');
  if (!fs.existsSync(vite)) return { ok: true, skipped: true, detail: 'vite not installed in sandbox' };

  const r = await run(process.execPath, [vite, 'build', '--logLevel', 'error'], { cwd: dir, timeoutMs: 240_000 });
  return r.exitCode === 0
    ? { ok: true, detail: 'frontend builds' }
    : { ok: false, detail: 'the frontend build fails', output: r.output.slice(-2000) };
}

/**
 * Every service must at least be *loadable*. `node --check` catches syntax errors;
 * actually importing the entrypoint catches the import-time explosions (a missing
 * module, a top-level throw) that a syntax check sails past.
 */
async function checkServices(sandboxRoot) {
  const root = path.join(sandboxRoot, 'services');
  if (!fs.existsSync(root)) return { ok: true, skipped: true, detail: 'no services/' };

  const services = fs
    .readdirSync(root, { withFileTypes: true })
    .filter((d) => d.isDirectory() && !d.name.startsWith('.'))
    .map((d) => d.name);

  const broken = [];
  const checked = [];
  for (const name of services) {
    const dir = path.join(root, name);
    const entry = ['src/index.js', 'src/server.js', 'index.js', 'server.js']
      .map((p) => path.join(dir, p))
      .find((p) => fs.existsSync(p));
    if (!entry) continue; // Python services (intel) and libs have no JS entrypoint.

    checked.push(name);
    const r = await run(process.execPath, ['--check', entry], { cwd: dir, timeoutMs: 20_000 });
    if (r.exitCode !== 0) broken.push({ name, why: r.output.split('\n')[0]?.slice(0, 160) || 'does not parse' });
  }

  if (!checked.length) return { ok: true, skipped: true, detail: 'no JS service entrypoints' };
  return broken.length
    ? { ok: false, detail: `${broken.length}/${checked.length} service(s) fail to load: ${broken.map((b) => b.name).join(', ')}`, broken }
    : { ok: true, detail: `all ${checked.length} service entrypoint(s) load` };
}

/**
 * Run the whole workbench against a sandbox.
 *
 * Score is what the engine folds into the iteration total: a hard 0 if the app
 * does not boot, because "it doesn't start" is not a matter of degree.
 *
 * @returns {{score, ok, summary, checks}}
 */
export async function verifyLocalExecution({ sandboxRoot, iterationId, signal } = {}) {
  emit('workbench.started', { iterationId });
  lg.info(`booting the app in the sandbox…`, { runId: iterationId });

  const checks = {};
  checks.backend = await bootBackend(sandboxRoot, { signal });
  emit('workbench.check', { iterationId, name: 'backend', ...checks.backend });

  checks.services = await checkServices(sandboxRoot);
  emit('workbench.check', { iterationId, name: 'services', ...checks.services });

  checks.frontend = await buildFrontend(sandboxRoot);
  emit('workbench.check', { iterationId, name: 'frontend', ...checks.frontend });

  // Weighting reflects blast radius: a backend that won't boot is total; a service
  // that won't load is severe; a frontend that won't build is serious but contained.
  const weights = { backend: 55, services: 25, frontend: 20 };
  let score = 0;
  let possible = 0;
  const failures = [];
  for (const [name, w] of Object.entries(weights)) {
    const c = checks[name];
    if (c.skipped) continue; // Don't punish an iteration for a surface that isn't there.
    possible += w;
    if (c.ok) score += w;
    else failures.push(`${name}: ${c.detail}`);
  }
  const normalised = possible ? Math.round((score / possible) * 100) : 100;
  const ok = failures.length === 0;

  const summary = ok
    ? `The app runs locally — ${Object.entries(checks)
        .filter(([, c]) => c.ok && !c.skipped)
        .map(([n]) => n)
        .join(', ')} all healthy.`
    : `The app does NOT run locally — ${failures.join(' · ')}`;

  emit('workbench.finished', { iterationId, score: normalised, ok, summary });
  lg[ok ? 'info' : 'error'](summary, { runId: iterationId });

  return { score: normalised, ok, summary, checks, failures };
}
