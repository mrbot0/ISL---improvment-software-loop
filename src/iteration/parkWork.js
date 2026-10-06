import { iteration as cfg } from '../config.js';
import { git, revParse, branchExists } from '../sandbox/worktree.js';
import { emit } from '../bus.js';
import { log } from '../logger.js';
import { notify } from '../db_iteration.js';

/**
 * PARK THE WORK BRANCH AND START AGAIN — without deleting anything.
 *
 * A work branch accumulates commits that will never land: ones whose content already reached the
 * base by another route, ones that conflict, ones a gate refused. Measured on a real branch: **49
 * commits "ahead" with six files of actual difference** — 32 already applied, 17 stuck. The page
 * says there are 49 things to promote, none of them promote, and the operator reasonably concludes
 * the tool is broken.
 *
 * The obvious fix is "delete the broken commits", and it is the wrong one. **102 iteration records
 * and 58 deployment rows reference those SHAs**: dropping them orphans the link between a commit and
 * the run that produced it, its scores, and the gates it passed — exactly the provenance that makes
 * any of this auditable.
 *
 * So the branch is *parked*, not pruned. Its tip is kept under a dated name, the work branch is
 * re-cut from the base, and every SHA remains reachable. This is the same decision `ensureWorkBranch`
 * already makes when it finds a branch cut from a stale base; this just makes it reachable for the
 * case where the branch is fine but its contents have been superseded.
 */

const lg = log.for('park');
const base = () => cfg.baseBranch;

/**
 * What is really still different between the base and the work branch.
 *
 * TWO dots: `a b` compares the two tips and answers "how would the base tree differ", which is the
 * question. `a...b` diffs from the merge base and answers something else — on this branch it said 92
 * files where the honest answer was 6.
 */
export function unlandedWork(branch = null) {
  const b = base();
  // Defaults to the work branch, but any parked branch can be asked the same question — and after a
  // re-cut that is the ONLY place the unlanded work still exists, so a recovery that could not
  // target one would be unable to recover the thing it was built for.
  const w = branch || cfg.workBranch;
  if (!branchExists(w)) return { ok: false, reason: `no such branch (${w})` };
  try {
    const files = git(['diff', '--name-only', b, w]).split('\n').filter(Boolean);
    const stat = files.length ? git(['diff', '--stat', b, w]).split('\n').filter(Boolean).slice(-1)[0] : '';
    const ahead = git(['log', '--oneline', `${b}..${w}`]).split('\n').filter(Boolean).length;
    return {
      ok: true,
      baseBranch: b,
      workBranch: w,
      ahead,
      files,
      stat: stat.trim(),
      identical: files.length === 0,
      // The gap between these two numbers IS the confusion this exists to resolve.
      summary: files.length === 0
        ? `${ahead} commit(s) ahead by identity, but the branches are byte-for-byte identical — none of it is unlanded work`
        : `${ahead} commit(s) ahead by identity; ${files.length} file(s) genuinely differ`,
    };
  } catch (err) {
    return { ok: false, reason: err.message };
  }
}

/** The patch for whatever has not landed, so it can be salvaged before the branch is parked. */
export function recoveryDiff({ branch = null, maxBytes = 400_000 } = {}) {
  const from = branch || cfg.workBranch;
  const state = unlandedWork(from);
  if (!state.ok) return state;
  if (state.identical) return { ok: true, empty: true, branch: from, diff: '', files: [], summary: `nothing unlanded on ${from} — no patch to recover` };
  try {
    const diff = git(['diff', base(), from]);
    return {
      ok: true,
      branch: from,
      files: state.files,
      truncated: diff.length > maxBytes,
      diff: diff.slice(0, maxBytes),
      summary: `${state.files.length} file(s), ${Math.round(diff.length / 1024)} KB from ${from} — apply with: git apply <this patch>`,
    };
  } catch (err) {
    return { ok: false, reason: err.message };
  }
}

/**
 * Move the work branch aside and re-cut it from the base.
 *
 * @param {object}  opts
 * @param {boolean} opts.force  park even when unlanded work would be left behind on the parked
 *   branch. Off by default: parking a branch that still carries the only copy of six files' worth
 *   of change is not "cleaning up", it is hiding work where nobody will look for it.
 */
export function parkAndRecut({ force = false, dryRun = false } = {}) {
  const state = unlandedWork();
  if (!state.ok) return { ok: false, error: state.reason };

  /*
   * A real preview, because "call it and see what it says" is not one.
   *
   * Written after doing exactly that: calling this to find out what it *would* do, and parking a
   * branch. It was harmless only because that branch happened to be empty. An operation that
   * rewrites a ref needs a way to be asked without being performed.
   */
  if (dryRun) {
    return {
      ok: true,
      dryRun: true,
      wouldPark: cfg.workBranch,
      commits: state.ahead,
      unlanded: state.identical ? [] : state.files,
      blocked: !state.identical && !force,
      summary: state.ahead === 0
        ? `${cfg.workBranch} already starts from ${base()} — parking it would achieve nothing`
        : `would park ${state.ahead} commit(s) and re-cut ${cfg.workBranch} from ${base()}`
          + (state.identical ? '' : `; ${state.files.length} unlanded file(s) would remain only on the parked branch`),
    };
  }

  // Parking a branch that is already at the base creates a ref pointing at nothing new — noise that
  // looks like an archive and holds no archive.
  if (state.ahead === 0 && !force) {
    return { ok: false, noop: true, error: `${cfg.workBranch} already starts from ${base()} — there is nothing to park` };
  }

  if (!state.identical && !force) {
    return {
      ok: false,
      needsForce: true,
      unlanded: state.files,
      error: `${state.files.length} file(s) have not landed — they would stay only on the parked branch. `
        + 'Take the recovery patch first, or park anyway if you mean to abandon them.',
    };
  }

  const w = cfg.workBranch;
  const from = revParse(w);
  const to = revParse(base());
  if (!from) return { ok: false, error: `${w} does not exist` };

  // A dated name, and a counter when the same day is parked twice — overwriting the earlier ref
  // would lose the very history this is meant to keep reachable.
  const day = new Date().toISOString().slice(0, 10);
  let parked = `isl-parked/${w.replace(/[^\w.-]+/g, '-')}-${day}`;
  for (let n = 2; branchExists(parked) && n < 50; n++) parked = `isl-parked/${w.replace(/[^\w.-]+/g, '-')}-${day}-${n}`;

  try {
    git(['branch', parked, from]);
  } catch (err) {
    return { ok: false, error: `could not park the branch (${err.message}) — nothing was changed` };
  }

  try {
    git(['branch', '-f', w, to]);
  } catch (err) {
    // The parked ref is left in place: it is now the only name pointing at the old tip.
    return { ok: false, error: `parked as ${parked} but could not re-cut ${w} (${err.message})`, parked };
  }

  lg.info(`parked ${w} (${from.slice(0, 8)}) as ${parked} and re-cut it from ${base()} (${to.slice(0, 8)})`);
  emit('deploy.parked', { branch: w, parked, from: from.slice(0, 8), to: to.slice(0, 8), ahead: state.ahead });
  notify({
    kind: 'promotion',
    severity: 'info',
    title: `Work branch re-cut from ${base()}`,
    body: `${state.ahead} superseded commit(s) parked on ${parked} — nothing was deleted, every commit is still reachable from there.`,
  });

  return {
    ok: true,
    parked,
    from: from.slice(0, 8),
    to: to.slice(0, 8),
    parkedCommits: state.ahead,
    unlanded: state.identical ? [] : state.files,
    summary: `${state.ahead} commit(s) parked on ${parked}; ${w} now starts from ${base()} at ${to.slice(0, 8)}`,
  };
}

/**
 * Parked branches, newest first — so nothing is quietly forgotten.
 *
 * BOTH naming schemes. `ensureWorkBranch` has parked branches as `<name>-orphaned-<date>` since long
 * before this module existed, and it is the one that fires automatically — on this repo it is what
 * actually holds the operator's 49 archived commits. Listing only `isl-parked/` would have shown an
 * empty archive while the real one sat next to it, which is the worst possible answer: it reads as
 * "your work is gone".
 */
export function listParked() {
  const out = [];
  /*
   * Every local ref, filtered here rather than by a glob.
   *
   * `refs/heads/*-orphaned-*` looks right and matches nothing: git's ref patterns do not let `*`
   * cross a `/`, so the branch that actually held the archived work —
   * `agents/auto-improve-orphaned-2026-08-07` — was invisible. An archive listing that reports
   * "empty" while the archive sits next to it is the worst possible answer, because it reads as
   * "your work is gone".
   */
  const PARKED = /(^isl-parked\/)|(-orphaned-\d{4}-\d{2}-\d{2})/;
  let lines = [];
  try {
    lines = git(['for-each-ref', '--sort=-committerdate', '--format=%(refname:short)\x1f%(committerdate:iso8601)\x1f%(objectname:short)', 'refs/heads/'])
      .split('\n').filter(Boolean);
  } catch { return []; }

  {
    for (const line of lines) {
      const [name, date, sha] = line.split('\x1f');
      if (!name || !PARKED.test(name)) continue;
      let ahead = 0;
      let files = 0;
      try { ahead = git(['log', '--oneline', `${base()}..${name}`]).split('\n').filter(Boolean).length; } catch { /* unreadable */ }
      // How much of it is genuinely unlanded, not just carrying a different SHA. A parked branch
      // with 49 commits and zero file differences holds nothing worth recovering.
      try { files = git(['diff', '--name-only', base(), name]).split('\n').filter(Boolean).length; } catch { /* unreadable */ }
      out.push({ branch: name, parkedAt: date, sha, ahead, unlandedFiles: files, auto: !name.startsWith('isl-parked/') });
    }
  }
  return out.sort((a, b) => String(b.parkedAt).localeCompare(String(a.parkedAt)));
}
