/**
 * AN IDENTIFIER THAT IS NOWHERE.
 *
 * `t(...)` inside a component that never bound `t`. `useResource(...)` in a view that never
 * imported it. `changedPathsFrom(diff)` in a grader, for a helper that does not exist. The same
 * mistake three times in ISL's own dashboard, and at least four times in the application it edits.
 *
 * Nothing in the pipeline could see it:
 *
 *   - the PARSE gate runs `node --check`, and `t(...)` is perfectly valid syntax;
 *   - the TEST gate only fails if a suite exercises that line, and the code in question is a
 *     click handler or a rarely-taken branch;
 *   - the WORKBENCH gate boots the app, and the app boots — the throw happens when a user opens
 *     the panel;
 *   - the REVIEWER scored the change that broke a live search bar **95 out of 100**. Reading
 *     scope across sibling components is exactly the kind of bookkeeping a language model does not
 *     do reliably, and it is exactly what a machine does perfectly.
 *
 * So this is deterministic, and it is scoped to the files the change actually touched: a
 * pre-existing unbound name elsewhere in the repository is not this change's fault and must not
 * block it.
 */
import fs from 'node:fs';
import path from 'node:path';
import { REPO_ROOT } from '../config.js';
import { getSetting, setSetting } from '../db.js';
import { changedPaths } from './changedLines.js';
import { stripNonCode, boundNames, calledNames } from './staticAnalysis.js';

/**
 * `off` | `advisory` | `enforce`. Advisory by default, and that default is a measurement, not
 * caution for its own sake.
 *
 * Passed over 220 healthy files of this project the check is silent on 217 of them. The remaining
 * three are false positives from the heuristic, not defects — roughly 1.4%. As a hard veto that
 * would reject about one changed file in seventy for no reason, and a gate that blocks good work
 * gets switched off within a week, taking the real findings with it.
 *
 * So it reports first. Promote it to `enforce` once it has run clean across real diffs — the same
 * path the coverage gate took.
 */
export function scopeGateMode() {
  const v = String(getSetting('scopeGate.mode', 'advisory'));
  return ['off', 'advisory', 'enforce'].includes(v) ? v : 'advisory';
}

export function setScopeGateMode(mode) {
  const v = ['off', 'advisory', 'enforce'].includes(String(mode)) ? String(mode) : 'advisory';
  setSetting('scopeGate.mode', v);
  return v;
}

/** Only languages whose scoping this understands. */
const CHECKABLE = /\.(js|jsx|mjs|cjs)$/i;

/**
 * Globals a browser or Node module may use without importing.
 *
 * Deliberately generous. The cost of a name missing from this list is a false veto on a good
 * change, which would get the gate switched off; the cost of one too many is that a genuinely
 * undefined global slips through, which the runtime catches anyway.
 */
/*
 * Esportata perché sia l'UNICA. Ne esistevano tre copie — questa, una morta in staticAnalysis.js e
 * una terza dentro il test che fa da guardia — e divergevano appena qualcuno aggiungeva un nome a
 * una sola: `DOMException` finito nella copia che nessuno consultava, `Uint8Array` mancante in
 * quella del test, che ha poi bocciato codice perfettamente valido. Una lista, un posto.
 */
export const GLOBALS = new Set([
  'require', 'import', 'if', 'for', 'while', 'switch', 'catch', 'return', 'typeof', 'function',
  'async', 'of', 'in', 'case', 'default', 'throw', 'instanceof', 'export', 'from', 'as', 'get', 'set',
  'await', 'new', 'delete', 'void', 'do', 'else', 'try', 'yield', 'super', 'this', 'constructor',
  'Object', 'Array', 'String', 'Number', 'Boolean', 'Symbol', 'BigInt', 'Math', 'JSON', 'Date',
  'RegExp', 'Error', 'TypeError', 'RangeError', 'SyntaxError', 'EvalError', 'URIError', 'AggregateError',
  'Promise', 'Map', 'Set', 'WeakMap', 'WeakSet', 'WeakRef', 'Proxy', 'Reflect', 'Intl',
  'parseInt', 'parseFloat', 'isNaN', 'isFinite', 'encodeURI', 'encodeURIComponent', 'decodeURI',
  'decodeURIComponent', 'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'setImmediate',
  'clearImmediate', 'queueMicrotask', 'structuredClone', 'fetch', 'Buffer', 'process', 'console',
  'URL', 'URLSearchParams', 'TextEncoder', 'TextDecoder', 'AbortController', 'AbortSignal',
  'Event', 'EventTarget', 'CustomEvent', 'DOMException', 'globalThis', 'WebSocket', 'Response', 'Request', 'Headers',
  'Blob', 'File', 'FormData', 'crypto', 'performance', 'atob', 'btoa', 'escape', 'unescape',
  // browser
  'window', 'document', 'navigator', 'localStorage', 'sessionStorage', 'location', 'history',
  'alert', 'confirm', 'prompt', 'requestAnimationFrame', 'cancelAnimationFrame', 'requestIdleCallback',
  'matchMedia', 'getComputedStyle', 'scrollTo', 'IntersectionObserver', 'ResizeObserver',
  'MutationObserver', 'PerformanceObserver', 'Image', 'Audio', 'Option', 'FileReader', 'Notification',
  'Worker', 'SharedWorker', 'BroadcastChannel', 'EventSource', 'XMLHttpRequest', 'DOMParser',
  'RTCPeerConnection', 'RTCSessionDescription', 'RTCIceCandidate', 'MediaStream', 'MediaRecorder',
  'Uint8Array', 'Uint16Array', 'Uint32Array', 'Uint8ClampedArray', 'Int8Array', 'Int16Array',
  'Int32Array', 'BigInt64Array', 'BigUint64Array', 'Float32Array', 'Float64Array', 'ArrayBuffer',
  'SharedArrayBuffer', 'DataView', 'Atomics', 'Element', 'HTMLElement', 'Node', 'NodeList',
]);

/** JSX element names — capitalised, so never a DOM tag. */
const usedComponents = (code) => new Set([...code.matchAll(/<([A-Z][\w]*)/g)].map((m) => m[1]));
const REACT_BUILTIN = new Set(['Fragment', 'Suspense', 'StrictMode', 'Profiler']);

/**
 * Names a file uses that it never binds.
 *
 * @param {string} code  the file's source
 * @returns {{calls: string[], components: string[]}}
 */
/**
 * Split a module into its top-level function bodies plus everything else.
 *
 * Needed because scope is per function, not per file — and reading it per file is precisely what
 * misses the bug this gate exists for. In the change that broke the search bar, `const t = useT()`
 * sat in the parent component and `t(...)` was used in a SIBLING component below it. A file-wide
 * view sees `t` bound and reports nothing; the browser throws the moment the panel opens.
 *
 * Bodies are found by brace matching rather than by regex, so a nested `{}` does not end them.
 */
export function topLevelBodies(code) {
  const bodies = [];
  const pattern = /(?:^|\n)\s*(?:export\s+(?:default\s+)?)?(?:async\s+)?(?:function\s+([A-Za-z_$][\w$]*)|(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?(?:\([^)]*\)|[A-Za-z_$][\w$]*)\s*=>)\s*/g;
  let m;
  while ((m = pattern.exec(code))) {
    /*
     * Salta la lista parametri PRIMA di cercare la graffa del corpo.
     *
     * `function run(input, { onDone }) {` contiene una graffa nei parametri, e prendere la prima
     * che si incontra faceva terminare il "corpo" su `{ onDone }`: il frammento analizzato era la
     * sola firma, ogni legatura interna spariva e il gate segnalava codice corretto.
     */
    let cursor = m.index + m[0].length - 1;
    const paren = code.indexOf('(', cursor);
    const brace = code.indexOf('{', cursor);
    if (paren !== -1 && (brace === -1 || paren < brace)) {
      let depth = 0;
      let j = paren;
      for (; j < code.length; j++) {
        if (code[j] === '(') depth++;
        else if (code[j] === ')') { depth--; if (!depth) break; }
      }
      cursor = j;
    }
    /*
     * Il corpo a blocco deve iniziare SUBITO dopo i parametri.
     *
     * `const J = (v) => JSON.stringify(v);` è una freccia a corpo conciso: non ha graffe. Cercando
     * "la prossima graffa del file" si agganciava a una funzione dichiarata molto più in basso,
     * inghiottendo tutto ciò che stava in mezzo — e quel testo spariva dallo scope di modulo
     * insieme alle sue legature. Risultato: 75 file su 220 segnalati, quasi tutti helper
     * perfettamente definiti. Se dopo i parametri non c'è una graffa, non c'è un corpo da isolare.
     */
    const rest = code.slice(cursor);
    const gap = /^[\s)]*/.exec(rest)[0].length;
    if (rest[gap] !== '{') continue;
    const open = cursor + gap;
    let depth = 0;
    let i = open;
    for (; i < code.length; i++) {
      if (code[i] === '{') depth++;
      else if (code[i] === '}') { depth--; if (!depth) break; }
    }
    if (depth) continue; // unbalanced — leave it to the module scope
    // Dalla DICHIARAZIONE, non dalla graffa: i parametri (`function run(a, { onDone })`) sono
    // legature del corpo, e partendo dalla graffa restavano fuori — un parametro destrutturato
    // finiva segnalato come non definito, cioè un falso positivo su codice corretto.
    bodies.push({ name: m[1] || m[2], start: m.index, end: i });
    pattern.lastIndex = i;
  }
  return bodies;
}

/**
 * Names a file uses that it never binds — checked per function body.
 *
 * Module scope is everything outside the top-level bodies, PLUS the names of the bodies themselves
 * (so functions can call each other in any order, as hoisting and module semantics allow). Each
 * body is then checked against module scope plus its own bindings.
 */
export function unboundNames(code) {
  const src = stripNonCode(code);
  const bodies = topLevelBodies(src);

  /*
   * Lo scope di modulo si legge DIRETTAMENTE dalle dichiarazioni in colonna zero, senza dipendere
   * dal rilevamento dei corpi.
   *
   * Prima lo ricavavo da "tutto ciò che sta fuori dai corpi", e bastava un corpo delimitato male
   * perché il cursore saltasse oltre le dichiarazioni successive: quelle sparivano dallo scope e
   * venivano segnalate come inesistenti. Una dichiarazione di primo livello sta a inizio riga —
   * è una regola semplice e vera nel codice reale, e non ha un modo silenzioso di sbagliare.
   */
  let outside = src;
  for (const b of [...bodies].reverse()) outside = outside.slice(0, b.start) + outside.slice(b.end + 1);

  const moduleScope = boundNames(outside);
  for (const m of src.matchAll(/^(?:export\s+)?(?:default\s+)?(?:async\s+)?(?:function|class|const|let|var)\s+([A-Za-z_$][\w$]*)/gm)) {
    moduleScope.add(m[1]);
  }
  // Anche le destrutturazioni di primo livello: `export const { a, b } = x;`
  for (const m of src.matchAll(/^(?:export\s+)?(?:const|let|var)\s*[{[]([^}\]]*)[}\]]/gm)) {
    for (const n of m[1].matchAll(/[A-Za-z_$][\w$]*/g)) moduleScope.add(n[0]);
  }
  for (const b of bodies) if (b.name) moduleScope.add(b.name);

  const calls = new Set();
  const components = new Set();
  const check = (fragment) => {
    const bound = new Set([...moduleScope, ...boundNames(fragment)]);
    for (const n of calledNames(fragment)) if (!bound.has(n) && !GLOBALS.has(n)) calls.add(n);
    for (const n of usedComponents(fragment)) if (!bound.has(n) && !REACT_BUILTIN.has(n)) components.add(n);
  };

  // Each body against its own scope, then whatever lives outside them all.
  for (const b of bodies) check(src.slice(b.start, b.end + 1));
  check(outside);

  return { calls: [...calls], components: [...components] };
}

/**
 * Check the files this change touched.
 *
 * @param {string} diff        the unified diff
 * @param {{root?: string, readFile?: (p: string) => string}} opts
 * @returns {{veto:boolean, checked:boolean, findings:Array, summary:string}}
 */
export function checkScope(diff, { root = REPO_ROOT, readFile = null } = {}) {
  const files = changedPaths(diff).filter((f) => CHECKABLE.test(f));
  if (!files.length) return { veto: false, checked: false, findings: [], summary: 'no JavaScript files changed' };

  const read = readFile || ((rel) => fs.readFileSync(path.join(root, rel), 'utf8'));
  const findings = [];
  let read_ok = 0;

  for (const rel of files) {
    let code;
    try {
      code = read(rel);
    } catch {
      // A file the change deleted, or one outside the sandbox. Not something to veto over.
      continue;
    }
    read_ok++;
    const { calls, components } = unboundNames(code);
    for (const name of calls) findings.push({ file: rel, name, kind: 'call' });
    for (const name of components) findings.push({ file: rel, name, kind: 'component' });
  }

  if (!read_ok) return { veto: false, checked: false, findings: [], summary: 'none of the changed files could be read' };
  if (!findings.length) return { veto: false, checked: true, findings: [], summary: `${read_ok} changed file(s) reference nothing undefined` };

  const list = findings.slice(0, 5).map((f) => `${f.name} (${f.file})`).join(', ');
  return {
    veto: true,
    checked: true,
    findings,
    summary: `${findings.length} name(s) used but never imported or declared: ${list}${findings.length > 5 ? ', …' : ''} — this throws at runtime the first time that code path runs`,
  };
}
