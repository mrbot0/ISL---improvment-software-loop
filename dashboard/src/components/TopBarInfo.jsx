import { api } from '../api.js';
import { useResource } from '../hooks.js';
import { SAFETY_NET_MS } from '../liveKeys.js';

/**
 * Top-bar status chips: the two facts an operator needs at a glance from ANY page —
 *   • which model is actually doing the work (and whether embeddings are on), and
 *   • what focus the fleet has been told to follow, with a warning when the scope is not enforced.
 * Both click through to their settings, so the bar is a control, not just a readout.
 */
export default function TopBarInfo({ onNavigate }) {
  // Scope changes on a project switch, which is an event; the model choice changes when the operator
  // saves Settings. Neither needed the 30-second poll this replaces.
  const { data: models } = useResource('models', api.models, { interval: SAFETY_NET_MS });
  const { data: scope } = useResource('scope', api.scope, { interval: SAFETY_NET_MS });

  const eff = models?.effective;
  const short = (m) => (m || '').replace(/:latest$/, '').slice(0, 18);

  // The top-weighted, non-excluded theme — the one-word answer to "what is it working on?"
  let focus = null;
  if (scope?.share) {
    const top = Object.entries(scope.share).filter(([, v]) => v > 0).sort((a, b) => b[1] - a[1])[0];
    if (top) focus = { key: top[0], pct: top[1], label: scope.themes?.[top[0]]?.label || top[0] };
  }

  return (
    <div className="hidden items-center gap-1.5 xl:flex">
      {eff && (
        <button
          onClick={() => onNavigate('settings')}
          className="flex items-center gap-1.5 rounded-lg border border-ink-800 px-2 py-1 text-[11px] text-slate-400 hover:border-ink-700 hover:text-slate-200"
          title={`Implement: ${eff.roles?.implement?.model}\nReview: ${eff.roles?.review?.model}\nPlan: ${eff.roles?.plan?.model}\nEmbeddings: ${eff.embed?.model || 'off'}\n\nClick to change`}
        >
          <span className="text-slate-600">🧠</span>
          <span className="font-medium">{short(eff.default?.model)}</span>
          {eff.embed?.model
            ? <span className="h-1.5 w-1.5 rounded-full bg-violet-400" title="embeddings on" />
            : <span className="h-1.5 w-1.5 rounded-full bg-slate-700" title="embeddings off" />}
        </button>
      )}

      {focus && (
        <button
          onClick={() => onNavigate('scope')}
          className={`flex items-center gap-1.5 rounded-lg border px-2 py-1 text-[11px] ${
            scope?.scope?.enforce ? 'border-ink-800 text-slate-400 hover:text-slate-200' : 'border-amber-800/50 bg-amber-500/10 text-amber-300'
          }`}
          title={scope?.scope?.enforce
            ? `Focus: ${focus.label} ${focus.pct}% — the planner enforces this mix.\nClick to change the scope.`
            : 'The improvement scope is ADVISORY — the planner is not shaping the batch. Click to enforce it.'}
        >
          <span>🎯</span>
          <span className="font-medium">{focus.label}</span>
          <span className="text-slate-600">{focus.pct}%</span>
          {!scope?.scope?.enforce && <span className="text-[10px] uppercase">advisory</span>}
        </button>
      )}
    </div>
  );
}
