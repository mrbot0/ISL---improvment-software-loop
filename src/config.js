import 'dotenv/config';
import fsSync from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { CODE_EXTENSIONS, codeGlobsUnder } from './languages.js';

const here = path.dirname(fileURLToPath(import.meta.url));

const bool = (v, dflt) => (v === undefined ? dflt : /^(1|true|yes|on)$/i.test(String(v)));
const int = (v, dflt) => (v === undefined || v === '' ? dflt : Number.parseInt(v, 10));

/* ═══════════════════════════════════════════════════════════════════════════
 * ISL — Improvement Software Loop
 *
 * A multi-project evolution of the single-project agent control plane it grew out
 * of. The single biggest architectural change from the original is that NOTHING
 * about the code being improved is a boot-time constant any more. The original
 * detected one repo root, one base branch and one product layout at import and
 * baked them in.
 *
 * Here, every one of those is a property of the *active project* and is resolved
 * on demand. `setActiveProjectConfig(project)` reassigns the exported live
 * bindings below; because ES modules expose live bindings, every consumer that
 * references e.g. REPO_ROOT at call-time follows the active project for free.
 * ═══════════════════════════════════════════════════════════════════════════ */

/* ------------------------- static, project-agnostic ----------------------- */

export const AGENTS_ROOT = path.resolve(here, '..');
export const DATA_DIR = path.join(AGENTS_ROOT, '.data');
/** Platform DB holds projects, users and sessions — one, shared across projects. */
export const PLATFORM_DB_PATH = path.join(DATA_DIR, 'platform.db');
/** Per-project data directory (its own SQLite DB lives here). */
export const projectDataDir = (projectId) => path.join(DATA_DIR, 'projects', String(projectId));
export const projectDbPath = (projectId) => path.join(projectDataDir(projectId), 'agents.db');

export const ollama = {
  host: (process.env.OLLAMA_HOST || 'http://127.0.0.1:11434').replace(/\/$/, ''),
  model: process.env.OLLAMA_MODEL || 'qwen3.6:latest',
  chatModel: process.env.OLLAMA_CHAT_MODEL || process.env.OLLAMA_MODEL || 'qwen3.6:latest',
  keepAlive: process.env.OLLAMA_KEEP_ALIVE || '30m',
  numCtx: int(process.env.OLLAMA_NUM_CTX, 32768),
  // Embedding model for the knowledge index's vector retrieval. Empty string disables vectors
  // (the index falls back to pure lexical BM25).
  embedModel: process.env.OLLAMA_EMBED_MODEL ?? 'nomic-embed-text',
};

/**
 * PER-ROLE model choice (ISL_IMPROVE §2): a cheap/fast model for triage (catalog, survey,
 * planning) and a stronger one for the work that decides quality (implement, review,
 * security). Configure with env vars ISL_MODEL_IMPLEMENT / _REVIEW / _SECURITY / _PLAN /
 * _RESEARCH; each defaults to OLLAMA_MODEL, so behaviour is unchanged until you set them.
 * This is the seam where a strong cloud/local model plugs into the phases that matter.
 */
const ROLE_MODELS = {
  implement: process.env.ISL_MODEL_IMPLEMENT,
  review: process.env.ISL_MODEL_REVIEW,
  security: process.env.ISL_MODEL_SECURITY,
  plan: process.env.ISL_MODEL_PLAN,
  research: process.env.ISL_MODEL_RESEARCH,
};
export const ROLE_KEYS = Object.keys(ROLE_MODELS);

/**
 * Runtime model overrides chosen by the operator in Settings. These are LIVE BINDINGS filled by
 * `core/models.js` at boot and whenever the choice changes, so a new model takes effect on the next
 * call with no restart. Precedence: operator setting → environment variable → built-in default.
 * (Kept here, rather than importing the DB into config, to avoid a circular import — the same
 * pattern the active-project config uses.)
 */
let _modelOverrides = { default: '', chat: '', embed: '', roles: {} };
export function setModelOverrides(o = {}) {
  _modelOverrides = { default: o.default || '', chat: o.chat || '', embed: o.embed || '', roles: o.roles || {} };
  // Keep the ollama object in sync so every existing reader (chat, embeddings) picks the change up.
  ollama.model = _modelOverrides.default || process.env.OLLAMA_MODEL || 'qwen3.6:latest';
  ollama.chatModel = _modelOverrides.chat || _modelOverrides.default || process.env.OLLAMA_CHAT_MODEL || process.env.OLLAMA_MODEL || 'qwen3.6:latest';
  ollama.embedModel = _modelOverrides.embed !== '' ? _modelOverrides.embed : (process.env.OLLAMA_EMBED_MODEL ?? 'nomic-embed-text');
}

export const modelFor = (role) => _modelOverrides.roles?.[role] || ROLE_MODELS[role] || ollama.model;

/**
 * LLM PROVIDER abstraction (ISL_IMPROVE §2). Default is local Ollama. Set
 * ISL_LLM_PROVIDER=openai to route to ANY OpenAI-compatible chat-completions API —
 * OpenAI, Anthropic-compat gateways, OpenRouter, Groq, Together, vLLM, or Ollama's own
 * /v1 endpoint — by giving ISL_LLM_BASE_URL and ISL_LLM_API_KEY. When unset, nothing
 * changes: the local Ollama path is used exactly as before.
 */
export const llm = {
  provider: (process.env.ISL_LLM_PROVIDER || 'ollama').toLowerCase(),
  baseUrl: (process.env.ISL_LLM_BASE_URL || '').replace(/\/$/, ''),
  apiKey: process.env.ISL_LLM_API_KEY || '',
};

export const server = {
  port: int(process.env.PORT, 7878),
};

export const authCfg = {
  // Seed admin. Password is NOT set here — the account is created "pending" and
  // the first person to log in with this email sets the password (owner claim).
  seedAdminEmail: (process.env.ADMIN_EMAIL || 'admin@example.com').toLowerCase(),
  sessionTtlMs: int(process.env.SESSION_TTL_HOURS, 24 * 7) * 3600_000,
  secret: process.env.AUTH_SECRET || 'isl-dev-secret-change-me',
};

export const autonomy = {
  loopIntervalSeconds: int(process.env.LOOP_INTERVAL_SECONDS, 900),
  autostartLoop: bool(process.env.AUTOSTART_LOOP, false),
  applyMode: process.env.APPLY_MODE === 'direct' ? 'direct' : 'branch',
  maxPendingProposals: int(process.env.MAX_PENDING_PROPOSALS, 20),
};

/**
 * Default code folder for the very first project seeded on a fresh install.
 * ISL improves OTHER codebases, so it cannot assume which one: unless
 * DEFAULT_PROJECT_PATH names a folder, the seeded project points at the
 * directory ISL was started from, and the operator repoints it from the
 * dashboard. A hardcoded path here seeded a project that does not exist on any
 * machine but the one it was written on.
 */
const defaultProjectPath = path.resolve(process.env.DEFAULT_PROJECT_PATH || process.cwd());
export const DEFAULT_PROJECT = {
  name: process.env.DEFAULT_PROJECT_NAME || path.basename(defaultProjectPath) || 'Default project',
  codePath: defaultProjectPath,
};

/**
 * Git identity ISL commits with INSIDE the project it improves. It must not name
 * the product ISL was first built against: those commits land in someone else's
 * history. Overridable so an operator can attribute them however they wish.
 */
export const AGENT_IDENTITY = {
  name: process.env.ISL_GIT_AUTHOR_NAME || 'ISL Agents',
  email: process.env.ISL_GIT_AUTHOR_EMAIL || 'agents@isl.local',
};

/* -------------------------- resolution primitives ------------------------- */

const exists = (root, rel) => {
  try {
    return fsSync.existsSync(path.join(root, rel));
  } catch {
    return false;
  }
};

const CANDIDATE_DIRS = [
  'backend/server',
  'backend/src',
  'backend/tests',
  'frontend/app',
  'frontend/src',
  'services',
  'docs',
];

function detectBaseBranch(root, override) {
  if (override) return override;
  try {
    const branch = execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], {
      cwd: root,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    return branch && branch !== 'HEAD' ? branch : 'main';
  } catch {
    return 'main';
  }
}

function detectRepoFacts(root, productDirs) {
  const listDir = (rel) => {
    try {
      return fsSync.readdirSync(path.join(root, rel), { withFileTypes: true });
    } catch {
      return [];
    }
  };
  let ts = 0;
  let js = 0;
  const sniff = (rel, depth = 0) => {
    if (depth > 3 || ts > 3) return;
    for (const e of listDir(rel)) {
      if (e.name === 'node_modules' || e.name.startsWith('.')) continue;
      const p = `${rel}/${e.name}`;
      if (e.isDirectory()) sniff(p, depth + 1);
      else if (/\.tsx?$/.test(e.name)) ts++;
      else if (/\.jsx?$/.test(e.name)) js++;
    }
  };
  for (const d of productDirs) sniff(d);
  const language = ts > js ? 'typescript' : 'javascript';
  const services = exists(root, 'services')
    ? listDir('services').filter((e) => e.isDirectory() && !e.name.startsWith('.')).map((e) => e.name)
    : [];
  const prismaSchema =
    ['backend/prisma_new/schema.prisma', 'backend/prisma/schema.prisma', 'prisma/schema.prisma'].find((r) => exists(root, r)) || null;
  const frontendDir = productDirs.find((d) => d.startsWith('frontend/')) || null;
  const backendDirs = productDirs.filter((d) => d.startsWith('backend/') && !d.includes('tests'));
  return {
    language,
    extensions: language === 'typescript' ? ['.ts', '.tsx'] : ['.js', '.jsx'],
    services,
    prismaSchema,
    frontendDir,
    backendDirs,
    productDirs,
  };
}

/**
 * Resolve the full project-specific config for a code folder. Pure — takes a
 * root and an optional base-branch override, returns everything the runtime
 * needs. `setActiveProjectConfig` applies the result to the live bindings.
 */
export function resolveProjectConfig({ id = 'default', codePath, baseBranch: baseBranchOverride } = {}) {
  const root = path.resolve(codePath || DEFAULT_PROJECT.codePath);
  const detectedDirs = CANDIDATE_DIRS.filter((d) => exists(root, d));

  // Polyglot / non-standard fallback: if none of the known product directories
  // exist (an ABAP repo, a Python service, a Go monolith, anything without a
  // backend/ or frontend/ layout), treat the WHOLE repository as the product
  // surface so the agents still run on the real code — in any language — rather
  // than on nothing. This is what lets ISL improve every kind of codebase.
  const wholeRepo = detectedDirs.length === 0;
  const productDirs = wholeRepo ? ['.'] : detectedDirs;
  const codeDirs = productDirs.filter((d) => d !== 'docs' && !d.includes('tests'));

  // Every code file, in every known language, under the product surface — the
  // scope that makes an agent language-agnostic.
  const allCodeGlobs = wholeRepo
    ? CODE_EXTENSIONS.map((e) => `**/*${e}`)
    : productDirs.flatMap((d) => codeGlobsUnder(d));

  const surface = {
    backend: detectedDirs.filter((d) => d.startsWith('backend/') && !d.includes('tests')).map((d) => `${d}/**/*.js`),
    frontend: detectedDirs.filter((d) => d.startsWith('frontend/')).flatMap((d) => [`${d}/**/*.jsx`, `${d}/**/*.js`]),
    services: exists(root, 'services') ? ['services/**/*.js'] : [],
    tests: [
      ...detectedDirs.filter((d) => d.includes('tests')).map((d) => `${d}/**`),
      ...detectedDirs.filter((d) => d.startsWith('backend/') && !d.includes('tests')).map((d) => `${d}/**/__tests__/**`),
      ...(exists(root, 'services') ? ['services/**/__tests__/**'] : []),
    ],
    all: allCodeGlobs, // all code files, all languages
  };

  return {
    id,
    repoRoot: root,
    baseBranch: detectBaseBranch(root, baseBranchOverride),
    workBranch: process.env.WORK_BRANCH || 'agents/auto-improve',
    productDirs,
    codeDirs,
    productWriteGlobs: wholeRepo ? ['**'] : productDirs.map((d) => `${d}/**`),
    surfaceGlobs: surface,
    repoFacts: detectRepoFacts(root, productDirs),
    worktreeDir: path.join(os.tmpdir(), 'isl-agent-worktrees', String(id)),
  };
}

/* --------------------- live, active-project bindings ---------------------- */
// Reassigned by setActiveProjectConfig(). Consumers reference these at call
// time and therefore always see the active project's values (ES live bindings).

export let ACTIVE_PROJECT_ID = null;
export let REPO_ROOT = DEFAULT_PROJECT.codePath;
export let BASE_BRANCH = 'main';
export let WORK_BRANCH = process.env.WORK_BRANCH || 'agents/auto-improve';
export let PRODUCT_DIRS = [];
export let CODE_DIRS = [];
export let PRODUCT_WRITE_GLOBS = [];
export let SURFACE_GLOBS = { backend: [], frontend: [], services: [], tests: [], all: [] };
export let REPO_FACTS = {
  language: 'javascript',
  extensions: ['.js', '.jsx'],
  services: [],
  prismaSchema: null,
  frontendDir: null,
  backendDirs: [],
  productDirs: [],
};
export let WORKTREE_DIR = path.join(os.tmpdir(), 'isl-agent-worktrees', 'default');

/** Apply a resolved project config to the live bindings. */
export function setActiveProjectConfig(resolved) {
  ACTIVE_PROJECT_ID = resolved.id;
  REPO_ROOT = resolved.repoRoot;
  BASE_BRANCH = resolved.baseBranch;
  WORK_BRANCH = resolved.workBranch;
  PRODUCT_DIRS = resolved.productDirs;
  CODE_DIRS = resolved.codeDirs;
  PRODUCT_WRITE_GLOBS = resolved.productWriteGlobs;
  SURFACE_GLOBS = resolved.surfaceGlobs;
  REPO_FACTS = resolved.repoFacts;
  WORKTREE_DIR = resolved.worktreeDir;
  return resolved;
}

/**
 * The autonomous iteration engine's runtime knobs. `baseBranch` / `workBranch`
 * are getters so they track the active project after a switch.
 */
export const iteration = {
  get baseBranch() {
    return BASE_BRANCH;
  },
  get workBranch() {
    return WORK_BRANCH;
  },
  intervalSeconds: int(process.env.ITERATION_INTERVAL_SECONDS, 120),
  autostart: bool(process.env.ITERATION_AUTOSTART, false),
  // Effectively unlimited by default — the loop is meant to run continuously. The cap
  // exists only as an opt-in throttle (set MAX_ITERATIONS_PER_DAY) and, when reached,
  // the loop skips cleanly rather than erroring or pausing.
  maxPerDay: int(process.env.MAX_ITERATIONS_PER_DAY, 100000),
  // Watchdog: abort an iteration that runs longer than this, so a hung LLM call
  // can never freeze the loop (it would sit "running" forever and never tick again).
  maxMinutes: int(process.env.ITERATION_MAX_MINUTES, 30),
};

/* ------------------------------- guardrails ------------------------------- */

export const DENY_GLOBS = [
  '**/node_modules/**',
  '**/.git/**',
  '**/dist/**',
  '**/build/**',
  '**/coverage/**',
  '**/.data/**',
  'agents/**',
  '_archive/**',
  '.claude/**',
  '**/.claude/**',
  'graphify-out/**',
  'logs/**',
  '**/*.bundle',
  '**/uploads/**',
  '**/package-lock.json',
  '**/*.png',
  '**/*.jpg',
  '**/*.jpeg',
  '**/*.gif',
  '**/*.pdf',
  '**/*.pptx',
  '**/*.ico',
  '**/*.woff*',
];

export const SECRET_GLOBS = ['**/.env', '**/.env.*', '**/*.pem', '**/*.key', '**/id_rsa*'];

export const MAX_READ_BYTES = 16_000;
export const TOOL_HISTORY_BUDGET = 48_000;
export const MAX_AGENT_STEPS = 24;
// 14 was too tight: a task that reads a couple of files, writes, and runs tests can
// legitimately need ~10 steps, and a model that re-reads before committing exhausted
// the budget and finished with nothing. 20 gives the margin without letting a truly
// stuck task run forever (the iteration watchdog still bounds total wall time).
export const IMPLEMENTER_MAX_STEPS = int(process.env.IMPLEMENTER_MAX_STEPS, 20);
