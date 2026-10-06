## Cosa cambia, e perché

<!--
  Il perché conta più del cosa: il diff dice già quali righe sono cambiate. Se chiude una issue,
  scrivi "Chiude #N".
-->

## Tipo

- [ ] Correzione di un difetto
- [ ] Gate deterministico nuovo o modificato
- [ ] Agente / manager / motore di iterazione
- [ ] Piattaforma (progetti, auth, admin)
- [ ] Dashboard
- [ ] Documentazione
- [ ] Altro: ……

## Come l'hai verificato

- Progetto attivo su cui l'hai provato:
- Run o iterazione di riferimento, se ce n'è uno:
- Cosa hai osservato che prima non andava e ora va:

```
npm run test:all      →
npm run check:routes  →
```

## Checklist

- [ ] `npm test` verde (backend, `node:test`)
- [ ] `cd dashboard && npx vitest run` verde — oppure `npm run test:all`
- [ ] `npm run check:routes` senza `MISSING`
- [ ] Se ho toccato `dashboard/src/`: ho eseguito `npm run dashboard:build` e verificato nel browser
      (`dashboard/dist` non è nel repository: il bundle è solo locale)
- [ ] Nessun valore del progetto bersaglio catturato all'import: passa da `src/config.js`
      (live bindings) e dall'handle di `src/db.js`, perché il progetto attivo cambia a runtime
- [ ] Niente segreti, percorsi personali, dati di progetti reali o file sotto `.data/` nel diff

### Se la PR aggiunge o modifica un gate

- [ ] Il commento in testa al file nomina il **guasto reale** che lo motiva e il danno prodotto
- [ ] Deterministico: nessuna chiamata a un LLM, verdetto stabile sullo stesso diff
- [ ] Due test in `test/`: il diff che ha rotto le cose è vietato, **e** la versione legittima della
      stessa operazione passa
- [ ] Atterra in `advisory` (via `getSetting`), non direttamente in `enforce`

## Rischio

<!--
  Se questa modifica è sbagliata, cosa succede? Chi lo scopre, e quando? ISL committa senza
  supervisione quando l'autonomia è attiva: un errore in un gate o nella promozione non si ferma
  a questa PR.
-->
