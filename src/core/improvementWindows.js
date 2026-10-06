import { getSetting, setSetting } from '../db.js';
import { log } from '../logger.js';
import { startDependencyScan } from '../deploy/depScan.js';
import { seedCoverageBacklog } from '../iteration/coverageScan.js';
import { seedStructuralBacklog } from '../iteration/structuralScan.js';
import { recordHealthSnapshot } from '../iteration/healthIndex.js';
import { crossProjectPlan, applyCrossProjectTransfer } from './crossProject.js';
import { startEmbeddingBuild } from '../context/knowledgeIndex.js';

/**
 * SCHEDULED IMPROVEMENT WINDOWS (ISL_IMPROVE "Deeper capability", P2).
 *
 * Some work is better done when nobody's watching: refreshing the CVE scan, seeding heavier
 * structural refactors and coverage tasks, snapshotting health, promoting learnings across projects.
 * This runs those heavier passes only inside operator-defined quiet-hour windows, each task at most
 * once per window per day (rate-limited, dedup-safe), so the daytime loop stays light and the heavy
 * lifting lands overnight. Off by default — the operator opts in and picks the hours + tasks.
 */

const lg = log.for('windows');

const DEFAULTS = {
  enabled: false,
  startHour: 2, // local hour the window opens (inclusive)
  endHour: 6, // local hour it closes (exclusive); if endHour <= startHour the window spans midnight
  days: [0, 1, 2, 3, 4, 5, 6], // 0 = Sunday … 6 = Saturday
  tasks: { deps: true, coverage: true, structural: true, health: true, crossProject: false, embeddings: true },
};

function clampHour(v, dflt) {
  const n = Number(v);
  return Number.isInteger(n) && n >= 0 && n <= 23 ? n : dflt;
}

export function getSchedule() {
  const saved = getSetting('improvementWindows', null) || {};
  return {
    enabled: !!saved.enabled,
    startHour: clampHour(saved.startHour, DEFAULTS.startHour),
    endHour: clampHour(saved.endHour, DEFAULTS.endHour),
    days: Array.isArray(saved.days) && saved.days.length ? saved.days.filter((d) => d >= 0 && d <= 6) : DEFAULTS.days,
    tasks: { ...DEFAULTS.tasks, ...(saved.tasks || {}) },
  };
}

export function setSchedule(patch = {}) {
  const cur = getSchedule();
  const next = {
    enabled: patch.enabled != null ? !!patch.enabled : cur.enabled,
    startHour: patch.startHour != null ? clampHour(patch.startHour, cur.startHour) : cur.startHour,
    endHour: patch.endHour != null ? clampHour(patch.endHour, cur.endHour) : cur.endHour,
    days: Array.isArray(patch.days) ? patch.days.filter((d) => d >= 0 && d <= 6) : cur.days,
    tasks: { ...cur.tasks, ...(patch.tasks || {}) },
  };
  setSetting('improvementWindows', next);
  return next;
}

/** Is `date` inside the configured window? Handles windows that span midnight. */
function inWindow(schedule, date = new Date()) {
  if (!schedule.enabled) return false;
  const h = date.getHours();
  const day = date.getDay();
  const { startHour, endHour, days } = schedule;
  if (startHour < endHour) return days.includes(day) && h >= startHour && h < endHour;
  // Overnight window (e.g. 22 → 5): the day check applies to the side the hour falls on.
  if (h >= startHour) return days.includes(day);
  const prevDay = (day + 6) % 7;
  return h < endHour && days.includes(prevDay);
}

const todayKey = (d = new Date()) => `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`;

const TASK_RUNNERS = {
  deps: () => { startDependencyScan(); return 'dependency scan started'; },
  coverage: () => { const r = seedCoverageBacklog({ max: 3 }); return `seeded ${r.added} coverage task(s)`; },
  structural: () => { const r = seedStructuralBacklog({ max: 2 }); return `seeded ${r.added} structural task(s)`; },
  health: () => { const s = recordHealthSnapshot({ commitSha: 'scheduled' }); return `health snapshot ${s ?? 'skipped'}`; },
  crossProject: () => {
    let moved = 0;
    for (const pair of crossProjectPlan().pairs) moved += applyCrossProjectTransfer({ from: pair.from, to: pair.to, max: 5 }).transferred;
    return `transferred ${moved} pattern(s) across projects`;
  },
  embeddings: () => { const s = startEmbeddingBuild(); return s ? 'embedding build started' : 'embed build skipped (running or no model)'; },
};

/**
 * One scheduler tick. Fires each enabled task at most once per calendar day, only inside the
 * window. Best-effort per task. Returns the tasks it ran (for logging/telemetry).
 */
export function runScheduledTick(now = new Date()) {
  const schedule = getSchedule();
  if (!inWindow(schedule, now)) return { inWindow: false, ran: [] };
  const runs = getSetting('improvementWindowRuns', {}) || {};
  const today = todayKey(now);
  const ran = [];
  for (const [task, on] of Object.entries(schedule.tasks)) {
    if (!on || !TASK_RUNNERS[task]) continue;
    if (runs[task] === today) continue; // already ran this task today
    try {
      const detail = TASK_RUNNERS[task]();
      runs[task] = today;
      ran.push({ task, detail });
      lg.info(`window task '${task}': ${detail}`);
    } catch (e) {
      lg.warn(`window task '${task}' failed: ${e.message}`);
    }
  }
  if (ran.length) setSetting('improvementWindowRuns', runs);
  return { inWindow: true, ran };
}

/** The next Date (ms) the window opens, searching forward up to 8 days. */
function nextWindowOpen(schedule, from) {
  for (let i = 0; i < 8 * 24; i++) {
    const d = new Date(from.getTime() + i * 3600_000);
    d.setMinutes(0, 0, 0);
    const prev = new Date(d.getTime() - 3600_000);
    if (inWindow(schedule, d) && !inWindow(schedule, prev)) return d.getTime();
  }
  return null;
}

/** Status for the dashboard: in-window now, last runs, next open time. */
export function scheduleStatus() {
  const schedule = getSchedule();
  const now = new Date();
  return {
    ...schedule,
    inWindow: inWindow(schedule, now),
    lastRuns: getSetting('improvementWindowRuns', {}) || {},
    nextWindow: schedule.enabled ? nextWindowOpen(schedule, now) : null,
  };
}

/** Force-run the window tasks now, ignoring the window/day gates (operator "run now"). */
export function runWindowNow() {
  const schedule = getSchedule();
  const ran = [];
  for (const [task, on] of Object.entries(schedule.tasks)) {
    if (!on || !TASK_RUNNERS[task]) continue;
    try { ran.push({ task, detail: TASK_RUNNERS[task]() }); } catch (e) { ran.push({ task, detail: `failed: ${e.message}` }); }
  }
  return { ran };
}

/** Start the periodic scheduler (called once at boot). Checks every 5 minutes. */
export function startImprovementWindows() {
  const tick = () => { try { runScheduledTick(); } catch (e) { lg.warn(`tick failed: ${e.message}`); } };
  const timer = setInterval(tick, 5 * 60_000);
  if (timer.unref) timer.unref();
  tick(); // catch a window we booted into
  return timer;
}
