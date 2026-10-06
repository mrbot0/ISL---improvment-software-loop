import fs from 'node:fs';
import path from 'node:path';
import { REPO_ROOT } from '../config.js';
import { blastRadius } from './blastRadius.js';

/**
 * INTERACTIVE REFACTOR DRY-RUN (ISL_IMPROVE "Working with humans", P0).
 *
 * Architectural change should be DIRECTED, not surprising. Before ISL splits a god-file, it should
 * show a human the plan: the symbols it contains, how big each is, a proposed grouping into new
 * modules, and which call-sites would have to rewire — a preview to approve or edit *before*
 * anything executes. This module computes that plan deterministically (no LLM, no writes):
 *
 *   - parse the file's top-level symbols (functions / components / classes / constants) + spans
 *   - classify each (component / dialog / tab / hook / helper / constant) and its size
 *   - propose a grouping into target modules by cohesion + size
 *   - use the reverse-dependency graph to list the call-sites, and which named symbols each uses,
 *     so the human sees exactly what a split would touch (usually: only the default export moves,
 *     so nothing external rewires — the reassuring truth a preview should surface)
 */

const DECL_RE = /^(export\s+)?(default\s+)?(async\s+)?(function\*?|const|let|class)\s+([A-Za-z_$][\w$]*)/;

/** Top-level declarations with approximate line spans (start → next decl - 1). */
export function extractSymbols(src) {
  const lines = src.split('\n');
  const decls = [];
  for (let i = 0; i < lines.length; i++) {
    const m = DECL_RE.exec(lines[i]);
    if (m) decls.push({ name: m[5], kind: m[4].startsWith('function') ? 'function' : m[4], exported: !!m[1], defaultExport: !!m[2], startLine: i + 1 });
  }
  for (let j = 0; j < decls.length; j++) {
    const end = j + 1 < decls.length ? decls[j + 1].startLine - 1 : lines.length;
    decls[j].endLine = end;
    decls[j].lines = end - decls[j].startLine + 1;
    decls[j].role = classify(decls[j]);
  }
  return decls;
}

function classify(d) {
  const cap = /^[A-Z]/.test(d.name);
  if (d.kind === 'const' || d.kind === 'let') {
    return /^[A-Z0-9_]+$/.test(d.name) ? 'constant' : cap && d.lines <= 6 ? 'helper' : 'value';
  }
  if (/Dialog$|Modal$/.test(d.name)) return 'dialog';
  if (/Tab$|Panel$|Section$|View$/.test(d.name)) return 'section';
  if (/^use[A-Z]/.test(d.name)) return 'hook';
  if (cap) return 'component';
  return 'helper';
}

/** Suggested target file for a symbol group, given the source file's dir + base. */
function targetPath(file, sub) {
  const dir = path.posix.dirname(file);
  const base = path.posix.basename(file).replace(/\.(jsx?|tsx?|vue|svelte)$/, '');
  const ext = path.posix.extname(file) || '.js';
  return `${dir}/${base}/${sub}${ext}`;
}

/**
 * Build a dry-run refactor plan for a file. Returns the inventory, a proposed module split, and
 * the call-sites (with the named symbols each uses) that a split would touch.
 */
export function planRefactor(file) {
  const rel = String(file).split(path.sep).join('/');
  const abs = path.join(REPO_ROOT, rel);
  let src;
  try { src = fs.readFileSync(abs, 'utf8'); } catch { return { file: rel, error: 'file not found' }; }

  const totalLines = src.split('\n').filter((l) => l.trim()).length;
  const symbols = extractSymbols(src);
  const b = blastRadius(rel);
  const isComponent = /\.(jsx|tsx|vue|svelte)$/.test(rel);

  // The entry symbol (default export) stays in the original file and imports the rest.
  const entry = symbols.find((s) => s.defaultExport) || symbols.find((s) => s.exported && s.role === 'component');

  // Group the non-entry symbols by role + size into proposed modules.
  const movable = symbols.filter((s) => s !== entry);
  const groups = [];
  const bucket = (pred, sub, reason) => {
    const items = movable.filter((s) => pred(s) && !s._grouped);
    if (!items.length) return;
    items.forEach((s) => { s._grouped = true; });
    groups.push({
      target: targetPath(rel, sub),
      reason,
      symbols: items.map((s) => ({ name: s.name, role: s.role, lines: s.lines })),
      lines: items.reduce((a, s) => a + s.lines, 0),
    });
  };
  // Big sections/panels each deserve their own file; group the rest by kind.
  for (const s of movable.filter((s) => s.role === 'section' && s.lines >= 120)) {
    if (s._grouped) continue;
    s._grouped = true;
    groups.push({ target: targetPath(rel, s.name), reason: `large ${s.role} (${s.lines} lines) — its own module`, symbols: [{ name: s.name, role: s.role, lines: s.lines }], lines: s.lines });
  }
  bucket((s) => s.role === 'section', 'sections', 'remaining sections/panels, grouped');
  bucket((s) => s.role === 'dialog', 'dialogs', 'dialog/modal components');
  bucket((s) => s.role === 'hook', 'hooks', 'custom hooks');
  bucket((s) => s.role === 'component' || s.role === 'helper', isComponent ? 'ui' : 'helpers', 'shared components / helpers');
  bucket((s) => s.role === 'constant' || s.role === 'value', 'constants', 'constants & static data');

  const exportedNames = new Set(symbols.filter((s) => s.exported && !s.defaultExport).map((s) => s.name));
  // Which call-sites reference a NAMED export (those would rewire if that symbol moves).
  const rewires = [];
  for (const dep of b.dependents) {
    if (!exportedNames.size) break;
    let depSrc;
    try { depSrc = fs.readFileSync(path.join(REPO_ROOT, dep), 'utf8'); } catch { continue; }
    const used = [...exportedNames].filter((n) => new RegExp(`\\b${n}\\b`).test(depSrc));
    if (used.length) rewires.push({ file: dep, symbols: used });
  }

  const proposedModules = groups.length;
  return {
    file: rel,
    totalLines,
    kind: isComponent ? 'component' : 'module',
    entry: entry ? { name: entry.name, lines: entry.lines } : null,
    blast: { dependentCount: b.dependentCount, sensitive: b.sensitive },
    symbolCount: symbols.length,
    symbols: symbols.map((s) => ({ name: s.name, role: s.role, lines: s.lines, exported: s.exported, startLine: s.startLine })),
    groups: groups.sort((a, b) => b.lines - a.lines),
    rewires,
    summary:
      `Split ${path.posix.basename(rel)} (${totalLines} lines, ${symbols.length} symbols) into ~${proposedModules} module(s). ` +
      `${entry ? `${entry.name} stays as the entry. ` : ''}` +
      `${b.dependentCount} file(s) import this; ${rewires.length ? `${rewires.length} reference named exports and would rewire` : 'only the default export is used, so nothing external rewires'}.`,
  };
}
