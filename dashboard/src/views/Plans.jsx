import { AGENT_META, ago } from '../components/ui.jsx';
import { accentHex } from '../components/charts.jsx';

const CRIT = { critical: 'rose', high: 'amber', medium: 'sky', low: 'slate' };

/**
 * The Plans view: every implementation plan an agent committed to before editing —
 * the critical task it picked, its approach, and the pros/cons it weighed. This is
 * where you see the fleet *thinking*, not just acting.
 */
export default function Plans({ plans }) {
  const list = plans?.list || [];
  const counts = plans?.byCriticality || {};

  return (
    <div className="mx-auto max-w-4xl space-y-3">
      <div className="flex items-center gap-2">
        <h2 className="text-xs font-semibold uppercase tracking-wide text-slate-400">Implementation plans</h2>
        <span className="text-[10px] text-slate-600">agents plan &amp; weigh trade-offs before they touch code</span>
        <div className="ml-auto flex gap-1.5">
          {['critical', 'high', 'medium', 'low'].map((k) =>
            counts[k] ? (
              <span key={k} className="pill" style={{ background: accentHex(CRIT[k]) + '22', color: accentHex(CRIT[k]) }}>
                {counts[k]} {k}
              </span>
            ) : null,
          )}
        </div>
      </div>

      {!list.length ? (
        <div className="card grid h-40 place-items-center text-xs text-slate-600">
          No plans yet. Agents submit a plan (the critical task + pros/cons) before every change.
        </div>
      ) : (
        <div className="space-y-3">
          {list.map((p) => {
            const meta = AGENT_META[p.agentId] ?? { emoji: '🤖' };
            const hex = accentHex(CRIT[p.criticality] || 'slate');
            return (
              <div key={p.id} className="card p-4" style={{ borderColor: p.criticality === 'critical' ? hex + '66' : undefined }}>
                <div className="flex items-center gap-2">
                  <span className="text-sm">{meta.emoji}</span>
                  <span className="text-[10px] text-slate-500">{p.agentId}</span>
                  <span className="pill" style={{ background: hex + '22', color: hex }}>{p.criticality}</span>
                  <span className={`pill ${p.status === 'executed' ? 'bg-emerald-500/15 text-emerald-300' : 'bg-slate-500/15 text-slate-400'}`}>{p.status}</span>
                  <div className="flex-1" />
                  <span className="text-[10px] text-slate-600">{ago(p.createdAt)}</span>
                </div>
                <h3 className="mt-1.5 text-sm font-semibold text-white">{p.title}</h3>
                {p.approach && <p className="mt-1 text-[12px] leading-relaxed text-slate-400">{p.approach}</p>}

                <div className="mt-3 grid gap-3 sm:grid-cols-2">
                  <div>
                    <div className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-emerald-500">Pros</div>
                    <ul className="space-y-0.5">
                      {p.pros.map((x, i) => <li key={i} className="flex gap-1.5 text-[11px] text-slate-300"><span className="text-emerald-500">+</span>{x}</li>)}
                    </ul>
                  </div>
                  <div>
                    <div className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-rose-500">Cons</div>
                    <ul className="space-y-0.5">
                      {p.cons.map((x, i) => <li key={i} className="flex gap-1.5 text-[11px] text-slate-300"><span className="text-rose-500">−</span>{x}</li>)}
                    </ul>
                  </div>
                </div>

                {(p.files?.length > 0 || p.risks) && (
                  <div className="mt-3 space-y-1.5 border-t border-ink-800 pt-2.5">
                    {p.files?.length > 0 && (
                      <div className="flex flex-wrap items-center gap-1.5">
                        <span className="text-[10px] text-slate-600">files:</span>
                        {p.files.map((f) => <code key={f} className="rounded bg-ink-800 px-1 py-0.5 font-mono text-[10px] text-slate-400">{f}</code>)}
                      </div>
                    )}
                    {p.risks && <div className="text-[11px] text-amber-400/90">⚠ {p.risks}</div>}
                    {p.proposalId && <div className="text-[10px] text-slate-600">→ became proposal #{p.proposalId}</div>}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
