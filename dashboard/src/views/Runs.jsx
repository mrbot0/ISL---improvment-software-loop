import { useState } from 'react';
import { api } from '../api.js';
import { useResource } from '../hooks.js';
import { Resource } from '../components/Resource.jsx';
import { SAFETY_NET_MS } from '../liveKeys.js';
import { useConfirm } from '../components/ConfirmDialog.jsx';
import { Empty, Spinner, ago } from '../components/ui.jsx';
import { GatePills } from '../components/GateRecord.jsx';

/**
 * The Runs board: every iteration that ended badly — error, interrupted, empty, or
 * rolled back — in one place to triage. Each run says WHY it failed and what a restart
 * would do, shows how much of its plan landed vs failed, and can be restarted (it
 * replays the edits it had produced) or cleared from the board.
 */
const STATUS_STYLE = {
  error: 'bg-rose-500/15 text-rose-300',
  interrupted: 'bg-amber-500/15 text-amber-300',
  empty: 'bg-slate-500/15 text-slate-300',
  rolled_back: 'bg-fuchsia-500/15 text-fuchsia-300',
};
const STATUS_LABEL = { error: 'error', interrupted: 'interrupted', empty: 'empty', rolled_back: 'rolled back' };

const FILTERS = [
  { id: '', label: 'All problems' },
  { id: 'error', label: 'Error' },
  { id: 'interrupted', label: 'Interrupted' },
  { id: 'empty', label: 'Empty' },
  { id: 'rolled_back', label: 'Rolled back' },
];

export default function Runs({ toast }) {
  const [filter, setFilter] = useState('');
  const [busy, setBusy] = useState(false);
  const [confirm, confirmUI] = useConfirm();

  // The board changes when a run starts, finishes or is restarted — all of which arrive as events,
  // so a 5-second poll was asking a question the socket had already answered. The key carries the
  // filter so switching tabs paints from cache instead of flashing a spinner.
  const res = useResource(
    `runs:${filter || 'all'}`,
    () => api.problemRuns(filter || undefined),
    { interval: SAFETY_NET_MS },
  );
  const { data, refetch: load } = res;

  const act = async (fn, msg) => {
    setBusy(true);
    try {
      const r = await fn();
      if (r?.busy) toast?.('An iteration is running — try again in a moment.', { type: 'info' });
      else if (msg) toast?.(msg, { type: 'success' });
      await load();
    } catch (e) {
      toast?.(e.message, { type: 'error' });
    } finally {
      setBusy(false);
    }
  };

  // Was a bare spinner, and before that a `.catch` that raised a toast. Neither survived: a failed
  // fetch now says so, with a retry, instead of spinning forever or showing an empty board.
  if (!data) return <Resource {...res} rows={4} emptyTitle="No runs to show" />;

  const runs = data.runs || [];
  const restartable = runs.filter((r) => r.failure);

  return (
    <div className="mx-auto max-w-5xl space-y-4">
      {confirmUI}
      <div className="flex flex-wrap items-center gap-2">
        <div className="flex gap-1 rounded-lg bg-ink-900 p-1">
          {FILTERS.map((f) => (
            <button
              key={f.id}
              onClick={() => setFilter(f.id)}
              className={`rounded px-2.5 py-1 text-[12px] transition-colors ${filter === f.id ? 'bg-ink-700 text-white' : 'text-slate-400 hover:text-slate-200'}`}
            >
              {f.label}
            </button>
          ))}
        </div>
        <div className="flex-1" />
        {data.busy && <span className="pill bg-sky-500/15 text-sky-300"><Spinner className="mr-1" /> a run is executing</span>}
        <button
          disabled={busy || !restartable.length || data.busy}
          onClick={async () => {
            if (await confirm({ title: `Restart ${restartable.length} run(s)?`, message: 'They will be re-run back-to-back on the model — this can take a while.', confirmLabel: 'Restart all', tone: 'primary' }))
              act(() => api.restartAllRuns(), `Restarting ${restartable.length} run(s) back-to-back…`);
          }}
          className="btn-primary"
          title="Restart every restartable run, one after another"
        >
          ↻ Restart all ({restartable.length})
        </button>
        <button
          disabled={busy || !runs.length}
          onClick={async () => {
            if (await confirm({ title: 'Clear the board?', message: 'The failed runs stay in history — they are just removed from this board.', confirmLabel: 'Clear all' }))
              act(() => api.dismissAllRuns(), 'Board cleared');
          }}
          className="btn-ghost"
          title="Clear the board — runs stay in history"
        >
          Clear all
        </button>
      </div>

      <div className="grid gap-2 sm:grid-cols-4">
        <Tally label="On the board" value={runs.length} />
        <Tally label="Error" value={runs.filter((r) => r.status === 'error').length} tone="rose" />
        <Tally label="Interrupted" value={runs.filter((r) => r.status === 'interrupted').length} tone="amber" />
        <Tally label="Empty" value={runs.filter((r) => r.status === 'empty').length} />
      </div>

      {!runs.length ? (
        <Empty icon="✓" title="No failed runs" hint="Runs that end in error, interruption, or with no changes show up here to be restarted or cleared." />
      ) : (
        <div className="space-y-2">
          {runs.map((r) => <RunCard key={r.id} run={r} busy={busy || data.busy} onAct={act} />)}
        </div>
      )}
    </div>
  );
}

function RunCard({ run, busy, onAct }) {
  const [open, setOpen] = useState(false);
  const tc = run.taskCounts || {};
  const f = run.failure;

  return (
    <div className="card p-3">
      <div className="flex items-start gap-3">
        <span className={`pill ${STATUS_STYLE[run.status] || 'bg-ink-800 text-slate-400'}`}>{STATUS_LABEL[run.status] || run.status}</span>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="font-mono text-[10px] text-slate-500">#{run.id}</span>
            <span className="truncate text-[13px] font-medium text-slate-200">{run.planTitle || f?.title || 'Untitled run'}</span>
            {run.restarts > 0 && <span className="pill bg-ink-800 text-slate-500" title="times already restarted">↻{run.restarts}</span>}
          </div>
          {f?.title && run.planTitle && <div className="mt-0.5 text-[12px] text-rose-300/90">{f.title}</div>}
          <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-[11px] text-slate-500">
            <span>{ago(run.finishedAt || run.startedAt)}</span>
            {run.totalTasks > 0 && (
              <span>
                tasks: <span className="text-emerald-400">{tc.done || 0} done</span> · <span className="text-rose-400">{tc.failed || 0} failed</span>
                {tc.pending ? ` · ${tc.pending} pending` : ''}
              </span>
            )}
            <span>{run.filesChanged || 0} file(s) changed</span>
            {run.resumable ? <span className="text-sky-400">replayable</span> : null}
            <GatePills gates={run.gates} />
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          {f && (
            <button
              disabled={busy}
              onClick={() => onAct(() => api.controlRestart(run.id), `Restarting #${run.id}…`)}
              className="btn-primary"
              title={f.remedy || 'Restart this run'}
            >
              ↻ Restart
            </button>
          )}
          <button disabled={busy} onClick={() => onAct(() => api.dismissRun(run.id))} className="btn-ghost" title="Clear from board">✕</button>
        </div>
      </div>

      {(f?.explanation || f?.remedy) && (
        <button onClick={() => setOpen((v) => !v)} className="mt-2 text-[11px] text-slate-500 hover:text-slate-300">
          {open ? '▾ hide details' : '▸ why it failed & what restart does'}
        </button>
      )}
      {open && (
        <div className="mt-2 space-y-1.5 rounded border border-ink-800 bg-ink-950/40 p-2.5 text-[12px]">
          {f?.explanation && <div><span className="stat-label">Why</span><div className="text-slate-300">{f.explanation}</div></div>}
          {f?.remedy && <div><span className="stat-label">A restart will</span><div className="text-slate-300">{f.remedy}</div></div>}
          {run.error && !f?.explanation && <div className="text-slate-400">{run.error}</div>}
        </div>
      )}
    </div>
  );
}

const Tally = ({ label, value, tone }) => (
  <div className="card p-3">
    <div className="stat-label">{label}</div>
    <div className={`stat mt-1 ${tone === 'rose' ? 'text-rose-400' : tone === 'amber' ? 'text-amber-400' : 'text-white'}`}>{value}</div>
  </div>
);
