import fs from 'node:fs';
import path from 'node:path';
import { CODE_DIRS, REPO_ROOT, REPO_FACTS } from '../config.js';
import { llmJson } from './llm.js';
import { evidenceFromHistory } from './proposalEvidence.js';
import { rulesFor } from '../memory/standingRules.js';
import { llmGate } from '../core/semaphore.js';
import { addFeature, topFunctions, listFeatures, countFeaturesByStatus } from '../db_iteration.js';
import { inventoryServices } from '../services/inventory.js';
import { vetTaskPaths } from './pathGuard.js';
import { emit } from '../bus.js';
import { log } from '../logger.js';

/**
 * The Surveyor.
 *
 * The backlog used to come from a web-research phase that ran every iteration and
 * invented "marketplace features" from the model's imagination — none of them tied
 * to a single real file in this repository. That is exactly how the fleet ended up
 * planning TypeScript microservices that don't exist.
 *
 * This replaces guessing with looking. Periodically (every N runs) the Surveyor
 * reads the ACTUAL code, gathers concrete evidence — real hotspots, real TODOs at
 * real line numbers, routes with no test, integration seams that are missing a
 * timeout — and turns THAT into backlog items, each pinned to a file that exists.
 * Nothing it proposes can reference a path the repo doesn't have, because every
 * proposal is vetted against the real tree before it's accepted.
 */

const SKIP = /node_modules|\.min\.|\.test\.|\.spec\.|__mocks__/;
const lg = log.for('surveyor');

/** Walk the code dirs, bounded, collecting file paths. */
function walk(dir, out = [], depth = 0) {
  if (depth > 6) return out;
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    if (e.name.startsWith('.') || /node_modules|dist|build|coverage/.test(e.name)) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out, depth + 1);
    else if (/\.(js|jsx|mjs|cjs)$/.test(e.name) && !SKIP.test(p)) out.push(p);
  }
  return out;
}

const rel = (abs) => path.relative(REPO_ROOT, abs).replace(/\\/g, '/');

/**
 * Gather hard evidence from the real code. Everything here is a fact with a file
 * (and often a line) behind it — the raw material the model turns into a backlog,
 * so it can't drift into fiction.
 */
async function gatherEvidence() {
  const files = CODE_DIRS.flatMap((d) => walk(path.join(REPO_ROOT, d)));

  const todos = []; // {file, line, text}
  const swallowed = []; // {file, line}  empty catch blocks
  const testedBasenames = new Set(); // which source files have a colocated test
  const sourceFiles = []; // {file, loc, hasTest:false placeholder}

  let scanned = 0;
  for (const abs of files) {
    let src;
    try {
      src = fs.readFileSync(abs, 'utf8');
    } catch {
      continue;
    }
    const r = rel(abs);

    // A test file records what it covers (by the name it imports / mirrors).
    if (/__tests__|\.test\.|\.spec\./.test(r)) {
      const base = path.basename(r).replace(/\.(test|spec)\./, '.').replace(/\.(js|jsx|mjs)$/, '');
      testedBasenames.add(base);
      continue;
    }

    sourceFiles.push({ file: r, loc: src.split('\n').length });

    const lines = src.split('\n');
    lines.forEach((line, i) => {
      const m = line.match(/(?:\/\/|\/\*|\*)\s*(TODO|FIXME|HACK|XXX)\b:?\s*(.*)/i);
      if (m && todos.length < 40) todos.push({ file: r, line: i + 1, text: (m[2] || '').trim().slice(0, 120) });
    });
    for (const m of src.matchAll(/catch\s*\([^)]*\)\s*\{\s*\}/g)) {
      if (swallowed.length < 20) swallowed.push({ file: r, line: src.slice(0, m.index).split('\n').length });
    }

    if (++scanned % 50 === 0) await new Promise((res) => setImmediate(res));
  }

  // Coverage gaps: substantial source files whose basename has no matching test.
  const coverageGaps = sourceFiles
    .filter((f) => f.loc >= 60)
    .filter((f) => {
      const base = path.basename(f.file).replace(/\.(js|jsx|mjs)$/, '');
      return !testedBasenames.has(base);
    })
    .filter((f) => /routes\/|lib\/|services\/|middleware\/|store\/|hooks\//.test(f.file))
    .slice(0, 25);

  // Hotspots straight from the catalogue (already grounded in real code).
  const hotspots = topFunctions(20)
    .filter((h) => h.complexity >= 8 || h.todos > 0 || h.fanIn >= 20)
    .map((h) => ({ file: h.path, name: h.name, complexity: h.complexity, fanIn: h.fanIn, todos: h.todos }));

  // Integration seams from the services inventory.
  const services = inventoryServices();
  const seamFindings = services.services
    .flatMap((s) => s.findings.map((f) => ({ ...f, service: s.name })))
    .slice(0, 15);

  return { fileCount: files.length, sourceCount: sourceFiles.length, todos, swallowed, coverageGaps, hotspots, seamFindings, servicesHealth: services.health };
}

/** Turn the evidence into a compact, model-readable brief. */
function evidenceBrief(ev) {
  const block = (title, rows) => (rows.length ? `${title}:\n${rows.join('\n')}` : '');
  return [
    `Repository: ${REPO_FACTS.language} · ${ev.sourceCount} source files · services integration health ${ev.servicesHealth}/100.`,
    block(
      'HOTSPOTS (heaviest real functions — candidates for a focused refactor or a test)',
      ev.hotspots.map((h) => `- ${h.file}#${h.name} — complexity ${h.complexity}, fan-in ${h.fanIn}${h.todos ? `, ${h.todos} TODO` : ''}`),
    ),
    block(
      'TODO / FIXME left in the code (real markers, real lines)',
      ev.todos.map((t) => `- ${t.file}:${t.line} — ${t.text || '(no text)'}`),
    ),
    block(
      'COVERAGE GAPS (substantial files with no colocated test)',
      ev.coverageGaps.map((c) => `- ${c.file} (${c.loc} lines)`),
    ),
    block(
      'SWALLOWED ERRORS (empty catch blocks)',
      ev.swallowed.map((s) => `- ${s.file}:${s.line}`),
    ),
    block(
      'INTEGRATION SEAMS (from the service mesh)',
      ev.seamFindings.map((f) => `- ${f.file}${f.line ? `:${f.line}` : ''} — ${f.detail}`),
    ),
  ]
    .filter(Boolean)
    .join('\n\n');
}

/**
 * Run a survey: read the code, propose a grounded backlog, and add the real ones.
 *
 * @param {object} opts
 * @param {number} [opts.maxNew]  how many items to try to add
 * @param {boolean} [opts.signal]
 * @returns {Promise<{summary, added, evidence}>}
 */
export async function survey({ maxNew = 12, signal, logger = lg } = {}) {
  emit('survey.started', {});
  logger.info?.('surveying the codebase for grounded backlog items…');

  const ev = await gatherEvidence();
  const existing = listFeatures({ limit: 80 }).map((f) => f.title);

  /*
   * Il nome del progetto NON va cablato qui.
   *
   * Questo prompt diceva "a codebase review of RentAll": vero per il progetto su cui è stato
   * scritto, falso per ogni altro che ISL governa. Un proponente convinto di guardare un altro
   * prodotto propone lavoro per quel prodotto — ed è lo stesso difetto che era già stato corretto
   * nel planner e qui era rimasto.
   */
  const system = `
You are a staff engineer doing a codebase review of THIS project (${REPO_FACTS.language}). What it
is and what must never break is described by the evidence and the briefing below — not by anything
you may assume from a name. Below is HARD EVIDENCE gathered from the actual repository — real
files, real line numbers, real gaps. Turn the most valuable of it into concrete, buildable
backlog items.

IRON RULE: every item MUST name a "file" that appears in the evidence above. Do not invent files,
directories, services, or a different tech stack. If it isn't in the evidence, you may not propose it.

Prefer, in order: a missing test for untested business logic; a real TODO/FIXME worth closing; a
swallowed error that hides a real failure; an integration seam missing a timeout or contract; a
genuine refactor of a hotspot that is measurably too complex. Each item is ONE focused change.

Return ONLY JSON: {"items":[{"title","description","file","area","priority","kind"}]} where
area is "backend"|"frontend"|"services"|"docs", priority is 1-100 (higher = more valuable),
kind is "test"|"fix"|"refactor"|"feature".`.trim();

  const user = [
    evidenceBrief(ev),
    /*
     * La storia, non solo il codice.
     *
     * Il proponente guardava esclusivamente lo stato PRESENTE del repository: file veri, righe
     * vere, lacune vere. Nulla gli diceva che su un certo file quattro tentativi su quattro erano
     * finiti in rollback, quindi lo riproponeva. È l'origine del problema che l'operatore aveva
     * descritto per primo — sprecare iterazioni per riottenere lo stesso fallimento.
     */
    evidenceFromHistory(),
    // Le regole permanenti: una proposta che le viola nasce già destinata a essere respinta.
    rulesFor('planner'),
    existing.length ? `\nAlready in the backlog (do NOT repeat):\n${existing.slice(0, 50).join('\n')}` : '',
    `\nPropose up to ${maxNew} items. Every "file" must be one from the evidence.`,
  ].filter(Boolean).join('\n');

  let items = [];
  let usage = { promptTokens: 0, evalTokens: 0 };
  try {
    const r = await llmGate.run(() => llmJson({ system, user, temperature: 0.4, signal }), signal);
    usage = r.usage || usage;
    items = Array.isArray(r.data?.items) ? r.data.items : Array.isArray(r.data) ? r.data : [];
  } catch (err) {
    if (err.message === 'interrupted') throw err;
    logger.warn?.(`survey LLM failed: ${err.message}`);
  }

  // Only keep items whose file is real. This is the guardrail that makes the whole
  // thing trustworthy — a surveyed backlog is grounded by construction.
  let added = 0;
  let rejected = 0;
  for (const it of items.slice(0, maxNew)) {
    if (!it?.title || !it?.file) {
      rejected++;
      continue;
    }
    const vet = vetTaskPaths({ kind: it.kind === 'feature' ? 'feature' : 'improvement', files: [it.file] });
    if (!vet.viable) {
      rejected++;
      logger.info?.(`dropped surveyed item "${String(it.title).slice(0, 50)}" — ${vet.reason}`);
      continue;
    }
    const target = vet.files[0];
    const id = addFeature({
      title: String(it.title).slice(0, 160),
      // Pin the real target file into the description so the planner inherits it.
      description: `Target: ${target}\n${String(it.description || '').slice(0, 700)}`,
      area: ['backend', 'frontend', 'services', 'docs'].includes(it.area) ? it.area : null,
      source: 'survey',
      priority: Math.min(100, Math.max(1, Number(it.priority) || 55)),
    });
    if (id) added++;
  }

  const counts = countFeaturesByStatus();
  const summary =
    `Surveyed ${ev.sourceCount} files → ${added} grounded backlog item(s)` +
    (rejected ? `, ${rejected} rejected (unreal/duplicate)` : '') +
    ` · backlog now ${counts.pending} pending`;
  emit('survey.finished', { added, rejected, evidence: { hotspots: ev.hotspots.length, todos: ev.todos.length, coverageGaps: ev.coverageGaps.length } });
  logger.info?.(summary);

  return { summary, added, rejected, evidence: ev, tokensIn: usage.promptTokens, tokensOut: usage.evalTokens };
}
