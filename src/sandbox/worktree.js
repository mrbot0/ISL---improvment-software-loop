import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { BASE_BRANCH, PRODUCT_DIRS, REPO_ROOT, WORKTREE_DIR } from '../config.js';

export function git(args, cwd = REPO_ROOT) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

export const headCommit = () => {
  try {
    return git(['rev-parse', 'HEAD']);
  } catch {
    return '';
  }
};

export const currentBranch = () => {
  try {
    return git(['rev-parse', '--abbrev-ref', 'HEAD']);
  } catch {
    return '';
  }
};

/**
 * Are there uncommitted changes? Only TRACKED files count — and that restriction is
 * not just semantic, it is a performance necessity. Plain `git status --porcelain`
 * walks the entire working tree, which here includes every `node_modules` in the
 * repo and its microservices (tens of thousands of files). On the hot `/api/state`
 * path that single command was costing the better part of a second per request.
 * `--untracked-files=no` skips all of that.
 */
export const isDirty = () => {
  try {
    return git(['status', '--porcelain', '--untracked-files=no']).length > 0;
  } catch {
    return false;
  }
};

/**
 * node_modules are not tracked by git, so a fresh worktree cannot run the test
 * suite. Link them from the main checkout instead of reinstalling (~1s vs ~60s).
 * Windows junctions work without elevation; everything else gets a symlink.
 */
function linkNodeModules(worktreePath) {
  for (const project of ['backend', 'frontend']) {
    const src = path.join(REPO_ROOT, project, 'node_modules');
    const dst = path.join(worktreePath, project, 'node_modules');
    if (!fs.existsSync(src) || fs.existsSync(dst)) continue;
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    try {
      fs.symlinkSync(src, dst, process.platform === 'win32' ? 'junction' : 'dir');
    } catch (err) {
      throw new Error(`Could not link ${project}/node_modules into the sandbox: ${err.message}`);
    }
  }
}

/**
 * Create a detached worktree at `commit`, apply `files`, and return its path.
 * The caller must always removeWorktree() in a finally block.
 *
 * @param {Array<{path:string,newContent:string}>} files
 */
export function createSandbox(files, commit = 'HEAD') {
  fs.mkdirSync(WORKTREE_DIR, { recursive: true });
  const dir = path.join(WORKTREE_DIR, `wt-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);

  git(['worktree', 'add', '--detach', '--quiet', dir, commit]);
  try {
    linkNodeModules(dir);
    for (const f of files) {
      const target = path.join(dir, f.path);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, f.newContent, 'utf8');
    }
  } catch (err) {
    removeWorktree(dir);
    throw err;
  }
  return dir;
}

export function removeWorktree(dir) {
  try {
    // The junctions must go first, or `git worktree remove` walks into node_modules.
    for (const project of ['backend', 'frontend']) {
      const link = path.join(dir, project, 'node_modules');
      try {
        if (fs.lstatSync(link).isSymbolicLink() || fs.lstatSync(link).isDirectory()) fs.unlinkSync(link);
      } catch {
        /* not linked */
      }
    }
  } catch {
    /* ignore */
  }
  try {
    git(['worktree', 'remove', '--force', dir]);
  } catch {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
      git(['worktree', 'prune']);
    } catch {
      /* best effort — a stale worktree is not worth crashing the server over */
    }
  }
}

/* ---------------------- iteration engine git helpers ---------------------- */

export const revParse = (ref) => {
  try {
    return git(['rev-parse', ref]);
  } catch {
    return '';
  }
};

export const branchExists = (branch) => !!revParse(`refs/heads/${branch}`);

/**
 * Ensure the work branch exists and is cut from the CURRENT baseline.
 *
 * The base used to be hard-coded to `main`. That silently pointed the whole fleet at
 * a stale lane: if the branch you actually ship from isn't called `main`, every
 * iteration was built on code you'd long since moved past. So the base is now
 * `BASE_BRANCH` — the branch you have checked out.
 *
 * We also refuse to keep a work branch that no longer descends from that baseline.
 * A work branch cut from an obsolete base can never fast-forward into the real one,
 * so its commits could never be promoted — it would accumulate work forever and land
 * none of it. Better to notice, say so, and re-cut it.
 *
 * The branch is never checked out in the main repo — iterations advance it by
 * committing in a detached worktree and force-moving the ref, so your working tree
 * is never disturbed.
 */
export function ensureWorkBranch(branch, baseBranch = BASE_BRANCH) {
  const base = revParse(baseBranch) || headCommit();

  if (!branchExists(branch)) {
    git(['branch', branch, base]);
    return base;
  }

  // Does the existing work branch still descend from the baseline?
  try {
    git(['merge-base', '--is-ancestor', base, branch]);
    return revParse(branch); // yes — carry on, its commits can still be promoted
  } catch {
    // No. It was cut from a different (usually stale) base. Its commits cannot
    // fast-forward into the baseline, so keeping it would be a slow-motion data loss:
    // work would pile up on a branch that can never land. Park it under a dated name
    // — nothing is deleted — and re-cut the work branch from the real baseline.
    const parked = `${branch}-orphaned-${new Date().toISOString().slice(0, 10)}`;
    try {
      git(['branch', '-f', parked, branch]);
    } catch {
      /* the parking ref already exists — the old tip is still reachable from it */
    }
    git(['branch', '-f', branch, base]);
    return base;
  }
}

/** Point a branch ref at a commit. Safe because the branch is not checked out here. */
export const moveBranch = (branch, sha) => git(['branch', '-f', branch, sha]);

/**
 * Stage the product files an implementer is allowed to touch, and return the
 * resulting diff + line stats. Nothing is committed yet — this feeds the graders.
 */
export function stageProductAndDiff(dir) {
  // The product dirs this branch actually has (detected at boot), filtered again
  // against the sandbox — a missing pathspec aborts `git add` outright.
  const specs = PRODUCT_DIRS.filter((p) => fs.existsSync(path.join(dir, p)));
  git(['add', '-A', '--', ...specs], dir);
  const diff = git(['diff', '--cached'], dir);
  const nameOnly = git(['diff', '--cached', '--name-only'], dir);
  const files = nameOnly ? nameOnly.split('\n').filter(Boolean) : [];
  let additions = 0;
  let deletions = 0;
  for (const line of diff.split('\n')) {
    if (line.startsWith('+') && !line.startsWith('+++')) additions++;
    else if (line.startsWith('-') && !line.startsWith('---')) deletions++;
  }
  return { diff, files, additions, deletions };
}

/**
 * Every file a worktree has modified relative to its checkout, added or not.
 * This is how a parallel wave knows what to carry between sandboxes.
 */
export function changedFiles(dir) {
  const out = git(['status', '--porcelain', '--untracked-files=all'], dir);
  if (!out) return [];
  return out
    .split('\n')
    .filter(Boolean)
    .map((line) => line.slice(3).trim()) // strip the XY status prefix
    .map((p) => p.replace(/^"(.*)"$/, '$1')) // git quotes paths with odd characters
    .filter((p) => !p.includes('node_modules/'));
}

/**
 * Copy a set of files from one worktree into another, creating directories as
 * needed. Used to seed a task sandbox with the work of previous waves, and to
 * fold a finished task's edits back into the accumulator.
 */
export function copyFiles(fromDir, toDir, files) {
  const copied = [];
  for (const rel of files) {
    const src = path.join(fromDir, rel);
    const dst = path.join(toDir, rel);
    try {
      if (!fs.existsSync(src)) {
        // The task deleted it — mirror that.
        if (fs.existsSync(dst)) {
          fs.rmSync(dst, { force: true });
          copied.push(rel);
        }
        continue;
      }
      fs.mkdirSync(path.dirname(dst), { recursive: true });
      fs.copyFileSync(src, dst);
      copied.push(rel);
    } catch {
      /* a file we cannot carry across is reported by the diff, not by throwing here */
    }
  }
  return copied;
}

/**
 * Replay a unified diff into a worktree. This is what makes a failed iteration
 * restartable: the edits it had produced are re-applied to a fresh sandbox so the
 * run resumes from the work already done rather than from nothing.
 *
 * `--3way` lets a patch still land when the base has drifted slightly underneath it.
 */
export function applyDiff(dir, diff) {
  if (!diff?.trim()) return { applied: false, reason: 'empty diff' };
  const patch = path.join(dir, '.agent-restart.patch');
  fs.writeFileSync(patch, diff.endsWith('\n') ? diff : `${diff}\n`, 'utf8');
  try {
    git(['apply', '--3way', '--whitespace=nowarn', patch], dir);
    return { applied: true };
  } catch (err) {
    try {
      // Fall back to a tolerant apply — better a partial replay than none.
      git(['apply', '--reject', '--whitespace=nowarn', patch], dir);
      return { applied: true, partial: true };
    } catch {
      return { applied: false, reason: err.message.split('\n')[0] };
    }
  } finally {
    fs.rmSync(patch, { force: true });
  }
}

/** Commit the already-staged changes in a worktree. Returns the new SHA. */
export function commitStaged(dir, message) {
  git(['-c', 'user.name=RentAll Agents', '-c', 'user.email=agents@rentall.local', 'commit', '--quiet', '-m', message], dir);
  return git(['rev-parse', 'HEAD'], dir);
}

/**
 * Run a command, capture combined output, never throw on non-zero exit.
 *
 * Deliberately no `shell: true` — on Windows that concatenates argv into a cmd.exe
 * string (DEP0190) and makes quoting a correctness problem. Callers invoke tool
 * entrypoints through `process.execPath` instead of the .cmd shims.
 */
export function run(command, args, { cwd, timeoutMs = 300_000 } = {}) {
  return new Promise((resolve) => {
    const started = Date.now();
    const child = spawn(command, args, {
      cwd,
      env: { ...process.env, CI: 'true', FORCE_COLOR: '0' },
    });

    let output = '';
    const cap = (buf) => {
      if (output.length < 20_000) output += buf.toString();
    };
    child.stdout.on('data', cap);
    child.stderr.on('data', cap);

    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      output += `\n[killed after ${timeoutMs}ms]`;
    }, timeoutMs);

    child.on('error', (err) => {
      clearTimeout(timer);
      resolve({ exitCode: -1, output: `${output}\n${err.message}`, ms: Date.now() - started });
    });
    child.on('close', (exitCode) => {
      clearTimeout(timer);
      resolve({ exitCode: exitCode ?? -1, output: output.trim(), ms: Date.now() - started });
    });
  });
}

/**
 * Run a VERIFICATION step — hermetically in a container when one is available, on this host when it
 * is not, and honest about which of the two actually happened.
 *
 * Separate from `run()` on purpose. `run()` is also used for git plumbing and for driving the
 * runtime itself; routing those through a container would be circular. This is the entry point for
 * the steps that execute the *target project's* code — tests, builds, lint, coverage — which are
 * precisely the ones that can have side effects on the operator's machine.
 *
 * The import is dynamic so `container.js` (which shells out to probe for a daemon) is only loaded
 * when a verification step actually runs, not on every module that touches the worktree.
 */
export async function runVerified(spec) {
  const { runVerification } = await import('./container.js');
  return runVerification(spec, run);
}
