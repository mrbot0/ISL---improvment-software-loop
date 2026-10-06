import fs from 'node:fs';
import path from 'node:path';
import { REPO_ROOT } from '../config.js';

/**
 * Detects the deployment surface of the active project: Terraform / IaC files
 * and their providers, plus GCP- and AWS-specific signals. This is what lets the
 * Deployment manager reason about how to ship the app and whether infrastructure
 * needs to change alongside the code.
 */

const IGNORE = new Set(['node_modules', '.git', 'dist', 'build', '.data', 'coverage', '.next', 'vendor', '.claude', 'tmp', '.terraform', '.cache']);
const MAX_READ = 200_000;

function walk(root, onFile) {
  const visit = (dir, depth) => {
    if (depth > 8) return;
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (e.isDirectory()) {
        if (IGNORE.has(e.name) || e.name.startsWith('.')) continue;
        visit(path.join(dir, e.name), depth + 1);
      } else if (e.isFile()) {
        onFile(path.join(dir, e.name), e.name);
      }
    }
  };
  visit(root, 0);
}

const rel = (root, abs) => path.relative(root, abs).split(path.sep).join('/');
const readSafe = (abs) => {
  try {
    if (fs.statSync(abs).size > MAX_READ) return '';
    return fs.readFileSync(abs, 'utf8');
  } catch {
    return '';
  }
};

// The scan walks the repo, so cache it briefly — the manager calls detectCloud
// on several events and we don't want a full walk each time.
let _cache = { root: null, at: 0, value: null };

export function detectCloud(root = REPO_ROOT) {
  if (_cache.value && _cache.root === root && Date.now() - _cache.at < 30_000) return _cache.value;
  const result = scanCloud(root);
  _cache = { root, at: Date.now(), value: result };
  return result;
}

function scanCloud(root) {
  const terraformFiles = [];
  const providers = new Set();
  let resourceCount = 0;
  const resourceTypes = new Set();
  const gcp = { signals: [], resources: 0 };
  const aws = { signals: [], resources: 0 };
  let hasDockerfile = false;
  const k8s = [];

  walk(root, (abs, name) => {
    const r = rel(root, abs);
    const lower = name.toLowerCase();

    // Terraform
    if (lower.endsWith('.tf')) {
      terraformFiles.push(r);
      const text = readSafe(abs);
      for (const m of text.matchAll(/provider\s+"([a-z0-9_-]+)"/gi)) providers.add(m[1].toLowerCase());
      for (const m of text.matchAll(/resource\s+"([a-z0-9_]+)"/gi)) {
        resourceCount++;
        resourceTypes.add(m[1]);
        if (m[1].startsWith('google_')) gcp.resources++;
        if (m[1].startsWith('aws_')) aws.resources++;
      }
      if (/provider\s+"google"/i.test(text)) providers.add('google');
      if (/provider\s+"aws"/i.test(text)) providers.add('aws');
    }

    // GCP signals
    if (lower === 'cloudbuild.yaml' || lower === 'cloudbuild.yml') gcp.signals.push(`Cloud Build config (${r})`);
    if (lower === 'app.yaml' || /^app\..*\.yaml$/.test(lower)) gcp.signals.push(`App Engine app.yaml (${r})`);
    if (lower === '.gcloudignore') gcp.signals.push('.gcloudignore present');
    if (lower === 'service.yaml' && readSafe(abs).includes('serving.knative')) gcp.signals.push(`Cloud Run service (${r})`);

    // AWS signals
    if (lower === 'serverless.yml' || lower === 'serverless.yaml') aws.signals.push(`Serverless Framework (${r})`);
    if (lower === 'samconfig.toml') aws.signals.push('AWS SAM config');
    if (lower === 'buildspec.yml' || lower === 'buildspec.yaml') aws.signals.push(`CodeBuild buildspec (${r})`);
    if (lower === 'cdk.json') aws.signals.push('AWS CDK app');
    if ((lower === 'template.yaml' || lower === 'template.yml') && /AWSTemplateFormatVersion|Transform:\s*AWS::Serverless/i.test(readSafe(abs)))
      aws.signals.push(`CloudFormation/SAM template (${r})`);
    if (lower === 'task-definition.json' || /ecs.*task/.test(lower)) aws.signals.push(`ECS task definition (${r})`);

    // Containers / k8s
    if (lower === 'dockerfile' || lower.endsWith('.dockerfile')) hasDockerfile = true;
    if ((lower.endsWith('.yaml') || lower.endsWith('.yml')) && k8s.length < 30) {
      const t = readSafe(abs);
      if (/^\s*kind:\s*(Deployment|Service|Ingress|StatefulSet|DaemonSet)\b/im.test(t)) k8s.push(r);
    }
  });

  const clouds = [];
  if (providers.has('google') || gcp.signals.length || gcp.resources) clouds.push('gcp');
  if (providers.has('aws') || aws.signals.length || aws.resources) clouds.push('aws');
  if (providers.has('azurerm')) clouds.push('azure');

  return {
    terraform: {
      present: terraformFiles.length > 0,
      files: terraformFiles.slice(0, 200),
      fileCount: terraformFiles.length,
      providers: [...providers],
      resourceCount,
      resourceTypes: [...resourceTypes].slice(0, 40),
    },
    gcp: { active: clouds.includes('gcp'), signals: gcp.signals.slice(0, 20), resources: gcp.resources },
    aws: { active: clouds.includes('aws'), signals: aws.signals.slice(0, 20), resources: aws.resources },
    clouds,
    containers: { dockerfile: hasDockerfile, kubernetes: k8s },
    scannedAt: Date.now(),
  };
}
