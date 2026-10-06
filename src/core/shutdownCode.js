/**
 * IL CODICE DI USCITA CHE DICE AL SUPERVISORE DI NON RIAVVIARE.
 *
 * Il supervisore esiste per non lasciare mai giù il piano di controllo: qualunque uscita del server
 * — crash, OOM, watchdog — viene seguita da un riavvio entro pochi secondi. È il comportamento
 * giusto per tutto tranne che per un caso: quando è l'operatore a voler spegnere. Senza un modo per
 * distinguerlo, "ferma ISL" dalla dashboard significa vedere il server tornare su da solo, e
 * l'unica via d'uscita è aprire un terminale e uccidere i processi a mano.
 *
 * Un codice di uscita è il canale giusto perché il sistema operativo lo consegna al padre in modo
 * atomico insieme all'uscita stessa: nessun file sentinella da scrivere, nessuna corsa fra chi
 * scrive e chi legge, niente da ripulire se il processo muore a metà.
 *
 * 99 è fuori dai codici che Node genera per conto suo (0, 1, 7, 8, 9, 12, 13) e fuori
 * dall'intervallo 128+N dei segnali, quindi non può essere confuso con una morte accidentale.
 *
 * Questo modulo non importa nulla di proposito: lo carica anche il supervisore, che deve restare
 * leggero e non deve trascinarsi dietro la configurazione o il database per conoscere un numero.
 */
export const SHUTDOWN_EXIT_CODE = 99;
