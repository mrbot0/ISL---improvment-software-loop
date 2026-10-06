import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * THE BACKEND EQUIVALENT OF THE DASHBOARD'S GUARD.
 *
 * There is no linter in this project. Node does not resolve an identifier until the line runs, so a
 * function called but never imported sits happily in a module until the one path that reaches it is
 * taken — which, for code inside a `catch` or a rarely-hit branch, can be weeks.
 *
 * The dashboard has had this guard since the third time it shipped there. The backend did not, and
 * it cost a call to `changedPathsFrom(diff)` — a helper that never existed — inside the review
 * grader, on the path that runs on every single iteration.
 *
 * Two checks, both chosen because they have no false positives:
 *
 *   1. **Called but nowhere bound.** `foo(...)` where `foo` is neither imported, declared, a
 *      parameter, nor a JavaScript global.
 *   2. **A class member defined twice.** Not an error in JavaScript — the later definition wins
 *      silently and the earlier becomes dead code. This project has been bitten by the same shape
 *      in its target application, where a duplicate `export` stopped a service from starting.
 */

const SRC = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src');

function jsFiles(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name.startsWith('.') || e.name === 'node_modules') continue;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) jsFiles(full, out);
    else if (e.name.endsWith('.js')) out.push(full);
  }
  return out;
}

/*
 * L'analizzatore NON vive qui.
 *
 * Questo file ne conteneva una copia completa — stripNonCode, boundNames, calledNames,
 * duplicateClassMembers e la lista dei nomi globali — e quella copia è rimasta indietro:
 * le mancava Uint8Array, e ha bocciato un modulo valido che lo usava. Una guardia che
 * sbaglia costringe a discutere con lei invece che col codice.
 *
 * Adesso importa la stessa implementazione che usa la pipeline. Se un giorno il gate
 * dovesse regredire, questo test regredisce con lui — che è esattamente ciò che serve:
 * una guardia che misura una copia diversa da quella in esercizio non misura nulla.
 */
import { stripNonCode, boundNames, calledNames, duplicateClassMembers } from '../src/iteration/staticAnalysis.js';
import { GLOBALS } from '../src/iteration/scopeGate.js';

const files = jsFiles(SRC);

test('the scanner finds the backend sources', () => {
  assert.ok(files.length > 50, `expected the backend to have more than 50 modules, found ${files.length}`);
});

test('no module calls a function it never imported or declared', () => {
  const problems = [];
  for (const f of files) {
    const code = stripNonCode(fs.readFileSync(f, 'utf8'));
    const bound = boundNames(code);
    for (const name of calledNames(code)) {
      if (!bound.has(name) && !GLOBALS.has(name)) {
        problems.push(`${path.relative(SRC, f).replace(/\\/g, '/')} → ${name}()`);
      }
    }
  }
  assert.deepEqual(problems, [], `these calls resolve to nothing:\n  ${problems.join('\n  ')}`);
});

test('no class defines the same member twice', () => {
  const problems = [];
  for (const f of files) {
    const code = stripNonCode(fs.readFileSync(f, 'utf8'));
    for (const d of duplicateClassMembers(code)) {
      problems.push(`${path.relative(SRC, f).replace(/\\/g, '/')} → ${d.cls}.${d.name} defined twice`);
    }
  }
  assert.deepEqual(problems, [], `the later definition silently wins:\n  ${problems.join('\n  ')}`);
});

test('the detector catches the two bugs it exists for', () => {
  const missing = 'const a = changedPathsFrom(diff);';
  const code = stripNonCode(missing);
  assert.ok(calledNames(code).has('changedPathsFrom'));
  assert.ok(!boundNames(code).has('changedPathsFrom'));

  const dup = 'class M {\n  broadcast(a) { return a; }\n  other() {}\n  broadcast(b, c) { return b; }\n}';
  const found = duplicateClassMembers(stripNonCode(dup));
  assert.equal(found.length, 1);
  assert.equal(found[0].name, 'broadcast');
});

test('the detector does not flag ordinary code', () => {
  const ok = [
    "import { helper } from './x.js';",
    'const local = (a) => a + 1;',
    'function top(b) { return helper(b) + local(b); }',
    'export class C { one() { return this.two(); } two() { return 1; } }',
  ].join('\n');
  const code = stripNonCode(ok);
  const bound = boundNames(code);
  const unbound = [...calledNames(code)].filter((n) => !bound.has(n) && !GLOBALS.has(n));
  assert.deepEqual(unbound, []);
  assert.deepEqual(duplicateClassMembers(code), []);
});
