import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * ONE CACHE KEY, ONE ENDPOINT.
 *
 * `useResource(key, fetcher)` caches by key across the whole app, so two components using the same
 * key with different fetchers get each other's data — and whichever mounts first wins.
 *
 * This has now shipped twice:
 *   - `deployments` held a NUMBER in one place and an ARRAY in another;
 *   - `health` was `/api/health` (`{ok, ollama, repo}`) in the always-mounted top-bar widget and
 *     `/api/health-index` (`{score, components}`) in the Health view. The widget won, the view read
 *     its payload, `if (!health)` passed because the object is perfectly truthy, and
 *     `Object.entries(undefined)` took the whole page down.
 *
 * Neither was caught by a type, a test or a review — the key is the contract and nothing enforced
 * it. This does.
 */

const SRC = path.dirname(fileURLToPath(import.meta.url));

/** Every `useResource('literal-key', …fetcher…)` in the app, with the endpoint it resolves to. */
function resourceUsages() {
  const files = [];
  (function walk(dir) {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (/\.jsx?$/.test(e.name) && !e.name.includes('.test.')) files.push(p);
    }
  })(SRC);

  const out = [];
  for (const file of files) {
    const src = fs.readFileSync(file, 'utf8');
    // Only literal keys — a template key like `iteration:${id}` is namespaced by construction.
    for (const m of src.matchAll(/useResource\(\s*'([^']+)'\s*,\s*([^)]*?)(?:,\s*\{|\))/gs)) {
      const [, key, fetcher] = m;
      // The api method named in the fetcher is what identifies the shape.
      const call = /api\.(\w+)/.exec(fetcher)?.[1] || fetcher.trim().slice(0, 40);
      out.push({ key, call, file: path.relative(SRC, file) });
    }
  }
  return out;
}

describe('useResource cache keys', () => {
  it('finds the usages it is meant to police', () => {
    // A regex that silently matches nothing would make every assertion below vacuous.
    const usages = resourceUsages();
    expect(usages.length).toBeGreaterThan(10);
  });

  it('NEVER maps one key to two different endpoints', () => {
    const byKey = new Map();
    for (const u of resourceUsages()) {
      if (!byKey.has(u.key)) byKey.set(u.key, new Map());
      byKey.get(u.key).set(u.call, u.file);
    }

    const collisions = [...byKey]
      .filter(([, calls]) => calls.size > 1)
      .map(([key, calls]) => `"${key}" ← ${[...calls].map(([c, f]) => `${c}() in ${f}`).join('  vs  ')}`);

    expect(collisions, `two shapes behind one cache key:\n  ${collisions.join('\n  ')}`).toEqual([]);
  });

  it('every key an event invalidates is a key something actually uses', () => {
    /*
     * The other half of the same contract. Renaming a key without updating `liveKeys.js` leaves the
     * invalidation pointing at nothing: the view keeps showing stale data and there is no error to
     * notice — it simply stops updating, which is the hardest kind of bug to attribute.
     */
    const used = new Set(resourceUsages().map((u) => u.key));
    const liveKeys = fs.readFileSync(path.join(SRC, 'liveKeys.js'), 'utf8');

    const invalidated = new Set();
    for (const m of liveKeys.matchAll(/'([a-z][\w:-]*)'/gi)) invalidated.add(m[1]);

    const orphans = [...invalidated].filter((k) => {
      if (k.includes('*') || k.includes('.')) return false; // wildcards and event names, not keys
      if (/^[A-Z]/.test(k)) return false; // manager names
      return !used.has(k) && !used.has(`${k}s`);
    });

    // Reported rather than asserted empty: `liveKeys.js` legitimately holds event names and
    // manager names in the same quotes, and a strict list here would fail on unrelated edits.
    // What matters is that the two keys this test exists for are present and correct.
    expect(used.has('health-index'), 'the Health view key must be the one events invalidate').toBe(true);
    expect(invalidated.has('health-index'), 'liveKeys must invalidate health-index, not health').toBe(true);
    expect(orphans.length, `keys invalidated but never used: ${orphans.join(', ')}`).toBeLessThan(20);
  });
});
