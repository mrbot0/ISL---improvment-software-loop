import {
  getQualityGates, setQualityGates,
  getProtectedPaths, setProtectedPaths, protectedViolations,
  scanRepoSecrets, licenceInventory,
  listWebhooks, addWebhook, deleteWebhook, WEBHOOK_EVENTS,
} from '../../core/governance.js';
import { egressPolicy, setEgressPolicy, EGRESS_MODES, redactText, classifyHost } from '../../core/egress.js';
import { listEgress, egressSummary, verifyEgressChain, sealEgressSegment, listEgressCheckpoints,
  listAudit, verifyAuditChain, sealAuditSegment, audit } from '../platformDb.js';
import { evidenceable, buildEvidencePack, renderEvidenceHtml, verifyEvidencePack } from '../../core/evidencePack.js';
import { ROLES, ROLE_CAPS, roleFor, can, grantRole, revokeRole, listProjectRoles } from '../rbac.js';
import { getPolicy, setPolicy, validatePolicy, simulate, OUTCOMES, CONDITIONS } from '../../core/policy.js';
import { budgetState, setBudget, getRates, setRates, usageBreakdown, efficiency } from '../../core/costMeter.js';
import { buildGoldenSet, getGoldenSet, scoreConfig, compareConfigs } from '../../core/evalHarness.js';
import { getChangeBudget } from '../../iteration/changeBudget.js';
import { healthReport } from '../../iteration/healthIndex.js';
import { listReviewQueue } from '../../core/reviewQueue.js';
import { ACTIVE_PROJECT_ID } from '../../config.js';

/** A denominator that fails must not take the whole cost report with it. */
const safeCount = (fn) => { try { return fn() || 0; } catch { return 0; } };
import { ollama, llm } from '../../config.js';
import { providerActive } from '../../openaiProvider.js';

/**
 * GOVERNANCE ROUTES — the enterprise controls: quality gates, protected paths, a repo-wide secret
 * scan, the dependency licence inventory, and outbound webhooks.
 *
 * The two scans are slow-ish (they read the working tree / node_modules), so their results are
 * cached in-process and refreshed on demand rather than recomputed per request.
 */
let secretCache = null;
let licenceCache = null;

export function mountGovernanceRoutes(app, { wrap }) {
  // Quality gates — the organisation's bar for a change, independent of any model's opinion.
  app.get('/api/governance/gates', wrap((_req, res) => res.json(getQualityGates())));
  app.post('/api/governance/gates', wrap((req, res) => res.json(setQualityGates(req.body || {}))));

  // Protected paths — globs the fleet may never touch autonomously.
  app.get('/api/governance/protected', wrap((_req, res) => res.json({ paths: getProtectedPaths() })));
  app.post('/api/governance/protected', wrap((req, res) => res.json({ paths: setProtectedPaths(req.body?.paths) })));
  app.post('/api/governance/protected/check', wrap((req, res) => {
    res.json({ violations: protectedViolations(Array.isArray(req.body?.files) ? req.body.files : []) });
  }));

  // Repo-wide secret scan — credentials committed BEFORE ISL arrived, not just in the current diff.
  app.get('/api/governance/secrets', wrap((_req, res) => res.json(secretCache || { total: null, hint: 'not scanned yet' })));
  app.post('/api/governance/secrets/scan', wrap((_req, res) => {
    secretCache = scanRepoSecrets();
    res.json(secretCache);
  }));

  // Licence inventory — every dependency licence, flagged by policy for legal review.
  app.get('/api/governance/licences', wrap((_req, res) => res.json(licenceCache || { flaggedCount: null, hint: 'not scanned yet' })));
  app.post('/api/governance/licences/scan', wrap((_req, res) => {
    licenceCache = licenceInventory();
    res.json(licenceCache);
  }));

  // Webhooks — let ISL notify the existing ops stack instead of demanding a watched dashboard.
  app.get('/api/governance/webhooks', wrap((_req, res) => res.json({ hooks: listWebhooks(), events: WEBHOOK_EVENTS })));
  app.post('/api/governance/webhooks', wrap((req, res) => res.json(addWebhook(req.body || {}))));
  app.delete('/api/governance/webhooks/:id', wrap((req, res) => res.json({ removed: deleteWebhook(req.params.id) })));

  /* ------------------------------ egress firewall ------------------------------ */

  // The data boundary: which models ISL may talk to, and the immutable record of what it sent.
  app.get('/api/governance/egress', wrap((_req, res) => {
    const policy = egressPolicy();
    const active = providerActive();
    const current = classifyHost(active ? llm.baseUrl : ollama.host);
    res.json({
      policy,
      modes: EGRESS_MODES,
      // What the CURRENT configuration would do — an operator should not have to simulate a call
      // to discover that their provider is about to be refused.
      current: {
        provider: active ? 'openai-compatible' : 'ollama',
        host: current.host,
        destination: current.destination,
        wouldBeAllowed:
          current.destination === 'local' ||
          policy.mode === 'any' ||
          (policy.mode === 'approved-vendors' && policy.approvedHosts.includes(current.host)),
      },
      summary: egressSummary(),
      chain: verifyEgressChain(),
    });
  }));

  app.post('/api/governance/egress', wrap((req, res) => {
    const actor = req.user?.email || req.user?.id || 'system';
    res.json(setEgressPolicy(req.body || {}, actor));
  }));

  app.get('/api/governance/egress/ledger', wrap((req, res) => {
    res.json({
      entries: listEgress({
        limit: Math.min(500, Math.max(1, Number(req.query?.limit) || 100)),
        decision: req.query?.decision || null,
        destination: req.query?.destination || null,
      }),
      chain: verifyEgressChain(),
      checkpoints: listEgressCheckpoints(10),
    });
  }));

  // Retention: seal the chain up to a point and archive it. The alternative — a ledger that can
  // never be truncated — is not operable, and deleting rows outright would break verification
  // permanently. Sealing keeps continuity provable across the gap.
  app.post('/api/governance/egress/seal', wrap((req, res) => {
    const actor = req.user?.email || req.user?.id || 'system';
    res.json(sealEgressSegment({ upToId: Number(req.body?.upToId) || null, actor, note: req.body?.note || null }));
  }));

  // Redaction preview — paste a prompt, see exactly what would leave. The only honest way for an
  // operator to trust a redactor is to watch it work on their own text.
  app.post('/api/governance/egress/preview', wrap((req, res) => {
    const { text = '' } = req.body || {};
    const r = redactText(String(text).slice(0, 100_000));
    res.json({ redacted: r.text, redactions: r.count });
  }));

  /* ------------------------- audit trail & evidence packs ------------------------ */

  // The platform audit trail, with the state of its hash chain. Rows written before chaining was
  // introduced are reported separately rather than counted as verified.
  app.get('/api/governance/audit', wrap((req, res) => {
    res.json({
      entries: listAudit(Math.min(500, Math.max(1, Number(req.query?.limit) || 100))),
      chain: verifyAuditChain(),
    });
  }));

  app.post('/api/governance/audit/seal', wrap((req, res) => {
    const actor = req.user?.email || req.user?.id || 'system';
    res.json(sealAuditSegment({ upToId: Number(req.body?.upToId) || null, actor, note: req.body?.note || null }));
  }));

  // Which landed changes can be evidenced.
  app.get('/api/governance/evidence', wrap((_req, res) => res.json({ changes: evidenceable({ limit: 50 }) })));

  /**
   * One change's evidence pack. `?format=html` returns the self-contained document an auditor can
   * read without ISL; the default JSON is what a recipient re-hashes to verify.
   *
   * Generating a pack is itself audited: producing compliance evidence is an act a reviewer may
   * legitimately want to see recorded.
   */
  app.get('/api/governance/evidence/:id', wrap((req, res) => {
    const pack = buildEvidencePack(req.params.id);
    if (!pack) return res.status(404).json({ error: 'no such iteration' });
    audit('evidence.generated', {
      actor: req.user?.email || req.user?.id || 'system',
      target: String(pack.subject.iterationId),
      detail: { digest: pack.digest, commit: pack.subject.commitSha },
    });
    if (req.query?.format === 'html') {
      res.setHeader('content-type', 'text/html; charset=utf-8');
      res.setHeader('content-disposition', `attachment; filename="evidence-iteration-${pack.subject.iterationId}.html"`);
      return res.send(renderEvidenceHtml(pack));
    }
    res.json(pack);
  }));

  // Verify a pack someone was handed — recomputes its digest from its own contents.
  app.post('/api/governance/evidence/verify', wrap((req, res) => res.json(verifyEvidencePack(req.body?.pack || req.body))));

  /* ------------------------------ self-evaluation harness ---------------------------- */

  app.get('/api/governance/eval', wrap((_req, res) => {
    const set = getGoldenSet();
    res.json({
      set: set ? { version: set.version, frozenAt: set.frozenAt, counts: set.counts } : null,
      baseline: set ? scoreConfig(getChangeBudget()) : null,
    });
  }));

  // Freeze a new golden set from current history. Explicit rather than automatic: a set that moved
  // under you would make two scorecards incomparable, which defeats the purpose.
  app.post('/api/governance/eval/freeze', wrap((req, res) => {
    if (!can(ACTIVE_PROJECT_ID, req.user, 'governance.write')) {
      return res.status(403).json({ error: 'your role in this project cannot freeze an evaluation set' });
    }
    res.json(buildGoldenSet({ limit: Math.min(500, Number(req.body?.limit) || 200) }));
  }));

  /**
   * Score a candidate configuration against the current one. The headline is whether it LOOSENS any
   * verdict — the direction in which a config change can hurt, and the only one that needs no
   * ground-truth labels to detect.
   */
  app.post('/api/governance/eval/compare', wrap((req, res) => {
    const baseline = req.body?.baseline || getChangeBudget();
    const candidate = req.body?.candidate || {};
    res.json(compareConfigs(baseline, candidate));
  }));

  /* ---------------------------- cost & capacity governance --------------------------- */

  // What ISL has consumed this period, whether a budget threshold is breached, and the forecast.
  app.get('/api/governance/cost', wrap((_req, res) => {
    const state = budgetState();
    // The two numbers a sponsor asks for, against real denominators from this project.
    const landed = safeCount(() => listReviewQueue({ limit: 500 }).filter((i) => i.status === 'approved' || i.status === 'auto').length);
    const health = safeCount(() => healthReport()?.delta ?? 0);
    res.json({
      state,
      rates: getRates(),
      breakdown: {
        byPurpose: usageBreakdown({ groupBy: 'purpose' }),
        byModel: usageBreakdown({ groupBy: 'model' }),
      },
      efficiency: efficiency({ landedChanges: landed, healthDelta: health }),
    });
  }));

  app.post('/api/governance/cost/budget', wrap((req, res) => {
    const actor = req.user?.email || req.user?.id || 'system';
    if (!can(ACTIVE_PROJECT_ID, req.user, 'governance.write')) {
      return res.status(403).json({ error: 'your role in this project cannot change the budget' });
    }
    try { res.json(setBudget(req.body || {}, actor)); }
    catch (err) { res.status(400).json({ error: err.message }); }
  }));

  app.post('/api/governance/cost/rates', wrap((req, res) => {
    const actor = req.user?.email || req.user?.id || 'system';
    if (!can(ACTIVE_PROJECT_ID, req.user, 'governance.write')) {
      return res.status(403).json({ error: 'your role in this project cannot change rates' });
    }
    res.json(setRates(req.body || {}, actor));
  }));

  /* --------------------------------- policy-as-code --------------------------------- */

  app.get('/api/governance/policy', wrap((_req, res) => {
    res.json({ policy: getPolicy(), outcomes: OUTCOMES, conditions: CONDITIONS });
  }));

  app.post('/api/governance/policy', wrap((req, res) => {
    const actor = req.user?.email || req.user?.id || 'system';
    if (!can(ACTIVE_PROJECT_ID, req.user, 'governance.write')) {
      return res.status(403).json({ error: 'your role in this project cannot change policy' });
    }
    const errors = validatePolicy(req.body || {});
    if (errors.length) return res.status(400).json({ error: 'invalid policy', errors });
    res.json(setPolicy(req.body, actor));
  }));

  /**
   * Simulate a DRAFT against real past changes. A policy whose effect is unknown is not a control,
   * so this answers "how many of the recent changes would this have held?" before it holds any.
   */
  app.post('/api/governance/policy/simulate', wrap((req, res) => {
    const draft = req.body?.policy || req.body;
    // Replay against the real queue: each past item carries the facts the evaluator needs.
    const past = listReviewQueue({ limit: Math.min(500, Number(req.body?.limit) || 200) }).map((i) => ({
      id: i.id,
      title: i.title,
      status: i.status,
      decision: i.decision,
      risk: i.risk,
      sensitive: i.sensitive,
      area: i.area,
      agent: i.agent,
      agentTrust: i.trustLevel,
      filesChanged: i.filesChanged,
      additions: i.additions,
      // The queue does not store the file list, so path rules cannot be simulated from history —
      // stated in the response rather than silently reporting "no matches".
      files: [],
    }));
    res.json({ ...simulate(draft, past), pathRulesSimulatable: false });
  }));

  /* -------------------------- roles & separation of duties -------------------------- */

  // Who holds which role in the active project, and what each role can actually do.
  app.get('/api/governance/roles', wrap((req, res) => {
    res.json({
      projectId: ACTIVE_PROJECT_ID,
      roles: ROLES,
      capabilities: ROLE_CAPS,
      grants: listProjectRoles(ACTIVE_PROJECT_ID),
      you: { role: roleFor(ACTIVE_PROJECT_ID, req.user), canDecide: can(ACTIVE_PROJECT_ID, req.user, 'review.decide') },
    });
  }));

  app.post('/api/governance/roles', wrap((req, res) => {
    const actor = req.user?.email || req.user?.id || 'system';
    // Granting roles is itself a privileged act — an operator must not be able to promote themselves.
    if (!can(ACTIVE_PROJECT_ID, req.user, 'roles.write')) {
      return res.status(403).json({ error: 'your role in this project cannot grant roles' });
    }
    const { userId, role } = req.body || {};
    if (!userId || !role) return res.status(400).json({ error: 'userId and role are required' });
    res.json(grantRole(ACTIVE_PROJECT_ID, userId, role, actor));
  }));

  app.delete('/api/governance/roles/:userId', wrap((req, res) => {
    const actor = req.user?.email || req.user?.id || 'system';
    if (!can(ACTIVE_PROJECT_ID, req.user, 'roles.write')) {
      return res.status(403).json({ error: 'your role in this project cannot revoke roles' });
    }
    res.json(revokeRole(ACTIVE_PROJECT_ID, req.params.userId, actor));
  }));
}
