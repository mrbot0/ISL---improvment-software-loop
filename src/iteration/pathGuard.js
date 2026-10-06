import fs from 'node:fs';
import path from 'node:path';
import { REPO_FACTS, REPO_ROOT, PRODUCT_DIRS } from '../config.js';

/**
 * Path reality check.
 *
 * The planner, left to its own training prior, plans against an architecture that
 * isn't here: TypeScript files, a `services/inventory` microservice, `frontend/src`,
 * `prisma/schema.prisma`. Every one of those tasks reaches an implementer that reads
 * the named file, finds nothing, and gives up — a failure with no useful explanation.
 *
 * This module does two things before a task ever runs:
 *   1. REPAIR the paths it can (wrong root, wrong extension) into the real ones.
 *   2. JUDGE what's left — does the file exist? is its directory even real? — so a
 *      task that is doomed can be reported with a concrete reason instead of a shrug.
 */

/**
 * Known root remaps from layouts the model imagines to the one that exists.
 * These are FUNCTIONS, not module-level consts, because REPO_FACTS / PRODUCT_DIRS
 * are live bindings that are empty until a project is activated — capturing them
 * at import would leave the guard with no real roots and reject every path.
 */
function rootRemap() {
  return [
    [/^frontend\/src\//, `${REPO_FACTS.frontendDir || 'frontend/app'}/`],
    [/^src\/(?=hooks|components|pages|store|lib|app)/, `${REPO_FACTS.frontendDir || 'frontend/app'}/`],
    [/^(?:backend\/)?prisma\//, REPO_FACTS.prismaSchema ? `${path.dirname(REPO_FACTS.prismaSchema)}/` : 'backend/prisma_new/'],
  ];
}

const exists = (rel) => {
  try {
    return fs.existsSync(path.join(REPO_ROOT, rel));
  } catch {
    return false;
  }
};

/** The real top-level roots / service names — read live, per active project. */
const realRoots = () => new Set(PRODUCT_DIRS);
const realServiceNames = () => new Set(REPO_FACTS.services);

/** Normalise a single declared path: fix separators, remap roots, fix extension. */
export function repairPath(raw) {
  let p = String(raw).replace(/\\/g, '/').replace(/^\.?\//, '').trim();
  const notes = [];

  for (const [re, to] of rootRemap()) {
    if (re.test(p)) {
      const before = p;
      p = p.replace(re, to);
      notes.push(`remapped ${before} → ${p}`);
      break;
    }
  }

  // The project is JavaScript. A .ts/.tsx path is a hallucination — rewrite the
  // extension so at least it lands in the right language, IF a sibling .js exists;
  // otherwise flag it (a brand-new .ts file has no place here).
  if (REPO_FACTS.language === 'javascript' && /\.tsx?$/.test(p)) {
    const asJs = p.replace(/\.tsx$/, '.jsx').replace(/\.ts$/, '.js');
    notes.push(`this is a JavaScript project — ${p} → ${asJs}`);
    p = asJs;
  }

  return { path: p, notes };
}

/**
 * Judge a repaired path against the real tree.
 * @returns {{path, ok, reason?, isNew?}}
 */
function judge(p, { kind }) {
  const top = p.split('/')[0];
  const services = realServiceNames();
  const roots = realRoots();

  // The Prisma schema is a real file but deliberately out of scope: changing it
  // implies a migration, and the agents are forbidden from touching migrations. Say
  // so precisely rather than pretending the path is unreal.
  if (/schema\.prisma$/.test(p) || /(^|\/)(prisma|migrations)\//.test(p)) {
    return {
      path: p,
      ok: false,
      reason: 'the Prisma schema / migrations are out of scope — a schema change needs a migration, which the agents are not allowed to make',
    };
  }

  // A services/<name>/… path that names a service which doesn't exist.
  if (top === 'services') {
    const svc = p.split('/')[1];
    if (svc && services.size && !services.has(svc)) {
      return {
        path: p,
        ok: false,
        reason: `names a service "${svc}" that does not exist — the real services are: ${REPO_FACTS.services.join(', ')}`,
      };
    }
  }

  // Not under any real product root at all.
  const underRealRoot = [...roots].some((r) => p === r || p.startsWith(`${r}/`)) || p.startsWith('docker') || p.endsWith('.yml');
  if (!underRealRoot) {
    return {
      path: p,
      ok: false,
      reason: `is not under any real source directory (${[...roots].join(', ')})`,
    };
  }

  if (exists(p)) return { path: p, ok: true, isNew: false };

  // Doesn't exist. For an improvement task that's fatal (you can't refactor a file
  // that isn't there). For a feature it may be a legitimately new file — but only if
  // its parent directory is real.
  const parent = path.dirname(p);
  const parentReal = exists(parent);
  if (kind === 'improvement') {
    return { path: p, ok: false, reason: `target file does not exist (cannot improve what isn't there)` };
  }
  /*
   * A new file may create ONE new directory, provided its grandparent is real.
   *
   * Requiring the parent to already exist refused the most ordinary thing in the codebase: adding
   * `backend/server/middleware/__tests__/auth.test.js` next to the middleware it tests, or
   * `services/x/src/lib/` for a new module. Every `__tests__` directory in this repository had to be
   * created by someone, once.
   *
   * One level, not two. `backend/server/src/routes/bookings.js` invents `src/` AND `routes/` under a
   * root whose real layout is `backend/server/routes/` — that is not a new directory, it is a wrong
   * guess about the project's shape, and it stays refused.
   */
  if (!parentReal && exists(path.dirname(parent))) {
    return { path: p, ok: true, isNew: true, newDir: parent };
  }
  if (!parentReal) {
    return { path: p, ok: false, reason: `new file's directory "${parent}" does not exist, and neither does its parent "${path.dirname(parent)}" — check the real layout before inventing a path` };
  }
  return { path: p, ok: true, isNew: true };
}

/**
 * Repair + judge every file a task declares.
 *
 * @returns {{ files, newFiles, existingFiles, problems, viable, reason }}
 *   `viable` is false when the task cannot be done as planned; `reason` says why in
 *   plain language, ready to store on the task and show in the UI.
 */
export function vetTaskPaths(task) {
  const raw = Array.isArray(task.files) ? task.files : [];
  if (!raw.length) {
    return { files: [], newFiles: [], existingFiles: [], problems: [], viable: true, reason: null };
  }

  const files = [];
  const problems = [];
  const newFiles = [];
  const existingFiles = [];

  for (const r of raw) {
    const { path: repaired, notes } = repairPath(r);
    const verdict = judge(repaired, { kind: task.kind });
    files.push(verdict.path);
    if (!verdict.ok) {
      problems.push(`${r} — ${verdict.reason}`);
    } else {
      if (verdict.isNew) newFiles.push(verdict.path);
      else existingFiles.push(verdict.path);
      if (notes.length) problems.push(`${r} — ${notes.join('; ')} (repaired, ok)`);
    }
  }

  // A task is viable if at least one declared file is real or a plausible new file.
  const usable = newFiles.length + existingFiles.length;
  const viable = usable > 0;

  const hard = problems.filter((p) => !p.includes('(repaired, ok)'));
  const reason = viable
    ? null
    : hard.length
      ? `The planner targeted files that don't fit this repository: ${hard.join(' · ')}.`
      : 'No usable target file.';

  return {
    files: [...new Set([...existingFiles, ...newFiles])],
    newFiles,
    existingFiles,
    problems,
    viable,
    reason,
  };
}

/** A compact repo-facts brief for the planner prompt. */
export function repoFactsBrief() {
  const f = REPO_FACTS;
  return [
    `REPOSITORY FACTS (this is the ground truth — do NOT plan against anything else):`,
    `- Language: ${f.language.toUpperCase()}. File extensions are ${f.extensions.join(' / ')}. There are NO ${f.language === 'javascript' ? 'TypeScript (.ts/.tsx)' : 'plain JS'} files — never name one.`,
    `- Backend lives in: ${f.backendDirs.join(', ')} (Express routes under routes/, helpers under lib/, middleware under middleware/).`,
    `- Frontend lives in: ${f.frontendDir || '(none)'} — React .jsx. There is no "frontend/src".`,
    f.services.length
      ? `- Microservices (services/<name>/src/*.js, each a flat src/ with server.js/db.js — NO nested services/ subfolder): ${f.services.join(', ')}. There is no "inventory" service; do not invent one.`
      : `- There are no microservices.`,
    f.prismaSchema ? `- Prisma schema: ${f.prismaSchema} (NOT "prisma/schema.prisma" or "backend/prisma").` : ``,
    `Every file you name in a task MUST use these real paths. A task that targets a path that doesn't exist is a wasted iteration.`,
  ]
    .filter(Boolean)
    .join('\n');
}
