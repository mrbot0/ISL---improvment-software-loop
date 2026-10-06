import { useEffect, useMemo, useState } from 'react';
import { ago, Empty } from '../components/ui.jsx';

/**
 * Notification centre — the durable feed (ISL_Frontend §15, P1).
 *
 * A toast is the wrong container for anything you might need later: it is gone in four seconds and
 * unrecoverable. The events this dashboard produces that MATTER — a change blocked by policy, a
 * refused self-approval, a model call the egress boundary stopped, a budget that halted the loop —
 * are precisely the ones an operator is not looking at the screen for.
 *
 * Two things make a feed usable rather than merely present: **filtering** (severity and kind, so
 * "show me what was blocked" is one click) and **acting on an item** (each notification links to the
 * view where the thing can actually be dealt with). A feed you can only scroll is a log.
 */
const SEV = {
  info: { dot: 'bg-sky-400', text: 'text-slate-300', label: 'info' },
  warn: { dot: 'bg-amber-400', text: 'text-amber-300', label: 'warning' },
  error: { dot: 'bg-rose-400', text: 'text-rose-300', label: 'error' },
  critical: { dot: 'bg-rose-500', text: 'text-rose-200', label: 'critical' },
};

const KIND_ICON = {
  iteration: '◆', regression: '⚠', rollback: '↩', promotion: '⬆', system: '⚙',
  governance: '⚖', security: '🔒', compliance: '📋', context: '📚', deploy: '☁',
};

/** Where an operator goes to act on this. */
const KIND_VIEW = {
  governance: 'governance', security: 'security', regression: 'reliability', rollback: 'reliability',
  promotion: 'deploy', iteration: 'iterations', compliance: 'compliance', context: 'context', deploy: 'cloud',
  // `system` covers interruptions and restarts, which are investigated on the runs view.
  system: 'runs', review: 'review',
};

export default function Notifications({ notifications, actions, onNavigate }) {
  const list = notifications?.list || [];
  const [sev, setSev] = useState('all');
  const [kind, setKind] = useState('all');
  const [unreadOnly, setUnreadOnly] = useState(false);

  // Opening the tab clears the badge. The per-item unread shading stays until the next load, so the
  // operator can still see what was new when they arrived — clearing it instantly would erase the
  // one piece of information they came for.
  useEffect(() => {
    if (notifications?.unread > 0) actions.readNotifications();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const kinds = useMemo(() => [...new Set(list.map((n) => n.kind))].sort(), [list]);
  const filtered = list.filter(
    (n) => (sev === 'all' || n.severity === sev) && (kind === 'all' || n.kind === kind) && (!unreadOnly || !n.read),
  );
  const counts = useMemo(
    () => list.reduce((a, n) => ({ ...a, [n.severity]: (a[n.severity] || 0) + 1 }), {}),
    [list],
  );

  /**
   * Resolve a notification to a view name.
   *
   * Links are written by the backend either as a plain view (`review`) or as `subject:id`
   * (`iteration:206`) — the id identifies the thing, not a route. Passing the raw string through
   * would both render "open iteration:206 →" and navigate nowhere, so the subject is mapped and the
   * id dropped.
   */
  const targetView = (n) => {
    const raw = String(n.link || '').trim();
    const base = raw.includes(':') ? raw.split(':')[0] : raw;
    return KIND_VIEW[base] || KIND_VIEW[n.kind] || (base && !raw.includes(':') ? base : null);
  };

  const go = (n) => {
    const view = targetView(n);
    if (view && onNavigate) onNavigate(view);
  };

  return (
    <div className="mx-auto max-w-3xl">
      <div className="card flex h-full flex-col">
        <div className="flex flex-wrap items-center gap-2 border-b border-ink-800 px-4 py-2.5">
          <h2 className="text-xs font-semibold uppercase tracking-wide text-slate-400">Notifications</h2>
          <span className="text-[10px] text-slate-600">{filtered.length} of {list.length}</span>
          <div className="flex-1" />
          <label className="flex cursor-pointer items-center gap-1 text-[11px] text-slate-500">
            <input type="checkbox" checked={unreadOnly} onChange={(e) => setUnreadOnly(e.target.checked)} />
            unread only
          </label>
        </div>

        {/* Filters. Severity first — "what went wrong" is the question people arrive with. */}
        <div className="flex flex-wrap items-center gap-1 border-b border-ink-800 px-4 py-2">
          {['all', 'critical', 'error', 'warn', 'info'].map((s) => (
            <button
              key={s}
              onClick={() => setSev(s)}
              className={`rounded-md px-2 py-0.5 text-[11px] ${sev === s ? 'bg-ink-700 text-white' : 'text-slate-500 hover:text-slate-300'}`}
            >
              {s === 'all' ? 'all severities' : (SEV[s]?.label || s)}
              {s !== 'all' && counts[s] ? <span className="ml-1 opacity-60">{counts[s]}</span> : null}
            </button>
          ))}
          {kinds.length > 1 && (
            <>
              <span className="mx-1 text-slate-700">·</span>
              <button onClick={() => setKind('all')} className={`rounded-md px-2 py-0.5 text-[11px] ${kind === 'all' ? 'bg-ink-700 text-white' : 'text-slate-500 hover:text-slate-300'}`}>all kinds</button>
              {kinds.map((k) => (
                <button
                  key={k}
                  onClick={() => setKind(k)}
                  className={`rounded-md px-2 py-0.5 text-[11px] ${kind === k ? 'bg-ink-700 text-white' : 'text-slate-500 hover:text-slate-300'}`}
                >
                  {KIND_ICON[k] || '•'} {k}
                </button>
              ))}
            </>
          )}
        </div>

        <div className="min-h-0 flex-1 overflow-auto">
          {!filtered.length ? (
            <div className="px-4 py-10">
              <Empty
                icon="◔"
                title={list.length ? 'Nothing matches these filters' : 'Nothing yet'}
                hint={list.length ? 'Widen the severity or kind filter.' : 'Landed changes, blocked changes, policy decisions and CVE findings appear here.'}
              />
            </div>
          ) : (
            <ul className="divide-y divide-ink-800/60">
              {filtered.map((n) => {
                const s = SEV[n.severity] || SEV.info;
                const target = targetView(n);
                return (
                  <li key={n.id} className={`flex items-start gap-3 px-4 py-3 ${n.read ? '' : 'bg-ink-800/30'}`}>
                    <span className={`mt-1 h-2 w-2 shrink-0 rounded-full ${s.dot}`} title={s.label} />
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <span className="text-slate-600" title={n.kind}>{KIND_ICON[n.kind] || '•'}</span>
                        <span className={`text-[12px] font-medium ${s.text}`}>{n.title}</span>
                        {!n.read && <span className="pill bg-sky-500/15 text-sky-300">new</span>}
                        <span className="ml-auto shrink-0 text-[10px] text-slate-600">{ago(n.ts)}</span>
                      </div>
                      {n.body && <p className="mt-0.5 text-[11px] text-slate-500">{n.body}</p>}
                      {target && onNavigate && (
                        <button onClick={() => go(n)} className="mt-1 text-[11px] text-sky-400 hover:text-sky-300">
                          open {target} →
                        </button>
                      )}
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      </div>
    </div>
  );
}
