import { git } from '../sandbox/worktree.js';
import { iteration as cfg } from '../config.js';
import { log } from '../logger.js';

/**
 * AT-LEAST-ONCE DELIVERY NEEDS AN IDEMPOTENCY KEY (ISL_IMPROVE "durable work queue", P1).
 *
 * Any pipeline that can replay a step can replay the step that COMMITS. The engine already has three
 * ways to re-run work that may have already landed — the operator's restart button, `restartMany`,
 * and the loop's own salvage of interrupted runs — and every one of them replays a stored diff into
 * a fresh sandbox. If the run being replayed had already reached `commitStaged` before it died, the
 * replay would happily commit the same change a second time.
 *
 * ── Why the key is what it is ───────────────────────────────────────────────────────────────────
 * The obvious key is the `[ai-iter#N]` marker the commit subject already carries. It is not enough
 * on its own: iteration ids restart from 1 whenever the project database is recreated, and this
 * repository's work branch already contains four id collisions from exactly that (#66, #68, #71 and
 * #74 each appear twice, with unrelated titles days apart). Keying on the id alone would read those
 * as duplicates and refuse to commit legitimate new work.
 *
 * So the key is the id AND the window: a commit only counts as "this iteration's work" if it was
 * made after the iteration started. An id reused by a later database cannot match a commit that
 * predates the run, and a genuine replay always looks at a commit made during it.
 */

const lg = log.for('idempotency');

/** Thrown when a replay would duplicate a commit that already landed. */
export class AlreadyCommittedError extends Error {
  constructor(iterationId, sha) {
    super(`iteration #${iterationId} has already committed ${String(sha).slice(0, 8)} — refusing to commit it twice`);
    this.name = 'AlreadyCommittedError';
    this.iterationId = iterationId;
    this.sha = sha;
  }
}

/**
 * The commit this iteration already made on the work branch, or null.
 *
 * @param {number} iterationId
 * @param {number} startedAtMs  when the iteration began — commits older than this belong to a
 *                              different database's run that happened to reuse the id
 * @param {{branch?:string}} [opts]
 */
export function existingCommitFor(iterationId, startedAtMs, { branch = cfg.workBranch } = {}) {
  if (!iterationId || !startedAtMs) return null;
  try {
    // `--grep` with a fixed string: the marker contains `[` and `#`, which are regex metacharacters.
    // `--since` is what makes an id reused by a later database harmless.
    const out = git([
      'log', branch,
      '--fixed-strings', `--grep=[ai-iter#${iterationId}]`,
      `--since=${Math.floor(startedAtMs / 1000)}`,
      '--format=%H',
      '-n', '1',
    ]);
    return out.trim() || null;
  } catch (err) {
    // A branch that does not exist yet, or a git that refused: this check may only ever PREVENT a
    // duplicate, never cause a refusal of its own. Failing open is right — the alternative is a
    // guard that blocks legitimate commits when git hiccups.
    lg.debug?.(`idempotency check skipped: ${err.message}`);
    return null;
  }
}

/**
 * Refuse to commit work that is already on the branch.
 * @throws {AlreadyCommittedError}
 */
export function assertNotAlreadyCommitted(iterationId, startedAtMs, opts = {}) {
  const sha = existingCommitFor(iterationId, startedAtMs, opts);
  if (sha) {
    lg.warn(`refusing a duplicate commit for iteration #${iterationId} — ${sha.slice(0, 8)} already carries this work`);
    throw new AlreadyCommittedError(iterationId, sha);
  }
}
