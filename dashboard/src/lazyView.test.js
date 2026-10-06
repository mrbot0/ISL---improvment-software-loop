import { describe, it, expect, beforeEach, vi } from 'vitest';
import { isStaleChunkError, reloadForNewBuild, markReloaded } from './lazyView.js';

/**
 * Recovering from a redeploy that happened while the tab was open.
 *
 * Every view is a lazily-loaded chunk whose filename is a hash of its contents, so a rebuild deletes
 * the names the open page knows. Navigating to a not-yet-visited view then requests a file that is
 * gone. It looked like a crash in that view, it happened on every page rather than one, and the
 * "reload view" button could not fix it because remounting re-requests the same missing file.
 */

describe('isStaleChunkError', () => {
  it('recognises the message from every browser engine', () => {
    // Each engine words this differently, and matching only Chrome's would leave Firefox and Safari
    // users with the dead view this exists to prevent.
    expect(isStaleChunkError(new Error('Failed to fetch dynamically imported module: http://x/assets/Runs-jWeVhlbY.js'))).toBe(true);
    expect(isStaleChunkError(new Error('error loading dynamically imported module'))).toBe(true);
    expect(isStaleChunkError(new Error('Importing a module script failed.'))).toBe(true);
    expect(isStaleChunkError(new Error('Unable to preload CSS for /assets/x.css'))).toBe(true);
  });

  it('does not claim ordinary crashes', () => {
    // Reloading the page on a genuine render bug would hide it and loop the operator through it.
    expect(isStaleChunkError(new Error('Cannot read properties of undefined'))).toBe(false);
    expect(isStaleChunkError(new TypeError('x is not a function'))).toBe(false);
    expect(isStaleChunkError(null)).toBe(false);
    expect(isStaleChunkError(undefined)).toBe(false);
  });
});

describe('reloadForNewBuild', () => {
  const reload = vi.fn();

  beforeEach(() => {
    reload.mockClear();
    sessionStorage.clear();
    // jsdom's location.reload is not configurable in place; replace the accessor.
    Object.defineProperty(window, 'location', { value: { ...window.location, reload }, writable: true });
  });

  it('reloads once', () => {
    expect(reloadForNewBuild()).toBe(true);
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it('REFUSES to reload again straight away', () => {
    /*
     * The guard that matters. If the freshly-loaded page fails the same way, the cause is not
     * staleness — and reloading again turns one broken view into a tab that reloads forever, which
     * is far worse than an error message.
     */
    reloadForNewBuild();
    reload.mockClear();
    expect(reloadForNewBuild()).toBe(false);
    expect(reload).not.toHaveBeenCalled();
  });

  it('reloads again once the guard window has passed', () => {
    markReloaded();
    sessionStorage.setItem('isl:chunk-reload', String(Date.now() - 60_000));
    expect(reloadForNewBuild()).toBe(true);
  });

  it('still reloads when sessionStorage is unavailable', () => {
    // Private-mode browsers can throw on storage. Sitting on a broken view is the worse failure.
    const original = Object.getOwnPropertyDescriptor(window, 'sessionStorage');
    Object.defineProperty(window, 'sessionStorage', {
      configurable: true,
      get() { throw new Error('denied'); },
    });
    expect(reloadForNewBuild()).toBe(true);
    if (original) Object.defineProperty(window, 'sessionStorage', original);
  });
});
