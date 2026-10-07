import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import '../src/db_iteration.js';
import { openProjectDb, initCoreSchema, closeProjectDb } from '../src/db.js';
import { startIteration, updateIteration, startTask, finishTask } from '../src/db_iteration.js';
import {
  recordModelAttempt,
  outcomeFor,
  downgradeVerdict,
  modelOutcomeLedger,
  genreOf,
  GENRE_NONE,
  THRESHOLDS,
} from '../src/core/modelOutcomes.js';

/**
 * QUELLO CHE DEVE RESTARE VERO DI UNA MEMORIA CHE DECIDE DOVE SPENDERE.
 *
 * Il verdetto di questo modulo autorizza a mandare lavoro a un modello piu' piccolo, e un
 * declassamento sbagliato non costa il risparmio mancato: costa l'iterazione intera, onde riuscite
 * comprese. Le proprieta' fissate qui sono le tre che, se si perdono, non fanno fallire niente —
 * il meccanismo continua a rispondere, solo che risponde male:
 *
 *   1. "non so ancora" non e' "va bene". Pochi campioni devono lasciare il routing sul modello
 *      grande; e' l'errore piu' facile da introdurre, perche' un verdetto positivo su due successi
 *      su due sembra funzionare per un bel po'.
 *   2. l'evidenza non e' simmetrica. Serve molta piu' prova per CONTINUARE a declassare che per
 *      smettere: smettere costa solo il risparmio, continuare puo' costare un'iterazione.
 *   3. quello che il modello non ha causato non gli viene addebitato — un server fermato, una
 *      connessione caduta, il fallimento di un'onda sorella. Una memoria che conta i fallimenti
 *      degli altri convince a non declassare mai nulla, e tanto valeva non averla.
 */

let dbFile;

before(() => {
  dbFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'isl-models-')), 'p.sqlite');
  openProjectDb(dbFile);
  initCoreSchema();
});

after(() => {
  closeProjectDb();
  for (const s of ['', '-wal', '-shm']) {
    try {
      fs.rmSync(dbFile + s, { force: true });
    } catch {
      /* held by the OS */
    }
  }
});

/**
 * Un'iterazione con un task, eseguito da uno o piu' modelli, portata fino a un esito.
 * `models` con due nomi = un retry: il primo modello e' stato scavalcato dal secondo.
 */
function oneRun({
  models,
  role = 'implement',
  kind = 'improvement',
  area = 'backend',
  task = 'done',
  iter = 'committed',
  failureKind = null,
}) {
  const iterationId = startIteration('loop', 'base');
  const taskId = startTask(iterationId, { kind, title: 'a task', area, agent: 'quality' });
  for (const m of models) recordModelAttempt({ taskId, role, model: m, paramsB: 7 });
  finishTask(taskId, task, 'summary', ['src/x.js']);
  updateIteration(iterationId, { status: iter, ...(failureKind ? { failureKind } : {}) });
  return { iterationId, taskId };
}

const many = (n, opts) => {
  for (let i = 0; i < n; i++) oneRun(opts);
};

const GENRE = 'improvement/backend';

test('il genere viene dedotto da cio\' che il task registra gia\'', () => {
  // Nessuna tassonomia nuova: kind + area sono due colonne che esistono su ogni riga di `tasks`.
  assert.equal(genreOf({ kind: 'improvement', area: 'backend' }), GENRE);
  assert.equal(genreOf({ kind: 'feature', area: 'frontend' }), 'feature/frontend');
  // Una fase senza task (plan, research) non ha un genere: vale per tutto il ruolo.
  assert.equal(genreOf({}), GENRE_NONE);
  assert.equal(genreOf(), GENRE_NONE);
});

test('pochi campioni danno "non so", non "va bene"', () => {
  // Tre successi di fila. Un meccanismo che si convince qui oscilla: tre prove non distinguono un
  // modello che regge da uno che ha avuto tre task banali.
  many(3, { models: ['few-samples'] });

  const s = outcomeFor('few-samples', 'implement', GENRE);
  assert.equal(s.decided, 3);
  assert.equal(s.landed, 3);
  assert.equal(s.failed, 0);
  // Il tasso grezzo dice 100%, quello su cui si decide no: e' smorzato, come nel resto del progetto.
  assert.equal(s.observedSuccessRate, 1);
  assert.ok(s.successRate < 1, `uno smoothing che da' 1 su tre prove non e' uno smoothing: ${s.successRate}`);

  const v = downgradeVerdict({ candidate: 'few-samples', role: 'implement', genre: GENRE });
  assert.equal(v.verdict, 'unknown');
  assert.equal(v.candidate.decided, 3);
});

test('con abbastanza prove il permesso arriva — "non so" e\' uno stato di passaggio', () => {
  // Il contro-test del precedente: se nessun volume di evidenza producesse mai 'ok', la funzione
  // sarebbe solo un modo elaborato di non declassare mai.
  many(THRESHOLDS.keepMinTrials, { models: ['proven-small'] });

  const v = downgradeVerdict({ candidate: 'proven-small', role: 'implement', genre: GENRE });
  assert.equal(v.verdict, 'ok');
  assert.equal(v.candidate.decided, THRESHOLDS.keepMinTrials);
});

test('un modello che fallisce sistematicamente viene escluso', () => {
  many(4, { models: ['broken-small'], task: 'failed', iter: 'rolled_back', failureKind: 'implementation' });

  const s = outcomeFor('broken-small', 'implement', GENRE);
  assert.equal(s.failed, 4);
  assert.equal(s.landed, 0);

  const v = downgradeVerdict({ candidate: 'broken-small', role: 'implement', genre: GENRE });
  assert.equal(v.verdict, 'stop');
  assert.match(v.reason, /ceiling/);
});

test('smettere richiede molta meno evidenza che continuare', () => {
  // L'asimmetria e' la decisione di progetto su cui poggia tutto il resto: il costo di un
  // declassamento sbagliato (un'iterazione annullata) non e' pari al risparmio. Se qualcuno
  // "pareggia" le soglie il meccanismo continua a funzionare, e comincia a perdere iterazioni.
  assert.ok(
    THRESHOLDS.keepMinTrials > THRESHOLDS.stopMinTrials,
    'continuare a declassare deve costare piu\' evidenza che smettere',
  );
  assert.equal(THRESHOLDS.slack, 0, 'il modello piccolo non ha diritto a essere "un po\' peggio"');

  // E in pratica: quattro prove bastano a fermare, non ad autorizzare.
  many(2, { models: ['asym'], task: 'failed', iter: 'rolled_back', failureKind: 'implementation' });
  many(2, { models: ['asym'] });
  assert.equal(downgradeVerdict({ candidate: 'asym', role: 'implement', genre: GENRE }).verdict, 'stop');
});

test('il confronto con il modello grande ferma anche un candidato sotto il tetto assoluto', () => {
  // Il tetto assoluto e' spento di proposito (`ceiling: 1`) per isolare la regola che conta qui:
  // "su questo genere di lavoro il piccolo fallisce piu' del grande".
  many(2, { models: ['cmp-small'], task: 'failed', iter: 'rolled_back', failureKind: 'implementation' });
  many(2, { models: ['cmp-small'] });
  many(10, { models: ['cmp-big'] });

  const v = downgradeVerdict(
    { candidate: 'cmp-small', baseline: 'cmp-big', role: 'implement', genre: GENRE },
    { ceiling: 1 },
  );
  assert.equal(v.verdict, 'stop');
  assert.match(v.reason, /cmp-big/);
  assert.ok(v.candidate.failRate > v.baselineStats.failRate);
});

test('un\'iterazione interrotta non viene addebitata al modello', () => {
  // La triage di core/failure.js distingue "fermato" da "sbagliato". Un server riavviato o una
  // connessione a Ollama caduta non dicono NIENTE sul modello: contarli lo condannerebbe per
  // qualcosa che non ha fatto, e il routing tornerebbe a non declassare mai.
  many(5, { models: ['interrupted-small'], task: 'failed', iter: 'interrupted', failureKind: 'interruption' });

  const s = outcomeFor('interrupted-small', 'implement', GENRE);
  assert.equal(s.trials, 0);
  assert.equal(s.failed, 0);
  assert.equal(downgradeVerdict({ candidate: 'interrupted-small', role: 'implement', genre: GENRE }).verdict, 'unknown');
});

test('il task riuscito di un\'iterazione annullata non e\' un fallimento del modello', () => {
  // Un'onda sorella fa annullare tutto: il lavoro e' perso, ma non per colpa di questo modello.
  // Contarlo come fallimento farebbe sembrare cattivi tutti i modelli dell'iterazione insieme.
  many(4, { models: ['collateral'], task: 'done', iter: 'rolled_back', failureKind: 'implementation' });

  const s = outcomeFor('collateral', 'implement', GENRE);
  assert.equal(s.lost, 4);
  assert.equal(s.failed, 0);
  assert.equal(s.decided, 0, 'un esito ambiguo non puo\' entrare nel denominatore del tasso');
  assert.equal(downgradeVerdict({ candidate: 'collateral', role: 'implement', genre: GENRE }).verdict, 'unknown');
});

test('un retry su un altro modello addebita il fallimento a chi e\' stato scavalcato', () => {
  // Il task alla fine e' andato a buon fine, ma non con il primo modello: senza questa regola il
  // declassamento fallito verrebbe contato come un successo del modello piccolo.
  oneRun({ models: ['retried-small', 'retried-big'] });

  assert.equal(outcomeFor('retried-small', 'implement', GENRE).failed, 1);
  assert.equal(outcomeFor('retried-big', 'implement', GENRE).landed, 1);
});

test('registrare due volte lo stesso tentativo non raddoppia i conteggi', () => {
  const iterationId = startIteration('loop', 'base');
  const taskId = startTask(iterationId, { kind: 'improvement', title: 't', area: 'backend', agent: 'quality' });
  assert.ok(recordModelAttempt({ taskId, role: 'implement', model: 'dedup' }));
  assert.equal(recordModelAttempt({ taskId, role: 'implement', model: 'dedup' }), null);
  finishTask(taskId, 'done', 'summary', []);
  updateIteration(iterationId, { status: 'committed' });

  assert.equal(outcomeFor('dedup', 'implement', GENRE).decided, 1);
});

test('dati assenti: nessun verdetto e nessuna eccezione', () => {
  const s = outcomeFor('never-seen', 'implement', GENRE);
  assert.equal(s.trials, 0);
  assert.equal(s.decided, 0);
  assert.equal(s.observedSuccessRate, null, 'senza prove il tasso osservato non esiste, non e\' zero');

  const v = downgradeVerdict({ candidate: 'never-seen', baseline: 'also-never-seen', role: 'implement', genre: GENRE });
  assert.equal(v.verdict, 'unknown');
  assert.deepEqual(modelOutcomeLedger({ model: 'never-seen' }), []);

  // Anche le chiamate malformate rispondono "non so" invece di alzare.
  assert.equal(downgradeVerdict({}).verdict, 'unknown');
  assert.equal(downgradeVerdict().verdict, 'unknown');
  assert.equal(recordModelAttempt({}), null);
  assert.equal(recordModelAttempt(), null);
});

test('il registro riporta i conteggi su cui il verdetto si basa', () => {
  // Un verdetto che nessuno puo' contestare guardando i numeri e' un oracolo, non una misura.
  const rows = modelOutcomeLedger({ model: 'broken-small' });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].genre, GENRE);
  assert.equal(rows[0].failed, 4);
  assert.equal(rows[0].role, 'implement');
});

// Ultimo di proposito: chiude il database sotto i piedi del modulo.
test('senza database aperto il meccanismo tace invece di far fallire chi lo chiama', () => {
  closeProjectDb();
  assert.equal(recordModelAttempt({ taskId: 1, role: 'implement', model: 'x' }), null);
  assert.equal(outcomeFor('x', 'implement', GENRE).trials, 0);
  assert.equal(downgradeVerdict({ candidate: 'x', role: 'implement', genre: GENRE }).verdict, 'unknown');
  assert.deepEqual(modelOutcomeLedger(), []);
});
