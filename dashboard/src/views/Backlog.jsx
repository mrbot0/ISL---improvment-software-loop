import { useEffect, useState } from 'react';
import { api } from '../api.js';
import { useResource } from '../hooks.js';
import { Resource } from '../components/Resource.jsx';
import { SAFETY_NET_MS } from '../liveKeys.js';
import { Spinner } from '../components/ui.jsx';
import { accentHex } from '../components/charts.jsx';

const FN_STATUS = { pending: 'slate', improving: 'sky', improved: 'emerald', deferred: 'amber' };
const FEAT_STATUS = { pending: 'slate', in_progress: 'sky', done: 'emerald', deferred: 'amber' };

const Counts = ({ counts, colors }) => (
  <div className="flex gap-1.5">
    {Object.entries(counts).map(([k, v]) => (
      <span key={k} className="pill" style={{ background: accentHex(colors[k]) + '22', color: accentHex(colors[k]) }}>
        {v} {k.replace('_', ' ')}
      </span>
    ))}
  </div>
);

function AddFeature({ onAdd }) {
  const [open, setOpen] = useState(false);
  const [title, setTitle] = useState('');
  const [area, setArea] = useState('backend');
  const [priority, setPriority] = useState(60);

  if (!open) return <button onClick={() => setOpen(true)} className="btn-ghost">+ add</button>;
  return (
    <form
      className="flex items-center gap-1.5"
      onSubmit={(e) => {
        e.preventDefault();
        if (!title.trim()) return;
        onAdd({ title: title.trim(), area, priority: Number(priority) });
        setTitle('');
        setOpen(false);
      }}
    >
      <input autoFocus value={title} onChange={(e) => setTitle(e.target.value)} placeholder="new feature idea…" className="input h-7 w-56 py-0 text-[11px]" />
      <select value={area} onChange={(e) => setArea(e.target.value)} className="input h-7 w-auto py-0 text-[11px]">
        <option value="backend">backend</option>
        <option value="frontend">frontend</option>
        <option value="docs">docs</option>
      </select>
      <input type="number" min="1" max="100" value={priority} onChange={(e) => setPriority(e.target.value)} className="input h-7 w-14 py-0 text-[11px]" />
      <button type="submit" className="btn-primary h-7">add</button>
      <button type="button" onClick={() => setOpen(false)} className="btn-ghost h-7">✕</button>
    </form>
  );
}

/**
 * WHY THE PROPOSALS STOPPED MAKING SENSE.
 *
 * A run reserves what it is about to work on; finishing releases it, being interrupted does not.
 * The planner only ever picks `pending`, so every interrupted run permanently shrinks the pool it
 * chooses from. On this database that had reached 67 features and 149 functions reserved by runs
 * that ended long ago, leaving **2** features the planner could actually choose — which is why it
 * fell back to micro-edits and why so many runs ended with "the implementer produced no edits".
 *
 * Nothing in the old UI showed that. The counts said "in progress", which reads as work underway.
 */
function BacklogHealth({ toast, onChanged }) {
  const [claims, setClaims] = useState(null);
  const [busy, setBusy] = useState(false);
  /*
   * Two guards, both for the same reason: this strip is diagnostics, and diagnostics must not be
   * able to take down the page they diagnose.
   *
   * `Promise.resolve().then(…)` turns a SYNCHRONOUS throw — an older server without this endpoint,
   * a client bundle missing the method — into a rejection the catch can absorb. And the response is
   * read field by field rather than trusted: reaching straight into `claims.selectable.features`
   * assumes a nested shape nothing guarantees, which is how a wrong assumption about an API payload
   * has blanked a page in this dashboard before.
   */
  const load = () =>
    Promise.resolve()
      .then(() => api.backlogClaims())
      .then((c) =>
        setClaims(
          c && typeof c === 'object'
            ? {
              features: Number(c.features) || 0,
              functions: Number(c.functions) || 0,
              total: Number(c.total) || 0,
              running: Number(c.running) || 0,
              selectable: { features: Number(c.selectable?.features) || 0, functions: Number(c.selectable?.functions) || 0 },
            }
            : null,
        ),
      )
      .catch(() => setClaims(null));
  useEffect(() => { load(); }, []);

  const reclaim = async () => {
    setBusy(true);
    try {
      const r = await api.reclaimBacklog();
      toast?.(`${r.released} item(s) handed back — ${r.features} feature(s), ${r.functions} function(s)`, { type: 'success' });
      load();
      onChanged?.();
    } catch (e) {
      toast?.(e.message, { type: 'error', title: 'Could not release the claims' });
    } finally {
      setBusy(false);
    }
  };

  if (!claims) return null;
  const starved = claims.selectable.features <= 2 && claims.total > 0;
  const idle = !claims.total;

  return (
    <div className={`card p-3 ${starved ? 'border-amber-900/50 bg-amber-950/10' : ''}`}>
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <div className="min-w-0">
          <div className="text-xs font-semibold text-white">
            {idle ? 'Backlog is healthy' : starved ? 'The planner has almost nothing left to choose from' : 'Reserved by runs that already ended'}
          </div>
          <div className="mt-0.5 text-[11px] text-slate-500">
            {idle
              ? 'Nothing is reserved by a finished run. Every pending item is selectable.'
              : `${claims.total} item(s) are still marked as being worked on — ${claims.features} feature(s), ${claims.functions} function(s) — but no run is behind them. The planner can only pick from what is pending: ${claims.selectable.features} feature(s), ${claims.selectable.functions} function(s).`}
          </div>
        </div>
        <div className="flex-1" />
        {!idle && (
          <button onClick={reclaim} disabled={busy} className={starved ? 'btn-primary' : 'btn-ghost'} title="Mark them pending again so the planner can pick them. Nothing is deleted.">
            {busy ? <Spinner /> : '↩'} hand back {claims.total}
          </button>
        )}
      </div>
      {claims.running > 0 && (
        <p className="mt-2 text-[10px] text-slate-500">
          A run is in progress; its own reservations are real. Stop the loop before handing claims back.
        </p>
      )}
    </div>
  );
}

export default function Backlog({ actions, toast }) {
  // The backlog only moves when the planner takes an item, a survey adds one, or the operator edits
  // it here — all of which announce themselves. The 5-second poll it replaces was asking a question
  // that had already been answered.
  const res = useResource('backlog', api.backlog, { interval: SAFETY_NET_MS });
  const { data, refetch: load } = res;

  const addFeature = async (f) => {
    try {
      await api.addFeature(f);
      toast?.('Feature added to backlog', { type: 'success' });
      load();
    } catch (e) {
      toast?.(e.message, { type: 'error' });
    }
  };
  const updateFeature = async (id, patch) => {
    try {
      await api.updateFeature(id, patch);
      load();
    } catch (e) {
      toast?.(e.message, { type: 'error' });
    }
  };
  const removeFeature = async (id) => {
    try {
      await api.deleteFeature(id);
      load();
    } catch (e) {
      toast?.(e.message, { type: 'error' });
    }
  };

  const [busy, setBusy] = useState(false);
  const research = async () => {
    setBusy(true);
    toast?.('Researching the best features online for this project… (~30–60s)', { type: 'info' });
    try {
      const r = await api.research();
      if (r?.busy) toast?.('Research already running…', { type: 'info' });
      // Ideas land in the backlog asynchronously; the 5s auto-refresh picks them up.
      setTimeout(load, 8000);
    } catch (e) {
      toast?.(e.message, { type: 'error', title: 'Research failed' });
    } finally {
      setBusy(false);
    }
  };
  const survey = async () => {
    setBusy(true);
    toast?.('Surveying the codebase… (reads the real files, ~30–60s)', { type: 'info' });
    try {
      const r = await api.surveyBacklog();
      toast?.(r.summary || 'Survey complete', { type: 'success' });
      load();
    } catch (e) {
      toast?.(e.message, { type: 'error', title: 'Survey failed' });
    } finally {
      setBusy(false);
    }
  };
  const reset = async () => {
    // The confirm names the real numbers. The old one described a rebuild in the abstract while the
    // operation deleted whatever happened to be `pending` — on a starved backlog, almost nothing.
    const c = await api.backlogClaims().catch(() => null);
    const detail = c
      ? `\n\n• ${c.total} item(s) reserved by runs that already ended → handed back\n• ${c.selectable.features + c.selectable.functions} pending item(s) → cleared and rebuilt from a fresh survey\n• kept: items you added by hand, and all history`
      : '';
    if (!window.confirm(`Rebuild the backlog from a fresh survey of the real code?${detail}`)) return;
    setBusy(true);
    toast?.('Resetting backlog and re-surveying the code…', { type: 'info' });
    try {
      const r = await api.resetBacklog({ resurvey: true, release: true });
      toast?.(`Released ${r.released ?? 0}, removed ${r.removed}; ${r.surveyed?.added ?? 0} grounded item(s) added`, { type: 'success' });
      load();
    } catch (e) {
      toast?.(e.message, { type: 'error', title: 'Reset failed' });
    } finally {
      setBusy(false);
    }
  };

  const dedup = async () => {
    setBusy(true);
    try {
      const d = await api.backlogDuplicates();
      if (!d.count) { toast?.('No duplicate backlog items found', { type: 'info' }); return; }
      const preview = d.pairs.slice(0, 6).map((p) => `• keep #${p.keep.id}, defer #${p.drop.id} — ${p.drop.title.slice(0, 50)}`).join('\n');
      if (!window.confirm(`Found ${d.count} duplicate pair(s). Defer the weaker of each?\n\n${preview}${d.count > 6 ? `\n…and ${d.count - 6} more` : ''}`)) return;
      const r = await api.dedupBacklog();
      toast?.(`Deferred ${r.deferred} duplicate item(s)`, { type: 'success' });
      load();
    } catch (e) {
      toast?.(e.message, { type: 'error', title: 'Dedup failed' });
    } finally {
      setBusy(false);
    }
  };

  if (!data) return <div className="p-4"><Resource {...res} rows={6} emptyTitle="The backlog is empty" emptyHint="Run a survey to catalog the code and propose work." /></div>;

  return (
    <div className="flex h-full flex-col gap-3">
      <GoalBar toast={toast} />
      <BacklogHealth toast={toast} onChanged={load} />
      <div className="grid min-h-0 flex-1 gap-3 lg:grid-cols-2">
      {/* Features (from research + operator) */}
      <div className="card flex min-h-0 flex-col">
        <div className="flex flex-wrap items-center gap-2 border-b border-ink-800 px-3 py-2">
          <h2 className="text-xs font-semibold uppercase tracking-wide text-slate-400">Feature backlog</h2>
          <Counts counts={data.features.counts} colors={FEAT_STATUS} />
          <div className="flex-1" />
          <button onClick={research} disabled={busy} className="btn-ghost" title="Search the web for the best features for this project's stack and add them to the backlog">
            {busy ? <Spinner /> : '🌐'} research
          </button>
          <button onClick={survey} disabled={busy} className="btn-ghost" title="Analyse the real codebase and add grounded backlog items (runs automatically every ~10 iterations)">
            {busy ? <Spinner /> : '🔍'} survey
          </button>
          <button onClick={dedup} disabled={busy} className="btn-ghost" title="Find near-duplicate pending items (same file + intent) and defer the weaker of each">
            ⧉ dedup
          </button>
          <button onClick={reset} disabled={busy} className="btn-ghost" title="Clear the pending backlog and rebuild it from a fresh survey of the real code">
            ↺ reset
          </button>
          <AddFeature onAdd={addFeature} />
        </div>
        <div className="min-h-0 flex-1 overflow-auto">
          {!data.features.all.length ? (
            <div className="grid h-full place-items-center px-6 text-center text-xs text-slate-600">
              Empty. Research fills this automatically when the loop runs — or add an idea above.
            </div>
          ) : (
            <ul className="divide-y divide-ink-800/60">
              {data.features.all.map((f) => (
                <li key={f.id} className="group px-3 py-2">
                  <div className="flex items-center gap-2">
                    <span className="h-2 w-2 shrink-0 rounded-full" style={{ background: accentHex(FEAT_STATUS[f.status]) }} />
                    <span className="text-[12px] font-medium text-slate-200">{f.title}</span>
                    <div className="ml-auto flex items-center gap-1 opacity-0 transition-opacity group-hover:opacity-100">
                      <button onClick={() => updateFeature(f.id, { priority: Math.min(100, f.priority + 10) })} className="rounded px-1 text-[11px] text-slate-500 hover:bg-ink-800 hover:text-emerald-400" title="Raise priority">▲</button>
                      <button onClick={() => updateFeature(f.id, { status: f.status === 'deferred' ? 'pending' : 'deferred' })} className="rounded px-1 text-[10px] text-slate-500 hover:bg-ink-800 hover:text-amber-400" title="Toggle defer">{f.status === 'deferred' ? 'restore' : 'defer'}</button>
                      <button onClick={() => removeFeature(f.id)} className="rounded px-1 text-[11px] text-slate-500 hover:bg-ink-800 hover:text-rose-400" title="Delete">✕</button>
                    </div>
                    <span className="font-mono text-[10px] text-slate-600">p{f.priority}</span>
                  </div>
                  {f.description && <p className="mt-0.5 line-clamp-2 pl-4 text-[10px] text-slate-500">{f.description}</p>}
                  <div className="mt-0.5 flex gap-2 pl-4 text-[10px] text-slate-600">
                    {f.area && <span className="rounded bg-ink-800 px-1">{f.area}</span>}
                    <span>{f.source}</span>
                    {f.failures > 0 && <span className="text-amber-600">{f.failures} fail</span>}
                  </div>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>

      {/* Functions (from cataloger) */}
      <div className="card flex min-h-0 flex-col">
        <div className="flex items-center justify-between border-b border-ink-800 px-3 py-2">
          <h2 className="text-xs font-semibold uppercase tracking-wide text-slate-400">Code hotspots</h2>
          <Counts counts={data.functions.counts} colors={FN_STATUS} />
        </div>
        <div className="min-h-0 flex-1 overflow-auto">
          {!data.functions.top.length ? (
            <div className="grid h-full place-items-center text-xs text-slate-600">Run an iteration to catalog the code.</div>
          ) : (
            <table className="w-full text-[11px]">
              <thead className="sticky top-0 bg-ink-900 text-left text-[10px] uppercase text-slate-600">
                <tr>
                  <th className="px-3 py-1.5">unit</th>
                  <th className="px-2 py-1.5">file</th>
                  <th className="px-2 py-1.5 text-right">cx</th>
                  <th className="px-2 py-1.5 text-right">fan-in</th>
                  <th className="px-2 py-1.5 text-right">weight</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-ink-800/60">
                {data.functions.top.map((f) => (
                  <tr key={f.id} className="hover:bg-ink-800/40">
                    <td className="px-3 py-1.5">
                      <span className="h-1.5 w-1.5 rounded-full inline-block mr-1.5" style={{ background: accentHex(FN_STATUS[f.status]) }} />
                      <span className="text-slate-300">{f.name}</span>
                      <span className="ml-1 text-[10px] text-slate-600">{f.kind}</span>
                    </td>
                    <td className="px-2 py-1.5 font-mono text-[10px] text-slate-600" title={f.path}>{f.path.split('/').slice(-2).join('/')}</td>
                    <td className="px-2 py-1.5 text-right font-mono text-slate-400">{f.complexity}</td>
                    <td className="px-2 py-1.5 text-right font-mono text-slate-400">{f.fanIn}</td>
                    <td className="px-2 py-1.5 text-right font-mono font-semibold text-slate-300">{f.weight}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </div>
      </div>
    </div>
  );
}

function GoalBar({ toast }) {
  const [goal, setGoal] = useState(null);
  const [text, setText] = useState('');
  const [area, setArea] = useState('');
  const [editing, setEditing] = useState(false);
  useEffect(() => {
    api.goal().then((g) => { setGoal(g); setText(g?.text || ''); setArea(g?.area || ''); }).catch(() => {});
  }, []);
  const save = async () => {
    try {
      const g = await api.setGoal(text.trim(), area);
      setGoal(g);
      setEditing(false);
      toast?.(text.trim() ? 'Objective set — the planner will prioritise it' : 'Objective cleared', { type: 'success' });
    } catch (e) {
      toast?.(e.message, { type: 'error' });
    }
  };
  const active = goal?.text;
  return (
    <div className={`card flex flex-wrap items-center gap-2 px-3 py-2 ${active ? 'border-brand/40' : ''}`}>
      <span className="text-[11px] font-semibold uppercase tracking-wide text-slate-400">🎯 Objective</span>
      {!editing ? (
        <>
          <span className="min-w-0 flex-1 truncate text-[12px] text-slate-300">
            {active ? <>{goal.text}{goal.area ? <span className="ml-1 text-slate-500">· {goal.area}</span> : null}</> : <span className="text-slate-600">No objective set — the fleet works the whole backlog. Set one to steer it.</span>}
          </span>
          <button onClick={() => setEditing(true)} className="btn-ghost">{active ? 'Change' : 'Set objective'}</button>
        </>
      ) : (
        <>
          <input autoFocus value={text} onChange={(e) => setText(e.target.value)} placeholder="e.g. harden auth · raise test coverage · reduce p95 latency" className="input h-7 min-w-0 flex-1 py-0 text-[11px]" />
          <select value={area} onChange={(e) => setArea(e.target.value)} className="input h-7 w-auto py-0 text-[11px]">
            <option value="">any area</option>
            <option value="backend">backend</option>
            <option value="frontend">frontend</option>
            <option value="services">services</option>
            <option value="infra">infra</option>
          </select>
          <button onClick={save} className="btn-primary h-7">Save</button>
          <button onClick={() => setEditing(false)} className="btn-ghost h-7">✕</button>
        </>
      )}
    </div>
  );
}
