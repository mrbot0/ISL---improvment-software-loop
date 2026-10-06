import fs from 'node:fs';
import path from 'node:path';
import { REPO_ROOT, PRODUCT_DIRS } from '../config.js';
import { scanFiles } from './structuralScan.js';
import { createSandbox, removeWorktree, git } from '../sandbox/worktree.js';

/**
 * PUBLIC-CONTRACT DIFF GATE (ISL_IMPROVE "Enterprise wave", P1).
 *
 * Every existing veto catches what the TESTS can see. A refactor that quietly renames an exported
 * function, drops a field from an HTTP response, or removes a database column passes a fully green
 * suite and breaks consumers downstream — and those are the failures that page someone at 3am.
 * `blastRadius` names the callers INSIDE the repo; nothing at all protected the consumers outside it.
 *
 * This takes a deterministic snapshot of a codebase's PUBLIC SURFACE — HTTP routes, exported module
 * symbols, database models and fields, GraphQL types — at two commits, and classifies each delta:
 *
 *   - **breaking**   : something a consumer depends on is gone or changed shape
 *   - **behavioural**: still present, but it may not behave the same (a field's type, a route's verb)
 *   - **additive**   : new surface, which by definition breaks nobody
 *
 * The classification is deliberately conservative in one direction only: anything ambiguous is
 * reported at the HIGHER severity. A gate that under-reports is worse than useless, because it
 * converts "we didn't check" into "we checked and it was fine".
 *
 * It reads source text rather than running the app: a contract gate that needed the target's server
 * to boot would be unusable on exactly the polyglot repos ISL is meant to manage.
 */

/* ------------------------------- extractors -------------------------------- */

const HTTP_VERBS = 'get|post|put|patch|delete|options|head|all';
// Matches `r.get('/x'`, `router.post("/y"`, `app.delete(\`/z\``. The receiver name is free — some
// codebases use a one-letter `r`, most use `router` or `app`, and pinning the name would silently
// find nothing on half of them.
const ROUTE_RE = new RegExp(`\\b([A-Za-z_$][\\w$]*)\\.(${HTTP_VERBS})\\s*\\(\\s*['"\`]([^'"\`]*)['"\`]`, 'g');
// Where a router gets mounted, which is what turns a relative route into a real URL.
const MOUNT_RE = /\.use\s*\(\s*['"`](\/[^'"`]*)['"`]\s*,\s*([A-Za-z_$][\w$]*)/g;

const EXPORT_RES = [
  /export\s+(?:async\s+)?function\*?\s+([A-Za-z_$][\w$]*)/g,
  /export\s+(?:const|let|var|class)\s+([A-Za-z_$][\w$]*)/g,
];
const EXPORT_LIST_RE = /export\s*\{([^}]+)\}/g;
// Python / Go / Java public surfaces, so this is not a JavaScript-only gate.
const PY_DEF_RE = /^\s*(?:def|class)\s+([A-Za-z_]\w*)/gm;
const GO_FUNC_RE = /^\s*func\s+(?:\([^)]*\)\s*)?([A-Z]\w*)/gm;

const isTest = (f) => /(\.test\.|\.spec\.|(^|\/)__tests__\/|(^|\/)tests?\/)/.test(f);

/** HTTP routes declared in a source file, plus any router mounts it performs. */
function extractRoutes(rel, src) {
  const routes = [];
  const mounts = [];
  let m;
  ROUTE_RE.lastIndex = 0;
  while ((m = ROUTE_RE.exec(src))) {
    // `.all` on a non-router (e.g. `Promise.all`, `arr.all`) would be a false positive; require the
    // first argument to look like a path.
    const p = m[3];
    if (!p.startsWith('/') && p !== '*') continue;
    routes.push({ file: rel, method: m[2].toUpperCase(), path: p });
  }
  MOUNT_RE.lastIndex = 0;
  while ((m = MOUNT_RE.exec(src))) mounts.push({ file: rel, prefix: m[1], router: m[2] });
  return { routes, mounts };
}

/** The public symbols a module offers its importers. */
function extractExports(rel, src) {
  const names = new Set();
  const push = (n) => { if (n && /^[A-Za-z_$][\w$]*$/.test(n) && n !== 'default') names.add(n); };
  for (const re of EXPORT_RES) {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(src))) push(m[1]);
  }
  EXPORT_LIST_RE.lastIndex = 0;
  let m;
  while ((m = EXPORT_LIST_RE.exec(src))) {
    for (const part of m[1].split(',')) push(part.trim().split(/\s+as\s+/).pop().trim());
  }
  if (rel.endsWith('.py')) { PY_DEF_RE.lastIndex = 0; while ((m = PY_DEF_RE.exec(src))) push(m[1]); }
  if (rel.endsWith('.go')) { GO_FUNC_RE.lastIndex = 0; while ((m = GO_FUNC_RE.exec(src))) push(m[1]); }
  return [...names].sort();
}

/**
 * Prisma models and their fields.
 *
 * Optionality is captured because losing it is a breaking change in the other direction: making a
 * previously-optional column required will reject writes that used to succeed, and no test that
 * only exercises the happy path will notice.
 */
function extractPrisma(src) {
  const models = {};
  const enums = {};
  const modelRe = /^\s*(model|enum)\s+(\w+)\s*\{([\s\S]*?)^\s*\}/gm;
  let m;
  while ((m = modelRe.exec(src))) {
    const [, kind, name, body] = m;
    if (kind === 'enum') {
      enums[name] = body.split('\n').map((l) => l.replace(/\/\/.*$/, '').trim()).filter((l) => /^\w+$/.test(l)).sort();
      continue;
    }
    const fields = {};
    for (const raw of body.split('\n')) {
      const line = raw.replace(/\/\/.*$/, '').trim();
      const fm = /^(\w+)\s+([\w[\]]+)(\?)?/.exec(line);
      if (!fm || ['model', 'enum'].includes(fm[1])) continue;
      fields[fm[1]] = { type: fm[2], optional: !!fm[3] };
    }
    models[name] = fields;
  }
  return { models, enums };
}

/** GraphQL types and their fields, from .graphql files or gql`` template literals. */
function extractGraphql(src) {
  const types = {};
  const re = /\b(type|input|interface|enum)\s+(\w+)[^{]*\{([^}]*)\}/g;
  let m;
  while ((m = re.exec(src))) {
    const fields = m[3].split('\n').map((l) => l.replace(/#.*$/, '').trim()).filter(Boolean)
      .map((l) => l.split(/[(:]/)[0].trim()).filter((n) => /^\w+$/.test(n));
    if (fields.length) types[`${m[1]} ${m[2]}`] = [...new Set(fields)].sort();
  }
  return types;
}

/* -------------------------------- snapshot --------------------------------- */

/**
 * The full public surface of a checkout.
 * @param {string} root  a repository root — the real one, or a sandbox worktree at another commit
 */
export function snapshotContract(root = REPO_ROOT, dirs = PRODUCT_DIRS) {
  const snapshot = { routes: {}, mounts: {}, exports: {}, db: { models: {}, enums: {} }, graphql: {} };

  for (const f of scanFiles({ root, dirs })) {
    if (isTest(f.file)) continue; // a test's exports are not a public contract
    let src;
    try { src = fs.readFileSync(path.join(root, f.file), 'utf8'); } catch { continue; }

    if (/\.(js|mjs|cjs|jsx|ts|tsx)$/.test(f.file)) {
      const { routes, mounts } = extractRoutes(f.file, src);
      for (const r of routes) snapshot.routes[`${r.method} ${r.path}`] = r.file;
      for (const mo of mounts) snapshot.mounts[`${mo.prefix} → ${mo.router}`] = mo.file;
    }
    const exp = extractExports(f.file, src);
    if (exp.length) snapshot.exports[f.file] = exp;
    if (/\.graphql$/.test(f.file)) Object.assign(snapshot.graphql, extractGraphql(src));
  }

  // The schema lives outside the product dirs in most layouts, so it is looked up directly.
  for (const rel of ['backend/prisma_new/schema.prisma', 'backend/prisma/schema.prisma', 'prisma/schema.prisma']) {
    const abs = path.join(root, rel);
    if (!fs.existsSync(abs)) continue;
    try {
      const parsed = extractPrisma(fs.readFileSync(abs, 'utf8'));
      Object.assign(snapshot.db.models, parsed.models);
      Object.assign(snapshot.db.enums, parsed.enums);
      break;
    } catch { /* an unparseable schema must not break the gate */ }
  }
  return snapshot;
}

/* ---------------------------------- diff ----------------------------------- */

const BREAKING = 'breaking';
const BEHAVIOURAL = 'behavioural';
const ADDITIVE = 'additive';

/**
 * Compare two contract snapshots.
 * @returns {{breaking:Array, behavioural:Array, additive:Array, counts:object, worst:string|null}}
 */
export function diffContracts(base, head) {
  const out = { [BREAKING]: [], [BEHAVIOURAL]: [], [ADDITIVE]: [] };
  const add = (sev, kind, subject, detail) => out[sev].push({ kind, subject, detail });

  // ── routes ────────────────────────────────────────────────────────────────
  for (const key of Object.keys(base.routes)) {
    if (!(key in head.routes)) add(BREAKING, 'route-removed', key, `served by ${base.routes[key]}; a client calling it now gets a 404`);
    else if (base.routes[key] !== head.routes[key]) {
      add(BEHAVIOURAL, 'route-moved', key, `moved from ${base.routes[key]} to ${head.routes[key]}`);
    }
  }
  for (const key of Object.keys(head.routes)) {
    if (!(key in base.routes)) add(ADDITIVE, 'route-added', key, `new in ${head.routes[key]}`);
  }

  // A changed mount prefix relocates every route under it at once — the single highest-blast-radius
  // contract change there is, and invisible in the per-route diff above.
  for (const key of Object.keys(base.mounts)) {
    if (!(key in head.mounts)) add(BREAKING, 'mount-removed', key, `every route under this prefix moved or disappeared`);
  }
  for (const key of Object.keys(head.mounts)) {
    if (!(key in base.mounts)) add(ADDITIVE, 'mount-added', key, `new mount in ${head.mounts[key]}`);
  }

  // ── exported symbols ──────────────────────────────────────────────────────
  for (const [file, names] of Object.entries(base.exports)) {
    const now = head.exports[file];
    if (!now) {
      // The module may have been renamed rather than deleted; either way its importers break.
      add(BREAKING, 'module-removed', file, `exported ${names.length} symbol(s): ${names.slice(0, 6).join(', ')}`);
      continue;
    }
    const gone = names.filter((n) => !now.includes(n));
    if (gone.length) add(BREAKING, 'exports-removed', file, `no longer exports: ${gone.join(', ')}`);
    const added = now.filter((n) => !names.includes(n));
    if (added.length) add(ADDITIVE, 'exports-added', file, `now also exports: ${added.slice(0, 8).join(', ')}`);
  }
  for (const file of Object.keys(head.exports)) {
    if (!(file in base.exports)) add(ADDITIVE, 'module-added', file, `new module exporting ${head.exports[file].length} symbol(s)`);
  }

  // ── database schema ───────────────────────────────────────────────────────
  for (const [model, fields] of Object.entries(base.db.models)) {
    const now = head.db.models[model];
    if (!now) { add(BREAKING, 'table-dropped', model, 'the model no longer exists — an irreversible migration'); continue; }
    for (const [field, def] of Object.entries(fields)) {
      const nd = now[field];
      if (!nd) { add(BREAKING, 'column-dropped', `${model}.${field}`, `was ${def.type}${def.optional ? '?' : ''} — dropping a column destroys data`); continue; }
      if (nd.type !== def.type) add(BREAKING, 'column-type-changed', `${model}.${field}`, `${def.type} → ${nd.type}`);
      // Optional → required rejects writes that used to succeed. A happy-path test never sees it.
      else if (def.optional && !nd.optional) add(BREAKING, 'column-now-required', `${model}.${field}`, 'was optional, is now required — existing writers that omit it will fail');
      else if (!def.optional && nd.optional) add(BEHAVIOURAL, 'column-now-optional', `${model}.${field}`, 'was required, is now optional — readers must handle null');
    }
    for (const field of Object.keys(now)) {
      if (!(field in fields)) {
        // A NEW required column is breaking for every existing writer, not additive.
        const sev = now[field].optional ? ADDITIVE : BREAKING;
        add(sev, 'column-added', `${model}.${field}`, now[field].optional ? 'new optional column' : 'new REQUIRED column — existing writers will fail unless it has a default');
      }
    }
  }
  for (const model of Object.keys(head.db.models)) {
    if (!(model in base.db.models)) add(ADDITIVE, 'table-added', model, 'new model');
  }
  for (const [en, values] of Object.entries(base.db.enums)) {
    const now = head.db.enums[en];
    if (!now) { add(BREAKING, 'enum-removed', en, 'the enum no longer exists'); continue; }
    const gone = values.filter((v) => !now.includes(v));
    if (gone.length) add(BREAKING, 'enum-values-removed', en, `removed: ${gone.join(', ')} — rows holding these values become invalid`);
    const added = now.filter((v) => !values.includes(v));
    if (added.length) add(ADDITIVE, 'enum-values-added', en, `added: ${added.join(', ')}`);
  }

  // ── GraphQL ───────────────────────────────────────────────────────────────
  for (const [type, fields] of Object.entries(base.graphql)) {
    const now = head.graphql[type];
    if (!now) { add(BREAKING, 'graphql-type-removed', type, 'the type no longer exists'); continue; }
    const gone = fields.filter((f) => !now.includes(f));
    if (gone.length) add(BREAKING, 'graphql-fields-removed', type, `removed: ${gone.join(', ')}`);
  }
  for (const type of Object.keys(head.graphql)) {
    if (!(type in base.graphql)) add(ADDITIVE, 'graphql-type-added', type, 'new type');
  }

  const counts = { breaking: out[BREAKING].length, behavioural: out[BEHAVIOURAL].length, additive: out[ADDITIVE].length };
  return {
    breaking: out[BREAKING],
    behavioural: out[BEHAVIOURAL],
    additive: out[ADDITIVE],
    counts,
    worst: counts.breaking ? BREAKING : counts.behavioural ? BEHAVIOURAL : counts.additive ? ADDITIVE : null,
  };
}

/* ---------------------------------- gate ----------------------------------- */

/**
 * Diff the working tree's contract against a base commit.
 *
 * The base side is read from a sandbox worktree — the same mechanism the pipeline and the coverage
 * run use — so nothing touches the operator's checkout.
 *
 * @returns {{ok:boolean, reason?:string, base?:string, diff?:object}}
 */
export function contractDiffAgainst(baseCommit = 'HEAD') {
  let sandbox = null;
  try {
    sandbox = createSandbox([], baseCommit);
  } catch (err) {
    return { ok: false, reason: `could not read the base commit: ${err.message}` };
  }
  try {
    const before = snapshotContract(sandbox);
    const after = snapshotContract(REPO_ROOT);

    // A base snapshot that came back empty while the head has a surface means the base side was
    // never actually read — and the diff would then report the ENTIRE codebase as newly added and
    // zero breaking changes. That reads exactly like a clean bill of health, which is the most
    // dangerous possible output for a gate: "we didn't check" disguised as "we checked and it's
    // fine". Refuse instead. (This is not hypothetical — it is what a hardcoded relative-path base
    // in `scanFiles` produced the first time this ran.)
    const size = (s) => Object.keys(s.routes).length + Object.keys(s.exports).length + Object.keys(s.db.models).length;
    if (size(before) === 0 && size(after) > 0) {
      return { ok: false, reason: `the base commit ${resolveRef(baseCommit).slice(0, 8)} yielded an empty contract surface — the comparison would be meaningless, so it is refused rather than reported as "no breaking changes"` };
    }

    return { ok: true, base: resolveRef(baseCommit), diff: diffContracts(before, after) };
  } finally {
    removeWorktree(sandbox);
  }
}

const resolveRef = (ref) => {
  try { return git(['rev-parse', ref]).trim(); } catch { return ref; }
};

/**
 * The gate's verdict for the review pipeline.
 *
 * A breaking contract change ALWAYS routes to a human, whatever the agent has earned — unless the
 * task explicitly declared it was making one, in which case it is still surfaced but does not
 * override the normal classification. Deliberate breaking changes are legitimate; silent ones are not.
 */
export function contractVerdict(diff, { declaredBreaking = false } = {}) {
  if (!diff || !diff.counts) return { needsReview: false, reasons: [] };
  const reasons = [];
  if (diff.counts.breaking) {
    const top = diff.breaking.slice(0, 3).map((b) => `${b.kind}: ${b.subject}`);
    reasons.push(
      declaredBreaking
        ? `${diff.counts.breaking} declared breaking contract change(s) — ${top.join('; ')}`
        : `UNDECLARED breaking contract change(s) (${diff.counts.breaking}) — ${top.join('; ')}`,
    );
  } else if (diff.counts.behavioural) {
    reasons.push(`${diff.counts.behavioural} behavioural contract change(s) — ${diff.behavioural.slice(0, 2).map((b) => b.subject).join('; ')}`);
  }
  return { needsReview: diff.counts.breaking > 0 && !declaredBreaking, reasons };
}
