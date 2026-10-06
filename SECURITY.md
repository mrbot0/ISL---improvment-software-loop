# Sicurezza

## Che cos'è ISL, dal punto di vista della sicurezza

ISL è un **control plane che esegue codice**. Per funzionare apre worktree git, lancia comandi e
suite di test, chiama un LLM locale, avvia e riavvia container, scrive commit e — se l'autonomia è
abilitata — li promuove. Chi ottiene una sessione autenticata su ISL non "legge una dashboard":
ottiene in pratica **esecuzione di codice sulla macchina che lo ospita**, con i permessi dell'utente
che ha avviato il processo, e accesso in scrittura ai repository configurati.

Tenetelo presente leggendo tutto il resto.

## Non esporlo su una rete pubblica

**ISL è progettato per girare in locale o su una rete di cui vi fidate.** Non è un'applicazione
multi-tenant indurita per Internet, e non va messa su un indirizzo pubblico.

Le due cose da sistemare prima di qualunque altra:

1. **Cambiate `AUTH_SECRET`.** Il valore di default in `.env.example` è
   `isl-dev-secret-change-me`: è pubblico, è in questo repository, ed è il segreto con cui vengono
   firmate le sessioni. Lasciarlo invariato su un'istanza raggiungibile da altri rende la
   protezione delle sessioni priva di valore. Generate un valore casuale e lungo, e non riusatelo
   fra istanze.

2. **Rivendicate l'account amministratore subito.** L'admin seminato (`ADMIN_EMAIL`, default
   `admin@example.com`) non ha una password: il **primo** sign-in con quell'email imposta la
   password e rivendica l'account. Su un'istanza esposta e non ancora rivendicata, il primo
   sconosciuto che la raggiunge diventa amministratore. Fate quel primo accesso prima che il server
   sia raggiungibile da chiunque altro.

Inoltre:

- Legate il processo a `localhost` e, se vi serve accedervi da fuori, mettetelo dietro un reverse
  proxy con TLS e una propria autenticazione, oppure dentro una VPN. Non aprite la porta `7878`
  verso Internet; il WebSocket è gated come le rotte `/api/*`, ma vale lo stesso discorso.
- `.data/` contiene i database di piattaforma e di progetto: utenti, sessioni, audit trail, backlog,
  contenuti e documenti indicizzati dei progetti bersaglio. È in `.gitignore` e non va pubblicato né
  copiato altrove senza pensarci.
- Lo stesso vale per `.env`: contiene `AUTH_SECRET` e i percorsi dei vostri repository.
- Trattate i progetti bersaglio come codice che ISL può modificare: puntatelo su un checkout che
  potete ispezionare e ripristinare, non sull'unica copia di qualcosa.

## Segnalare una vulnerabilità

**Non aprite una issue pubblica per una vulnerabilità.**

Usate il canale privato del repository — **GitHub Security Advisories**:

👉 [Segnala una vulnerabilità in privato](https://github.com/mrbot0/ISL---improvment-software-loop/security/advisories/new)

(Dal repository: tab **Security** → **Report a vulnerability**.) La segnalazione resta visibile solo
a voi e a chi mantiene il progetto, finché non viene pubblicata una advisory.

Non c'è un indirizzo email dedicato: il canale sopra è l'unica via di segnalazione riservata.

Nella segnalazione aiuta avere:

- la versione o il commit di ISL;
- quale componente è coinvolto (auth e sessioni, rotte `/api/*`, WebSocket, sandbox e worktree,
  runtime dei container, dashboard, indice della conoscenza…);
- i passi per riprodurre, e l'impatto che ne deriva;
- se vi è servita una sessione autenticata, e con quale ruolo (`admin`, `user`, `viewer`).

Quello che possiamo dire sui tempi, senza promettere ciò che non possiamo mantenere: ISL è
mantenuto nel tempo libero, non c'è un turno di guardia e **non ci sono tempi di risposta
garantiti**. Le segnalazioni vengono lette e, per quanto possibile, affrontate in ordine di gravità.
Non esiste un programma di bug bounty e non ci sono ricompense.

### Divulgazione

Preferiamo la divulgazione coordinata: segnalate in privato, concordiamo quando pubblicare. Se
preferite pubblicare per vostro conto, è una vostra scelta — chiediamo solo di dircelo, così chi usa
ISL può essere avvisato insieme alla pubblicazione. Il merito della scoperta viene riconosciuto
nell'advisory, se lo desiderate.

## Versioni coperte

Il progetto ha un'unica linea di sviluppo attiva: **l'ultimo commit del branch di default**. Non
esistono branch di manutenzione né backport su versioni precedenti. Una correzione di sicurezza
arriva lì.

## Cosa non è una vulnerabilità

Alcuni comportamenti sono di progetto, e segnalarli come falle non porta a una correzione:

- **Gli agenti eseguono codice.** Il motore di iterazione esegue build, test e comandi del progetto
  bersaglio dentro una sandbox: è il suo lavoro, non un'escalation.
- **Un amministratore può far eseguire codice a ISL.** Il ruolo `admin` configura i progetti e il
  runtime; ha per definizione il potere descritto in cima a questa pagina.
- **L'istanza non è indurita per l'esposizione pubblica.** Un problema che richiede, come premessa,
  che ISL sia stato messo su una rete pubblica contro quanto scritto qui, è documentato — non è una
  segnalazione nuova.

Restano invece segnalazioni utili e benvenute, per esempio: aggirare l'autenticazione o il gate del
WebSocket, salire di ruolo (`viewer` o `user` che ottiene capacità da `admin`), uscire dalla sandbox
verso percorsi che il progetto attivo non comprende, leggere i dati di un progetto da una sessione
che non vi ha accesso, far eseguire comandi tramite contenuti che ISL soltanto *legge* (documenti,
diff, output di un modello), o un segreto che finisce nei log, nelle risposte dell'API o in un
commit.
