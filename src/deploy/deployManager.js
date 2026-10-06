import fs from 'node:fs';
import path from 'node:path';
import { BaseManager } from '../managers/baseManager.js';
import { REPO_ROOT } from '../config.js';
import { emit } from '../bus.js';
import { log } from '../logger.js';
import { llmJson } from '../iteration/llm.js';
import { notify, listIterations, getIteration } from '../db_iteration.js';
import { projectContextBlurb } from '../context/contextManager.js';
import { detectCloud } from './cloudDetect.js';
import {
  saveDeployPlan,
  latestPlan,
  addTerraformFinding,
  clearOpenTerraformFindings,
  listTerraformFindings,
  countOpenTerraformFindings,
} from './deployDb.js';

const MAX_TF_CHARS = 24_000;

/* ------------------------------ read helpers ------------------------------ */

function readTerraform(files) {
  let budget = MAX_TF_CHARS;
  const parts = [];
  for (const rel of files) {
    if (budget <= 0) break;
    try {
      const text = fs.readFileSync(path.join(REPO_ROOT, rel), 'utf8').slice(0, Math.max(1000, budget));
      parts.push(`### ${rel}\n${text}`);
      budget -= text.length;
    } catch {
      /* skip */
    }
  }
  return parts.join('\n\n');
}

/** The most recent landed code change, as a diff, to check infra against. */
function recentCodeDiff() {
  const committed = listIterations(10).find((i) => (i.status === 'committed' || i.status === 'promoted') && i.commitSha);
  if (!committed) return null;
  const full = getIteration(committed.id, { withDiff: true });
  return full?.diff ? { id: committed.id, title: full.planTitle, diff: full.diff.slice(0, 20_000) } : null;
}

/* ---------------------------- release strategy ---------------------------- */

const STRATEGY_SYSTEM = `You are a senior release/DevOps engineer. Given a web application's context and its detected
deployment surface (Terraform providers/resources, GCP/AWS signals, containers), define a concrete
PRODUCTION release strategy for the requested cloud. Return ONLY JSON:
{
  "strategy": "blue-green | canary | rolling | recreate — pick the best fit and name it",
  "summary": "2-3 sentences on how releases should proceed and why this strategy",
  "prerequisites": ["what must be true/ready before deploying"],
  "steps": ["ordered, concrete deploy steps for THIS cloud and stack (build, push, apply IaC, migrate, cut over, verify)"],
  "rollback": "exactly how to roll back this release",
  "risks": ["the real risks and how to mitigate them"],
  "terraform": ["infrastructure changes (if any) this release/strategy requires"]
}
Ground every step in the detected stack and cloud. Be specific (e.g. name the gcloud/aws commands or the CI stage). Max 10 steps.`;

export async function defineReleaseStrategy({ cloud = 'gcp', environment = 'production', signal } = {}) {
  const detection = detectCloud();
  const tf = detection.terraform.present ? readTerraform(detection.terraform.files.slice(0, 12)) : '(no Terraform in project)';
  const ctx = projectContextBlurb();

  const user = [
    ctx || 'No project context available.',
    `\nTARGET CLOUD: ${cloud.toUpperCase()} · ENVIRONMENT: ${environment}`,
    `\nDETECTED DEPLOYMENT SURFACE:\n${JSON.stringify({ terraform: { providers: detection.terraform.providers, resources: detection.terraform.resourceCount, types: detection.terraform.resourceTypes }, gcp: detection.gcp, aws: detection.aws, containers: detection.containers }, null, 2)}`,
    `\nTERRAFORM (excerpt):\n${tf}`,
  ].join('\n');

  const r = await llmJson({ system: STRATEGY_SYSTEM, user, temperature: 0.3, signal });
  const data = r.data || {};
  const plan = {
    cloud,
    environment,
    strategy: data.strategy || 'rolling',
    summary: data.summary || '',
    steps: Array.isArray(data.steps) ? data.steps.slice(0, 12) : [],
    prerequisites: Array.isArray(data.prerequisites) ? data.prerequisites : [],
    rollback: data.rollback || '',
    risks: Array.isArray(data.risks) ? data.risks : [],
    terraform: Array.isArray(data.terraform) ? data.terraform : [],
  };
  const id = saveDeployPlan(plan);
  emit('deploy.strategy', { cloud, id });
  log.info('deploy', `defined ${cloud} release strategy: ${plan.strategy}`);
  return { id, ...plan };
}

/* --------------------------- terraform drift ------------------------------ */

const DRIFT_SYSTEM = `You are an infrastructure reviewer. You are given a code change (diff) and the project's
Terraform/IaC. Decide whether the code change REQUIRES matching infrastructure changes and, if so,
what. Look for: new environment variables/secrets, new services/ports, new managed resources
(buckets, queues, databases, caches), new external dependencies, scaling or IAM needs, and anything
the code now assumes that the Terraform does not yet provide. Return ONLY JSON:
{"findings":[{"relPath":"terraform file or null","kind":"drift|missing|security|cost","severity":"low|medium|high","message":"what infra change the code now needs","suggestion":"the concrete Terraform change to make"}]}
If the code change needs no infra change, return {"findings":[]}. Be concrete and conservative. Max 10.`;

/**
 * Verify whether a landed code change requires Terraform/IaC updates. Runs after
 * changes land (and on demand). This is the guarantee the operator asked for:
 * every code change is checked against the infrastructure it runs on.
 */
export async function checkTerraformDrift({ signal, diff = null } = {}) {
  const detection = detectCloud();
  if (!detection.terraform.present) {
    emit('deploy.tf_checked', { findings: 0, skipped: 'no-terraform' });
    return { findings: [], skipped: true };
  }
  const change = diff ? { title: 'provided change', diff: String(diff).slice(0, 20_000) } : recentCodeDiff();
  if (!change) {
    emit('deploy.tf_checked', { findings: 0, skipped: 'no-change' });
    return { findings: [], skipped: 'no recent code change to check' };
  }

  const tf = readTerraform(detection.terraform.files.slice(0, 14));
  clearOpenTerraformFindings();
  let out = [];
  try {
    const r = await llmJson({
      system: DRIFT_SYSTEM,
      user: `CODE CHANGE: ${change.title || ''}\n\`\`\`diff\n${change.diff}\n\`\`\`\n\nPROJECT TERRAFORM:\n${tf}`,
      temperature: 0.2,
      signal,
    });
    out = Array.isArray(r.data?.findings) ? r.data.findings.slice(0, 10) : [];
  } catch (err) {
    log.warn('deploy', `terraform drift check failed: ${err.message}`);
  }
  for (const f of out) {
    addTerraformFinding({
      relPath: f.relPath || null,
      kind: f.kind || 'drift',
      severity: ['low', 'medium', 'high'].includes(f.severity) ? f.severity : 'medium',
      message: f.message,
      suggestion: f.suggestion || null,
    });
  }
  emit('deploy.tf_checked', { findings: out.length });
  if (out.length) {
    notify({
      kind: 'system',
      severity: 'warn',
      title: `Terraform may need updating (${out.length})`,
      body: out[0]?.message?.slice(0, 140),
      link: '#cloud',
    });
  }
  log.info('deploy', `terraform drift check — ${out.length} finding(s)`);
  return { findings: listTerraformFindings({ onlyOpen: true, limit: 50 }) };
}

/* -------------------------------- report ---------------------------------- */

export function deployReport() {
  const detection = detectCloud();
  return {
    detection,
    plans: {
      gcp: latestPlan('gcp'),
      aws: latestPlan('aws'),
      generic: latestPlan('generic'),
    },
    terraformFindings: listTerraformFindings({ onlyOpen: true, limit: 100 }),
  };
}

/* ------------------------------- manager ---------------------------------- */

export class DeploymentManager extends BaseManager {
  constructor() {
    super('Deployment', { icon: '🚀', accent: 'sky', role: 'Release strategy & infrastructure drift' });
    this.checking = false;
    // Every landed change is checked for infra impact (debounced, TF-only).
    this.on('deploy.promoted', () => this.autoDrift('promotion'));
    this.on('iteration.finished', (e) => {
      if (e?.status === 'committed') this.autoDrift('iteration');
    });
    for (const ev of ['deploy.strategy', 'deploy.tf_checked']) this.on(ev, () => this.analyze());
  }

  autoDrift(reason) {
    if (this.checking) return;
    const det = detectCloud();
    if (!det.terraform.present) return; // nothing to check
    this.checking = true;
    checkTerraformDrift({})
      .catch((e) => this.log.error(`auto drift check failed: ${e.message}`))
      .finally(() => {
        this.checking = false;
        this.analyze();
      });
    this.log.info(`checking terraform against the ${reason} change`);
  }

  analyze() {
    let det;
    let tfOpen;
    let gcp;
    let aws;
    try {
      det = detectCloud();
      tfOpen = countOpenTerraformFindings();
      gcp = latestPlan('gcp');
      aws = latestPlan('aws');
    } catch {
      this.setBrief({ status: 'idle', headline: 'No project database open.', stats: {} });
      return;
    }
    const stats = {
      clouds: det.clouds,
      terraformFiles: det.terraform.fileCount,
      terraformProviders: det.terraform.providers,
      openTerraformFindings: tfOpen,
      hasGcpStrategy: !!gcp,
      hasAwsStrategy: !!aws,
      dockerfile: det.containers.dockerfile,
    };

    let status = 'idle';
    let headline;
    const recommendations = [];
    if (!det.clouds.length && !det.terraform.present) {
      status = 'idle';
      headline = 'No cloud/IaC deployment surface detected in this project.';
    } else if (tfOpen > 0) {
      status = 'alert';
      headline = `${tfOpen} Terraform finding(s): landed code likely needs matching infrastructure changes.`;
      recommendations.push('Review the Terraform findings on the Cloud page — the code has drifted from the infra.');
    } else {
      status = 'watching';
      const cl = det.clouds.map((c) => c.toUpperCase()).join(' + ') || 'containers';
      headline = `Deploy target: ${cl} · ${det.terraform.fileCount} Terraform file(s)${gcp || aws ? ' · release strategy defined' : ' · no strategy yet'}.`;
      if (!gcp && det.gcp.active) recommendations.push('Define a GCP release strategy on the Cloud page.');
      if (!aws && det.aws.active) recommendations.push('Define an AWS release strategy on the Cloud page.');
    }
    this.setBrief({ status, headline, stats, recommendations });
  }
}
