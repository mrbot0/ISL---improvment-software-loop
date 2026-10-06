import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { PageHeader, Empty, SeverityPill, Skeleton, ago } from './ui.jsx';

describe('ui kit', () => {
  it('PageHeader renders title + subtitle + actions', () => {
    render(<PageHeader title="Decisions" subtitle="learned routing"><button>act</button></PageHeader>);
    expect(screen.getByRole('heading', { name: 'Decisions' })).toBeInTheDocument();
    expect(screen.getByText('learned routing')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'act' })).toBeInTheDocument();
  });

  it('Empty shows an explanatory state', () => {
    render(<Empty icon="🧠" title="Nothing yet" hint="It will fill up." />);
    expect(screen.getByText('Nothing yet')).toBeInTheDocument();
    expect(screen.getByText('It will fill up.')).toBeInTheDocument();
  });

  it('SeverityPill renders each severity without crashing', () => {
    for (const s of ['critical', 'high', 'medium', 'low']) {
      const { unmount } = render(<SeverityPill severity={s} />);
      unmount();
    }
    expect(true).toBe(true);
  });

  it('Skeleton renders the requested number of rows', () => {
    const { container } = render(<Skeleton rows={4} />);
    expect(container.querySelectorAll('.skeleton').length).toBe(4);
  });

  // `Date.now() - undefined` is NaN, every comparison against NaN is false, and the old code fell
  // through to its last line — printing "NaNd ago" on screen. A missing timestamp must read as an
  // absent value, not as a broken number that looks like a defect in the product.
  it('ago says "never" for a missing timestamp, not NaN', () => {
    for (const bad of [undefined, null, 0, '', NaN, 'not a date']) {
      expect(ago(bad)).toBe('never');
    }
    expect(ago(undefined, '—')).toBe('—');
  });

  it('ago handles a clock skew instead of reporting a negative age', () => {
    expect(ago(Date.now() + 60_000)).toBe('just now');
  });

  it('ago formats relative time', () => {
    expect(ago(Date.now())).toMatch(/s ago/);
    expect(ago(Date.now() - 3 * 3600 * 1000)).toMatch(/h ago/);
  });
});
