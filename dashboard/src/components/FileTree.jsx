import { useEffect, useState } from 'react';
import { api } from '../api.js';

const ICON = {
  js: '⬡', mjs: '⬡', cjs: '⬡', jsx: '⬢', ts: '⬡', tsx: '⬢',
  json: '{}', md: '¶', css: '#', html: '◇', yml: '⚙', yaml: '⚙', svg: '▲', env: '·',
};
const fileIcon = (name) => ICON[name.split('.').pop()] || '·';

/** One directory node — lazy-loads its children from the API when expanded. */
function Node({ entry, gitRef, depth, selected, onSelect }) {
  const [open, setOpen] = useState(false);
  const [children, setChildren] = useState(null);
  const [loading, setLoading] = useState(false);

  const load = async () => {
    if (children) return;
    setLoading(true);
    try {
      const t = await api.filesTree(entry.path, gitRef);
      setChildren(t.entries);
    } catch {
      setChildren([]);
    } finally {
      setLoading(false);
    }
  };

  // Reset cached children when the ref (branch) changes.
  useEffect(() => {
    setChildren(null);
    setOpen(false);
  }, [gitRef]);

  if (entry.type === 'dir') {
    return (
      <div>
        <button
          onClick={() => {
            const next = !open;
            setOpen(next);
            if (next) load();
          }}
          className="flex w-full items-center gap-1 rounded px-1 py-0.5 text-left text-[12px] text-slate-300 hover:bg-ink-800"
          style={{ paddingLeft: depth * 12 + 4 }}
        >
          <span className="w-3 shrink-0 text-slate-600">{open ? '▾' : '▸'}</span>
          <span className="shrink-0 text-amber-500/80">▸</span>
          <span className="truncate">{entry.name}</span>
        </button>
        {open && (
          <div>
            {loading && <div className="py-0.5 text-[10px] text-slate-600" style={{ paddingLeft: depth * 12 + 24 }}>…</div>}
            {children?.map((c) => (
              <Node key={c.path} entry={c} gitRef={gitRef} depth={depth + 1} selected={selected} onSelect={onSelect} />
            ))}
          </div>
        )}
      </div>
    );
  }

  return (
    <button
      onClick={() => onSelect(entry.path)}
      className={`flex w-full items-center gap-1.5 rounded px-1 py-0.5 text-left text-[12px] hover:bg-ink-800 ${
        selected === entry.path ? 'bg-ink-800 text-white' : 'text-slate-400'
      }`}
      style={{ paddingLeft: depth * 12 + 20 }}
    >
      <span className="w-3 shrink-0 text-center text-[10px] text-slate-600">{fileIcon(entry.name)}</span>
      <span className="truncate">{entry.name}</span>
    </button>
  );
}

/** Root file tree for a git ref. */
export default function FileTree({ gitRef, selected, onSelect }) {
  const [root, setRoot] = useState(null);

  useEffect(() => {
    let alive = true;
    api.filesTree('', gitRef).then((t) => alive && setRoot(t.entries)).catch(() => alive && setRoot([]));
    return () => {
      alive = false;
    };
  }, [gitRef]);

  if (!root) return <div className="p-3 text-[11px] text-slate-600">loading tree…</div>;
  return (
    <div className="py-1">
      {root.map((e) => (
        <Node key={e.path} entry={e} gitRef={gitRef} depth={0} selected={selected} onSelect={onSelect} />
      ))}
    </div>
  );
}
