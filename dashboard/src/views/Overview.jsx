import { AreaChart, BarChart, Donut, Kpi, accentHex } from '../components/charts.jsx';
import OnboardingTour from '../components/OnboardingTour.jsx';
import ActivityFeed from '../components/ActivityFeed.jsx';
import { AGENT_META, Spinner, ago } from '../components/ui.jsx';

const fmt = (n) => (n >= 1000 ? (n / 1000).toFixed(1) + 'k' : String(n ?? 0));
const secs = (ms) => (ms ? `${Math.round(ms / 1000)}s` : '—');

/** The pipeline every proposal flows through — rendered live from current counts. */
function FlowStrip({ metrics, orchestrator }) {
  const s = metrics?.proposalsByStatus || {};
  const stages = [
    { key: 'drafting', label: 'Agents', value: orchestrator?.current ? 1 : 0, accent: 'sky', live: !!orchestrator?.current, sub: orchestrator?.current?.agentId || 'idle' },
    { key: 'verifying', label: 'Verifying', value: s.verifying || 0, accent: 'amber' },
    { key: 'review', label: 'Awaiting review', value: (s.verified || 0) + (s.failed || 0), accent: 'violet' },
    { key: 'applied', label: 'Landed', value: s.applied || 0, accent: 'emerald' },
  ];
  return (
    <div className="card p-4">
      <div className="mb-3 flex items-center justify-between">
        <h3 className="text-xs font-semibold uppercase tracking-wide text-slate-400">Improvement pipeline</h3>
        <span className="text-[10px] text-slate-600">proposal → verify → review → land</span>
      </div>
      <div className="flex items-stretch gap-2">
        {stages.map((st, i) => (
          <div key={st.key} className="flex flex-1 items-center gap-2">
            <div
              className="relative flex-1 rounded-lg border p-3 text-center"
              style={{ borderColor: accentHex(st.accent) + '40', background: accentHex(st.accent) + '0d' }}
            >
              {st.live && (
                <span className="absolute right-2 top-2 flex h-2 w-2">
                  <span className="absolute inline-flex h-full w-full animate-ping rounded-full opacity-75" style={{ background: accentHex(st.accent) }} />
                  <span className="inline-flex h-2 w-2 rounded-full" style={{ background: accentHex(st.accent) }} />
                </span>
              )}
              <div className="text-2xl font-bold tabular-nums" style={{ color: accentHex(st.accent) }}>{st.value}</div>
              <div className="mt-0.5 text-[10px] font-medium text-slate-400">{st.label}</div>
              {st.sub && <div className="mt-0.5 truncate text-[10px] text-slate-600">{st.sub}</div>}
            </div>
            {i < stages.length - 1 && <span className="text-slate-600">→</span>}
          </div>
        ))}
      </div>
    </div>
  );
}

/** Language breakdown of the codebase, from the Context Manager's scan. */
function CodeComposition({ codeStats, onNavigate }) {
  const langs = (codeStats?.byLanguage || []).filter((l) => l.pct != null);
  const segments = langs.slice(0, 8).map((l) => ({ label: l.lang, value: l.lines, accent: l.accent }));
  return (
    <div className="card p-4">
      <div className="mb-3 flex items-center justify-between">
        <h3 className="text-xs font-semibold uppercase tracking-wide text-slate-400">Code composition</h3>
        <span className="text-[10px] text-slate-600">
          {codeStats ? `${codeStats.totalFiles} files · ${fmt(codeStats.totalLines)} lines` : '—'}
        </span>
      </div>
      {!codeStats ? (
        <button onClick={() => onNavigate?.('context')} className="grid h-[132px] w-full place-items-center text-[11px] text-slate-600 hover:text-slate-400">
          Not scanned yet — build context to analyse the codebase.
        </button>
      ) : (
        <div className="flex items-center gap-4">
          <Donut segments={segments.length ? segments : [{ label: 'none', value: 1, accent: 'slate' }]} centerLabel="languages" centerValue={codeStats.languages} />
          <div className="min-w-0 flex-1 space-y-1.5">
            {langs.slice(0, 7).map((l) => (
              <div key={l.lang} className="flex items-center gap-2 text-[11px]">
                <span className="h-2.5 w-2.5 shrink-0 rounded-sm" style={{ background: accentHex(l.accent) }} />
                <span className="min-w-0 flex-1 truncate text-slate-400">{l.lang}</span>
                <span className="font-mono text-slate-300">{l.pct}%</span>
                <span className="w-14 text-right font-mono text-[10px] text-slate-600">{fmt(l.lines)} ln</span>
              </div>
            ))}
            {!langs.length && <div className="text-[11px] text-slate-600">No source code detected.</div>}
          </div>
        </div>
      )}
    </div>
  );
}

export default function Overview({ metrics, orchestrator, events, agents, proposals, thoughts, onOpenProposal, iteration, managers, codeStats, onNavigate }) {
  if (!metrics) return <div className="grid h-full place-items-center"><Spinner /></div>;

  const running = orchestrator?.current?.agentId;
  const director = (managers?.briefs || []).find((b) => b.name === 'Director');
  const sparkProposals = (metrics.timeline || []).map((t) => t.proposals);
  const sparkRuns = (metrics.timeline || []).map((t) => t.runs);
  const statusSegs = [
    { label: 'landed', value: metrics.proposalsByStatus.applied || 0, accent: 'emerald' },
    { label: 'review', value: (metrics.proposalsByStatus.verified || 0) + (metrics.proposalsByStatus.failed || 0), accent: 'violet' },
    { label: 'rejected', value: metrics.proposalsByStatus.rejected || 0, accent: 'slate' },
    { label: 'stale', value: metrics.proposalsByStatus.stale || 0, accent: 'amber' },
  ].filter((s) => s.value > 0);

  const agentBars = metrics.byAgent
    .map((a) => ({ label: a.agentId, value: a.proposals, accent: AGENT_META[a.agentId]?.accent || 'slate' }))
    .sort((a, b) => b.value - a.value);

  return (
    <div className="space-y-3">
      {/* Shown only while a prerequisite is genuinely missing, and dismissible for good. */}
      <OnboardingTour onNavigate={onNavigate} />

      {director && (
        <button
          onClick={() => onNavigate?.('plans')}
          className="card flex w-full items-center gap-3 p-3.5 text-left transition-colors hover:border-ink-600"
          style={{ borderColor: director.status === 'alert' ? accentHex('rose') + '55' : director.status === 'acting' ? accentHex('sky') + '55' : undefined }}
        >
          <span className="grid h-9 w-9 shrink-0 place-items-center rounded-lg text-base" style={{ background: accentHex('sky') + '1a' }}>🧭</span>
          <div className="min-w-0 flex-1">
            <div className="text-[10px] font-semibold uppercase tracking-wide text-slate-500">Critical task · Director</div>
            <div className="truncate text-[13px] font-medium text-slate-200">{director.headline}</div>
          </div>
          <span className={`pill ${director.status === 'alert' ? 'bg-rose-500/15 text-rose-300' : director.status === 'acting' ? 'bg-sky-500/15 text-sky-300' : 'bg-slate-500/15 text-slate-400'}`}>
            {director.status}
          </span>
        </button>
      )}

      <div className="grid grid-cols-2 gap-3 md:grid-cols-4 xl:grid-cols-6">
        <Kpi label="Proposals" value={metrics.totals.proposals} sub={`${metrics.totals.applied} landed`} accent="sky" icon="◆" spark={sparkProposals} />
        <Kpi label="Awaiting review" value={metrics.totals.pendingReview} sub={`cap ${orchestrator?.fleet?.maxPending ?? "—"}`} accent="violet" icon="⏳" />
        <Kpi label="Pass rate" value={metrics.verification.passRate != null ? `${metrics.verification.passRate}%` : '—'} sub={`${metrics.verification.passed}✓ / ${metrics.verification.failed}✕`} accent="emerald" icon="✓" />
        <Kpi label="Runs" value={metrics.runs.total} sub={`${metrics.runs.errors} errors · avg ${secs(metrics.runs.avgDurationMs)}`} accent="amber" icon="▶" spark={sparkRuns} />
        <Kpi label="Tokens" value={fmt(metrics.runs.tokensIn + metrics.runs.tokensOut)} sub={`${metrics.runs.llmCalls} llm calls`} accent="teal" icon="⚡" />
        <Kpi label="Iterations" value={iteration?.controller?.todayCount ?? 0} sub={iteration?.controller?.looping ? 'loop on' : 'loop off'} accent={iteration?.controller?.running ? 'emerald' : 'slate'} icon="⟳" />
      </div>

      <FlowStrip metrics={metrics} orchestrator={orchestrator} />

      <div className="grid gap-3 lg:grid-cols-3">
        <div className="card p-4 lg:col-span-2">
          <div className="mb-2 flex items-center justify-between">
            <h3 className="text-xs font-semibold uppercase tracking-wide text-slate-400">Activity · last 24h</h3>
            <div className="flex gap-3 text-[10px]">
              <span className="flex items-center gap-1"><span className="h-2 w-2 rounded-full" style={{ background: accentHex('sky') }} />proposals</span>
              <span className="flex items-center gap-1"><span className="h-2 w-2 rounded-full" style={{ background: accentHex('violet') }} />runs</span>
            </div>
          </div>
          <AreaChart
            data={metrics.timeline}
            series={[{ key: 'proposals', accent: 'sky' }, { key: 'runs', accent: 'violet' }]}
            height={150}
          />
        </div>

        <div className="card flex items-center justify-around p-4">
          <Donut segments={statusSegs.length ? statusSegs : [{ label: 'none', value: 1, accent: 'slate' }]} centerLabel="proposals" centerValue={metrics.totals.proposals} />
          <div className="space-y-1.5 text-[11px]">
            {(statusSegs.length ? statusSegs : [{ label: 'no proposals yet', value: 0, accent: 'slate' }]).map((s) => (
              <div key={s.label} className="flex items-center gap-1.5">
                <span className="h-2.5 w-2.5 rounded-sm" style={{ background: accentHex(s.accent) }} />
                <span className="text-slate-400">{s.label}</span>
                <span className="font-mono text-slate-300">{s.value}</span>
              </div>
            ))}
          </div>
        </div>
      </div>

      <div className="grid gap-3 lg:grid-cols-3">
        <div className="lg:col-span-2"><CodeComposition codeStats={codeStats} onNavigate={onNavigate} /></div>
        <div className="card p-4">
          <h3 className="mb-3 text-xs font-semibold uppercase tracking-wide text-slate-400">Proposals by agent</h3>
          <BarChart rows={agentBars} />
        </div>
      </div>

      <div className="card flex min-h-[220px] flex-col">
        <ActivityFeed events={events} />
      </div>
    </div>
  );
}
