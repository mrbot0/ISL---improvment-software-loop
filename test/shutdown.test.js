import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { spawn } from 'node:child_process';
import path from 'node:path';
import os from 'node:os';
import { SHUTDOWN_EXIT_CODE } from '../src/core/shutdownCode.js';

/**
 * L'arresto completo dipende da una cosa sola: che il supervisore sappia distinguere "il server è
 * morto" da "gli è stato chiesto di morire". Se sbaglia, il pulsante non spegne niente — il server
 * torna su dopo due secondi e l'operatore non capisce perché.
 *
 * Questi test guidano il VERO supervisore con un finto server, invece di riscrivere la sua logica
 * nel test: una copia della regola nel test dimostra solo che la copia funziona, ed è la copia che
 * poi resta indietro.
 */

const ROOT = path.resolve(import.meta.dirname, '..');

/** Avvia il supervisore con un server finto che esce col codice richiesto, e riferisce cosa accade. */
function runSupervisorWith(exitCode, { waitMs = 4000 } = {}) {
  return new Promise((resolve) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'isl-shutdown-'));
    const fake = path.join(dir, 'fakeServer.mjs');
    // Ogni avvio lascia una riga: contarle dice quante volte il supervisore ha rilanciato.
    fs.writeFileSync(fake, [
      'import fs from "node:fs";',
      `fs.appendFileSync(${JSON.stringify(path.join(dir, 'starts.log'))}, "x");`,
      `process.exit(${exitCode});`,
    ].join('\n'));

    // Il supervisore VERO, puntato al server finto. Nessuna copia: una copia riscritta proverebbe
    // la copia, e la regola che ci interessa vive nell'originale.
    const child = spawn(process.execPath, [path.join(ROOT, 'supervisor.mjs')], {
      cwd: ROOT,
      stdio: 'ignore',
      env: { ...process.env, ISL_SERVER_ENTRY: fake },
    });
    let exited = null;
    child.on('exit', (code) => { exited = code; });

    setTimeout(() => {
      const starts = fs.existsSync(path.join(dir, 'starts.log'))
        ? fs.readFileSync(path.join(dir, 'starts.log'), 'utf8').length
        : 0;
      if (exited === null) child.kill();
      setTimeout(() => {
        fs.rmSync(dir, { recursive: true, force: true });
        resolve({ starts, supervisorExit: exited });
      }, 200);
    }, waitMs);
  });
}

test('il codice di arresto ferma anche il supervisore', async () => {
  const r = await runSupervisorWith(SHUTDOWN_EXIT_CODE);
  assert.equal(r.starts, 1, 'il server non doveva essere rilanciato');
  assert.equal(r.supervisorExit, 0, 'il supervisore doveva uscire, e uscire pulito');
});

test('un crash normale viene ancora rilanciato', async () => {
  // La rete di sicurezza deve restare: se questo test passa insieme al precedente, il supervisore
  // sta davvero distinguendo i due casi invece di aver smesso di riavviare.
  const r = await runSupervisorWith(1);
  assert.ok(r.starts > 1, `atteso almeno un riavvio, avviato ${r.starts} volta/e`);
  assert.equal(r.supervisorExit, null, 'il supervisore doveva restare vivo per riprovare');
});

test('il codice concordato non collide con quelli che Node produce da solo', () => {
  // 0 successo, 1 eccezione, 7/8/9/12/13 errori interni, 128+N i segnali.
  assert.ok(![0, 1, 7, 8, 9, 12, 13].includes(SHUTDOWN_EXIT_CODE));
  assert.ok(SHUTDOWN_EXIT_CODE < 128);
});
