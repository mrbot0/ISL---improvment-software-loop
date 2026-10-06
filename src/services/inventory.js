import fs from 'node:fs';
import path from 'node:path';
import { REPO_ROOT } from '../config.js';

/**
 * A static read of how well the services actually hang together.
 *
 * This is not a linter and it does not pretend to be sound — it is a cheap,
 * honest sweep for the handful of integration defects that account for most real
 * outages in a system shaped like this one: a call that leaves the process with no
 * timeout, a retry wrapped around something that must not be retried, an error
 * swallowed into a misleading success. It gives the Services manager something
 * concrete to point at and the planner something specific to fix, instead of
 * "improve the services".
 */

const SERVICES_DIR = path.join(REPO_ROOT, 'services');

const SKIP_DIR = new Set(['node_modules', '.git', 'dist', 'build', 'coverage', '__pycache__', '.pytest_cache', 'venv']);

function walk(dir, out = [], depth = 0) {
  if (depth > 6) return out;
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    if (e.name.startsWith('.') || SKIP_DIR.has(e.name)) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out, depth + 1);
    else if (/\.(js|mjs|cjs|ts)$/.test(e.name) && !/\.(test|spec)\./.test(e.name)) out.push(p);
  }
  return out;
}

/** Calls that leave the process. These are the ones that need a timeout and a failure path. */
const OUTBOUND = /\b(?:fetch|axios(?:\.\w+)?|got|superagent|http\.request|https\.request)\s*\(/g;
const HAS_TIMEOUT = /\b(?:timeout|signal|AbortSignal|AbortController|timeoutMs|deadline)\b/;

/** Actual retry machinery — not the word "retry" in a comment. */
const RETRY_CODE = /\b(?:pRetry|p_retry|retryPolicy|withRetry|maxRetries|retryCount|backoff)\b|\bfor\s*\([^)]*attempt|\bwhile\s*\([^)]*attempt/i;
const NON_IDEMPOTENT = /\b(?:charge|capture|refund|transfer|createPayment|createBooking)\s*\(/i;

/**
 * Evidence that the author DID think about double delivery. A retry over an
 * operation guarded by an idempotency key or an event-id dedup is not a bug — it is
 * the correct design, and flagging it would send an agent to "fix" working code.
 */
const IDEMPOTENT = /\b(?:idempoten\w*|idempotency[_-]?key|dedup\w*|eventId|event_id|upsert|ON CONFLICT)\b/i;

const SWALLOW = /catch\s*\([^)]*\)\s*\{\s*\}/g;
const CATCH_RETURN_OK = /catch\s*\([^)]*\)\s*\{[^}]{0,200}?res\.(?:json|send)\s*\(|catch\s*\([^)]*\)\s*\{[^}]{0,200}?res\.status\(\s*200/g;

/**
 * Comments are not code.
 *
 * The first version of this scanner matched raw source, and confidently reported two
 * CRITICAL "retry on a non-idempotent operation" findings. One was the word `retry`
 * inside the comment `// retry → DLQ`. The other was a handler whose comments
 * *explain its idempotency*. Both were correct code; both would have been handed to
 * an agent to "fix". A scanner that cries wolf is worse than no scanner, so strip the
 * prose before looking for defects.
 */
function stripComments(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '') // block comments
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1') // line comments (leaving `http://` alone)
    .replace(/(['"`])(?:\\.|(?!\1)[^\\])*\1/g, '""'); // string literals
}

function analyseFile(abs, rel) {
  let raw;
  try {
    raw = fs.readFileSync(abs, 'utf8');
  } catch {
    return null;
  }
  const src = stripComments(raw);
  const lineOf = (i) => src.slice(0, i).split('\n').length;
  const findings = [];

  // An outbound call with nothing that looks like a deadline anywhere near it.
  for (const m of src.matchAll(OUTBOUND)) {
    const window = src.slice(Math.max(0, m.index - 200), m.index + 400);
    if (!HAS_TIMEOUT.test(window)) {
      findings.push({
        kind: 'no_timeout',
        severity: 'high',
        line: lineOf(m.index),
        detail: 'a call leaves the process with no timeout — a hung dependency takes the whole request with it',
      });
    }
  }

  // Retry around something that must not be retried — UNLESS the code guards against
  // double delivery, in which case retrying is exactly right.
  if (RETRY_CODE.test(src) && NON_IDEMPOTENT.test(src) && !IDEMPOTENT.test(raw)) {
    findings.push({
      kind: 'unsafe_retry',
      severity: 'critical',
      detail:
        'retry machinery wraps a non-idempotent operation (charge/capture/refund) with no idempotency key ' +
        'or dedup guard anywhere in the file — a retry here can double-charge',
    });
  }

  // Errors quietly dropped.
  for (const m of src.matchAll(SWALLOW)) {
    findings.push({
      kind: 'swallowed_error',
      severity: 'medium',
      line: lineOf(m.index),
      detail: 'an empty catch block: the failure is discarded and the caller cannot tell',
    });
  }
  for (const m of src.matchAll(CATCH_RETURN_OK)) {
    findings.push({
      kind: 'error_as_success',
      severity: 'high',
      line: lineOf(m.index),
      detail: 'a catch block answers with a success response — the caller cannot distinguish failure from success',
    });
  }

  return findings.length ? { file: rel, findings } : null;
}

/** Which other services does this one talk to? Names appear in URLs and env vars. */
function crossRefs(files, names, selfName) {
  const hits = new Set();
  for (const { abs } of files) {
    let src;
    try {
      src = fs.readFileSync(abs, 'utf8');
    } catch {
      continue;
    }
    for (const n of names) {
      if (n === selfName) continue;
      const re = new RegExp(`\\b${n}[_-]?(?:service|svc|url|host|api)\\b|/${n}/|['"\`]${n}['"\`]`, 'i');
      if (re.test(src)) hits.add(n);
    }
  }
  return [...hits];
}

/**
 * Inventory every service: its size, its language, whether it boots, who it talks
 * to, and what is wrong at its seams.
 */
export function inventoryServices() {
  if (!fs.existsSync(SERVICES_DIR)) {
    return { services: [], totals: { services: 0, findings: 0, critical: 0, high: 0 }, health: 100, scannedAt: Date.now() };
  }

  const names = fs
    .readdirSync(SERVICES_DIR, { withFileTypes: true })
    .filter((d) => d.isDirectory() && !d.name.startsWith('.') && !SKIP_DIR.has(d.name))
    .map((d) => d.name);

  const services = names.map((name) => {
    const dir = path.join(SERVICES_DIR, name);
    const jsFiles = walk(dir).map((abs) => ({ abs, rel: path.relative(REPO_ROOT, abs).replace(/\\/g, '/') }));

    const isPython = fs.existsSync(path.join(dir, 'requirements.txt')) || fs.existsSync(path.join(dir, 'pyproject.toml'));
    const hasPkg = fs.existsSync(path.join(dir, 'package.json'));
    const hasPySource = isPython && fs.existsSync(path.join(dir, 'app'));
    const entry = ['src/index.js', 'src/server.js', 'index.js', 'server.js'].find((p) => fs.existsSync(path.join(dir, p))) || null;
    const hasTests = fs.existsSync(path.join(dir, 'tests')) || fs.existsSync(path.join(dir, 'test'));
    const hasDockerfile = fs.existsSync(path.join(dir, 'Dockerfile'));
    const hasDeps = fs.existsSync(path.join(dir, 'node_modules'));

    // The state that matters most here, and that a naive scan hides: a service
    // directory that has its dependencies installed and NO SOURCE AT ALL. It looks
    // like a service, it is counted like a service, and it does nothing. Reporting
    // that as "healthy, no findings" would be a lie of omission — an unimplemented
    // service is the largest integration gap there is.
    const hasSource = jsFiles.length > 0 || hasPySource;
    const state = hasSource ? 'implemented' : hasDeps || hasPkg ? 'scaffold' : 'empty';

    const issues = [];
    for (const f of jsFiles) {
      const r = analyseFile(f.abs, f.rel);
      if (r) issues.push(r);
    }
    const findings = issues.flatMap((i) => i.findings.map((f) => ({ ...f, file: i.file })));

    if (!hasSource) {
      findings.push({
        kind: 'not_implemented',
        severity: 'high',
        file: `services/${name}/`,
        detail:
          state === 'scaffold'
            ? `the ${name} service has its dependencies installed but contains no source code — it is declared in ` +
              `the architecture and does nothing. Whatever the backend expects of it is missing, or quietly ` +
              `hard-coded somewhere else.`
            : `the ${name} service directory exists but is empty — no source, no manifest, nothing. It appears in ` +
              `the architecture and is not a service at all.`,
      });
    }

    const bySeverity = findings.reduce((a, f) => ({ ...a, [f.severity]: (a[f.severity] || 0) + 1 }), {});

    // An unimplemented service is not "healthy with no findings" — it is a hole in
    // the architecture, and scoring it 100 would hide exactly the thing worth seeing.
    const penalty = (bySeverity.critical || 0) * 30 + (bySeverity.high || 0) * 12 + (bySeverity.medium || 0) * 4;
    const health = hasSource ? Math.max(0, 100 - penalty) : 0;

    return {
      name,
      language: isPython ? 'python' : 'node',
      state,
      files: jsFiles.length,
      entry,
      hasTests,
      hasDockerfile,
      hasDeps,
      dependsOn: crossRefs(jsFiles, names, name),
      findings,
      bySeverity,
      health,
    };
  });

  const all = services.flatMap((s) => s.findings);
  const implemented = services.filter((s) => s.state === 'implemented');
  const scaffolds = services.filter((s) => s.state !== 'implemented');

  const totals = {
    services: services.length,
    implemented: implemented.length,
    scaffolds: scaffolds.length,
    findings: all.length,
    critical: all.filter((f) => f.severity === 'critical').length,
    high: all.filter((f) => f.severity === 'high').length,
    medium: all.filter((f) => f.severity === 'medium').length,
    noTimeout: all.filter((f) => f.kind === 'no_timeout').length,
    unsafeRetry: all.filter((f) => f.kind === 'unsafe_retry').length,
    notImplemented: scaffolds.length,
  };

  // Health across the whole mesh, counting the empty ones for what they are.
  const health = services.length
    ? Math.round(services.reduce((a, s) => a + s.health, 0) / services.length)
    : 100;

  return { services, totals, health, scannedAt: Date.now() };
}

/**
 * Turn the worst integration findings into backlog-ready task seeds, so the
 * planner has something specific to hand the services agent rather than a vibe.
 */
export function integrationBacklog(limit = 5) {
  const { services } = inventoryServices();
  const rank = { critical: 3, high: 2, medium: 1 };
  return services
    .flatMap((s) => s.findings.map((f) => ({ ...f, service: s.name })))
    .sort((a, b) => (rank[b.severity] || 0) - (rank[a.severity] || 0))
    .slice(0, limit)
    .map((f) => ({
      title: `${f.service}: ${f.detail.split('—')[0].trim()}`,
      description: `${f.file}${f.line ? `:${f.line}` : ''} — ${f.detail}`,
      area: 'services',
      // Above the default 50 that research-sourced features get: a seam that can
      // double-charge a customer outranks a nice-to-have.
      priority: f.severity === 'critical' ? 95 : f.severity === 'high' ? 80 : 60,
      file: f.file,
    }));
}
