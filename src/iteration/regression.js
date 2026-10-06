import fs from 'node:fs';
import path from 'node:path';
import { CODE_DIRS } from '../config.js';
import { getGoldenSurface, saveGoldenSurface } from '../db_iteration.js';
import { log } from '../logger.js';

/**
 * Regression guard via a "golden surface": the set of public exports and routes
 * the app exposes. If an iteration removes or renames items from that surface it
 * has probably broken a caller the tests don't cover, so we score it down and —
 * for outright removals — veto the whole iteration regardless of other scores.
 *
 * The surface is captured from a directory tree (the sandbox during an iteration,
 * or the real repo when taking the initial baseline).
 */

const SKIP = /node_modules|\.test\.|\.spec\.|\.min\./;

function walk(dir, out = []) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    const abs = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (!/node_modules|\.git|dist|build|coverage/.test(e.name)) walk(abs, out);
    } else if (/\.(js|jsx|mjs|cjs)$/.test(e.name) && !SKIP.test(abs)) out.push(abs);
  }
  return out;
}

/** Collect the public surface of a checkout rooted at `root`. */
export function collectSurface(root) {
  const surface = [];
  for (const d of CODE_DIRS) {
    // CODE_DIRS read live — it is empty until a project is activated.
    for (const abs of walk(path.join(root, d))) {
      let src;
      try {
        src = fs.readFileSync(abs, 'utf8');
      } catch {
        continue;
      }
      const rel = path.relative(root, abs).split(path.sep).join('/');
      const push = (name) => name && surface.push(`${rel}#${name}`);

      // CommonJS: module.exports = { a, b } and module.exports.x = / exports.x =
      let m;
      const reCjs = /(?:module\.)?exports\.([A-Za-z0-9_]+)\s*=/g;
      while ((m = reCjs.exec(src))) push(m[1]);
      const block = src.match(/module\.exports\s*=\s*\{([\s\S]*?)\}/);
      if (block) for (const part of block[1].split(',')) {
        const nm = part.split(':')[0].trim();
        if (/^[A-Za-z0-9_]+$/.test(nm)) push(nm);
      }
      // ESM: export const/function/class X, export { a, b }
      const reEsm = /export\s+(?:async\s+)?(?:const|function|class|let)\s+([A-Za-z0-9_]+)/g;
      while ((m = reEsm.exec(src))) push(m[1]);
      const named = src.match(/export\s*\{([^}]*)\}/g) || [];
      for (const grp of named) for (const part of grp.replace(/export\s*\{|\}/g, '').split(',')) {
        const nm = part.split(/\s+as\s+/)[0].trim();
        if (/^[A-Za-z0-9_]+$/.test(nm)) push(nm);
      }
      // Routes
      const reRoute = /\b(?:router|app)\.(get|post|put|patch|delete)\(\s*['"`]([^'"`]+)['"`]/g;
      while ((m = reRoute.exec(src))) push(`${m[1].toUpperCase()} ${m[2]}`);
    }
  }
  return [...new Set(surface)];
}

/** Take (or refresh) the baseline from the real repo. */
export function takeBaseline(root, commitSha) {
  const surface = collectSurface(root);
  saveGoldenSurface(surface, commitSha);
  return surface.length;
}

/**
 * Compare a candidate checkout against the golden surface.
 * @returns {{score:number, removed:string[], added:number, veto:boolean, summary:string}}
 */
export function check({ root, logger = log.for('regression') } = {}) {
  const golden = getGoldenSurface();
  if (!golden || !golden.surface.length) {
    // No baseline yet: adopt the candidate as the baseline, don't penalise.
    const surface = collectSurface(root);
    saveGoldenSurface(surface, null);
    const summary = `No baseline — captured ${surface.length} surface items as the golden set.`;
    logger.info?.(summary);
    return { score: 100, removed: [], added: surface.length, veto: false, summary };
  }

  const current = new Set(collectSurface(root));
  const removed = golden.surface.filter((s) => !current.has(s));
  const added = [...current].filter((s) => !golden.surface.includes(s)).length;

  // Every removed public item is a potential breaking change. Score falls fast.
  const score = Math.max(0, 100 - removed.length * 20);
  const veto = removed.length > 0;
  const summary = removed.length
    ? `${removed.length} public surface item(s) removed: ${removed.slice(0, 5).join(', ')}${removed.length > 5 ? '…' : ''}`
    : `Public surface intact (+${added} new). No regressions.`;
  logger[removed.length ? 'warn' : 'info']?.(summary);
  return { score, removed, added, veto, summary };
}
