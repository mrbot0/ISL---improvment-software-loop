import { getSetting, setSetting } from '../db.js';

/**
 * CHANGE-SIZE BUDGET (ISL_IMPROVE "New high-value functions", P1).
 *
 * A change nobody can read is a change nobody can trust. This caps how much one iteration may
 * change, on two thresholds:
 *   - soft : past this, the change is routed to human review (it still lands — the loop never
 *            stalls — but a human is asked to bless it). This is the threshold the review queue uses.
 *   - hard : past this, the change is VETOED at finalize and never commits — a diff this large is
 *            almost always a runaway (a whole file rewritten, generated code, an accidental dump),
 *            not a reviewable improvement.
 * Refactors legitimately move a lot of code, so they get a larger allowance (a multiplier).
 * All four numbers are operator-configurable; the defaults are deliberately generous on the hard cap
 * so only genuinely unreviewable diffs are stopped.
 */

const DEFAULTS = {
  softFiles: 8,
  softAdditions: 400,
  hardFiles: 40,
  hardAdditions: 2500,
  refactorMultiplier: 3, // refactors move code — allow proportionally more
};

/** Current budget = defaults overlaid with any operator setting. */
export function getChangeBudget() {
  const saved = getSetting('changeBudget', null) || {};
  const b = { ...DEFAULTS };
  for (const k of Object.keys(DEFAULTS)) {
    const v = Number(saved[k]);
    if (Number.isFinite(v) && v > 0) b[k] = v;
  }
  return b;
}

/** Persist an operator override (only the known numeric keys). */
export function setChangeBudget(patch = {}) {
  const cur = getSetting('changeBudget', {}) || {};
  const next = { ...cur };
  for (const k of Object.keys(DEFAULTS)) {
    const v = Number(patch[k]);
    if (Number.isFinite(v) && v > 0) next[k] = v;
  }
  setSetting('changeBudget', next);
  return getChangeBudget();
}

/**
 * Classify a diff against the budget.
 * @returns {{ level:'ok'|'review'|'veto', reason:string|null, caps:object }}
 */
export function checkChangeBudget({ filesChanged = 0, additions = 0, refactor = false } = {}) {
  const b = getChangeBudget();
  const mult = refactor ? b.refactorMultiplier : 1;
  const hardFiles = b.hardFiles * mult;
  const hardAdditions = b.hardAdditions * mult;
  const softFiles = b.softFiles * mult;
  const softAdditions = b.softAdditions * mult;

  if (filesChanged > hardFiles || additions > hardAdditions) {
    return {
      level: 'veto',
      reason: `change-size veto — ${filesChanged} files / +${additions} lines exceeds the hard budget (${hardFiles} files / +${hardAdditions})${refactor ? ' [refactor allowance applied]' : ''}; a diff this large is not reviewable`,
      caps: { hardFiles, hardAdditions, softFiles, softAdditions },
    };
  }
  if (filesChanged > softFiles || additions > softAdditions) {
    return {
      level: 'review',
      reason: `over the soft budget (${softFiles} files / +${softAdditions}) — routed to human review`,
      caps: { hardFiles, hardAdditions, softFiles, softAdditions },
    };
  }
  return { level: 'ok', reason: null, caps: { hardFiles, hardAdditions, softFiles, softAdditions } };
}
