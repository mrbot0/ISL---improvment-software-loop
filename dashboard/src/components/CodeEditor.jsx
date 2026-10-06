import { useEffect, useMemo, useRef, useState } from 'react';

/**
 * A dependency-free code editor: a monospace textarea with a synced line-number
 * gutter, tab-to-indent, and a read-only mode. Deliberately not a full IDE — it's
 * reliable, light, and does what "edit and save a file" needs. Syntax highlighting
 * is skipped in favour of correctness and zero heavy dependencies.
 */
export default function CodeEditor({ value, onChange, readOnly = false, language }) {
  const taRef = useRef(null);
  const gutterRef = useRef(null);
  const [local, setLocal] = useState(value ?? '');

  useEffect(() => setLocal(value ?? ''), [value]);

  const lineCount = useMemo(() => Math.max(1, (local.match(/\n/g)?.length ?? 0) + 1), [local]);

  const syncScroll = () => {
    if (gutterRef.current && taRef.current) gutterRef.current.scrollTop = taRef.current.scrollTop;
  };

  const onKeyDown = (e) => {
    if (readOnly) return;
    if (e.key === 'Tab') {
      e.preventDefault();
      const ta = taRef.current;
      const start = ta.selectionStart;
      const end = ta.selectionEnd;
      const next = local.slice(0, start) + '  ' + local.slice(end);
      setLocal(next);
      onChange?.(next);
      requestAnimationFrame(() => {
        ta.selectionStart = ta.selectionEnd = start + 2;
      });
    }
  };

  const handleChange = (e) => {
    setLocal(e.target.value);
    onChange?.(e.target.value);
  };

  return (
    <div className="relative flex h-full min-h-0 overflow-hidden rounded-lg border border-ink-700 bg-ink-950">
      <div
        ref={gutterRef}
        className="select-none overflow-hidden border-r border-ink-800 bg-ink-900/60 px-2 py-2 text-right font-mono text-[11px] leading-[1.5] text-slate-600"
        style={{ minWidth: 44 }}
        aria-hidden="true"
      >
        {Array.from({ length: lineCount }, (_, i) => (
          <div key={i}>{i + 1}</div>
        ))}
      </div>
      <textarea
        ref={taRef}
        value={local}
        onChange={handleChange}
        onKeyDown={onKeyDown}
        onScroll={syncScroll}
        readOnly={readOnly}
        spellCheck={false}
        wrap="off"
        className={`min-h-0 flex-1 resize-none overflow-auto bg-transparent px-3 py-2 font-mono text-[11px] leading-[1.5] text-slate-200 focus:outline-none ${
          readOnly ? 'cursor-default text-slate-400' : ''
        }`}
        style={{ tabSize: 2 }}
        aria-label={`Code editor${language ? ` (${language})` : ''}${readOnly ? ', read only' : ''}`}
      />
      {readOnly && (
        <span className="pointer-events-none absolute right-2 top-2 rounded bg-ink-800/90 px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-slate-500">
          read-only
        </span>
      )}
    </div>
  );
}
