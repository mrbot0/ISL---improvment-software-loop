import { EventEmitter } from 'node:events';
import { recordEvent } from './db.js';

/**
 * Central event bus. Everything the agents do flows through here:
 * the WebSocket layer rebroadcasts it to the dashboard, and durable
 * events are persisted so the activity feed survives a restart.
 */
class Bus extends EventEmitter {}
export const bus = new Bus();
bus.setMaxListeners(200);

/**
 * Event types written to the DB. Everything else is broadcast to open dashboards and then gone.
 *
 * This list had never been updated past the agent era: `agent.*`, `proposal.*`, `orchestrator.*`.
 * Not one event from the iteration pipeline the product is now built around — no `iteration.*`, no
 * `impl.*`, no `survey.*`, no `workbench.*`. A run's whole history therefore existed only as a
 * WebSocket broadcast, so closing the tab, reloading, or simply opening the dashboard after the run
 * had finished left nothing behind. Measured on this database: 400 stored events across three
 * types, 384 of them tool calls, and no trace of 435 runs.
 *
 * The pipeline events below are what a run actually consists of. `impl.tool` is the high-volume one
 * — one row per file operation — and it is included deliberately: it is the only record of the
 * longest phase of a run, the UI folds consecutive ones into a single line, and `trimEvents` caps
 * the table at 20k rows. Token deltas stay out; those are a stream, not a history.
 */
const DURABLE = new Set([
  /* the agents */
  'agent.started',
  'agent.finished',
  'agent.error',
  'agent.tool_call',
  'agent.plan',
  'agent.proposal_drafted',
  'agent.critique',
  /* proposals and their verification */
  'proposal.created',
  'verify.started',
  'verify.finished',
  'proposal.approved',
  'proposal.rejected',
  'proposal.applied',
  'proposal.apply_failed',
  /* the iteration pipeline — the part that was missing entirely */
  'iteration.started',
  'iteration.phase',
  'iteration.finished',
  /*
   * L'attribuzione di un difetto all'onda che lo ha introdotto è l'unico posto in cui esiste la
   * risposta a "quale task ha rotto questo". Emetterla senza persisterla la rendeva una notifica
   * che svaniva: quando l'iterazione fallisce e qualcuno indaga, arriva dopo. Qui sopravvive.
   */
  'iteration.wave_defects',
  'impl.task_started',
  'impl.task_finished',
  'impl.tool',
  'survey.started',
  'survey.finished',
  'research.finished',
  'workbench.check',
  'workbench.healing',
  'workbench.healed',
  'reliability.applied',
  /* the loop itself: starting, stopping, and the reasons it stands still */
  'control.loop',
  'control.tick',
  'orchestrator.started',
  'orchestrator.stopped',
  'orchestrator.tick',
  'config.changed',
]);

export function emit(type, payload = {}) {
  const event = { type, ts: Date.now(), ...payload };
  if (DURABLE.has(type)) {
    try {
      event.id = recordEvent(type, payload.runId ?? null, payload.agentId ?? null, payload);
    } catch {
      /* never let logging break a run */
    }
  }
  bus.emit('event', event);
  bus.emit(type, event);
  return event;
}
