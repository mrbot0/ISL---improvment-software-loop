import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import '../src/db_iteration.js';
import { parseCheckAll } from '../src/iteration/langRunners.js';

/**
 * The parse gate, on the file types it used to ignore entirely.
 *
 * `node --check` accepts `.js`, `.mjs` and `.cjs` and nothing else, so before this there was no
 * checker matching `.ts`, `.tsx` or `.jsx` at all — a React component with an unclosed element went
 * through the gate untouched and was scored on its diff. On a React or TypeScript codebase that is
 * the largest category of file in the repo.
 *
 * These run against `dashboard/`, because that is where a real parser lives (esbuild, via Vite).
 * Where no parser is installed the assertions flip to the property that matters even more: the gate
 * must report the language as SKIPPED, never as a pass it did not perform.
 */

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const DASH = path.join(ROOT, 'dashboard');
const hasParser = fs.existsSync(path.join(DASH, 'node_modules/esbuild')) || fs.existsSync(path.join(DASH, 'node_modules/typescript'));

const FILES = {
  '__pc_broken.jsx': 'export function A() {\n  return <div>unclosed\n}\n',
  '__pc_broken.ts': 'export const x: number = 1;\nfunction y( {\n',
  '__pc_broken.js': 'const a = ;\n',
  '__pc_ok.tsx': 'export const ok = () => <b>fine</b>;\n',
  '__pc_ok.js': 'const fine = 1;\nexport default fine;\n',
};

before(() => { for (const [name, body] of Object.entries(FILES)) fs.writeFileSync(path.join(DASH, name), body); });
after(() => { for (const name of Object.keys(FILES)) { try { fs.rmSync(path.join(DASH, name), { force: true }); } catch { /* gone */ } } });

const check = (names) => parseCheckAll(DASH, names);
const named = (issues, file) => issues.some((i) => i.startsWith(`${file}:`));

test('a .js syntax error is caught — the case that always worked', async () => {
  const r = await check(['__pc_broken.js']);
  assert.ok(named(r.issues, '__pc_broken.js'));
});

test('a .jsx syntax error is caught', async (t) => {
  const r = await check(['__pc_broken.jsx']);
  if (!hasParser) {
    assert.ok(r.skipped.includes('typescript'), 'with no parser it must SKIP, never pass silently');
    assert.equal(r.issues.length, 0);
    return t.skip('no esbuild or typescript installed in dashboard/');
  }
  assert.ok(named(r.issues, '__pc_broken.jsx'), `expected a diagnostic, got ${JSON.stringify(r)}`);
  // A location without a diagnosis was a real failure mode of this gate before; the message has to
  // say what is wrong, not only where.
  assert.match(r.issues[0], /SyntaxError|Unexpected|Expected/);
});

test('a .ts syntax error is caught', async (t) => {
  const r = await check(['__pc_broken.ts']);
  if (!hasParser) return t.skip('no esbuild or typescript installed in dashboard/');
  assert.ok(named(r.issues, '__pc_broken.ts'), `expected a diagnostic, got ${JSON.stringify(r)}`);
});

test('VALID .tsx and .js are not flagged', async () => {
  // The failure that matters most. An early version resolved its own helper through a
  // percent-encoded URL path, so on a checkout containing a space every .ts/.tsx/.jsx file failed
  // the gate with "cannot find module" — a tool rejecting correct code because of where it lives.
  const r = await check(['__pc_ok.tsx', '__pc_ok.js']);
  assert.deepEqual(r.issues, []);
});

test('the checker reports which languages it actually verified', async (t) => {
  const r = await check(['__pc_ok.tsx', '__pc_ok.js']);
  assert.ok(r.checkedLangs.includes('node'));
  if (!hasParser) return t.skip('no esbuild or typescript installed in dashboard/');
  assert.ok(r.checkedLangs.includes('typescript'));
});

test('a file that does not exist is skipped, not failed', async () => {
  const r = await check(['__pc_absent.tsx']);
  assert.deepEqual(r.issues, []);
});

test('an unknown extension is left alone', async () => {
  const r = await check(['__pc_broken.zzz']);
  assert.deepEqual(r.issues, []);
  assert.deepEqual(r.checkedLangs, []);
});
