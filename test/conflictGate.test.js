import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkConflictMarkers } from '../src/iteration/conflictGate.js';

const wrap = (file, lines) => [
  `diff --git a/${file} b/${file}`,
  `--- a/${file}`,
  `+++ b/${file}`,
  '@@ -1,1 +1,9 @@',
  ...lines,
].join('\n');

test('vieta una modifica che introduce marcatori di conflitto', () => {
  // La forma esatta trovata in HEAD su un repository vero, ferma lì da 200 iterazioni.
  const r = checkConflictMarkers(wrap('server/lib/__tests__/circuitBreaker.test.js', [
    '+<<<<<<< ours',
    "+import { CircuitBreaker } from '../circuitBreaker.js';",
    '+=======',
    "+import { CircuitBreaker, getBreaker } from '../circuitBreaker.js';",
    '+>>>>>>> theirs',
  ]));
  assert.equal(r.veto, true);
  assert.equal(r.findings.length, 3);
  assert.match(r.summary, /circuitBreaker\.test\.js/);
});

test('non confonde una freccia o un operatore con un marcatore', () => {
  const r = checkConflictMarkers(wrap('src/x.js', [
    '+const shift = a >>> 2;',
    '+const cmp = x <<< y;',
    '+// ======= sezione =======',
    '+const eq = a === b;',
  ]));
  assert.equal(r.veto, false, r.summary);
});

test('un marcatore già presente e non aggiunto dalla modifica non la blocca', () => {
  // Bloccare una modifica per un difetto che non ha introdotto non lo ripara: rende solo
  // impossibile lavorare su quel file, che è il contrario di quello che serve.
  const r = checkConflictMarkers(wrap('src/x.js', [
    ' <<<<<<< ours',
    '+const aggiunta = 1;',
    ' >>>>>>> theirs',
  ]));
  assert.equal(r.veto, false);
});

test('il riepilogo nomina il file, non solo il conteggio', () => {
  const r = checkConflictMarkers(wrap('app/pages/Admin.jsx', ['+<<<<<<< Updated upstream']));
  assert.match(r.summary, /Admin\.jsx/);
});

test('un diff vuoto passa senza inventare problemi', () => {
  assert.equal(checkConflictMarkers('').veto, false);
});
