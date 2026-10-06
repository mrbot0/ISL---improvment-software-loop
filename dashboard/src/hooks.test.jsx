import { describe, it, expect, vi } from 'vitest';
import { renderHook, waitFor, act } from '@testing-library/react';
import { useResource, invalidateResource } from './hooks.js';

describe('useResource', () => {
  it('fetches, exposes data, and dedups concurrent callers', async () => {
    const fetcher = vi.fn().mockResolvedValue({ n: 1 });
    const a = renderHook(() => useResource('k1', fetcher));
    const b = renderHook(() => useResource('k1', fetcher)); // same key, concurrent
    await waitFor(() => expect(a.result.current.data).toEqual({ n: 1 }));
    expect(b.result.current.data).toEqual({ n: 1 });
    // Both mounted but only one network call thanks to in-flight dedup.
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('paints instantly from cache on a later mount', async () => {
    const fetcher = vi.fn().mockResolvedValue({ n: 2 });
    const first = renderHook(() => useResource('k2', fetcher));
    await waitFor(() => expect(first.result.current.data).toEqual({ n: 2 }));
    const second = renderHook(() => useResource('k2', fetcher));
    expect(second.result.current.data).toEqual({ n: 2 }); // cached, no spinner
  });

  it('invalidateResource refetches mounted views live', async () => {
    let val = 3;
    const fetcher = vi.fn(() => Promise.resolve({ n: val }));
    const { result } = renderHook(() => useResource('k3', fetcher));
    await waitFor(() => expect(result.current.data).toEqual({ n: 3 }));
    val = 4;
    await act(async () => {
      invalidateResource('k3');
    });
    await waitFor(() => expect(result.current.data).toEqual({ n: 4 }));
  });
});
