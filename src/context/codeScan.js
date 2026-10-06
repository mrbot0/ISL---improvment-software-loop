import fs from 'node:fs';
import path from 'node:path';
import { REPO_ROOT } from '../config.js';
import { LANGUAGES, NON_CODE_FAMILIES, languageOf } from '../languages.js';
import { setContext, getContext } from './contextDb.js';

/**
 * Language composition of the project. The Context Manager not only reads the
 * docs — it validates what code is actually present and in which languages, so
 * the Overview can show the real breakdown (how much JS vs PY vs …).
 */

const IGNORE_DIRS = new Set([
  'node_modules', '.git', 'dist', 'build', 'coverage', '.data', '.next', '.nuxt',
  'out', 'vendor', '.claude', '.cache', 'tmp', '.venv', 'venv', '__pycache__', '.turbo',
  'bower_components', '.pytest_cache', '.idea', '.vscode', 'target', 'bin', 'obj',
]);

const MAX_FILE_BYTES = 2_000_000;

/** Resolve a filename to [displayName, accent] via the shared language registry. */
function langFor(name) {
  const key = languageOf(name);
  if (!key) return null;
  const def = LANGUAGES[key];
  return [def.name, def.accent, key];
}

/**
 * Walk the project and tally files + non-blank lines per language. Bounded and
 * best-effort; returns a structure ready for the Overview chart.
 */
export function scanCodebase({ root = REPO_ROOT, includeMarkup = false } = {}) {
  const byLang = new Map();
  let totalFiles = 0;
  let totalLines = 0;
  const otherExt = new Map();

  const visit = (dir, depth) => {
    if (depth > 14) return;
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (e.isDirectory()) {
        if (IGNORE_DIRS.has(e.name) || (e.name.startsWith('.') && e.name !== '.')) continue;
        visit(path.join(dir, e.name), depth + 1);
      } else if (e.isFile()) {
        const info = langFor(e.name);
        if (!info) {
          const ext = path.extname(e.name).toLowerCase();
          if (ext) otherExt.set(ext, (otherExt.get(ext) || 0) + 1);
          continue;
        }
        const [lang, accent, key] = info;
        const abs = path.join(dir, e.name);
        let lines = 0;
        try {
          const stat = fs.statSync(abs);
          if (stat.size > MAX_FILE_BYTES) continue;
          const text = fs.readFileSync(abs, 'utf8');
          lines = text.split('\n').filter((l) => l.trim()).length;
        } catch {
          continue;
        }
        const cur = byLang.get(lang) || { lang, accent, key, files: 0, lines: 0 };
        cur.files++;
        cur.lines += lines;
        byLang.set(lang, cur);
        totalFiles++;
        totalLines += lines;
      }
    }
  };
  visit(root, 0);

  // "Code" percentage excludes pure markup/config/docs unless asked, so real code
  // languages (JS, PY, ABAP, …) read true against each other.
  const isMarkup = (l) => NON_CODE_FAMILIES.has(LANGUAGES[l.key]?.family);
  const all = [...byLang.values()];
  const codeLangs = all.filter((l) => includeMarkup || !isMarkup(l));
  const codeLines = codeLangs.reduce((a, l) => a + l.lines, 0) || 1;

  const byLanguage = all
    .map((l) => ({
      lang: l.lang,
      accent: l.accent,
      key: l.key,
      family: LANGUAGES[l.key]?.family || 'other',
      files: l.files,
      lines: l.lines,
      pct: isMarkup(l) ? null : Math.round((l.lines / codeLines) * 1000) / 10,
      pctAll: Math.round((l.lines / (totalLines || 1)) * 1000) / 10,
    }))
    .sort((a, b) => b.lines - a.lines);

  const topOther = [...otherExt.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8).map(([ext, n]) => ({ ext, files: n }));

  return {
    totalFiles,
    totalLines,
    codeLines,
    languages: byLanguage.length,
    byLanguage,
    otherExtensions: topOther,
    scannedAt: Date.now(),
  };
}

/** Scan and persist the composition into the project's context store. */
export function refreshCodeStats() {
  const stats = scanCodebase();
  setContext('codeStats', stats);
  return stats;
}

export const getCodeStats = () => getContext('codeStats', null);

/**
 * Collect up to `perLanguage` representative files for each requested language
 * key (largest-first), for the compliance checker to read. Returns
 * { langKey: [{ relPath, absPath, lines }] }.
 */
export function sampleFilesByLanguage({ root = REPO_ROOT, languages = null, perLanguage = 3 } = {}) {
  const want = languages ? new Set(languages) : null;
  const buckets = {};

  const visit = (dir, depth) => {
    if (depth > 14) return;
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (e.isDirectory()) {
        if (IGNORE_DIRS.has(e.name) || (e.name.startsWith('.') && e.name !== '.')) continue;
        visit(path.join(dir, e.name), depth + 1);
      } else if (e.isFile()) {
        const key = languageOf(e.name);
        if (!key || (want && !want.has(key))) continue;
        const abs = path.join(dir, e.name);
        let lines = 0;
        try {
          const stat = fs.statSync(abs);
          if (stat.size > MAX_FILE_BYTES) continue;
          lines = fs.readFileSync(abs, 'utf8').split('\n').length;
        } catch {
          continue;
        }
        (buckets[key] ||= []).push({ relPath: path.relative(root, abs).split(path.sep).join('/'), absPath: abs, lines });
      }
    }
  };
  visit(root, 0);

  // Keep the biggest files per language — they carry the most to check.
  for (const key of Object.keys(buckets)) {
    buckets[key] = buckets[key].sort((a, b) => b.lines - a.lines).slice(0, perLanguage);
  }
  return buckets;
}
