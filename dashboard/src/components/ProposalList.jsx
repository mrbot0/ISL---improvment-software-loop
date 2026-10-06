import { useMemo, useState } from 'react';
import { AGENT_META, Churn, Empty, SeverityPill, Spinner, StatusPill, ago } from './ui.jsx';

const GROUPS = {
  review: ['verified', 'failed', 'verifying'],
  ideas: ['idea'],
  landed: ['approved', 'applied'],
  closed: ['rejected', 'stale', 'apply_failed'],
};

const SEVERITY_ORDER = { critical: 0, high: 1, medium: 2, low: 3 };

export default function ProposalList({ proposals, onOpen, selectedId }) {
  const [tab, setTab] = useState('review');

  const counts = useMemo(
    () =>
      Object.fromEntries(
        Object.entries(GROUPS).map(([k, statuses]) => [k, proposals.filter((p) => statuses.includes(p.status)).length]),
      ),
    [proposals],
  );

  const rows = useMemo(() => {
    const filtered = proposals.filter((p) => GROUPS[tab].includes(p.status));
    // In the review queue, surface what matters: verified-and-severe first.
    if (tab !== 'review') return filtered;
    return [...filtered].sort((a, b) => {
      const av = a.status === 'verified' ? 0 : 1;
      const bv = b.status === 'verified' ? 0 : 1;
      return av - bv || SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity] || b.id - a.id;
    });
  }, [proposals, tab]);

  return (
    <section className="card flex min-h-0 flex-col">
      <div className="flex items-center gap-1 border-b border-ink-800 px-3 py-2">
        <h2 className="mr-2 text-xs font-semibold uppercase tracking-wide text-slate-400">Proposals</h2>
        {Object.keys(GROUPS).map((k) => (
          <button
            key={k}
            onClick={() => setTab(k)}
            className={`rounded-md px-2 py-1 text-[11px] font-medium transition-colors ${
              tab === k ? 'bg-ink-700 text-white' : 'text-slate-500 hover:text-slate-300'
            }`}
          >
            {k}
            <span className="ml-1 font-mono text-slate-600">{counts[k]}</span>
          </button>
        ))}
      </div>

      <div className="min-h-0 flex-1 overflow-auto">
        {!rows.length ? (
          <Empty>
            {tab === 'review'
              ? 'Nothing awaiting review. Start the loop or run an agent to generate proposals.'
              : `No ${tab} proposals yet.`}
          </Empty>
        ) : (
          <ul className="divide-y divide-ink-800/70">
            {rows.map((p) => {
              const meta = AGENT_META[p.agentId] ?? { emoji: '🤖' };
              return (
                <li key={p.id}>
                  <button
                    onClick={() => onOpen(p.id)}
                    className={`flex w-full items-start gap-3 px-3.5 py-2.5 text-left transition-colors hover:bg-ink-800/50 ${
                      selectedId === p.id ? 'bg-ink-800/70' : ''
                    }`}
                  >
                    <span className="mt-0.5 text-sm">{meta.emoji}</span>
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-1.5">
                        <span className="font-mono text-[10px] text-slate-600">#{p.id}</span>
                        <h3 className="truncate text-[13px] font-medium text-slate-200">{p.title}</h3>
                      </div>
                      <div className="mt-1 flex flex-wrap items-center gap-1.5">
                        {p.status === 'verifying' ? (
                          <span className="pill bg-sky-500/15 text-sky-300">
                            <Spinner className="h-2.5 w-2.5" /> verifying
                          </span>
                        ) : (
                          <StatusPill status={p.status} />
                        )}
                        <SeverityPill severity={p.severity} />
                        {p.status === 'idea' ? (
                          <span className="pill bg-indigo-500/15 text-indigo-300">🌐 research idea</span>
                        ) : (
                          <>
                            <Churn additions={p.additions} deletions={p.deletions} />
                            {p.paths[0] && <code className="truncate font-mono text-[10px] text-slate-600">{p.paths[0]}</code>}
                          </>
                        )}
                        <span className="ml-auto shrink-0 text-[10px] text-slate-600">{ago(p.createdAt)}</span>
                      </div>
                    </div>
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </section>
  );
}
