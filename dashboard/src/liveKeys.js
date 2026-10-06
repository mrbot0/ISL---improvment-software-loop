/**
 * WHICH EVENT MAKES WHICH DATA STALE (ISL_Frontend §3 P0, §7 P0).
 *
 * The dashboard had a shared cache with WebSocket-driven invalidation (F4) and — measured across the
 * views — used it nowhere. Eight views and three widgets each ran their own `setInterval`: the
 * iteration detail refetched every 3 seconds, the runtime every 4, four more every 5, forever,
 * whether or not anything had happened. That is a request every few hundred milliseconds across an
 * open dashboard, to learn "nothing changed" nearly every time, while the server was already
 * pushing the truth down a socket the page had open.
 *
 * The fix is not "poll less" — it is to let the event that CAUSED the change say what it invalidated.
 * This table is that mapping, kept in one file on purpose: an event type and the data it makes stale
 * are one fact, and splitting it across eight views is how the two drift apart.
 *
 * Keys ending in `*` are prefix wildcards (see `invalidateResource`), which is how a per-id resource
 * like `iteration:214` is refreshed without this table needing to know the ids.
 *
 * A slow interval REMAINS on each resource as a safety net, because a dropped socket must degrade
 * into a stale-but-eventually-correct page rather than a frozen one. It is measured in tens of
 * seconds instead of single digits, so the common case costs almost nothing.
 */
export const EVENT_KEYS = {
  // ── the iteration pipeline ────────────────────────────────────────────────
  'iteration.started': ['iterations', 'iteration:*', 'runs:*', 'backlog'],
  'iteration.phase': ['iteration:*'],
  'iteration.task': ['iteration:*'],
  'iteration.replayed': ['iteration:*', 'runs:*'],
  'iteration.plan': ['iterations', 'iteration:*', 'decisions', 'security:risk', 'backlog'],
  'iteration.finished': ['iterations', 'iteration:*', 'runs:*', 'decisions', 'security:risk', 'backlog', 'health-index', 'context:situation'],

  // ── the control plane ─────────────────────────────────────────────────────
  'control.loop': ['runs:*'],
  'control.tick': ['runs:*'],
  'control.restart_all_done': ['runs:*', 'iterations'],

  // ── everything else that changes data a view is showing ───────────────────
  'deploy.promoted': ['deploy', 'dora', 'health-index'],
  'dora.deployed': ['dora'],
  'dora.breach': ['dora', 'reliability:*'],
  'backlog.changed': ['backlog'],
  'feature.changed': ['backlog'],
  'runtime.changed': ['runtime'],
  'runtime.status': ['runtime'],
  'services.changed': ['services'],
  'context.built': ['context:*'],
  'reliability.signal': ['reliability:*'],
  'reliability.error': ['reliability:*'],
  'bisect.finished': ['reliability:*'],
  'memory.changed': ['memory'],
  'proposal.created': ['proposals'],
  'proposal.decided': ['proposals', 'decisions'],
  'project.switched': ['*'], // a different codebase — nothing cached is about it any more
};

/**
 * A manager brief is a single event type carrying many different subjects, so it needs the manager's
 * name to say what it touched. Kept apart from the table above rather than folded in, because the
 * lookup is on a different field and pretending otherwise would make both harder to read.
 */
export const MANAGER_KEYS = {
  Risk: ['security:risk'],
  Reliability: ['reliability:*'],
  Deployment: ['deploy', 'dora'],
  Context: ['context:*'],
  Operations: ['runtime', 'services'],
  Insights: ['health-index'],
};

/** Every resource key an event invalidates. Unknown events invalidate nothing — deliberately. */
export function keysForEvent(ev) {
  if (!ev?.type) return [];
  if (ev.type === 'manager.brief') return MANAGER_KEYS[ev.manager] || [];
  return EVENT_KEYS[ev.type] || [];
}

/**
 * The safety-net refresh for a resource, in ms.
 *
 * Only for the case where the socket is down or an event we do not model happened. Long by design:
 * the events above are the real update path, and a short interval here would quietly restore the
 * polling this replaced.
 */
export const SAFETY_NET_MS = 60_000;

/** Faster net for the two things an operator watches live and would notice lagging. */
export const SAFETY_NET_LIVE_MS = 20_000;
