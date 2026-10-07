import { test, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openProjectDb, closeProjectDb, initCoreSchema } from '../src/db.js';
import { modelFor } from '../src/config.js';
import {
  modelForTask,
  routeDecision,
  sizeLadder,
  taskDifficulty,
  setRoutingConfig,
  getRoutingConfig,
  resetRoutingConfig,
  JUDGEMENT_ROLES,
} from '../src/core/modelRouting.js';

/**
 * IL ROUTING DEVE POTER SOLO RISPARMIARE, MAI FAR FALLIRE.
 *
 * Il costo di un declassamento sbagliato non e' "una risposta peggiore": un task che non conclude
 * fa annullare l'intera iterazione, onde riuscite comprese. Il risparmio di un declassamento
 * giusto e' una frazione del tempo di una fase. Il rapporto fra i due e' il motivo per cui ogni
 * test qui sotto verifica la stessa cosa da un lato diverso: in ogni condizione di dubbio il
 * meccanismo deve restituire ESATTAMENTE `modelFor(role)`.
 */

// Il modello di oggi per `implement`, qualunque sia la configurazione della macchina che esegue i
// test: lo si legge da `config.js` invece di scriverlo a mano, cosi' il test non fissa un nome.
const BASE = modelFor('implement');

/*
 * Una detection finta.
 *
 * `sizeGB` NON e' decorativo: il routing rifiuta un declassamento che non scenda anche di ingombro,
 * perche' in un modello a esperti sparsi i parametri totali non sono il costo — `qwen3:30b-a3b` ne
 * dichiara 30,5 miliardi e ne attiva circa 3. Una fixture senza `sizeGB` descriverebbe modelli che
 * il runtime non produce, e proverebbe un percorso che in esercizio non esiste. Qui il peso segue
 * i parametri in proporzione, come in una famiglia densa.
 */
const detected = (models) => ({ models });
const chatModel = (id, paramsB, sizeGB = Math.round(paramsB * 0.6 * 10) / 10) =>
  ({ id, provider: 'ollama', paramsB, sizeGB, chat: true, embedding: false });

// Un root di lavoro con un file bersaglio piccolo: la dimensione dei file dichiarati e' uno dei
// segnali, e misurarla richiede che il file esista davvero.
let root;
let dbFile;

before(() => {
  dbFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'isl-routing-')), 'p.sqlite');
  openProjectDb(dbFile);
  initCoreSchema();

  root = fs.mkdtempSync(path.join(os.tmpdir(), 'isl-routing-root-'));
  fs.mkdirSync(path.join(root, 'src'), { recursive: true });
  // ~200 byte: ben sotto il limite di 24 KB.
  fs.writeFileSync(path.join(root, 'src', 'small.js'), '// '.padEnd(200, 'x') + '\n');
  // ~64 KB: ben sopra.
  fs.writeFileSync(path.join(root, 'src', 'huge.js'), '// '.padEnd(64 * 1024, 'y') + '\n');

  // Il routing non deve dipendere da come e' configurata la macchina di chi esegue i test.
  delete process.env.ISL_MODEL_ROUTING;
});

beforeEach(() => {
  setRoutingConfig({ enabled: true, agents: ['docs', 'quality'] });
});

/** Un task banale: un file piccolo, due step, agent nell'allowlist, nessun file nuovo. */
const trivialTask = () => ({
  kind: 'improvement',
  agent: 'docs',
  files: ['src/small.js'],
  newFiles: [],
  steps: ['Correggi il commento del modulo', 'Esegui i test'],
});

/** Due taglie con un salto reale: 30B di oggi, 8B disponibile (8 <= 30 * 0.6, e >= 4). */
const twoRungs = () => detected([chatModel(BASE, 30), chatModel('piccolo:8b', 8)]);

/* ----------------------------- un solo modello ---------------------------------- */

test('un solo modello installato: non c e nulla da scegliere e il routing si toglie di mezzo', () => {
  const only = detected([chatModel(BASE, 30)]);
  const d = routeDecision('implement', trivialTask(), { detected: only, root });
  assert.equal(d.model, modelFor('implement'), 'con una scala di un gradino il modello resta quello di oggi');
  assert.equal(d.routed, false);
  assert.match(d.reason, /nulla da scegliere/);
});

test('nessuna detection ancora passata: il routing non va a cercarla e torna la taglia piena', () => {
  // `detected: null` e' il caso reale all'avvio: la cache di detectModels e' vuota.
  const d = routeDecision('implement', trivialTask(), { detected: null, root });
  assert.equal(d.model, modelFor('implement'));
  assert.equal(d.routed, false);
});

/* -------------------------------- paramsB nullo --------------------------------- */

test('paramsB nullo: una taglia ignota non e una taglia piccola, quindi nessuno scende', () => {
  const unknown = detected([chatModel(BASE, null), chatModel('misterioso:latest', null)]);
  assert.deepEqual(sizeLadder(unknown), [], 'un modello senza paramsB non entra nella scala');

  const d = routeDecision('implement', trivialTask(), { detected: unknown, root });
  assert.equal(d.model, modelFor('implement'));
  assert.equal(d.routed, false);
});

test('il nome non entra nel giudizio: un solo paramsB noto non basta a costruire una scala', () => {
  // `tiny-1b-fast` SEMBRA piccolo ma non dichiara la taglia: il nome non viene creduto.
  const half = detected([chatModel(BASE, 30), chatModel('tiny-1b-fast:latest', null)]);
  assert.deepEqual(sizeLadder(half).map((m) => m.id), [BASE]);
  assert.equal(modelForTask('implement', trivialTask(), { detected: half, root }), modelFor('implement'));
});

/* ------------------------------- task banale ------------------------------------ */

test('task banale: scende di un gradino', () => {
  const d = routeDecision('implement', trivialTask(), { detected: twoRungs(), root });
  assert.equal(d.routed, true, 'un edit da due step su un file piccolo e lavoro meccanico');
  assert.equal(d.model, 'piccolo:8b');
  assert.notEqual(d.model, modelFor('implement'));
  assert.equal(d.difficulty.tier, 'mechanical');
  assert.deepEqual(d.difficulty.blockers, []);
});

test('scende di UN gradino utile, non in fondo alla scala', () => {
  const ladder = detected([
    chatModel(BASE, 30),
    chatModel('medio:14b', 14),
    chatModel('piccolo:8b', 8),
    chatModel('micro:1b', 1),
  ]);
  const d = routeDecision('implement', trivialTask(), { detected: ladder, root });
  // 14B e' ammissibile (14 <= 18) ed e' il piu' grande fra gli ammissibili: si prende quello.
  // `micro:1b` e' sotto il floor di 4B e non e' candidabile per nessun task.
  assert.equal(d.model, 'medio:14b');
});

test('un gradino che non risparmia niente non vale il rischio', () => {
  // 7.6B al posto di 8B: tutto il rischio, nessun risparmio. Il minSavingRatio lo esclude.
  const tooClose = detected([chatModel(BASE, 8), chatModel('quasiuguale:7.6b', 7.6)]);
  const d = routeDecision('implement', trivialTask(), { detected: tooClose, root });
  assert.equal(d.model, modelFor('implement'));
  assert.equal(d.routed, false);
  assert.match(d.reason, /risparmio di almeno/);
});

/* ------------------------------- task complesso --------------------------------- */

test('task complesso: taglia piena', () => {
  const complex = {
    kind: 'feature',
    agent: 'services',
    files: ['src/small.js', 'src/huge.js', 'src/altro.js'],
    newFiles: ['src/nuovo.js'],
    steps: ['uno', 'due', 'tre', 'quattro', 'cinque', 'sei', 'sette'],
  };
  const d = routeDecision('implement', complex, { detected: twoRungs(), root });
  assert.equal(d.routed, false);
  assert.equal(d.model, modelFor('implement'));
  assert.equal(d.difficulty.tier, 'full');
});

test('ogni singolo segnale di complessita basta da solo a tenere la taglia piena', () => {
  const variants = {
    'piu di un file': { files: ['src/small.js', 'src/huge.js'] },
    'troppi step': { steps: ['a', 'b', 'c'] },
    'kind feature': { kind: 'feature' },
    'file nuovi': { newFiles: ['src/nuovo.js'] },
    'agent fuori allowlist': { agent: 'security' },
    'file bersaglio enorme': { files: ['src/huge.js'] },
  };
  for (const [why, patch] of Object.entries(variants)) {
    const d = routeDecision('implement', { ...trivialTask(), ...patch }, { detected: twoRungs(), root });
    assert.equal(d.model, modelFor('implement'), `${why}: deve restare la taglia piena`);
    assert.equal(d.routed, false, why);
  }
});

test('un task senza file o senza step e assenza di segnale, non segnale di semplicita', () => {
  for (const patch of [{ files: [] }, { steps: [] }]) {
    const d = routeDecision('implement', { ...trivialTask(), ...patch }, { detected: twoRungs(), root });
    assert.equal(d.routed, false);
    assert.equal(d.model, modelFor('implement'));
  }
  // Nessun task affatto: `modelForTask(role)` e' legale e vale esattamente `modelFor(role)`.
  assert.equal(modelForTask('implement', null, { detected: twoRungs(), root }), modelFor('implement'));
});

test('un file dichiarato che non esiste non e lavoro meccanico', () => {
  const d = taskDifficulty({ ...trivialTask(), files: ['src/inesistente.js'] }, { root, config: getRoutingConfig() });
  assert.equal(d.tier, 'full');
  assert.equal(d.signals.bytes, null);
});

/* --------------------------- le fasi di giudizio -------------------------------- */

test('review e security non scendono MAI, nemmeno sul task piu banale del mondo', () => {
  for (const role of ['review', 'security']) {
    const d = routeDecision(role, trivialTask(), { detected: twoRungs(), root });
    assert.equal(d.model, modelFor(role), `${role} deve usare il modello pieno`);
    assert.equal(d.routed, false, role);
    assert.match(d.reason, /fase di giudizio/);
    assert.equal(modelForTask(role, trivialTask(), { detected: twoRungs(), root }), modelFor(role));
  }
});

test('plan non scende: un piano sbagliato spreca ogni fase a valle', () => {
  const d = routeDecision('plan', trivialTask(), { detected: twoRungs(), root });
  assert.equal(d.model, modelFor('plan'));
  assert.equal(d.routed, false);
  assert.match(d.reason, /fase di giudizio/);
});

test('nemmeno una configurazione permissiva puo far scendere una fase di giudizio', () => {
  // Il divieto non e' una soglia: allargare l'allowlist e azzerare i limiti non lo tocca.
  const permissive = { enabled: true, agents: ['docs', 'quality', 'security', 'services'], maxFiles: 20, maxSteps: 50, minParamsB: 0.5, minSavingRatio: 1 };
  for (const role of JUDGEMENT_ROLES) {
    const d = routeDecision(role, trivialTask(), { detected: twoRungs(), root, config: permissive });
    assert.equal(d.model, modelFor(role), `${role} non e declassabile per configurazione`);
  }
});

test('un ruolo non classificato cade in taglia piena', () => {
  const d = routeDecision('ruolo-che-non-esiste', trivialTask(), { detected: twoRungs(), root });
  assert.equal(d.routed, false);
  assert.match(d.reason, /non classificato/);
});

/* ------------------------------ routing spento ---------------------------------- */

test('routing spento: restituisce esattamente modelFor(role), per ogni ruolo', () => {
  setRoutingConfig({ enabled: false });
  assert.equal(getRoutingConfig().enabled, false);

  for (const role of ['implement', 'review', 'security', 'plan', 'research']) {
    const viaRouting = modelForTask(role, trivialTask(), { detected: twoRungs(), root });
    assert.equal(viaRouting, modelFor(role), `${role}: spento significa il comportamento di oggi`);
  }
  const d = routeDecision('implement', trivialTask(), { detected: twoRungs(), root });
  assert.equal(d.routed, false);
  assert.match(d.reason, /spento/);
});

test('lo spegnimento e persistente e riaccendibile senza toccare codice', () => {
  setRoutingConfig({ enabled: false });
  assert.equal(modelForTask('implement', trivialTask(), { detected: twoRungs(), root }), modelFor('implement'));
  setRoutingConfig({ enabled: true });
  assert.equal(modelForTask('implement', trivialTask(), { detected: twoRungs(), root }), 'piccolo:8b');
});

test('ISL_MODEL_ROUTING=off spegne il routing senza passare dalla dashboard', () => {
  const saved = process.env.ISL_MODEL_ROUTING;
  try {
    // La precedenza e' quella del resto del progetto: setting salvato → env → default. Per lasciare
    // parlare l'ambiente la scelta salvata va azzerata, che e' esattamente cio' che fa il reset.
    resetRoutingConfig();
    process.env.ISL_MODEL_ROUTING = 'off';
    assert.equal(getRoutingConfig().enabled, false);
    assert.equal(getRoutingConfig().from, 'env');
    assert.equal(modelForTask('implement', trivialTask(), { detected: twoRungs(), root }), modelFor('implement'));

    // E il setting salvato vince sull'ambiente, come dichiarato.
    setRoutingConfig({ enabled: true, agents: ['docs', 'quality'] });
    assert.equal(getRoutingConfig().from, 'setting');
    assert.equal(modelForTask('implement', trivialTask(), { detected: twoRungs(), root }), 'piccolo:8b');
  } finally {
    if (saved === undefined) delete process.env.ISL_MODEL_ROUTING;
    else process.env.ISL_MODEL_ROUTING = saved;
  }
});

test('senza database aperto il routing risulta spento, non rotto', () => {
  // Fuori da un progetto `getSetting` lancia. Chi non riesce a leggere la propria configurazione
  // non e in condizione di prendere una decisione rischiosa.
  closeProjectDb();
  try {
    const cfg = getRoutingConfig();
    assert.equal(cfg.enabled, false);
    assert.equal(cfg.readable, false);
    assert.equal(modelForTask('implement', trivialTask(), { detected: twoRungs(), root }), modelFor('implement'));
  } finally {
    openProjectDb(dbFile);
  }
});

/* -------------------------- non puo far fallire niente -------------------------- */

test('un input malformato non fa lanciare il routing: torna la taglia piena', () => {
  const junk = [
    undefined,
    null,
    42,
    'una stringa',
    { files: 'non-un-array', steps: null, agent: 7, kind: {} },
    { files: [null, undefined, ''], steps: [''] },
  ];
  for (const task of junk) {
    assert.equal(
      modelForTask('implement', task, { detected: twoRungs(), root }),
      modelFor('implement'),
      `task malformato (${JSON.stringify(task)}) non deve declassare ne lanciare`,
    );
  }
  // Anche una detection malformata.
  for (const bad of [{ models: 'no' }, { models: [null, {}, { id: 'x' }] }, 'no', 7]) {
    assert.equal(modelForTask('implement', trivialTask(), { detected: bad, root }), modelFor('implement'));
  }
});

/* ------------------- i difetti trovati dalla verifica ------------------- */

test('un MoE non viene scambiato per grande: i parametri non sono il costo', () => {
  /*
   * Il difetto piu' grave, e non di laboratorio: il modello predefinito del progetto e'
   * `qwen3.6:latest`. Un modello a esperti sparsi dichiara 30,5 miliardi di parametri e ne attiva
   * circa 3; declassarlo su un denso da 14 significa QUATTRO O CINQUE VOLTE piu' calcolo attivo per
   * token, con per di piu' un modello piu' debole — l'inversione esatta dell'economia servita.
   *
   * Il peso scende del 50%, i parametri del 54%: l'ingombro non cala quanto i parametri promettono,
   * ed e' il segnale che quei parametri non erano tutti attivi.
   */
  const moe = { models: [
    { id: 'moe:30b-a3b', paramsB: 30.5, sizeGB: 18, chat: true, embedding: false },
    { id: 'denso:14b', paramsB: 14, sizeGB: 9, chat: true, embedding: false },
  ] };
  const d = routeDecision('implement', trivialTask(), { detected: moe, root, baseline: 'moe:30b-a3b' });
  assert.equal(d.routed, false, 'un MoE non deve essere declassato su un denso piu piccolo');
});

test('senza la misura di ingombro non si declassa', () => {
  // Niente `sizeGB` significa non poter dimostrare che il costo scenda. In dubbio si rinuncia: un
  // risparmio mancato non costa nulla, un declassamento sbagliato annulla l'intera iterazione.
  const senzaPeso = { models: [
    { id: 'grande:30b', paramsB: 30, chat: true, embedding: false },
    { id: 'piccolo:8b', paramsB: 8, chat: true, embedding: false },
  ] };
  const d = routeDecision('implement', trivialTask(), { detected: senzaPeso, root, baseline: 'grande:30b' });
  assert.equal(d.routed, false);
});

test('una soglia non configurata ricade sul default, non su zero', () => {
  /*
   * `Number('')` vale 0, quindi un campo numerico vuoto di un form portava il pavimento da 4
   * miliardi di parametri a 0,5 — il regime che questo modulo dichiara vietato, dove il fallimento
   * non e' "codice peggiore" ma "nessuna modifica".
   */
  for (const assente of ['', '   ', null, false, []]) {
    setRoutingConfig({ enabled: true, minParamsB: assente });
    assert.equal(getRoutingConfig().minParamsB, 4, `${JSON.stringify(assente)} non deve valere zero`);
  }
  resetRoutingConfig();
});

test('cambiare una soglia non riaccende un routing spento', () => {
  // Un interruttore di sicurezza che si richiude da solo quando tocchi qualcos'altro non e' un
  // interruttore: chi aveva spento il routing se lo ritrovava acceso dopo aver mosso una soglia.
  resetRoutingConfig();
  setRoutingConfig({ enabled: false });
  assert.equal(getRoutingConfig().enabled, false);
  setRoutingConfig({ maxFiles: 2 });
  assert.equal(getRoutingConfig().enabled, false, 'toccare una soglia non deve riaccendere il routing');
  resetRoutingConfig();
});
