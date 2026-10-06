import { describe, expect, it } from 'vitest';
import { filterRuns } from './Iterations.jsx';

const runs = [
  { id: 429, status: 'interrupted', planTitle: 'UX Polish: Listing Detail', resumable: true, failure: { title: 'Interrupted — the run was cancelled' } },
  { id: 428, status: 'rolled_back', planTitle: 'OtpDialog Resend Logic', resumable: true, failure: { title: 'the change produced code that does not compile' } },
  { id: 392, status: 'empty', planTitle: 'Iteration improvements', resumable: false, failure: { title: 'the implementer produced no edits' } },
  { id: 300, status: 'committed', planTitle: 'Search route cleanup', resumable: false, failure: null },
];

describe('filterRuns', () => {
  it('returns everything by default', () => {
    expect(filterRuns(runs)).toHaveLength(4);
    expect(filterRuns(runs, { status: 'all' })).toHaveLength(4);
  });

  it('filters by outcome', () => {
    expect(filterRuns(runs, { status: 'rolled_back' }).map((r) => r.id)).toEqual([428]);
    expect(filterRuns(runs, { status: 'empty' }).map((r) => r.id)).toEqual([392]);
    expect(filterRuns(runs, { status: 'committed' }).map((r) => r.id)).toEqual([300]);
  });

  it('treats restartable as a property, not an outcome', () => {
    // `resumable` cuts across statuses — an interrupted run and a rolled-back one can both be
    // picked up, and that is the list an operator wants when clearing a backlog of failures.
    expect(filterRuns(runs, { status: 'resumable' }).map((r) => r.id)).toEqual([429, 428]);
  });

  it('searches the title, the id and the failure', () => {
    expect(filterRuns(runs, { query: 'otpdialog' }).map((r) => r.id)).toEqual([428]);
    expect(filterRuns(runs, { query: '392' }).map((r) => r.id)).toEqual([392]);
    // The reason a run failed is the thing you remember, and it is not in the title.
    expect(filterRuns(runs, { query: 'no edits' }).map((r) => r.id)).toEqual([392]);
  });

  it('combines an outcome with a search', () => {
    expect(filterRuns(runs, { status: 'resumable', query: 'compile' }).map((r) => r.id)).toEqual([428]);
  });

  it('ignores case and surrounding spaces, and survives missing fields', () => {
    expect(filterRuns(runs, { query: '  LISTING  ' }).map((r) => r.id)).toEqual([429]);
    expect(filterRuns([{ id: 1, status: 'empty' }], { query: 'x' })).toEqual([]);
    expect(filterRuns([{ id: 1, status: 'empty' }], { query: '1' })).toHaveLength(1);
  });
});
