import { useEffect, useRef, useState } from 'react';
import { api } from '../api.js';
import { invalidateResource } from '../hooks.js';
import { Empty, Spinner, ago } from './ui.jsx';
import DiffViewer from './DiffViewer.jsx';

/**
 * Approval inbox — a purpose-built surface for the human review loop (ISL_Frontend §15, P1).
 *
 * The queue list answers "what is waiting?". It does not answer the question a reviewer actually
 * has, which is "should I approve THIS?" — and that needs the diff, what depends on the files it
 * touches, why it was held, and whether this reviewer is even eligible to decide. Reading a list,
 * clicking through to a diff, and clicking back is the wrong shape for work you do twenty times in a
 * row, so this is keyboard-driven: j/k to move, a/r to decide, without the hands leaving the keys.
 *
 * The eligibility check is the important one. Segregation of duties is enforced server-side and
 * returns 409, but making someone discover a control by hitting it is a poor way to explain a rule —
 * so the reason is shown BEFORE they act, on the item, with the buttons disabled.
 */
const RISK = { high: 'bg-rose-500/15 text-rose-300', medium: 'bg-amber-500/15 text-amber-300', low: 'bg-slate-600/20 text-slate-400' };
const TRUST = { proven: 'bg-emerald-500/15 text-emerald-300', trusted: 'bg-sky-500/15 text-sky-300', probation: 'bg-slate-600/20 text-slate-400' };

/** Why this reviewer may not decide this item — null when they may. */
function ineligibility(item, user) {
  if (!item) return null;
  const me = (user?.email || user?.id || '').trim().toLowerCase();
  const author = (item.authoredBy || '').trim().toLowerCase();
  if (author && me && author === me) {
    return 'You originated this change. Segregation of duties: the identity that authored a change cannot approve it.';
  }
  return null;
}

export default function ReviewInbox({ items = [], user, toast }) {
  const [idx, setIdx] = useState(0);
  const [busy, setBusy] = useState(false);
  const [detail, setDetail] = useState(null); // { id, loading, diff }
  const [showHelp, setShowHelp] = useState(false);
  const listRef = useRef(null);

  const pending = items.filter((i) => i.status === 'pending');
  const current = pending[Math.min(idx, pending.length - 1)] || null;
  const blocked = ineligibility(current, user);

  // Load the selected change's diff. The queue carries no diff (it would make the list payload
  // enormous), so it is fetched per selection.
  useEffect(() => {
    if (!current?.iterationId) return setDetail(null);
    let cancelled = false;
    setDetail({ id: current.iterationId, loading: true });
    api.iteration(current.iterationId)
      .then((it) => { if (!cancelled) setDetail({ id: current.iterationId, diff: it?.diff || it?.iteration?.diff || '' }); })
      .catch(() => { if (!cancelled) setDetail({ id: current.iterationId, diff: '' }); });
    return () => { cancelled = true; };
  }, [current?.iterationId]);

  const decide = async (verdict) => {
    if (!current || busy) return;
    if (blocked) return toast?.(blocked, { type: 'warn' });
    setBusy(true);
    try {
      await api.decideReview(current.id, verdict);
      invalidateResource('review:queue');
      toast?.(verdict === 'approve' ? 'Change approved' : 'Change rejected', { type: verdict === 'approve' ? 'success' : 'warn' });
      setIdx((i) => Math.min(i, Math.max(0, pending.length - 2)));
    } catch (e) {
      // A 409 is the segregation-of-duties control firing, not a failure — say which.
      toast?.(e.message || 'Failed', { type: 'error' });
    } finally {
      setBusy(false);
    }
  };

  // Keyboard driving. Ignored while typing so the shortcuts cannot fire from a search box.
  useEffect(() => {
    const onKey = (e) => {
      const t = e.target;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const k = e.key.toLowerCase();
      if (k === 'j' || e.key === 'ArrowDown') { e.preventDefault(); setIdx((i) => Math.min(i + 1, pending.length - 1)); }
      else if (k === 'k' || e.key === 'ArrowUp') { e.preventDefault(); setIdx((i) => Math.max(i - 1, 0)); }
      else if (k === 'a') { e.preventDefault(); decide('approve'); }
      else if (k === 'r') { e.preventDefault(); decide('reject'); }
      else if (k === '?') { e.preventDefault(); setShowHelp((s) => !s); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [pending.length, current?.id, busy, blocked]);

  // Keep the selected row visible when moving by keyboard.
  useEffect(() => {
    listRef.current?.querySelector('[data-selected="true"]')?.scrollIntoView({ block: 'nearest' });
  }, [idx]);

  if (!pending.length) {
    return <div className="card"><div className="px-3 py-10"><Empty icon="✓" title="Nothing awaiting review" hint="Risky or low-trust changes appear here. Trusted agents' low-risk work auto-lands." /></div></div>;
  }

  return (
    <div className="card overflow-hidden">
      <div className="card-head flex-wrap gap-y-1">
        <span className="card-title">Approval inbox</span>
        <span className="ml-2 text-[11px] text-slate-500">{idx + 1} of {pending.length}</span>
        <div className="flex-1" />
        <button onClick={() => setShowHelp((s) => !s)} className="btn-ghost text-[11px]" title="Keyboard shortcuts">⌨ j/k · a/r · ?</button>
      </div>

      {showHelp && (
        <div className="border-b border-ink-800 bg-ink-950/60 px-3 py-2 text-[11px] text-slate-400">
          <b className="text-slate-300">j</b> / <b className="text-slate-300">↓</b> next · <b className="text-slate-300">k</b> / <b className="text-slate-300">↑</b> previous ·
          <b className="text-slate-300"> a</b> approve · <b className="text-slate-300">r</b> reject · <b className="text-slate-300">?</b> toggle this help
        </div>
      )}

      <div className="grid gap-0 lg:grid-cols-[minmax(0,320px)_1fr]">
        {/* The queue */}
        <div ref={listRef} className="max-h-[65vh] divide-y divide-ink-800 overflow-y-auto border-b border-ink-800 lg:border-b-0 lg:border-r">
          {pending.map((it, i) => {
            const selected = i === idx;
            const mine = !!ineligibility(it, user);
            return (
              <button
                key={it.id}
                data-selected={selected}
                onClick={() => setIdx(i)}
                className={`block w-full px-3 py-2 text-left ${selected ? 'bg-ink-800/70' : 'hover:bg-ink-900'}`}
              >
                <div className="flex items-center gap-2">
                  <span className={`pill ${RISK[it.risk] || RISK.low}`}>{it.risk}</span>
                  <span className="min-w-0 flex-1 truncate text-[12px] text-slate-200">{it.title}</span>
                  {mine && <span className="pill bg-amber-500/15 text-amber-300" title="You authored this — you cannot approve it">yours</span>}
                </div>
                <div className="mt-0.5 flex flex-wrap gap-x-2 text-[10px] text-slate-600">
                  <span className="font-mono">{it.commitSha?.slice(0, 8) || `#${it.iterationId}`}</span>
                  <span>{it.agent}</span>
                  <span>+{it.additions}/−{it.deletions}</span>
                  <span>{ago(it.createdAt)}</span>
                </div>
              </button>
            );
          })}
        </div>

        {/* The change */}
        <div className="flex min-h-0 flex-col">
          {current && (
            <>
              <div className="border-b border-ink-800 px-3 py-2">
                <div className="flex flex-wrap items-center gap-2">
                  <span className={`pill ${RISK[current.risk] || RISK.low}`}>{current.risk}</span>
                  {current.sensitive && <span className="pill bg-rose-500/15 text-rose-300">sensitive</span>}
                  <span className={`pill ${TRUST[current.trustLevel] || TRUST.probation}`}>{current.trustLevel}</span>
                  <span className="min-w-0 flex-1 truncate text-[13px] text-slate-100">{current.title}</span>
                </div>
                <div className="mt-1 flex flex-wrap gap-x-3 text-[10px] text-slate-600">
                  <span className="font-mono">{current.commitSha?.slice(0, 10) || ''}</span>
                  <span>{current.agent}</span>
                  <span>{current.filesChanged} file(s) · +{current.additions}/−{current.deletions}</span>
                  {/* Null authoredBy means the autonomous loop originated it — worth stating, since
                      it is why anyone eligible may decide. */}
                  <span>origin: {current.authoredBy || 'autonomous loop'}</span>
                </div>

                {current.reasons?.length > 0 && (
                  <div className="mt-1.5 text-[11px] text-slate-400">held because: {current.reasons.join(' · ')}</div>
                )}

                {/* Which organisational rule held it, and under which policy version. */}
                {current.policy?.matched?.length > 0 && (
                  <div className="mt-1 text-[11px] text-sky-300/90">
                    policy v{current.policy.version}: {current.policy.matched.map((m) => m.id).join(', ')}
                    {current.policy.blocked && <span className="ml-1 text-rose-300">· blocked from auto-promotion</span>}
                    {current.policy.approvals > 1 && <span className="ml-1 text-slate-400">· requires {current.policy.approvals} approvals</span>}
                  </div>
                )}

                {blocked && (
                  <div className="mt-2 rounded-md border border-amber-500/30 bg-amber-500/10 px-2 py-1.5 text-[11px] text-amber-200">
                    ⚖ {blocked}
                  </div>
                )}

                <div className="mt-2 flex gap-2">
                  <button
                    disabled={busy || !!blocked}
                    onClick={() => decide('approve')}
                    className="rounded-md bg-emerald-600/80 px-3 py-1 text-[12px] text-white hover:bg-emerald-600 disabled:cursor-not-allowed disabled:opacity-40"
                    title={blocked || 'Approve (a)'}
                  >
                    {busy ? <Spinner /> : '✓'} Approve <span className="opacity-60">a</span>
                  </button>
                  <button
                    disabled={busy || !!blocked}
                    onClick={() => decide('reject')}
                    className="rounded-md bg-rose-600/70 px-3 py-1 text-[12px] text-white hover:bg-rose-600 disabled:cursor-not-allowed disabled:opacity-40"
                    title={blocked || 'Reject (r)'}
                  >
                    ✕ Reject <span className="opacity-60">r</span>
                  </button>
                </div>
              </div>

              <div className="min-h-0 flex-1" style={{ height: '52vh' }}>
                {detail?.loading
                  ? <div className="grid h-full place-items-center"><Spinner /></div>
                  : <DiffViewer diff={detail?.diff || ''} />}
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
