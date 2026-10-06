/**
 * L'AGENTE CHE RIPULISCE L'ALBERO DI LAVORO SENZA DISTRUGGERE NIENTE.
 *
 * "working tree dirty" è un semaforo rosso senza istruzioni: dice che qualcosa c'è, non che cosa né
 * cosa farne. La risposta istintiva è `git checkout .` e `git clean -fd`, che in un colpo solo
 * cancella tanto gli scarti di compilazione quanto il lavoro non ancora salvato — e su questo
 * repository quel lavoro è stato, in almeno un'occasione, l'unica copia esistente di correzioni a
 * un difetto in produzione.
 *
 * Quindi questo modulo non "pulisce": CLASSIFICA, e per ogni categoria propone l'unica azione che
 * per quella categoria è sicura. Le regole in ordine di rischio crescente:
 *
 *   artefatto   scarti di build e di strumenti — `nul`, cartelle con i due punti nel nome, output
 *               di bundler finiti nel repo. Nessuno li ha scritti a mano, si rigenerano. Eliminabili.
 *   ingombro    directory non tracciate che contengono un progetto (node_modules, package.json).
 *               MAI eliminate: si propone una riga in .gitignore, perché il problema non è che
 *               esistano, è che git le guardi.
 *   ripristino  file tracciati e cancellati. Git ne ha ancora il contenuto: si può rimettere a posto
 *               con una riga, e questa è l'azione proposta — non "conferma la cancellazione".
 *   formato     modifiche che spariscono ignorando spazi e fine riga. Nessun contenuto cambia.
 *   lavoro      tutto il resto: modifiche vere a sorgenti veri. Nessuna azione automatica. Si
 *               propone di salvarle, mai di buttarle.
 *
 * E il principio che tiene insieme tutto: OGNI AZIONE È RECUPERABILE. Prima di rimuovere o
 * ripristinare qualsiasi cosa si crea una copia (uno stash per il tracciato, una cartella di backup
 * per il non tracciato). Un pulsante "pulisci" che non si può annullare è un pulsante che prima o
 * poi cancella la cosa sbagliata.
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { REPO_ROOT } from '../config.js';
import { log } from '../logger.js';

/*
 * `trim` solo dove è innocuo, MAI sull'output di `status --porcelain`.
 *
 * In quel formato i due caratteri di stato sono posizionali e il primo è uno spazio per tutto ciò
 * che non è nell'indice: ` M file`. Un trim complessivo mangia lo spazio iniziale della PRIMA riga
 * e sposta di un carattere il taglio del percorso — il primo file dell'elenco diventava
 * `ackend/package-lock.json`, che non esiste, quindi ogni azione su di esso sarebbe fallita o,
 * peggio, avrebbe centrato un percorso diverso da quello mostrato all'operatore.
 */
const git = (args, cwd) => execFileSync('git', ['-C', cwd, ...args], {
  encoding: 'utf8',
  maxBuffer: 32 * 1024 * 1024,
});
const gitTrim = (args, cwd) => git(args, cwd).trim();

/** Nomi che nessuno scrive a mano: sono ricadute di uno strumento mal configurato. */
const ARTEFATTI = [
  /(^|\/)nul$/i,              // Windows: `> /dev/null` eseguito dove /dev non esiste
  /(^|\/)NUL$/,
  /:/,                        // un percorso Windows finito dentro un container Linux
  /(^|\/)\.DS_Store$/,
  /(^|\/)Thumbs\.db$/,
  /(^|\/)npm-debug\.log$/,
  /(^|\/)core\.\d+$/,
];

const CATEGORIE = {
  artefatto: { rischio: 0, azione: 'elimina', etichetta: 'Scarto di build o di strumento' },
  formato: { rischio: 0, azione: 'ripristina', etichetta: 'Solo spazi o fine riga' },
  ingombro: { rischio: 1, azione: 'ignora', etichetta: 'Progetto o dipendenze non tracciate' },
  ripristino: { rischio: 2, azione: 'ripristina', etichetta: 'File tracciato cancellato' },
  lavoro: { rischio: 3, azione: 'salva', etichetta: 'Modifiche a sorgenti' },
};

/** Una directory non tracciata che contiene un progetto a sé: pesante, e da non toccare mai. */
function isIngombro(root, rel) {
  const full = path.join(root, rel);
  try {
    if (!fs.statSync(full).isDirectory()) return false;
  } catch { return false; }
  for (const marker of ['node_modules', 'package.json', '.git', 'vendor', 'target']) {
    if (fs.existsSync(path.join(full, marker))) return true;
  }
  return false;
}

/** Byte occupati, per dire all'operatore quanto pesa ciò che sta guardando. */
function pesa(root, rel) {
  const full = path.join(root, rel);
  let total = 0;
  const walk = (p, depth = 0) => {
    if (depth > 6) return;
    let st;
    try { st = fs.statSync(p); } catch { return; }
    if (st.isFile()) { total += st.size; return; }
    if (!st.isDirectory()) return;
    let entries;
    try { entries = fs.readdirSync(p); } catch { return; }
    for (const e of entries.slice(0, 400)) walk(path.join(p, e), depth + 1);
  };
  walk(full);
  return total;
}

/**
 * Guarda l'albero e dice cosa c'è, per categoria. Non modifica nulla.
 *
 * @param {string} [root]  radice del repository; per default il progetto attivo
 */
export function analyseTree(root = REPO_ROOT) {
  let porcelain;
  try {
    porcelain = git(['status', '--porcelain'], root).replace(/\n$/, '');
  } catch (err) {
    return { ok: false, error: `git non risponde in ${root}: ${err.message}`, items: [] };
  }
  if (!porcelain.trim()) return { ok: true, clean: true, items: [], summary: 'albero pulito' };

  const items = [];
  const decoder = new TextDecoder('utf-8');
  for (const riga of porcelain.split('\n')) {
    if (!riga.trim()) continue;
    const stato = riga.slice(0, 2);
    let rel = riga.slice(3).trim();
    /*
     * I nomi non ASCII arrivano fra virgolette con ogni BYTE in ottale. Decodificarli con
     * `String.fromCharCode` uno per uno tratta ciascun byte come un carattere e produce mojibake:
     * il nome mostrato non è quello sul disco, e un'azione su un nome sbagliato non è un errore di
     * visualizzazione, è un'azione sul file sbagliato. Vanno raccolti come byte e decodificati
     * insieme come UTF-8.
     */
    if (rel.startsWith('"') && rel.endsWith('"')) {
      const corpo = rel.slice(1, -1);
      const bytes = [];
      for (let i = 0; i < corpo.length; i++) {
        const m = /^\\([0-7]{3})/.exec(corpo.slice(i));
        if (m) { bytes.push(parseInt(m[1], 8)); i += 3; continue; }
        bytes.push(corpo.charCodeAt(i));
      }
      rel = decoder.decode(new Uint8Array(bytes));
    }

    let categoria;
    if (ARTEFATTI.some((re) => re.test(rel))) categoria = 'artefatto';
    else if (stato.includes('?') && isIngombro(root, rel)) categoria = 'ingombro';
    else if (stato.includes('D')) categoria = 'ripristino';
    else if (stato.includes('?')) categoria = 'artefatto';
    else {
      /*
       * Una modifica che sparisce ignorando spazi e fine riga non cambia il programma.
       *
       * Il confronto DEVE partire da HEAD, non dalla copia di lavoro. `git diff` senza argomenti
       * guarda solo ciò che non è nell'indice: per un file già messo in stage restituisce vuoto, e
       * il vuoto qui significa "nessuna differenza di contenuto". Con quella lettura un file pieno
       * di lavoro appena stagiato veniva classificato come rumore di formattazione e proposto per
       * il ripristino — su questo repository è successo con la risoluzione di un conflitto di
       * merge, cioè esattamente il tipo di modifica che non si può rifare a memoria.
       */
      let soloFormato = false;
      try {
        soloFormato = gitTrim(['diff', 'HEAD', '--ignore-all-space', '--ignore-blank-lines', '--', rel], root) === '';
      } catch { soloFormato = false; }
      categoria = soloFormato ? 'formato' : 'lavoro';
    }

    items.push({
      path: rel,
      stato: stato.trim() || '??',
      categoria,
      ...CATEGORIE[categoria],
      bytes: categoria === 'ingombro' || categoria === 'artefatto' ? pesa(root, rel) : 0,
    });
  }

  const per = (c) => items.filter((i) => i.categoria === c).length;
  return {
    ok: true,
    clean: false,
    root,
    items: items.sort((a, b) => a.rischio - b.rischio),
    conteggi: Object.fromEntries(Object.keys(CATEGORIE).map((c) => [c, per(c)])),
    summary: `${items.length} voci: ${Object.entries(CATEGORIE)
      .map(([c, m]) => (per(c) ? `${per(c)} ${m.etichetta.toLowerCase()}` : null))
      .filter(Boolean).join(', ')}`,
  };
}

/**
 * Esegue le azioni proposte, SOLO per i percorsi che l'operatore ha scelto.
 *
 * Non c'è un "pulisci tutto": la lista dei percorsi arriva da chi ha guardato la classificazione.
 * Prima di toccare qualunque cosa si crea la rete di recupero, e se non si riesce a crearla non si
 * procede — meglio un albero sporco che una modifica persa.
 *
 * @param {string[]} paths      percorsi scelti, così come compaiono in `analyseTree`
 * @param {object}   opts
 * @param {string}   [opts.root]
 * @param {boolean}  [opts.dryRun]  descrive senza eseguire
 */
export function applyCleanup(paths, { root = REPO_ROOT, dryRun = false } = {}) {
  const analisi = analyseTree(root);
  if (!analisi.ok) return analisi;

  const scelti = analisi.items.filter((i) => paths.includes(i.path));
  if (!scelti.length) return { ok: false, error: 'nessuno dei percorsi indicati risulta sporco', done: [] };

  const rifiutati = scelti.filter((i) => i.categoria === 'lavoro');
  if (rifiutati.length) {
    return {
      ok: false,
      error: `${rifiutati.length} file contengono modifiche vere e questo agente non le tocca: `
        + `${rifiutati.slice(0, 3).map((i) => i.path).join(', ')}. Salvale con un commit o uno stash.`,
      done: [],
    };
  }

  if (dryRun) {
    return { ok: true, dryRun: true, done: scelti.map((i) => ({ path: i.path, azione: i.azione })) };
  }

  /*
   * LA RETE PRIMA DEL SALTO.
   *
   * Un backup datato dei non tracciati che stiamo per rimuovere, e uno stash dei tracciati che
   * stiamo per ripristinare. Se una delle due non riesce, ci si ferma: la garanzia di questo modulo
   * è che ogni azione sia annullabile, e senza copia quella garanzia non esiste più.
   */
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backupDir = path.join(root, '.isl-cleanup', stamp);
  const done = [];
  const tracciati = scelti.filter((i) => i.categoria === 'formato' || i.categoria === 'ripristino');
  let stashLabel = null;

  if (tracciati.length) {
    stashLabel = `isl-cleanup-${stamp}`;
    try {
      gitTrim(['stash', 'push', '-m', stashLabel, '--', ...tracciati.map((i) => i.path)], root);
    } catch (err) {
      // Un `stash push` che non trova nulla da salvare non è un fallimento: i file cancellati
      // possono già essere interamente rappresentati dall'indice.
      if (!/No local changes/i.test(err.message)) {
        return { ok: false, error: `copia di sicurezza non riuscita, non tocco niente: ${err.message}`, done: [] };
      }
      stashLabel = null;
    }
    // Lo stash ha già riportato i file allo stato di HEAD: è esattamente il ripristino voluto.
    for (const i of tracciati) done.push({ path: i.path, azione: 'ripristinato', recupero: stashLabel });
  }

  for (const i of scelti.filter((x) => x.categoria === 'artefatto')) {
    const full = path.join(root, i.path);
    const dest = path.join(backupDir, i.path.replace(/[:<>|?*]/g, '_'));
    try {
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.cpSync(full, dest, { recursive: true });
    } catch (err) {
      done.push({ path: i.path, azione: 'saltato', motivo: `copia non riuscita: ${err.message}` });
      continue;
    }
    try {
      fs.rmSync(full, { recursive: true, force: true });
      done.push({ path: i.path, azione: 'eliminato', recupero: path.relative(root, dest) });
    } catch (err) {
      done.push({ path: i.path, azione: 'saltato', motivo: err.message });
    }
  }

  const daIgnorare = scelti.filter((i) => i.categoria === 'ingombro');
  if (daIgnorare.length) {
    // .gitignore, non rimozione: la cartella serve a qualcuno, è solo git che non deve guardarla.
    const gi = path.join(root, '.gitignore');
    const attuale = fs.existsSync(gi) ? fs.readFileSync(gi, 'utf8') : '';
    const nuove = daIgnorare
      .map((i) => (i.path.endsWith('/') ? i.path : `${i.path}/`))
      .filter((r) => !attuale.split('\n').some((l) => l.trim() === r.trim()));
    if (nuove.length) {
      fs.writeFileSync(gi, `${attuale}${attuale.endsWith('\n') || !attuale ? '' : '\n'}\n# aggiunte da ISL — cartelle non tracciate che contengono un progetto\n${nuove.join('\n')}\n`, 'utf8');
    }
    for (const i of daIgnorare) done.push({ path: i.path, azione: 'ignorato in .gitignore' });
  }

  log.info('cleanup', `albero ripulito: ${done.length} voci (recupero in ${stashLabel || path.relative(root, backupDir)})`);
  return {
    ok: true,
    done,
    recupero: {
      stash: stashLabel,
      backup: fs.existsSync(backupDir) ? path.relative(root, backupDir) : null,
      come: stashLabel
        ? `Per annullare il ripristino: git stash pop (cerca "${stashLabel}")`
        : 'I file eliminati sono copiati sotto .isl-cleanup/',
    },
  };
}
