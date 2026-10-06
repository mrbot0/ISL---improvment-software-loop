import { useEffect, useMemo, useRef, useState } from 'react';
import { Empty } from './ui.jsx';

/**
 * Density-aware, virtualised data table (ISL_Frontend §15, P2).
 *
 * The big lists — backlog, runs, memory, dependencies — render every row. At a few hundred that is
 * merely wasteful; at a few thousand it makes the page janky enough that operators stop scrolling,
 * which quietly turns "we have the data" into "nobody looks at it".
 *
 * Three properties, in the order they matter:
 *   1. **Virtualised**: only the visible slice is in the DOM, so cost is bounded by the viewport
 *      rather than by the dataset.
 *   2. **Degrades to cards below `sm`**: a ten-column table on a phone is not a table, it is a
 *      horizontal-scroll puzzle. The same data renders as stacked cards there.
 *   3. **Sortable and column-configurable**, persisted per table id, because which columns matter
 *      is a property of the operator's job and not of the schema.
 *
 * Deliberately dependency-free: a virtualisation library would be a large addition to a bundle whose
 * whole point is being fast, and fixed-height windowing is a dozen lines.
 */

const ROW_H = 28; // px, fixed — variable heights would require measurement and are not worth it here
const OVERSCAN = 6;

const stored = (key, dflt) => {
  try { const v = localStorage.getItem(key); return v ? JSON.parse(v) : dflt; } catch { return dflt; }
};

export default function DataTable({
  id,
  rows = [],
  columns = [],
  rowKey = (r, i) => r.id ?? i,
  onRowClick,
  empty,
  maxHeight = '55vh',
}) {
  const [sort, setSort] = useState(() => stored(`isl.table.${id}.sort`, null));
  const [hidden, setHidden] = useState(() => stored(`isl.table.${id}.hidden`, []));
  const [showCols, setShowCols] = useState(false);
  const [scrollTop, setScrollTop] = useState(0);
  const [viewportH, setViewportH] = useState(400);
  const boxRef = useRef(null);

  useEffect(() => { try { localStorage.setItem(`isl.table.${id}.sort`, JSON.stringify(sort)); } catch { /* private mode */ } }, [id, sort]);
  useEffect(() => { try { localStorage.setItem(`isl.table.${id}.hidden`, JSON.stringify(hidden)); } catch { /* private mode */ } }, [id, hidden]);

  useEffect(() => {
    const el = boxRef.current;
    if (!el) return;
    const measure = () => setViewportH(el.clientHeight || 400);
    measure();
    // ResizeObserver is absent in some webviews and in jsdom. Falling back to a window listener
    // keeps the table working (it just re-measures on window resize rather than on container
    // resize) instead of throwing during mount and taking the whole view down with it.
    if (typeof ResizeObserver === 'function') {
      const ro = new ResizeObserver(measure);
      ro.observe(el);
      return () => ro.disconnect();
    }
    window.addEventListener('resize', measure);
    return () => window.removeEventListener('resize', measure);
  }, []);

  const visibleCols = columns.filter((c) => !hidden.includes(c.key));

  const sorted = useMemo(() => {
    if (!sort) return rows;
    const col = columns.find((c) => c.key === sort.key);
    if (!col) return rows;
    const get = col.sortValue || col.value || ((r) => r[col.key]);
    // A stable, type-tolerant comparison: these lists mix numbers, strings and nulls, and a naive
    // comparator would scatter the nulls unpredictably between renders.
    return [...rows].sort((a, b) => {
      const x = get(a);
      const y = get(b);
      if (x == null && y == null) return 0;
      if (x == null) return 1;
      if (y == null) return -1;
      const r = typeof x === 'number' && typeof y === 'number' ? x - y : String(x).localeCompare(String(y));
      return sort.dir === 'desc' ? -r : r;
    });
  }, [rows, sort, columns]);

  const total = sorted.length;
  const first = Math.max(0, Math.floor(scrollTop / ROW_H) - OVERSCAN);
  const count = Math.min(total - first, Math.ceil(viewportH / ROW_H) + OVERSCAN * 2);
  const slice = sorted.slice(first, first + count);

  const toggleSort = (key) =>
    setSort((s) => (s?.key !== key ? { key, dir: 'asc' } : s.dir === 'asc' ? { key, dir: 'desc' } : null));

  if (!rows.length) return empty || <Empty icon="○" title="Nothing here" hint="No rows to show." />;

  return (
    <div className="flex min-h-0 flex-col">
      <div className="flex items-center gap-2 border-b border-ink-800 px-3 py-1 text-[10px] text-slate-600">
        <span>{total.toLocaleString()} row{total === 1 ? '' : 's'}</span>
        {sort && (
          <button onClick={() => setSort(null)} className="hover:text-slate-400" title="Clear sorting">
            sorted by {sort.key} {sort.dir === 'asc' ? '↑' : '↓'} ✕
          </button>
        )}
        <div className="flex-1" />
        <button onClick={() => setShowCols((v) => !v)} className="hover:text-slate-400">columns</button>
      </div>

      {showCols && (
        <div className="flex flex-wrap gap-x-3 gap-y-1 border-b border-ink-800 bg-ink-950/50 px-3 py-2 text-[11px]">
          {columns.map((c) => (
            <label key={c.key} className="flex cursor-pointer items-center gap-1 text-slate-400">
              <input
                type="checkbox"
                checked={!hidden.includes(c.key)}
                onChange={(e) => setHidden((h) => (e.target.checked ? h.filter((k) => k !== c.key) : [...h, c.key]))}
              />
              {c.label}
            </label>
          ))}
        </div>
      )}

      {/* ── table, sm and up ────────────────────────────────────────────────── */}
      <div className="hidden sm:block">
        <div className="flex border-b border-ink-800 bg-ink-900/60 px-3 py-1 text-[10px] uppercase tracking-wide text-slate-500">
          {visibleCols.map((c) => (
            <button
              key={c.key}
              onClick={() => c.sortable !== false && toggleSort(c.key)}
              style={{ width: c.width || 'auto', flex: c.width ? '0 0 auto' : '1 1 0' }}
              className={`truncate px-1 text-left ${c.sortable === false ? 'cursor-default' : 'hover:text-slate-300'}`}
            >
              {c.label}
              {sort?.key === c.key ? (sort.dir === 'asc' ? ' ↑' : ' ↓') : ''}
            </button>
          ))}
        </div>

        <div ref={boxRef} onScroll={(e) => setScrollTop(e.currentTarget.scrollTop)} className="overflow-auto" style={{ maxHeight }}>
          {/* One tall spacer holds the scrollbar honest; only `slice` exists in the DOM. */}
          <div style={{ height: total * ROW_H, position: 'relative' }}>
            <div style={{ position: 'absolute', top: first * ROW_H, left: 0, right: 0 }}>
              {slice.map((row, i) => (
                <div
                  key={rowKey(row, first + i)}
                  onClick={() => onRowClick?.(row)}
                  style={{ height: ROW_H }}
                  className={`flex items-center border-b border-ink-800/50 px-3 text-[12px] ${onRowClick ? 'cursor-pointer hover:bg-ink-800/50' : ''}`}
                >
                  {visibleCols.map((c) => (
                    <div
                      key={c.key}
                      style={{ width: c.width || 'auto', flex: c.width ? '0 0 auto' : '1 1 0' }}
                      className="min-w-0 truncate px-1"
                    >
                      {c.render ? c.render(row) : String(c.value ? c.value(row) : row[c.key] ?? '')}
                    </div>
                  ))}
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>

      {/* ── cards, below sm ─────────────────────────────────────────────────── */}
      <div className="divide-y divide-ink-800/50 overflow-auto sm:hidden" style={{ maxHeight }}>
        {sorted.slice(0, 200).map((row, i) => (
          <div
            key={rowKey(row, i)}
            onClick={() => onRowClick?.(row)}
            className={`px-3 py-2 text-[12px] ${onRowClick ? 'cursor-pointer active:bg-ink-800/50' : ''}`}
          >
            {visibleCols.map((c) => (
              <div key={c.key} className="flex gap-2">
                <span className="w-20 shrink-0 text-[10px] uppercase text-slate-600">{c.label}</span>
                <span className="min-w-0 flex-1 truncate">{c.render ? c.render(row) : String(c.value ? c.value(row) : row[c.key] ?? '')}</span>
              </div>
            ))}
          </div>
        ))}
        {/* The card list is not virtualised: a phone showing thousands of stacked cards is a
            scrolling problem no windowing fixes, so it is capped and says so. */}
        {sorted.length > 200 && (
          <div className="px-3 py-2 text-[11px] text-slate-600">
            showing the first 200 of {sorted.length.toLocaleString()} — narrow the list or use a wider screen
          </div>
        )}
      </div>
    </div>
  );
}
