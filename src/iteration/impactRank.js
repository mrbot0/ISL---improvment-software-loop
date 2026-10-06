import { scanFiles } from './structuralScan.js';
import { blastRadius } from './blastRadius.js';

/**
 * UNIFIED IMPACT-RANKED BACKLOG (ISL_IMPROVE "Next wave", P1).
 *
 * The fleet's various scans each rank work by ONE lens (structural = size, coverage = untested,
 * health = composite). This composes them into a single leverage score per file, so ISL always
 * knows where an improvement helps the MOST — not just what's biggest or least-tested. Every input
 * is deterministic and read from the blast-radius graph + the file scan:
 *
 *   reach       (0.30) — how many modules depend on this file (a bug here breaks a lot)
 *   untested    (0.25) — no test imports it (the strongest, cheapest win for the test agent)
 *   routes      (0.15) — feeds user-facing routes (a break is visible to users)
 *   sensitive   (0.12) — auth / payment / migration (a break is costly)
 *   size        (0.10) — god-file (hard to change safely; refactor leverage)
 *   complexity  (0.08) — branch density (defect-prone)
 *
 * The result is a "fix/test/refactor these first" list the operator and planner can trust.
 */

const W = { reach: 0.30, untested: 0.25, routes: 0.15, sensitive: 0.12, size: 0.10, complexity: 0.08 };
const clamp01 = (n) => Math.max(0, Math.min(1, n));

/** Rank every product source file by composite improvement leverage. */
export function impactRanked({ limit = 30 } = {}) {
  const files = scanFiles().filter((f) => !f.isTest);
  const rows = files.map((f) => {
    const b = blastRadius(f.file);
    const signals = {
      reach: clamp01(b.dependentCount / 30),
      untested: b.testCount === 0 ? 1 : 0.15,
      routes: clamp01(b.routeCount / 20),
      sensitive: b.sensitive ? 1 : 0,
      size: clamp01(f.lines / 800),
      complexity: clamp01(f.complexity / 200),
    };
    const score = Math.round(Object.entries(W).reduce((s, [k, w]) => s + w * signals[k], 0) * 100);
    const reasons = [];
    if (b.dependentCount) reasons.push(`${b.dependentCount} dependents`);
    if (b.testCount === 0) reasons.push('untested');
    if (b.routeCount) reasons.push(`${b.routeCount} routes`);
    if (b.sensitive) reasons.push('sensitive');
    if (f.lines >= 500) reasons.push(`${f.lines}L god-file`);
    // The action that would move the needle most for this file.
    const action = b.testCount === 0 ? 'add tests' : f.lines >= 500 ? 'refactor / split' : 'harden';
    return {
      file: f.file,
      score,
      action,
      dependents: b.dependentCount,
      tested: b.testCount > 0,
      routes: b.routeCount,
      sensitive: b.sensitive,
      lines: f.lines,
      reasons,
    };
  });
  rows.sort((a, b) => b.score - a.score);
  return { scanned: files.length, top: rows.slice(0, limit) };
}
