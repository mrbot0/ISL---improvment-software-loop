import { useEffect, useState } from 'react';
import { api } from '../api.js';
import { useResource } from '../hooks.js';
import { SAFETY_NET_MS } from '../liveKeys.js';
import FileTree from '../components/FileTree.jsx';
import CodeEditor from '../components/CodeEditor.jsx';
import { AGENT_META, SeverityPill, Spinner, StatusPill, ago } from '../components/ui.jsx';

/**
 * The Explorer: a file browser + code editor for the repo. Two pages —
 *  • Home   — what's changed (working tree), what the agents proposed, and a jump-in.
 *  • Editor — file tree + editor, switchable between `main` (editable working tree)
 *             and the work branch (read-only view of the agents' committed output).
 */
export default function Explorer({ proposals, onOpenProposal, toast }) {
  const [page, setPage] = useState('home');
  const [openPath, setOpenPath] = useState(null);

  const openInEditor = (path) => {
    setOpenPath(path);
    setPage('editor');
  };

  return (
    <div className="flex h-full flex-col">
      <div className="mb-3 flex items-center gap-1">
        {[['home', 'Home'], ['editor', 'Editor']].map(([id, label]) => (
          <button
            key={id}
            onClick={() => setPage(id)}
            className={`rounded-lg px-3 py-1.5 text-[13px] font-medium transition-colors ${page === id ? 'bg-ink-800 text-white' : 'text-slate-500 hover:text-slate-300'}`}
          >
            {label}
          </button>
        ))}
      </div>
      <div className="min-h-0 flex-1">
        {page === 'home' ? (
          <Home proposals={proposals} onOpenProposal={onOpenProposal} openInEditor={openInEditor} />
        ) : (
          <Editor initialPath={openPath} toast={toast} />
        )}
      </div>
    </div>
  );
}

/* ---------------------------------- Home ---------------------------------- */

function Home({ proposals, onOpenProposal, openInEditor }) {
  // File status changes when an iteration writes to the tree, which is an event — no 6-second poll.
  const { data: status } = useResource('files:status', api.filesStatus, { interval: SAFETY_NET_MS });

  const open = (proposals || []).filter((p) => ['verified', 'failed', 'verifying'].includes(p.status));

  return (
    <div className="grid h-full gap-3 lg:grid-cols-3">
      {/* Modified code (working tree) */}
      <div className="card flex min-h-0 flex-col">
        <div className="border-b border-ink-800 px-3 py-2">
          <h3 className="text-xs font-semibold uppercase tracking-wide text-slate-400">Modified code</h3>
          <p className="text-[10px] text-slate-600">uncommitted changes on {status?.branch || 'main'}</p>
        </div>
        <div className="min-h-0 flex-1 overflow-auto p-1.5">
          {!status ? (
            <div className="grid h-24 place-items-center"><Spinner /></div>
          ) : !status.modified.length ? (
            <div className="px-3 py-6 text-center text-[11px] text-slate-600">Working tree clean — no tracked changes.</div>
          ) : (
            <ul>
              {status.modified.map((f) => (
                <li key={f.path}>
                  <button onClick={() => openInEditor(f.path)} className="flex w-full items-center gap-2 rounded px-2 py-1 text-left text-[11px] hover:bg-ink-800">
                    <span className="w-4 shrink-0 text-center font-mono text-amber-400">{f.code || 'M'}</span>
                    <span className="truncate text-slate-300">{f.path}</span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
        {status?.workAhead > 0 && (
          <div className="border-t border-ink-800 px-3 py-2 text-[10px] text-emerald-400">
            {status.workAhead} agent commit(s) on {status.workBranch} — view them in the Editor's work-branch mode.
          </div>
        )}
      </div>

      {/* Code to modify — jump into the tree */}
      <div className="card flex min-h-0 flex-col">
        <div className="border-b border-ink-800 px-3 py-2">
          <h3 className="text-xs font-semibold uppercase tracking-wide text-slate-400">Code to modify</h3>
          <p className="text-[10px] text-slate-600">browse the repo and open a file to edit</p>
        </div>
        <div className="min-h-0 flex-1 overflow-auto">
          <QuickTree onOpen={openInEditor} />
        </div>
        <button onClick={() => openInEditor(null)} className="btn-primary m-2">open the editor →</button>
      </div>

      {/* Proposal code (agents) */}
      <div className="card flex min-h-0 flex-col">
        <div className="border-b border-ink-800 px-3 py-2">
          <h3 className="text-xs font-semibold uppercase tracking-wide text-slate-400">Proposal code</h3>
          <p className="text-[10px] text-slate-600">changes the agents drafted, awaiting review</p>
        </div>
        <div className="min-h-0 flex-1 overflow-auto p-1.5">
          {!open.length ? (
            <div className="px-3 py-6 text-center text-[11px] text-slate-600">No proposals awaiting review.</div>
          ) : (
            <ul className="space-y-0.5">
              {open.map((p) => {
                const meta = AGENT_META[p.agentId] ?? { emoji: '🤖' };
                return (
                  <li key={p.id}>
                    <button onClick={() => onOpenProposal(p.id)} className="w-full rounded px-2 py-1.5 text-left hover:bg-ink-800">
                      <div className="flex items-center gap-1.5">
                        <span>{meta.emoji}</span>
                        <span className="font-mono text-[10px] text-slate-600">#{p.id}</span>
                        <StatusPill status={p.status} />
                        <SeverityPill severity={p.severity} />
                      </div>
                      <div className="mt-0.5 truncate text-[11px] text-slate-300">{p.title}</div>
                      <code className="text-[10px] text-slate-600">{p.paths?.[0]}</code>
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      </div>
    </div>
  );
}

/** A compact always-open-at-root tree for the Home "code to modify" panel. */
function QuickTree({ onOpen }) {
  return (
    <div className="px-1 py-1">
      <FileTree gitRef="main" selected={null} onSelect={onOpen} />
    </div>
  );
}

/* --------------------------------- Editor --------------------------------- */

function Editor({ initialPath, toast }) {
  const [gitRef, setGitRef] = useState('main');
  const [selected, setSelected] = useState(initialPath || null);
  const [file, setFile] = useState(null);
  const [draft, setDraft] = useState('');
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (initialPath) setSelected(initialPath);
  }, [initialPath]);

  useEffect(() => {
    if (!selected) {
      setFile(null);
      return;
    }
    let alive = true;
    api.fileRead(selected, gitRef).then((f) => {
      if (!alive) return;
      setFile(f);
      setDraft(f.content || '');
      setDirty(false);
    }).catch(() => {});
    return () => {
      alive = false;
    };
  }, [selected, gitRef]);

  const save = async () => {
    if (!selected || !file?.editable) return;
    setSaving(true);
    try {
      await api.fileWrite(selected, draft);
      setDirty(false);
      toast?.(`Saved ${selected}`, { type: 'success' });
    } catch (e) {
      toast?.(e.message, { type: 'error' });
    } finally {
      setSaving(false);
    }
  };

  // Ctrl/Cmd-S to save.
  useEffect(() => {
    const onKey = (e) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
        e.preventDefault();
        save();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  const readOnly = gitRef === 'work' || !file?.editable;

  return (
    <div className="grid h-full grid-cols-[260px_minmax(0,1fr)] gap-3">
      {/* tree + branch switch */}
      <div className="card flex min-h-0 flex-col">
        <div className="border-b border-ink-800 p-2">
          <div className="flex rounded-lg bg-ink-950 p-0.5 text-[11px]">
            {[['main', 'main'], ['work', 'work branch']].map(([id, label]) => (
              <button
                key={id}
                onClick={() => setGitRef(id)}
                className={`flex-1 rounded-md px-2 py-1 font-medium transition-colors ${gitRef === id ? 'bg-ink-700 text-white' : 'text-slate-500 hover:text-slate-300'}`}
              >
                {label}
              </button>
            ))}
          </div>
          <p className="mt-1 px-1 text-[10px] text-slate-600">
            {gitRef === 'main' ? 'working tree — editable' : 'agents/auto-improve — read-only'}
          </p>
        </div>
        <div className="min-h-0 flex-1 overflow-auto">
          <FileTree gitRef={gitRef} selected={selected} onSelect={setSelected} />
        </div>
      </div>

      {/* editor */}
      <div className="card flex min-h-0 flex-col">
        <div className="flex items-center gap-2 border-b border-ink-800 px-3 py-2">
          {selected ? (
            <code className="truncate font-mono text-[12px] text-slate-300">{selected}</code>
          ) : (
            <span className="text-[12px] text-slate-600">select a file from the tree</span>
          )}
          {dirty && <span className="h-1.5 w-1.5 rounded-full bg-amber-400" title="unsaved changes" />}
          <div className="flex-1" />
          {file?.note && <span className="text-[10px] text-amber-500">{file.note}</span>}
          {selected && !readOnly && (
            <button onClick={save} disabled={saving || !dirty} className="btn-primary">
              {saving ? <><Spinner /> saving</> : '⌘S save'}
            </button>
          )}
        </div>
        <div className="min-h-0 flex-1 p-2">
          {!selected ? (
            <div className="grid h-full place-items-center text-xs text-slate-600">
              Pick a file to view or edit. Switch to the work branch to see what the agents committed.
            </div>
          ) : !file ? (
            <div className="grid h-full place-items-center"><Spinner /></div>
          ) : (
            <CodeEditor
              value={draft}
              readOnly={readOnly}
              onChange={(v) => {
                setDraft(v);
                setDirty(v !== (file.content || ''));
              }}
            />
          )}
        </div>
      </div>
    </div>
  );
}
