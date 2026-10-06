import http from 'node:http';
import path from 'node:path';
import fs from 'node:fs';
import cors from 'cors';
import express from 'express';
import { WebSocketServer } from 'ws';

import { AGENTS_ROOT, REPO_ROOT, autonomy, iteration as iterationCfg, server as serverCfg } from './config.js';
import { bus, emit } from './bus.js';
import {
  clearMessages,
  computeMetrics,
  countPlansByCriticality,
  getAgent,
  listPlans,
  getAllManagerBriefs,
  getProposal,
  listAgents,
  listEvents,
  listLogs,
  listManagerMessages,
  listMessages,
  listProposals,
  listRuns,
  reapStaleRuns,
  trimLogs,
  trimEvents,
  updateAgent,
  db,
} from './db.js';
import {
  countFeaturesByStatus,
  countFunctionsByStatus,
  addFeature,
  countUnreadNotifications,
  deleteFeature,
  getIteration,
  getKpi,
  listFeatures,
  setFeaturePriority,
  setFeatureStatus,
  listIterations,
  listNotifications,
  listPhases,
  listRestartable,
  listProblemRuns,
  countProblemRuns,
  dismissRun,
  dismissAllProblemRuns,
  listTasks,
  markNotificationsRead,
  reapStaleIterations,
  resetBacklog,
  backlogClaims,
  releaseStuckClaims,
  setKpi,
  topFunctions,
} from './db_iteration.js';
import { fileDiff, listTree, readFile, status as fileStatus, writeFile } from './files.js';
import { seedAgents } from './agents/registry.js';
import { orchestrator } from './orchestrator.js';
import { controller } from './core/controller.js';
import { startImprovementWindows } from './core/improvementWindows.js';
import { applyModelConfig, detectModels } from './core/models.js';
import { wireWebhooks } from './core/governance.js';
import { inventoryServices } from './services/inventory.js';
import { survey } from './iteration/surveyor.js';
import { baselineStatus, deployStatus, promoteToMain } from './iteration/promote.js';
import { checkBakeWindows } from './deploy/dora.js';
import { isolationStatus } from './sandbox/container.js';
import { runtimeController } from './runtime/controller.js';
import { checkSchemaIntegrity, findSchemaFiles, parsePrismaModels } from './runtime/schemaAgent.js';
import { restartService, rebuildService, serviceLogs, startService, stopService } from './runtime/compose.js';
import { startManagers } from './managers/index.js';
import { log } from './logger.js';
import { requireAdmin } from './platform/authMiddleware.js';
import { SHUTDOWN_EXIT_CODE } from './core/shutdownCode.js';
import { approveProposal, applyProposal, rejectProposal } from './apply.js';
import { verifyProposal } from './sandbox/verifier.js';
import { handleChatTurn } from './chat.js';
import { health } from './ollama.js';
import { currentBranch, headCommit, isDirty } from './sandbox/worktree.js';
import { seedAdmin, reapSessions } from './platform/users.js';
import { bootActiveProject, getActiveProject } from './platform/activeProject.js';
import { mountPlatformRoutes } from './platform/routes.js';
import { mountFeatureRoutes } from './platform/featureRoutes.js';
import { attachUser, userFromCookieHeader } from './platform/authMiddleware.js';
import { getUserPrefs, setUserPrefs, PREF_KEYS } from './platform/platformDb.js';
import { getCodeStats } from './context/codeScan.js';
import { seedBestPractices } from './bestpractices/bestPracticesDb.js';

const app = express();
app.use(cors());
app.use(express.json({ limit: '4mb' }));
app.use(attachUser);

// Everything under /api requires a session, except the auth handshake and the
// health probe. The platform routes (login, projects, admin) are mounted right
// after so the login endpoint is reachable while unauthenticated.
const PUBLIC_API = new Set(['/api/auth/login', '/api/auth/logout', '/api/auth/me', '/api/health']);
app.use((req, res, next) => {
  if (!req.path.startsWith('/api/')) return next();
  if (PUBLIC_API.has(req.path)) return next();
  if (!req.user) return res.status(401).json({ error: 'Not authenticated' });
  next();
});

// Managers are created at boot (below); this holder lets the project-switch route
// re-prime them without a forward reference.
let managersRef = null;
const reanalyzeManagers = () => managersRef?.all.forEach((m) => m.analyze?.());
mountPlatformRoutes(app, { controller, reanalyzeManagers });
mountFeatureRoutes(app, { reanalyzeManagers });

/**
 * `repo` is read on every /api/state and /api/health, and each field is a synchronous
 * `git` spawn. On the socket-driven refetch path that is three process spawns several
 * times a second — pure event-loop tax for data that changes only when you commit.
 * Cache it briefly; the dashboard never needs it fresher than this.
 */
let repoCache = { at: 0, value: null };
const repoInfo = () => {
  const now = Date.now();
  if (now - repoCache.at < 3000 && repoCache.value) return repoCache.value;
  repoCache = {
    at: now,
    value: { branch: currentBranch(), head: headCommit().slice(0, 8), dirty: isDirty() },
  };
  return repoCache.value;
};

const ok = (res, data) => res.json(data);
const wrap = (fn) => (req, res) => {
  // new Promise so a synchronous throw inside fn is caught too, not just rejections.
  new Promise((resolve) => resolve(fn(req, res))).catch((err) => {
    res.status(err.status ?? 400).json({ error: err.message });
  });
};

/* --------------------------------- state ---------------------------------- */

app.get('/api/health', wrap(async (_req, res) => {
  ok(res, {
    ok: true,
    ollama: await health(),
    repo: { root: REPO_ROOT, ...repoInfo() },
    // Which code are the agents actually improving? Never leave this implicit again.
    baseline: baselineStatus(),
    control: controller.state(),
    // Whether verification actually runs in a sandbox that cannot touch this machine. Surfaced on
    // health rather than buried in a run record, because an operator deciding how far to trust the
    // fleet needs to know this BEFORE the run, not after it.
    isolation: isolationStatus(),
  });
}));

app.get('/api/state', wrap(async (_req, res) => {
  ok(res, {
    // One control plane. `orchestrator` is kept as an alias so nothing that still
    // reads the old shape breaks mid-upgrade; it is the same single loop.
    control: controller.state(),
    orchestrator: controller.state(),
    agents: listAgents(),
    proposals: listProposals({ limit: 40 }),
    runs: listRuns(20),
    // events and logs stream live over the WebSocket and the client accumulates them,
    // so /api/state only needs a modest seed for a cold load — not the whole tail on
    // every refetch. This is the single biggest slice of a payload that was fetched
    // several times a second during an iteration.
    events: listEvents(60),
    metrics: computeMetrics(),
    managers: { briefs: getAllManagerBriefs(), messages: listManagerMessages(30) },
    plans: { list: listPlans(20), byCriticality: countPlansByCriticality() },
    logs: listLogs({ limit: 60 }),
    iteration: {
      controller: controller.state(),
      recent: listIterations(15),
      restartable: listRestartable(10),
      backlog: { functions: countFunctionsByStatus(), features: countFeaturesByStatus() },
      kpi: getKpi(),
    },
    notifications: { list: listNotifications(30), unread: countUnreadNotifications() },
    deploy: deployStatus(),
    baseline: baselineStatus(),
    repo: repoInfo(),
    codeStats: (() => {
      try {
        return getCodeStats();
      } catch {
        return null;
      }
    })(),
  });
}));

/* ----------------------------- control plane ------------------------------ */
// The single loop. These replace the old /api/orchestrator/* and /api/iteration/*
// pairs, which each drove a separate engine.

app.get('/api/control', wrap((_req, res) => ok(res, controller.state())));
app.post('/api/control/start', wrap((_req, res) => ok(res, controller.start())));
app.post('/api/control/stop', wrap((_req, res) => ok(res, controller.stop())));
app.post('/api/control/cancel', wrap((_req, res) => ok(res, controller.cancel())));
app.post('/api/control/restart-loop', wrap((_req, res) => ok(res, controller.restartLoop())));

/**
 * ARRESTO COMPLETO — ferma il loop, chiude il server e impedisce al supervisore di riavviarlo.
 *
 * Riservato agli amministratori: non è una pausa, è lo spegnimento del prodotto, e da qui in poi
 * l'unico modo per riaccenderlo è un terminale sulla macchina che lo ospita.
 *
 * L'ordine dei passi è la parte che conta:
 *
 * 1. `stop()` con persistenza — scrive `loopDesired = false`. Va fatto PRIMA di uscire, altrimenti
 *    al prossimo avvio il loop si riarma da solo e l'operatore che aveva chiesto di fermare tutto
 *    ritrova le iterazioni in corso. È lo stesso motivo per cui il riavvio del supervisore
 *    riprendeva le run: l'intento è persistito apposta.
 * 2. `cancel()` — interrompe l'iterazione in volo al prossimo confine di fase. Il lavoro già
 *    prodotto resta nel checkpoint, quindi non si perde nulla.
 * 3. la risposta HTTP, INTERA, prima di qualsiasi uscita: se il processo muore mentre la risposta
 *    è a metà, la dashboard vede una connessione caduta e non sa se l'arresto è avvenuto.
 * 4. l'uscita, dopo un istante, con il codice concordato con il supervisore.
 */
app.post('/api/control/shutdown', requireAdmin, wrap((_req, res) => {
  const state = controller.stop();
  const cancelled = controller.cancel();
  log.warn('control', 'arresto completo richiesto — il supervisore non riavviera il server');
  ok(res, {
    stopping: true,
    loopWasRunning: !!state?.looping,
    cancelledIteration: cancelled?.cancelled ?? false,
    exitCode: SHUTDOWN_EXIT_CODE,
    note: 'Il loop resta fermo anche al prossimo avvio. Per riaccendere: node supervisor.mjs',
  });
  // Un attimo perche' la risposta lasci il socket e il log venga scritto, poi si chiude.
  setTimeout(() => process.exit(SHUTDOWN_EXIT_CODE), 250);
}));

app.post('/api/control/run', wrap((_req, res) => {
  if (controller.state().running) return ok(res, { busy: true });
  controller.runOnce('manual'); // fire-and-forget; the socket streams the phases
  ok(res, { started: true });
}));

/**
 * Restart a failed run from the changes it already produced. The engine decides
 * where to resume based on WHY it failed — an interruption continues from where it
 * stopped, an implementation error goes back to the implementer with the defect.
 */
app.post('/api/control/restart/:id', wrap((req, res) => {
  if (controller.state().running) return ok(res, { busy: true });
  const id = Number(req.params.id);
  const prev = getIteration(id);
  if (!prev) return res.status(404).json({ error: `iteration #${id} not found` });
  if (!prev.failure) return res.status(400).json({ error: `iteration #${id} did not fail — nothing to restart` });
  controller.restart(id);
  ok(res, { restarting: id, from: prev.failure.resumeFrom, because: prev.failure.title });
}));

app.get('/api/control/restartable', wrap((_req, res) => ok(res, listRestartable(20))));

/* --------------------------- runs board (failed) --------------------------- */
// Every run that ended in error / interrupted / empty / rolled_back and hasn't been
// cleared — the operator's board for triaging and restarting failed work.
app.get('/api/runs/problems', wrap((req, res) => {
  const status = ['error', 'interrupted', 'empty', 'rolled_back'].includes(req.query.status) ? req.query.status : null;
  ok(res, { runs: listProblemRuns({ status, limit: 80 }), count: countProblemRuns(), busy: controller.state().running });
}));

// Restart many at once (all restartable problem runs, or a supplied list of ids).
app.post('/api/runs/restart-all', wrap((req, res) => {
  const ids = Array.isArray(req.body?.ids) && req.body.ids.length
    ? req.body.ids.map(Number).filter(Boolean)
    : listProblemRuns({ limit: 80 }).filter((r) => r.failure).map((r) => r.id);
  ok(res, controller.restartMany(ids));
}));

// Clear a run (or all) from the board — stays in history, just hidden here.
app.post('/api/runs/:id/dismiss', wrap((req, res) => ok(res, { dismissed: dismissRun(Number(req.params.id)) })));
app.post('/api/runs/dismiss-all', wrap((_req, res) => ok(res, { dismissed: dismissAllProblemRuns() })));

app.post('/api/control/config', wrap((req, res) => {
  const { intervalSeconds, parallelism, improvements, features } = req.body || {};
  if (intervalSeconds !== undefined) controller.setInterval(intervalSeconds);
  if (parallelism !== undefined) controller.setParallelism(parallelism);
  if (improvements !== undefined || features !== undefined) controller.setBatch({ improvements, features });
  ok(res, controller.state());
}));

/* -------------------------------- services -------------------------------- */

app.get('/api/services', wrap((_req, res) => ok(res, inventoryServices())));

/* -------------------------- backlog analysis ------------------------------ */

/**
 * Wipe the pending backlog and (optionally) rebuild it from a fresh survey of the
 * real code. This is the escape hatch when the backlog is full of fantasies from an
 * older, wrong model of the repo.
 */
app.post('/api/backlog/reset', wrap(async (req, res) => {
  const { source, resurvey = true, release = true } = req.body || {};
  /*
   * Release BEFORE deleting. `resetBacklog` only removes `pending` rows, so on a database where
   * most of the backlog is stuck in `in_progress` this endpoint deleted a handful of items, ran a
   * survey, and reported success while the planner's actual choices stayed just as starved — a
   * reset button that did almost nothing, which is worse than not having one.
   */
  const claims = release ? releaseStuckClaims({ force: !!(req.body || {}).force }) : { released: 0, refused: null };
  if (claims.refused) return res.status(409).json({ error: `Cannot reset while ${claims.refused}. Stop the loop first.` });
  const removed = resetBacklog({ source: source || null });
  let surveyed = null;
  if (resurvey) surveyed = await survey({}).catch((e) => ({ error: e.message }));
  emit('config.changed', { note: `backlog reset — ${claims.released} released, ${removed} removed` });
  return ok(res, { removed, released: claims.released, surveyed });
}));

/**
 * What state is the backlog actually in? Answers the question an operator asks after a run of bad
 * iterations — "is it proposing nonsense, or has it run out of things to propose?" — with the two
 * numbers that distinguish them: what is claimed but abandoned, and what is still selectable.
 */
app.get('/api/backlog/claims', wrap((_req, res) => {
  const claims = backlogClaims();
  ok(res, {
    ...claims,
    selectable: { features: countFeaturesByStatus().pending, functions: countFunctionsByStatus().pending },
  });
}));

/**
 * Hand abandoned claims back to the pool. This is the non-destructive repair: nothing is deleted,
 * work that an interrupted run had reserved simply becomes pickable again.
 */
app.post('/api/backlog/reclaim', wrap((req, res) => {
  const r = releaseStuckClaims({ force: !!(req.body || {}).force });
  if (r.refused) return res.status(409).json({ error: `Cannot release claims while ${r.refused}. Stop the loop first.` });
  emit('config.changed', { note: `backlog: ${r.released} abandoned claim(s) released` });
  return ok(res, r);
}));

/** Run a codebase survey now (grounded backlog refresh), without touching what's there. */
app.post('/api/backlog/survey', wrap(async (_req, res) => ok(res, await survey({}))));

app.get('/api/events', wrap((req, res) => ok(res, listEvents(Number(req.query.limit) || 200))));
app.get('/api/runs', wrap((req, res) => ok(res, listRuns(Number(req.query.limit) || 50))));
app.get('/api/plans', wrap((req, res) => ok(res, { list: listPlans(Number(req.query.limit) || 50), byCriticality: countPlansByCriticality() })));

/* ------------------------------- metrics ---------------------------------- */

app.get('/api/metrics', wrap((_req, res) => ok(res, computeMetrics())));

/* ------------------------------- managers --------------------------------- */

app.get('/api/managers', wrap((_req, res) =>
  ok(res, { briefs: getAllManagerBriefs(), messages: listManagerMessages(60) }),
));

/* ------------------------- iteration engine ------------------------------- */

app.get('/api/iterations', wrap((req, res) => ok(res, listIterations(Number(req.query.limit) || 40))));

app.get('/api/iterations/:id', wrap((req, res) => {
  const it = getIteration(Number(req.params.id), { withDiff: true });
  if (!it) throw Object.assign(new Error('Not found'), { status: 404 });
  ok(res, { ...it, phases: listPhases(it.id), tasks: listTasks(it.id) });
}));

// Legacy iteration routes now drive the one unified loop.
app.post('/api/iterations/run', wrap(async (_req, res) => {
  if (controller.state().running) return ok(res, { busy: true });
  controller.runOnce('manual'); // fire-and-forget; watch via the socket
  ok(res, { started: true });
}));

app.post('/api/iteration/loop/start', wrap((_req, res) => ok(res, controller.start())));
app.post('/api/iteration/loop/stop', wrap((_req, res) => ok(res, controller.stop())));
app.post('/api/iteration/loop/cancel', wrap((_req, res) => ok(res, controller.cancel())));
app.post('/api/iteration/loop/settings', wrap((req, res) => {
  if (req.body?.intervalSeconds !== undefined) controller.setInterval(req.body.intervalSeconds);
  ok(res, controller.state());
}));

/* -------------------------- runtime / docker ------------------------------ */

app.get('/api/runtime', wrap(async (_req, res) => ok(res, await runtimeController.observe())));
app.post('/api/runtime/target', wrap((req, res) => ok(res, runtimeController.setTarget(req.body?.target))));
app.post('/api/runtime/up', wrap(async (_req, res) => { runtimeController.up(); ok(res, { started: true }); }));
app.post('/api/runtime/down', wrap(async (_req, res) => ok(res, await runtimeController.down())));
app.post('/api/runtime/restart', wrap(async (_req, res) => { runtimeController.restart(); ok(res, { restarting: true }); }));
app.post('/api/runtime/heal', wrap(async (_req, res) => { runtimeController.heal('manual trigger'); ok(res, { healing: true }); }));
app.post('/api/runtime/autoheal', wrap((req, res) => ok(res, runtimeController.setAutoHeal(!!req.body?.on))));

// Which docker-compose file to run — chosen from those found in the project, or
// picked by browsing the folders.
/* ------------------------- runtime: the Prisma schema ---------------------- */

/**
 * The schemas as they are on disk, parsed. READ-ONLY, and it stays that way: nothing under
 * /api/runtime may write a `.prisma` file or issue DDL. The database is the one thing in this
 * system with no undo, and a control plane that can edit the schema it displays is one bad agent
 * away from an unrecoverable mistake.
 */
app.get('/api/runtime/schema', wrap((_req, res) => {
  const files = findSchemaFiles().map((abs) => {
    const src = fs.readFileSync(abs, 'utf8');
    return {
      path: path.relative(REPO_ROOT, abs).replace(/\\/g, '/'),
      bytes: src.length,
      models: parsePrismaModels(src),
      source: src.length <= 120_000 ? src : `${src.slice(0, 120_000)}\n… (truncated)`,
    };
  });
  ok(res, { files, models: files.reduce((n, f) => n + f.models.length, 0) });
}));

/** Run the integrity agent on demand — the same check that runs after every commit. */
app.get('/api/runtime/schema/integrity', wrap(async (_req, res) => ok(res, await checkSchemaIntegrity())));

/* --------------------- runtime: one container at a time -------------------- */

/**
 * `stop` halts a container and leaves it, its volumes and its network alone; `start` brings the
 * same instance back. Neither can reach the `-v` flag that would delete the database volume —
 * `compose.js` refuses any command carrying it rather than relying on callers to remember.
 */
const SERVICE_ACTIONS = { stop: stopService, start: startService, restart: restartService, rebuild: rebuildService };

app.post('/api/runtime/service/:name/:action', wrap(async (req, res) => {
  const fn = SERVICE_ACTIONS[req.params.action];
  if (!fn) return res.status(400).json({ error: `unknown action "${req.params.action}"` });
  const target = runtimeController.status().target;
  const r = await fn(target, req.params.name);
  emit('runtime.service', { service: req.params.name, action: req.params.action, ok: r.ok });
  return ok(res, { ok: r.ok, output: r.output?.slice(-4000) || '', exitCode: r.exitCode });
}));

app.get('/api/runtime/service/:name/logs', wrap(async (req, res) => {
  const target = runtimeController.status().target;
  const r = await serviceLogs(target, req.params.name, Math.min(1000, Number(req.query.lines) || 200));
  ok(res, { ok: r.ok, output: r.output || '' });
}));

app.get('/api/runtime/compose-files', wrap((_req, res) => ok(res, runtimeController.listComposeFiles())));
app.post('/api/runtime/compose', wrap((req, res) => {
  const file = req.body?.file;
  if (!file || typeof file !== 'string') throw new Error('file is required');
  ok(res, runtimeController.setComposeFile(file));
}));
app.get('/api/runtime/browse', wrap((req, res) => ok(res, runtimeController.browse(req.query.dir || ''))));

/* ------------------------- file explorer / editor ------------------------- */

app.get('/api/files/tree', wrap((req, res) => ok(res, listTree(req.query.path || '', req.query.ref || 'main'))));
app.get('/api/files/read', wrap((req, res) => {
  if (!req.query.path) throw new Error('path is required');
  ok(res, readFile(req.query.path, req.query.ref || 'main'));
}));
app.post('/api/files/write', wrap((req, res) => {
  const { path: p, content } = req.body ?? {};
  if (!p) throw new Error('path is required');
  ok(res, writeFile(p, content ?? ''));
}));
app.get('/api/files/status', wrap((_req, res) => ok(res, fileStatus())));
app.get('/api/files/diff', wrap((req, res) => {
  if (!req.query.path) throw new Error('path is required');
  ok(res, fileDiff(req.query.path));
}));

/* --------------------------- deploy / promote ----------------------------- */

app.get('/api/deploy', wrap((_req, res) => ok(res, deployStatus())));
// `stash: true` sets the operator's overlapping edits aside for the fast-forward and restores them
// afterwards — the manual "commit or stash first" chore, done by the product. Opt-in: it touches the
// working tree, so it happens only when asked for explicitly.
app.post('/api/deploy/promote', wrap((req, res) => ok(res, promoteToMain(req.body?.upTo || null, { stash: !!req.body?.stash }))));

/* -------------------------------- backlog --------------------------------- */

app.get('/api/backlog', wrap((_req, res) =>
  ok(res, {
    functions: { counts: countFunctionsByStatus(), top: topFunctions(30) },
    features: { counts: countFeaturesByStatus(), pending: listFeatures({ status: 'pending', limit: 60 }), all: listFeatures({ limit: 120 }) },
  }),
));

// Operator-authored backlog items + triage.
app.post('/api/backlog/features', wrap((req, res) => {
  const { title, description, area, priority } = req.body ?? {};
  if (!title?.trim()) throw new Error('title is required');
  const id = addFeature({ title: title.trim(), description, area, priority, source: 'operator' });
  emit('config.changed', { note: 'feature added to backlog' });
  ok(res, { id });
}));
app.patch('/api/backlog/features/:id', wrap((req, res) => {
  const id = Number(req.params.id);
  if (req.body?.status) setFeatureStatus(id, req.body.status);
  if (req.body?.priority !== undefined) setFeaturePriority(id, Number(req.body.priority));
  emit('config.changed', { note: 'feature updated' });
  ok(res, { ok: true });
}));
app.delete('/api/backlog/features/:id', wrap((req, res) => ok(res, { deleted: deleteFeature(Number(req.params.id)) })));

/* --------------------------------- report --------------------------------- */

// A self-contained JSON snapshot the operator can download / archive.
app.get('/api/report', wrap((_req, res) => {
  ok(res, {
    generatedAt: Date.now(),
    repo: { branch: currentBranch(), head: headCommit() },
    metrics: computeMetrics(),
    iterations: listIterations(50),
    backlog: { functions: countFunctionsByStatus(), features: countFeaturesByStatus() },
    deploy: deployStatus(),
    managers: getAllManagerBriefs(),
  });
}));

/* ---------------------------------- KPI ----------------------------------- */

app.get('/api/kpi', wrap((_req, res) => ok(res, getKpi())));
app.post('/api/kpi', wrap((req, res) => ok(res, setKpi(req.body ?? {}))));

/* ----------------------------- notifications ------------------------------ */

app.get('/api/notifications', wrap((_req, res) => ok(res, listNotifications(60))));
app.post('/api/notifications/read', wrap((_req, res) => ok(res, { marked: markNotificationsRead() })));

/* ---------------------------- user preferences ---------------------------- */

// Scoped to the authenticated user by the SESSION, never by a body parameter — a user id in the
// request would let anyone read or overwrite someone else's preferences.
app.get('/api/preferences', wrap((req, res) => ok(res, { prefs: getUserPrefs(req.user?.id), keys: PREF_KEYS })));
app.put('/api/preferences', wrap((req, res) => ok(res, { prefs: setUserPrefs(req.user?.id, req.body || {}) })));

/* --------------------------------- logs ----------------------------------- */

app.get('/api/logs', wrap((req, res) =>
  ok(res, listLogs({
    level: req.query.level,
    source: req.query.source,
    sinceId: Number(req.query.since) || 0,
    limit: Number(req.query.limit) || 300,
  })),
));

/* --------------------------------- agents --------------------------------- */

app.get('/api/agents', wrap((_req, res) => ok(res, listAgents())));

app.patch('/api/agents/:id', wrap((req, res) => {
  if (!getAgent(req.params.id)) throw Object.assign(new Error('Unknown agent'), { status: 404 });
  const agent = updateAgent(req.params.id, req.body ?? {});
  emit('config.changed', { agentId: agent.id, note: 'agent updated' });
  ok(res, agent);
}));

app.post('/api/agents/:id/run', wrap((req, res) => {
  const { instruction } = req.body ?? {};
  ok(res, orchestrator.enqueue(req.params.id, { trigger: 'manual', instruction: instruction || null }));
}));

/* --------------------------- orchestrator (legacy) ------------------------- */
// There is only one loop now. These aliases drive it, so an older client that still
// speaks the orchestrator dialect controls the same engine rather than a second one.

app.post('/api/orchestrator/start', wrap((_req, res) => ok(res, controller.start())));
app.post('/api/orchestrator/stop', wrap((_req, res) => ok(res, controller.stop())));
app.post('/api/orchestrator/cancel', wrap((_req, res) => ok(res, controller.cancel())));
app.post('/api/orchestrator/settings', wrap((req, res) => {
  const { intervalSeconds, maxPending, applyMode } = req.body ?? {};
  if (intervalSeconds !== undefined) controller.setInterval(intervalSeconds);
  if (maxPending !== undefined) orchestrator.setMaxPending(maxPending);
  if (applyMode !== undefined) orchestrator.setApplyMode(applyMode);
  ok(res, controller.state());
}));

/* -------------------------------- proposals -------------------------------- */

app.get('/api/proposals', wrap((req, res) => {
  const status = req.query.status ? String(req.query.status).split(',') : undefined;
  ok(res, listProposals({ status, agentId: req.query.agentId, limit: Number(req.query.limit) || 100 }));
}));

app.get('/api/proposals/:id', wrap((req, res) => {
  const p = getProposal(Number(req.params.id), { withFiles: true });
  if (!p) throw Object.assign(new Error('Not found'), { status: 404 });
  ok(res, p);
}));

app.post('/api/proposals/:id/approve', wrap((req, res) => {
  const { note, autoApply = true } = req.body ?? {};
  ok(res, approveProposal(Number(req.params.id), { note, autoApply }));
}));

app.post('/api/proposals/:id/reject', wrap((req, res) => {
  ok(res, rejectProposal(Number(req.params.id), req.body?.reason ?? ''));
}));

app.post('/api/proposals/:id/apply', wrap((req, res) => {
  ok(res, applyProposal(Number(req.params.id), { mode: req.body?.mode }));
}));

app.post('/api/proposals/:id/reverify', wrap(async (req, res) => {
  ok(res, await verifyProposal(Number(req.params.id)));
}));

/* ---------------------------------- chat ----------------------------------- */

app.get('/api/chat/messages', wrap((_req, res) => ok(res, listMessages(100))));
app.delete('/api/chat/messages', wrap((_req, res) => ok(res, { cleared: clearMessages() })));

/** Streams the assistant reply as NDJSON so the UI can render tokens as they land. */
app.post('/api/chat', wrap(async (req, res) => {
  const text = String(req.body?.message ?? '').trim();
  const images = Array.isArray(req.body?.images) ? req.body.images.slice(0, 4) : [];
  if (!text && !images.length) throw new Error('message is required');

  res.writeHead(200, {
    'content-type': 'application/x-ndjson; charset=utf-8',
    'cache-control': 'no-cache',
    connection: 'keep-alive',
  });
  const send = (obj) => res.write(JSON.stringify(obj) + '\n');
  const ac = new AbortController();
  // Abort the model call ONLY if the client actually disconnects before we have
  // finished responding. Listening on `req` 'close' was firing as soon as the
  // request body was consumed, which aborted the turn immediately (empty reply).
  res.on('close', () => {
    if (!res.writableEnded) ac.abort();
  });

  try {
    const result = await handleChatTurn(text, {
      images,
      signal: ac.signal,
      onToken: (t) => send({ type: 'token', text: t }),
      onTool: (t) => send({ type: 'tool', name: t.name, args: t.args }),
    });
    send({ type: 'done', content: result.content, tools: result.tools });
  } catch (err) {
    if (!ac.signal.aborted) send({ type: 'error', error: err.message });
  }
  res.end();
}));

/* ------------------------- static dashboard (prod) -------------------------- */

const dashboardDist = path.join(AGENTS_ROOT, 'dashboard', 'dist');
if (fs.existsSync(dashboardDist)) {
  app.use(express.static(dashboardDist));
  app.get(/^(?!\/api\/).*/, (_req, res) => res.sendFile(path.join(dashboardDist, 'index.html')));
}

/* --------------------------------- server ---------------------------------- */

const httpServer = http.createServer(app);
const wss = new WebSocketServer({ server: httpServer, path: '/ws' });

wss.on('connection', (ws, req) => {
  // Gate the live socket behind the same session cookie the REST API uses.
  const user = userFromCookieHeader(req.headers?.cookie);
  if (!user) {
    try {
      ws.close(4401, 'Not authenticated');
    } catch {
      /* already closing */
    }
    return;
  }
  // Keepalive uses a missed-pong COUNTER, not a boolean. A single missed round
  // during a heavy iteration (Ollama pinning the CPU delays the event loop) used
  // to terminate a perfectly-alive client after ~60s and flap "connection lost".
  // Now a client is only dropped after several missed rounds (~2 min).
  ws.missed = 0;
  ws.on('pong', () => {
    ws.missed = 0;
  });
  ws.send(JSON.stringify({ type: 'hello', ts: Date.now(), state: controller.state() }));
  const onEvent = (event) => {
    if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(event));
  };
  bus.on('event', onEvent);
  ws.on('close', () => bus.off('event', onEvent));
});

// Protocol-level keepalive. A browser WebSocket has no idle timeout of its own, so a
// connection that was silently severed (a laptop that slept, an iteration that pinned
// the event loop long enough for the OS to give up on the socket) would otherwise sit
// there looking alive on the server while the dashboard shows "connection lost". Ping
// every 30s; a client that misses two rounds is reaped so its slot is freed and the
// client's own reconnect loop takes over cleanly.
setInterval(() => {
  for (const ws of wss.clients) {
    ws.missed = (ws.missed ?? 0) + 1;
    if (ws.missed > 4) {
      // ~2 min of genuine silence — reap so the client's own reconnect takes over.
      ws.terminate();
      continue;
    }
    try {
      ws.ping();
    } catch {
      /* the socket is already going away */
    }
  }
}, 30_000).unref();

// State heartbeat: the dashboard's live pills must not drift out of sync. Kept small
// and cheap so it can go out even between the event loop's busier moments.
setInterval(() => {
  if (!wss.clients.size) return;
  let payload;
  try {
    payload = JSON.stringify({ type: 'state', ts: Date.now(), state: controller.state() });
  } catch {
    return; // never let a serialisation hiccup take the heartbeat down
  }
  for (const ws of wss.clients) if (ws.readyState === ws.OPEN) ws.send(payload);
}, 5000).unref();

// Platform boot MUST run first: it opens the active project's SQLite database
// (nothing below can touch the DB until a project is active) and seeds the
// bootstrap admin. seedAgents() now happens inside project activation.
seedAdmin();
seedBestPractices();
const activated = bootActiveProject();
const { seeded, repaired } = activated.seed;
const reaped = reapStaleRuns();
const reapedIters = reapStaleIterations();
const managers = startManagers();
managersRef = managers;
reapSessions();

// Keep the logs + events tables bounded and expire dead sessions.
setInterval(() => { trimLogs(5000); trimEvents(20000); }, 10 * 60_000).unref();
setInterval(() => reapSessions(), 30 * 60_000).unref();

// POST-DEPLOY GUARDRAIL. Each promotion opens a bake window; this is what actually looks at it.
// One minute is short relative to the default 30-minute window, so a breach is caught while the
// change is still fresh in the operator's mind — and each pass is three cheap local reads.
setInterval(() => {
  try {
    const r = checkBakeWindows();
    if (r.breached) log.warn('dora', `${r.breached} deployment(s) breached their bake window`);
  } catch (err) {
    log.warn('dora', `bake-window check failed: ${err.message}`);
  }
}, 60_000).unref();

// Scheduled improvement windows: fire heavier passes during operator-defined quiet hours.
startImprovementWindows();

// Apply the operator's saved model choice (Settings → Models) to config's live bindings, and probe
// what is actually installed in the background so the picker is populated on first open.
applyModelConfig();
detectModels().catch(() => {});

// Outbound webhooks: subscribe the dispatcher to the bus. Without this the Governance → Webhooks
// tab saves URLs that are never called — the feature looked configured and did nothing.
wireWebhooks();

// MEMORY WATCHDOG. A long autonomous run slowly accretes heap (LLM buffers, diffs, the
// sqlite WAL). An actual OOM crash cannot be caught by the handlers above — the process just
// dies, which is the "ISL is down after a few hours" symptom. So we watch RSS and, before we
// get near the V8 heap ceiling, exit CLEANLY (code 0) — the supervisor restarts us in seconds
// and the loop auto-resumes (its desired state is persisted). A planned blink, not a crash.
const MEM_LIMIT_MB = Number(process.env.ISL_MEM_LIMIT_MB) || 1400;
setInterval(() => {
  const rssMB = Math.round(process.memoryUsage().rss / 1048576);
  if (rssMB >= MEM_LIMIT_MB) {
    console.error(`[memory-watchdog] RSS ${rssMB}MB ≥ ${MEM_LIMIT_MB}MB — restarting cleanly to reclaim memory`);
    try { log.warn('server', `memory watchdog: RSS ${rssMB}MB ≥ ${MEM_LIMIT_MB}MB — clean restart`); } catch { /* ignore */ }
    controller.stop({ persist: false }); // don't record the blink as an operator stop
    try { db.exec('PRAGMA wal_checkpoint(TRUNCATE);'); } catch { /* best-effort */ }
    httpServer.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 4000).unref();
  } else if (rssMB >= MEM_LIMIT_MB * 0.8) {
    // Approaching the limit — nudge GC if the process was started with --expose-gc.
    try { global.gc?.(); } catch { /* ignore */ }
  }
}, 60_000).unref();

// A restart can race the previous process still releasing the port (Windows TIME_WAIT). Rather
// than let a generic uncaughtException leave us up-but-not-listening, retry the bind a few times,
// then exit so the supervisor relaunches once the port is truly free.
let bindAttempts = 0;
httpServer.on('error', (err) => {
  if (err?.code === 'EADDRINUSE' && bindAttempts < 10) {
    bindAttempts++;
    console.error(`[server] port ${serverCfg.port} busy (attempt ${bindAttempts}/10) — retrying in 1s`);
    setTimeout(() => { try { httpServer.close(); } catch { /* not open */ } httpServer.listen(serverCfg.port); }, 1000);
    return;
  }
  console.error(`[server] listen failed: ${err?.message} — exiting for the supervisor to restart`);
  process.exit(1);
});

httpServer.listen(serverCfg.port, () => {
  console.log(`\n  ISL — Improvement Software Loop`);
  console.log(`  ├─ project    ${getActiveProject()?.project?.name ?? '—'} (${REPO_ROOT})`);
  console.log(`  ├─ api        http://localhost:${serverCfg.port}/api/health`);
  console.log(`  ├─ dashboard  http://localhost:${serverCfg.port}/  (after dashboard:build)`);
  console.log(`  ├─ websocket  ws://localhost:${serverCfg.port}/ws`);
  console.log(`  ├─ repo       ${REPO_ROOT}`);
  console.log(`  ├─ agents     ${listAgents().length} registered${seeded.length ? ` (seeded: ${seeded.join(', ')})` : ''}`);
  console.log(`  ├─ managers   ${managers.names.join(', ')}`);
  const bl = baselineStatus();
  console.log(`  ├─ baseline   ${bl.baseBranch} (${bl.trackedFiles} tracked files)${bl.aligned ? '' : '  ⚠ NOT the checked-out branch!'}`);
  if (bl.warning) console.log(`  ├─ ⚠ WARNING  ${bl.warning}`);
  if (repaired?.length) console.log(`  ├─ repaired   scope of ${repaired.join(', ')} — it pointed at directories this branch does not have`);
  const c = controller.state();
  console.log(`  ├─ pipeline   work branch ${c.workBranch} · ${c.parallel.maxTasks} task(s) in parallel · ${c.batch.improvements} impr + ${c.batch.features} feat per run`);
  if (reaped || reapedIters) console.log(`  ├─ recovered  ${reaped} run(s), ${reapedIters} iteration(s) marked interrupted`);
  if (c.restartable.length) console.log(`  ├─ restartable ${c.restartable.length} failed run(s) can be resumed from their changes`);
  console.log(`  └─ apply mode ${orchestrator.state().applyMode}\n`);
  log.info('server', `control plane up on :${serverCfg.port}`, { data: { agents: listAgents().length } });

  // The loop AUTO-RESUMES if it was armed before this restart: an autonomous plane
  // that stops the moment its host restarts isn't autonomous. `desiredRunning` is the
  // persisted intent — true = keep it running, false = the operator explicitly stopped
  // it (respect that), null = fresh install (fall back to the autostart config).
  const desired = controller.desiredRunning;
  if (desired === true || (desired === null && (autonomy.autostartLoop || iterationCfg.autostart))) {
    controller.start();
    if (desired === true) console.log('  ├─ loop        auto-resumed (it was running before the restart)');
  }
});

const shutdown = () => {
  // A shutdown is not the operator stopping the loop — don't persist it as "off", so
  // the loop re-arms on the next boot.
  controller.stop({ persist: false });
  httpServer.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 3000).unref();
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

// An autonomous control plane must survive a single bad run. Log and keep serving
// rather than let one unhandled error take the whole fleet down.
process.on('unhandledRejection', (reason) => {
  const msg = reason?.message || String(reason);
  console.error('[unhandledRejection]', msg);
  try {
    log.error('server', `unhandled rejection: ${msg}`);
  } catch {
    /* ignore */
  }
});
process.on('uncaughtException', (err) => {
  console.error('[uncaughtException]', err?.stack || err?.message || err);
  try {
    log.error('server', `uncaught exception: ${err?.message || err}`);
  } catch {
    /* ignore */
  }
});
