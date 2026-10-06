import { useEffect, useRef, useState } from 'react';
import { Empty, ago } from './ui.jsx';

/** How each durable event renders. Token streams never reach this component. */
const RENDER = {
  'agent.started': (e) => [`▶`, 'text-emerald-400', `${e.agentName ?? e.agentId} started`, e.instruction && `“${e.instruction}”`],
  'agent.finished': (e) => [
    e.status === 'error' ? '✕' : '■',
    e.status === 'error' ? 'text-rose-400' : 'text-slate-500',
    `${e.agentName ?? e.agentId} finished · ${e.proposals} proposal${e.proposals === 1 ? '' : 's'} · ${e.steps} steps`,
    e.summary,
  ],
  'agent.tool_call': (e) => ['·', 'text-slate-600', `${e.agentId} → ${e.tool}()`, formatArgs(e.args)],
  'agent.error': (e) => ['✕', 'text-rose-400', `${e.agentId ?? 'fleet'} error`, e.error],
  'proposal.created': (e) => ['◆', 'text-sky-400', `proposal #${e.proposalId}: ${e.title}`, `${e.path} (+${e.additions}/−${e.deletions})`],
  'verify.started': (e) => ['⟳', 'text-sky-500', e.inline ? `${e.agentId} self-verifying` : `verifying #${e.proposalId}`, e.paths?.join(', ')],
  'verify.finished': (e) => [
    e.ok ? '✓' : '✕',
    e.ok ? 'text-emerald-400' : 'text-rose-400',
    e.inline
      ? `${e.agentId} self-verify ${e.ok ? 'passed' : 'failed'}`
      : `#${e.proposalId} verification ${e.ok ? 'passed' : 'failed'}`,
    e.failed && `failed at ${e.failed}`,
  ],
  'proposal.approved': (e) => ['✓', 'text-emerald-300', `approved #${e.proposalId}`, e.wasVerified ? '' : 'despite failing verification'],
  'proposal.rejected': (e) => ['✕', 'text-slate-500', `rejected #${e.proposalId}`, e.note],
  'proposal.applied': (e) => ['⬆', 'text-emerald-300', `landed #${e.proposalId}`, `→ ${e.ref}`],
  'proposal.apply_failed': (e) => ['✕', 'text-rose-400', `could not land #${e.proposalId}`, e.error],
  'orchestrator.started': (e) => ['▶', 'text-emerald-400', `loop started`, `every ${e.intervalSeconds}s`],
  'orchestrator.stopped': () => ['■', 'text-slate-500', 'loop stopped', ''],
  'orchestrator.tick': (e) =>
    e.skipped ? ['·', 'text-amber-500', `tick skipped: ${e.skipped}`, e.pending != null ? `${e.pending} pending` : ''] : null,
  'config.changed': (e) => ['⚙', 'text-violet-400', 'config changed', JSON.stringify(e.note ?? e).slice(0, 90)],
  'agent.queued': (e) => ['·', 'text-slate-600', `${e.agentId} queued`, e.trigger],
};

const formatArgs = (args) => {
  if (!args) return '';
  const s = Object.entries(args)
    .map(([k, v]) => `${k}=${typeof v === 'string' ? v : JSON.stringify(v)}`)
    .join(' ');
  return s.length > 90 ? s.slice(0, 90) + '…' : s;
};

export default function ActivityFeed({ events }) {
  const [pinned, setPinned] = useState(true);
  const ref = useRef(null);

  useEffect(() => {
    if (pinned && ref.current) ref.current.scrollTop = ref.current.scrollHeight;
  }, [events, pinned]);

  const onScroll = () => {
    const el = ref.current;
    if (el) setPinned(el.scrollHeight - el.scrollTop - el.clientHeight < 40);
  };

  const rows = events.map((e) => ({ e, r: RENDER[e.type]?.(e) })).filter((x) => x.r);

  return (
    <section className="card flex min-h-0 flex-col">
      <div className="flex items-center gap-2 border-b border-ink-800 px-3 py-2">
        <h2 className="text-xs font-semibold uppercase tracking-wide text-slate-400">Activity</h2>
        <div className="flex-1" />
        {!pinned && (
          <button
            className="text-[10px] text-slate-500 hover:text-slate-300"
            onClick={() => {
              setPinned(true);
              if (ref.current) ref.current.scrollTop = ref.current.scrollHeight;
            }}
          >
            ↓ jump to latest
          </button>
        )}
      </div>

      <div ref={ref} onScroll={onScroll} className="min-h-0 flex-1 overflow-auto px-3 py-2">
        {!rows.length ? (
          <Empty>No activity yet.</Empty>
        ) : (
          <ul className="space-y-1">
            {rows.map(({ e, r }) => {
              const [glyph, tint, title, detail] = r;
              return (
                <li key={e.id ?? `${e.type}-${e.ts}-${Math.random()}`} className="flex gap-2 text-[11px] leading-relaxed">
                  <span className={`shrink-0 font-mono ${tint}`}>{glyph}</span>
                  <div className="min-w-0 flex-1">
                    <span className="text-slate-300">{title}</span>
                    {detail && <span className="ml-1.5 break-words text-slate-600">{detail}</span>}
                  </div>
                  <time className="shrink-0 font-mono text-[10px] text-slate-700">{ago(e.ts)}</time>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </section>
  );
}
