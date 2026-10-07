import { createSandbox, removeWorktree, changedFiles, copyFiles, stageProductAndDiff } from '../sandbox/worktree.js';
import { planWaves, describeWaves, parallelism } from '../core/scheduler.js';
import { mapLimit } from '../core/semaphore.js';
import { runTask, changeNote, readSource } from './implementer.js';
import { checkScope, scopeGateMode } from './scopeGate.js';
import { checkConflictMarkers } from './conflictGate.js';
import { emit } from '../bus.js';
import { log } from '../logger.js';

/**
 * IL CONTROLLO FRA UN'ONDA E L'ALTRA.
 *
 * Prima non ne girava nessuno: si verificava solo in `finalize`. La differenza non è accademica —
 * un identificatore mai legato introdotto nell'onda 1 arrivava in fondo alla iterazione, dove il
 * veto annulla TUTTO, anche le onde che non c'entravano, e il messaggio di fallimento diceva
 * soltanto "l'iterazione è fallita". Nessuno sapeva quale task incolpare.
 *
 * Qui, dopo ogni onda, l'accumulatore passa due gate DETERMINISTICI già in esercizio: i marcatori
 * di conflitto e lo scope. Nessun LLM — il costo è un `git diff` più due scansioni di testo, così
 * può girare sempre e nessuno lo disattiverà perché è lento.
 *
 * DECISIONE DI PROGETTO: registra e ATTRIBUISCE, non ferma. Le due alternative sono entrambe
 * peggiori. Fermare l'iterazione all'onda 1 butta via lavoro già pagato, e lo fa su un segnale che
 * non è definitivo: un nome non legato dall'onda 1 può essere GUARITO dall'onda 2, che aggiunge
 * l'helper mancante — ed è il motivo per cui `checkScope` è consultivo di default, sbaglia qualche
 * volta (~1.4% misurato). Proseguire in silenzio riporta esattamente al difetto di oggi. Quindi il
 * registro tiene, per ogni difetto, l'onda in cui è COMPARSO e l'ultima in cui è stato VISTO: i
 * difetti guariti cadono da sé, i sopravvissuti escono nel risultato con il task e l'agente che li
 * hanno introdotti. `finalize` continua a decidere SE committare; questo decide CHI nominare
 * quando non si committa.
 */

/** Identità stabile di un difetto: lo stesso nome nello stesso file è un difetto solo, non uno per onda. */
const defectKey = (d) => `${d.kind}:${d.file}:${d.name}`;

/** Come si nomina il colpevole in un log leggibile da un umano. */
const blame = (d) => (d.by ? `task ${d.by.index} "${d.by.title}" [${d.by.agent}]` : 'origine non attribuita');

/**
 * Passa i gate deterministici sull'accumulatore e attribuisce ciò che trova.
 *
 * Il diff arriva da `stageProductAndDiff`, lo stesso meccanismo che usano `finalize` e il
 * checkpoint di fine task: un secondo modo di calcolare il diff sarebbe un secondo modo di
 * sbagliarlo. Se git non collabora il controllo semplicemente non gira — un controllo non deve
 * diventare un nuovo modo di far fallire la iterazione.
 *
 * @param {string} accumulator  il worktree che tiene la modifica dell'intera iterazione
 * @param {{wave:number, owners:Map, ledger:Map, iterationId:any, logger:any}} ctx
 * @returns {{checked:boolean, fresh:Array}}  `fresh` = i difetti comparsi in QUESTA onda
 */
function auditWave(accumulator, { wave, owners, ledger, iterationId, logger }) {
  /*
   * TUTTO DENTRO IL try, non solo la prima riga.
   *
   * La protezione copriva soltanto `stageProductAndDiff`. Fuori restavano `scopeGateMode()` — che
   * fa una lettura SQLite — `checkConflictMarkers`, `checkScope` (espressioni regolari pesanti su
   * ogni file cambiato) e l'attribuzione. Un'eccezione da uno qualunque di questi risaliva fuori da
   * `implementParallel`, attraversava `phase('implement')` e uccideva l'iterazione A META' DELLE
   * ONDE, dopo che il lavoro del modello era già stato pagato, con un messaggio che non riguardava
   * nessun task.
   *
   * Cioè esattamente il fallimento che questo controllo esiste per evitare, spostato dentro il
   * controllore. Il precedente sta a due file di distanza: `checkpointDiff` in engine.js avvolge
   * tutto e spiega perché deve farlo — un meccanismo di osservazione che abbatte ciò che osserva è
   * peggio della sua assenza.
   */
  try {
    const diff = stageProductAndDiff(accumulator).diff;
    if (!diff) return { checked: true, fresh: [] };

    const found = [];
    for (const f of checkConflictMarkers(diff).findings) {
      found.push({ kind: 'conflict', file: f.file, name: String(f.line).trim() });
    }
    // `off` è una scelta dell'operatore sullo scope gate e vale anche qui: nessun rumore su una
    // dimensione che ha deciso di non guardare. I marcatori di conflitto non hanno modalità.
    let scopeChecked = true;
    if (scopeGateMode() !== 'off') {
      const scope = checkScope(diff, { root: accumulator });
      /*
       * `checked: false` vuol dire "non ho potuto guardare" — nessun file in un linguaggio che
       * l'analizzatore capisce, oppure file illeggibili. Scambiarlo per "pulito" farebbe risultare
       * GUARITI tutti i difetti registrati prima, cancellandoli in silenzio: il filtro a valle
       * deduce la guarigione dall'assenza del difetto, e l'assenza di uno sguardo non è l'assenza
       * di un problema.
       */
      scopeChecked = scope.checked;
      for (const f of scope.findings) {
        found.push({ kind: f.kind === 'component' ? 'scope/component' : 'scope/call', file: f.file, name: f.name });
      }
    }

    return { checked: scopeChecked, fresh: attributeFindings(found, { wave, owners, ledger }) };
  } catch (err) {
    logger?.debug?.(`onda ${wave}: controllo saltato (${err.message})`, { runId: iterationId });
    return { checked: false, fresh: [] };
  }
}

/**
 * Aggiorna il registro e restituisce i difetti COMPARSI in questa onda.
 *
 * Separata dall'IO perché è la parte che può sbagliare in modo silenzioso: un difetto imputato
 * all'onda sbagliata è peggio di nessuna imputazione. Un difetto già noto non viene ri-annunciato,
 * resta imputato all'onda che l'ha introdotto, e si limita ad aggiornare `lastSeen` — il campo da
 * cui si capisce, in fondo, se è stato guarito.
 */
export function attributeFindings(found, { wave, owners, ledger }) {
  const fresh = [];
  for (const f of found) {
    const key = defectKey(f);
    const known = ledger.get(key);
    if (known) {
      known.lastSeen = wave;
      continue;
    }
    const entry = { ...f, introducedIn: wave, lastSeen: wave, by: owners.get(f.file) || null };
    ledger.set(key, entry);
    fresh.push(entry);
  }
  return fresh;
}

/**
 * Parallel batch implementer.
 *
 * The old executor ran tasks one after another against a single sandbox. That is
 * simple and it is slow: an iteration with four tasks spent four times as long as
 * it needed to, because "add a rate limit to auth" and "paginate the listings
 * query" have nothing to do with each other and were still made to queue.
 *
 * Here, tasks are grouped into waves of mutually non-conflicting work (see
 * core/scheduler.js) and each wave runs concurrently, every task in its own
 * throwaway sandbox. Because no two tasks in a wave touch the same file, folding
 * their results back together is a copy, not a merge — there is no conflict to
 * resolve. Later waves are seeded with everything the earlier ones produced, so a
 * task that *does* depend on a previous edit still sees it.
 *
 * E ora sa anche COSA ha visto. Il codice viaggiava fra le onde, la conoscenza no: un agente
 * dell'onda 2 editava file già riscritti dall'onda 1 sapendo soltanto i TITOLI dei task altrui,
 * presi dal piano. Dopo ogni onda si costruisce il resoconto di ciò che è realmente cambiato —
 * quali file, da quale task, e quali export sono comparse, sparite o cambiate di firma — e lo si
 * passa alle onde successive accanto a `siblings`. È il difetto che la garanzia di non-collisione
 * non copriva: A cambia la firma in a.js, B la chiama da b.js, file diversi, nessuna collisione,
 * entrambi verdi, la combinazione rotta.
 *
 * The model itself remains the bottleneck and stays behind a semaphore (llmGate),
 * so widening parallelism never oversubscribes the GPU — it just means one task can
 * be running tests while another is thinking, which is exactly the win we want.
 */
export async function implementParallel({
  accumulator, // the sandbox that ends up holding the whole iteration's change
  base, // commit the sandboxes are cut from
  tasks,
  taskIds,
  iterationId,
  iterationBrief = null,
  maxParallel = 2,
  onTaskStart,
  onTaskFinish,
  signal,
  logger = log.for('implementer'),
}) {
  const waves = planWaves(tasks, maxParallel);
  const shape = parallelism(waves);
  const serialEstimate = tasks.length;

  emit('iteration.waves', {
    iterationId,
    waves: waves.map((w, i) => ({ wave: i + 1, tasks: w.map((x) => ({ index: x.index, title: x.task.title, agent: x.task.agent })) })),
    widest: shape.widest,
  });
  logger.info?.(
    `${tasks.length} task(s) → ${waves.length} wave(s), up to ${shape.widest} in parallel\n${describeWaves(waves)}`,
    { runId: iterationId },
  );

  const results = new Array(tasks.length);
  let tokensIn = 0;
  let tokensOut = 0;
  const startedAt = Date.now();
  let serialMs = 0; // summed task time — what a serial run would have cost

  // Chi ha scritto quale file, onda per onda. È l'unica cosa che trasforma "l'iterazione è
  // fallita" in "il task 3 ha rotto questo file": il file è il solo anello fra un finding del
  // gate e il task che lo ha prodotto.
  const owners = new Map(); // file → { wave, index, agent, title }
  const defects = new Map(); // defectKey → { kind, file, name, introducedIn, lastSeen, by }
  let lastAudited = 0; // ultima onda in cui il controllo è davvero girato

  // Cosa le onde già finite hanno REALMENTE cambiato, una riga per task. Non i titoli del piano:
  // i file toccati e il delta delle export. È ciò che le onde successive leggono nel prompt.
  const landed = [];

  for (let w = 0; w < waves.length; w++) {
    if (signal?.aborted) throw new Error('interrupted');
    const wave = waves[w];
    emit('iteration.wave_started', { iterationId, wave: w + 1, total: waves.length, tasks: wave.length });

    // Whatever previous waves produced must be visible to this one.
    const carry = changedFiles(accumulator);
    // …e insieme ai file, il resoconto di cosa quelle onde hanno fatto a quei file. Le ultime
    // otto righe: deve stare in un prompt, dove le righe sono poche e contate.
    const priorWork = landed.slice(-8);

    const outcomes = await mapLimit(wave, wave.length, async ({ task, index }) => {
      if (signal?.aborted) throw new Error('interrupted');

      // A wave of one doesn't need its own sandbox — work straight in the accumulator.
      const solo = wave.length === 1;
      const root = solo ? accumulator : createSandbox([], base);
      if (!solo && carry.length) copyFiles(accumulator, root, carry);

      const t0 = Date.now();
      onTaskStart?.({ index, task, wave: w + 1 });
      emit('impl.task_started', { iterationId, index: index + 1, total: tasks.length, title: task.title, kind: task.kind, agent: task.agent, wave: w + 1 });

      // The peers this task runs beside: every other task in the iteration. The
      // Context Agent turns this into "what the rest of the fleet is doing now".
      const siblings = tasks.filter((_, j) => j !== index).map((t) => ({ agent: t.agent, title: t.title, area: t.area }));

      // Lo stato dei file dichiarati PRIMA dell'edit, per poter dire dopo cosa è cambiato. Si
      // cattura adesso perché in un'onda di uno `root` È l'accumulatore: dopo, il "prima" non
      // esiste più da nessuna parte.
      const before = new Map();
      for (const rel of new Set([...(task.files || []), ...(task.newFiles || [])])) before.set(rel, readSource(root, rel));

      try {
        const r = await runTask(root, task, { iterationId, signal, iterationBrief, siblings, priorWork });
        r.ms = Date.now() - t0;

        /*
         * Cosa questo task ha realmente fatto. Calcolato PRIMA del fold: dopo la copia
         * l'accumulatore non ha più la versione precedente, e per un file non dichiarato è l'unico
         * posto da cui leggerla (in un'onda di uno la si è catturata sopra). `undefined` significa
         * "non lo sappiamo", e allora si riporta solo il nome del file: una firma inventata è
         * peggio del silenzio, perché un agente le crede.
         */
        r.note = changeNote({
          task,
          files: r.filesChanged,
          before: (rel) => (before.has(rel) ? before.get(rel) : solo ? undefined : readSource(accumulator, rel)),
          after: (rel) => readSource(root, rel),
        });

        // Fold this task's edits into the accumulator. Safe by construction: no
        // other task in this wave declared any of these files.
        if (!solo && r.filesChanged.length) copyFiles(root, accumulator, r.filesChanged);

        return r;
      } finally {
        if (!solo) removeWorktree(root);
      }
    });

    // Record the wave.
    let waveMs = 0;
    outcomes.forEach((o, i) => {
      const { task, index } = wave[i];
      const r = o.ok
        ? o.value
        : { ok: false, summary: o.error?.message || 'task failed', filesChanged: [], steps: 0, tokensIn: 0, tokensOut: 0, ms: 0, error: o.error?.message };

      // An interruption is not a task failure — it must abort the whole iteration.
      if (!o.ok && o.error?.message === 'interrupted') throw o.error;

      results[index] = r;
      // Solo i task riusciti: un task che non ha scritto niente non ha niente da raccontare, e un
      // resoconto che elenca lavoro mai avvenuto è peggio di un resoconto assente.
      if (r.ok && r.note) landed.push(r.note);
      tokensIn += r.tokensIn || 0;
      tokensOut += r.tokensOut || 0;
      serialMs += r.ms || 0;
      waveMs = Math.max(waveMs, r.ms || 0);

      onTaskFinish?.({ index, task, result: r, wave: w + 1, taskId: taskIds?.[index] });
      emit('impl.task_finished', {
        iterationId,
        index: index + 1,
        title: task.title,
        ok: r.ok,
        files: r.filesChanged.length,
        agent: task.agent,
        wave: w + 1,
        ms: r.ms,
      });
    });

    /* --------------------- controllo di fine onda --------------------- */
    for (const { task, index } of wave) {
      for (const f of results[index]?.filesChanged || []) {
        owners.set(f, { wave: w + 1, index: index + 1, agent: task.agent, title: task.title });
      }
    }
    const audit = auditWave(accumulator, { wave: w + 1, owners, ledger: defects, iterationId, logger });
    if (audit.checked) lastAudited = w + 1;
    if (audit.fresh.length) {
      emit('iteration.wave_defects', {
        iterationId,
        wave: w + 1,
        total: waves.length,
        defects: audit.fresh.map((d) => ({
          kind: d.kind,
          file: d.file,
          name: d.name,
          agent: d.by?.agent ?? null,
          task: d.by?.title ?? null,
          index: d.by?.index ?? null,
        })),
      });
      // Il log è la copia che sopravvive: l'evento è live per la dashboard, questa riga resta.
      logger.warn?.(
        `onda ${w + 1}/${waves.length}: ${audit.fresh.length} difetto(i) comparsi — ` +
          audit.fresh.slice(0, 5).map((d) => `${d.kind} ${d.name} (${d.file}) ← ${blame(d)}`).join('; ') +
          (audit.fresh.length > 5 ? ', …' : '') +
          ' · l\'iterazione continua, può ancora essere riparata da un\'onda successiva',
        { runId: iterationId },
      );
    }

    emit('iteration.wave_finished', { iterationId, wave: w + 1, ms: waveMs, defects: audit.fresh.length });
  }

  const wallMs = Date.now() - startedAt;
  const savedMs = Math.max(0, serialMs - wallMs);
  const done = results.filter((r) => r?.ok).length;
  const touched = new Set();
  results.forEach((r) => r?.filesChanged?.forEach((f) => touched.add(f)));

  /*
   * Sopravvive solo ciò che l'ULTIMO controllo ha ancora visto.
   *
   * Un difetto comparso nell'onda 1 e assente nell'onda 2 è stato guarito — tipicamente dal task
   * che ha aggiunto l'helper che mancava — e imputarlo a qualcuno sarebbe un'accusa falsa, cioè la
   * strada più breve perché questo controllo venga ignorato. L'ordine è quello di scoperta, quindi
   * il primo elemento è il più antico: è quello da nominare.
   */
  const waveDefects = lastAudited
    ? [...defects.values()]
        .filter((d) => d.lastSeen === lastAudited)
        .map((d) => ({
          kind: d.kind,
          file: d.file,
          name: d.name,
          wave: d.introducedIn,
          index: d.by?.index ?? null,
          task: d.by?.title ?? null,
          agent: d.by?.agent ?? null,
        }))
    : [];
  const blameLine = waveDefects.length
    ? ` · ${waveDefects.length} difetto(i) deterministici ancora presenti, il primo introdotto nell'onda ` +
      `${waveDefects[0].wave}${waveDefects[0].task ? ` dal task ${waveDefects[0].index} "${waveDefects[0].task}"` : ''}`
    : '';

  logger.info?.(
    `${done}/${tasks.length} task(s) landed · ${touched.size} file(s) · ` +
      `${Math.round(wallMs / 1000)}s wall vs ~${Math.round(serialMs / 1000)}s serial (saved ~${Math.round(savedMs / 1000)}s)` +
      blameLine,
    { runId: iterationId },
  );

  return {
    results,
    touched: [...touched],
    waves: waves.map((w, i) => ({ wave: i + 1, tasks: w.map((x) => x.index) })),
    summary:
      `${done}/${tasks.length} task(s) applied · ${touched.size} file(s) changed · ${waves.length} wave(s), ` +
      `~${Math.round(savedMs / 1000)}s saved by running in parallel${blameLine}`,
    // Chi ha introdotto cosa: `finalize` ha il diff e il veto, non il nome del task.
    waveDefects,
    savedMs,
    wallMs,
    serialMs,
    serialEstimate,
    tokensIn,
    tokensOut,
  };
}
