/**
 * Does every endpoint the dashboard calls actually exist on the server?
 *
 * The client and the server agree by convention and nothing checks the convention. A renamed route,
 * a typo, or a method mismatch produces a 404 at the moment a user opens the page — and because the
 * client's error path usually renders an empty state, it looks like "there is no data" rather than
 * like a bug.
 *
 * Reports both directions:
 *   MISSING  — the dashboard calls something the server does not serve. Always a defect.
 *   UNUSED   — the server serves something no dashboard call reaches. Often fine (some routes are
 *              for agents, scripts or the chat tool layer), so it is reported, not failed on.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const read = (p) => {
  try {
    return fs.readFileSync(p, 'utf8');
  } catch {
    return '';
  }
};

function walk(dir, ext, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name.startsWith('.') || e.name === 'node_modules') continue;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) walk(full, ext, out);
    else if (e.name.endsWith(ext)) out.push(full);
  }
  return out;
}

/** `app.get('/api/x/:id', …)` → { method, template, regex }. */
export function serverRoutes() {
  const routes = [];
  for (const f of walk(path.join(ROOT, 'src'), '.js')) {
    const src = read(f);
    for (const m of src.matchAll(/\bapp\.(get|post|put|patch|delete)\(\s*'([^']+)'/g)) {
      const [, method, template] = m;
      routes.push({
        method: method.toUpperCase(),
        template,
        file: path.relative(ROOT, f).replace(/\\/g, '/'),
        // `:param` matches one path segment.
        regex: new RegExp(`^${template.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/:[\w]+/g, '[^/]+')}$`),
      });
    }
  }
  return routes;
}

/**
 * Endpoints the dashboard's api.js calls. Template placeholders become a single segment, and a
 * query string is dropped — the server matches on path only.
 */
/**
 * Read one string or template literal starting at `i`, following `${…}` nesting.
 *
 * A regex cannot do this: `` `/api/events${limit ? `?limit=${limit}` : ''}` `` contains a nested
 * template inside its interpolation, and `[^`]*` stops at the inner backtick — which reported two
 * perfectly good endpoints as missing.
 */
function readLiteral(src, i) {
  const quote = src[i];
  if (quote !== '`' && quote !== "'" && quote !== '"') return null;
  let out = '';
  i++;
  let depth = 0;
  while (i < src.length) {
    const c = src[i];
    if (c === '\\') { out += src.slice(i, i + 2); i += 2; continue; }
    if (quote === '`' && c === '$' && src[i + 1] === '{') { depth++; out += '${'; i += 2; continue; }
    if (quote === '`' && depth && c === '}') { depth--; out += '}'; i++; continue; }
    if (c === quote && !depth) return { value: out, end: i + 1 };
    out += c;
    i++;
  }
  return null;
}

/**
 * Collapse an interpolation to one path segment, and drop any query string.
 *
 * Balanced, not `\$\{[^}]*\}`: an interpolation containing its own braces — a nested template, an
 * object literal, a ternary — ends at the FIRST `}` under that regex, leaving the tail behind and
 * turning a valid endpoint into a nonsense path.
 */
function toPath(raw) {
  let out = '';
  for (let i = 0; i < raw.length; i++) {
    if (raw[i] === '$' && raw[i + 1] === '{') {
      let depth = 1;
      i += 2;
      while (i < raw.length && depth) {
        if (raw[i] === '{') depth++;
        else if (raw[i] === '}') depth--;
        i++;
      }
      i--;
      out += 'X';
      continue;
    }
    out += raw[i];
  }
  return out.split('?')[0];
}

export function clientCalls() {
  const calls = [];
  const verb = { get: 'GET', post: 'POST', put: 'PUT', patch: 'PATCH', del: 'DELETE' };

  // 1. the api.js wrappers
  const api = read(path.join(ROOT, 'dashboard', 'src', 'api.js'));
  for (const m of api.matchAll(/\b(get|post|put|patch|del)\(\s*/g)) {
    const lit = readLiteral(api, m.index + m[0].length);
    if (!lit || !lit.value.startsWith('/api/')) continue;
    calls.push({ method: verb[m[1]], path: toPath(lit.value), raw: lit.value, from: 'api.js' });
  }

  // 2. any direct fetch in a view or component — these bypass api.js entirely, so a route they
  //    depend on would look unused while being load-bearing.
  for (const f of walk(path.join(ROOT, 'dashboard', 'src'), '.jsx')) {
    const src = read(f);
    for (const m of src.matchAll(/fetch\(\s*/g)) {
      const lit = readLiteral(src, m.index + m[0].length);
      if (!lit || !lit.value.startsWith('/api/')) continue;
      const after = src.slice(m.index, m.index + 240);
      const method = /method:\s*'(\w+)'/.exec(after)?.[1]?.toUpperCase() || 'GET';
      calls.push({ method, path: toPath(lit.value), raw: lit.value, from: path.relative(ROOT, f).replace(/\\/g, '/') });
    }
  }
  return calls;
}

const routes = serverRoutes();
const calls = clientCalls();

const missing = [];
for (const c of calls) {
  const hit = routes.find((r) => r.method === c.method && r.regex.test(c.path));
  if (!hit) missing.push(c);
}

const reached = new Set();
for (const c of calls) {
  const hit = routes.find((r) => r.method === c.method && r.regex.test(c.path));
  if (hit) reached.add(`${hit.method} ${hit.template}`);
}
const unused = routes.filter((r) => !reached.has(`${r.method} ${r.template}`));

console.log(`server routes: ${routes.length} · dashboard calls: ${calls.length}`);
console.log(`\nMISSING — the dashboard calls these and the server does not serve them: ${missing.length}`);
for (const m of missing) console.log(`   ${m.method.padEnd(6)} ${m.path}      (${m.from}: ${m.raw})`);
console.log(`\nUNUSED by the dashboard (may be for agents, scripts or Alfred): ${unused.length}`);
for (const u of unused.slice(0, 40)) console.log(`   ${u.method.padEnd(6)} ${u.template}`);
if (unused.length > 40) console.log(`   … and ${unused.length - 40} more`);

process.exit(missing.length ? 1 : 0);
