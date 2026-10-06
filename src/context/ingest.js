import fs from 'node:fs';
import path from 'node:path';
import { REPO_ROOT } from '../config.js';
import { log } from '../logger.js';
import { DOC_EXTENSIONS, extractText } from './extract.js';
import { upsertDocument, pruneDocumentsNotIn, documentHashes, documentStats } from './contextDb.js';

const IGNORE_DIRS = new Set([
  'node_modules', '.git', 'dist', 'build', 'coverage', '.data', '.next', '.nuxt',
  'out', 'vendor', '.claude', '.cache', 'tmp', '.venv', 'venv', '__pycache__', '.turbo',
]);

const MAX_DEPTH = 12;

/** Recursively collect candidate document files under the project root. */
function walk(root) {
  const found = [];
  const visit = (dir, depth) => {
    if (depth > MAX_DEPTH) return;
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (e.name.startsWith('.') && e.isDirectory()) continue;
      if (e.isDirectory()) {
        if (IGNORE_DIRS.has(e.name)) continue;
        visit(path.join(dir, e.name), depth + 1);
      } else if (DOC_EXTENSIONS.has(path.extname(e.name).toLowerCase())) {
        found.push(path.join(dir, e.name));
      }
    }
  };
  visit(root, 0);
  return found;
}

/**
 * Ingest every document in the active project's folder (and subfolders). Skips
 * files whose size+mtime are unchanged since the last pass, extracts text from
 * the rest, and prunes rows for docs that have disappeared.
 */
export async function ingestDocuments({ force = false } = {}) {
  const root = REPO_ROOT;
  const files = walk(root);
  const known = documentHashes();
  const seen = [];
  let extracted = 0;
  let skipped = 0;
  let failed = 0;

  for (const abs of files) {
    const relPath = path.relative(root, abs).split(path.sep).join('/');
    seen.push(relPath);
    try {
      const stat = fs.statSync(abs);
      const prev = known[relPath];
      // Cheap skip: unchanged mtime means we already have the text.
      if (!force && prev && prev.mtime === stat.mtimeMs) {
        skipped++;
        continue;
      }
      const doc = await extractText(abs);
      upsertDocument({ relPath, ...doc });
      if (doc.error) failed++;
      else extracted++;
    } catch (err) {
      failed++;
      upsertDocument({ relPath, type: 'other', title: path.basename(abs), error: err.message, text: '', chars: 0 });
    }
  }

  const removed = pruneDocumentsNotIn(seen);
  const stats = documentStats();
  log.info('context', `ingested docs — ${extracted} new/changed, ${skipped} unchanged, ${failed} failed, ${removed} removed`, {
    data: { total: stats.total },
  });
  return { scanned: files.length, extracted, skipped, failed, removed, stats };
}

export { walk as walkDocuments };
