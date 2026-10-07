import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { exportSurface, surfaceNotes, changeNote, readSource } from '../src/iteration/implementer.js';

/**
 * IL DIFETTO CHE LA NON-COLLISIONE NON COPRE.
 *
 * Le onde di `parallelImplementer` sono composte in modo che due task non dichiarino mai lo stesso
 * file, e la garanzia è vera: nessun conflitto da risolvere nel fold. Ma riguarda i FILE, non il
 * SIGNIFICATO. A cambia la firma di `send` in http.js, B la chiama da client.js: file diversi,
 * nessuna collisione, entrambi i task passano i propri test, e la combinazione è rotta.
 *
 * L'unica difesa è dirlo a B. Il resoconto qui sotto è ciò che B riceve: quali file sono stati
 * toccati, da chi, e cosa è cambiato nella superficie pubblica. Deve stare in una riga — finisce in
 * un prompt — e soprattutto non deve MENTIRE: un agente crede a una firma che legge, quindi quando
 * il "prima" non è noto si riporta solo il nome del file.
 */

test('la superficie pubblica ignora gli `export` che non sono codice', () => {
  // Senza `stripNonCode` ogni commento e ogni stringa che parla di export entrerebbe nel
  // resoconto, e un agente andrebbe a cercare un simbolo che non esiste.
  const surface = exportSurface(`
    // export function ghost() {}
    /* export const alsoGhost = 1; */
    const doc = 'export const fake = 1';
    export function real(a, b) {}
  `);
  assert.deepEqual([...surface.keys()], ['real']);
  assert.equal(surface.get('real'), '(a, b)');
});

test('riconosce le forme di export che questo codice usa davvero', () => {
  const surface = exportSurface(`
    export async function run(spec) {}
    export const parse = (src, opts) => src;
    export const ping = async () => 1;
    export const one = (x) => x;
    export const LIMIT = 10;
    export class Box {}
    const inner = 1;
    export { inner as outer };
  `);
  assert.deepEqual([...surface.keys()].sort(), ['Box', 'LIMIT', 'one', 'outer', 'parse', 'ping', 'run']);
  assert.equal(surface.get('run'), '(spec)');
  assert.equal(surface.get('parse'), '(src, opts)');
  assert.equal(surface.get('one'), '(x)');
  assert.equal(surface.get('LIMIT'), ''); // un valore non ha firma
});

test('il delta dice comparse, sparizioni e cambi di firma', () => {
  const before = 'export function formatDate(d) {}\nexport const parse = (src, opts) => src;\n';
  const after = 'export function formatDateTime(d, tz) {}\nexport const parse = (src) => src;\n';
  const notes = surfaceNotes(before, after);
  assert.deepEqual(notes, [
    "rimossa l'export `formatDate`",
    "aggiunta l'export `formatDateTime`",
    'firma cambiata: `parse(src)`',
  ]);
});

test('un file riformattato ma con la stessa superficie non produce rumore', () => {
  // La firma è normalizzata negli spazi: un a capo aggiunto fra i parametri non è un cambio di
  // contratto, e segnalarlo insegnerebbe a ignorare il resoconto.
  const before = 'export function send(url, body) {}';
  const after = 'export function send(\n  url,\n  body,\n) {\n  // altra implementazione\n}';
  assert.deepEqual(surfaceNotes(before, after), []);
});

test('file nuovo e file rimosso si distinguono', () => {
  assert.deepEqual(surfaceNotes(null, 'export const q = 1;'), ['nuovo file, esporta `q`']);
  assert.deepEqual(surfaceNotes('export const q = 1;', null), ['file rimosso']);
});

test('la riga di resoconto nomina agente, task e delta', () => {
  const before = 'export function send(url, body) {}\nexport const ping = () => 1;\n';
  const after = 'export function send(url, body, timeoutMs) {}\n';
  const note = changeNote({
    task: { agent: 'resilience', title: 'Timeout su ogni chiamata HTTP' },
    files: ['src/http.js'],
    before: () => before,
    after: () => after,
  });
  assert.match(note, /^- \[resilience\] Timeout su ogni chiamata HTTP → src\/http\.js: /);
  assert.match(note, /rimossa l'export `ping`/);
  assert.match(note, /firma cambiata: `send\(url, body, timeoutMs\)`/);
});

test('quando il "prima" non è noto si riporta solo il file, mai una firma inventata', () => {
  // `undefined` = non lo sappiamo (un file non dichiarato toccato in un\'onda di uno). Dedurre un
  // delta da lì vorrebbe dire annunciare come NUOVA ogni export che esisteva già.
  const note = changeNote({
    task: { agent: 'quality', title: 'Pulizia' },
    files: ['src/mystery.js'],
    before: () => undefined,
    after: () => 'export const q = 1;',
  });
  assert.equal(note, '- [quality] Pulizia → src/mystery.js');
});

test('i file non-codice e la coda lunga restano brevi', () => {
  const note = changeNote({
    task: { agent: 'docs', title: 'Aggiorna la guida' },
    files: ['README.md', 'a.js', 'b.js', 'c.js', 'd.js', 'e.js'],
    before: () => null,
    after: () => 'export const q = 1;',
    maxFiles: 2,
  });
  // Il Markdown non ha superficie pubblica; gli altri quattro file non devono allungare la riga.
  assert.equal(note, '- [docs] Aggiorna la guida → README.md · a.js: nuovo file, esporta `q` · +4 altri file');
});

test('un task che non ha toccato niente non ha resoconto', () => {
  assert.equal(changeNote({ task: { agent: 'tests', title: 'niente' }, files: [] }), null);
});

test('sul filesystem, esattamente come lo compone un\'onda', () => {
  // Lo stesso montaggio di `parallelImplementer`: si cattura il "prima" dei file dichiarati, il
  // task edita il sandbox, e il "dopo" si rilegge da lì. È il passaggio in cui un errore di
  // percorso non si vedrebbe nei test sulle sole stringhe.
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'isl-wave-'));
  try {
    fs.mkdirSync(path.join(sandbox, 'src'), { recursive: true });
    fs.writeFileSync(path.join(sandbox, 'src/http.js'), 'export function send(url, body) {}\n', 'utf8');
    fs.writeFileSync(path.join(sandbox, 'src/legacy.js'), 'export const old = 1;\n', 'utf8');

    const declared = ['src/http.js', 'src/legacy.js', 'src/new.js'];
    const before = new Map(declared.map((rel) => [rel, readSource(sandbox, rel)]));
    assert.equal(before.get('src/new.js'), null); // non esiste ancora: è un file nuovo, non un ignoto

    // …il task fa il suo lavoro.
    fs.writeFileSync(path.join(sandbox, 'src/http.js'), 'export function send(url, body, timeoutMs) {}\n', 'utf8');
    fs.writeFileSync(path.join(sandbox, 'src/new.js'), 'export const retry = (fn) => fn();\n', 'utf8');
    fs.rmSync(path.join(sandbox, 'src/legacy.js'));

    const note = changeNote({
      task: { agent: 'resilience', title: 'Timeout e retry' },
      files: declared,
      before: (rel) => (before.has(rel) ? before.get(rel) : undefined),
      after: (rel) => readSource(sandbox, rel),
    });
    assert.equal(
      note,
      '- [resilience] Timeout e retry → src/http.js: firma cambiata: `send(url, body, timeoutMs)`' +
        ' · src/legacy.js: file rimosso · src/new.js: nuovo file, esporta `retry`',
    );
  } finally {
    fs.rmSync(sandbox, { recursive: true, force: true });
  }
});

test('export { f }: una firma cambiata non resta muta', () => {
  /*
   * Era il buco piu' importante, perche' coincideva con lo scenario che motiva tutto il
   * meccanismo — "A cambia la firma di `send`, B la chiama". Il nome veniva registrato con firma
   * vuota, quindi prima e dopo la superficie diceva `send -> ''` e il confronto non vedeva nulla.
   * Dieci moduli di ISL stesso esportano con la lista.
   */
  const prima = 'function send(url, body) { return 1; }\nexport { send };';
  const dopo = 'function send(url, body, timeoutMs) { return 1; }\nexport { send };';
  const note = surfaceNotes(prima, dopo);
  assert.equal(note.length, 1);
  assert.match(note[0], /firma cambiata/);
  assert.match(note[0], /timeoutMs/);
});

test('export { f as g }: la firma si cerca sul nome locale, si riporta quello esposto', () => {
  const a = 'const fetchIt = (a) => a;\nexport { fetchIt as get };';
  const b = 'const fetchIt = (a, b) => a;\nexport { fetchIt as get };';
  const note = surfaceNotes(a, b);
  assert.equal(note.length, 1);
  // Chi chiama conosce `get`, non `fetchIt`: il nome nella nota deve essere il suo.
  assert.match(note[0], /`get\(a, b\)`/);
});

test('un valore riesportato non ha firma e non inventa differenze', () => {
  const a = 'const X = 5;\nexport { X };';
  const b = 'const X = 6;\nexport { X };';
  // Cambia il valore, non il contratto: nessun chiamante deve essere avvisato.
  assert.deepEqual(surfaceNotes(a, b), []);
});
