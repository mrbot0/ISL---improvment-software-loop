import { bus, emit as busEmit } from '../bus.js';
import { getAllManagerBriefs, getManagerBrief, publishManagerBrief, sendManagerMessage, getSetting, setSetting } from '../db.js';
import { remember as memRemember, recall as memRecall } from '../memory/memoryDb.js';
import { networkInsight, networkSnapshot } from '../core/decisionNetwork.js';
import { log } from '../logger.js';

/**
 * A Manager is a supervisory layer sitting above the five worker agents. It does
 * not write code and cannot approve anything — it *observes* the event bus, keeps
 * a live "brief" (its current read on one dimension of the system), and coordinates
 * with peer managers by exchanging messages.
 *
 * Four are passive observers (Quality, Throughput, Risk, Insights); one is active
 * (Operations) and may take a bounded, recorded action such as pausing the loop.
 *
 * status: idle (all well) | watching (normal) | acting | alert (needs attention)
 */
export class BaseManager {
  constructor(name, opts = {}) {
    this.name = name;
    this.icon = opts.icon || '◆';
    this.accent = opts.accent || 'slate';
    this.role = opts.role || '';
    this.publishIntervalMs = opts.publishIntervalMs || 8000;
    this.brief = {
      name,
      icon: this.icon,
      accent: this.accent,
      role: this.role,
      status: 'idle',
      headline: 'Initializing…',
      summary: '',
      stats: {},
      recommendations: [],
      lastEventAt: null,
    };
    this._timer = null;
    this._subs = [];
    this._peers = [];
    // Posta in arrivo: capienza fissa, i piu' vecchi cadono. Vedi inbox().
    this._inbox = [];
    this._inboxMax = 20;
    // Ultimo titolo gia condiviso: un allarme che lampeggia non deve ripetersi nei prompt.
    this._lastShared = null;
    this.log = log.for(`manager:${name}`);
  }

  /** A disabled manager stops reacting and acting — used to "fix" a misbehaving one. */
  isEnabled() {
    return getSetting(`manager.enabled.${this.name}`, true);
  }

  setEnabled(on) {
    setSetting(`manager.enabled.${this.name}`, !!on);
    if (!on) {
      this.setBrief({ status: 'idle', headline: `${this.name} is disabled.`, recommendations: [] });
    } else {
      this.analyze?.();
    }
    return this.isEnabled();
  }

  on(event, handler) {
    const wrapped = (payload) => {
      if (!this.isEnabled()) return; // a disabled manager neither analyses nor acts
      try {
        handler(payload);
      } catch (err) {
        this.reportError(`handler for ${event}`, err);
      }
    };
    bus.on(event, wrapped);
    this._subs.push({ event, wrapped });
  }

  /**
   * Report a failure: log it AND route a structured message to the Reliability
   * manager so failures are correlated in one place instead of scattered across
   * per-manager logs. This is the managers' shared error-handling channel.
   */
  reportError(context, err) {
    const msg = err?.message || String(err);
    this.log.error(`${context} failed: ${msg}`);
    if (this.name !== 'Reliability') {
      try {
        this.send('Reliability', 'error', { context, error: msg }, { severity: 'error', title: `${this.name}: ${context} failed` });
      } catch {
        /* error reporting must never throw */
      }
    }
  }

  setPeers(names) {
    this._peers = names.filter((n) => n !== this.name);
  }

  /**
   * PUBLISH SOMETHING THE REST OF THE FLEET NEEDS TO KNOW.
   *
   * The peer channel existed and carried exactly one kind of traffic: `reportError`. Thirteen
   * managers, each watching a different dimension of the system, and the only thing any of them
   * ever told another was that one of its own handlers had thrown. A manager that notices the app
   * has stopped booting, that a gate keeps rejecting the same area, or that reliability is
   * degrading held that knowledge on its own dashboard card while the planner went on choosing
   * work as though nothing were wrong.
   *
   * A broadcast does three things at once, because a finding that reaches only one of them is a
   * finding that changes nothing:
   *
   *   1. it messages every peer, so a manager can react in its own analysis;
   *   2. it is written to shared memory, so it survives the run and reaches AGENTS — the memory
   *      blurb is already injected into the planner, the implementer and the graders;
   *   3. it is emitted on the bus, so the dashboard shows the coordination as it happens.
   *
   * Named `shareFinding`, not `broadcast`: `broadcast()` already exists below and already has four
   * call sites. Defining a second method of the same name in one class body is not an error in
   * JavaScript — the later definition silently wins and the earlier one is dead code, which is how
   * a duplicate definition survives review.
   *
   * @param {'risk'|'insight'|'blocker'} kind  what sort of knowledge this is
   * @param {string} title    one line, the finding itself
   * @param {string} detail   what to do about it, or why it matters
   * @param {{severity?: string, area?: string|null}} opts
   */
  shareFinding(kind, title, detail = '', { severity = 'warn', area = null } = {}) {
    if (!title) return;
    try {
      // 1. the peers, through the existing channel.
      this.broadcast(kind, { title, detail, area }, { severity, title: `${this.name}: ${title}` });
      // 2. the agents, through shared memory — scoped where they will look. An area-specific risk
      //    reaches whoever works that area; a general one reaches everyone via `global`.
      this.remember(kind === 'risk' ? 'pitfall' : 'insight', title, detail, area ? `area:${area}` : 'global');
      // 3. the operator, live.
      busEmit('manager.finding', { from: this.name, kind, title, detail, area, severity });
    } catch (err) {
      // A coordination channel must not be able to break the manager using it.
      this.log.debug?.(`shareFinding failed: ${err.message}`);
    }
  }

  /**
   * What the other managers currently see. Read this before concluding anything on your own:
   * "tests are failing" means something different when Workbench is reporting the app does not
   * boot at all.
   */
  peerConcerns() {
    try {
      return (getAllManagerBriefs() || [])
        .filter((b) => b && b.name !== this.name && (b.status === 'alert' || b.status === 'acting'))
        .map((b) => ({ name: b.name, status: b.status, headline: b.headline, recommendation: b.recommendations?.[0] || null }));
    } catch {
      return [];
    }
  }

  /**
   * UN ALLARME È GIÀ UNA SEGNALAZIONE.
   *
   * Misurato: su tredici manager, due soltanto chiamavano `shareFinding`. Gli altri cinque che
   * vanno in allarme ne sollevavano dieci in tutto, e nessuno li sentiva — restavano un colore
   * nella dashboard. Il canale funzionava; semplicemente quasi nessuno lo usava.
   *
   * Scrivere a mano una chiamata a ogni punto d'allarme è il rimedio fragile: dieci punti oggi,
   * e il prossimo manager che qualcuno aggiunge ricomincia da zero — è esattamente come la posta
   * in arrivo era collegata da un manager su tredici. Quindi lo fa la classe base.
   *
   * Due condizioni, perché il costo di sbagliare qui è alto: `shareFinding` scrive in memoria
   * condivisa, e la memoria condivisa finisce nei prompt degli agenti, dove le righe sono poche
   * e contate.
   *   - solo sulla TRANSIZIONE verso l'allarme, non a ogni pubblicazione;
   *   - solo se il titolo è cambiato, così un allarme che lampeggia non ripete se stesso.
   */
  setBrief(patch) {
    const prima = this.brief.status;
    const titoloPrima = this.brief.headline;
    Object.assign(this.brief, patch);
    this.brief.lastEventAt = Date.now();

    const entraInAllarme = this.brief.status === 'alert' && prima !== 'alert';
    const titoloNuovo = this.brief.headline && this.brief.headline !== titoloPrima;
    if (entraInAllarme && titoloNuovo && this.brief.headline !== this._lastShared) {
      this._lastShared = this.brief.headline;
      this.shareFinding('risk', this.brief.headline, this.brief.recommendations?.[0] || this.brief.summary || '');
    }

    this._publish();
  }

  /**
   * La posta in arrivo: cosa i pari hanno detto a QUESTO manager.
   *
   * `send()` scriveva nel database ed emetteva sul bus, e lì finiva. L'unico iscritto a
   * `manager.message` usava l'evento come campanello — richiamava la propria analisi senza mai
   * aprire il payload — e l'unico vero lettore dei messaggi salvati era la dashboard. I manager
   * comunicavano con l'operatore, non fra loro.
   *
   * Qui ogni manager tiene le ultime cose che gli sono state dette, così `analyze()` può
   * consultarle. Capienza fissa: una coda che cresce diventa una perdita di memoria in un processo
   * che resta acceso per giorni, e un messaggio di ieri non cambia una decisione di adesso.
   */
  inbox({ kind = null, limit = 10 } = {}) {
    const items = kind ? this._inbox.filter((m) => m.kind === kind) : this._inbox;
    return items.slice(-limit);
  }

  /**
   * Il contesto che cambia il significato della propria conclusione.
   *
   * "I test falliscono" vuol dire una cosa diversa quando Workbench sta segnalando che
   * l'applicazione non si avvia affatto. `peerConcerns()` esisteva già, scritta esattamente per
   * questo, e non la chiamava nessuno: allegarla qui la rende viva per tutti i manager in una volta
   * sola, e la porta dove serve — nel brief che la dashboard mostra e che `managerConcerns()` passa
   * al planner.
   *
   * Solo quando questo manager è in allarme: a riposo il contesto dei pari è rumore, e questo
   * metodo gira a ogni pubblicazione.
   */
  _attachPeerContext() {
    if (this.brief.status !== 'alert' && this.brief.status !== 'acting') {
      if (this.brief.peerContext) this.brief.peerContext = null;
      return;
    }
    // `peerConcerns` restituisce solo nome, stato, titolo e una raccomandazione: non copia il
    // peerContext altrui, quindi i brief non si annidano l'uno nell'altro a ogni pubblicazione.
    const peers = this.peerConcerns();
    this.brief.peerContext = peers.length ? peers : null;
  }

  _publish() {
    try {
      this._attachPeerContext();
      publishManagerBrief(this.name, this.brief);
      busEmit('manager.brief', { manager: this.name, brief: this.brief });
    } catch {
      /* ignore */
    }
  }

  /**
   * Si iscrive alla propria posta. Nella classe base di proposito: un canale che ogni sottoclasse
   * deve ricordarsi di collegare e' un canale che meta' delle sottoclassi non collega — ed e'
   * esattamente com'era prima, con un solo manager iscritto a `manager.message` su tredici.
   */
  _listenForMessages() {
    this.on('manager.message', (e) => {
      if (!e || e.from === this.name) return;
      if (e.to !== this.name && e.to !== 'broadcast') return;
      this._inbox.push({
        from: e.from, kind: e.kind, title: e.title || null,
        severity: e.severity || 'info', payload: e.payload, at: Date.now(),
      });
      if (this._inbox.length > this._inboxMax) this._inbox.shift();
    });
  }

  start() {
    if (this._timer) return;
    this._listenForMessages();
    this._publish();
    this._timer = setInterval(() => this._publish(), this.publishIntervalMs);
    if (this._timer.unref) this._timer.unref();
  }

  stop() {
    if (this._timer) clearInterval(this._timer);
    this._timer = null;
    for (const { event, wrapped } of this._subs) bus.off(event, wrapped);
    this._subs = [];
  }

  /** Message a peer (or 'broadcast'). Persisted + emitted for the coordination log. */
  send(target, kind, payload, opts = {}) {
    sendManagerMessage(this.name, target, kind, payload, opts);
    busEmit('manager.message', {
      from: this.name,
      to: target,
      kind,
      severity: opts.severity || 'info',
      title: opts.title,
      payload,
    });
    if (opts.severity === 'error' || opts.severity === 'critical') {
      this.log.warn(`→ ${target}: ${opts.title || kind}`);
    }
  }

  broadcast(kind, payload, opts = {}) {
    this.send('broadcast', kind, payload, opts);
  }

  readPeer(name) {
    return getManagerBrief(name);
  }
  readAllPeers() {
    return getAllManagerBriefs().filter((b) => b.name !== this.name);
  }

  /* ----------------------------- shared memory ---------------------------- */
  // Managers write insights the whole fleet can read, and read what's been learned.

  /**
   * @param {string} kind
   * @param {string} title
   * @param {string} content
   * @param {string|null} scope  where this belongs. Defaults to this manager's own scope.
   *
   * The default is deliberately private, and that is the point of the parameter. `recall()` reads
   * `global` plus the scopes a caller asks for — an agent asks for `agent:<id>` and `area:<x>` — so
   * anything written under `manager:<name>` is visible on the Memory page and to nobody else.
   * Findings that the fleet should act on have to be written where the fleet looks, which is what
   * `broadcast()` does.
   */
  remember(kind, title, content = '', scope = null) {
    try {
      memRemember({ scope: scope || `manager:${this.name}`, kind, title, content, source: `manager:${this.name}` });
    } catch {
      /* memory is best-effort */
    }
  }

  recall(limit = 8) {
    try {
      return memRecall({ scopes: [`manager:${this.name}`], limit });
    } catch {
      return [];
    }
  }

  /* --------------------------- decision network --------------------------- */
  // Every manager can consult the learned (agent × area) competence graph to make
  // smarter calls — reroute work away from a failing pairing, flag a weak specialist,
  // double down on a strong one.

  decisionInsight() {
    try {
      return networkInsight();
    } catch {
      return '';
    }
  }

  decisions() {
    try {
      return networkSnapshot();
    } catch {
      return { agents: [], strong: [], weak: [] };
    }
  }
}
