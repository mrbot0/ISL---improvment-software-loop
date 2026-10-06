import fs from 'node:fs';
import { authCfg, resolveProjectConfig } from '../config.js';
import { log } from '../logger.js';
import { survey } from '../iteration/surveyor.js';
import { buildContext } from '../context/contextManager.js';
import {
  authenticate,
  changePassword,
  createSession,
  destroySession,
  createUser,
  updateUser,
  deleteUser,
  listUsers,
  getUser,
  getUserByEmail,
  listSessions,
  countActiveSessions,
  destroyUserSessions,
} from './users.js';
import { ollama } from '../config.js';
import { countPractices } from '../bestpractices/bestPracticesDb.js';
import { listProjects, getProject, createProject, updateProject, archiveProject } from './projects.js';
import { activateProject, getActiveProject } from './activeProject.js';
import { listAudit, getPlatformSetting, setPlatformSetting, audit } from './platformDb.js';
import { listDatabases, listTables, readTable, runQuery } from './dbExplorer.js';
import {
  requireAuth,
  requireAdmin,
  setSessionCookie,
  clearSessionCookie,
} from './authMiddleware.js';

const wrap = (fn) => (req, res) => {
  new Promise((resolve) => resolve(fn(req, res))).catch((err) => {
    res.status(err.status ?? 400).json({ error: err.message });
  });
};

/**
 * Mount the platform control surface: authentication, the project registry and
 * the admin panel. `ctx` gives the routes the two process singletons they must
 * coordinate with when the active project changes — the control loop (paused
 * before a DB swap) and the managers (re-primed after).
 */
export function mountPlatformRoutes(app, ctx = {}) {
  const { controller, reanalyzeManagers } = ctx;

  /* ------------------------------- auth --------------------------------- */

  app.post(
    '/api/auth/login',
    wrap((req, res) => {
      const { email, password } = req.body ?? {};
      const result = authenticate(email, password);
      if (!result.ok) return res.status(401).json({ error: result.error });
      const token = createSession(result.user.id, {
        ip: req.ip,
        agent: req.headers['user-agent'] || null,
      });
      setSessionCookie(res, token, authCfg.sessionTtlMs);
      res.json({ user: result.user, claimed: !!result.claimed });
    }),
  );

  app.post(
    '/api/auth/logout',
    wrap((req, res) => {
      destroySession(req.sessionToken);
      clearSessionCookie(res);
      res.json({ ok: true });
    }),
  );

  app.get(
    '/api/auth/me',
    wrap((req, res) => {
      if (!req.user) return res.status(401).json({ error: 'Not authenticated' });
      res.json({ user: req.user });
    }),
  );

  app.post(
    '/api/auth/password',
    requireAuth,
    wrap((req, res) => {
      const { currentPassword, newPassword } = req.body ?? {};
      res.json(changePassword(req.user.id, currentPassword, newPassword));
    }),
  );

  /* ------------------------------ projects ------------------------------ */

  app.get(
    '/api/projects',
    requireAuth,
    wrap((_req, res) => {
      res.json({ list: listProjects({ includeArchived: true }), active: getActiveProject()?.project ?? null });
    }),
  );

  app.get(
    '/api/projects/active',
    requireAuth,
    wrap((_req, res) => res.json(getActiveProject() ?? {})),
  );

  // Switching the active project changes the runtime for everyone (one loop, one
  // DB handle). Refuse mid-iteration; pause the loop, swap, re-prime managers.
  app.post(
    '/api/projects/active',
    requireAuth,
    wrap((req, res) => {
      const { id } = req.body ?? {};
      if (!getProject(id)) return res.status(404).json({ error: `Unknown project: ${id}` });
      if (controller?.state?.().running) {
        return res.status(409).json({ error: 'An iteration is running — cancel it before switching projects.' });
      }
      // Switching is an incidental stop (we must swap DB handles), NOT the operator
      // turning the loop off — don't persist it as "off", and re-arm on the new project
      // if it was running, so the loop keeps going.
      const wasRunning = controller?.desiredRunning === true || controller?.state?.().looping;
      controller?.stop?.({ persist: false });
      const active = activateProject(id);
      reanalyzeManagers?.();
      if (wasRunning) controller?.start?.();
      res.json({ active });
    }),
  );

  app.post(
    '/api/projects',
    requireAdmin,
    wrap((req, res) => {
      const { name, codePath, baseBranch, description, color } = req.body ?? {};
      const project = createProject({ name, codePath, baseBranch, description, color, createdBy: req.user.email });
      res.json(project);
    }),
  );

  app.patch(
    '/api/projects/:id',
    requireAdmin,
    wrap((req, res) => res.json(updateProject(req.params.id, req.body ?? {}))),
  );

  app.post(
    '/api/projects/:id/archive',
    requireAdmin,
    wrap((req, res) => res.json(archiveProject(req.params.id))),
  );

  // Change a project's source folder. This is destructive: the backlog is reset
  // and the project is re-analysed from scratch against the new code. The client
  // confirms and warns before calling. Refused mid-iteration.
  app.post(
    '/api/projects/:id/source',
    requireAdmin,
    wrap((req, res) => {
      const id = req.params.id;
      const project = getProject(id);
      if (!project) return res.status(404).json({ error: `Unknown project: ${id}` });
      const codePath = String(req.body?.codePath || '').trim();
      if (!codePath) throw new Error('codePath is required');
      if (!fs.existsSync(codePath) || !fs.statSync(codePath).isDirectory()) throw new Error(`Not a directory: ${codePath}`);

      const isActive = getActiveProject()?.project?.id === id;
      if (isActive && controller?.state?.().running) {
        return res.status(409).json({ error: 'An iteration is running — cancel it before changing the source folder.' });
      }

      updateProject(id, { codePath });

      if (!isActive) {
        // Inactive project: the reset + fresh analysis happen automatically when
        // it is next activated (the path-change is detected then).
        return res.json({ updated: true, reanalyzing: false, activeReset: false });
      }

      controller?.stop?.({ persist: false }); // heavy re-analysis follows; don't disarm the loop's intent
      const active = activateProject(id); // detects the path change → resets backlog + clears context
      reanalyzeManagers?.();
      // Fresh analysis from scratch, in the background.
      Promise.resolve()
        .then(async () => {
          await survey({}).catch((e) => log.warn('project', `resurvey failed: ${e.message}`));
          await buildContext({ force: true }).catch((e) => log.warn('project', `context rebuild failed: ${e.message}`));
          reanalyzeManagers?.();
        })
        .catch(() => {});
      res.json({ updated: true, reanalyzing: true, activeReset: !!active.sourceChanged });
    }),
  );

  // Inspect a candidate folder for the create form: does it exist, and what
  // layout does ISL detect there? Lets the admin see what they'll get.
  app.post(
    '/api/projects/validate-path',
    requireAdmin,
    wrap((req, res) => {
      const p = String(req.body?.path || '').trim();
      if (!p) return res.status(400).json({ error: 'path is required' });
      if (!fs.existsSync(p)) return res.json({ exists: false });
      if (!fs.statSync(p).isDirectory()) return res.json({ exists: true, isDirectory: false });
      const r = resolveProjectConfig({ id: 'probe', codePath: p });
      res.json({
        exists: true,
        isDirectory: true,
        productDirs: r.productDirs,
        language: r.repoFacts.language,
        services: r.repoFacts.services,
        baseBranch: r.baseBranch,
      });
    }),
  );

  /* -------------------------------- admin -------------------------------- */

  app.get(
    '/api/admin/users',
    requireAdmin,
    wrap((_req, res) => res.json(listUsers())),
  );

  app.post(
    '/api/admin/users',
    requireAdmin,
    wrap((req, res) => {
      const { email, name, role, password } = req.body ?? {};
      res.json(createUser({ email, name, role, password: password || null, createdBy: req.user.email }));
    }),
  );

  app.patch(
    '/api/admin/users/:id',
    requireAdmin,
    wrap((req, res) => {
      const target = getUser(req.params.id);
      if (!target) return res.status(404).json({ error: 'Unknown user' });
      // Don't let an admin lock themselves out by demoting/disabling the last admin.
      if (target.role === 'admin' && (req.body?.role === 'user' || req.body?.status === 'disabled')) {
        const admins = listUsers().filter((u) => u.role === 'admin' && u.status !== 'disabled');
        if (admins.length <= 1) return res.status(400).json({ error: 'Cannot demote or disable the last active administrator' });
      }
      res.json(updateUser(req.params.id, req.body ?? {}, req.user.email));
    }),
  );

  app.delete(
    '/api/admin/users/:id',
    requireAdmin,
    wrap((req, res) => {
      const target = getUser(req.params.id);
      if (!target) return res.status(404).json({ error: 'Unknown user' });
      if (target.id === req.user.id) return res.status(400).json({ error: 'You cannot delete your own account' });
      if (target.role === 'admin') {
        const admins = listUsers().filter((u) => u.role === 'admin' && u.status !== 'disabled');
        if (admins.length <= 1) return res.status(400).json({ error: 'Cannot delete the last administrator' });
      }
      res.json({ deleted: deleteUser(req.params.id, req.user.email) });
    }),
  );

  app.get(
    '/api/admin/audit',
    requireAdmin,
    wrap((req, res) => res.json(listAudit(Number(req.query.limit) || 200))),
  );

  app.get('/api/admin/sessions', requireAdmin, wrap((_req, res) => res.json(listSessions())));

  app.post('/api/admin/users/:id/revoke-sessions', requireAdmin, wrap((req, res) => {
    const target = getUser(req.params.id);
    if (!target) return res.status(404).json({ error: 'Unknown user' });
    destroyUserSessions(req.params.id);
    res.json({ ok: true });
  }));

  app.get('/api/admin/system', requireAdmin, wrap((_req, res) => {
    const users = listUsers();
    res.json({
      version: '2.0.0',
      node: process.version,
      uptimeSec: Math.round(process.uptime()),
      memoryMB: Math.round(process.memoryUsage().rss / 1048576),
      activeSessions: countActiveSessions(),
      users: users.length,
      projects: listProjects({ includeArchived: true }).length,
      bestPractices: countPractices(),
      activeProject: getActiveProject()?.project?.name ?? null,
      ollama: { model: ollama.model, chatModel: ollama.chatModel, host: ollama.host },
    });
  }));

  /* --------------------------- database explorer ------------------------- */
  // Read-only inspection of every ISL database. Admin-only, SELECT-only.
  app.get('/api/admin/databases', requireAdmin, wrap((_req, res) => res.json({ databases: listDatabases() })));
  app.get('/api/admin/db/tables', requireAdmin, wrap((req, res) => res.json({ tables: listTables(String(req.query.db || 'platform')) })));
  app.get('/api/admin/db/rows', requireAdmin, wrap((req, res) => {
    res.json(readTable(String(req.query.db || 'platform'), String(req.query.table || ''), { limit: req.query.limit, offset: req.query.offset }));
  }));
  app.post('/api/admin/db/query', requireAdmin, wrap((req, res) => {
    const { db = 'platform', sql = '' } = req.body ?? {};
    audit('db.query', { actor: req.user.email, target: db, detail: String(sql).slice(0, 300) });
    res.json(runQuery(db, sql));
  }));

  /* --------------------------- dashboard control ------------------------- */
  // The admin owns the shape of the dashboard: which menu items everyone sees,
  // their labels, and the default landing view. Stored platform-wide.
  const DASHBOARD_DEFAULTS = { hidden: [], labels: {}, defaultView: 'overview' };
  const readDashCfg = () => ({ ...DASHBOARD_DEFAULTS, ...(getPlatformSetting('dashboard.config', {}) || {}) });
  // Everyone reads it (their nav reflects the admin's choices)…
  app.get('/api/dashboard-config', requireAuth, wrap((_req, res) => res.json(readDashCfg())));
  // …only an admin writes it.
  app.get('/api/admin/dashboard-config', requireAdmin, wrap((_req, res) => res.json(readDashCfg())));
  app.put('/api/admin/dashboard-config', requireAdmin, wrap((req, res) => {
    const body = req.body ?? {};
    const cfg = {
      hidden: Array.isArray(body.hidden) ? body.hidden.map(String).slice(0, 100) : [],
      labels: body.labels && typeof body.labels === 'object' ? body.labels : {},
      defaultView: typeof body.defaultView === 'string' ? body.defaultView : 'overview',
    };
    setPlatformSetting('dashboard.config', cfg);
    audit('dashboard.config', { actor: req.user.email, detail: `${cfg.hidden.length} hidden, default=${cfg.defaultView}` });
    res.json(cfg);
  }));

  app.get(
    '/api/admin/overview',
    requireAdmin,
    wrap((_req, res) => {
      const users = listUsers();
      res.json({
        users: {
          total: users.length,
          admins: users.filter((u) => u.role === 'admin').length,
          pending: users.filter((u) => u.status === 'pending').length,
          disabled: users.filter((u) => u.status === 'disabled').length,
        },
        projects: listProjects({ includeArchived: true }).length,
        recentAudit: listAudit(20),
      });
    }),
  );
}
