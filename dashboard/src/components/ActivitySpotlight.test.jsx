import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import ActivitySpotlight from './ActivitySpotlight.jsx';

/**
 * The strip renders the run state the STORE maintains (see store.js: it is tracked event by event,
 * not folded from the bounded event log, which forgets `iteration.started` long before a run ends).
 * What matters here is that the strip is honest about that state: silent when nothing runs, never
 * claiming activity it cannot substantiate, and falling back to the controller when a client
 * connected mid-run and has not yet seen a phase event.
 */
const run = (over = {}) => ({ id: 42, phase: 'review', summary: null, startedAt: Date.now() - 90_000, phaseAt: Date.now() - 5_000, ...over });

describe('ActivitySpotlight', () => {
  it('renders nothing when nothing is running', () => {
    const { container } = render(<ActivitySpotlight activeRun={null} iteration={null} />);
    expect(container.firstChild).toBeNull();
  });

  it('renders nothing when the controller is idle', () => {
    const { container } = render(<ActivitySpotlight activeRun={null} iteration={{ controller: { running: false } }} />);
    expect(container.firstChild).toBeNull();
  });

  it('shows the run id and current phase', () => {
    render(<ActivitySpotlight activeRun={run()} iteration={null} />);
    expect(screen.getByText('#42')).toBeTruthy();
    expect(screen.getByText('review')).toBeTruthy();
  });

  it("shows 'starting' before the first phase is known", () => {
    render(<ActivitySpotlight activeRun={run({ phase: null })} iteration={null} />);
    expect(screen.getByText('starting')).toBeTruthy();
  });

  it('surfaces the phase summary when one is reported', () => {
    render(<ActivitySpotlight activeRun={run({ summary: '42 tests passed' })} iteration={null} />);
    expect(screen.getByText('42 tests passed')).toBeTruthy();
  });

  it('renders both clocks', () => {
    render(<ActivitySpotlight activeRun={run()} iteration={null} />);
    expect(screen.getByText('5s')).toBeTruthy();          // time in phase
    expect(screen.getByText(/1m 30s/)).toBeTruthy();      // total run time
  });

  it('marks completed, current and pending phases distinctly', () => {
    const { container } = render(<ActivitySpotlight activeRun={run({ phase: 'security' })} iteration={null} />);
    const ticks = [...container.querySelectorAll('span.rounded-sm')];
    expect(ticks).toHaveLength(10);
    // security is index 5: five done, one current, four pending.
    expect(ticks.filter((t) => t.className.includes('emerald-600'))).toHaveLength(5);
    expect(ticks.filter((t) => t.className.includes('emerald-400'))).toHaveLength(1);
  });

  /**
   * A client that connected mid-run has no `activeRun` until the next phase event, but the
   * controller already knows a run is in flight — the strip must say so rather than stay silent.
   */
  it('falls back to the controller when the store has no run yet', () => {
    render(<ActivitySpotlight activeRun={null} iteration={{ controller: { running: true, current: 9 } }} />);
    expect(screen.getByText('#9')).toBeTruthy();
    expect(screen.getByText('starting')).toBeTruthy();
  });

  it('still announces a run whose id is not known yet', () => {
    render(<ActivitySpotlight activeRun={null} iteration={{ controller: { running: true, current: null } }} />);
    expect(screen.getByText('run')).toBeTruthy();
  });

  // Clocks are absent in the controller fallback; showing "0s" would be a fabricated measurement.
  // Asserted on the clock elements themselves — a regex over the whole strip matches "#9" followed
  // by "starting" and would have failed for a reason that has nothing to do with clocks.
  it('omits the clocks rather than inventing them', () => {
    const { container } = render(<ActivitySpotlight activeRun={null} iteration={{ controller: { running: true, current: 9 } }} />);
    const clocks = [...container.querySelectorAll('span.tabular-nums')];
    expect(clocks).toHaveLength(2);
    expect(clocks.map((c) => c.textContent.replace(/[·\s]/g, ''))).toEqual(['', '']);
  });

  it('the store run wins over the controller fallback', () => {
    render(<ActivitySpotlight activeRun={run({ id: 42 })} iteration={{ controller: { running: true, current: 9 } }} />);
    expect(screen.getByText('#42')).toBeTruthy();
    expect(screen.queryByText('#9')).toBeNull();
  });
});
