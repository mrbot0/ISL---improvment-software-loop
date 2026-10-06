import { describe, expect, it, vi } from 'vitest';
import { lazy } from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import TabbedView from './TabbedView.jsx';

const tabs = (mounted = []) => [
  { id: 'a', label: 'First', render: () => { mounted.push('a'); return <p>panel A</p>; } },
  { id: 'b', label: 'Second', render: () => { mounted.push('b'); return <p>panel B</p>; } },
  { id: 'c', label: 'Third', render: () => { mounted.push('c'); return <p>panel C</p>; } },
];

describe('TabbedView', () => {
  it('mounts only the visible tab', () => {
    // The merged views poll on an interval. Mounting all three to show one would triple the
    // request rate against the server for no visible benefit.
    const mounted = [];
    render(<TabbedView tabs={tabs(mounted)} active="a" label="Runs" />);
    expect(mounted).toEqual(['a']);
    expect(screen.queryByText('panel B')).toBeNull();
  });

  it('opens the tab named by the route, not the first one', () => {
    render(<TabbedView tabs={tabs()} active="c" label="Runs" />);
    expect(screen.getByText('panel C')).toBeTruthy();
  });

  it('falls back to the first tab when the route names nothing valid', () => {
    render(<TabbedView tabs={tabs()} active={undefined} label="Runs" />);
    expect(screen.getByText('panel A')).toBeTruthy();
  });

  it('follows the route when it changes underneath it', () => {
    // A deep link, a notification or the browser Back button all change `active` without a click;
    // local state must not win over the URL.
    const { rerender } = render(<TabbedView tabs={tabs()} active="a" label="Runs" />);
    rerender(<TabbedView tabs={tabs()} active="b" label="Runs" />);
    expect(screen.getByText('panel B')).toBeTruthy();
  });

  it('reports the tab change so the URL can be updated', () => {
    const onTabChange = vi.fn();
    render(<TabbedView tabs={tabs()} active="a" onTabChange={onTabChange} label="Runs" />);
    fireEvent.click(screen.getByRole('tab', { name: 'Second' }));
    expect(onTabChange).toHaveBeenCalledWith('b');
  });

  it('exposes the tabs as a set to assistive tech', () => {
    render(<TabbedView tabs={tabs()} active="a" label="Runs" />);
    expect(screen.getByRole('tablist').getAttribute('aria-label')).toBe('Runs');
    const [first, second] = screen.getAllByRole('tab');
    expect(first.getAttribute('aria-selected')).toBe('true');
    expect(second.getAttribute('aria-selected')).toBe('false');
    // Only the selected tab is in the tab order — arrows move between them, which is why the
    // keydown handler exists and why this assertion matters.
    expect(first.tabIndex).toBe(0);
    expect(second.tabIndex).toBe(-1);
  });

  it('moves between tabs with the arrow keys, wrapping at both ends', () => {
    const onTabChange = vi.fn();
    render(<TabbedView tabs={tabs()} active="a" onTabChange={onTabChange} label="Runs" />);
    const list = screen.getByRole('tablist');
    fireEvent.keyDown(list, { key: 'ArrowRight' });
    expect(onTabChange).toHaveBeenLastCalledWith('b');
    fireEvent.keyDown(list, { key: 'ArrowLeft' });
    expect(onTabChange).toHaveBeenLastCalledWith('a');
    fireEvent.keyDown(list, { key: 'ArrowLeft' });
    expect(onTabChange).toHaveBeenLastCalledWith('c');
  });

  it('moves focus with the arrow keys, not just the selection', () => {
    // Roving tabindex means the previously focused tab becomes tabindex="-1" the moment selection
    // moves. Leaving focus there puts the ring on a tab that is no longer the open one, and a
    // screen reader announces a tab the user is not looking at.
    render(<TabbedView tabs={tabs()} active="a" label="Runs" />);
    const [first, second] = screen.getAllByRole('tab');
    first.focus();
    fireEvent.keyDown(screen.getByRole('tablist'), { key: 'ArrowRight' });
    expect(document.activeElement).toBe(second);
  });

  it('does not steal focus on a click, which already moves it', () => {
    render(<TabbedView tabs={tabs()} active="a" label="Runs" />);
    const heading = document.createElement('button');
    document.body.appendChild(heading);
    heading.focus();
    fireEvent.click(screen.getByRole('tab', { name: 'Second' }));
    expect(document.activeElement).toBe(heading);
    heading.remove();
  });

  it('keeps the tab bar on screen while a lazy tab loads', () => {
    // Measured in the browser: the first arrow onto a not-yet-fetched chunk replaced the whole
    // shell with App's spinner, unmounting the focused tab button and dropping focus to <body>,
    // so the next arrow key did nothing at all.
    const Never = lazy(() => new Promise(() => {})); // a chunk that never arrives
    render(
      <TabbedView
        label="Runs"
        active="slow"
        tabs={[{ id: 'slow', label: 'Slow', render: () => <Never /> }, { id: 'other', label: 'Other', render: () => <p>b</p> }]}
      />,
    );
    expect(screen.getAllByRole('tab')).toHaveLength(2);
    expect(screen.getByRole('tab', { name: 'Slow' })).toBeTruthy();
  });

  it('contains a crashing tab without taking the tablist with it', () => {
    // App's boundary is keyed by page, so a crash inside one panel would otherwise remove the
    // tabs too, leaving no way to navigate off the broken tab.
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const boom = [{ id: 'x', label: 'Broken', render: () => { throw new Error('kaboom'); } }];
    render(<TabbedView tabs={boom} active="x" label="Runs" />);
    expect(screen.getByRole('tab', { name: 'Broken' })).toBeTruthy();
    expect(screen.getByRole('alert')).toBeTruthy();
    err.mockRestore();
  });
});
