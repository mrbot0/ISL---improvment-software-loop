import { describe, expect, it } from 'vitest';
import { schemaLabel } from './SchemaPanel.jsx';

/**
 * The schema list exists to let an operator pick between schemas. Labelling them by the last two
 * path segments gave every service the same `prisma/schema.prisma` — one name repeated down the
 * one list whose entire purpose is telling them apart.
 *
 * The service names below are invented: the bug is about the shape of a path, not about any
 * particular product's topology.
 */
describe('schemaLabel', () => {
  it('names the service, which is what differs', () => {
    expect(schemaLabel('services/catalogue/prisma/schema.prisma')).toBe('catalogue');
    expect(schemaLabel('services/billing/prisma/schema.prisma')).toBe('billing');
  });

  it('gives every service schema a distinct label', () => {
    const paths = ['accounts', 'catalogue', 'inbox', 'alerts', 'billing', 'lookup']
      .map((s) => `services/${s}/prisma/schema.prisma`);
    expect(new Set(paths.map(schemaLabel)).size).toBe(paths.length);
  });

  it('handles a schema that is not under a prisma directory', () => {
    expect(schemaLabel('backend/prisma_new/schema.prisma')).toBe('prisma_new/schema.prisma');
    expect(schemaLabel('schema.prisma')).toBe('schema.prisma');
  });

  it('survives empty input rather than rendering "undefined"', () => {
    expect(schemaLabel('')).toBe('');
    expect(schemaLabel()).toBe('');
  });
});
