# ISL — Improvement Software Loop

**Un sistema autonomo che migliora codice altrui e si rifiuta di rompere ciò che tocca.**

Gli punti una cartella di codice — qualsiasi linguaggio, qualsiasi struttura — e ISL la legge,
decide cosa vale la pena cambiare, scrive la modifica in una sandbox isolata, la sottopone a una
batteria di controlli, e la fa atterrare **solo se li supera tutti**. Il tuo ramo principale e il
tuo albero di lavoro non vengono toccati fino a quel momento.

Versione **2.0.0** · Node ≥ 22.5 · sette dipendenze in produzione (`express`, `ws`, `cors`,
`dotenv`, `diff`, `pdf-parse`, `mammoth`) · SQLite nativo, nessun ORM.

---

## Il problema che risolve

Un modello linguistico sa scrivere una modifica plausibile. Non sa se funziona.

La differenza fra un assistente che suggerisce e un sistema che si può lasciare acceso sta tutta
qui: cosa succede quando la modifica è sbagliata **e sembra giusta**. ISL è costruito attorno a
quella domanda. Ogni controllo descritto sotto esiste perché un difetto preciso è passato, è
arrivato agli utenti, ed è stato ricostruito a ritroso.

Alcuni esempi, tutti reali e documentati nel codice:

| Cosa è passato | Perché nessuno l'ha fermato |
|---|---|
| Un file che non compila | il review pesa 0.2 → il totale restava ~80 su una soglia di 60 |
| Una suite interamente rossa | i test pesano 0.15 → totale 83 |
| Una barra di ricerca resa inutilizzabile | il reviewer le diede **95 su 100** |
| Un campo aggiunto a uno schema senza migrazione | compila, i test passano, il servizio si avvia |

Da lì discende il principio che regge tutto: **il giudizio di un modello non è una garanzia.** Dove
una verifica può essere meccanica, è meccanica.

---

## Come funziona una iterazione

Dieci fasi, in sequenza, dentro un worktree git separato:

```
catalog → survey → plan → implement → review → security → regression → test → workbench → finalize
```

**`catalog`** cataloga il codice reale: file, funzioni, complessità, punti caldi.
**`survey`** cerca lavoro che valga la pena fare partendo da prove — TODO reali a righe reali,
`catch` vuoti, file senza test, giunzioni fra servizi senza timeout.
**`plan`** trasforma le prove in task piccoli e verificabili, ognuno con i file che tocca dichiarati.
**`implement`** esegue i task (vedi *Lavorare in parallelo*).
**`review` · `security` · `regression` · `test`** giudicano il risultato da quattro angoli diversi.
**`workbench`** è la fase che si guadagna il posto: **avvia davvero l'applicazione** e rifiuta la
modifica se non parte più — il guasto che ogni test unitario del mondo supera indenne.
**`finalize`** decide: commit o annullamento.

### I cancelli

Alla fine la modifica incontra **undici veto deterministici**. Nessuno chiede un parere a un modello:

`parse` (il file non compila) · `test` (ha rotto una suite che prima passava) · `regression` (ha
rimosso qualcosa di pubblico) · `security` · `scope` (un identificatore usato e legato da nessuna
parte) · `conflict` (marcatori di merge non risolti) · `schema` (campo senza migrazione) · `intent`
(il diff non corrisponde al titolo del task) · `behaviour` · `dead-code` · `coverage`.

Accanto a loro, **le soglie minime per dimensione**. Una media pesata risponde a *«quanto è buono nel
complesso»*; committare è un'altra domanda: *«c'è qualcosa che da solo squalifica»*. Una media
diluisce per costruzione — è il motivo per cui un file non compilabile totalizzava 80. Una dimensione
sotto la sua soglia squalifica la modifica qualunque sia il totale, e le soglie si configurano senza
toccare il codice.

---

## Gli agenti

Tredici specialisti. Non sono processi separati: sono **le persone che l'implementer indossa** in
base al task, ognuno con il proprio obiettivo, il proprio ambito di file e la propria inclinazione
alla severità.

| Agente | Che cosa cerca |
|---|---|
| 🛡️ **Security Auditor** | Falle di autorizzazione, injection, input non validato, dati esposti |
| 🧪 **Test Engineer** | Copertura sui rami non testati, soprattutto errori e casi limite |
| ⚡ **Performance Engineer** | Query N+1, indici mancanti, fetch illimitati, render inutili |
| 🧹 **Code Quality** | Duplicazione, codice morto, gestione degli errori, nomi |
| ♿ **Frontend / A11y** | Accessibilità: nomi, raggiungibilità da tastiera, focus, contrasto |
| 🔗 **Services / Integration** | Le giunzioni fra servizi: contratti, timeout, retry, comportamento in guasto |
| 🔧 **Workbench** | Che l'applicazione si avvii, serva e compili — non che passi i test |
| 🛟 **Resilience Engineer** | Timeout, retry, idempotenza, degradazione controllata |
| 📋 **Compliance Engineer** | Violazioni delle buone pratiche, per linguaggio |
| 📚 **Documentation Engineer** | Documentazione che ha smesso di corrispondere al codice |
| 🏗️ **Infrastructure Engineer** | IaC, container e CI allineati al codice |
| 🧱 **Refactoring Engineer** | Confini fra moduli, logica condivisa, accoppiamento |
| 🎨 **UX Engineer** | Usabilità, coerenza, stati di caricamento e vuoti |

A ognuno arrivano nel prompt: il profilo del progetto, le regole che non deve violare, i rischi già
registrati su quell'area, e **le regole permanenti** — lezioni ricavate da difetti che hanno
raggiunto gli utenti attraversando una pipeline interamente verde.

### Lavorare in parallelo senza pestarsi i piedi

I task che non dichiarano file in comune vengono raggruppati in **onde** ed eseguiti insieme, ognuno
nel proprio worktree. Ma l'assenza di collisioni sui file non basta: A può cambiare la firma di una
funzione in `a.js` mentre B la chiama da `b.js` — nessuna collisione, ognuno passa i propri
controlli, la combinazione è rotta.

Per questo, fra un'onda e l'altra:

- gli agenti ricevono **cosa è realmente cambiato** — quali export sono comparsi, spariti o hanno
  cambiato firma — non solo i titoli dei task altrui;
- i gate deterministici girano sull'accumulatore e il difetto viene **attribuito all'onda che lo ha
  introdotto**: il fallimento dice *«introdotto nell'onda 2 dal task 3»*, non *«iterazione
  annullata»*;
- dove l'analisi non sa guardare lo **dichiara** invece di tacere. Un elenco vuoto accanto a un file
  cambiato si legge come «non è cambiato niente», che è la conclusione opposta a quella vera.

---

## Gli agent manager

Tredici supervisori che osservano il sistema mentre lavora. Non scrivono codice: tengono d'occhio
una dimensione ciascuno, si avvisano a vicenda, e ciò che trovano arriva agli agenti.

| Manager | Dominio |
|---|---|
| **Quality** | Verifica, review e qualità delle iterazioni |
| **Throughput** | Velocità e costo della flotta |
| **Risk** | Gravità ed esposizione di sicurezza |
| **Insights** | Quali agenti sono efficaci, dove si concentra il lavoro |
| **Operations** | Salute del runtime e controllo |
| **Services** | Integrazione fra servizi e contratti |
| **Workbench** | Esecuzione locale e salute dell'avvio |
| **Implementation** | Pipeline di iterazione e flusso del backlog |
| **Director** | Task critici e smistamento |
| **Compliance** | Conformità alle buone pratiche, su tutti i linguaggi |
| **Context** | Contesto del progetto e documentazione |
| **Deployment** | Strategia di rilascio e deriva dell'infrastruttura |
| **Reliability** | Errori degli agenti, anomalie, auto-miglioramento |

### Come comunicano

Tre canali, ognuno con una ragione precisa.

**Verso gli agenti.** Quando un manager trova qualcosa finisce in memoria condivisa, indicizzata per
area, e da lì nei prompt di planner, implementer e graders. Un rischio su un'area raggiunge chi
lavora su quell'area.

**Fra manager.** Ognuno ha una posta in arrivo: i messaggi dei pari arrivano con il loro contenuto,
non come semplice notifica. L'iscrizione sta nella classe base, non nelle singole sottoclassi — un
canale che ogni manager deve ricordarsi di collegare è un canale che metà non collega.

**Il contesto che cambia il significato.** Quando un manager va in allarme, il suo brief porta con sé
cosa stanno segnalando gli altri. *«I test falliscono»* vuol dire una cosa diversa quando Workbench
sta dicendo che l'applicazione non si avvia affatto: nel secondo caso nei test non c'è niente da
riparare.

---

## Multi-progetto

Un registro dei progetti in `platform.db`. **Ogni progetto ha il proprio database** sotto
`.data/projects/<id>/`, con la propria struttura rilevata (radice, ramo base, cartelle di prodotto)
e i propri agenti. Si cambia progetto attivo dalla dashboard, senza riavviare.

Nessun nome di prodotto è cablato nei prompt: ciò che il sistema sa di un progetto lo ha letto da
quel progetto.

---

## La dashboard

React + Vite dietro login. Le run in corso e passate, il backlog, le proposte da approvare, lo stato
di agenti e manager, i servizi e i container, lo schema del database, la memoria della flotta.

Da qui si avvia e si ferma il loop, si promuovono i commit, si ripara l'albero di lavoro sporco — e
si **spegne ISL del tutto**: il server esce con un codice che il supervisore riconosce come arresto
voluto ed esce a sua volta, invece di riavviarlo.

---

## Requisiti

- **Node ≥ 22.5** (usa `node:sqlite`, il modulo nativo)
- Un modello locale servito da **Ollama**, o un endpoint compatibile
- Git

## Avvio

```bash
npm install
cp .env.example .env     # imposta DEFAULT_PROJECT_PATH e AUTH_SECRET
npm --prefix dashboard install && npm --prefix dashboard run build
node supervisor.mjs
```

Poi apri `http://localhost:7878`.

Avvia **sempre `supervisor.mjs`**, mai `src/server.js` direttamente: il supervisore alza lo heap e
riavvia il server entro pochi secondi dopo un crash o un esaurimento di memoria. L'unica uscita che
non viene riavviata è l'arresto richiesto dall'operatore.

Le modifiche alla dashboard richiedono `npm --prefix dashboard run build`: viene servita da `dist`.

## Configurazione

Le chiavi stanno in `.env.example`, commentate. Le due che contano:

- **`DEFAULT_PROJECT_PATH`** — la cartella del codice da migliorare. Senza, ISL parte su sé stesso.
- **`AUTH_SECRET`** — il valore predefinito è un segnaposto. Su qualunque macchina raggiungibile da
  altri va cambiato: è l'unica cosa che protegge un piano di controllo che esegue codice e scrive
  commit.

ISL **non va esposto su una rete pubblica**. Vedi [SECURITY.md](SECURITY.md).

## Test

```bash
npm test                      # 254 test, test runner di Node, nessuna dipendenza
npm --prefix dashboard test   # 356 test, Vitest
```

Alcuni meritano una menzione, perché non verificano funzioni ma **proprietà che si perderebbero
senza far fallire niente**:

- `scopeGate.test.js` — la forma esatta che rese inutilizzabile una barra di ricerca in produzione
  con un punteggio di review di 95 su 100
- `composeSafety.test.js` — legge il sorgente e fallisce se un comando compose porta `-v`. Quel flag
  cancella il volume del database e, a differenza di tutto il resto, non ha un annullamento
- `standingRules.test.js` — che le regole permanenti restino generiche: prende il nome del progetto
  attivo dalla configurazione, quindi vale per qualunque prodotto ISL stia governando
- `floorBreaches.test.js` — che una dimensione **non misurata** non venga scambiata per bocciata:
  una fase saltata non deve annullare una run

## Contribuire

[CONTRIBUTING.md](CONTRIBUTING.md) · [SECURITY.md](SECURITY.md) ·
[CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md)

## Licenza

**GNU Affero General Public License v3.0** — testo completo in [LICENSE](LICENSE).

Sei libero di usare, studiare, modificare e ridistribuire ISL. Se lo modifichi e lo rendi
disponibile ad altri — anche solo facendolo girare come servizio raggiungibile in rete, senza
distribuirne una copia — devi offrire a chi lo usa il sorgente della tua versione. È la clausola che
distingue l'AGPL dalla GPL (sezione 13), ed è deliberata: ISL è un piano di controllo che si usa
attraverso un'interfaccia web, e senza quella clausola chiunque potrebbe offrirlo come servizio
chiuso senza restituire nulla.

    ISL — Improvement Software Loop
    Copyright (C) 2026  mrbot0

    This program is free software: you can redistribute it and/or modify it under the terms of
    the GNU Affero General Public License as published by the Free Software Foundation, either
    version 3 of the License, or (at your option) any later version.

    This program is distributed in the hope that it will be useful, but WITHOUT ANY WARRANTY;
    without even the implied warranty of MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.
    See the GNU Affero General Public License for more details.

    You should have received a copy of the GNU Affero General Public License along with this
    program. If not, see <https://www.gnu.org/licenses/>.
