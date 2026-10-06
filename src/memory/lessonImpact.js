import { db } from '../db.js';
import { FAILURE_LESSONS } from './lessons.js';

/**
 * DOES A LESSON ACTUALLY WORK?
 *
 * Writing a lesson is easy and feels like progress. Whether the fleet stops making the mistake is a
 * different question, and until now nothing asked it — a lesson was recorded, injected into every
 * prompt forever, and never measured.
 *
 * The measurement is simple: for each taught failure code, compare how often it happened BEFORE the
 * lesson was first written with how often it has happened SINCE, as a share of runs in each window.
 * Rate, not count — a lesson taught during a quiet week would otherwise look effective for no reason.
 *
 * ── The finding that shaped this ─────────────────────────────────────────────────────────────────
 * A lesson that does NOT reduce recurrence is the interesting case, and the honest reading of it is
 * usually **not** "the agent is ignoring us". It is "the diagnosis is wrong — this failure has a
 * cause the agent cannot act on".
 *
 * The live data proves the point. The largest implementation failure in this project's history was
 * `empty` (82 runs: "the implementer finished without editing any file"), and every lesson written
 * about it was useless — because the real cause was `\r\n` line endings in `edit_file`, which no
 * amount of instruction could have fixed. A measure like this one, running from the start, would
 * have said "this lesson is not landing" and pointed at the system instead of the model.
 *
 * So this is not a report card for the agents. It is a check on whether OUR explanation of a failure
 * is the right one.
 */

/** Minimum runs on each side before a verdict is anything but noise. */
const MIN_SAMPLE = 8;

/**
 * How many runs to weigh on each side of the moment a lesson was written.
 *
 * Large enough that one unlucky run cannot flip a verdict, small enough that the "before" side is
 * recent history rather than the whole life of the project.
 */
const WINDOW_RUNS = 30;

/**
 * How each taught lesson has fared since it was first written.
 *
 * @returns {Array<{code, taughtAt, before:{runs,failures,rate}, after:{runs,failures,rate},
 *                  delta, verdict, note}>}
 */
export function lessonImpact() {
  let lessons = [];
  try {
    // `source` is `lesson:<code>` — set by `lessonFor`, so a hand-written memory is not measured as
    // if it were one of the curated lessons.
    lessons = db
      .prepare(`SELECT source, MIN(created_at) taught_at FROM memory WHERE source LIKE 'lesson:%' GROUP BY source`)
      .all();
  } catch {
    return [];
  }

  const out = [];
  for (const row of lessons) {
    const code = String(row.source).slice('lesson:'.length);
    if (!FAILURE_LESSONS[code]) continue; // a code we no longer teach
    const taughtAt = row.taught_at;

    /*
     * A BOUNDED window on each side, counted in RUNS rather than in time.
     *
     * "Everything before the lesson" sounds thorough and is not: it stretches back through periods
     * when the codebase, the model and the gates were all different, so a lesson taught today is
     * measured against a project that no longer exists. It also makes the two sides incomparable —
     * six months on one side, a week on the other.
     *
     * The same number of runs either side of the moment the lesson was written is the honest
     * comparison, and it is the one a person would make by hand.
     */
    const side = (order, boundary) => {
      const rows = db
        .prepare(
          `SELECT failure_code FROM iterations
           WHERE started_at ${order === 'before' ? '<' : '>='} ?
           ORDER BY started_at ${order === 'before' ? 'DESC' : 'ASC'}
           LIMIT ?`,
        )
        .all(boundary, WINDOW_RUNS);
      const failures = rows.filter((r) => r.failure_code === code).length;
      return { runs: rows.length, failures, rate: rows.length ? +(failures / rows.length).toFixed(3) : null };
    };

    const before = side('before', taughtAt);
    const after = side('after', taughtAt);

    let verdict = 'too-early';
    let note = `Only ${after.runs} run(s) since this was first taught — not enough to judge.`;
    if (before.runs >= MIN_SAMPLE && after.runs >= MIN_SAMPLE) {
      const b = before.rate ?? 0;
      const a = after.rate ?? 0;
      if (a === 0) {
        verdict = 'learned';
        note = 'The failure has not recurred since the lesson was written.';
      } else if (a < b * 0.6) {
        verdict = 'working';
        note = `Recurrence fell from ${Math.round(b * 100)}% of runs to ${Math.round(a * 100)}%.`;
      } else if (a > b * 1.2) {
        verdict = 'not-landing';
        note =
          `Recurrence ROSE from ${Math.round(b * 100)}% to ${Math.round(a * 100)}% of runs. `
          + 'A lesson that makes no difference usually means the diagnosis is wrong — look for a cause the agent cannot act on '
          + '(a tool that refuses its edits, an environment difference, a guard that is too strict) before writing another lesson.';
      } else {
        verdict = 'no-change';
        note =
          `Recurrence is unchanged (${Math.round(b * 100)}% → ${Math.round(a * 100)}% of runs). `
          + 'The instruction is not the missing piece — check whether this failure has a cause outside the agent\'s control.';
      }
    }

    out.push({ code, taughtAt, before, after, delta: (after.rate ?? 0) - (before.rate ?? 0), verdict, note });
  }

  // The ones that are not working first — those are the ones that need a human to look.
  const rank = { 'not-landing': 0, 'no-change': 1, working: 2, learned: 3, 'too-early': 4 };
  return out.sort((x, y) => rank[x.verdict] - rank[y.verdict] || y.after.failures - x.after.failures);
}

/**
 * Codes whose lesson has demonstrably been learned.
 *
 * The injected memory block is capped, so a lesson the fleet has stopped needing is occupying a line
 * that a lesson it still needs could use. Stepping aside is not forgetting: the memory stays, and
 * the moment the failure recurs the verdict flips and it comes straight back.
 */
export function learnedCodes() {
  return lessonImpact().filter((l) => l.verdict === 'learned').map((l) => l.code);
}

/** The lessons a human should look at, because instruction is not fixing them. */
export function lessonsNotLanding() {
  return lessonImpact().filter((l) => l.verdict === 'not-landing' || l.verdict === 'no-change');
}
