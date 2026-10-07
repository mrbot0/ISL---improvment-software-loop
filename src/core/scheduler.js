/**
 * Conflict-aware, importance-aware wave scheduler.
 *
 * Tasks in one iteration are mostly independent — "add a rate limit to auth" and
 * "paginate the listings query" have nothing to do with each other and there is no
 * reason to run them one after the other. But two tasks that edit the SAME file
 * cannot run in parallel sandboxes: their diffs would collide at merge time and
 * one would silently clobber the other.
 *
 * So we partition the batch into waves. Within a wave, no two tasks declare an
 * overlapping file; across waves, order is preserved. Each wave runs concurrently,
 * and the next wave starts from the merged result of the previous one — so a task
 * that follows a conflicting one still sees its predecessor's edits.
 *
 * ORDINE FRA LE ONDE. Le onde si formavano in ordine di piano: il primo task del piano
 * apriva l'onda 1, e chi collideva con lui slittava. Il risultato e' che l'importanza del
 * lavoro non entrava mai nella decisione — una falla di sicurezza poteva finire nell'onda 3
 * dietro a un rinominamento, e un'iterazione che si ferma prima (budget esaurito,
 * interruzione, onda fallita) non la eseguiva affatto. Il piano porta gia' i segnali per
 * decidere (`agent`, `kind`, e la `priority` quando il backlog la dichiara): ora le onde si
 * formano a partire da quelli.
 *
 * DUE GARANZIE, in quest'ordine di precedenza:
 *
 *   1. La CORRETTEZZA viene prima dell'ordine. L'importanza decide solo fra task che si
 *      possono comunque mettere insieme: due task che dichiarano uno stesso file non
 *      finiscono nella stessa onda qualunque sia la loro priorita'. Il test di collisione e'
 *      un cancello, non un peso — non lo si puo' compensare con un punteggio alto.
 *
 *   2. Nessun task resta indietro per sempre. Un ordinamento per sola importanza e' una
 *      coda a priorita' senza invecchiamento: il lavoro meno importante slitta ad ogni onda
 *      e, se il piano lo ripropone identico ad ogni iterazione, slitta per sempre. Quindi lo
 *      slittamento e' LIMITATO: si calcola prima il piano in ordine di piano, e l'onda che
 *      ogni task ottiene la' diventa la sua scadenza (+ `maxSlip`). Un task scaduto entra
 *      nell'onda corrente prima di chiunque altro. Con `maxSlip` onde di tolleranza, nessun
 *      task puo' finire piu' di `maxSlip` onde dietro la posizione che avrebbe avuto senza
 *      alcun riordino: il ritardo e' limitato da una costante, non dal numero di task
 *      importanti che arrivano dopo.
 *
 *      Il limite vale fra task AMMISSIBILI: come la collisione, un cancello di correttezza
 *      viene prima della scadenza, perche' eseguire un task scaduto ma non eseguibile non e'
 *      eseguirlo. Un task trattenuto da un cancello non e' pero' affamato — resta scaduto, e
 *      quindi primo in coda all'onda successiva in cui diventa ammissibile.
 *
 * E UN TERZO SEGNALE: LA DIPENDENZA DICHIARATA, che non e' ne' una collisione ne' una priorita'.
 *
 * La sovrapposizione dei file dice "questi due non possono scrivere insieme"; non sa dire
 * "questo viene dopo quello". Due task possono essere indipendenti sui FILE e dipendenti nel
 * SIGNIFICATO: A aggiunge un helper in `a.js`, B lo importa da `b.js`. I file non si
 * sovrappongono, quindi niente li separa, finiscono nella stessa onda, e B fallisce perche'
 * l'helper non esiste ancora. Per questo un task puo' dichiarare `dependsOn: [ref, ...]` — i
 * `ref` di altri task dello STESSO lotto che devono essere gia' atterrati. E' l'unico modo di
 * esprimere un ordine, e si comporta come la collisione: e' un cancello che viene prima
 * dell'importanza, e un punteggio alto non lo apre. Senza `dependsOn` il piano e' identico.
 */

/* ------------------------------- collisioni -------------------------------- */

/** Normalise a task's declared file set (the planner gives paths; be forgiving). */
function fileSet(task) {
  const files = Array.isArray(task?.files) ? task.files : [];
  return new Set(files.map((f) => String(f).replace(/\\/g, '/').replace(/^\.?\//, '')).filter(Boolean));
}

/** Do two tasks contend for the same file? Directory-level heuristics stay out of it. */
function conflicts(a, b) {
  for (const f of a) if (b.has(f)) return true;
  return false;
}

/* -------------------------------- importanza ------------------------------- */

const clamp = (n) => Math.min(100, Math.max(1, Math.round(n)));

/**
 * Quanto costa LASCIARE INDIETRO un task, 0..100 — non quanto e' difficile farlo.
 *
 * I pesi seguono lo specialista perche' e' l'unico segnale che il piano porta sempre: il
 * `routing` ha gia' deciso chi possiede il cambiamento, e quella scelta dice di che natura
 * e' il lavoro. In cima sta cio' che, non fatto, lascia il progetto esposto (`security`,
 * `compliance`, `resilience`); in fondo cio' che, non fatto, lascia solo il progetto meno
 * curato (`docs`, `ux`). Non si legge il titolo ne' la motivazione: sono testo di un modello,
 * e un punteggio che dipende dalle parole scelte da un modello non e' una misura.
 */
const AGENT_WEIGHT = {
  security: 100,
  compliance: 85,
  resilience: 78,
  tests: 66,
  infra: 60,
  services: 58,
  performance: 54,
  quality: 50,
  refactor: 42,
  workbench: 40,
  frontend: 38,
  ux: 28,
  docs: 20,
};

const DEFAULT_WEIGHT = 50;

/*
 * A parita' di specialista, una correzione viene prima di un'aggiunta: un difetto non
 * corretto continua ad accumulare rischio, una feature non costruita e' solo valore
 * rinviato. E' una spinta, non un salto di categoria.
 */
const KIND_NUDGE = { improvement: 4, feature: 0 };

/**
 * Il punteggio di importanza di un task, 1..100.
 *
 * Una `priority` dichiarata dal piano (il backlog la porta su 1..100, e un operatore la puo'
 * impostare a mano) e' autorevole e vince sul peso dedotto: chi l'ha scritta sapeva qualcosa
 * che lo specialista non dice.
 *
 * Non lancia mai: un task malformato vale il peso neutro. Questo modulo decide soltanto un
 * ORDINE, e un ordine sbagliato costa un'onda in piu' — un'eccezione qui costerebbe l'intera
 * iterazione.
 *
 * @param {object} task
 * @returns {number} 1..100, piu' alto = piu' costoso lasciarlo indietro
 */
export function taskPriority(task) {
  try {
    const declared = Number(task?.priority);
    if (Number.isFinite(declared) && declared > 0) return clamp(declared);
    const base = AGENT_WEIGHT[String(task?.agent)] ?? DEFAULT_WEIGHT;
    return clamp(base + (KIND_NUDGE[String(task?.kind)] ?? 0));
  } catch {
    return DEFAULT_WEIGHT;
  }
}

/** Fra task non scaduti: prima il piu' importante, e a pari importanza l'ordine del piano. */
const byImportance = (a, b) => b.priority - a.priority || a.index - b.index;

/**
 * Fra task scaduti: prima la scadenza piu' vecchia, e a pari scadenza l'ordine del piano.
 * E' il criterio che impedisce l'attesa infinita.
 *
 * L'importanza non compare, e non per dimenticanza: i task che scadono nella stessa onda
 * vengono tutti dalla stessa onda del piano, quindi non collidono fra loro e non sono piu' di
 * `width` — entrano tutti, in qualunque ordine li si provi. Non decidendo nulla, l'importanza
 * lascia il posto all'ordine del piano, e cosi' `maxSlip: 0` riproduce esattamente lo
 * scheduler precedente: il ripiego e il metro dello slittamento sono lo stesso piano.
 */
const byUrgency = (a, b) => a.deadline - b.deadline || a.index - b.index;

/* ------------------------------- dipendenze -------------------------------- */

/** Quante decisioni sulle dipendenze finiscono nel resoconto: e' una riga di log, non un registro. */
const MAX_NOTES = 12;

/** Un nome corto e sempre presente, per i messaggi e per il log del piano. */
function shortTitle(task) {
  return String(task?.title || task?.ref || 'untitled').slice(0, 40);
}

/** Il `ref` con cui un task e' nominabile dagli altri. Vuoto = non referenziabile. */
function refOf(task) {
  const raw = task?.ref;
  return raw == null ? '' : String(raw).trim();
}

/**
 * Le dipendenze dichiarate, come lista di `ref` puliti.
 *
 * Tollerante sulla forma perche' la sorgente e' un modello: accetta l'array, accetta la singola
 * stringa, scarta tutto il resto. La validazione sta QUI e soltanto qui — il planner si limita a
 * passare il campo come lo riceve, cosi' non esistono due copie delle stesse regole.
 */
function declaredDeps(task) {
  const raw = task?.dependsOn;
  const list = Array.isArray(raw) ? raw : typeof raw === 'string' ? [raw] : [];
  const out = [];
  for (const entry of list) {
    if (entry == null || typeof entry === 'object') continue;
    const ref = String(entry).trim();
    if (ref && !out.includes(ref)) out.push(ref);
  }
  return out;
}

/** Un raccoglitore di note limitato e senza ripetizioni: lo leggera' un umano, in una riga di log. */
function noteSink(notes) {
  let overflow = 0;
  return (line) => {
    if (notes.includes(line)) return;
    if (notes.length < MAX_NOTES) notes.push(line);
    else if (++overflow === 1) notes.push('…and more dependency notes, suppressed');
  };
}

/**
 * Esiste un cammino di dipendenze da `from` a `to`?
 *
 * Serve a una cosa sola: sapere se l'arco `v → from` chiude un ciclo su `v`. Deliberatamente NON
 * tratta `from === to` come un cammino, perche' la domanda e' sempre "da qui si torna indietro?".
 */
function reaches(deps, from, to) {
  const seen = new Set();
  const stack = [from];
  while (stack.length) {
    const n = stack.pop();
    if (n === to) return true;
    if (seen.has(n)) continue;
    seen.add(n);
    for (const d of deps.get(n) || []) stack.push(d);
  }
  return false;
}

/**
 * DA `dependsOn` A UN GRAFO ACICLICO.
 *
 * Tre cose possono andare storte, e nessuna deve costare un lotto:
 *
 *  - un `ref` che non esiste in questo lotto → la dipendenza e' ASSENTE. Il planner scrive un
 *    riferimento sbagliato di tanto in tanto; perdere l'intero lotto per una stringa storta non
 *    e' un prezzo accettabile.
 *  - un task che dipende da se' stesso → ignorato.
 *  - un CICLO ("A dopo B" e "B dopo A") → va spezzato. Non e' un caso ipotetico: e' esattamente
 *    cio' che produce un modello che ragiona su due task per volta. Senza protezione lo
 *    scheduler non terminerebbe, oppure scarterebbe dei task in silenzio — e un task scartato di
 *    cui nessuno dice niente e' peggio di un errore.
 *
 * LA REGOLA PER SPEZZARE, deterministica e qui dichiarata: finche' esiste un task che dipende da
 * se' stesso per transitivita', si prende quello di INDICE PIU' BASSO (il primo nell'ordine del
 * piano) e fra i suoi archi si taglia quello di indice piu' basso che torna su di lui. UN ARCO
 * PER VOLTA: si perde solo l'ordinamento che il ciclo rendeva comunque impossibile, non gli
 * altri. Ogni decisione finisce in `notes`, che `describeWaves` stampa — quindi si legge nella
 * riga di log in cui il piano delle onde viene gia' scritto.
 *
 * @param {Array<{task, index}>} items
 * @returns {{deps: Map<number, Set<number>>, notes: string[]}} grafo garantito aciclico
 */
function resolveDeps(items) {
  const notes = [];
  const note = noteSink(notes);
  const deps = new Map(items.map((it) => [it.index, new Set()]));

  // ref → indice. Il primo a dichiarare un ref lo tiene: un omonimo e' ambiguo, e far scivolare
  // in silenzio una dipendenza sull'altro sarebbe un ordinamento inventato.
  const byRef = new Map();
  for (const it of items) {
    const ref = refOf(it.task);
    if (ref && !byRef.has(ref)) byRef.set(ref, it.index);
  }

  for (const it of items) {
    for (const ref of declaredDeps(it.task)) {
      const target = byRef.get(ref);
      if (target === undefined) {
        note(`ignored dependency on unknown ref "${ref}" ("${shortTitle(it.task)}")`);
        continue;
      }
      if (target === it.index) {
        note(`ignored self-dependency "${ref}" ("${shortTitle(it.task)}")`);
        continue;
      }
      deps.get(it.index).add(target);
    }
  }

  // Un arco per rottura, e gli archi sono in numero finito: il limite del ciclo e' una garanzia
  // di terminazione, non una stima.
  const edges = [...deps.values()].reduce((n, s) => n + s.size, 0);
  const onCycle = (v) => [...deps.get(v)].some((d) => reaches(deps, d, v));
  for (let i = 0; i <= edges; i++) {
    const victim = items.map((it) => it.index).find(onCycle);
    if (victim === undefined) break;
    const edge = [...deps.get(victim)].sort((a, b) => a - b).find((d) => reaches(deps, d, victim));
    if (edge === undefined) break; // irraggiungibile: `onCycle` ha appena detto il contrario
    deps.get(victim).delete(edge);
    note(
      `broke a dependency cycle — "${shortTitle(items[victim].task)}" no longer waits for ` +
        `"${shortTitle(items[edge].task)}"`,
    );
  }

  return { deps, notes };
}

/**
 * Chi puo' entrare nell'onda che si sta aprendo.
 *
 * `fill` calcola `unplaced` PRIMA di comporre l'onda, quindi tutto cio' che non e' in quella
 * lista sta in un'onda gia' chiusa — che e' esattamente la condizione che una dipendenza deve
 * soddisfare. Un task la cui dipendenza e' ancora in attesa viene tolto dai candidati: non entra
 * nemmeno nella stessa onda della sua dipendenza, perche' dentro un'onda l'ordine non esiste.
 *
 * Se restasse bloccato tutto (impossibile su un grafo aciclico), si restituisce comunque la lista
 * intera: `fill` collochera' qualcosa e il ciclo avanzera'. Fermare l'iterazione per difendere un
 * ordinamento sarebbe peggio del disordine, ma la decisione va detta.
 */
function admissible(unplaced, deps, note) {
  const waiting = new Set(unplaced.map((it) => it.index));
  const ready = unplaced.filter((it) => {
    for (const d of deps.get(it.index) || []) if (waiting.has(d)) return false;
    return true;
  });
  if (!ready.length && unplaced.length) {
    note(`released "${shortTitle(unplaced[0].task)}" — its dependencies could not be ordered`);
    return unplaced;
  }
  return ready;
}

/** Il resoconto viaggia con il piano, cosi' `describeWaves` lo stampa dov'e' leggibile. */
function withNotes(waves, notes) {
  if (Array.isArray(waves) && notes?.length) waves.notes = notes;
  return waves;
}

/* -------------------------------- formazione ------------------------------- */

/**
 * Di quante onde l'importanza puo' far slittare un task oltre la posizione che avrebbe
 * avuto in ordine di piano. `0` riproduce esattamente il piano di prima.
 */
const DEFAULT_MAX_SLIP = 2;

/**
 * Il riempimento avido, UNO solo per entrambi i piani.
 *
 * Cambia soltanto l'ordine in cui i candidati vengono presentati: `sequence` riceve i task
 * non ancora collocati e l'indice dell'onda che si sta aprendo, e restituisce l'ordine in cui
 * provarli. Il primo che non e' ancora collocato apre l'onda, gli altri la riempiono finche'
 * non collidono e finche' c'e' spazio. Tenere il test di collisione qui, in un solo posto,
 * e' cio' che rende impossibile che un ordinamento lo aggiri.
 *
 * (Un vincolo che dica "B non e' pronto finche' A non e' passata" appartiene a `sequence`: e'
 * l'unico punto che decide chi e' ammissibile in questa onda. E' esattamente quello che fa
 * `admissible`, che toglie dai candidati chi aspetta ancora una dipendenza.)
 *
 * @param {Array<{task, index, files:Set<string>, priority:number}>} items
 * @param {number} width
 * @param {(unplaced:Array, waveIndex:number) => Array} sequence
 */
function fill(items, width, sequence) {
  const waves = [];
  const placed = new Set();

  while (placed.size < items.length) {
    const unplaced = items.filter((it) => !placed.has(it.index));

    /*
     * Un ordinatore che restituisce il vuoto, o un elemento gia' collocato, non deve ne'
     * far perdere un task ne' far girare questo ciclo a vuoto: si ricade sull'ordine di
     * piano, che contiene per costruzione tutto cio' che manca.
     */
    let queue = unplaced;
    try {
      const proposed = sequence(unplaced, waves.length);
      if (Array.isArray(proposed) && proposed.length) queue = proposed;
    } catch {
      queue = unplaced;
    }
    const seed = queue.find((it) => it && !placed.has(it.index)) || unplaced[0];

    const wave = [seed];
    placed.add(seed.index);

    // Unknown blast radius → run it alone.
    if (seed.files.size === 0) {
      waves.push(wave);
      continue;
    }

    // Greedily fill the wave with tasks that don't collide with anything already in it.
    const claimed = new Set(seed.files);
    for (const other of queue) {
      if (wave.length >= width) break;
      if (!other || placed.has(other.index) || other.files.size === 0) continue;
      if (conflicts(claimed, other.files)) continue;
      wave.push(other);
      other.files.forEach((f) => claimed.add(f));
      placed.add(other.index);
    }
    waves.push(wave);
  }
  return waves;
}

/**
 * Group tasks into waves of mutually non-conflicting work, i piu' importanti per primi.
 *
 * A task with NO declared files is treated as conflicting with everything: we cannot prove
 * it is safe to run alongside anything else, so it gets a wave of its own. That's the
 * conservative choice, and it's rare — the planner is asked for explicit file lists.
 *
 * Si calcolano due piani. Il primo, in ordine di piano, e' esattamente lo scheduler di
 * prima: serve come metro dello slittamento e come ripiego se il riordino per importanza
 * incontra qualcosa di inatteso. Il secondo riordina per importanza rispettando le scadenze
 * ricavate dal primo. Nessuno dei due puo' mettere nella stessa onda due task che dichiarano
 * uno stesso file: il cancello sta in `fill`, fuori dalla portata dell'ordinamento. E nessuno
 * dei due puo' anticipare un task sopra una dipendenza che ha dichiarato: quel cancello sta in
 * `admissible`, e vale per entrambi i piani.
 *
 * @param {Array} tasks
 * @param {number} maxParallel  cap on wave width (the model is the bottleneck)
 * @param {{maxSlip?: number}} [options]  di quante onde l'importanza puo' far slittare un task
 * @returns {Array<Array<{task, index, files:Set<string>, priority:number}>>} waves. Quando sono
 *          state prese decisioni sulle dipendenze (un ciclo spezzato, un `ref` inesistente),
 *          l'array porta anche `.notes` — una proprieta' sull'array, quindi `map`, `length`,
 *          `reduce` e `JSON.stringify` non cambiano di una virgola.
 */
export function planWaves(tasks, maxParallel = 2, options = {}) {
  const list = Array.isArray(tasks) ? tasks : [];
  const width = Math.max(1, Number(maxParallel) || 1);
  const items = list.map((task, index) => ({
    task,
    index,
    files: fileSet(task),
    priority: taskPriority(task),
  }));
  if (!items.length) return [];

  /*
   * Il grafo delle dipendenze, garantito aciclico, e il resoconto di cio' che e' stato deciso per
   * renderlo tale. La risoluzione e' un meccanismo nuovo: se cede, deve cedere verso il
   * comportamento di prima — nessuna dipendenza — non verso un lotto perduto.
   */
  let deps;
  let notes;
  try {
    ({ deps, notes } = resolveDeps(items));
  } catch (err) {
    deps = new Map(items.map((it) => [it.index, new Set()]));
    notes = [`dependency ordering skipped — ${err?.message || err}`];
  }
  const note = noteSink(notes);
  /*
   * Il cancello delle dipendenze avvolge ENTRAMBI i piani: e' un vincolo di correttezza, non una
   * preferenza d'ordine, quindi vale anche per il piano che misura lo slittamento. Senza
   * `dependsOn` `gate` e' l'identita', e i due piani restano quelli di prima.
   */
  const gate = (unplaced) => admissible(unplaced, deps, note);

  const planOrder = fill(items, width, gate);

  try {
    const slip = Math.max(0, Number(options?.maxSlip ?? DEFAULT_MAX_SLIP) || 0);

    /*
     * La scadenza di un task e' l'onda che gli toccava in ordine di piano, piu' la
     * tolleranza. Da qui viene il limite: i task che condividono un'onda del piano
     * condividono la scadenza, e per costruzione non collidono fra loro e non sono piu' di
     * `width` — quindi quando scadono entrano TUTTI nella stessa onda. Non resta mai un
     * arretrato di scaduti che si accumula.
     */
    for (const it of items) it.deadline = Infinity;
    planOrder.forEach((wave, w) => wave.forEach((it) => { it.deadline = w + slip; }));

    const perImportanza = fill(items, width, (unplaced, w) => {
      const due = [];
      const rest = [];
      // `gate` prima dell'ordinamento: chi aspetta una dipendenza non e' un candidato, quindi
      // non c'e' punteggio che lo possa far entrare in quest'onda.
      for (const it of gate(unplaced)) (it.deadline <= w ? due : rest).push(it);
      due.sort(byUrgency);
      rest.sort(byImportance);
      // Gli scaduti aprono l'onda: e' cio' che rende il ritardo limitato invece che possibile.
      return due.concat(rest);
    });

    /*
     * IL RIORDINO NON PUO' COSTARE UN'ONDA.
     *
     * Ordinare per importanza cambia quali task sono candidati a ogni passo, e un riempimento
     * avido con un ordine diverso puo' produrre PIU' onde. Misurato su 30.000 lotti generati con i
     * parametri reali (3-6 task, width 2-3): 1312 volte — il 4,37% — il piano riordinato ne aveva
     * almeno una in piu', fino a +50% di round seriali su un caso riproducibile.
     *
     * Un'onda in piu' e' un giro seriale in piu' su un sistema in cui il modello e' il collo di
     * bottiglia: una funzione nata per far arrivare prima il lavoro importante finiva, una volta su
     * ventitre', per far arrivare tutto piu' tardi. Entrambi i piani sono gia' calcolati qui, quindi
     * il confronto non costa nulla e il dubbio si chiude con una misura invece che con una
     * preferenza.
     *
     * A parita' di onde vince il riordino: e' il caso in cui l'importanza si guadagna gratis.
     */
    if (perImportanza.length > planOrder.length) {
      note(`riordino per importanza scartato: ${perImportanza.length} onde contro ${planOrder.length} in ordine di piano`);
      return withNotes(planOrder, notes);
    }
    return withNotes(perImportanza, notes);
  } catch {
    // Un riordino che non riesce non deve costare l'iterazione: il piano in ordine di piano
    // e' valido e corretto, solo meno ordinato per importanza.
    return withNotes(planOrder, notes);
  }
}

/* --------------------------------- resoconto -------------------------------- */

/** Human-readable plan of the waves, for the log and the dashboard. */
export function describeWaves(waves) {
  const plan = (Array.isArray(waves) ? waves : [])
    .map((w, i) => {
      const body = (Array.isArray(w) ? w : [])
        .map((x) => {
          const title = shortTitle(x?.task);
          const p = Number.isFinite(x?.priority) ? x.priority : taskPriority(x?.task);
          // L'agente e il punteggio accanto al titolo: senza di loro un'onda "sbagliata" nel
          // log non si distingue da una giusta, e l'ordinamento non si puo' verificare.
          return `${title} [${x?.task?.agent || '?'} p${p}]`;
        })
        .join(' ‖ ');
      return `wave ${i + 1}: ${body}`;
    })
    .join('\n');

  /*
   * Le decisioni sulle dipendenze viaggiano con il piano e si stampano qui, perche' questa e' la
   * riga che il chiamante logga gia': un ciclo spezzato o un `ref` inesistente devono essere
   * leggibili dov'e' scritto il piano, non in un canale che nessuno guarda.
   */
  const notes = Array.isArray(waves?.notes) ? waves.notes : [];
  return notes.length ? `${plan}\n${notes.map((n) => `  note: ${n}`).join('\n')}` : plan;
}

/**
 * How much wall-clock the wave plan saves versus running everything serially, e se il lavoro
 * piu' importante del lotto e' davvero partito per primo (`leadsWithTop`): un piano parallelo
 * che rimanda la cosa che conta non e' un buon piano, e questo lo rende leggibile nel log.
 */
export function parallelism(waves) {
  const list = Array.isArray(waves) ? waves.filter((w) => Array.isArray(w) && w.length) : [];
  const total = list.reduce((n, w) => n + w.length, 0);
  const priorityOf = (x) => (Number.isFinite(x?.priority) ? x.priority : taskPriority(x?.task));
  const top = list.length ? Math.max(...list.map((w) => Math.max(...w.map(priorityOf)))) : 0;
  return {
    tasks: total,
    waves: list.length,
    widest: Math.max(0, ...list.map((w) => w.length)),
    topPriority: top,
    leadsWithTop: list.length ? list[0].some((x) => priorityOf(x) === top) : true,
  };
}
