import fs from 'node:fs';
import path from 'node:path';
import { webSearch, readPage } from './websearch.js';
import { llmJson } from './llm.js';
import { addFeature, countFeaturesByStatus, listFeatures } from '../db_iteration.js';
import { createRun, finishRun, createProposal, setProposalStatus } from '../db.js';
import { getProfile } from '../context/contextDb.js';
import { projectContextBlurb } from '../context/contextManager.js';
// Live bindings — read at call time so switching projects redirects them.
import { REPO_FACTS, REPO_ROOT } from '../config.js';
import { researchFocus, scopeBrief } from '../core/scope.js';
import { evidenceFromHistory } from './proposalEvidence.js';
import { rulesFor } from '../memory/standingRules.js';
import { emit } from '../bus.js';
import { log } from '../logger.js';

/**
 * Research: searches the web for the best features to add to THIS project — both
 * by matching its stack/domain and by looking at what similar/competitor apps
 * offer — then turns the findings into concrete, buildable ideas. Ideas span the
 * whole app: backend, services, AND the frontend (making it more beautiful and
 * usable), not just the API.
 *
 * Ideas land in the backlog (for the iteration engine) and, for on-demand runs,
 * also as "idea" proposals so the Proposals page fills with reviewable suggestions.
 */

const YEAR = new Date().getFullYear();

/**
 * Choose the queries to run: keep the ones that were put first ON PURPOSE, sample the rest.
 *
 * The previous version shuffled the whole list and took five. `topicsFor` `unshift`s the operator's
 * improvement-scope themes to the front precisely so they are searched — and the shuffle then threw
 * them away at random. The entire steering mechanism was a coin flip, and a scope the operator had
 * set could produce proposals that ignored it with no sign anything had gone wrong.
 *
 * @param {number} keep how many leading entries are deliberate and must survive
 */
export function chooseTopics(all, n, keep = 0) {
  const pinned = all.slice(0, keep);
  const rest = [...all.slice(keep)].sort(() => Math.random() - 0.5);
  return [...pinned, ...rest].slice(0, Math.max(n, pinned.length));
}

function topicsFor(profile, { similarApps = true, frontend = true } = {}) {
  const stack = (profile?.stack || []).slice(0, 4).join(' ');
  const what = profile?.whatItIs || '';
  const kind = (what.split(/[.,]/)[0] || 'web application').trim().slice(0, 80);
  const lang = REPO_FACTS.language || 'web';

  const topics = [
    what && `best features to add to a ${kind} ${YEAR}`,
    stack && `${stack} production best practices ${YEAR}`,
    kind && `${kind} security and reliability best practices`,
  ].filter(Boolean);

  if (similarApps) {
    topics.push(
      kind && `apps similar to ${kind} feature comparison`,
      kind && `${kind} competitors must-have features ${YEAR}`,
      kind && `what features do top ${kind} apps have`,
    );
  }
  if (frontend) {
    topics.push(
      `${kind} UX improvements that increase engagement`,
      `modern web app UI design trends ${YEAR}`,
      `${lang} frontend accessibility and usability best practices`,
    );
  }

  // IMPROVEMENT SCOPE: the operator's focus decides what we go looking for, so the proposals that
  // come back match the direction they set instead of generic "best practices". Everything unshifted
  // here is PINNED — `pinned` tells the sampler how many leading entries must not be dropped.
  let pinned = 0;
  try {
    const rf = researchFocus();
    for (const t of rf.themes) {
      topics.unshift(`${kind} ${t.label} improvements ${YEAR} — ${t.hint.split(',')[0]}`);
      pinned++;
    }
    if (rf.directives) {
      topics.unshift(`${kind} — ${rf.directives.split('\n')[0].slice(0, 120)}`);
      pinned++;
    }
  } catch { /* scope not ready */ }

  const list = topics.filter(Boolean);
  list.pinned = pinned;
  return list;
}

/**
 * A second round of searches, aimed at what the first round actually turned up.
 *
 * One pass over generic queries returns generic advice — "add caching", "improve onboarding" — which
 * produces proposals no one can build. The follow-up asks the model to name the specific products,
 * techniques and terms worth looking into given what came back, and searches those. That is the
 * difference between reading a listicle and reading about the thing the listicle mentioned.
 *
 * Best-effort throughout: a failed refinement returns nothing and the first round stands on its own.
 */
async function refineSearch({ topics, snippets, kind, signal, max = 3 }) {
  if (!snippets.length) return { queries: [], snippets: [] };
  try {
    const { data } = await llmJson({
      system:
        'You are refining a web search. Given the first round of results, name the most specific '
        + 'follow-up queries that would yield CONCRETE, implementable detail — named products, named '
        + 'techniques, named standards — rather than more general advice. '
        + 'Return ONLY JSON: {"queries":["…"]}. No more than ' + max + '. Each must be a search '
        + 'engine query, not a question to a person.',
      user: [
        `Project: ${kind}`,
        `First-round queries:\n${topics.join('\n')}`,
        `What came back:\n${snippets.slice(0, 24).join('\n')}`,
      ].join('\n\n'),
      temperature: 0.3,
      signal,
    });
    const queries = (Array.isArray(data) ? data : data?.queries || []).filter((q) => typeof q === 'string' && q.trim()).slice(0, max);
    /*
     * QUESTO GIRO LEGGE LE PAGINE, non i frammenti.
     *
     * Misurato su una ricerca reale: i frammenti di DuckDuckGo sono 145-290 caratteri — didascalie.
     * Lo schema di output di questo agente gli chiede pero' `competitorEvidence`, "quale prodotto
     * fa questa cosa e cosa fa esattamente": una precisione che una didascalia non contiene. A un
     * modello a cui si chiede un dettaglio che non ha resta solo inventarlo, ed e' il motivo per
     * cui le proposte nate dalla ricerca restavano generiche.
     *
     * Il primo giro resta a frammenti: serve ad ampiezza, a capire cosa valga la pena cercare. E'
     * questo secondo giro — gia' mirato — che deve portare sostanza, e ora apre davvero le fonti.
     *
     * Solo le prime due per query: scaricare pagine costa tempo di rete e spazio nel prompt, e la
     * terza fonte su una query mirata aggiunge molto meno della prima sulla query successiva.
     */
    const found = [];
    for (const q of queries) {
      const hits = await webSearch(q, { max: 5 });
      for (const h of hits) found.push(`- [${q}] ${h.title ? h.title + ': ' : ''}${h.snippet}`.slice(0, 500));

      for (const h of hits.filter((x) => x.url).slice(0, 2)) {
        const text = await readPage(h.url, { maxChars: 2500 });
        // Una pagina che non si apre, o che e' quasi tutta navigazione, non vale una riga nel
        // prompt: lo spazio tolto qui e' spazio tolto a una fonte che invece dice qualcosa.
        if (text.length < 400) continue;
        found.push(`- [FONTE ${h.url}] ${text}`);
      }
    }
    return { queries, snippets: found };
  } catch {
    return { queries: [], snippets: [] };
  }
}

async function gatherIdeas({ signal, count = 6, similarApps = true, frontend = true } = {}) {
  const profile = (() => {
    try {
      return getProfile();
    } catch {
      return null;
    }
  })();
  const all = topicsFor(profile, { similarApps, frontend });
  const topics = chooseTopics(all, 5, all.pinned || 0);
  const lg = log.for('researcher');
  lg.info?.(`researching (${all.pinned || 0} pinned by scope): ${topics.join(' · ')}`);

  const snippets = [];
  for (const t of topics) {
    const hits = await webSearch(t, { max: 5 });
    for (const h of hits) snippets.push(`- ${h.title ? h.title + ': ' : ''}${h.snippet}`.slice(0, 500));
  }

  // Second pass, aimed at what the first pass found. This is where the specifics come from.
  const kind = (profile?.whatItIs || 'web application').split(/[.,]/)[0].trim().slice(0, 80);
  const refined = await refineSearch({ topics, snippets, kind, signal });
  if (refined.snippets.length) {
    lg.info?.(`follow-up searches: ${refined.queries.join(' · ')} (+${refined.snippets.length} result(s))`);
    snippets.push(...refined.snippets);
  }

  const existing = listFeatures({ limit: 60 }).map((f) => f.title);
  const ctx = projectContextBlurb();
  // The area map tells research WHERE in this codebase a feature would live, so ideas
  // are grounded in real directories instead of generic advice.
  const areas = Array.isArray(profile?.areas) && profile.areas.length
    ? profile.areas.map((a) => `- ${a.name}${a.path ? ` (${a.path})` : ''}: ${a.responsibility || ''}`).join('\n')
    : '';

  const system =
    `${scopeBrief()}\n\n` +
    'You are a senior product engineer and designer improving the project in the PROJECT CONTEXT. ' +
    'Using the web research (which includes features of SIMILAR/COMPETITOR apps) plus that context, ' +
    'propose improvements that give a REAL, COMPLETE benefit to THIS app — not vague advice. ' +
    'Each idea must be a fully buildable unit of work: it is only "complete" if it is wired end-to-end ' +
    '(e.g. a feature that needs UI must include both the backend/service change AND the frontend change; ' +
    'do not propose a half-feature). Prefer improvements that a user would actually notice.\n' +
    'Think like a product team, not a linter: what would make a user choose this product, finish a ' +
    'task faster, or trust it more? Include at least one UX/design improvement and one architectural ' +
    'or backend capability among your ideas.\n' +
    'Return ONLY JSON: {"ideas":[{ "title", "description", "area", "priority", "impact", "inspiration", ' +
    '"userValue", "files":[relative paths or dirs it would touch], "steps":[concrete build steps end to end], ' +
    '"acceptance":"how we would verify it works", "fullStack":true|false, ' +
    '"effort":"S"|"M"|"L", "risk":"low"|"medium"|"high", "successMetric":"the number that should move, and how to read it", ' +
    '"competitorEvidence":"which app does this and what specifically they do (or empty if none)", ' +
    '"uxNotes":"the interaction/visual detail that makes it feel right (empty for pure backend work)" }]} ' +
    'where area is "backend"|"frontend"|"services"|"ux"|"docs", priority is 1-100. Ground "files" in the ' +
    'AREAS below. Set fullStack:true when the idea needs coordinated backend+frontend work, and then ' +
    '"steps" MUST cover both. An idea without a successMetric is not a proposal, it is a wish.';

  const user = [
    ctx || 'No project context available; infer from the research.',
    areas ? `\nCODEBASE AREAS (put each idea's "files" in the right one):\n${areas}` : '',
    /*
     * Anche il ricercatore deve sapere com'è andata finora.
     *
     * Guardava il web e il contesto del progetto, mai l'esito delle proprie proposte precedenti. Sui
     * dati veri di questo progetto le idee nate dalla ricerca arrivano in fondo la metà delle volte,
     * contro quasi nove su dieci di quelle nate dall'esame del codice — e tre erano già state messe
     * da parte. Senza questo blocco continuava a proporre nella stessa direzione, e a proporre lavoro
     * su file che avevano già respinto dieci tentativi.
     */
    evidenceFromHistory(),
    // Un'idea che viola una regola permanente nasce già destinata a essere respinta a valle.
    rulesFor('planner'),
    snippets.length ? `\nWeb research (incl. similar apps):\n${snippets.join('\n')}` : '\nNo web results (offline); use your domain knowledge for this stack.',
    existing.length ? `\nAlready in the backlog (do NOT repeat):\n${existing.slice(0, 40).join('\n')}` : '',
    // Over-request. Ideas without build steps, without acceptance criteria, or naming files that do
    // not exist are rejected before they reach the planner, and asking for the exact number needed
    // meant every rejection came straight off the total.
    `\nPropose ${count + 3} NEW improvements that each deliver a real, complete benefit — a MIX of backend/services and frontend/UX. ` +
      'For anything user-facing, make it full-stack and list steps for BOTH ends. Be concrete and specific.\n' +
      'Every "files" entry must be a path that plausibly exists in the AREAS above — a new file is fine, ' +
      'but its DIRECTORY must be one of the real ones listed. An invented path is worse than no path: it ' +
      'looks specific, survives review, and fails when an agent tries to open it.\n' +
      'At least two build steps and a concrete acceptance check per idea, or the idea is discarded.',
  ].join('\n');

  let raw = [];
  let usage = { promptTokens: 0, evalTokens: 0 };
  try {
    const r = await llmJson({ system, user, temperature: 0.7, signal });
    usage = r.usage || usage;
    raw = Array.isArray(r.data) ? r.data : r.data?.ideas || [];
  } catch (err) {
    lg.warn?.(`idea generation failed: ${err.message}`);
  }

  /*
   * FILTER, THEN GROUND, THEN DE-DUPLICATE — and say what was dropped and why.
   *
   * Everything the model returned used to be accepted. An idea with no build steps, no acceptance
   * criteria or invented file paths still reached the planner, which turned it into tasks the
   * implementer could not ground; the run then ended "the implementer produced no edits". Asking for
   * more than are needed means the rejects cost nothing.
   */
  const rejected = [];
  const kept = [];
  for (const idea of raw) {
    const bad = usable(idea);
    if (bad) { rejected.push({ title: idea?.title || '(untitled)', why: bad }); continue; }

    const ground = groundFiles(idea);
    if (ground.ratio === 0) {
      rejected.push({ title: idea.title, why: `every file it names is invented (${ground.invented.join(', ')})` });
      continue;
    }

    const dupe = tooSimilar(idea.title, [...existing, ...kept.map((k) => k.title)]);
    if (dupe) { rejected.push({ title: idea.title, why: `already in the backlog as "${dupe}"` }); continue; }

    // Keep only the paths that resolve — an agent handed an invented one wastes a task on it.
    kept.push({ ...idea, files: ground.grounded, _invented: ground.invented });
    if (kept.length >= count) break;
  }

  if (rejected.length) {
    lg.info?.(`dropped ${rejected.length} idea(s): ${rejected.map((r) => `${r.title} — ${r.why}`).join(' · ')}`);
  }
  lg.info?.(`${kept.length} usable idea(s) from ${raw.length} generated, over ${snippets.length} web result(s)`);

  return { ideas: kept, rejected, snippets: snippets.length, topics, refinedQueries: refined.queries, usage };
}

const AREAS = ['backend', 'frontend', 'services', 'ux', 'docs'];
const sevFor = (p) => (p >= 80 ? 'high' : p >= 50 ? 'medium' : 'low');

/**
 * Does this idea have enough in it to be built?
 *
 * The prompt demands steps, acceptance criteria and a success metric, and the previous version
 * accepted whatever came back regardless. An idea that is a title and a paragraph is not a proposal;
 * it reaches the planner, which turns it into tasks that the implementer cannot ground, and the run
 * ends "the implementer produced no edits". Rejecting it here costs one slot; passing it costs a run.
 */
export function usable(idea) {
  if (!idea?.title || String(idea.title).trim().length < 8) return 'no usable title';
  const steps = Array.isArray(idea.steps) ? idea.steps.filter((s) => typeof s === 'string' && s.trim().length > 12) : [];
  if (steps.length < 2) return 'fewer than two concrete build steps';
  if (!idea.acceptance || String(idea.acceptance).trim().length < 12) return 'no way to verify it works';
  if (!Array.isArray(idea.files) || !idea.files.filter(Boolean).length) return 'no target files';
  return null;
}

/**
 * Do the files an idea names actually exist in this repository?
 *
 * A path the model invented is the most expensive kind of wrong: it looks specific, it survives
 * review, and it fails at the moment an agent tries to open it. Each entry is checked as a file OR
 * as a directory — a new feature legitimately names a file that does not exist yet, so a MISS is
 * only counted when its parent directory is absent too.
 *
 * The verdict is attached, not enforced: an idea whose paths are all invented is dropped, but one
 * that names a new file in a real directory is exactly what a feature proposal should look like.
 */
export function groundFiles(idea) {
  const files = (Array.isArray(idea.files) ? idea.files : []).filter((f) => typeof f === 'string' && f.trim());
  if (!files.length) return { grounded: [], invented: [], ratio: 0 };
  const grounded = [];
  const invented = [];
  for (const f of files.slice(0, 8)) {
    const rel = f.replace(/^[./\\]+/, '').split('\\').join('/');
    const abs = path.join(REPO_ROOT, rel);
    const parent = path.dirname(abs);
    try {
      if (fs.existsSync(abs) || fs.existsSync(parent)) grounded.push(rel);
      else invented.push(rel);
    } catch { invented.push(rel); }
  }
  return { grounded, invented, ratio: grounded.length / (grounded.length + invented.length || 1) };
}

/** Normalised title, for spotting an idea the backlog already has under different wording. */
const normalise = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim();

/** Word-overlap similarity — enough to catch a restatement without pulling in a similarity library. */
export function tooSimilar(title, existing) {
  const a = new Set(normalise(title).split(' ').filter((w) => w.length > 3));
  if (a.size < 2) return null;
  for (const e of existing) {
    const b = new Set(normalise(e).split(' ').filter((w) => w.length > 3));
    if (!b.size) continue;
    let shared = 0;
    for (const w of a) if (b.has(w)) shared++;
    if (shared / Math.min(a.size, b.size) >= 0.7) return e;
  }
  return null;
}

/**
 * Build a COMPLETE, buildable description from a research idea — the plan, target files,
 * end-to-end steps and acceptance — so the planner and implementer can turn it into a
 * real change instead of guessing at a one-line title. This is what makes a research
 * proposal actually complete.
 */
function richDescription(idea) {
  const files = Array.isArray(idea.files) ? idea.files.filter(Boolean).slice(0, 8) : [];
  const steps = Array.isArray(idea.steps) ? idea.steps.filter(Boolean).slice(0, 10) : [];
  return [
    String(idea.description || '').slice(0, 600),
    idea.userValue ? `\nUser value: ${idea.userValue}` : '',
    idea.impact ? `\nImpact: ${idea.impact}` : '',
    idea.fullStack ? '\nScope: FULL-STACK — implement backend/service AND frontend so the feature is complete.' : '',
    files.length ? `\nTarget files/areas: ${files.join(', ')}` : '',
    steps.length ? `\nBuild steps:\n${steps.map((s, i) => `${i + 1}. ${s}`).join('\n')}` : '',
    idea.acceptance ? `\nAcceptance: ${idea.acceptance}` : '',
    // Product framing: what should move, what it costs, how risky, and who does it well already.
    idea.successMetric ? `\nSuccess metric: ${idea.successMetric}` : '',
    idea.uxNotes ? `\nUX detail: ${idea.uxNotes}` : '',
    idea.effort || idea.risk ? `\nEffort/risk: ${idea.effort || '?'} effort · ${idea.risk || '?'} risk` : '',
    idea.competitorEvidence ? `\nEvidence: ${idea.competitorEvidence}` : '',
    idea.inspiration ? `\nInspired by: ${idea.inspiration}` : '',
  ].filter(Boolean).join('').slice(0, 2400);
}

/** Backlog-only research (used by the iteration engine's research phase). */
export async function research({ logger = log.for('researcher'), signal, maxNew = 4 } = {}) {
  const { ideas, snippets, usage } = await gatherIdeas({ signal, count: maxNew });
  let added = 0;
  for (const idea of ideas) {
    if (!idea?.title) continue;
    const id = addFeature({
      title: String(idea.title).slice(0, 160),
      description: richDescription(idea),
      area: AREAS.includes(idea.area) ? (idea.area === 'ux' ? 'frontend' : idea.area) : null,
      source: 'research',
      priority: Math.min(100, Math.max(1, Number(idea.priority) || 50)),
    });
    if (id) added++;
  }
  const counts = countFeaturesByStatus();
  const summary = `Research added ${added} idea(s) · backlog now ${counts.pending} pending`;
  logger.info?.(summary);
  return { summary, added, snippets, backlog: counts, tokensIn: usage.promptTokens, tokensOut: usage.evalTokens };
}

/**
 * On-demand rich research: searches similar apps + frontend/UX and creates
 * reviewable "idea" proposals (so the Proposals page fills) AND backlog items.
 */
export async function researchProposals({ signal, count = 8 } = {}) {
  const { ideas, snippets, topics } = await gatherIdeas({ signal, count, similarApps: true, frontend: true });
  if (!ideas.length) {
    emit('research.finished', { proposals: 0, snippets });
    return { created: 0, snippets };
  }

  const runId = createRun('research', 'research', 'online feature research');
  let created = 0;
  for (const idea of ideas) {
    if (!idea?.title) continue;
    const area = AREAS.includes(idea.area) ? idea.area : 'backend';
    const priority = Math.min(100, Math.max(1, Number(idea.priority) || 50));
    const rationale = [
      richDescription(idea),
      `\n\nArea: ${area} · Priority: ${priority}`,
      '\n\n(Research idea — a complete build plan is above. Add it to the backlog to have the agents implement it end-to-end.)',
    ].join('');
    try {
      const pid = createProposal({
        runId,
        agentId: 'research',
        title: String(idea.title).slice(0, 160),
        rationale,
        severity: sevFor(priority),
        files: [],
        diff: '',
      });
      setProposalStatus(pid, 'idea');
      created++;
    } catch (err) {
      log.warn('researcher', `could not create idea proposal: ${err.message}`);
    }
    /*
     * Seed the backlog with the FULL plan, not the summary.
     *
     * This wrote `idea.description` — a paragraph — while the rich version with target files, build
     * steps and acceptance criteria went only to the proposal. That is backwards: the backlog is
     * what the planner and implementer actually read, and the proposal is what a person reads. The
     * agents were being handed the thin half of every research idea.
     */
    addFeature({
      title: String(idea.title).slice(0, 160),
      description: richDescription(idea),
      area: area === 'ux' ? 'frontend' : area,
      source: 'research',
      priority,
    });
  }
  finishRun(runId, { status: 'done', summary: `Created ${created} research proposal(s) from ${snippets} web result(s)` });
  emit('research.finished', { proposals: created, snippets, topics });
  log.info('researcher', `created ${created} idea proposal(s) from online research`);
  return { created, snippets, topics };
}
