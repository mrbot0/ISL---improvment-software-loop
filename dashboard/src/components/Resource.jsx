import { Empty, Skeleton } from './ui.jsx';
import { t as tr } from '../i18n.js';

/**
 * THE THREE STATES EVERY FETCHED PANEL HAS (ISL_Frontend §6 P0).
 *
 * Loading, empty and failed are not edge cases — they are three of the four things a panel can be,
 * and each view was inventing its own answer to all three. Measured before this: 26 views spun a
 * `Spinner`, 19 had an `Empty`, `Skeleton` existed in `ui.jsx` and **no view used it at all**, and
 * error handling ranged from a toast to a silent `.catch(() => {})`.
 *
 * The silent catch is the one that matters. A panel that renders nothing because the request failed
 * looks exactly like a panel that renders nothing because there is nothing to show — and the second
 * is fine while the first is a server the operator needs to know about. (Converting the polling
 * views to `useResource` made this worse before it made it better: dropping a `.catch` that raised
 * a toast turned a reported failure into an invisible one. This is the structural fix for that.)
 *
 * Pass a `useResource` result straight in:
 *
 *   const runs = useResource('runs', api.problemRuns);
 *   <Resource {...runs} empty="No failed runs." >{(data) => <RunList runs={data} />}</Resource>
 *
 * `children` is a function so it only runs once data exists — no `data?.x?.y` chains guarding
 * against a shape that is simply not there yet.
 */
export function Resource({
  data,
  loading,
  error,
  refetch,
  empty = null,
  emptyTitle = null,
  emptyHint = null,
  emptyIcon = null,
  isEmpty = defaultIsEmpty,
  rows = 3,
  children,
}) {
  // ERROR FIRST. Stale data with a failed refresh is still a failure the operator should see: the
  // numbers on screen are no longer the truth, and silently showing them is how someone acts on a
  // reading that stopped being live ten minutes ago.
  if (error) {
    return (
      <div role="alert" className="rounded-lg border border-rose-900/50 bg-rose-950/20 px-3 py-2.5 text-[11px] text-rose-300">
        <div className="font-medium">{tr('resource.failed')}</div>
        <div className="mt-0.5 text-rose-400/80">{String(error.message || error)}</div>
        {refetch && (
          <button onClick={refetch} className="btn-ghost mt-1.5 text-[10px]">
            {tr('resource.retry')}
          </button>
        )}
      </div>
    );
  }

  // A skeleton, not a spinner: it hints at the shape of what is coming, so the panel does not jump
  // when it arrives. Only on the FIRST load — a background refresh with data already on screen must
  // not blank the page out, which is the whole point of the cache paint.
  if (loading && data == null) return <Skeleton rows={rows} />;

  if (isEmpty(data)) {
    return <Empty icon={emptyIcon} title={emptyTitle} hint={emptyHint}>{empty}</Empty>;
  }

  return typeof children === 'function' ? children(data) : children;
}

/** Null, an empty array, or an object with no keys. A zero or an empty string is real data. */
function defaultIsEmpty(data) {
  if (data == null) return true;
  if (Array.isArray(data)) return data.length === 0;
  if (typeof data === 'object') return Object.keys(data).length === 0;
  return false;
}
