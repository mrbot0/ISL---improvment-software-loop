/**
 * REGOLE PERMANENTI — ciò che ISL ha imparato rompendo software vero.
 *
 * Le lezioni in `lessons.js` sono REATTIVE: si insegnano dopo un fallimento, indicizzate sul codice
 * del classificatore. Queste sono PREVENTIVE. Entrano in ogni prompt di pianificazione e di
 * implementazione, sempre, perché il fallimento che descrivono non si presenta come un errore da
 * classificare: si presenta come una run verde.
 *
 * Ogni regola qui è stata pagata. Le quattro voci sono le quattro rotture che ISL ha prodotto su
 * un'applicazione in produzione, tutte con la pipeline al verde e il reviewer soddisfatto — una di
 * esse con 95 su 100. Nessuna era un bug di sintassi, nessuna un test rosso, nessuna un boot fallito.
 *
 * NIENTE QUI NOMINA QUEL PROGETTO. Una regola scritta come "attenzione a SearchBar.jsx" non insegna
 * nulla: vale per un file di un repository e ISL ne governa molti. Quello che si ripete non è il
 * file, è la FORMA dell'errore — un simbolo letto dove non è legato, un limite scritto due volte in
 * due punti, un controllo di sicurezza che in caso di guasto lascia passare, una stringa che esiste
 * in una lingua sola. Quelle forme ricorrono in qualsiasi linguaggio e qualsiasi dominio.
 *
 * Il criterio per aggiungerne una: un difetto che è ARRIVATO ALL'UTENTE attraversando tutti i gate.
 * Se un gate deterministico l'avrebbe preso, la sede giusta è il gate, non un prompt — un modello a
 * cui si chiede di ricordare venti regole ne rispetta poche. Sono quattro, e restano poche.
 */

export const STANDING_RULES = [
  {
    id: 'scope-binding',
    title: 'Un simbolo va legato nell’unità che lo usa',
    /** Ciò che finisce nel prompt. Seconda persona, imperativo, con il perché. */
    rule: [
      'OGNI NOME CHE USI DEVE ESSERE LEGATO NELL’AMBITO IN CUI LO SCRIVI. Che sia un import, un',
      'parametro, una variabile o il risultato di un hook: se lo leggi in una funzione o in un',
      'componente, deve essere legato LÌ, non in un fratello e non nel genitore. Copiare una riga da',
      'un componente che aveva l’hook dentro uno che non ce l’ha produce codice che compila, supera i',
      'test che non toccano quel ramo, avvia il servizio senza un lamento, e va in eccezione appena',
      'un utente apre quel pannello. È già successo: una modifica valutata 95 su 100 ha reso',
      'inutilizzabile la barra di ricerca di un sito in produzione.',
    ].join('\n'),
    audience: ['planner', 'implementer'],
  },
  {
    id: 'single-source-limit',
    title: 'Un limite si scrive una volta sola',
    rule: [
      'QUANDO DUE PUNTI DEL CODICE DEVONO CONCORDARE SU UN NUMERO, DERIVANE UNO DALL’ALTRO. Il tetto',
      'del body di una richiesta e la dimensione massima per elemento; il numero di elementi accettati',
      'dal validatore e quello che il client invia; il timeout del chiamante e quello del chiamato.',
      'Due costanti scritte a mano in due file non restano d’accordo: la prima modifica che tocca una',
      'sola delle due crea un limite che il client supera e il server rifiuta, e il fallimento non',
      'assomiglia a un limite superato — assomiglia a una connessione interrotta a metà. È già',
      'successo: un tetto sul corpo della richiesta più basso della somma degli allegati che lo stesso',
      'endpoint dichiarava di accettare ha interrotto ogni invio a metà, e la funzione è rimasta rotta',
      'per giorni perché l’errore diceva "richiesta annullata" e non "troppo grande". Calcola il',
      'valore dipendente da quello autorevole, nello stesso modulo, con un commento che lo dice.',
    ].join('\n'),
    audience: ['planner', 'implementer'],
  },
  {
    id: 'fail-closed',
    title: 'Un controllo di sicurezza che si guasta deve bloccare',
    rule: [
      'MODERAZIONE, AUTORIZZAZIONE E VALIDAZIONE VANNO IN FAIL-CLOSED. Se il controllo non ha potuto',
      'esprimersi — la rete è caduta, il servizio ha risposto 500, la richiesta è andata in timeout —',
      'l’esito è RIFIUTO, non passaggio. Un catch che ingoia l’errore e prosegue trasforma ogni',
      'disservizio in un’assenza totale di controllo, e nessun test lo vede perché nei test la rete',
      'funziona. È già successo: un filtro immagini che falliva in apertura ha lasciato pubblicare la',
      'foto di un’arma. Se un rifiuto in caso di guasto è inaccettabile per il prodotto, quella è una',
      'decisione di prodotto: dichiarala nel task e rendila visibile all’utente, non implicita in un catch.',
    ].join('\n'),
    audience: ['planner', 'implementer', 'security'],
  },
  {
    id: 'user-strings-localised',
    title: 'Il testo che l’utente legge passa dal sistema di traduzione',
    rule: [
      'NESSUNA STRINGA VISIBILE ALL’UTENTE VA SCRITTA IN CHIARO NEL CODICE, e la chiave che introduci',
      'deve esistere in TUTTE le lingue già presenti nel progetto, nella forma che il resolver del',
      'progetto sa leggere. Aggiungerla a una lingua sola non produce un errore: produce un’interfaccia',
      'che ricade nella lingua di sviluppo per tutti gli altri utenti, il che sembra funzionante a chi',
      'scrive il codice e non lo è per chi lo usa. Vale anche per il testo generato: se il sistema ha',
      'una lingua attiva, passala al modello e chiedi esplicitamente l’output in quella lingua —',
      'altrimenti risponderà nella lingua del prompt, che è quella di chi ha scritto il prompt.',
    ].join('\n'),
    audience: ['planner', 'implementer', 'frontend', 'ux'],
  },
  {
    id: 'layout-contract',
    title: 'Cambiare il modello di layout riapre il contratto di ogni figlio',
    rule: [
      'SE CAMBI IL CONTENITORE, RIDICHIARA IL DIMENSIONAMENTO DI OGNI FIGLIO. Passare da una griglia',
      'a una riga flessibile, invertire la direzione, cambiare il display: in tutti questi casi le',
      'regole che davano dimensione ai figli smettono di valere, e i valori di default che subentrano',
      'sono quasi sempre "dimensionati sul contenuto". Il risultato non è una pagina rotta che salta',
      'all’occhio: è una colonna che si restringe, un pannello che lascia metà schermo vuoto, un',
      'campo di input spinto sotto la piega. Compila, i test passano, l’applicazione si avvia. È già',
      'successo: un task che doveva aggiungere la modifica dei messaggi ha riscritto il contenitore',
      'della pagina e ha dimenticato di dichiarare che la colonna della conversazione doveva',
      'espandersi; si è ridotta a un terzo della larghezza e il campo di scrittura è finito fuori',
      'schermo. Se il task non riguarda il layout, NON riscrivere il contenitore: fai la modifica',
      'dentro la struttura che trovi.',
    ].join('\n'),
    audience: ['planner', 'frontend', 'ux'],
  },
];

/**
 * Le regole per un destinatario, pronte da concatenare in un prompt.
 *
 * `audience` è un filtro, non una gerarchia: un agente di sicurezza non ha bisogno delle regole
 * sulle traduzioni, e ogni riga che non gli serve indebolisce quelle che gli servono.
 */
export function rulesFor(audience = 'implementer') {
  // Più destinatari in una chiamata sola, non due chiamate concatenate: un task frontend è sia
  // "implementer" sia "frontend", e sommare due risultati ripete la regola che sta in entrambi.
  // Una regola ripetuta nello stesso prompt non pesa il doppio — segnala solo che nessuno ha riletto.
  const wanted = new Set([audience].flat().filter(Boolean));
  const picked = STANDING_RULES.filter((r) => r.audience.some((a) => wanted.has(a)));
  if (!picked.length) return '';
  return [
    'REGOLE PERMANENTI — ognuna deriva da un difetto che ha raggiunto gli utenti passando per una',
    'pipeline completamente verde. Non sono preferenze di stile.',
    '',
    ...picked.map((r) => `• ${r.title.toUpperCase()}\n${r.rule}`),
  ].join('\n');
}
