import fs from 'node:fs';
import path from 'node:path';
import { REPO_ROOT, PRODUCT_DIRS } from '../config.js';
import { scanFiles } from './structuralScan.js';
import { addFeature } from '../db_iteration.js';

/**
 * APPLY ISL'S OWN GATES TO THE TARGET APP — static frontend audit (ISL_IMPROVE "Deeper capability",
 * P1). ISL improves accessibility and i18n of the apps it works on — so it should AUDIT them and
 * feed the findings back as real improvement work. This is a deterministic static pass over the
 * target's JSX/TSX for the highest-signal, lowest-false-positive issues:
 *
 *   - img-no-alt          : <img> with no alt text (screen-reader gap)
 *   - click-non-interactive: onClick on a <div>/<span>/… with no role (keyboard/AT gap)
 *   - anchor-no-href      : <a onClick> with no href (not focusable/operable by keyboard)
 *   - hardcoded-string    : visible UI text not wrapped in i18n — ONLY in files that already use
 *                           i18n, so it flags a genuine translation gap, not an un-internationalised
 *                           app
 *
 * No browser, no run — just the source, so it's fast and works anywhere. Real findings become
 * frontend/ux backlog tasks.
 */

const FE_RE = /\.(jsx|tsx|vue|svelte)$/;
const MAX_BYTES = 600_000;

// A file "uses i18n" if it pulls in a translation mechanism — only then is bare text a real gap.
const I18N_HINT = /\b(useTranslation|useLocale|useI18n|i18n|<Trans\b|\bt\(\s*['"`])/;
// Non-interactive elements that shouldn't carry a raw onClick without a role.
const NONINTERACTIVE = /<(div|span|li|td|tr|p|section|article|header|footer|nav|ul|ol|img)\b[^>]*\bonClick[=]/g;

function lineOf(src, index) {
  let line = 1;
  for (let i = 0; i < index && i < src.length; i++) if (src[i] === '\n') line++;
  return line;
}

function auditFile(rel, src) {
  const findings = [];
  const add = (kind, index, snippet) => findings.push({ kind, file: rel, line: lineOf(src, index), snippet: snippet.slice(0, 100).replace(/\s+/g, ' ').trim() });

  // <img> without alt (JSX tag, may span lines)
  for (const m of src.matchAll(/<img\b[^>]*?\/?>/gs)) {
    if (!/\balt\s*=/.test(m[0])) add('img-no-alt', m.index, m[0]);
  }
  // onClick on a non-interactive element with no role
  for (const m of src.matchAll(NONINTERACTIVE)) {
    // Read the whole tag to check for role=
    const tagEnd = src.indexOf('>', m.index);
    const tag = src.slice(m.index, tagEnd > 0 ? tagEnd + 1 : m.index + 120);
    if (!/\brole\s*=/.test(tag)) add('click-non-interactive', m.index, tag);
  }
  // <a onClick> without href
  for (const m of src.matchAll(/<a\b[^>]*\bonClick[=][^>]*?>/gs)) {
    if (!/\bhref\s*=/.test(m[0])) add('anchor-no-href', m.index, m[0]);
  }
  // hardcoded visible strings — only in i18n-aware files
  if (I18N_HINT.test(src)) {
    // >Two or more words of letters< with no interpolation braces — likely untranslated UI text
    for (const m of src.matchAll(/>\s*([A-Za-z][A-Za-z']*(?:\s+[A-Za-z][A-Za-z']*){1,})\s*</g)) {
      const text = m[1];
      if (text.length < 4) continue;
      if (/^(https?|www|true|false|null|undefined)$/i.test(text)) continue;
      add('hardcoded-string', m.index, text);
      if (findings.filter((f) => f.kind === 'hardcoded-string').length >= 40) break; // cap per file
    }
  }
  return findings;
}

/** Which frontend dirs to scan: the product dirs that look like a frontend, else all. */
function frontendDirs() {
  const fe = PRODUCT_DIRS.filter((d) => /front|client|web|app|ui|dashboard/i.test(d));
  return fe.length ? fe : PRODUCT_DIRS;
}

/**
 * Audit the target frontend.
 * @returns {{ scanned, totals, files, findings }}
 */
export function auditFrontend({ root = REPO_ROOT, dirs } = {}) {
  const scanDirs = dirs || frontendDirs();
  const files = scanFiles({ root, dirs: scanDirs }).filter((f) => FE_RE.test(f.file) && !f.isTest);
  const totals = { 'img-no-alt': 0, 'click-non-interactive': 0, 'anchor-no-href': 0, 'hardcoded-string': 0, total: 0 };
  const perFile = new Map();
  const findings = [];

  for (const f of files) {
    let src;
    try {
      const abs = path.join(root, f.file);
      if (fs.statSync(abs).size > MAX_BYTES) continue;
      src = fs.readFileSync(abs, 'utf8');
    } catch { continue; }
    const fnd = auditFile(f.file, src);
    if (!fnd.length) continue;
    for (const x of fnd) { totals[x.kind]++; totals.total++; }
    perFile.set(f.file, (perFile.get(f.file) || 0) + fnd.length);
    findings.push(...fnd);
  }

  const filesRanked = [...perFile.entries()]
    .map(([file, count]) => ({ file, count }))
    .sort((a, b) => b.count - a.count);

  return { scanned: files.length, totals, files: filesRanked.slice(0, 40), findings: findings.slice(0, 300) };
}

const KIND_LABEL = {
  'img-no-alt': 'images missing alt text',
  'click-non-interactive': 'click handlers on non-interactive elements (no role)',
  'anchor-no-href': 'links without href',
  'hardcoded-string': 'un-translated UI strings',
};

/** Seed the worst frontend files as accessibility/i18n improvement tasks. */
export function seedFrontendBacklog({ max = 5 } = {}) {
  const { files, findings } = auditFrontend();
  let added = 0;
  for (const f of files.slice(0, max)) {
    const kinds = {};
    for (const x of findings) if (x.file === f.file) kinds[x.kind] = (kinds[x.kind] || 0) + 1;
    const detail = Object.entries(kinds).map(([k, n]) => `${n} ${KIND_LABEL[k] || k}`).join(', ');
    const title = `Fix accessibility/i18n issues in ${f.file.split('/').pop()} (${f.count})`.slice(0, 160);
    const description = [
      `ACCESSIBILITY / I18N — ${f.file} has ${f.count} issue(s): ${detail}.`,
      `Add missing alt text, give click-handling elements a proper role + keyboard support (or use a <button>), add href to links, and wrap visible UI strings in the app's i18n helper.`,
      `Target file: ${f.file}`,
      `Acceptance: the flagged issues are resolved without changing behaviour; existing tests still pass.`,
    ].join('\n');
    const id = addFeature({ title, description, area: 'frontend', source: 'a11y', priority: Math.min(75, 45 + f.count) });
    if (id) added++;
  }
  return { added, candidates: files.length };
}
