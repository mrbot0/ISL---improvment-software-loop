import { useState } from 'react';
import { api } from '../api.js';
import { useResource } from '../hooks.js';
import { CardHead, Empty, PageHeader, Spinner, ago } from '../components/ui.jsx';

/**
 * Digest — the operator's "what improved" summary over a window (today / this week / this month).
 * Everything on this page is a real, recorded number: landed changes, land rate, the health index
 * and its trend, blocked-unsafe-changes, and outstanding dependency CVEs. It's the human-facing
 * roll-up of every deterministic signal ISL tracks — the surface a daily email would render.
 */
const WINDOWS = [
  { label: 'Today', hours: 24 },
  { label: 'This week', hours: 168 },
  { label: 'This month', hours: 720 },
];

export default function Digest() {
  const [hours, setHours] = useState(24);
  const { data: d, loading } = useResource(
    `digest:${hours}`,
    () => api.digest(hours),
    { interval: 20000 },
  );

  return (
    <div className="mx-auto max-w-5xl space-y-4">
      <PageHeader title="📰 Digest" subtitle="What the fleet actually improved — a plain-language roll-up of landed changes, health, blocked-unsafe-changes and dependency risk.">
        <div className="flex gap-1">
          {WINDOWS.map((w) => (
            <button
              key={w.hours}
              onClick={() => setHours(w.hours)}
              className={`rounded-md px-2.5 py-1 text-[12px] ${hours === w.hours ? 'bg-ink-700 text-white' : 'text-slate-400 hover:text-slate-200'}`}
            >
              {w.label}
            </button>
          ))}
        </div>
      </PageHeader>

      {loading && !d && <div className="grid h-40 place-items-center text-slate-500"><Spinner /></div>}

      {d && (
        <>
          <div className="card p-4">
            <div className="text-[11px] uppercase tracking-wide text-slate-500">Headline</div>
            <div className="mt-1 text-[14px] font-medium text-slate-100">{d.headline}</div>
            <div className="mt-1 text-[10px] text-slate-600">Generated {ago(d.generatedAt)}</div>
          </div>

          <div className="grid gap-3 sm:grid-cols-4">
            <Stat label="Landed" value={d.counts.committed} tone="ok" />
            <Stat label="Land rate" value={`${d.landRate}%`} />
            <Stat label="Avg score" value={d.avgScore ?? '—'} />
            <Stat label="Files touched" value={d.totals.files} />
          </div>

          <div className="grid gap-3 sm:grid-cols-3">
            <MiniCard title="Outcome mix">
              <Row label="Committed" value={d.counts.committed} cls="text-emerald-400" />
              <Row label="Interrupted" value={d.counts.interrupted} cls="text-slate-400" />
              <Row label="Empty / skipped" value={d.counts.empty} cls="text-slate-400" />
              <Row label="Rolled back" value={d.counts.blocked} cls="text-amber-400" />
              {d.counts.errored ? <Row label="Errored" value={d.counts.errored} cls="text-rose-400" /> : null}
            </MiniCard>

            <MiniCard title="Codebase health">
              {d.health ? (
                <>
                  <div className="flex items-end gap-2">
                    <span className="text-3xl font-semibold text-slate-100">{d.health.score}</span>
                    <span className="pb-1 text-[12px] text-slate-500">/ 100</span>
                    {d.health.delta != null && (
                      <span className={`pb-1 text-[12px] ${d.health.delta > 0 ? 'text-emerald-400' : d.health.delta < 0 ? 'text-rose-400' : 'text-slate-500'}`}>
                        {d.health.delta >= 0 ? '+' : ''}{d.health.delta}
                      </span>
                    )}
                  </div>
                  <div className="mt-1 text-[11px] text-slate-500">Test coverage proxy: {d.health.testRatio ?? '—'}</div>
                </>
              ) : <div className="text-[12px] text-slate-500">No snapshots yet.</div>}
            </MiniCard>

            <MiniCard title="Security posture">
              <Row label="Unsafe changes blocked" value={d.gate?.vetoes ?? 0} cls={d.gate?.vetoes ? 'text-emerald-400' : 'text-slate-400'} />
              {d.dependencies ? (
                <>
                  <Row label="Critical CVEs" value={d.dependencies.totals.critical} cls={d.dependencies.totals.critical ? 'text-rose-400' : 'text-slate-400'} />
                  <Row label="High CVEs" value={d.dependencies.totals.high} cls={d.dependencies.totals.high ? 'text-amber-400' : 'text-slate-400'} />
                  <Row label="Total CVEs" value={d.dependencies.totals.total} cls="text-slate-300" />
                </>
              ) : <div className="mt-1 text-[11px] text-slate-500">Run a dependency scan on the Security page.</div>}
            </MiniCard>
          </div>

          <div className="card">
            <div className="card-head">
          <span className="card-title">What landed ({d.highlights.length})</span>
        </div>
            <div className="divide-y divide-ink-800">
              {d.highlights.map((h) => (
                <div key={h.id} className="flex items-center gap-3 px-3 py-2.5 text-[12px]">
                  <span className="font-mono text-[11px] text-slate-600">{h.sha || `#${h.id}`}</span>
                  <span className="min-w-0 flex-1 truncate text-slate-200">{h.title}</span>
                  <span className="text-slate-500">{h.files} file{h.files === 1 ? '' : 's'}</span>
                  {h.score != null && <span className="pill bg-ink-800 text-slate-400">{h.score}</span>}
                </div>
              ))}
              {!d.highlights.length && (
                <Empty icon="○" title="Nothing landed in this window" hint="No change committed in the selected period. Widen the window, or check the Runs page for interrupted work." />
              )}
            </div>
          </div>
        </>
      )}
    </div>
  );
}

const Stat = ({ label, value, tone }) => (
  <div className="card p-3">
    <div className="stat-label">{label}</div>
    <div className={`stat mt-1 ${tone === 'ok' ? 'text-emerald-400' : 'text-white'}`}>{value}</div>
  </div>
);

const MiniCard = ({ title, children }) => (
  <div className="card p-3">
    <div className="card-title mb-2">{title}</div>
    <div className="space-y-1">{children}</div>
  </div>
);

const Row = ({ label, value, cls }) => (
  <div className="flex items-center justify-between text-[12px]">
    <span className="text-slate-500">{label}</span>
    <span className={`font-medium ${cls || 'text-slate-300'}`}>{value}</span>
  </div>
);
