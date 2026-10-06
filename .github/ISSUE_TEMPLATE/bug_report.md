---
name: Segnalazione di un difetto
about: Qualcosa in ISL non si comporta come dovrebbe
title: ''
labels: bug
---

<!--
  Per una VULNERABILITA' non usare questo template e non aprire una issue pubblica:
  vedi SECURITY.md (GitHub Security Advisories, canale privato).
-->

## Cosa è andato storto

<!-- Cosa ti aspettavi e cosa è successo invece. Una o due frasi bastano. -->

## Progetto attivo

- Nome del progetto attivo quando è accaduto:
- Stack del progetto bersaglio (linguaggi, framework, Prisma sì/no, Docker sì/no):
- È il progetto `isl-self` (ISL che migliora se stesso)? sì / no

<!--
  Quasi tutto in ISL dipende dal progetto attivo: config, database, agenti, layout rilevato.
  Lo stesso bug spesso esiste su un progetto e non sull'altro.
-->

## Run o iterazione

- Numero del run / dell'iterazione (tab **Runs** o **Iterations**):
- Verdetto: committed / rolled back / interrotto / mai partito
- Punteggi, se li vedi (review, tests, security, regression, totale):
- Qualche gate ha messo un veto? quale, e in che modalità (`off` / `advisory` / `enforce`):

## Dove

<!-- Barra ciò che vale. -->

- [ ] Dashboard (quale tab: ……)
- [ ] API / WebSocket (quale rotta: ……)
- [ ] Autenticazione, sessioni, admin panel
- [ ] Un agente o un manager (quale: ……)
- [ ] Motore di iterazione, sandbox, worktree
- [ ] Un gate deterministico (quale: ……)
- [ ] Runtime dei container / schema integrity
- [ ] Context Manager, doc agents, knowledge index
- [ ] Supervisore / avvio / memoria
- [ ] Altro: ……

## Cosa dicono i log

<!--
  Dove guardare:
  - tab Logs della dashboard, oppure GET /api/logs?level=error — è il log persistito di ISL
  - tab Flow: la cronologia degli eventi del run (ora è persistita, sopravvive al reload)
  - lo stdout di `npm run serve`: ci sono anche i riavvii del supervisore e il memory watchdog
  - console del browser, se il problema è nella dashboard
  - `npm run doctor`: dipendenze esterne (node, repo, node_modules, Ollama, sandbox)
  Incolla le righe pertinenti, non l'intero file, e togli percorsi o nomi che non vuoi pubblicare.
-->

```
(righe di log)
```

## Riproduzione

1.
2.
3.

Si riproduce: sempre / a volte / una volta sola

## Ambiente

- Commit o versione di ISL:
- `node --version`:
- Sistema operativo:
- Modello Ollama (`OLLAMA_MODEL`) e, se rilevante, `OLLAMA_CHAT_MODEL`:
- Dashboard ricostruita dopo l'ultima modifica (`npm run dashboard:build`)? sì / no
