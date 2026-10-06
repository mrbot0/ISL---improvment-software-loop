import { getSetting, setSetting } from '../db.js';

/**
 * IMPROVEMENT SCOPE — the human's steering wheel.
 *
 * Left to itself the fleet drifts toward whatever is easiest to land: on this project that meant a
 * flood of unit tests and small hardening commits, and almost no UX, frontend or architectural work.
 * That is a governance problem, not a model problem — so the operator gets an explicit scope that
 * every part of the loop must obey:
 *
 *   - focus     : a weight per improvement THEME (ux, frontend, backend, architecture, security,
 *                 performance, tests, docs, infra). Weights bias the planner's batch composition,
 *                 the Decision Network's routing, and what gets seeded into the backlog.
 *   - caps      : a hard ceiling per theme (e.g. "tests ≤ 20% of a batch") so no theme can dominate
 *                 just because it is the easiest to land.
 *   - directives: free-text instructions injected into the planner, every agent's working context
 *                 and the managers' briefs ("redesign the booking flow", "reduce checkout friction").
 *   - exclude   : themes/areas the fleet must NOT spend iterations on right now.
 *   - research  : what the online research should look for (so proposals match the focus).
 *
 * Everything is deterministic and inspectable: `scopeBrief()` is the exact text the agents read, and
 * `themeAllowance()` is the exact arithmetic the planner applies.
 */

/** The themes a human thinks in — mapped to the agents that deliver them. */
export const THEMES = {
  ux: { label: 'UX & design', agents: ['ux', 'frontend'], hint: 'user flows, information architecture, usability, visual polish, accessibility' },
  frontend: { label: 'Frontend', agents: ['frontend', 'ux'], hint: 'components, state, rendering, responsiveness, client performance' },
  backend: { label: 'Backend & API', agents: ['services', 'resilience', 'quality'], hint: 'endpoints, domain logic, data access, contracts, error handling' },
  architecture: { label: 'Architecture', agents: ['refactor', 'services'], hint: 'module boundaries, splitting god-files, removing duplication, dependency direction' },
  security: { label: 'Security', agents: ['security', 'compliance'], hint: 'authn/authz, input validation, secrets, dependency CVEs' },
  performance: { label: 'Performance', agents: ['performance'], hint: 'hot paths, N+1 queries, caching, payload size, render cost' },
  tests: { label: 'Tests', agents: ['tests'], hint: 'unit/characterization coverage for critical paths' },
  docs: { label: 'Docs', agents: ['docs'], hint: 'READMEs, API docs, runbooks, inline rationale' },
  infra: { label: 'Infra & deploy', agents: ['infra', 'workbench'], hint: 'build, CI, containers, environments, observability' },
};

export const THEME_KEYS = Object.keys(THEMES);

/**
 * Defaults deliberately favour USER-VISIBLE and STRUCTURAL work over tests. Tests matter, but they
 * are also the easiest thing for an LLM to produce, so they get a modest weight and a hard cap.
 */
const DEFAULT_SCOPE = {
  focus: { ux: 20, frontend: 20, backend: 20, architecture: 15, security: 10, performance: 5, tests: 5, docs: 3, infra: 2 },
  caps: { tests: 25, docs: 15 }, // max % of a batch a theme may take
  directives: '',
  exclude: [],
  research: '',
  enforce: true, // when false the scope is advisory only (guidance text, no batch shaping)
};

export function getScope() {
  const saved = getSetting('improvementScope', null) || {};
  const focus = { ...DEFAULT_SCOPE.focus };
  for (const k of THEME_KEYS) {
    const v = Number(saved.focus?.[k]);
    if (Number.isFinite(v) && v >= 0) focus[k] = v;
  }
  const caps = { ...DEFAULT_SCOPE.caps };
  for (const k of THEME_KEYS) {
    const v = Number(saved.caps?.[k]);
    if (Number.isFinite(v) && v > 0 && v <= 100) caps[k] = v;
  }
  return {
    focus,
    caps,
    directives: typeof saved.directives === 'string' ? saved.directives : DEFAULT_SCOPE.directives,
    exclude: Array.isArray(saved.exclude) ? saved.exclude.filter((t) => THEME_KEYS.includes(t)) : [],
    research: typeof saved.research === 'string' ? saved.research : DEFAULT_SCOPE.research,
    enforce: saved.enforce != null ? !!saved.enforce : DEFAULT_SCOPE.enforce,
  };
}

export function setScope(patch = {}) {
  const cur = getScope();
  const next = {
    focus: { ...cur.focus, ...(patch.focus || {}) },
    caps: { ...cur.caps, ...(patch.caps || {}) },
    directives: patch.directives != null ? String(patch.directives).slice(0, 2000) : cur.directives,
    exclude: Array.isArray(patch.exclude) ? patch.exclude.filter((t) => THEME_KEYS.includes(t)) : cur.exclude,
    research: patch.research != null ? String(patch.research).slice(0, 1000) : cur.research,
    enforce: patch.enforce != null ? !!patch.enforce : cur.enforce,
  };
  setSetting('improvementScope', next);
  return getScope();
}

export function resetScope() {
  setSetting('improvementScope', null);
  return getScope();
}

/** Normalised focus weights (sum to 1), with excluded themes zeroed. */
export function focusShare(scope = getScope()) {
  const eff = {};
  let total = 0;
  for (const k of THEME_KEYS) {
    const w = scope.exclude.includes(k) ? 0 : Math.max(0, Number(scope.focus[k]) || 0);
    eff[k] = w;
    total += w;
  }
  if (!total) return Object.fromEntries(THEME_KEYS.map((k) => [k, 1 / THEME_KEYS.length]));
  for (const k of THEME_KEYS) eff[k] = eff[k] / total;
  return eff;
}

/**
 * The theme an agent delivers. Declared EXPLICITLY (not derived from THEMES.agents, which lists each
 * theme's contributors and would collapse two agents onto one theme — leaving 'frontend' unreachable).
 */
const AGENT_THEME = {
  ux: 'ux',
  frontend: 'frontend',
  services: 'backend',
  resilience: 'backend',
  quality: 'backend',
  refactor: 'architecture',
  security: 'security',
  compliance: 'security',
  performance: 'performance',
  tests: 'tests',
  docs: 'docs',
  infra: 'infra',
  workbench: 'infra',
};
export const themeForAgent = (agent) => AGENT_THEME[agent] || 'backend';

/**
 * How many tasks of `n` a theme may take, given the focus share and its hard cap.
 * The planner uses this to shape the batch instead of letting one theme dominate.
 */
export function themeAllowance(n, scope = getScope()) {
  const share = focusShare(scope);
  const out = {};
  for (const k of THEME_KEYS) {
    const byShare = share[k] * n;
    const cap = scope.caps[k] != null ? (scope.caps[k] / 100) * n : Infinity;
    out[k] = Math.min(byShare, cap);
  }
  return out;
}

/** Is this theme excluded or already at its cap in the current batch? */
export function themeBlocked(theme, countSoFar, batchSize, scope = getScope()) {
  if (scope.exclude.includes(theme)) return `theme '${theme}' is excluded from the current scope`;
  const cap = scope.caps[theme];
  if (cap != null && batchSize > 0 && countSoFar >= Math.max(1, Math.round((cap / 100) * batchSize))) {
    return `theme '${theme}' has reached its ${cap}% cap for this batch`;
  }
  return null;
}

/**
 * The scope as the agents, planner and managers read it. This is injected verbatim, so what the
 * operator writes on the Scope page is literally what the fleet is told.
 */
export function scopeBrief(scope = getScope()) {
  const share = focusShare(scope);
  const ranked = THEME_KEYS
    .filter((k) => !scope.exclude.includes(k) && share[k] > 0)
    .sort((a, b) => share[b] - share[a])
    .map((k) => `${THEMES[k].label} ${Math.round(share[k] * 100)}%`);

  const lines = ['IMPROVEMENT SCOPE — the operator directs the focus; follow it over your own preference.'];
  if (ranked.length) lines.push(`Focus mix: ${ranked.join(' · ')}.`);
  if (scope.exclude.length) lines.push(`Do NOT work on: ${scope.exclude.map((k) => THEMES[k].label).join(', ')}.`);
  for (const [k, cap] of Object.entries(scope.caps)) {
    if (THEMES[k] && !scope.exclude.includes(k)) lines.push(`${THEMES[k].label} may be at most ${cap}% of a batch — do not fill an iteration with it.`);
  }
  if (scope.directives.trim()) lines.push(`Operator directives:\n${scope.directives.trim()}`);
  const top = ranked[0];
  if (top) {
    const key = THEME_KEYS.find((k) => THEMES[k].label === top.split(' ').slice(0, -1).join(' '));
    if (key) lines.push(`The highest-weighted theme is ${THEMES[key].label} — ${THEMES[key].hint}.`);
  }
  return lines.join('\n');
}

/** What the online research should look for, given the scope. */
export function researchFocus(scope = getScope()) {
  const share = focusShare(scope);
  const top = THEME_KEYS.filter((k) => !scope.exclude.includes(k)).sort((a, b) => share[b] - share[a]).slice(0, 3);
  return {
    themes: top.map((k) => ({ key: k, label: THEMES[k].label, hint: THEMES[k].hint })),
    directives: scope.research.trim() || scope.directives.trim(),
  };
}
