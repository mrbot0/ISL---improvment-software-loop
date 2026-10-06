import { describe, it, expect, vi } from 'vitest';
import { render, waitFor } from '@testing-library/react';
import { axe } from 'vitest-axe';
import { mockApi, VIEW_PROPS } from '../test/fixtures.js';

/**
 * WCAG CHECKS ON THE ACTUAL VIEWS (ISL_Frontend §2 P0, §12).
 *
 * `components/a11y.test.jsx` runs axe over three shared components — `PageHeader`, `Empty` and a
 * button row. Those pass, and always would: they were written for the test. The pages an operator
 * actually looks at were never checked, so "the dashboard is accessible" rested on the accessibility
 * of three components that are a fraction of it.
 *
 * ── Two false greens this had to be beaten out of ───────────────────────────────────────────────
 * 1. `render` is synchronous and a resource resolves a tick later, so auditing immediately audits
 *    the loading SKELETON — no controls, therefore no violations, and eight green ticks that meant
 *    nothing. Hence the wait below.
 * 2. Empty fixtures meant tables and row actions never rendered. Hence the assertion that each view
 *    produced at least one interactive control before the audit is trusted at all.
 *
 * Colour contrast is excluded: jsdom has no layout engine, so axe cannot judge it here and a green
 * result would be a claim nobody checked.
 */

vi.mock('../api.js', () => ({ api: mockApi() }));
vi.mock('../components/Toast.jsx', () => ({ useToast: () => vi.fn(), ToastHost: () => null }));

/**
 * The views audited today. Each one is fixtured well enough that it renders its real controls, which
 * is the precondition for the audit meaning anything.
 */
const VIEWS = [
  ['Runs', () => import('./Runs.jsx')],
  ['Backlog', () => import('./Backlog.jsx')],
  ['Services', () => import('./Services.jsx')],
  ['Runtime', () => import('./Runtime.jsx')],
  ['Cloud', () => import('./Cloud.jsx')],
  ['Summary', () => import('./Summary.jsx')],
  ['Scope', () => import('./Scope.jsx')],
  ['Fleet', () => import('./Fleet.jsx')],
  ['Proposals', () => import('./Proposals.jsx')],
  ['Plans', () => import('./Plans.jsx'), { readOnly: true }],
  ['Logs', () => import('./Logs.jsx')],
  ['Notifications', () => import('./Notifications.jsx')],
  ['Telemetry', () => import('./Telemetry.jsx'), { readOnly: true }],
  ['KPI', () => import('./KPI.jsx')],
  ['Explorer', () => import('./Explorer.jsx')],
  ['Memory', () => import('./Memory.jsx')],
  ['Security', () => import('./Security.jsx')],
  ['Review', () => import('./Review.jsx')],
  ['Insight', () => import('./Insight.jsx')],
  ['Overview', () => import('./Overview.jsx')],
  ['Managers', () => import('./Managers.jsx'), { readOnly: true }], // manager briefs: cards, no controls
  ['Analytics', () => import('./Analytics.jsx'), { readOnly: true }],
  ['Context', () => import('./Context.jsx')],
  ['Decisions', () => import('./Decisions.jsx')],
  ['Deploy', () => import('./Deploy.jsx')],
  ['Digest', () => import('./Digest.jsx')],
  ['Iterations', () => import('./Iterations.jsx')],
  ['Compliance', () => import('./Compliance.jsx')],
  ['Health', () => import('./Health.jsx')],
  ['Reliability', () => import('./Reliability.jsx')],
];

/**
 * NOT audited, and why — listed so the gap is visible rather than implied by absence.
 *
 * `Admin`, `Governance`, `Projects` and `Settings` are gated on server config or a live session, so
 * under a stub they render a permission or setup state; auditing that is not auditing the view.
 * `Workbench` and `Flow` are driven by a live event stream rather than a fetch.
 *
 * Everything else in the dashboard is below.
 */

/**
 * The rules asserted. Deliberately the ones that DECIDE whether a page is usable without a mouse or
 * with a screen reader — not the full ruleset, which fails on things jsdom cannot model and would
 * teach us to disable the test rather than fix the page.
 */
const RULES = {
  'button-name': { enabled: true },
  'link-name': { enabled: true },
  label: { enabled: true },
  'select-name': { enabled: true },
  'aria-required-attr': { enabled: true },
  'aria-valid-attr-value': { enabled: true },
  'aria-roles': { enabled: true },
  'image-alt': { enabled: true },
  'heading-order': { enabled: true },
  'duplicate-id-active': { enabled: true },
  'nested-interactive': { enabled: true },
  'color-contrast': { enabled: false }, // not computable in jsdom — excluded rather than faked
};

describe('views meet the serious WCAG rules', () => {
  for (const [name, load, opts = {}] of VIEWS) {
    it(`${name} has no keyboard or screen-reader blockers`, async () => {
      const { default: View } = await load();
      const { container } = render(<View {...VIEW_PROPS} />);

      await waitFor(() => expect(container.querySelector('.skeleton')).toBeNull());

      // Prove the page is really populated before trusting the audit. A few views are genuinely
      // read-only — cards and charts, no controls — and demanding a button from them would be this
      // assertion being wrong rather than the page. Those still have to render CONTENT.
      if (opts.readOnly) {
        expect(container.textContent.trim().length, `${name} rendered nothing — the audit would be vacuous`).toBeGreaterThan(0);
      } else {
        const controls = container.querySelectorAll('button, a[href], input, select, textarea, [tabindex]');
        expect(controls.length, `${name} rendered no interactive controls — the audit would be vacuous`).toBeGreaterThan(0);
      }

      expect(await axe(container, { rules: RULES })).toHaveNoViolations();
    });
  }
});
