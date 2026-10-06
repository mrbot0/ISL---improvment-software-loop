/**
 * COSA È GIÀ STATO PROVATO QUI, E COM'È ANDATA.
 *
 * Chi pensa il backlog scriveva proposte guardando solo il codice: file reali, righe reali, lacune
 * reali. Grounding sul PRESENTE, e cieco sul passato. Il risultato è il difetto che l'operatore ha
 * descritto per primo — "se lo stesso pezzo va in errore, sprecare n tentativi per avere lo stesso
 * risultato non ha senso" — perché nulla impediva di riproporre per la quarta volta una modifica
 * che era stata annullata tre volte.
 *
 * Questo modulo risponde a tre domande che un ingegnere si farebbe prima di aprire un ticket:
 *
 *   dove ci siamo già rotti la testa   file su cui i tentativi finiscono in rollback
 *   che genere di lavoro attecchisce   quali tipi di proposta arrivano al commit e quali no
 *   cosa è stato messo da parte        elementi differiti, che non vanno riproposti come nuovi
 *
 * Sono numeri presi dal database delle iterazioni, non impressioni. Un modello a cui si dice
 * "evita i file fragili" ignora l'istruzione; uno a cui si dice "auth.js: 4 tentativi, 4 annullati"
 * ha un fatto su cui ragionare.
 */
import { db } from '../db.js';

/** Righe di una query, con un ripiego silenzioso: mancare questo contesto non deve fermare una run. */
function rows(sql, params = []) {
  try {
    return db.prepare(sql).all(...params);
  } catch {
    return [];
  }
}

/**
 * File che hanno visto più tentativi finire male che bene.
 *
 * Non è una lista di divieti: un file fragile può contenere il difetto più importante del prodotto.
 * È un'informazione sul COSTO — se un file ha respinto quattro tentativi, il quinto va proposto in
 * modo diverso dai precedenti, o non va proposto affatto.
 */
export function fragileFiles({ limit = 12, scan = 800 } = {}) {
  /*
   * I file di un task stanno in `tasks.files` come TESTO JSON, non in una tabella a sé. La prima
   * versione di questa query interrogava un `iteration_files` che non esiste: SQLite falliva, il
   * ripiego restituiva l'elenco vuoto, e il proponente continuava a lavorare esattamente come
   * prima — senza che nulla segnalasse che il contesto nuovo non stava arrivando. Un guasto che
   * non si vede è peggio di uno che si vede, quindi l'aggregazione si fa qui, su dati che ci sono.
   */
  const righe = rows(
    `SELECT t.files AS files, i.status AS status
       FROM tasks t
       JOIN iterations i ON i.id = t.iteration_id
      WHERE t.files IS NOT NULL AND t.files != ''
      ORDER BY t.id DESC
      LIMIT ?`,
    [scan],
  );

  const per = new Map();
  for (const r of righe) {
    let elenco = [];
    try {
      const p = JSON.parse(r.files);
      elenco = Array.isArray(p) ? p : [];
    } catch {
      // Alcune righe più vecchie hanno un elenco separato da virgole invece che JSON.
      elenco = String(r.files).split(',').map((s) => s.trim()).filter(Boolean);
    }
    const andataMale = r.status === 'rolled_back' || r.status === 'error';
    for (const f of elenco.slice(0, 20)) {
      const k = String(f).replace(/\\/g, '/');
      if (!k || k.length > 200) continue;
      const v = per.get(k) || { path: k, attempts: 0, failed: 0 };
      v.attempts++;
      if (andataMale) v.failed++;
      per.set(k, v);
    }
  }

  return [...per.values()]
    .filter((v) => v.attempts >= 2 && v.failed >= 2)
    .map((v) => ({ ...v, rate: Math.round((100 * v.failed) / v.attempts) }))
    .sort((a, b) => b.failed - a.failed || b.attempts - a.attempts)
    .slice(0, limit);
}

/**
 * Quali GENERI di proposta arrivano davvero in fondo.
 *
 * Serve a spostare il backlog verso ciò che funziona invece di verso ciò che suona bene. Se i
 * "refactor" vengono annullati due volte su tre e i "test" atterrano quasi sempre, il proponente
 * deve saperlo — è la differenza fra un backlog pieno di buone intenzioni e uno che avanza.
 */
export function kindOutcomes() {
  const r = rows(
    `SELECT COALESCE(NULLIF(f.source,''),'unknown') AS kind,
            COUNT(*) AS total,
            SUM(CASE WHEN f.status = 'done' THEN 1 ELSE 0 END) AS landed
       FROM features f
      GROUP BY kind
     HAVING total >= 3
      ORDER BY total DESC`,
  );
  return r.map((x) => ({ ...x, landedPct: x.total ? Math.round((100 * x.landed) / x.total) : 0 }));
}

/** Elementi messi da parte: riproporli come nuovi è il modo più rapido di sprecare un'iterazione. */
export function deferredTitles({ limit = 25 } = {}) {
  return rows(
    "SELECT title, COALESCE(failures,0) AS failures FROM features WHERE status = 'deferred' ORDER BY id DESC LIMIT ?",
    [limit],
  );
}

/**
 * Il blocco pronto da mettere nel prompt. Vuoto se non c'è storia: a un progetto appena aperto non
 * si raccontano statistiche inesistenti, si lascia semplicemente guardare il codice.
 */
export function evidenceFromHistory() {
  const fragili = fragileFiles();
  const generi = kindOutcomes();
  const differiti = deferredTitles();
  if (!fragili.length && !generi.length && !differiti.length) return '';

  const parti = ['STORIA DI QUESTO PROGETTO — fatti misurati, non impressioni.'];

  if (fragili.length) {
    parti.push(
      '',
      'FILE CHE HANNO GIÀ RESPINTO DEI TENTATIVI (tentativi/annullati):',
      ...fragili.map((f) => `  ${f.path} — ${f.attempts} tentativi, ${f.failed} annullati (${f.rate}%)`),
      'Non sono vietati. Ma riproporre su di essi la stessa modifica già annullata è il modo più',
      'sicuro di sprecare un\'iterazione: o cambi approccio, o scegli altro lavoro.',
    );
  }

  if (generi.length) {
    parti.push(
      '',
      'CHE GENERE DI LAVORO ARRIVA IN FONDO:',
      ...generi.map((k) => `  ${k.kind}: ${k.landed} su ${k.total} completati (${k.landedPct}%)`),
      'Sposta il peso verso ciò che atterra. Un backlog di proposte che vengono annullate non',
      'migliora il prodotto, consuma soltanto tempo di calcolo.',
    );
  }

  if (differiti.length) {
    parti.push(
      '',
      'GIÀ MESSI DA PARTE — non riproporli con altre parole:',
      ...differiti.slice(0, 15).map((d) => `  ${d.title}${d.failures ? ` (${d.failures} fallimenti)` : ''}`),
    );
  }

  return parti.join('\n');
}
