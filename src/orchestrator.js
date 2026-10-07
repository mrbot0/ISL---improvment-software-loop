import { autonomy } from './config.js';
import { bus, emit } from './bus.js';
import { countPending, db, getAgent, getSetting, markStaleProposals, setSetting } from './db.js';
import {
  WORKER_ID,
  acquireLeadership,
  claim,
  complete,
  enqueue as enqueueJob,
  fail,
  leadershipStatus,
  renew,
} from './core/workQueue.js';
import { runAgent } from './agents/runner.js';
import { verifyProposal } from './sandbox/verifier.js';
import { headCommit } from './sandbox/worktree.js';
import { log } from './logger.js';

/**
 * The review-pass executor.
 *
 * This used to own a loop of its own, competing with the iteration engine for the
 * same GPU and giving the operator a second switch that looked like the main one.
 * That loop is gone — core/controller.js is now the only one, and the specialists
 * it used to schedule became the personas the implementer wears inside an iteration.
 *
 * What survives is the part that was genuinely distinct: running ONE specialist,
 * on demand, as a REVIEW pass that produces proposals for a human to approve
 * rather than a change that commits itself. "Audit the security surface and tell me
 * what you find" is a real request, and it is not the same as "improve the code".
 * It just doesn't need a loop to exist.
 *
 * ── Perché la coda è durevole ───────────────────────────────────────────────────
 * Il mestiere resta quello: UNA passata di revisione su richiesta. Cambia il modo
 * in cui la richiesta viene custodita. Prima era `this.queue`, un array in memoria,
 * e il supervisore riavvia questo processo dopo ogni crash e dopo ogni riavvio
 * pulito del guardiano: a ogni riavvio la coda spariva senza lasciare traccia, e
 * chi l'aveva riempita non lo sapeva. Per un piano di controllo che deve restare
 * acceso per giorni era il difetto principale.
 *
 * Ora i lavori vivono in `work_queue` (core/workQueue.js), la coda durevole che il
 * progetto ha già: lease che SCADONO, `attempts` con tetto, idempotency key. Non ne
 * aggiungiamo una seconda — qui si usa la sua API, e la sola cosa che questo modulo
 * fa da sé sulla tabella è LEGGERLA per raccontarla in `state()` (più la potatura
 * dello storico dei soli lavori di questo kind, come `trimLogs` fa per i log).
 *
 * Le tre garanzie che ne derivano, e da dove vengono:
 *
 *   1. un lavoro in coda sopravvive al riavvio — è una riga di SQLite, non un array;
 *   2. un lavoro interrotto a metà non resta "in esecuzione" per sempre — il lease
 *      è rinnovato solo da un processo vivo, quindi scade entro LEASE_MS dal crash
 *      e `claim()` lo riporta a `ready`. La scadenza è il protocollo: è l'unico che
 *      sopravvive a un processo UCCISO, non soltanto fermato con garbo;
 *   3. i ritentativi hanno un tetto — `max_attempts`, poi la riga diventa `dead`.
 *      Una passata di revisione che si ritenta all'infinito su un errore permanente
 *      consuma budget e nasconde il guasto.
 */

/** Il kind con cui i lavori di questo modulo vivono nella coda durevole. */
const JOB_KIND = 'review_pass';

/**
 * Ruolo di leadership per le passate di revisione.
 *
 * Il lease sul singolo lavoro impedisce a due worker di eseguire LO STESSO lavoro.
 * Non impedisce a due server sovrapposti (la finestra di riavvio del supervisore) di
 * eseguirne DUE DIVERSI insieme, e su questo progetto è un guasto misurato: due
 * generazioni concorrenti contro un solo Ollama con un solo modello residente si
 * uccidono a vicenda (cfr. test/runStability.test.js). Il ruolo rende la mutua
 * esclusione esplicita invece che sperata.
 *
 * Se il ruolo non è nostro NON si perde nulla: la coda è durevole, `state()` dice
 * chi lo tiene, e il poll ritenta. Un meccanismo nuovo non deve poter abbattere
 * ciò che osserva: al massimo qui si resta fermi, in modo visibile.
 */
const ROLE = 'review-pass';
const ROLE_TTL_MS = 2 * 60_000;

/**
 * Durata del lease su un lavoro e intervallo di rinnovo.
 *
 * Il rinnovo deve stare comodamente dentro il lease, altrimenti un lavoro lungo ma
 * sano si fa portare via da sotto i piedi. Il lease, a sua volta, è il tempo massimo
 * per cui un lavoro interrotto resta `leased` dopo un crash: tenerlo corto è ciò che
 * rende il recupero automatico invece che manuale.
 */
const LEASE_MS = 2 * 60_000;
const RENEW_MS = 40_000;

/** Attesa prima di un ritentativo, e tetto ai ritentativi (1 = nessun ritentativo). */
const RETRY_DELAY_MS = 60_000;
const DEFAULT_MAX_ATTEMPTS = 2;
const MAX_ATTEMPTS_CAP = 5;

/** Ogni quanto si ricontrolla la coda quando nessuno chiama `enqueue`. */
const POLL_MS = 30_000;

/** Quanti lavori conclusi di questo kind si tengono come storico. */
const HISTORY_KEEP = 200;

/** Quanto a lungo vale la proiezione della coda letta per `state()` (hot path). */
const VIEW_TTL_MS = 1_500;

const lg = log.for('orchestrator');
const now = () => Date.now();
const P = (v, dflt = null) => {
  if (v == null) return dflt;
  try {
    return JSON.parse(v);
  } catch {
    return dflt;
  }
};

export class Orchestrator {
  /**
   * @param {object} [deps] seam per i test: il runner, la verifica e HEAD sono
   *   iniettabili, così la coda si può esercitare senza accendere un modello.
   */
  constructor(deps = {}) {
    this.runAgent = deps.runAgent ?? runAgent;
    this.verifyProposal = deps.verifyProposal ?? verifyProposal;
    this.headCommit = deps.headCommit ?? headCommit;
    this.retryDelayMs = deps.retryDelayMs ?? RETRY_DELAY_MS;
    this.pollMs = deps.pollMs ?? POLL_MS;

    this.current = null; // { jobId, agentId, runId, attempt, startedAt, abort, cancelled }
    this.draining = false;
    this.recovered = false;
    this._inflight = null;
    this._stopped = false;
    this.declinedRole = null; // chi tiene il ruolo, quando non è nostro
    this._keepalive = null;
    this._poll = null;
    this._view = null; // { at, counts, waiting, running, orphaned, failures }
  }

  get maxPending() {
    return getSetting('maxPendingProposals', autonomy.maxPendingProposals);
  }

  /** Tetto ai ritentativi di una passata di revisione. Scritto, limitato, testato. */
  get maxAttempts() {
    const raw = Number(getSetting('reviewPassMaxAttempts', DEFAULT_MAX_ATTEMPTS));
    const n = Number.isFinite(raw) ? Math.trunc(raw) : DEFAULT_MAX_ATTEMPTS;
    return Math.min(MAX_ATTEMPTS_CAP, Math.max(1, n));
  }

  /**
   * Tutto ciò che serve a un operatore per capire cosa è in coda, cosa sta girando
   * e cosa è fallito di recente. I campi `queued` e `current` conservano la forma
   * che il dashboard legge già; il resto è nuovo e sta sotto `durable`.
   */
  state() {
    this._ensureRecovered();
    const view = this._queueView();
    return {
      maxPending: this.maxPending,
      pending: countPending(),
      queued: view.waiting.map((j) => j.agentId),
      current: this.current
        ? {
            agentId: this.current.agentId,
            runId: this.current.runId,
            jobId: this.current.jobId,
            attempt: this.current.attempt,
            startedAt: this.current.startedAt,
          }
        : null,
      applyMode: getSetting('applyMode', autonomy.applyMode),
      headCommit: this.safeHead().slice(0, 8),

      /**
       * La coda durevole, come la vede chi deve decidere se intervenire.
       * `orphaned` sono lavori che un altro processo teneva in esecuzione: non si
       * rubano, si aspetta che il loro lease scada (`reclaimAt`).
       */
      durable: {
        kind: JOB_KIND,
        worker: WORKER_ID,
        draining: this.draining,
        leadership: view.leadership,
        maxAttempts: this.maxAttempts,
        leaseMs: LEASE_MS,
        counts: view.counts,
        waiting: view.waiting,
        running: view.running,
        orphaned: view.orphaned,
        recentFailures: view.failures,
      },
    };
  }

  /* -------------------------------- queueing ------------------------------- */

  /**
   * Metti in coda una passata di revisione. Il lavoro è una riga di SQLite da
   * subito: se il processo muore un millisecondo dopo, la richiesta è ancora lì.
   *
   * `idempotencyKey` rende la stessa chiamata ripetibile senza duplicati — utile a
   * un chiamante che ritenta e non sa se la prima volta è arrivata.
   */
  enqueue(agentId, { trigger = 'manual', instruction = null, idempotencyKey = null } = {}) {
    const agent = getAgent(agentId);
    if (!agent) throw new Error(`Unknown agent: ${agentId}`);
    this._ensureRecovered();

    const job = enqueueJob({
      kind: JOB_KIND,
      payload: { agentId, trigger, instruction, queuedAt: now() },
      idempotencyKey,
      maxAttempts: this.maxAttempts,
    });
    this._invalidateView();

    const view = this._queueView();
    const position = view.waiting.length + view.running.length;
    emit('agent.queued', { agentId, trigger, jobId: job.id, position, duplicate: job.duplicate });
    if (!job.duplicate) lg.info(`queued review pass #${job.id} for ${agentId} (${trigger})`, { agentId });

    this._kick();
    return { queued: true, position, jobId: job.id, duplicate: job.duplicate };
  }

  /**
   * Svuota la coda, un lavoro alla volta.
   *
   * Una sola passata per volta: chi chiama mentre un'altra è in corso riceve LA
   * STESSA promise, non un rifiuto. Così `await drain()` significa sempre "quando la
   * coda è stata svuotata", da qualunque punto arrivi la chiamata.
   */
  drain() {
    if (this._inflight) return this._inflight;
    this._inflight = this._drain().finally(() => {
      this._inflight = null;
    });
    return this._inflight;
  }

  /**
   * `claim()` fa due cose in una: recupera i lease scaduti (il lavoro di un processo
   * che ha smesso di rinnovare) e ne assegna uno a noi con un UPDATE condizionale
   * singolo, così due worker che allungano la mano sulla stessa riga non possono
   * credere entrambi di aver vinto.
   */
  async _drain() {
    if (this._stopped) return { drained: 0, reason: 'stopped' };
    this._ensureRecovered();

    if (!this._takeRole()) {
      const who = this._leadership();
      if (this.declinedRole !== who.holder) {
        this.declinedRole = who.holder;
        lg.warn(`another worker holds the review-pass role (${who.holder ?? 'unknown'}) — the queue waits, nothing is lost`);
      }
      return { drained: 0, reason: 'role not held' };
    }
    this.declinedRole = null;

    this.draining = true;
    let drained = 0;
    try {
      for (;;) {
        let job;
        try {
          job = claim({ kinds: [JOB_KIND], leaseMs: LEASE_MS });
        } catch (err) {
          // Una coda che non si può leggere non deve far cadere chi la stava svuotando.
          lg.error(`claim failed: ${err.message}`);
          break;
        }
        if (!job) break;
        this._invalidateView();
        try {
          await this._runJob(job);
        } catch (err) {
          // `_runJob` chiude da sé ogni esito previsto; qui si finisce solo per un
          // guasto dell'infrastruttura (DB chiuso a metà). Il lease scade e il
          // lavoro torna disponibile: meglio fermare il giro che perderlo in silenzio.
          lg.error(`review pass #${job.id} aborted outside its own handling: ${err.message}`);
          break;
        }
        drained += 1;
      }
    } finally {
      this.draining = false;
      this._stopKeepalive();
      this._invalidateView();
      // Lo storico si pota qui e non solo al boot: un piano di controllo acceso per
      // giorni non riparte, e la coda non ha una potatura propria.
      if (drained) this._pruneHistory();
    }
    return { drained };
  }

  /** Esegue un lavoro già assegnato a noi e lo chiude in un solo stato terminale. */
  async _runJob(job) {
    const { agentId = null, trigger = 'manual', instruction = null } = job.payload ?? {};
    const agent = agentId ? getAgent(agentId) : null;
    if (!agent) {
      // Guasto permanente: nessun ritentativo può fare esistere un agent cancellato.
      // Si chiude subito con l'esito scritto nel risultato, invece di bruciare i tentativi.
      this._settle(job, { ok: false, agentId, reason: `unknown agent: ${agentId ?? '(none)'}` });
      lg.error(`review pass #${job.id} cannot run — unknown agent: ${agentId ?? '(none)'}`);
      emit('agent.error', { agentId, jobId: job.id, error: `unknown agent: ${agentId ?? '(none)'}` });
      return;
    }

    const abort = new AbortController();
    this.current = {
      jobId: job.id,
      agentId: agent.id,
      runId: null,
      attempt: job.attempts,
      startedAt: now(),
      abort,
      cancelled: false,
    };
    this._startKeepalive(job.id);

    let result;
    try {
      result = await this.runAgent(agent, { trigger, instruction, signal: abort.signal });
    } catch (err) {
      const cancelled = this.current?.cancelled === true;
      if (cancelled) {
        // Lo ha fermato un umano: ritentarlo sarebbe disobbedire.
        this._settle(job, { ok: false, agentId: agent.id, reason: 'cancelled by operator' });
        lg.warn(`review pass #${job.id} (${agent.id}) cancelled by operator`, { agentId: agent.id });
        emit('agent.error', { agentId: agent.id, jobId: job.id, error: 'cancelled by operator' });
        return;
      }
      const outcome = this._fail(job, err);
      lg.error(
        `review pass #${job.id} (${agent.id}) failed on attempt ${job.attempts}/${job.maxAttempts}: ${err.message}` +
          (outcome.dead ? ' — no attempts left, marked dead' : ' — will retry'),
        { agentId: agent.id },
      );
      emit('agent.error', {
        agentId: agent.id,
        jobId: job.id,
        error: err.message,
        attempt: job.attempts,
        maxAttempts: job.maxAttempts,
        willRetry: outcome.retried,
        dead: outcome.dead,
      });
      return;
    } finally {
      this.current = null;
      this._stopKeepalive();
    }

    /**
     * Il lavoro è "esegui lo specialista e produci proposte": si chiude qui.
     * La verifica che segue ha il proprio stato sulla proposta (`verifying`), ed è
     * la parte economica: tenere il lavoro aperto fino alla fine della verifica
     * farebbe ri-eseguire un'intera passata LLM per un crash dentro un check.
     */
    const settled = this._settle(job, {
      ok: true,
      agentId: agent.id,
      runId: result?.runId ?? null,
      proposals: result?.proposalIds?.length ?? 0,
    });
    if (!settled) {
      lg.warn(
        `review pass #${job.id} (${agent.id}) finished but its lease was gone — another worker may repeat it`,
        { agentId: agent.id },
      );
    }

    // A commit landing mid-run invalidates every open proposal's base.
    try {
      // Un HEAD vuoto è git che non ha risposto, non un commit nuovo: passarlo
      // dichiarerebbe stale OGNI proposta aperta (nessuna ha `base_commit = ''`).
      const head = this.safeHead();
      const stale = head ? markStaleProposals(head) : 0;
      if (stale) emit('config.changed', { note: `${stale} proposal(s) marked stale — HEAD moved` });
    } catch (err) {
      lg.warn(`could not re-base open proposals: ${err.message}`);
    }

    for (const id of result?.proposalIds ?? []) {
      try {
        await this.verifyProposal(id);
      } catch (err) {
        emit('agent.error', { agentId: agent.id, error: `verify #${id}: ${err.message}` });
      }
    }
  }

  /**
   * Ferma la passata in corso. Un annullamento non è un guasto: il lavoro si chiude
   * senza ritentativi, altrimenti il sistema rifarebbe ciò che gli è stato detto di
   * smettere di fare.
   */
  cancelCurrent() {
    if (!this.current) return { cancelled: false };
    this.current.cancelled = true;
    const { agentId, jobId } = this.current;
    this.current.abort.abort();
    return { cancelled: true, agentId, jobId };
  }

  /* ------------------------------- recovery -------------------------------- */

  /** Il cambio di progetto cambia il database: la coda da recuperare è un'altra. */
  onProjectActivated() {
    this.recovered = false;
    this._invalidateView();
    setImmediate(() => this._ensureRecovered());
  }

  /**
   * Recupero al primo contatto con un database aperto.
   *
   * Non c'è un hook di boot da chiamare da qui (server.js è un altro mestiere), e
   * non serve: `project.activated` scatta a ogni apertura di progetto, e questa
   * guardia copre anche chi apre un DB da sé (i test). Idempotente e silenziosa in
   * caso di errore: un recupero che fallisce non deve far cadere `state()`.
   */
  _ensureRecovered() {
    if (this.recovered) return;
    this.recovered = true;
    try {
      this._recover();
    } catch (err) {
      lg.warn(`queue recovery skipped: ${err.message}`);
    }
  }

  _recover() {
    const view = this._queueView({ fresh: true });

    for (const job of view.orphaned) {
      lg.warn(
        `review pass #${job.id} (${job.agentId ?? 'unknown agent'}) was left running by ${job.leasedBy ?? 'a previous process'} — ` +
          `its lease expires in ${Math.max(0, Math.round((job.reclaimAt - now()) / 1000))}s and it will be picked up then`,
      );
    }
    if (view.waiting.length) {
      lg.info(`${view.waiting.length} review pass(es) survived the restart — resuming`);
    }

    this._pruneHistory();
    this._startPoll();

    // Un lease già scaduto viene recuperato da `claim()` dentro `drain()`; uno ancora
    // valido va atteso, quindi si programma il passaggio subito dopo la sua scadenza.
    // Il primo giro è differito di un tick: il recupero può essere stato innescato
    // DA una `drain()` in corso, e una chiamata sincrona qui la rifarebbe partire.
    setImmediate(() => this._kick());
    const next = view.orphaned.reduce((min, j) => (min === null || j.reclaimAt < min ? j.reclaimAt : min), null);
    if (next !== null) {
      const wait = Math.min(Math.max(next - now() + 1_000, 1_000), LEASE_MS + 5_000);
      const t = setTimeout(() => this._kick(), wait);
      if (t.unref) t.unref();
    }
  }

  /**
   * `drain()` è asincrona e viene lanciata da timer e da `enqueue`, dove nessuno
   * aspetta il risultato. Senza questo involucro un suo rifiuto diventerebbe una
   * unhandled rejection, che su Node fa cadere il processo: il meccanismo che
   * sorveglia la coda non deve poter abbattere il server che la ospita.
   */
  _kick() {
    try {
      const p = this.drain();
      if (p && typeof p.catch === 'function') p.catch((err) => lg.error(`drain failed: ${err.message}`));
    } catch (err) {
      lg.error(`drain could not start: ${err.message}`);
    }
  }

  /**
   * Rinnova il lease mentre il lavoro gira (e con esso il ruolo). Senza questo, una
   * passata più lunga del lease verrebbe considerata abbandonata e rieseguita da
   * un altro processo mentre è ancora viva.
   */
  _startKeepalive(jobId) {
    this._stopKeepalive();
    const t = setInterval(() => {
      try {
        if (!renew(jobId, LEASE_MS)) {
          lg.warn(`lease on review pass #${jobId} was not renewed — another worker may take it`);
        }
        acquireLeadership(ROLE, ROLE_TTL_MS);
      } catch {
        /* il keepalive non deve mai essere la causa della morte di una run */
      }
    }, RENEW_MS);
    if (t.unref) t.unref();
    this._keepalive = t;
  }

  _stopKeepalive() {
    if (this._keepalive) clearInterval(this._keepalive);
    this._keepalive = null;
  }

  /**
   * Ricontrollo periodico. Serve a due casi che `enqueue` non copre: un lavoro
   * sopravvissuto a un riavvio e un lease altrui che scade. Unref'd, così non è
   * questo timer a tenere in vita il processo.
   */
  _startPoll() {
    if (this._poll) return;
    const t = setInterval(() => this._kick(), Math.max(5_000, this.pollMs));
    if (t.unref) t.unref();
    this._poll = t;
  }

  /**
   * Ritira questa istanza: niente più poll, niente più rinnovi, e `drain()` non
   * prende altri lavori. Serve a chi crea un'istanza a parte (i test) e vuole che
   * smetta di muoversi da sola. Il singleton non viene mai ritirato.
   */
  stopPolling() {
    this._stopped = true;
    if (this._poll) clearInterval(this._poll);
    this._poll = null;
    this._stopKeepalive();
  }

  /* ---------------------------- queue plumbing ----------------------------- */

  _takeRole() {
    try {
      return acquireLeadership(ROLE, ROLE_TTL_MS);
    } catch (err) {
      lg.warn(`review-pass role check failed (${err.message}) — standing by`);
      return false;
    }
  }

  _leadership() {
    try {
      return leadershipStatus(ROLE);
    } catch {
      return { role: ROLE, holder: null, isMe: false, expired: false };
    }
  }

  safeHead() {
    try {
      return this.headCommit() || '';
    } catch {
      return '';
    }
  }

  /** Chiude un lavoro in modo definitivo, con l'esito leggibile nel risultato. */
  _settle(job, result) {
    this._invalidateView();
    try {
      return complete(job.id, { ...result, at: now() });
    } catch (err) {
      lg.error(`could not settle review pass #${job.id}: ${err.message}`);
      return false;
    }
  }

  /** Lo fa ritentare, se gli restano tentativi; altrimenti lo dichiara `dead`. */
  _fail(job, err) {
    this._invalidateView();
    try {
      return fail(job.id, err, { retryDelayMs: this.retryDelayMs });
    } catch (e) {
      lg.error(`could not record the failure of review pass #${job.id}: ${e.message}`);
      return { retried: false, dead: false };
    }
  }

  _invalidateView() {
    this._view = null;
  }

  /**
   * Proiezione SOLA LETTURA della coda durevole, limitata a questo kind.
   *
   * Le transizioni di stato passano tutte dall'API di workQueue.js — qui si legge, e
   * si legge con un filtro su `kind` e su `status` perché `listJobs()` restituisce
   * le ultime N righe di OGNI kind e di ogni stato: con settimane di lavori conclusi
   * in tabella, le righe `ready` non ci sarebbero più dentro.
   *
   * Memoizzata per VIEW_TTL_MS: `state()` sta sul percorso caldo (ogni tick del
   * controller, ogni /api/state), e tre query per chiamata non si giustificano.
   */
  _queueView({ fresh = false } = {}) {
    if (!fresh && this._view && now() - this._view.at < VIEW_TTL_MS) return this._view;

    const empty = { at: now(), counts: {}, waiting: [], running: [], orphaned: [], failures: [], leadership: this._leadership() };
    let view;
    try {
      view = this._readQueue();
    } catch (err) {
      // La tabella può non esistere ancora (nessun progetto aperto): è un'assenza di
      // dati, non un guasto, e `state()` deve restare servibile comunque.
      view = { ...empty, unavailable: err.message };
    }
    this._view = view;
    return view;
  }

  _readQueue() {
    const counts = Object.fromEntries(
      db
        .prepare('SELECT status, COUNT(*) n FROM work_queue WHERE kind = ? GROUP BY status')
        .all(JOB_KIND)
        .map((r) => [r.status, r.n]),
    );

    const open = db
      .prepare(
        `SELECT id, status, payload_json, attempts, max_attempts, leased_by, lease_until, run_after, last_error, created_at
           FROM work_queue
          WHERE kind = ? AND status IN ('ready', 'leased')
          ORDER BY id`,
      )
      .all(JOB_KIND);

    const waiting = [];
    const running = [];
    const orphaned = [];
    for (const r of open) {
      const payload = P(r.payload_json, {}) ?? {};
      const row = {
        id: r.id,
        agentId: payload.agentId ?? null,
        trigger: payload.trigger ?? null,
        instruction: payload.instruction ?? null,
        attempts: r.attempts,
        maxAttempts: r.max_attempts,
        queuedAt: r.created_at,
        lastError: r.last_error,
      };
      if (r.status === 'ready') {
        waiting.push({ ...row, runAfter: r.run_after, retrying: r.attempts > 0 });
      } else {
        const mine = r.leased_by === WORKER_ID;
        const entry = { ...row, leasedBy: r.leased_by, leaseUntil: r.lease_until, mine };
        if (mine) running.push(entry);
        else orphaned.push({ ...entry, reclaimAt: r.lease_until ?? now() });
      }
    }

    const failures = db
      .prepare(
        `SELECT id, status, payload_json, attempts, max_attempts, last_error, result_json, updated_at
           FROM work_queue
          WHERE kind = ? AND status IN ('dead', 'failed', 'done')
          ORDER BY id DESC LIMIT 40`,
      )
      .all(JOB_KIND)
      .map((r) => {
        const payload = P(r.payload_json, {}) ?? {};
        const result = P(r.result_json, null);
        // `done` con `ok: false` è un guasto PERMANENTE chiuso senza ritentativi
        // (agent inesistente, annullamento): non è un successo e non va nascosto.
        if (r.status === 'done' && result?.ok !== false) return null;
        return {
          id: r.id,
          agentId: payload.agentId ?? result?.agentId ?? null,
          status: r.status,
          attempts: r.attempts,
          maxAttempts: r.max_attempts,
          error: r.last_error ?? result?.reason ?? null,
          retriable: r.status !== 'dead' && r.status !== 'done',
          at: r.updated_at,
        };
      })
      .filter(Boolean)
      .slice(0, 10);

    return { at: now(), counts, waiting, running, orphaned, failures, leadership: this._leadership() };
  }

  /**
   * Tiene limitato lo storico dei lavori di questo kind — la coda non ha una
   * potatura propria, e `trimLogs`/`trimEvents` sono il precedente. Si potano solo
   * le righe terminali del NOSTRO kind: nessun altro lavoro viene toccato.
   */
  _pruneHistory(keep = HISTORY_KEEP) {
    try {
      const changes = db
        .prepare(
          `DELETE FROM work_queue WHERE id IN (
             SELECT id FROM work_queue
              WHERE kind = ? AND status IN ('done', 'failed', 'dead')
              ORDER BY id DESC LIMIT -1 OFFSET ?
           )`,
        )
        .run(JOB_KIND, keep).changes;
      if (changes) lg.debug(`pruned ${changes} finished review pass record(s)`);
      return changes;
    } catch {
      return 0;
    }
  }

  /* ------------------------------- settings -------------------------------- */

  setMaxPending(n) {
    setSetting('maxPendingProposals', Math.max(1, Number(n) || 20));
    emit('config.changed', { maxPending: this.maxPending });
    return this.state();
  }

  /** Il tetto ai ritentativi è regolabile, ma resta un tetto: 1..MAX_ATTEMPTS_CAP. */
  setMaxAttempts(n) {
    const raw = Number(n);
    const wanted = Number.isFinite(raw) ? Math.trunc(raw) : DEFAULT_MAX_ATTEMPTS;
    setSetting('reviewPassMaxAttempts', Math.min(MAX_ATTEMPTS_CAP, Math.max(1, wanted)));
    emit('config.changed', { reviewPassMaxAttempts: this.maxAttempts });
    return this.state();
  }

  setApplyMode(mode) {
    if (!['branch', 'direct'].includes(mode)) throw new Error("applyMode must be 'branch' or 'direct'");
    setSetting('applyMode', mode);
    emit('config.changed', { applyMode: mode });
    return this.state();
  }
}

export const orchestrator = new Orchestrator();

/**
 * Un cambio di progetto apre un altro database: la coda da riprendere è quella del
 * progetto appena attivato. Il listener sta qui e non nel costruttore perché solo il
 * singleton deve reagire — un'istanza creata da un test non va iscritta al bus.
 */
bus.on('project.activated', () => {
  try {
    orchestrator.onProjectActivated();
  } catch {
    /* un recupero mancato non deve far fallire l'attivazione del progetto */
  }
});
