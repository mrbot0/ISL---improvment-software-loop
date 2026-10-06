import fs from 'node:fs';
import path from 'node:path';
import { CODE_DIRS, REPO_ROOT } from '../config.js';
import { upsertFunction, countFunctionsByStatus } from '../db_iteration.js';
import { log } from '../logger.js';

/**
 * Builds the code inventory that drives what the planner improves. Deliberately
 * a regex/heuristic scan, not a full AST parse: it must run in a second or two
 * over the whole repo every iteration, tolerate JS/JSX/CJS/ESM alike, and never
 * throw on a file it doesn't fully understand. Precision matters less than having
 * a stable, ranked list of the heaviest code units.
 */

/**
 * Files that contain code but are not code worth *improving*. Seed scripts, mock
 * fixtures and generated data are full of one-letter helpers and enormous literal
 * arrays; left in, they dominate the ranking on sheer size and the planner
 * cheerfully sends a specialist off to refactor a pile of fake listings.
 */
const SKIP = /node_modules|\.test\.|\.spec\.|__tests__|__mocks__|\.min\.|[/\\](seed|mock|fixtures?|generated)[^/\\]*\.(js|jsx|mjs|cjs)$|[/\\](seeds?|mocks?|fixtures?|__generated__)[/\\]/i;

const walk = (dir, out = []) => {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    const abs = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (!/node_modules|\.git|dist|build|coverage/.test(e.name)) walk(abs, out);
    } else if (/\.(js|jsx|mjs|cjs)$/.test(e.name) && !SKIP.test(abs)) {
      out.push(abs);
    }
  }
  return out;
};

/**
 * Identifiers so common that their name tells you nothing about what they are.
 * A unit called `handler` or `err` is a local, not a shared abstraction, and
 * counting every file that happens to mention it produces nonsense.
 */
const COMMON_IDENT = new Set([
  'err', 'error', 'data', 'item', 'items', 'list', 'value', 'val', 'result', 'res', 'req', 'next',
  'ctx', 'cb', 'fn', 'args', 'opts', 'options', 'params', 'props', 'state', 'init', 'main', 'run',
  'get', 'set', 'add', 'remove', 'update', 'create', 'handler', 'callback', 'index', 'key', 'name',
  'type', 'id', 'idx', 'obj', 'arr', 'str', 'num', 'temp', 'tmp', 'test', 'noop', 'now', 'load',
]);

/** Cheap cyclomatic-complexity proxy: count branch/loop/logical keywords. */
function complexityOf(body) {
  const m = body.match(/\b(if|for|while|case|catch|&&|\|\||\?)\b|\?\./g);
  return 1 + (m ? m.length : 0);
}

/** Extract named units from a source file, noting which ones are actually exported. */
function extractUnits(rel, src) {
  const units = [];
  const lines = src.split('\n');
  const add = (name, kind, startLine, sig, exported) => {
    // A two-character name is a loop variable or a local shorthand, not a unit of
    // work worth planning an iteration around. Routes are exempt — "GET /x" is real.
    if (!name || (kind !== 'route' && name.length < 3)) return;
    // Grab a rough body window for complexity: 40 lines from the definition.
    const body = lines.slice(startLine - 1, startLine + 40).join('\n');
    units.push({
      name,
      kind,
      startLine,
      exported: !!exported,
      signature: (sig || '').trim().slice(0, 160),
      complexity: complexityOf(body),
    });
  };

  lines.forEach((line, i) => {
    const ln = i + 1;
    let m;
    // function foo(...) / export async function foo(...)
    //   group 1 = the `export` keyword, 2 = the NAME, 3 = the parameter list.
    if ((m = line.match(/^\s*(export\s+)?(?:default\s+)?(?:async\s+)?function\s+([A-Za-z0-9_]+)\s*\(([^)]*)\)/))) {
      const name = m[2];
      const kind = /^[A-Z]/.test(name) ? 'component' : 'function';
      add(name, kind, ln, `${name}(${m[3]})`, m[1]);
    }
    // const foo = (...) => / export const foo = async (...) =>
    else if ((m = line.match(/^\s*(export\s+)?const\s+([A-Za-z0-9_]+)\s*=\s*(?:async\s*)?\(([^)]*)\)\s*=>/))) {
      const name = m[2];
      const kind = /^[A-Z]/.test(name) ? 'component' : 'function';
      add(name, kind, ln, `${name}(${m[3]})`, m[1]);
    }
    // Express routes: router.get('/x', ...) / app.post(...)
    else if ((m = line.match(/\b(?:router|app)\.(get|post|put|patch|delete)\(\s*['"`]([^'"`]+)['"`]/))) {
      add(`${m[1].toUpperCase()} ${m[2]}`, 'route', ln, line.trim().slice(0, 120), false);
    }
  });
  return units;
}

/**
 * @returns {Promise<{files:number, functions:number, summary:string, counts:object}>}
 */
export async function catalog({ logger = log.for('cataloger') } = {}) {
  // Read CODE_DIRS at call time — it is a live binding that is empty until a
  // project is activated, so capturing it at import would scan nothing.
  const files = CODE_DIRS.flatMap((d) => walk(path.join(REPO_ROOT, d)));
  logger.info?.(`scanning ${files.length} source file(s)`);

  // Pass 1: read every file once, extract units, and tokenise it into the set of
  // identifiers it uses. Reading hundreds of files is synchronous I/O, so we yield
  // to the event loop every so often — otherwise the whole server (HTTP + the live
  // WebSocket) freezes for the duration of the scan, and the dashboard shows
  // "connection lost" mid-iteration.
  const perFile = [];
  let read = 0;
  for (const abs of files) {
    let src;
    try {
      src = fs.readFileSync(abs, 'utf8');
    } catch {
      continue;
    }
    const rel = path.relative(REPO_ROOT, abs).split(path.sep).join('/');
    const units = extractUnits(rel, src);
    const todos = (src.match(/TODO|FIXME|XXX|HACK/g) || []).length;
    // Every distinct identifier in the file — computed once, so fan-in becomes a set
    // lookup instead of a regex per candidate name per file.
    const idents = new Set(src.match(/[A-Za-z_$][A-Za-z0-9_$]*/g) || []);
    perFile.push({ rel, units, loc: src.split('\n').length, todos, idents });
    if (++read % 40 === 0) await new Promise((r) => setImmediate(r));
  }

  /**
   * Fan-in: how many OTHER files reference this unit.
   *
   * Two traps here, both of which the naive version fell into.
   *
   * Correctness: "does any file contain this string?" ranks a local handler called
   * `onClick` as the most depended-upon code in the app. So only EXPORTED names count
   * (a non-export cannot be referenced cross-file at all), matched as whole words.
   *
   * Cost: testing every exported name against every file with a regex is
   * O(files × names) regex executions — hundreds of thousands of them — and it ran
   * synchronously at the top of every iteration, blocking the event loop for seconds.
   * Instead we build an inverted index from the identifier sets we already have:
   * one pass, O(total identifiers), no regex.
   */
  const exportDefiners = new Map(); // exported name → Set(files that define+export it)
  for (const f of perFile) {
    for (const u of f.units) {
      if (u.exported && !u.name.includes(' ') && !COMMON_IDENT.has(u.name)) {
        if (!exportDefiners.has(u.name)) exportDefiners.set(u.name, new Set());
        exportDefiners.get(u.name).add(f.rel);
      }
    }
  }

  const fanIn = new Map(); // exported name → count of OTHER files that reference it
  for (const f of perFile) {
    for (const name of exportDefiners.keys()) {
      if (exportDefiners.get(name).has(f.rel)) continue; // its own defining file isn't fan-in
      if (f.idents.has(name)) fanIn.set(name, (fanIn.get(name) || 0) + 1);
    }
  }

  let count = 0;
  for (const f of perFile) {
    const fileTodo = f.todos;
    for (const u of f.units) {
      // A non-exported unit keeps an honest zero.
      const units = u.exported ? (fanIn.get(u.name) ?? 0) : 0;
      // Weight favours complex, widely-referenced, TODO-laden, larger units.
      const weight = u.complexity * 6 + units * 10 + fileTodo * 8 + Math.min(40, Math.round(f.loc / 10));
      upsertFunction({
        path: f.rel,
        name: u.name,
        kind: u.kind,
        signature: u.signature,
        startLine: u.startLine,
        loc: f.loc,
        complexity: u.complexity,
        fanIn: units,
        todos: fileTodo,
        weight,
      });
      count++;
    }
  }

  const counts = countFunctionsByStatus();
  const summary = `Catalogued ${count} unit(s) across ${files.length} files · ${counts.pending} pending, ${counts.improved} improved`;
  logger.info?.(summary);
  return { files: files.length, functions: count, counts, summary };
}
