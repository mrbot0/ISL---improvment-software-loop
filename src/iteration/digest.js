import { listIterations } from '../db_iteration.js';
import { healthReport } from './healthIndex.js';
import { getLastDependencyScan } from '../deploy/depScan.js';
import { getAllManagerBriefs } from '../db.js';

/**
 * DIGEST REPORTS (ISL_IMPROVE "New high-value functions", P1).
 *
 * A plain-language "what happened" summary over a time window — what landed, what was blocked,
 * where the health index moved, and what security debt is outstanding — so an operator can see
 * the fleet's value at a glance without reading 100 iterations. Fully deterministic: it composes
 * data ISL already records (iterations, health snapshots, the security gate, the dependency scan),
 * so the number in the digest is always the real number. This is the surface a daily/weekly email
 * or Slog message would render from.
 */

const HOUR = 3_600_000;

function windowIterations(hours) {
  const since = Date.now() - hours * HOUR;
  // Look back over plenty of rows, then keep those that finished (or at least started) in-window.
  return listIterations(400).filter((i) => (i.finishedAt || i.startedAt || 0) >= since);
}

function bucket(iters) {
  const is = (i, ...s) => s.includes(i.status);
  const committed = iters.filter((i) => is(i, 'committed', 'promoted'));
  const blocked = iters.filter((i) => is(i, 'rolled_back') || i.rolledBack);
  const empty = iters.filter((i) => is(i, 'empty', 'skipped'));
  const interrupted = iters.filter((i) => is(i, 'interrupted', 'running'));
  const errored = iters.filter((i) => is(i, 'error'));
  return { committed, blocked, empty, interrupted, errored };
}

function sum(iters, key) {
  return iters.reduce((a, i) => a + (i[key] || 0), 0);
}

/** Compose the digest for a window (default 24h). Deterministic; never throws on missing data. */
export function buildDigest({ hours = 24 } = {}) {
  const iters = windowIterations(hours);
  const b = bucket(iters);
  const finished = iters.filter((i) => i.status !== 'running');

  const totals = {
    files: sum(b.committed, 'filesChanged'),
    additions: sum(b.committed, 'additions'),
    deletions: sum(b.committed, 'deletions'),
    improvements: sum(b.committed, 'improvements'),
    features: sum(b.committed, 'featuresDone'),
  };
  const scored = b.committed.filter((i) => i.scores?.total != null);
  const avgScore = scored.length ? Math.round(scored.reduce((a, i) => a + i.scores.total, 0) / scored.length) : null;
  const landRate = finished.length ? Math.round((b.committed.length / finished.length) * 100) : 0;

  const highlights = b.committed
    .slice(0, 8)
    .map((i) => ({
      id: i.id,
      title: i.planTitle || `Iteration #${i.id}`,
      score: i.scores?.total ?? null,
      sha: (i.commitSha || '').slice(0, 8),
      files: i.filesChanged || 0,
    }));

  let health = null;
  try {
    const h = healthReport();
    health = { score: h.score, delta: h.delta, testRatio: h.components?.testRatio ?? null };
  } catch { /* no snapshots */ }

  let dependencies = null;
  const dep = getLastDependencyScan();
  if (dep) dependencies = { totals: dep.totals, scannedAt: dep.scannedAt };

  let gate = null;
  try {
    const risk = (getAllManagerBriefs() || []).find((m) => m.name === 'Risk');
    if (risk) gate = { vetoes: risk.gateVetoes || 0, findings: (risk.gateFindings || []).length };
  } catch { /* manager not ready */ }

  return {
    generatedAt: Date.now(),
    window: { hours, since: Date.now() - hours * HOUR },
    counts: {
      total: iters.length,
      committed: b.committed.length,
      blocked: b.blocked.length,
      empty: b.empty.length,
      interrupted: b.interrupted.length,
      errored: b.errored.length,
    },
    landRate,
    totals,
    avgScore,
    highlights,
    health,
    dependencies,
    gate,
    headline: headline({ counts: { committed: b.committed.length }, totals, landRate, health, hours, dependencies, gate }),
  };
}

/** One-line human summary — the subject line of the digest. */
function headline({ counts, totals, landRate, health, hours, dependencies, gate }) {
  const span = hours <= 24 ? 'today' : hours <= 24 * 7 ? 'this week' : `in the last ${Math.round(hours / 24)} days`;
  if (!counts.committed) {
    const parts = [`No changes landed ${span}`];
    if (health) parts.push(`health ${health.score}/100`);
    if (dependencies?.totals?.total) parts.push(`${dependencies.totals.total} known CVE(s) outstanding`);
    return parts.join(' · ') + '.';
  }
  const parts = [`${counts.committed} change${counts.committed === 1 ? '' : 's'} landed ${span}`];
  if (totals.files) parts.push(`${totals.files} file${totals.files === 1 ? '' : 's'} touched`);
  parts.push(`${landRate}% land rate`);
  if (health) parts.push(`health ${health.score}/100${health.delta != null ? ` (${health.delta >= 0 ? '+' : ''}${health.delta})` : ''}`);
  if (gate?.vetoes) parts.push(`${gate.vetoes} unsafe change${gate.vetoes === 1 ? '' : 's'} blocked`);
  if (dependencies?.totals?.critical) parts.push(`${dependencies.totals.critical} critical CVE(s) to fix`);
  return parts.join(' · ') + '.';
}
