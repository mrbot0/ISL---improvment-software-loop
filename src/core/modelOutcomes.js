import { db, registerSchema } from '../db.js';
import { log } from '../logger.js';

/**
 * MEMORIA DEGLI ESITI PER MODELLO — la base su cui il routing puo' correggersi.
 *
 * `config.js` sceglie il modello PER RUOLO e in modo STATICO: un task che aggiunge un punto e
 * virgola riceve lo stesso modello di un refactor strutturale. Scendere di taglia (i `paramsB` che
 * `core/models.js` raccoglie gia' per ogni modello locale) e' il risparmio piu' grosso disponibile,
 * perche' il modello e' il collo di bottiglia e il costo principale del sistema.
 *
 * Il problema e' che un declassamento deciso a tavolino e' una scommessa fatta una volta sola. E il
 * banco non paga pari: un task che fallisce fa annullare l'intera iterazione — tutte le onde,
 * comprese quelle riuscite — quindi un declassamento sbagliato costa molte volte quello che il
 * risparmio vale. La domanda che conta non e' "questo task sembra facile", e' "i task come questo,
 * su quel modello, sono andati a buon fine?". ISL registra gia' l'esito di ogni task e di ogni
 * iterazione: manca solo il collegamento con il modello che quel task l'ha eseguito.
 *
 * Questo modulo aggiunge quel collegamento e le tre risposte che ne derivano:
 *
 *   1. `recordModelAttempt()` — una riga per ogni dispatch: quale modello, per quale ruolo, su quale
 *      task. Nient'altro: l'ESITO non viene scritto qui, viene DEDOTTO (vedi sotto).
 *   2. `outcomeFor()` — per una combinazione (modello, ruolo, genere di task): il tasso di riuscita
 *      e su quante prove. Il numero di prove conta quanto il tasso: due successi su due non sono una
 *      prova di niente, percio' il tasso e' smorzato alla Laplace come nel resto del progetto
 *      (`core/decisionNetwork.js`, `core/trust.js`) e le prove viaggiano sempre accanto.
 *   3. `downgradeVerdict()` — il verdetto che il routing puo' usare: `stop` (smetti di mandarci
 *      questo genere di lavoro), `ok` (regge, continua), `unknown` (non so ancora). `unknown` NON
 *      e' `ok`: in dubbio si usa il modello grande.
 *
 * PERCHE' L'ESITO SI DEDUCE INVECE DI SCRIVERLO.
 * L'esito di un task non e' noto quando il task finisce: una modifica che passa puo' essere
 * annullata dopo, al rollback dell'iterazione. Se lo fotografassimo a fine task registreremmo un
 * successo che il rollback smentisce. Dedurlo dal join su `tasks` + `iterations` — la stessa tecnica
 * che `core/decisionNetwork.js` usa per la competenza (agent x area) — tiene conto anche di quello
 * che succede dopo, e non aggiunge un secondo punto di chiamata che qualcuno puo' dimenticare.
 * Dove una verifica puo' essere meccanica, e' meccanica.
 *
 * NIENTE FOREIGN KEY verso `tasks`/`iterations`: il database gira con `PRAGMA foreign_keys = ON`,
 * quindi una FK trasformerebbe un id sbagliato in un INSERT rifiutato, cioe' in un errore dentro al
 * percorso che questo modulo osserva. Una memoria che puo' far fallire cio' che misura e' peggio
 * della sua assenza. Le righe orfane restano semplicemente non interpretabili e vengono ignorate.
 */

const lg = log.for('modelOutcomes');

registerSchema(() => {
  db.exec(`
  -- Un tentativo = un dispatch di un task (o di una fase) a un modello. L'esito non e' qui.
  CREATE TABLE IF NOT EXISTS model_attempts (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    task_id      INTEGER,          -- tasks.id: il join che permette di dedurre l'esito
    iteration_id INTEGER,          -- usato dalle fasi senza task (plan, research)
    role         TEXT NOT NULL,    -- implement | review | security | plan | research
    model        TEXT NOT NULL,
    params_b     REAL,             -- la taglia al momento del tentativo (models.js -> paramsB)
    kind         TEXT,             -- improvement | feature
    area         TEXT,             -- backend | frontend | services | infra
    ts           INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_model_attempts_task ON model_attempts(task_id);
  CREATE INDEX IF NOT EXISTS idx_model_attempts_key ON model_attempts(model, role);
  -- Registrare due volte lo stesso (task, ruolo, modello) e' un doppio conteggio, non un retry:
  -- il secondo INSERT viene ignorato. Un retry su un modello DIVERSO resta invece una riga a se',
  -- perche' e' esattamente l'evidenza che serve (vedi la regola "superseded" piu' sotto).
  CREATE UNIQUE INDEX IF NOT EXISTS uq_model_attempt_task
    ON model_attempts(task_id, role, model) WHERE task_id IS NOT NULL;
  CREATE UNIQUE INDEX IF NOT EXISTS uq_model_attempt_phase
    ON model_attempts(iteration_id, role, model) WHERE task_id IS NULL;
  `);
});

/* ------------------------------ genere di task ---------------------------- */

/**
 * Il genere sotto cui finiscono i tentativi senza genere: le fasi che non hanno un task
 * (plan, research) valgono per tutto il ruolo, non per un genere specifico.
 */
export const GENRE_NONE = '*';

/**
 * Il "genere di task", preso da cio' che il progetto registra GIA' sulla riga del task: `kind`
 * (improvement | feature) e `area` (backend | frontend | services | infra). Niente tassonomia
 * nuova da mantenere allineata, e niente giudizio su quanto un task "sembri facile".
 *
 * Due dimensioni sono anche il massimo che si possa permettere: ogni dimensione in piu' divide i
 * campioni, e un verdetto senza campioni e' solo un'opinione.
 */
export function genreOf(task = {}) {
  const kind = String(task?.kind ?? '').trim();
  const area = String(task?.area ?? '').trim();
  if (!kind && !area) return GENRE_NONE;
  return `${kind || 'task'}/${area || 'backend'}`;
}

// La stessa espressione, in SQL. Deve restare d'accordo con genreOf(): e' l'unica cosa che lega
// quello che si scrive a quello che si interroga.
const GENRE_SQL =
  "CASE WHEN COALESCE(a.kind,'') = '' AND COALESCE(a.area,'') = '' THEN '" + GENRE_NONE + "'" +
  " ELSE COALESCE(NULLIF(a.kind,''),'task') || '/' || COALESCE(NULLIF(a.area,''),'backend') END";

/* ------------------------------- registrazione ---------------------------- */

/**
 * Registra che `model` ha preso in carico un task per conto di `role`.
 *
 * `kind`/`area` vengono letti dalla riga del task quando c'e', non dal chiamante: la riga e' la
 * fonte autorevole, il parametro e' solo un ripiego. Tutto e' avvolto: se il database non e' aperto,
 * se la tabella non c'e', se l'id non esiste, la funzione restituisce null e non alza niente. Il
 * routing deve poter chiamare questa funzione senza proteggersi.
 *
 * @returns {number|null} l'id del tentativo, o null (anche quando era un doppione gia' registrato)
 */
export function recordModelAttempt({
  taskId = null, iterationId = null, role, model, paramsB = null, kind = null, area = null,
} = {}) {
  try {
    if (!role || !model) return null;
    let k = kind;
    let ar = area;
    let iter = iterationId;
    if (taskId != null) {
      const t = db.prepare('SELECT kind, area, iteration_id FROM tasks WHERE id = ?').get(taskId);
      if (t) {
        k = t.kind ?? kind;
        ar = t.area ?? area;
        iter = iter ?? t.iteration_id;
      }
    }
    const size = paramsB == null || !Number.isFinite(Number(paramsB)) ? null : Number(paramsB);
    const r = db
      .prepare(
        'INSERT OR IGNORE INTO model_attempts (task_id, iteration_id, role, model, params_b, kind, area, ts) ' +
          'VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      )
      .run(taskId ?? null, iter ?? null, String(role), String(model), size, k ?? null, ar ?? null, Date.now());
    return r.changes ? Number(r.lastInsertRowid) : null;
  } catch (e) {
    lg.warn(`could not record model attempt: ${e.message}`);
    return null;
  }
}

/* --------------------------------- esiti ---------------------------------- */

/**
 * Da tentativo a esito, meccanicamente. Quattro esiti, e la distinzione fra i due di mezzo e' il
 * punto delicato:
 *
 *   failed — il modello non ce l'ha fatta: il task risulta `failed`, oppure il task e' stato
 *            ritentato su un altro modello (un tentativo superato da uno successivo sullo stesso
 *            task E' un fallimento, per definizione: altrimenti non si sarebbe ritentato).
 *   landed — il lavoro e' arrivato fino al commit.
 *   lost   — il task ha finito, ma l'iterazione non ha committato. Ambiguo: puo' essere questa
 *            modifica bocciata da un gate, puo' essere il fallimento di un'onda sorella che ha
 *            annullato tutto. Contato e mostrato a parte, MAI dentro al tasso: addossare a ogni
 *            modello il fallimento dei vicini fa sembrare cattivi tutti e cancella il segnale.
 *   open   — non ancora giudicabile, oppure non attribuibile: se l'iterazione e' morta per
 *            `interruption` o `infrastructure` (la triage di `core/failure.js`) il modello non
 *            c'entra niente — il server si e' fermato, Ollama ha chiuso la connessione. Conta zero.
 */
const SETTLED_SQL = `
  SELECT a.model AS model,
         a.role AS role,
         ${GENRE_SQL} AS genre,
         a.params_b AS params_b,
         a.ts AS ts,
         CASE
           WHEN a.task_id IS NOT NULL
            AND a.id < (SELECT MAX(b.id) FROM model_attempts b WHERE b.task_id = a.task_id) THEN 'failed'
           WHEN i.failure_kind IN ('interruption', 'infrastructure') THEN 'open'
           WHEN t.status = 'failed' THEN 'failed'
           WHEN t.status = 'done' AND i.status IN ('committed', 'promoted') THEN 'landed'
           WHEN t.status = 'done' AND i.status IN ('rolled_back', 'rejected', 'error', 'empty') THEN 'lost'
           WHEN a.task_id IS NULL AND i.status IN ('committed', 'promoted') THEN 'landed'
           WHEN a.task_id IS NULL AND i.status IN ('rolled_back', 'rejected', 'error', 'empty') THEN 'lost'
           ELSE 'open'
         END AS outcome
    FROM model_attempts a
    LEFT JOIN tasks t ON t.id = a.task_id
    LEFT JOIN iterations i ON i.id = COALESCE(t.iteration_id, a.iteration_id)
`;

const COUNTS = `COUNT(*) AS trials,
       SUM(CASE WHEN outcome = 'landed' THEN 1 ELSE 0 END) AS landed,
       SUM(CASE WHEN outcome = 'failed' THEN 1 ELSE 0 END) AS failed,
       SUM(CASE WHEN outcome = 'lost' THEN 1 ELSE 0 END) AS lost,
       MAX(params_b) AS params_b,
       MAX(ts) AS last_ts`;

const r3 = (x) => Math.round(x * 1000) / 1000;

/**
 * Le statistiche di una combinazione, nella forma che serve a decidere.
 *
 * `decided` (landed + failed) e' il denominatore: i tentativi il cui esito e' attribuibile al
 * modello. Il tasso e' smorzato alla Laplace con le stesse costanti del resto del progetto, cosi'
 * un 2/2 non viene letto come perfezione; `observedSuccessRate` resta accanto, grezzo, perche' un
 * numero smorzato che nessuno puo' ricondurre ai conteggi non si puo' discutere.
 */
function statOf(row, { model = null, role = null, genre = null } = {}) {
  const landed = Number(row?.landed || 0);
  const failed = Number(row?.failed || 0);
  const lost = Number(row?.lost || 0);
  const decided = landed + failed;
  const successRate = (landed + 1) / (decided + 3);
  return {
    model: row?.model ?? model,
    role: row?.role ?? role,
    genre: row?.genre ?? genre,
    trials: landed + failed + lost,
    decided,
    landed,
    failed,
    lost,
    successRate: r3(successRate),
    failRate: r3(1 - successRate),
    observedSuccessRate: decided ? r3(landed / decided) : null,
    paramsB: row?.params_b ?? null,
    lastAt: row?.last_ts ?? null,
  };
}

const ZERO = (model, role, genre) => statOf(null, { model, role, genre });

/**
 * Tasso di riuscita e numero di prove per una combinazione (modello, ruolo, genere).
 * `genre` omesso o null = rollup su tutti i generi di quel ruolo.
 * Senza dati restituisce zeri — non null e non un'eccezione: chi chiama non deve distinguere
 * "non ho dati" da "il database non c'e'".
 */
export function outcomeFor(model, role, genre = null) {
  try {
    if (!model || !role) return ZERO(model ?? null, role ?? null, genre);
    const where = ["outcome <> 'open'", 'model = ?', 'role = ?'];
    const args = [model, role];
    if (genre != null) {
      where.push('genre = ?');
      args.push(genre);
    }
    const row = db
      .prepare(`WITH settled AS (${SETTLED_SQL}) SELECT ${COUNTS} FROM settled WHERE ${where.join(' AND ')}`)
      .get(...args);
    return statOf(row, { model, role, genre });
  } catch (e) {
    lg.warn(`could not read model outcomes: ${e.message}`);
    return ZERO(model ?? null, role ?? null, genre);
  }
}

/**
 * Il registro completo (modello x ruolo x genere), piu' provato in cima — per la dashboard, i
 * manager e chiunque debba poter contestare un verdetto guardando i conteggi.
 */
export function modelOutcomeLedger({ role = null, model = null, limit = 200 } = {}) {
  try {
    const where = ["outcome <> 'open'"];
    const args = [];
    if (model) {
      where.push('model = ?');
      args.push(model);
    }
    if (role) {
      where.push('role = ?');
      args.push(role);
    }
    return db
      .prepare(
        `WITH settled AS (${SETTLED_SQL}) SELECT model, role, genre, ${COUNTS} FROM settled ` +
          `WHERE ${where.join(' AND ')} GROUP BY model, role, genre ORDER BY trials DESC, model LIMIT ?`,
      )
      .all(...args, limit)
      .map((r) => statOf(r));
  } catch (e) {
    lg.warn(`could not read the model ledger: ${e.message}`);
    return [];
  }
}

/* -------------------------------- verdetto -------------------------------- */

/**
 * LE SOGLIE, E PERCHE' NON SONO SIMMETRICHE.
 *
 * Smettere di declassare e' gratis: si torna al modello grande, che e' quello che il sistema usava
 * comunque prima che questa funzione esistesse. Continuare a declassare e' una scommessa che, se
 * persa, annulla un'iterazione intera, onde riuscite comprese. Le due decisioni non possono quindi
 * chiedere la stessa evidenza: per SMETTERE bastano `stopMinTrials` prove, per CONTINUARE ne
 * servono `keepMinTrials`, quattro volte tante.
 *
 * `stopMinFailures` e' il contrappeso nella direzione opposta: un singolo fallimento e' un
 * incidente, non un andamento, e basterebbe a spegnere il meccanismo per sempre.
 */
export const THRESHOLDS = {
  stopMinTrials: 3, //  prove attribuibili sufficienti per smettere
  stopMinFailures: 2, //  ...ma un fallimento solo e' un incidente, non un andamento
  keepMinTrials: 12, //  prove necessarie per continuare a declassare
  worseBy: 0.1, //  quanto peggio del modello grande conta come "peggio"
  ceiling: 0.25, //  tasso di fallimento oltre il quale si smette comunque
  // Zero di proposito: il modello piccolo NON ha diritto a essere "un po' peggio". Il risparmio su
  // un task non paga un'iterazione annullata, quindi non c'e' margine da concedere.
  slack: 0,
};

const pct = (x) => `${Math.round(x * 100)}%`;

/**
 * Il verdetto che il routing puo' usare per decidere se mandare questo genere di lavoro al modello
 * piccolo invece che a quello grande.
 *
 *   'stop'    — ci fallisce: non mandarcelo piu'.
 *   'ok'      — regge, con abbastanza prove da giustificare la scommessa.
 *   'unknown' — non si sa ancora. DIVERSO da 'ok': in dubbio si usa `baseline`.
 *
 * L'ordine non e' casuale: prima si cerca un motivo per smettere, poi — e solo poi — il permesso di
 * continuare. E l'evidenza per smettere puo' arrivare anche dal record del modello su TUTTO il
 * ruolo, mentre il permesso richiede prove su QUESTO genere: la cautela puo' generalizzare, la
 * fiducia no. Se pero' su questo genere le prove ci sono (>= keepMinTrials), il record specifico
 * vince sul generale — altrimenti un modello bravo su un genere e scarso su un altro verrebbe
 * escluso da tutti e due.
 *
 * @returns {{verdict:'stop'|'ok'|'unknown', reason:string, candidate:object|null, baselineStats:object|null}}
 */
export function downgradeVerdict({ candidate, baseline = null, role, genre = null } = {}, opts = {}) {
  const th = { ...THRESHOLDS, ...opts };
  const out = (verdict, reason, extra = {}) => ({
    verdict,
    reason,
    model: candidate ?? null,
    baseline: baseline ?? null,
    role: role ?? null,
    genre,
    thresholds: th,
    candidate: null,
    baselineStats: null,
    ...extra,
  });

  try {
    if (!candidate || !role) return out('unknown', 'no candidate model or role given');

    const cand = outcomeFor(candidate, role, genre);
    const base = baseline ? outcomeFor(baseline, role, genre) : null;

    // Un motivo per smettere. `b` serve solo quando ha abbastanza prove sullo STESSO genere: un
    // confronto fra un tasso su questo genere e un tasso su tutto il ruolo non confronta niente.
    const stopReason = (s, b, scope) => {
      if (s.failed < th.stopMinFailures || s.decided < th.stopMinTrials) return null;
      if (s.failRate >= th.ceiling) {
        return `${scope}: fails ${pct(s.failRate)} of the time over ${s.decided} attributable attempt(s), above the ${pct(th.ceiling)} ceiling`;
      }
      if (b && b.decided >= th.stopMinTrials && s.failRate >= b.failRate + th.worseBy) {
        return `${scope}: fails ${pct(s.failRate)} against ${pct(b.failRate)} for ${b.model} over ${s.decided} attributable attempt(s)`;
      }
      return null;
    };

    const scope = genre == null ? `across role ${role}` : `on ${genre}`;
    const why = stopReason(cand, base, scope);
    if (why) return out('stop', why, { candidate: cand, baselineStats: base });

    // Su questo genere le prove non bastano ancora: allora vale il record sul ruolo intero.
    if (genre != null && cand.decided < th.keepMinTrials) {
      const wide = outcomeFor(candidate, role, null);
      const wideBase = baseline ? outcomeFor(baseline, role, null) : null;
      const wideWhy = stopReason(wide, wideBase, `across role ${role}`);
      if (wideWhy) return out('stop', wideWhy, { candidate: cand, baselineStats: base, roleWide: wide });
    }

    // Il permesso. Serve evidenza diretta su questa combinazione, sotto il tetto assoluto e non
    // peggiore del modello grande — anche quando il grande, su questo genere, fallisce spesso: un
    // genere difficile per entrambi non e' un buon posto per risparmiare.
    const notWorse = !base || base.decided < th.stopMinTrials || cand.failRate <= base.failRate + th.slack;
    if (cand.decided >= th.keepMinTrials && cand.failRate < th.ceiling && notWorse) {
      return out('ok', `${scope}: ${pct(cand.successRate)} success over ${cand.decided} attributable attempt(s)`, {
        candidate: cand,
        baselineStats: base,
      });
    }

    return out(
      'unknown',
      `${scope}: only ${cand.decided} attributable attempt(s), ${th.keepMinTrials} needed before trusting the smaller model`,
      { candidate: cand, baselineStats: base },
    );
  } catch (e) {
    // Un meccanismo che puo' far fallire cio' che tocca e' peggio della sua assenza: qualunque
    // cosa vada storta, la risposta e' "non so" e il routing resta sul modello grande.
    lg.warn(`could not reach a downgrade verdict: ${e.message}`);
    return out('unknown', `verdict unavailable: ${e.message}`);
  }
}
