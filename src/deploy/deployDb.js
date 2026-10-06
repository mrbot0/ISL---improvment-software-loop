import { db, registerSchema } from '../db.js';

/**
 * Per-project deployment store: the release strategies/plans the Deployment
 * manager produces (per cloud target), and the Terraform/IaC drift findings that
 * flag when landed code needs matching infrastructure changes.
 */
registerSchema(() => {
  db.exec(`
  CREATE TABLE IF NOT EXISTS deploy_plans (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    ts            INTEGER NOT NULL,
    cloud         TEXT NOT NULL,           -- gcp | aws | generic
    environment   TEXT NOT NULL DEFAULT 'production',
    strategy      TEXT NOT NULL,           -- e.g. blue-green | canary | rolling
    summary       TEXT,
    steps         TEXT NOT NULL DEFAULT '[]',
    prerequisites TEXT NOT NULL DEFAULT '[]',
    rollback      TEXT,
    risks         TEXT NOT NULL DEFAULT '[]',
    terraform     TEXT NOT NULL DEFAULT '[]', -- infra changes this release needs
    status        TEXT NOT NULL DEFAULT 'draft'
  );
  CREATE INDEX IF NOT EXISTS idx_deploy_cloud ON deploy_plans(cloud);

  CREATE TABLE IF NOT EXISTS terraform_findings (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    ts         INTEGER NOT NULL,
    rel_path   TEXT,
    kind       TEXT NOT NULL DEFAULT 'drift', -- drift | missing | security | cost
    severity   TEXT NOT NULL DEFAULT 'medium',
    message    TEXT NOT NULL,
    suggestion TEXT,
    resolved   INTEGER NOT NULL DEFAULT 0
  );
  CREATE INDEX IF NOT EXISTS idx_tf_resolved ON terraform_findings(resolved);
  `);
});

const now = () => Date.now();
const J = (v) => JSON.stringify(v ?? []);
const P = (v, d = []) => {
  if (v == null) return d;
  try {
    return JSON.parse(v);
  } catch {
    return d;
  }
};

/* ------------------------------- plans ------------------------------------ */

export function saveDeployPlan(plan) {
  const r = db
    .prepare(
      `INSERT INTO deploy_plans (ts, cloud, environment, strategy, summary, steps, prerequisites, rollback, risks, terraform, status)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'draft')`,
    )
    .run(
      now(),
      plan.cloud,
      plan.environment || 'production',
      plan.strategy || 'rolling',
      plan.summary || null,
      J(plan.steps),
      J(plan.prerequisites),
      plan.rollback || null,
      J(plan.risks),
      J(plan.terraform),
    );
  return Number(r.lastInsertRowid);
}

const rowToPlan = (r) => ({
  id: r.id,
  ts: r.ts,
  cloud: r.cloud,
  environment: r.environment,
  strategy: r.strategy,
  summary: r.summary,
  steps: P(r.steps),
  prerequisites: P(r.prerequisites),
  rollback: r.rollback,
  risks: P(r.risks),
  terraform: P(r.terraform),
  status: r.status,
});

export function latestPlan(cloud) {
  const r = db.prepare('SELECT * FROM deploy_plans WHERE cloud = ? ORDER BY id DESC LIMIT 1').get(cloud);
  return r ? rowToPlan(r) : null;
}

export const listPlansForCloud = (cloud, limit = 10) =>
  db.prepare('SELECT * FROM deploy_plans WHERE cloud = ? ORDER BY id DESC LIMIT ?').all(cloud, limit).map(rowToPlan);

/* ----------------------------- tf findings -------------------------------- */

export function addTerraformFinding(f) {
  db.prepare(
    'INSERT INTO terraform_findings (ts, rel_path, kind, severity, message, suggestion) VALUES (?, ?, ?, ?, ?, ?)',
  ).run(now(), f.relPath ?? null, f.kind || 'drift', f.severity || 'medium', String(f.message || '').slice(0, 1000), f.suggestion || null);
}

export function clearOpenTerraformFindings() {
  db.exec('DELETE FROM terraform_findings WHERE resolved = 0');
}

export const listTerraformFindings = ({ onlyOpen = true, limit = 200 } = {}) =>
  db
    .prepare(`SELECT * FROM terraform_findings ${onlyOpen ? 'WHERE resolved = 0' : ''} ORDER BY id DESC LIMIT ?`)
    .all(limit)
    .map((r) => ({
      id: r.id,
      ts: r.ts,
      relPath: r.rel_path,
      kind: r.kind,
      severity: r.severity,
      message: r.message,
      suggestion: r.suggestion,
      resolved: !!r.resolved,
    }));

export function resolveTerraformFinding(id) {
  db.prepare('UPDATE terraform_findings SET resolved = 1 WHERE id = ?').run(id);
}

export const countOpenTerraformFindings = () => db.prepare('SELECT COUNT(*) n FROM terraform_findings WHERE resolved = 0').get().n;
