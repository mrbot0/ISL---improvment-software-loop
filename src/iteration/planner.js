import fs from 'node:fs';
import path from 'node:path';
import { llmJson } from './llm.js';
import { llmGate } from '../core/semaphore.js';
import { getKpi, pickFunctionsToImprove, pickFeatures } from '../db_iteration.js';
import { getSetting } from '../db.js';
// Live bindings — read at call time so switching projects redirects them.
import { modelFor, REPO_ROOT } from '../config.js';
import { repoFactsBrief, vetTaskPaths } from './pathGuard.js';
import { testPathFor } from './implementer.js';
import { memoryBlurb } from '../memory/memoryDb.js';
import { rulesFor } from '../memory/standingRules.js';
import { briefingFor } from '../context/fleetBriefing.js';
import { chooseAgent, prioritise, inferArea, networkInsight } from '../core/decisionNetwork.js';
import { getScope, focusShare, themeForAgent, themeBlocked, scopeBrief, THEME_KEYS } from '../core/scope.js';

const THEME_COUNT = THEME_KEYS.length;
import { log } from '../logger.js';

/**
 * The planner turns the backlog into the concrete batch of work one iteration will
 * do. Two things matter here and both were weak before:
 *
 * 1. SPECIFICITY. A task that says "improve error handling in bookings.js" gives the
 *    implementer nothing to aim at, and it comes back with either nothing or a
 *    drive-by refactor. A task must name the file, the symbol, the defect, and the
 *    acceptance check — so the implementer's only remaining job is to write the code.
 *
 * 2. OWNERSHIP. Each task is assigned to the specialist who should write it. The
 *    implementer then works in that persona, which is the difference between a
 *    generic edit and one a security engineer would actually sign off on.
 *
 * The file list each task declares is also load-bearing: the scheduler uses it to
 * decide what can run in parallel, so a task that under-declares its files can
 * collide with a sibling. We ask for it explicitly and we validate it.
 */

const AGENTS = [
  'security', 'performance', 'tests', 'quality', 'frontend', 'services', 'workbench',
  'resilience', 'compliance', 'docs', 'infra', 'refactor', 'ux',
];

/**
 * Which specialist owns a path. This now goes through the DECISION NETWORK, which blends
 * the static file→specialist prior with each agent's LEARNED land-rate in that area — so
 * work flows to whoever actually ships it, and away from a pairing that keeps failing.
 * `hint` is the agent the LLM suggested; a strong track record can override a weak hint.
 */
function inferAgent(files = [], hint = null) {
  return chooseAgent({ files, hint }).agent;
}

/**
 * Is there a test file beside this source file?
 *
 * Read from the real checkout, not from the coverage record: coverage may be stale, absent, or
 * unmeasurable on this host, whereas the file either sits there or it does not. An unreadable path
 * returns `null` — "unknown", which the prompt renders as nothing rather than as a claim.
 */
function hasTestFile(srcRel) {
  if (!srcRel) return null;
  try {
    return fs.existsSync(path.join(REPO_ROOT, testPathFor(srcRel)));
  } catch {
    return null;
  }
}

export async function plan({ logger = log.for('planner'), signal, iterationId = null } = {}) {
  const kpi = getKpi();
  const nImpr = Math.max(1, Math.round(kpi.improvements_per_iter ?? 3));
  const nFeat = Math.max(0, Math.round(kpi.features_per_iter ?? 2));

  /*
   * `iterationId` drives the cooldown: a target that failed within the last few runs is skipped
   * rather than re-proposed. Without it the same high-weight function came back in four consecutive
   * batches (#437-#440), each time with the same information that had already failed.
   */
  const functions = pickFunctionsToImprove(nImpr, { currentIter: iterationId });
  const features = pickFeatures(nFeat);

  const rawCandidates = [
    ...functions.map((f) => ({
      ref: `fn:${f.id}`,
      kind: 'improvement',
      target: `${f.path}#${f.name}`,
      file: f.path,
      complexity: f.complexity,
      fanIn: f.fanIn,
      todos: f.todos,
      failures: f.failures,
      /*
       * DOES IT ALREADY HAVE TESTS?
       *
       * A fact from disk, stated to the planner, because without it the model kept proposing "add
       * unit tests for X" for files that already had them. Measured over 120 runs: **11 of the 20
       * tasks that ended without an edit** were an agent reporting some form of "intelClient.test.js
       * already exists with 28 tests" — the same file reissued three separate times, each costing a
       * full turn to rediscover.
       *
       * The implementer already computed this to decide between `write_file` and `edit_file`. It was
       * simply never available at the point where the decision to propose the work is made.
       */
      hasTests: hasTestFile(f.path),
      why: `complexity ${f.complexity}, fan-in ${f.fanIn}, ${f.todos} TODO(s)`,
    })),
    ...features.map((f) => ({
      ref: `feat:${f.id}`,
      kind: 'feature',
      target: f.title,
      file: null,
      failures: f.failures,
      why: f.description || f.area || '',
    })),
  ];
  // The DECISION NETWORK re-ranks the backlog by expected value = impact × the fleet's
  // learned likelihood of actually landing it, so the highest-payoff, most-executable
  // work is planned first (and doomed items sink).
  let candidates = prioritise(rawCandidates);

  // GOAL-SETTING (ISL_IMPROVE §7): a human can set an objective the fleet plans toward.
  // We boost candidates that advance it to the top, and tell the model to prefer them.
  const goal = (() => { try { return getSetting('projectGoal', null); } catch { return null; } })();
  if (goal?.text) {
    const words = goal.text.toLowerCase().split(/\s+/).filter((w) => w.length > 3);
    candidates = candidates
      .map((c) => {
        const hay = `${c.file || ''} ${c.why || ''} ${c.target || ''} ${c.area || ''}`.toLowerCase();
        const matches = (goal.area && c.area === goal.area) || words.some((w) => hay.includes(w));
        return matches ? { ...c, ev: (c.ev || 0) + 0.5, forGoal: true } : c;
      })
      .sort((a, b) => (b.ev || 0) - (a.ev || 0));
  }

  // IMPROVEMENT SCOPE: the operator's focus mix re-weights the candidate list BEFORE the model sees
  // it, and hard caps stop one theme (in practice: tests) filling the whole batch just because it is
  // the easiest thing to land. This is what makes the human's steering actually bite.
  const scope = getScope();
  if (scope.enforce) {
    const share = focusShare(scope);
    const seen = {};
    const batchSize = Math.max(1, nImpr + nFeat);
    candidates = candidates
      .map((c) => {
        const theme = themeForAgent(inferAgent(c.files || (c.file ? [c.file] : []), c.agent || null));
        // Weight of that theme relative to an even split: >1 boosts, <1 sinks.
        const bias = share[theme] * THEME_COUNT;
        return { ...c, theme, ev: (c.ev || 0) * (0.4 + 0.6 * bias) };
      })
      .sort((a, b) => (b.ev || 0) - (a.ev || 0))
      .filter((c) => {
        const blocked = themeBlocked(c.theme, seen[c.theme] || 0, batchSize, scope);
        if (blocked) return false;
        seen[c.theme] = (seen[c.theme] || 0) + 1;
        return true;
      });
  }

  /*
   * The product is named by the Context Manager, not hardcoded.
   *
   * This prompt opened by naming one specific product and describing its business domain
   * — true for the project it was written against and false for every other one ISL can be pointed
   * at. A planner told it is working on the wrong product plans for the wrong product, and the
   * multi-project foundation underneath it made that a live defect rather than a tidiness issue.
   */
  const system = `
You are the tech lead for this project. The PROJECT BRIEFING in the next message states what it is,
how it is divided, what must never break, and where this codebase has been misunderstood before.
Treat it as ground truth and plan within it.

${repoFactsBrief()}

${rulesFor('planner')}

Produce the batch plan for ONE iteration. Every task must be small, independently verifiable, and
SPECIFIC ENOUGH TO IMPLEMENT WITHOUT GUESSING. A vague task is a wasted iteration.

For each task you MUST give:
- "ref":     echo the candidate id token I give you, exactly.
- "title":   what changes, naming the symbol. Not "improve X" — "add an ownership check to
             updateBooking before it mutates the record".
- "rationale": the concrete defect or gap, and what goes wrong today because of it.
- "agent":   who should write it — one of: security, performance, tests, quality, frontend, services,
             workbench, resilience (error handling/timeouts/retries), compliance (best-practice fixes),
             docs (Markdown/comments only), infra (Terraform/Docker/CI), refactor (structure, no
             behaviour change), ux (frontend polish). Pick the closest specialist.
- "files":   EVERY file the change touches. This is load-bearing: tasks that declare no overlapping
             files are executed in PARALLEL, so an under-declared file list causes a collision.
             Be exact and be complete.
- "steps":   the actual edit, step by step, concrete enough that the implementer only has to type it.
- "acceptance": how we would know it worked — the assertion, the query count, the status code.
- "integration": if the change crosses a boundary (route → service, service → service, frontend →
             API), name the contract on both sides and what happens when the far side fails.
             Empty string if the change is local.

NEVER PROPOSE DELETING CODE YOU DO NOT UNDERSTAND. If you cannot tell whether something is dead
code or an unfinished feature, that uncertainty forbids removal — it does not license it. Either
propose finishing it, or leave it alone and pick different work. A task whose reasoning contains
"unclear if", "probably unused", "seems to be dead" and whose action is removal will be rejected.
This is not hypothetical: a task titled "Resolve TODO regarding userPrefs", justified as "unclear
if it's dead code or a missing feature — removing this ensures the route is clean", deleted the
personalisation of a live search endpoint, and users lost the feature.

A REMOVAL MUST BE THE TITLE'S OWN VERB. If the change deletes behaviour, say so in the title:
"Remove X". A task titled "resolve", "fix", "implement" or "wire up" that produces a deletion is a
different change from the one that was approved, and the pipeline rolls it back.

ADDING A FIELD TO A SCHEMA REQUIRES A MIGRATION IN THE SAME TASK. A Prisma model field with no
migration is a column that does not exist: the code compiles, the service boots, and every query
selecting it fails in production. If you cannot also write the migration, do not touch the schema.

INTEGRATION IS A FIRST-CLASS GOAL. This system is a set of services that must actually work
together. Prefer changes that make the seams solid — agreed contracts, explicit timeouts, defined
failure behaviour, reuse of the existing shared client instead of a second hand-rolled fetch.

Return ONLY JSON:
{"title": string, "theme": string, "tasks": [{"ref","title","rationale","agent","files":[],"steps":[],"acceptance","integration"}]}
`.trim();

  /*
   * WHAT THE APPLICATION IS, BEFORE DECIDING WHAT TO DO TO IT.
   *
   * The planner previously saw path facts, the operator scope and past lessons — but nothing about
   * the application itself. It chose work suited to one kind of product without ever being told
   * that is what it was, and without its invariants ("the API contract must never change", "a
   * microservice outage must never block user access") or its recorded risks ("assuming models
   * that do not exist causes runtime errors" — which is, in advance, the failure that later removed
   * business users from the app).
   */
  const briefing = briefingFor('planner');
  const memBlurb = memoryBlurb({ limit: 8 });
  // The operator's scope is injected VERBATIM and first — it outranks the model's own instincts
  // (which, left alone, produce another batch of unit tests).
  const scopeLine = `${scopeBrief(scope)}\n\n`;
  const goalLine = goal?.text ? `OPERATOR OBJECTIVE — prioritise work that advances this goal: "${goal.text}"${goal.area ? ` (focus area: ${goal.area})` : ''}.\n\n` : '';
  const user =
    scopeLine +
    goalLine +
    (briefing ? `${briefing}

` : '') +
    (memBlurb ? `${memBlurb}\n\n` : '') +
    (candidates.length
      ? `Plan one task per candidate. Keep each tightly scoped; they will run in parallel where their files do not overlap.\n\n${candidates
          .map((c) => `- ref=${c.ref} [${c.kind}] ${c.target}${c.file ? ` (${c.file})` : ''} — ${c.why}`
            + (c.hasTests === true ? ' · ALREADY HAS A TEST FILE — do not propose writing one; improve the code itself'
              : c.hasTests === false ? ' · has no test file yet' : ''))
          .join('\n')}`
      : 'The backlog is empty. Propose ONE small, safe, specific improvement to the backend (ref="explore:1").') +
    '\n\nReturn the JSON plan now.';

  let data = null;
  let usage = { promptTokens: 0, evalTokens: 0 };
  try {
    const r = await llmGate.run(() => llmJson({ system, user, model: modelFor('plan'), temperature: 0.35, signal }), signal);
    data = r.data;
    usage = r.usage || usage;
  } catch (err) {
    if (err.message === 'interrupted') throw err;
    logger.warn?.(`planner LLM failed: ${err.message}`);
  }

  // The local model sometimes returns an empty/!array `tasks`. One terse retry (no
  // memory preamble, blunter instruction) recovers a real plan most of the time; if it
  // still fails, the deterministic fallback below guarantees the iteration isn't wasted.
  if ((!Array.isArray(data?.tasks) || !data.tasks.length) && candidates.length) {
    try {
      const retryUser =
        `You MUST return one task per candidate below. Do not return an empty list.\n\n${candidates
          .map((c) => `- ref=${c.ref} [${c.kind}] ${c.target}${c.file ? ` (${c.file})` : ''} — ${c.why}`
            + (c.hasTests === true ? ' · ALREADY HAS A TEST FILE — do not propose writing one; improve the code itself'
              : c.hasTests === false ? ' · has no test file yet' : ''))
          .join('\n')}\n\nReturn ONLY the JSON: {"title","theme","tasks":[{"ref","title","rationale","agent","files":[],"steps":[],"acceptance","integration"}]}`;
      const r2 = await llmGate.run(() => llmJson({ system, user: retryUser, model: modelFor('plan'), temperature: 0.15, signal }), signal);
      if (Array.isArray(r2.data?.tasks) && r2.data.tasks.length) {
        data = r2.data;
        usage = { promptTokens: usage.promptTokens + (r2.usage?.promptTokens || 0), evalTokens: usage.evalTokens + (r2.usage?.evalTokens || 0) };
        logger.info?.('planner recovered a plan on the terse retry');
      }
    } catch (err) {
      if (err.message === 'interrupted') throw err;
      logger.warn?.(`planner retry failed: ${err.message}`);
    }
  }

  const rawTasks = Array.isArray(data?.tasks) ? data.tasks : [];
  const byRef = Object.fromEntries(candidates.map((c) => [c.ref, c]));

  const mapped = rawTasks
    .map((t) => {
      const cand = byRef[t.ref];
      const rawFiles = (Array.isArray(t.files) ? t.files : [])
        .map((f) => String(f).replace(/\\/g, '/').replace(/^\.?\//, ''))
        .filter(Boolean)
        .slice(0, 6);
      // The candidate's own file is authoritative — the model sometimes forgets it.
      if (cand?.file && !rawFiles.includes(cand.file)) rawFiles.unshift(cand.file);

      const kind = cand?.kind || (t.kind === 'feature' ? 'feature' : 'improvement');

      // Reality-check the paths: repair what we can (wrong root/extension), and learn
      // why the rest can't be done — before an implementer wastes a turn discovering it.
      const vet = vetTaskPaths({ files: rawFiles, kind });
      const files = vet.files.length ? vet.files : rawFiles;
      // Route through the decision network: the LLM's pick is a HINT, but the network can
      // steer to the specialist with the better track record in this area.
      const agent = inferAgent(files, AGENTS.includes(t.agent) ? t.agent : null);

      return {
        kind,
        functionId: cand?.ref?.startsWith('fn:') ? Number(cand.ref.slice(3)) : null,
        featureId: cand?.ref?.startsWith('feat:') ? Number(cand.ref.slice(5)) : null,
        agent,
        area: inferArea(files),
        title: String(t.title || cand?.target || 'improvement').slice(0, 180),
        rationale: String(t.rationale || '').slice(0, 600),
        files,
        newFiles: vet.newFiles,
        steps: Array.isArray(t.steps) ? t.steps.slice(0, 10).map(String) : [],
        acceptance: String(t.acceptance || '').slice(0, 300),
        integration: String(t.integration || '').slice(0, 400),
        // Carried through so the engine can fail it early with a clear message rather
        // than let the implementer flail and report "no summary".
        viable: vet.viable,
        pathIssue: vet.reason,
        pathNotes: vet.problems,
      };
    })
    .filter((t) => t.title)
    .slice(0, nImpr + nFeat);

  // Split viable from doomed. Doomed tasks are NOT silently dropped — they are kept so
  // the operator sees exactly which planned work was impossible and why.
  const tasks = mapped.filter((t) => t.viable);
  const rejected = mapped.filter((t) => !t.viable);

  for (const t of rejected) {
    logger.warn?.(`dropped "${t.title.slice(0, 60)}" — ${t.pathIssue}`);
  }

  // CRITICAL RELIABILITY GUARANTEE: a local model intermittently returns an empty or
  // unparseable task list, which used to yield a totally wasted "empty" iteration even
  // though the backlog was full. When the LLM gives us nothing usable but we DO have
  // real candidates, synthesize grounded tasks straight from the candidate metadata —
  // we already know the exact file and symbol from the catalog, so nothing is invented.
  if (!tasks.length && candidates.length) {
    const synth = candidates
      .filter((c) => c.file) // grounded in a real, catalogued file
      .slice(0, nImpr + nFeat)
      .map((c) => {
        const files = [c.file];
        const name = String(c.target || '').includes('#') ? c.target.split('#').pop() : null;
        return {
          kind: c.kind === 'feature' ? 'feature' : 'improvement',
          functionId: c.ref?.startsWith('fn:') ? Number(c.ref.slice(3)) : null,
          featureId: c.ref?.startsWith('feat:') ? Number(c.ref.slice(5)) : null,
          agent: inferAgent(files),
          area: inferArea(files),
          title: name ? `Improve ${name} in ${c.file}` : `Improve ${c.file}`,
          rationale: String(c.why || 'flagged by the catalog for improvement').slice(0, 400),
          files,
          newFiles: [],
          steps: name
            ? [`Find ${name} in ${c.file} (use search_code).`, 'Make ONE small, safe, concrete improvement — tighten error handling, validate an input, remove real duplication, or fix a clear bug.', 'Keep behaviour intact; run tests.']
            : ['Make one small, safe, concrete improvement to this file.', 'Keep behaviour intact; run tests.'],
          acceptance: 'Tests pass and the app still boots.',
          integration: '',
          viable: true,
          pathIssue: null,
          pathNotes: [],
        };
      });
    if (synth.length) {
      tasks.push(...synth);
      logger.warn?.(`planner LLM produced no usable tasks — synthesized ${synth.length} grounded task(s) from the backlog so the iteration still does real work`);
    }
  }

  const title = String(data?.title || 'Iteration improvements').slice(0, 160);
  const improvements = tasks.filter((t) => t.kind === 'improvement');
  const featureTasks = tasks.filter((t) => t.kind === 'feature');
  const byAgent = tasks.reduce((acc, t) => ({ ...acc, [t.agent]: (acc[t.agent] || 0) + 1 }), {});

  const summary =
    `Planned "${title}" — ${improvements.length} improvement(s), ${featureTasks.length} feature(s)` +
    (rejected.length ? `, ${rejected.length} dropped (unreal paths)` : '') +
    ` · ${Object.entries(byAgent).map(([a, n]) => `${a}×${n}`).join(' ')}`;
  logger.info?.(summary);

  return {
    title,
    theme: String(data?.theme || '').slice(0, 200),
    tasks,
    rejected, // planned-but-impossible tasks, kept with their reason for the UI
    improvements,
    features: featureTasks,
    byAgent,
    summary,
    tokensIn: usage.promptTokens,
    tokensOut: usage.evalTokens,
  };
}
