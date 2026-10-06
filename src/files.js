import fs from 'node:fs';
import path from 'node:path';
import { DENY_GLOBS, REPO_ROOT, SECRET_GLOBS, iteration as iterCfg } from './config.js';
import { matchesAny } from './glob.js';
import { git } from './sandbox/worktree.js';
import { emit } from './bus.js';
import { log } from './logger.js';

/**
 * File browser + editor backend. Two refs are addressable:
 *   - 'main'  → the live working tree (what's on disk). Editable.
 *   - 'work'  → the tip of the work branch (agents/auto-improve), read via
 *               `git show` since it isn't checked out. Read-only — it's the
 *               agents' committed output, shown for comparison.
 *
 * Writes are hard-guarded: no traversal, no .git/node_modules/dist, no secrets.
 */

const WORK = iterCfg.workBranch;

const toRel = (p) => (p || '').replace(/\\/g, '/').replace(/^\.?\//, '').replace(/\/$/, '');

/** Resolve + validate a repo-relative path. Throws on anything unsafe. */
function safe(relInput, { write = false } = {}) {
  const rel = toRel(relInput);
  const abs = path.resolve(REPO_ROOT, rel);
  const norm = path.relative(REPO_ROOT, abs).split(path.sep).join('/');
  if (rel && (norm.startsWith('..') || path.isAbsolute(norm))) throw new Error(`path escapes the repository: ${relInput}`);
  if (norm && (matchesAny(norm, DENY_GLOBS) || matchesAny(norm, SECRET_GLOBS))) throw new Error(`path is not accessible: ${norm}`);
  if (write && !norm) throw new Error('cannot write the repository root');
  return { abs, rel: norm };
}

const SKIP_DIRS = new Set(['node_modules', '.git', '.claude', 'dist', 'build', 'coverage', '.data', '_archive', 'graphify-out', 'logs', 'uploads']);

/**
 * List the immediate children of a directory for the file tree.
 * @returns {{path, ref, entries: Array<{name, type, path}>}}
 */
export function listTree(relInput = '', ref = 'main') {
  const { rel } = safe(relInput);

  if (ref === 'work') {
    // git ls-tree of the work branch at this path.
    let out = '';
    try {
      out = git(['ls-tree', `${WORK}:${rel}`]);
    } catch {
      return { path: rel, ref, entries: [] };
    }
    const entries = out
      .split('\n')
      .filter(Boolean)
      .map((line) => {
        const [meta, name] = line.split('\t');
        const type = meta.split(' ')[1]; // blob | tree
        return { name, type: type === 'tree' ? 'dir' : 'file', path: rel ? `${rel}/${name}` : name };
      })
      .filter((e) => !SKIP_DIRS.has(e.name));
    return { path: rel, ref, entries: sortEntries(entries) };
  }

  const dirAbs = path.join(REPO_ROOT, rel);
  let dirents;
  try {
    dirents = fs.readdirSync(dirAbs, { withFileTypes: true });
  } catch {
    return { path: rel, ref, entries: [] };
  }
  const entries = [];
  for (const d of dirents) {
    if (SKIP_DIRS.has(d.name) || d.name.startsWith('.git')) continue;
    const childRel = rel ? `${rel}/${d.name}` : d.name;
    if (matchesAny(childRel, SECRET_GLOBS)) continue;
    entries.push({ name: d.name, type: d.isDirectory() ? 'dir' : 'file', path: childRel });
  }
  return { path: rel, ref, entries: sortEntries(entries) };
}

const sortEntries = (entries) =>
  entries.sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name) : a.type === 'dir' ? -1 : 1));

const MAX_FILE = 400_000;

/** Read a file's content from a ref. */
export function readFile(relInput, ref = 'main') {
  const { abs, rel } = safe(relInput);
  if (ref === 'work') {
    try {
      const content = git(['show', `${WORK}:${rel}`]);
      return { path: rel, ref, content, editable: false, exists: true };
    } catch {
      return { path: rel, ref, content: '', editable: false, exists: false, note: 'not present on the work branch' };
    }
  }
  if (!fs.existsSync(abs)) return { path: rel, ref, content: '', editable: true, exists: false };
  const stat = fs.statSync(abs);
  if (stat.size > MAX_FILE) return { path: rel, ref, content: '', editable: false, exists: true, note: `file too large (${Math.round(stat.size / 1024)} KB)` };
  const buf = fs.readFileSync(abs);
  if (buf.includes(0)) return { path: rel, ref, content: '', editable: false, exists: true, note: 'binary file' };
  return { path: rel, ref, content: buf.toString('utf8'), editable: true, exists: true };
}

/** Save content to the working tree. Only 'main' is writable. */
export function writeFile(relInput, content) {
  if (typeof content !== 'string') throw new Error('content must be a string');
  const { abs, rel } = safe(relInput, { write: true });
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content, 'utf8');
  emit('file.saved', { path: rel, bytes: content.length });
  log.info('editor', `saved ${rel} (${content.length} bytes)`, { data: { path: rel } });
  return { ok: true, path: rel, bytes: content.length };
}

/** Working-tree modifications (tracked changes) + branch context for the Home page. */
export function status() {
  let porcelain = '';
  try {
    porcelain = git(['status', '--porcelain', '--untracked-files=no']);
  } catch {
    /* not a repo */
  }
  const modified = porcelain
    .split('\n')
    .filter(Boolean)
    .map((line) => ({ code: line.slice(0, 2).trim(), path: line.slice(3).trim() }))
    .filter((f) => !matchesAny(f.path, DENY_GLOBS) && !matchesAny(f.path, SECRET_GLOBS));

  let ahead = [];
  try {
    const out = git(['log', '--oneline', `main..${WORK}`]);
    ahead = out ? out.split('\n').filter(Boolean) : [];
  } catch {
    /* work branch may not exist */
  }
  let branch = '';
  try {
    branch = git(['rev-parse', '--abbrev-ref', 'HEAD']);
  } catch {
    /* */
  }
  return { branch, workBranch: WORK, modified, workAhead: ahead.length };
}

/** Unified diff of a single working-tree file vs HEAD (for the Home preview). */
export function fileDiff(relInput) {
  const { rel } = safe(relInput);
  try {
    return { path: rel, diff: git(['diff', '--', rel]) || git(['diff', '--cached', '--', rel]) };
  } catch {
    return { path: rel, diff: '' };
  }
}
