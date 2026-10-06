import { db, getSetting, setSetting } from '../db.js';
import { scanDiff, scorePenalty } from '../iteration/securityGate.js';
import { scanSafety } from '../iteration/safetyGate.js';
import { evaluatePolicy } from './policy.js';
import { audit } from '../platform/platformDb.js';

/**
 * SELF-EVALUATION HARNESS (ISL_IMPROVE "Enterprise wave", P1).
 *
 * Models, prompts and gate thresholds are changed by judgement. Per-role model selection exists, the
 * change budget is tunable, policy is now editable — and there was **no way to answer "did that make
 * ISL better?"**. The only feedback was the land rate, which moves for a dozen unrelated reasons.
 *
 * This replays a frozen set of REAL past changes through the deterministic gates under a candidate
 * configuration, and reports what changed. Two deliberate limits, both stated in every result rather
 * than papered over:
 *
 *   1. **Only the deterministic gates are replayed.** Security, safety, change-size, policy and the
 *      review classification are pure functions of a diff and a config, so replaying them is exact
 *      and free. The LLM phases are not: replaying those needs real model calls, would cost real
 *      money and would not be reproducible anyway. A harness that pretended to score them from
 *      stored text would be measuring its own fiction.
 *   2. **Agreement with humans is only as strong as the labels.** A verdict is "labelled" only where
 *      a human actually decided. With few labels, precision and recall are noise — so the sample size
 *      is reported alongside every agreement figure, and `underpowered` is set when it is too small
 *      to conclude anything.
 *
 * What IS reliable even with no labels at all is **verdict stability**: replay every stored diff
 * under baseline and candidate, and count how many verdicts flip and in which direction. A flip
 * toward *permissive* — a change that used to be held now auto-landing — is the dangerous direction,
 * and it is reported separately from the safe one. That single number is what an operator needs
 * before promoting a threshold change, and it needs no ground truth.
 */

const SET_KEY = 'eval.goldenSet';

/* ------------------------------- golden set -------------------------------- */

/**
 * Freeze a set of real past changes to evaluate against.
 *
 * Cases are drawn from iterations that stored a diff, joined to their review outcome where one
 * exists. Both LABELLED (a human decided) and unlabelled cases are kept: the labelled ones measure
 * agreement, the unlabelled ones measure stability, and throwing the latter away would discard most
 * of the evidence available.
 */
export function buildGoldenSet({ limit = 200 } = {}) {
  const rows = db
    .prepare(
      `SELECT i.id, i.plan_title, i.diff, i.files_changed, i.additions, i.deletions,
              i.total_score, i.status,
              r.status AS review_status, r.risk AS review_risk, r.decision AS review_decision,
              r.sensitive, r.agent, r.area, r.trust_level
       FROM iterations i
       LEFT JOIN review_queue r ON r.iteration_id = i.id
       WHERE i.diff IS NOT NULL AND i.diff != ''
       ORDER BY i.id DESC LIMIT ?`,
    )
    .all(limit);

  const cases = rows.map((r) => ({
    id: r.id,
    title: r.plan_title,
    diff: r.diff,
    filesChanged: r.files_changed,
    additions: r.additions,
    deletions: r.deletions,
    agent: r.agent || 'implementer',
    area: r.area || null,
    sensitive: !!r.sensitive,
    // Null when no review recorded the trust: unknown, NOT "probation". Defaulting here is what
    // made the harness blind to the size thresholds in the first place.
    agentTrust: r.trust_level || null,
    // The ground truth, where it exists. `auto` is a machine decision, not a human one, so it is
    // NOT a label — treating it as one would be scoring the gates against themselves.
    label: r.review_status === 'approved' ? 'approved' : r.review_status === 'rejected' ? 'rejected' : null,
  }));

  const set = {
    version: (getSetting(SET_KEY, null)?.version || 0) + 1,
    frozenAt: Date.now(),
    cases,
    counts: { total: cases.length, labelled: cases.filter((c) => c.label).length },
  };
  setSetting(SET_KEY, set);
  audit('eval.golden_set_frozen', { detail: { version: set.version, ...set.counts } });
  return { version: set.version, frozenAt: set.frozenAt, counts: set.counts };
}

export function getGoldenSet() {
  return getSetting(SET_KEY, null);
}

/* --------------------------------- replay ---------------------------------- */

/** The trust levels a change can be judged under. */
const TRUST_LEVELS = ['probation', 'trusted', 'proven'];

/**
 * Run one case through the deterministic gates under a configuration, at a given trust level.
 *
 * `trust` is explicit rather than defaulted, and that matters more than it looks. The first version
 * defaulted unknown trust to `probation`, which always holds — so the size thresholds never applied
 * to the 70-odd cases with no recorded trust, and the harness was blind to changes in exactly the
 * knob it was built to evaluate. Rather than pick a different arbitrary default, `scoreConfig`
 * evaluates unlabelled cases at EVERY level: a configuration counts as loosening if it loosens under
 * any of them, which is the only assumption-free reading and the strictly safer one.
 *
 * @param {object} c       a golden case
 * @param {object} config  { softFiles, softAdditions, policy }
 * @param {string} trust   'probation' | 'trusted' | 'proven'
 */
export function replayCase(c, config = {}, trust = 'probation') {
  // Both gates return { findings, veto, summary } — the veto is the gate's OWN verdict, so it is
  // used directly rather than re-derived from severities here. Re-deriving would mean the harness
  // scored a second, subtly different copy of each gate instead of the gate itself.
  const security = scanDiff(c.diff);
  const safety = scanSafety(c.diff);
  const penalty = scorePenalty(security.findings || []);

  const secVeto = !!security.veto;
  const safetyVeto = !!safety.veto;

  const softFiles = config.softFiles ?? 12;
  const softAdditions = config.softAdditions ?? 400;
  const big = c.filesChanged > softFiles || c.additions > softAdditions;

  // The same shape of decision `classifyChange` makes, reproduced here over frozen facts so the
  // replay does not depend on live trust or health, which move for reasons unrelated to the config
  // under test. Isolating the variable is the whole point of a harness.
  const risk = c.sensitive ? 'high' : big ? 'medium' : 'low';
  let held = c.sensitive || secVeto || safetyVeto;
  if (!held) {
    if (trust === 'proven') held = false;
    else if (trust === 'trusted') held = big;
    else held = true;
  }

  const pol = config.policy ? evaluatePolicy({ risk, sensitive: c.sensitive, area: c.area, agent: c.agent, agentTrust: trust, filesChanged: c.filesChanged, additions: c.additions, files: [] }, { ...config.policy, enabled: true }) : { outcome: 'allow', matched: [] };
  if (pol.outcome !== 'allow') held = true;

  return {
    id: c.id,
    trust,
    verdict: held ? 'review' : 'auto',
    risk,
    securityFindings: (security.findings || []).length,
    securityVeto: secVeto,
    safetyVeto,
    penalty,
    policyMatched: pol.matched.map((m) => m.id),
  };
}

/* ---------------------------------- score ---------------------------------- */

/** Replay the whole set under one configuration. */
export function scoreConfig(config = {}, set = getGoldenSet()) {
  if (!set?.cases?.length) return { ok: false, reason: 'no golden set has been frozen yet' };
  // A case with a RECORDED trust is replayed at that trust — that is ground truth. A case without
  // one is replayed at every level, because guessing would hide the effect of any config knob that
  // only applies at some levels (which is what the size thresholds do).
  const results = [];
  for (const c of set.cases) {
    const levels = c.agentTrust && TRUST_LEVELS.includes(c.agentTrust) ? [c.agentTrust] : TRUST_LEVELS;
    for (const t of levels) results.push({ ...replayCase(c, config, t), label: c.label });
  }

  const labelled = results.filter((r) => r.label);
  // A human "approved" means the change was acceptable; "rejected" means it should have been stopped.
  // Agreement asks: did the gates hold what the human rejected, and let through what they approved?
  let agree = 0;
  let missedRejection = 0; // the dangerous error: gates let through something a human rejected
  let overHeld = 0;        // the safe error: gates held something a human approved
  for (const r of labelled) {
    const shouldHold = r.label === 'rejected';
    const didHold = r.verdict === 'review';
    if (shouldHold === didHold) agree++;
    else if (shouldHold && !didHold) missedRejection++;
    else overHeld++;
  }

  return {
    ok: true,
    setVersion: set.version,
    // `cases` is the frozen changes; `evaluations` is those expanded across trust levels, which is
    // what the counts below are out of.
    cases: set.cases.length,
    evaluations: results.length,
    held: results.filter((r) => r.verdict === 'review').length,
    auto: results.filter((r) => r.verdict === 'auto').length,
    securityVetoes: results.filter((r) => r.securityVeto).length,
    safetyVetoes: results.filter((r) => r.safetyVeto).length,
    totalFindings: results.reduce((n, r) => n + r.securityFindings, 0),
    agreement: {
      labelled: labelled.length,
      agree,
      missedRejection,
      overHeld,
      rate: labelled.length ? Math.round((agree / labelled.length) * 100) : null,
      // Below this, precision and recall are noise. Saying so is more useful than a percentage
      // computed from four samples and presented as a measurement.
      underpowered: labelled.length < 20,
      note: labelled.length < 20
        ? `only ${labelled.length} human-decided case(s) in the set — too few to conclude anything about agreement; use the stability comparison instead`
        : null,
    },
    results,
  };
}

/**
 * Compare a candidate configuration against a baseline over the same frozen set.
 *
 * The headline number is `loosened` — verdicts that moved from held to auto. That is the direction
 * in which a configuration change can hurt, it needs no ground-truth labels, and it is the question
 * an operator actually has before promoting a threshold change.
 */
export function compareConfigs(baseline = {}, candidate = {}, set = getGoldenSet()) {
  const a = scoreConfig(baseline, set);
  const b = scoreConfig(candidate, set);
  if (!a.ok) return a;
  if (!b.ok) return b;

  // Keyed by case AND trust level — the same change judged at two trust levels is two evaluations,
  // and collapsing them onto the id would silently drop all but one.
  const byKey = new Map(a.results.map((r) => [`${r.id}@${r.trust}`, r]));
  const loosened = [];
  const tightened = [];
  for (const r of b.results) {
    const was = byKey.get(`${r.id}@${r.trust}`);
    if (!was || was.verdict === r.verdict) continue;
    (was.verdict === 'review' && r.verdict === 'auto' ? loosened : tightened).push({ id: r.id, trust: r.trust, from: was.verdict, to: r.verdict });
  }

  return {
    ok: true,
    setVersion: a.setVersion,
    cases: a.cases,
    evaluations: a.evaluations,
    baseline: summary(a),
    candidate: summary(b),
    flips: { loosened: loosened.length, tightened: tightened.length, loosenedCases: loosened.slice(0, 20), tightenedCases: tightened.slice(0, 20) },
    verdict: loosened.length
      ? `REGRESSION RISK: ${loosened.length} change(s) that were held for a human would now auto-land`
      : tightened.length
        ? `stricter: ${tightened.length} additional change(s) would be held`
        : 'no verdict changed on this set',
    // A candidate is only recommendable when it does not loosen; anything else is a judgement call
    // that belongs to a human, and the harness declines to make it for them.
    safeToPromote: loosened.length === 0,
  };
}

const summary = (s) => ({
  held: s.held, auto: s.auto, securityVetoes: s.securityVetoes, safetyVetoes: s.safetyVetoes,
  totalFindings: s.totalFindings, agreement: { rate: s.agreement.rate, labelled: s.agreement.labelled, missedRejection: s.agreement.missedRejection },
});
