import { useState } from 'react';
import { api } from '../api.js';
import { useResource } from '../hooks.js';
import { Resource } from '../components/Resource.jsx';
import { SAFETY_NET_MS } from '../liveKeys.js';
import { Empty } from '../components/ui.jsx';

/**
 * The service mesh, told straight.
 *
 * The most important thing this view can do is refuse to flatter. A directory under
 * services/ with node_modules and no source is not a healthy service with no
 * findings — it is a hole in the architecture, and it is shown as one.
 */

const SEV = {
  critical: { c: 'text-rose-300', bg: 'bg-rose-500/15', label: 'critical' },
  high: { c: 'text-amber-300', bg: 'bg-amber-500/15', label: 'high' },
  medium: { c: 'text-sky-300', bg: 'bg-sky-500/15', label: 'medium' },
};

const STATE = {
  implemented: { c: 'text-emerald-300', bg: 'bg-emerald-500/15', label: 'implemented' },
  scaffold: { c: 'text-rose-300', bg: 'bg-rose-500/15', label: 'not implemented' },
  empty: { c: 'text-rose-300', bg: 'bg-rose-500/15', label: 'empty' },
};

const KIND_LABEL = {
  no_timeout: 'no timeout',
  unsafe_retry: 'unsafe retry',
  swallowed_error: 'swallowed error',
  error_as_success: 'error returned as success',
  not_implemented: 'not implemented',
};

export default function Services({ managers }) {
  const [sel, setSel] = useState(null);

  // 20s was the gentlest poll here, but still a poll for data that only moves when the Services
  // manager reports or an iteration touches a service.
  const res = useResource('services', api.services, { interval: SAFETY_NET_MS });
  const inv = res.data;

  const brief = (managers?.briefs || []).find((b) => b.name === 'Services');

  if (!inv) return <div className="p-4"><Resource {...res} rows={5} emptyTitle="No services detected" emptyHint="Nothing in this project looks like a runnable service yet." /></div>;

  const { services, totals, health } = inv;
  const selected = services.find((s) => s.name === sel) || null;
  const healthTone = health >= 70 ? 'text-emerald-300' : health >= 40 ? 'text-amber-300' : 'text-rose-300';

  return (
    <div className="flex h-full flex-col gap-3">
      {/* headline */}
      <div className="card p-4">
        <div className="flex flex-wrap items-start gap-6">
          <div>
            <div className="stat-label">Integration health</div>
            <div className={`stat mt-1 ${healthTone}`}>{health}<span className="text-sm text-slate-600">/100</span></div>
          </div>
          <Metric label="Services" value={totals.services} />
          <Metric label="Implemented" value={totals.implemented} tone={totals.implemented ? 'text-emerald-300' : 'text-rose-300'} />
          <Metric label="Not implemented" value={totals.scaffolds} tone={totals.scaffolds ? 'text-rose-300' : 'text-slate-400'} />
          <Metric label="Findings" value={totals.findings} />
          <Metric label="No timeout" value={totals.noTimeout} tone={totals.noTimeout ? 'text-amber-300' : 'text-slate-400'} />
          <Metric label="Unsafe retry" value={totals.unsafeRetry} tone={totals.unsafeRetry ? 'text-rose-300' : 'text-slate-400'} />
        </div>

        {brief?.headline && (
          <div
            className={`mt-3 rounded-lg border px-3 py-2 text-[12px] ${
              brief.status === 'alert'
                ? 'border-rose-900/50 bg-rose-950/30 text-rose-200'
                : 'border-ink-700 bg-ink-800/40 text-slate-300'
            }`}
          >
            <span className="mr-1.5 font-semibold text-slate-400">Services manager:</span>
            {brief.headline}
          </div>
        )}
        {(brief?.recommendations || []).map((r, i) => (
          <div key={i} className="mt-1.5 flex gap-2 px-1 text-[11px] text-slate-400">
            <span className="text-brand">▸</span> {r}
          </div>
        ))}
      </div>

      <div className="grid min-h-0 flex-1 grid-cols-[minmax(0,1fr)_minmax(0,1.3fr)] gap-3">
        {/* the mesh */}
        <div className="card flex min-h-0 flex-col">
          <div className="card-head">
            <h3 className="card-title">The mesh</h3>
            <div className="flex-1" />
            <span className="text-[10px] text-slate-600">{services.length} directories</span>
          </div>
          <div className="min-h-0 flex-1 space-y-1.5 overflow-auto p-2">
            {services.map((s) => {
              const st = STATE[s.state] || STATE.empty;
              const active = sel === s.name;
              return (
                <button
                  key={s.name}
                  onClick={() => setSel(active ? null : s.name)}
                  className={`w-full rounded-lg border px-3 py-2 text-left transition-colors ${
                    active ? 'border-brand/50 bg-brand/5' : 'border-ink-700/60 bg-ink-800/30 hover:bg-ink-800/60'
                  }`}
                >
                  <div className="flex items-center gap-2">
                    <span className={`h-2 w-2 shrink-0 rounded-full ${s.health >= 70 ? 'bg-emerald-400' : s.health > 0 ? 'bg-amber-400' : 'bg-rose-500'}`} />
                    <span className="text-[13px] font-medium text-slate-200">{s.name}</span>
                    <span className={`pill ${st.bg} ${st.c}`}>{st.label}</span>
                    <div className="flex-1" />
                    <span className="font-mono text-[11px] text-slate-500">{s.health}</span>
                  </div>
                  <div className="mt-1 pl-4 text-[10px] text-slate-500">
                    {s.language}
                    {s.files > 0 && ` · ${s.files} file${s.files === 1 ? '' : 's'}`}
                    {s.entry && ` · ${s.entry}`}
                    {s.hasDeps && s.files === 0 && ' · node_modules installed, no source'}
                    {s.findings.length > 0 && ` · ${s.findings.length} finding${s.findings.length === 1 ? '' : 's'}`}
                    {s.dependsOn.length > 0 && ` · → ${s.dependsOn.join(', ')}`}
                  </div>
                </button>
              );
            })}
          </div>
        </div>

        {/* findings */}
        <div className="card flex min-h-0 flex-col">
          <div className="card-head">
            <h3 className="card-title">{selected ? `${selected.name} — findings` : 'All findings'}</h3>
            <div className="flex-1" />
            {selected && (
              <button onClick={() => setSel(null)} className="text-[10px] text-slate-500 hover:text-slate-300">
                show all
              </button>
            )}
          </div>
          <div className="min-h-0 flex-1 overflow-auto p-2">
            <FindingList services={selected ? [selected] : services} />
          </div>
        </div>
      </div>
    </div>
  );
}

function FindingList({ services }) {
  const rows = services.flatMap((s) => s.findings.map((f) => ({ ...f, service: s.name })));
  const rank = { critical: 0, high: 1, medium: 2 };
  rows.sort((a, b) => (rank[a.severity] ?? 3) - (rank[b.severity] ?? 3));

  if (!rows.length) {
    return <Empty icon="✓" title="No integration defects" hint="No missing timeouts, unsafe retries or swallowed errors were found." />;
  }

  return (
    <ul className="space-y-1.5">
      {rows.map((f, i) => {
        const sev = SEV[f.severity] || SEV.medium;
        return (
          <li key={i} className="rounded-lg border border-ink-700/60 bg-ink-800/30 px-3 py-2">
            <div className="flex items-center gap-2">
              <span className={`pill ${sev.bg} ${sev.c}`}>{sev.label}</span>
              <span className="text-[11px] font-medium text-slate-300">{KIND_LABEL[f.kind] || f.kind}</span>
              <div className="flex-1" />
              <span className="font-mono text-[10px] text-slate-600">{f.service}</span>
            </div>
            <p className="mt-1 text-[12px] leading-relaxed text-slate-400">{f.detail}</p>
            <div className="mt-1 font-mono text-[10px] text-slate-600">
              {f.file}
              {f.line ? `:${f.line}` : ''}
            </div>
          </li>
        );
      })}
    </ul>
  );
}

const Metric = ({ label, value, tone = 'text-slate-200' }) => (
  <div>
    <div className="stat-label">{label}</div>
    <div className={`stat mt-1 ${tone}`}>{value}</div>
  </div>
);
