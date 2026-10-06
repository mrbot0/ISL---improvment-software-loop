import { describe, it, expect } from 'vitest';
import { navCatalog, applyDashboardConfig, UNHIDEABLE } from './nav.js';

describe('nav / dashboard config', () => {
  it('admins get the Administration group; non-admins do not', () => {
    const adminIds = navCatalog(true).flatMap((g) => g.items).map((i) => i.id);
    const userIds = navCatalog(false).flatMap((g) => g.items).map((i) => i.id);
    expect(adminIds).toContain('admin');
    expect(userIds).not.toContain('admin');
  });

  it('hides items and applies custom labels', () => {
    const groups = applyDashboardConfig(true, { hidden: ['logs'], labels: { memory: 'Knowledge' } });
    const items = groups.flatMap((g) => g.items);
    expect(items.find((i) => i.id === 'logs')).toBeUndefined();
    expect(items.find((i) => i.id === 'memory')?.label).toBe('Knowledge');
  });

  it('never hides the unhideable items (overview, admin)', () => {
    const groups = applyDashboardConfig(true, { hidden: [...UNHIDEABLE] });
    const ids = groups.flatMap((g) => g.items).map((i) => i.id);
    for (const id of UNHIDEABLE) expect(ids).toContain(id);
  });

  it('drops empty groups after filtering', () => {
    const cfg = { hidden: navCatalog(false).flatMap((g) => g.items).map((i) => i.id) };
    const groups = applyDashboardConfig(false, cfg);
    // Every remaining group has at least one item (overview survives as unhideable).
    expect(groups.every((g) => g.items.length > 0)).toBe(true);
  });
});
