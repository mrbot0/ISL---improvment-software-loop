import { AreaChart, BarChart, Donut, Kpi, accentHex } from '../components/charts.jsx';
import { AGENT_META } from '../components/ui.jsx';

const fmt = (n) => (n >= 1000 ? (n / 1000).toFixed(1) + 'k' : String(n ?? 0));
const pct = (n, d) => (d ? Math.round((n / d) * 100) : 0);

/**
 * Analytics: the deep-dive view. Per-agent effectiveness, verification funnel,
 * proposal-status mix, token economics, and the 24h activity trend — everything
 * an operator needs to judge whether the fleet is actually earning its compute.
 */
export default function Analytics({ metrics, iteration, plans }) {
  if (!metrics) return null;

  const agents = metrics.byAgent.map((a) => {
    const decided = a.applied + a.rejected;
    return { ...a, decided, effectiveness: decided ? pct(a.applied, decided) : null };
  });

  const funnel = [
    { label: 'proposed', value: metrics.totals.proposals, accent: 'sky' },
    { label: 'verified', value: metrics.verification.passed, accent: 'violet' },
    { label: 'landed', value: metrics.totals.applied, accent: 'emerald' },
  ];

  const statusSegs = Object.entries(metrics.proposalsByStatus || {})
    .map(([k, v]) => ({ label: k, value: v, accent: { applied: 'emerald', verified: 'violet', failed: 'rose', rejected: 'slate', stale: 'amber', verifying: 'sky' }[k] || 'slate' }))
    .filter((s) => s.value > 0);

  const iters = iteration?.recent || [];
  const avgIterScore = iters.filter((i) => i.scores?.total != null);
  const meanScore = avgIterScore.length ? Math.round(avgIterScore.reduce((a, b) => a + b.scores.total, 0) / avgIterScore.length) : null;

  return (
    <div className="space-y-3">
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4 xl:grid-cols-6">
        <Kpi label="Proposals" value={metrics.totals.proposals} sub={`${metrics.totals.applied} landed`} accent="sky" />
        <Kpi label="Land rate" value={metrics.totals.proposals ? pct(metrics.totals.applied, metrics.totals.proposals) + '%' : '—'} sub="of all proposals" accent="emerald" />
        <Kpi label="Verify pass" value={metrics.verification.passRate != null ? metrics.verification.passRate + '%' : '—'} accent="violet" />
        <Kpi label="Iterations" value={iters.length} sub={meanScore != null ? `avg score ${meanScore}` : ''} accent="amber" />
        <Kpi label="Plans" value={plans?.list?.length ?? 0} sub={`${plans?.byCriticality?.critical || 0} critical`} accent="rose" />
        <Kpi label="Tokens" value={fmt(metrics.runs.tokensIn + metrics.runs.tokensOut)} sub={`${metrics.runs.llmCalls} calls`} accent="teal" />
      </div>

      <div className="grid gap-3 lg:grid-cols-3">
        <div className="card p-4 lg:col-span-2">
          <h3 className="mb-3 text-xs font-semibold uppercase tracking-wide text-slate-400">Activity trend · 24h</h3>
          <AreaChart data={metrics.timeline} series={[{ key: 'proposals', accent: 'sky' }, { key: 'runs', accent: 'violet' }]} height={150} />
        </div>
        <div className="card flex items-center justify-around p-4">
          <Donut segments={statusSegs.length ? statusSegs : [{ label: 'none', value: 1, accent: 'slate' }]} centerLabel="proposals" centerValue={metrics.totals.proposals} />
          <div className="space-y-1 text-[11px]">
            {(statusSegs.length ? statusSegs : [{ label: 'none', value: 0, accent: 'slate' }]).map((s) => (
              <div key={s.label} className="flex items-center gap-1.5">
                <span className="h-2.5 w-2.5 rounded-sm" style={{ background: accentHex(s.accent) }} />
                <span className="text-slate-400">{s.label}</span>
                <span className="font-mono text-slate-300">{s.value}</span>
              </div>
            ))}
          </div>
        </div>
      </div>

      <div className="grid gap-3 lg:grid-cols-2">
        <div className="card p-4">
          <h3 className="mb-3 text-xs font-semibold uppercase tracking-wide text-slate-400">Verification funnel</h3>
          <BarChart rows={funnel} />
          <p className="mt-2 text-[10px] text-slate-600">proposed → verified → landed</p>
        </div>

        <div className="card flex flex-col">
          <h3 className="border-b border-ink-800 px-4 py-3 text-xs font-semibold uppercase tracking-wide text-slate-400">Per-agent effectiveness</h3>
          <div className="min-h-0 flex-1 overflow-auto">
            <table className="w-full text-[11px]">
              <thead className="sticky top-0 bg-ink-900 text-left text-[10px] uppercase text-slate-600">
                <tr>
                  <th className="px-3 py-1.5">agent</th>
                  <th className="px-2 py-1.5 text-right">proposals</th>
                  <th className="px-2 py-1.5 text-right">landed</th>
                  <th className="px-2 py-1.5 text-right">rejected</th>
                  <th className="px-3 py-1.5 text-right">effectiveness</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-ink-800/60">
                {agents.map((a) => (
                  <tr key={a.agentId} className="hover:bg-ink-800/40">
                    <td className="px-3 py-1.5"><span className="mr-1">{AGENT_META[a.agentId]?.emoji}</span>{a.agentId}</td>
                    <td className="px-2 py-1.5 text-right font-mono text-slate-400">{a.proposals}</td>
                    <td className="px-2 py-1.5 text-right font-mono text-emerald-400">{a.applied}</td>
                    <td className="px-2 py-1.5 text-right font-mono text-slate-500">{a.rejected}</td>
                    <td className="px-3 py-1.5 text-right">
                      {a.effectiveness == null ? (
                        <span className="text-slate-600">—</span>
                      ) : (
                        <span className="font-mono font-semibold" style={{ color: accentHex(a.effectiveness >= 50 ? 'emerald' : a.effectiveness >= 25 ? 'amber' : 'rose') }}>
                          {a.effectiveness}%
                        </span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </div>
    </div>
  );
}
