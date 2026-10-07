import { test } from 'node:test';
import assert from 'node:assert/strict';
import { planWaves, taskPriority, describeWaves, parallelism } from '../src/core/scheduler.js';

/*
 * Lo scheduler decide DUE cose insieme, e una delle due non e' negoziabile.
 *
 * Puo' sbagliare l'ordine: costa un'onda in piu', o il lavoro importante fatto piu' tardi.
 * Non puo' sbagliare le collisioni: due task nella stessa onda che toccano lo stesso file
 * girano in sandbox separate e si sovrascrivono a vicenda al rientro, in silenzio. Qui si
 * fissano entrambe, nell'ordine in cui contano.
 */

const task = (over = {}) => ({ kind: 'improvement', title: over.agent || 'task', ...over });

/**
 * I file dichiarati da un task, normalizzati come fa lo scheduler — deduplicati, perche' un
 * piano puo' nominare lo stesso file due volte e un task non collide con se stesso.
 */
const filesOf = (t) => [
  ...new Set(
    (Array.isArray(t?.files) ? t.files : []).map((f) => String(f).replace(/\\/g, '/').replace(/^\.?\//, '')).filter(Boolean),
  ),
];

/** L'indice d'onda di ogni task del piano, per indice di piano. */
function waveIndexByTask(waves) {
  const at = new Map();
  waves.forEach((w, i) => w.forEach((x) => at.set(x.index, i)));
  return at;
}

/** LA garanzia: nessuna onda contiene due task che dichiarano uno stesso file. */
function assertNoCollisions(waves, label) {
  for (const [i, wave] of waves.entries()) {
    const claimed = new Map();
    for (const item of wave) {
      for (const f of filesOf(item.task)) {
        assert.equal(
          claimed.has(f),
          false,
          `${label}: wave ${i + 1} mette "${item.task.title}" e "${claimed.get(f)}" insieme, entrambi su ${f}`,
        );
        claimed.set(f, item.task.title);
      }
    }
  }
}

/** Ogni task pianificato esiste in esattamente un'onda. */
function assertEveryTaskPlacedOnce(waves, tasks, label) {
  const seen = waves.flat().map((x) => x.index).sort((a, b) => a - b);
  assert.deepEqual(seen, tasks.map((_, i) => i), `${label}: qualche task e' stato perso o duplicato`);
}

/* ------------------------- 1. l'importanza entra in gioco ------------------- */

test("il lavoro critico apre il piano invece di aspettare dietro a quello cosmetico", () => {
  // Il caso che ha motivato il riordino: in ordine di piano la falla di sicurezza era terza,
  // e un'iterazione interrotta prima non la eseguiva mai.
  const tasks = [
    task({ agent: 'docs', files: ['docs/setup.md'] }),
    task({ agent: 'ux', files: ['ui/Button.jsx'] }),
    task({ agent: 'security', files: ['src/auth.js'], title: 'patch the token check' }),
  ];

  const waves = planWaves(tasks, 1); // serial: l'ordine e' tutto cio' che resta da decidere
  assert.equal(waves[0][0].task.agent, 'security', describeWaves(waves));
  assert.equal(parallelism(waves).leadsWithTop, true);
});

test("una priorita' dichiarata dal piano vince sul peso dedotto dallo specialista", () => {
  // Chi scrive una priorita' a mano sa qualcosa che lo specialista non dice: il valore
  // dichiarato si usa com'e', e il peso dell'agente non lo corregge.
  assert.ok(taskPriority({ agent: 'docs' }) < 30, 'docs non dichiarato deve pesare poco');
  assert.equal(taskPriority({ agent: 'docs', priority: 99 }), 99);

  // E decide davvero l'ordine: un task da `docs` dichiarato a 99 passa davanti a `compliance`,
  // che senza dichiarazione lo surclasserebbe.
  const waves = planWaves(
    [task({ agent: 'compliance', files: ['a.js'] }), task({ agent: 'docs', priority: 99, files: ['b.js'] })],
    1,
  );
  assert.equal(waves[0][0].task.agent, 'docs', describeWaves(waves));
});

/* ---------------- 2. la correttezza viene PRIMA dell'ordine ----------------- */

test("task che collidono sui file non finiscono nella stessa onda, quale che sia la priorita'", () => {
  // Tre task di altissima priorita' che vogliono tutti lo stesso file. L'ordinamento li
  // vorrebbe tutti davanti; il cancello delle collisioni li costringe in onde diverse.
  const tasks = [
    task({ agent: 'security', files: ['src/auth.js'], title: 'rate limit' }),
    task({ agent: 'compliance', files: ['src/auth.js'], title: 'audit log' }),
    task({ agent: 'resilience', files: ['src/auth.js'], title: 'retry' }),
    task({ agent: 'docs', files: ['docs/x.md'], title: 'readme' }),
  ];

  const waves = planWaves(tasks, 3);
  assertNoCollisions(waves, 'collisione su un solo file');
  assertEveryTaskPlacedOnce(waves, tasks, 'collisione su un solo file');
  assert.equal(waves.length, 3, describeWaves(waves));
});

test("una priorita' altissima non compra un posto in un'onda occupata dallo stesso file", () => {
  // Il punteggio non e' un peso che si possa sommare fino a superare il cancello.
  const tasks = [
    task({ agent: 'quality', files: ['src/core.js'] }),
    task({ agent: 'security', priority: 100, files: ['src/core.js', 'src/new.js'] }),
  ];
  const waves = planWaves(tasks, 4);
  assert.equal(waves.length, 2);
  assertNoCollisions(waves, 'nessun acquisto di posto');
});

/* ------------- 3. nessun task resta indietro per sempre (slip limitato) ----- */

test("il lavoro meno importante non puo' slittare oltre maxSlip onde", () => {
  /*
   * Senza un limite, questo e' esattamente il caso che affama: un task da `docs` davanti a
   * dieci task di sicurezza. Il solo ordine per importanza lo manderebbe in ultima onda, e
   * se il piano lo ripropone identico ad ogni iterazione non verrebbe eseguito MAI.
   */
  const tasks = [
    task({ agent: 'docs', files: ['docs/intro.md'], title: 'il task affamato' }),
    ...Array.from({ length: 10 }, (_, i) => task({ agent: 'security', files: [`src/s${i}.js`], title: `sec ${i}` })),
  ];

  const plan = planWaves(tasks, 1, { maxSlip: 2 });
  const at = waveIndexByTask(plan);

  // In ordine di piano era l'onda 0; la tolleranza e' 2; quindi al piu' l'onda di indice 2.
  const baseline = waveIndexByTask(planWaves(tasks, 1, { maxSlip: 0 }));
  assert.equal(baseline.get(0), 0);
  assert.ok(
    at.get(0) <= baseline.get(0) + 2,
    `il task affamato e' finito nell'onda ${at.get(0) + 1} di ${plan.length}:\n${describeWaves(plan)}`,
  );
  // E l'importanza ha comunque fatto il suo lavoro: non e' rimasto primo.
  assert.ok(at.get(0) > 0, 'la sicurezza avrebbe dovuto passargli davanti');
  assert.equal(plan[0][0].task.agent, 'security');
});

test('maxSlip 0 riproduce esattamente il piano in ordine di piano', () => {
  // Il ripiego e il metro sono la stessa cosa, e deve restare cio' che era prima del riordino.
  const tasks = [
    task({ agent: 'docs', files: ['docs/a.md'] }),
    task({ agent: 'security', files: ['src/auth.js'] }),
    task({ agent: 'quality', files: ['docs/a.md'] }),
  ];
  const waves = planWaves(tasks, 2, { maxSlip: 0 });
  assert.deepEqual(waves.map((w) => w.map((x) => x.index)), [[0, 1], [2]], describeWaves(waves));
});

/* ---------- 4. le due garanzie insieme, su molte forme di lotto ------------- */

test('su centinaia di lotti generati: nessuna collisione, nessuno slittamento oltre il limite', () => {
  /*
   * Un controllo a mano copre le forme a cui si e' pensato. Queste sono le altre: pochi file
   * condivisi fra molti task, cioe' il regime in cui le collisioni sono la norma e non
   * l'eccezione. Generatore deterministico — un fallimento qui si riproduce.
   */
  const AGENTS = ['security', 'docs', 'ux', 'quality', 'tests', 'performance', 'refactor', 'compliance'];
  const POOL = ['a.js', 'b.js', 'c.js', 'd.js', 'e.js'];
  let seed = 7;
  const rnd = (n) => ((seed = (seed * 48271) % 2147483647) % n);

  for (let batch = 0; batch < 200; batch++) {
    const tasks = Array.from({ length: 1 + rnd(7) }, (_, i) => {
      const nFiles = rnd(4) === 0 ? 0 : 1 + rnd(2); // un task su quattro senza file dichiarati
      const files = Array.from({ length: nFiles }, () => POOL[rnd(POOL.length)]);
      return task({
        agent: AGENTS[rnd(AGENTS.length)],
        kind: rnd(2) ? 'improvement' : 'feature',
        files,
        title: `t${i}`,
      });
    });

    for (const width of [1, 2, 3]) {
      const reference = waveIndexByTask(planWaves(tasks, width, { maxSlip: 0 }));

      for (const maxSlip of [0, 1, 2, 3]) {
        const label = `batch ${batch} width ${width} slip ${maxSlip}`;
        const waves = planWaves(tasks, width, { maxSlip });

        assertNoCollisions(waves, label);
        assertEveryTaskPlacedOnce(waves, tasks, label);

        for (const wave of waves) {
          assert.ok(wave.length <= width, `${label}: un'onda larga ${wave.length} oltre il cap ${width}`);
          // Un task senza file dichiarati ha raggio d'azione ignoto: gira da solo.
          if (wave.length > 1) {
            for (const item of wave) {
              assert.ok(filesOf(item.task).length > 0, `${label}: un task senza file ha un compagno d'onda`);
            }
          }
        }

        const at = waveIndexByTask(waves);
        for (const [index, w] of at) {
          assert.ok(
            w <= reference.get(index) + maxSlip,
            `${label}: il task ${index} slitta da ${reference.get(index)} a ${w}, oltre il limite di ${maxSlip}`,
          );
        }
      }
    }
  }
});

/* --------------- 5. un ordinamento non puo' abbattere una run -------------- */

test('un piano malformato non fa lanciare lo scheduler', () => {
  // Il piano arriva da un modello: un campo mancante o del tipo sbagliato e' un caso vivo,
  // e un'eccezione qui costerebbe l'iterazione intera per una questione di ordine.
  assert.deepEqual(planWaves([]), []);
  assert.deepEqual(planWaves(null), []);
  assert.deepEqual(planWaves(undefined), []);

  const junk = [null, {}, { files: 'src/a.js' }, { agent: 42, kind: {}, files: ['src/a.js'] }, { priority: 'alta', files: [null, ''] }];
  const waves = planWaves(junk, 2);
  assertEveryTaskPlacedOnce(waves, junk, 'piano malformato');
  assert.equal(typeof describeWaves(waves), 'string');
  assert.equal(parallelism(waves).tasks, junk.length);

  // Anche le opzioni arrivano da una configurazione, e possono essere sciocchezze.
  for (const maxSlip of [-1, NaN, 'due', null, Infinity]) {
    assert.equal(planWaves(junk, 2, { maxSlip }).flat().length, junk.length);
  }
  assert.equal(planWaves([task({ agent: 'quality', files: ['a.js'] })], 0).length, 1);
});

test('il resoconto nomina specialista e punteggio, non solo il titolo', () => {
  // Senza di questi, nel log un ordinamento giusto e uno sbagliato si leggono uguali.
  const waves = planWaves([task({ agent: 'security', files: ['src/auth.js'], title: 'patch token check' })], 2);
  assert.match(describeWaves(waves), /patch token check \[security p100\]/);
});
