import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import Flow, { mergeFlowEvents, phaseTimings } from './Flow.jsx';

/**
 * The Flow view is the page an operator opens while a run is in flight, so its job is to answer
 * "what is it doing, and is it stuck?". These pin the two ways it can fail at that quietly: showing
 * a duration it does not actually know, and going blank when nothing is running.
 */

const ev = (over) => ({ type: 'iteration.phase', iterationId: 7, ts: 0, ...over });

describe('phaseTimings', () => {
  it('measures a phase from its start event to its end event', () => {
    const t = phaseTimings([
      ev({ phase: 'plan', status: 'running', ts: 1000 }),
      ev({ phase: 'plan', status: 'ok', ts: 4000, summary: '3 tasks', score: 88 }),
    ], 7);
    expect(t).toHaveLength(1);
    expect(t[0]).toMatchObject({ phase: 'plan', ms: 3000, status: 'ok', summary: '3 tasks', score: 88 });
  });

  it('reports a phase still running as live, with no duration yet', () => {
    const t = phaseTimings([ev({ phase: 'implement', status: 'running', ts: 1000 })], 7);
    expect(t[0].live).toBe(true);
    expect(t[0].ms).toBe(null);
    expect(t[0].startedAt).toBe(1000);
  });

  it('does NOT invent a duration when the opening event has aged out of the log', () => {
    // The event log is a bounded tail. A long run loses its early events, and a phase whose start
    // is gone must read as unmeasured — a fabricated 0s would be read as "this step was instant".
    const t = phaseTimings([ev({ phase: 'catalog', status: 'ok', ts: 9000 })], 7);
    expect(t[0].ms).toBe(null);
    expect(t[0].status).toBe('ok');
  });

  it('ignores phases belonging to a different run', () => {
    const t = phaseTimings([
      ev({ phase: 'plan', status: 'running', ts: 1000, iterationId: 99 }),
      ev({ phase: 'plan', status: 'ok', ts: 2000, iterationId: 99 }),
    ], 7);
    expect(t).toEqual([]);
  });

  it('returns phases in pipeline order, not the order they were logged', () => {
    const t = phaseTimings([
      ev({ phase: 'test', status: 'running', ts: 5000 }),
      ev({ phase: 'test', status: 'ok', ts: 6000 }),
      ev({ phase: 'catalog', status: 'running', ts: 1000 }),
      ev({ phase: 'catalog', status: 'ok', ts: 2000 }),
    ], 7);
    expect(t.map((p) => p.phase)).toEqual(['catalog', 'test']);
  });

  it('is safe with no run and no events', () => {
    expect(phaseTimings([], null)).toEqual([]);
    expect(phaseTimings([ev({ phase: 'plan', status: 'ok' })], null)).toEqual([]);
  });
});

describe('Live flow', () => {
  const orch = { fleet: { queued: [], pending: 0 }, looping: false, parallel: { maxTasks: 2 } };
  const iterating = { controller: { running: true, current: 7 }, recent: [{ id: 7, status: 'running', planTitle: 'A change' }] };
  const active = { id: 7, phase: 'implement', startedAt: Date.now() - 1000, phaseAt: Date.now() - 1000 };

  it('shows the work happening during implement — the phase that was silent', () => {
    /*
     * `implement` is the longest phase of a run (median ~38 minutes, measured) and the only one that
     * changes files, and none of its events were mapped: the timeline showed nothing for the whole
     * time it mattered, which reads as a stalled page.
     */
    render(
      <Flow
        events={[
          { type: 'impl.task_started', ts: Date.now() - 900, index: 1, total: 2, title: 'Harden the retry path', agent: 'quality' },
          { type: 'impl.task_finished', ts: Date.now() - 100, index: 1, title: 'Harden the retry path', ok: true, files: 3 },
        ]}
        orchestrator={orch} iteration={iterating} activeRun={active}
      />,
    );
    expect(screen.getByText(/task 1\/2 · quality/)).toBeInTheDocument();
    expect(screen.getByText(/task 1 landed · 3 file\(s\)/)).toBeInTheDocument();
  });

  it('folds a burst of tool calls into one line with a count', () => {
    // The implementer emits one event per file operation. Shown individually they push everything
    // else off the screen; dropped they leave the run looking dead.
    render(
      <Flow
        events={Array.from({ length: 8 }, (_, i) => ({
          type: 'impl.tool', ts: Date.now() - (8 - i) * 100, tool: 'edit_file', path: `src/f${i}.js`, taskTitle: 'T',
        }))}
        orchestrator={orch} iteration={iterating} activeRun={active}
      />,
    );
    expect(screen.getByText('×8')).toBeInTheDocument();
    expect(screen.getAllByText('edit_file')).toHaveLength(1);
  });

  it('does not fold across different tasks', () => {
    render(
      <Flow
        events={[
          { type: 'impl.tool', ts: 1, tool: 'edit_file', path: 'a.js', taskTitle: 'One' },
          { type: 'impl.tool', ts: 2, tool: 'edit_file', path: 'b.js', taskTitle: 'Two' },
        ]}
        orchestrator={orch} iteration={iterating} activeRun={active}
      />,
    );
    expect(screen.getAllByText('edit_file')).toHaveLength(2);
    expect(screen.queryByText('×2')).not.toBeInTheDocument();
  });

  it('surfaces a failing task rather than only a failing phase', () => {
    render(
      <Flow
        events={[{ type: 'impl.task_finished', ts: Date.now(), index: 2, title: 'Refactor pricing', ok: false, reason: 'the file was not found' }]}
        orchestrator={orch} iteration={iterating} activeRun={active}
      />,
    );
    expect(screen.getByText(/task 2 failed/)).toBeInTheDocument();
    expect(screen.getByText('the file was not found')).toBeInTheDocument();
  });

  it('says when the loop is standing by, and why', () => {
    // "Nothing is happening" and "something is stopping it from happening" look identical on a
    // timeline that drops control events — and the difference is the whole diagnosis.
    render(
      <Flow
        events={[{ type: 'control.tick', ts: Date.now(), skipped: 'not_leader', leader: 'HOST:31100:abc' }]}
        orchestrator={orch} iteration={{ controller: { running: false }, recent: [] }} activeRun={null}
      />,
    );
    expect(screen.getByText('standing by')).toBeInTheDocument();
    expect(screen.getByText(/another process holds the loop/)).toBeInTheDocument();
  });

  it('shows a phase result but not a bare "phase running" line', () => {
    // The phase table already carries running phases with their durations; repeating them here
    // would be the same information twice, and it crowded out the events that appear only here.
    render(
      <Flow
        events={[
          { type: 'iteration.phase', ts: 1, iterationId: 7, phase: 'review', status: 'running' },
          { type: 'iteration.phase', ts: 2, iterationId: 7, phase: 'review', status: 'ok', summary: 'looks sound', score: 82 },
        ]}
        orchestrator={orch} iteration={iterating} activeRun={active}
      />,
    );
    expect(screen.getByText('review done · 82')).toBeInTheDocument();
    // The summary appears in BOTH the per-phase table and the timeline, and that is intended: the
    // table describes THIS run and disappears with it, while the timeline is the chronological
    // record that outlives it. Unlike the static phase blurb — which was the same sentence twice
    // and was removed — this is a result specific to the run.
    expect(screen.getAllByText('looks sound').length).toBeGreaterThanOrEqual(1);
    // A phase merely starting must not produce a line of its own; the table already shows it live.
    expect(screen.queryByText(/phase review$/)).not.toBeInTheDocument();
  });

  it('never drops a phase failure', () => {
    render(
      <Flow
        events={[{ type: 'iteration.phase', ts: 1, iterationId: 7, phase: 'test', status: 'error', summary: '3 suites red' }]}
        orchestrator={orch} iteration={iterating} activeRun={active}
      />,
    );
    expect(screen.getByText('phase test failed')).toBeInTheDocument();
  });
});

describe('Flow', () => {
  const orch = { fleet: { queued: [], pending: 0 }, looping: false, parallel: { maxTasks: 2 } };

  it('says what the run is doing, not just that one exists', () => {
    render(
      <Flow
        events={[ev({ phase: 'implement', status: 'running', ts: Date.now() - 5000 })]}
        orchestrator={orch}
        iteration={{ controller: { running: true, current: 7 }, recent: [{ id: 7, status: 'running', planTitle: 'Harden the payment retry path' }] }}
        activeRun={{ id: 7, phase: 'implement', startedAt: Date.now() - 60000, phaseAt: Date.now() - 5000, trigger: 'loop' }}
      />,
    );
    // The plan title is the answer to "what"; the phase only answers "how far".
    expect(screen.getByText('Harden the payment retry path')).toBeInTheDocument();
    expect(screen.getAllByText('implement').length).toBeGreaterThan(0);
    expect(screen.getByText(/step 4 of 10/)).toBeInTheDocument();
    // The phase name alone means nothing to someone who does not know the pipeline.
    expect(screen.getByText(/specialists are editing files/i)).toBeInTheDocument();
  });

  it('shows the last run when idle instead of the word "idle"', () => {
    render(
      <Flow
        events={[]}
        orchestrator={orch}
        iteration={{
          controller: { running: false },
          recent: [{ id: 6, status: 'rolled_back', planTitle: 'Extract the pricing helper', scores: { total: 41 }, finishedAt: Date.now() - 120000, filesChanged: 3, gates: { coverage: { applicable: true, pct: 12, executable: 25, mode: 'advisory', pass: false } } }],
        }}
        activeRun={null}
      />,
    );
    expect(screen.getByText('Extract the pricing helper')).toBeInTheDocument();
    expect(screen.getByText('rolled back')).toBeInTheDocument();
    // The gate verdict travels with the run — this is the page where "why did that not land?" is asked.
    expect(screen.getByText(/12% of new lines tested/)).toBeInTheDocument();
    expect(screen.getByText(/loop is stopped/)).toBeInTheDocument();
  });

  it('distinguishes an armed loop from a stopped one when idle', () => {
    render(
      <Flow events={[]} orchestrator={{ ...orch, looping: true }} iteration={{ controller: { running: false }, recent: [] }} activeRun={null} />,
    );
    expect(screen.getByText(/another run will start on its own/)).toBeInTheDocument();
  });

  it('survives a snapshot with nothing in it', () => {
    render(<Flow events={[]} orchestrator={undefined} iteration={undefined} activeRun={null} />);
    expect(screen.getByText(/No runs yet/)).toBeInTheDocument();
  });
});

/**
 * THE FLOW HAD NO MEMORY.
 *
 * `bus.js` decides which events reach the database. Its list had never moved past the agent era —
 * no `iteration.*`, no `impl.*`, no `survey.*` — so a run's history existed only as a WebSocket
 * broadcast to whoever happened to be watching. Measured on the real database: 400 stored rows
 * across three types, 384 of them `agent.tool_call`, and no trace of 435 runs. Reloading the page
 * emptied the panel, which is exactly what "it doesn't keep track" describes.
 *
 * With the events stored, the view reads a history and merges the socket on top. These pin the
 * merge, because the failure it prevents — one event counted twice — looks like real activity.
 */
describe('mergeFlowEvents', () => {
  it('keeps the stored history when the socket has delivered nothing', () => {
    const stored = [{ id: 1, type: 'iteration.started', ts: 10 }];
    expect(mergeFlowEvents(stored, [])).toEqual(stored);
  });

  it('shows live events on a page that has no stored history yet', () => {
    const live = [{ type: 'impl.tool', ts: 5, tool: 'write_file' }];
    expect(mergeFlowEvents([], live)).toEqual(live);
  });

  it('counts a durable event once, however many times it arrives', () => {
    // `emit` writes the row and puts its id on the broadcast, so the same event is in both lists.
    const e = { id: 42, type: 'iteration.finished', ts: 90 };
    expect(mergeFlowEvents([e], [{ ...e }])).toHaveLength(1);
  });

  it('distinguishes two events that differ only in what they touched', () => {
    const live = [
      { type: 'impl.tool', ts: 5, tool: 'write_file', path: 'a.js' },
      { type: 'impl.tool', ts: 5, tool: 'write_file', path: 'b.js' },
    ];
    expect(mergeFlowEvents([], live)).toHaveLength(2);
  });

  it('orders everything by time, not by which list it came from', () => {
    const merged = mergeFlowEvents(
      [{ id: 1, type: 'a', ts: 30 }, { id: 2, type: 'b', ts: 10 }],
      [{ type: 'c', ts: 20 }],
    );
    expect(merged.map((e) => e.ts)).toEqual([10, 20, 30]);
  });

  it('survives nullish input and holes', () => {
    expect(mergeFlowEvents()).toEqual([]);
    expect(mergeFlowEvents(null, undefined)).toEqual([]);
    expect(mergeFlowEvents([null], [{ type: 'x', ts: 1 }])).toHaveLength(1);
  });
});

describe('the timeline reads the events that are actually stored', () => {
  it('renders agent tool calls, which are most of the database', () => {
    // This map covered thirteen event types and not `agent.tool_call` — so 384 of 400 stored rows
    // were dropped and a freshly loaded page showed the few started/finished lines around them.
    render(
      <Flow
        events={[
          { id: 1, type: 'agent.started', agentId: 'workbench', ts: 1 },
          { id: 2, type: 'agent.tool_call', agentId: 'workbench', tool: 'read_file', args: { path: 'src/pay.js' }, ts: 2 },
        ]}
        orchestrator={{}}
        iteration={{ controller: {}, recent: [] }}
        activeRun={null}
      />,
    );
    expect(screen.getByText('read_file')).toBeTruthy();
    expect(screen.getByText('src/pay.js')).toBeTruthy();
  });
});
