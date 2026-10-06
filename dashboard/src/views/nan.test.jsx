import { describe, it, expect, vi } from 'vitest';
import { render, waitFor } from '@testing-library/react';
import { mockApi, VIEW_PROPS } from '../test/fixtures.js';

/**
 * NOTHING ON SCREEN MAY READ "NaN", "undefined", "null" OR "Invalid Date".
 *
 * `ago(undefined)` printed "NaNd ago" on the Compliance page — a missing value rendered as a broken
 * number, which reads as a defect in the product rather than as "there is nothing here yet". That
 * class of bug is invisible to every other test: the page renders, the audit passes, the text is
 * simply wrong.
 *
 * The fixtures deliberately leave optional fields absent, which is exactly the state a fresh install
 * is in — no runs, no scans, no coverage.
 */
vi.mock('../api.js', () => ({ api: mockApi() }));
vi.mock('../components/Toast.jsx', () => ({ useToast: () => vi.fn(), ToastHost: () => null }));

const VIEWS = [
  'Runs', 'Backlog', 'Services', 'Runtime', 'Cloud', 'Summary', 'Scope', 'Fleet', 'Proposals',
  'Plans', 'Logs', 'Notifications', 'Telemetry', 'KPI', 'Explorer', 'Memory', 'Security', 'Review',
  'Insight', 'Overview', 'Managers', 'Analytics', 'Context', 'Decisions', 'Deploy', 'Digest',
  'Iterations', 'Compliance', 'Health', 'Reliability',
];

// "NaN" as a word, an undefined/null leaking into a template, or a bad Date.
const GIBBERISH = /\bNaN\b|\bundefined\b|\bnull\b|Invalid Date/;

describe('no view renders a broken value', () => {
  for (const name of VIEWS) {
    it(`${name} shows no NaN/undefined/null on screen`, async () => {
      const { default: View } = await import(`./${name}.jsx`);
      const { container } = render(<View {...VIEW_PROPS} />);
      await waitFor(() => expect(container.querySelector('.skeleton')).toBeNull());
      const text = container.textContent || '';
      const hit = text.match(GIBBERISH);
      expect(hit ? `${name} rendered "${hit[0]}" in: …${text.slice(Math.max(0, hit.index - 45), hit.index + 25)}…` : null).toBeNull();
    });
  }
});
