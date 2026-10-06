import fs from 'node:fs';
import path from 'node:path';
import { createSandbox, removeWorktree, headCommit, git } from '../sandbox/worktree.js';
import { verifyLocalExecution } from '../workbench/workbench.js';
import { healBoot } from '../workbench/workbenchAgent.js';
import { emit } from '../bus.js';
import { log } from '../logger.js';
import { getSetting, setSetting } from '../db.js';
// A live binding — read at call time, never captured, so switching projects redirects it.
import { REPO_ROOT } from '../config.js';

/**
 * REPAIR — "is the app actually working, and if not, fix it".
 *
 * The workbench already answers "does this CHANGE still boot?" as one gate inside an iteration. It
 * cannot answer the question an operator actually asks, which is about the app as it stands right
 * now, independent of any change: **is it broken, what exactly is broken, and can you fix it?**
 *
 * Two properties this must have, and the second is the one that makes it safe to put behind a button:
 *
 *   - **It diagnoses reality, not HEAD.** The sandbox is created at HEAD and the working tree's
 *     uncommitted changes are replayed into it, because a report about a codebase nobody has is
 *     worse than no report.
 *   - **It never writes to the operator's checkout.** Diagnosis and repair both happen inside a
 *     detached worktree. A successful repair produces a DIFF for review, applied through the same
 *     path as any other change. A tool that silently edits the working tree to "fix" something is a
 *     tool nobody can trust to run.
 */

const lg = log.for('repair');
const LAST_KEY = 'repair.last';

/** Mirror uncommitted tracked changes into the sandbox, so the diagnosis describes what exists. */
function overlayWorkingTree(sandbox) {
  let entries;
  try { entries = git(['status', '--porcelain', '--untracked-files=no']).split('\n').filter(Boolean); }
  catch { return { dirty: false, applied: 0 }; }

  let applied = 0;
  for (const line of entries) {
    const status = line.slice(0, 2);
    const rel = line.slice(3).split(' -> ').pop().trim().replace(/^"|"$/g, '');
    if (!rel) continue;
    const dest = path.join(sandbox, rel);
    try {
      if (status.includes('D')) {
        fs.rmSync(dest, { force: true });
      } else {
        fs.mkdirSync(path.dirname(dest), { recursive: true });
        fs.copyFileSync(path.join(REPO_ROOT, rel), dest);
      }
      applied++;
    } catch { /* a file we cannot read is simply not overlaid */ }
  }
  return { dirty: applied > 0, applied };
}

/**
 * A check result reduced to what a person needs to act on it.
 *
 * The workbench puts its human-readable verdict in `detail` and the raw process output in `output` —
 * verified against the source rather than guessed, because reading the wrong field here would show
 * a blank reason on precisely the screen that exists to explain a failure.
 */
const toFinding = (name, c) => ({
  area: name,
  ok: !!c?.ok,
  reason: c?.detail || c?.error || (c?.ok ? 'working' : 'failed with no reason given'),
  // The tail of the output: a build or boot failure prints its error last, after the noise.
  output: c?.output ? String(c.output).slice(-4000) : null,
  skipped: !!c?.skipped,
});

/**
 * Run the health checks against the app as it is right now.
 *
 * @returns {Promise<{ok, checkedAt, commit, dirty, findings, failing, error?}>}
 */
export async function diagnose({ signal } = {}) {
  let sandbox = null;
  emit('repair.started', { phase: 'diagnose' });
  try {
    sandbox = createSandbox([], 'HEAD');
  } catch (err) {
    const out = { ok: false, error: `could not create a sandbox to test in: ${err.message}`, checkedAt: Date.now(), findings: [], failing: [] };
    setSetting(LAST_KEY, JSON.stringify(out));
    return out;
  }

  try {
    const overlay = overlayWorkingTree(sandbox);
    const result = await verifyLocalExecution({ sandboxRoot: sandbox, iterationId: null, signal });
    const findings = Object.entries(result.checks || {}).map(([name, c]) => toFinding(name, c));
    const failing = findings.filter((f) => !f.ok && !f.skipped);

    const out = {
      ok: failing.length === 0,
      checkedAt: Date.now(),
      commit: headCommit(),
      dirty: overlay.dirty,
      uncommittedFiles: overlay.applied,
      findings,
      failing: failing.map((f) => f.area),
      summary: failing.length
        ? `${failing.length} of ${findings.length} check(s) failing: ${failing.map((f) => f.area).join(', ')}`
        : `all ${findings.length} check(s) passing`,
    };
    setSetting(LAST_KEY, JSON.stringify(out));
    emit('repair.diagnosed', { ok: out.ok, failing: out.failing, summary: out.summary });
    lg.info(out.summary);
    return out;
  } finally {
    if (sandbox) removeWorktree(sandbox);
  }
}

/**
 * Try to make the app work, and return the change that would do it.
 *
 * Nothing is applied. The result carries a diff the operator reviews and lands through the normal
 * path, so a repair is subject to exactly the same scrutiny as any other change to the codebase.
 */
export async function repair({ signal, commit = 'HEAD', overlay: useOverlay = true } = {}) {
  let sandbox = null;
  emit('repair.started', { phase: 'repair', commit });
  try {
    sandbox = createSandbox([], commit);
  } catch (err) {
    return { ok: false, error: `could not create a sandbox to repair in: ${err.message}` };
  }

  try {
    // Repairing a SPECIFIC commit — as the promote flow does for a blocker — must not overlay the
    // working tree: the question there is whether that commit is sound, and mixing in uncommitted
    // edits would answer a different one.
    const overlay = useOverlay && commit === 'HEAD' ? overlayWorkingTree(sandbox) : { dirty: false, applied: 0 };
    const initial = await verifyLocalExecution({ sandboxRoot: sandbox, iterationId: null, signal });

    if (initial.ok) {
      // Saying "nothing to repair" is a result, not a failure. A repair tool that always produces a
      // change is a tool that damages working software.
      return {
        ok: true, repaired: false, nothingToDo: true,
        summary: 'every check already passes — there is nothing to repair',
        findings: Object.entries(initial.checks || {}).map(([n, c]) => toFinding(n, c)),
      };
    }

    // `healBoot` fixes its own attempt count (MAX_ATTEMPTS); accepting a `maxAttempts` here and
    // passing it would be an option that silently does nothing.
    const healed = await healBoot({ sandboxRoot: sandbox, iterationId: null, diff: '', diffFiles: [], initial, signal });

    // Whatever the repair actually changed, read back from git rather than from what it claims.
    // `git(args, cwd)` takes the directory as its SECOND POSITIONAL argument — passing `{ cwd }`
    // would have run these against the operator's real checkout instead of the sandbox.
    let diff = '';
    let files = [];
    try {
      diff = git(['diff'], sandbox);
      files = git(['diff', '--name-only'], sandbox).split('\n').filter(Boolean);
    } catch { /* an unreadable diff is reported as none */ }

    const out = {
      ok: true,
      repaired: !!healed.healed,
      attempts: healed.attempts,
      fixes: (healed.fixes || []).map((f) => ({ file: f.file || f.path || null, why: f.why || f.reason || null })),
      files,
      diff,
      dirty: overlay.dirty,
      findings: Object.entries(healed.result?.checks || {}).map(([n, c]) => toFinding(n, c)),
      summary: healed.healed
        ? `repaired after ${healed.attempts} attempt(s) — ${files.length} file(s) changed, review the diff before applying`
        : `could not repair it in ${healed.attempts} attempt(s) — the diagnosis below is what it was still failing on`,
    };
    emit('repair.finished', { repaired: out.repaired, attempts: out.attempts, files: files.length });
    lg[out.repaired ? 'info' : 'warn'](out.summary);
    return out;
  } catch (err) {
    lg.warn(`repair failed: ${err.message}`);
    return { ok: false, error: err.message };
  } finally {
    if (sandbox) removeWorktree(sandbox);
  }
}

/** The last diagnosis, so the page has something to show before anything is run. */
export function lastDiagnosis() {
  try { return JSON.parse(getSetting(LAST_KEY, 'null')); } catch { return null; }
}
