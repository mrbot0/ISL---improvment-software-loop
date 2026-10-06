import { healthReport } from '../iteration/healthIndex.js';
import { getSetting, setSetting } from '../db.js';

/**
 * HEALTH-GATED AUTONOMY (ISL_IMPROVE "Next wave", P1).
 *
 * A self-correcting governor. If the codebase Health Index falls more than `healthGuardDrop` points
 * below a recent peak, ISL enters STABILISE mode: it stops auto-landing (every change routes to a
 * human review) until health recovers. The autonomous loop keeps running — it just gets more
 * cautious exactly when the codebase is trending the wrong way, which is when caution matters most.
 * Deterministic: driven entirely by the honest Health Index trend, no LLM.
 */

const DEFAULT_DROP = 3;
const RECENT_SNAPSHOTS = 10; // window over which a "recent peak" is measured (~10h, health is 1/hr)

export function getHealthGuard() {
  const v = Number(getSetting('healthGuardDrop', DEFAULT_DROP));
  return Number.isFinite(v) && v > 0 ? v : DEFAULT_DROP;
}
export function setHealthGuard(n) {
  const v = Math.max(1, Math.min(25, Number(n) || DEFAULT_DROP));
  setSetting('healthGuardDrop', v);
  return v;
}

/**
 * The current autonomy stance.
 * @returns {{ mode:'normal'|'stabilize', health, peak, drop, threshold, reason }}
 */
export function autonomyMode() {
  let health = null;
  let trend = [];
  try {
    const r = healthReport();
    health = r.score;
    trend = r.trend || [];
  } catch { /* no snapshots yet */ }

  const threshold = getHealthGuard();
  const recent = trend.slice(-RECENT_SNAPSHOTS).map((t) => t.score);
  const peak = recent.length ? Math.max(...recent, health ?? 0) : (health ?? 0);
  const drop = health != null ? health - peak : 0; // ≤ 0 when below the recent peak
  const stabilize = health != null && drop <= -threshold;

  return {
    mode: stabilize ? 'stabilize' : 'normal',
    health,
    peak,
    drop,
    threshold,
    reason: stabilize
      ? `codebase health fell ${Math.abs(drop)} pt(s) below a recent peak of ${peak} — stabilising: no auto-land until it recovers`
      : null,
  };
}
