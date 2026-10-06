import fs from 'node:fs';
import path from 'node:path';
import { llmJson } from '../iteration/llm.js';
import { DENY_GLOBS, PRODUCT_WRITE_GLOBS, SECRET_GLOBS } from '../config.js';
import { matchesAny } from '../glob.js';
import { emit } from '../bus.js';
import { log } from '../logger.js';

/**
 * The Ops agent: when a compose fails to come up, or its logs show a hard error,
 * it diagnoses the cause from the logs (and the files they point at) and proposes
 * a concrete one-file fix. The controller applies it to the running target's
 * checkout and restarts. It only ever edits product source / infra config — never
 * secrets or lockfiles — and gives up cleanly rather than guessing wildly.
 */

// Product source (in this branch's real layout) plus the infra files a boot failure
// usually points at.
// A function, not a const: PRODUCT_WRITE_GLOBS is a live binding (empty until a
// project is activated), so build the editable set at call time.
const editable = () => [...PRODUCT_WRITE_GLOBS, 'backend/prisma*/**', 'docker/**', 'docker-compose*.yml'];

const lg = log.for('ops-agent');

/** Pull file paths mentioned in an error log so we can show the model their content. */
function filesFromLogs(logs) {
  const found = new Set();
  const re = /(?:\/app\/|\.\/|\b)((?:backend|frontend|services)\/[A-Za-z0-9_./-]+\.(?:js|jsx|mjs|cjs|json|prisma))/g;
  let m;
  while ((m = re.exec(logs)) && found.size < 4) found.add(m[1]);
  return [...found];
}

function readIfSafe(root, rel) {
  if (matchesAny(rel, DENY_GLOBS) || matchesAny(rel, SECRET_GLOBS)) return null;
  try {
    const src = fs.readFileSync(path.join(root, rel), 'utf8');
    return src.length < 14000 ? src : src.slice(0, 14000) + '\n…[truncated]';
  } catch {
    return null;
  }
}

/**
 * Diagnose a failure and return a proposed fix (or a diagnosis with no fix).
 * @returns {Promise<null | {path, newContent, diagnosis, summary}>}
 */
export async function diagnoseAndFix({ target, targetRoot, logs, signal }) {
  emit('ops.diagnosing', { target });
  lg.info(`diagnosing ${target} failure`);

  const referenced = filesFromLogs(logs);
  const context = referenced
    .map((rel) => {
      const c = readIfSafe(targetRoot, rel);
      return c ? `--- ${rel} ---\n${c}` : null;
    })
    .filter(Boolean)
    .join('\n\n');

  const system =
    'You are a DevOps engineer for RentAll (Express + Prisma backend, React + Vite frontend), ' +
    'running under docker compose. A container failed or logged a hard error. Diagnose the root ' +
    'cause and, if it is a code/config problem you can safely fix in ONE file, return the fix. ' +
    'Only edit application source or compose/Docker config — never .env, lockfiles or node_modules. ' +
    'Return ONLY JSON: {"diagnosis": string, "fixable": boolean, "path": string, "new_content": string, "summary": string}. ' +
    'If it is an environment problem (docker not running, missing image, port in use) set fixable=false and explain in diagnosis.';

  const user = [
    `Target: ${target}`,
    `\nCompose / container logs (tail):\n${logs.slice(-6000)}`,
    context ? `\nReferenced files:\n${context}` : '',
    '\nDiagnose and, if safely fixable in one file, return the complete new file content.',
  ].join('\n');

  let data;
  try {
    const r = await llmJson({ system, user, temperature: 0.2, signal });
    data = r.data;
  } catch (err) {
    lg.warn(`diagnosis LLM failed: ${err.message}`);
    return null;
  }
  if (!data) return null;

  emit('ops.diagnosis', { target, diagnosis: (data.diagnosis || '').slice(0, 300), fixable: !!data.fixable });
  lg.info(`diagnosis: ${(data.diagnosis || '').slice(0, 200)}${data.fixable ? '' : ' (not auto-fixable)'}`);

  if (!data.fixable || !data.path || typeof data.new_content !== 'string' || !data.new_content.trim()) {
    return { diagnosis: data.diagnosis || 'no diagnosis', path: null };
  }

  const rel = String(data.path).replace(/\\/g, '/').replace(/^\.?\//, '');
  if (!matchesAny(rel, editable()) || matchesAny(rel, SECRET_GLOBS) || matchesAny(rel, DENY_GLOBS)) {
    lg.warn(`refused fix outside editable scope: ${rel}`);
    return { diagnosis: data.diagnosis, path: null };
  }
  return { path: rel, newContent: data.new_content, diagnosis: data.diagnosis, summary: data.summary || `fix ${rel}` };
}

/** Apply a fix to a target checkout (guarded). */
export function applyFix(targetRoot, fix) {
  const abs = path.join(targetRoot, fix.path);
  const norm = path.relative(targetRoot, abs).split(path.sep).join('/');
  if (norm.startsWith('..') || !matchesAny(norm, editable()) || matchesAny(norm, SECRET_GLOBS)) {
    throw new Error(`refusing to write ${norm}`);
  }
  const before = fs.existsSync(abs) ? fs.readFileSync(abs, 'utf8') : '';
  if (before && fix.newContent.length < before.length * 0.4) throw new Error('fix looks truncated — refusing');
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, fix.newContent, 'utf8');
  emit('ops.fix_applied', { path: fix.path, summary: fix.summary });
  lg.info(`applied fix to ${fix.path}: ${fix.summary}`);
  return { path: fix.path };
}

/** Error signatures worth reacting to in a compose log stream. */
export const ERROR_PATTERNS =
  /error:|exited with code [1-9]|cannot find module|econnrefused|unhandledrejection|listen eaddrinuse|prisma\S* error|traceback|fatal|panic:/i;
