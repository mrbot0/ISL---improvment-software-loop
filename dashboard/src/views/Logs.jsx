import { useEffect, useMemo, useRef, useState } from 'react';

const LEVELS = ['all', 'debug', 'info', 'warn', 'error'];
const LEVEL_CLS = {
  debug: 'text-slate-500',
  info: 'text-sky-400',
  warn: 'text-amber-400',
  error: 'text-rose-400',
};

const time = (ts) => new Date(ts).toLocaleTimeString('it-IT', { hour12: false }) + '.' + String(new Date(ts).getMilliseconds()).padStart(3, '0');

export default function Logs({ logs }) {
  const [level, setLevel] = useState('all');
  const [source, setSource] = useState('all');
  const [query, setQuery] = useState('');
  const [pinned, setPinned] = useState(true);
  const scroller = useRef(null);

  const order = { debug: 0, info: 1, warn: 2, error: 3 };
  const sources = useMemo(() => ['all', ...new Set(logs.map((l) => l.source))].sort(), [logs]);

  const filtered = useMemo(() => {
    const floor = level === 'all' ? -1 : order[level];
    const q = query.toLowerCase();
    return logs.filter(
      (l) =>
        (level === 'all' || order[l.level] >= floor) &&
        (source === 'all' || l.source === source) &&
        (!q || l.message.toLowerCase().includes(q) || l.source.toLowerCase().includes(q)),
    );
  }, [logs, level, source, query]);

  useEffect(() => {
    if (pinned && scroller.current) scroller.current.scrollTop = scroller.current.scrollHeight;
  }, [filtered, pinned]);

  const counts = useMemo(() => {
    const c = { debug: 0, info: 0, warn: 0, error: 0 };
    for (const l of logs) c[l.level] = (c[l.level] || 0) + 1;
    return c;
  }, [logs]);

  return (
    <div className="card flex h-full flex-col">
      <div className="flex flex-wrap items-center gap-2 border-b border-ink-800 px-3 py-2">
        <h2 className="text-xs font-semibold uppercase tracking-wide text-slate-400">Logs</h2>
        <div className="flex items-center gap-1">
          {LEVELS.map((lv) => (
            <button
              key={lv}
              onClick={() => setLevel(lv)}
              className={`rounded-md px-2 py-1 text-[11px] font-medium transition-colors ${
                level === lv ? 'bg-ink-700 text-white' : 'text-slate-500 hover:text-slate-300'
              }`}
            >
              {lv}
              {lv !== 'all' && <span className="ml-1 font-mono text-slate-600">{counts[lv] || 0}</span>}
            </button>
          ))}
        </div>
        <select aria-label="Filter logs by source" value={source} onChange={(e) => setSource(e.target.value)} className="input h-7 w-auto py-0 text-[11px]">
          {sources.map((s) => <option key={s} value={s}>{s === 'all' ? 'all sources' : s}</option>)}
        </select>
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="filter…"
          className="input h-7 w-40 py-0 text-[11px]"
        />
        <div className="flex-1" />
        <label className="flex items-center gap-1 text-[10px] text-slate-500">
          <input type="checkbox" checked={pinned} onChange={(e) => setPinned(e.target.checked)} className="accent-emerald-500" />
          follow
        </label>
        <span className="font-mono text-[10px] text-slate-600">{filtered.length}/{logs.length}</span>
      </div>

      <div
        ref={scroller}
        onScroll={() => {
          const el = scroller.current;
          if (el) setPinned(el.scrollHeight - el.scrollTop - el.clientHeight < 40);
        }}
        className="min-h-0 flex-1 overflow-auto bg-ink-950/50 p-2 font-mono text-[11px] leading-relaxed"
      >
        {!filtered.length ? (
          <div className="grid h-full place-items-center text-slate-600">No matching log lines.</div>
        ) : (
          filtered.map((l) => (
            <div key={l.id ?? l.ts} className="flex gap-2 px-1 py-0.5 hover:bg-ink-800/40">
              <span className="shrink-0 text-slate-700">{time(l.ts)}</span>
              <span className={`w-11 shrink-0 uppercase ${LEVEL_CLS[l.level] || 'text-slate-500'}`}>{l.level}</span>
              <span className="w-32 shrink-0 truncate text-slate-500" title={l.source}>{l.source}</span>
              <span className="min-w-0 flex-1 whitespace-pre-wrap break-words text-slate-300">{l.message}</span>
            </div>
          ))
        )}
      </div>
    </div>
  );
}
