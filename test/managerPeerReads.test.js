import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  openProjectDb,
  publishManagerBrief,
  upsertAgent,
  createRun,
  createProposal,
  setProposalStatus,
} from '../src/db.js';

/**
 * I MANAGER AVEVANO DUE CANALI E CONCLUDEVANO COMUNQUE DA SOLI.
 *
 * `inbox()` e `brief.peerContext` esistevano e nessuno dei tredici li leggeva: ogni `analyze()`
 * ricalcolava la propria vista e decideva come se fosse l'unico a guardare il sistema. Due
 * manager una domanda diretta l'avevano perfino mandata — e la risposta non arrivava, perché
 * nessuno leggeva la domanda.
 *
 * Questi test fissano le proprietà che si perderebbero senza che niente fallisca:
 *
 *   1. un blocco a monte cambia la CONCLUSIONE di chi lo legge, non solo la sua prosa;
 *   2. un messaggio vecchio in coda non deve poter zittire un allarme vero (la posta non manda
 *      un "tutto a posto": è il modo in cui questa coordinazione si rompe in silenzio);
 *   3. una domanda fra manager riceve una risposta, e la risposta cambia cosa viene raccomandato.
 */

let dbFile;
let mgrs;
let mod;

before(async () => {
  dbFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'isl-peerreads-')), 'p.sqlite');
  openProjectDb(dbFile);

  /*
   * Un agente che sta andando male per davvero, perché le conclusioni che questi test misurano si
   * calcolano su questi numeri e non su una finzione:
   *   1 verificata + 4 fallite  → tasso di verifica 20%, il caso che fa gridare Quality;
   *   0 approvate + 3 respinte  → efficacia 0% con 3 decise, il caso in cui Insights propone di
   *                               disabilitare un agente. Senza le respinte quel ramo non gira
   *                               nemmeno, e il test che lo controlla passerebbe a vuoto.
   */
  upsertAgent({ id: 'security', name: 'Security', description: 'test' });
  const runId = createRun('security', 'test');
  const nuova = () => createProposal({ runId, agentId: 'security', title: 'p', files: [{ path: 'src/a.js' }], severity: 'medium' });
  setProposalStatus(nuova(), 'verified');
  for (let i = 0; i < 4; i++) setProposalStatus(nuova(), 'failed');
  for (let i = 0; i < 3; i++) setProposalStatus(nuova(), 'rejected');

  mod = await import('../src/managers/index.js');
  mgrs = mod.startManagers();
});

after(() => {
  mod?.stopManagers();
});

/** Workbench in allarme: l'unico stato che rende insignificanti le misure degli altri. */
function bootRotto(detail = 'next start: listen EADDRINUSE 7878') {
  publishManagerBrief('Workbench', {
    name: 'Workbench',
    status: 'alert',
    headline: `The app does NOT boot — ${detail}`,
    recommendations: [],
  });
  // Il dettaglio viaggia nella posta, come lo manda il vero WorkbenchManager.
  mgrs.byName.Workbench.shareFinding('blocker', 'The application does not start', detail, { severity: 'critical' });
}

function bootSano() {
  publishManagerBrief('Workbench', { name: 'Workbench', status: 'idle', headline: 'The app boots and serves.', recommendations: [] });
}

/* ──────────────────────── 1. la lettura dei pari ──────────────────────── */

test('senza pari in allarme non si vede nessun blocco', () => {
  bootSano();
  assert.equal(mod.bootBlocker(mgrs.byName.Quality), null);
});

test('un blocco di Workbench si vede, col dettaglio preso dalla posta', () => {
  bootRotto('database/schema.sql: no such table');
  const b = mod.bootBlocker(mgrs.byName.Quality);
  assert.ok(b, 'il blocco non è stato visto');
  assert.equal(b.from, 'Workbench');
  assert.match(b.detail, /no such table/, 'il dettaglio deve venire dal messaggio, non dal solo titolo');
  bootSano();
});

test('un blocco VECCHIO in coda non conta: decide lo stato, non la posta', () => {
  /*
   * È la proprietà che tiene in piedi tutto il resto. La posta ha venti posti e nessuno manda un
   * "tutto a posto": il messaggio di blocco resta lì anche dopo che il boot è stato riparato. Se
   * `bootBlocker` leggesse la posta da sola, Quality resterebbe in attesa per sempre e un vero
   * difetto di qualità non verrebbe più segnalato — un guasto che nessun test noterebbe, perché
   * tutto continua a funzionare, solo in silenzio.
   */
  bootRotto('transitorio');
  assert.ok(mod.bootBlocker(mgrs.byName.Quality), 'premessa: il blocco deve essere visibile');
  bootSano(); // riparato — ma il messaggio è ancora in coda
  assert.ok(
    mgrs.byName.Quality.inbox({ kind: 'blocker', limit: 8 }).some((m) => m.from === 'Workbench'),
    'premessa: il messaggio vecchio deve essere ancora in posta',
  );
  assert.equal(mod.bootBlocker(mgrs.byName.Quality), null, 'un blocco risolto non deve più contare');
});

test("Workbench che sta riparando ('acting') non è un blocco", () => {
  publishManagerBrief('Workbench', { name: 'Workbench', status: 'acting', headline: 'repaired 2 boot failure(s)', recommendations: [] });
  assert.equal(mod.bootBlocker(mgrs.byName.Quality), null);
  bootSano();
});

test("l'allarme di un altro manager non è un blocco a monte", () => {
  // Una proposta critica va rivista comunque: non cambia il significato di nessun'altra misura.
  publishManagerBrief('Risk', { name: 'Risk', status: 'alert', headline: '3 CRITICAL proposal(s) awaiting review', recommendations: [] });
  assert.equal(mod.bootBlocker(mgrs.byName.Quality), null);
  publishManagerBrief('Risk', { name: 'Risk', status: 'idle', headline: 'No open proposals.', recommendations: [] });
});

test('una serie di fallimenti conta solo se annunciata: il numero sta nella posta', () => {
  publishManagerBrief('Operations', { name: 'Operations', status: 'alert', headline: 'Backpressure: 40 proposals awaiting review', recommendations: [] });
  assert.equal(mod.failureStreak(mgrs.byName.Throughput), null, "la contropressione non è una serie di fallimenti");

  publishManagerBrief('Operations', { name: 'Operations', status: 'alert', headline: '4 consecutive failed iterations', recommendations: [] });
  mgrs.byName.Operations.send('broadcast', 'decision', { action: 'error_streak', reason: 'error_streak', streak: 4 }, { severity: 'error', title: 'Operations: repeated failures' });
  const s = mod.failureStreak(mgrs.byName.Throughput);
  assert.ok(s, 'la serie annunciata non è stata vista');
  assert.equal(s.streak, 4, 'il numero deve arrivare dal payload, che il brief non porta');

  publishManagerBrief('Operations', { name: 'Operations', status: 'idle', headline: 'Loop stopped.', recommendations: [] });
  assert.equal(mod.failureStreak(mgrs.byName.Throughput), null, 'rientrato lo stato, la serie non conta più');
});

/* ─────────── 2. il blocco cambia la conclusione, non la prosa ─────────── */

test('Quality non grida quando il blocco è a monte, e grida quando non c’è', () => {
  const quality = mgrs.byName.Quality;

  bootRotto();
  quality.analyze();
  assert.equal(quality.brief.status, 'watching', "sotto un blocco a monte Quality deve aspettare, non andare in allarme");
  assert.match(quality.brief.headline, /does not start/, 'il motivo dell’attesa deve essere detto');

  bootSano();
  quality.analyze();
  assert.equal(quality.brief.status, 'alert', 'senza blocco il tasso basso è un allarme di qualità');
  assert.match(quality.brief.headline, /pass verification/);
});

test('Director non dispaccia nessuno mentre l’applicazione non parte', () => {
  /*
   * Director è il solo manager che AGISCE: `controller.runAgent(owner)` manda davvero uno
   * specialista a lavorare. Mandarlo su un albero che non si avvia produce un diff che non si può
   * verificare — e il rischio vero è che venga giudicato sui fallimenti del blocco. `owner: null`
   * è ciò che impedisce la partenza: è quello che va fissato, non il titolo.
   */
  const director = mgrs.byName.Director;

  bootRotto();
  const bloccato = director.critical();
  assert.equal(bloccato.kind, 'unblock');
  assert.equal(bloccato.owner, null, 'con il boot rotto non si può dispacciare nessuno');

  bootSano();
  const libero = director.critical();
  assert.notEqual(libero.kind, 'unblock', 'riparato il boot, Director torna a scegliere il lavoro');
});

/* ──────── 3. una domanda fra manager riceve una risposta che serve ──────── */

test('Quality chiede, Insights risponde, e la risposta cambia la raccomandazione', () => {
  const quality = mgrs.byName.Quality;
  const insights = mgrs.byName.Insights;

  bootSano();
  quality.analyze(); // tasso basso, nessun blocco: manda la domanda a Insights
  const domanda = insights.inbox({ kind: 'request', limit: 8 }).find((m) => m.payload?.ask === 'agents_failing_verification');
  assert.ok(domanda, 'la domanda non è arrivata nella posta di Insights');

  insights.analyze();
  assert.equal(insights.brief.stats.failingVerification, 'security 4', 'Insights deve rispondere con i numeri per agente');
  assert.equal(insights.brief.status, 'alert', "solo i brief in allarme raggiungono il planner: una risposta in 'watching' non cambia nulla");

  const risposta = quality.inbox({ kind: 'answer', limit: 8 }).find((m) => m.payload?.ask === 'agents_failing_verification');
  assert.ok(risposta, 'la risposta non è tornata a Quality');
  assert.equal(risposta.payload.agents[0].agent, 'security');

  quality.analyze();
  assert.match(quality.brief.headline, /security \(4\)/, 'Quality deve dire DOVE si concentra, non solo che qualcosa fallisce');
  assert.ok(
    quality.brief.recommendations.some((r) => /narrow security/.test(r)),
    'la raccomandazione che il planner legge deve nominare l’agente responsabile',
  );
});

test('né la domanda né la risposta si ripetono: la posta ha venti posti', () => {
  /*
   * `analyze()` gira a ogni evento, e Insights gira anche a ogni messaggio sul bus. Senza guardia
   * venti copie della stessa domanda — o della stessa risposta — butterebbero fuori dalla coda
   * tutto il resto, compresa la risposta stessa: il canale si romperebbe proprio perché usato.
   */
  const quality = mgrs.byName.Quality;
  const insights = mgrs.byName.Insights;
  const domandePrima = insights.inbox({ kind: 'request', limit: 100 }).length;
  const rispostePrima = quality.inbox({ kind: 'answer', limit: 100 }).length;

  for (let i = 0; i < 6; i++) {
    quality.analyze();
    insights.analyze();
  }

  assert.equal(insights.inbox({ kind: 'request', limit: 100 }).length, domandePrima, 'la domanda è stata rimandata');
  assert.equal(quality.inbox({ kind: 'answer', limit: 100 }).length, rispostePrima, 'la risposta è stata rimandata');
});

test('sotto un blocco Insights non propone di disabilitare un agente', () => {
  /*
   * Mentre l'applicazione non parte ogni agente perde, e "quasi sempre respinto" non distingue uno
   * specialista debole da uno che ha lavorato su un albero rotto. Un agente spento resta spento:
   * è una decisione durevole presa su un dato temporaneo.
   */
  const insights = mgrs.byName.Insights;

  // Premessa, perché il ramo giri: senza un agente davvero debole il test passerebbe a vuoto.
  bootSano();
  insights.analyze();
  assert.match(insights.brief.recommendations.join(' | '), /disable it/, 'premessa: senza blocco la proposta di disabilitare deve esserci');

  bootRotto();
  insights.analyze();
  const righe = insights.brief.recommendations.join(' | ');
  assert.ok(!/disable it/.test(righe), `ha proposto di disabilitare sotto un blocco: ${righe}`);
  assert.match(righe, /confounded/, 'va detto perché la classifica non si può usare');
  bootSano();
});
