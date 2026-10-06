import path from 'node:path';
import { git } from '../sandbox/worktree.js';
import { PRODUCT_DIRS } from '../config.js';

/**
 * Deterministic DEAD-CODE detector.
 *
 * The failure mode this closes: a "refactor" task that creates a new hook / helper /
 * util file (or adds a new exported symbol) but never wires it in — the original code
 * is untouched, the new abstraction is imported by nobody, and the reviewer waves it
 * through with a high score. That is not an improvement, it is cruft plus the same
 * duplication as before.
 *
 * We catch it structurally: parse the diff for newly-added files and newly-exported
 * symbols, then ask git whether anything ELSE in the product code references them. A
 * symbol used only in the file that defines it is dead. Cheap, language-aware for the
 * JS/TS family (where the risk lives), and conservative — when in doubt it stays quiet,
 * so it flags real cruft without vetoing honest work.
 */

const CODE_RE = /\.(jsx?|tsx?|mjs|cjs)$/;
const TEST_RE = /(^|\/)__tests__\/|\.(test|spec)\.[jt]sx?$/;

// Files that are legitimately imported by nobody — entrypoints, config loaded by
// convention, migrations, type decls. Never flag these as "dead".
const ENTRY_RE = /(^|\/)(index|main|server|app|routes?|migrations?|seed|setup|vite\.config|\.d)\.[jt]sx?$|(^|\/)(migrations|prisma)\//i;

/** Pull the newly-added files and newly-exported symbols out of a unified diff. */
function parseDiff(diff) {
  const newFiles = new Set();
  const addedExports = []; // { file, symbol }
  let curFile = null;
  let pendingNew = false;

  for (const line of String(diff).split('\n')) {
    if (line.startsWith('--- ')) {
      pendingNew = line === '--- /dev/null';
      continue;
    }
    const mf = line.match(/^\+\+\+ b\/(.+)$/);
    if (mf) {
      curFile = mf[1] === 'dev/null' ? null : mf[1];
      if (pendingNew && curFile) newFiles.add(curFile);
      pendingNew = false;
      continue;
    }
    if (!curFile || !line.startsWith('+') || line.startsWith('+++')) continue;
    const body = line.slice(1);
    // ESM + CommonJS export forms.
    let m;
    if ((m = body.match(/^\s*export\s+(?:async\s+)?(?:function|class)\s+([A-Za-z_$][\w$]*)/))) addedExports.push({ file: curFile, symbol: m[1] });
    else if ((m = body.match(/^\s*export\s+(?:const|let|var)\s+([A-Za-z_$][\w$]*)/))) addedExports.push({ file: curFile, symbol: m[1] });
    else if ((m = body.match(/^\s*export\s*\{\s*([^}]+)\}/))) {
      for (const part of m[1].split(',')) {
        const name = part.trim().split(/\s+as\s+/)[0].trim();
        if (/^[A-Za-z_$][\w$]*$/.test(name)) addedExports.push({ file: curFile, symbol: name });
      }
    } else if ((m = body.match(/^\s*(?:module\.)?exports\.([A-Za-z_$][\w$]*)\s*=/))) addedExports.push({ file: curFile, symbol: m[1] });
  }
  return { newFiles, addedExports };
}

/** Files (other than `self`) in the product code that reference `needle` as a whole word. */
function referencedIn(sandboxRoot, needle, self) {
  const dirs = PRODUCT_DIRS.filter(Boolean);
  if (!dirs.length) return [];
  try {
    const out = git(['grep', '-lIw', '--untracked', '-e', needle, '--', ...dirs], sandboxRoot);
    return out.split('\n').map((s) => s.trim()).filter((f) => f && f !== self);
  } catch {
    // git grep exits non-zero when there are no matches — that means "unused".
    return [];
  }
}

/**
 * @returns {Array<{file, symbol, kind:'unused-file'|'unused-export', message}>}
 */
export function findDeadCode({ diff, sandboxRoot }) {
  if (!diff || !diff.trim()) return [];
  const { newFiles, addedExports } = parseDiff(diff);
  const findings = [];

  // 1) A brand-new module that nothing imports.
  for (const f of newFiles) {
    if (!CODE_RE.test(f) || TEST_RE.test(f) || ENTRY_RE.test(f)) continue;
    const base = path.basename(f).replace(CODE_RE, '');
    if (!referencedIn(sandboxRoot, base, f).length) {
      findings.push({ file: f, symbol: base, kind: 'unused-file', message: `New file ${f} is imported by nothing — dead code. Wire it in or drop it.` });
    }
  }

  // 2) A new export added to an existing file that nothing uses.
  const seen = new Set();
  for (const { file, symbol } of addedExports) {
    if (newFiles.has(file)) continue; // covered by the file-level check
    if (!CODE_RE.test(file) || TEST_RE.test(file)) continue;
    const key = `${file}::${symbol}`;
    if (seen.has(key)) continue;
    seen.add(key);
    if (!referencedIn(sandboxRoot, symbol, file).length) {
      findings.push({ file, symbol, kind: 'unused-export', message: `New export "${symbol}" in ${file} is used nowhere — dead code.` });
    }
  }

  return findings.slice(0, 12);
}

/** Just the created-but-unimported files — the high-confidence subset used as a hard gate. */
export function findUnusedNewFiles({ diff, sandboxRoot }) {
  return findDeadCode({ diff, sandboxRoot }).filter((f) => f.kind === 'unused-file');
}

/**
 * Given the files a task CREATED, return the ones nothing imports. Used by the
 * implementer to catch dead code at the source — before it ever reaches review — so
 * it can wire the new module in (or delete it) instead of shipping cruft.
 */
export function unusedCreatedFiles(sandboxRoot, files = []) {
  const out = [];
  for (const f of files) {
    if (!CODE_RE.test(f) || TEST_RE.test(f) || ENTRY_RE.test(f)) continue;
    const base = path.basename(f).replace(CODE_RE, '');
    if (!referencedIn(sandboxRoot, base, f).length) out.push(f);
  }
  return out;
}
