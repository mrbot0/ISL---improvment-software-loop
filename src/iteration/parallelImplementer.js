import { createSandbox, removeWorktree, changedFiles, copyFiles } from '../sandbox/worktree.js';
import { planWaves, describeWaves, parallelism } from '../core/scheduler.js';
import { mapLimit } from '../core/semaphore.js';
import { runTask } from './implementer.js';
import { emit } from '../bus.js';
import { log } from '../logger.js';

/**
 * Parallel batch implementer.
 *
 * The old executor ran tasks one after another against a single sandbox. That is
 * simple and it is slow: an iteration with four tasks spent four times as long as
 * it needed to, because "add a rate limit to auth" and "paginate the listings
 * query" have nothing to do with each other and were still made to queue.
 *
 * Here, tasks are grouped into waves of mutually non-conflicting work (see
 * core/scheduler.js) and each wave runs concurrently, every task in its own
 * throwaway sandbox. Because no two tasks in a wave touch the same file, folding
 * their results back together is a copy, not a merge — there is no conflict to
 * resolve. Later waves are seeded with everything the earlier ones produced, so a
 * task that *does* depend on a previous edit still sees it.
 *
 * The model itself remains the bottleneck and stays behind a semaphore (llmGate),
 * so widening parallelism never oversubscribes the GPU — it just means one task can
 * be running tests while another is thinking, which is exactly the win we want.
 */
export async function implementParallel({
  accumulator, // the sandbox that ends up holding the whole iteration's change
  base, // commit the sandboxes are cut from
  tasks,
  taskIds,
  iterationId,
  iterationBrief = null,
  maxParallel = 2,
  onTaskStart,
  onTaskFinish,
  signal,
  logger = log.for('implementer'),
}) {
  const waves = planWaves(tasks, maxParallel);
  const shape = parallelism(waves);
  const serialEstimate = tasks.length;

  emit('iteration.waves', {
    iterationId,
    waves: waves.map((w, i) => ({ wave: i + 1, tasks: w.map((x) => ({ index: x.index, title: x.task.title, agent: x.task.agent })) })),
    widest: shape.widest,
  });
  logger.info?.(
    `${tasks.length} task(s) → ${waves.length} wave(s), up to ${shape.widest} in parallel\n${describeWaves(waves)}`,
    { runId: iterationId },
  );

  const results = new Array(tasks.length);
  let tokensIn = 0;
  let tokensOut = 0;
  const startedAt = Date.now();
  let serialMs = 0; // summed task time — what a serial run would have cost

  for (let w = 0; w < waves.length; w++) {
    if (signal?.aborted) throw new Error('interrupted');
    const wave = waves[w];
    emit('iteration.wave_started', { iterationId, wave: w + 1, total: waves.length, tasks: wave.length });

    // Whatever previous waves produced must be visible to this one.
    const carry = changedFiles(accumulator);

    const outcomes = await mapLimit(wave, wave.length, async ({ task, index }) => {
      if (signal?.aborted) throw new Error('interrupted');

      // A wave of one doesn't need its own sandbox — work straight in the accumulator.
      const solo = wave.length === 1;
      const root = solo ? accumulator : createSandbox([], base);
      if (!solo && carry.length) copyFiles(accumulator, root, carry);

      const t0 = Date.now();
      onTaskStart?.({ index, task, wave: w + 1 });
      emit('impl.task_started', { iterationId, index: index + 1, total: tasks.length, title: task.title, kind: task.kind, agent: task.agent, wave: w + 1 });

      // The peers this task runs beside: every other task in the iteration. The
      // Context Agent turns this into "what the rest of the fleet is doing now".
      const siblings = tasks.filter((_, j) => j !== index).map((t) => ({ agent: t.agent, title: t.title, area: t.area }));

      try {
        const r = await runTask(root, task, { iterationId, signal, iterationBrief, siblings });
        r.ms = Date.now() - t0;

        // Fold this task's edits into the accumulator. Safe by construction: no
        // other task in this wave declared any of these files.
        if (!solo && r.filesChanged.length) copyFiles(root, accumulator, r.filesChanged);

        return r;
      } finally {
        if (!solo) removeWorktree(root);
      }
    });

    // Record the wave.
    let waveMs = 0;
    outcomes.forEach((o, i) => {
      const { task, index } = wave[i];
      const r = o.ok
        ? o.value
        : { ok: false, summary: o.error?.message || 'task failed', filesChanged: [], steps: 0, tokensIn: 0, tokensOut: 0, ms: 0, error: o.error?.message };

      // An interruption is not a task failure — it must abort the whole iteration.
      if (!o.ok && o.error?.message === 'interrupted') throw o.error;

      results[index] = r;
      tokensIn += r.tokensIn || 0;
      tokensOut += r.tokensOut || 0;
      serialMs += r.ms || 0;
      waveMs = Math.max(waveMs, r.ms || 0);

      onTaskFinish?.({ index, task, result: r, wave: w + 1, taskId: taskIds?.[index] });
      emit('impl.task_finished', {
        iterationId,
        index: index + 1,
        title: task.title,
        ok: r.ok,
        files: r.filesChanged.length,
        agent: task.agent,
        wave: w + 1,
        ms: r.ms,
      });
    });

    emit('iteration.wave_finished', { iterationId, wave: w + 1, ms: waveMs });
  }

  const wallMs = Date.now() - startedAt;
  const savedMs = Math.max(0, serialMs - wallMs);
  const done = results.filter((r) => r?.ok).length;
  const touched = new Set();
  results.forEach((r) => r?.filesChanged?.forEach((f) => touched.add(f)));

  logger.info?.(
    `${done}/${tasks.length} task(s) landed · ${touched.size} file(s) · ` +
      `${Math.round(wallMs / 1000)}s wall vs ~${Math.round(serialMs / 1000)}s serial (saved ~${Math.round(savedMs / 1000)}s)`,
    { runId: iterationId },
  );

  return {
    results,
    touched: [...touched],
    waves: waves.map((w, i) => ({ wave: i + 1, tasks: w.map((x) => x.index) })),
    summary: `${done}/${tasks.length} task(s) applied · ${touched.size} file(s) changed · ${waves.length} wave(s), ~${Math.round(savedMs / 1000)}s saved by running in parallel`,
    savedMs,
    wallMs,
    serialMs,
    serialEstimate,
    tokensIn,
    tokensOut,
  };
}
