import { api } from '../api.js';
import { useResource } from '../hooks.js';
import { CardHead, Empty, Spinner } from '../components/ui.jsx';
import CompetenceHeatmap from '../components/CompetenceHeatmap.jsx';

/**
 * The Decision Network — the fleet's learned choice brain. It shows, per specialist and
 * per area, how often that agent's work actually LANDED (survived review, tests and the
 * workbench and got committed). The planner routes new work toward the strong pairings
 * and away from the weak ones automatically; this view is the window into that learning.
 */
export default function Decisions() {
  const { data, loading } = useResource('decisions', () => api.decisions(), { interval: 8000 });
  if (!data && loading) return <div className="grid h-40 place-items-center text-slate-500"><Spinner /></div>;
  if (!data) return <div className="grid h-40 place-items-center text-slate-500"><Spinner /></div>;

  const agents = (data.agents || []).filter((a) => a.attempts > 0);
  // `areas` and the per-cell lookup moved into CompetenceHeatmap, which indexes the cells once
  // instead of scanning the list per cell.

  return (
    <div className="mx-auto max-w-6xl space-y-4">
      <div>
        <h1 className="page-title">🧠 Decision Network</h1>
        <p className="page-sub">What the fleet has LEARNED about which specialist ships work in which area. The planner routes by this.</p>
      </div>

      {!agents.length ? (
        <Empty icon="🧠" title="No decisions learned yet" hint="As iterations run and commit, the network learns each agent's land-rate per area and starts routing work to whoever actually ships it." />
      ) : (
        <>
          {/* The matrix first: "who should own THIS area?" is the question, and its shape is a
              grid — the strongest/weakest lists below answer a narrower one. */}
          <div className="card">
            <div className="card-head">
              <span className="card-title">Competence map</span>
              <span className="ml-2 text-[10px] text-slate-600">colour = land rate · paleness = how little evidence · click a cell to drill in</span>
            </div>
            <div className="px-3 py-3">
              <CompetenceHeatmap network={data} />
            </div>
          </div>

          <div className="grid gap-3 sm:grid-cols-2">
            <div className="card p-3">
              <div className="card-title mb-2">✅ Strongest pairings</div>
              {data.strong?.length ? data.strong.map((c, i) => (
                <div key={i} className="flex items-center justify-between py-1 text-[12px]">
                  <span className="text-slate-300">{c.agent} <span className="text-slate-500">· {c.area}</span></span>
                  <span className="text-emerald-400">{Math.round(c.landRate * 100)}% <span className="text-slate-600">({c.landed}/{c.attempts})</span></span>
                </div>
              )) : <div className="text-[11px] text-slate-500">Not enough data yet.</div>}
            </div>
            <div className="card p-3">
              <div className="card-title mb-2">⚠ Weakest pairings — auto-rerouted</div>
              {data.weak?.length ? data.weak.map((c, i) => (
                <div key={i} className="flex items-center justify-between py-1 text-[12px]">
                  <span className="text-slate-300">{c.agent} <span className="text-slate-500">· {c.area}</span></span>
                  <span className="text-rose-400">{Math.round(c.landRate * 100)}% <span className="text-slate-600">({c.landed}/{c.attempts})</span></span>
                </div>
              )) : <div className="text-[11px] text-slate-500">No weak pairings — nice.</div>}
            </div>
          </div>

          <p className="text-[10px] text-slate-500">Land-rate = share of that specialist's changes in that area that survived review + tests + workbench and committed. Green ≥ 60%, amber ≥ 35%, red below. The planner blends this with the static file→specialist prior to route every task to whoever is most likely to ship it.</p>
        </>
      )}
    </div>
  );
}
