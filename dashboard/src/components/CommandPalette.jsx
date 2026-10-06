import { useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../api.js';
import { useFocusTrap } from '../useFocusTrap.js';
import { ABSORBED_LABELS, MERGED_ROUTES } from '../merged.js';

/**
 * Ctrl/Cmd-K command palette: fuzzy-jump to any view, run an action, search live data
 * (proposals, iterations, backlog) — and search the hybrid KNOWLEDGE INDEX (the codebase's
 * files/symbols plus the fleet's learned lessons and past changes), so grounded search is one
 * keystroke away from anywhere instead of buried inside a page. Keyboard-first.
 */
export default function CommandPalette({ open, onClose, nav, actions, data, onNavigate }) {
  const [q, setQ] = useState('');
  const [active, setActive] = useState(0);
  const trapRef = useFocusTrap(open, onClose);
  const [knowledge, setKnowledge] = useState(null);
  const [searching, setSearching] = useState(false);
  const inputRef = useRef(null);

  useEffect(() => {
    if (open) {
      setQ('');
      setActive(0);
      setKnowledge(null);
      setTimeout(() => inputRef.current?.focus(), 10);
    }
  }, [open]);

  // Debounced knowledge lookup — the codebase is far larger than the local lists, so it is the
  // answer to "where is X handled?" that the palette could not give before.
  useEffect(() => {
    if (!open || q.trim().length < 3) { setKnowledge(null); return undefined; }
    const t = setTimeout(async () => {
      setSearching(true);
      try { setKnowledge(await api.knowledge(q.trim())); } catch { setKnowledge(null); } finally { setSearching(false); }
    }, 350);
    return () => clearTimeout(t);
  }, [q, open]);

  const items = useMemo(() => {
    const list = [];
    /*
     * Views. `keywords` carries the route id alongside the label, because the label is what the
     * page is called TODAY and the query is usually what it was called when the operator learned
     * it: "telemetry" now reads "Cost & tokens", "health" reads "Metrics", "deploy" reads
     * "Promote". Matching the label alone answers "no such page" to a page that is right there.
     */
    for (const n of nav) list.push({ kind: 'view', label: `Go to ${n.label}`, keywords: n.id, hint: 'view', run: () => onNavigate(n.id) });
    // Pages that became tabs inside another page. Without these, merging removed eight
    // destinations from the palette, and typing the name someone has always used would find
    // nothing — indistinguishable from the feature having been deleted.
    for (const [id, label] of Object.entries(ABSORBED_LABELS)) {
      list.push({ kind: 'view', label: `Go to ${label}`, keywords: id, hint: `in ${MERGED_ROUTES[id].page}`, run: () => onNavigate(id) });
    }
    // Actions
    for (const a of actions) list.push({ kind: 'action', label: a.label, hint: a.hint || 'action', run: a.run });
    // Live data search (only when there's a query)
    const query = q.trim().toLowerCase();
    if (query) {
      for (const p of data.proposals || []) {
        if (p.title.toLowerCase().includes(query)) list.push({ kind: 'proposal', label: `#${p.id} ${p.title}`, hint: 'proposal', run: () => onNavigate('proposals') });
      }
      for (const it of data.iterations || []) {
        if ((it.planTitle || '').toLowerCase().includes(query)) list.push({ kind: 'iteration', label: `Iteration #${it.id}: ${it.planTitle}`, hint: `score ${it.scores?.total ?? '—'}`, run: () => onNavigate('iterations') });
      }
      for (const f of data.features || []) {
        if (f.title.toLowerCase().includes(query)) list.push({ kind: 'feature', label: f.title, hint: 'backlog', run: () => onNavigate('backlog') });
      }
    }

    if (!query) return list;
    // Simple subsequence fuzzy match + rank by match position.
    // Ranked on the label so the visible text still drives the order, but matched on the label plus
    // its keywords so an old name finds the page it moved into.
    const hay = (it) => `${it.label} ${it.keywords || ''}`.toLowerCase();
    const scored = list
      .map((it) => ({ it, i: it.label.toLowerCase().indexOf(query), h: hay(it).indexOf(query) }))
      .filter((x) => x.h !== -1 || fuzzy(hay(x.it), query))
      .sort((a, b) => (a.i === -1 ? 999 : a.i) - (b.i === -1 ? 999 : b.i));
    const local = scored.map((x) => x.it);

    // Knowledge hits go last — they answer "where is this in the code?" rather than "take me there".
    const know = (knowledge?.results || []).slice(0, 8).map((r) => ({
      kind: r.kind === 'memory' ? 'lesson' : r.kind === 'change' ? 'change' : 'code',
      label: r.title,
      hint: r.kind === 'memory' ? (r.snippet || 'lesson') : r.kind === 'change' ? `${r.sha || ''} score ${r.changeScore ?? '—'}` : (r.symbols?.slice(0, 4).join(' · ') || 'file'),
      run: () => onNavigate(r.kind === 'memory' ? 'memory' : r.kind === 'change' ? 'summary' : 'explorer'),
    }));
    return [...local, ...know];
  }, [q, nav, actions, data, onNavigate, knowledge]);

  useEffect(() => {
    if (active >= items.length) setActive(0);
  }, [items, active]);

  if (!open) return null;

  const choose = (it) => {
    it?.run();
    onClose();
  };

  /*
   * The palette had focus-on-open and Escape but no dialog role and no trap, so Tab from the
   * results list walked out into the page behind it. It is the one overlay reached by keyboard
   * shortcut rather than by clicking, which makes it the one most likely to be driven entirely
   * without a mouse.
   */
  return (
    <div
      className="fixed inset-0 z-[70] flex items-start justify-center bg-black/50 pt-[12vh] backdrop-blur-sm"
      onClick={onClose}
      ref={trapRef}
      role="dialog"
      aria-modal="true"
      aria-label="Command palette"
      tabIndex={-1}
    >
      <div className="w-full max-w-xl overflow-hidden rounded-2xl border border-ink-700 bg-ink-900 shadow-2xl" onClick={(e) => e.stopPropagation()}>
        <input
          ref={inputRef}
          // The search field, not the first button — the palette exists to be typed into.
          data-autofocus
          value={q}
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'ArrowDown') { e.preventDefault(); setActive((a) => Math.min(a + 1, items.length - 1)); }
            else if (e.key === 'ArrowUp') { e.preventDefault(); setActive((a) => Math.max(a - 1, 0)); }
            else if (e.key === 'Enter') { e.preventDefault(); choose(items[active]); }
            else if (e.key === 'Escape') onClose();
          }}
          placeholder="Go to a page, run an action, or search the codebase…"
          className="w-full border-b border-ink-800 bg-transparent px-4 py-3.5 text-sm text-slate-200 placeholder:text-slate-600 focus:outline-none"
        />
        <ul className="max-h-80 overflow-auto py-1">
          {!items.length && <li className="px-4 py-6 text-center text-xs text-slate-600">No matches.</li>}
          {items.slice(0, 40).map((it, i) => (
            <li key={i}>
              <button
                onMouseEnter={() => setActive(i)}
                onClick={() => choose(it)}
                className={`flex w-full items-center gap-3 px-4 py-2 text-left text-[13px] ${i === active ? 'bg-ink-800 text-white' : 'text-slate-300'}`}
              >
                <span className="text-[10px] uppercase tracking-wide text-slate-600">{KIND[it.kind] || '›'}</span>
                <span className="flex-1 truncate">{it.label}</span>
                <span className="text-[10px] text-slate-600">{it.hint}</span>
              </button>
            </li>
          ))}
        </ul>
        <div className="flex items-center gap-3 border-t border-ink-800 px-4 py-2 text-[10px] text-slate-600">
          <span><kbd className="rounded bg-ink-800 px-1">↑↓</kbd> navigate</span>
          <span><kbd className="rounded bg-ink-800 px-1">↵</kbd> select</span>
          <span><kbd className="rounded bg-ink-800 px-1">esc</kbd> close</span>
          <div className="flex-1" />
          {searching && <span>searching the codebase…</span>}
          {!searching && knowledge?.stats && <span>{knowledge.stats.documents} docs · {knowledge.mode || 'lexical'}</span>}
        </div>
      </div>
    </div>
  );
}

const KIND = { view: 'go', action: 'run', proposal: 'prop', iteration: 'iter', feature: 'feat', code: 'code', lesson: 'lesson', change: 'change' };

function fuzzy(str, q) {
  let i = 0;
  for (const c of str) if (c === q[i]) i++;
  return i === q.length;
}
