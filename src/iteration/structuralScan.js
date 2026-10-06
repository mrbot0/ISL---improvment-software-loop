import fs from 'node:fs';
import path from 'node:path';
import { PRODUCT_DIRS, REPO_ROOT } from '../config.js';
import { addFeature } from '../db_iteration.js';

/**
 * STRUCTURAL BACKLOG SOURCE (ISL_IMPROVE "Architecture Gap", pillar C).
 *
 * The catalog/survey backlog is per-function hotspots — great for local hardening, useless
 * for architecture. The agents never *see* the real structural problems, so they never fix
 * them. This scanner surfaces those signals — god-files (too big, mixed concerns) and
 * over-complex files — and turns each into a REFACTOR RECIPE the fleet can execute under
 * behaviour-preserving, wire-in-verified gates: `split-god-file`, `extract-component`,
 * `reduce-complexity`. This is what makes real architectural improvement possible.
 */

const IGNORE = new Set(['node_modules', '.git', 'dist', 'build', 'coverage', '.data', '.next', 'vendor', '.terraform']);
const CODE = /\.(js|mjs|cjs|jsx|ts|tsx|py|rb|php|go|java|cs|vue|svelte)$/;
const TEST = /(\.test\.|\.spec\.|(^|\/)__tests__\/)/;
// A markup/config file being large isn't a structural smell the agents should refactor.
const GOD_LINES = 500;
const COMPLEX = 120;
const MAX_BYTES = 2_000_000;
// Branchiness proxy for cyclomatic complexity (cheap, language-agnostic).
const BRANCH_RE = /\b(if|for|while|switch|catch|case)\b|&&|\|\||\?\.|=>/g;

/**
 * `base` is the root the emitted paths are relative TO. It used to be hardcoded to `REPO_ROOT`,
 * which meant `scanFiles({ root })` only half-honoured its own parameter: scanning any other
 * checkout — a sandbox worktree at another commit, say — produced `../../../..`-style paths that
 * resolved nowhere, so the caller silently got an empty result rather than an error.
 */
function walk(dir, depth, out, base) {
  if (depth > 12) return;
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    if (e.isDirectory()) {
      if (IGNORE.has(e.name) || e.name.startsWith('.')) continue;
      walk(path.join(dir, e.name), depth + 1, out, base);
    } else if (e.isFile() && CODE.test(e.name)) {
      const abs = path.join(dir, e.name);
      try {
        const stat = fs.statSync(abs);
        if (stat.size > MAX_BYTES) continue;
        const text = fs.readFileSync(abs, 'utf8');
        const lines = text.split('\n').filter((l) => l.trim()).length;
        const complexity = (text.match(BRANCH_RE) || []).length;
        out.push({ file: path.relative(base, abs).split(path.sep).join('/'), lines, complexity, isTest: TEST.test(e.name) });
      } catch {
        /* unreadable */
      }
    }
  }
}

/** Raw file scan (product code, tests flagged) — shared by the structural scan and health index. */
export function scanFiles({ root = REPO_ROOT, dirs = PRODUCT_DIRS } = {}) {
  const files = [];
  const roots = dirs && dirs.length ? dirs.map((d) => path.join(root, d)) : [root];
  for (const r of roots) walk(r, 0, files, root);
  return files;
}

/** @returns {{ scanned, candidates: Array<{file, lines, complexity, kind, recipe, why}> }} */
export function scanStructure({ root = REPO_ROOT, dirs = PRODUCT_DIRS } = {}) {
  const files = scanFiles({ root, dirs }).filter((f) => !f.isTest);

  const candidates = [];
  for (const f of files) {
    const isComponent = /\.(jsx|tsx|vue|svelte)$/.test(f.file);
    if (f.lines >= GOD_LINES) {
      candidates.push({
        ...f,
        kind: 'god-file',
        recipe: isComponent ? 'extract-component' : 'split-god-file',
        why: isComponent
          ? `${f.lines} lines — a component this large is hard to change and test; extract self-contained sub-components (behaviour must be identical).`
          : `${f.lines} lines — a module this large mixes concerns; split it into focused modules, moving code and rewiring imports (behaviour must be identical).`,
      });
    } else if (f.complexity >= COMPLEX) {
      candidates.push({ ...f, kind: 'high-complexity', recipe: 'reduce-complexity', why: `~${f.complexity} branch points — extract the deepest branches into named helpers without changing behaviour.` });
    }
  }
  // Biggest god-files first (weighted), then complexity.
  candidates.sort((a, b) => b.lines * (b.kind === 'god-file' ? 2 : 1) - a.lines * (a.kind === 'god-file' ? 2 : 1));
  return { scanned: files.length, candidates: candidates.slice(0, 30) };
}

/**
 * Seed the backlog with the top structural candidates as refactor-recipe features. They carry
 * the recipe in their description so the planner/implementer treat them as constrained,
 * behaviour-preserving structural work — not "improve the structure".
 */
export function seedStructuralBacklog({ max = 5 } = {}) {
  const { candidates } = scanStructure();
  let added = 0;
  for (const c of candidates.slice(0, max)) {
    const title = `[${c.recipe}] ${c.file} (${c.lines} lines)`.slice(0, 160);
    const description = [
      `STRUCTURAL REFACTOR — recipe: ${c.recipe}. ${c.why}`,
      `Target file: ${c.file}`,
      'Acceptance: the FULL existing test suite must pass identically (behaviour preserved), the new code must be wired into real call-sites (no dead code), and the diff must show deletions (the original code moved, not duplicated).',
    ].join('\n');
    const area = /frontend/.test(c.file) ? 'frontend' : /services/.test(c.file) ? 'services' : 'backend';
    const id = addFeature({ title, description, area, source: 'structural', priority: c.kind === 'god-file' ? 70 : 55 });
    if (id) added++;
  }
  return { added, candidates: candidates.length };
}
