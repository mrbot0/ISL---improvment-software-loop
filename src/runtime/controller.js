import { emit } from '../bus.js';
import { log } from '../logger.js';
import { getSetting, setSetting } from '../db.js';
import {
  dockerStatus,
  down,
  followLogs,
  logsTail,
  services,
  targetDir,
  up,
  WORK_BRANCH,
  getComposeFile,
  setComposeFile,
  discoverComposeFiles,
  browseDir,
} from './compose.js';
import { ERROR_PATTERNS, applyFix, diagnoseAndFix } from './opsAgent.js';

const MAX_LOG_LINES = 500;
const MAX_HEAL_ATTEMPTS = 3;

/**
 * Runs the target project's stack for one selected target (main | work), streams its logs,
 * and — when auto-heal is on — lets the Ops agent diagnose failures, apply a fix,
 * and restart, up to a bounded number of attempts.
 */
class RuntimeController {
  constructor() {
    this.target = 'main';
    this.state = 'stopped'; // stopped | starting | up | error | healing
    this.logBuffer = [];
    this.logFollower = null;
    this.busy = false;
    this.lastError = null;
    this.healAttempts = 0;
    this.services = [];
    this._healTimer = null;
  }

  get autoHeal() {
    return getSetting('runtimeAutoHeal', true);
  }

  status() {
    return {
      target: this.target,
      state: this.state,
      autoHeal: this.autoHeal,
      docker: dockerStatus(),
      services: this.services,
      healAttempts: this.healAttempts,
      lastError: this.lastError,
      workBranch: WORK_BRANCH,
      composeFile: getComposeFile(),
      composeFiles: discoverComposeFiles(),
      logs: this.logBuffer.slice(-MAX_LOG_LINES),
    };
  }

  /** Choose which compose file the runtime uses. Takes effect on the next up/restart. */
  setComposeFile(rel) {
    const file = setComposeFile(rel);
    this._log(`compose file → ${file}${this.state === 'up' ? ' (restart to apply)' : ''}`);
    emit('runtime.state', { target: this.target, state: this.state, composeFile: file });
    return this.status();
  }

  /** List discovered compose files. */
  listComposeFiles() {
    return discoverComposeFiles();
  }

  /** Browse the project folders to pick a compose file manually. */
  browse(dir) {
    return browseDir(dir);
  }

  _log(line, level = 'info') {
    const entry = { ts: Date.now(), line, level };
    this.logBuffer.push(entry);
    if (this.logBuffer.length > MAX_LOG_LINES + 100) this.logBuffer = this.logBuffer.slice(-MAX_LOG_LINES);
    emit('runtime.log', entry);
  }

  _setState(state, extra = {}) {
    this.state = state;
    emit('runtime.state', { target: this.target, state, ...extra });
  }

  setTarget(target) {
    const t = target === 'work' ? 'work' : 'main';
    if (t === this.target) return this.status();
    this.target = t;
    this.logBuffer = [];
    this._log(`switched target to ${t}`);
    emit('runtime.state', { target: t, state: this.state });
    return this.status();
  }

  setAutoHeal(on) {
    setSetting('runtimeAutoHeal', !!on);
    return this.status();
  }

  /**
   * ADOPT CONTAINERS ISL DID NOT START.
   *
   * `refreshServices` was only ever called from `up()` and the heal path, so the service list was
   * populated exactly when ISL had launched the stack itself. Start it from a terminal — which is
   * how it is usually started — and Runtime showed "stopped" with an empty list indefinitely, while
   * eight containers ran happily alongside. That made every per-service control unreachable in the
   * one situation where an operator most wants them: something is wrong with one container and they
   * are looking at the page to deal with it.
   *
   * `docker compose ps` already reports whatever is running for this compose file, whoever started
   * it. Reading it is enough; nothing here starts, stops or changes anything. Cached briefly
   * because the dashboard polls, and each call spawns a docker process.
   */
  async observe() {
    const now = Date.now();
    if (now - (this._observedAt || 0) < 4000) return this.status();
    this._observedAt = now;
    await this.refreshServices();

    // Only adopt or release between the two settled states. A stack mid-`up`, healing or in error
    // is being driven by this process, and its own transitions must not be second-guessed by a poll.
    const anyUp = this.services.some((s) => /run|healthy|up/i.test(s.state));
    if (anyUp && this.state === 'stopped') this._setState('up', { adopted: true });
    else if (!anyUp && this.state === 'up') this._setState('stopped', { adopted: true });
    return this.status();
  }

  async refreshServices() {
    try {
      this.services = await services(this.target);
    } catch {
      this.services = [];
    }
    return this.services;
  }

  _startFollowing() {
    this.logFollower?.stop();
    this.logFollower = followLogs(this.target, (line) => {
      const level = ERROR_PATTERNS.test(line) ? 'error' : 'info';
      this._log(line, level);
      if (level === 'error' && this.autoHeal && this.state === 'up') this._scheduleHeal('log error');
    });
  }

  /** Debounced heal trigger — collapse a burst of error lines into one heal pass. */
  _scheduleHeal(reason) {
    if (this._healTimer || this.state === 'healing') return;
    this._healTimer = setTimeout(() => {
      this._healTimer = null;
      this.heal(reason).catch((e) => this._log(`heal failed: ${e.message}`, 'error'));
    }, 4000);
    if (this._healTimer.unref) this._healTimer.unref();
  }

  async up() {
    if (this.busy) return { busy: true };
    this.busy = true;
    this.healAttempts = 0;
    this.lastError = null;
    const d = dockerStatus();
    if (!d.running) {
      this.busy = false;
      this.lastError = d.error;
      this._setState('error', { error: d.error });
      this._log(d.error, 'error');
      return this.status();
    }
    try {
      // Bring the other target down first — they share ports/container names.
      const other = this.target === 'main' ? 'work' : 'main';
      await down(other).catch(() => {});

      this._setState('starting');
      this._log(`docker compose up (${this.target})…`);
      const r = await up(this.target);
      r.output.split('\n').filter(Boolean).slice(-30).forEach((l) => this._log(l, ERROR_PATTERNS.test(l) ? 'error' : 'info'));
      await this.refreshServices();

      if (r.ok) {
        this._setState('up');
        this._log(`stack is up on ${this.target} — frontend :5173, backend :4000`);
        this._startFollowing();
      } else {
        this.lastError = `compose up exited ${r.exitCode}`;
        this._setState('error', { error: this.lastError });
        if (this.autoHeal) await this.heal('up failed', r.output);
      }
    } finally {
      this.busy = false;
    }
    return this.status();
  }

  async down() {
    this.logFollower?.stop();
    this.logFollower = null;
    this._log(`docker compose down (${this.target})…`);
    await down(this.target).catch(() => {});
    this.services = [];
    this._setState('stopped');
    return this.status();
  }

  async restart() {
    await this.down();
    return this.up();
  }

  /** Diagnose the current failure and, if fixable, apply + restart. Bounded. */
  async heal(reason, extraLogs = '') {
    if (this.healAttempts >= MAX_HEAL_ATTEMPTS) {
      this._log(`gave up after ${MAX_HEAL_ATTEMPTS} heal attempts — needs a human`, 'error');
      this._setState('error', { error: 'auto-heal exhausted' });
      return;
    }
    this.healAttempts++;
    this._setState('healing');
    this._log(`Ops agent healing (attempt ${this.healAttempts}/${MAX_HEAL_ATTEMPTS}) — ${reason}`);

    const tail = extraLogs || this.logBuffer.slice(-80).map((l) => l.line).join('\n');
    const root = targetDir(this.target);
    let fix;
    try {
      fix = await diagnoseAndFix({ target: this.target, targetRoot: root, logs: tail });
    } catch (e) {
      this._log(`diagnosis error: ${e.message}`, 'error');
    }

    if (!fix) {
      this._log('Ops agent could not diagnose the failure.', 'error');
      this._setState('error', { error: 'undiagnosed' });
      return;
    }
    this._log(`diagnosis: ${(fix.diagnosis || '').slice(0, 200)}`);
    if (!fix.path) {
      this._log('not auto-fixable (environment issue) — see diagnosis.', 'error');
      this._setState('error', { error: fix.diagnosis || 'not fixable' });
      return;
    }

    try {
      applyFix(root, fix);
      this._log(`applied fix to ${fix.path}: ${fix.summary}. Restarting…`);
    } catch (e) {
      this._log(`could not apply fix: ${e.message}`, 'error');
      this._setState('error', { error: e.message });
      return;
    }
    // Restart to pick up the fix (dev containers hot-reload, but rebuild to be safe).
    const r = await up(this.target);
    await this.refreshServices();
    if (r.ok) {
      this._setState('up');
      this._log('restart succeeded after fix.', 'info');
      this._startFollowing();
      emit('ops.healed', { target: this.target, attempts: this.healAttempts });
      log.info('ops-agent', `healed ${this.target} after ${this.healAttempts} attempt(s)`);
    } else if (this.autoHeal) {
      await this.heal('still failing after fix', r.output);
    } else {
      this._setState('error', { error: 'still failing' });
    }
  }
}

export const runtimeController = new RuntimeController();
