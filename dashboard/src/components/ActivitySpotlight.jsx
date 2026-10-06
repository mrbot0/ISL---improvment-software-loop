import { useEffect, useMemo, useState } from 'react';

/**
 * Live activity spotlight — "what is happening right now", always visible (ISL_Frontend §15, P1).
 *
 * The loop runs for minutes at a time and, from any page other than Flow, gives no sign of life.
 * That silence is the problem: an operator cannot tell a working run from a hung one, so they open
 * Flow "just to check", which is the interruption this strip exists to remove.
 *
 * Driven entirely by the WebSocket events the store already receives — no polling, no new endpoint.
 * It shows only while something is actually running, because a permanent "idle" bar would be
 * furniture: it would occupy the space without ever carrying information.
 */

/** The phases, in pipeline order, so progress is positional rather than a number to interpret. */
const PHASES = ['catalog', 'survey', 'plan', 'implement', 'review', 'security', 'regression', 'test', 'workbench', 'finalize'];

const elapsed = (since) => {
  const s = Math.max(0, Math.round((Date.now() - since) / 1000));
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, '0')}s`;
};

export default function ActivitySpotlight({ activeRun, iteration, onOpen }) {
  const [, tick] = useState(0);

  const controllerRunning = !!iteration?.controller?.running;
  const controllerId = iteration?.controller?.current ?? null;

  /**
   * `activeRun` is maintained by the store, event by event — NOT folded from the event log here.
   *
   * The first version did fold the log, and it was wrong in a way only a real run exposed: the log
   * is a bounded tail, one chatty event type fills it in under three minutes, and a run lasts longer.
   * `iteration.started` was therefore evicted mid-run, the fold concluded no run existed, and every
   * later phase event looked orphaned. Run state must not be a function of a buffer that forgets.
   *
   * The controller is the fallback for a client that connected mid-run before any phase event: it
   * knows a run is in flight and its id, just not which phase.
   */
  const run = useMemo(() => {
    if (activeRun) return activeRun;
    if (controllerRunning) return { id: controllerId, phase: null, summary: null, startedAt: null, phaseAt: null };
    return null;
  }, [activeRun, controllerRunning, controllerId]);

  const running = !!run;
  useEffect(() => {
    if (!running) return;
    const t = setInterval(() => tick((n) => n + 1), 1000);
    return () => clearInterval(t);
  }, [running]);

  if (!running) return null;

  const phaseIdx = run?.phase ? PHASES.indexOf(run.phase) : -1;
  // The controller exposes the running iteration as `current`. The event-derived id is preferred
  // because it is available the instant the run starts, before the next state snapshot lands.
  const id = run?.id ?? iteration?.controller?.current ?? null;

  return (
    <button
      onClick={onOpen}
      title="Open the Flow view for the full picture"
      className="flex w-full items-center gap-2 overflow-hidden border-b border-ink-800 bg-ink-900/70 px-3 py-1.5 text-left text-[11px] hover:bg-ink-800/70"
    >
      {/* A pulsing dot is the cheapest possible "this is alive" signal, and the one an operator
          reads without focusing on it. */}
      <span className="relative flex h-2 w-2 shrink-0">
        <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-400 opacity-60" />
        <span className="relative inline-flex h-2 w-2 rounded-full bg-emerald-500" />
      </span>

      <span className="shrink-0 font-mono text-slate-400" data-spotlight="run-id">{id != null ? `#${id}` : 'run'}</span>

      {/* Positional progress: which phase, out of the pipeline you can see. */}
      <span className="hidden shrink-0 items-center gap-0.5 sm:flex">
        {PHASES.map((p, i) => (
          <span
            key={p}
            title={p}
            className={`h-1.5 w-3 rounded-sm ${
              phaseIdx < 0 ? 'bg-ink-700' : i < phaseIdx ? 'bg-emerald-600/70' : i === phaseIdx ? 'bg-emerald-400' : 'bg-ink-700'
            }`}
          />
        ))}
      </span>

      <span className="shrink-0 font-medium text-slate-200">{run?.phase || 'starting'}</span>
      {run?.summary && <span className="min-w-0 flex-1 truncate text-slate-500">{run.summary}</span>}
      <div className="flex-1" />
      <span className="shrink-0 tabular-nums text-slate-500" title="time in this phase">
        {run?.phaseAt ? elapsed(run.phaseAt) : ''}
      </span>
      <span className="hidden shrink-0 tabular-nums text-slate-600 sm:inline" title="total run time">
        · {run?.startedAt ? elapsed(run.startedAt) : ''}
      </span>
      <span className="shrink-0 text-slate-600">⇉</span>
    </button>
  );
}
