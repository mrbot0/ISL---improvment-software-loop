import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openProjectDb } from '../src/db.js';

/**
 * LA COMUNICAZIONE FRA MANAGER ERA A SENSO UNICO.
 *
 * Misurato sul codice prima di questa modifica: `send` e `broadcast` erano chiamati dodici volte,
 * `peerConcerns` zero, `readPeer` e `readAllPeers` zero. I messaggi finivano nel database e sul
 * bus, e l'unico iscritto a `manager.message` usava l'evento come campanello — richiamava la
 * propria analisi senza mai aprire il payload. L'unico lettore vero era la dashboard: i manager
 * comunicavano con l'operatore, non fra loro.
 *
 * Questi test verificano le due proprietà che rendono il canale reale, e che si perderebbero senza
 * che nulla fallisca: che un messaggio ARRIVI a chi è destinato, e che un manager in allarme SAPPIA
 * cosa stanno segnalando gli altri.
 */

const tmp = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'isl-comms-')), 'p.sqlite');
openProjectDb(tmp);

const { BaseManager } = await import('../src/managers/baseManager.js');

class Finto extends BaseManager {
  constructor(nome) {
    super(nome, { role: 'test' });
  }
}

test('un messaggio diretto arriva nella posta del destinatario', () => {
  const a = new Finto('Alfa');
  const b = new Finto('Beta');
  a.start();
  b.start();

  a.send('Beta', 'risk', { what: 'il database non risponde' }, { severity: 'critical', title: 'DB giù' });

  const posta = b.inbox();
  assert.equal(posta.length, 1, 'il destinatario non ha ricevuto nulla');
  assert.equal(posta[0].from, 'Alfa');
  assert.equal(posta[0].kind, 'risk');
  assert.equal(posta[0].payload.what, 'il database non risponde', 'il contenuto non deve essere scartato');
  assert.equal(a.inbox().length, 0, 'il mittente non deve ricevere il proprio messaggio');

  a.stop();
  b.stop();
});

test('un broadcast arriva a tutti tranne che a chi lo manda', () => {
  const a = new Finto('Gamma');
  const b = new Finto('Delta');
  const c = new Finto('Epsilon');
  [a, b, c].forEach((m) => m.start());

  a.broadcast('insight', { nota: 'la suite è lenta' });

  assert.equal(b.inbox().length, 1);
  assert.equal(c.inbox().length, 1);
  assert.equal(a.inbox().length, 0);

  [a, b, c].forEach((m) => m.stop());
});

test('la posta ha capienza fissa: un processo acceso per giorni non accumula', () => {
  const a = new Finto('Zeta');
  const b = new Finto('Eta');
  a.start();
  b.start();

  for (let i = 0; i < 50; i++) a.send('Eta', 'insight', { i });

  const posta = b.inbox({ limit: 100 });
  assert.ok(posta.length <= 20, `la coda è cresciuta a ${posta.length}`);
  assert.equal(posta[posta.length - 1].payload.i, 49, "l'ultimo messaggio deve essere il più recente");

  a.stop();
  b.stop();
});

test('un manager in allarme pubblica cosa stanno segnalando gli altri', () => {
  /*
   * È la proprietà per cui `peerConcerns` era stata scritta, e che non valeva per nessuno perché
   * non la chiamava nessuno: "i test falliscono" significa una cosa diversa quando un altro
   * manager sta dicendo che l'applicazione non si avvia affatto.
   */
  const workbench = new Finto('Workbench');
  const tests = new Finto('Tests');
  workbench.start();
  tests.start();

  workbench.setBrief({ status: 'alert', headline: "l'applicazione non si avvia" });
  tests.setBrief({ status: 'alert', headline: 'la suite fallisce' });

  const ctx = tests.brief.peerContext;
  assert.ok(Array.isArray(ctx) && ctx.length >= 1, 'il manager in allarme non vede i pari');
  const visto = ctx.find((p) => p.name === 'Workbench');
  assert.ok(visto, 'il pari in allarme deve comparire');
  assert.match(visto.headline, /non si avvia/);
  assert.ok(!ctx.some((p) => p.name === 'Tests'), 'un manager non deve vedere se stesso fra i pari');

  workbench.stop();
  tests.stop();
});

test('a riposo il contesto dei pari non viene allegato', () => {
  // A riposo è rumore: il brief lo leggono la dashboard e il planner, e ogni riga che non serve
  // toglie spazio a una che serve.
  const m = new Finto('Theta');
  m.start();
  m.setBrief({ status: 'ok', headline: 'tutto a posto' });
  assert.equal(m.brief.peerContext ?? null, null);
  m.stop();
});
