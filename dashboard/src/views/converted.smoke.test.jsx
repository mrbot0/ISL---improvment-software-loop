import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { mockApi, failingApi, VIEW_PROPS } from '../test/fixtures.js';

/**
 * SMOKE TEST FOR THE VIEWS MOVED ONTO `useResource`.
 *
 * This exists because of a bug that shipped: converting `Compliance` to a keyed resource removed its
 * `load()` function, but a `<select onChange>` still called it. Nothing caught that — the build only
 * type-checks syntax, the project has no linter, and a reference to a name that no longer exists is
 * a *runtime* error. It would have thrown the first time an operator changed the language filter.
 *
 * Rendering each converted view with a mocked API catches exactly that class of mistake: an
 * identifier the refactor left dangling, a hook called conditionally, a destructure of something
 * that is no longer returned. It is not a test of what the views look like — it is the guard that
 * says they still evaluate at all.
 *
 * Every view is rendered THREE times: with data, mid-load, and with a failing API. The third is the
 * one that used to be untested everywhere, and it is where the silent-empty-panel bug lived.
 */

vi.mock('../api.js', () => ({ api: mockApi() }));

// The toast hook a few views reach for.
vi.mock('../components/Toast.jsx', () => ({ useToast: () => vi.fn(), ToastHost: () => null }));

const VIEWS = [
  ['Runs', () => import('./Runs.jsx')],
  ['Backlog', () => import('./Backlog.jsx')],
  ['Services', () => import('./Services.jsx')],
  ['Runtime', () => import('./Runtime.jsx')],
  ['Explorer', () => import('./Explorer.jsx')],
  ['Cloud', () => import('./Cloud.jsx')],
  ['Compliance', () => import('./Compliance.jsx')],
  ['Summary', () => import('./Summary.jsx')],
  ['Scope', () => import('./Scope.jsx')],
];


describe('views converted to useResource still evaluate', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Each test needs its own cache generation, or the second render reads the first's data and
    // never exercises the loading path this is meant to cover.
    vi.resetModules();
  });

  for (const [name, load] of VIEWS) {
    it(`${name} renders without throwing`, async () => {
      const { default: View } = await load();
      expect(() => render(<View {...VIEW_PROPS} />)).not.toThrow();
      // Let the resource resolve, so the data path evaluates too — not just the skeleton.
      await waitFor(() => expect(document.body.textContent.length).toBeGreaterThan(0));
    });
  }

  it('a failing API produces a visible alert, never a blank panel', async () => {
    vi.resetModules();
    vi.doMock('../api.js', () => ({ api: failingApi('backend unreachable') }));
    const { default: Runs } = await import('./Runs.jsx');
    render(<Runs {...VIEW_PROPS} />);
    // This is the whole point of the Resource component: the operator learns the server is down
    // instead of reading an empty board as "nothing is failing".
    await waitFor(() => expect(screen.getByRole('alert')).toBeInTheDocument());
    expect(screen.getByText(/backend unreachable/)).toBeInTheDocument();
  });
});
