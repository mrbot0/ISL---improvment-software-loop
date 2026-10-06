import { ACTIVE_PROJECT_ID, REPO_ROOT } from '../config.js';

/**
 * PROJECT-STAMPED CACHES (ISL_IMPROVE "durable work queue", the cached-singleton half).
 *
 * ISL is multi-project, but its expensive derived data — the import graph, the coverage numbers, the
 * knowledge-index vectors — lived in module-scope variables with no idea which project they came
 * from. Correctness depended on `activateProject` remembering to call each module's invalidator by
 * hand. That list had grown to three, and it was already wrong: `knowledgeIndex` was never on it, so
 * switching project served the previous project's vectors for up to five minutes.
 *
 * "Remember to add your cache to a list in another file" is not a design; it is a bug waiting for
 * the next cache. So a cache built here STAMPS itself with the project it was filled under and
 * refuses to answer for a different one. Cross-project leakage stops being something to remember and
 * becomes something that cannot happen: a cache added tomorrow and registered nowhere is still safe.
 *
 * The explicit `invalidate()` remains, because "the project changed" and "the files changed" are
 * different events and only the first one is detectable from the stamp.
 */

/** Identity of the project a cached value belongs to. Both parts matter: a project can be repointed
 *  at a different folder without its id changing, and that is just as much a different codebase. */
const stamp = () => `${ACTIVE_PROJECT_ID ?? '—'}@${REPO_ROOT ?? '—'}`;

/**
 * A memoised value scoped to the active project.
 *
 * @param {string} name             for diagnostics
 * @param {{ttlMs?: number}} opts   0 = no expiry; the value lives until invalidated or the project changes
 * @returns {{get:(compute:()=>any)=>any, peek:()=>any, invalidate:()=>void, set:(v:any)=>any, stats:()=>object}}
 */
export function projectCache(name, { ttlMs = 0 } = {}) {
  let value;
  let filled = false;
  let filledAt = 0;
  let filledFor = null;

  const fresh = () => filled && filledFor === stamp() && (!ttlMs || Date.now() - filledAt < ttlMs);

  const set = (v) => {
    value = v;
    filled = true;
    filledAt = Date.now();
    filledFor = stamp();
    return v;
  };

  return {
    /** The cached value, computing it if this project has none (or its TTL has passed). */
    get(compute) {
      if (fresh()) return value;
      return set(compute());
    },
    /** The cached value WITHOUT computing it — null when there is nothing valid for this project. */
    peek() {
      return fresh() ? value : null;
    },
    set,
    invalidate() {
      value = undefined;
      filled = false;
      filledFor = null;
    },
    stats() {
      return { name, filled, fresh: fresh(), filledFor, ageMs: filled ? Date.now() - filledAt : null, ttlMs };
    },
  };
}
