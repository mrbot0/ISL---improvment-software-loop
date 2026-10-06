import { getSetting, setSetting } from '../db.js';
import { matchesAny } from '../glob.js';
import { audit } from '../platform/platformDb.js';

/**
 * POLICY-AS-CODE (ISL_IMPROVE "Enterprise wave", P0).
 *
 * The six hard vetoes and the review queue's routing rules live in JavaScript. An organisation
 * cannot express "changes under payments/** need two approvals", "no dependency added under a
 * non-approved licence", "migrations only inside a change window" without editing ISL's own source —
 * and, worse, cannot prove AFTER THE FACT which rules were in force when a change landed.
 *
 * This adds a versioned, per-project rule document evaluated deterministically over facts ISL
 * already computes. Three design decisions carry the weight:
 *
 *   1. **Policy can only TIGHTEN, never loosen.** A rule can force a human review or block a
 *      promotion; nothing in a policy document can grant auto-land latitude the built-in
 *      classification withheld. This is deliberately stricter than the original proposal, which
 *      described replacing the hard-coded gates outright. Replacing battle-tested veto logic with a
 *      config file means a gap in the config becomes a gap in the guardrails — and the failure mode
 *      is silent. Layering means the worst a broken policy can do is demand too many reviews.
 *   2. **Every matching rule is evaluated, and the most restrictive outcome wins** — not
 *      first-match. Rule ordering is then irrelevant, so an operator cannot weaken the policy by
 *      accidentally putting a permissive rule first.
 *   3. **Simulation before adoption.** `simulate()` replays a draft against real past changes and
 *      reports exactly what would have changed. A policy whose effect is unknown is not a control.
 *
 * JSON rather than YAML: it needs no dependency, and a policy is read by the evaluator far more
 * often than it is hand-edited.
 */

const KEY = 'policy.document';
const ORDER = { allow: 0, review: 1, deny: 2 }; // severity — higher always wins

/** Outcomes a rule may demand. */
export const OUTCOMES = {
  allow: 'No constraint added. The built-in classification decides.',
  review: 'A human must decide, whatever the agent has earned.',
  deny: 'A human must decide AND the change may never auto-promote.',
};

/** The conditions a rule may match on, and what each means. Surfaced to the UI as documentation. */
export const CONDITIONS = {
  paths: 'Any changed file matches one of these globs (e.g. "backend/server/payments/**").',
  risk: 'The classified risk is one of these ("low" | "medium" | "high").',
  sensitive: 'The change touches a sensitive area (auth / payment / migration).',
  area: 'The change\'s area is one of these ("backend" | "frontend" | "services" | …).',
  agentTrust: 'The acting agent\'s trust level is one of these ("probation" | "trusted" | "proven").',
  minFilesChanged: 'At least this many files changed.',
  minAdditions: 'At least this many lines added.',
  agents: 'The acting agent is one of these.',
};

const DEFAULT_POLICY = {
  version: 1,
  updatedAt: null,
  updatedBy: null,
  enabled: false,
  // Ships EMPTY and disabled on purpose: the acceptance test for this feature is that turning it on
  // changes nothing until an organisation writes a rule. Anything else would be ISL quietly
  // altering the routing of changes on upgrade.
  rules: [],
};

export function getPolicy() {
  const saved = getSetting(KEY, null);
  return { ...DEFAULT_POLICY, ...(saved || {}) };
}

/**
 * Validate a policy document. Returns the errors rather than throwing on the first one, because an
 * operator fixing a policy wants the whole list, not a game of whack-a-mole.
 */
export function validatePolicy(doc) {
  const errors = [];
  if (!doc || typeof doc !== 'object') return ['the policy must be an object'];
  const rules = doc.rules;
  if (!Array.isArray(rules)) return ['`rules` must be an array'];

  const ids = new Set();
  rules.forEach((r, i) => {
    const at = `rule[${i}]${r?.id ? ` (${r.id})` : ''}`;
    if (!r || typeof r !== 'object') return errors.push(`${at}: must be an object`);
    if (!r.id || typeof r.id !== 'string') errors.push(`${at}: needs a string \`id\``);
    else if (ids.has(r.id)) errors.push(`${at}: duplicate id — ids identify a rule in the audit record and must be unique`);
    else ids.add(r.id);
    if (!OUTCOMES[r.then]) errors.push(`${at}: \`then\` must be one of ${Object.keys(OUTCOMES).join(' | ')}`);
    if (r.when != null && typeof r.when !== 'object') errors.push(`${at}: \`when\` must be an object`);
    for (const k of Object.keys(r.when || {})) {
      if (!(k in CONDITIONS)) errors.push(`${at}: unknown condition \`${k}\` — it would silently never match`);
    }
    // A rule with no conditions matches EVERYTHING. That is occasionally intended ("review
    // everything while we onboard"), so it is allowed — but never by accident.
    if (r.when && Object.keys(r.when).length === 0 && !r.matchAll) {
      errors.push(`${at}: has an empty \`when\` and would match every change — set \`matchAll: true\` if that is intended`);
    }
  });
  return errors;
}

export function setPolicy(doc, actor = 'system') {
  const errors = validatePolicy(doc);
  if (errors.length) throw new Error(`invalid policy: ${errors.join('; ')}`);
  const prev = getPolicy();
  const next = {
    ...DEFAULT_POLICY,
    ...doc,
    // The version is ISL's, not the author's: it increments on every accepted write so an evidence
    // pack can cite the exact document that was in force.
    version: (prev.version || 0) + 1,
    updatedAt: Date.now(),
    updatedBy: actor,
  };
  setSetting(KEY, next);
  audit('policy.updated', { actor, detail: { version: next.version, rules: next.rules.length, enabled: !!next.enabled } });
  return next;
}

/* -------------------------------- evaluation ------------------------------- */

const asArray = (v) => (v == null ? [] : Array.isArray(v) ? v : [v]);

/** Does one rule's `when` match these facts? An absent condition is simply not a constraint. */
function ruleMatches(rule, facts) {
  const w = rule.when || {};
  if (rule.matchAll && !Object.keys(w).length) return true;
  if (!Object.keys(w).length) return false; // guarded by validation, belt-and-braces here

  if (w.paths && !(facts.files || []).some((f) => matchesAny(f, asArray(w.paths)))) return false;
  if (w.risk && !asArray(w.risk).includes(facts.risk)) return false;
  if (w.sensitive != null && !!facts.sensitive !== !!w.sensitive) return false;
  if (w.area && !asArray(w.area).includes(facts.area)) return false;
  if (w.agentTrust && !asArray(w.agentTrust).includes(facts.agentTrust)) return false;
  if (w.agents && !asArray(w.agents).includes(facts.agent)) return false;
  if (w.minFilesChanged != null && (facts.filesChanged || 0) < w.minFilesChanged) return false;
  if (w.minAdditions != null && (facts.additions || 0) < w.minAdditions) return false;
  return true;
}

/**
 * Evaluate the policy against one change.
 *
 * @returns {{outcome:'allow'|'review'|'deny', matched:Array<{id,then,reason}>, approvals:number}}
 */
export function evaluatePolicy(facts, policy = getPolicy()) {
  if (!policy.enabled || !policy.rules?.length) return { outcome: 'allow', matched: [], approvals: 1 };

  const matched = [];
  let outcome = 'allow';
  let approvals = 1;
  for (const rule of policy.rules) {
    if (!ruleMatches(rule, facts)) continue;
    matched.push({ id: rule.id, then: rule.then, reason: rule.reason || rule.description || rule.id });
    if (ORDER[rule.then] > ORDER[outcome]) outcome = rule.then;
    if (rule.approvals && rule.approvals > approvals) approvals = rule.approvals;
  }
  return { outcome, matched, approvals };
}

/**
 * Apply the policy ON TOP of the built-in classification. Tighten-only: `decision` may move from
 * `auto` to `review`, never the other way, and the reasons the policy added are named so a reviewer
 * sees WHICH rule held their change.
 */
export function applyPolicy(base, facts, policy = getPolicy()) {
  const verdict = evaluatePolicy(facts, policy);
  if (verdict.outcome === 'allow') return { ...base, policy: verdict };

  const reasons = [...base.reasons];
  for (const m of verdict.matched) {
    if (m.then === 'allow') continue;
    reasons.push(`policy ${m.id}: ${m.reason}`);
  }
  return {
    ...base,
    decision: 'review', // both `review` and `deny` require a human
    // `deny` additionally bars auto-promotion — recorded so the promoter can honour it.
    policyBlocked: verdict.outcome === 'deny',
    requiredApprovals: verdict.approvals,
    reasons,
    policy: verdict,
  };
}

/* -------------------------------- simulation ------------------------------- */

/**
 * Replay a draft policy against real past changes.
 *
 * An operator must be able to see the blast radius of a rule BEFORE it starts holding production
 * changes — "how many of last month's changes would this have stopped?" is the question that decides
 * whether a policy is workable or is about to bury the team in reviews.
 *
 * @param {object} draft   the policy to test (need not be saved)
 * @param {Array}  changes past changes as fact objects, newest first
 */
export function simulate(draft, changes = []) {
  const errors = validatePolicy(draft);
  if (errors.length) return { ok: false, errors };

  const policy = { ...draft, enabled: true }; // simulate as if it were on, even when saved disabled
  const rows = changes.map((c) => {
    const v = evaluatePolicy(c, policy);
    const wasAuto = c.decision === 'auto' || c.status === 'auto';
    // The only change simulation can report is auto → held: policy never loosens.
    const wouldHold = v.outcome !== 'allow';
    return {
      id: c.id,
      title: c.title,
      was: wasAuto ? 'auto' : 'review',
      wouldBe: wouldHold ? (v.outcome === 'deny' ? 'deny' : 'review') : (wasAuto ? 'auto' : 'review'),
      changed: wasAuto && wouldHold,
      matched: v.matched.map((m) => m.id),
    };
  });

  const byRule = {};
  for (const r of rows) for (const id of r.matched) byRule[id] = (byRule[id] || 0) + 1;
  // A rule that matches nothing is usually a typo'd glob, not a rule with nothing to do — surfaced
  // rather than left for someone to discover during an incident.
  const neverMatched = (draft.rules || []).map((r) => r.id).filter((id) => !byRule[id]);

  return {
    ok: true,
    evaluated: rows.length,
    wouldChange: rows.filter((r) => r.changed).length,
    wouldDeny: rows.filter((r) => r.wouldBe === 'deny').length,
    byRule,
    neverMatched,
    rows: rows.slice(0, 100),
  };
}
