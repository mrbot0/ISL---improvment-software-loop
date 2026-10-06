import { iteration as cfg } from '../config.js';
import { git, revParse, branchExists } from '../sandbox/worktree.js';
import { emit } from '../bus.js';
import { log } from '../logger.js';
import { notify } from '../db_iteration.js';
import { recordDeployment } from '../deploy/dora.js';
import { assessPromotion } from './promoteRisk.js';

/**
 * The hybrid gate. Iterations auto-commit onto the work branch; NOTHING reaches the
 * BASE BRANCH until the operator promotes it here. Promotion is a fast-forward merge
 * of the work branch into the base — refused if the base isn't a strict ancestor (so
 * we never silently drop or rewrite your commits) or if tracked files are dirty.
 *
 * The base is whatever branch you have checked out, NOT a hard-coded `main`. That
 * distinction matters: this repo's `main` is a stale lane, and promoting into it
 * would land agent work on a branch nobody ships.
 */

const base = () => cfg.baseBranch;

/**
 * Both of the functions below shell out to git several times, and on Windows every
 * `git` invocation is a fresh process spawn costing tens of milliseconds. They are
 * read from `/api/state`, which the dashboard refetches on almost every socket event
 * — so during a busy iteration this was firing a dozen synchronous git spawns several
 * times a second, pinning the event loop and starving the very WebSocket that drives
 * the refetch. The result the user saw: "connection lost", constantly, mid-run.
 *
 * None of what these report changes faster than a commit does. A one-second cache
 * removes the storm without making the UI feel stale.
 */
function cached(fn, ttlMs = 3000) {
  let at = 0;
  let value;
  return () => {
    const now = Date.now();
    if (now - at < ttlMs && value !== undefined) return value;
    value = fn();
    at = now;
    return value;
  };
}

/**
 * Is the fleet pointed at the code you think it is?
 *
 * This check exists because its absence cost twenty-two iterations. The engine was
 * hard-wired to `main`; this repo ships from a different branch; nothing anywhere
 * said so, and the agents spent days improving a version of the app nobody runs. The
 * failure was completely silent — every iteration passed, committed, and scored well.
 * It was just working on the wrong code.
 *
 * So now the baseline states itself, out loud, on the health endpoint.
 */
function baselineStatus_uncached() {
  let checkedOut = null;
  try {
    checkedOut = git(['rev-parse', '--abbrev-ref', 'HEAD']);
  } catch {
    /* not a git repo — the caller renders "unknown" */
  }

  const aligned = checkedOut === base();
  let trackedFiles = 0;
  try {
    trackedFiles = git(['ls-files']).split('\n').filter(Boolean).length;
  } catch {
    /* ignore */
  }

  return {
    baseBranch: base(),
    checkedOut,
    aligned,
    trackedFiles,
    workBranch: cfg.workBranch,
    workBranchDescendsFromBase: canFastForward(),
    warning: !aligned
      ? `The agents are configured to improve "${base()}" but the checkout is on "${checkedOut}". ` +
        `They will catalogue and edit the checked-out code and try to promote into "${base()}" — ` +
        `restart the server to re-detect, or set BASE_BRANCH.`
      : !canFastForward() && branchExists(cfg.workBranch)
        ? `The work branch "${cfg.workBranch}" does not descend from "${base()}" — its commits can never be ` +
          `promoted. It will be parked and re-cut on the next iteration.`
        : null,
  };
}

/** Commits on the work branch that are not yet on the base branch. */
function commitsAhead() {
  if (!branchExists(cfg.workBranch)) return [];
  try {
    const out = git(['log', '--oneline', `${base()}..${cfg.workBranch}`]);
    return out ? out.split('\n').filter(Boolean) : [];
  } catch {
    return [];
  }
}

/** True when the base is a strict ancestor of the work branch (a clean fast-forward). */
function canFastForward() {
  if (!branchExists(cfg.workBranch)) return false;
  try {
    git(['merge-base', '--is-ancestor', base(), cfg.workBranch]);
    return true;
  } catch {
    return false;
  }
}

/** Tracked files with local modifications, as repo-relative paths. */
function dirtyFiles() {
  try {
    return git(['status', '--porcelain', '--untracked-files=no'])
      .split('\n')
      .filter(Boolean)
      .map((l) => l.slice(3).trim().replace(/^"(.*)"$/, '$1'))
      // A rename shows as "old -> new"; the destination is the one a merge would write.
      .map((p) => (p.includes(' -> ') ? p.split(' -> ')[1] : p));
  } catch {
    return [];
  }
}

/**
 * The dirty files a promotion would actually overwrite.
 *
 * The old guard refused a promotion whenever ANY tracked file was modified, which is far
 * stricter than git: a fast-forward only fails on files the incoming commits touch. In practice that
 * meant a working tree with 21 unrelated edits blocked a 15-commit promotion of which exactly **one**
 * file overlapped — and the operator was told to "commit or stash" all 21 to land work that had
 * nothing to do with 20 of them.
 *
 * This narrows the refusal to the real conflict and NAMES it, so the fix is obvious instead of a
 * hunt. It never widens what is allowed: git's own `merge --ff-only` remains the final authority and
 * will still refuse if this misses something.
 */
function blockingDirtyFiles(target = cfg.workBranch) {
  const dirty = dirtyFiles();
  if (!dirty.length) return [];
  let incoming;
  try {
    incoming = new Set(git(['diff', '--name-only', `${base()}..${target}`]).split('\n').filter(Boolean));
  } catch {
    // Cannot tell what the promotion touches — fall back to the strict rule rather than guess
    // permissively. Refusing too much is recoverable; overwriting someone's edits is not.
    return dirty;
  }
  return dirty.filter((f) => incoming.has(f));
}

/**
 * Which commits ahead actually touch a blocking file.
 *
 * Knowing that "1 file would be overwritten" is only half an answer: the operator still has to guess
 * WHICH commit brought it, and every selection at or above that commit fails the same way. One `git
 * log` per blocking file (there is usually one) turns the list into something you can read the
 * answer off — pick anything below the marked commit and the promotion goes through.
 */
function conflictingCommits(target = cfg.workBranch) {
  const blocking = blockingDirtyFiles(target);
  if (!blocking.length) return {};
  const out = {};
  for (const file of blocking) {
    let shas = [];
    try {
      shas = git(['log', '--format=%h', `${base()}..${target}`, '--', file]).split('\n').filter(Boolean);
    } catch { /* unreadable — the file simply goes unattributed */ }
    for (const sha of shas) (out[sha] ||= []).push(file);
  }
  return out;
}

/** Promotion must land on the branch you actually have checked out. */
function onBaseBranch() {
  try {
    return git(['rev-parse', '--abbrev-ref', 'HEAD']) === base();
  } catch {
    return false;
  }
}

function deployStatus_uncached() {
  const baseSha = revParse(base());
  const workSha = revParse(cfg.workBranch);
  const ahead = commitsAhead();
  return {
    baseBranch: base(),
    workBranch: cfg.workBranch,
    baseSha: baseSha.slice(0, 8),
    mainSha: baseSha.slice(0, 8), // legacy key — same value, kept so older clients render
    workSha: workSha.slice(0, 8),
    ahead: ahead.length,
    /*
     * WHAT IS ACTUALLY DIFFERENT — not how many commits carry a different sha.
     *
     * "Commits ahead" counts identity. A commit whose changes reached the base by another route
     * still counts, while carrying nothing new. On a real branch that read **49 commits ahead** when
     * the two trees differed by **6 files**: 43 of them were already applied. An operator told there
     * are 49 things to promote, who then cannot promote any of them, concludes the tool is broken —
     * and the tool was telling the truth in a way that could not be acted on.
     */
    contentDiff: (() => {
      try {
        // TWO dots, not three. `a...b` diffs from the merge-base and answers "what happened on b
        // since they diverged" — which counted 92 files here. `a b` compares the two tips and
        // answers the question actually being asked, "how would the base tree differ": 6 files.
        const files = git(['diff', '--name-only', base(), cfg.workBranch]).split('\n').filter(Boolean);
        return { files: files.length, sample: files.slice(0, 8), identical: files.length === 0 };
      } catch {
        return null; // unreadable — the caller shows the commit count alone rather than a guess
      }
    })(),
    // All of them, not a slice: the cap silently hid the OLDEST commits, which are exactly the ones
    // you select when a conflict forces you to promote a shorter prefix.
    commits: ahead,
    // Which commits carry the conflict, so the list can mark them instead of leaving the operator to
    // bisect the selection by trial and error.
    conflictingCommits: conflictingCommits(),
    // Per-commit risk from what ISL already recorded about each run, plus how far it is safe to
    // promote. A merge conflict was the only thing that could previously stop a promotion; a commit
    // that landed with a red suite or a non-booting app went through unremarked.
    risk: assessPromotion({ commits: ahead, conflicts: conflictingCommits() }),
    canPromote: ahead.length > 0 && canFastForward() && onBaseBranch() && blockingDirtyFiles().length === 0,
    // Surfaced so the dashboard can show WHICH files are in the way rather than "commit or stash".
    blockingFiles: blockingDirtyFiles().slice(0, 20),
    dirtyCount: dirtyFiles().length,
    blockedReason:
      ahead.length === 0
        ? 'nothing to promote'
        : !onBaseBranch()
          ? `the checkout is not on ${base()} — switch to it before promoting`
          : !canFastForward()
            ? `the work branch has diverged from ${base()} (not a fast-forward)`
            : blockingDirtyFiles().length
              ? `${blockingDirtyFiles().length} file(s) you have edited would be overwritten — commit or stash them first: ${blockingDirtyFiles().slice(0, 3).join(', ')}${blockingDirtyFiles().length > 3 ? '…' : ''}`
              : null,
  };
}

/** Cached views (git-backed, slow, rarely-changing). Callers get a fresh-enough answer. */
export const deployStatus = cached(deployStatus_uncached);
export const baselineStatus = cached(baselineStatus_uncached);

/**
 * Fast-forward the base branch to the work branch tip. Runs in the main checkout, so
 * it updates your working tree — but only ever with commits already reviewed and
 * scored on the work branch, and only when it's a clean fast-forward.
 */
/**
 * @param {string|null} upToSha promote up to this commit (null = the whole source branch)
 * @param {object}  opts
 * @param {boolean} opts.stash  set the operator's overlapping edits aside and restore them after
 * @param {string}  opts.from   the branch `upToSha` is expected to be on. Defaults to the work
 *   branch — but the promote agent assembles its approved commits onto a branch of its own, cut
 *   from the base, and that branch is a perfectly valid fast-forward target. Requiring the target
 *   to be on the work branch rejected exactly the thing the agent exists to produce: 47 commits
 *   cherry-picked successfully and then refused with "is not on the work branch".
 */
export function promoteToMain(upToSha = null, { stash = false, from = null } = {}) {
  const source = from || cfg.workBranch;
  const status = deployStatus();
  // An assembled branch is its own justification for promoting: the commits are already on it.
  if (!from && status.ahead === 0) throw new Error('nothing to promote');
  if (!onBaseBranch()) throw new Error(`the checkout is not on ${base()} — switch to it before promoting`);
  if (!from && !canFastForward()) throw new Error(`the work branch has diverged from ${base()} — not a fast-forward`);
  // Default: promote the whole work branch. When a commit is selected, promote ONLY
  // up to (and including) it — a fast-forward to that commit. Because the work branch
  // is linear and descends from the base, any commit ahead is a valid FF target; its
  // older siblings come along, its newer ones stay behind for a later promotion.
  let target = source;
  let count = status.ahead;
  if (upToSha) {
    let full;
    try {
      full = revParse(String(upToSha).trim());
    } catch {
      throw new Error(`unknown commit ${upToSha}`);
    }
    try {
      git(['merge-base', '--is-ancestor', full, source]);
    } catch {
      throw new Error(`${String(upToSha).slice(0, 8)} is not on ${source}`);
    }
    try {
      git(['merge-base', '--is-ancestor', base(), full]);
    } catch {
      throw new Error(`${String(upToSha).slice(0, 8)} is not ahead of ${base()} (nothing to promote up to it)`);
    }
    target = full;
    try {
      count = git(['log', '--oneline', `${base()}..${full}`]).split('\n').filter(Boolean).length;
    } catch {
      count = 1;
    }
  }

  /*
   * THE CONFLICT WITH YOUR OWN EDITS — the block that made promotion unusable.
   *
   * "Commit or stash them first" is correct and it is also a chore ISL can simply do. With `stash`
   * it stashes ONLY the overlapping files, fast-forwards, and puts them back — which is exactly the
   * manual sequence, minus the part where the operator has to leave the product to run it.
   *
   * It is safe because nothing is discarded at any point: `git stash push -- <paths>` keeps the work
   * in the stash, and if restoring it conflicts with what was just promoted, the stash is STILL
   * there and git leaves the conflict markers to resolve normally. The one thing this must never do
   * is drop an edit on the floor, and no path through it can.
   */
  const blocking = blockingDirtyFiles(target);
  let stashed = null;
  if (blocking.length) {
    if (!stash) {
      throw new Error(
        `${blocking.length} file(s) you have edited would be overwritten by this promotion — commit or stash them first: `
        + `${blocking.slice(0, 5).join(', ')}${blocking.length > 5 ? ` and ${blocking.length - 5} more` : ''}`,
      );
    }
    const label = `isl-promote-${Date.now()}`;
    try {
      git(['stash', 'push', '-m', label, '--', ...blocking]);
      stashed = { label, files: blocking };
      log.info('promote', `stashed ${blocking.length} overlapping file(s) as "${label}" — they are restored after the fast-forward`);
    } catch (err) {
      throw new Error(`could not set your edits aside (${err.message}) — commit or stash them yourself, nothing was changed`);
    }
  }

  const before = revParse(base());
  try {
    git(['merge', '--ff-only', target]);
  } catch (err) {
    // The promotion failed AFTER the stash: put the edits back before reporting, or the operator
    // is left with their work in a stash they were never told about.
    if (stashed) {
      try { git(['stash', 'pop']); } catch { /* reported below */ }
    }
    throw err;
  }
  const after = revParse(base());

  if (stashed) {
    try {
      git(['stash', 'pop']);
      stashed.restored = true;
      log.info('promote', `restored ${stashed.files.length} stashed file(s)`);
    } catch (err) {
      // A conflicting pop is a normal git situation, not a lost edit — but it MUST be surfaced,
      // loudly, with the stash name, because the operator's work is now only in the stash.
      stashed.restored = false;
      stashed.conflict = err.message;
      /*
       * DIRE LA COSA GIUSTA, non quella rassicurante.
       *
       * Questo messaggio diceva "esegui `git stash pop` e risolvi". È sbagliato ed è sbagliato in
       * modo dannoso: il pop è GIÀ avvenuto, ed è proprio lui ad aver lasciato i marcatori nei file.
       * Rieseguirlo dà errore, e nel frattempo l'operatore ha in mano dei sorgenti che non
       * compilano credendo che il lavoro sia ancora "al sicuro nello stash" e la copia di lavoro
       * intatta. Su questo repository un file di pagina è rimasto così, in stato UU e con i
       * marcatori dentro, finché qualcuno non ha provato ad aprire quella pagina.
       *
       * La sequenza vera è: i marcatori sono già nei tuoi file, risolvili lì, poi butta lo stash.
       * Elenchiamo anche QUALI file, perché "N file" non basta a sapere dove guardare.
       */
      const conflicted = (() => {
        try {
          return git(['diff', '--name-only', '--diff-filter=U']).trim().split('\n').filter(Boolean);
        } catch { return stashed.files; }
      })();
      stashed.conflictedFiles = conflicted;
      log.warn('promote', `i tuoi file sono già in conflitto nella copia di lavoro (${conflicted.join(', ')}) — risolvi lì, poi: git stash drop`);
      notify({
        kind: 'promotion',
        severity: 'warning',
        title: `${conflicted.length} file in conflitto da risolvere`,
        body: `La promozione è riuscita, ma il ripristino delle tue modifiche confligge con essa. `
          + `I marcatori di conflitto sono GIÀ nei file: ${conflicted.slice(0, 4).join(', ')}${conflicted.length > 4 ? '…' : ''}. `
          + `Questi file non compilano finché non li risolvi. Poi elimina la copia di sicurezza con `
          + `\`git stash drop\` ("${stashed.label}"). Non eseguire di nuovo \`git stash pop\`: fallirebbe.`,
      });
    }
  }

  // DORA + the post-deploy guardrail. Recorded here rather than on the `deploy.promoted` event
  // because a listener that misses the event loses the deployment silently, and a deployment that
  // never entered the metrics is one the bake window will never watch.
  recordDeployment({ from: before, to: after, branch: base(), count });

  emit('deploy.promoted', { from: before.slice(0, 8), to: after.slice(0, 8), count, branch: base() });
  log.info('promote', `promoted ${count} commit(s) to ${base()} → ${after.slice(0, 8)}${upToSha ? ` (up to ${after.slice(0, 8)})` : ''}`);
  notify({
    kind: 'promotion',
    severity: 'info',
    title: `Promoted ${count} commit(s) to ${base()}`,
    body: `${base()} → ${after.slice(0, 8)}`,
  });
  return { ok: true, from: before.slice(0, 8), to: after.slice(0, 8), promoted: count, branch: base(), stashed };
}
