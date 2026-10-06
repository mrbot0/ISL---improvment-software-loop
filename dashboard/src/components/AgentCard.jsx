import { useEffect, useState } from 'react';
import { AGENT_META, Spinner } from './ui.jsx';

export default function AgentCard({ agent, isRunning, isQueued, liveThought, onUpdate, onRun }) {
  const [editing, setEditing] = useState(false);
  const meta = AGENT_META[agent.id] ?? { emoji: '🤖', tint: 'text-slate-300' };

  return (
    <div
      className={`card p-3.5 transition-colors ${
        isRunning ? 'border-emerald-700/60 bg-emerald-950/20' : 'hover:border-ink-600'
      }`}
    >
      <div className="flex items-start gap-3">
        <div className={`grid h-9 w-9 shrink-0 place-items-center rounded-lg bg-ink-800 text-base ${isRunning ? 'animate-pulseRing' : ''}`}>
          {meta.emoji}
        </div>

        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <h3 className={`truncate text-sm font-semibold ${meta.tint}`}>{agent.name}</h3>
            {isRunning && <Spinner className="text-emerald-400" />}
            {isQueued && !isRunning && <span className="pill bg-sky-500/15 text-sky-300">queued</span>}
            <div className="flex-1" />
            <Toggle
              checked={agent.enabled}
              onChange={(enabled) => onUpdate(agent.id, { enabled })}
              label={`${agent.enabled ? 'Disable' : 'Enable'} ${agent.name}`}
            />
          </div>

          <p className="mt-0.5 line-clamp-2 text-[11px] leading-relaxed text-slate-500">{agent.description}</p>

          {isRunning && liveThought && (
            <p className="mt-2 line-clamp-2 border-l-2 border-emerald-800 pl-2 font-mono text-[10px] italic leading-relaxed text-emerald-600/80">
              {liveThought}
            </p>
          )}

          <div className="mt-2 flex flex-wrap gap-1">
            {agent.scope.include.slice(0, 3).map((g) => (
              <code key={g} className="rounded bg-ink-800/80 px-1.5 py-0.5 font-mono text-[10px] text-slate-500">
                {g}
              </code>
            ))}
            {agent.scope.include.length > 3 && (
              <span className="px-1 text-[10px] text-slate-600">+{agent.scope.include.length - 3}</span>
            )}
          </div>

          <div className="mt-2.5 flex items-center gap-1.5">
            <button className="btn-ghost" onClick={() => onRun(agent.id)} disabled={isRunning || isQueued || !agent.enabled}>
              ▶ run now
            </button>
            <button className="btn-ghost" onClick={() => setEditing((v) => !v)}>
              {editing ? 'close' : 'scope'}
            </button>
          </div>
        </div>
      </div>

      {editing && <ScopeEditor agent={agent} onUpdate={onUpdate} onRun={onRun} onClose={() => setEditing(false)} />}
    </div>
  );
}

function ScopeEditor({ agent, onUpdate, onRun, onClose }) {
  const [objective, setObjective] = useState(agent.objective);
  const [include, setInclude] = useState(agent.scope.include.join('\n'));
  const [exclude, setExclude] = useState(agent.scope.exclude.join('\n'));
  const [maxProposals, setMaxProposals] = useState(agent.maxProposals);
  const [instruction, setInstruction] = useState('');

  // A chat command or another tab can change the agent under us.
  useEffect(() => {
    setObjective(agent.objective);
    setInclude(agent.scope.include.join('\n'));
    setExclude(agent.scope.exclude.join('\n'));
    setMaxProposals(agent.maxProposals);
  }, [agent]);

  const lines = (s) => s.split('\n').map((l) => l.trim()).filter(Boolean);

  const save = () => {
    onUpdate(agent.id, {
      objective,
      maxProposals: Math.min(5, Math.max(1, Number(maxProposals) || 1)),
      scope: { include: lines(include), exclude: lines(exclude) },
    });
    onClose();
  };

  return (
    <div className="mt-3 space-y-2.5 border-t border-ink-800 pt-3">
      <label className="block">
        <span className="mb-1 block text-[10px] font-medium uppercase tracking-wide text-slate-500">Objective</span>
        <textarea rows={3} value={objective} onChange={(e) => setObjective(e.target.value)} className="input resize-y font-normal" />
      </label>

      <div className="grid grid-cols-2 gap-2">
        <label className="block">
          <span className="mb-1 block text-[10px] font-medium uppercase tracking-wide text-slate-500">Include (one glob per line)</span>
          <textarea rows={3} value={include} onChange={(e) => setInclude(e.target.value)} className="input resize-y font-mono text-[11px]" />
        </label>
        <label className="block">
          <span className="mb-1 block text-[10px] font-medium uppercase tracking-wide text-slate-500">Exclude</span>
          <textarea rows={3} value={exclude} onChange={(e) => setExclude(e.target.value)} className="input resize-y font-mono text-[11px]" />
        </label>
      </div>

      <div className="flex items-end gap-2">
        <label className="w-28">
          <span className="mb-1 block text-[10px] font-medium uppercase tracking-wide text-slate-500">Max proposals</span>
          <input type="number" min="1" max="5" value={maxProposals} onChange={(e) => setMaxProposals(e.target.value)} className="input" />
        </label>
        <div className="flex-1" />
        <button className="btn-primary" onClick={save}>
          save scope
        </button>
      </div>

      <div className="border-t border-ink-800 pt-2.5">
        <span className="mb-1 block text-[10px] font-medium uppercase tracking-wide text-slate-500">
          One-off instruction (overrides the objective for a single run)
        </span>
        <div className="flex gap-2">
          <input
            value={instruction}
            onChange={(e) => setInstruction(e.target.value)}
            placeholder="e.g. focus only on the Stripe webhook handler"
            className="input"
          />
          <button
            className="btn-ghost shrink-0"
            disabled={!instruction.trim()}
            onClick={() => {
              onRun(agent.id, instruction.trim());
              setInstruction('');
              onClose();
            }}
          >
            ▶ run
          </button>
        </div>
      </div>
    </div>
  );
}

const Toggle = ({ checked, onChange, label }) => (
  <button
    role="switch"
    // ARIA demands the string "true"/"false". `enabled` arrives from SQLite as 1/0, and React renders
    // that verbatim as aria-checked="1" — an invalid value, which leaves the switch with NO state as
    // far as a screen reader is concerned. Coercing here fixes it for every caller at once.
    aria-checked={!!checked}
    aria-label={label}
    onClick={() => onChange(!checked)}
    className={`relative h-4 w-7 shrink-0 rounded-full transition-colors ${checked ? 'bg-emerald-500' : 'bg-ink-700'}`}
  >
    <span
      className={`absolute top-0.5 h-3 w-3 rounded-full bg-white transition-transform ${checked ? 'translate-x-3.5' : 'translate-x-0.5'}`}
    />
  </button>
);
