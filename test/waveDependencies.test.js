import { test } from 'node:test';
import assert from 'node:assert/strict';
import { planWaves, describeWaves } from '../src/core/scheduler.js';

/**
 * IL BUCO CHE LA COLLISIONE SUI FILE NON COPRE.
 *
 * Le onde si compongono guardando i file dichiarati: due task che scrivono lo stesso file non
 * possono stare insieme. È vero e necessario, ma è un segnale DIVERSO dall'ordine. Il task A
 * aggiunge un helper in `a.js`, il task B lo importa da `b.js`: i file non si sovrappongono,
 * niente li separa, finiscono nella stessa onda, e B fallisce perché l'helper non esiste ancora.
 *
 * `dependsOn` è l'unico modo di dire "B viene DOPO A". Questi test coprono le quattro cose che
 * contano: che l'ordine sia rispettato, che un ciclo non fermi né svuoti il lotto, che un `ref`
 * scritto male non costi l'intero batch, e — il più importante — che senza `dependsOn` il piano
 * sia esattamente quello di prima.
 */

/** Un task minimo: solo ciò che lo scheduler legge. */
const T = (ref, files, dependsOn) => ({
  ref,
  title: ref,
  agent: 'quality',
  kind: 'improvement',
  files,
  ...(dependsOn === undefined ? {} : { dependsOn }),
});

/** In quale onda è finito il task con questo `ref`. */
const waveOf = (waves, ref) => waves.findIndex((w) => w.some((x) => x.task.ref === ref));

/** I `ref` per onda, nell'ordine in cui lo scheduler li ha messi. */
const shape = (waves) => waves.map((w) => w.map((x) => x.task.ref));

/** Tutti i task sono stati collocati esattamente una volta? Un task perso è il difetto peggiore. */
function assertNoneLost(waves, refs) {
  const placed = waves.flat().map((x) => x.task.ref);
  assert.deepEqual(placed.slice().sort(), refs.slice().sort(), 'qualche task è stato perso o duplicato');
}

test('il task che USA aspetta il task che AGGIUNGE, anche se i file non si sovrappongono', () => {
  // Esattamente lo scenario che motiva il meccanismo: file disgiunti, quindi la collisione non
  // li separerebbe mai. Senza `dependsOn` starebbero nella stessa onda e il secondo fallirebbe.
  const tasks = [
    T('use', ['src/b.js'], ['add']),
    T('add', ['src/a.js']),
  ];
  const waves = planWaves(tasks, 2);
  assert.ok(waveOf(waves, 'add') < waveOf(waves, 'use'), `onde: ${JSON.stringify(shape(waves))}`);
  assertNoneLost(waves, ['use', 'add']);
});

test('una dipendenza non è soddisfatta dalla STESSA onda — dentro un\'onda non c\'è ordine', () => {
  /*
   * È la parte che si sbaglia facilmente. I task girano in parallelo dentro un'onda: metterli
   * insieme non significa "prima A poi B", significa "insieme". La dipendenza deve stare in
   * un'onda GIÀ CHIUSA, e questo richiede almeno due onde anche quando ci sarebbe spazio.
   */
  const waves = planWaves([T('add', ['src/a.js']), T('use', ['src/b.js'], ['add'])], 4);
  assert.equal(waves.length, 2);
  assert.deepEqual(shape(waves), [['add'], ['use']]);
});

test('una catena di tre si srotola in tre onde, in ordine', () => {
  const tasks = [
    T('third', ['src/c.js'], ['second']),
    T('second', ['src/b.js'], ['first']),
    T('first', ['src/a.js']),
  ];
  const waves = planWaves(tasks, 3);
  assert.deepEqual(shape(waves), [['first'], ['second'], ['third']]);
});

test('più dipendenze: si aspetta la PIÙ TARDIVA, non la prima soddisfatta', () => {
  // `last` dipende da due task che per via della collisione sui file finiscono in onde diverse.
  // Non basta che uno dei due sia atterrato: devono esserlo tutti.
  const tasks = [
    T('last', ['src/z.js'], ['one', 'two']),
    T('one', ['src/shared.js']),
    T('two', ['src/shared.js']), // collide con `one`: slitta di un'onda
  ];
  const waves = planWaves(tasks, 3);
  const lastWave = waveOf(waves, 'last');
  assert.ok(lastWave > waveOf(waves, 'one'), 'last non aspetta one');
  assert.ok(lastWave > waveOf(waves, 'two'), 'last non aspetta two');
  assertNoneLost(waves, ['last', 'one', 'two']);
});

test('un ciclo A↔B non blocca e non perde niente: si spezza, e lo si dice', () => {
  /*
   * IL RISCHIO VERO. Un modello che ragiona su due task per volta dichiara "A dopo B" e "B dopo
   * A" senza accorgersene. Senza protezione lo scheduler non terminerebbe, o scarterebbe dei
   * task in silenzio — e un task scartato di cui nessuno dice niente è peggio di un errore.
   */
  const waves = planWaves([T('A', ['src/a.js'], ['B']), T('B', ['src/b.js'], ['A'])], 2);
  assertNoneLost(waves, ['A', 'B']);
  // La rottura è deterministica e dichiarata: si libera il task di indice più basso, quindi `A`
  // (il primo nell'ordine del piano) smette di aspettare `B`, e l'ordine residuo è B dopo A.
  assert.deepEqual(shape(waves), [['A'], ['B']]);
  assert.ok(waves.notes?.some((n) => /broke a dependency cycle/.test(n)), JSON.stringify(waves.notes));
  // E la decisione è leggibile dove il piano viene loggato, non in un canale che nessuno guarda.
  assert.match(describeWaves(waves), /note: broke a dependency cycle/);
});

test('lo stesso ciclo dà sempre lo stesso piano: la rottura non è casuale', () => {
  const build = () => planWaves([T('A', ['src/a.js'], ['B']), T('B', ['src/b.js'], ['A'])], 2);
  assert.deepEqual(shape(build()), shape(build()));
  assert.deepEqual(build().notes, build().notes);
});

test('un ciclo a tre si spezza con UN SOLO arco: gli altri ordini sopravvivono', () => {
  // A→B→C→A. Si taglia l'arco che chiude il ciclo sul task di indice più basso (A aspettava C),
  // e restano validi "B dopo A" e "C dopo B": il piano è la catena completa, non il caos.
  const tasks = [
    T('A', ['src/a.js'], ['C']),
    T('B', ['src/b.js'], ['A']),
    T('C', ['src/c.js'], ['B']),
  ];
  const waves = planWaves(tasks, 3);
  assert.deepEqual(shape(waves), [['A'], ['B'], ['C']]);
  assert.equal(waves.notes.filter((n) => /broke a dependency cycle/.test(n)).length, 1);
});

test('due cicli indipendenti si spezzano entrambi', () => {
  const tasks = [
    T('A', ['src/a.js'], ['B']),
    T('B', ['src/b.js'], ['A']),
    T('C', ['src/c.js'], ['D']),
    T('D', ['src/d.js'], ['C']),
  ];
  const waves = planWaves(tasks, 4);
  assertNoneLost(waves, ['A', 'B', 'C', 'D']);
  assert.ok(waveOf(waves, 'A') < waveOf(waves, 'B'));
  assert.ok(waveOf(waves, 'C') < waveOf(waves, 'D'));
});

test('un task che dipende da sé stesso viene ignorato, non messo in attesa di sé', () => {
  const waves = planWaves([T('solo', ['src/a.js'], ['solo'])], 2);
  assert.deepEqual(shape(waves), [['solo']]);
  assert.ok(waves.notes?.some((n) => /self-dependency/.test(n)), JSON.stringify(waves.notes));
});

test('un `ref` inesistente è una dipendenza ASSENTE, non un lotto perduto', () => {
  /*
   * Il planner scrive un riferimento storto di tanto in tanto. Perdere il batch intero per una
   * stringa sbagliata non è un prezzo accettabile: la dipendenza si ignora, il task gira, e
   * l'errore del planner resta scritto.
   */
  const waves = planWaves([T('real', ['src/a.js'], ['fn:999', '  ', null])], 2);
  assert.deepEqual(shape(waves), [['real']]);
  assert.ok(waves.notes?.some((n) => /unknown ref "fn:999"/.test(n)), JSON.stringify(waves.notes));
});

test('un ref sporco di spazi fa comunque centro', () => {
  const waves = planWaves([T('use', ['src/b.js'], [' add ']), T('add', ['src/a.js'])], 2);
  assert.deepEqual(shape(waves), [['add'], ['use']]);
  assert.deepEqual(waves.notes ?? [], []);
});

test('forme storte di `dependsOn` non fanno cadere niente', () => {
  // La sorgente è un modello: stringa singola, oggetti, numeri, `null`. Nessuna di queste deve
  // poter abbattere una run — al massimo l'ordinamento non c'è.
  for (const weird of ['add', 42, {}, [{ ref: 'add' }], [null, undefined], '', 0, false]) {
    const tasks = [{ ...T('use', ['src/b.js']), dependsOn: weird }, T('add', ['src/a.js'])];
    const waves = planWaves(tasks, 2);
    assertNoneLost(waves, ['use', 'add']);
  }
  // …e la stringa singola, che è la forma storta più plausibile, viene comunque onorata.
  const single = planWaves([{ ...T('use', ['src/b.js']), dependsOn: 'add' }, T('add', ['src/a.js'])], 2);
  assert.ok(waveOf(single, 'add') < waveOf(single, 'use'));
});

test('un task senza `ref` non è nominabile, ma non rompe nulla', () => {
  const tasks = [
    { title: 'anonimo', agent: 'quality', kind: 'improvement', files: ['src/a.js'] },
    T('use', ['src/b.js'], ['anonimo']), // nessun ref con quel nome: dipendenza assente
  ];
  const waves = planWaves(tasks, 2);
  assertNoneLost(waves, [undefined, 'use']);
  assert.ok(waves.notes?.some((n) => /unknown ref "anonimo"/.test(n)));
});

test('due task con lo stesso `ref`: la dipendenza va al primo, senza ambiguità silenziose', () => {
  const tasks = [
    T('dup', ['src/a.js']),
    T('dup', ['src/b.js']),
    T('use', ['src/c.js'], ['dup']),
  ];
  const waves = planWaves(tasks, 3);
  assertNoneLost(waves, ['dup', 'dup', 'use']);
  // Il primo `dup` (indice 0) è quello che `use` aspetta: deve stare in un'onda precedente.
  const firstDup = waves.findIndex((w) => w.some((x) => x.index === 0));
  assert.ok(firstDup < waveOf(waves, 'use'));
});

/* ----------------------- nessuna regressione senza dependsOn ---------------------- */

test('senza `dependsOn` il piano è IDENTICO a quello della sola analisi dei file', () => {
  /*
   * La garanzia che rende il meccanismo adottabile: chi non dichiara dipendenze non paga nulla.
   * Si confrontano i piani dello stesso lotto con e senza il campo — a campo assente e a campo
   * vuoto il risultato deve essere lo stesso, e `notes` non deve comparire.
   */
  const lotto = () => [
    T('a', ['src/auth.js']),
    T('b', ['src/auth.js', 'src/user.js']), // collide con `a`
    T('c', ['src/listings.js']),
    T('d', []), // nessun file dichiarato: onda tutta sua
    T('e', ['src/user.js']), // collide con `b`
  ];
  const senza = planWaves(lotto(), 2);
  const vuoto = planWaves(lotto().map((t) => ({ ...t, dependsOn: [] })), 2);

  assert.deepEqual(shape(vuoto), shape(senza));
  assert.equal(senza.notes, undefined, 'un lotto senza dipendenze non deve produrre note');
  assert.equal(vuoto.notes, undefined);
  assertNoneLost(senza, ['a', 'b', 'c', 'd', 'e']);
});

test('le due garanzie di prima restano vere anche con le dipendenze accese', () => {
  /*
   * Il contratto che esisteva prima di `dependsOn`, verificato sulla struttura e non sul
   * confronto con un piano atteso: dentro un'onda nessun file è dichiarato due volte, e un task
   * che non dichiara file gira da solo. Se il cancello delle dipendenze toccasse la collisione,
   * questo test cadrebbe — ed è l'unico errore di questa modifica che corromperebbe un merge.
   */
  const tasks = [
    T('a', ['src/auth.js'], []),
    T('b', ['src/auth.js', 'src/user.js'], ['a']),
    T('c', ['src/listings.js']),
    T('d', [], ['c']),
    T('e', ['src/user.js'], ['c']),
    T('f', ['src/listings.js'], ['a']),
  ];
  const waves = planWaves(tasks, 3);
  assertNoneLost(waves, ['a', 'b', 'c', 'd', 'e', 'f']);
  for (const w of waves) {
    const seen = new Set();
    for (const x of w) {
      assert.ok(x.files.size > 0 || w.length === 1, 'un task senza file dichiarati non gira da solo');
      for (const f of x.files) {
        assert.ok(!seen.has(f), `${f} dichiarato due volte nella stessa onda`);
        seen.add(f);
      }
    }
  }
  // …e l'ordine dichiarato è rispettato in aggiunta, non al posto, della non-collisione.
  assert.ok(waveOf(waves, 'a') < waveOf(waves, 'b'));
  assert.ok(waveOf(waves, 'c') < waveOf(waves, 'd'));
  assert.ok(waveOf(waves, 'c') < waveOf(waves, 'e'));
  assert.ok(waveOf(waves, 'a') < waveOf(waves, 'f'));
});

test('`describeWaves` resta la riga di prima quando non c\'è niente da dire', () => {
  const waves = planWaves([T('a', ['src/a.js']), T('b', ['src/b.js'])], 2);
  const text = describeWaves(waves);
  assert.match(text, /^wave 1: /);
  assert.ok(!/note:/.test(text), text);
});

test('il lotto vuoto e gli ingressi assurdi restano un piano vuoto, non un\'eccezione', () => {
  // Lo scheduler decide un ORDINE: un'eccezione qui costerebbe l'intera iterazione.
  assert.deepEqual(planWaves([], 2), []);
  assert.deepEqual(planWaves(null, 2), []);
  assert.deepEqual(planWaves(undefined), []);
});

test('la larghezza dell\'onda resta un tetto anche con le dipendenze in gioco', () => {
  const tasks = [
    T('a', ['src/a.js']),
    T('b', ['src/b.js']),
    T('c', ['src/c.js']),
    T('d', ['src/d.js'], ['a']),
  ];
  const waves = planWaves(tasks, 2);
  assert.ok(waves.every((w) => w.length <= 2), JSON.stringify(shape(waves)));
  assert.ok(waveOf(waves, 'a') < waveOf(waves, 'd'));
  assertNoneLost(waves, ['a', 'b', 'c', 'd']);
});

test('`.notes` è una proprietà sull\'array: la forma del valore di ritorno non cambia', () => {
  /*
   * Il resoconto viaggia col piano perché è lì che si legge, ma chi consuma le onde non deve
   * accorgersene: `parallelImplementer` fa `waves.length`, `map` e `JSON.stringify`.
   */
  const waves = planWaves([T('A', ['src/a.js'], ['B']), T('B', ['src/b.js'], ['A'])], 2);
  assert.ok(Array.isArray(waves));
  assert.equal(waves.length, 2);
  assert.equal(waves.map((w) => w.length).reduce((n, x) => n + x, 0), 2);
  // Un array serializzato non porta le proprietà non indicizzate: nessun consumatore cambia.
  assert.equal(JSON.parse(JSON.stringify(waves)).length, 2);
});
