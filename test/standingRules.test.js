import { test } from 'node:test';
import assert from 'node:assert/strict';
import { STANDING_RULES, rulesFor } from '../src/memory/standingRules.js';

/**
 * Queste regole esistono perché ISL ha rotto software in produzione con la pipeline al verde.
 * I test qui sotto non verificano che il testo sia bello: verificano le due proprietà che, se si
 * perdono, rendono le regole inefficaci senza che nulla fallisca — che restino generiche e che non
 * si ripetano dentro lo stesso prompt.
 */

test('nessuna regola nomina il progetto su cui è stata imparata', () => {
  // Una regola scritta come "attenzione a SearchBar.jsx" vale per un file di un repository.
  // ISL ne governa molti, e ciò che si ripete è la forma dell'errore, non il file.
  const blob = JSON.stringify(STANDING_RULES);
  for (const leak of [/rentall/i, /SearchBar/, /BecomeLister/, /\.jsx\b/, /prisma/i]) {
    assert.equal(leak.test(blob), false, `una regola nomina qualcosa di specifico: ${leak}`);
  }
});

test('ogni regola dice cosa fare, non solo cosa è andato storto', () => {
  for (const r of STANDING_RULES) {
    assert.ok(r.rule.length > 200, `${r.id}: troppo corta per contenere un'istruzione`);
    assert.ok(r.audience.length, `${r.id}: nessun destinatario, non entrerà in nessun prompt`);
    // Il perché è ciò che distingue una regola da un divieto: senza, il modello la aggira.
    // Le regole sono mandate a capo a mano, quindi lo spazio fra le parole può essere un newline.
    assert.match(r.rule, /perch|è\s+già\s+successo|altrimenti|produce/i, `${r.id}: manca il motivo`);
  }
});

test('più destinatari non ripetono la stessa regola', () => {
  // Un task frontend è sia implementer sia frontend, e la regola sulle traduzioni sta in entrambi.
  const out = rulesFor(['implementer', 'frontend']);
  const localised = out.match(/NESSUNA STRINGA VISIBILE/g) || [];
  assert.equal(localised.length, 1, 'regola duplicata nello stesso prompt');
});

test('un destinatario filtra davvero: security non riceve le regole di traduzione', () => {
  const sec = rulesFor('security');
  assert.match(sec, /FAIL-CLOSED/);
  assert.doesNotMatch(sec, /NESSUNA STRINGA VISIBILE/);
});

test('un destinatario sconosciuto non produce un blocco vuoto con la sola intestazione', () => {
  assert.equal(rulesFor('infra'), '');
});

test('il planner riceve la regola sullo scope', () => {
  // È quella che ha superato una review da 95/100.
  assert.match(rulesFor('planner'), /DEVE ESSERE LEGATO NELL/);
});
