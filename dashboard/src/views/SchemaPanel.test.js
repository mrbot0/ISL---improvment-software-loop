import { describe, expect, it } from 'vitest';
import { schemaLabel } from './SchemaPanel.jsx';

/**
 * The schema list exists to let an operator pick between schemas. Labelling them by the last two
 * path segments gave `prisma/schema.prisma` for identity, listings, messaging, notifications,
 * payments and search — six entries, one name, in the one list whose purpose is telling them apart.
 */
describe('schemaLabel', () => {
  it('names the service, which is what differs', () => {
    expect(schemaLabel('services/listings/prisma/schema.prisma')).toBe('listings');
    expect(schemaLabel('services/payments/prisma/schema.prisma')).toBe('payments');
  });

  it('gives every service schema a distinct label', () => {
    const paths = ['identity', 'listings', 'messaging', 'notifications', 'payments', 'search']
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
