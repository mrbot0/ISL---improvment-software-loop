import fs from 'node:fs';
import path from 'node:path';
import { chat, toolArgs } from '../ollama.js';
import { IMPLEMENTER_TOOLS, makeImplementerTools } from './sandboxTools.js';
import { IMPLEMENTER_MAX_STEPS, TOOL_HISTORY_BUDGET, modelFor } from '../config.js';
import { taskWorkingContext } from '../context/contextAgent.js';
import { briefingFor } from '../context/fleetBriefing.js';
import { unusedCreatedFiles } from './deadCode.js';
import { stripNonCode } from './staticAnalysis.js';
import { blastRadiusBlurb } from './blastRadius.js';
import { similarChanges } from '../context/knowledgeIndex.js';
import { memoryBlurb } from '../memory/memoryDb.js';
import { rulesFor } from '../memory/standingRules.js';
import { decisionBrief } from '../core/decisionNetwork.js';
import { llmGate } from '../core/semaphore.js';
import { emit } from '../bus.js';
import { log } from '../logger.js';

const SYSTEM = `
You are the implementer for the project described in the PROJECT CONTEXT below (when one is
provided — treat it as the ground truth about what this app is and its constraints). You are given
ONE task and a live sandbox copy of the repo. Your job is to SHIP the change — make a concrete edit
with your file tools, prove it with run_tests, then finish.

You are a builder, not a critic. The plan was already vetted before it reached you; do not
re-litigate whether it's worth doing. If the exact task as written is awkward, do the SMALLEST
useful version of it rather than nothing — a modest real improvement beats a perfect idea you
never wrote. Finishing with zero edits is a FAILURE and wastes the whole iteration.

HOW TO WORK
1. The target file's current content is given to you below. Read any other file you need with read_file.
2. Make the edit with edit_file (exact string replace) — surgical, minimal, matching the
   surrounding style, imports and error handling exactly. Use write_file only for a new file.
3. Call run_tests. If it fails, read the output, fix, and run_tests again until green.
4. finish() with a one-line summary of what you changed.

WIRE IN EVERYTHING YOU CREATE — this is the #1 rule.
- A new function, hook, helper or file that nothing imports or calls is DEAD CODE. It is not an
  improvement; it is cruft, and it will be rejected outright. If you create something, you MUST import
  and actually USE it from the real caller in the SAME change (use search_code to find that caller).
- A REFACTOR means REPLACE, not ADD. Extracting logic into a helper is only done when you then delete
  the original inline code and make it call the helper. Additions with no deletions are a red flag that
  you created an abstraction and left the duplication in place — do not do that.
- If you cannot wire a new module in, do NOT create it — make the change inline instead.

WRITE CODE THAT BELONGS HERE
- Orient first. In an unfamiliar area, call search_knowledge with a plain-language description of what
  you need ("where booking overlap is validated") to get the most relevant files, their key symbols,
  AND any past lesson about that area — then read_file the top hit. Use search_code when you know the
  exact symbol.
- Integrate, don't isolate. Before you write a helper, use search_code (or search_knowledge) to find one
  that already exists — this codebase has shared middleware, error types, a Prisma client, and service
  clients. Reusing them is the difference between a change that fits and a change that merely compiles.
- Respect the boundaries. A backend route talks to a service through its existing client, not by
  re-implementing the call. A service owns its own data — do not reach around it.
- Handle the unhappy path exactly the way the neighbouring code does: same error type, same status
  code, same log shape. An inconsistent error path is a bug that only shows up in production.
- Anything crossing a process boundary (HTTP, queue, database) needs a timeout and a failure path.
  Code that assumes the network always works is code that takes the site down.

HARD RULES
- Change as few files as possible; do the task, nothing more — no drive-by refactors.
- Never weaken/delete a test, never touch package.json / .env / migrations.
- Never remove or rename an existing export or route — that breaks callers (it will be rejected).
- The app must still BOOT. A change that passes tests but breaks an import, a route registration or
  a service entrypoint fails the whole iteration at the workbench stage.
- ONLY abandon the task (finish with no edit) if it is genuinely IMPOSSIBLE — e.g. the target
  no longer exists, or doing it would require removing a public API. In that case explain the
  concrete blocker in one sentence AND name a smaller change you could have made instead.
  "It could be risky" or "it's complex" are NOT acceptable reasons to do nothing.
`.trim();

/**
 * The specialist voice for a task. The planner assigns each task an owner; giving
 * the implementer that owner's priorities produces a visibly different — and
 * better — change than a generic "improve this" ever does.
 */
const PERSONAS = {
  security: `YOU ARE WEARING THE SECURITY AUDITOR'S HAT.
Prioritise: ownership checks before any mutation, validation of input that reaches Prisma or the
filesystem, no PII or secrets in responses/logs, rate limits on auth and payment routes, and errors
that never echo internals to the client. Fix the vulnerability, do not merely comment on it.`,

  performance: `YOU ARE WEARING THE PERFORMANCE ENGINEER'S HAT.
Prioritise: eliminating N+1 Prisma queries (use include/in), bounding unbounded findMany with
take/skip, narrowing selects, replacing sequential awaits with Promise.all where order does not
matter. State the concrete win ("1+N queries become 2"). Never trade readability for a nanosecond.`,

  tests: `YOU ARE WEARING THE TEST ENGINEER'S HAT.
Write tests that would actually catch a production break — overlapping bookings, expired tokens,
missing records, zero-length date ranges. Copy the conventions of the existing tests exactly. Every
test you write must pass against the CURRENT behaviour; you are protecting it, not redesigning it.`,

  quality: `YOU ARE WEARING THE CODE QUALITY ENGINEER'S HAT.
Prioritise: genuinely duplicated logic extracted into the shared helper that already exists, silent
catch blocks given real handling, misleading names corrected, proven-dead code removed. Do not
rename for taste, do not reformat, do not "modernise" working code.`,

  frontend: `YOU ARE WEARING THE FRONTEND / ACCESSIBILITY ENGINEER'S HAT.
Prioritise: keyboard-reachable controls, labels and alt text, focus handling in modals, and loading
and error states that are actually rendered. This app is internationalised with react-i18next —
never hard-code a user-facing string; reuse an existing key or add one in the shape you observe.`,

  services: `YOU ARE WEARING THE SERVICES / INTEGRATION ENGINEER'S HAT.
You work across the microservices in services/ and the seams where they meet the backend.
Prioritise: a caller and callee that agree on the contract (shape, status codes, error body); every
cross-service call given an explicit timeout and a defined behaviour when it fails; retries only
where the operation is idempotent; failures that degrade the feature instead of taking down the
request. A service that silently returns 200 with a broken body is worse than one that returns 503.`,

  workbench: `YOU ARE WEARING THE WORKBENCH ENGINEER'S HAT.
Your concern is that the application actually RUNS. Imports resolve, routes register against
functions that exist, entrypoints boot, config has a sane default. Prefer the minimal repair that
gets it starting again over the elegant restructure that might.`,

  resilience: `YOU ARE WEARING THE RESILIENCE ENGINEER'S HAT.
Wrap unguarded external calls (HTTP, DB, queue) with an explicit timeout and a defined failure path.
Add retries ONLY to idempotent operations — never to a payment or a booking. Replace silent catch
blocks with real handling. Make non-essential features degrade instead of failing the request. Name
the exact failure you are closing.`,

  compliance: `YOU ARE WEARING THE COMPLIANCE ENGINEER'S HAT.
Fix a concrete violation of a language best practice: parameterise a string-built query, handle a
specific exception instead of a bare catch, close a leaked resource, remove a hardcoded secret. Match
the language's idioms and cite the rule you are satisfying. Do not touch code that already complies.`,

  docs: `YOU ARE WEARING THE DOCUMENTATION ENGINEER'S HAT.
You edit Markdown and code COMMENTS only — never executable logic. Fix references to files/paths that
moved, correct out-of-date instructions, delete misleading comments. Keep the project's documentation
voice. If a fix would require changing code, do not make it — describe it in finish() instead.`,

  infra: `YOU ARE WEARING THE INFRASTRUCTURE ENGINEER'S HAT.
Keep the IaC/Docker/CI in step with the code. When the code now needs a new env var, port, service or
managed resource, make the Terraform/compose provide it. Fix compose-vs-code drift. Minimal, reviewable
change; name the exact resource/variable and why the code needs it. Never run terraform.`,

  refactor: `YOU ARE WEARING THE REFACTORING ENGINEER'S HAT.
Improve structure, NEVER behaviour. A refactor is a REPLACEMENT: when you extract logic into a helper
or hook, you MUST (1) create it, (2) delete the original inline code, and (3) rewire the original call
site to use it — in this same change. Your diff must show DELETIONS, not just additions. Creating a new
helper/hook file and leaving the original code untouched is dead code and will be rejected — search_code
for the exact call site and edit it. Every existing test must pass unchanged. Never touch a public
export or route — that breaks callers.`,

  ux: `YOU ARE WEARING THE UX ENGINEER'S HAT.
Render missing loading/empty/error states, make components and spacing consistent with the design
system already in the code, add sensible defaults and small interaction niceties. Reuse existing
components and tokens; introduce no new styling approach. Never hard-code a user-facing string in an
internationalised app.`,
};

/** The repair brief a restarted task gets: its own previous work, plus what went wrong with it. */
function repairBrief(repair) {
  if (!repair) return null;
  return [
    '⚠ THIS IS A RESTART OF A FAILED ATTEMPT.',
    `Your previous attempt at this exact task failed: ${repair.title}`,
    repair.explanation && `Why: ${repair.explanation}`,
    repair.detail && `\nThe failure output was:\n${String(repair.detail).slice(0, 2000)}`,
    '',
    'The edits you made last time are ALREADY PRESENT in this sandbox — you are looking at your own',
    'work. Do not start over. Find the specific defect described above, fix it, and re-run the tests.',
  ]
    .filter(Boolean)
    .join('\n');
}

/* ------------------------------------------------------------------------------------------------
 * COSA È REALMENTE CAMBIATO — e chi lo deve sapere.
 *
 * Ogni task riceve `siblings`: cosa gli altri agenti hanno l'INCARICO di fare, preso dal piano. Non
 * riceve nulla su cosa hanno FATTO. Ma un task che gira dopo un altro — nell'onda seguente, oppure
 * subito dopo nello stesso sandbox — lavora SOPRA quel codice: i file sono già stati riscritti
 * sotto i suoi piedi. Finché nessuno glielo dice, chiama in buona fede una funzione che il task
 * prima ha rinominato: i due non collidono su nessun file, passano entrambi i propri test, e la
 * combinazione è rotta. È l'unico difetto che la garanzia "nessun altro task ha dichiarato questi
 * file" non copre, perché riguarda il SIGNIFICATO del codice, non la spartizione dei file.
 *
 * La superficie pubblica si ricava con `stripNonCode` di staticAnalysis.js, non con un parser
 * nuovo: un secondo analizzatore divergerebbe dal primo alla prima riga di codice insolita, e due
 * analizzatori che non concordano sono peggio di nessuno.
 * ---------------------------------------------------------------------------------------------- */

/** Le estensioni per cui la superficie pubblica ha senso; per le altre si riporta solo il file. */
const CODE_FILE = /\.(?:js|jsx|mjs|cjs|ts|tsx)$/i;

/** Il contenuto di un file nel sandbox, o `null` se non c'è — cancellato, o non ancora creato. */
export function readSource(root, rel) {
  try {
    return fs.readFileSync(path.join(root, rel), 'utf8');
  } catch {
    return null;
  }
}

/**
 * Una firma normalizzata e accorciata: serve a CONFRONTARE due versioni, non a riprodurle.
 *
 * Normalizzata perché le differenze che non sono differenze sono il modo più rapido di rendere
 * inutile un resoconto: spezzare i parametri su più righe, o lasciare la virgola finale che un
 * formattatore aggiunge, non cambia il contratto per nessun chiamante. Segnalarlo come "firma
 * cambiata" insegna a un agente a non leggere queste righe.
 */
const signature = (params) => {
  const s = String(params)
    .replace(/\s+/g, ' ')
    .replace(/\s*,\s*/g, ', ')
    .replace(/,\s*$/, '')
    .trim();
  return `(${s.length > 60 ? `${s.slice(0, 57)}…` : s})`;
};

const nameList = (names) =>
  names.slice(0, 3).map((n) => `\`${n}\``).join(', ') + (names.length > 3 ? ` (+${names.length - 3})` : '');

/**
 * La superficie pubblica di un modulo: nome esportato → firma (`(a, b)` per una funzione, `''` per
 * un valore). Costruita sul codice già spogliato di commenti e stringhe, così la parola `export`
 * dentro un commento o un template literal non conta come export.
 */
export function exportSurface(src) {
  if (src == null) return null;
  const code = stripNonCode(src);
  const surface = new Map();
  const put = (name, sig) => {
    if (/^[A-Za-z_$][\w$]*$/.test(name) && !surface.has(name)) surface.set(name, sig);
  };
  // L'ordine conta: il primo riconoscimento di un nome vince, e le forme che hanno una firma vanno
  // prima di quella generica, altrimenti ogni funzione esportata risulterebbe un valore.
  for (const m of code.matchAll(/\bexport\s+(?:default\s+)?(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)\s*\(([^)]*)\)/g)) put(m[1], signature(m[2]));
  for (const m of code.matchAll(/\bexport\s+(?:default\s+)?class\s+([A-Za-z_$][\w$]*)/g)) put(m[1], '');
  for (const m of code.matchAll(/\bexport\s+(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s+)?(?:function\s*\*?\s*[\w$]*\s*)?\(([^)]*)\)\s*(?:=>|\{)/g)) put(m[1], signature(m[2]));
  for (const m of code.matchAll(/\bexport\s+(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s+)?([A-Za-z_$][\w$]*)\s*=>/g)) put(m[1], signature(m[2]));
  for (const m of code.matchAll(/\bexport\s+(?:const|let|var)\s+([A-Za-z_$][\w$]*)/g)) put(m[1], '');
  /*
   * `export { f }` — il nome c'era, LA FIRMA NO.
   *
   * Questa riga registrava ogni riesportazione con firma vuota. Il nome risultava tracciato, ma
   * cambiare `send(url, body)` in `send(url, body, timeoutMs)` non produceva alcuna nota: prima e
   * dopo la superficie diceva `send → ''`, e il confronto non vedeva differenze.
   *
   * È esattamente lo scenario scritto nel commento che motiva questa funzione — "A cambia la firma
   * di `send`, B la chiama" — e per i moduli che esportano con la lista il meccanismo taceva. Dieci
   * moduli di ISL stesso usano questo stile; su un progetto altrui la quota può essere più alta.
   *
   * La firma si trova dove la funzione è DICHIARATA, nello stesso file: la lista di export rimanda
   * a un nome locale, e quel nome ha un corpo qualche riga sopra.
   */
  const localSignature = (name) => {
    if (!/^[A-Za-z_$][\w$]*$/.test(name)) return '';
    const fn = new RegExp(`\\bfunction\\s*\\*?\\s*${name}\\s*\\(([^)]*)\\)`).exec(code);
    if (fn) return signature(fn[1]);
    const arrow = new RegExp(`\\b(?:const|let|var)\\s+${name}\\s*=\\s*(?:async\\s+)?\\(([^)]*)\\)\\s*=>`).exec(code);
    if (arrow) return signature(arrow[1]);
    const unario = new RegExp(`\\b(?:const|let|var)\\s+${name}\\s*=\\s*(?:async\\s+)?([A-Za-z_$][\\w$]*)\\s*=>`).exec(code);
    if (unario) return signature(unario[1]);
    return ''; // un valore, non una funzione: non c'è firma da confrontare
  };
  for (const m of code.matchAll(/\bexport\s*\{([^}]*)\}/g)) {
    for (const part of m[1].split(',')) {
      const pezzi = part.split(/\s+as\s+/);
      const esposto = (pezzi[pezzi.length - 1] || '').trim();
      // La firma va cercata sul nome LOCALE (quello prima di `as`): è lui a essere dichiarato qui.
      const locale = (pezzi[0] || '').trim();
      if (esposto) put(esposto, localSignature(locale || esposto));
    }
  }
  return surface;
}

/**
 * Il delta fra due versioni dello stesso file, detto come lo vedrebbe un chiamante. Corto per
 * costruzione: finisce in un prompt, dove le righe sono poche e contate — "rimossa l'export
 * `formatDate`, aggiunta `formatDateTime`" è quanto serve, un diff no.
 */
export function surfaceNotes(beforeSrc, afterSrc) {
  const after = exportSurface(afterSrc);
  if (!after) return ['file rimosso'];
  const before = exportSurface(beforeSrc);
  if (!before) {
    const names = [...after.keys()];
    return [names.length ? `nuovo file, esporta ${nameList(names)}` : 'nuovo file'];
  }
  const gone = [...before.keys()].filter((n) => !after.has(n));
  const added = [...after.keys()].filter((n) => !before.has(n));
  const resigned = [...after.keys()].filter((n) => before.has(n) && before.get(n) !== after.get(n));
  const notes = [];
  if (gone.length) notes.push(`rimossa l'export ${nameList(gone)}`);
  if (added.length) notes.push(`aggiunta l'export ${nameList(added)}`);
  for (const n of resigned.slice(0, 2)) notes.push(`firma cambiata: \`${n}${after.get(n)}\``);
  return notes;
}

/**
 * La riga di resoconto di un task finito, per i task che verranno dopo.
 *
 * `before(rel)` dà il contenuto di prima, `null` se il file non esisteva, `undefined` se non lo
 * sappiamo — e in quel caso si riporta solo il nome del file: una firma inventata è peggio del
 * silenzio, perché un agente le crede.
 */
export function changeNote({ task, files = [], before, after, maxFiles = 4 }) {
  if (!files.length) return null;
  const parts = [];
  for (const rel of files.slice(0, maxFiles)) {
    const pre = before?.(rel);
    if (!CODE_FILE.test(rel) || pre === undefined) {
      parts.push(rel);
      continue;
    }
    /*
     * IL SILENZIO NON È UNA RASSICURAZIONE.
     *
     * `surfaceNotes` riconosce le forme `export function f(…)` e `export const f = (…) =>`, non la
     * lista `export { f }` né la sintassi TypeScript. Su quei file restituisce [] — e un elenco
     * vuoto, accanto a un file che compare fra quelli CAMBIATI, un agente lo legge come "la
     * superficie pubblica non è cambiata". È la lettura opposta a quella vera, ed è esattamente
     * ciò che questo resoconto esiste per evitare.
     *
     * Finché l'analisi non copre quelle forme, lo dichiara: "superficie non analizzabile" manda
     * l'agente ad aprire il file, mentre il nome nudo lo convince di non doverlo fare.
     */
    const notes = surfaceNotes(pre, after?.(rel) ?? null);
    if (notes.length) {
      parts.push(`${rel}: ${notes.join('; ')}`);
    } else {
      const analizzabile = /\.(?:js|jsx|mjs|cjs)$/i.test(rel)
        && !/^\s*export\s*\{/m.test(pre || '');
      parts.push(analizzabile ? rel : `${rel} (cambiato — superficie non analizzabile, apri il file)`);
    }
  }
  const rest = files.length - maxFiles;
  if (rest > 0) parts.push(`+${rest} ${rest === 1 ? 'altro file' : 'altri file'}`);
  return `- [${task?.agent || 'agent'}] ${task?.title || 'task'} → ${parts.join(' · ')}`;
}

/** Il blocco di prompt che porta quel resoconto sotto gli occhi dell'agente. */
function priorWorkBlurb(priorWork) {
  const body = (Array.isArray(priorWork) ? priorWork : String(priorWork || '').split('\n')).filter(Boolean);
  if (!body.length) return null;
  return [
    'GIÀ CAMBIATO IN QUESTA ITERAZIONE — il codice che hai sotto mano è già stato modificato da',
    'altri agenti in questa stessa iterazione, quindi non è più quello del branch:',
    // Le ultime otto, non le prime otto: le righe recenti sono quelle che descrivono il codice
    // che questo task ha davvero sotto mano, e un prompt ha poche righe da spendere.
    ...body.slice(-8),
    'Se chiami o tocchi uno di questi simboli, verifica la firma ATTUALE con read_file prima di' +
      ' editare: un richiamo alla versione vecchia compila, passa i test del tuo file e rompe la combinazione.',
  ].join('\n');
}

const isTestPath = (p) => /(^|\/)__tests__\//.test(p) || /\.(test|spec)\.[jt]sx?$/.test(p);

/** The conventional test-file path beside a source file: lib/crypto.js → lib/__tests__/crypto.test.js. */
export function testPathFor(srcRel) {
  const rel = String(srcRel).replace(/\\/g, '/');
  const dir = rel.includes('/') ? rel.slice(0, rel.lastIndexOf('/')) : '.';
  const file = rel.includes('/') ? rel.slice(rel.lastIndexOf('/') + 1) : rel;
  const ext = /\.(jsx|tsx)$/.test(file) ? file.slice(file.lastIndexOf('.')) : '.js';
  const base = file.replace(/\.(jsx?|tsx?|mjs|cjs)$/, '');
  return `${dir}/__tests__/${base}.test${ext}`;
}

// Words that appear in task titles but aren't code symbols — filtered out so we
// window a big file on the ACTUAL function/identifier the task is about.
const SYMBOL_STOP = new Set(
  ('add the and for with error handling validation input function before after logic tests test unit ' +
    'code file page from into that this when return const async await prevent optimize timeout retry ' +
    'round trips hashing compliance gdpr race conditions to in of a an on new fix update improve check ' +
    'ensure implement create remove delete data user admin community business').split(/\s+/),
);

/** Identifiers a task mentions, longest first — the handle we use to find the spot to edit in a large file. */
function taskSymbols(task) {
  const text = [task.title, ...(task.steps || [])].join(' ');
  const ids = [...new Set(text.match(/[A-Za-z_][A-Za-z0-9_]{2,}/g) || [])];
  return ids.filter((w) => !SYMBOL_STOP.has(w.toLowerCase())).sort((a, b) => b.length - a.length);
}

const numbered = (src, from = 0) =>
  src.split('\n').map((l, i) => `${String(from + i + 1).padStart(4)}  ${l}`).join('\n');

/** A focused window of a large file around the first task symbol found in it. */
function windowAround(src, symbols, radius = 70) {
  const lines = src.split('\n');
  for (const sym of symbols) {
    // Prefer a definition site (function/const/method) over any mention.
    const defRe = new RegExp(`(function\\s+${sym}\\b|\\b${sym}\\s*[=:(]|\\b${sym}\\s*\\()`);
    let i = lines.findIndex((l) => defRe.test(l));
    if (i < 0) i = lines.findIndex((l) => l.includes(sym));
    if (i >= 0) {
      const from = Math.max(0, i - 10);
      const to = Math.min(lines.length, i + radius);
      return { sym, from: from + 1, to, body: numbered(lines.slice(from, to).join('\n'), from) };
    }
  }
  return null;
}

const PRELOAD_WHOLE_LIMIT = 20_000;

/**
 * Pre-load the code the model actually needs to edit. Small files come whole; a large
 * file (a 200KB page) is windowed around the task's symbol, because read_file truncates
 * at 16KB and the model would otherwise never see the function it was asked to change —
 * the single biggest cause of "the implementer produced no edits".
 */
function preloadFiles(sandboxRoot, files, symbols) {
  const out = [];
  for (const entry of files.slice(0, 3)) {
    const rel = typeof entry === 'string' ? entry : entry.rel;
    const label = typeof entry === 'string' ? '' : entry.label ? ` [${entry.label}]` : '';
    let src;
    try {
      src = fs.readFileSync(path.join(sandboxRoot, rel), 'utf8');
    } catch {
      continue; // file may not exist yet (a new file) or the plan listed it loosely
    }
    if (src.length <= PRELOAD_WHOLE_LIMIT) {
      out.push(`--- ${rel}${label} (current content, with line numbers) ---\n${numbered(src)}`);
    } else {
      const win = windowAround(src, symbols);
      const kb = Math.round(src.length / 1000);
      if (win) {
        out.push(
          `--- ${rel}${label} (${kb}KB — showing lines ${win.from}-${win.to} around "${win.sym}"; ` +
            `use read_file with {offset,limit} or {find} to see more) ---\n${win.body}`,
        );
      } else {
        out.push(
          `--- ${rel}${label} (${kb}KB — large file; first 180 lines shown. Use read_file {find:"<symbol>"} ` +
            `to jump to the exact spot before editing) ---\n${numbered(src.split('\n').slice(0, 180).join('\n'))}`,
        );
      }
    }
  }
  return out.join('\n\n');
}

/**
 * Execute one planned task inside the sandbox. Writes directly (safely — the
 * sandbox is a throwaway worktree). Returns which files it touched.
 *
 * `repair` turns this into a second attempt: the sandbox already contains the
 * previous attempt's edits, and the model is told exactly how they failed.
 *
 * `priorWork` sono le righe di resoconto (vedi `changeNote`) dei task già finiti in questa
 * iterazione: non cosa dovevano fare, ma cosa hanno cambiato davvero nei file che questo sandbox
 * contiene adesso.
 */
export async function runTask(sandboxRoot, task, { iterationId, signal, repair = null, iterationBrief = null, siblings = [], priorWork = null } = {}) {
  const { handlers, touched, created } = makeImplementerTools(sandboxRoot);
  const persona = PERSONAS[task.agent] || null;
  const brief = repairBrief(repair);

  // A tests task is pointed at the SOURCE file by the planner, but the test engineer
  // must not edit source — it writes a test file BESIDE it. Left unreframed, the agent
  // is deadlocked (it can't edit source, and no test file is in newFiles) and finishes
  // with zero edits. Reframe: the target becomes the __tests__ file (new if absent),
  // with the source preloaded read-only so the model knows what to cover.
  const symbols = taskSymbols(task);
  let testFor = null;
  let effectiveTask = task;
  if (task.agent === 'tests' && (task.files || []).length && !(task.files || []).some(isTestPath)) {
    const source = task.files.find((f) => !isTestPath(f)) || task.files[0];
    const tp = testPathFor(source);
    const exists = fs.existsSync(path.join(sandboxRoot, tp));
    testFor = { source, tp, exists };
    effectiveTask = { ...task, files: [tp], newFiles: exists ? task.newFiles || [] : [tp] };
  }

  // Files to preload: the source-under-test (for a tests task) plus the declared targets.
  const preloadList = [
    ...(testFor ? [{ rel: testFor.source, label: 'source under test — READ ONLY' }] : []),
    ...(effectiveTask.files || []),
  ];
  const preloaded = preloadFiles(sandboxRoot, preloadList, symbols);

  // Blast radius of the change: the callers this edit must not break, computed from the real
  // reverse-dependency graph. For a tests task it describes the source under test, not the
  // (new) test file, which has no dependents.
  const blastFiles = testFor ? [testFor.source] : (task.files || []);
  const blast = blastRadiusBlurb({ files: blastFiles });

  // FIND A SIMILAR PAST CHANGE: retrieve the proven approaches the fleet has already landed for this
  // shape of work, so the implementer reuses what worked instead of reinventing. Best-effort (falls
  // back to lexical fast); never blocks the task.
  let priorArt = null;
  try {
    const sim = await similarChanges(`${task.title} ${task.rationale || ''} ${(task.files || []).join(' ')}`, { k: 3 });
    const good = (sim.changes || []).filter((c) => (c.score ?? 0) >= 80);
    if (good.length) {
      priorArt = 'PROVEN APPROACHES — the fleet has landed similar work before (reuse what worked):\n' +
        good.map((c) => `- ${c.title} (${c.sha}, score ${c.score})`).join('\n') +
        '\nUse search_knowledge or read_file to see how those changes did it.';
    }
  } catch { /* retrieval is a nicety, never a blocker */ }

  // The Context Agent's working brief: app context + this iteration's mission, the
  // area's cautions, and what every peer task is doing in parallel — so the agent
  // always knows what it (and the rest of the fleet) is doing.
  const workingContext = taskWorkingContext({ agent: task.agent, area: task.area, task, iterationBrief, siblings });
  // Accanto al contesto di lavoro, perché è la metà che mancava: `siblings` dice cosa gli altri
  // hanno l'incarico di fare, questo dice cosa hanno già fatto al codice in questo sandbox.
  const alreadyChanged = priorWorkBlurb(priorWork);
  // The rules that apply to the files this task declared. The working context says what the fleet
  // is doing; this says what the change is not allowed to break.
  const rules = briefingFor('implementer', { files: task.files || [], area: task.area, includeSituation: false });
  /*
   * Le regole permanenti, filtrate per specialista. Quelle sulle traduzioni servono a frontend e ux,
   * non a chi tocca l'infrastruttura: ogni riga irrilevante in un prompt indebolisce quelle che
   * contano, ed è il motivo per cui `rulesFor` prende un destinatario invece di restituire tutto.
   */
  const standing = rulesFor(['implementer', task.agent].filter(Boolean));

  const testDirective = testFor
    ? `\nThis is a TEST task. Do NOT modify the source. ${testFor.exists ? `ADD tests to the existing file ${testFor.tp} with edit_file` : `CREATE ${testFor.tp} with write_file`}, copying the conventions of the nearest existing __tests__ file. Every test must pass against the CURRENT behaviour of ${testFor.source}. Then run_tests and finish.`
    : null;

  const messages = [
    { role: 'system', content: [persona ? `${SYSTEM}\n\n${persona}` : SYSTEM, workingContext, alreadyChanged, rules, standing, decisionBrief({ agentId: task.agent, area: task.area }), memoryBlurb({ agentId: task.agent, area: task.area })].filter(Boolean).join('\n\n') },
    {
      role: 'user',
      content: [
        brief && `${brief}\n`,
        `TASK (${task.kind}): ${task.title}`,
        task.rationale && `Rationale: ${task.rationale}`,
        task.area && `Area: ${task.area}`,
        effectiveTask.files?.length && `Target file(s): ${effectiveTask.files.join(', ')}`,
        effectiveTask.newFiles?.length &&
          `These are NEW files — create them with write_file: ${effectiveTask.newFiles.join(', ')}. The others already exist; edit them with edit_file.`,
        task.steps?.length && `Suggested steps:\n${task.steps.map((s, i) => `${i + 1}. ${s}`).join('\n')}`,
        task.integration && `Integration notes: ${task.integration}`,
        blast && `\n${blast}`,
        priorArt && `\n${priorArt}`,
        testDirective,
        preloaded && `\n${preloaded}`,
        repair
          ? '\nFix the defect described above with edit_file, then run_tests, then finish.'
          : testFor
            ? '\nWrite the test file now, then run_tests, then finish. Ship a concrete change.'
            : '\nMake the edit now with edit_file, then run_tests, then finish. Ship a concrete change.',
      ]
        .filter(Boolean)
        .join('\n'),
    },
  ];

  let steps = 0;
  let summary = null;
  let nudges = 0;
  let finishNudges = 0;
  let deadNudged = false;
  // Set when the agent declares, through `finish`, that the codebase already satisfies the task.
  let alreadySatisfied = false;
  let midNudged = false;
  let tokensIn = 0;
  let tokensOut = 0;
  // Past this point, exploring further just burns the budget with nothing to show.
  const commitBy = Math.max(4, Math.ceil(IMPLEMENTER_MAX_STEPS * 0.5));

  while (steps < IMPLEMENTER_MAX_STEPS) {
    if (signal?.aborted) throw new Error('interrupted');
    steps++;

    // Halfway through with no edit yet is the road to an empty iteration. Push the
    // model to stop reading and commit the concrete change while it still has steps.
    if (!midNudged && steps >= commitBy && touched().length === 0) {
      midNudged = true;
      messages.push({
        role: 'user',
        content:
          `You are ${steps} step(s) in and have not edited any file yet — you have ${IMPLEMENTER_MAX_STEPS - steps} left. ` +
          'Stop exploring. You have enough to act: make the single most useful concrete edit for this task NOW with ' +
          'edit_file or write_file (the file content you need is in the preload above; use read_file {find:"<symbol>"} only if you truly must), ' +
          'then run_tests, then finish.',
      });
    }
    // The model is the one truly serial resource — hold a slot only for the
    // generation itself, and release it while this task runs its tests, so a
    // sibling task in the same wave can think while we wait on the suite.
    const { content, toolCalls, usage } = await llmGate.run(
      () =>
        chat({
          messages,
          model: modelFor('implement'),
          tools: IMPLEMENTER_TOOLS,
          think: true,
          signal,
          onToken: (text, kind) => emit('impl.token', { iterationId, taskTitle: task.title, text, kind }),
        }),
      signal,
    );
    tokensIn += usage?.promptTokens || 0;
    tokensOut += usage?.evalTokens || 0;
    messages.push({ role: 'assistant', content, ...(toolCalls.length ? { tool_calls: toolCalls } : {}) });

    if (!toolCalls.length) {
      // A turn that ends with prose but no tool call is only a valid ENDING if the model
      // has actually edited something — then the prose is its summary. If it has touched
      // NO file, this is the classic local-model failure: it pasted the file content (or
      // a plan) as chat text instead of calling write_file/edit_file, and that text is
      // thrown away. Don't accept it as success — push it to use the tool.
      const madeEdit = touched().length > 0;
      if (content.trim() && madeEdit) {
        summary = content.trim();
        break;
      }
      if (nudges++ < 3) {
        messages.push({
          role: 'user',
          content: madeEdit
            ? 'If the change is complete, call finish(summary). Otherwise continue with a tool call.'
            : 'You did not call a tool, and pasting code in the chat does NOT create a file — that text is ignored. ' +
              'Use write_file(path, content) to CREATE the file now (or edit_file for an existing one), then run_tests, then finish. Act now.',
        });
        continue;
      }
      summary = content.trim() ? `ended with prose but no edit — ${content.trim().slice(0, 160)}` : 'ended without an explicit finish';
      break;
    }

    let done = false;
    for (const call of toolCalls) {
      const name = call.function?.name;
      const args = toolArgs(call);
      emit('impl.tool', { iterationId, taskTitle: task.title, tool: name, path: args?.path });
      let obs;
      const fn = handlers[name];
      if (!fn) obs = `Unknown tool: ${name}`;
      else {
        try {
          obs = await fn(args); // run_tests is async; the rest resolve immediately
        } catch (err) {
          obs = `Error: ${err.message}`;
        }
      }
      if (typeof obs === 'string' && obs.startsWith('__FINISH__')) {
        summary = obs.slice('__FINISH__'.length);
        if (summary.startsWith('__SATISFIED__')) {
          summary = summary.slice('__SATISFIED__'.length);
          alreadySatisfied = true;
        }
        // Guard against the "give up without doing anything" failure mode: if the
        // model tries to finish having touched no file, push back once and make it
        // either ship a concrete edit or justify a genuine impossibility.
        //
        // A declared "the work is already here" is exempt: nudging it produces either a
        // pointless duplicate test file or the same answer a second time, and the eleven
        // measured cases were all correct on the first pass.
        if (touched().length === 0 && !alreadySatisfied && finishNudges < 1) {
          finishNudges++;
          emit('impl.tool', { iterationId, taskTitle: task.title, tool: 'finish_rejected' });
          obs =
            'You are trying to finish without changing any file. That fails the task. ' +
            'Make the smallest concrete useful edit for this task now with edit_file (or write_file), ' +
            'then run_tests and finish. Only give up if it is truly impossible — and if so, state the ' +
            'exact blocker and the smaller change you could make instead.';
          messages.push({ role: 'tool', tool_name: name, content: obs });
          continue;
        }
        // DEAD-CODE self-check: a file you created that nothing imports is cruft — the
        // exact "new helper nobody uses" failure. Make the model wire it in or delete it
        // (this also gets vetoed at review, so finishing here just wastes the iteration).
        if (!deadNudged) {
          const orphans = unusedCreatedFiles(sandboxRoot, created());
          if (orphans.length) {
            deadNudged = true;
            emit('impl.tool', { iterationId, taskTitle: task.title, tool: 'deadcode_rejected' });
            obs =
              `DEAD CODE: you created ${orphans.join(', ')} but nothing imports it. An unused new file is ` +
              'not an improvement and will be rejected. Either (a) wire it in — import and actually USE it from ' +
              'the real caller with edit_file (for a refactor, replace the original duplicated code so it now ' +
              'calls your new code), or (b) if you cannot, delete it and make the change inline instead. ' +
              'Use search_code to find the caller. Then run_tests and finish.';
            messages.push({ role: 'tool', tool_name: name, content: obs });
            continue;
          }
        }
        done = true;
        obs = 'Task complete.';
      }
      messages.push({ role: 'tool', tool_name: name, content: String(obs) });
    }
    compact(messages);
    if (done) break;
  }

  const files = touched();
  /*
   * "NOTHING TO DO" IS A SUCCESS.
   *
   * `ok` used to be `files.length > 0` and nothing else, so an agent that inspected the codebase,
   * found the task already done, and said so was scored exactly like one that failed. The target
   * stayed pending and was reissued — measured: eleven tasks across the sample, several of them the
   * *same* test file proposed three separate times, each burning a full agent turn to rediscover
   * that it had 28 tests already.
   *
   * The flag is declared by the agent through `finish(alreadySatisfied: true)` rather than inferred
   * from its prose, so this cannot be triggered by a model that happens to use the word "exists".
   */
  const ok = files.length > 0 || alreadySatisfied;
  // When nothing was written, say WHY in words the operator can act on, instead of the
  // useless "no summary". The model's own last words are the best available reason.
  const reason = files.length > 0
    ? summary || 'edited but gave no summary'
    : alreadySatisfied
      ? `no change needed — ${(summary || 'the codebase already does this').slice(0, 200)}`
      : summary && summary !== 'no summary'
        ? `made no edit — ${summary.slice(0, 200)}`
        : `the implementer finished without editing any file (it could not turn the task into a concrete change after ${steps} step(s))`;
  /*
   * The reason is carried on `error` as well when the task failed.
   *
   * `engine.js` records `result.error` against the task, and this path set only `summary` — so the
   * most common failure the loop has ("the implementer finished without editing any file") was
   * stored with a NULL reason. Measured: 154 of 420 task failures had none. Everything downstream
   * keys off that field: the reliability clustering that groups recurring failures, the deferral
   * that retires a target which keeps failing, and the memory that turns a repeated failure into a
   * lesson. A carefully worded reason computed here and dropped one line later is the same as no
   * reason at all.
   */
  return { ok, alreadySatisfied, summary: reason, error: ok ? null : reason, filesChanged: files, steps, tokensIn, tokensOut };
}

/**
 * Run every task in the batch, sequentially, against the same sandbox so their
 * changes accumulate into one reviewable iteration.
 *
 * Sequenziale non vuol dire informato: il task numero 3 edita un sandbox che i primi due hanno già
 * riscritto. `landed` è il resoconto di quelle modifiche, e viaggia avanti insieme al codice.
 * @returns {{ results, touched: string[], summary, tokensIn, tokensOut }}
 */
export async function implementBatch({ sandboxRoot, tasks, iterationId, onProgress, signal, logger = log.for('implementer') }) {
  const results = [];
  const allTouched = new Set();
  const landed = []; // cosa i task già finiti hanno realmente cambiato in questo sandbox
  let tokensIn = 0;
  let tokensOut = 0;

  for (let i = 0; i < tasks.length; i++) {
    const task = tasks[i];
    if (signal?.aborted) throw new Error('interrupted');
    onProgress?.({ index: i + 1, total: tasks.length, task });
    emit('impl.task_started', { iterationId, index: i + 1, total: tasks.length, title: task.title, kind: task.kind });
    logger.info?.(`task ${i + 1}/${tasks.length}: ${task.title}`, { runId: iterationId });

    const siblings = tasks.filter((_, j) => j !== i).map((t) => ({ agent: t.agent, title: t.title, area: t.area }));
    // Lo stato dei file dichiarati PRIMA che il task li tocchi. Il sandbox è condiviso con i task
    // seguenti, quindi dopo l'edit il "prima" non è più recuperabile da nessuna parte.
    const before = new Map();
    for (const rel of new Set([...(task.files || []), ...(task.newFiles || [])])) before.set(rel, readSource(sandboxRoot, rel));
    let r;
    try {
      r = await runTask(sandboxRoot, task, { iterationId, signal, siblings, priorWork: landed });
    } catch (err) {
      if (err.message === 'interrupted') throw err;
      /*
       * `error` as well as `summary`, because they go to different places.
       *
       * `engine.js` passes `result.error` to `finishTask`, and this path only ever set `summary` —
       * so every task that failed by throwing recorded a NULL reason. Measured: **154 of 420 task
       * failures had no error at all**, which is a third of the fleet's failures that nothing could
       * learn from, no cluster could group, and no operator could diagnose. The message existed the
       * whole time; it was simply written to the wrong field.
       */
      r = { ok: false, summary: err.message, error: err.message, filesChanged: [], steps: 0, tokensIn: 0, tokensOut: 0 };
    }
    results.push(r);
    r.note = changeNote({
      task,
      files: r.filesChanged,
      before: (rel) => (before.has(rel) ? before.get(rel) : undefined),
      after: (rel) => readSource(sandboxRoot, rel),
    });
    if (r.ok && r.note) landed.push(r.note);
    r.filesChanged.forEach((f) => allTouched.add(f));
    tokensIn += r.tokensIn;
    tokensOut += r.tokensOut;
    emit('impl.task_finished', { iterationId, index: i + 1, title: task.title, ok: r.ok, files: r.filesChanged.length });
  }
  onProgress?.({ status: 'finished' });

  const done = results.filter((r) => r.ok).length;
  return {
    results,
    touched: [...allTouched],
    summary: `${done}/${tasks.length} task(s) applied · ${allTouched.size} file(s) changed`,
    tokensIn,
    tokensOut,
  };
}

/** Same context-window guard the proposal runner uses. */
function compact(messages) {
  const idx = messages.map((m, i) => (m.role === 'tool' ? i : -1)).filter((i) => i >= 0);
  let total = idx.reduce((n, i) => n + messages[i].content.length, 0);
  if (total <= TOOL_HISTORY_BUDGET) return;
  for (const i of idx.slice(0, -3)) {
    if (total <= TOOL_HISTORY_BUDGET) break;
    if (messages[i].elided) continue;
    const ph = `[earlier ${messages[i].tool_name} output elided to fit the context window]`;
    total -= messages[i].content.length - ph.length;
    messages[i].content = ph;
    messages[i].elided = true;
  }
}
