const json = async (res) => {
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(body.error || `HTTP ${res.status}`);
    err.status = res.status;
    throw err;
  }
  return body;
};

const get = (url) => fetch(url).then(json);
const send = (method) => (url, body) =>
  fetch(url, {
    method,
    headers: { 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  }).then(json);

const post = send('POST');
const put = send('PUT');
const patch = send('PATCH');
const del = send('DELETE');

export const api = {
  state: () => get('/api/state'),
  health: () => get('/api/health'),
  metrics: () => get('/api/metrics'),
  managers: () => get('/api/managers'),
  logs: (q = {}) => get('/api/logs?' + new URLSearchParams(q)),

  updateAgent: (id, body) => patch(`/api/agents/${id}`, body),
  runAgent: (id, instruction) => post(`/api/agents/${id}/run`, { instruction }),

  // The single control plane — one loop, one switch.
  control: () => get('/api/control'),
  controlStart: () => post('/api/control/start'),
  controlStop: () => post('/api/control/stop'),
  controlCancel: () => post('/api/control/cancel'),
  controlRestartLoop: () => post('/api/control/restart-loop'),
  // Arresto completo: ferma il loop, chiude il server e impedisce al supervisore di riavviarlo.
  controlShutdown: () => post('/api/control/shutdown'),
  // Albero di lavoro: GET classifica senza toccare, POST agisce solo sui percorsi scelti.
  treeAnalyse: () => get('/api/tree/clean'),
  treeClean: (paths) => post('/api/tree/clean', { paths }),
  controlRun: () => post('/api/control/run'),
  controlRestart: (id) => post(`/api/control/restart/${id}`),
  controlConfig: (body) => post('/api/control/config', body),
  restartable: () => get('/api/control/restartable'),

  // Failed-runs board: error / interrupted / empty / rolled_back runs to triage.
  problemRuns: (status) => get('/api/runs/problems' + (status ? '?' + new URLSearchParams({ status }) : '')),
  restartAllRuns: (ids) => post('/api/runs/restart-all', ids ? { ids } : {}),
  dismissRun: (id) => post(`/api/runs/${id}/dismiss`),
  dismissAllRuns: () => post('/api/runs/dismiss-all'),

  services: () => get('/api/services'),
  surveyBacklog: () => post('/api/backlog/survey'),
  resetBacklog: (body) => post('/api/backlog/reset', body),
  backlogClaims: () => get('/api/backlog/claims'),
  reclaimBacklog: (body) => post('/api/backlog/reclaim', body || {}),

  settings: (body) => post('/api/orchestrator/settings', body),

  proposal: (id) => get(`/api/proposals/${id}`),
  approve: (id, note) => post(`/api/proposals/${id}/approve`, { note }),
  reject: (id, reason) => post(`/api/proposals/${id}/reject`, { reason }),
  reverify: (id) => post(`/api/proposals/${id}/reverify`),

  messages: () => get('/api/chat/messages'),
  clearMessages: () => del('/api/chat/messages'),

  // iteration engine
  // The path stays a literal and the query is built beside it: an endpoint hidden inside a
  // template interpolation cannot be checked against the server's routes.
  events: (limit) => get('/api/events' + (limit ? `?${new URLSearchParams({ limit })}` : '')),
  iterations: (limit) => get('/api/iterations' + (limit ? `?${new URLSearchParams({ limit })}` : '')),
  iteration: (id) => get(`/api/iterations/${id}`),
  runIteration: () => post('/api/iterations/run'),
  iterStart: () => post('/api/iteration/loop/start'),
  iterStop: () => post('/api/iteration/loop/stop'),
  iterCancel: () => post('/api/iteration/loop/cancel'),
  iterSettings: (body) => post('/api/iteration/loop/settings', body),
  backlog: () => get('/api/backlog'),
  kpi: () => get('/api/kpi'),
  setKpi: (body) => post('/api/kpi', body),
  // Per-user preferences: scoped to the session server-side, never by a user id in the request.
  preferences: () => get('/api/preferences'),
  savePreferences: (body) => put('/api/preferences', body),
  notifications: () => get('/api/notifications'),
  readNotifications: () => post('/api/notifications/read'),
  deploy: () => get('/api/deploy'),
  promote: (upTo, opts = {}) => post('/api/deploy/promote', { ...(upTo ? { upTo } : {}), ...opts }),
  plans: () => get('/api/plans'),
  filesTree: (p = '', ref = 'main') => get('/api/files/tree?' + new URLSearchParams({ path: p, ref })),
  fileRead: (p, ref = 'main') => get('/api/files/read?' + new URLSearchParams({ path: p, ref })),
  fileWrite: (p, content) => post('/api/files/write', { path: p, content }),
  filesStatus: () => get('/api/files/status'),
  fileDiff: (p) => get('/api/files/diff?' + new URLSearchParams({ path: p })),
  runtime: () => get('/api/runtime'),
  runtimeTarget: (target) => post('/api/runtime/target', { target }),
  runtimeUp: () => post('/api/runtime/up'),
  runtimeDown: () => post('/api/runtime/down'),
  runtimeRestart: () => post('/api/runtime/restart'),
  runtimeHeal: () => post('/api/runtime/heal'),
  runtimeAutoHeal: (on) => post('/api/runtime/autoheal', { on }),
  // Per-container controls. The server refuses any compose flag that would delete a volume, so
  // none of these can reach the database.
  runtimeService: (name, action) => post(`/api/runtime/service/${encodeURIComponent(name)}/${action}`),
  runtimeServiceLogs: (name, lines = 200) => get(`/api/runtime/service/${encodeURIComponent(name)}/logs?lines=${lines}`),
  runtimeSchema: () => get('/api/runtime/schema'),
  runtimeSchemaIntegrity: () => get('/api/runtime/schema/integrity'),
  runtimeComposeFiles: () => get('/api/runtime/compose-files'),
  runtimeSetCompose: (file) => post('/api/runtime/compose', { file }),
  runtimeBrowse: (dir = '') => get('/api/runtime/browse?' + new URLSearchParams({ dir })),
  addFeature: (body) => post('/api/backlog/features', body),
  updateFeature: (id, body) => patch(`/api/backlog/features/${id}`, body),
  deleteFeature: (id) => del(`/api/backlog/features/${id}`),
  report: () => get('/api/report'),

  /* ------------------------------- auth -------------------------------- */
  login: (email, password) => post('/api/auth/login', { email, password }),
  logout: () => post('/api/auth/logout'),
  me: () => get('/api/auth/me'),
  changePassword: (currentPassword, newPassword) => post('/api/auth/password', { currentPassword, newPassword }),

  /* ----------------------------- projects ------------------------------ */
  projects: () => get('/api/projects'),
  activeProject: () => get('/api/projects/active'),
  switchProject: (id) => post('/api/projects/active', { id }),
  createProject: (body) => post('/api/projects', body),
  updateProject: (id, body) => patch(`/api/projects/${id}`, body),
  archiveProject: (id) => post(`/api/projects/${id}/archive`),
  changeSource: (id, codePath) => post(`/api/projects/${id}/source`, { codePath }),
  validatePath: (path) => post('/api/projects/validate-path', { path }),

  /* ------------------------------ admin -------------------------------- */
  adminOverview: () => get('/api/admin/overview'),
  users: () => get('/api/admin/users'),
  createUser: (body) => post('/api/admin/users', body),
  updateUser: (id, body) => patch(`/api/admin/users/${id}`, body),
  deleteUser: (id) => del(`/api/admin/users/${id}`),
  audit: (limit = 200) => get('/api/admin/audit?' + new URLSearchParams({ limit })),
  adminSessions: () => get('/api/admin/sessions'),
  revokeUserSessions: (id) => post(`/api/admin/users/${id}/revoke-sessions`),
  adminSystem: () => get('/api/admin/system'),

  // Database explorer (admin, read-only)
  databases: () => get('/api/admin/databases'),
  dbTables: (db) => get('/api/admin/db/tables?' + new URLSearchParams({ db })),
  dbRows: (db, table, limit = 50, offset = 0) => get('/api/admin/db/rows?' + new URLSearchParams({ db, table, limit, offset })),
  dbQuery: (db, sql) => post('/api/admin/db/query', { db, sql }),

  // Dashboard control (menus / default view)
  dashboardConfig: () => get('/api/dashboard-config'),
  adminDashboardConfig: () => get('/api/admin/dashboard-config'),
  saveDashboardConfig: (cfg) => put('/api/admin/dashboard-config', cfg),

  /* ----------------------------- context ------------------------------- */
  context: () => get('/api/context'),
  contextBuild: (force = false) => post('/api/context/build', { force }),
  contextIngest: () => post('/api/context/ingest'),
  contextVerify: () => post('/api/context/verify'),
  answerQuestion: (id, answer) => post(`/api/context/questions/${id}`, { answer }),
  contextDocuments: () => get('/api/context/documents'),
  contextDocument: (id) => get(`/api/context/documents/${id}`),
  contextFindings: () => get('/api/context/findings'),
  resolveFinding: (id) => post(`/api/context/findings/${id}/resolve`),
  contextSituation: () => get('/api/context/situation'),
  decisions: () => get('/api/decisions'),
  healthIndex: () => get('/api/health-index'),
  healthSnapshot: () => post('/api/health-index/snapshot', {}),
  // Models & LLM
  models: () => get('/api/models'),
  detectModels: () => post('/api/models/detect', {}),
  setModelConfig: (body) => post('/api/models/config', body),
  resetModelConfig: () => post('/api/models/reset', {}),
  testModel: (model, embedding = false) => post('/api/models/test', { model, embedding }),
  // Obtaining a model, and handing it to the agents once it has proved it answers.
  modelPulls: () => get('/api/models/pulls'),
  pullModel: (model, opts = {}) => post('/api/models/pull', { model, ...opts }),
  cancelPull: (model) => post('/api/models/pull/cancel', { model }),
  adoptModel: (model, opts = {}) => post('/api/models/adopt', { model, ...opts }),

  // Repair: diagnose the app as it stands, and produce a change that would fix it.
  repairState: () => get('/api/repair'),
  repairDiagnose: () => post('/api/repair/diagnose', {}),
  repairRun: (commit) => post('/api/repair/run', commit ? { commit } : {}),
  // Try to make a commit that is blocking a promotion promotable.
  autofixCommit: (sha) => post('/api/deploy/autofix', { sha }),
  // The authoritative check: does the code actually work at the commit being promoted TO?
  verifyCommit: (sha) => post('/api/deploy/verify', { sha }),
  // The promote agent: work out what can land without the broken commits (planning touches nothing),
  // then apply exactly what was approved.
  planPromotion: (exclude = []) => post('/api/deploy/plan', { exclude }),
  applyPromotionPlan: (shas, opts = {}) => post('/api/deploy/apply-plan', { shas, ...opts }),
  structural: () => get('/api/structural'),
  seedStructural: (max = 5) => post('/api/structural/seed', { max }),
  dependencies: () => get('/api/dependencies'),
  scanDependencies: () => post('/api/dependencies/scan', {}),
  remediation: () => get('/api/dependencies/remediate'),
  startRemediation: (projectDir) => post('/api/dependencies/remediate', projectDir ? { projectDir } : {}),
  blastRadius: (file) => get('/api/blast-radius?' + new URLSearchParams({ file })),
  refactorPlan: (file) => get('/api/refactor/plan?' + new URLSearchParams({ file })),
  coverage: () => get('/api/coverage'),
  seedCoverage: (max = 5) => post('/api/coverage/seed', { max }),
  // Real per-line coverage: `measureCoverage` only STARTS the run (it is a full test suite);
  // `measuredCoverage` is polled for its state and its result.
  measuredCoverage: () => get('/api/coverage/measured'),
  measureCoverage: () => post('/api/coverage/measure', {}),
  impact: () => get('/api/impact'),
  backlogDuplicates: () => get('/api/backlog/duplicates'),
  dedupBacklog: () => post('/api/backlog/dedup', {}),
  frontendAudit: () => get('/api/frontend-audit'),
  seedFrontendAudit: (max = 5) => post('/api/frontend-audit/seed', { max }),
  knowledge: (q) => get('/api/knowledge?' + new URLSearchParams({ q })),
  buildEmbeddings: () => post('/api/knowledge/embed', {}),
  schedule: () => get('/api/schedule'),
  setSchedule: (body) => post('/api/schedule', body),
  runScheduleNow: () => post('/api/schedule/run-now', {}),
  crossProject: () => get('/api/cross-project'),
  applyCrossProject: (from, to, max = 10) => post('/api/cross-project/apply', { from, to, max }),
  flaky: () => get('/api/flaky'),
  setFlakyRetries: (retries) => post('/api/flaky/retries', { retries }),
  scanFlaky: (body = {}) => post('/api/flaky/scan', body),
  regressionCommits: () => get('/api/regression/commits'),
  bisectResult: () => get('/api/regression/bisect'),
  startBisect: (body = {}) => post('/api/regression/bisect', body),
  revertCommit: (sha) => post('/api/regression/revert', { sha }),
  digest: (hours = 24) => get('/api/digest?' + new URLSearchParams({ hours })),
  changelog: () => get('/api/changelog'),
  reviewQueue: (status = '') => get('/api/review-queue' + (status ? '?' + new URLSearchParams({ status }) : '')),
  decideReview: (id, verdict) => post(`/api/review-queue/${id}/decide`, { verdict }),
  autoPromote: () => get('/api/auto-promote'),
  setAutoPromote: (enabled) => post('/api/auto-promote/enabled', { enabled }),
  runAutoPromote: () => post('/api/auto-promote/run', { force: true }),
  dora: (days = 30) => get(`/api/dora?days=${days}`),
  doraCheck: () => post('/api/dora/check', {}),
  setDoraBakeWindow: (minutes) => post('/api/dora/bake-window', { minutes }),
  setDoraAutoRevert: (enabled) => post('/api/dora/auto-revert', { enabled }),
  resolveDoraBreach: (id) => post(`/api/dora/${id}/resolve`, {}),
  changeBudget: () => get('/api/change-budget'),
  setChangeBudget: (body) => post('/api/change-budget', body),
  // Governance (enterprise controls)
  // Cost governance. The hard cap here is what stops iterations starting, so the screen that
  // shows it is the one an operator reaches from the "iterations stopped" notification.
  costGovernance: () => get('/api/governance/cost'),
  setCostBudget: (body) => post('/api/governance/cost/budget', body),
  setCostRates: (body) => post('/api/governance/cost/rates', body),
  qualityGates: () => get('/api/governance/gates'),
  setQualityGates: (body) => post('/api/governance/gates', body),
  protectedPaths: () => get('/api/governance/protected'),
  setProtectedPaths: (paths) => post('/api/governance/protected', { paths }),
  repoSecrets: () => get('/api/governance/secrets'),
  scanRepoSecrets: () => post('/api/governance/secrets/scan', {}),
  licences: () => get('/api/governance/licences'),
  scanLicences: () => post('/api/governance/licences/scan', {}),
  // Data egress: which models ISL may talk to, and the tamper-evident record of what it sent.
  governanceCost: () => get('/api/governance/cost'),
  egress: () => get('/api/governance/egress'),
  setEgress: (body) => post('/api/governance/egress', body),
  egressLedger: (limit = 100) => get(`/api/governance/egress/ledger?limit=${limit}`),
  egressPreview: (text) => post('/api/governance/egress/preview', { text }),
  sealEgress: (note) => post('/api/governance/egress/seal', { note }),
  // Audit trail + compliance evidence packs.
  auditTrail: (limit = 100) => get(`/api/governance/audit?limit=${limit}`),
  evidenceList: () => get('/api/governance/evidence'),
  evidencePack: (id) => get(`/api/governance/evidence/${id}`),
  evidenceHtmlUrl: (id) => `/api/governance/evidence/${id}?format=html`,
  webhooks: () => get('/api/governance/webhooks'),
  addWebhook: (body) => post('/api/governance/webhooks', body),
  deleteWebhook: (id) => del(`/api/governance/webhooks/${id}`),
  toolchain: () => get('/api/toolchain'),
  scope: () => get('/api/scope'),
  setScope: (body) => post('/api/scope', body),
  resetScope: () => post('/api/scope/reset', {}),
  goal: () => get('/api/goal'),
  setGoal: (text, area = '') => post('/api/goal', { text, area }),

  /* --------------------------- cloud / deploy -------------------------- */
  cloudReport: () => get('/api/deploy/cloud'),
  defineStrategy: (cloud) => post('/api/deploy/strategy', { cloud }),
  terraformCheck: () => post('/api/deploy/terraform-check'),
  resolveTerraform: (id) => post(`/api/deploy/terraform-findings/${id}/resolve`),

  /* ------------------------------ summary ------------------------------ */
  summaryCommits: () => get('/api/summary/commits'),
  commitDetail: (id) => get(`/api/summary/commits/${id}`),
  describeCommits: (ids) => post('/api/summary/describe', { ids }),

  /* -------------------------- best practices --------------------------- */
  bestPractices: (q = {}) => get('/api/bestpractices?' + new URLSearchParams(q)),
  addPractice: (body) => post('/api/bestpractices', body),
  deletePractice: (id) => del(`/api/bestpractices/${id}`),

  /* ---------------------------- compliance ----------------------------- */
  compliance: () => get('/api/compliance'),
  complianceCheck: (languages) => post('/api/compliance/check', languages ? { languages } : {}),
  resolveCompliance: (id) => post(`/api/compliance/findings/${id}/resolve`),

  /* --------------------------- shared memory --------------------------- */
  memory: (scope) => get('/api/memory' + (scope ? '?' + new URLSearchParams({ scope }) : '')),
  addMemory: (body) => post('/api/memory', body),
  pinMemory: (id, pinned) => post(`/api/memory/${id}/pin`, { pinned }),
  deleteMemory: (id) => del(`/api/memory/${id}`),

  /* ----------------------------- research ------------------------------ */
  research: () => post('/api/research'),

  /* ------------------------- export data sets -------------------------- */
  agentsList: () => get('/api/agents'),
  proposalsAll: () => get('/api/proposals?limit=200'),

  /* --------------------------- reliability ----------------------------- */
  reliability: () => get('/api/reliability'),
  reliabilityDistill: () => post('/api/reliability/distill'),
  reliabilitySignal: (id, action) => post(`/api/reliability/signals/${id}/${action}`),
};

/**
 * Streams one chat turn. Yields `{type:'token'|'tool'|'done'|'error', ...}`.
 * The server speaks NDJSON so partial lines must be buffered across chunks.
 */
export async function* chatStream(message, signal, images = []) {
  const res = await fetch('/api/chat', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ message, images }),
    signal,
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let nl;
    while ((nl = buf.indexOf('\n')) !== -1) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (line) yield JSON.parse(line);
    }
  }
}

/** Auto-reconnecting event socket. Returns an unsubscribe function. */
export function connectEvents(onEvent, onStatus) {
  let ws;
  let closed = false;
  let retry = 500;

  const open = () => {
    if (closed) return;
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    ws = new WebSocket(`${proto}://${location.host}/ws`);

    ws.onopen = () => {
      retry = 500;
      onStatus?.('online');
    };
    ws.onmessage = (e) => onEvent(JSON.parse(e.data));
    ws.onclose = () => {
      onStatus?.('offline');
      if (closed) return;
      setTimeout(open, retry);
      retry = Math.min(retry * 2, 8000); // back off, but stay responsive
    };
    ws.onerror = () => ws.close();
  };

  open();
  return () => {
    closed = true;
    ws?.close();
  };
}
