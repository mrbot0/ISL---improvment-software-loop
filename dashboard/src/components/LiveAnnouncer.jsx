import { useEffect, useRef, useState } from 'react';

/**
 * WHAT A SCREEN READER IS TOLD WHILE A RUN IS HAPPENING.
 *
 * The dashboard's whole point is watching an autonomous loop work. Every signal it gives about that
 * — the phase strip, the pulsing dot, the score rings, the status pills — is **visual only**. A
 * screen-reader user opening this page during a run learns nothing: no announcement when a run
 * starts, none when it moves phase, none when it commits or is vetoed. The toast has `aria-live`,
 * but toasts fire on *your* actions, not on the loop's.
 *
 * **The hard part is saying less, not more.** A live region wired to the event bus would announce
 * dozens of times a minute and make the page unusable with a screen reader on — worse than silence,
 * because the user cannot turn it off. So:
 *
 *   - only STATE CHANGES are announced, never repeats of the same message;
 *   - only the four things an operator actually waits for: a run starting, its phase changing, its
 *     outcome, and a gate refusing it;
 *   - `polite`, never `assertive` — this must queue behind whatever is being read, not interrupt it;
 *   - the region is always mounted and only its text changes, because a region added to the DOM at
 *     the same moment as its content is not reliably announced.
 */

/** Plain-language phase names — the pipeline's tokens mean nothing read aloud. */
const PHASE_SAID = {
  catalog: 'indexing the codebase',
  survey: 'reading the code',
  plan: 'planning the work',
  implement: 'writing the change',
  review: 'reviewing the change',
  security: 'security scan',
  regression: 'regression check',
  test: 'running tests',
  workbench: 'checking the app boots',
  finalize: 'finalising',
};

const OUTCOME_SAID = {
  committed: 'committed',
  promoted: 'promoted',
  rolled_back: 'rolled back',
  error: 'failed with an error',
  interrupted: 'was interrupted',
  empty: 'produced no changes',
};

export default function LiveAnnouncer({ activeRun, events }) {
  const [message, setMessage] = useState('');
  // What was last said, so an unchanged state is not re-announced on every re-render.
  const said = useRef('');

  const runId = activeRun?.id ?? null;
  const phase = activeRun?.phase ?? null;

  useEffect(() => {
    if (runId == null) return;
    const text = phase
      ? `Run ${runId}: ${PHASE_SAID[phase] || phase}`
      : `Run ${runId} started`;
    if (text === said.current) return;
    said.current = text;
    setMessage(text);
  }, [runId, phase]);

  /*
   * Outcomes and vetoes come from the event stream rather than `activeRun`, which is cleared the
   * moment a run ends — the one announcement a user most wants is the one the state no longer holds.
   */
  useEffect(() => {
    const last = events?.[events.length - 1];
    if (!last) return;

    let text = null;
    if (last.type === 'iteration.finished') {
      const outcome = OUTCOME_SAID[last.status] || last.status;
      text = `Run ${last.iterationId} ${outcome}${last.total != null ? `, score ${last.total}` : ''}`;
    } else if (last.type === 'iteration.phase' && last.status === 'error') {
      // A gate refusing a change is the event an operator is waiting for and the one that otherwise
      // passes in silence.
      text = `Run ${last.iterationId} blocked at ${PHASE_SAID[last.phase] || last.phase}${last.summary ? `: ${last.summary}` : ''}`;
    }

    if (!text || text === said.current) return;
    said.current = text;
    setMessage(text);
  }, [events]);

  return (
    <div
      aria-live="polite"
      aria-atomic="true"
      // Visually hidden, not `display: none` — a hidden region is not announced at all.
      className="sr-only"
      data-testid="live-announcer"
    >
      {message}
    </div>
  );
}
