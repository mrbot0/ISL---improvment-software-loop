import { useState } from 'react';
import { api } from '../api.js';
import { useResource } from '../hooks.js';
import { Resource } from '../components/Resource.jsx';
import { SAFETY_NET_LIVE_MS } from '../liveKeys.js';
import { accentHex } from '../components/charts.jsx';
import { Spinner, Empty, ago, AGENT_META } from '../components/ui.jsx';
import DiffViewer from '../components/DiffViewer.jsx';
import { GateRecord } from '../components/GateRecord.jsx';

// Must match the engine's real phase names (src/iteration/engine.js PHASES). The
// second phase is "survey" (grounded codebase analysis), not "research" — the old
// label meant this step never lit up, because the engine never emits "research".
const PHASES = ['catalog', 'survey', 'plan', 'implement', 'review', 'security', 'regression', 'test', 'workbench', 'finalize'];

const ITER_STATUS = {
  running: 'bg-sky-500/15 text-sky-300',
  committed: 'bg-emerald-500/20 text-emerald-300',
  rolled_back: 'bg-amber-500/15 text-amber-300',
  rejected: 'bg-slate-500/15 text-slate-400',
  promoted: 'bg-emerald-600/25 text-emerald-200',
  empty: 'bg-slate-500/15 text-slate-500',
  error: 'bg-rose-500/15 text-rose-300',
  interrupted: 'bg-slate-500/15 text-slate-400',
};

/**
 * The failure taxonomy, in the operator's language. The distinction the whole
 * restart mechanism turns on: was the work STOPPED, or is it WRONG?
 */
const FAILURE = {
  interruption: {
    icon: '⏸',
    tint: 'text-slate-300',
    border: 'border-slate-600/50',
    bg: 'bg-slate-500/10',
    verdict: 'The run was stopped — nothing is known to be wrong with the work it did.',
  },
  implementation: {
    icon: '✕',
    tint: 'text-rose-300',
    border: 'border-rose-900/50',
    bg: 'bg-rose-950/30',
    verdict: 'The change itself is broken.',
  },
  infrastructure: {
    icon: '⚠',
    tint: 'text-amber-300',
    border: 'border-amber-900/50',
    bg: 'bg-amber-950/30',
    verdict: 'The machine got in the way — this says nothing about the change.',
  },
};

const scoreColor = (s) => (s == null ? 'slate' : s >= 80 ? 'emerald' : s >= 60 ? 'amber' : 'rose');

function ScoreRing({ score, size = 52, label }) {
  const r = (size - 8) / 2;
  const c = 2 * Math.PI * r;
  const hex = accentHex(scoreColor(score));
  const pct = (score ?? 0) / 100;
  return (
    <div className="flex flex-col items-center gap-1">
      <div className="relative grid place-items-center" style={{ width: size, height: size }}>
        <svg className="-rotate-90" width={size} height={size}>
          <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="rgb(var(--ink-800))" strokeWidth="4" />
          <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke={hex} strokeWidth="4" strokeLinecap="round" strokeDasharray={`${c * pct} ${c}`} />
        </svg>
        <span className="absolute text-xs font-bold" style={{ color: hex }}>{score ?? '—'}</span>
      </div>
      {label && <span className="text-[10px] uppercase tracking-wide text-slate-500">{label}</span>}
    </div>
  );
}

function PhaseStrip({ phases, live }) {
  const byName = Object.fromEntries((phases || []).map((p) => [p.phase, p]));
  return (
    <div className="flex items-center gap-1 overflow-x-auto">
      {PHASES.map((name, i) => {
        const p = byName[name];
        let st = p?.status;
        // A phase left "running" on an iteration that is no longer live was
        // interrupted mid-flight — reflect that instead of spinning forever.
        if (st === 'running' && !live) st = 'interrupted';
        const color =
          st === 'ok' ? 'emerald' : st === 'error' ? 'rose' : st === 'running' ? 'sky' : st === 'interrupted' ? 'amber' : 'slate';
        return (
          <div key={name} className="flex items-center gap-1">
            <div
              className="flex flex-col items-center rounded-md px-2 py-1"
              style={{ background: st ? `${accentHex(color)}18` : 'transparent', minWidth: 60 }}
              title={st === 'interrupted' ? `${name} — interrupted mid-run` : p?.summary || name}
            >
              <span className="flex items-center gap-1 text-[10px] font-medium" style={{ color: st ? accentHex(color) : 'rgb(var(--ink-500))' }}>
                {st === 'running' && <Spinner className="h-2.5 w-2.5" />}
                {st === 'interrupted' && <span>⏸</span>}
                {st === 'error' && <span>✕</span>}
                {name}
              </span>
              {p?.score != null && <span className="text-[10px] text-slate-500">{p.score}</span>}
            </div>
            {i < PHASES.length - 1 && <span className="text-[10px] text-slate-700">›</span>}
          </div>
        );
      })}
    </div>
  );
}

/**
 * The failure card. This is the answer to "why did it break, and what happens if I
 * press restart?" — stated plainly, because an operator should never have to open
 * a log file to learn whether their agent was interrupted or wrong.
 */
function FailureCard({ it, onRestart, busy }) {
  if (!it.failure) return null;
  const f = FAILURE[it.failure.kind] || FAILURE.implementation;

  return (
    <div className={`border-b ${f.border} ${f.bg} px-4 py-3`}>
      <div className="flex items-start gap-3">
        <span className={`mt-0.5 text-lg ${f.tint}`}>{f.icon}</span>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className={`text-[13px] font-semibold ${f.tint}`}>{it.failure.title}</span>
            <span className="pill bg-ink-800 text-slate-400">{it.failure.kind}</span>
            {it.failure.resumeFrom && (
              <span className="pill bg-ink-800 text-slate-500">resumes at “{it.failure.resumeFrom}”</span>
            )}
            {it.restarts > 0 && <span className="pill bg-ink-800 text-slate-500">restarted {it.restarts}×</span>}
          </div>

          <p className="mt-1.5 text-[12px] leading-relaxed text-slate-300">{it.failure.explanation}</p>

          {it.failure.remedy && (
            <p className="mt-2 flex gap-2 text-[11px] leading-relaxed text-slate-400">
              <span className="text-brand">▸</span>
              {it.failure.remedy}
            </p>
          )}

          {it.filesChanged > 0 && (
            <p className="mt-1.5 text-[11px] text-slate-500">
              It had already produced <strong className="text-slate-300">{it.filesChanged} file{it.filesChanged === 1 ? '' : 's'}</strong> of
              changes (+{it.additions}/−{it.deletions}). A restart replays them, so the work is not thrown away.
            </p>
          )}
        </div>

        {/* Any failed or interrupted run can be restarted — the engine decides where
            to resume from based on why it stopped. */}
        <button onClick={() => onRestart(it.id)} disabled={busy} className="btn-primary shrink-0">
          {busy ? <><Spinner /> restarting…</> : it.resumable ? '↻ restart from these changes' : '↻ restart'}
        </button>
      </div>
    </div>
  );
}

/** How the batch was actually parallelised. */
function Waves({ waves, tasks, savedMs }) {
  if (!waves?.length) return null;
  const byIndex = tasks || [];
  return (
    <div className="border-b border-ink-800 px-4 py-2.5">
      <div className="mb-1.5 flex items-center gap-2">
        <h3 className="text-[10px] font-semibold uppercase tracking-wide text-slate-500">Parallel execution</h3>
        {savedMs > 0 && (
          <span className="pill bg-emerald-500/15 text-emerald-300">saved ~{Math.round(savedMs / 1000)}s</span>
        )}
      </div>
      <div className="space-y-1">
        {waves.map((w) => (
          <div key={w.wave} className="flex items-center gap-2">
            <span className="w-12 shrink-0 text-[10px] uppercase tracking-wide text-slate-600">wave {w.wave}</span>
            <div className="flex flex-1 flex-wrap gap-1">
              {w.tasks.map((ti) => {
                const t = byIndex[ti];
                const meta = AGENT_META[t?.agent] || {};
                return (
                  <span
                    key={ti}
                    className="flex max-w-[240px] items-center gap-1 truncate rounded bg-ink-800 px-2 py-0.5 text-[10px] text-slate-300"
                    title={t?.title}
                  >
                    {meta.emoji} <span className="truncate">{t?.title || `task ${ti + 1}`}</span>
                  </span>
                );
              })}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function Detail({ id, onRestart, restarting }) {
  // Was a 3-second poll — the most aggressive in the dashboard, refetching a whole iteration twenty
  // times a minute to learn nothing had changed. The pipeline emits `iteration.phase` and
  // `iteration.task` as they happen, so the detail now updates the moment a phase moves, and the
  // long interval is only there in case the socket is down.
  const res = useResource(`iteration:${id}`, () => api.iteration(id), { interval: SAFETY_NET_LIVE_MS });
  const it = res.data;

  if (!it) return <div className="p-4"><Resource {...res} rows={6} emptyTitle={`Run #${id} not found`} /></div>;

  return (
    <div className="flex h-full flex-col">
      <div className="border-b border-ink-800 px-4 py-3">
        <div className="flex items-center gap-2">
          <span className="font-mono text-[11px] text-slate-500">#{it.id}</span>
          <span className={`pill ${ITER_STATUS[it.status] || ''}`}>{it.status.replace('_', ' ')}</span>
          {it.rolledBack && <span className="pill bg-amber-500/15 text-amber-300">rolled back</span>}
          {it.restartOf && <span className="pill bg-ink-800 text-slate-400">restart of #{it.restartOf}</span>}
          <div className="flex-1" />
          <span className="text-[10px] text-slate-600">
            {ago(it.startedAt)}
            {it.durationMs ? ` · ${Math.round(it.durationMs / 1000)}s` : ''}
          </span>
        </div>
        <h2 className="mt-1 text-sm font-semibold text-white">{it.planTitle || 'Iteration'}</h2>
        {it.commitSha && (
          <p className="mt-1 text-[11px] text-emerald-400">
            committed <code className="font-mono">{it.commitSha.slice(0, 8)}</code> → <code className="font-mono">{it.branch}</code>
          </p>
        )}
      </div>

      {/*
        * EVERYTHING BELOW THE HEADER SCROLLS.
        *
        * This was a fixed-height flex column where only the diff at the bottom could scroll, so
        * every section above it — scores, gates, phases, waves, tasks — was squeezed into whatever
        * space was left and the overflow was simply unreachable. Adding the judging-gates panel,
        * which carries real runner output and can be tall, made that unmissable: the run was
        * showing content nobody could scroll to.
        *
        * The header stays put because run identity and status are what you navigate by.
        */}
      <div className="min-h-0 flex-1 overflow-y-auto">
      <FailureCard it={it} onRestart={onRestart} busy={restarting} />

      <div className="flex items-center justify-around border-b border-ink-800 bg-ink-900/40 py-3">
        <ScoreRing score={it.scores.total} label="total" size={62} />
        <ScoreRing score={it.scores.review} label="review" />
        <ScoreRing score={it.scores.security} label="security" />
        <ScoreRing score={it.scores.regression} label="regression" />
        <ScoreRing score={it.scores.test} label="test" />
        <ScoreRing score={it.scores.workbench} label="boots?" />
      </div>

      {/* The two gates that end in a judgement rather than a score, so they have no ring above. */}
      <GateRecord gates={it.gates} detail={it.gateDetail} />

      <div className="border-b border-ink-800 px-4 py-2.5">
        <PhaseStrip phases={it.phases} live={it.status === 'running'} />
      </div>

      <Waves waves={it.waves} tasks={it.tasks} savedMs={it.parallelSavedMs} />

      {it.tasks?.length > 0 && (
        <div className="border-b border-ink-800 px-4 py-2.5">
          <h3 className="mb-1.5 text-[10px] font-semibold uppercase tracking-wide text-slate-500">
            Tasks · {it.tasks.filter((t) => t.status === 'done').length}/{it.tasks.length} landed
          </h3>
          <ul className="space-y-1">
            {it.tasks.map((t) => {
              const meta = AGENT_META[t.agent] || {};
              return (
                <li key={t.id} className="text-[11px]">
                  <div className="flex items-start gap-2">
                    <span className={`mt-0.5 ${t.status === 'done' ? 'text-emerald-500' : t.status === 'failed' ? 'text-rose-500' : 'text-slate-600'}`}>
                      {t.status === 'done' ? '✓' : t.status === 'failed' ? '✕' : '·'}
                    </span>
                    <span className="rounded bg-ink-800 px-1 text-[10px] text-slate-500">{t.kind}</span>
                    {t.agent && (
                      <span className={`shrink-0 ${meta.tint || 'text-slate-500'}`} title={`assigned to the ${t.agent} specialist`}>
                        {meta.emoji} {t.agent}
                      </span>
                    )}
                    <span className="min-w-0 flex-1 text-slate-300">{t.title}</span>
                    {t.filesChanged?.length > 0 && <span className="shrink-0 text-slate-600">{t.filesChanged.length}f</span>}
                  </div>
                  {/* Why it failed, spelled out — the whole point of asking "why do services fail?". */}
                  {t.status === 'failed' && (t.error || t.summary) && (
                    <div className="ml-6 mt-0.5 rounded border border-rose-900/40 bg-rose-950/20 px-2 py-1 text-[10px] leading-relaxed text-rose-300/90">
                      {t.error || t.summary}
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        </div>
      )}

      {/* A generous fixed height rather than `flex-1`: inside a scrolling parent, "fill what is
          left" resolves to nothing, and the diff would collapse to zero. */}
      <div className="h-[70vh] min-h-[320px] overflow-hidden border-t border-ink-800 bg-ink-950/60">
        {it.diff ? (
          <DiffViewer diff={it.diff} />
        ) : (
          <div className="grid h-full place-items-center text-xs text-slate-600">
            {it.status === 'running' ? 'iteration in progress…' : 'no diff'}
          </div>
        )}
      </div>
      </div>
    </div>
  );
}

/**
 * History filters. The list is every run in order, which is the right default and the wrong thing
 * to read when you are asking a question — "did anything actually land today?", "what were the
 * rollbacks about?". With hundreds of runs, and long stretches where they all end the same way,
 * scrolling is not a way to answer either.
 */
const FILTERS = [
  { id: 'all', label: 'All' },
  { id: 'committed', label: 'Landed', hint: 'runs whose changes were kept' },
  { id: 'rolled_back', label: 'Rolled back', hint: 'graded too low, or broke the build' },
  { id: 'empty', label: 'No edits', hint: 'the implementer produced nothing' },
  { id: 'interrupted', label: 'Interrupted', hint: 'the server stopped, or the run was cancelled' },
  { id: 'resumable', label: 'Restartable', hint: 'can be picked back up where it stopped' },
];

export function filterRuns(runs, { status = 'all', query = '' } = {}) {
  const q = query.trim().toLowerCase();
  return runs.filter((r) => {
    if (status === 'resumable' ? !r.resumable : status !== 'all' && r.status !== status) return false;
    if (!q) return true;
    return `#${r.id} ${r.planTitle || ''} ${r.failure?.title || ''}`.toLowerCase().includes(q);
  });
}

export default function Iterations({ iteration, control, actions, thoughts, toast }) {
  /*
   * `/api/state` carries 15 runs so the shell can render immediately — enough for "what happened
   * lately", useless for filtering: on this database that is 15 of 435, so "9 rolled back" answered
   * a question about the last hour while looking like a verdict on the project. The deeper list is
   * fetched here, by the one view that needs it, rather than inflating a payload the whole app
   * refetches on every event.
   */
  const deep = useResource('iterations', () => api.iterations(250), { interval: SAFETY_NET_LIVE_MS });
  const recent = deep.data?.length ? deep.data : iteration?.recent || [];
  const restartable = control?.restartable || [];
  const [selected, setSelected] = useState(null);
  const [restarting, setRestarting] = useState(false);
  const [status, setStatus] = useState('all');
  const [query, setQuery] = useState('');

  const shown = filterRuns(recent, { status, query });
  // The selection follows the filter: keeping a hidden run open leaves the detail pane showing
  // something the list no longer offers, with no way to tell why.
  const sel = shown.some((r) => r.id === selected) ? selected : shown[0]?.id ?? null;

  const restart = async (id) => {
    setRestarting(true);
    try {
      const r = await actions.restartIteration(id);
      toast?.(r?.busy ? 'The pipeline is already running' : `Restarting #${id} from its changes`, {
        type: r?.busy ? 'warn' : 'success',
      });
    } catch (e) {
      toast?.(e.message, { type: 'error', title: 'Restart failed' });
    } finally {
      setRestarting(false);
    }
  };

  return (
    <div className="grid h-full grid-cols-[340px_minmax(0,1fr)] gap-3">
      <div className="flex min-h-0 flex-col gap-3">
        {/* the one control */}
        <div className="card p-3">
          <div className="flex items-center justify-between">
            <div>
              <div className="text-xs font-semibold text-white">Pipeline</div>
              <div className="text-[10px] text-slate-500">
                {control?.workBranch} · {control?.todayCount}/{control?.maxPerDay} today ·{' '}
                {control?.parallel?.maxTasks}× parallel
              </div>
            </div>
            {control?.looping ? (
              <button onClick={actions.stopLoop} className="btn-danger">■ stop</button>
            ) : (
              <button onClick={actions.startLoop} className="btn-primary">▶ loop</button>
            )}
          </div>
          <div className="mt-2 flex gap-2">
            <button onClick={actions.runIteration} disabled={control?.running} className="btn-ghost flex-1">
              {control?.running ? <><Spinner /> running…</> : '↻ run one now'}
            </button>
            {control?.running && <button onClick={actions.cancelCurrent} className="btn-danger">cancel</button>}
          </div>
          {control?.running && thoughts?.__iteration && (
            <p className="mt-2 line-clamp-2 border-l-2 border-brand/50 pl-2 font-mono text-[10px] italic text-slate-500">
              {thoughts.__iteration}
            </p>
          )}
        </div>

        {/* restartable runs — the most actionable thing on this page */}
        {restartable.length > 0 && (
          <div className="card border-amber-900/40 bg-amber-950/10 p-3">
            <h3 className="mb-1.5 text-[10px] font-semibold uppercase tracking-wide text-amber-400">
              {restartable.length} run{restartable.length === 1 ? '' : 's'} can be picked back up
            </h3>
            <div className="space-y-1.5">
              {restartable.slice(0, 4).map((r) => (
                <div key={r.id} className="flex items-center gap-2 text-[11px]">
                  <button onClick={() => setSelected(r.id)} className="font-mono text-slate-500 hover:text-white">
                    #{r.id}
                  </button>
                  <span className={FAILURE[r.failure?.kind]?.tint || 'text-slate-400'}>
                    {FAILURE[r.failure?.kind]?.icon} {r.failure?.kind === 'interruption' ? 'interrupted' : 'broken'}
                  </span>
                  <span className="text-slate-600">{r.filesChanged}f</span>
                  <div className="flex-1" />
                  <button
                    onClick={() => restart(r.id)}
                    disabled={restarting || control?.running}
                    className="rounded border border-amber-800/60 px-1.5 py-0.5 text-[10px] text-amber-300 hover:bg-amber-500/10 disabled:opacity-40"
                  >
                    ↻ restart
                  </button>
                </div>
              ))}
            </div>
          </div>
        )}

        <div className="card flex min-h-0 flex-1 flex-col">
          <div className="card-head">
            <h3 className="card-title">History</h3>
            <span className="ml-auto font-mono text-[10px] text-slate-600">
              {shown.length === recent.length ? `${recent.length}` : `${shown.length}/${recent.length}`}
            </span>
          </div>
          <div className="border-b border-ink-800 px-2 py-1.5">
            <div className="flex flex-wrap gap-1">
              {FILTERS.map((f) => {
                const n = f.id === 'all' ? recent.length : filterRuns(recent, { status: f.id }).length;
                return (
                  <button
                    key={f.id}
                    onClick={() => setStatus(f.id)}
                    title={f.hint}
                    aria-pressed={status === f.id}
                    className={`rounded px-1.5 py-0.5 text-[10px] transition-colors ${
                      status === f.id ? 'bg-ink-700 text-white' : 'text-slate-500 hover:bg-ink-800 hover:text-slate-300'
                    }`}
                  >
                    {f.label} <span className="text-slate-600">{n}</span>
                  </button>
                );
              })}
            </div>
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="filter by title, #id or failure…"
              aria-label="Filter run history"
              className="input mt-1.5 h-6 w-full py-0 text-[11px]"
            />
          </div>
          <div className="min-h-0 flex-1 overflow-auto">
            {!recent.length ? (
              <Empty icon="⟳" title="No iterations yet" hint="Start the pipeline, or run one now to see it plan, implement in parallel, grade, boot the app, and commit." />
            ) : !shown.length ? (
              <Empty icon="⌕" title="No run matches" hint="Nothing in the loaded history matches this filter. Clear it to see every run again." />
            ) : (
              <ul className="divide-y divide-ink-800/60">
                {shown.map((it) => (
                  <li key={it.id}>
                    <button
                      onClick={() => setSelected(it.id)}
                      className={`w-full px-3 py-2 text-left transition-colors hover:bg-ink-800/50 ${sel === it.id ? 'bg-ink-800/70' : ''}`}
                    >
                      <div className="flex items-center gap-2">
                        <span className="font-mono text-[10px] text-slate-600">#{it.id}</span>
                        <span className={`pill ${ITER_STATUS[it.status] || ''}`}>{it.status.replace('_', ' ')}</span>
                        {it.resumable && <span className="text-[10px] text-amber-400" title="restartable">↻</span>}
                        {it.scores?.total != null && (
                          <span className="ml-auto font-mono text-[11px] font-bold" style={{ color: accentHex(scoreColor(it.scores.total)) }}>
                            {it.scores.total}
                          </span>
                        )}
                      </div>
                      <div className="mt-0.5 truncate text-[11px] text-slate-300">{it.planTitle || '—'}</div>
                      <div className="mt-0.5 flex flex-wrap items-center gap-1.5 text-[10px] text-slate-600">
                        <span>{ago(it.startedAt)}</span>
                        {it.filesChanged > 0 && <span>· {it.filesChanged}f +{it.additions}/−{it.deletions}</span>}
                        {it.improvements > 0 && <span className="text-emerald-600">· +{it.improvements} impr</span>}
                        {it.featuresDone > 0 && <span className="text-sky-600">· +{it.featuresDone} feat</span>}
                        {it.parallelSavedMs > 1000 && <span className="text-slate-500">· −{Math.round(it.parallelSavedMs / 1000)}s ‖</span>}
                      </div>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
      </div>

      <div className="card min-h-0 overflow-hidden">
        {sel != null ? (
          <Detail id={sel} onRestart={restart} restarting={restarting} />
        ) : (
          <Empty icon="⟳" title="Select an iteration" hint="Every run records its plan, how it was parallelised, its scores, whether the app still booted, and — if it failed — why." />
        )}
      </div>
    </div>
  );
}
