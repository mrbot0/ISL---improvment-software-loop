/**
 * Passa il gate di scope su un intero albero di sorgenti.
 *
 *   node tools/scopeScan.mjs [dir...]
 *
 * Serve a una domanda sola, e non è "trova i bug": è **il gate è silenzioso su codice sano?**
 * Una veto con falsi positivi blocca ogni run e viene disattivata entro una settimana, il che la
 * rende peggio che inutile. Prima di collegarlo alla pipeline deve essere muto su ciò che funziona.
 */
import fs from 'node:fs';
import path from 'node:path';
import { unboundNames } from '../src/iteration/scopeGate.js';

const roots = process.argv.slice(2);
if (!roots.length) {
  console.error('uso: node tools/scopeScan.mjs <dir> [dir...]');
  process.exit(2);
}

const SKIP = new Set(['node_modules', 'dist', 'build', 'coverage', '.next']);

function walk(dir, out = []) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    if (e.name.startsWith('.') || SKIP.has(e.name)) continue;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) walk(full, out);
    else if (/\.(js|jsx|mjs)$/.test(e.name) && !/\.(test|spec)\./.test(e.name)) out.push(full);
  }
  return out;
}

let scanned = 0;
const findings = [];
for (const root of roots) {
  for (const file of walk(root)) {
    scanned++;
    let code;
    try {
      code = fs.readFileSync(file, 'utf8');
    } catch {
      continue;
    }
    const { calls, components } = unboundNames(code);
    const all = [...calls, ...components];
    if (all.length) findings.push({ file: file.split(path.sep).join('/'), names: all });
  }
}

console.log(`${scanned} file · file con segnalazioni: ${findings.length}`);
for (const f of findings.slice(0, 30)) console.log(`   ${f.file}  →  ${f.names.join(', ')}`);
if (findings.length > 30) console.log(`   … e altri ${findings.length - 30}`);
process.exit(findings.length ? 1 : 0);
