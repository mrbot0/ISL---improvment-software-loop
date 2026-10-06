import { describe, it, expect, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import DataTable from './DataTable.jsx';

/**
 * The properties worth testing are the ones a virtualised table can silently get wrong: rendering
 * far fewer rows than it claims to have, sorting that scatters nulls, and persisted column choices
 * that leak between tables.
 */
const cols = [
  { key: 'name', label: 'Name' },
  { key: 'n', label: 'Count' },
  { key: 'note', label: 'Note' },
];
const rows = (n) => Array.from({ length: n }, (_, i) => ({ id: i, name: `pkg-${String(i).padStart(3, '0')}`, n: n - i, note: `note ${i}` }));

beforeEach(() => localStorage.clear());

describe('DataTable', () => {
  it('shows the empty state rather than an empty frame', () => {
    render(<DataTable id="t0" rows={[]} columns={cols} />);
    expect(screen.getByText(/Nothing here/i)).toBeTruthy();
  });

  it('reports the true row count even though it renders a slice', () => {
    render(<DataTable id="t1" rows={rows(5000)} columns={cols} />);
    expect(screen.getByText('5,000 rows')).toBeTruthy();
  });

  // The point of virtualisation: DOM cost bounded by the viewport, not the dataset.
  it('keeps only a small window in the DOM', () => {
    const { container } = render(<DataTable id="t2" rows={rows(5000)} columns={cols} />);
    const cells = container.querySelectorAll('.sm\\:block [class*="border-b"]');
    expect(cells.length).toBeGreaterThan(0);
    expect(cells.length).toBeLessThan(200); // 5000 rows would be catastrophic
  });

  it('sorts ascending, then descending, then clears', () => {
    render(<DataTable id="t3" rows={rows(30)} columns={cols} />);
    const header = screen.getByRole('button', { name: /^Count/ });
    fireEvent.click(header);
    expect(screen.getByText(/sorted by n ↑/)).toBeTruthy();
    fireEvent.click(header);
    expect(screen.getByText(/sorted by n ↓/)).toBeTruthy();
    fireEvent.click(header);
    expect(screen.queryByText(/sorted by/)).toBeNull();
  });

  // Mixed types and nulls are the norm in these lists; a naive comparator reorders them per render.
  it('sorts nulls to the end in both directions, deterministically', () => {
    const mixed = [{ id: 1, name: 'b', n: 2 }, { id: 2, name: 'a', n: null }, { id: 3, name: 'c', n: 1 }];
    const { container, rerender } = render(<DataTable id="t4" rows={mixed} columns={cols} />);
    fireEvent.click(screen.getByRole('button', { name: /^Count/ }));
    const read = () => [...container.querySelectorAll('.sm\\:block [class*="border-b"]')].map((r) => r.textContent.slice(0, 1));
    const asc = read();
    rerender(<DataTable id="t4" rows={mixed} columns={cols} />);
    expect(read()).toEqual(asc); // stable across re-renders
    expect(asc[asc.length - 1]).toBe('a'); // the null row is last, not scattered
  });

  it('hides a column and remembers the choice per table id', () => {
    const { unmount } = render(<DataTable id="t5" rows={rows(10)} columns={cols} />);
    fireEvent.click(screen.getByText('columns'));
    fireEvent.click(screen.getByLabelText('Note'));
    expect(screen.queryByRole('button', { name: /^Note/ })).toBeNull();
    unmount();
    render(<DataTable id="t5" rows={rows(10)} columns={cols} />);
    expect(screen.queryByRole('button', { name: /^Note/ })).toBeNull();
  });

  it('does not leak column choices between different tables', () => {
    const { unmount } = render(<DataTable id="a" rows={rows(5)} columns={cols} />);
    fireEvent.click(screen.getByText('columns'));
    fireEvent.click(screen.getByLabelText('Note'));
    unmount();
    render(<DataTable id="b" rows={rows(5)} columns={cols} />);
    expect(screen.getByRole('button', { name: /^Note/ })).toBeTruthy();
  });

  it('uses a custom renderer when given one', () => {
    render(<DataTable id="t6" rows={[{ id: 1, name: 'x', n: 1 }]} columns={[{ key: 'name', label: 'Name', render: () => <b>rendered</b> }]} />);
    expect(screen.getAllByText('rendered').length).toBeGreaterThan(0);
  });
});
