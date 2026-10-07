import { test } from 'node:test';
import assert from 'node:assert/strict';
import { floorBreaches } from '../src/iteration/engine.js';

/**
 * LA DOMANDA A CUI UNA MEDIA NON SA RISPONDERE.
 *
 * La media pesata risponde a "quanto è buono nel complesso". Committare è un'altra domanda: "c'è
 * qualcosa che da solo squalifica questa modifica". In `engine.js` ci sono sedici punti di
 * rollback, quasi tutti aggiunti dopo che un difetto preciso era passato attraverso la media — un
 * file che non compila totalizzava ~80 perché il review pesa 0.2, una suite interamente rossa
 * totalizzava 83 perché i test pesano 0.15.
 *
 * Questi test fissano le tre proprietà che rendono una soglia diversa da un peso, e che se si
 * perdono non fanno fallire niente: che squalifichi NONOSTANTE un totale alto, che una dimensione
 * NON MISURATA non venga scambiata per bocciata, e che una soglia spenta non blocchi nulla.
 */

test('una dimensione sotto soglia squalifica anche con tutto il resto perfetto', () => {
  // Il caso reale: review 55 insieme a quattro punteggi meccanici quasi perfetti totalizzava 90 e
  // committava. La media diluisce l'unica obiezione; la soglia no.
  const scores = { review: 55, security: 100, regression: 100, test: 95, workbench: 100 };
  const b = floorBreaches(scores, {});
  assert.equal(b.length, 1);
  assert.equal(b[0].dim, 'review');
  assert.equal(b[0].score, 55);
  assert.equal(b[0].floor, 70);
});

test('una dimensione NON MISURATA non viene scambiata per bocciata', () => {
  // Una fase saltata non deve squalificare: la soglia punirebbe l'assenza di un giudizio invece
  // di un giudizio negativo, e ogni run senza quella fase verrebbe annullata.
  assert.deepEqual(floorBreaches({ review: null, security: 100 }, {}), []);
  assert.deepEqual(floorBreaches({ security: 100 }, {}), []);
  assert.deepEqual(floorBreaches({}, {}), []);
});

test('una soglia a zero è spenta e non blocca nulla', () => {
  // Le dimensioni per cui non esiste una distribuzione misurata partono spente: inventare una
  // soglia bloccherebbe lavoro buono sulla base di un'intuizione.
  const scores = { review: 100, security: 1, regression: 1, test: 1, workbench: 1 };
  assert.deepEqual(floorBreaches(scores, {}), []);
});

test('ogni dimensione può avere la propria soglia, dalla configurazione', () => {
  const scores = { review: 100, security: 40, test: 30 };
  const b = floorBreaches(scores, { 'floor.security': 60, 'floor.test': 50 });
  assert.equal(b.length, 2);
  assert.deepEqual(b.map((x) => x.dim).sort(), ['security', 'test']);
});

test('la soglia del review resta configurabile anche con la chiave storica', () => {
  // `review_floor` era la chiave usata dal veto specifico che `floorBreaches` sostituisce:
  // un'installazione che l'aveva impostata non deve vedere il proprio valore ignorato.
  assert.deepEqual(floorBreaches({ review: 65 }, { review_floor: 60 }), []);
  assert.equal(floorBreaches({ review: 65 }, { review_floor: 80 }).length, 1);
  // La chiave nuova ha la precedenza quando ci sono entrambe.
  assert.deepEqual(floorBreaches({ review: 65 }, { review_floor: 80, 'floor.review': 60 }), []);
});

test('riporta tutte le dimensioni sotto soglia, non solo la prima', () => {
  // Chi legge l'errore deve sapere quante cose sono da correggere, non scoprirne una per run.
  const b = floorBreaches({ review: 10, security: 10 }, { 'floor.security': 50 });
  assert.equal(b.length, 2);
});
