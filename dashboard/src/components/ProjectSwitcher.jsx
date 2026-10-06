import { useState } from 'react';

/**
 * The active-project selector. Switching re-points the whole control plane at a
 * different code folder, so the choice lives in the chrome, always visible.
 */
export default function ProjectSwitcher({ projects = [], active, onSwitch, onManage, busy }) {
  const [open, setOpen] = useState(false);
  const live = projects.filter((p) => !p.archived);

  return (
    <div className="relative">
      <button
        onClick={() => setOpen((v) => !v)}
        className="flex items-center gap-2 rounded-lg border border-ink-700 bg-ink-900/60 px-2.5 py-1.5 text-[12px] text-slate-200 hover:bg-ink-800"
        title="Switch project"
      >
        <span className="h-2 w-2 rounded-full bg-brand" />
        <span className="max-w-[160px] truncate font-medium">{active?.name ?? 'No project'}</span>
        <span className="text-slate-500">▾</span>
      </button>

      {open && (
        <>
          <div className="fixed inset-0 z-40" onClick={() => setOpen(false)} />
          <div className="absolute left-0 z-50 mt-1 w-72 rounded-xl border border-ink-700 bg-ink-900 p-1.5 shadow-lift">
            <div className="px-2 py-1 text-[10px] font-semibold uppercase tracking-[0.14em] text-slate-600">Projects</div>
            <div className="max-h-72 overflow-y-auto">
              {live.map((p) => {
                const isActive = p.id === active?.id;
                return (
                  <button
                    key={p.id}
                    disabled={busy || isActive}
                    onClick={async () => {
                      setOpen(false);
                      if (!isActive) await onSwitch(p.id);
                    }}
                    className={`flex w-full items-start gap-2 rounded-lg px-2 py-1.5 text-left text-[12px] ${
                      isActive ? 'bg-ink-800 text-white' : 'text-slate-300 hover:bg-ink-800'
                    }`}
                  >
                    <span className={`mt-1 h-2 w-2 shrink-0 rounded-full ${isActive ? 'bg-brand' : 'bg-slate-600'}`} />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate font-medium">{p.name}</span>
                      <span className="block truncate text-[10px] text-slate-500">{p.codePath}</span>
                    </span>
                    {p.contextReady ? (
                      <span className="mt-0.5 text-[10px] text-emerald-400" title="Context ready">●</span>
                    ) : (
                      <span className="mt-0.5 text-[10px] text-amber-400" title="Context not built yet">○</span>
                    )}
                  </button>
                );
              })}
              {!live.length && <div className="px-2 py-3 text-center text-[11px] text-slate-600">No projects yet</div>}
            </div>
            <div className="mt-1 border-t border-ink-800 pt-1">
              <button
                onClick={() => {
                  setOpen(false);
                  onManage?.();
                }}
                className="w-full rounded-lg px-2 py-1.5 text-left text-[12px] text-slate-400 hover:bg-ink-800 hover:text-slate-200"
              >
                ⚙ Manage projects
              </button>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
