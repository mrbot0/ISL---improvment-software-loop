import { describe, expect, it } from 'vitest';
import { ABSORBED, ABSORBED_LABELS, MERGED_ROUTES, resolveRoute, rollUpBadges, routeFor } from './merged.js';
import { navCatalog } from './nav.js';

/**
 * The merge removed eight nav entries by folding them into five pages. The risk is not that the tab
 * shell breaks — that is visible immediately — but that a link somewhere quietly stops arriving:
 * a bookmark, a notification, an `onNavigate` call in a view nobody opened during testing.
 */
describe('resolveRoute', () => {
  it('sends an old top-level id to its new page and tab', () => {
    expect(resolveRoute('flow')).toEqual({ page: 'runs', tab: 'flow' });
    expect(resolveRoute('telemetry')).toEqual({ page: 'health', tab: 'telemetry' });
    expect(resolveRoute('repair')).toEqual({ page: 'workbench', tab: 'repair' });
  });

  it('reads the explicit sub-route the tab shell writes', () => {
    expect(resolveRoute('runs/iterations')).toEqual({ page: 'runs', tab: 'iterations' });
    expect(resolveRoute('security/governance')).toEqual({ page: 'security', tab: 'governance' });
  });

  it('opens the default tab rather than a blank panel for a sub-route of another page', () => {
    // `#/runs/telemetry` is not a route anyone should produce, but a hand-edited or truncated URL
    // must land on something rather than render an empty panel with no way back.
    expect(resolveRoute('runs/telemetry')).toEqual({ page: 'runs', tab: 'runs' });
    expect(resolveRoute('runs/nonsense')).toEqual({ page: 'runs', tab: 'runs' });
  });

  it('leaves an unmerged page alone', () => {
    expect(resolveRoute('overview')).toEqual({ page: 'overview', tab: null });
    expect(resolveRoute('backlog')).toEqual({ page: 'backlog', tab: null });
  });

  it('survives empty and nullish input', () => {
    expect(resolveRoute('')).toEqual({ page: '', tab: null });
    expect(resolveRoute(undefined)).toEqual({ page: '', tab: null });
    expect(resolveRoute(null)).toEqual({ page: '', tab: null });
  });
});

describe('routeFor', () => {
  it('leaves the default tab out of the hash', () => {
    // Arrowing round to the first tab used to produce `#/runs/runs`: a second URL for a page that
    // already had one, which is a second history entry and a second possible bookmark.
    expect(routeFor('runs', 'runs')).toBe('runs');
    expect(routeFor('health', 'health')).toBe('health');
    expect(routeFor('runs', null)).toBe('runs');
  });

  it('names a non-default tab', () => {
    expect(routeFor('runs', 'flow')).toBe('runs/flow');
    expect(routeFor('security', 'governance')).toBe('security/governance');
  });

  it('round-trips through resolveRoute', () => {
    for (const [id, { page, tab }] of Object.entries(MERGED_ROUTES)) {
      expect(resolveRoute(routeFor(page, tab))).toEqual({ page, tab: MERGED_ROUTES[page].tab === tab ? MERGED_ROUTES[page].tab : tab });
      expect(resolveRoute(routeFor(page, id)).tab).toBe(id);
    }
  });
});

describe('the merge table and the nav agree', () => {
  const navIds = new Set(navCatalog(true).flatMap((g) => g.items).map((i) => i.id));

  it('every hosting page is a real nav entry', () => {
    // If a page id were misspelled here, its route would resolve to a page App never renders and
    // the operator would get a blank main area — the failure mode the tab shell exists to prevent.
    for (const { page } of Object.values(MERGED_ROUTES)) expect(navIds).toContain(page);
  });

  it('no absorbed id is still shown in the nav', () => {
    for (const id of ABSORBED) expect(navIds).not.toContain(id);
  });

  it('every absorbed id keeps a name the command palette can search', () => {
    // The palette builds its jump list from the nav, so without a label the destination simply
    // disappears from Ctrl-K — indistinguishable, to the person typing, from a deleted feature.
    for (const id of ABSORBED) expect(ABSORBED_LABELS[id]).toBeTruthy();
  });
});

describe('rollUpBadges', () => {
  it('moves an absorbed page count onto the page that now hosts it', () => {
    expect(rollUpBadges({ compliance: 4 })).toEqual({ security: 4 });
  });

  it('adds counts that land on the same page instead of overwriting one', () => {
    expect(rollUpBadges({ compliance: 4, governance: 3, security: 1 })).toEqual({ security: 8 });
  });

  it('passes unmerged counts through untouched', () => {
    expect(rollUpBadges({ proposals: 2, cloud: 1 })).toEqual({ proposals: 2, cloud: 1 });
  });

  it('treats a missing or non-numeric count as zero', () => {
    expect(rollUpBadges({ compliance: undefined, governance: null })).toEqual({ security: 0 });
    expect(rollUpBadges()).toEqual({});
  });
});
