import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

/** Max characters of extracted text we keep per document (bounds DB + LLM cost). */
export const MAX_DOC_CHARS = 200_000;

const TEXT_EXT = new Set(['.md', '.markdown', '.txt', '.text', '.rst', '.adoc', '.asciidoc', '.mdx']);
export const DOC_EXTENSIONS = new Set([...TEXT_EXT, '.pdf', '.docx', '.doc', '.odt']);

export function classify(ext) {
  const e = ext.toLowerCase();
  if (e === '.md' || e === '.markdown' || e === '.mdx') return 'md';
  if (e === '.pdf') return 'pdf';
  if (e === '.docx') return 'docx';
  if (e === '.doc') return 'doc';
  if (e === '.odt') return 'odt';
  if (e === '.rst') return 'rst';
  if (e === '.adoc' || e === '.asciidoc') return 'adoc';
  if (e === '.txt' || e === '.text') return 'txt';
  return 'other';
}

/** First markdown/asciidoc heading, or the file name, as a human title. */
function deriveTitle(text, fallback) {
  const m = String(text || '').match(/^\s*#{1,3}\s+(.+)$/m) || String(text || '').match(/^(.+)\n[=-]{3,}\s*$/m);
  return (m && m[1].trim().slice(0, 120)) || fallback;
}

const clip = (s) => {
  const t = String(s || '').replace(/\r\n/g, '\n').replace(/[ \t]+\n/g, '\n');
  return t.length > MAX_DOC_CHARS ? t.slice(0, MAX_DOC_CHARS) + '\n\n…[truncated]' : t;
};

/**
 * Extract plain text from a document. Never throws — a failed extraction returns
 * `{ error }` so ingestion can record it and move on.
 */
export async function extractText(absPath) {
  const ext = path.extname(absPath);
  const type = classify(ext);
  const stat = fs.statSync(absPath);
  const buffer = fs.readFileSync(absPath);
  const hash = crypto.createHash('sha1').update(buffer).digest('hex');
  const base = { type, size: stat.size, mtime: stat.mtimeMs, hash };

  try {
    let text = '';
    if (TEXT_EXT.has(ext.toLowerCase())) {
      text = buffer.toString('utf8');
    } else if (type === 'pdf') {
      const pdfParse = (await import('pdf-parse/lib/pdf-parse.js')).default;
      const data = await pdfParse(buffer);
      text = data.text || '';
    } else if (type === 'docx') {
      const mammoth = await import('mammoth');
      const { value } = await mammoth.extractRawText({ buffer });
      text = value || '';
    } else if (type === 'doc' || type === 'odt') {
      // Legacy binary Word / ODT: no pure-JS extractor bundled. Best-effort strings.
      text = buffer
        .toString('latin1')
        .replace(/[^\x09\x0a\x0d\x20-\x7e]+/g, ' ')
        .replace(/\s{2,}/g, ' ')
        .trim();
      if (text.length < 40) return { ...base, error: `Unsupported binary format (${type}) — install LibreOffice for full extraction`, text: '', chars: 0, title: path.basename(absPath) };
    } else {
      text = buffer.toString('utf8');
    }
    const clipped = clip(text);
    return { ...base, text: clipped, chars: clipped.length, title: deriveTitle(clipped, path.basename(absPath)) };
  } catch (err) {
    return { ...base, error: err.message, text: '', chars: 0, title: path.basename(absPath) };
  }
}
