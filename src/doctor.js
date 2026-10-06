/** Preflight: verifies every external dependency the fleet needs before you rely on it. */
import fs from 'node:fs';
import path from 'node:path';
import { REPO_ROOT, ollama as ollamaCfg } from './config.js';
import { health } from './ollama.js';
import { createSandbox, currentBranch, headCommit, removeWorktree, run } from './sandbox/worktree.js';

const checks = [];
const record = (name, ok, detail) => {
  checks.push({ name, ok, detail });
  console.log(`${ok ? '  ok  ' : ' FAIL '} ${name}${detail ? ` — ${detail}` : ''}`);
};

console.log('\nRentAll Agents — preflight\n');

// 1. Node
const [major] = process.versions.node.split('.').map(Number);
record('node >= 22.5 (node:sqlite)', major >= 22, `v${process.versions.node}`);

// 2. Repo
record('repo is a git checkout', fs.existsSync(path.join(REPO_ROOT, '.git')), REPO_ROOT);
record('on a branch', !!currentBranch(), `${currentBranch()} @ ${headCommit().slice(0, 8)}`);

// 3. node_modules present (the sandbox links, it does not install)
for (const p of ['backend', 'frontend']) {
  record(`${p}/node_modules installed`, fs.existsSync(path.join(REPO_ROOT, p, 'node_modules')), `run: npm --prefix ${p} install`);
}

// 4. Ollama
const h = await health();
record('ollama reachable', h.ok, h.ok ? h.host : h.error);
if (h.ok) {
  record(`model "${ollamaCfg.model}" pulled`, h.modelReady, h.modelReady ? '' : `run: ollama pull ${ollamaCfg.model}`);
}

// 5. The sandbox — the single most failure-prone piece, so exercise it for real.
let sandbox;
try {
  sandbox = createSandbox([], 'HEAD');
  const linked = fs.existsSync(path.join(sandbox, 'backend', 'node_modules'));
  record('git worktree sandbox', true, sandbox);
  record('node_modules linked into sandbox', linked, linked ? '' : 'symlink/junction failed');

  if (linked) {
    const cwd = path.join(sandbox, 'backend');
    const { exitCode, ms, output } = await run(process.execPath, [path.join(cwd, 'node_modules/vitest/vitest.mjs'), 'run'], {
      cwd,
      timeoutMs: 300_000,
    });
    record('backend test suite green at HEAD', exitCode === 0, `exit ${exitCode} in ${ms}ms`);
    if (exitCode !== 0) console.log(output.slice(-800));
  }
} catch (err) {
  record('git worktree sandbox', false, err.message);
} finally {
  if (sandbox) removeWorktree(sandbox);
}

const failed = checks.filter((c) => !c.ok);
console.log(`\n${checks.length - failed.length}/${checks.length} checks passed.\n`);
process.exit(failed.length ? 1 : 0);
