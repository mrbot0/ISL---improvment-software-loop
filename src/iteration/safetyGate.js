/**
 * DETERMINISTIC SAFETY GATE (ISL_IMPROVE §6 — "do no harm", beyond security).
 *
 * Security is about attackers; SAFETY is about accidental destruction. An autonomous
 * agent editing real code could, in one line, drop a table, delete data, wipe a
 * directory, reset migrations, or quietly disable the logging/telemetry/backups a team
 * depends on to notice something is wrong. None of that is a "vulnerability", so the
 * security gate wouldn't catch it — but it can be catastrophic and irreversible.
 *
 * This gate reads the diff and VETOES clearly destructive/irreversible operations
 * introduced in product code, and PENALISES silently disabling observability. As with
 * the security gate, test/fixture/migration-authoring files are treated leniently.
 */

// Migration files and tests legitimately contain DROP/DELETE and destructive DDL.
const LENIENT_FILE = /(^|\/)(migrations?|__tests__|tests?|spec|fixtures?|seeds?)\/|\.(test|spec)\.[jt]sx?$|\.sql$/i;
// Temp/cache/build dirs are safe targets for recursive delete.
const TEMP_PATH = /tmp|temp|cache|dist|build|coverage|node_modules|\.data|sandbox|worktree/i;

// —— irreversible / data-loss operations (VETO) ——
const DESTRUCTIVE = [
  { kind: 'sql-drop', re: /\bDROP\s+(?:TABLE|DATABASE|SCHEMA|COLUMN)\b/i, msg: 'drops a database table/schema/column (data loss)' },
  { kind: 'sql-truncate', re: /\bTRUNCATE\s+(?:TABLE\s+)?\w/i, msg: 'truncates a table (data loss)' },
  { kind: 'sql-delete-all', re: /\bDELETE\s+FROM\s+[`"\w.]+\s*(?:;|$)/im, msg: 'deletes all rows (DELETE with no WHERE)' },
  { kind: 'prisma-reset', re: /migrate\s+reset|db\s+push\s+--force|--force-reset|--accept-data-loss/i, msg: 'resets/force-pushes the database schema (data loss)' },
  { kind: 'deleteMany-empty', re: /\.deleteMany\s*\(\s*\)|\.deleteMany\s*\(\s*\{\s*\}\s*\)|\.drop\s*\(\s*\)/i, msg: 'deletes every record (deleteMany/drop with no filter)' },
  { kind: 'rm-rf', re: /\brm\s+-rf?\b|\brmdir\s+\/s\b|\bRemove-Item\b[^\n]*-Recurse[^\n]*-Force/i, msg: 'recursively force-deletes files' },
];

// fs recursive delete, only dangerous when NOT aimed at a temp/build path.
const FS_RECURSIVE = /\bfs\.(?:rm|rmSync|rmdir|rmdirSync)\s*\(\s*([^,)]+)[^)]*recursive\s*:\s*true|shutil\.rmtree\s*\(\s*([^,)]+)/;

// —— disabling observability / safety infra (PENALISE) ——
const DISABLE = [
  { kind: 'disable-logging', re: /console\.(?:log|error|warn)\s*=\s*(?:\(\)\s*=>|function)|logger\s*=\s*null|LOG_LEVEL\s*=\s*['"]?(?:silent|off|none)/i, msg: 'disables logging' },
  { kind: 'disable-telemetry', re: /(?:telemetry|monitoring|metrics|sentry|analytics|tracing)\b[^\n]*(?:=\s*false|\.disable\(|enabled\s*:\s*false)/i, msg: 'disables telemetry/monitoring' },
  { kind: 'disable-healthcheck', re: /health(?:check)?\b[^\n]*(?:=\s*false|disabled|\.disable\()/i, msg: 'disables a health check' },
];

function walk(diff) {
  const files = [];
  let cur = null;
  for (const line of String(diff).split('\n')) {
    const mf = line.match(/^\+\+\+ b\/(.+)$/);
    if (mf) { cur = { file: mf[1] === 'dev/null' ? null : mf[1], added: [] }; if (cur.file) files.push(cur); continue; }
    if (cur && line.startsWith('+') && !line.startsWith('+++')) cur.added.push(line.slice(1));
  }
  return files;
}

/** @returns {{ findings, veto, summary }} */
export function scanSafety(diff) {
  const findings = [];
  if (!diff || !diff.trim()) return { findings, veto: false, summary: 'No changes to scan.' };

  for (const f of walk(diff)) {
    const lenient = f.file && LENIENT_FILE.test(f.file);
    const text = f.added.join('\n');

    if (!lenient) {
      for (const rule of DESTRUCTIVE) {
        if (rule.re.test(text)) findings.push({ severity: 'critical', kind: rule.kind, file: f.file, message: `${f.file}: ${rule.msg}.` });
      }
      const m = FS_RECURSIVE.exec(text);
      if (m) {
        const target = (m[1] || m[2] || '').trim();
        if (!TEMP_PATH.test(target)) findings.push({ severity: 'critical', kind: 'fs-recursive-delete', file: f.file, message: `${f.file}: recursively deletes a non-temp path (${target.slice(0, 40)}).` });
      }
    }
    for (const rule of DISABLE) {
      if (rule.re.test(text)) findings.push({ severity: 'high', kind: rule.kind, file: f.file, message: `${f.file}: ${rule.msg}.` });
    }
  }

  const seen = new Set();
  const deduped = findings.filter((x) => { const k = `${x.kind}:${x.file}`; if (seen.has(k)) return false; seen.add(k); return true; });
  const veto = deduped.some((x) => x.severity === 'critical');
  const summary = deduped.length ? `${deduped.length} safety finding(s)${veto ? ' — VETO' : ''}: ${deduped[0].message}` : 'No safety issues found.';
  return { findings: deduped.slice(0, 12), veto, summary };
}
