import fs from 'node:fs';
import path from 'node:path';
import { emit } from '../bus.js';
import { getProposal, setProposalStatus } from '../db.js';
import { REPO_ROOT } from '../config.js';
import { createSandbox, removeWorktree, run } from './worktree.js';
import { log } from '../logger.js';

const NODE = process.execPath;

/** Public exports + routes declared in a source string — the regression surface. */
function surfaceOf(content) {
  const out = new Set();
  let m;
  const reCjs = /(?:module\.)?exports\.([A-Za-z0-9_]+)\s*=/g;
  while ((m = reCjs.exec(content))) out.add(m[1]);
  const block = content.match(/module\.exports\s*=\s*\{([\s\S]*?)\}/);
  if (block) for (const part of block[1].split(',')) {
    const nm = part.split(':')[0].trim();
    if (/^[A-Za-z0-9_]+$/.test(nm)) out.add(nm);
  }
  const reEsm = /export\s+(?:async\s+)?(?:const|function|class|let)\s+([A-Za-z0-9_]+)/g;
  while ((m = reEsm.exec(content))) out.add(m[1]);
  for (const grp of content.match(/export\s*\{([^}]*)\}/g) || [])
    for (const part of grp.replace(/export\s*\{|\}/g, '').split(',')) {
      const nm = part.split(/\s+as\s+/)[0].trim();
      if (/^[A-Za-z0-9_]+$/.test(nm)) out.add(nm);
    }
  const reRoute = /\b(?:router|app)\.(get|post|put|patch|delete)\(\s*['"`]([^'"`]+)['"`]/g;
  while ((m = reRoute.exec(content))) out.add(`${m[1].toUpperCase()} ${m[2]}`);
  return out;
}

/**
 * Regression guard for a proposal: does any changed file remove a public export
 * or route that existed before? Removing one silently breaks callers the tests
 * may not cover, so we block it. Compares each changed file's new content against
 * the version currently on disk.
 */
function surfaceRegression(files) {
  const removed = [];
  for (const f of files) {
    const abs = path.join(REPO_ROOT, f.path);
    if (!fs.existsSync(abs)) continue; // new file — nothing to regress
    const before = surfaceOf(fs.readFileSync(abs, 'utf8'));
    const after = surfaceOf(f.newContent);
    for (const sym of before) if (!after.has(sym)) removed.push(`${f.path}#${sym}`);
  }
  return removed;
}
const ESLINT = 'node_modules/eslint/bin/eslint.js';
const VITEST = 'node_modules/vitest/vitest.mjs';

const LINT_TARGETS = { backend: ['src', 'tests'], frontend: ['src'] };

/** node --check understands CommonJS and ESM, but not JSX. */
const parseable = (p) => /\.(js|mjs|cjs)$/.test(p);

/**
 * ESLint 9 only reads flat config. This repo still ships `.eslintrc.cjs`, so
 * `eslint src` exits non-zero at HEAD with "couldn't find a config file" — for
 * every input, good or bad. Treating that as a verification failure would reject
 * every proposal an agent ever makes, so we only lint where a flat config exists
 * and lean on the parse check plus the test suite otherwise.
 */
const hasFlatConfig = (projectDir) =>
  ['eslint.config.js', 'eslint.config.mjs', 'eslint.config.cjs'].some((f) => fs.existsSync(path.join(projectDir, f)));

/**
 * Build the check plan for a proposal. Ordered cheapest-first, and we fail fast:
 * once a file does not parse, the test output tells you nothing you don't know.
 *
 * Tools are invoked via their JS entrypoints through `process.execPath` rather
 * than `npm test`, so no shell is involved (see run() in worktree.js).
 */
function planFor(paths) {
  const checks = [];

  // 1. Every changed file must at least parse. This is what actually catches the
  //    dominant LLM failure mode: a whole-file rewrite that got truncated.
  for (const p of paths) {
    if (parseable(p)) checks.push({ name: `parse:${path.basename(p)}`, parseOnly: p, timeoutMs: 20_000 });
  }

  // 2. Then the owning project's lint (if configured) and full test suite.
  const projects = new Set();
  for (const p of paths) {
    if (p.startsWith('backend/')) projects.add('backend');
    else if (p.startsWith('frontend/')) projects.add('frontend');
  }
  for (const project of projects) {
    checks.push({ name: `${project}:lint`, project, bin: ESLINT, args: [...LINT_TARGETS[project], '--no-error-on-unmatched-pattern'], needsFlatConfig: true, timeoutMs: 120_000 });
    checks.push({ name: `${project}:test`, project, bin: VITEST, args: ['run'], timeoutMs: 300_000 });
  }
  return checks;
}

/** Resolve a check into a runnable argv, or a `skip` reason. */
function resolveCheck(check, sandbox) {
  if (check.parseOnly) {
    return { cmd: NODE, args: ['--check', path.join(sandbox, check.parseOnly)], cwd: sandbox };
  }
  const cwd = path.join(sandbox, check.project);
  if (check.needsFlatConfig && !hasFlatConfig(cwd)) {
    return { skip: 'no eslint flat config in this project' };
  }
  const bin = path.join(cwd, check.bin);
  if (!fs.existsSync(bin)) return { skip: `${check.bin} not installed` };
  return { cmd: NODE, args: [bin, ...check.args], cwd };
}

/**
 * Verify a proposal in an isolated git worktree. The user's working tree is
 * never touched — this is the whole reason the sandbox exists.
 *
 * @returns {Promise<{ok:boolean, checks:Array, skipped?:boolean}>}
 */
/**
 * Core: verify a set of {path, newContent} drafts in an isolated sandbox at
 * `baseCommit`. Returns { ok, skipped, checks } without any DB/event side effects.
 * Shared by verifyProposal (post-run) and the agents' in-loop verify_change tool.
 *
 * @param {Array<{path:string,newContent:string}>} files
 * @param {object} [opts] { baseCommit, onProgress }
 */
export async function verifyFiles(files, { baseCommit = 'HEAD', onProgress } = {}) {
  const paths = files.map((f) => f.path);

  // Regression guard first: refuse a change that removes a public export or route.
  const removed = surfaceRegression(files);
  if (removed.length) {
    const output = `Removed public symbol(s): ${removed.join(', ')}. Removing an export or route breaks callers — restore it or keep it.`;
    onProgress?.({ check: 'regression', ok: false, ms: 0 });
    return { ok: false, checks: [{ name: 'regression', ok: false, exitCode: 1, ms: 0, output }] };
  }

  const checks = planFor(paths);
  if (!checks.length) {
    return { ok: true, skipped: true, checks: [], note: 'No automated checks cover these paths.' };
  }

  let sandbox;
  const results = [];
  try {
    sandbox = createSandbox(files, baseCommit);
    for (const check of checks) {
      const resolved = resolveCheck(check, sandbox);
      if (resolved.skip) {
        results.push({ name: check.name, ok: true, skipped: true, exitCode: 0, ms: 0, output: `skipped: ${resolved.skip}` });
        onProgress?.({ check: check.name, ok: true, skipped: true, ms: 0 });
        continue;
      }
      const { exitCode, output, ms } = await run(resolved.cmd, resolved.args, { cwd: resolved.cwd, timeoutMs: check.timeoutMs });
      const ok = exitCode === 0;
      results.push({ name: check.name, ok, exitCode, ms, output: tail(output) });
      onProgress?.({ check: check.name, ok, ms });
      if (!ok) break; // fail fast: a lint error makes the test result meaningless
    }
  } catch (err) {
    results.push({ name: 'sandbox', ok: false, exitCode: -1, ms: 0, output: err.message });
  } finally {
    if (sandbox) removeWorktree(sandbox);
  }
  return { ok: results.every((r) => r.ok), checks: results };
}

export async function verifyProposal(proposalId) {
  const proposal = getProposal(proposalId, { withFiles: true });
  if (!proposal) throw new Error(`No such proposal: ${proposalId}`);

  emit('verify.started', { proposalId, agentId: proposal.agentId, paths: proposal.paths });
  setProposalStatus(proposalId, 'verifying');

  const verification = await verifyFiles(proposal.files, {
    baseCommit: proposal.baseCommit || 'HEAD',
    onProgress: (p) => emit('verify.progress', { proposalId, agentId: proposal.agentId, ...p }),
  });
  if (verification.skipped) {
    setProposalStatus(proposalId, 'verified', { verification });
    emit('verify.finished', { proposalId, agentId: proposal.agentId, ok: true, skipped: true });
    return verification;
  }

  setProposalStatus(proposalId, verification.ok ? 'verified' : 'failed', { verification });
  const failedCheck = verification.checks.find((r) => !r.ok)?.name ?? null;
  emit('verify.finished', { proposalId, agentId: proposal.agentId, ok: verification.ok, failed: failedCheck });
  log[verification.ok ? 'info' : 'warn'](
    'verifier',
    `#${proposalId} ${verification.ok ? 'verified' : `failed at ${failedCheck}`} (${verification.checks.map((r) => r.name).join(', ')})`,
    { agentId: proposal.agentId },
  );
  return verification;
}

/** Test runners put the useful part at the end; keep the tail, not the head. */
const tail = (s, n = 6000) => (s.length <= n ? s : `…[${s.length - n} chars trimmed]…\n${s.slice(-n)}`);
