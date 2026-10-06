import { useEffect, useMemo, useState } from 'react';
import { api } from '../api.js';

/**
 * Per-file diff viewer with syntax highlighting and blast-radius annotation.
 *
 * "Turn trust the score into see the change" (ISL_Frontend §15, P0). Two things were missing before:
 * the diff was a wall of monochrome text, and it told you WHAT changed without telling you what
 * depends on it — the question a reviewer actually has.
 *
 * Highlighting is a dependency-free tokenizer on purpose. Pulling in a highlighter would add a large
 * bundle to a dashboard whose whole point is being fast, and a diff needs far less than a full
 * grammar: comments, strings, numbers and keywords are what make code scannable. The tokenizer is
 * written to be **incapable of losing text** — every branch consumes and re-emits the input verbatim,
 * so a language it does not understand renders as plain (correct) text rather than mangled code.
 */

/* ------------------------------- highlighting ------------------------------- */

const KEYWORDS = new Set([
  'const', 'let', 'var', 'function', 'return', 'if', 'else', 'for', 'while', 'switch', 'case', 'break',
  'continue', 'new', 'class', 'extends', 'import', 'from', 'export', 'default', 'async', 'await',
  'try', 'catch', 'finally', 'throw', 'typeof', 'instanceof', 'in', 'of', 'this', 'null', 'undefined',
  'true', 'false', 'def', 'elif', 'None', 'True', 'False', 'self', 'lambda', 'pass', 'raise', 'with',
  'func', 'package', 'type', 'struct', 'interface', 'nil', 'end', 'do', 'then', 'fn', 'let', 'mut',
  'pub', 'impl', 'match', 'use', 'public', 'private', 'protected', 'static', 'void', 'select', 'where',
]);

const LINE_COMMENT = /^\s*(\/\/|#|--)/;

/**
 * Split one line of code into typed tokens. Order matters: strings and comments must win over
 * everything else, or a keyword inside a string would be highlighted as code.
 */
function tokenize(text) {
  if (LINE_COMMENT.test(text)) return [{ t: 'comment', v: text }];
  const out = [];
  const re = /(`(?:[^`\\]|\\.)*`|"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*')|(\/\*[\s\S]*?\*\/|\/\/[^\n]*|#[^\n]*)|(\b\d[\d_.]*\b)|([A-Za-z_$][\w$]*)/g;
  let last = 0;
  let m;
  while ((m = re.exec(text))) {
    if (m.index > last) out.push({ t: 'plain', v: text.slice(last, m.index) });
    if (m[1]) out.push({ t: 'string', v: m[1] });
    else if (m[2]) out.push({ t: 'comment', v: m[2] });
    else if (m[3]) out.push({ t: 'number', v: m[3] });
    else if (m[4]) out.push({ t: KEYWORDS.has(m[4]) ? 'keyword' : 'plain', v: m[4] });
    last = m.index + m[0].length;
  }
  // The tail is always emitted, so the concatenation of tokens equals the input exactly.
  if (last < text.length) out.push({ t: 'plain', v: text.slice(last) });
  return out;
}

const TOKEN_CLASS = {
  keyword: 'text-violet-300',
  string: 'text-emerald-300/90',
  comment: 'text-slate-600 italic',
  number: 'text-amber-300/90',
  plain: '',
};

/** A diff line: the leading +/- marker keeps its own colour, the rest is highlighted code. */
function DiffLine({ line, highlight }) {
  if (line.startsWith('+++') || line.startsWith('---') || line.startsWith('diff ') || line.startsWith('index ')) {
    return <div className="diff-meta -mx-1 px-1">{line || ' '}</div>;
  }
  if (line.startsWith('@@')) return <div className="diff-hunk -mx-1 px-1">{line}</div>;

  const kind = line.startsWith('+') ? 'add' : line.startsWith('-') ? 'del' : 'ctx';
  const marker = kind === 'ctx' ? ' ' : line[0];
  const body = kind === 'ctx' ? line.slice(line.startsWith(' ') ? 1 : 0) : line.slice(1);
  const rowClass = kind === 'add' ? 'diff-add' : kind === 'del' ? 'diff-del' : 'text-slate-400';

  return (
    <div className={`${rowClass} -mx-1 px-1`}>
      <span className="select-none opacity-60">{marker}</span>
      {highlight
        ? tokenize(body).map((tk, i) => <span key={i} className={TOKEN_CLASS[tk.t]}>{tk.v}</span>)
        : body}
      {!body && ' '}
    </div>
  );
}

/* --------------------------------- parsing --------------------------------- */

function splitFiles(diff) {
  if (!diff) return [];
  const files = [];
  let cur = null;
  for (const line of diff.split('\n')) {
    const m = line.match(/^diff --git a\/(.+?) b\/(.+)$/) || line.match(/^\+\+\+ b\/(.+)$/);
    if (line.startsWith('diff --git')) {
      if (cur) files.push(cur);
      cur = { path: (m && (m[2] || m[1])) || 'file', lines: [line], add: 0, del: 0 };
    } else if (!cur && line.startsWith('+++')) {
      cur = { path: (m && m[1]) || 'file', lines: [line], add: 0, del: 0 };
    } else if (cur) {
      cur.lines.push(line);
      if (line.startsWith('+') && !line.startsWith('+++')) cur.add++;
      else if (line.startsWith('-') && !line.startsWith('---')) cur.del++;
    }
  }
  if (cur) files.push(cur);
  return files;
}

/* ------------------------------ blast radius -------------------------------- */

/**
 * What depends on each changed file. Fetched lazily and capped: a reviewer needs this for the few
 * files in front of them, and firing dozens of requests to populate a panel nobody scrolled to
 * would be a poor trade for a page that is meant to feel instant.
 */
function useBlastRadius(paths, enabled) {
  const [blast, setBlast] = useState({});
  const key = paths.join('|');
  useEffect(() => {
    if (!enabled || !paths.length) return;
    let cancelled = false;
    (async () => {
      const out = {};
      for (const p of paths.slice(0, 8)) {
        try { out[p] = await api.blastRadius(p); } catch { /* a missing file is not an error here */ }
      }
      if (!cancelled) setBlast(out);
    })();
    return () => { cancelled = true; };
  }, [key, enabled]);
  return blast;
}

const RISK_CLASS = { high: 'text-rose-300', medium: 'text-amber-300', low: 'text-slate-500' };

/* ---------------------------------- view ----------------------------------- */

export default function DiffViewer({ diff, maxLinesPerFile = 500, showBlast = true }) {
  const files = useMemo(() => splitFiles(diff), [diff]);
  const [collapsed, setCollapsed] = useState({});
  const [copied, setCopied] = useState(false);
  const [highlight, setHighlight] = useState(true);
  const paths = useMemo(() => files.map((f) => f.path), [files]);
  const blast = useBlastRadius(paths, showBlast);

  if (!diff?.trim()) {
    return <div className="grid h-full place-items-center text-xs text-slate-600">No diff.</div>;
  }

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(diff);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch { /* clipboard blocked */ }
  };

  const totals = files.reduce((t, f) => ({ add: t.add + f.add, del: t.del + f.del }), { add: 0, del: 0 });

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center gap-2 border-b border-ink-800 px-3 py-1.5 text-[10px] text-slate-500">
        <span>{files.length} file{files.length === 1 ? '' : 's'}</span>
        <span className="font-mono text-emerald-400">+{totals.add}</span>
        <span className="font-mono text-rose-400">−{totals.del}</span>
        <div className="flex-1" />
        <button
          onClick={() => setHighlight((h) => !h)}
          className="rounded px-1.5 py-0.5 hover:bg-ink-800 hover:text-slate-300"
          title="Syntax highlighting is a display aid — turn it off to read the raw text"
        >
          {highlight ? '◨ syntax on' : '◧ syntax off'}
        </button>
        <button onClick={copy} className="rounded px-1.5 py-0.5 hover:bg-ink-800 hover:text-slate-300">{copied ? '✓ copied' : 'copy diff'}</button>
      </div>
      <div className="min-h-0 flex-1 overflow-auto">
        {files.map((f, fi) => {
          const isCollapsed = collapsed[fi];
          const b = blast[f.path];
          return (
            <div key={fi} className="border-b border-ink-800/60">
              <button
                onClick={() => setCollapsed((c) => ({ ...c, [fi]: !c[fi] }))}
                className="sticky top-0 flex w-full items-center gap-2 bg-ink-900/95 px-3 py-1.5 text-left text-[11px] backdrop-blur hover:bg-ink-800"
              >
                <span className="text-slate-600">{isCollapsed ? '▸' : '▾'}</span>
                <code className="flex-1 truncate font-mono text-slate-300">{f.path}</code>
                {/* The reviewer's real question: what breaks if this is wrong? */}
                {b && (
                  <span className={`font-mono text-[10px] ${RISK_CLASS[b.risk] || ''}`} title={`${b.dependentCount} module(s) import this${b.testCount ? `, ${b.testCount} test(s) cover it` : ', no test covers it'}${b.sensitive ? ' — sensitive area' : ''}`}>
                    ⟿ {b.dependentCount}{b.sensitive ? ' ⚠' : ''}
                  </span>
                )}
                <span className="font-mono text-[10px] text-emerald-400">+{f.add}</span>
                <span className="font-mono text-[10px] text-rose-400">−{f.del}</span>
              </button>

              {/* Callers listed inline: "these must keep working" is the acceptance criterion for a
                  behaviour-preserving change, and it belongs next to the change, not a click away. */}
              {!isCollapsed && b?.dependents?.length > 0 && (
                <div className="border-b border-ink-800/40 bg-ink-950/40 px-3 py-1 text-[10px] text-slate-600">
                  must keep working: {b.dependents.slice(0, 6).map((d) => <code key={d} className="mr-2 font-mono text-slate-500">{d.split('/').pop()}</code>)}
                  {b.dependents.length > 6 && <span>+{b.dependents.length - 6} more</span>}
                  {b.testCount === 0 && <span className="ml-2 text-amber-400/80">· no test imports this file</span>}
                </div>
              )}

              {!isCollapsed && (
                <pre className="w-max min-w-full px-3 pb-2 font-mono text-[11px] leading-relaxed">
                  {f.lines.slice(0, maxLinesPerFile).map((l, i) => (
                    <DiffLine key={i} line={l} highlight={highlight} />
                  ))}
                  {f.lines.length > maxLinesPerFile && (
                    <div className="px-1 text-slate-600">… {f.lines.length - maxLinesPerFile} more lines</div>
                  )}
                </pre>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
