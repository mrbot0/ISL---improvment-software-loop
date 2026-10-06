import { db, registerSchema } from '../db.js';
import { learnedCodes } from './lessonImpact.js';

/**
 * The fleet's SHARED MEMORY — a per-project store of what the agents and managers
 * have learned. Unlike the per-agent reflection lessons (computed on the fly from
 * recent rejections), this is durable, cross-cutting knowledge every agent and
 * manager reads and writes:
 *
 *   scope:  global | agent:<id> | manager:<Name> | area:<backend|frontend|…>
 *   kind:   lesson (do this) | pitfall (avoid this) | fix (this worked) |
 *           pattern (a recurring shape) | insight (a manager observation)
 *
 * A repeated mistake doesn't create a duplicate — it bumps the same entry's `uses`,
 * so the memory naturally weights what keeps going wrong. This is the substrate of
 * self-improvement: errors become memory, memory is injected into the next run.
 */
registerSchema(() => {
  db.exec(`
  CREATE TABLE IF NOT EXISTS memory (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    scope      TEXT NOT NULL DEFAULT 'global',
    kind       TEXT NOT NULL DEFAULT 'lesson',
    title      TEXT NOT NULL,
    content    TEXT NOT NULL DEFAULT '',
    source     TEXT,
    uses       INTEGER NOT NULL DEFAULT 1,
    pinned     INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    UNIQUE(scope, title)
  );
  CREATE INDEX IF NOT EXISTS idx_memory_scope ON memory(scope);
  CREATE INDEX IF NOT EXISTS idx_memory_uses ON memory(uses DESC);
  `);

  /*
   * ONE-TIME CLEANUP: forget what was never a lesson.
   *
   * Before `memory/lessons.js` existed, every recorded error was written as a pitfall. The result,
   * measured on a live database, was that the top of every prompt read:
   *
   *     "Recurring failure: implementation error — the implementer…"  ×77
   *     "Recurring error: fetch failed"                               ×11
   *     "Recurring failure: failed — cause not recognised"            ×20
   *
   * Nothing there tells an agent what to do differently, and the injected block is capped — so these
   * were actively displacing the lessons that do. New writes are now gated, but the existing entries
   * would keep occupying that space forever.
   *
   * Deliberately narrow: it matches the exact generated prefixes and the two failure classes that
   * are never behavioural. A hand-written or operator-pinned memory is never touched.
   */
  try {
    const gone = db.prepare(
      `DELETE FROM memory
       WHERE pinned = 0
         AND kind = 'pitfall'
         AND (
           title LIKE 'Recurring error:%'
           OR title LIKE 'Recurring failure:%'
           OR title LIKE 'Iteration failure:%'
           OR title LIKE 'Recurring verify:%'
           OR title LIKE '%cause not recognised%'
           OR content LIKE '%fetch failed%'
         )`,
    ).run().changes;
    if (gone) {
      // eslint-disable-next-line no-console
      console.log(`[memory] forgot ${gone} restated-error "lesson(s)" — they taught nothing and crowded out the ones that do`);
    }
  } catch { /* a fresh database has nothing to clean */ }
});

const now = () => Date.now();

const rowToMem = (r) => ({
  id: r.id,
  scope: r.scope,
  kind: r.kind,
  title: r.title,
  content: r.content,
  source: r.source,
  uses: r.uses,
  pinned: !!r.pinned,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
});

/**
 * Record (or reinforce) a memory. If an entry with the same scope+title exists,
 * bump its use count and refresh its content instead of duplicating.
 */
export function remember({ scope = 'global', kind = 'lesson', title, content = '', source = null }) {
  if (!title || !title.trim()) return null;
  const t = title.trim().slice(0, 200);
  const existing = db.prepare('SELECT id FROM memory WHERE scope = ? AND title = ?').get(scope, t);
  if (existing) {
    db.prepare('UPDATE memory SET uses = uses + 1, content = ?, source = ?, updated_at = ? WHERE id = ?').run(
      String(content || '').slice(0, 2000),
      source,
      now(),
      existing.id,
    );
    return existing.id;
  }
  const r = db
    .prepare('INSERT INTO memory (scope, kind, title, content, source, uses, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 1, ?, ?)')
    .run(scope, kind, t, String(content || '').slice(0, 2000), source, now(), now());
  return Number(r.lastInsertRowid);
}

/**
 * Recall the most relevant memories for a context: the given scopes, plus 'global',
 * ranked by pinned → uses → recency.
 */
export function recall({ scopes = [], limit = 12 } = {}) {
  const wanted = [...new Set(['global', ...scopes])];
  const placeholders = wanted.map(() => '?').join(',');
  /*
   * RANKING: specific before frequent.
   *
   * Ordering by `uses` alone put the most-RECURRING memory first, and the most recurring thing in a
   * system is rarely the most instructive — a network hiccup recorded eleven times outranked a
   * carefully written lesson recorded once. Worse, an agent-scoped memory (written about *this*
   * agent's own mistake) lost to a generic global one for the same reason.
   *
   * So: pinned first (an operator said so), then agent/area-scoped before global (a lesson about
   * your own work beats a lesson about everyone's), and only then recurrence and recency. The
   * scope-specific ordering matters because `limit` is small — twelve lines decide what the model
   * reads, and the ones about its own past failures are the ones it can act on.
   */
  return db
    .prepare(
      `SELECT * FROM memory
       WHERE scope IN (${placeholders})
       ORDER BY pinned DESC,
                CASE WHEN scope = 'global' THEN 1 ELSE 0 END,
                uses DESC,
                updated_at DESC
       LIMIT ?`,
    )
    .all(...wanted, limit)
    .map(rowToMem);
}

/**
 * A compact block of relevant memory for injection into a prompt. Grouped so the model
 * sees, distinctly, what to REUSE (proven wins + conventions) and what to AVOID (past
 * mistakes) — a flat list buries the signal.
 */
export function memoryBlurb({ agentId = null, area = null, extraScopes = [], limit = 12 } = {}) {
  const scopes = [];
  if (agentId) scopes.push(`agent:${agentId}`);
  if (area) scopes.push(`area:${area}`);
  scopes.push(...extraScopes);
  const mems = recall({ scopes, limit });
  if (!mems.length) return '';

  /*
   * A LEARNED LESSON STEPS ASIDE.
   *
   * This block is capped — twelve lines decide what the model reads before it starts work. A lesson
   * whose failure has not recurred since it was written is still true, but it is no longer the best
   * use of one of those lines: the fleet has demonstrably stopped making that mistake, while other
   * lessons are still being ignored.
   *
   * Stepping aside is not forgetting. The memory stays in the store, it is still visible on the
   * Memory page, and the moment the failure recurs `lessonImpact` flips its verdict and it comes
   * straight back into the prompt. Deliberately best-effort: this reads run history, and a learning
   * optimisation must never be the reason a prompt fails to build.
   */
  let learned = new Set();
  try {
    learned = new Set(learnedCodes().map((c) => `lesson:${c}`));
  } catch { /* no history yet, or the table is mid-migration */ }
  const relevant = learned.size ? mems.filter((m) => !learned.has(m.source)) : mems;
  if (!relevant.length) return '';

  const fmt = (m) => `- ${m.title}${m.content ? ` — ${m.content}` : ''}${m.uses > 1 ? ` (seen ${m.uses}×)` : ''}`;
  const wins = relevant.filter((m) => m.kind === 'pattern' || m.kind === 'fix' || m.kind === 'lesson' || m.kind === 'insight');
  const avoid = relevant.filter((m) => m.kind === 'pitfall');

  const parts = ['SHARED MEMORY — what the fleet has learned. Use it.'];
  if (wins.length) parts.push(`PROVEN — reuse these approaches:\n${wins.map(fmt).join('\n')}`);
  if (avoid.length) parts.push(`AVOID — past mistakes, do NOT repeat:\n${avoid.map(fmt).join('\n')}`);
  return parts.join('\n');
}

export const listMemory = ({ scope = null, limit = 300 } = {}) =>
  (scope
    ? db.prepare('SELECT * FROM memory WHERE scope = ? ORDER BY pinned DESC, uses DESC, updated_at DESC LIMIT ?').all(scope, limit)
    : db.prepare('SELECT * FROM memory ORDER BY pinned DESC, uses DESC, updated_at DESC LIMIT ?').all(limit)
  ).map(rowToMem);

export const countMemory = () => db.prepare('SELECT COUNT(*) n FROM memory').get().n;

export function memoryStats() {
  const byScope = db.prepare("SELECT CASE WHEN scope LIKE 'agent:%' THEN 'agent' WHEN scope LIKE 'manager:%' THEN 'manager' WHEN scope LIKE 'area:%' THEN 'area' ELSE scope END g, COUNT(*) n FROM memory GROUP BY g").all();
  const byKind = db.prepare('SELECT kind, COUNT(*) n FROM memory GROUP BY kind').all();
  return {
    total: countMemory(),
    byScope: Object.fromEntries(byScope.map((r) => [r.g, r.n])),
    byKind: Object.fromEntries(byKind.map((r) => [r.kind, r.n])),
  };
}

export function pinMemory(id, pinned = true) {
  db.prepare('UPDATE memory SET pinned = ?, updated_at = ? WHERE id = ?').run(pinned ? 1 : 0, now(), id);
}

export function deleteMemory(id) {
  return Number(db.prepare('DELETE FROM memory WHERE id = ?').run(id).changes) > 0;
}
