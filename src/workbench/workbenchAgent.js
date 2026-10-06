import fs from 'node:fs';
import path from 'node:path';
import { llmJson } from '../iteration/llm.js';
import { llmGate } from '../core/semaphore.js';
import { DENY_GLOBS, PRODUCT_WRITE_GLOBS, SECRET_GLOBS } from '../config.js';
import { matchesAny } from '../glob.js';
import { emit } from '../bus.js';
import { log } from '../logger.js';
import { verifyLocalExecution } from './workbench.js';

/**
 * The workbench agent.
 *
 * When the workbench says "the app doesn't boot", something in the iteration's own
 * diff almost certainly broke it — a bad import, a route registered against a
 * function that no longer exists, a typo in an export. That is a mechanical
 * failure with a mechanical fix, and it is a waste to throw the entire iteration
 * away over it.
 *
 * So this agent gets the boot output and the diff that caused it, finds the
 * breakage, fixes it *in the sandbox*, and we boot again. It is deliberately
 * narrow: it repairs what the iteration broke, it does not get to improve
 * anything. Two attempts, then we give up and let the iteration fail honestly.
 */

const MAX_ATTEMPTS = 2;
// A function, not a const: PRODUCT_WRITE_GLOBS is a live binding, empty until a
// project is activated, so it must be read at call time.
const editable = () => PRODUCT_WRITE_GLOBS;
const lg = log.for('workbench-agent');

/** Files the boot output points at — the model needs to see them to fix them. */
function suspects(checks, diffFiles) {
  const text = Object.values(checks)
    .map((c) => `${c.detail || ''}\n${c.output || ''}`)
    .join('\n');
  const found = new Set();
  const re = /((?:backend|frontend|services)[/\\][A-Za-z0-9_./\\-]+\.(?:js|jsx|mjs|cjs))/g;
  let m;
  while ((m = re.exec(text)) && found.size < 4) found.add(m[1].replace(/\\/g, '/'));
  // The diff is the prime suspect list: the app booted before this iteration touched it.
  for (const f of diffFiles.slice(0, 6)) if (found.size < 6) found.add(f);
  return [...found];
}

function readSafe(root, rel) {
  if (matchesAny(rel, DENY_GLOBS) || matchesAny(rel, SECRET_GLOBS)) return null;
  try {
    const src = fs.readFileSync(path.join(root, rel), 'utf8');
    return src.length < 12000 ? src : `${src.slice(0, 12000)}\n…[truncated]`;
  } catch {
    return null;
  }
}

/** Ask the model for one concrete file fix. */
async function proposeFix({ checks, failures, sandboxRoot, diffFiles, diff, signal }) {
  const files = suspects(checks, diffFiles);
  const context = files
    .map((rel) => {
      const src = readSafe(sandboxRoot, rel);
      return src ? `--- ${rel} ---\n${src}` : null;
    })
    .filter(Boolean)
    .join('\n\n');

  const bootOutput = Object.entries(checks)
    .filter(([, c]) => !c.ok && !c.skipped)
    .map(([name, c]) => `[${name}] ${c.detail}\n${(c.output || '').slice(-1500)}`)
    .join('\n\n');

  const system =
    'You are the workbench engineer for RentAll (Express + Prisma backend, React + Vite frontend, ' +
    'plus microservices under services/). An automated iteration just changed the code and now THE APP ' +
    'NO LONGER STARTS. Find what the change broke and fix it in ONE file. ' +
    'You are repairing a regression, not improving anything — make the minimal edit that gets the app ' +
    'booting again, preserving the intent of the change where you can. ' +
    'Return ONLY JSON: {"diagnosis": string, "fixable": boolean, "path": string, "new_content": string, "summary": string}. ' +
    'Never edit package.json, .env, lockfiles or migrations. If the only way to fix it is to revert the ' +
    'whole change, set fixable=false and say so in diagnosis.';

  const user = [
    'BOOT FAILURE:',
    bootOutput || failures.join('\n'),
    '',
    'THE CHANGE THAT CAUSED IT (diff):',
    (diff || '').slice(0, 8000),
    '',
    context ? `CURRENT FILE CONTENT:\n${context}` : '',
    '',
    'Diagnose what broke the boot and return the complete fixed content of the ONE file that needs to change.',
  ].join('\n');

  const { data } = await llmGate.run(() => llmJson({ system, user, temperature: 0.2, signal }), signal);
  return data;
}

/**
 * Try to get a broken sandbox booting again.
 *
 * @returns {{ healed: boolean, attempts, fixes: Array, result }}
 *   `result` is the final workbench verdict — healed or not, the engine scores from it.
 */
export async function healBoot({ sandboxRoot, iterationId, diff, diffFiles = [], initial, signal }) {
  let result = initial;
  const fixes = [];

  for (let attempt = 1; attempt <= MAX_ATTEMPTS && !result.ok; attempt++) {
    if (signal?.aborted) throw new Error('interrupted');
    emit('workbench.healing', { iterationId, attempt, max: MAX_ATTEMPTS });
    lg.info(`the app does not boot — repair attempt ${attempt}/${MAX_ATTEMPTS}`, { runId: iterationId });

    let fix;
    try {
      fix = await proposeFix({
        checks: result.checks,
        failures: result.failures,
        sandboxRoot,
        diffFiles,
        diff,
        signal,
      });
    } catch (err) {
      if (err.message === 'interrupted') throw err;
      lg.warn(`repair LLM failed: ${err.message}`, { runId: iterationId });
      break;
    }

    if (!fix?.fixable || !fix.path || typeof fix.new_content !== 'string' || !fix.new_content.trim()) {
      lg.warn(`not repairable: ${fix?.diagnosis?.slice(0, 160) || 'no diagnosis'}`, { runId: iterationId });
      result.diagnosis = fix?.diagnosis || null;
      break;
    }

    const rel = String(fix.path).replace(/\\/g, '/').replace(/^\.?\//, '');
    if (!matchesAny(rel, editable()) || matchesAny(rel, SECRET_GLOBS) || matchesAny(rel, DENY_GLOBS)) {
      lg.warn(`refused a fix outside the editable surface: ${rel}`, { runId: iterationId });
      break;
    }

    const abs = path.join(sandboxRoot, rel);
    const before = fs.existsSync(abs) ? fs.readFileSync(abs, 'utf8') : '';
    // A "fix" that is a fraction of the original is a truncated generation, not a fix.
    if (before && fix.new_content.length < before.length * 0.4) {
      lg.warn(`refused a suspiciously truncated fix for ${rel}`, { runId: iterationId });
      break;
    }

    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, fix.new_content, 'utf8');
    fixes.push({ path: rel, summary: fix.summary || 'boot fix', diagnosis: fix.diagnosis });
    emit('workbench.fix', { iterationId, path: rel, summary: fix.summary });
    lg.info(`applied a boot fix to ${rel}: ${fix.summary || fix.diagnosis || ''}`, { runId: iterationId });

    result = await verifyLocalExecution({ sandboxRoot, iterationId, signal });
  }

  if (result.ok && fixes.length) {
    emit('workbench.healed', { iterationId, fixes: fixes.length });
    lg.info(`the app boots again after ${fixes.length} repair(s)`, { runId: iterationId });
  }
  return { healed: result.ok && fixes.length > 0, attempts: fixes.length, fixes, result };
}
