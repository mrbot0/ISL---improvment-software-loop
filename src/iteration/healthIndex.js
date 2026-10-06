import { db, registerSchema } from '../db.js';
import { scanFiles } from './structuralScan.js';

/**
 * CODEBASE HEALTH INDEX (ISL_IMPROVE "New high-value functions").
 *
 * One honest composite score (0-100) per project, tracked over time, so the answer to "is ISL
 * actually making this codebase better?" is a trend line, not a feeling. It is deliberately
 * built from DETERMINISTIC signals we can compute cheaply and repeatedly:
 *
 *   - structure  : share of code sitting in god-files (>500 lines) — lower is better
 *   - complexity : average branch density per file — lower is better
 *   - testRatio  : test files vs source files — more is better (ISL's strongest lever)
 *   - sizeSpread : how concentrated the code is in a few huge files
 *
 * Coverage %, duplication and vuln counts are proxies here and are called out as "next" — but the
 * index already moves the right way when a god-file is split or tests are added, which is the point.
 */

registerSchema(() => {
  db.exec(`
  CREATE TABLE IF NOT EXISTS health_snapshots (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    ts         INTEGER NOT NULL,
    score      INTEGER NOT NULL,
    components TEXT NOT NULL,
    commit_sha TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_health_ts ON health_snapshots(id DESC);
  `);
});

const clamp = (n) => Math.max(0, Math.min(100, Math.round(n)));

/** Compute the current health index + its components from the code on disk. */
export function computeHealth() {
  const files = scanFiles();
  const source = files.filter((f) => !f.isTest);
  const tests = files.filter((f) => f.isTest);
  const totalFiles = source.length || 1;
  const totalLines = source.reduce((a, f) => a + f.lines, 0) || 1;

  const godFiles = source.filter((f) => f.lines >= 500);
  const godLines = godFiles.reduce((a, f) => a + f.lines, 0);
  const avgComplexity = source.reduce((a, f) => a + f.complexity, 0) / totalFiles;
  const testRatio = tests.length / totalFiles;

  // Each component is 0-100, higher = healthier.
  const components = {
    structure: clamp(100 - (godLines / totalLines) * 220), // share of code in god-files
    complexity: clamp(100 - (avgComplexity / 60) * 100), // avg branch density (~60 = busy)
    testRatio: clamp(testRatio * 260), // ~0.38 test/source files → ~100
    sizeSpread: clamp(100 - (godFiles.length / totalFiles) * 700), // how many files are oversized
  };
  const weights = { structure: 0.3, complexity: 0.25, testRatio: 0.3, sizeSpread: 0.15 };
  const score = clamp(Object.entries(components).reduce((a, [k, v]) => a + v * weights[k], 0));

  return {
    score,
    components,
    facts: {
      sourceFiles: source.length,
      testFiles: tests.length,
      totalLines,
      godFiles: godFiles.length,
      avgComplexity: Math.round(avgComplexity),
      biggest: [...source].sort((a, b) => b.lines - a.lines).slice(0, 5).map((f) => ({ file: f.file, lines: f.lines })),
    },
  };
}

/** Persist a snapshot so the trend builds over time. Deduped to at most one per hour. */
export function recordHealthSnapshot({ commitSha = null } = {}) {
  try {
    const last = db.prepare('SELECT ts FROM health_snapshots ORDER BY id DESC LIMIT 1').get();
    if (last && Date.now() - last.ts < 3_600_000 && !commitSha) return null; // throttle idle snapshots
    const h = computeHealth();
    db.prepare('INSERT INTO health_snapshots (ts, score, components, commit_sha) VALUES (?, ?, ?, ?)').run(
      Date.now(), h.score, JSON.stringify(h.components), commitSha,
    );
    return h.score;
  } catch {
    return null;
  }
}

/** Current health + the recent trend (for the dashboard). */
export function healthReport({ limit = 60 } = {}) {
  const current = computeHealth();
  let trend = [];
  try {
    trend = db
      .prepare('SELECT ts, score, commit_sha FROM health_snapshots ORDER BY id DESC LIMIT ?')
      .all(limit)
      .reverse()
      .map((r) => ({ ts: r.ts, score: r.score, commitSha: r.commit_sha }));
  } catch {
    /* no snapshots yet */
  }
  const first = trend[0]?.score;
  const delta = first != null ? current.score - first : null;
  return { ...current, trend, delta };
}
