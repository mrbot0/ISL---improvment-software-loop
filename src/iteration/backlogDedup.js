import { listFeatures, setFeatureStatus } from '../db_iteration.js';

/**
 * BACKLOG DEDUP (ISL_IMPROVE "Next wave", P2).
 *
 * Over time the backlog accretes near-duplicates: research re-adds a similar idea, the survey and
 * the coverage scan both flag the same file, two phrasings of one refactor. This finds those pairs
 * and (on apply) defers the weaker of each, keeping the backlog a crisp priority list.
 *
 * DESIGN NOTE — we deliberately do NOT use sentence embeddings here. The backlog is full of TEMPLATED
 * titles ("Add unit tests for X", "Fix accessibility issues in Y") that differ only in the filename;
 * an embedding gives two such titles ~0.95 cosine even when X and Y are DIFFERENT files — i.e. it
 * would merge distinct work. (Measured on a real backlog: it flagged two pages with unrelated
 * subjects as duplicates purely because their titles shared a template.) The precise, high-precision signal for a backlog is instead: **same target file + same
 * intent**, with a high-lexical fallback for file-less items. Deterministic and safe.
 */

const STOP = new Set(['add', 'the', 'for', 'and', 'to', 'in', 'of', 'a', 'unit', 'tests', 'test', 'untested', 'logic', 'business', 'characterization', 'coverage', 'reduce', 'from']);

const INTENTS = [
  { key: 'test', re: /\b(test|coverage|spec|characteri[sz])/i },
  { key: 'refactor', re: /\b(refactor|split|extract|complexit|god[- ]?file|dedup|simplif|consolidat)/i },
  { key: 'a11y', re: /\b(accessib|a11y|i18n)/i },
  { key: 'security', re: /\b(secur|harden|vuln|\bcve\b|sanit)/i },
  { key: 'perf', re: /\b(perf|performance|optimi|cache|latency)/i },
];
function intentOf(feature) {
  const t = `${feature.title} ${feature.description || ''}`;
  for (const i of INTENTS) if (i.re.test(t)) return i.key;
  return 'other';
}

/** The filename a feature is about (its clearest dedup key), or null. */
function fileKey(feature) {
  const m = `${feature.title} ${feature.description || ''}`.match(/[\w/.-]+\.(?:jsx?|tsx?|py|rb|go|vue|svelte)/i);
  return m ? m[0].split(/[\\/]/).pop().toLowerCase() : null;
}

function distinctiveTokens(feature) {
  const set = new Set();
  for (const raw of `${feature.title} ${feature.description || ''}`.toLowerCase().split(/[^a-z0-9.]+/)) {
    const t = raw.replace(/^[.]+|[.]+$/g, '');
    if (t.length >= 3 && !STOP.has(t)) set.add(t);
  }
  return set;
}
function jaccard(a, b) {
  if (!a.size || !b.size) return 0;
  let inter = 0;
  for (const x of a) if (b.has(x)) inter++;
  return inter / (a.size + b.size - inter);
}

/**
 * Find near-duplicate pending features (high precision).
 * @returns {{ scanned, count, pairs }}
 */
export function findDuplicates({ lexicalThreshold = 0.7, max = 120 } = {}) {
  const feats = listFeatures({ status: 'pending', limit: max });
  const meta = feats.map((f) => ({ f, file: fileKey(f), intent: intentOf(f), toks: distinctiveTokens(f) }));

  const pairs = [];
  for (let i = 0; i < meta.length; i++) {
    for (let j = i + 1; j < meta.length; j++) {
      const a = meta[i];
      const b = meta[j];
      let sim = 0;
      let signal = null;
      // Strong, precise signal: same file AND same intent → the same work, however worded.
      if (a.file && a.file === b.file && a.intent === b.intent && a.intent !== 'other') {
        sim = 0.95;
        signal = 'same-file+intent';
      } else if (!a.file && !b.file) {
        // No filename on either — fall back to a HIGH lexical-overlap bar on distinctive tokens.
        const lex = jaccard(a.toks, b.toks);
        if (lex >= lexicalThreshold) { sim = Math.round(lex * 100) / 100; signal = 'lexical'; }
      }
      if (signal) {
        const [keep, drop] = a.f.priority >= b.f.priority ? [a.f, b.f] : [b.f, a.f];
        pairs.push({
          keep: { id: keep.id, title: keep.title, priority: keep.priority, source: keep.source },
          drop: { id: drop.id, title: drop.title, priority: drop.priority, source: drop.source },
          similarity: sim,
          signal,
        });
      }
    }
  }
  pairs.sort((x, y) => y.similarity - x.similarity);
  return { scanned: feats.length, count: pairs.length, pairs };
}

/** Defer the weaker feature of each duplicate pair. Returns how many were deferred. */
export function dedupBacklog({ lexicalThreshold = 0.7 } = {}) {
  const { pairs } = findDuplicates({ lexicalThreshold });
  const deferred = new Set();
  const kept = new Set();
  for (const p of pairs) {
    if (deferred.has(p.drop.id) || deferred.has(p.keep.id) || kept.has(p.drop.id)) continue;
    setFeatureStatus(p.drop.id, 'deferred');
    deferred.add(p.drop.id);
    kept.add(p.keep.id);
  }
  return { deferred: deferred.size, pairs: pairs.length };
}
