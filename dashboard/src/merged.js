/**
 * THE PAGE MERGES, AND THE PROMISE THAT NO LINK BREAKS.
 *
 * The nav had 38 entries. Several answered the same question from slightly different angles — to
 * follow one run you moved between Iterations, Runs and Flow; to learn whether the app boots you
 * chose between Workbench and Repair. Five merges take it to 29.
 *
 * **Nothing is deleted.** Each merged page is a tab shell around the *unchanged* view components,
 * so every feature survives by construction. What this file adds is the second half of that
 * promise: the old ids keep working.
 *
 * `#/flow`, a bookmark, a link in a notification, `onNavigate('security')` from another view — all
 * of them resolve to the right page and the right tab. A merge that silently 404s the links people
 * already have is a merge that looks tidy and costs the operator their bearings.
 */

/** id → { page, tab }. The page is what the nav shows; the tab is which panel opens. */
export const MERGED_ROUTES = {
  /* ── the run, in one place ───────────────────────────────────────────────
   * Runs (what failed), Iterations (all of them, with the diff) and Flow (the one happening now)
   * are three windows onto the same object. Following a single run meant three pages. */
  runs: { page: 'runs', tab: 'runs' },
  iterations: { page: 'runs', tab: 'iterations' },
  flow: { page: 'runs', tab: 'flow' },

  /* ── does the app work? ──────────────────────────────────────────────────
   * Workbench answers it as a gate inside a run; Repair answers it on demand. Same check. */
  workbench: { page: 'workbench', tab: 'workbench' },
  repair: { page: 'workbench', tab: 'repair' },

  /* ── the numbers ─────────────────────────────────────────────────────────
   * Health (codebase score), Analytics (run trends) and Telemetry (tokens and cost) are three
   * pages of read-only measurement. KPI stays separate — it is configuration, not a report. */
  health: { page: 'health', tab: 'health' },
  analytics: { page: 'health', tab: 'analytics' },
  telemetry: { page: 'health', tab: 'telemetry' },

  /* ── what is allowed ─────────────────────────────────────────────────────
   * Security gates the diff, Compliance holds the best-practice rules, Governance the policy.
   * Three faces of the same question. */
  security: { page: 'security', tab: 'security' },
  compliance: { page: 'security', tab: 'compliance' },
  governance: { page: 'security', tab: 'governance' },

  /* ── what the fleet learned ──────────────────────────────────────────────
   * Memory is what it knows; Decisions is how that knowledge routes work. */
  memory: { page: 'memory', tab: 'memory' },
  decisions: { page: 'memory', tab: 'decisions' },
};

/** The nav ids that no longer appear as their own entry. */
export const ABSORBED = Object.entries(MERGED_ROUTES)
  .filter(([id, r]) => id !== r.page)
  .map(([id]) => id);

/**
 * The hash to write for a page and tab, leaving the default tab implicit.
 *
 * `#/runs` and `#/runs/runs` show the same thing, and both appear the moment the tab shell writes
 * the id unconditionally — arrowing round to the first tab produced the second form. Two URLs for
 * one view is two entries in history and two different bookmarks for the same page.
 */
export function routeFor(page, tab) {
  const fallback = MERGED_ROUTES[page]?.tab;
  return !tab || tab === fallback ? page : `${page}/${tab}`;
}

/**
 * Names for the absorbed pages, so the command palette can still find them.
 *
 * The palette builds its jump list from the nav, which means a merge silently removes eight
 * destinations from Ctrl-K. Someone who has always reached the cost breakdown by typing "telemetry"
 * would find nothing and reasonably conclude the feature was deleted. These entries keep the word
 * searchable and land on the right tab.
 */
export const ABSORBED_LABELS = {
  iterations: 'All runs',
  flow: 'Live run flow',
  repair: 'Diagnose & repair',
  analytics: 'Run analytics',
  telemetry: 'Cost & tokens',
  compliance: 'Best practices',
  governance: 'Policy',
  decisions: 'Routing decisions',
};

/**
 * Move the badge count of an absorbed page onto the page that now hosts it.
 *
 * Badges are keyed by nav id, so the moment Compliance stopped being a nav entry its
 * open-violations count had nowhere to render — the number an operator uses to notice unaddressed
 * violations would just stop appearing, which reads as "no violations".
 */
export function rollUpBadges(badges = {}) {
  const out = {};
  for (const [id, n] of Object.entries(badges)) {
    const key = MERGED_ROUTES[id]?.page || id;
    out[key] = (out[key] || 0) + (Number(n) || 0);
  }
  return out;
}

/**
 * Resolve a hash route to the page to render and the tab to open.
 *
 * Handles three shapes, because all three exist in the wild:
 *   `runs/flow`   the new form, written by the tab shell
 *   `flow`        the old form, in bookmarks and in `onNavigate` calls across the views
 *   `overview`    an ordinary unmerged page
 */
export function resolveRoute(view) {
  const raw = String(view || '');
  const [head, sub] = raw.split('/');

  const merged = MERGED_ROUTES[head];
  if (!merged) return { page: head, tab: null };

  // An explicit sub-route wins, but only if it belongs to this page — `runs/nonsense` should open
  // the page's default tab rather than a blank panel.
  if (sub && MERGED_ROUTES[sub]?.page === merged.page) return { page: merged.page, tab: sub };
  return { page: merged.page, tab: merged.tab };
}
