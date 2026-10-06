import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkScope, unboundNames } from '../src/iteration/scopeGate.js';

/**
 * THE BUG THAT PASSES EVERY OTHER GATE.
 *
 * Run #322 shipped `t(...)` inside a component that never bound `t`. The parse gate runs
 * `node --check` and `t(...)` is valid syntax; no suite exercised that click handler; the app booted
 * fine, because the throw happens when a user opens the panel; and the LLM reviewer scored the
 * change **95 out of 100**. Reading scope across sibling components is exactly the bookkeeping a
 * language model does not do reliably and a machine does perfectly.
 *
 * The same shape has now shipped three times in ISL's own dashboard and at least four times in the
 * application it edits.
 *
 * The gate is scoped to the files a change touched: a pre-existing unbound name elsewhere in the
 * repository is not this change's fault and must not block it.
 */

/** A diff touching one file, with the file's content supplied by a fake reader. */
const diffFor = (file) => `diff --git a/${file} b/${file}\n--- a/${file}\n+++ b/${file}\n@@ -1,1 +1,1 @@\n+x`;
const reader = (content) => () => content;

test('catches the exact shape that broke the search bar', () => {
  const code = `
    import { useT } from '../i18n.jsx';
    function Parent() { const t = useT(); return <div>{t('a')}</div>; }
    function SuggestPanel({ q }) { return <div aria-label={t('search.suggestions')}>{q}</div>; }
  `;
  const r = checkScope(diffFor('app/SearchBar.jsx'), { readFile: reader(code) });
  assert.equal(r.veto, true);
  assert.ok(r.findings.some((f) => f.name === 't'), 't is bound in the parent, not in SuggestPanel');
  assert.match(r.summary, /throws at runtime/);
});

test('passes the same file once the hook is called in the component', () => {
  const fixed = `
    import { useT } from '../i18n.jsx';
    function Parent() { const t = useT(); return <div>{t('a')}</div>; }
    function SuggestPanel({ q }) { const t = useT(); return <div aria-label={t('search.suggestions')}>{q}</div>; }
  `;
  assert.equal(checkScope(diffFor('app/SearchBar.jsx'), { readFile: reader(fixed) }).veto, false);
});

test('catches a component used but never imported', () => {
  const code = 'function App() { return <TabbedView tabs={[]} />; }';
  const r = checkScope(diffFor('src/App.jsx'), { readFile: reader(code) });
  assert.equal(r.veto, true);
  assert.equal(r.findings[0].name, 'TabbedView');
  assert.equal(r.findings[0].kind, 'component');
});

test('catches a helper that does not exist', () => {
  // `changedPathsFrom(diff)` — called in a grader for a function nobody ever wrote.
  const code = "import { briefingFor } from './x.js';\nconst p = changedPathsFrom(diff);";
  const r = checkScope(diffFor('src/graders.js'), { readFile: reader(code) });
  assert.ok(r.findings.some((f) => f.name === 'changedPathsFrom'));
});

test('accepts imports, declarations, parameters and destructuring', () => {
  const code = `
    import { helper } from './x.js';
    import React, { useState } from 'react';
    export function run(input, { onDone }) {
      const [value, setValue] = useState(0);
      const local = (n) => n + 1;
      setValue(local(value));
      onDone(helper(input));
      return React.createElement('div');
    }
  `;
  const r = checkScope(diffFor('src/run.js'), { readFile: reader(code) });
  assert.equal(r.veto, false, `unexpected: ${r.summary}`);
});

test('does not flag browser or Node globals', () => {
  const code = `
    export function boot() {
      const c = new AbortController();
      setTimeout(() => console.log(JSON.stringify({ ok: true })), 10);
      return fetch('/x', { signal: c.signal }).then((r) => r.json());
    }
  `;
  assert.equal(checkScope(diffFor('src/boot.js'), { readFile: reader(code) }).veto, false);
});

test('ignores names that only appear in comments or strings', () => {
  const code = [
    '// usage: renderThing(props)',
    '/* see alsoMissingHelper() */',
    "const msg = 'call somethingUndefined() to start';",
    'export const ok = 1;',
  ].join('\n');
  assert.equal(checkScope(diffFor('src/x.js'), { readFile: reader(code) }).veto, false);
});

test('skips languages whose scoping it does not understand', () => {
  const r = checkScope(diffFor('services/api/main.py'), { readFile: reader('print(undefined_thing())') });
  assert.equal(r.checked, false);
  assert.equal(r.veto, false);
});

test('a deleted file is not a reason to veto', () => {
  const throwing = () => { throw new Error('ENOENT'); };
  const r = checkScope(diffFor('src/gone.js'), { readFile: throwing });
  assert.equal(r.veto, false);
  assert.equal(r.checked, false);
});

test('says so when there is nothing to check, rather than passing silently', () => {
  const r = checkScope('', { readFile: reader('') });
  assert.equal(r.checked, false);
  assert.match(r.summary, /no JavaScript files changed/);
});

test('reports every offending name, not just the first', () => {
  const code = 'function f() { return alpha() + beta() + gamma(); }';
  const r = checkScope(diffFor('src/x.js'), { readFile: reader(code) });
  assert.equal(r.findings.length, 3);
});

test('an apostrophe in prose does not blind the analyser', () => {
  /*
   * Il difetto peggiore trovato finora, perché non produceva un errore ma il SILENZIO.
   *
   * Il testo dentro JSX non è una stringa. `l'accesso` in una riga di prosa apriva uno stato
   * "stringa" che divorava tutto fino alla virgoletta successiva — su un file reale cinque righe —
   * e da lì in poi la parità restava invertita per il resto del file. Il gate smetteva di vedere
   * sia le definizioni (falsi positivi) sia gli usi non legati (falsi negativi, che sono peggio).
   * Su un progetto scritto in italiano capita in quasi ogni pagina.
   */
  const code = [
    "function Panel() {",
    "  return <p>Conservali: permettono di accedere se perdi l'accesso al telefono</p>;",
    '}',
    'function Other() { return mancaDavvero(); }',
    'const usato = () => 1;',
  ].join('\n');
  const { calls } = unboundNames(code);
  assert.deepEqual(calls, ['mancaDavvero'], 'la prosa ha inghiottito il codice che la segue');
});

test('a real multi-line construct is still read as a string', () => {
  // Le stringhe vere restano stringhe: quello che c'è dentro non deve diventare una segnalazione.
  const code = "const q = 'chiamata a nonEsiste() dentro una stringa';\nexport const ok = 1;";
  assert.deepEqual(unboundNames(code).calls, []);
});

test('a self-closing JSX tag next to a template literal is not a regex', () => {
  /*
   * `<Users size={11} />` — il test che riconosce una regex guardava se UNO QUALSIASI degli ultimi
   * otto caratteri stava in posizione di valore, e `size={11}` contiene `=` e `{`. La barra del tag
   * passava per inizio di regex, correva fino alla barra dentro il template della riga e si portava
   * via il backtick di APERTURA: quello di chiusura ne apriva uno nuovo che divorava settantasette
   * righe. I due componenti definiti in quel tratto sparivano e venivano dati per inesistenti.
   */
  const code = [
    "import { Users } from 'lucide-react';",
    'function Row({ e }) {',
    '  return <span><Users size={11} /> {e.n}{e.cap > 0 ? ` / ${e.cap}` : \'\'}</span>;',
    '}',
    'function Stat({ v }) { return <b>{v}</b>; }',
    'export default function All() { return <div><Row e={{}} /><Stat v={1} /></div>; }',
  ].join('\n');
  assert.deepEqual(unboundNames(code).components, [], 'il tag autochiudente ha inghiottito il file');
});

test('unboundNames separates calls from components', () => {
  const { calls, components } = unboundNames('function A() { return <Missing />; }\nconst z = alsoMissing();');
  assert.deepEqual(calls, ['alsoMissing']);
  assert.deepEqual(components, ['Missing']);
});
