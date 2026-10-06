import crypto from 'node:crypto';
import { db } from '../db.js';
import { verifyAuditChain, verifyEgressChain, egressSummary } from '../platform/platformDb.js';
import { getQualityGates } from './governance.js';
import { egressPolicy } from './egress.js';
import { getPolicy } from './policy.js';
import { ACTIVE_PROJECT_ID, REPO_ROOT, BASE_BRANCH, WORK_BRANCH } from '../config.js';

/**
 * COMPLIANCE EVIDENCE PACK (ISL_IMPROVE "Enterprise wave", P0).
 *
 * An auditor asking "who authorised this production change, what verified it, and can you prove the
 * record was not edited afterwards?" is asking a question ISL could previously only answer by a
 * human clicking through the dashboard and writing prose. That is not evidence; it is a summary
 * written by the party being audited.
 *
 * This assembles the answer mechanically, for one landed change, from the records ISL already keeps:
 * the originating task, the plan the agent committed to BEFORE editing, every gate result with its
 * score and summary, the diff, the human decision and who made it, the governance configuration in
 * force at the time, and the integrity state of both hash chains. The bundle is then hashed, so the
 * pack itself is verifiable — an altered pack no longer matches its own digest.
 *
 * Two deliberate limits, stated in the pack rather than hidden:
 *   - Quality gates and the egress policy are reported as configured NOW, not as configured then;
 *     neither is versioned, so claiming point-in-time accuracy would be the unearned assurance this
 *     feature exists to prevent. The organisational POLICY is the exception — its version and the
 *     rules that actually held the change are recorded on the review item, so that one is historical.
 *   - Rows written before hash chaining was introduced are counted separately as unchained legacy.
 */

const J = (v, dflt = null) => { try { return JSON.parse(v); } catch { return dflt; } };
const iso = (ms) => (ms ? new Date(ms).toISOString() : null);

/** Every landed change that can be evidenced — the picker's source list. */
export function evidenceable({ limit = 50 } = {}) {
  return db
    .prepare(
      `SELECT id, status, plan_title, total_score, files_changed, additions, deletions,
              commit_sha, branch, started_at, finished_at
       FROM iterations
       WHERE commit_sha IS NOT NULL AND commit_sha != ''
       ORDER BY id DESC LIMIT ?`,
    )
    .all(limit)
    .map((r) => ({ ...r, startedAt: iso(r.started_at), finishedAt: iso(r.finished_at) }));
}

/**
 * Build the evidence pack for one iteration.
 * @param {number} iterationId
 * @returns {object|null} null when the iteration does not exist
 */
export function buildEvidencePack(iterationId) {
  const it = db.prepare('SELECT * FROM iterations WHERE id = ?').get(Number(iterationId));
  if (!it) return null;

  const phases = db
    .prepare('SELECT phase, status, score, summary, result, started_at, finished_at FROM phases WHERE iteration_id = ? ORDER BY id ASC')
    .all(it.id);

  const tasks = db
    .prepare('SELECT kind, title, rationale, status FROM tasks WHERE iteration_id = ? ORDER BY id ASC')
    .all(it.id);

  const plans = db
    .prepare('SELECT agent_id, title, criticality, approach, steps, files, pros, cons, risks, status FROM plans WHERE run_id = ? ORDER BY id ASC')
    .all(it.id);

  // The human decision. Its ABSENCE is itself evidence — it means the change landed without an
  // explicit human decision, which an auditor needs stated rather than omitted.
  const review = safe(
    () => db.prepare('SELECT * FROM review_queue WHERE iteration_id = ? ORDER BY id DESC LIMIT 1').get(it.id),
    null, // a project DB created before the review queue existed simply has no such table
  );

  const pack = {
    packVersion: 1,
    generatedAt: new Date().toISOString(),

    subject: {
      projectId: ACTIVE_PROJECT_ID,
      repoRoot: REPO_ROOT,
      iterationId: it.id,
      title: it.plan_title,
      status: it.status,
      trigger: it.trigger,
      commitSha: it.commit_sha,
      baseCommit: it.base_commit,
      branch: it.branch,
      baseBranch: BASE_BRANCH,
      workBranch: WORK_BRANCH,
      startedAt: iso(it.started_at),
      finishedAt: iso(it.finished_at),
      rolledBack: !!it.rolled_back,
      error: it.error || null,
    },

    // WHY the change was made: the backlog item and the plan the agent committed to before editing.
    authorisation: {
      tasks: tasks.map((t) => ({ kind: t.kind, title: t.title, rationale: t.rationale, status: t.status })),
      plans: plans.map((p) => ({
        agent: p.agent_id,
        title: p.title,
        criticality: p.criticality,
        approach: p.approach,
        steps: J(p.steps, []),
        files: J(p.files, []),
        pros: J(p.pros, []),
        cons: J(p.cons, []),
        risks: p.risks,
        status: p.status,
      })),
    },

    // WHAT verified it — every gate, with its score and the summary it produced.
    verification: {
      scores: {
        review: it.review_score,
        security: it.security_score,
        regression: it.regression_score,
        tests: it.test_score,
        total: it.total_score,
      },
      phases: phases.map((p) => ({
        phase: p.phase,
        status: p.status,
        score: p.score,
        summary: p.summary,
        // The raw result carries the gate's INPUTS, which is what makes the verdict checkable
        // rather than merely reported.
        result: J(p.result, p.result || null),
        startedAt: iso(p.started_at),
        finishedAt: iso(p.finished_at),
      })),
      changeSize: { filesChanged: it.files_changed, additions: it.additions, deletions: it.deletions },
    },

    // WHO authorised it.
    approval: review
      ? {
          reviewed: true,
          risk: review.risk,
          sensitive: !!review.sensitive,
          routing: review.decision,
          reasons: J(review.reasons, []),
          agentTrust: review.trust_level,
          status: review.status,
          decidedBy: review.decided_by,
          decidedAt: iso(review.decided_at),
        }
      : { reviewed: false, note: 'No review-queue record: this change landed without an explicit human decision.' },

    // The diff itself, so the pack stands alone without repository access.
    change: { diff: it.diff || null, diffBytes: it.diff ? Buffer.byteLength(it.diff, 'utf8') : 0 },

    // The controls that were configured. See the header note on why this is "now", not "then".
    governance: {
      note: 'Quality gates and egress policy are the configuration as of pack generation, not point-in-time. The organisational POLICY is the exception: the version that actually held this change is recorded on the review item itself and reported below.',
      // The policy version in force AT THE TIME, taken from the review record rather than from
      // today's configuration — this is the one control ISL can honestly attest to historically.
      policyAtTheTime: review?.policy_json ? safe(() => JSON.parse(review.policy_json), null) : null,
      policyNow: safe(() => { const p = getPolicy(); return { version: p.version, enabled: !!p.enabled, rules: (p.rules || []).length }; }, null),
      qualityGates: safe(() => getQualityGates(), null),
      egressPolicy: safe(() => { const p = egressPolicy(); return { mode: p.mode, approvedHosts: p.approvedHosts, redact: p.redact, capturePayloads: p.capturePayloads }; }, null),
    },

    // Whether the records this pack is drawn from are themselves intact.
    integrity: {
      auditChain: safe(verifyAuditChain, null),
      egressChain: safe(verifyEgressChain, null),
      egressSummary: safe(egressSummary, null),
    },
  };

  // The pack commits to itself: any later edit breaks the digest.
  pack.digest = digestOf(pack);
  return pack;
}

const safe = (fn, dflt) => { try { return fn(); } catch { return dflt; } };

/** SHA-256 over the pack with its own digest field excluded — the value that must be recomputable. */
export function digestOf(pack) {
  const { digest, ...rest } = pack;
  return crypto.createHash('sha256').update(JSON.stringify(rest)).digest('hex');
}

/** Re-derive the digest and compare — how a recipient checks a pack they were handed. */
export function verifyEvidencePack(pack) {
  if (!pack?.digest) return { ok: false, reason: 'the pack carries no digest' };
  const expected = digestOf(pack);
  return expected === pack.digest
    ? { ok: true, digest: expected }
    : { ok: false, reason: 'the pack contents do not match its digest — it was altered after generation', expected, found: pack.digest };
}

/* ------------------------------ HTML rendering ------------------------------ */

const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

const row = (k, v) => `<tr><th>${esc(k)}</th><td>${v == null || v === '' ? '<em>—</em>' : esc(v)}</td></tr>`;

/**
 * Render the pack as ONE self-contained HTML file.
 *
 * An auditor must be able to read this without ISL, without the network, and without a build step —
 * so there are no external stylesheets, scripts or fonts, and the digest is printed on the page so
 * the reader can check it against the JSON they were given.
 */
export function renderEvidenceHtml(pack) {
  const p = pack;
  const phaseRows = p.verification.phases
    .map((ph) => `<tr>
      <td>${esc(ph.phase)}</td>
      <td class="${ph.status === 'ok' ? 'ok' : ph.status === 'error' ? 'bad' : ''}">${esc(ph.status)}</td>
      <td>${ph.score ?? '—'}</td>
      <td>${esc(ph.summary || '')}</td>
    </tr>`)
    .join('\n');

  const planBlocks = p.authorisation.plans
    .map((pl) => `<div class="plan">
      <b>${esc(pl.title)}</b> <span class="muted">— ${esc(pl.agent)} · criticality ${esc(pl.criticality)}</span>
      <p>${esc(pl.approach)}</p>
      ${pl.files?.length ? `<p class="muted">Files: ${esc(pl.files.join(', '))}</p>` : ''}
      ${pl.risks ? `<p class="muted">Risks: ${esc(pl.risks)}</p>` : ''}
    </div>`)
    .join('\n') || '<p class="muted">No recorded plan.</p>';

  const a = p.approval;
  const integrityLine = (label, c) =>
    c ? `${label}: <span class="${c.ok ? 'ok' : 'bad'}">${c.ok ? 'verified' : `BROKEN at #${c.brokenAt} — ${esc(c.reason)}`}</span> (${c.rows} chained row(s)${c.unchainedLegacy ? `, ${c.unchainedLegacy} predate chaining` : ''})` : `${label}: unavailable`;

  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<title>Evidence pack — iteration ${esc(p.subject.iterationId)}</title>
<style>
 body{font:14px/1.5 system-ui,Segoe UI,sans-serif;margin:0;padding:32px;background:#fff;color:#111;max-width:1000px}
 h1{font-size:22px;margin:0 0 4px} h2{font-size:15px;margin:28px 0 8px;border-bottom:1px solid #ddd;padding-bottom:4px}
 table{border-collapse:collapse;width:100%;margin:8px 0} th,td{border:1px solid #ddd;padding:6px 8px;text-align:left;vertical-align:top}
 th{background:#f7f7f7;width:190px;font-weight:600} .muted{color:#666} .ok{color:#0a7d33} .bad{color:#c0242c;font-weight:600}
 pre{background:#f7f7f7;border:1px solid #ddd;padding:10px;overflow:auto;max-height:520px;font-size:12px}
 .plan{border-left:3px solid #ddd;padding:2px 0 2px 10px;margin:10px 0}
 .digest{font-family:ui-monospace,Consolas,monospace;font-size:11px;word-break:break-all}
 @media print{body{padding:0} pre{max-height:none}}
</style></head><body>
<h1>Change evidence pack</h1>
<p class="muted">Iteration ${esc(p.subject.iterationId)} · generated ${esc(p.generatedAt)} · pack v${esc(p.packVersion)}</p>

<h2>1. Subject of the change</h2>
<table>
${row('Title', p.subject.title)}
${row('Project', p.subject.projectId)}
${row('Repository', p.subject.repoRoot)}
${row('Commit', p.subject.commitSha)}
${row('Base commit', p.subject.baseCommit)}
${row('Branch', `${p.subject.branch || '—'} (base ${p.subject.baseBranch})`)}
${row('Status', p.subject.status)}
${row('Started / finished', `${p.subject.startedAt || '—'} → ${p.subject.finishedAt || '—'}`)}
${row('Rolled back', p.subject.rolledBack ? 'YES' : 'no')}
</table>

<h2>2. Why it was made</h2>
${p.authorisation.tasks.length
    ? `<table>${p.authorisation.tasks.map((t) => row(t.kind, `${t.title}${t.rationale ? ` — ${t.rationale}` : ''}`)).join('')}</table>`
    : '<p class="muted">No originating task recorded.</p>'}
${planBlocks}

<h2>3. What verified it</h2>
<table>
${row('Total score', p.verification.scores.total)}
${row('Review / security', `${p.verification.scores.review ?? '—'} / ${p.verification.scores.security ?? '—'}`)}
${row('Regression / tests', `${p.verification.scores.regression ?? '—'} / ${p.verification.scores.tests ?? '—'}`)}
${row('Change size', `${p.verification.changeSize.filesChanged} file(s), +${p.verification.changeSize.additions} −${p.verification.changeSize.deletions}`)}
</table>
<table><tr><th>Phase</th><th>Status</th><th>Score</th><th>Summary</th></tr>${phaseRows}</table>

<h2>4. Who authorised it</h2>
${a.reviewed
    ? `<table>
${row('Routing decision', a.routing)}
${row('Risk', `${a.risk}${a.sensitive ? ' (sensitive area)' : ''}`)}
${row('Reasons', (a.reasons || []).join('; '))}
${row('Agent trust at the time', a.agentTrust)}
${row('Final status', a.status)}
${row('Decided by', a.decidedBy)}
${row('Decided at', a.decidedAt)}
</table>`
    : `<p class="bad">${esc(a.note)}</p>`}

<h2>5. Controls in force</h2>
<p class="muted">${esc(p.governance.note)}</p>
<table>
${row('Policy in force at the time', p.governance.policyAtTheTime
    ? `v${p.governance.policyAtTheTime.version} — ${p.governance.policyAtTheTime.outcome}, held by: ${(p.governance.policyAtTheTime.matched || []).map((m) => m.id).join(', ')}`
    : 'no organisational policy rule applied to this change')}
${row('Policy now', p.governance.policyNow ? `v${p.governance.policyNow.version}, ${p.governance.policyNow.enabled ? 'enabled' : 'disabled'}, ${p.governance.policyNow.rules} rule(s)` : null)}
${row('Egress mode', p.governance.egressPolicy?.mode)}
${row('Redaction', p.governance.egressPolicy?.redact ? 'on' : 'off')}
${row('Quality gates', JSON.stringify(p.governance.qualityGates))}
</table>

<h2>6. Integrity of the record</h2>
<p>${integrityLine('Platform audit trail', p.integrity.auditChain)}</p>
<p>${integrityLine('Model-egress ledger', p.integrity.egressChain)}</p>
<p class="muted">Pack digest (SHA-256, computed over this pack with the digest field removed):</p>
<p class="digest">${esc(p.digest)}</p>

<h2>7. The change itself</h2>
${p.change.diff ? `<pre>${esc(p.change.diff)}</pre>` : '<p class="muted">No diff stored for this iteration.</p>'}
</body></html>`;
}
