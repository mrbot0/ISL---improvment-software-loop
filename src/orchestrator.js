import { autonomy } from './config.js';
import { emit } from './bus.js';
import { computeMetrics, countPending, getAgent, getSetting, listAgents, listRuns, markStaleProposals, setSetting } from './db.js';
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
 */
class Orchestrator {
  constructor() {
    this.queue = [];
    this.current = null; // { agentId, runId, abort }
    this.draining = false;
  }

  get maxPending() {
    return getSetting('maxPendingProposals', autonomy.maxPendingProposals);
  }

  state() {
    return {
      maxPending: this.maxPending,
      pending: countPending(),
      queued: this.queue.map((j) => j.agentId),
      current: this.current ? { agentId: this.current.agentId, runId: this.current.runId } : null,
      applyMode: getSetting('applyMode', autonomy.applyMode),
      headCommit: headCommit().slice(0, 8),
    };
  }

  /* -------------------------------- queueing ------------------------------- */

  enqueue(agentId, { trigger = 'manual', instruction = null } = {}) {
    const agent = getAgent(agentId);
    if (!agent) throw new Error(`Unknown agent: ${agentId}`);
    const job = { agentId, trigger, instruction, queuedAt: Date.now() };
    this.queue.push(job);
    emit('agent.queued', { agentId, trigger, position: this.queue.length });
    this.drain();
    return { queued: true, position: this.queue.length };
  }

  async drain() {
    if (this.draining) return;
    this.draining = true;
    try {
      while (this.queue.length) {
        const job = this.queue.shift();
        const agent = getAgent(job.agentId);
        if (!agent) continue;

        const abort = new AbortController();
        this.current = { agentId: agent.id, runId: null, abort };

        let result;
        try {
          result = await runAgent(agent, {
            trigger: job.trigger,
            instruction: job.instruction,
            signal: abort.signal,
          });
        } catch (err) {
          emit('agent.error', { agentId: agent.id, error: err.message });
          continue;
        } finally {
          this.current = null;
        }

        // A commit landing mid-run invalidates every open proposal's base.
        const stale = markStaleProposals(headCommit());
        if (stale) emit('config.changed', { note: `${stale} proposal(s) marked stale — HEAD moved` });

        for (const id of result.proposalIds) {
          try {
            await verifyProposal(id);
          } catch (err) {
            emit('agent.error', { agentId: agent.id, error: `verify #${id}: ${err.message}` });
          }
        }
      }
    } finally {
      this.draining = false;
    }
  }

  cancelCurrent() {
    if (!this.current) return { cancelled: false };
    this.current.abort.abort();
    return { cancelled: true, agentId: this.current.agentId };
  }

  /* ------------------------------- settings -------------------------------- */

  setMaxPending(n) {
    setSetting('maxPendingProposals', Math.max(1, Number(n) || 20));
    emit('config.changed', { maxPending: this.maxPending });
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
