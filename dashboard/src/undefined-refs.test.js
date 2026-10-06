import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * A STANDING GUARD FOR THE ONE BUG THE BUILD CANNOT SEE.
 *
 * Vite compiles JSX without resolving identifiers, and there is no linter configured, so a component
 * used but never imported builds cleanly and throws only when a user opens that page. This project
 * has shipped that bug twice: a focus-trap ref declared in one component and used in another, and a
 * tab shell referenced before its import existed. Both times the build was green.
 *
 * The check is deliberately narrow — JSX element names, which are unambiguous — so it has no false
 * positives and nobody is tempted to weaken it. It does not catch undefined plain variables; only a
 * real linter would.
 */

const SRC = dirname(fileURLToPath(import.meta.url));

function jsxFiles(dir = SRC, out = []) {
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry === 'dist') continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) jsxFiles(full, out);
    else if (entry.endsWith('.jsx') && !entry.includes('.test.')) out.push(full);
  }
  return out;
}

/**
 * Drop comments before scanning. Several files document their own usage with a JSX example in the
 * header — `<Resource>{(d) => <RunList …/>}</Resource>` — and a component named only in prose is not
 * a missing import. The `[^:]` guard keeps `http://` in a string from swallowing the rest of a line.
 */
function stripComments(code) {
  return code.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
}

/** Element names used in JSX: `<Foo`, `<Foo.Bar` — capitalised, so never a DOM tag. */
function usedComponents(code) {
  const names = new Set();
  for (const m of code.matchAll(/<([A-Z][\w]*)/g)) names.add(m[1]);
  return names;
}

/**
 * Hooks called in this file: `useState(`, `useResource(`, `useFocusTrap(`.
 *
 * A second zero-noise rule, added after `useResource` was called in a view that never imported it —
 * the build was green and the page threw only when opened. Hooks are always imported or defined in
 * the file; there is no such thing as a global one, so a name matching `use[A-Z]…` that is nowhere
 * bound is always a missing import. `.useState(` on an object is excluded by the leading guard.
 */
function usedHooks(code) {
  const names = new Set();
  for (const m of code.matchAll(/(^|[^.\w$])(use[A-Z][\w$]*)\s*\(/g)) names.add(m[2]);
  return names;
}

/**
 * Names the file can legitimately use: anything imported, and anything bound at any depth —
 * `const X = …`, `function X`, `class X`, and destructured `{ X }`. Over-permissive by design:
 * this test exists to catch the name that is nowhere, not to police shadowing.
 */
function boundNames(code) {
  const names = new Set();
  for (const m of code.matchAll(/^\s*import\s+([\s\S]*?)\s+from\s+/gm)) {
    for (const n of m[1].matchAll(/[A-Za-z_$][\w$]*/g)) names.add(n[0]);
  }
  for (const m of code.matchAll(/\b(?:const|let|var|function|class)\s+([A-Za-z_$][\w$]*)/g)) names.add(m[1]);
  for (const m of code.matchAll(/[{,]\s*([A-Z][\w$]*)\s*[,}:=]/g)) names.add(m[1]);
  return names;
}

// React's own elements are provided by the runtime import, not by a binding in the file.
const BUILT_IN = new Set(['Fragment', 'Suspense', 'StrictMode', 'Profiler']);

/** The detector, checked against the two shapes it exists for. A guard nobody has seen fail is a
 *  guard nobody knows works. */
describe('the detector itself', () => {
  const missing = (code) => {
    const c = stripComments(code);
    const bound = boundNames(c);
    return [...usedComponents(c), ...usedHooks(c)].filter((n) => !bound.has(n) && !BUILT_IN.has(n));
  };

  it('catches a component that is used but never imported', () => {
    // The exact bug that shipped: the tab shell referenced before its import existed.
    expect(missing('function App() { return <TabbedView tabs={[]} />; }')).toEqual(['TabbedView']);
  });

  it('accepts a component that is imported, declared, or destructured', () => {
    expect(missing("import Foo from './Foo.jsx';\nconst a = <Foo />;")).toEqual([]);
    expect(missing('function Foo() { return null; }\nconst a = <Foo />;')).toEqual([]);
    expect(missing("import { Bar } from './ui.jsx';\nconst a = <Bar />;")).toEqual([]);
    expect(missing('const { Baz } = mod;\nconst a = <Baz />;')).toEqual([]);
  });

  it('ignores a component named only in a comment', () => {
    expect(missing('/* usage: <RunList runs={d} /> */\nconst a = 1;')).toEqual([]);
  });

  it('catches a hook called without an import', () => {
    // The second time this shipped: a view called useResource and never imported it.
    expect(missing('function V() { const r = useResource(key, f); return null; }')).toEqual(['useResource']);
    expect(missing("import { useResource } from './hooks.js';\nconst r = useResource(key, f);")).toEqual([]);
  });

  it('does not mistake a method call for a bare hook', () => {
    expect(missing('const r = React.useState(0);')).toEqual([]);
  });

  it('does not mistake a lowercase DOM tag for a component', () => {
    expect(missing('const a = <div><span /></div>;')).toEqual([]);
  });
});

describe('every JSX component is actually in scope', () => {
  const files = jsxFiles();

  it('finds the source files to check', () => {
    expect(files.length).toBeGreaterThan(20);
  });

  for (const file of files) {
    const rel = file.slice(SRC.length + 1).replace(/\\/g, '/');
    it(`${rel} references nothing undefined`, () => {
      const code = stripComments(readFileSync(file, 'utf8'));
      const bound = boundNames(code);
      const used = [...usedComponents(code), ...usedHooks(code)];
      const missing = used.filter((n) => !bound.has(n) && !BUILT_IN.has(n));
      expect(missing, `${rel} uses ${missing.join(', ')} without importing or declaring it`).toEqual([]);
    });
  }
});
