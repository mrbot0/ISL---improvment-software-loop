import { vi } from 'vitest';

/**
 * ONE SET OF TEST FIXTURES FOR EVERY VIEW-LEVEL TEST.
 *
 * The smoke test and the accessibility audit both need a mocked API and a realistic prop bag, and
 * they briefly had their own copies. Two copies of a response shape drift, and when they drift the
 * *test* fails for a reason that has nothing to do with the code — which teaches whoever is on call
 * to loosen the assertion rather than fix the page. So there is one copy, here.
 *
 * Every shape below mirrors what the server actually sends. That is not pedantry: a stub missing a
 * field the view is entitled to assume crashes the render, and a crashed render audits nothing while
 * looking like a pass. Three separate rounds of this were needed before the audit found anything
 * real — `services/inventory.js`, `deploy/cloudDetect.js` and `files.js` each had a field the first
 * guess got wrong.
 */

const now = Date.now();

/** Fields common enough that most endpoints carry some of them. */
const GENERIC = {
  ok: true, items: [], list: [], findings: [], commits: [], runs: [],
  totals: { count: 2 }, health: 72, stats: { files: 10 }, effective: {}, snapshot: {},
};

/** Per-endpoint shapes, keyed by the `api.*` method name. */
export const API_SHAPES = {
  backlog: {
    functions: { counts: { pending: 2 }, top: [
      { id: 1, path: 'src/a.js', name: 'doThing', loc: 120, complexity: 9, weight: 40, status: 'pending' },
      { id: 2, path: 'src/b.js', name: 'other', loc: 80, complexity: 4, weight: 20, status: 'improved' },
    ] },
    features: {
      counts: { pending: 1 },
      pending: [{ id: 1, title: 'Add coupons', area: 'backend', priority: 60, status: 'pending' }],
      all: [{ id: 1, title: 'Add coupons', area: 'backend', priority: 60, status: 'pending', description: 'x' }],
    },
  },
  // Mirrors deploy/cloudDetect.js — `files` is a LIST of paths, not a count.
  cloudReport: {
    detection: {
      clouds: ['gcp'],
      terraform: { present: true, providers: ['google'], resourceCount: 12, resourceTypes: ['google_cloud_run_service'], files: ['main.tf', 'variables.tf'] },
      gcp: { project: 'p', services: [] },
      aws: { services: [] },
    },
    terraformFindings: [{ id: 1, severity: 'high', message: 'drift in run service', resolved: 0 }],
    plans: { gcp: { strategy: 'rolling' } },
  },
  scope: {
    scope: { focus: { ux: 20, backend: 30 }, exclude: [], caps: { tests: 25 }, enforce: true },
    themes: { ux: { label: 'UX' }, backend: { label: 'Backend' } },
    share: { ux: 40, backend: 60 },
  },
  problemRuns: {
    busy: false, counts: { error: 1 },
    runs: [{
      id: 12, status: 'rolled_back', filesChanged: 3, restarts: 0, startedAt: now, tasks: [],
      failure: { kind: 'implementation', code: 'behaviour', title: 'Implementation error', explanation: 'e', remedy: 'r', resumeFrom: 'implement' },
    }],
  },
  // Mirrors services/inventory.js field for field.
  services: {
    services: [{
      name: 'api', language: 'node', state: 'implemented', files: 4, entry: 'src/index.js',
      hasTests: true, hasDockerfile: false, hasDeps: true, dependsOn: [], findings: [], bySeverity: {}, health: 80,
    }],
    totals: { services: 1, implemented: 1, scaffolds: 0, findings: 0, critical: 0, high: 0, medium: 0, noTimeout: 0 },
    health: 80, scannedAt: now,
  },
  runtime: {
    target: 'local', running: true, autoHeal: false, docker: { ok: true },
    logs: [{ ts: now - 2000, line: 'server listening on 3000', level: 'info' }, { ts: now, line: 'ready', level: 'info' }],
    composeFiles: [{ rel: 'docker-compose.yml' }], composeFile: 'docker-compose.yml',
  },
  compliance: { lastRun: { score: 74, at: now }, findings: [{ id: 1, severity: 'high', rule: 'no-eval', file: 'a.js', message: 'avoid eval' }], byLanguage: [{ language: 'javascript', violations: 3, severe: 1 }] },
  bestPractices: { rules: [{ id: 1, language: 'javascript', category: 'security', title: 'No eval', rule: 'Never eval', severity: 'high', rationale: 'injection' }], languages: ['javascript'] },
  summaryCommits: {
    commits: [{ id: 'abc1234', sha: 'abc1234', title: '[ai-iter#3] Improve x', at: now, filesChanged: 2, additions: 40, deletions: 10, improvements: 1, features: 0, score: 84 }],
    totals: { commits: 1, files: 2, additions: 40, deletions: 10, improvements: 1, features: 0, avgScore: 84 },
  },
  filesStatus: { branch: 'main', workBranch: 'agents/auto-improve', workAhead: 2, modified: [{ code: 'M', path: 'src/a.js' }] },
  changelog: { markdown: '# Notes\n- a change' },
  health: { ok: true, ollama: { ok: true, model: 'qwen3.6' }, repo: { root: '/r', branch: 'main', head: 'abc1234', dirty: false }, baseline: { baseBranch: 'main', trackedFiles: 10, aligned: true }, control: {}, isolation: { isolated: false, detail: 'no runtime' } },
  models: { effective: { implement: 'qwen3.6', review: 'qwen3.6' }, installed: ['qwen3.6'] },
  crossProject: { pairs: [], stacks: {} },

  // Mirrors core/decisionNetwork.js `networkSnapshot()`.
  decisions: {
    agents: [{ agent: 'implementer', attempts: 8, landed: 6, failed: 2, landRate: 0.75 }],
    areas: ['backend', 'frontend'],
    cells: [{ agent: 'implementer', area: 'backend', attempts: 5, landed: 4, failed: 1, landRate: 0.8 }],
    strong: [{ agent: 'implementer', area: 'backend', attempts: 5, landed: 4, failed: 1, landRate: 0.8 }],
    weak: [],
  },

  // Mirrors context/contextManager.js `onboardingStatus()` — `documents` is an OBJECT of stats, and
  // the view keeps its own `docs` list, so both have to be right or the page throws on `.map`.
  context: {
    profile: { summary: 'A rental marketplace', stack: ['node'], domains: ['booking'], updatedAt: now },
    questions: [{ id: 1, question: 'What is the deploy target?', answer: null, auto: 0, status: 'open' }],
    documents: { count: 3, indexed: 3, bytes: 1024 },
    codeStats: {
    total: 100,
    byLanguage: [{ name: 'javascript', files: 40, lines: 5000, pct: 100 }],
    files: 40, lines: 5000,
  },
    pending: 1,
    findings: [{ id: 1, severity: 'medium', title: 'No README', detail: 'add one', status: 'open' }],
  },
  // Returns a bare array — see `mockApi`. Mirrors contextDb.rowToDoc(): the identity is `id`, the
  // path is `relPath` and the size the view prints is `chars`. Under {path, bytes, kind} the row
  // keyed itself off an absent `id` and printed `NaNk`.
  contextDocuments: [{ id: 1, relPath: 'README.md', type: 'markdown', title: 'Readme', size: 500, chars: 500, stale: false, error: null, indexedAt: now }],
  contextSituation: { snapshot: { mission: 'improve', peers: [], at: now } },

  // Mirrors iteration/digest.js `buildDigest()`.
  digest: {
    generatedAt: now,
    window: { hours: 24, since: now - 86400000 },
    counts: { total: 5, committed: 3, blocked: 1, empty: 0, interrupted: 1, errored: 0 },
    landRate: 0.6,
    totals: { files: 9, additions: 200, deletions: 80 },
    avgScore: 82,
    highlights: [{ id: 3, title: 'Improve x', score: 84, filesChanged: 2 }],
    health: { score: 72, delta: 1 },
    dependencies: { advisories: 0, outdated: 2, totals: { critical: 0, high: 1, moderate: 2, low: 0, total: 3 } },
    gate: { blocked: 1, reasons: ['behaviour'] },
    headline: 'Three changes landed today.',
  },

  // Mirrors iteration/healthIndex.js `healthReport()`.
  // The Health view calls api.healthIndex() — the full report — not the server-status /api/health
  // the top bar reads. Two different endpoints, two different shapes.
  healthIndex: {
    score: 72,
    components: { structure: 70, complexity: 65, testRatio: 80, sizeSpread: 75 },
    facts: { sourceFiles: 40, testFiles: 15, totalLines: 5000, godFiles: 2, avgComplexity: 12, biggest: [{ file: 'src/a.js', lines: 800 }] },
    trend: [{ ts: now - 86400000, score: 71 }, { ts: now, score: 72 }],
    delta: 1,
  },

  // Mirrors deploy/dora.js `doraMetrics()` — both sides are always present, even when null inside.
  dora: {
    windowDays: 30, deployments: 2, watching: 0, unobserved: 1, caveat: 'Too thin to conclude from.',
    isl: { deployments: 1, commits: 2, deploymentsPerWeek: 0.2, leadTimeMedianHours: 3, observedDeployments: 1, failedDeployments: 0, changeFailureRate: 0, mttrMedianHours: null, unresolvedFailures: 0 },
    human: { deployments: 1, commits: 1, deploymentsPerWeek: 0.2, leadTimeMedianHours: 5, observedDeployments: 1, failedDeployments: 0, changeFailureRate: 0, mttrMedianHours: null, unresolvedFailures: 0 },
    comparison: { changeFailureRateDelta: 0, islIsSafer: true },
    bakeWindowMinutes: 30, autoRevert: false,
    recent: [{ id: 1, ts: now, to: 'abc1234', branch: 'main', commits: 2, islCommits: 1, humanCommits: 1, agents: ['implementer'], bakeStatus: 'clean', bakeUntil: now, breachReason: null, revertedSha: null, resolvedAt: null, evidence: { sources: ['errors'] } }],
  },
  autoPromote: { enabled: false, ahead: 2, promotable: 1, upTo: 'abc1234', upToShort: 'abc1234', blockedBy: null, autonomy: { mode: 'normal', health: 72 }, commits: [{ sha: 'abc1234', shortSha: 'abc1234', title: '[ai-iter#3] Improve x', ok: true, reason: 'approved' }] },
  autonomy: { mode: 'normal', health: 72, guardDrop: 8 },

  coverage: { scanned: 40, totalCritical: 8, coveredCritical: 5, criticalCoverage: 62, gaps: [{ file: 'src/a.js', pct: 30, critical: true, lines: 200 }] },
  measuredCoverage: { overall: 62, files: [{ file: 'src/a.js', pct: 30 }], measuredAt: now, source: 'vitest' },
  impact: { top: [{ file: 'src/a.js', score: 72, reach: 12, untested: true, routes: 2, reasons: ['12 importers', 'no tests'] }], scannedAt: now },
  refactorPlan: { steps: [], recipe: null },
  bisectResult: { running: false, culprit: null, steps: 0, checked: [] },
  regressionCommits: { commits: [{ sha: 'abc1234', title: 'a change', at: now }] },
  reliability: {
    errors24h: 3,
    // Mirrors reliabilityDb.errorClusters() — `agents` is a LIST split from GROUP_CONCAT, and
    // the timestamps are lastTs/firstTs, not lastAt.
    clusters: [{ signature: 'typeerror #', category: 'error', count: 3, lastTs: now, firstTs: now - 3600000, agents: ['implementer'], sample: 'TypeError: x is undefined' }],
    // Mirrors reliabilityDb.errorsByAgent(), which names the column `agent` — NOT `agentId`, the
    // field the unrelated metrics.byAgent uses. Under `agentId` the pill keyed and labelled itself
    // off an absent field.
    byAgent: [{ agent: 'implementer', count: 2, lastTs: now }],
    anomalies: [],
    recentErrors: [{ id: 1, ts: now, source: 'runtime', severity: 'error', message: 'TypeError: x', signature: 'typeerror #' }],
    signals: [{ id: 1, title: 'Retry storms', status: 'open', severity: 'high', applyTo: 'none', detail: 'd', evidence: 'e' }],
  },
  regression: { status: 'clean', findings: [], lastRun: now },
  structural: { candidates: [{ file: 'src/big.js', lines: 800, complexity: 40, recipe: 'split-god-file', why: 'god file' }], scannedAt: now },
  // The iteration detail: `status` is read with `.replace`, so it must be a string, and `phases`
  // and `tasks` are mapped.
  iteration: {
    id: 3, status: 'committed', trigger: 'loop', startedAt: now, finishedAt: now,
    filesChanged: 2, additions: 40, deletions: 10, commitSha: 'abc1234', branch: 'agents/auto-improve',
    scores: { review: 88, security: 90, regression: 80, test: 85, workbench: 78, total: 84 },
    plan: { title: 'Improve x', theme: 'reliability', tasks: [] },
    phases: [{ id: 1, phase: 'implement', status: 'ok', score: 90, summary: 'done', startedAt: now, finishedAt: now }],
    tasks: [{ id: 1, kind: 'improvement', title: 'Tighten x', status: 'done', agent: 'implementer', filesChanged: ['src/a.js'], summary: 's' }],
    failure: null, resumable: false, restarts: 0, isolation: null,
  },
  flaky: { suites: [], events: [] },
  memory: { rows: [{ id: 1, scope: 'global', kind: 'lesson', title: 'A lesson', content: 'body', source: 'engine', at: now, pinned: 0 }], scopes: ['global'] },
};

/**
 * A mocked `api` module: every method resolves to its shape, or a generic one.
 *
 * An ARRAY shape is returned as-is. Spreading the generic object over one would quietly turn a list
 * into an object, and the view's `.map` would fail on a fixture that looked perfectly reasonable.
 */
export const mockApi = () => new Proxy({}, {
  get: (_t, name) => {
    const shape = API_SHAPES[name];
    return vi.fn().mockResolvedValue(Array.isArray(shape) ? shape : { ...GENERIC, ...(shape || {}) });
  },
});

/** An `api` where everything fails — for asserting the operator is told, not shown a blank page. */
export const failingApi = (message = 'backend unreachable') => new Proxy({}, {
  get: () => vi.fn().mockRejectedValue(new Error(message)),
});

/**
 * Props for the views that receive their data from the store rather than fetching it. Populated,
 * not empty: a view handed nothing renders nothing, and auditing nothing proves nothing.
 */
export const VIEW_PROPS = {
  toast: vi.fn(),
  user: { id: 1, email: 'op@example.com', role: 'admin' },
  actions: new Proxy({}, { get: () => vi.fn() }),
  onNavigate: vi.fn(),
  onOpenProposal: vi.fn(),
  onOpen: vi.fn(),
  onSwitch: vi.fn(),
  onConfigSaved: vi.fn(),
  openInEditor: vi.fn(),
  toggleTheme: vi.fn(),
  theme: 'dark',
  selectedId: null,
  activeId: 'default',
  // `byLanguage` is a LIST where the views filter it — not the keyed object the context response
  // uses. Same field name, two shapes, and only one of them has `.filter`.
  //
  // Mirrors codeScan.scanCodebase(): each entry is keyed by `key` (the language id, e.g. the value
  // compliance findings join on) and LABELLED by `lang`. A fixture carrying `name` instead left both
  // undefined, so the views rendered blank pills under `key={undefined}` — an unkeyed-list warning,
  // and an a11y audit reading empty elements.
  codeStats: {
    totalFiles: 40, totalLines: 5000, languages: 1,
    byLanguage: [{ key: 'javascript', lang: 'JavaScript', accent: 'amber', family: 'script', files: 40, lines: 5000, pct: 100, pctAll: 100 }],
  },

  agents: [{
    id: 'implementer', name: 'Implementer', status: 'idle', role: 'implementer', enabled: 1, runs: 3,
    emoji: '🛠', description: 'writes the change', model: 'qwen3.6',
    scope: { include: ['src/**'], exclude: [] },
  }],
  // `byAgent` is read without a guard by Telemetry, so an absent array crashes the page rather than
  // rendering an empty chart. Mirrored here for the same reason every other shape is.
  metrics: {
    generatedAt: now,
    // `runs` is an object here, not a list — the generic fixture's `runs: []` used to shadow it and
    // every field read off it rendered as "undefined" on screen.
    runs: { total: 5, errors: 1, avgDurationMs: 4200, tokensIn: 100, tokensOut: 50, llmCalls: 8 },
    timeline: [{ t: now - 3600000, proposals: 1, runs: 2 }],
    byAgent: [{ agentId: 'implementer', applied: 3, rejected: 1, runs: 4, proposals: 4, tokensIn: 100, tokensOut: 50 }],
    byDay: [{ day: '2026-07-30', runs: 2, proposals: 1 }],
    totals: { proposals: 4, applied: 3, pendingReview: 1, rejected: 1 },
    byStatus: { pending: 0, applied: 3, rejected: 1 },
    verification: { passed: 3, failed: 1, skipped: 0 },
    proposalsByStatus: { pending: 0, applied: 3, rejected: 1, verified: 3, failed: 1 },
  },
  proposals: [{ id: 1, title: 'Improve x', agentId: 'implementer', status: 'pending', createdAt: now, risk: 'low' }],
  managers: { briefs: [{ name: 'Quality', summary: 'all good', severity: 'info', at: now }], messages: [] },
  events: [{ id: 1, type: 'iteration.started', ts: now, iterationId: 3 }],
  logs: [{ id: 1, ts: now, level: 'info', source: 'engine', message: 'started' }],
  runs: [{ id: 1, agentId: 'implementer', status: 'done', startedAt: now, finishedAt: now, steps: 2 }],
  thoughts: [],
  plans: {
    list: [{
      id: 1, title: 'Plan', criticality: 'medium', createdAt: now, agentId: 'implementer',
      steps: ['a'], rationale: 'r', status: 'open', pros: ['clear win'], cons: ['some risk'],
      files: ['src/a.js'], risks: 'none material', approach: 'incremental',
    }],
    byCriticality: { medium: 1 },
  },
  notifications: { list: [{ id: 1, ts: now, kind: 'iteration', severity: 'info', title: 'Done', read: 0 }], unread: 1 },
  deploy: { workBranch: 'agents/auto-improve', workSha: 'abc1234', mainSha: 'def5678', ahead: 2, canPromote: true, commits: ['abc1234 [ai-iter#3] Improve x'], blockedReason: null },
  repo: { branch: 'main', head: 'abc1234', dirty: false },
  orchestrator: {
    looping: true, running: true, current: { agentId: 'implementer', runId: 1 }, intervalSeconds: 120,
    fleet: { pending: 0, maxPending: 10, queued: [], current: { agentId: 'implementer' } },
    parallel: { maxTasks: 2, llmInFlight: 1, llmQueued: 0 }, batch: { improvements: 2, features: 1 },
    restartable: [], workBranch: 'agents/auto-improve', todayCount: 1, maxPerDay: 100, headCommit: 'abc1234',
  },
  control: { looping: false, running: false, current: null, intervalSeconds: 120, parallel: { maxTasks: 2 }, batch: {}, restartable: [] },
  iteration: {
    controller: { looping: false, running: false, restartable: [] },
    recent: [{ id: 3, status: 'committed', trigger: 'loop', startedAt: now, finishedAt: now, filesChanged: 2, scores: { total: 84 } }],
    restartable: [],
    backlog: { functions: { pending: 2 }, features: { pending: 1 } },
    kpi: { improvements_per_iter: 2, features_per_iter: 1, rollback_threshold: 60 },
  },
};
