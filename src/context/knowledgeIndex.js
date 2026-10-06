import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { projectCache } from '../core/projectCache.js';
import { REPO_ROOT, PRODUCT_DIRS, ollama } from '../config.js';
import { db, registerSchema } from '../db.js';
import { scanFiles } from '../iteration/structuralScan.js';
import { extractSymbols } from '../iteration/refactorPlan.js';
import { listMemory } from '../memory/memoryDb.js';
import { landedCommits } from '../summary.js';
import { guardEgress } from '../core/egress.js';
import { log } from '../logger.js';

/**
 * KNOWLEDGE INDEX (ISL_IMPROVE "Deeper capability" — semantic code+docs RAG).
 *
 * A retrieval index the agents and Alfred query to ground a change in the WHOLE codebase, not a
 * single keyword grep. Every code file becomes a document keyed on its path + exported symbols +
 * head; every shared-memory lesson is a document too. Two retrieval signals are blended:
 *
 *   - lexical  : BM25 over a camelCase-aware tokenizer, with an exact-symbol-match boost
 *   - vector   : cosine similarity of a `nomic-embed-text` embedding (768-dim), when available
 *
 * Embeddings are cached in `knowledge_embeddings` keyed by a content hash, so a rebuild only
 * re-embeds the documents that actually changed — the expensive part happens once, in the
 * background. If no embedding model is configured/reachable, the index degrades to pure lexical.
 */

const lg = log.for('knowledge');
const CODE_HEAD_LINES = 40;
const MAX_BYTES = 400_000;
const EMBED_MAX_CHARS = 1600; // what we send to the embedder per doc
const HYBRID_ALPHA = 0.5; // blend weight: final = (1-α)·lexicalNorm + α·cosine

registerSchema(() => {
  db.exec(`
  CREATE TABLE IF NOT EXISTS knowledge_embeddings (
    id     TEXT PRIMARY KEY,
    hash   TEXT NOT NULL,
    vector TEXT NOT NULL
  );`);
});

// --- tokenizer: lowercase, split on non-alphanumerics, AND split camelCase / snake into parts ---
function tokenize(text) {
  const out = [];
  for (const raw of String(text).split(/[^A-Za-z0-9]+/)) {
    if (!raw) continue;
    const lower = raw.toLowerCase();
    out.push(lower);
    const parts = raw.replace(/([a-z0-9])([A-Z])/g, '$1 $2').split(/\s+/);
    if (parts.length > 1) for (const p of parts) { const pl = p.toLowerCase(); if (pl && pl !== lower) out.push(pl); }
  }
  return out.filter((t) => t.length >= 2 && t.length <= 40);
}

const hashOf = (text) => crypto.createHash('sha1').update(text).digest('hex');

/**
 * Call the embedding model. Returns a Float32Array, or null if embeddings are unavailable.
 * `timeoutMs` is short for interactive queries (fall back to lexical fast when Ollama is busy) and
 * long for the background build.
 */
export async function embed(text, timeoutMs = 30_000) {
  if (!ollama.embedModel) return null;
  // The index embeds the WHOLE codebase, so this is the highest-volume egress path in ISL — it must
  // pass the same firewall as chat. A denial is not swallowed by the catch below: `guardEgress`
  // throws before the request is built, and the build/query above must see that the boundary
  // refused rather than silently produce an index with holes in it.
  const guarded = guardEgress({
    purpose: 'embed',
    provider: 'ollama',
    model: ollama.embedModel,
    url: ollama.host,
    parts: [String(text).slice(0, EMBED_MAX_CHARS)],
  });
  try {
    const res = await fetch(`${ollama.host}/api/embeddings`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: ollama.embedModel, prompt: guarded.parts[0] }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) return null;
    const j = await res.json();
    return Array.isArray(j.embedding) && j.embedding.length ? Float32Array.from(j.embedding) : null;
  } catch {
    return null;
  }
}

function cosine(a, b) {
  if (!a || !b || a.length !== b.length) return 0;
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
  return na && nb ? dot / (Math.sqrt(na) * Math.sqrt(nb)) : 0;
}

// Project-STAMPED. This cache was the one nobody added to `activateProject`'s invalidation list, so
// a project switch served the PREVIOUS project's documents and vectors for up to five minutes. The
// stamp makes that impossible rather than merely remembered.
const _index = projectCache('knowledge-index', { ttlMs: 5 * 60_000 });

function loadVectors() {
  const map = new Map();
  try {
    for (const r of db.prepare('SELECT id, hash, vector FROM knowledge_embeddings').all()) {
      map.set(r.id, { hash: r.hash, vec: Float32Array.from(JSON.parse(r.vector)) });
    }
  } catch { /* table not ready */ }
  return map;
}

function buildIndex() {
  const docs = [];
  for (const f of scanFiles({ root: REPO_ROOT, dirs: PRODUCT_DIRS })) {
    if (f.isTest) continue;
    let src = '';
    try {
      const abs = path.join(REPO_ROOT, f.file);
      if (fs.statSync(abs).size > MAX_BYTES) continue;
      src = fs.readFileSync(abs, 'utf8');
    } catch { continue; }
    const symbols = extractSymbols(src).filter((s) => s.exported || s.role === 'component' || s.role === 'section');
    const head = src.split('\n').slice(0, CODE_HEAD_LINES).join('\n');
    const text = `${f.file} ${symbols.map((s) => s.name).join(' ')} ${head}`;
    docs.push({ id: `code:${f.file}`, kind: 'code', title: f.file, symbols: symbols.map((s) => s.name), text, hash: hashOf(text) });
  }
  try {
    for (const m of listMemory({ limit: 400 })) {
      const text = `${m.title} ${m.content || ''} ${m.scope}`;
      docs.push({ id: `mem:${m.id}`, kind: 'memory', title: m.title, text, scope: m.scope, memKind: m.kind, hash: hashOf(text) });
    }
  } catch { /* memory not ready */ }

  // Landed CHANGES — so "find a similar past change" works: the implementer can retrieve a proven
  // approach for a recurring shape of work (its plan title, files, and the score it earned).
  try {
    for (const c of landedCommits({ limit: 150 }).commits) {
      const text = `${c.title} ${(c.filesChanged || 0)} files`;
      docs.push({ id: `change:${c.id}`, kind: 'change', title: c.title, text, sha: c.sha, score: c.score, files: c.filesChanged, hash: hashOf(text + (c.sha || '')) });
    }
  } catch { /* history not ready */ }

  const df = new Map();
  const postings = docs.map((d) => {
    const tokens = tokenize(d.text);
    const tf = new Map();
    for (const t of tokens) tf.set(t, (tf.get(t) || 0) + 1);
    for (const t of tf.keys()) df.set(t, (df.get(t) || 0) + 1);
    return { doc: d, tf, len: tokens.length };
  });
  const avgLen = postings.reduce((a, p) => a + p.len, 0) / (postings.length || 1);
  return { postings, df, avgLen, N: postings.length, vectors: loadVectors() };
}

function index() {
  return _index.get(buildIndex);
}

export function invalidateKnowledgeIndex() {
  _index.invalidate();
}

/** BM25 score for one posting against the query tokens. */
function bm25(p, qTokens, idx) {
  const k1 = 1.5, b = 0.75;
  let score = 0;
  for (const qt of qTokens) {
    const f = p.tf.get(qt);
    if (!f) continue;
    const n = idx.df.get(qt) || 1;
    const idf = Math.log(1 + (idx.N - n + 0.5) / (n + 0.5));
    score += idf * ((f * (k1 + 1)) / (f + k1 * (1 - b + b * (p.len / idx.avgLen))));
  }
  if (p.doc.symbols) for (const qt of qTokens) if (p.doc.symbols.some((s) => s.toLowerCase() === qt)) score += 1.5;
  return score;
}

/**
 * Hybrid BM25 + vector query over the code+memory corpus.
 * @returns {{ query, results, corpus, mode }}
 */
export async function queryIndex(query, { k = 8, kinds = null } = {}) {
  const idx = index();
  const qTokens = [...new Set(tokenize(query))];
  if (!qTokens.length || !idx.N) return { query, results: [], corpus: idx.N, mode: 'lexical' };

  // Optionally restrict to certain document kinds (e.g. only past changes) so they rank among
  // themselves rather than being crowded out by the far larger code corpus.
  const kindSet = kinds ? new Set(kinds) : null;
  const postings = kindSet ? idx.postings.filter((p) => kindSet.has(p.doc.kind)) : idx.postings;

  // Lexical pass over the (optionally filtered) corpus.
  const lex = [];
  let maxLex = 0;
  for (const p of postings) {
    const s = bm25(p, qTokens, idx);
    if (s > 0) { lex.push({ p, lexical: s }); if (s > maxLex) maxLex = s; }
  }

  // Vector pass — only if we have doc embeddings and can embed the query.
  let mode = 'lexical';
  // Short timeout: a search must stay responsive — if Ollama is busy (e.g. the build is running),
  // fall back to lexical rather than hang the request.
  const qvec = idx.vectors.size ? await embed(query, 7_000) : null;
  if (qvec && idx.vectors.size) {
    mode = 'hybrid';
    // Consider the lexical shortlist plus any high-cosine docs the lexical pass missed.
    const scoredById = new Map(lex.map((x) => [x.p.doc.id, x]));
    for (const p of postings) {
      const v = idx.vectors.get(p.doc.id);
      if (!v) continue;
      const cos = cosine(qvec, v.vec);
      if (cos <= 0) continue;
      const existing = scoredById.get(p.doc.id);
      if (existing) existing.cosine = cos;
      else if (cos > 0.4) { const x = { p, lexical: 0, cosine: cos }; scoredById.set(p.doc.id, x); lex.push(x); }
    }
  }

  for (const x of lex) {
    const lexNorm = maxLex ? x.lexical / maxLex : 0;
    const cos = x.cosine || 0;
    x.final = mode === 'hybrid' ? (1 - HYBRID_ALPHA) * lexNorm + HYBRID_ALPHA * cos : x.lexical;
  }
  lex.sort((a, b) => b.final - a.final);

  const results = lex.slice(0, k).map(({ p, lexical, cosine: cos, final }) => ({
    id: p.doc.id, kind: p.doc.kind, title: p.doc.title,
    score: Math.round(final * 1000) / 1000,
    lexical: Math.round(lexical * 100) / 100,
    cosine: cos != null ? Math.round(cos * 1000) / 1000 : null,
    symbols: p.doc.symbols?.slice(0, 8), scope: p.doc.scope, memKind: p.doc.memKind,
    sha: p.doc.sha, changeScore: p.doc.score, files: p.doc.files,
    snippet: snippetFor(p.doc, qTokens),
  }));
  return { query, results, corpus: idx.N, mode };
}

/**
 * Retrieve the most similar PAST landed changes for a task description — the implementer's "you've
 * solved this shape of problem before" lookup. Filters the hybrid results to landed changes.
 */
export async function similarChanges(query, { k = 5 } = {}) {
  const { results, mode } = await queryIndex(query, { k, kinds: ['change'] });
  const changes = results
    .slice(0, k)
    .map((r) => ({ id: r.id.replace('change:', ''), title: r.title, sha: r.sha, score: r.changeScore, files: r.files, similarity: r.score }));
  return { query, mode, changes };
}

function snippetFor(doc, qTokens) {
  for (const line of doc.text.split('\n')) {
    const lower = line.toLowerCase();
    if (qTokens.some((t) => lower.includes(t))) return line.trim().slice(0, 160);
  }
  return (doc.text || '').slice(0, 160).replace(/\s+/g, ' ').trim();
}

// --- background embedding build (incremental by content hash) ---
let _building = false;
let _buildProgress = null;
export const isEmbeddingBuildRunning = () => _building;
export const getEmbeddingBuildStatus = () => _buildProgress;

export async function buildEmbeddings() {
  if (!ollama.embedModel) return { embedded: 0, skipped: 0, reason: 'no embed model configured' };
  const idx = buildIndex(); // fresh doc set
  const cached = idx.vectors;
  const stale = idx.postings.filter((p) => { const c = cached.get(p.doc.id); return !c || c.hash !== p.doc.hash; });
  _buildProgress = { total: stale.length, done: 0, startedAt: Date.now() };
  let embedded = 0;
  const upsert = db.prepare('INSERT INTO knowledge_embeddings (id, hash, vector) VALUES (?,?,?) ON CONFLICT(id) DO UPDATE SET hash=excluded.hash, vector=excluded.vector');
  for (const p of stale) {
    const vec = await embed(p.doc.text);
    if (vec) { upsert.run(p.doc.id, p.doc.hash, JSON.stringify(Array.from(vec))); embedded++; }
    _buildProgress.done++;
  }
  // Drop embeddings for docs that no longer exist.
  try {
    const liveIds = new Set(idx.postings.map((p) => p.doc.id));
    for (const r of db.prepare('SELECT id FROM knowledge_embeddings').all()) if (!liveIds.has(r.id)) db.prepare('DELETE FROM knowledge_embeddings WHERE id = ?').run(r.id);
  } catch { /* best-effort */ }
  invalidateKnowledgeIndex();
  _buildProgress.finishedAt = Date.now();
  lg.info(`embedded ${embedded} document(s) (${stale.length} stale of ${idx.N})`);
  return { embedded, total: idx.N, stale: stale.length };
}

export function startEmbeddingBuild() {
  if (_building) return false;
  if (!ollama.embedModel) return false;
  _building = true;
  buildEmbeddings().catch((e) => lg.warn(`embedding build failed: ${e.message}`)).finally(() => { _building = false; });
  return true;
}

/** Corpus stats for the dashboard. */
export function knowledgeStats() {
  const idx = index();
  const byKind = {};
  for (const p of idx.postings) byKind[p.doc.kind] = (byKind[p.doc.kind] || 0) + 1;
  return {
    documents: idx.N,
    byKind,
    avgTokens: Math.round(idx.avgLen),
    embedModel: ollama.embedModel || null,
    embedded: idx.vectors.size,
    building: _building,
    buildProgress: _buildProgress,
  };
}
