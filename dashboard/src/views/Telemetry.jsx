import { AreaChart, BarChart, Kpi, accentHex } from '../components/charts.jsx';
import { AGENT_META, StatusPill, ago } from '../components/ui.jsx';

const fmt = (n) => (n >= 1000 ? (n / 1000).toFixed(1) + 'k' : String(n ?? 0));
const secs = (ms) => (ms ? `${(ms / 1000).toFixed(1)}s` : '—');

export default function Telemetry({ metrics, runs }) {
  if (!metrics) return null;

  const effRows = metrics.byAgent
    .map((a) => {
      const decided = a.applied + a.rejected;
      return { label: a.agentId, value: decided ? Math.round((a.applied / decided) * 100) : 0, accent: AGENT_META[a.agentId]?.accent || 'slate' };
    })
    .sort((a, b) => b.value - a.value);

  const volRows = metrics.byAgent
    .map((a) => ({ label: a.agentId, value: a.proposals, accent: AGENT_META[a.agentId]?.accent || 'slate' }))
    .sort((a, b) => b.value - a.value);

  return (
    <div className="space-y-3">
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <Kpi label="LLM calls" value={metrics.runs.llmCalls} accent="teal" icon="⚡" />
        <Kpi label="Tokens in" value={fmt(metrics.runs.tokensIn)} sub="prompt" accent="sky" />
        <Kpi label="Tokens out" value={fmt(metrics.runs.tokensOut)} sub="generated" accent="violet" />
        <Kpi label="Avg run" value={secs(metrics.runs.avgDurationMs)} sub={`${metrics.runs.total} runs`} accent="amber" />
      </div>

      <div className="grid gap-3 lg:grid-cols-2">
        <div className="card p-4">
          <h3 className="mb-3 text-xs font-semibold uppercase tracking-wide text-slate-400">Throughput · 24h</h3>
          <AreaChart data={metrics.timeline} series={[{ key: 'proposals', accent: 'sky' }, { key: 'runs', accent: 'violet' }]} height={140} />
        </div>
        <div className="card p-4">
          <h3 className="mb-3 text-xs font-semibold uppercase tracking-wide text-slate-400">Agent effectiveness · % of decided proposals that landed</h3>
          <BarChart rows={effRows} />
        </div>
      </div>

      <div className="grid gap-3 lg:grid-cols-2">
        <div className="card p-4">
          <h3 className="mb-3 text-xs font-semibold uppercase tracking-wide text-slate-400">Proposal volume by agent</h3>
          <BarChart rows={volRows} />
        </div>

        <div className="card flex flex-col">
          <h3 className="border-b border-ink-800 px-4 py-3 text-xs font-semibold uppercase tracking-wide text-slate-400">Recent runs</h3>
          <div className="min-h-0 flex-1 overflow-auto">
            <table className="w-full text-[11px]">
              <thead className="sticky top-0 bg-ink-900 text-left text-[10px] uppercase text-slate-600">
                <tr>
                  <th className="px-3 py-1.5">#</th>
                  <th className="px-2 py-1.5">agent</th>
                  <th className="px-2 py-1.5">status</th>
                  <th className="px-2 py-1.5 text-right">steps</th>
                  <th className="px-2 py-1.5 text-right">tokens</th>
                  <th className="px-2 py-1.5 text-right">dur</th>
                  <th className="px-3 py-1.5 text-right">when</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-ink-800/60">
                {runs.map((r) => (
                  <tr key={r.id} className="hover:bg-ink-800/40">
                    <td className="px-3 py-1.5 font-mono text-slate-600">{r.id}</td>
                    <td className="px-2 py-1.5">
                      <span className="mr-1">{AGENT_META[r.agentId]?.emoji}</span>
                      <span className="text-slate-300">{r.agentId}</span>
                    </td>
                    <td className="px-2 py-1.5">
                      <span className={r.status === 'error' ? 'text-rose-400' : r.status === 'running' ? 'text-sky-400' : 'text-slate-400'}>
                        {r.status}
                      </span>
                    </td>
                    <td className="px-2 py-1.5 text-right font-mono text-slate-400">{r.steps}</td>
                    <td className="px-2 py-1.5 text-right font-mono text-slate-400">{fmt((r.tokensIn || 0) + (r.tokensOut || 0))}</td>
                    <td className="px-2 py-1.5 text-right font-mono text-slate-400">{secs(r.durationMs)}</td>
                    <td className="px-3 py-1.5 text-right text-slate-600">{ago(r.startedAt)}</td>
                  </tr>
                ))}
                {!runs.length && (
                  <tr><td colSpan={7} className="px-3 py-6 text-center text-slate-600">No runs yet.</td></tr>
                )}
              </tbody>
            </table>
          </div>
        </div>
      </div>
    </div>
  );
}
