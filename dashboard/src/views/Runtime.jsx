import { useEffect, useRef, useState } from 'react';
import { api } from '../api.js';
import { useResource } from '../hooks.js';
import { Resource } from '../components/Resource.jsx';
import { SAFETY_NET_LIVE_MS } from '../liveKeys.js';
import { Spinner, ago } from '../components/ui.jsx';
import { accentHex } from '../components/charts.jsx';
import TabbedView from '../components/TabbedView.jsx';
import SchemaPanel from './SchemaPanel.jsx';

const STATE = {
  stopped: { label: 'stopped', tint: 'slate' },
  starting: { label: 'starting', tint: 'sky' },
  up: { label: 'running', tint: 'emerald' },
  healing: { label: 'ops agent healing', tint: 'amber' },
  error: { label: 'error', tint: 'rose' },
};

/**
 * Runtime view: boot the RentAll stack under docker compose for either the `main`
 * working tree or the work branch, watch the live compose logs, and let the Ops
 * agent auto-heal failures. One target runs at a time (shared ports).
 */
export default function Runtime() {
  const [busy, setBusy] = useState(false);
  const [browseOpen, setBrowseOpen] = useState(false);
  const [tab, setTab] = useState('containers');
  const logRef = useRef(null);

  // The hand-rolled "refetch when a runtime.* event arrives" listener that used to sit here is now
  // the shared mapping in liveKeys.js, so the 4-second poll underneath it is gone too.
  const res = useResource('runtime', api.runtime, { interval: SAFETY_NET_LIVE_MS });
  const { data: rt, refetch: load } = res;

  useEffect(() => {
    if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight;
  }, [rt?.logs]);

  const act = async (fn) => {
    setBusy(true);
    try {
      await fn();
      await load();
    } finally {
      setBusy(false);
    }
  };

  if (!rt) return <div className="p-4"><Resource {...res} rows={4} emptyTitle="No runtime information" /></div>;

  const st = STATE[rt.state] || STATE.stopped;
  const dockerOk = rt.docker?.running;
  const running = rt.state === 'up';

  return (
    <div className="flex h-full flex-col gap-3">
      {/* control bar */}
      <div className="card p-3">
        <div className="flex flex-wrap items-center gap-3">
          <div className="flex items-center gap-2">
            <span className="grid h-8 w-8 place-items-center rounded-lg bg-sky-500/15 text-base">🐳</span>
            <div>
              <div className="text-[13px] font-semibold text-white">Container runtime</div>
              <div className="text-[10px] text-slate-500">docker compose · one target at a time</div>
            </div>
          </div>

          {/* target switch */}
          <div className="flex rounded-lg bg-ink-950 p-0.5 text-[11px]">
            {[['main', 'main'], ['work', 'work branch']].map(([id, label]) => (
              <button
                key={id}
                disabled={running || busy}
                onClick={() => act(() => api.runtimeTarget(id))}
                className={`rounded-md px-3 py-1 font-medium transition-colors disabled:opacity-40 ${rt.target === id ? 'bg-ink-700 text-white' : 'text-slate-500 hover:text-slate-300'}`}
              >
                {label}
              </button>
            ))}
          </div>

          <span className="pill" style={{ background: accentHex(st.tint) + '22', color: accentHex(st.tint) }}>
            {(rt.state === 'starting' || rt.state === 'healing') && <Spinner className="h-2.5 w-2.5" />} {st.label}
          </span>

          <div className="flex-1" />

          <label className="flex items-center gap-1.5 text-[11px] text-slate-400">
            <input type="checkbox" checked={rt.autoHeal} onChange={(e) => act(() => api.runtimeAutoHeal(e.target.checked))} className="accent-emerald-500" />
            auto-heal
          </label>

          {running ? (
            <>
              <button className="btn-ghost" disabled={busy} onClick={() => act(api.runtimeRestart)}>↻ restart</button>
              <button className="btn-danger" disabled={busy} onClick={() => act(api.runtimeDown)}>■ stop</button>
            </>
          ) : (
            <button className="btn-primary" disabled={busy || !dockerOk} onClick={() => act(api.runtimeUp)}>▶ start ({rt.target})</button>
          )}
          <button className="btn-ghost" disabled={busy || running} onClick={() => act(api.runtimeHeal)} title="Run the ops agent now">✚ heal</button>
        </div>

        {/* compose file selection — pick from those found in the project, or browse */}
        <div className="mt-2 flex flex-wrap items-center gap-2 border-t border-ink-800 pt-2">
          <span className="text-[10px] font-semibold uppercase tracking-wide text-slate-500">compose file</span>
          <select
            aria-label="Compose file to run"
            value={rt.composeFile || ''}
            disabled={busy}
            onChange={(e) => act(() => api.runtimeSetCompose(e.target.value))}
            className="max-w-[380px] rounded-lg border border-ink-700 bg-ink-950 px-2 py-1 text-[11px] text-slate-200"
          >
            {rt.composeFile && !(rt.composeFiles || []).some((f) => f.rel === rt.composeFile) && (
              <option value={rt.composeFile}>{rt.composeFile}</option>
            )}
            {(rt.composeFiles || []).map((f) => (
              <option key={f.rel} value={f.rel}>{f.rel}</option>
            ))}
            {!(rt.composeFiles || []).length && !rt.composeFile && <option value="">no compose file found</option>}
          </select>
          <button className="btn-ghost" disabled={busy} onClick={() => setBrowseOpen(true)}>⌕ browse…</button>
          <span className="text-[10px] text-slate-600">{(rt.composeFiles || []).length} found in project</span>
          {running && <span className="text-[10px] text-amber-400">↻ restart to apply a change</span>}
        </div>

        {!dockerOk && (
          <div className="mt-2 rounded-lg border border-amber-900/50 bg-amber-950/30 px-3 py-1.5 text-[11px] text-amber-300">
            {rt.docker?.error || 'Docker is not available.'} {rt.docker?.installed && !rt.docker?.running && 'Start Docker Desktop, then press start.'}
          </div>
        )}
        {rt.lastError && dockerOk && (
          <div className="mt-2 rounded-lg border border-rose-900/50 bg-rose-950/30 px-3 py-1.5 text-[11px] text-rose-300">
            {rt.lastError}
          </div>
        )}
      </div>

      {/*
        * The stack-level controls stay above the tabs, because they apply to both: which target
        * runs and which compose file it uses are the same facts whether you are watching logs or
        * reading the schema.
        */}
      <div className="min-h-0 flex-1">
      <TabbedView
        label="Runtime"
        active={tab}
        onTabChange={setTab}
        tabs={[
          {
            id: 'containers',
            label: 'Containers',
            icon: '🐳',
            hint: 'each service, its state, and the controls to stop, restart or rebuild it',
            render: () => (
      <div className="grid h-full min-h-0 grid-cols-[220px_minmax(0,1fr)] gap-3">
        {/* services */}
        <div className="card flex min-h-0 flex-col">
          <h3 className="border-b border-ink-800 px-3 py-2 text-xs font-semibold uppercase tracking-wide text-slate-400">Services</h3>
          <div className="min-h-0 flex-1 overflow-auto p-2">
            {rt.services?.length ? (
              <ul className="space-y-1.5">
                {rt.services.map((s) => (
                  <ServiceRow key={s.name} service={s} onDone={load} />
                ))}
              </ul>
            ) : (
              <div className="px-2 py-6 text-center text-[11px] text-slate-600">
                {running ? 'querying…' : 'not running'}
              </div>
            )}
          </div>
          {running && (
            <div className="border-t border-ink-800 p-2 text-[10px] text-slate-500">
              <a href="http://localhost:5173" target="_blank" rel="noreferrer" className="block hover:text-emerald-400">▸ frontend :5173</a>
              <a href="http://localhost:4000/api" target="_blank" rel="noreferrer" className="block hover:text-emerald-400">▸ backend :4000</a>
            </div>
          )}
        </div>

        {/* logs */}
        <div className="card flex min-h-0 flex-col">
          <div className="flex items-center gap-2 border-b border-ink-800 px-3 py-2">
            <h3 className="text-xs font-semibold uppercase tracking-wide text-slate-400">Compose logs</h3>
            {rt.healAttempts > 0 && <span className="text-[10px] text-amber-400">heal attempts: {rt.healAttempts}/3</span>}
            <div className="flex-1" />
            <span className="font-mono text-[10px] text-slate-600">{rt.logs?.length || 0} lines</span>
          </div>
          <div ref={logRef} className="min-h-0 flex-1 overflow-auto bg-ink-950/60 p-2 font-mono text-[11px] leading-relaxed">
            {!rt.logs?.length ? (
              <div className="grid h-full place-items-center text-slate-600">
                No logs yet. Press start to boot the {rt.target} stack.
              </div>
            ) : (
              rt.logs.map((l, i) => (
                <div key={i} className={`px-1 ${l.level === 'error' ? 'text-rose-300' : 'text-slate-400'}`}>
                  <span className="mr-2 text-slate-700">{new Date(l.ts).toLocaleTimeString('it-IT', { hour12: false })}</span>
                  {l.line}
                </div>
              ))
            )}
          </div>
        </div>
      </div>
            ),
          },
          {
            id: 'schema',
            label: 'Prisma schema',
            icon: '🗄',
            hint: 'the models on disk, and whether the live database still has the columns they name',
            render: () => <SchemaPanel />,
          },
        ]}
      />
      </div>

      {browseOpen && (
        <BrowseModal
          current={rt.composeFile}
          onClose={() => setBrowseOpen(false)}
          onPick={(rel) => {
            setBrowseOpen(false);
            act(() => api.runtimeSetCompose(rel));
          }}
        />
      )}
    </div>
  );
}

/** A small project-scoped file browser for picking a compose file manually. */
function BrowseModal({ current, onClose, onPick }) {
  const [node, setNode] = useState(null);
  const [error, setError] = useState(null);

  const go = (dir) =>
    api
      .runtimeBrowse(dir)
      .then((n) => {
        setNode(n);
        setError(null);
      })
      .catch((e) => setError(e.message));
  useEffect(() => {
    go('');
  }, []);

  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-black/50 p-4" onClick={onClose}>
      <div className="flex max-h-[70vh] w-[560px] max-w-full flex-col rounded-xl border border-ink-700 bg-ink-950" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center gap-2 border-b border-ink-800 px-3 py-2">
          <span className="text-xs font-semibold uppercase tracking-wide text-slate-400">Browse for a compose file</span>
          <div className="flex-1" />
          <button onClick={onClose} className="btn-ghost">✕</button>
        </div>

        <div className="border-b border-ink-800 px-3 py-1.5 font-mono text-[11px] text-slate-500">
          /{node?.cwd || ''}
        </div>

        {error && <div className="px-3 py-2 text-[11px] text-rose-300">{error}</div>}

        <div className="min-h-0 flex-1 overflow-auto p-2">
          {node?.parent !== null && node?.cwd !== '' && (
            <button onClick={() => go(node.parent)} className="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-[12px] text-slate-400 hover:bg-ink-800">
              <span>📁</span> ..
            </button>
          )}
          {(node?.dirs || []).map((d) => (
            <button
              key={d}
              onClick={() => go(node.cwd ? `${node.cwd}/${d}` : d)}
              className="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-[12px] text-slate-300 hover:bg-ink-800"
            >
              <span>📁</span> {d}
            </button>
          ))}
          {(node?.files || []).map((f) => {
            const rel = node.cwd ? `${node.cwd}/${f.name}` : f.name;
            return (
              <button
                key={f.name}
                onClick={() => onPick(rel)}
                className={`flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-[12px] hover:bg-ink-800 ${
                  rel === current ? 'text-brand-light' : f.isCompose ? 'text-emerald-300' : 'text-slate-400'
                }`}
              >
                <span>{f.isCompose ? '🐳' : '📄'}</span>
                <span className="flex-1">{f.name}</span>
                {rel === current && <span className="text-[10px]">current</span>}
                {f.isCompose && rel !== current && <span className="text-[10px] text-slate-600">select</span>}
              </button>
            );
          })}
          {node && !node.dirs.length && !node.files.length && node.cwd === '' && (
            <div className="px-2 py-6 text-center text-[11px] text-slate-600">No folders or YAML files here.</div>
          )}
        </div>
        <div className="border-t border-ink-800 px-3 py-1.5 text-[10px] text-slate-600">
          🐳 = docker-compose file · click a YAML file to use it
        </div>
      </div>
    </div>
  );
}

/**
 * One container, with the controls an operator reaches for when it misbehaves.
 *
 * Until now the only controls were stack-wide: stop everything, restart everything. When two of
 * eight services were crash-looping on a syntax error, bringing down the other six — including
 * Postgres — was the only offered response.
 *
 * `stop` halts this container and leaves its volumes and network alone, so `start` returns the same
 * instance. `rebuild` is separate and labelled as slow because it is a different operation: it
 * re-runs the image build, which is what a change to a Dockerfile step needs — `prisma generate`,
 * for one, runs at build time, so a schema edit is invisible to a plain restart.
 *
 * None of these can delete data: the server refuses any compose invocation carrying `-v`, the flag
 * that would remove the database volume.
 */
function ServiceRow({ service, onDone }) {
  const [busy, setBusy] = useState(null);
  const [error, setError] = useState(null);

  const run = async (action) => {
    setBusy(action);
    setError(null);
    try {
      const r = await api.runtimeService(service.name, action);
      if (!r.ok) setError((r.output || '').trim().split('\n').slice(-2).join(' ') || `${action} failed`);
      await onDone?.();
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(null);
    }
  };

  const up = /run|healthy|up/i.test(service.state);
  const dead = /exit|dead|restarting/i.test(service.state);

  return (
    <li className="rounded-lg bg-ink-800/50 px-2 py-1.5">
      <div className="flex items-center gap-1.5">
        <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${up ? 'bg-emerald-400' : dead ? 'bg-rose-400' : 'bg-amber-400'}`} />
        <span className="truncate text-[12px] text-slate-200">{service.name}</span>
      </div>
      <div className="pl-3 text-[10px] text-slate-500">{service.state}{service.ports ? ` · :${service.ports}` : ''}</div>
      <div className="mt-1 flex flex-wrap gap-1 pl-3">
        {up ? (
          <SvcBtn label="stop" busy={busy} action="stop" onRun={run} hint="Halt this container. Its data volume is untouched." />
        ) : (
          <SvcBtn label="start" busy={busy} action="start" onRun={run} hint="Bring this container back up." />
        )}
        <SvcBtn label="restart" busy={busy} action="restart" onRun={run} hint="Restart in place — no rebuild." />
        <SvcBtn label="rebuild" busy={busy} action="rebuild" onRun={run} hint="Rebuild the image and recreate. Slow, and the only way to re-run build steps such as prisma generate." />
      </div>
      {error && <div className="mt-1 pl-3 text-[10px] text-rose-400">{error}</div>}
    </li>
  );
}

const SvcBtn = ({ label, action, busy, onRun, hint }) => (
  <button
    onClick={() => onRun(action)}
    disabled={!!busy}
    title={hint}
    className="rounded border border-ink-700 px-1.5 py-0.5 text-[10px] text-slate-400 transition-colors hover:bg-ink-700 hover:text-white disabled:opacity-40"
  >
    {busy === action ? <Spinner /> : label}
  </button>
);
