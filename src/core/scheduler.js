/**
 * Conflict-aware wave scheduler.
 *
 * Tasks in one iteration are mostly independent — "add a rate limit to auth" and
 * "paginate the listings query" have nothing to do with each other and there is no
 * reason to run them one after the other. But two tasks that edit the SAME file
 * cannot run in parallel sandboxes: their diffs would collide at merge time and
 * one would silently clobber the other.
 *
 * So we partition the batch into waves. Within a wave, no two tasks declare an
 * overlapping file; across waves, order is preserved. Each wave runs concurrently,
 * and the next wave starts from the merged result of the previous one — so a task
 * that follows a conflicting one still sees its predecessor's edits.
 */

/** Normalise a task's declared file set (the planner gives paths; be forgiving). */
function fileSet(task) {
  const files = Array.isArray(task.files) ? task.files : [];
  return new Set(files.map((f) => String(f).replace(/\\/g, '/').replace(/^\.?\//, '')).filter(Boolean));
}

/** Do two tasks contend for the same file? Directory-level heuristics stay out of it. */
function conflicts(a, b) {
  for (const f of a) if (b.has(f)) return true;
  return false;
}

/**
 * Group tasks into waves of mutually non-conflicting work.
 *
 * A task with NO declared files is treated as conflicting with everything: we
 * cannot prove it is safe to run alongside anything else, so it gets a wave of its
 * own. That's the conservative choice, and it's rare — the planner is asked for
 * explicit file lists.
 *
 * @param {Array} tasks
 * @param {number} maxParallel  cap on wave width (the model is the bottleneck)
 * @returns {Array<Array<{task, index}>>} waves, each an array of {task, index}
 */
export function planWaves(tasks, maxParallel = 2) {
  const width = Math.max(1, maxParallel);
  const items = tasks.map((task, index) => ({ task, index, files: fileSet(task) }));
  const waves = [];
  const placed = new Set();

  for (const item of items) {
    if (placed.has(item.index)) continue;

    // Unknown blast radius → run it alone.
    if (item.files.size === 0) {
      waves.push([item]);
      placed.add(item.index);
      continue;
    }

    // Seed a new wave and greedily fill it with later tasks that don't collide
    // with anything already in it.
    const wave = [item];
    const claimed = new Set(item.files);
    placed.add(item.index);

    for (const other of items) {
      if (wave.length >= width) break;
      if (placed.has(other.index) || other.files.size === 0) continue;
      if (conflicts(claimed, other.files)) continue;
      wave.push(other);
      other.files.forEach((f) => claimed.add(f));
      placed.add(other.index);
    }
    waves.push(wave);
  }
  return waves;
}

/** Human-readable plan of the waves, for the log and the dashboard. */
export function describeWaves(waves) {
  return waves
    .map((w, i) => `wave ${i + 1}: ${w.map((x) => x.task.title.slice(0, 40)).join(' ‖ ')}`)
    .join('\n');
}

/** How much wall-clock the wave plan saves versus running everything serially. */
export function parallelism(waves) {
  const total = waves.reduce((n, w) => n + w.length, 0);
  return { tasks: total, waves: waves.length, widest: Math.max(0, ...waves.map((w) => w.length)) };
}
