import { useEffect, useState } from 'react';
import { useFocusTrap } from '../useFocusTrap.js';
import { api } from '../api.js';
import { AGENT_META, Churn, SeverityPill, Spinner, StatusPill, ago } from './ui.jsx';
import DiffViewer from './DiffViewer.jsx';

export default function ProposalDetail({ id, onClose, onChanged }) {
  const [p, setP] = useState(null);
  const [busy, setBusy] = useState(null);
  const [error, setError] = useState(null);
  const [note, setNote] = useState('');

  const load = () => api.proposal(id).then(setP).catch((e) => setError(e.message));
  useEffect(() => {
    setP(null);
    setError(null);
    load();
  }, [id]);

  /*
   * Escape and focus are both owned by the trap inside `Panel` below.
   *
   * This panel carried `role="dialog"` and `aria-modal` while never moving focus into itself — the
   * markup claimed a modal and the behaviour was a page-shaped div. For a screen reader that is
   * worse than no role at all: it announces a dialog, and focus is still on the row behind it.
   */

  const act = async (label, fn) => {
    setBusy(label);
    setError(null);
    try {
      await fn();
      await load();
      onChanged?.();
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(null);
    }
  };

  if (error && !p) return <Panel onClose={onClose}><div className="p-6 text-sm text-rose-400">{error}</div></Panel>;
  if (!p) return <Panel onClose={onClose}><div className="grid h-40 place-items-center"><Spinner /></div></Panel>;

  const v = p.verification;
  const decided = !['verifying', 'verified', 'failed'].includes(p.status);
  const meta = AGENT_META[p.agentId] ?? { emoji: '🤖' };
  const isIdea = p.status === 'idea';

  return (
    <Panel onClose={onClose}>
      <div className="border-b border-ink-800 px-5 py-4">
        <div className="flex items-center gap-2">
          <span className="text-base">{meta.emoji}</span>
          <span className="font-mono text-[11px] text-slate-500">#{p.id}</span>
          <StatusPill status={p.status} />
          <SeverityPill severity={p.severity} />
          {p.confidence != null && (
            <span
              className="pill"
              style={{ background: (p.confidence >= 70 ? '#34d399' : p.confidence >= 40 ? '#fbbf24' : '#fb7185') + '22', color: p.confidence >= 70 ? '#34d399' : p.confidence >= 40 ? '#fbbf24' : '#fb7185' }}
              title="Agent's self-rated confidence"
            >
              {p.confidence}% conf
            </span>
          )}
          <div className="flex-1" />
          {!isIdea && <Churn additions={p.additions} deletions={p.deletions} />}
          <span className="text-[10px] text-slate-600">{ago(p.createdAt)}</span>
        </div>
        <h2 className="mt-2 text-base font-semibold text-white">{p.title}</h2>
        <p className="mt-1 text-xs leading-relaxed text-slate-400">{p.rationale}</p>
        <div className="mt-2 flex flex-wrap gap-1.5">
          {p.paths.map((f) => (
            <code key={f} className="rounded bg-ink-800 px-1.5 py-0.5 font-mono text-[10px] text-slate-400">{f}</code>
          ))}
        </div>
        {p.appliedRef && (
          <p className="mt-2 text-[11px] text-emerald-400">
            landed on <code className="font-mono">{p.appliedRef}</code>
            {p.appliedRef !== 'working-tree' && (
              <span className="ml-2 text-slate-500">git merge {p.appliedRef}</span>
            )}
          </p>
        )}
      </div>

      {v && (
        <div className="border-b border-ink-800 bg-ink-900/40 px-5 py-3">
          <div className="mb-2 flex items-center gap-2 text-[11px] font-medium">
            <span className={v.ok ? 'text-emerald-400' : 'text-rose-400'}>
              {v.ok ? '✓ verification passed' : '✕ verification failed'}
            </span>
            {v.skipped && <span className="text-slate-500">— no automated checks cover these paths</span>}
          </div>
          <div className="space-y-1.5">
            {v.checks?.map((c) => (
              <details key={c.name} className="group">
                <summary className="flex cursor-pointer list-none items-center gap-2 text-[11px]">
                  <span className={c.skipped ? 'text-slate-600' : c.ok ? 'text-emerald-500' : 'text-rose-500'}>
                    {c.skipped ? '○' : c.ok ? '●' : '✕'}
                  </span>
                  <code className="font-mono text-slate-400">{c.name}</code>
                  <span className="text-slate-600">{c.skipped ? 'skipped' : `${c.ms}ms`}</span>
                  {!c.ok && <span className="text-rose-400">exit {c.exitCode}</span>}
                  <span className="text-slate-700 group-open:hidden">· show output</span>
                </summary>
                <pre className="mt-1.5 max-h-56 overflow-auto rounded-lg bg-ink-950 p-2.5 font-mono text-[10px] leading-relaxed text-slate-400">
                  {c.output || '(no output)'}
                </pre>
              </details>
            ))}
          </div>
        </div>
      )}

      <div className="min-h-0 flex-1 overflow-auto bg-ink-950/60">
        {isIdea ? (
          <div className="grid h-full place-items-center p-6 text-center">
            <div className="max-w-md text-[12px] leading-relaxed text-slate-500">
              🌐 This is a <span className="text-indigo-300">research idea</span> — a new feature suggestion from online research, not code yet.
              It has been added to the backlog for the agents to implement when the loop runs.
            </div>
          </div>
        ) : (
          <DiffViewer diff={p.diff} />
        )}
      </div>

      <div className="border-t border-ink-800 bg-ink-900/70 px-5 py-3">
        {error && <p className="mb-2 text-[11px] text-rose-400">{error}</p>}

        {!v?.ok && p.status === 'failed' && !decided && (
          <p className="mb-2 rounded-lg border border-amber-900/50 bg-amber-950/30 px-2.5 py-1.5 text-[11px] text-amber-300">
            This change did not pass verification. Approving it will still land the code.
          </p>
        )}

        {isIdea ? (
          <div className="flex items-center justify-between">
            <span className="text-[11px] text-slate-500">Queued in the backlog for the agents. Dismiss to remove this idea.</span>
            <button className="btn-danger" disabled={!!busy} onClick={() => act('reject', () => api.reject(p.id, 'dismissed research idea'))}>
              {busy === 'reject' ? <Spinner /> : 'dismiss'}
            </button>
          </div>
        ) : (
          <div className="flex items-center gap-2">
            <input
              value={note}
              onChange={(e) => setNote(e.target.value)}
              placeholder="review note (optional)"
              className="input flex-1"
              disabled={decided}
            />
            <button className="btn-ghost" disabled={!!busy || p.status === 'applied'} onClick={() => act('reverify', () => api.reverify(p.id))}>
              {busy === 'reverify' ? <Spinner /> : '↻'} re-verify
            </button>
            <button className="btn-danger" disabled={!!busy || decided} onClick={() => act('reject', () => api.reject(p.id, note))}>
              reject
            </button>
            <button
              className="btn-primary"
              disabled={!!busy || decided}
              onClick={() => act('approve', () => api.approve(p.id, note))}
              title={v?.ok ? 'Approve and land' : 'Approve despite failing verification'}
            >
              {busy === 'approve' ? <Spinner /> : '✓'} approve {v?.ok ? '' : 'anyway'}
            </button>
          </div>
        )}
      </div>
    </Panel>
  );
}

/**
 * The overlay chrome. The trap lives HERE, not in `ProposalDetail`, because this is the component
 * that renders the dialog — and `ProposalDetail` returns a `Panel` from three different branches
 * (loading, error, loaded), so a ref held there would attach to whichever one rendered last.
 */
function Panel({ children, onClose }) {
  const trapRef = useFocusTrap(true, onClose);
  return (
    <div className="fixed inset-0 z-30 flex justify-end bg-black/60 backdrop-blur-sm" onClick={onClose}>
      <div
        className="flex h-full w-full max-w-4xl flex-col border-l border-ink-700 bg-ink-900 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label="Proposal detail"
        ref={trapRef}
        tabIndex={-1}
      >
        <div className="flex justify-end px-3 pt-3">
          <button onClick={onClose} className="btn-ghost" aria-label="Close">esc ✕</button>
        </div>
        {children}
      </div>
    </div>
  );
}
