import fs from 'node:fs';
import path from 'node:path';
import { BaseManager } from '../managers/baseManager.js';
import { REPO_ROOT, REPO_FACTS, PRODUCT_DIRS } from '../config.js';
import { emit } from '../bus.js';
import { log } from '../logger.js';
import { llmJson } from '../iteration/llm.js';
import { notify } from '../db_iteration.js';
import { markContextReady } from '../platform/projects.js';
import { ACTIVE_PROJECT_ID } from '../config.js';
import { ingestDocuments } from './ingest.js';
import { refreshCodeStats, getCodeStats } from './codeScan.js';
import {
  listDocuments,
  getProfile,
  setProfile,
  listQuestions,
  replaceQuestions,
  answerQuestion as dbAnswerQuestion,
  countPendingQuestions,
  documentStats,
  addDocFinding,
  clearOpenFindings,
  listFindings,
  markDocumentsStale,
  getDocumentByPath,
} from './contextDb.js';

/* --------------------------------- corpus --------------------------------- */

// Docs whose names signal they describe the whole system get priority in the
// bounded corpus we feed the model.
const PRIORITY = /readme|architecture|overview|design|adr|spec|contributing|getting.?started|docs?\//i;
const CORPUS_BUDGET = 42_000;

function buildCorpus() {
  const docs = listDocuments();
  const ranked = [...docs].sort((a, b) => {
    const pa = PRIORITY.test(a.relPath) ? 0 : 1;
    const pb = PRIORITY.test(b.relPath) ? 0 : 1;
    return pa - pb || b.chars - a.chars;
  });
  let budget = CORPUS_BUDGET;
  const parts = [];
  for (const d of ranked) {
    if (budget <= 0) break;
    const full = getDocumentByPath(d.relPath, { withText: true });
    const text = (full?.text || '').trim();
    if (!text) continue;
    const slice = text.slice(0, Math.min(text.length, Math.max(600, Math.floor(budget * 0.4))));
    parts.push(`### DOCUMENT: ${d.relPath}\n${slice}`);
    budget -= slice.length + d.relPath.length;
  }
  return parts.join('\n\n');
}

/** A compact description of the code layout, so the model isn't guessing. */
function layoutSummary() {
  const lines = [
    `Language: ${REPO_FACTS.language}`,
    `Product directories: ${PRODUCT_DIRS.join(', ') || '(none detected)'}`,
  ];
  if (REPO_FACTS.services?.length) lines.push(`Services: ${REPO_FACTS.services.join(', ')}`);
  if (REPO_FACTS.prismaSchema) lines.push(`Prisma schema: ${REPO_FACTS.prismaSchema}`);
  // A shallow top-level listing anchors the model to what actually exists.
  try {
    const top = fs
      .readdirSync(REPO_ROOT, { withFileTypes: true })
      .filter((e) => !e.name.startsWith('.') && e.name !== 'node_modules')
      .slice(0, 40)
      .map((e) => (e.isDirectory() ? `${e.name}/` : e.name));
    lines.push(`Top-level entries: ${top.join(', ')}`);
  } catch {
    /* ignore */
  }
  return lines.join('\n');
}

/* ------------------------------ profile build ----------------------------- */

const PROFILE_SYSTEM = `You are the Context Manager for an autonomous software-improvement platform.
Your job is to read a project's documentation and code layout and produce a precise, grounded
context profile that other AI agents will rely on to improve the code correctly. Think like a new
senior engineer writing the onboarding note they wish they'd had.

Return ONLY JSON with this shape:
{
  "whatItIs": "one or two sentences: what this application IS",
  "objective": "the product goal / the problem it solves for its users",
  "audience": "who uses it",
  "stack": ["concrete technologies you have EVIDENCE for"],
  "keyFlows": ["the most important end-to-end flows / capabilities"],
  "architecture": "2-3 sentences on how the pieces fit together (services, data flow, boundaries)",
  "areas": [
    {"name": "backend|frontend|services|infra|<module>", "path": "the directory it lives in",
     "responsibility": "what this area is responsible for",
     "cautions": "what an agent editing here must be careful about (contracts, invariants, gotchas)"}
  ],
  "invariants": ["non-negotiable rules that must NEVER be broken — e.g. 'a booking may never overlap another for the same listing', 'money movements must be idempotent'"],
  "risks": ["the most sensitive/fragile places where a careless change would cause real damage"],
  "glossary": [{"term": "...", "definition": "..."}],
  "docHighlights": [{"path": "relative/path", "why": "what this doc covers"}],
  "summary": "a tight 3-4 sentence executive summary"
}
Ground every claim in the documents or the layout. Derive "areas" from the directories that actually
exist. Derive "invariants" from the domain the docs describe — these are the guardrails other agents
must respect, so be concrete and correct. If the docs are thin, say so in the summary, keep the stack
to what the layout proves, and leave arrays you cannot ground as []. Do not invent features.`;

const QUESTIONS_SYSTEM = `You are the Context Manager onboarding a new project. Produce AT MOST 10 targeted
questions whose answers would let improvement agents work safely and correctly (e.g. the product's
non-negotiable invariants, the primary users, what "done" means, deployment target, compliance limits,
areas that must not be touched, performance/scale expectations).

CRUCIAL: for each question, if the documentation or layout ALREADY answers it confidently, fill "answer"
and set "source":"auto" with a short "rationale" citing the evidence. Only if the answer is genuinely
NOT derivable from what you were given, leave "answer" null and set "source":"pending" — these are the
gaps a human must fill. Prefer answering; ask the human only for true gaps.

Return ONLY JSON: {"questions":[{"question":"...","answer":"... or null","source":"auto|pending","rationale":"..."}]}
Order the questions from most to least important. Never exceed 10.`;

/**
 * Build (or rebuild) the project context: ingest docs, derive the profile, and
 * generate the ≤10 onboarding questions (auto-answered where the docs suffice).
 */
export async function buildContext({ signal, force = false } = {}) {
  const ingest = await ingestDocuments({ force });
  // Validate what code is actually present and in which languages.
  const codeStats = refreshCodeStats();
  const corpus = buildCorpus();
  const layout = layoutSummary();
  const docList = listDocuments()
    .map((d) => `- ${d.relPath} (${d.type}${d.stale ? ', STALE' : ''})`)
    .join('\n');

  const composition = (codeStats.byLanguage || [])
    .filter((l) => l.pct != null)
    .slice(0, 8)
    .map((l) => `${l.lang} ${l.pct}%`)
    .join(', ');
  const userMsg = `PROJECT CODE LAYOUT\n${layout}\n\nCODE COMPOSITION (${codeStats.totalFiles} files, ${codeStats.totalLines} lines)\n${composition || '(none detected)'}\n\nDOCUMENT INDEX (${ingest.stats.total} docs)\n${docList || '(no documents found)'}\n\nDOCUMENTATION CORPUS\n${corpus || '(no readable documentation)'}\n`;

  let profile = null;
  let questions = [];
  try {
    const p = await llmJson({ system: PROFILE_SYSTEM, user: userMsg, temperature: 0.3, signal });
    profile = p.data;
  } catch (err) {
    log.warn('context', `profile generation failed: ${err.message}`);
  }
  try {
    const q = await llmJson({
      system: QUESTIONS_SYSTEM,
      user: `${userMsg}\n\nDERIVED PROFILE\n${JSON.stringify(profile ?? {}, null, 2)}`,
      temperature: 0.4,
      signal,
    });
    questions = Array.isArray(q.data?.questions) ? q.data.questions.slice(0, 10) : [];
  } catch (err) {
    log.warn('context', `question generation failed: ${err.message}`);
  }

  if (profile) setProfile(profile);
  if (questions.length) replaceQuestions(questions);

  const pending = countPendingQuestions();
  // The project is "context ready" once we have a profile and no open gaps.
  const ready = !!profile && pending === 0;
  if (ACTIVE_PROJECT_ID) markContextReady(ACTIVE_PROJECT_ID, ready);
  emit('context.built', { docs: ingest.stats.total, pending, ready });
  notify({
    kind: 'system',
    severity: pending ? 'warn' : 'info',
    title: pending
      ? `Context built — ${pending} question(s) need your input`
      : 'Project context is ready',
    body: profile?.summary || null,
    link: '#context',
  });
  return { profile: getProfile(), questions: listQuestions(), ingest, pending, ready };
}

export function onboardingStatus() {
  return {
    profile: getProfile(),
    questions: listQuestions(),
    documents: documentStats(),
    codeStats: getCodeStats(),
    pending: countPendingQuestions(),
    findings: listFindings({ onlyOpen: true, limit: 50 }),
  };
}

export function answerContextQuestion(id, answer) {
  const q = dbAnswerQuestion(id, answer);
  const pending = countPendingQuestions();
  if (ACTIVE_PROJECT_ID && pending === 0 && getProfile()) markContextReady(ACTIVE_PROJECT_ID, true);
  emit('context.answered', { id, pending });
  return { question: q, pending };
}

/**
 * A compact context blurb for injection into the improvement agents' prompts so
 * they know what the project actually is. This is how the Context Manager
 * "makes the documentation available" to the rest of the fleet.
 */
export function projectContextBlurb() {
  const p = getProfile();
  if (!p) return '';
  const answered = listQuestions().filter((q) => q.answer && q.answer.trim());
  const facts = answered.slice(0, 8).map((q) => `- ${q.question} → ${q.answer}`).join('\n');
  const areas = Array.isArray(p.areas) && p.areas.length
    ? p.areas.slice(0, 8).map((a) => `- ${a.name}${a.path ? ` (${a.path})` : ''}: ${a.responsibility || ''}`).join('\n')
    : '';
  const invariants = Array.isArray(p.invariants) && p.invariants.length
    ? p.invariants.slice(0, 8).map((i) => `- ${i}`).join('\n')
    : '';
  return [
    'PROJECT CONTEXT (from the Context Manager — treat as ground truth about this app):',
    p.whatItIs ? `What it is: ${p.whatItIs}` : '',
    p.objective ? `Objective: ${p.objective}` : '',
    p.stack?.length ? `Stack: ${p.stack.join(', ')}` : '',
    p.architecture ? `Architecture: ${p.architecture}` : '',
    p.keyFlows?.length ? `Key flows: ${p.keyFlows.join('; ')}` : '',
    areas ? `Areas of the codebase:\n${areas}` : '',
    invariants ? `INVARIANTS you must never break:\n${invariants}` : '',
    facts ? `Known constraints:\n${facts}` : '',
  ]
    .filter(Boolean)
    .join('\n');
}

/**
 * The Context Manager's brief for one area of the codebase — its responsibility and
 * the cautions an agent editing there must respect. Consumed by the Context Agent to
 * tell each task-owner exactly what to watch for in the part of the code they touch.
 */
export function areaBrief(area) {
  if (!area) return '';
  const p = getProfile();
  const areas = Array.isArray(p?.areas) ? p.areas : [];
  const a = areas.find(
    (x) => x?.name && (String(x.name).toLowerCase() === String(area).toLowerCase() || String(x.path || '').toLowerCase().includes(String(area).toLowerCase())),
  );
  if (!a) return '';
  return [
    `Your area — ${a.name}${a.path ? ` (${a.path})` : ''}: ${a.responsibility || ''}`.trim(),
    a.cautions ? `Watch out: ${a.cautions}` : '',
  ]
    .filter(Boolean)
    .join('\n');
}

/* --------------------------- doc-verifier agent --------------------------- */

// Paths a doc references that don't exist any more are the clearest signal a doc
// has drifted from the code. Cheap, deterministic, and high-signal.
const PATH_RE = /\b((?:backend|frontend|services|src|app|lib|docs|packages)\/[A-Za-z0-9_\-./]+\.[A-Za-z0-9]{1,5})\b/g;

function deterministicStaleness() {
  const stale = [];
  for (const d of listDocuments()) {
    const full = getDocumentByPath(d.relPath, { withText: true });
    const text = full?.text || '';
    const refs = new Set();
    let m;
    PATH_RE.lastIndex = 0;
    while ((m = PATH_RE.exec(text)) && refs.size < 60) refs.add(m[1]);
    const missing = [...refs].filter((r) => {
      try {
        return !fs.existsSync(path.join(REPO_ROOT, r));
      } catch {
        return false;
      }
    });
    if (missing.length >= 2) stale.push({ relPath: d.relPath, missing });
  }
  return stale;
}

const VERIFY_SYSTEM = `You are the Documentation Verifier. Given a project's code layout and its document index,
identify concrete documentation problems. Return ONLY JSON:
{"findings":[{"relPath":"path or null","kind":"missing|coverage|stale|drift|quality","severity":"low|medium|high","message":"...","detail":"..."}]}
Focus on: major code areas with NO documentation (coverage/missing), docs that contradict the detected
layout (drift), and docs that are clearly out of date (stale). Be specific and cite paths. Max 12 findings.`;

export async function verifyDocumentation({ signal } = {}) {
  await ingestDocuments({});
  clearOpenFindings(['stale', 'coverage', 'missing', 'drift', 'quality']);

  // 1) Deterministic staleness from broken path references.
  const stale = deterministicStaleness();
  const staleNames = stale.map((s) => s.relPath);
  if (staleNames.length) markDocumentsStale(staleNames);
  for (const s of stale) {
    addDocFinding({
      relPath: s.relPath,
      kind: 'stale',
      severity: 'medium',
      message: `${s.relPath} references ${s.missing.length} path(s) that no longer exist`,
      detail: s.missing.slice(0, 8).join(', '),
    });
  }

  // 2) LLM coverage / drift assessment.
  const layout = layoutSummary();
  const docList = listDocuments().map((d) => `- ${d.relPath} (${d.type})`).join('\n') || '(none)';
  let llmFindings = [];
  try {
    const r = await llmJson({
      system: VERIFY_SYSTEM,
      user: `CODE LAYOUT\n${layout}\n\nDOCUMENT INDEX\n${docList}\n\nCORPUS\n${buildCorpus().slice(0, 20000)}`,
      temperature: 0.3,
      signal,
    });
    llmFindings = Array.isArray(r.data?.findings) ? r.data.findings.slice(0, 12) : [];
  } catch (err) {
    log.warn('context', `doc verify LLM step failed: ${err.message}`);
  }
  for (const f of llmFindings) {
    addDocFinding({ relPath: f.relPath || null, kind: f.kind || 'quality', severity: f.severity || 'medium', message: f.message, detail: f.detail || null });
  }

  const findings = listFindings({ onlyOpen: true, limit: 100 });
  emit('docs.verified', { findings: findings.length, stale: staleNames.length });
  log.info('context', `documentation verified — ${findings.length} finding(s), ${staleNames.length} stale doc(s)`);
  return { findings, stale: staleNames };
}

/* --------------------------- doc-updater agent ---------------------------- */

/**
 * Runs when work is merged to the base branch. Re-ingests the docs, re-checks
 * for drift, flags docs that reference code the merge touched, and drafts a
 * suggested update note. It FLAGS and SUGGESTS rather than rewriting docs
 * silently — a human keeps the pen on the documentation.
 */
export async function updateDocsOnMerge(payload = {}, { signal } = {}) {
  await ingestDocuments({ force: false });
  const stale = deterministicStaleness();
  const names = stale.map((s) => s.relPath);
  if (names.length) markDocumentsStale(names);

  clearOpenFindings(['drift']);
  for (const s of stale) {
    addDocFinding({
      relPath: s.relPath,
      kind: 'drift',
      severity: 'medium',
      message: `After the merge, ${s.relPath} references ${s.missing.length} missing path(s) — likely needs updating`,
      detail: s.missing.slice(0, 8).join(', '),
    });
  }
  if (names.length) {
    notify({
      kind: 'system',
      severity: 'warn',
      title: `Docs may be out of date after merge (${names.length})`,
      body: names.slice(0, 5).join(', '),
      link: '#context',
    });
  }
  emit('docs.updated_check', { stale: names.length, ...payload });
  log.info('context', `post-merge doc check — ${names.length} doc(s) flagged for update`);
  return { stale: names };
}

/* ---------------------------- manager (brief) ----------------------------- */

export class ContextManager extends BaseManager {
  constructor() {
    super('Context', { icon: '📚', accent: 'indigo', role: 'Project context & documentation' });
    // Re-check docs when work merges to the base branch (the doc-updater trigger).
    this.on('deploy.promoted', (e) => {
      updateDocsOnMerge(e || {}).catch((err) => this.log.error(`doc-updater failed: ${err.message}`));
    });
    for (const ev of ['context.built', 'context.answered', 'docs.verified', 'docs.updated_check']) this.on(ev, () => this.analyze());
  }

  analyze() {
    let profile;
    let docs;
    let pending;
    let findings;
    try {
      profile = getProfile();
      docs = documentStats();
      pending = countPendingQuestions();
      findings = listFindings({ onlyOpen: true, limit: 100 });
    } catch {
      this.setBrief({ status: 'idle', headline: 'No project database open.', stats: {} });
      return;
    }
    const stats = {
      documents: docs.total,
      docTypes: docs.byType,
      staleDocs: docs.stale,
      pendingQuestions: pending,
      openFindings: findings.length,
      contextReady: !!profile && pending === 0,
    };

    let status = 'watching';
    let headline;
    const recommendations = [];
    if (!profile) {
      status = 'alert';
      headline = `No context yet — run onboarding to analyse the ${docs.total} document(s) and define the project.`;
      recommendations.push('Open the Context tab and press “Build context” to profile the project from its docs.');
    } else if (pending > 0) {
      status = 'alert';
      headline = `Context drafted from ${docs.total} docs — ${pending} question(s) still need your answer.`;
      recommendations.push(`Answer the ${pending} open onboarding question(s) so agents work with full context.`);
    } else if (findings.length) {
      status = 'watching';
      headline = `Context ready. ${findings.length} documentation finding(s) open${docs.stale ? `, ${docs.stale} stale doc(s)` : ''}.`;
      recommendations.push('Review the documentation findings — some docs have drifted from the code.');
    } else {
      status = 'idle';
      headline = `Context ready · ${docs.total} document(s) indexed · documentation healthy.`;
    }
    this.setBrief({ status, headline, stats, recommendations, summary: profile?.summary || '' });
  }
}
