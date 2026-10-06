import { useEffect, useState } from 'react';
import { api } from '../api.js';

/**
 * First-run guided tour (ISL_Frontend §15, P2).
 *
 * ISL has a real prerequisite chain — a project, then analysed context, then embeddings, then the
 * loop — and getting it wrong produces a system that looks broken rather than unconfigured: the loop
 * runs, finds nothing useful, and the operator concludes the product does not work. The tour exists
 * to make that chain visible once.
 *
 * Two decisions keep it from becoming the thing everyone dismisses on sight:
 *
 *   1. **It checks reality instead of tracking progress.** Each step asks the API whether it is
 *      already done, so an operator who set things up before ever seeing this sees a completed
 *      checklist, not a tutorial for work they finished. A tour that insists on being followed after
 *      the fact is the reason people close tours.
 *   2. **It shows only when there is something to do**, and dismissal is permanent per user
 *      (server-side, so it does not return on another machine).
 */

const DISMISS_KEY = 'tourDismissed';

/** Each step names what it needs, how to get it, and how to tell whether it is already true. */
const STEPS = [
  {
    id: 'project',
    title: 'Point ISL at a codebase',
    body: 'Everything else is relative to this. A project is a folder on disk that ISL reads, analyses and improves.',
    view: 'projects',
    check: async () => {
      const r = await api.projects().catch(() => null);
      return Array.isArray(r) ? r.length > 0 : (r?.projects?.length || 0) > 0;
    },
  },
  {
    id: 'context',
    title: 'Build the context',
    body: 'ISL reads the repository and writes down what it is: languages, layout, services, hotspots. Without this the agents plan against a codebase they have never seen.',
    view: 'context',
    check: async () => {
      const r = await api.context().catch(() => null);
      return !!r && (r.ready === true || (r.entries || r.documents || []).length > 0);
    },
  },
  {
    id: 'embeddings',
    title: 'Build the embeddings (optional but worth it)',
    body: 'Turns keyword search into "where is payment retry handled?". Without it retrieval falls back to lexical matching, which still works — just less well.',
    view: 'context',
    optional: true,
    check: async () => {
      const r = await api.knowledge('probe').catch(() => null);
      return (r?.embedded || 0) > 0 || r?.mode === 'hybrid';
    },
  },
  {
    id: 'scope',
    title: 'Set the improvement focus',
    body: 'Decide what the fleet should work on — UX, frontend, backend, security. Left alone, ISL defaults to user-visible work rather than writing tests forever.',
    view: 'scope',
    check: async () => {
      const r = await api.scope?.().catch(() => null);
      return !!r; // the scope always exists; visiting it is what matters, so this step is informational
    },
  },
  {
    id: 'loop',
    title: 'Arm the loop',
    body: 'ISL starts proposing and landing changes on its own work branch. Your main branch is never touched, and risky changes wait for you in the approval inbox.',
    view: 'iterations',
    check: async () => {
      const r = await api.state().catch(() => null);
      return !!(r?.iteration?.controller?.looping || (r?.iteration?.controller?.todayCount || 0) > 0);
    },
  },
];

export default function OnboardingTour({ onNavigate }) {
  const [state, setState] = useState(null); // { done: Set<id>, dismissed }
  const [open, setOpen] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const prefs = await api.preferences().catch(() => ({ prefs: {} }));
      if (prefs?.prefs?.[DISMISS_KEY]) return;
      // Checks run in parallel and each failure is a "not done", never an error the operator sees:
      // an endpoint this build does not have must not block onboarding.
      const results = await Promise.all(STEPS.map((s) => s.check().then((v) => !!v).catch(() => false)));
      if (cancelled) return;
      const done = new Set(STEPS.filter((_, i) => results[i]).map((s) => s.id));
      const remaining = STEPS.filter((s) => !done.has(s.id) && !s.optional);
      setState({ done });
      setOpen(remaining.length > 0);
    })();
    return () => { cancelled = true; };
  }, []);

  const dismiss = () => {
    setOpen(false);
    // Persisted server-side so it does not reappear on another machine.
    api.savePreferences({ [DISMISS_KEY]: true }).catch(() => { /* best effort */ });
  };

  if (!open || !state) return null;

  const doneCount = STEPS.filter((s) => state.done.has(s.id)).length;

  return (
    <div className="mb-3 rounded-lg border border-sky-500/30 bg-sky-500/5 p-3">
      <div className="flex items-center gap-2">
        <span className="text-[13px] font-medium text-sky-200">Getting ISL working</span>
        <span className="text-[11px] text-slate-500">{doneCount} of {STEPS.length} done</span>
        <div className="flex-1" />
        <button onClick={dismiss} className="text-[11px] text-slate-500 hover:text-slate-300" title="Do not show this again">dismiss</button>
      </div>
      <p className="mt-1 text-[11px] text-slate-400">
        These build on each other: skipping one does not break ISL, it makes it work on a codebase it does not understand.
      </p>
      <ol className="mt-2 space-y-1.5">
        {STEPS.map((s) => {
          const done = state.done.has(s.id);
          return (
            <li key={s.id} className="flex items-start gap-2 text-[12px]">
              <span className={`mt-0.5 shrink-0 ${done ? 'text-emerald-400' : 'text-slate-600'}`}>{done ? '✓' : '○'}</span>
              <div className="min-w-0 flex-1">
                <button
                  onClick={() => onNavigate?.(s.view)}
                  className={`text-left ${done ? 'text-slate-500 line-through decoration-slate-700' : 'text-slate-200 hover:text-white'}`}
                >
                  {s.title}
                  {s.optional && <span className="ml-1 text-[10px] text-slate-600">optional</span>}
                </button>
                {!done && <p className="text-[11px] text-slate-500">{s.body}</p>}
              </div>
            </li>
          );
        })}
      </ol>
    </div>
  );
}
