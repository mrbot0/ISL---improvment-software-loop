import { useEffect, useState } from 'react';
import { api } from '../api.js';
import { useResource } from '../hooks.js';
import { Resource } from '../components/Resource.jsx';
import { Empty, Spinner, ago } from '../components/ui.jsx';
import { useConfirm } from '../components/ConfirmDialog.jsx';

/**
 * MODELS — get a brain, then give it to the agents.
 *
 * Choosing among installed models already lived in Settings. What had no home anywhere was the step
 * before it: obtaining a model that is not installed yet meant leaving the product for a terminal.
 *
 * The page is built around one honest sequence — **download → prove it answers → assign** — because
 * the failure mode of skipping the middle step is every agent in the fleet failing on the next run,
 * reported as `fetch failed`, with nothing on screen connecting that to the model someone swapped in.
 */

const ROLE_BLURB = {
  implement: 'writes the code',
  review: 'grades the diff',
  security: 'scans for secrets and weakened controls',
  plan: 'turns findings into tasks',
  research: 'reads the web for prior art',
};

const bytes = (n) => {
  if (!n) return '';
  const gb = n / 1e9;
  return gb >= 1 ? `${gb.toFixed(1)} GB` : `${Math.round(n / 1e6)} MB`;
};

export default function Models({ toast, events }) {
  const [name, setName] = useState('');
  const [roles, setRoles] = useState([]);
  const [alsoChat, setAlsoChat] = useState(true);
  const [busy, setBusy] = useState(false);
  const [confirm, confirmUI] = useConfirm();

  const res = useResource('model-pulls', () => api.modelPulls(), { interval: 15000 });
  const { data, refetch } = res;
  const installed = useResource('models-installed', () => api.models(), { interval: 60000 });

  // A download emits progress on the socket. Refetching on those events keeps the bars moving
  // without polling every second for the ~99% of the time nothing is downloading.
  useEffect(() => {
    const last = events?.[events.length - 1];
    if (last?.type === 'model.pull' || last?.type === 'model.adopted') refetch();
  }, [events, refetch]);

  useEffect(() => { if (data?.roles?.length && !roles.length) setRoles(data.roles); }, [data?.roles]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!data) return <Resource {...res} rows={3} emptyTitle="Models unavailable" />;

  const act = async (fn, msg) => {
    setBusy(true);
    try {
      const r = await fn();
      if (r?.error) toast?.(r.error, { type: 'error' });
      else if (msg) toast?.(msg, { type: 'success' });
      await refetch();
      await installed.refetch?.();
      return r;
    } catch (e) {
      toast?.(e.message, { type: 'error' });
    } finally {
      setBusy(false);
    }
  };

  // `detected.models`, not `detected.ollama.models`: the detection payload has no `ollama` key (it
  // has `providers.ollama` for status). The wrong path meant this list was always empty.
  const chatModels = (installed.data?.detected?.models || []).filter((m) => m.chat);
  const assignment = data.assignment || {};

  return (
    <div className="mx-auto max-w-4xl space-y-4">
      {confirmUI}

      {/*
        * THE STRONGEST MODELS YOU ALREADY HAVE.
        *
        * The page used to open on an empty text field, which is only useful to someone who already
        * knows the exact tag they want. This opens on what is installed and usable, ranked.
        */}
      {data.top?.models?.length > 0 && (
        <div className="card p-4">
          <div className="flex items-baseline gap-2">
            <h3 className="text-[10px] font-semibold uppercase tracking-wide text-slate-500">Best local models</h3>
            <span className="text-[10px] text-slate-600">{data.top.total} chat model(s) installed</span>
          </div>
          {/* The ranking rule, stated. Quality on a given codebase is not something Ollama reports,
              and a score invented from a name would be a guess wearing a measurement's clothes. */}
          <p className="mt-0.5 text-[10px] leading-relaxed text-slate-600">{data.top.rule}</p>
          <ul className="mt-2 space-y-1">
            {data.top.models.map((m) => {
              const inUse = Object.values(assignment).includes(m.id);
              return (
                <li key={m.id} className="flex items-center gap-2 text-[12px]">
                  <span className="w-4 shrink-0 text-right font-mono text-[10px] text-slate-600">{m.rank}</span>
                  <span className="min-w-0 flex-1 truncate font-mono text-slate-200" title={m.id}>{m.id}</span>
                  {m.paramsB && <span className="pill bg-ink-800 text-slate-400">{m.paramsB}B</span>}
                  {m.sizeGB && <span className="shrink-0 font-mono text-[10px] text-slate-600">{m.sizeGB} GB</span>}
                  {inUse ? (
                    <span className="pill bg-emerald-500/15 text-emerald-300" title="already assigned to at least one role">in use</span>
                  ) : (
                    <button
                      className="btn-ghost"
                      disabled={busy || !roles.length}
                      onClick={async () => {
                        const r = await act(() => api.adoptModel(m.id, { roles, chat: alsoChat }), null);
                        if (r?.adopted) toast?.(`${m.id} assigned to ${roles.join(', ')}`, { type: 'success' });
                      }}
                      title={roles.length ? `Test it, then assign to ${roles.join(', ')}` : 'Select at least one role below'}
                    >
                      Apply
                    </button>
                  )}
                  <span className="hidden shrink-0 text-[10px] text-slate-600 sm:inline" title="why it ranks here">{m.why}</span>
                </li>
              );
            })}
          </ul>
        </div>
      )}

      {/* ── download ─────────────────────────────────────────────────────────── */}
      <div className="card p-4">
        <h3 className="text-[10px] font-semibold uppercase tracking-wide text-slate-500">Download a model</h3>
        <p className="mt-1 text-[11px] leading-relaxed text-slate-500">
          The name is passed to your Ollama, which fetches the weights from its own registry — ISL
          does not choose where they come from. Use the exact tag, e.g. <code className="font-mono">qwen3:14b</code>.
        </p>
        <div className="mt-2 flex flex-wrap gap-2">
          <input
            className="input min-w-[220px] flex-1"
            placeholder="model:tag"
            value={name}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter' && name.trim() && !busy) act(() => api.pullModel(name.trim()), `Downloading ${name.trim()}…`); }}
          />
          <button
            className="btn-ghost"
            disabled={busy || !name.trim()}
            onClick={() => act(() => api.pullModel(name.trim()), `Downloading ${name.trim()} — progress below`)}
            title="Download only. Nothing is assigned to the agents."
          >
            ↓ Download
          </button>
          <button
            className="btn-primary"
            disabled={busy || !name.trim() || !roles.length}
            onClick={async () => {
              const target = name.trim();
              if (!(await confirm({
                title: `Download ${target} and give it to the agents?`,
                message: `It will be tested with a real prompt first. If it does not answer, the ${roles.length} selected role(s) keep the model they have. A large model can take a long time to download.`,
                confirmLabel: 'Download & apply',
                tone: 'primary',
              }))) return;
              const r = await act(() => api.pullModel(target, { adopt: true, roles, chat: alsoChat }), null);
              if (r?.ok) toast?.(`${target} downloaded, tested and assigned to ${roles.join(', ')}`, { type: 'success' });
              else if (r && !r.error) toast?.(r.adoption?.error || r.state?.error || 'the download did not complete', { type: 'error' });
            }}
            title="Download, verify it answers, then assign it to the selected roles"
          >
            ↓ Download &amp; apply
          </button>
        </div>
      </div>

      {/* ── in flight ────────────────────────────────────────────────────────── */}
      {data.active?.length > 0 && (
        <div className="card p-4">
          <h3 className="mb-2 text-[10px] font-semibold uppercase tracking-wide text-slate-500">Downloading</h3>
          <ul className="space-y-3">
            {data.active.map((p) => (
              <li key={p.model}>
                <div className="flex items-baseline gap-2">
                  <Spinner className="text-sky-400" />
                  <span className="font-mono text-[12px] text-slate-200">{p.model}</span>
                  <span className="text-[11px] text-slate-500">{p.status}</span>
                  {p.layer && <span className="font-mono text-[10px] text-slate-600">layer {p.layer}</span>}
                  <span className="ml-auto font-mono text-[11px] tabular-nums text-slate-400">
                    {/* Bytes, not just a percentage: on a slow link the percentage can sit still for
                        minutes while the download is perfectly healthy. */}
                    {p.pct != null ? `${p.pct}%` : ''} {p.total ? `· ${bytes(p.completed)} / ${bytes(p.total)}` : ''}
                  </span>
                  <button className="btn-ghost" disabled={busy} onClick={() => act(() => api.cancelPull(p.model), `Cancelled ${p.model}`)}>✕</button>
                </div>
                <div className="mt-1 h-1.5 overflow-hidden rounded-sm bg-ink-800">
                  <div className="h-full rounded-sm bg-sky-500/70 transition-[width] duration-500" style={{ width: `${p.pct ?? 2}%` }} />
                </div>
              </li>
            ))}
          </ul>
        </div>
      )}

      {data.recent?.length > 0 && (
        <div className="card p-4">
          <h3 className="mb-2 text-[10px] font-semibold uppercase tracking-wide text-slate-500">Recent downloads</h3>
          <ul className="space-y-1">
            {data.recent.map((p) => (
              <li key={`${p.model}-${p.finishedAt}`} className="flex items-baseline gap-2 text-[11px]">
                <span className={p.ok ? 'text-emerald-400' : 'text-rose-400'}>{p.ok ? '✓' : '✕'}</span>
                <span className="font-mono text-slate-300">{p.model}</span>
                <span className="text-slate-500">{p.ok ? 'downloaded' : p.error}</span>
                <span className="ml-auto font-mono text-[10px] text-slate-600">{ago(p.finishedAt)}</span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* ── who gets it ──────────────────────────────────────────────────────── */}
      <div className="card p-4">
        <h3 className="text-[10px] font-semibold uppercase tracking-wide text-slate-500">Which agents get the new model</h3>
        <ul className="mt-2 space-y-1.5">
          {(data.roles || []).map((r) => (
            <li key={r} className="flex items-center gap-2">
              <input
                id={`role-${r}`}
                type="checkbox"
                className="h-3.5 w-3.5 accent-brand"
                checked={roles.includes(r)}
                onChange={(e) => setRoles((prev) => (e.target.checked ? [...prev, r] : prev.filter((x) => x !== r)))}
              />
              <label htmlFor={`role-${r}`} className="text-[12px] text-slate-200">{r}</label>
              <span className="text-[11px] text-slate-600">{ROLE_BLURB[r] || ''}</span>
              {/* What it would replace. Assigning without seeing this is how a working setup is
                  quietly swapped for an untried one. */}
              <span className="ml-auto font-mono text-[10px] text-slate-500" title="currently assigned">
                {assignment[r] || 'default'}
              </span>
            </li>
          ))}
          <li className="flex items-center gap-2 border-t border-ink-800 pt-2">
            <input id="role-chat" type="checkbox" className="h-3.5 w-3.5 accent-brand" checked={alsoChat} onChange={(e) => setAlsoChat(e.target.checked)} />
            <label htmlFor="role-chat" className="text-[12px] text-slate-200">chat</label>
            <span className="text-[11px] text-slate-600">Alfred, and anything you ask directly</span>
            <span className="ml-auto font-mono text-[10px] text-slate-500">{assignment.chat || 'default'}</span>
          </li>
        </ul>
      </div>

      {/* ── already installed ────────────────────────────────────────────────── */}
      <div className="card p-4">
        <h3 className="mb-2 text-[10px] font-semibold uppercase tracking-wide text-slate-500">Installed &amp; ready</h3>
        {!chatModels.length ? (
          <Empty icon="◍" title="No chat models installed" hint="Download one above, or check that Ollama is running." />
        ) : (
          <ul className="space-y-1">
            {chatModels.map((m) => (
              <li key={m.id} className="flex items-center gap-2 text-[12px]">
                <span className="min-w-0 flex-1 truncate font-mono text-slate-200" title={m.id}>{m.id}</span>
                {m.params && <span className="pill bg-ink-800 text-slate-500">{m.params}</span>}
                {m.sizeGB && <span className="font-mono text-[10px] text-slate-600">{m.sizeGB} GB</span>}
                <button
                  className="btn-ghost"
                  disabled={busy || !roles.length}
                  onClick={async () => {
                    const r = await act(() => api.adoptModel(m.id, { roles, chat: alsoChat }), null);
                    if (r?.adopted) toast?.(`${m.id} assigned to ${roles.join(', ')}`, { type: 'success' });
                  }}
                  title={roles.length ? `Test it, then assign to ${roles.join(', ')}` : 'Select at least one role above'}
                >
                  Apply
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
