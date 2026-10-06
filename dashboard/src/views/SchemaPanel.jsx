import { useState } from 'react';
import { api } from '../api.js';
import { useResource } from '../hooks.js';
import { Resource } from '../components/Resource.jsx';
import { Spinner } from '../components/ui.jsx';

/**
 * THE SCHEMA, AND WHETHER THE DATABASE STILL AGREES WITH IT.
 *
 * Prisma checks a model field against the real table only when a query runs. That one fact makes a
 * whole class of change invisible to every gate ISL has: the schema parses, nothing disappears from
 * any export, no suite covers it, and the service boots perfectly. The failure waits for the first
 * production read.
 *
 * It has happened. A run added a scalar field to a model that a service only MIRRORS — a model
 * documented as a read-only copy of a table that service does not own — with no migration. Weeks
 * later it surfaced as a whole class of records vanishing from the application: every read of that
 * model was asking Postgres for a column that had never existed.
 *
 * This panel is READ-ONLY, and deliberately so. It shows the schemas and reports what the integrity
 * agent found; it cannot edit a `.prisma` file or issue a single line of DDL. The database is the
 * one part of this system with no undo, and a control plane able to "fix" the schema it displays is
 * one confident mistake away from destroying what it exists to protect.
 */
/**
 * A name that tells the schemas apart.
 *
 * Nearly every one is at `<service>/prisma/schema.prisma`, so showing the last two path segments
 * labelled three different services identically — `prisma/schema.prisma`, three times, in a list
 * whose whole job is to let you pick between them. The distinguishing part is the directory ABOVE
 * `prisma`, so that is what is shown, with the rest as the title attribute.
 */
export function schemaLabel(p = '') {
  const parts = String(p).split('/').filter(Boolean);
  const i = parts.lastIndexOf('prisma');
  if (i > 0) return parts.slice(Math.max(0, i - 1), i).join('/');
  return parts.slice(-2).join('/') || p;
}

export default function SchemaPanel() {
  const schema = useResource('runtime-schema', () => api.runtimeSchema(), { interval: 0 });
  const [integrity, setIntegrity] = useState(null);
  const [checking, setChecking] = useState(false);
  const [openFile, setOpenFile] = useState(null);

  const check = async () => {
    setChecking(true);
    try {
      setIntegrity(await api.runtimeSchemaIntegrity());
    } catch (e) {
      setIntegrity({ checked: false, ok: true, reason: e.message, drift: [], summary: 'the check could not run' });
    } finally {
      setChecking(false);
    }
  };

  if (!schema.data) {
    return <div className="p-4"><Resource {...schema} rows={4} emptyTitle="No Prisma schema in this project" emptyHint="Nothing to check — this project does not use Prisma." /></div>;
  }

  const files = schema.data.files || [];
  const errors = (integrity?.drift || []).filter((d) => d.severity === 'error');
  const warns = (integrity?.drift || []).filter((d) => d.severity !== 'error');
  const current = files.find((f) => f.path === openFile);

  return (
    <div className="flex h-full min-h-0 flex-col gap-3">
      {/* verdict */}
      <div
        className={`card p-3 ${
          integrity?.checked && !integrity.ok ? 'border-rose-900/50 bg-rose-950/10' : integrity?.ok && integrity?.checked ? 'border-emerald-900/40' : ''
        }`}
      >
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
          <div className="min-w-0">
            <div className="text-xs font-semibold text-white">
              {!integrity
                ? 'Schema integrity'
                : !integrity.checked
                  ? 'Integrity unknown'
                  : integrity.ok
                    ? 'Every model matches the database'
                    : 'The database does not have what the models ask for'}
            </div>
            <div className="mt-0.5 text-[11px] text-slate-500">
              {!integrity
                ? `${schema.data.models} model(s) across ${files.length} schema file(s). The same check runs automatically after every commit.`
                : integrity.checked
                  ? integrity.summary
                  : `${integrity.reason} — no claim is made either way.`}
            </div>
          </div>
          <div className="flex-1" />
          {integrity?.database && <span className="font-mono text-[10px] text-slate-600">{integrity.container} · {integrity.database}</span>}
          <button onClick={check} disabled={checking} className="btn-ghost" title="Compare every model against the columns the database actually has. Read-only.">
            {checking ? <Spinner /> : '⌕'} check now
          </button>
        </div>

        {!!errors.length && (
          <ul className="mt-2 space-y-1 border-t border-ink-800 pt-2">
            {errors.map((d, i) => (
              <li key={i} className="text-[11px]">
                <span className="font-mono text-rose-300">{d.model}</span>
                <span className="text-slate-500"> names </span>
                <span className="font-mono text-rose-300">{d.fields.join(', ')}</span>
                <span className="text-slate-500">, absent from table </span>
                <span className="font-mono text-slate-400">{d.table}</span>
                <div className="pl-1 text-[10px] text-slate-600">
                  {d.file} — every query selecting {d.fields.length === 1 ? 'it' : 'them'} fails at runtime, however healthy the service looks.
                </div>
              </li>
            ))}
          </ul>
        )}
        {!!warns.length && (
          <div className="mt-2 border-t border-ink-800 pt-2 text-[10px] text-slate-500">
            {warns.length} model(s) have no table in this database — expected for views, search indexes and models bound elsewhere:{' '}
            <span className="font-mono">{warns.map((d) => d.model).join(', ')}</span>
          </div>
        )}
      </div>

      {/* schemas */}
      <div className="grid min-h-0 flex-1 grid-cols-[260px_minmax(0,1fr)] gap-3">
        <div className="card flex min-h-0 flex-col">
          <h3 className="border-b border-ink-800 px-3 py-2 text-xs font-semibold uppercase tracking-wide text-slate-400">
            Schemas <span className="ml-1 font-normal text-slate-600">{files.length}</span>
          </h3>
          <ul className="min-h-0 flex-1 overflow-auto p-1.5">
            {files.map((f) => {
              const bad = errors.filter((d) => d.file === f.path);
              return (
                <li key={f.path}>
                  <button
                    onClick={() => setOpenFile(f.path === openFile ? null : f.path)}
                    className={`w-full rounded-lg px-2 py-1.5 text-left transition-colors ${f.path === openFile ? 'bg-ink-800' : 'hover:bg-ink-800/60'}`}
                  >
                    <div className="flex items-center gap-1.5">
                      {bad.length > 0 && <span className="text-[10px] text-rose-400">●</span>}
                      <span className="truncate text-[11px] text-slate-200">{schemaLabel(f.path)}</span>
                    </div>
                    <div className="text-[10px] text-slate-600">{f.models.length} model(s)</div>
                  </button>
                </li>
              );
            })}
          </ul>
        </div>

        <div className="card flex min-h-0 flex-col">
          {!current ? (
            <div className="grid h-full place-items-center px-6 text-center text-[11px] text-slate-600">
              Pick a schema to read its models and the source as it is on disk.
            </div>
          ) : (
            <>
              <div className="flex items-center gap-2 border-b border-ink-800 px-3 py-2">
                <span className="truncate font-mono text-[11px] text-slate-300">{current.path}</span>
                <div className="flex-1" />
                <span className="text-[10px] text-slate-600">read-only</span>
              </div>
              <div className="min-h-0 flex-1 overflow-auto">
                <table className="w-full text-[11px]">
                  <tbody>
                    {current.models.map((m) => {
                      const bad = new Set(errors.filter((d) => d.file === current.path && d.model === m.model).flatMap((d) => d.fields));
                      return (
                        <tr key={m.model} className="border-b border-ink-800/60 align-top">
                          <td className="w-40 px-3 py-1.5">
                            <div className="font-mono text-slate-200">{m.model}</div>
                            {m.table !== m.model && <div className="text-[10px] text-slate-600">→ {m.table}</div>}
                          </td>
                          <td className="px-3 py-1.5">
                            <div className="flex flex-wrap gap-1">
                              {m.fields.map((f) => (
                                <span
                                  key={f.field}
                                  className={`rounded px-1.5 py-0.5 font-mono text-[10px] ${
                                    bad.has(f.column) ? 'bg-rose-500/20 text-rose-300' : 'bg-ink-800 text-slate-400'
                                  }`}
                                  title={`${f.type}${f.optional ? ' (optional)' : ''}${f.column !== f.field ? ` → column ${f.column}` : ''}`}
                                >
                                  {f.field}
                                </span>
                              ))}
                              {!m.fields.length && <span className="text-[10px] text-slate-600">no scalar fields</span>}
                            </div>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
                <pre className="whitespace-pre-wrap break-words border-t border-ink-800 bg-ink-950/60 p-3 font-mono text-[10px] leading-relaxed text-slate-500">
                  {current.source}
                </pre>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
