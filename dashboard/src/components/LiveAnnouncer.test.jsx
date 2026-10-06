import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import LiveAnnouncer from './LiveAnnouncer.jsx';

/**
 * What a screen reader is told while the loop runs — and, more importantly, what it is NOT told.
 *
 * Everything the dashboard says about a run in progress is visual: the phase strip, the pulsing
 * dot, the score rings, the status pills. A screen-reader user watching a run learned nothing.
 *
 * The failure mode of fixing that badly is worse than the gap. A live region wired straight to the
 * event bus would speak dozens of times a minute over whatever the user is reading, and they cannot
 * turn it off. So half of these tests assert **silence**: no repeat of an unchanged state, no
 * announcement for the routine traffic, and `polite` rather than `assertive`.
 */

const region = () => screen.getByTestId('live-announcer');

describe('LiveAnnouncer', () => {
  it('is polite and always present', () => {
    // `assertive` interrupts mid-sentence; a run moving phase does not warrant that.
    render(<LiveAnnouncer activeRun={null} events={[]} />);
    expect(region()).toHaveAttribute('aria-live', 'polite');
    // The region must exist BEFORE it has content — one added to the DOM together with its text
    // is not reliably announced.
    expect(region()).toBeInTheDocument();
    expect(region()).toHaveTextContent('');
  });

  it('announces a run starting', () => {
    render(<LiveAnnouncer activeRun={{ id: 42, phase: null }} events={[]} />);
    expect(region()).toHaveTextContent('Run 42 started');
  });

  it('says the phase in words, not the pipeline token', () => {
    // "implement" read aloud tells an operator nothing; "writing the change" does.
    render(<LiveAnnouncer activeRun={{ id: 42, phase: 'implement' }} events={[]} />);
    expect(region()).toHaveTextContent('Run 42: writing the change');
  });

  it('DOES NOT repeat an unchanged state', () => {
    // A re-render is not news. Without this the region re-announces on every store update.
    const run = { id: 42, phase: 'review' };
    const { rerender } = render(<LiveAnnouncer activeRun={run} events={[]} />);
    const first = region().textContent;
    rerender(<LiveAnnouncer activeRun={{ ...run }} events={[]} />);
    expect(region().textContent).toBe(first);
  });

  it('announces the outcome, which the run state no longer holds', () => {
    // `activeRun` is cleared the moment a run ends, so the one announcement an operator most wants
    // has to come from the event stream instead.
    render(
      <LiveAnnouncer
        activeRun={null}
        events={[{ type: 'iteration.finished', iterationId: 7, status: 'committed', total: 92 }]}
      />,
    );
    expect(region()).toHaveTextContent('Run 7 committed, score 92');
  });

  it('names a rolled-back run in plain words', () => {
    render(
      <LiveAnnouncer activeRun={null} events={[{ type: 'iteration.finished', iterationId: 8, status: 'rolled_back' }]} />,
    );
    expect(region()).toHaveTextContent('Run 8 rolled back');
    expect(region()).not.toHaveTextContent('rolled_back');
  });

  it('announces a gate blocking a change', () => {
    // The event an operator is waiting for, and the one that otherwise passes in complete silence.
    render(
      <LiveAnnouncer
        activeRun={null}
        events={[{ type: 'iteration.phase', iterationId: 9, phase: 'test', status: 'error', summary: '2 suites red' }]}
      />,
    );
    expect(region()).toHaveTextContent('Run 9 blocked at running tests: 2 suites red');
  });

  it('SAYS NOTHING for routine phase traffic on the event stream', () => {
    // Phase progress is already announced from `activeRun`. Announcing it a second time from the
    // bus would double every message.
    render(
      <LiveAnnouncer
        activeRun={null}
        events={[{ type: 'iteration.phase', iterationId: 9, phase: 'review', status: 'running' }]}
      />,
    );
    expect(region()).toHaveTextContent('');
  });

  it('SAYS NOTHING for the chatter the loop emits constantly', () => {
    // Tool calls, ticks and token streams arrive many times a second. Any of them reaching the
    // region would make the page unusable with a screen reader.
    render(
      <LiveAnnouncer
        activeRun={null}
        events={[
          { type: 'impl.tool', tool: 'edit_file', path: 'a.js' },
          { type: 'orchestrator.tick', agentId: 'quality' },
        ]}
      />,
    );
    expect(region()).toHaveTextContent('');
  });

  it('survives an empty or absent event list', () => {
    expect(() => render(<LiveAnnouncer activeRun={null} events={undefined} />)).not.toThrow();
  });
});
