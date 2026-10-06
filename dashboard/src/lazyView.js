import { lazy } from 'react';

/**
 * A LAZY VIEW THAT SURVIVES A REDEPLOY.
 *
 * Vite names each lazily-loaded chunk with a hash of its contents, so every rebuild produces new
 * filenames and deletes the old ones. A dashboard left open in a tab is still holding the previous
 * `index.html`, which knows only the OLD names — so the moment the operator navigates to a view they
 * had not visited yet, the browser requests a file that no longer exists and React throws
 * "Failed to fetch dynamically imported module".
 *
 * This is not an edge case for a control plane that is redeployed while it is being watched. It also
 * cannot be recovered by re-rendering: the error boundary's "reload view" remounted the component,
 * which re-requested the same missing file and failed identically. Only a real page load gets the
 * new `index.html`.
 *
 * So: retry once (a genuine network blip is common and costs nothing), then reload the page. The
 * reload is guarded by a timestamp in sessionStorage — if the fresh page fails the same way, the
 * problem is not staleness and looping would replace one broken screen with an unusable one.
 */

const RELOADED_AT = 'isl:chunk-reload';
const LOOP_WINDOW_MS = 15_000;

/** The message differs per engine; all three mean the same thing. */
export function isStaleChunkError(err) {
  const m = String(err?.message || err || '');
  return /Failed to fetch dynamically imported module/i.test(m)      // Chrome, Edge
    || /error loading dynamically imported module/i.test(m)          // Firefox
    || /Importing a module script failed/i.test(m)                   // Safari
    || /Unable to preload CSS/i.test(m);                             // Vite's CSS preload helper
}

/** Have we already reloaded for this reason a moment ago? Then reloading again will not help. */
function recentlyReloaded() {
  try {
    const at = Number(sessionStorage.getItem(RELOADED_AT) || 0);
    return Number.isFinite(at) && Date.now() - at < LOOP_WINDOW_MS;
  } catch {
    return false; // storage unavailable — better to reload than to sit on a broken view
  }
}

export function markReloaded() {
  try { sessionStorage.setItem(RELOADED_AT, String(Date.now())); } catch { /* not essential */ }
}

/**
 * Reload the page to pick up the current build. Returns false when it declined (a loop guard trip),
 * so the caller can fall through to showing the error instead of hanging on a promise that never
 * settles.
 */
export function reloadForNewBuild() {
  if (recentlyReloaded()) return false;
  markReloaded();
  window.location.reload();
  return true;
}

/**
 * `lazy()`, but a chunk that has been redeployed out from under us reloads the page instead of
 * leaving a dead view.
 */
export function lazyView(importer) {
  return lazy(() =>
    importer().catch(async (err) => {
      if (!isStaleChunkError(err)) throw err;

      // One retry. A transient failure — the server restarting mid-request, which happens a lot
      // here — looks identical to a stale chunk, and a page reload for that would be heavy-handed.
      try {
        await new Promise((r) => setTimeout(r, 400));
        return await importer();
      } catch (again) {
        if (!isStaleChunkError(again)) throw again;
      }

      if (reloadForNewBuild()) {
        // The reload is in flight; never resolve, so nothing renders in the meantime.
        return new Promise(() => {});
      }
      throw err; // already reloaded once and it did not help — let the boundary show it
    }),
  );
}
