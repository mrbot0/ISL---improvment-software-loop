import { useState } from 'react';
import { api } from '../api.js';
import { useResource } from '../hooks.js';
import { Resource } from '../components/Resource.jsx';
import { Empty, Spinner, ago } from '../components/ui.jsx';
import { useConfirm } from '../components/ConfirmDialog.jsx';
import DiffViewer from '../components/DiffViewer.jsx';

/**
 * REPAIR — is the app working, and can it be made to work?
 *
 * The workbench answers "does this CHANGE still boot?" as one gate inside an iteration. Nothing
 * answered the question an operator actually has, which is about the application as it stands right
 * now: is it broken, what exactly is broken, and can you fix it.
 *
 * The page states two things plainly and repeatedly, because both are easy to assume wrongly:
 *
 *   - **Nothing here touches your checkout.** Diagnosis and repair run in a detached worktree. A
 *     repair produces a diff you review; landing it goes through the same path as any other change.
 *   - **"All checks pass" is a result, not a failure.** A repair tool that always finds something to
 *     change is a tool that damages working software.
 */

const AREA_BLURB = {
  backend: 'the server starts and answers /api/health',
  services: 'each service module loads without throwing',
  frontend: 'the frontend build completes',
};

export default function Repair({ toast }) {
  const [busy, setBusy] = useState(null); // 'diagnose' | 'repair'
  const [result, setResult] = useState(null); // the repair attempt, when one has been made
  const [open, setOpen] = useState({});
  const [confirm, confirmUI] = useConfirm();

  const res = useResource('repair', () => api.repairState(), { interval: 0 });
  const { data, refetch } = res;
  if (!data) return <Resource {...res} rows={3} emptyTitle="Repair unavailable" />;

  const diagnosis = result?.findings ? result : data.last;
  const findings = diagnosis?.findings || [];
  const failing = findings.filter((f) => !f.ok && !f.skipped);

  const run = async (kind) => {
    setBusy(kind);
    try {
      const r = kind === 'diagnose' ? await api.repairDiagnose() : await api.repairRun();
      if (r?.error) { toast?.(r.error, { type: 'error' }); return; }
      setResult(kind === 'repair' ? r : null);
      await refetch();
      toast?.(r.summary || 'done', { type: r.ok === false || r.repaired === false ? 'info' : 'success' });
    } catch (e) {
      toast?.(e.message, { type: 'error' });
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="mx-auto max-w-4xl space-y-4">
      {confirmUI}

      <div className="card p-4">
        <div className="flex flex-wrap items-center gap-2">
          <div className="min-w-0 flex-1">
            <h3 className="text-[10px] font-semibold uppercase tracking-wide text-slate-500">Application health</h3>
            {!diagnosis ? (
              <p className="mt-1 text-[12px] text-slate-400">Nothing checked yet.</p>
            ) : (
              <p className={`mt-1 text-[13px] font-medium ${failing.length ? 'text-rose-300' : 'text-emerald-300'}`}>
                {diagnosis.summary}
              </p>
            )}
            {diagnosis?.checkedAt && (
              <p className="mt-0.5 text-[10px] text-slate-600">
                checked {ago(diagnosis.checkedAt)}
                {diagnosis.commit ? ` · at ${String(diagnosis.commit).slice(0, 8)}` : ''}
                {/* Provenance: a verdict on HEAD when the operator has uncommitted work describes a
                    codebase nobody has. The overlay makes it real, and saying so keeps it honest. */}
                {diagnosis.dirty ? ` · including ${diagnosis.uncommittedFiles} uncommitted file(s)` : ''}
              </p>
            )}
          </div>
          <button className="btn-ghost" disabled={!!busy} onClick={() => run('diagnose')}>
            {busy === 'diagnose' ? <><Spinner className="mr-1" /> checking…</> : '⟳ Check now'}
          </button>
          <button
            className="btn-primary"
            disabled={!!busy}
            onClick={async () => {
              if (!(await confirm({
                title: 'Attempt a repair?',
                message: 'It runs in a throwaway worktree and produces a diff for you to review — your checkout is not touched. It uses the model, so it can take a few minutes.',
                confirmLabel: 'Repair',
                tone: 'primary',
              }))) return;
              run('repair');
            }}
          >
            {busy === 'repair' ? <><Spinner className="mr-1" /> repairing…</> : '🔧 Repair'}
          </button>
        </div>
        <p className="mt-2 border-t border-ink-800 pt-2 text-[10px] leading-relaxed text-slate-600">
          Both run in a detached git worktree. Nothing writes to your working tree — a repair gives
          you a diff, and landing it goes through the same review as any other change.
        </p>
      </div>

      {result && (
        <div className={`card p-4 ${result.repaired ? 'border-emerald-900/50' : ''}`}>
          <h3 className="text-[10px] font-semibold uppercase tracking-wide text-slate-500">Repair attempt</h3>
          <p className={`mt-1 text-[12px] ${result.repaired ? 'text-emerald-300' : result.nothingToDo ? 'text-slate-300' : 'text-amber-300'}`}>
            {result.summary}
          </p>
          {result.fixes?.length > 0 && (
            <ul className="mt-2 space-y-0.5 text-[11px]">
              {result.fixes.map((f, i) => (
                <li key={i} className="flex gap-2">
                  <span className="font-mono text-slate-400">{f.file || '(file not recorded)'}</span>
                  {f.why && <span className="min-w-0 flex-1 truncate text-slate-500">{f.why}</span>}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      {!findings.length ? (
        <Empty icon="🔧" title="No health report yet" hint="Check now boots the app in a throwaway copy and reports what does not work." />
      ) : (
        <div className="card">
          <h3 className="border-b border-ink-800 px-4 py-2.5 text-xs font-semibold uppercase tracking-wide text-slate-400">
            Checks
          </h3>
          <ul className="divide-y divide-ink-800/60">
            {findings.map((f) => (
              <li key={f.area} className="px-4 py-2.5">
                <div className="flex items-start gap-2">
                  <span className={`mt-0.5 ${f.skipped ? 'text-slate-600' : f.ok ? 'text-emerald-500' : 'text-rose-500'}`}>
                    {f.skipped ? '·' : f.ok ? '✓' : '✕'}
                  </span>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-baseline gap-2">
                      <span className="text-[12px] font-medium text-slate-200">{f.area}</span>
                      {/* "Skipped" and "passed" must not look the same: a surface this repo does not
                          have was never tested, and reading that as healthy is how a gap hides. */}
                      {f.skipped && <span className="pill bg-ink-800 text-slate-500">not present</span>}
                      <span className="text-[10px] text-slate-600">{AREA_BLURB[f.area] || ''}</span>
                    </div>
                    <div className={`mt-0.5 text-[11px] ${f.ok ? 'text-slate-500' : 'text-rose-300/90'}`}>{f.reason}</div>
                    {f.output && (
                      <>
                        <button
                          className="mt-1 text-[10px] text-slate-500 hover:text-slate-300"
                          onClick={() => setOpen((o) => ({ ...o, [f.area]: !o[f.area] }))}
                        >
                          {open[f.area] ? '▾ hide output' : '▸ show the actual output'}
                        </button>
                        {open[f.area] && (
                          <pre className="mt-1 max-h-64 overflow-auto rounded border border-ink-800 bg-ink-950/60 p-2 text-[10px] leading-relaxed text-slate-400">
                            {f.output}
                          </pre>
                        )}
                      </>
                    )}
                  </div>
                </div>
              </li>
            ))}
          </ul>
        </div>
      )}

      {result?.diff && (
        <div className="card flex max-h-[60vh] min-h-0 flex-col">
          <h3 className="border-b border-ink-800 px-4 py-2.5 text-xs font-semibold uppercase tracking-wide text-slate-400">
            The change that would fix it · {result.files?.length || 0} file(s)
          </h3>
          <div className="min-h-0 flex-1 overflow-hidden">
            <DiffViewer diff={result.diff} />
          </div>
        </div>
      )}
    </div>
  );
}
