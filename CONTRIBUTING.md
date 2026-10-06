# Contribuire a ISL

ISL non è una libreria: è un **control plane autonomo** che apre worktree, esegue codice, assegna
punteggi a diff e scrive commit. Contribuirci significa quasi sempre toccare qualcosa che decide
automaticamente se una modifica va in commit o va in rollback. Questo documento descrive come si
lavora qui davvero — l'avvio, i test, la dashboard e la convenzione sui gate — non come si lavora
su un progetto generico.

Prima di aprire una PR vale la pena leggere il [README](README.md) per l'architettura e `ISL.md`
per il dettaglio dei singoli sottosistemi.

---

## 1. Ambiente

| Requisito | Perché |
|---|---|
| Node **≥ 22.5** | ISL usa il modulo built-in `node:sqlite`. Su una versione precedente non parte. |
| [Ollama](https://ollama.com) in locale | Tutti gli agenti e i grader LLM passano da qui. Modello di default `qwen3.6:latest`. |
| `ollama pull nomic-embed-text` | Opzionale. Abilita la ricerca vettoriale del knowledge index; senza, l'indice resta lessicale (BM25). |
| Git | Il motore di iterazione crea worktree reali: senza un checkout git non c'è sandbox. |

```bash
npm run setup          # dipendenze backend + dashboard
cp .env.example .env   # poi apri .env e sistema i valori
npm run doctor         # preflight: node, repo, node_modules, Ollama, sandbox
```

`npm run doctor` è il primo comando da eseguire quando qualcosa non va: verifica per davvero le
dipendenze esterne — crea e distrugge una sandbox vera invece di simularla — così scopri subito
cosa manca, non a metà di un run.

---

## 2. Avvio — `supervisor.mjs`, non `src/server.js`

```bash
npm run serve   # = node supervisor.mjs   -> http://localhost:7878
```

**Usa `npm run serve`.** Il supervisore è la parte che tiene su ISL: riavvia il server entro pochi
secondi per qualunque uscita, ha un guard anti crash-loop con backoff, e tratta l'uscita pulita del
memory watchdog (codice 0, emessa prima dell'OOM) come un riavvio normale. Lo stato desiderato del
loop è persistito, quindi il loop riprende da solo sul processo nuovo.

`npm start` lancia `src/server.js` direttamente, **senza** riavvio automatico. Serve solo quando
vuoi che un crash resti in piedi invece di essere riassorbito — cioè quando stai debuggando il
crash stesso. Non è il modo in cui ISL va eseguito.

Per il lavoro sul backend:

```bash
npm run dev     # node --watch src/server.js
```

Al primo accesso: email `ADMIN_EMAIL` (default `admin@example.com`) e una password qualsiasi di
almeno 8 caratteri — il primo sign-in *imposta* quella password e rivendica l'account.

---

## 3. La dashboard si ricostruisce a parte

La dashboard è un'applicazione separata in `dashboard/` (React + Vite + Tailwind). Il backend serve
`dashboard/dist`, e **`dashboard/dist/` è in `.gitignore`**: nel repository non c'è nessun build. Il
bundle che vedi nel browser è quello che hai prodotto tu.

```bash
npm run dashboard:build   # ricostruisce dashboard/dist — il backend serve questo
```

Conseguenza pratica, ed è la causa più comune di «ho modificato il file e non cambia niente»:
**ogni modifica sotto `dashboard/src/` richiede una ricostruzione.** Riavviare il backend non
ricostruisce la dashboard.

In sviluppo conviene invece il dev server con hot-reload, che fa da proxy verso l'API:

```bash
npm run serve       # backend su :7878
npm run dashboard   # vite su :5273  <- apri questo
```

---

## 4. Test

```bash
npm test                        # backend — node:test su test/*.test.js
cd dashboard && npx vitest run  # dashboard — vitest + testing-library
npm run test:all                # entrambi
npm run check:routes            # ogni endpoint chiamato dalla dashboard esiste sul server?
```

`npm run check:routes` riporta due direzioni. `MISSING`: la dashboard chiama una rotta che il server
non serve — è sempre un difetto, e insidioso, perché il percorso d'errore del client rende uno stato
vuoto e sembra «non ci sono dati» invece di un bug. `UNUSED`: il server serve qualcosa che nessuna
chiamata raggiunge — spesso legittimo, ci sono rotte per gli agenti e per il layer chat, quindi
viene riportato e non fa fallire il check.

Due test non sono unit test ordinari ma **guard strutturali**, ed esistono entrambi perché il guasto
che intercettano era già andato in produzione. Se li tocchi, parti da qui:

- `dashboard/src/undefined-refs.test.js` — non c'è linter configurato e Vite compila JSX senza
  risolvere gli identificatori, quindi un componente o un hook usato ma mai importato *builda* e
  lancia solo quando un utente apre quella pagina. È successo tre volte.
- `test/composeSafety.test.js` — legge il sorgente di `src/runtime/compose.js` e fallisce se un
  comando compose porta `-v` o `--volumes`. Quel flag cancella il volume del database e, a
  differenza di tutto il resto di ciò che il runtime può fare, non ha undo.

Un test che legge il sorgente invece di eseguirlo è una scelta deliberata: su una regola di questo
tipo l'unica verifica affidabile è vietare la stringa.

---

## 5. La convenzione sui gate deterministici

I grader LLM assegnano punteggi. I **gate** vietano. Sono due cose diverse, e la differenza è il
cuore del progetto: la media pesata dei punteggi è già stata battuta dall'aritmetica. Un review a 55
su una modifica che cancellava la personalizzazione della ricerca è stato scavalcato perché review
pesa 0.2 e il totale arrivava comunque sopra la soglia di rollback. Da qui la regola: **ciò che deve
fermare una modifica non può essere un addendo in una media.**

Un gate vive in `src/iteration/` (`intentGate.js`, `schemaGuard.js`, `safetyGate.js`,
`securityGate.js`, `scopeGate.js`, `conflictGate.js`, `behaviourGate.js`, …) ed è cablato in
`src/iteration/engine.js`. Se ne scrivi uno nuovo, seguono cinque regole.

**1. Nessun LLM.** Un gate è deterministico: stesso diff, stesso verdetto, sempre. Prende il task
e/o il diff e ritorna una forma `{ veto, summary, findings }` (o `violations`). Niente chiamate a
modelli, niente euristiche che dipendono dal campionamento.

**2. Un gate nasce da un guasto reale, e il file lo racconta.** Ogni gate esistente apre con un
commento che nomina il run concreto che l'ha motivato e il danno che ha prodotto: `schemaGuard.js`
racconta il run #91, il campo aggiunto a un model senza migration e i 500 arrivati settimane dopo;
`intentGate.js` racconta il run #426 e la barra di ricerca che è sparita. Non è decorazione: è ciò
che impedisce di ammorbidire la regola fra sei mesi senza sapere cosa si sta riaprendo. Se non sai
indicare la modifica che è passata e non doveva passare, probabilmente non ti serve un gate.

**3. Due test, non uno.** In `test/` metti il diff che ha rotto le cose come fixture e asserisci il
veto — e poi asserisci che la regola **non** scatta sulla versione legittima della stessa
operazione. Vedi `test/intentGate.test.js`: la cancellazione mascherata da fix è vietata, la
cancellazione che il task chiedeva esplicitamente passa. Un gate che produce falsi positivi viene
spento, ed è peggio di un gate che non esiste.

**4. Resta stretta.** La regola copre ciò che può dimostrare, non ciò che sospetta. `schemaGuard`
tratta i campi *aggiunti* senza migration e ignora deliberatamente quelli rimossi: è un'operazione
diversa, di solito voluta, e Prisma tollera una tabella con colonne che il model non nomina.

**5. Modalità, e si entra in `advisory`.** Le modalità sono `off` / `advisory` / `enforce`, lette
dalle impostazioni del progetto attivo con `getSetting` (per esempio `scopeGate.mode`, default
`advisory`), non da variabili d'ambiente — così si cambiano a runtime dalla dashboard e per singolo
progetto. Un gate nuovo atterra in `advisory`: prima lo guardi registrare quello che registrerebbe
su run reali, poi lo porti a `enforce`.

---

## 6. Convenzioni di codice e di PR

- **ESM puro** (`"type": "module"`), Node nativo. Le dipendenze sono poche e deliberate: prima di
  aggiungerne una, verifica che non si risolva con la standard library.
- **Nessun valore del progetto bersaglio letto a boot time.** Tutto ciò che riguarda il codice da
  migliorare passa dalle live bindings di `src/config.js` e dall'handle DB swappabile di `src/db.js`,
  perché il progetto attivo cambia a runtime. Una costante catturata all'import rompe il
  multi-project in modo silenzioso.
- **Commenti**: italiano e inglese convivono nel codebase. Scrivi nella lingua del file che stai
  modificando, e tieni in inglese i termini tecnici. Quello che conta è che il commento spieghi
  *perché*: il codice dice già *cosa* fa.
- **Un commit, una ragione.** Il messaggio dice perché, non quali righe sono cambiate.
- **Non committare**: `.env`, `.data/`, `dashboard/dist/`, i database SQLite locali. Sono già in
  `.gitignore`; se ti serve nel repository qualcosa che è escluso, non togliere la riga dal
  `.gitignore` senza prima verificare che non contenga segreti o dati di un progetto reale.
- Prima di aprire la PR: `npm run test:all` e `npm run check:routes` verdi, e il
  [template di PR](.github/pull_request_template.md) compilato.

---

## 7. Prima di una modifica non banale

Apri una issue e descrivi cosa vuoi cambiare. ISL prende decisioni autonome su codice altrui: una
modifica a un gate, al motore di iterazione o alla promozione cambia *cosa viene committato senza
supervisione umana*, e vale la pena discuterla prima di scriverla.

Questo è un progetto mantenuto nel tempo libero: non ci sono tempi di risposta garantiti su issue e
PR. Se una proposta resta ferma non è un giudizio — e un fork è un esito perfettamente legittimo,
l'AGPL è lì anche per questo.

## Licenza dei contributi

ISL è distribuito sotto **AGPL-3.0-only** (vedi [LICENSE](LICENSE)). Aprendo una PR accetti che il
tuo contributo sia distribuito con la stessa licenza.

Nelle interazioni sul repository vale il [Codice di Condotta](CODE_OF_CONDUCT.md). Per le
vulnerabilità **non** usare le issue pubbliche: vedi [SECURITY.md](SECURITY.md).
