import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { Resource } from './Resource.jsx';

/**
 * This component decides what an operator sees when a request fails. The failure it exists to
 * prevent — a failed fetch rendering as an innocuous empty panel — is invisible by definition, so
 * the distinction between "nothing to show" and "could not load" is pinned here explicitly.
 */
describe('Resource', () => {
  it('renders the data when there is data', () => {
    render(<Resource data={[1, 2]}>{(d) => <p>{d.length} items</p>}</Resource>);
    expect(screen.getByText('2 items')).toBeInTheDocument();
  });

  it('accepts plain children as well as a render function', () => {
    render(<Resource data={{ a: 1 }}><p>static</p></Resource>);
    expect(screen.getByText('static')).toBeInTheDocument();
  });

  it('shows a skeleton on the FIRST load, not a spinner', () => {
    const { container } = render(<Resource loading data={null}>{() => <p>never</p>}</Resource>);
    expect(container.querySelector('.skeleton')).toBeTruthy();
    expect(screen.queryByText('never')).toBeNull();
  });

  it('does NOT blank the page while refreshing data it already has', () => {
    // The whole point of the cache paint: a background refresh must not throw the content away.
    render(<Resource loading data={[1]}>{(d) => <p>{d.length} loaded</p>}</Resource>);
    expect(screen.getByText('1 loaded')).toBeInTheDocument();
  });

  it('THE POINT: a failure is announced, not silently rendered as empty', () => {
    render(<Resource error={new Error('network down')} data={null}>{() => <p>x</p>}</Resource>);
    expect(screen.getByRole('alert')).toBeInTheDocument();
    expect(screen.getByText(/network down/)).toBeInTheDocument();
  });

  it('reports a failed REFRESH even when stale data is on screen', () => {
    // Numbers that stopped being live are worse than no numbers, because they look fine.
    render(<Resource error={new Error('gone')} data={[1, 2, 3]}>{(d) => <p>{d.length} items</p>}</Resource>);
    expect(screen.getByRole('alert')).toBeInTheDocument();
    expect(screen.queryByText('3 items')).toBeNull();
  });

  it('offers a retry that calls refetch', () => {
    const refetch = vi.fn();
    render(<Resource error={new Error('boom')} refetch={refetch} data={null} />);
    fireEvent.click(screen.getByRole('button'));
    expect(refetch).toHaveBeenCalledOnce();
  });

  it('omits the retry when there is nothing to retry with', () => {
    render(<Resource error={new Error('boom')} data={null} />);
    expect(screen.queryByRole('button')).toBeNull();
  });

  it('distinguishes empty from failed', () => {
    render(<Resource data={[]} emptyTitle="Nothing here yet" />);
    expect(screen.getByText('Nothing here yet')).toBeInTheDocument();
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('treats null, [] and {} as empty', () => {
    for (const empty of [null, [], {}]) {
      const { unmount } = render(<Resource data={empty} emptyTitle="none" />);
      expect(screen.getByText('none')).toBeInTheDocument();
      unmount();
    }
  });

  it('does NOT treat 0 or "" as empty — they are real values', () => {
    // A zero count is data. Rendering "nothing here" for it would be a lie about the system.
    render(<Resource data={0}>{(d) => <p>value {String(d)}</p>}</Resource>);
    expect(screen.getByText('value 0')).toBeInTheDocument();
  });

  it('honours a caller that knows better what empty means', () => {
    render(
      <Resource data={{ runs: [] }} isEmpty={(d) => !d.runs.length} emptyTitle="no runs">
        {() => <p>list</p>}
      </Resource>,
    );
    expect(screen.getByText('no runs')).toBeInTheDocument();
  });
});
