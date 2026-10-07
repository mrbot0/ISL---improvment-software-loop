import fs from 'node:fs';
import path from 'node:path';
import { getSetting, setSetting } from '../db.js';
import { downgradeVerdict } from './modelOutcomes.js';
import { modelFor, REPO_ROOT } from '../config.js';
import { getDetected } from './models.js';
import { log } from '../logger.js';

/**
 * MODEL ROUTING — scegliere la TAGLIA del modello in base al compito, non solo al ruolo.
 *
 * `config.js` risolve il modello PER RUOLO e in modo STATICO: `modelFor('implement')` restituisce
 * lo stesso nome per un task che aggiunge un punto e virgola e per un refactor strutturale. Il
 * modello e' il collo di bottiglia e il costo principale del sistema, e `detectModels()` raccoglie
 * gia' per ogni modello locale `paramsB` — la materia prima per scegliere una taglia minore esiste
 * e non la usa nessuno. Questo modulo la usa.
 *
 * L'ECONOMIA, che e' cio' che da' forma al meccanismo:
 * scendere di taglia conviene SOLO se il modello piu' piccolo ce la fa. Un task che fallisce fa
 * annullare l'intera iterazione — tutte le onde, anche quelle riuscite — quindi un declassamento
 * sbagliato costa molto piu' di quanto il risparmio valga. Il rischio NON e' simmetrico, e il
 * meccanismo non lo e' a sua volta: ogni dubbio, ogni segnale assente, ogni misura che non si
 * riesce a prendere, ogni errore interno si risolvono in TAGLIA PIENA. Il declassamento e' il caso
 * speciale che va guadagnato con prove, non il comportamento di default.
 *
 * Tre conseguenze dirette, tutte verificabili leggendo il codice qui sotto:
 *
 *   1. Il giudizio di difficolta' e' MECCANICO e costa zero: conta file dichiarati, step, `kind`,
 *      `agent` e i byte dei file bersaglio. Nessun modello decide quale modello usare, altrimenti
 *      il risparmio se lo mangerebbe la decisione stessa.
 *   2. Le fasi di GIUDIZIO non scendono mai (vedi `JUDGEMENT_ROLES`).
 *   3. Tutto e' avvolto: `modelForTask()` non puo' lanciare e, in ogni percorso di errore,
 *      restituisce esattamente cio' che `modelFor(role)` restituirebbe. Un meccanismo che puo' far
 *      fallire cio' che tocca sarebbe peggio della sua assenza.
 *
 * L'interfaccia e' un rimpiazzo di `modelFor(role)` a parita' di forma — `modelForTask(role)` senza
 * task e' legale e torna la taglia piena — cosi' un chiamante si converte aggiungendo un argomento,
 * e il routing si spegne da configurazione senza toccare codice.
 */

const lg = log.for('model-routing');

/** Chiave del setting per-progetto. */
const KEY = 'modelRouting';

/**
 * DOVE NON SI SCENDE MAI. Non e' una soglia, e' un divieto.
 *
 * `review` e `security` sono gli unici due passaggi che confrontano la modifica con cio' che era
 * stato chiesto e cercano cio' che non si vede. Un giudizio dato da un modello piu' debole e'
 * peggio di nessun giudizio, perche' arriva con la stessa autorita' e con la stessa forma: un
 * verdetto "nessun problema" prodotto da un modello che non ha capito il diff viene registrato e
 * creduto esattamente come uno vero.
 *
 * `plan` decide cosa fare a tutta l'iterazione. Un piano sbagliato spreca ogni fase a valle — si
 * implementa bene, si revisiona bene e si promuove la cosa sbagliata — quindi e' il punto del
 * sistema dove risparmiare rende meno di qualunque altro.
 */
export const JUDGEMENT_ROLES = Object.freeze(['review', 'security', 'plan']);

/**
 * Gli unici ruoli per cui un declassamento e' CONSIDERABILE (poi deve ancora guadagnarselo).
 * `implement` esegue istruzioni gia' scritte; `research` raccoglie materiale. Un ruolo nuovo
 * aggiunto a `ROLE_MODELS` in futuro non compare qui e cade quindi in taglia piena: la scelta
 * sicura e' anche quella che si ottiene non facendo niente.
 */
export const DOWNGRADABLE_ROLES = Object.freeze(['implement', 'research']);

/**
 * SOGLIE, e perche' sono queste. Sono tutte configurabili perche' la taratura giusta dipende dai
 * modelli installati, ma i default sono deliberatamente stretti.
 *
 *   - `minParamsB: 4`   — sotto i ~4B i modelli locali smettono di emettere tool call affidabili e
 *                         JSON valido, che e' esattamente il modo in cui l'implementer lavora. Il
 *                         fallimento non e' "codice peggiore", e' "nessuna modifica".
 *   - `minSavingRatio`  — il candidato deve avere al massimo il 60% dei parametri del modello di
 *                         oggi. Scendere da 8B a 7.6B prende tutto il rischio e non risparmia
 *                         niente: il rischio si corre solo per un risparmio reale.
 *   - `maxFiles: 1`     — un task su piu' file chiede di tenere coerenti piu' contesti insieme, che
 *                         e' la prima cosa che un modello piccolo perde.
 *   - `maxSteps: 2`     — "meccanico" vuol dire che il planner ha scritto l'edit in una o due
 *                         istruzioni. Tre step sono una procedura, non una digitazione.
 *   - `maxTargetBytes`  — 24 KB di sorgente sono circa 7k token; sommati al preambolo degli
 *                         strumenti, alla storia delle tool call e al diff, la finestra utile di un
 *                         modello piccolo e' finita molto prima della sua finestra nominale.
 *   - `agents`          — ALLOWLIST, non blocklist. Un elenco di agenti "rischiosi" da escludere
 *                         sbaglia in modo pericoloso ogni volta che si aggiunge un agente nuovo;
 *                         un elenco di agenti ammessi sbaglia in modo innocuo. Partono solo `docs`
 *                         (prosa e commenti) e `quality` (nomi, codice morto, pulizia locale):
 *                         sono i due dove un edit sbagliato e' visibile subito e non silenzioso.
 *                         Un operatore che ha MISURATO che un altro agente regge puo' allargarla.
 */
export const DEFAULTS = Object.freeze({
  enabled: true,
  minParamsB: 4,
  minSavingRatio: 0.6,
  maxFiles: 1,
  maxSteps: 2,
  maxTargetBytes: 24 * 1024,
  agents: Object.freeze(['docs', 'quality']),
});

/** Valori che spengono il routing dalla variabile d'ambiente `ISL_MODEL_ROUTING`. */
const ENV_OFF = /^(0|off|false|no)$/i;

/*
 * "NON CONFIGURATO" NON E' "CONFIGURATO A ZERO".
 *
 * `Number(null)`, `Number('')`, `Number(false)` e `Number([])` valgono tutti 0, quindi un valore
 * assente veniva letto come uno zero esplicito e schiacciato sul limite inferiore invece di
 * ricadere sul default. Su tutte le soglie tranne una l'errore era innocuo; su `minParamsB` no:
 * portava il pavimento da 4 miliardi di parametri a 0,5 — esattamente il regime che questo modulo
 * dichiara vietato, dove il fallimento non e' "codice peggiore" ma "nessuna modifica". E un campo
 * numerico vuoto di un form posta proprio `''`.
 */
const clamp = (v, dflt, lo, hi) => {
  if (v === null || v === undefined || typeof v === 'boolean' || Array.isArray(v)) return dflt;
  if (typeof v === 'string' && !v.trim()) return dflt;
  const n = Number(v);
  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : dflt;
};

function normalise(raw = {}, enabled = DEFAULTS.enabled) {
  const agents = Array.isArray(raw.agents)
    ? raw.agents.map((a) => String(a).trim()).filter(Boolean)
    : [...DEFAULTS.agents];
  return {
    enabled: !!enabled,
    minParamsB: clamp(raw.minParamsB, DEFAULTS.minParamsB, 0.5, 1000),
    minSavingRatio: clamp(raw.minSavingRatio, DEFAULTS.minSavingRatio, 0.1, 1),
    maxFiles: Math.round(clamp(raw.maxFiles, DEFAULTS.maxFiles, 1, 20)),
    maxSteps: Math.round(clamp(raw.maxSteps, DEFAULTS.maxSteps, 1, 50)),
    maxTargetBytes: Math.round(clamp(raw.maxTargetBytes, DEFAULTS.maxTargetBytes, 256, 10_000_000)),
    agents,
  };
}

/**
 * La configurazione in forza. Precedenza come nel resto del progetto: setting salvato → variabile
 * d'ambiente (`ISL_MODEL_ROUTING=off`) → default. La variabile d'ambiente esiste perche' un
 * operatore che sospetta il routing deve poterlo spegnere anche senza passare dalla dashboard.
 *
 * Se il setting non e' LEGGIBILE — nessun database di progetto aperto, schema non inizializzato —
 * il routing risulta SPENTO. Non e' un dettaglio difensivo: se non si riesce a leggere la propria
 * configurazione non si e' in condizione di prendere una decisione rischiosa, e l'unica risposta
 * onesta e' il comportamento di oggi.
 */
export function getRoutingConfig() {
  const envRaw = process.env.ISL_MODEL_ROUTING;
  const envEnabled =
    envRaw === undefined || String(envRaw).trim() === '' ? null : !ENV_OFF.test(String(envRaw).trim());
  let saved = null;
  try {
    saved = getSetting(KEY, null);
  } catch (e) {
    return { ...normalise({}, false), readable: false, from: 'unreadable', reason: `setting non leggibile (${e.message})` };
  }
  const savedEnabled = typeof saved?.enabled === 'boolean' ? saved.enabled : null;
  const enabled = savedEnabled != null ? savedEnabled : envEnabled != null ? envEnabled : DEFAULTS.enabled;
  const from = savedEnabled != null ? 'setting' : envEnabled != null ? 'env' : 'default';
  return { ...normalise(saved || {}, enabled), readable: true, from, reason: null };
}

/**
 * Salva (fondendola) la configurazione del routing. Lancia se non c'e' un database aperto: e'
 * un'azione d'operatore, non un percorso caldo, e un salvataggio che finge di essere avvenuto e'
 * peggio di un errore.
 */
export function setRoutingConfig(patch = {}) {
  let cur = {};
  try {
    cur = getSetting(KEY, null) || {};
  } catch {
    cur = {};
  }
  /*
   * NON SCRIVERE `enabled` SE NESSUNO L'HA CHIESTO.
   *
   * Qui `enabled` veniva materializzato dal default ogni volta che ne' il patch ne' il valore
   * salvato ne portavano uno. Conseguenza: un operatore che aveva spento il routing con
   * `ISL_MODEL_ROUTING=off` e poi cambiava UNA SOLA soglia dalla dashboard se lo ritrovava acceso
   * senza averlo chiesto — e da quel momento l'impostazione salvata scavalcava la variabile
   * d'ambiente per sempre, perche' il salvato ha la precedenza sull'ambiente.
   *
   * Un interruttore di sicurezza che si richiude da solo quando tocchi qualcos'altro non e' un
   * interruttore. Omettendo il campo, la catena salvato → ambiente → default resta intatta.
   */
  const merged = normalise({ ...cur, ...patch }, DEFAULTS.enabled);
  if (patch.enabled != null) merged.enabled = !!patch.enabled;
  else if (typeof cur.enabled === 'boolean') merged.enabled = cur.enabled;
  else delete merged.enabled;

  setSetting(KEY, merged);
  return getRoutingConfig();
}

/**
 * Cancella la scelta salvata: si torna ai default e la variabile d'ambiente riprende la parola.
 * Esiste per lo stesso motivo di `resetModelConfig()` in `core/models.js` — una configurazione che
 * si puo' solo cambiare, e non azzerare, intrappola l'operatore nell'ultimo valore che ha scritto.
 */
export function resetRoutingConfig() {
  setSetting(KEY, null);
  return getRoutingConfig();
}

/* ---------------------------- la scala delle taglie ----------------------------- */

/** `qwen3:8b` e `qwen3:8b:latest` sono lo stesso gradino. */
const normId = (s) => String(s || '').trim().toLowerCase().replace(/:latest$/, '');

/**
 * I modelli disponibili ordinati per numero di parametri, crescente.
 *
 * Si usa SOLO `paramsB`, che `detectModels()` ricava da `parameter_size` dichiarato dal runtime.
 * I nomi non entrano nel giudizio: un tag puo' mentire sulla taglia, mentre `parameter_size` lo
 * dichiara il runtime che il modello lo ha caricato. Un modello con `paramsB` nullo NON entra
 * nella scala: una taglia ignota non e' una taglia piccola. Restano fuori anche i modelli di
 * embedding, che non sanno chattare.
 */
export function sizeLadder(detected = getDetected()) {
  const models = Array.isArray(detected?.models) ? detected.models : [];
  return models
    .filter((m) => m && m.chat !== false && !m.embedding && Number.isFinite(Number(m.paramsB)) && Number(m.paramsB) > 0)
    .map((m) => ({ id: String(m.id), paramsB: Number(m.paramsB), sizeGB: m.sizeGB ?? null, family: m.family ?? null }))
    .sort((a, b) => a.paramsB - b.paramsB || a.id.localeCompare(b.id));
}

const findRung = (ladder, id) => ladder.find((m) => normId(m.id) === normId(id)) || null;

/**
 * Il gradino da usare al posto di `base`: il PIU' GRANDE fra quelli ammissibili, non il piu'
 * piccolo disponibile. Si scende di un gradino utile, non in fondo alla scala — il risparmio in
 * fondo e' maggiore, ma la probabilita' di non concludere il task cresce molto piu' in fretta del
 * risparmio.
 */
function pickRung(ladder, base, cfg) {
  const ceiling = base.paramsB * cfg.minSavingRatio;
  const admissible = ladder.filter(
    (m) =>
      normId(m.id) !== normId(base.id) &&
      m.paramsB < base.paramsB &&
      m.paramsB >= cfg.minParamsB &&
      m.paramsB <= ceiling &&
      costoScende(base, m),
  );
  return admissible.length ? admissible[admissible.length - 1] : null; // la scala e' crescente
}

/**
 * I PARAMETRI NON SONO IL COSTO.
 *
 * In un modello a esperti sparsi (MoE) i parametri TOTALI dicono quanto pesa in memoria, non quanto
 * calcolo serve per generare un token: `qwen3:30b-a3b` ne dichiara 30,5 miliardi e ne attiva circa
 * 3. Decidendo sui soli `paramsB`, il routing scambiava quel modello per "grande" e lo sostituiva
 * con un denso da 14 miliardi — quattro o cinque volte piu' calcolo attivo per token, e per di piu'
 * un modello piu' debole. L'inversione esatta dell'economia che questo modulo serve, e non su un
 * caso di laboratorio: il modello predefinito del progetto e' `qwen3.6:latest`.
 *
 * `sizeGB` veniva gia' raccolto e portato nel gradino, e poi non letto da nessuno. E' un indicatore
 * imperfetto del costo — misura i pesi su disco, non i parametri attivi — ma e' l'unico dato che il
 * runtime fornisce, e la direzione che indica e' quella giusta: un MoE pesa come il suo totale,
 * quindi un candidato che NON scende anche di ingombro non sta risparmiando niente.
 *
 * In dubbio si rinuncia al declassamento. Un risparmio mancato non costa nulla; un declassamento
 * sbagliato fa annullare l'intera iterazione, onde riuscite comprese.
 */
function costoScende(base, candidato) {
  const a = Number(base?.sizeGB);
  const b = Number(candidato?.sizeGB);
  // Senza la misura su ENTRAMBI non si puo' dire che il costo scenda: non si declassa.
  if (!Number.isFinite(a) || !Number.isFinite(b) || a <= 0 || b <= 0) return false;
  // Deve scendere ALMENO quanto scendono i parametri dichiarati. Un candidato che dimezza i
  // parametri ma pesa uguale sta spostando il lavoro, non riducendolo.
  return b / a <= candidato.paramsB / base.paramsB;
}

/* ---------------------------------- difficolta' --------------------------------- */

/**
 * Byte totali dei file bersaglio, o `null` se anche uno solo non si riesce a misurare.
 * `null` e' bloccante: un percorso che non esiste (o che non e' un file) significa che il task non
 * sta modificando cio' che dice di modificare, e quello non e' lavoro meccanico.
 */
function targetBytes(root, files) {
  if (!files.length) return null;
  let total = 0;
  for (const rel of files) {
    try {
      const st = fs.statSync(path.resolve(String(root || '.'), String(rel)));
      if (!st.isFile()) return null;
      total += st.size;
    } catch {
      return null;
    }
  }
  return total;
}

/**
 * Il giudizio di difficolta', con i soli segnali che il task GIA' porta e che si possono contare.
 * Due esiti: `mechanical` (nessun blocker) e `full`. Non c'e' una scala continua perche' non
 * servirebbe a niente: l'unica decisione a valle e' binaria, e un punteggio inventato darebbe
 * l'impressione di una misura che non abbiamo.
 *
 * `blockers` e' la parte utile: dice PERCHE' un task non e' stato declassato, cosi' la decisione e'
 * ispezionabile dai log e dalla UI senza rieseguire niente.
 */
export function taskDifficulty(task = null, { root = REPO_ROOT, config = null } = {}) {
  const cfg = config ? normalise(config, config.enabled !== false) : getRoutingConfig();
  const list = (v) => (Array.isArray(v) ? v.filter(Boolean) : []);
  const files = list(task?.files);
  const steps = list(task?.steps);
  const newFiles = list(task?.newFiles);
  const kind = String(task?.kind || '');
  const agent = String(task?.agent || '');
  const bytes = targetBytes(root, files);
  const blockers = [];

  // Un task che non dichiara file non e' un task piccolo: e' un task senza segnale. L'assenza di
  // prove non e' una prova di semplicita', e il planner dice che un elenco file vuoto e' il
  // sintomo tipico di una dichiarazione incompleta.
  if (!files.length) blockers.push('nessun file dichiarato: assenza di segnale, non segnale di semplicita');
  else if (files.length > cfg.maxFiles) blockers.push(`${files.length} file dichiarati (limite ${cfg.maxFiles})`);

  if (!steps.length) blockers.push('nessuno step dichiarato: il piano non ha scritto cosa fare');
  else if (steps.length > cfg.maxSteps) blockers.push(`${steps.length} step (limite ${cfg.maxSteps})`);

  if (kind === 'feature') blockers.push('kind=feature: una feature inventa struttura che non esiste ancora');
  if (newFiles.length) blockers.push(`${newFiles.length} file nuovi: nessuna forma esistente da seguire`);
  if (!cfg.agents.includes(agent)) {
    blockers.push(`agent=${agent || '(assente)'} non nell'allowlist [${cfg.agents.join(', ')}]`);
  }

  if (bytes == null) blockers.push('dimensione dei file bersaglio non misurabile');
  else if (bytes > cfg.maxTargetBytes) {
    blockers.push(
      `${Math.round(bytes / 1024)} KB di sorgente bersaglio (limite ${Math.round(cfg.maxTargetBytes / 1024)} KB)`,
    );
  }

  return {
    tier: blockers.length ? 'full' : 'mechanical',
    blockers,
    signals: { files: files.length, steps: steps.length, newFiles: newFiles.length, kind, agent, bytes },
  };
}

/* ----------------------------------- decisione ---------------------------------- */

/** `modelFor` legge binding vivi di `config.js`; se qualcosa non e' inizializzato non deve propagarsi. */
function safeBaseline(role) {
  try {
    return modelFor(role) || '';
  } catch {
    return '';
  }
}

/**
 * La decisione completa e ispezionabile: quale modello, quale sarebbe stato, e perche'.
 * `modelForTask()` e' questa funzione piu' `.model` — una sola implementazione della scelta, due
 * forme di risposta, cosi' il log e la UI non possono raccontare una decisione diversa da quella
 * effettivamente usata.
 *
 * @param {string} role uno di implement | review | security | plan | research
 * @param {object|null} task il task del planner ({ files, steps, kind, agent, newFiles })
 * @param {{detected?:object, config?:object, root?:string}} [opts] override per test e simulazioni
 */
export function routeDecision(role, task = null, opts = {}) {
  const baseline = safeBaseline(role);
  const out = {
    role: String(role || ''),
    model: baseline,
    baseline,
    routed: false,
    enabled: false,
    reason: '',
    difficulty: null,
    ladder: [],
  };
  try {
    const cfg = opts.config ? normalise(opts.config, opts.config.enabled !== false) : getRoutingConfig();
    out.enabled = cfg.enabled;

    if (!cfg.enabled) {
      out.reason = 'routing spento: comportamento di oggi';
      return out;
    }
    if (JUDGEMENT_ROLES.includes(out.role)) {
      out.reason = `${out.role} e' una fase di giudizio: taglia piena sempre`;
      return out;
    }
    if (!DOWNGRADABLE_ROLES.includes(out.role)) {
      out.reason = `ruolo ${out.role || '(assente)'} non classificato per il routing: taglia piena`;
      return out;
    }

    const ladder = sizeLadder(opts.detected ?? getDetected());
    out.ladder = ladder.map((m) => m.id);
    // Un solo modello installato e' il caso NORMALE: non c'e' nulla da scegliere e il meccanismo
    // deve semplicemente togliersi di mezzo. Lo stesso vale quando la detection non e' ancora
    // passata (cache vuota): il routing non va a cercarla in rete, non ne ha il diritto.
    if (ladder.length < 2) {
      out.reason = `scala con ${ladder.length} modello/i a paramsB noto: nulla da scegliere`;
      return out;
    }

    const base = findRung(ladder, baseline);
    if (!base) {
      out.reason = `il modello di oggi (${baseline || 'ignoto'}) non e' nella scala: non si puo' sapere se un candidato sia piu' piccolo`;
      return out;
    }

    const difficulty = taskDifficulty(task, { root: opts.root ?? REPO_ROOT, config: cfg });
    out.difficulty = difficulty;
    if (difficulty.tier !== 'mechanical') {
      out.reason = `taglia piena: ${difficulty.blockers[0]}`;
      return out;
    }

    const cand = pickRung(ladder, base, cfg);
    if (!cand) {
      out.reason = `nessun gradino sotto ${base.id} (${base.paramsB}B) con almeno ${cfg.minParamsB}B e un risparmio di almeno il ${Math.round((1 - cfg.minSavingRatio) * 100)}%`;
      return out;
    }

    /*
     * L'ULTIMA PAROLA CE L'HANNO GLI ESITI, NON L'EURISTICA.
     *
     * Tutto cio' che precede e' un giudizio A PRIORI: questo task SEMBRA meccanico, questo modello
     * SEMBRA abbastanza grande. Ma la domanda che conta non e' come sembra: e' se i task come
     * questo, su quel modello, siano andati a buon fine. `modelOutcomes` tiene quella misura, e
     * finora il router non la consultava — l'asimmetria del rischio era applicata prima della prima
     * prova e mai piu' dopo, quindi lo stesso genere di lavoro tornava sullo stesso gradino anche
     * dopo N fallimenti consecutivi.
     *
     * `stop` blocca il declassamento. `unknown` NON lo blocca: senza campioni sufficienti non si sa
     * ancora, e rifiutarsi di provare impedirebbe per sempre di raccogliere i dati che servono a
     * decidere — la soglia minima di prove sta li' apposta perche' il "non so" costi poco.
     *
     * Avvolto a parte: se la memoria degli esiti non e' leggibile (nessun database di progetto
     * aperto, tabella vuota) il routing deve continuare a funzionare come prima, non fermarsi.
     */
    let verdetto = null;
    try {
      verdetto = downgradeVerdict({
        candidate: cand.id,
        baseline: base.id,
        role,
        genre: difficulty.signals?.agent ?? null,
      });
    } catch {
      verdetto = null;
    }
    if (verdetto?.verdict === 'stop') {
      out.reason = `declassamento a ${cand.id} escluso dagli esiti: ${verdetto.reason}`;
      out.outcome = verdetto;
      return out;
    }

    out.model = cand.id;
    out.routed = true;
    out.outcome = verdetto;
    out.reason = `lavoro meccanico (${difficulty.signals.files} file, ${difficulty.signals.steps} step, agent=${difficulty.signals.agent}): ${base.id} ${base.paramsB}B → ${cand.id} ${cand.paramsB}B`;
    return out;
  } catch (e) {
    // Qualunque errore qui dentro e' un errore del routing, non del task: si torna al modello di
    // oggi e si va avanti. Il meccanismo non ha il diritto di far fallire cio' che tocca.
    out.model = baseline;
    out.routed = false;
    out.difficulty = null;
    out.reason = `routing non applicato (${e.message})`;
    return out;
  }
}

/**
 * IL RIMPIAZZO DI `modelFor(role)`.
 *
 * Stessa forma: prende un ruolo, torna un nome di modello, non lancia mai. Il task e' opzionale, e
 * senza task la risposta e' la taglia piena — cosi' un chiamante si converte aggiungendo un
 * argomento, e nessun chiamante e' costretto a cambiare forma per via di questo modulo.
 */
export function modelForTask(role, task = null, opts = {}) {
  try {
    const d = routeDecision(role, task, opts);
    if (d.routed) lg.info(`${d.role}: ${d.reason}`);
    return d.model || safeBaseline(role);
  } catch {
    return safeBaseline(role);
  }
}
