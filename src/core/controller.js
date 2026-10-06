import { iteration as cfg, autonomy } from '../config.js';
import { emit, bus } from '../bus.js';
import { log } from '../logger.js';
import { getSetting, setSetting, countPending } from '../db.js';
import { countTodayIterations, getKpi, setKpi, listRestartable, listSalvageable } from '../db_iteration.js';
import { runIteration, restartIteration } from '../iteration/engine.js';
import { orchestrator } from '../orchestrator.js';
import { llmGate } from './semaphore.js';
import { headCommit } from '../sandbox/worktree.js';
import { acquireLeadership, releaseLeadership, leadershipStatus, queueStats, WORKER_ID } from './workQueue.js';

/** The role that owns the iteration loop. Exactly one process may hold it. */
const LOOP_ROLE = 'iteration-loop';
// Comfortably longer than the tick interval, so a leader that is merely busy in a long iteration
// does not lose the role it still holds. A dead leader costs at most this long before a successor
// takes over — an acceptable pause, where a split-brain loop is not.
const LEADER_TTL_MS = 15 * 60_000;

/**
 * The single control plane.
 *
 * There used to be two loops. The orchestrator ran a fleet of proposal agents on
 * one timer; the iteration controller ran a nine-phase pipeline on another. They
 * competed for the same GPU, produced two different kinds of output, and gave the
 * operator two switches that each looked like "the" switch — with no way to reason
 * about what the system was actually doing.
 *
 * There is now one loop and one switch. The iteration pipeline is the system: it
 * plans a batch, routes each task to the specialist who should write it, runs the
 * independent ones in parallel, boots the app to prove it still works, and commits.
 * The old proposal agents did not disappear — they became the personas the
 * implementer wears (see iteration/implementer.js), and they can still be run
 * one-off, on demand, when you want a review pass rather than a change.
 */
class UnifiedController {
  constructor() {
    this.timer = null;
    this.running = false; // an iteration is executing right now
    this.abort = null;
    this.current = null; // iterationId
    this.lastResult = null;
  }

  /* -------------------------------- settings ------------------------------- */

  get intervalSeconds() {
    return getSetting('iterationIntervalSeconds', cfg.intervalSeconds);
  }
  get looping() {
    return this.timer !== null;
  }
  get maxParallel() {
    return Math.max(1, Math.round(getKpi().max_parallel_tasks ?? 2));
  }
  get maxPending() {
    return getSetting('maxPendingProposals', autonomy.maxPendingProposals);
  }

  state() {
    const kpi = getKpi();
    return {
      looping: this.looping,
      running: this.running,
      current: this.current,
      intervalSeconds: this.intervalSeconds,
      workBranch: cfg.workBranch,
      todayCount: countTodayIterations(),
      maxPerDay: cfg.maxPerDay,
      headCommit: headCommit().slice(0, 8),

      // Who is actually driving. With one server this is always this process; it stops being
      // rhetorical the moment a second one exists.
      worker: WORKER_ID,
      leadership: leadershipStatus(LOOP_ROLE),
      queue: queueStats(),

      // Parallelism, surfaced so the operator can see and tune what it costs.
      parallel: {
        maxTasks: this.maxParallel,
        llmInFlight: llmGate.active,
        llmQueued: llmGate.pending,
      },
      batch: {
        improvements: Math.round(kpi.improvements_per_iter ?? 3),
        features: Math.round(kpi.features_per_iter ?? 2),
      },

      // Failed runs waiting to be picked back up.
      restartable: listRestartable(10).map((i) => ({
        id: i.id,
        status: i.status,
        failure: i.failure,
        filesChanged: i.filesChanged,
        restarts: i.restarts,
      })),

      // The one-off proposal fleet still exists; it just no longer has its own loop.
      fleet: {
        pending: countPending(),
        maxPending: this.maxPending,
        current: orchestrator.state().current,
        queued: orchestrator.state().queued,
      },
    };
  }

  /* --------------------------------- loop ---------------------------------- */

  start() {
    // The loop's DESIRED state is persisted so it survives restarts: once armed it
    // stays armed until an explicit stop. Nothing but an explicit stop turns it off.
    setSetting('loopDesired', true);
    if (this.looping) return this.state();
    const tick = () => this.tick().catch((e) => log.error('control', `tick failed: ${e.message}`));
    this.timer = setInterval(tick, Math.max(30, this.intervalSeconds) * 1000);
    if (this.timer.unref) this.timer.unref();
    emit('control.loop', { running: true, intervalSeconds: this.intervalSeconds });
    log.info('control', `unified loop started — one iteration every ${this.intervalSeconds}s, ${this.maxParallel} task(s) in parallel`);
    tick(); // don't make the operator wait a full interval for the first run
    return this.state();
  }

  /**
   * Stop the loop. `persist` records the operator's INTENT: an explicit stop (the
   * default) means "stay stopped, even across a restart"; an internal stop — a
   * shutdown, or the stop half of a restart — passes persist:false so the loop
   * re-arms on the next boot. The loop never stops itself for any other reason.
   */
  stop({ persist = true } = {}) {
    if (persist) setSetting('loopDesired', false);
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    // Hand the role back rather than making a successor wait out the TTL. Best-effort: a crash
    // skips this, which is exactly what the expiry is for.
    try { releaseLeadership(LOOP_ROLE); } catch { /* the lease will simply expire */ }
    emit('control.loop', { running: false });
    log.info('control', 'unified loop stopped');
    return this.state();
  }

  /** Was the loop armed (running) when we last knew? Drives auto-resume on boot. */
  get desiredRunning() {
    return getSetting('loopDesired', null);
  }

  /** Interrupt the in-flight iteration at the next phase boundary. */
  cancel() {
    if (!this.abort) return { cancelled: false };
    this.abort.abort();
    log.info('control', `cancelling iteration #${this.current}`);
    return { cancelled: true, iterationId: this.current };
  }

  async tick() {
    if (this.running) return; // never overlap iterations — they share one work branch

    // LEADER ELECTION. `this.running` stops this PROCESS overlapping itself; it says nothing about a
    // second process. The supervisor restarts the server on a clean exit, so a slow shutdown racing
    // a fast restart can put two servers on the same database — and two loops driving one work
    // branch is how you get interleaved commits nobody can untangle. The lease makes single-writer
    // an enforced property rather than an assumption. A single server always wins it immediately.
    if (!acquireLeadership(LOOP_ROLE, LEADER_TTL_MS)) {
      const who = leadershipStatus(LOOP_ROLE);
      emit('control.tick', { skipped: 'not_leader', leader: who.holder });
      log.info('control', `another process holds the loop (${who.holder}) — standing by`);
      return;
    }

    // The daily cap is a THROTTLE, not a failure: skip the tick cleanly (no error, no
    // effect on the health streak) and let the loop keep ticking — it resumes on its
    // own after midnight. It must never look like a crash or pause the loop.
    if (countTodayIterations() >= cfg.maxPerDay) {
      emit('control.tick', { skipped: 'daily_cap', todayCount: countTodayIterations(), maxPerDay: cfg.maxPerDay });
      return;
    }

    // Backpressure is advisory only. The pipeline commits its own work to the work
    // branch — it does not add to the human review queue — so a backlog of one-off
    // proposals must NOT stop it. We surface the pressure but keep producing, because
    // the loop only ever stops on an explicit operator request.
    const pending = countPending();
    if (pending >= this.maxPending) emit('control.tick', { backpressure: true, pending, maxPending: this.maxPending });

    // SALVAGE BEFORE PLANNING. The loop auto-resumes after a restart, but it used to resume by
    // planning a brand-new batch — so every iteration in flight when the server went down was
    // abandoned mid-pipeline, diff and all. Over the last 60 runs that was the single largest
    // outcome: 42% ended "interrupted", most of them with real, reviewed work sitting in
    // pending_diff that nobody ever picked up. The commit rate was low because finished work was
    // being thrown away, not because the agents were failing.
    //
    // So: before planning anything new, finish what was already started. `listSalvageable` is the
    // narrow, crash-loop-safe subset (see its comment) — judged failures are never in it.
    const [salvage] = listSalvageable(1);
    if (salvage) {
      emit('control.tick', { salvaging: salvage.id, filesChanged: salvage.filesChanged, attempt: (salvage.restarts || 0) + 1 });
      log.info('control', `picking #${salvage.id} back up — it was cut short by a server restart with ${salvage.filesChanged} file(s) already changed`);
      await this.restart(salvage.id);
      return;
    }

    await this.runOnce('loop');
  }

  /* ------------------------------- execution -------------------------------- */

  async _execute(fn, label) {
    if (this.running) return { busy: true };
    this.running = true;
    this.abort = new AbortController();

    // IDLE watchdog. The old watchdog was a hard wall-clock timeout: it aborted every
    // iteration at exactly `maxMinutes`, which on a slow local model is shorter than a
    // real iteration takes — so healthy, progressing runs were killed and NOTHING ever
    // committed. What we actually want to catch is a HUNG run, not a slow one. So the
    // timer now measures INACTIVITY: any pipeline event (a streamed token, a phase
    // change, a finished task) resets it. A run that is making progress runs as long as
    // it needs; only a run that goes silent for the whole window is aborted.
    const idleMs = Math.max(2, cfg.maxMinutes) * 60_000;
    let watchdog;
    let lastKick = 0;
    const arm = () => {
      watchdog = setTimeout(() => {
        if (this.abort) {
          log.warn('control', `${label} made no progress for ${cfg.maxMinutes} min — aborting (it appears hung)`);
          this.abort.abort();
        }
      }, idleMs);
      if (watchdog.unref) watchdog.unref();
    };
    // Reset on activity, throttled so a token stream doesn't churn timers every ms.
    const onActivity = (evt) => {
      // Capture the running iteration's id the moment it exists. It used to be assigned from the
      // RESULT of the run — i.e. after it had finished — and then cleared in the `finally`, so
      // `state().current` was null for the entire time a run was in flight, which is precisely when
      // anything would want to read it. The field was effectively unobservable.
      if (evt?.type === 'iteration.started' && evt.iterationId != null) this.current = evt.iterationId;

      const now = Date.now();
      if (now - lastKick < 2000) return;
      lastKick = now;
      clearTimeout(watchdog);
      arm();
    };
    arm();
    bus.on('event', onActivity);

    try {
      const r = await fn(this.abort.signal);
      this.lastResult = r;
      return r;
    } catch (err) {
      log.error('control', `${label} failed: ${err.message}`);
      return { error: err.message };
    } finally {
      bus.off('event', onActivity);
      clearTimeout(watchdog);
      this.running = false;
      this.abort = null;
      this.current = null;
    }
  }

  /**
   * Restart the loop from a clean state: cancel any in-flight (possibly hung)
   * iteration, stop the timer, and start it again. The operator's "get it going
   * again" button when the loop looks stuck or was auto-paused.
   */
  restartLoop() {
    if (this.running) this.cancel();
    this.stop();
    return this.start();
  }

  /** Run exactly one iteration now. */
  runOnce(trigger = 'manual') {
    return this._execute((signal) => runIteration({ trigger, signal }), 'iteration');
  }

  /**
   * Pick a failed run back up from the changes it had already made.
   * The engine decides where to resume based on why it died.
   */
  restart(id) {
    return this._execute((signal) => restartIteration(id, { signal }), `restart of #${id}`);
  }

  /**
   * Restart several failed/empty/interrupted runs back-to-back. The engine shares one
   * work branch so they cannot overlap — we process them sequentially in the
   * background, waiting for any in-flight run (including a loop tick) to finish
   * between each. Returns immediately with how many were queued.
   */
  restartMany(ids = []) {
    const queue = [...new Set(ids)].filter((n) => Number.isFinite(n));
    if (!queue.length) return { queued: 0 };
    (async () => {
      for (const id of queue) {
        while (this.running) await new Promise((r) => setTimeout(r, 1500));
        try {
          await this.restart(id);
        } catch (err) {
          log.error('control', `restart-all: #${id} failed: ${err.message}`);
        }
      }
      emit('control.restart_all_done', { count: queue.length });
    })();
    return { queued: queue.length };
  }

  /* ------------------------------- one-offs -------------------------------- */

  /**
   * Run a single specialist as a REVIEW pass — it produces proposals for you to
   * approve rather than committing. This is the old fleet behaviour, kept because
   * "audit the security surface and tell me what you find" is a genuinely different
   * request from "improve the code", and it should not need its own loop to exist.
   */
  runAgent(agentId, instruction = null) {
    return orchestrator.enqueue(agentId, { trigger: 'manual', instruction });
  }

  /* -------------------------------- tuning --------------------------------- */

  setInterval(seconds) {
    setSetting('iterationIntervalSeconds', Math.max(30, Number(seconds) || cfg.intervalSeconds));
    if (this.looping) {
      this.stop();
      this.start();
    }
    return this.state();
  }

  /**
   * How many tasks may run at once — and, separately, how many may be GENERATING at once.
   *
   * These were one number, and conflating them was the single largest source of instability in the
   * loop. Measured across the run history: `fetch failed` accounts for 216 of 420 task failures,
   * and **105 of the 109 iterations that hit it lost exactly two tasks** — with parallelism at two.
   * Not a network hiccup: two concurrent generations against one local Ollama holding one resident
   * model kill each other, on average 154 seconds in. Retrying does not help, because the retry
   * re-enters the same contention; the share of failures that were `fetch failed` rose from 37% to
   * 72% as parallelism was used more.
   *
   * The genuine win the semaphore was written for — "one thinking while another runs tests" —
   * requires task parallelism to EXCEED model parallelism. With both set to the same number there
   * is no staggering at all: both tasks think simultaneously, which is the one thing the hardware
   * cannot do.
   *
   * So tasks stay parallel and the model is serialised by default. `max_parallel_llm` is a separate
   * KPI for anyone running a model server that genuinely handles concurrent generations.
   */
  setParallelism(n) {
    const v = Math.min(6, Math.max(1, Number(n) || 1));
    setKpi({ max_parallel_tasks: v });
    llmGate.setLimit(llmLimit());
    emit('config.changed', { maxParallelTasks: v });
    log.info('control', `parallelism set to ${v} task(s) in flight · ${llmLimit()} generation(s) at a time`);
    return this.state();
  }

  /** How many generations may run concurrently. Independent of task parallelism — see above. */
  setLlmParallelism(n) {
    const v = Math.min(4, Math.max(1, Number(n) || 1));
    setKpi({ max_parallel_llm: v });
    llmGate.setLimit(v);
    emit('config.changed', { maxParallelLlm: v });
    log.info('control', `model concurrency set to ${v}`);
    return this.state();
  }

  /** How much work goes into each iteration. */
  setBatch({ improvements, features }) {
    const patch = {};
    if (improvements != null) patch.improvements_per_iter = Math.min(8, Math.max(0, Number(improvements) || 0));
    if (features != null) patch.features_per_iter = Math.min(6, Math.max(0, Number(features) || 0));
    setKpi(patch);
    emit('config.changed', patch);
    return this.state();
  }
}

export const controller = new UnifiedController();

/**
 * How many generations may be in flight. Defaults to ONE — see setParallelism for the measurement
 * that made serialising the model the default rather than an option.
 */
function llmLimit() {
  try {
    return Math.max(1, Math.round(getKpi().max_parallel_llm ?? 1));
  } catch {
    return 1;
  }
}

// Keep the model gate in step across restarts.
try {
  llmGate.setLimit(llmLimit());
} catch {
  /* the DB may not be ready at import time in some tooling paths */
}
