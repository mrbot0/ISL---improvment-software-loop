import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { SHUTDOWN_EXIT_CODE } from './src/core/shutdownCode.js';

/**
 * ISL SUPERVISOR — keeps the server alive.
 *
 * The autonomous control plane must never stay down. The server already survives a single bad
 * run (it catches unhandled errors), but it cannot survive a hard crash or an out-of-memory kill
 * — and over long runs those DO happen. This tiny supervisor is the guaranteed-recovery layer:
 * it launches the server and, whenever it exits for ANY reason, restarts it within seconds. The
 * loop's desired state is persisted, so it auto-resumes on the fresh process.
 *
 * A crash-loop guard prevents a truly broken build from respawning in a tight loop: after several
 * failures in a short window it backs off, then keeps trying (never gives up — the operator wants
 * ISL running). The server's own memory watchdog exits cleanly (code 0) before OOM, which the
 * supervisor treats as a normal restart.
 *
 * Run this (not server.js) as the long-lived process:  node supervisor.mjs
 */

const __dirname = path.dirname(fileURLToPath(import.meta.url));
/*
 * Sovrascrivibile per una ragione sola: poter provare questo file per davvero.
 *
 * La regola che conta qui — quale uscita fa riavviare e quale no — non si può verificare senza
 * eseguire il supervisore, e il primo tentativo lo copiava in una cartella temporanea riscrivendone
 * il sorgente. Quel test provava la copia, non l'originale, e si rompeva per conto suo (un percorso
 * assoluto Windows non è uno specificatore ESM valido). Una variabile d'ambiente lascia che il test
 * guidi esattamente il file che va in produzione, che è l'unico che valga la pena verificare.
 */
const SERVER = process.env.ISL_SERVER_ENTRY || path.join(__dirname, 'src', 'server.js');
const HEAP_MB = Number(process.env.ISL_HEAP_MB) || 2048;

// Crash-loop guard: count restarts inside a rolling window.
const FAST_WINDOW_MS = 60_000;
const FAST_MAX = 5;
let recent = [];
let generation = 0;

function backoffMs() {
  recent = recent.filter((t) => Date.now() - t < FAST_WINDOW_MS);
  if (recent.length >= FAST_MAX) return 30_000; // too many fast crashes — cool down
  return 2_000;
}

function ts() {
  return new Date().toISOString();
}

function launch() {
  const gen = ++generation;
  console.log(`[supervisor ${ts()}] starting server (gen ${gen}, heap ${HEAP_MB}MB)`);
  const child = spawn(
    process.execPath,
    [`--max-old-space-size=${HEAP_MB}`, '--expose-gc', SERVER],
    { cwd: __dirname, stdio: 'inherit', env: process.env, windowsHide: true },
  );

  child.on('exit', (code, signal) => {
    /*
     * L'UNICA USCITA CHE NON VIENE RIAVVIATA.
     *
     * Riavviare sempre è ciò che rende affidabile questo processo, ed è anche ciò che rendeva
     * impossibile spegnere ISL dalla dashboard: premi "ferma", il server esce, e dopo due secondi
     * è di nuovo su. Un codice concordato distingue "è morto" da "gli è stato chiesto di morire".
     *
     * Qui il supervisore esce a sua volta con 0: la richiesta è stata soddisfatta, non è un
     * fallimento, e un supervisore che resta vivo senza figlio sarebbe solo un processo fantasma
     * che tiene occupata la porta al prossimo avvio.
     */
    if (code === SHUTDOWN_EXIT_CODE) {
      console.log(`[supervisor ${ts()}] arresto richiesto dall'operatore (gen ${gen}) — esco senza riavviare`);
      process.exit(0);
    }
    recent.push(Date.now());
    const wait = backoffMs();
    console.error(`[supervisor ${ts()}] server (gen ${gen}) exited code=${code} signal=${signal || '—'} — restarting in ${wait}ms`);
    setTimeout(launch, wait);
  });

  child.on('error', (err) => {
    console.error(`[supervisor ${ts()}] failed to spawn server: ${err.message} — retrying in 5s`);
    setTimeout(launch, 5_000);
  });
}

// The supervisor itself must not die on a stray error.
process.on('uncaughtException', (e) => console.error(`[supervisor ${ts()}] uncaught: ${e?.message || e}`));
process.on('unhandledRejection', (e) => console.error(`[supervisor ${ts()}] unhandled: ${e?.message || e}`));
process.on('SIGINT', () => process.exit(0));
process.on('SIGTERM', () => process.exit(0));

launch();
