import { iteration as cfg } from '../config.js';
import { git, revParse, createSandbox, removeWorktree } from '../sandbox/worktree.js';
import { emit } from '../bus.js';
import { log } from '../logger.js';

/**
 * THE PROMOTE AGENT — land the good commits, leave the broken ones behind.
 *
 * Promotion was a fast-forward, which means what lands is a contiguous **prefix**: one bad commit
 * walls off everything after it. On a real branch that made the feature unusable — 49 commits ahead,
 * the OLDEST carrying a security finding, therefore nothing promotable at all, ever, no matter how
 * good the other 48 were.
 *
 * The fast-forward was a choice of the implementation, not a constraint of git. Cherry-picking the
 * chosen commits onto a fresh branch off the base lifts it, and the excluded ones simply never
 * appear. What that buys has to be paid for with real analysis, because a commit is rarely
 * independent:
 *
 *   1. **Dependencies.** If commit B touches a file commit A changed, taking B without A is at best
 *      a conflict and at worst a silently wrong tree. Excluding a commit therefore has to exclude
 *      everything that builds on it, transitively.
 *   2. **git decides, not the analysis.** File overlap is a conservative *guess* at dependency. The
 *      authoritative test is whether the cherry-pick applies, so the plan is REHEARSED in a
 *      throwaway worktree; anything that will not apply is dropped (with its dependents) and the
 *      rehearsal repeats.
 *   3. **Then it is verified.** The result is a tree nobody has ever built. Running the suite and
 *      the boot check on it is the difference between "these commits looked fine individually" and
 *      "this combination works".
 *
 * Nothing touches the operator's checkout until they approve. The final step is still a plain
 * fast-forward — onto a branch that now contains exactly what was approved.
 */

const lg = log.for('promote-agent');
const base = () => cfg.baseBranch || 'main';

/** Files a commit touches. The unit of "these two commits are related". */
function filesOf(sha, cwd) {
  try {
    return git(['show', '--pretty=format:', '--name-only', sha], cwd).split('\n').map((s) => s.trim()).filter(Boolean);
  } catch {
    return [];
  }
}

/**
 * Which commits each commit depends on.
 *
 * Conservative and textual: B depends on A when they share a file and A is older. It over-reports —
 * two unrelated edits to opposite ends of a large file look dependent — and that is the right
 * direction to be wrong in. Under-reporting produces a tree that applies cleanly and is subtly
 * wrong; over-reporting only means a commit waits for the next promotion.
 *
 * @param {Array<{sha:string}>} ordered oldest first
 */
export function dependencyGraph(ordered, cwd) {
  const files = new Map();
  for (const c of ordered) files.set(c.sha, new Set(filesOf(c.sha, cwd)));

  const deps = new Map();
  for (let i = 0; i < ordered.length; i++) {
    const me = ordered[i];
    const mine = files.get(me.sha);
    const on = new Set();
    for (let j = 0; j < i; j++) {
      const older = ordered[j];
      for (const f of files.get(older.sha)) {
        if (mine.has(f)) { on.add(older.sha); break; }
      }
    }
    deps.set(me.sha, on);
  }
  return { deps, files };
}

/**
 * Close a set of exclusions over the dependency graph.
 *
 * Excluding a commit without excluding what builds on it is the mistake that makes cherry-picking
 * dangerous: the dependent applies, git reports success, and the result compiles into behaviour
 * nobody wrote. Each excluded commit carries a reason, and a commit dropped for depending on
 * another says which one — "excluded because it builds on a1b2c3d" is actionable in a way that
 * "excluded" is not.
 */
export function excludeWithDependents(ordered, deps, seeds) {
  const excluded = new Map(seeds); // sha → reason
  let changed = true;
  while (changed) {
    changed = false;
    for (const c of ordered) {
      if (excluded.has(c.sha)) continue;
      for (const d of deps.get(c.sha) || []) {
        if (excluded.has(d)) {
          excluded.set(c.sha, `it builds on ${d.slice(0, 8)}, which is excluded (${excluded.get(d)})`);
          changed = true;
          break;
        }
      }
    }
  }
  return excluded;
}

/**
 * Work out what can actually be promoted, and rehearse it.
 *
 * @param {object}   opts
 * @param {Array}    opts.commits  assessed commits, NEWEST FIRST (as git log prints them)
 * @param {Function} opts.isBroken (commit) → reason string, or null to include it
 * @returns {Promise<object>} the plan, the exclusions with reasons, and the rehearsal result
 */
export async function planPromotion({ commits = [], isBroken, strictDeps = false, maxAttempts = 40, signal } = {}) {
  if (!commits.length) return { ok: true, empty: true, plan: [], excluded: [], summary: 'nothing ahead of the base branch' };

  // Oldest first: that is the order a cherry-pick has to replay them in.
  const ordered = [...commits].reverse();

  let sandbox = null;
  let rehearsalBranch = null;
  try {
    sandbox = createSandbox([], base());
  } catch (err) {
    return { ok: false, error: `could not create a worktree to rehearse in: ${err.message}` };
  }

  try {
    const { deps } = dependencyGraph(ordered, sandbox);

    const seeds = new Map();
    for (const c of ordered) {
      const why = isBroken?.(c);
      if (why) seeds.set(c.sha, why);
    }

    /*
     * START FROM THE BROKEN ONES ONLY, AND LET GIT FIND THE REST.
     *
     * Closing the exclusion over the textual graph up front is far too blunt in practice: measured
     * on a real branch, three security-flagged commits took **152 others** with them, because file
     * overlap counts `package.json` and any shared module as a dependency. Almost none of those 152
     * actually needed the excluded commits.
     *
     * And the reasoning behind the closure does not hold for this case. A security finding says
     * commit A introduced a secret — it does not travel to a later commit B that happens to touch
     * the same file. What B might genuinely need from A is A's *content*, and whether B can live
     * without it is a question `git cherry-pick` answers exactly, in the rehearsal below.
     *
     * So the graph is not used to pre-emptively exclude. It is used to close over the commits that
     * git PROVES are dependent, by refusing to apply them — where "it builds on X" is a fact rather
     * than an inference. `strictDeps` restores the pessimistic behaviour for anyone who wants it.
     */
    let excluded = strictDeps ? excludeWithDependents(ordered, deps, seeds) : new Map(seeds);
    let plan = ordered.filter((c) => !excluded.has(c.sha));

    /*
     * REHEARSAL. The textual graph proposes; git disposes.
     *
     * A commit the analysis called independent can still fail to apply — a rename, a file deleted in
     * between, a hunk whose context moved. Each failure excludes that commit AND its dependents, and
     * the whole rehearsal starts again on a clean branch, because a partially-applied series is not
     * a state anything can be concluded from.
     */
    /*
     * ONE PASS, SKIPPING WHAT WILL NOT APPLY.
     *
     * `cherry-pick --abort` restores the state from before the failed pick, so a failure does not
     * poison the series — the next commit can be tried immediately. Restarting the whole rehearsal
     * on every failure would be O(n × failures), and on a 200-commit branch that is minutes of
     * cherry-picking to reach the same answer.
     *
     * The transitive exclusion falls out of this for free, and as a FACT rather than an inference: a
     * commit that genuinely needed a skipped one fails too, and is skipped in turn.
     */
    const branch = `isl-promote-${Date.now()}`;
    rehearsalBranch = branch; // so the `finally` can remove it
    try { git(['cherry-pick', '--abort'], sandbox); } catch { /* nothing in progress */ }
    git(['checkout', '-B', branch, base()], sandbox);

    const applied = [];
    /*
     * ALREADY ON THE BASE — the distinction that makes the whole feature honest.
     *
     * "Commits ahead" counts SHA identity. A commit whose changes reached the base by another route
     * — an earlier promotion, a manual merge, a rebase — is still ahead by that count while
     * carrying nothing new. Measured on a real branch: **49 commits ahead, 6 files of actual
     * difference**; 43 of them were already applied.
     *
     * Cherry-picking those produces an empty commit, which `--empty=drop` correctly discards — and
     * the earlier version then counted them as "applied", assembled a branch identical to the base,
     * and reported "promoted 0 commits" after claiming 32 would land. Tracking them separately is
     * the difference between "nothing can be promoted" (alarming, wrong) and "this is already on
     * the base" (true, and the end of the matter).
     */
    const alreadyPresent = [];
    let head = git(['rev-parse', 'HEAD'], sandbox);
    let attempts = 0;
    for (const c of plan) {
      /*
       * Every commit is tried. The earlier guard stopped after `maxAttempts` when nothing had
       * applied yet — meant as protection against a hopeless branch, it instead truncated the
       * analysis on the common case where the first several commits are already on the base, and
       * the report then accounted for 42 of 49 commits with no explanation for the other 7.
       * A cherry-pick that drops is cheap; an incomplete answer is not.
       */
      attempts++;
      try {
        /*
         * `-x` records where it came from — on a promotion branch that provenance is the only route
         * back to the original commit and its run record.
         *
         * `--empty=drop` is the difference between this working and not. A cherry-pick whose changes
         * are ALREADY on the base is not a failure: it means that work is present, and git's default
         * is to stop the whole sequence with "The previous cherry-pick is now empty". Treating that
         * as inapplicable rejected commits whose content had already landed — on this branch that was
         * the majority of them.
         */
        git(['cherry-pick', '-x', '--empty=drop', c.sha], sandbox);
        // HEAD not moving means the pick was empty and was dropped: its content is already here.
        const now = git(['rev-parse', 'HEAD'], sandbox);
        if (now === head) alreadyPresent.push(c.sha);
        else { applied.push(c.sha); head = now; }
      } catch (err) {
        /*
         * `--skip`, NOT `--abort`.
         *
         * `--abort` unwinds the ENTIRE sequence back to where the branch started, so a single
         * conflict discarded every commit already applied — and the loop then reported that nothing
         * could be promoted. `--skip` drops just this commit and leaves the rest standing, which is
         * exactly what a skip-and-continue pass needs. `--quit` is the fallback for a state where
         * there is no sequence left to skip.
         */
        try { git(['cherry-pick', '--skip'], sandbox); }
        catch { try { git(['cherry-pick', '--quit'], sandbox); } catch { /* nothing in progress */ } }
        const first = String(err.message || '').split('\n').find((l) => /conflict|error: could not apply|CONFLICT/i.test(l)) || 'it does not apply';
        excluded.set(c.sha, `it does not apply on top of what came before it — ${first.trim().slice(0, 160)}`);
      }
    }
    plan = ordered.filter((c) => applied.includes(c.sha));

    // `revParse` always runs in the main checkout — it takes no cwd — so asking it for the
    // rehearsal's HEAD would have returned the operator's branch tip instead. Same trap as the
    // second positional argument of `git()`, and just as silent.
    const tip = plan.length ? (() => { try { return git(['rev-parse', 'HEAD'], sandbox); } catch { return null; } })() : null;
    const result = {
      ok: true,
      // Neither is usable by the caller — the worktree is about to be removed and the branch with
      // it. Reported for the log, not offered as something to act on: `applyPlan` rebuilds from the
      // approved list precisely so nothing depends on scratch state surviving between requests.
      rehearsedOn: branch,
      attempts,
      tip,
      plan: plan.map((c) => ({ sha: c.sha, subject: c.subject, runId: c.runId ?? null, score: c.score ?? null })),
      alreadyPresent: alreadyPresent.map((sha) => {
        const c = ordered.find((x) => x.sha === sha);
        return { sha, subject: c?.subject || '' };
      }),
      excluded: [...excluded].map(([sha, why]) => {
        const c = ordered.find((x) => x.sha === sha);
        return { sha, subject: c?.subject || '', why, direct: seeds.has(sha) };
      }),
      // Three outcomes, three sentences. Conflating "already there" with "cannot be promoted" is what
      // made this read as a broken system when it was reporting the truth.
      summary: plan.length
        ? `${plan.length} of ${ordered.length} commit(s) bring new work and can be promoted`
          + (alreadyPresent.length ? `; ${alreadyPresent.length} are already on ${base()}` : '')
          + (excluded.size ? `; ${excluded.size} left behind` : '')
        : alreadyPresent.length === ordered.length - excluded.size
          ? `nothing to promote — all ${alreadyPresent.length} commit(s) with content are already on ${base()}`
          : `none of the ${ordered.length} commit(s) can be promoted on their own`,
    };
    lg.info(result.summary);
    return result;
  } catch (err) {
    return { ok: false, error: err.message };
  } finally {
    /*
     * Remove the worktree AND the rehearsal branch.
     *
     * A worktree shares the ref store, so a branch created inside one outlives it — the rehearsal
     * was leaving `isl-promote-<ts>` behind on every run, and planning is something an operator does
     * repeatedly. The branch is pure scratch: `applyPlan` rebuilds from the approved list rather
     * than trusting a ref that has been sitting around since a previous request.
     */
    if (sandbox) removeWorktree(sandbox);
    if (rehearsalBranch) {
      try { git(['branch', '-D', rehearsalBranch]); } catch { /* already gone with the worktree */ }
    }
  }
}

/**
 * Rebuild an approved plan and fast-forward the base branch onto it.
 *
 * Deliberately re-derived rather than reusing the rehearsal: the two are separate requests, minutes
 * can pass, and applying a branch built from state nobody re-checked is how a promotion lands
 * something the operator never saw. The cherry-picks run in a throwaway worktree; the operator's
 * checkout only ever performs a fast-forward, exactly as before.
 *
 * @param {string[]} shas approved commits, OLDEST FIRST
 */
export async function applyPlan(shas = [], { verify = null } = {}) {
  if (!shas.length) return { ok: false, error: 'nothing approved to promote' };

  let sandbox = null;
  try {
    sandbox = createSandbox([], base());
  } catch (err) {
    return { ok: false, error: `could not create a worktree: ${err.message}` };
  }

  const branch = `isl-promoted-${Date.now()}`;
  try {
    git(['checkout', '-B', branch, base()], sandbox);
    const applied = [];
    const alreadyPresent = [];
    let head = git(['rev-parse', 'HEAD'], sandbox);
    for (const sha of shas) {
      try {
        // Same two rules as the rehearsal: an already-present change is dropped, not fatal.
        git(['cherry-pick', '-x', '--empty=drop', sha], sandbox);
        const now = git(['rev-parse', 'HEAD'], sandbox);
        if (now === head) alreadyPresent.push(sha);
        else { applied.push(sha); head = now; }
      } catch (err) {
        try { git(['cherry-pick', '--quit'], sandbox); } catch { /* nothing in progress */ }
        // Nothing has touched the real branch yet, so abandoning here leaves no trace.
        return {
          ok: false,
          error: `${sha.slice(0, 8)} no longer applies (${String(err.message).split('\n')[0]}) — re-plan and approve again`,
          appliedBefore: applied.length,
        };
      }
    }

    // A worktree shares the object store and the ref store with the main repository, so the branch
    // `checkout -B` created above already exists there — the main checkout can fast-forward onto it
    // as soon as this worktree is gone. Nothing further is needed to publish it.
    const tip = git(['rev-parse', 'HEAD'], sandbox);
    /*
     * A tip equal to the base is not a failure — it is the answer "everything you selected is
     * already there". Returning ok:true with applied:0 and letting the caller fast-forward onto the
     * base it is already on produced the nonsensical "promoted 0 commit(s), 01723fd7 → 01723fd7".
     */
    if (!applied.length) {
      return {
        ok: false,
        nothingNew: true,
        alreadyPresent: alreadyPresent.length,
        error: `all ${alreadyPresent.length} selected commit(s) are already on ${base()} — their changes arrived by another route, so there is nothing to fast-forward`,
      };
    }
    return { ok: true, branch, tip, applied: applied.length, shas: applied, alreadyPresent: alreadyPresent.length };
  } catch (err) {
    return { ok: false, error: err.message };
  } finally {
    if (sandbox) removeWorktree(sandbox);
  }
}

/** Remove a promotion branch once it has been merged, so they do not pile up. */
export function dropPromotionBranch(branch) {
  if (!/^isl-promot(e|ed)-\d+$/.test(String(branch || ''))) return false;
  try { git(['branch', '-D', branch]); return true; } catch { return false; }
}

export { base as promoteBase };
