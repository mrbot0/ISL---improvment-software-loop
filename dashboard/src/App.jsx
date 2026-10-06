import { Suspense, useCallback, useEffect, useRef, useState } from 'react';
// `lazy`, but a chunk that was redeployed out from under an open tab reloads the page instead of
// leaving a dead view. Every view here is a separate hashed chunk, so this affects all of them.
import { lazyView } from './lazyView.js';
import { useDashboardStore } from './store.js';
import { useHashRoute, useKeyboard, useTheme, useDensity, useAuth, usePreferences, invalidateResource } from './hooks.js';
import { keysForEvent } from './liveKeys.js';
import { api } from './api.js';
import { Spinner } from './components/ui.jsx';
import { useToast } from './components/Toast.jsx';
import CommandPalette from './components/CommandPalette.jsx';
import TopBarInfo from './components/TopBarInfo.jsx';
import HealthWidget from './components/HealthWidget.jsx';
import ActivitySpotlight from './components/ActivitySpotlight.jsx';
import LiveAnnouncer from './components/LiveAnnouncer.jsx';
import Chat from './components/Chat.jsx';
import ProposalDetail from './components/ProposalDetail.jsx';
import Login from './components/Login.jsx';
import ProjectSwitcher from './components/ProjectSwitcher.jsx';
import { ErrorBoundary } from './components/ErrorBoundary.jsx';
import { applyDashboardConfig } from './nav.js';
import { t as tr, useLocale, LOCALES } from './i18n.js';
import TabbedView from './components/TabbedView.jsx';
import { resolveRoute, rollUpBadges, routeFor } from './merged.js';

// Route-level CODE-SPLITTING (ISL_Frontend §3): each view is its own lazy chunk, so the
// initial bundle is a small shell and pages load on demand. Suspense shows a spinner
// while a chunk streams in.
const Overview = lazyView(() => import('./views/Overview.jsx'));
const Flow = lazyView(() => import('./views/Flow.jsx'));
const Iterations = lazyView(() => import('./views/Iterations.jsx'));
const Runs = lazyView(() => import('./views/Runs.jsx'));
const Plans = lazyView(() => import('./views/Plans.jsx'));
const Backlog = lazyView(() => import('./views/Backlog.jsx'));
const Managers = lazyView(() => import('./views/Managers.jsx'));
const Fleet = lazyView(() => import('./views/Fleet.jsx'));
const Proposals = lazyView(() => import('./views/Proposals.jsx'));
const Deploy = lazyView(() => import('./views/Deploy.jsx'));
const Analytics = lazyView(() => import('./views/Analytics.jsx'));
const Telemetry = lazyView(() => import('./views/Telemetry.jsx'));
const KPI = lazyView(() => import('./views/KPI.jsx'));
const Logs = lazyView(() => import('./views/Logs.jsx'));
const Notifications = lazyView(() => import('./views/Notifications.jsx'));
const Explorer = lazyView(() => import('./views/Explorer.jsx'));
const Runtime = lazyView(() => import('./views/Runtime.jsx'));
const Services = lazyView(() => import('./views/Services.jsx'));
const Workbench = lazyView(() => import('./views/Workbench.jsx'));
const Models = lazyView(() => import('./views/Models.jsx'));
const Repair = lazyView(() => import('./views/Repair.jsx'));
const SettingsView = lazyView(() => import('./views/Settings.jsx'));
const Projects = lazyView(() => import('./views/Projects.jsx'));
const Summary = lazyView(() => import('./views/Summary.jsx'));
const Context = lazyView(() => import('./views/Context.jsx'));
const Reliability = lazyView(() => import('./views/Reliability.jsx'));
const Compliance = lazyView(() => import('./views/Compliance.jsx'));
const Cloud = lazyView(() => import('./views/Cloud.jsx'));
const Memory = lazyView(() => import('./views/Memory.jsx'));
const Decisions = lazyView(() => import('./views/Decisions.jsx'));
const Security = lazyView(() => import('./views/Security.jsx'));
const Health = lazyView(() => import('./views/Health.jsx'));
const Insight = lazyView(() => import('./views/Insight.jsx'));
const Digest = lazyView(() => import('./views/Digest.jsx'));
const Scope = lazyView(() => import('./views/Scope.jsx'));
const Governance = lazyView(() => import('./views/Governance.jsx'));
const Review = lazyView(() => import('./views/Review.jsx'));
const Admin = lazyView(() => import('./views/Admin.jsx'));
import { Logo } from './components/Logo.jsx';

/**
 * The navigation, grouped by what the operator is actually doing:
 *   Workspace   — the project you're improving (its code, docs, files)
 *   Improve     — the autonomous loop: its runs, plan, queue, and the proposals to review
 *   Fleet       — the AI workforce: agents, their managers, and the self-monitoring
 *   Deploy      — getting the app running and shipped: health, runtime, promote, cloud
 *   Insight     — metrics, logs and settings
 *   Admin       — users & platform (admin only)
 */

/* ─────────────────────────────── auth gate ─────────────────────────────── */

export default function App() {
  const auth = useAuth();

  if (!auth.ready) {
    return (
      <div className="grid h-screen place-items-center bg-ink-950">
        <div className="flex items-center gap-2 text-slate-500"><Spinner /> starting ISL…</div>
      </div>
    );
  }
  if (!auth.user) return <Login onLogin={auth.login} />;
  return <Dashboard user={auth.user} onLogout={auth.logout} onUnauthorized={() => auth.setUser(null)} />;
}

/* ─────────────────────────────── dashboard ─────────────────────────────── */

function Dashboard({ user, onLogout, onUnauthorized }) {
  const store = useDashboardStore({ onUnauthorized });
  const [view, setView] = useHashRoute('overview');
  const [theme, toggleTheme, setTheme] = useTheme();
  const [density, toggleDensity, setDensity] = useDensity();
  const [locale, setLocale] = useLocale(); // re-render on language change

  // Server-persisted preferences. Local values apply instantly (no theme flash on load); the server
  // corrects them once, and every subsequent change is written through so a second machine agrees.
  const [, savePrefs] = usePreferences(user, { setTheme, setDensity, setLocale });
  useEffect(() => { savePrefs({ theme }); }, [theme]);
  useEffect(() => { savePrefs({ density }); }, [density]);
  useEffect(() => { savePrefs({ locale }); }, [locale]);
  const [openId, setOpenId] = useState(null);
  const [chatOpen, setChatOpen] = useState(false);
  const [sidebarOpen, setSidebarOpen] = useState(false); // mobile drawer
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [projects, setProjects] = useState([]);
  const [activeProject, setActiveProject] = useState(null);
  const toast = useToast();

  const isAdmin = user.role === 'admin';

  /*
   * ARRESTO COMPLETO DI ISL.
   *
   * Due conferme, non una. La prima è la domanda; la seconda chiede di scrivere il nome, perché
   * questo pulsante non ha un annullamento: quando il server è giù non c'è più interfaccia da cui
   * riaccenderlo, serve un terminale sulla macchina che lo ospita. Un `confirm()` singolo si
   * accetta per riflesso, digitare una parola no.
   *
   * `shutdownDone` porta la dashboard in uno stato terminale invece di lasciarla tentare
   * riconnessioni contro un server che non tornerà: senza, l'operatore vedrebbe "connessione persa
   * — riconnessione in corso…" e non saprebbe se lo spegnimento è riuscito o se qualcosa è rotto.
   */
  const [shuttingDown, setShuttingDown] = useState(false);
  const [shutdownDone, setShutdownDone] = useState(null);

  const requestShutdown = async () => {
    if (!window.confirm(
      'Spegnere ISL completamente?\n\n'
      + '• il loop viene fermato e resta fermo anche al prossimo avvio\n'
      + "• l'iterazione in corso viene interrotta (il lavoro fatto resta nel checkpoint)\n"
      + '• il server si chiude e il supervisore NON lo riavvia\n\n'
      + 'Per riaccenderlo servirà un terminale sulla macchina.',
    )) return;
    if (window.prompt('Scrivi ISL per confermare lo spegnimento:')?.trim().toUpperCase() !== 'ISL') return;
    setShuttingDown(true);
    try {
      const r = await actions.shutdown();
      setShutdownDone(r || {});
    } catch (e) {
      /*
       * Il server può chiudersi prima che la risposta arrivi: la connessione cade e fetch fallisce
       * anche se lo spegnimento è perfettamente riuscito. Trattarlo come errore direbbe all'operatore
       * il contrario di quello che è successo, quindi verifichiamo com'è andata davvero — se il
       * server non risponde più, si è spento.
       */
      const stillUp = await api.control().then(() => true).catch(() => false);
      if (stillUp) {
        setShuttingDown(false);
        toast?.error?.(`Arresto non riuscito: ${e.message}`);
        return;
      }
      setShutdownDone({ stopping: true, note: 'Per riaccendere: node supervisor.mjs' });
    }
  };

  // The admin can hide/rename menu items and set the default view; everyone's nav
  // reflects that config (re-fetched when the admin saves — see the 'dashboard.config' event).
  const [dashCfg, setDashCfg] = useState(null);
  const loadDashCfg = () => api.dashboardConfig().then(setDashCfg).catch(() => setDashCfg({ hidden: [], labels: {}, defaultView: 'overview' }));
  useEffect(() => { loadDashCfg(); }, []);

  const NAV_GROUPS = applyDashboardConfig(isAdmin, dashCfg || {});
  const NAV = NAV_GROUPS.flatMap((g) => g.items);
  const VALID_VIEWS = new Set(NAV.map((n) => n.id));

  const { control, metrics, agents, proposals, managers, events, logs, runs, thoughts, repo, wsStatus, iteration, notifications, deploy, plans, codeStats, actions, ready, error } = store;
  const orch = control;

  /*
   * `page` is what the nav highlights and what App renders; `tab` is which panel opens inside a
   * merged page. `resolveRoute` maps all three shapes that exist in the wild — `runs/flow` (written
   * by the tab shell), `flow` (bookmarks, and `onNavigate('flow')` calls scattered across views),
   * and plain unmerged ids.
   */
  const { page, tab } = resolveRoute(view);

  /*
   * A destination is valid if the nav has it OR it resolves into a merged page. Validating against
   * `VALID_VIEWS` alone would send every `go('flow')` in the codebase to Overview the moment Flow
   * stopped being its own nav entry — a silent redirect that looks like the link is broken.
   */
  const go = (v) => {
    const dest = resolveRoute(v);
    const ok = VALID_VIEWS.has(v) || VALID_VIEWS.has(dest.page);
    setView(ok ? v : 'overview');
    setSidebarOpen(false);
  };

  // Live, not polled (ISL_Frontend §3/§7): the event that CAUSED a change says what it made stale,
  // and every mounted view using that data refetches immediately.
  //
  // This used to handle two event types and three keys, hard-coded here, while eight views ran their
  // own timers regardless. The mapping now lives in `liveKeys.js` — an event and the data it
  // invalidates are one fact, and keeping them together is what stops them drifting.
  //
  // Only the LAST event is read, deliberately: a burst arrives as a batched store update, and
  // walking the whole buffer on every render would invalidate the same keys dozens of times.
  const lastSeen = useRef(null);
  useEffect(() => {
    const ev = store.events?.[store.events.length - 1];
    if (!ev || ev === lastSeen.current) return;
    lastSeen.current = ev;
    for (const key of keysForEvent(ev)) invalidateResource(key);
  }, [store.events]);

  // Honour the admin's default landing view — but only when the user arrived without
  // an explicit route in the URL, so deep links and manual navigation still win.
  const appliedDefault = useRef(false);
  useEffect(() => {
    if (!dashCfg || appliedDefault.current) return;
    appliedDefault.current = true;
    const hash = location.hash.replace(/^#\/?/, '');
    // Resolved, not compared literally: an admin who set the landing page to Telemetry before the
    // merge would otherwise be dropped back on Overview with no indication their setting was lost.
    if (!hash && dashCfg.defaultView && dashCfg.defaultView !== 'overview' && VALID_VIEWS.has(resolveRoute(dashCfg.defaultView).page)) {
      setView(dashCfg.defaultView);
    }
  }, [dashCfg]); // eslint-disable-line react-hooks/exhaustive-deps


  const guard = async (fn, successMsg) => {
    setBusy(true);
    try {
      await fn();
      if (successMsg) toast(successMsg, { type: 'success' });
    } catch (e) {
      toast(e.message, { type: 'error', title: 'Action failed' });
    } finally {
      setBusy(false);
    }
  };

  const loadProjects = useCallback(async () => {
    try {
      const { list, active } = await api.projects();
      setProjects(list);
      setActiveProject(active);
    } catch {
      /* ignore — the switcher just shows what it has */
    }
  }, []);
  useEffect(() => {
    loadProjects();
  }, [loadProjects]);

  const switchProject = async (id) => {
    await api.switchProject(id);
    await loadProjects();
    await actions.refetch();
  };
  const guardedSwitch = (id) => guard(() => switchProject(id), 'Project switched');

  // Surface important live events as toasts (deduped by event id/ts).
  const seen = useRef(0);
  useEffect(() => {
    for (const e of events) {
      const key = e.id ?? e.ts;
      if (key <= seen.current) continue;
      seen.current = Math.max(seen.current, key);
      if (e.type === 'iteration.finished') {
        const t = e.status === 'committed' ? 'success' : e.status === 'rolled_back' ? 'warn' : e.status === 'error' ? 'error' : 'info';
        toast(`Iteration #${e.iterationId} ${(e.status || '').replace('_', ' ')}${e.total != null ? ` · score ${e.total}` : ''}`, { type: t, title: 'Iteration finished' });
      } else if (e.type === 'deploy.promoted') {
        toast(`Promoted ${e.count} commit(s) to main → ${e.to}`, { type: 'success', title: 'Deployed' });
      } else if (e.type === 'proposal.created') {
        toast(`${e.agentId}: ${e.title}`, { type: 'info', title: 'New proposal' });
      } else if (e.type === 'context.built') {
        toast(e.ready ? 'Project context is ready' : `Context built — ${e.pending} question(s) need you`, { type: e.ready ? 'success' : 'warn', title: 'Context Manager' });
      } else if (e.type === 'project.activated') {
        toast(`Now improving ${e.name}`, { type: 'info', title: 'Project' });
      } else if (e.type === 'manager.message' && (e.severity === 'critical' || e.severity === 'error')) {
        toast(e.title || 'Manager alert', { type: 'error', title: `${e.from} → ${e.to}` });
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [events]);

  const exportReport = async () => {
    try {
      const report = await api.report();
      const blob = new Blob([JSON.stringify(report, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `isl-report-${new Date().toISOString().slice(0, 19).replace(/:/g, '')}.json`;
      a.click();
      URL.revokeObjectURL(url);
      toast('Report downloaded', { type: 'success' });
    } catch (e) {
      toast(e.message, { type: 'error' });
    }
  };

  useKeyboard(
    {
      'mod+k': () => setPaletteOpen((v) => !v),
      c: () => setChatOpen((v) => !v),
      t: () => toggleTheme(),
      escape: () => { setPaletteOpen(false); setOpenId(null); },
      ...Object.fromEntries(NAV.slice(0, 9).map((n, i) => [String(i + 1), () => go(n.id)])),
    },
    [toggleTheme],
  );

  const paletteActions = [
    { label: control?.looping ? 'Stop the pipeline' : 'Start the pipeline', hint: 'loop', run: () => guard(control?.looping ? actions.stopLoop : actions.startLoop) },
    { label: 'Restart the loop (recover if stuck)', hint: 'loop', run: () => guard(actions.restartLoop, 'Loop restarted') },
    { label: 'Run one iteration now', hint: 'iteration', run: () => guard(actions.runIteration, 'Iteration started') },
    ...(control?.restartable || []).slice(0, 3).map((r) => ({
      label: `Restart iteration #${r.id} (${r.failure?.kind === 'interruption' ? 'was interrupted' : 'fix the failure'})`,
      hint: 'restart',
      run: () => guard(() => actions.restartIteration(r.id), `Restarting #${r.id}`),
    })),
    { label: 'Build project context', hint: 'context', run: () => guard(() => api.contextBuild(true), 'Building context…') },
    { label: 'Promote to main', hint: 'deploy', run: () => guard(actions.promote, 'Promoted to main') },
    // The deterministic subsystems, reachable without hunting for their page.
    { label: 'Scan dependencies for CVEs', hint: 'security', run: () => guard(api.scanDependencies, 'Dependency scan started') },
    { label: 'Compute safe dependency upgrades', hint: 'security', run: () => guard(() => api.startRemediation(), 'Computing safe upgrades…') },
    { label: 'Seed coverage tests for critical files', hint: 'backlog', run: () => guard(() => api.seedCoverage(5), 'Coverage tasks seeded') },
    { label: 'Seed structural refactors', hint: 'backlog', run: () => guard(() => api.seedStructural(5), 'Refactor tasks seeded') },
    { label: 'Seed accessibility / i18n fixes', hint: 'backlog', run: () => guard(() => api.seedFrontendAudit(5), 'A11y tasks seeded') },
    { label: 'De-duplicate the backlog', hint: 'backlog', run: () => guard(api.dedupBacklog, 'Backlog de-duplicated') },
    { label: 'Research improvements online', hint: 'research', run: () => guard(api.research, 'Research started') },
    { label: 'Build knowledge embeddings', hint: 'knowledge', run: () => guard(api.buildEmbeddings, 'Embedding build started') },
    { label: 'Detect available models', hint: 'models', run: () => guard(api.detectModels, 'Models detected') },
    { label: 'Take a health snapshot', hint: 'health', run: () => guard(api.healthSnapshot, 'Health snapshot taken') },
    { label: 'Export report (JSON)', hint: 'export', run: exportReport },
    { label: `Switch to ${theme === 'dark' ? 'light' : 'dark'} theme`, hint: 'theme', run: toggleTheme },
    { label: `Switch to ${density === 'compact' ? 'comfortable' : 'compact'} density`, hint: 'display', run: toggleDensity },
    { label: 'Sign out', hint: 'account', run: onLogout },
  ];

  const reviewCount = proposals.filter((p) => ['verified', 'failed', 'verifying'].includes(p.status)).length;
  const briefs = managers.briefs || [];
  const alertManagers = briefs.filter((b) => b.status === 'alert').length;
  const contextBrief = briefs.find((b) => b.name === 'Context');
  const reliabilityBrief = briefs.find((b) => b.name === 'Reliability');
  const complianceBrief = briefs.find((b) => b.name === 'Compliance');
  const deploymentBrief = briefs.find((b) => b.name === 'Deployment');
  const ideaCount = proposals.filter((p) => p.status === 'idea').length;
  // Rolled up onto the hosting page: a count keyed to an absorbed id has no nav entry to render on.
  const badges = rollUpBadges({
    proposals: reviewCount + ideaCount,
    managers: alertManagers,
    notifications: notifications.unread,
    context: contextBrief?.stats?.pendingQuestions || 0,
    reliability: reliabilityBrief?.stats?.openAnomalies || 0,
    compliance: complianceBrief?.stats?.openViolations || 0,
    cloud: deploymentBrief?.stats?.openTerraformFindings || 0,
  });

  /*
   * Stato terminale, prima di ogni altra cosa.
   *
   * Va sopra il controllo su `ready` perché appena il server si chiude `ready` torna falso e la
   * dashboard mostrerebbe "connessione al piano di controllo…" all'infinito — cioè il messaggio di
   * un problema, per un'operazione perfettamente riuscita. Qui invece si dice che è spento, e come
   * si riaccende, che è l'unica cosa che serve sapere da questo momento in poi.
   */
  if (shutdownDone) {
    return (
      <div className="grid h-screen place-items-center bg-ink-950 p-6">
        <div className="max-w-md rounded-lg border border-ink-800 bg-ink-900 p-6 text-center">
          <div className="text-3xl">⏻</div>
          <h1 className="mt-3 text-lg font-semibold text-slate-200">ISL è spento</h1>
          <p className="mt-2 text-sm text-slate-400">
            Il loop è stato fermato e resta fermo anche al prossimo avvio. Il supervisore non
            riavvierà il server.
          </p>
          {shutdownDone.cancelledIteration && (
            <p className="mt-2 text-xs text-amber-400">
              L&apos;iterazione in corso è stata interrotta. Il lavoro già prodotto è nel checkpoint
              e riparte da lì al prossimo avvio.
            </p>
          )}
          <p className="mt-4 text-xs text-slate-500">Per riaccenderlo, da un terminale nella cartella del progetto:</p>
          <code className="mt-1 block rounded bg-ink-950 px-3 py-2 text-xs text-emerald-300">node supervisor.mjs</code>
        </div>
      </div>
    );
  }

  if (!ready) {
    return (
      <div className="grid h-screen place-items-center">
        <div className="flex items-center gap-2 text-slate-500"><Spinner /> connecting to control plane…</div>
      </div>
    );
  }

  return (
    <div className="flex h-screen overflow-hidden">
      <a href="#main" className="skip-link">{tr('action.skipToContent')}</a>
      {/* Mobile drawer backdrop */}
      {sidebarOpen && <div className="fixed inset-0 z-30 bg-black/50 lg:hidden" onClick={() => setSidebarOpen(false)} aria-hidden="true" />}
      {/* ── Sidebar (static on desktop, slide-in drawer on small screens) ── */}
      <aside className={`fixed inset-y-0 left-0 z-40 flex w-56 shrink-0 flex-col border-r border-ink-800 bg-ink-950 transition-transform lg:static lg:z-auto lg:translate-x-0 ${sidebarOpen ? 'translate-x-0' : '-translate-x-full'}`}>
        <div className="px-4 py-4">
          <Logo />
        </div>

        <button
          onClick={() => setPaletteOpen(true)}
          className="mx-2 mb-2 flex items-center gap-2 rounded-lg border border-ink-700 px-2.5 py-1.5 text-[11px] text-slate-500 hover:bg-ink-900 hover:text-slate-300"
        >
          <span>⌕</span> <span className="flex-1 text-left">Search…</span>
          <kbd className="rounded bg-ink-800 px-1 text-[9px]">⌘K</kbd>
        </button>

        <nav className="flex-1 overflow-y-auto px-2 pb-2">
          {NAV_GROUPS.map((group) => (
            <div key={group.title} className="mb-3">
              <div className="px-3 pb-1 text-[9px] font-semibold uppercase tracking-[0.14em] text-slate-600">{tr('nav.' + group.title)}</div>
              <div className="space-y-0.5">
                {group.items.map((n) => (
                  <button
                    key={n.id}
                    onClick={() => go(n.id)}
                    aria-current={page === n.id ? 'page' : undefined}
                    title={n.label}
                    className={`group flex w-full items-center gap-2.5 rounded-lg px-3 py-1.5 text-[13px] transition-colors ${
                      page === n.id ? 'bg-ink-800 text-white' : 'text-slate-400 hover:bg-ink-900 hover:text-slate-200'
                    }`}
                  >
                    <span className={`-ml-1 h-4 w-0.5 rounded-full transition-colors ${page === n.id ? 'bg-brand' : 'bg-transparent'}`} />
                    <span className="text-slate-500">{n.icon}</span>
                    <span className="flex-1 text-left">{n.label}</span>
                    {badges[n.id] > 0 && (
                      <span
                        className={`rounded-full px-1.5 py-0.5 text-[9px] font-bold ${
                          n.id === 'managers' || n.id === 'reliability'
                            ? 'bg-rose-500/25 text-rose-300'
                            : n.id === 'notifications' || n.id === 'context' || n.id === 'security' || n.id === 'cloud'
                              ? 'bg-amber-500/25 text-amber-300'
                              : 'bg-brand/25 text-brand-light'
                        }`}
                      >
                        {badges[n.id]}
                      </span>
                    )}
                  </button>
                ))}
              </div>
            </div>
          ))}
        </nav>

        <div className="border-t border-ink-800 p-3">
          <button
            onClick={() => setChatOpen((v) => !v)}
            className={`flex w-full items-center gap-2 rounded-lg px-3 py-2 text-[13px] transition-colors ${
              chatOpen ? 'bg-brand/15 text-brand-light' : 'text-slate-400 hover:bg-ink-900'
            }`}
            title="Alfred — your operations assistant"
          >
            <span>🎩</span> Alfred
          </button>

          {/* account */}
          <div className="mt-2 flex items-center gap-2 rounded-lg px-2 py-1.5">
            <span className="grid h-6 w-6 shrink-0 place-items-center rounded-full bg-brand/20 text-[10px] font-bold text-brand-light">
              {(user.name || user.email)[0]?.toUpperCase()}
            </span>
            <span className="min-w-0 flex-1">
              <span className="block truncate text-[11px] text-slate-300" title={user.email}>{user.email}</span>
              <span className="block text-[9px] uppercase tracking-wide text-slate-600">{user.role}</span>
            </span>
            <button onClick={onLogout} className="rounded px-1.5 py-0.5 text-[11px] text-slate-500 hover:bg-ink-800 hover:text-rose-300" title="Sign out">⏻</button>
          </div>

          <div className="mt-1 flex items-center gap-2 px-1">
            <span className="flex items-center gap-1.5 text-[10px] text-slate-600">
              <span className={`h-1.5 w-1.5 rounded-full ${wsStatus === 'online' ? 'bg-emerald-400' : 'bg-rose-400'}`} />
              {wsStatus}
            </span>
            <div className="flex-1" />
            <button
              onClick={() => setLocale(LOCALES[(LOCALES.indexOf(locale) + 1) % LOCALES.length])}
              className="rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase text-slate-500 hover:bg-ink-800 hover:text-slate-300"
              title="Language / Lingua"
              aria-label="Change language"
            >
              {locale}
            </button>
            <button onClick={toggleTheme} className="rounded px-1.5 py-0.5 text-[11px] text-slate-500 hover:bg-ink-800 hover:text-slate-300" title={tr('action.toggleTheme') + ' (t)'} aria-label={tr('action.toggleTheme')}>
              {theme === 'dark' ? '☀' : '☾'}
            </button>
          </div>

          {/*
            ARRESTO COMPLETO — in fondo al menu, lontano dai comandi del loop.

            Non sta accanto a "stop pipeline" di proposito: quello mette in pausa il lavoro e si
            annulla con un clic, questo spegne il prodotto e da qui in poi serve un terminale sulla
            macchina per riaccenderlo. Due pulsanti con conseguenze così diverse non vanno messi a
            portata dello stesso movimento del mouse.

            Solo per amministratori, coerentemente con la rotta che lo serve.
          */}
          {isAdmin && (
            <button
              onClick={requestShutdown}
              disabled={shuttingDown}
              className="mt-2 w-full rounded border border-rose-900/60 px-2 py-1.5 text-[11px] font-semibold text-rose-400 hover:bg-rose-950/40 hover:text-rose-300 disabled:opacity-50"
              title="Ferma il loop, chiude il server e impedisce al supervisore di riavviarlo"
            >
              {shuttingDown ? '⏻ arresto in corso…' : '⏻ spegni ISL'}
            </button>
          )}
        </div>
      </aside>

      {/* ── Main column ─────────────────────────────────────── */}
      <div className="flex min-w-0 flex-1 flex-col">
        <header className="sticky top-0 z-30 flex items-center gap-3 border-b border-ink-800 bg-ink-950/95 px-5 py-2.5 backdrop-blur">
          <button className="btn-ghost -ml-2 px-2 lg:hidden" aria-label="Toggle menu" onClick={() => setSidebarOpen((v) => !v)}>☰</button>
          <h1 className="font-display text-base tracking-[0.06em] text-white">{view.toUpperCase()}</h1>

          <ProjectSwitcher projects={projects} active={activeProject} onSwitch={guardedSwitch} onManage={() => go('projects')} busy={busy} />

          <div className="ml-1 flex items-center gap-3 text-[11px]">
            <Stat label="pending" value={control?.fleet?.pending ?? 0} warn={control?.fleet?.pending >= control?.fleet?.maxPending} />
            <Stat label="parallel" value={`${control?.parallel?.maxTasks ?? 1}×`} />
            <Stat label="batch" value={control ? `${control.batch.improvements}+${control.batch.features}` : '—'} />
            <Stat label="today" value={control ? `${control.todayCount}/${control.maxPerDay}` : '—'} />
          </div>

          {control?.running && (
            <span className="flex items-center gap-1.5 rounded-lg border border-brand/40 bg-brand/10 px-2 py-1 text-[11px] text-brand-light">
              <Spinner /> iterating
              <button onClick={() => guard(actions.cancelCurrent)} className="ml-1 hover:text-white" title="Cancel">✕</button>
            </span>
          )}

          {!control?.running && control?.restartable?.length > 0 && (
            <button
              onClick={() => go('iterations')}
              className="flex items-center gap-1.5 rounded-lg border border-amber-800/50 bg-amber-500/10 px-2 py-1 text-[11px] text-amber-300 hover:bg-amber-500/20"
              title="Failed runs that can be restarted from the changes they already made"
            >
              ↻ {control.restartable.length} restartable
            </button>
          )}

          <div className="flex-1" />

          {control?.fleet?.current && (
            <div className="flex items-center gap-2 rounded-lg border border-emerald-800/50 bg-emerald-500/10 px-2.5 py-1 text-[11px] text-emerald-300">
              <Spinner /> <span className="font-medium">{control.fleet.current.agentId}</span>
            </div>
          )}

          <TopBarInfo onNavigate={go} />
          <button
            onClick={() => setPaletteOpen(true)}
            className="hidden items-center gap-1.5 rounded-lg border border-ink-800 px-2 py-1 text-[11px] text-slate-500 hover:border-ink-700 hover:text-slate-300 md:flex"
            title="Command palette — go anywhere, run anything, search the codebase"
          >
            ⌕ <span className="hidden lg:inline">Search</span> <kbd className="rounded bg-ink-800 px-1 text-[9px]">⌘K</kbd>
          </button>
          <HealthWidget wsStatus={wsStatus} repo={repo} />
          <button onClick={exportReport} className="btn-ghost" title="Download JSON report">⭳ export</button>
          <button onClick={() => guard(actions.runIteration, 'Iteration started')} disabled={busy || control?.running} className="btn-ghost" title="Run one iteration now">
            ▶ run once
          </button>

          {control?.looping ? (
            <>
              <button
                onClick={() => guard(actions.restartLoop, 'Loop restarted')}
                disabled={busy}
                className="btn-ghost"
                title="Cancel any stuck iteration and restart the loop"
              >
                ↻ restart
              </button>
              <button onClick={() => guard(actions.stopLoop)} disabled={busy} className="btn-danger">■ stop pipeline</button>
            </>
          ) : (
            <button onClick={() => guard(actions.startLoop)} disabled={busy} className="btn-primary">▶ start pipeline</button>
          )}
        </header>

        {wsStatus !== 'online' && (
          <div className="flex items-center gap-2 border-b border-amber-900/50 bg-amber-950/30 px-5 py-1.5 text-[11px] text-amber-300">
            <Spinner className="text-amber-400" /> connection lost — reconnecting to the control plane…
          </div>
        )}
        {error && (
          <div className="flex items-center gap-2 border-b border-rose-900/60 bg-rose-950/40 px-5 py-1.5 text-[11px] text-rose-300">
            {error}
            <button onClick={actions.refetch} className="underline hover:text-white">retry</button>
          </div>
        )}

        {/* Shows only while a run is in flight — a permanent "idle" bar would be furniture. */}
        {/* Everything the spotlight below says visually, said once, politely, for a screen reader.
            Mounted always so the region exists before its text does — a live region added to the
            DOM at the same moment as its content is not reliably announced. */}
        <LiveAnnouncer activeRun={store.activeRun} events={events} />
        <ActivitySpotlight activeRun={store.activeRun} iteration={iteration} onOpen={() => go('flow')} />

        <main id="main" tabIndex={-1} className="min-h-0 flex-1 overflow-auto p-4">
          {/* Keyed by `page`, not `view`: on a merged page a tab change is a change of `view`, and
              keying by it would unmount the tablist along with the panel — the focus ring would jump
              off the button just pressed and arrow-key movement would stop after one key. Each tab
              panel carries its own boundary inside TabbedView, so a crash is still contained. */}
          <ErrorBoundary key={page}>
          <Suspense fallback={<div className="grid h-full place-items-center text-slate-500"><Spinner /></div>}>
          {page === 'overview' && (
            <Overview metrics={metrics} orchestrator={orch} events={events} agents={agents} proposals={proposals} thoughts={thoughts} onOpenProposal={setOpenId} iteration={iteration} managers={managers} codeStats={codeStats} onNavigate={go} />
          )}
          {/*
            * MERGED PAGES. Each renders the EXISTING view components, unchanged, one per tab —
            * so no feature is lost in the merge. The old ids (`#/flow`, `#/iterations`, …) still
            * resolve here through `resolveRoute`, so bookmarks and cross-view `onNavigate` calls
            * keep working. Only the visible tab mounts: these views poll, and mounting three at
            * once would triple the request rate to show one.
            */}
          {page === 'runs' && (
            <TabbedView
              label="Runs"
              active={tab}
              onTabChange={(t) => go(routeFor('runs', t))}
              tabs={[
                { id: 'runs', label: 'Problems', icon: '⚠', hint: 'runs that ended badly, and what a restart would do', render: () => <Runs control={control} toast={toast} /> },
                { id: 'iterations', label: 'All runs', icon: '⟳', hint: 'every iteration with its scores, tasks and diff', render: () => <div className="h-full"><Iterations iteration={iteration} control={control} actions={actions} thoughts={thoughts} toast={toast} /></div> },
                { id: 'flow', label: 'Live', icon: '⇉', hint: 'what the fleet is doing right now', render: () => <div className="h-full"><Flow events={events} orchestrator={orch} iteration={iteration} activeRun={store.activeRun} /></div> },
              ]}
            />
          )}
          {page === 'plans' && <Plans plans={plans} />}
          {page === 'summary' && <Summary toast={toast} />}
          {page === 'context' && <Context toast={toast} />}
          {page === 'projects' && <Projects user={user} activeId={activeProject?.id} onSwitch={switchProject} toast={toast} />}
          {page === 'services' && <div className="h-full"><Services managers={managers} /></div>}
          {page === 'workbench' && (
            <TabbedView
              label="Workbench"
              active={tab}
              onTabChange={(t) => go(routeFor('workbench', t))}
              tabs={[
                { id: 'workbench', label: 'Boot check', icon: '🔧', hint: 'the gate that runs inside an iteration', render: () => <div className="h-full"><Workbench iteration={iteration} managers={managers} events={events} /></div> },
                { id: 'repair', label: 'Diagnose & repair', icon: '🩻', hint: 'the same check on demand, with a repair attempt', render: () => <Repair toast={toast} /> },
              ]}
            />
          )}
          {page === 'models' && <Models toast={toast} events={events} />}
          {page === 'explorer' && <div className="h-full"><Explorer proposals={proposals} onOpenProposal={setOpenId} toast={toast} /></div>}
          {page === 'runtime' && <div className="h-full"><Runtime /></div>}
          {page === 'backlog' && <div className="h-full"><Backlog actions={actions} toast={toast} /></div>}
          {page === 'deploy' && <Deploy deploy={deploy} repo={repo} actions={actions} />}
          {page === 'cloud' && <Cloud toast={toast} />}
          {page === 'kpi' && <KPI iteration={iteration} actions={actions} />}
          {/* `onNavigate` turns each notification into an action: a feed you can only scroll is a log. */}
          {page === 'notifications' && <Notifications notifications={notifications} actions={actions} onNavigate={go} />}
          {page === 'managers' && <Managers managers={managers} />}
          {page === 'reliability' && <Reliability managers={managers} toast={toast} />}
          {page === 'memory' && (
            <TabbedView
              label="Memory"
              active={tab}
              onTabChange={(t) => go(routeFor('memory', t))}
              tabs={[
                { id: 'memory', label: 'What it knows', icon: '🗃', hint: 'lessons, patterns and pitfalls the fleet has recorded', render: () => <Memory toast={toast} /> },
                { id: 'decisions', label: 'How it routes', icon: '🧠', hint: 'the learned agent × area competence graph', render: () => <Decisions toast={toast} /> },
              ]}
            />
          )}
          {/* `user` is needed for the segregation-of-duties check: the inbox must be able to tell
              the reviewer they authored a change BEFORE they try to approve it. */}
          {page === 'review' && <Review toast={toast} user={user} />}
          {page === 'security' && (
            <TabbedView
              label="Security and rules"
              active={tab}
              onTabChange={(t) => go(routeFor('security', t))}
              tabs={[
                { id: 'security', label: 'Gate findings', icon: '🔒', hint: 'what the security gate found on real diffs', render: () => <Security toast={toast} /> },
                { id: 'compliance', label: 'Best practices', icon: '📋', hint: 'the rule catalogue and where the code breaks it', render: () => <Compliance codeStats={codeStats} toast={toast} /> },
                { id: 'governance', label: 'Policy', icon: '⚖', hint: 'quality gates, protected paths, egress, licences, webhooks', render: () => <Governance toast={toast} /> },
              ]}
            />
          )}
          {page === 'health' && (
            <TabbedView
              label="Metrics"
              active={tab}
              onTabChange={(t) => go(routeFor('health', t))}
              tabs={[
                { id: 'health', label: 'Codebase health', icon: '🩹', hint: 'the composite score, tracked over time', render: () => <Health toast={toast} /> },
                { id: 'analytics', label: 'Run analytics', icon: '▦', hint: 'how the loop is performing across runs', render: () => <Analytics metrics={metrics} iteration={iteration} plans={plans} /> },
                { id: 'telemetry', label: 'Cost & tokens', icon: '◫', hint: 'what the fleet is spending', render: () => <Telemetry metrics={metrics} runs={runs} /> },
              ]}
            />
          )}
          {page === 'insight' && <Insight onNavigate={go} />}
          {page === 'digest' && <Digest />}
          {page === 'scope' && <Scope toast={toast} />}
          {page === 'fleet' && <Fleet agents={agents} orchestrator={orch} metrics={metrics} thoughts={thoughts} runs={runs} actions={actions} />}
          {page === 'proposals' && <div className="h-full"><Proposals proposals={proposals} onOpen={setOpenId} selectedId={openId} /></div>}
          {page === 'logs' && <div className="h-full"><Logs logs={logs} /></div>}
          {page === 'settings' && <SettingsView orchestrator={orch} iteration={iteration} actions={actions} theme={theme} toggleTheme={toggleTheme} toast={toast} />}
          {page === 'admin' && (isAdmin ? <Admin user={user} toast={toast} onConfigSaved={loadDashCfg} onNavigate={go} /> : <div className="p-8 text-center text-slate-500">Administrator access required.</div>)}
          </Suspense>
          </ErrorBoundary>
        </main>
      </div>

      <CommandPalette
        open={paletteOpen}
        onClose={() => setPaletteOpen(false)}
        nav={NAV}
        actions={paletteActions}
        data={{ proposals, iterations: iteration?.recent, features: [] }}
        onNavigate={go}
      />

      {/* ── Copilot slide-over ──────────────────────────────── */}
      <div
        className={`fixed inset-y-0 right-0 z-40 flex w-[420px] max-w-full flex-col border-l border-ink-800 bg-ink-950 shadow-2xl transition-transform duration-200 ${
          chatOpen ? 'translate-x-0' : 'translate-x-full'
        }`}
      >
        <Chat onStateChange={actions.refetch} onClose={() => setChatOpen(false)} />
      </div>
      {chatOpen && <div className="fixed inset-0 z-30 bg-black/40" onClick={() => setChatOpen(false)} />}

      {openId != null && <ProposalDetail id={openId} onClose={() => setOpenId(null)} onChanged={actions.refetch} />}
    </div>
  );
}

const Stat = ({ label, value, warn }) => (
  <span className="flex items-baseline gap-1">
    <span className="text-slate-600">{label}</span>
    <span className={`font-mono font-semibold ${warn ? 'text-amber-400' : 'text-slate-300'}`}>{value ?? '—'}</span>
  </span>
);
