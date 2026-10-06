import { useEffect, useMemo, useState } from 'react';
import { api } from '../api.js';
import { CardHead, Empty, Spinner, ago } from '../components/ui.jsx';
import { navCatalog } from '../nav.js';

/**
 * The admin control center: user directory, the whole project fleet, a read-only
 * explorer over every ISL database, dashboard/menu control, live sessions, the
 * platform audit trail, and system health. Reachable only by administrators (the
 * nav item is role-gated, and every endpoint re-checks on the server).
 */
const TABS = [
  ['users', 'Users'],
  ['projects', 'Projects'],
  ['databases', 'Databases'],
  ['dashboard', 'Dashboard'],
  ['sessions', 'Sessions'],
  ['audit', 'Audit'],
  ['system', 'System'],
];

export default function Admin({ user, toast, onConfigSaved, onNavigate }) {
  const [tab, setTab] = useState('users');
  const [overview, setOverview] = useState(null);

  useEffect(() => {
    api.adminOverview().then(setOverview).catch((e) => toast?.(e.message, { type: 'error' }));
  }, []);

  return (
    <div className="mx-auto max-w-6xl space-y-4">
      <div>
        <h1 className="text-lg font-semibold text-white">Admin control center</h1>
        <p className="text-[12px] text-slate-500">Full control of the platform — people, projects, data, and the dashboard itself.</p>
      </div>

      {overview && (
        <div className="grid gap-3 sm:grid-cols-4">
          <Stat label="Users" value={overview.users.total} />
          <Stat label="Admins" value={overview.users.admins} />
          <Stat label="Pending" value={overview.users.pending} tone={overview.users.pending ? 'warn' : 'ok'} />
          <Stat label="Projects" value={overview.projects} />
        </div>
      )}

      <div className="flex flex-wrap gap-1 border-b border-ink-800 pb-2">
        {TABS.map(([id, label]) => (
          <button
            key={id}
            onClick={() => setTab(id)}
            className={`rounded-lg px-3 py-1.5 text-[12px] ${tab === id ? 'bg-ink-800 text-white' : 'text-slate-400 hover:bg-ink-900'}`}
          >
            {label}
          </button>
        ))}
      </div>

      {tab === 'users' && <Users me={user} toast={toast} />}
      {tab === 'projects' && <Projects toast={toast} onNavigate={onNavigate} />}
      {tab === 'databases' && <Databases toast={toast} />}
      {tab === 'dashboard' && <DashboardControl toast={toast} onSaved={onConfigSaved} />}
      {tab === 'sessions' && <Sessions toast={toast} />}
      {tab === 'audit' && <Audit toast={toast} />}
      {tab === 'system' && <System toast={toast} />}
    </div>
  );
}

/* ------------------------------- projects -------------------------------- */

function Projects({ toast, onNavigate }) {
  const [data, setData] = useState(null);
  const load = () => api.projects().then(setData).catch((e) => toast?.(e.message, { type: 'error' }));
  useEffect(() => { load(); }, []);
  if (!data) return <div className="grid h-32 place-items-center text-slate-500"><Spinner /></div>;
  const list = data.list || [];
  const activeId = data.active?.id;

  const switchTo = async (id) => {
    try { await api.switchProject(id); toast?.('Active project switched', { type: 'success' }); load(); }
    catch (e) { toast?.(e.message, { type: 'error' }); }
  };

  return (
    <div className="card overflow-hidden">
      <div className="card-head">
          <span className="card-title">All projects ({list.length})</span>
<button onClick={() => onNavigate?.('projects')} className="btn-ghost">Open Projects workspace →</button>
      </div>
      <table className="w-full text-[12px]">
        <thead className="bg-ink-900/60 text-left text-[10px] uppercase tracking-wide text-slate-500">
          <tr><th className="px-3 py-2">Project</th><th className="px-3 py-2">Source folder</th><th className="px-3 py-2">Branch</th><th className="px-3 py-2">Context</th><th className="px-3 py-2"></th></tr>
        </thead>
        <tbody className="divide-y divide-ink-800">
          {list.map((p) => (
            <tr key={p.id} className={p.id === activeId ? 'bg-brand/5' : ''}>
              <td className="px-3 py-2">
                <div className="font-medium text-slate-200">{p.name} {p.id === activeId && <span className="pill bg-emerald-500/15 text-emerald-300">active</span>} {p.archived && <span className="pill bg-ink-800 text-slate-500">archived</span>}</div>
                <div className="font-mono text-[10px] text-slate-600">{p.id}</div>
              </td>
              <td className="px-3 py-2 font-mono text-[10px] text-slate-400">{p.codePath}</td>
              <td className="px-3 py-2 text-slate-400">{p.baseBranch || '—'}</td>
              <td className="px-3 py-2">{p.contextReady ? <span className="pill bg-emerald-500/15 text-emerald-300">ready</span> : <span className="pill bg-amber-500/15 text-amber-300">pending</span>}</td>
              <td className="px-3 py-2 text-right">
                {p.id !== activeId && !p.archived && <button onClick={() => switchTo(p.id)} className="btn-ghost">Activate</button>}
              </td>
            </tr>
          ))}
          {!list.length && <tr><td colSpan={5}><Empty title="No projects" /></td></tr>}
        </tbody>
      </table>
    </div>
  );
}

/* ------------------------------ databases -------------------------------- */

function Databases({ toast }) {
  const [dbs, setDbs] = useState(null);
  const [dbId, setDbId] = useState('platform');
  const [tables, setTables] = useState(null);
  const [table, setTable] = useState(null);
  const [rows, setRows] = useState(null);
  const [sql, setSql] = useState('');
  const [queryResult, setQueryResult] = useState(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => { api.databases().then((d) => setDbs(d.databases)).catch((e) => toast?.(e.message, { type: 'error' })); }, []);
  useEffect(() => {
    setTable(null); setRows(null); setTables(null); setQueryResult(null);
    api.dbTables(dbId).then((d) => setTables(d.tables)).catch((e) => toast?.(e.message, { type: 'error' }));
  }, [dbId]);

  const openTable = (name) => {
    setTable(name); setRows(null); setQueryResult(null);
    api.dbRows(dbId, name, 50, 0).then(setRows).catch((e) => toast?.(e.message, { type: 'error' }));
  };
  const runSql = async () => {
    setBusy(true); setQueryResult(null);
    try { setQueryResult(await api.dbQuery(dbId, sql)); }
    catch (e) { toast?.(e.message, { type: 'error' }); }
    finally { setBusy(false); }
  };

  if (!dbs) return <div className="grid h-32 place-items-center text-slate-500"><Spinner /></div>;

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <span className="stat-label">Database</span>
        <select value={dbId} onChange={(e) => setDbId(e.target.value)} className="input max-w-md">
          {dbs.map((d) => <option key={d.id} value={d.id} disabled={!d.exists}>{d.label}{d.exists ? ` · ${(d.sizeBytes / 1024).toFixed(0)} KB` : ' · (not created)'}</option>)}
        </select>
      </div>

      <div className="grid gap-3 lg:grid-cols-[220px_1fr]">
        {/* tables list */}
        <div className="card max-h-[60vh] overflow-y-auto">
          <div className="card-head">
          <span className="card-title">Tables {tables ? `(${tables.length})` : ''}</span>
        </div>
          {!tables ? <div className="grid h-24 place-items-center"><Spinner /></div> : (
            <div className="divide-y divide-ink-800">
              {tables.map((t) => (
                <button key={t.name} onClick={() => openTable(t.name)} className={`flex w-full items-center justify-between px-3 py-1.5 text-left text-[12px] hover:bg-ink-900 ${table === t.name ? 'bg-ink-800 text-white' : 'text-slate-300'}`}>
                  <span className="truncate font-mono">{t.name}</span>
                  <span className="pill bg-ink-800 text-slate-500">{t.rows}</span>
                </button>
              ))}
              {!tables.length && <Empty title="No tables" />}
            </div>
          )}
        </div>

        {/* rows / query */}
        <div className="space-y-3">
          <div className="card p-3">
            <div className="mb-1 flex items-center gap-2">
              <span className="card-title">Query</span>
              <span className="text-[10px] text-slate-500">read-only · SELECT / WITH / PRAGMA table_info</span>
              <div className="flex-1" />
              <button disabled={busy || !sql.trim()} onClick={runSql} className="btn-primary">{busy ? <Spinner /> : 'Run'}</button>
            </div>
            <textarea value={sql} onChange={(e) => setSql(e.target.value)} rows={2} placeholder={`SELECT * FROM ${table || 'table'} LIMIT 20`} className="input w-full font-mono text-[11px]" />
          </div>

          {queryResult && <DataGrid title={`Query result (${queryResult.count}${queryResult.capped ? ', capped' : ''})`} columns={queryResult.columns} rows={queryResult.rows} />}
          {!queryResult && table && rows && <DataGrid title={`${table} · ${rows.total} row(s)`} columns={rows.columns.map((c) => c.name)} rows={rows.rows} />}
          {!queryResult && !table && <Empty icon="🗄️" title="Pick a table" hint="Choose a table on the left to browse its rows, or run a SELECT query above." />}
        </div>
      </div>
    </div>
  );
}

function DataGrid({ title, columns, rows }) {
  return (
    <div className="card overflow-hidden">
      <div className="card-head">
          <span className="card-title">{title}</span>
        </div>
      <div className="max-h-[55vh] overflow-auto">
        <table className="w-full text-[11px]">
          <thead className="sticky top-0 bg-ink-900 text-left text-[10px] uppercase tracking-wide text-slate-500">
            <tr>{columns.map((c) => <th key={c} className="whitespace-nowrap px-3 py-2">{c}</th>)}</tr>
          </thead>
          <tbody className="divide-y divide-ink-800">
            {rows.map((r, i) => (
              <tr key={i} className="hover:bg-ink-900/50">
                {columns.map((c) => <td key={c} className="max-w-[320px] truncate px-3 py-1.5 font-mono text-slate-300" title={fmt(r[c])}>{fmt(r[c])}</td>)}
              </tr>
            ))}
            {!rows.length && <tr><td colSpan={columns.length}><Empty title="No rows" /></td></tr>}
          </tbody>
        </table>
      </div>
    </div>
  );
}
const fmt = (v) => (v === null || v === undefined ? '∅' : typeof v === 'object' ? JSON.stringify(v) : String(v));

/* --------------------------- dashboard control --------------------------- */

function DashboardControl({ toast, onSaved }) {
  const catalog = useMemo(() => navCatalog(true), []);
  const [cfg, setCfg] = useState(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => { api.adminDashboardConfig().then(setCfg).catch((e) => toast?.(e.message, { type: 'error' })); }, []);
  if (!cfg) return <div className="grid h-32 place-items-center text-slate-500"><Spinner /></div>;

  const hidden = new Set(cfg.hidden || []);
  const labels = cfg.labels || {};
  const allItems = catalog.flatMap((g) => g.items);
  const UNHIDEABLE = new Set(['overview', 'admin']);

  const toggle = (id) => {
    const h = new Set(hidden);
    h.has(id) ? h.delete(id) : h.add(id);
    setCfg({ ...cfg, hidden: [...h] });
  };
  const rename = (id, label) => setCfg({ ...cfg, labels: { ...labels, [id]: label } });
  const save = async () => {
    setBusy(true);
    try {
      const saved = await api.saveDashboardConfig(cfg);
      setCfg(saved);
      toast?.('Dashboard updated for everyone', { type: 'success' });
      onSaved?.();
    } catch (e) { toast?.(e.message, { type: 'error' }); }
    finally { setBusy(false); }
  };

  return (
    <div className="space-y-3">
      <div className="card p-3">
        <div className="flex flex-wrap items-center gap-3">
          <div className="min-w-0">
            <div className="card-title">Default landing view</div>
            <div className="text-[11px] text-slate-500">Where everyone lands when they open the dashboard without a specific link.</div>
          </div>
          <div className="flex-1" />
          <select value={cfg.defaultView} onChange={(e) => setCfg({ ...cfg, defaultView: e.target.value })} className="input max-w-xs">
            {allItems.filter((it) => !hidden.has(it.id)).map((it) => <option key={it.id} value={it.id}>{labels[it.id] || it.label}</option>)}
          </select>
          <button disabled={busy} onClick={save} className="btn-primary">{busy ? <Spinner /> : 'Save changes'}</button>
        </div>
      </div>

      <p className="text-[11px] text-slate-500">Toggle any menu item off to hide it for all users, or rename it. Overview and Admin can't be hidden.</p>

      {catalog.map((g) => (
        <div key={g.title} className="card">
          <CardHead title={<>{g.title}</>} />
          <div className="divide-y divide-ink-800">
            {g.items.map((it) => {
              const isHidden = hidden.has(it.id);
              const locked = UNHIDEABLE.has(it.id);
              return (
                <div key={it.id} className="flex items-center gap-3 px-3 py-2">
                  <span className="w-5 text-center text-slate-500">{it.icon}</span>
                  <input
                    value={labels[it.id] ?? it.label}
                    onChange={(e) => rename(it.id, e.target.value)}
                    className="w-44 rounded border border-ink-700 bg-ink-950 px-2 py-1 text-[12px] text-slate-200"
                  />
                  <span className="font-mono text-[10px] text-slate-600">{it.id}</span>
{labels[it.id] && labels[it.id] !== it.label && <button onClick={() => rename(it.id, it.label)} className="btn-ghost text-[10px]">reset name</button>}
                  <button
                    disabled={locked}
                    onClick={() => toggle(it.id)}
                    className={`pill ${locked ? 'bg-ink-800 text-slate-600' : isHidden ? 'bg-rose-500/15 text-rose-300' : 'bg-emerald-500/15 text-emerald-300'}`}
                    title={locked ? 'Always visible' : isHidden ? 'Hidden — click to show' : 'Visible — click to hide'}
                  >
                    {locked ? 'always on' : isHidden ? 'hidden' : 'visible'}
                  </button>
                </div>
              );
            })}
          </div>
        </div>
      ))}
    </div>
  );
}

function Sessions({ toast }) {
  const [rows, setRows] = useState(null);
  const load = () => api.adminSessions().then(setRows).catch((e) => toast?.(e.message, { type: 'error' }));
  useEffect(() => {
    load();
  }, []);
  if (!rows) return <div className="grid h-32 place-items-center text-slate-500"><Spinner /></div>;
  const revoke = async (id, email) => {
    if (!confirm(`Sign out all sessions for ${email}?`)) return;
    try {
      await api.revokeUserSessions(id);
      toast?.('Sessions revoked', { type: 'success' });
      load();
    } catch (e) {
      toast?.(e.message, { type: 'error' });
    }
  };
  return (
    <div className="card">
      <div className="card-head">
          <span className="card-title">Active sessions ({rows.length})</span>
        </div>
      <div className="divide-y divide-ink-800">
        {rows.map((s, i) => (
          <div key={i} className="flex items-center gap-3 px-3 py-2 text-[12px]">
            <span className="min-w-0 flex-1">
              <span className="font-medium text-slate-200">{s.email}</span>
              <span className="ml-2 text-[10px] text-slate-600">{s.ip || '—'} · started {ago(s.createdAt)} · expires {ago(s.expiresAt)}</span>
            </span>
            <span className={`pill ${s.role === 'admin' ? 'bg-brand/15 text-brand-light' : 'bg-ink-800 text-slate-400'}`}>{s.role}</span>
            <button onClick={() => revoke(s.userId, s.email)} className="btn-ghost">Sign out</button>
          </div>
        ))}
        {!rows.length && <Empty title="No active sessions" />}
      </div>
    </div>
  );
}

function System({ toast }) {
  const [sys, setSys] = useState(null);
  useEffect(() => {
    api.adminSystem().then(setSys).catch((e) => toast?.(e.message, { type: 'error' }));
  }, []);
  if (!sys) return <div className="grid h-32 place-items-center text-slate-500"><Spinner /></div>;
  const rows = [
    ['ISL version', sys.version],
    ['Node', sys.node],
    ['Uptime', `${Math.floor(sys.uptimeSec / 3600)}h ${Math.floor((sys.uptimeSec % 3600) / 60)}m`],
    ['Memory (RSS)', `${sys.memoryMB} MB`],
    ['Active project', sys.activeProject || '—'],
    ['Projects', sys.projects],
    ['Users', sys.users],
    ['Active sessions', sys.activeSessions],
    ['Best-practice rules', sys.bestPractices],
    ['LLM model', sys.ollama.model],
    ['LLM chat model', sys.ollama.chatModel],
    ['LLM host', sys.ollama.host],
  ];
  return (
    <div className="card">
      <CardHead title="System" />
      <div className="grid gap-x-6 gap-y-2 p-4 sm:grid-cols-2">
        {rows.map(([k, v]) => (
          <div key={k} className="flex items-center justify-between border-b border-ink-800/50 py-1 text-[12px]">
            <span className="text-slate-500">{k}</span>
            <span className="font-mono text-slate-300">{v}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

function Users({ me, toast }) {
  const [users, setUsers] = useState(null);
  const [creating, setCreating] = useState(false);

  const load = () => api.users().then(setUsers).catch((e) => toast?.(e.message, { type: 'error' }));
  useEffect(() => {
    load();
  }, []);

  if (!users) return <div className="grid h-32 place-items-center text-slate-500"><Spinner /></div>;

  return (
    <div className="space-y-3">
      <div className="flex justify-end">
        <button onClick={() => setCreating((v) => !v)} className="btn-primary">{creating ? '✕ Cancel' : '＋ Invite user'}</button>
      </div>
      {creating && <CreateUser onDone={() => { setCreating(false); load(); }} toast={toast} />}

      <div className="card overflow-hidden">
        <table className="w-full text-[12px]">
          <thead className="bg-ink-900/60 text-left text-[10px] uppercase tracking-wide text-slate-500">
            <tr>
              <th className="px-3 py-2">Email</th>
              <th className="px-3 py-2">Role</th>
              <th className="px-3 py-2">Status</th>
              <th className="px-3 py-2">Last login</th>
              <th className="px-3 py-2"></th>
            </tr>
          </thead>
          <tbody className="divide-y divide-ink-800">
            {users.map((u) => <UserRow key={u.id} u={u} me={me} onChanged={load} toast={toast} />)}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function UserRow({ u, me, onChanged, toast }) {
  const [busy, setBusy] = useState(false);
  const self = u.id === me.id;

  const patch = async (body) => {
    setBusy(true);
    try {
      await api.updateUser(u.id, body);
      onChanged();
    } catch (e) {
      toast?.(e.message, { type: 'error' });
    } finally {
      setBusy(false);
    }
  };

  const resetPw = async () => {
    const pw = prompt(`Set a new password for ${u.email} (min 8 chars):`);
    if (!pw) return;
    if (pw.length < 8) return toast?.('Password too short', { type: 'error' });
    await patch({ password: pw });
    toast?.('Password reset', { type: 'success' });
  };

  const remove = async () => {
    if (!confirm(`Delete ${u.email}? This cannot be undone.`)) return;
    setBusy(true);
    try {
      await api.deleteUser(u.id);
      onChanged();
    } catch (e) {
      toast?.(e.message, { type: 'error' });
    } finally {
      setBusy(false);
    }
  };

  return (
    <tr className={busy ? 'opacity-50' : ''}>
      <td className="px-3 py-2">
        <div className="font-medium text-slate-200">{u.email}{self && <span className="ml-1 text-[10px] text-slate-500">(you)</span>}</div>
        {u.name && <div className="text-[10px] text-slate-500">{u.name}</div>}
      </td>
      <td className="px-3 py-2">
        <select value={u.role} disabled={busy} onChange={(e) => patch({ role: e.target.value })} className="rounded border border-ink-700 bg-ink-950 px-1.5 py-1 text-[11px]">
          <option value="admin">admin</option>
          <option value="user">user</option>
          <option value="viewer">viewer</option>
        </select>
      </td>
      <td className="px-3 py-2">
        <span className={`pill ${u.status === 'active' ? 'bg-emerald-500/15 text-emerald-300' : u.status === 'pending' ? 'bg-amber-500/15 text-amber-300' : 'bg-rose-500/15 text-rose-300'}`}>
          {u.status}
        </span>
      </td>
      <td className="px-3 py-2 text-[11px] text-slate-500">{u.lastLogin ? ago(u.lastLogin) : '—'}</td>
      <td className="px-3 py-2">
        <div className="flex justify-end gap-1">
          {u.status === 'disabled' ? (
            <button disabled={busy} onClick={() => patch({ status: 'active' })} className="btn-ghost">Enable</button>
          ) : (
            <button disabled={busy || self} onClick={() => patch({ status: 'disabled' })} className="btn-ghost">Disable</button>
          )}
          <button disabled={busy} onClick={resetPw} className="btn-ghost">Reset PW</button>
          <button disabled={busy || self} onClick={remove} className="btn-danger">Delete</button>
        </div>
      </td>
    </tr>
  );
}

function CreateUser({ onDone, toast }) {
  const [email, setEmail] = useState('');
  const [name, setName] = useState('');
  const [role, setRole] = useState('user');
  const [busy, setBusy] = useState(false);

  const create = async () => {
    setBusy(true);
    try {
      await api.createUser({ email: email.trim(), name: name.trim(), role });
      toast?.('User invited — they set their password on first sign-in', { type: 'success' });
      onDone();
    } catch (e) {
      toast?.(e.message, { type: 'error' });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="card p-4">
      <div className="grid gap-3 sm:grid-cols-3">
        <label className="block sm:col-span-2">
          <span className="stat-label">Email</span>
          <input className="input mt-1" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="teammate@example.com" />
        </label>
        <label className="block">
          <span className="stat-label">Role</span>
          <select value={role} onChange={(e) => setRole(e.target.value)} className="input mt-1">
            <option value="admin">admin</option>
            <option value="user">user</option>
            <option value="viewer">viewer</option>
          </select>
        </label>
        <label className="block sm:col-span-3">
          <span className="stat-label">Name (optional)</span>
          <input className="input mt-1" value={name} onChange={(e) => setName(e.target.value)} />
        </label>
      </div>
      <p className="mt-2 text-[10px] text-slate-500">The account starts pending — the first sign-in with this email sets the password and activates it.</p>
      <div className="mt-3 flex justify-end">
        <button disabled={busy || !email.trim()} onClick={create} className="btn-primary">{busy ? <Spinner /> : 'Send invite'}</button>
      </div>
    </div>
  );
}

function Audit({ toast }) {
  const [rows, setRows] = useState(null);
  useEffect(() => {
    api.audit(300).then(setRows).catch((e) => toast?.(e.message, { type: 'error' }));
  }, []);
  if (!rows) return <div className="grid h-32 place-items-center text-slate-500"><Spinner /></div>;
  return (
    <div className="card">
      <CardHead title="Audit trail" />
      <div className="max-h-[60vh] divide-y divide-ink-800 overflow-y-auto">
        {rows.map((r) => (
          <div key={r.id} className="flex items-center gap-3 px-3 py-1.5 text-[11px]">
            <span className="w-24 shrink-0 text-slate-600">{ago(r.ts)}</span>
            <span className="w-40 shrink-0 truncate text-slate-400">{r.actor}</span>
            <span className="shrink-0 font-mono text-slate-300">{r.action}</span>
            {r.target && <span className="truncate text-slate-500">{r.target}</span>}
          </div>
        ))}
        {!rows.length && <Empty title="No audit entries" />}
      </div>
    </div>
  );
}

const Stat = ({ label, value, tone }) => (
  <div className="card p-3">
    <div className="stat-label">{label}</div>
    <div className={`stat mt-1 ${tone === 'warn' ? 'text-amber-400' : 'text-white'}`}>{value}</div>
  </div>
);
