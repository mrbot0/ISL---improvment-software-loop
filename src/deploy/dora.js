import { db, registerSchema, getSetting, setSetting } from '../db.js';
import { git } from '../sandbox/worktree.js';
import { iteration as cfg } from '../config.js';
import { emit } from '../bus.js';
import { log } from '../logger.js';
import { notifyOnce } from '../db_iteration.js';
import { remember } from '../memory/memoryDb.js';
import { audit } from '../platform/platformDb.js';
import { countErrors, listAnomalies } from '../reliability/reliabilityDb.js';
import { computeHealth } from '../iteration/healthIndex.js';
import { revertCommit } from '../iteration/bisect.js';

/**
 * DORA METRICS + POST-DEPLOY GUARDRAIL (ISL_IMPROVE enterprise wave, P1).
 *
 * Two gaps, one module.
 *
 * FIRST: ISL graded its own gates but never learned whether a change **hurt** anything after it
 * shipped. Promotion was the last step and then the loop forgot. So the four DORA metrics are
 * computed here — lead time, deployment frequency, change-failure rate, MTTR — and deliberately
 * computed SEPARATELY for ISL-authored and human-authored change. "The fleet's change-failure rate
 * is lower than ours" is the sentence that decides an enterprise rollout; if it is false, the
 * operator needs to know that more, not less. A comparison that could only ever flatter ISL would
 * be marketing, so authorship is read from the commit itself and both sides are measured identically.
 *
 * SECOND: the last missing edge in the feedback graph. Every other negative signal already teaches
 * the fleet — a veto, a failed test, a human rejection — but "it shipped and then broke" taught
 * nothing at all. After each promotion a BAKE WINDOW opens; if the signals degrade inside it, a
 * revert proposal is raised with its evidence attached, the responsible agents' trust is docked, and
 * the failure is written to shared memory exactly as a rejection is.
 *
 * ── On honesty about signals ────────────────────────────────────────────────────────────────
 * ISL has no production telemetry, and pretending otherwise would be the worst possible failure for
 * a guardrail: a green bake window that never looked at anything. The signals used are the ones that
 * genuinely exist locally — recorded error events, open anomalies, and the codebase health index —
 * and every verdict records WHICH sources were readable. When none were, the window closes as
 * `unobserved`, never as `clean`, and the change-failure rate excludes those deployments from its
 * denominator rather than scoring an unwatched deployment as a success.
 */

const lg = log.for('dora');
const now = () => Date.now();

registerSchema(() => {
  db.exec(`
  CREATE TABLE IF NOT EXISTS deployments (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    ts             INTEGER NOT NULL,
    from_sha       TEXT,
    to_sha         TEXT,
    branch         TEXT,
    commit_count   INTEGER NOT NULL DEFAULT 0,
    isl_commits    INTEGER NOT NULL DEFAULT 0,
    human_commits  INTEGER NOT NULL DEFAULT 0,
    bake_until     INTEGER,
    bake_status    TEXT NOT NULL DEFAULT 'watching',
    breach_reason  TEXT,
    evidence_json  TEXT,
    baseline_json  TEXT,
    reverted_sha   TEXT,
    resolved_at    INTEGER
  );
  CREATE INDEX IF NOT EXISTS idx_deploy_ts ON deployments(ts DESC);
  CREATE INDEX IF NOT EXISTS idx_deploy_bake ON deployments(bake_status, bake_until);

  CREATE TABLE IF NOT EXISTS deployment_commits (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    deployment_id INTEGER NOT NULL,
    sha           TEXT NOT NULL,
    authored_at   INTEGER NOT NULL,
    author        TEXT,
    title         TEXT,
    by_isl        INTEGER NOT NULL DEFAULT 0,
    agents_json   TEXT,
    iteration_id  INTEGER
  );
  CREATE INDEX IF NOT EXISTS idx_depcommit_dep ON deployment_commits(deployment_id);
  `);
});

/* ------------------------------- settings -------------------------------- */

/** How long after a promotion the signals are watched. */
export const getBakeWindowMinutes = () => Number(getSetting('doraBakeWindowMinutes', 30)) || 30;
export const setBakeWindowMinutes = (m) => setSetting('doraBakeWindowMinutes', Math.min(1440, Math.max(1, Number(m) || 30)));

/**
 * Standing authorisation to EXECUTE a revert rather than only propose one. Off by default and
 * deliberately separate from every other autonomy switch: a revert rewrites what already shipped, so
 * it is the one action the operator has to turn on by name.
 */
export const isAutoRevertEnabled = () => getSetting('doraAutoRevert', false) === true;
export const setAutoRevertEnabled = (on) => setSetting('doraAutoRevert', !!on);

/* ---------------------------- commit authorship --------------------------- */

/**
 * Authorship is read from the COMMIT, never from our own database: an ISL change and a change a
 * developer wrote by hand land on the same branch, and only the commit knows which is which.
 *
 * These patterns must track the message `engine.js` builds when it commits. That message carries no
 * dedicated machine-readable trailers, so they parse the human-readable form it does write:
 *
 *   [ai-iter#182] Tighten the booking validators             ← subject: the run id
 *   ...
 *   Provenance: model qwen3.6 · agents implementer×2 tester×1 · gates passed [...]
 *   Generated autonomously by ISL. Co-Authored-By: ISL Agents <agents@isl.local>
 *
 * If that format changes, `byIsl` degrades safely — a missed ISL commit is counted as human, which
 * understates ISL's deployment count rather than flattering its failure rate. But `agents` going
 * empty would SILENTLY disable the trust and memory feedback on a breach, which is the entire point
 * of the guardrail. That is why `parseAgents` is tested against the real message shape.
 */
const ISL_TRAILER = /Co-Authored-By:\s*ISL Agents/i;
const RUN_SUBJECT = /\[ai-iter#(\d+)\]/i;
const PROVENANCE_AGENTS = /·\s*agents\s+(.+?)\s*·/i;

const RS = '\x1e'; // record separator — safe inside a commit body, unlike a newline
const FS = '\x1f'; // field separator

/** `implementer×2 tester×1` → `['implementer', 'tester']`. The empty marker `—` → `[]`. */
export function parseAgents(body) {
  const seg = String(body || '').match(PROVENANCE_AGENTS)?.[1];
  if (!seg || seg.trim() === '—') return [];
  return [
    ...new Set(
      seg
        .split(/\s+/)
        .map((tok) => tok.split(/[×x]/)[0].trim())
        .filter((a) => a && a !== '—'),
    ),
  ];
}

/** Every commit in `from..to`, with the facts DORA needs. */
export function commitsBetween(fromSha, toSha) {
  if (!fromSha || !toSha || fromSha === toSha) return [];
  let out = '';
  try {
    out = git(['log', `--format=%H${FS}%at${FS}%ae${FS}%s${FS}%B${RS}`, `${fromSha}..${toSha}`]);
  } catch (err) {
    lg.warn(`could not read commits ${String(fromSha).slice(0, 8)}..${String(toSha).slice(0, 8)}: ${err.message}`);
    return [];
  }
  return out
    .split(RS)
    .map((rec) => rec.trim())
    .filter(Boolean)
    .map((rec) => {
      const [sha, at, author, title, body = ''] = rec.split(FS);
      const byIsl = ISL_TRAILER.test(body);
      return {
        sha,
        authoredAt: Number(at) * 1000,
        author,
        title: (title || '').slice(0, 200),
        byIsl,
        // A batch is written by SEVERAL specialists, so this is a list. Attributing a breach to one
        // arbitrarily-picked agent would dock the wrong reputation much of the time.
        agents: byIsl ? parseAgents(body) : [],
        iterationId: byIsl ? Number((title || '').match(RUN_SUBJECT)?.[1]) || null : null,
      };
    });
}

/* ------------------------------ deployments ------------------------------- */

/**
 * Record a promotion and open its bake window.
 *
 * Called from `promoteToMain` AFTER the fast-forward succeeds — a promotion git refused is not a
 * deployment and must never enter the metrics.
 */
export function recordDeployment({ from, to, branch = cfg.baseBranch, count = 0 } = {}) {
  try {
    const commits = commitsBetween(from, to);
    const isl = commits.filter((c) => c.byIsl).length;
    const id = Number(
      db
        .prepare(
          `INSERT INTO deployments (ts, from_sha, to_sha, branch, commit_count, isl_commits, human_commits, bake_until, bake_status, baseline_json)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'watching', ?)`,
        )
        .run(
          now(), from || null, to || null, branch,
          commits.length || count, isl, commits.length - isl,
          now() + getBakeWindowMinutes() * 60_000,
          JSON.stringify(baselineSnapshot()),
        ).lastInsertRowid,
    );

    const ins = db.prepare(
      `INSERT INTO deployment_commits (deployment_id, sha, authored_at, author, title, by_isl, agents_json, iteration_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    for (const c of commits) {
      ins.run(id, c.sha, c.authoredAt, c.author || null, c.title, c.byIsl ? 1 : 0, JSON.stringify(c.agents || []), c.iterationId);
    }

    lg.info(`deployment #${id}: ${commits.length} commit(s) (${isl} by ISL) → ${String(to).slice(0, 8)}; baking for ${getBakeWindowMinutes()}m`);
    emit('dora.deployed', { id, to: String(to).slice(0, 8), commits: commits.length, islCommits: isl, bakeMinutes: getBakeWindowMinutes() });
    audit('deploy.recorded', { actor: 'isl', target: String(to).slice(0, 12), detail: { commits: commits.length, islCommits: isl } });
    return { id, commits: commits.length, islCommits: isl };
  } catch (err) {
    // A metrics failure must never break a promotion that already succeeded.
    lg.warn(`could not record deployment: ${err.message}`);
    return null;
  }
}

/** The signal levels at the moment of deployment — a breach is measured against these, not zero. */
function baselineSnapshot() {
  const snap = { at: now(), sources: [] };
  try {
    snap.errorsPrevHour = countErrors({ sinceMs: now() - 3_600_000 });
    snap.sources.push('errors');
  } catch { /* table not ready */ }
  try {
    snap.openAnomalies = listAnomalies({ onlyOpen: true, limit: 200 }).length;
    snap.sources.push('anomalies');
  } catch { /* table not ready */ }
  const h = readHealth();
  if (h != null) {
    snap.health = h;
    snap.sources.push('health');
  }
  return snap;
}

/**
 * The health score, or null when the repository could not actually be read.
 *
 * `computeHealth()` does not throw on an unreadable or empty checkout — its divisors are guarded
 * with `|| 1`, so a scan that found nothing still returns a plausible-looking number. Trusting that
 * is how a bake window closes `clean` on the strength of a score computed from zero files, which is
 * precisely the "green window that never looked at anything" this module exists to prevent. So the
 * scan has to have seen source files before its score counts as a signal at all.
 */
function readHealth() {
  try {
    const h = computeHealth();
    return h?.facts?.sourceFiles > 0 ? h.score : null;
  } catch {
    return null;
  }
}

/* --------------------------- the bake guardrail --------------------------- */

// How much worse than the pre-deploy baseline counts as a breach. Errors are compared as a RATE (the
// hour before vs the elapsed window since), so a repo that is always noisy does not trip the guard
// on its own steady noise — only on a step change.
const ERROR_SPIKE_FACTOR = 2;
const ERROR_SPIKE_FLOOR = 3; // never trip on 1 → 2 errors
const HEALTH_DROP_POINTS = 5;

/**
 * Evaluate one deployment's signals right now.
 * @returns {{ breached:boolean, observed:boolean, reasons:string[], evidence:object }}
 */
export function evaluateSignals(dep) {
  const baseline = (() => { try { return JSON.parse(dep.baseline_json || '{}'); } catch { return {}; } })();
  const sinceDeploy = now() - dep.ts;
  const reasons = [];
  const evidence = { windowMs: sinceDeploy, baseline, sources: [] };

  // 1. Error rate, normalised so a four-minute check is not compared against a full hour.
  try {
    const since = countErrors({ sinceMs: dep.ts });
    const hours = Math.max(sinceDeploy / 3_600_000, 1 / 60);
    const ratePerHour = since / hours;
    const basePerHour = Number(baseline.errorsPrevHour ?? 0);
    evidence.errorsSinceDeploy = since;
    evidence.errorRatePerHour = Math.round(ratePerHour * 10) / 10;
    evidence.baselineRatePerHour = basePerHour;
    evidence.sources.push('errors');
    if (since >= ERROR_SPIKE_FLOOR && ratePerHour > Math.max(basePerHour * ERROR_SPIKE_FACTOR, ERROR_SPIKE_FLOOR)) {
      reasons.push(`error rate ${evidence.errorRatePerHour}/h since the deploy vs ${basePerHour}/h before it`);
    }
  } catch { /* unreadable — its absence from evidence.sources is the record of that */ }

  // 2. Anomalies opened after the deployment.
  try {
    const opened = listAnomalies({ onlyOpen: true, limit: 200 }).filter((a) => (a.ts ?? a.created_at ?? 0) >= dep.ts);
    evidence.anomaliesOpened = opened.length;
    evidence.sources.push('anomalies');
    if (opened.length) reasons.push(`${opened.length} anomaly/anomalies opened after the deploy`);
  } catch { /* unreadable */ }

  // 3. Health index regression.
  const score = readHealth();
  if (score != null) {
    evidence.health = score;
    evidence.baselineHealth = baseline.health ?? null;
    evidence.sources.push('health');
    if (baseline.health != null && score <= baseline.health - HEALTH_DROP_POINTS) {
      reasons.push(`health index fell ${Math.round(baseline.health - score)} points (${baseline.health} → ${score})`);
    }
  }

  return { breached: reasons.length > 0, observed: evidence.sources.length > 0, reasons, evidence };
}

/**
 * Check every open bake window: breach now, or close it once the window expires.
 *
 * A window that expires having read NOTHING closes as `unobserved`, not `clean`. Scoring an
 * unwatched deployment as a success would quietly inflate the very number this module exists to
 * report honestly.
 */
export function checkBakeWindows() {
  let breached = 0;
  let closed = 0;
  let open = [];
  try {
    open = db.prepare("SELECT * FROM deployments WHERE bake_status = 'watching' ORDER BY id").all();
  } catch {
    return { checked: 0, breached: 0, closed: 0 }; // schema not ready yet
  }

  for (const dep of open) {
    const verdict = evaluateSignals(dep);

    if (verdict.breached) {
      db.prepare("UPDATE deployments SET bake_status = 'breached', breach_reason = ?, evidence_json = ? WHERE id = ?")
        .run(verdict.reasons.join('; ').slice(0, 500), JSON.stringify(verdict.evidence), dep.id);
      breached++;
      try {
        onBreach(dep, verdict);
      } catch (err) {
        lg.warn(`breach handling for deployment #${dep.id} failed: ${err.message}`);
      }
      continue;
    }

    if (now() >= (dep.bake_until || 0)) {
      const status = verdict.observed ? 'clean' : 'unobserved';
      db.prepare('UPDATE deployments SET bake_status = ?, evidence_json = ? WHERE id = ?')
        .run(status, JSON.stringify(verdict.evidence), dep.id);
      closed++;
      if (status === 'unobserved') {
        lg.warn(`deployment #${dep.id} baked with no readable signal — recorded as unobserved, NOT as clean`);
      }
    }
  }
  return { checked: open.length, breached, closed };
}

/** The agents credited on a deployment's ISL commits. */
function agentsOf(depId) {
  const rows = db.prepare('SELECT agents_json FROM deployment_commits WHERE deployment_id = ? AND by_isl = 1').all(depId);
  const out = new Set();
  for (const r of rows) {
    try { for (const a of JSON.parse(r.agents_json || '[]')) out.add(a); } catch { /* malformed row */ }
  }
  return [...out];
}

/**
 * A deployment went bad. Propose the revert with its evidence, teach the fleet, and dock the trust
 * of every agent that authored the shipped commits — the same treatment a human rejection gets,
 * because a change that broke after shipping is at least as strong a signal.
 */
function onBreach(dep, verdict) {
  const commits = db.prepare('SELECT * FROM deployment_commits WHERE deployment_id = ? ORDER BY id DESC').all(dep.id);
  const islCommits = commits.filter((c) => c.by_isl);
  const agents = agentsOf(dep.id);
  const why = verdict.reasons.join('; ');

  lg.warn(`deployment #${dep.id} BREACHED its bake window: ${why}`);
  emit('dora.breach', { id: dep.id, reasons: verdict.reasons, islCommits: islCommits.length, agents });
  audit('deploy.breach', { actor: 'post-deploy-guardrail', target: String(dep.to_sha).slice(0, 12), detail: { reasons: verdict.reasons, agents } });

  for (const agent of agents) {
    try {
      remember({
        scope: `agent:${agent}`,
        kind: 'pitfall',
        title: `Shipped, then broke: ${(islCommits[0]?.title || 'a promoted change').slice(0, 80)}`,
        content:
          `A change you authored passed every gate, was promoted, and then the signals degraded: ${why}. `
          + 'Passing the tests is not the same as being safe in the running system. For this shape of change, '
          + 'prefer the smaller version, and reason about what it does at runtime — not only whether the suite is green.',
        source: 'dora:breach',
      });
    } catch { /* memory best-effort */ }
  }

  // The revert PROPOSAL is the default; executing it needs standing authorisation, by name.
  const target = islCommits[0] || commits[0];
  let reverted = null;
  if (isAutoRevertEnabled() && target) {
    const r = revertCommit({ sha: target.sha });
    if (r.ok) {
      reverted = r.sha;
      db.prepare('UPDATE deployments SET reverted_sha = ?, resolved_at = ? WHERE id = ?').run(r.sha, now(), dep.id);
      lg.info(`auto-reverted ${String(target.sha).slice(0, 8)} → ${String(r.sha).slice(0, 8)} (standing authorisation is on)`);
      audit('deploy.auto_reverted', { actor: 'post-deploy-guardrail', target: String(target.sha).slice(0, 12), detail: { newSha: r.sha } });
    } else {
      lg.warn(`auto-revert of ${String(target.sha).slice(0, 8)} failed: ${r.reason}`);
    }
  }

  notifyOnce({
    kind: 'deploy',
    severity: 'error',
    title: reverted ? `Reverted a promoted change — ${why.slice(0, 70)}` : 'A promoted change looks bad — revert proposed',
    body:
      `Deployment #${dep.id} (${commits.length} commit(s), ${islCommits.length} by ISL${agents.length ? `, from ${agents.join(', ')}` : ''}) `
      + `breached its bake window: ${why}. `
      + (reverted
        ? `Auto-revert is on, so ${String(target.sha).slice(0, 8)} has been reverted on the work branch.`
        : `Proposed revert: ${target ? String(target.sha).slice(0, 8) : 'n/a'} — "${(target?.title || '').slice(0, 60)}". Turn on standing authorisation to have this done automatically.`),
    link: 'deploy',
  });
}

/** Mark a breached deployment resolved (the revert landed, or the operator fixed it forward). */
export function resolveBreach(id, { revertedSha = null } = {}) {
  const changed = db
    .prepare(
      `UPDATE deployments SET resolved_at = ?, reverted_sha = COALESCE(?, reverted_sha)
       WHERE id = ? AND bake_status = 'breached' AND resolved_at IS NULL`,
    )
    .run(now(), revertedSha, id).changes;
  if (changed) audit('deploy.breach_resolved', { actor: 'operator', target: String(id) });
  return { resolved: !!changed };
}

/* -------------------------------- metrics -------------------------------- */

const median = (xs) => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : Math.round((s[m - 1] + s[m]) / 2);
};
const hours = (ms) => (ms == null ? null : Math.round((ms / 3_600_000) * 10) / 10);

/**
 * The four DORA metrics, computed separately for ISL-authored and human-authored change.
 *
 * @param {{days?:number}} opts
 */
export function doraMetrics({ days = 30 } = {}) {
  const since = now() - days * 86_400_000;
  let deps = [];
  try {
    deps = db.prepare('SELECT * FROM deployments WHERE ts >= ? ORDER BY ts').all(since);
  } catch {
    return { windowDays: days, deployments: 0, unavailable: 'no deployments have been recorded yet' };
  }
  const commits = deps.length
    ? db.prepare(`SELECT * FROM deployment_commits WHERE deployment_id IN (${deps.map(() => '?').join(',')})`).all(...deps.map((d) => d.id))
    : [];
  const byDep = new Map(deps.map((d) => [d.id, d]));

  const side = (byIsl) => {
    const mine = commits.filter((c) => !!c.by_isl === byIsl);
    const deployIds = new Set(mine.map((c) => c.deployment_id));
    const myDeps = deps.filter((d) => deployIds.has(d.id));

    // Lead time for change: authored → promoted, per commit.
    const leadTimes = mine.map((c) => byDep.get(c.deployment_id).ts - c.authored_at).filter((n) => n >= 0);

    // Change failure rate: over deployments we actually WATCHED. An unobserved window is not
    // evidence of success, so it leaves the denominator rather than counting as a pass.
    const observed = myDeps.filter((d) => d.bake_status === 'breached' || d.bake_status === 'clean');
    const failed = observed.filter((d) => d.bake_status === 'breached');

    // Time to restore service: breach detected → resolved.
    const restores = failed.filter((d) => d.resolved_at).map((d) => d.resolved_at - d.ts);

    return {
      deployments: myDeps.length,
      commits: mine.length,
      deploymentsPerWeek: Math.round((myDeps.length / days) * 7 * 10) / 10,
      leadTimeMedianMs: median(leadTimes),
      leadTimeMedianHours: hours(median(leadTimes)),
      observedDeployments: observed.length,
      failedDeployments: failed.length,
      changeFailureRate: observed.length ? Math.round((failed.length / observed.length) * 1000) / 10 : null,
      mttrMedianMs: median(restores),
      mttrMedianHours: hours(median(restores)),
      unresolvedFailures: failed.filter((d) => !d.resolved_at).length,
    };
  };

  const isl = side(true);
  const human = side(false);
  const unobserved = deps.filter((d) => d.bake_status === 'unobserved').length;

  return {
    windowDays: days,
    deployments: deps.length,
    watching: deps.filter((d) => d.bake_status === 'watching').length,
    unobserved,
    // Stated plainly, so a thin sample cannot be read as a verdict.
    caveat:
      unobserved || deps.length < 5
        ? `Based on ${deps.length} deployment(s)${unobserved ? `, ${unobserved} of which had no readable signal and are excluded from the failure rate` : ''} — too thin to draw a conclusion from.`
        : null,
    isl,
    human,
    // The comparison the roadmap asks for, reported whichever way it comes out.
    comparison:
      isl.changeFailureRate != null && human.changeFailureRate != null
        ? {
          changeFailureRateDelta: Math.round((isl.changeFailureRate - human.changeFailureRate) * 10) / 10,
          islIsSafer: isl.changeFailureRate <= human.changeFailureRate,
        }
        : null,
    bakeWindowMinutes: getBakeWindowMinutes(),
    autoRevert: isAutoRevertEnabled(),
  };
}

/**
 * Deployments that breached after carrying this agent's work — read by `trust.js`.
 *
 * Kept as its own signal rather than rewritten into the review queue on purpose: a human who
 * approved a change DID approve it, and flipping that record to "rejected" after the fact would
 * falsify their decision to make the arithmetic simpler.
 */
export function postDeployBreaches(agentId) {
  try {
    const rows = db
      .prepare(
        `SELECT DISTINCT d.id, c.agents_json
         FROM deployments d JOIN deployment_commits c ON c.deployment_id = d.id
         WHERE d.bake_status = 'breached' AND c.by_isl = 1`,
      )
      .all();
    const hit = new Set();
    for (const r of rows) {
      try {
        if (JSON.parse(r.agents_json || '[]').includes(agentId)) hit.add(r.id);
      } catch { /* malformed row */ }
    }
    return hit.size;
  } catch {
    return 0;
  }
}

/** Recent deployments for the dashboard, newest first. */
export const listDeployments = (limit = 25) => {
  try {
    return db.prepare('SELECT * FROM deployments ORDER BY id DESC LIMIT ?').all(limit).map((d) => ({
      id: d.id,
      ts: d.ts,
      to: (d.to_sha || '').slice(0, 8),
      branch: d.branch,
      commits: d.commit_count,
      islCommits: d.isl_commits,
      humanCommits: d.human_commits,
      agents: agentsOf(d.id),
      bakeStatus: d.bake_status,
      bakeUntil: d.bake_until,
      breachReason: d.breach_reason,
      revertedSha: d.reverted_sha ? d.reverted_sha.slice(0, 8) : null,
      resolvedAt: d.resolved_at,
      evidence: (() => { try { return JSON.parse(d.evidence_json || 'null'); } catch { return null; } })(),
    }));
  } catch {
    return [];
  }
};
