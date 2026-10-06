import { useEffect, useState } from 'react';
import { api } from '../api.js';
import { CardHead, Empty, Spinner, ago } from '../components/ui.jsx';

/**
 * Project registry: create, inspect and switch the code folders ISL manages.
 * Creation and editing are admin-only; switching the active project is open to
 * any operator (it changes the runtime for everyone — one loop, one folder).
 */
export default function Projects({ user, activeId, onSwitch, toast }) {
  const [projects, setProjects] = useState([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState(null);
  const isAdmin = user?.role === 'admin';

  const load = async () => {
    try {
      const { list } = await api.projects();
      setProjects(list);
    } catch (e) {
      toast?.(e.message, { type: 'error' });
    } finally {
      setLoading(false);
    }
  };
  useEffect(() => {
    load();
  }, []);

  const switchTo = async (id) => {
    setBusy(true);
    try {
      await onSwitch(id);
      toast?.('Switched project', { type: 'success' });
      await load();
    } catch (e) {
      toast?.(e.message, { type: 'error' });
    } finally {
      setBusy(false);
    }
  };

  const archive = async (id) => {
    setBusy(true);
    try {
      await api.archiveProject(id);
      toast?.('Project archived', { type: 'success' });
      await load();
    } catch (e) {
      toast?.(e.message, { type: 'error' });
    } finally {
      setBusy(false);
    }
  };

  if (loading) return <div className="grid h-40 place-items-center text-slate-500"><Spinner /></div>;

  return (
    <div className="mx-auto max-w-5xl space-y-4">
      {isAdmin && <CreateProject onCreated={load} toast={toast} />}

      <div className="card">
        <div className="card-head">
          <span className="card-title">Projects ({projects.filter((p) => !p.archived).length})</span>
        </div>
        <div className="divide-y divide-ink-800">
          {projects.filter((p) => !p.archived).map((p) => (
            <div key={p.id}>
              <div className="flex items-center gap-3 px-3 py-3">
                <span className={`h-2.5 w-2.5 rounded-full ${p.id === activeId ? 'bg-brand' : 'bg-slate-600'}`} />
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className="truncate text-[13px] font-semibold text-slate-200">{p.name}</span>
                    {p.id === activeId && <span className="pill bg-brand/20 text-brand-light">active</span>}
                    {p.contextReady ? (
                      <span className="pill bg-emerald-500/15 text-emerald-300">context ready</span>
                    ) : (
                      <span className="pill bg-amber-500/15 text-amber-300">no context</span>
                    )}
                  </div>
                  <div className="truncate font-mono text-[11px] text-slate-500">{p.codePath}</div>
                  {p.description && <div className="mt-0.5 text-[11px] text-slate-500">{p.description}</div>}
                  <div className="mt-0.5 text-[10px] text-slate-600">created {ago(p.createdAt)}{p.baseBranch ? ` · base ${p.baseBranch}` : ''}</div>
                </div>
                <div className="flex shrink-0 items-center gap-2">
                  {p.id !== activeId && (
                    <button disabled={busy} onClick={() => switchTo(p.id)} className="btn-primary">Switch</button>
                  )}
                  {isAdmin && (
                    <button disabled={busy} onClick={() => setEditing(editing === p.id ? null : p.id)} className="btn-ghost">
                      Source
                    </button>
                  )}
                  {isAdmin && p.id !== activeId && (
                    <button disabled={busy} onClick={() => archive(p.id)} className="btn-ghost">Archive</button>
                  )}
                </div>
              </div>
              {isAdmin && editing === p.id && (
                <ChangeSource project={p} isActive={p.id === activeId} onDone={() => { setEditing(null); load(); }} onCancel={() => setEditing(null)} toast={toast} />
              )}
            </div>
          ))}
          {!projects.filter((p) => !p.archived).length && <Empty title="No projects" hint="Create one to point ISL at a code folder." />}
        </div>
      </div>

      {projects.some((p) => p.archived) && (
        <div className="card">
          <CardHead title="Archived" />
          <div className="divide-y divide-ink-800">
            {projects.filter((p) => p.archived).map((p) => (
              <div key={p.id} className="flex items-center gap-3 px-3 py-2 text-slate-500">
                <span className="truncate text-[12px]">{p.name}</span>
                <span className="truncate font-mono text-[10px]">{p.codePath}</span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

/** Change a project's source folder — destructive, so it confirms and warns. */
function ChangeSource({ project, isActive, onDone, onCancel, toast }) {
  const [codePath, setCodePath] = useState(project.codePath);
  const [probe, setProbe] = useState(null);
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const changed = codePath.trim() && codePath.trim() !== project.codePath;

  const validate = async () => {
    if (!codePath.trim()) return;
    try {
      setProbe(await api.validatePath(codePath.trim()));
    } catch (e) {
      setProbe({ error: e.message });
    }
  };

  const apply = async () => {
    setBusy(true);
    try {
      const r = await api.changeSource(project.id, codePath.trim());
      toast?.(r.reanalyzing ? 'Source changed — re-analysing from scratch…' : 'Source folder updated', { type: 'success' });
      onDone?.();
    } catch (e) {
      toast?.(e.message, { type: 'error' });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="border-t border-ink-800 bg-ink-950/40 px-4 py-3">
      <div className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-slate-400">Change source folder</div>
      <div className="flex gap-2">
        <input className="input" value={codePath} onChange={(e) => { setCodePath(e.target.value); setConfirming(false); }} onBlur={validate} />
        <button onClick={validate} className="btn-ghost shrink-0">Check</button>
      </div>
      {probe && (
        <div className="mt-2 text-[11px]">
          {probe.error ? <span className="text-rose-300">{probe.error}</span>
            : !probe.exists ? <span className="text-rose-300">Path does not exist.</span>
            : !probe.isDirectory ? <span className="text-rose-300">Not a directory.</span>
            : <span className="text-slate-400">✓ {probe.language} · {probe.productDirs?.join(', ') || '(no standard dirs)'} · base {probe.baseBranch}</span>}
        </div>
      )}

      {changed && !confirming && (
        <div className="mt-3 flex items-center justify-end gap-2">
          <button onClick={onCancel} className="btn-ghost">Cancel</button>
          <button disabled={probe && !probe.isDirectory} onClick={() => setConfirming(true)} className="btn-danger">Change source…</button>
        </div>
      )}

      {changed && confirming && (
        <div className="mt-3 rounded-lg border border-amber-800/60 bg-amber-950/30 p-3">
          <div className="text-[12px] font-semibold text-amber-300">⚠ This resets the project's analysis</div>
          <ul className="mt-1 list-disc space-y-0.5 pl-5 text-[11px] text-amber-200/80">
            <li>The entire backlog (hotspots + feature ideas) will be <strong>wiped</strong>.</li>
            <li>The document index, project profile and onboarding answers will be <strong>cleared</strong>.</li>
            <li>ISL will <strong>re-analyse the new folder from scratch</strong> (survey + context rebuild).</li>
            {isActive && <li>This is the <strong>active</strong> project — the running loop is paused for the switch.</li>}
          </ul>
          <div className="mt-3 flex items-center justify-end gap-2">
            <button onClick={() => setConfirming(false)} className="btn-ghost">Back</button>
            <button disabled={busy} onClick={apply} className="btn-danger">{busy ? <Spinner /> : 'Yes, change & re-analyse'}</button>
          </div>
        </div>
      )}
    </div>
  );
}

function CreateProject({ onCreated, toast }) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState('');
  const [codePath, setCodePath] = useState('');
  const [baseBranch, setBaseBranch] = useState('');
  const [description, setDescription] = useState('');
  const [probe, setProbe] = useState(null);
  const [busy, setBusy] = useState(false);

  const validate = async () => {
    if (!codePath.trim()) return;
    try {
      setProbe(await api.validatePath(codePath.trim()));
    } catch (e) {
      setProbe({ error: e.message });
    }
  };

  const create = async () => {
    setBusy(true);
    try {
      await api.createProject({ name: name.trim(), codePath: codePath.trim(), baseBranch: baseBranch.trim() || null, description });
      toast?.('Project created', { type: 'success' });
      setName(''); setCodePath(''); setBaseBranch(''); setDescription(''); setProbe(null); setOpen(false);
      onCreated?.();
    } catch (e) {
      toast?.(e.message, { type: 'error' });
    } finally {
      setBusy(false);
    }
  };

  if (!open) {
    return (
      <button onClick={() => setOpen(true)} className="btn-primary">＋ New project</button>
    );
  }

  return (
    <div className="card p-4">
      <div className="mb-3 flex items-center justify-between">
        <span className="card-title">New project</span>
        <button onClick={() => setOpen(false)} className="btn-ghost">✕</button>
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        <label className="block">
          <span className="stat-label">Name</span>
          <input className="input mt-1" value={name} onChange={(e) => setName(e.target.value)} placeholder="My App" />
        </label>
        <label className="block">
          <span className="stat-label">Base branch (optional)</span>
          <input className="input mt-1" value={baseBranch} onChange={(e) => setBaseBranch(e.target.value)} placeholder="auto-detect" />
        </label>
        <label className="block sm:col-span-2">
          <span className="stat-label">Code folder (absolute path)</span>
          <div className="mt-1 flex gap-2">
            <input className="input" value={codePath} onChange={(e) => setCodePath(e.target.value)} onBlur={validate} placeholder="C:\\path\\to\\project" />
            <button onClick={validate} className="btn-ghost shrink-0">Check</button>
          </div>
        </label>
        <label className="block sm:col-span-2">
          <span className="stat-label">Description (optional)</span>
          <input className="input mt-1" value={description} onChange={(e) => setDescription(e.target.value)} />
        </label>
      </div>

      {probe && (
        <div className="mt-3 rounded-lg border border-ink-700 bg-ink-950/60 px-3 py-2 text-[11px]">
          {probe.error ? (
            <span className="text-rose-300">{probe.error}</span>
          ) : !probe.exists ? (
            <span className="text-rose-300">That path does not exist.</span>
          ) : !probe.isDirectory ? (
            <span className="text-rose-300">That path is not a directory.</span>
          ) : (
            <span className="text-slate-400">
              ✓ {probe.language} · dirs: {probe.productDirs?.join(', ') || '(none detected)'}
              {probe.services?.length ? ` · services: ${probe.services.join(', ')}` : ''} · base {probe.baseBranch}
            </span>
          )}
        </div>
      )}

      <div className="mt-4 flex justify-end gap-2">
        <button onClick={() => setOpen(false)} className="btn-ghost">Cancel</button>
        <button disabled={busy || !name.trim() || !codePath.trim() || (probe && !probe.isDirectory)} onClick={create} className="btn-primary">
          {busy ? <Spinner /> : 'Create project'}
        </button>
      </div>
    </div>
  );
}
