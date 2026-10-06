/**
 * Concurrency limiter.
 *
 * The whole fleet shares one Ollama process holding one large model resident in
 * memory. Firing N generations at it concurrently does not make them finish
 * sooner — they queue inside Ollama, thrash the KV cache, and every one of them
 * gets slower. So LLM work goes through a small semaphore: a couple of tasks can
 * be in flight (one thinking while another runs tests is a genuine win), but we
 * never let the queue depth run away.
 *
 * Everything that is NOT the model — git, file I/O, test runs — can go wide, and
 * uses its own, larger limiter.
 */
export class Semaphore {
  constructor(limit = 1, name = 'sem') {
    this.limit = Math.max(1, limit);
    this.name = name;
    this.active = 0;
    this.waiters = [];
  }

  get pending() {
    return this.waiters.length;
  }

  setLimit(n) {
    this.limit = Math.max(1, Number(n) || 1);
    this._pump();
  }

  _pump() {
    while (this.active < this.limit && this.waiters.length) {
      const { resolve } = this.waiters.shift();
      this.active++;
      resolve();
    }
  }

  async acquire(signal) {
    if (signal?.aborted) throw new Error('interrupted');
    if (this.active < this.limit) {
      this.active++;
      return;
    }
    await new Promise((resolve, reject) => {
      const waiter = { resolve, reject };
      this.waiters.push(waiter);
      // An aborted task must not keep holding its place in the queue.
      signal?.addEventListener?.(
        'abort',
        () => {
          const i = this.waiters.indexOf(waiter);
          if (i >= 0) {
            this.waiters.splice(i, 1);
            reject(new Error('interrupted'));
          }
        },
        { once: true },
      );
    });
  }

  release() {
    this.active = Math.max(0, this.active - 1);
    this._pump();
  }

  /** Run `fn` while holding a slot. Always releases, even on throw. */
  async run(fn, signal) {
    await this.acquire(signal);
    try {
      return await fn();
    } finally {
      this.release();
    }
  }
}

/**
 * The model gate. Every LLM call in the system funnels through this, so raising
 * task parallelism can never oversubscribe the GPU.
 */
export const llmGate = new Semaphore(1, 'llm');

/** Sandboxes, test runs, git: cheap enough to go wider. */
export const ioGate = new Semaphore(4, 'io');

/**
 * Map with bounded concurrency, preserving input order in the results.
 * Rejections are captured per-item so one bad task cannot sink the wave.
 */
export async function mapLimit(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(Math.max(1, limit), items.length || 1) }, async () => {
    while (true) {
      const i = next++;
      if (i >= items.length) return;
      try {
        results[i] = { ok: true, value: await fn(items[i], i) };
      } catch (err) {
        results[i] = { ok: false, error: err };
      }
    }
  });
  await Promise.all(workers);
  return results;
}
