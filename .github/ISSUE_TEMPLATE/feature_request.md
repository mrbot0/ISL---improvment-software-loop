---
name: Proposta di miglioramento
about: Un'idea per ISL — un gate, un agente, un manager, una vista della dashboard
title: ''
labels: enhancement
---

## Il problema

<!--
  Parti dal guasto o dall'attrito concreto, non dalla soluzione. In ISL le cose migliori sono
  nate così: "il planner ha scelto la stessa funzione in quattro run di fila, fallendo ogni
  volta". Se puoi, indica il run o la situazione che l'ha reso evidente.
-->

## Cosa proponi

## Dove interverrebbe

- [ ] Un **gate deterministico** nuovo o modificato (`src/iteration/`)
- [ ] Un grader o il motore di iterazione
- [ ] Un agente o un manager
- [ ] Planner / backlog / scelta dei candidati
- [ ] Piattaforma: progetti, auth, admin, audit
- [ ] Context Manager / doc agents / knowledge index
- [ ] Reliability Manager
- [ ] Runtime dei container / schema integrity
- [ ] Dashboard (quale tab, o una nuova)
- [ ] Altro: ……

## Se è un gate

<!--
  La convenzione è descritta in CONTRIBUTING.md §5. In breve, rispondi a queste:
-->

- Quale modifica è passata e non doveva passare? (il guasto reale che motiva il gate)
- La regola è decidibile senza LLM, sullo stesso diff, sempre con lo stesso verdetto?
- Qual è la versione **legittima** della stessa operazione, quella su cui il gate non deve
  scattare?

## Alternative considerate

<!-- Compreso: si può ottenere con le impostazioni già esistenti? -->

## Effetto sull'autonomia

<!--
  Cambia cosa ISL committa o promuove senza che un umano guardi? Se sì, dillo esplicitamente:
  è la parte da discutere prima di scrivere il codice.
-->
