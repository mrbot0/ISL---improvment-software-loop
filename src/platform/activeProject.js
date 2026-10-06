import { resolveProjectConfig, setActiveProjectConfig, projectDbPath } from '../config.js';
import { openProjectDb, db } from '../db.js';
import { seedAgents } from '../agents/registry.js';
import { resetBacklog } from '../db_iteration.js';
import { clearAllContext, getContext, setContext } from '../context/contextDb.js';
import { getProject, listProjects, ensureDefaultProject, markContextReady } from './projects.js';
import { getPlatformSetting, setPlatformSetting, audit } from './platformDb.js';
import { invalidateBlastGraph } from '../iteration/blastRadius.js';
import { invalidateCoverage } from '../iteration/coverageRun.js';
import { invalidateEgressTripwire } from '../core/egress.js';
import { emit } from '../bus.js';
import { log } from '../logger.js';

/**
 * The active-project switch. This is the one place that changes what "the code"
 * means for the whole runtime:
 *
 *   1. resolve the project's layout facts (repo root, base branch, product dirs)
 *   2. apply them to config's live bindings
 *   3. point the swappable DB handle at that project's own SQLite file
 *   4. seed the improvement agents into that DB
 *
 * The caller (server) is responsible for pausing the control loop before a
 * switch and re-priming the managers after, since those are process singletons.
 */

let _active = null;

const publicConfig = (r) => ({
  id: r.id,
  repoRoot: r.repoRoot,
  baseBranch: r.baseBranch,
  workBranch: r.workBranch,
  productDirs: r.productDirs,
  language: r.repoFacts.language,
  services: r.repoFacts.services,
});

export function activateProject(id) {
  const project = getProject(id);
  if (!project) throw new Error(`Unknown project: ${id}`);

  const resolved = resolveProjectConfig({
    id: project.id,
    codePath: project.codePath,
    baseBranch: project.baseBranch || undefined,
  });
  setActiveProjectConfig(resolved);
  openProjectDb(projectDbPath(project.id));

  // Process-wide caches keyed to "the code" must die with the switch. Both are memoised in module
  // scope, so without this the new project would be served the previous one's import graph and
  // coverage numbers until something else happened to invalidate them.
  invalidateBlastGraph();
  invalidateCoverage();
  // The tripwire fingerprints the PREVIOUS project's secret files; keeping them would both miss the
  // new project's secrets and deny calls over a file that is no longer in scope.
  invalidateEgressTripwire();

  const seed = seedAgents();

  // If the project's source folder changed since it was last analysed, the whole
  // analysis is stale: wipe the backlog and every derived context so the next
  // build starts from scratch against the new code.
  let sourceChanged = false;
  const prevPath = getContext('analyzedPath', null);
  if (prevPath && prevPath !== resolved.repoRoot) {
    const removed = resetBacklog({ keepOperator: false });
    try {
      db.exec('DELETE FROM functions'); // the code hotspot catalog is stale too
    } catch {
      /* table may not exist yet */
    }
    clearAllContext();
    markContextReady(project.id, false);
    sourceChanged = true;
    log.warn('project', `source folder changed for ${project.id} — reset backlog (${removed}) and cleared context`);
    emit('project.source_changed', { projectId: project.id, from: prevPath, to: resolved.repoRoot });
  }
  setContext('analyzedPath', resolved.repoRoot);

  _active = { project, config: publicConfig(resolved), seed, sourceChanged };
  setPlatformSetting('activeProjectId', project.id);
  emit('project.activated', { projectId: project.id, name: project.name, repoRoot: resolved.repoRoot });
  audit('project.activated', { target: project.id, detail: { seeded: seed.seeded } });
  return _active;
}

export function getActiveProject() {
  return _active;
}

/** On boot: make sure a project exists and activate the last-used one. */
export function bootActiveProject() {
  ensureDefaultProject();
  const saved = getPlatformSetting('activeProjectId');
  const target = saved && getProject(saved) ? saved : listProjects()[0]?.id;
  if (!target) throw new Error('No project available to activate');
  return activateProject(target);
}
