/**
 * Run the undefined-reference check over the TARGET repository.
 *
 *   node tools/scanTarget.mjs [absolute-path-to-repo]
 *
 * ISL guards its own dashboard against this class of bug and did not guard the code it changes.
 * Run #322 shipped `t(...)` inside a component that never bound `t` — the identifier is
 * syntactically valid, so `node --check` passed, and the LLM reviewer scored the change 95/100
 * because reading scope across sibling components is not something it reliably does. The search bar
 * threw `ReferenceError: t is not defined` the moment a user clicked it.
 *
 * The check is the same one used on ISL itself: a name in call position, or a JSX component, that is
 * neither imported nor declared nor a parameter nor a JavaScript global.
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { stripNonCode, boundNames, calledNames, duplicateClassMembers } from './staticCheck.mjs';

const REPO = process.argv[2] || process.cwd();

const GLOBALS = new Set([
  'require', 'import', 'if', 'for', 'while', 'switch', 'catch', 'return', 'typeof', 'function',
  'async', 'of', 'in', 'case', 'default', 'throw', 'instanceof', 'export', 'from', 'as', 'get', 'set',
  'await', 'new', 'delete', 'void', 'do', 'else', 'try', 'yield', 'super', 'this', 'constructor',
  'Object', 'Array', 'String', 'Number', 'Boolean', 'Symbol', 'BigInt', 'Math', 'JSON', 'Date',
  'RegExp', 'Error', 'TypeError', 'RangeError', 'SyntaxError', 'Promise', 'Map', 'Set', 'WeakMap',
  'WeakSet', 'Proxy', 'Reflect', 'Intl', 'parseInt', 'parseFloat', 'isNaN', 'isFinite', 'encodeURI',
  'encodeURIComponent', 'decodeURI', 'decodeURIComponent', 'setTimeout', 'clearTimeout',
  'setInterval', 'clearInterval', 'setImmediate', 'queueMicrotask', 'structuredClone', 'fetch',
  'Buffer', 'process', 'console', 'URL', 'URLSearchParams', 'TextEncoder', 'TextDecoder',
  'AbortController', 'AbortSignal', 'Event', 'EventTarget', 'globalThis', 'WebSocket', 'Response',
  'Request', 'Headers', 'Blob', 'FormData', 'crypto', 'performance', 'atob', 'btoa',
  // browser globals — the target is a web app, ISL's own backend is not
  'window', 'document', 'navigator', 'localStorage', 'sessionStorage', 'location', 'history',
  'alert', 'confirm', 'prompt', 'requestAnimationFrame', 'cancelAnimationFrame', 'matchMedia',
  'IntersectionObserver', 'ResizeObserver', 'MutationObserver', 'Image', 'FileReader', 'Notification',
  'getComputedStyle', 'scrollTo', 'open', 'close', 'postMessage', 'addEventListener', 'removeEventListener',
  'Uint8Array', 'Uint16Array', 'Uint32Array', 'Int8Array', 'Float32Array', 'Float64Array', 'ArrayBuffer', 'DataView',
  'RTCPeerConnection', 'RTCSessionDescription', 'RTCIceCandidate', 'MediaStream', 'MediaRecorder',
  'Audio', 'Worker', 'BroadcastChannel', 'EventSource', 'CustomEvent', 'DOMParser', 'XMLHttpRequest',
]);

/** Which files did ISL change? Those are the ones this is asking about. */
function islTouched() {
  try {
    const out = execFileSync('git', ['log', '--name-only', '--format=', '--grep=ai-iter'], { cwd: REPO, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
    return new Set(out.split('\n').map((s) => s.trim()).filter(Boolean));
  } catch {
    return new Set();
  }
}

function walk(dir, out = []) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    if (e.name.startsWith('.') || ['node_modules', 'dist', 'build', 'coverage'].includes(e.name)) continue;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) walk(full, out);
    else if (/\.(js|jsx|mjs)$/.test(e.name) && !/\.(test|spec)\./.test(e.name)) out.push(full);
  }
  return out;
}

/** JSX element names — capitalised, so never a DOM tag. */
const usedComponents = (code) => new Set([...code.matchAll(/<([A-Z][\w]*)/g)].map((m) => m[1]));
const REACT_BUILTIN = new Set(['Fragment', 'Suspense', 'StrictMode', 'Profiler']);

const touched = islTouched();
const files = [
  ...walk(path.join(REPO, 'frontend')),
  ...walk(path.join(REPO, 'backend')),
  ...walk(path.join(REPO, 'services')),
];

const findings = [];
for (const f of files) {
  let code;
  try {
    code = stripNonCode(fs.readFileSync(f, 'utf8'));
  } catch {
    continue;
  }
  const bound = boundNames(code);
  const rel = path.relative(REPO, f).replace(/\\/g, '/');
  const byIsl = touched.has(rel);

  for (const name of calledNames(code)) {
    if (!bound.has(name) && !GLOBALS.has(name)) findings.push({ rel, kind: 'call', name, byIsl });
  }
  for (const name of usedComponents(code)) {
    if (!bound.has(name) && !REACT_BUILTIN.has(name)) findings.push({ rel, kind: 'component', name, byIsl });
  }
  for (const d of duplicateClassMembers(code)) {
    findings.push({ rel, kind: 'duplicate', name: `${d.cls}.${d.name}`, byIsl });
  }
}

const mine = findings.filter((f) => f.byIsl);
const other = findings.filter((f) => !f.byIsl);

console.log(`scanned ${files.length} file(s) · ${touched.size} touched by ISL`);
console.log(`\nIN FILES ISL CHANGED: ${mine.length}`);
for (const f of mine) console.log(`   ${f.rel}  →  ${f.name}  (${f.kind})`);
console.log(`\nIN FILES ISL NEVER TOUCHED: ${other.length}`);
for (const f of other.slice(0, 25)) console.log(`   ${f.rel}  →  ${f.name}  (${f.kind})`);
if (other.length > 25) console.log(`   … and ${other.length - 25} more`);

process.exit(mine.length ? 1 : 0);
