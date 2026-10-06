import { useEffect, useState } from 'react';
import { api } from '../api.js';
import { SAFETY_NET_MS } from '../liveKeys.js';
import { Resource } from '../components/Resource.jsx';
import { useResource } from '../hooks.js';
import { CardHead, Empty, SeverityPill, Spinner, ago } from '../components/ui.jsx';

/**
 * Compliance: how well the project's code respects best practices, per language.
 * The check runs against the best-practices knowledge base and works for every
 * language ISL recognises — including ABAP, Apex and COBOL. A second tab browses
 * the knowledge base itself.
 */
export default function Compliance({ codeStats, toast }) {
  const [tab, setTab] = useState('report');
  return (
    <div className="mx-auto max-w-5xl space-y-4">
      <div className="flex gap-1">
        {[['report', 'Compliance'], ['rules', 'Best-practice rules'], ['frontend', 'Frontend a11y/i18n']].map(([id, label]) => (
          <button key={id} onClick={() => setTab(id)} className={`rounded-lg px-3 py-1.5 text-[12px] ${tab === id ? 'bg-ink-800 text-white' : 'text-slate-400 hover:bg-ink-900'}`}>
            {label}
          </button>
        ))}
      </div>
      {tab === 'report' && <Report codeStats={codeStats} toast={toast} />}
      {tab === 'rules' && <Rules codeStats={codeStats} toast={toast} />}
      {tab === 'frontend' && <FrontendAudit toast={toast} />}
    </div>
  );
}

function Report({ codeStats, toast }) {
  const [busy, setBusy] = useState(false);
  const res = useResource('compliance', api.compliance, { interval: SAFETY_NET_MS });
  const { data, refetch: load } = res;

  const run = async () => {
    setBusy(true);
    toast?.('Auditing code against best practices per language… (~1–2 min)', { type: 'info' });
    try {
      await api.complianceCheck();
      setTimeout(load, 6000);
    } catch (e) {
      toast?.(e.message, { type: 'error' });
    } finally {
      setBusy(false);
    }
  };

  if (!data) return <div className="p-4"><Resource {...res} rows={5} emptyTitle="No compliance report yet" emptyHint="Run an audit to grade this codebase against its language best practices." /></div>;

  const score = data.lastRun?.score;
  const codeLangs = (codeStats?.byLanguage || []).filter((l) => l.pct != null);

  return (
    <div className="space-y-4">
      <div className="grid gap-3 sm:grid-cols-4">
        <Stat label="Compliance score" value={score != null ? score : '—'} suffix={score != null ? '/100' : ''} tone={score == null ? 'muted' : score >= 80 ? 'ok' : score >= 60 ? 'warn' : 'bad'} />
        <Stat label="Open violations" value={data.openViolations} tone={data.openViolations ? 'warn' : 'ok'} />
        <Stat label="Languages checked" value={data.lastRun?.languages?.length ?? 0} />
        <Stat label="Last run" value={data.lastRun ? ago(data.lastRun.ts) : 'never'} tone="muted" />
      </div>

      <div className="card">
        <CardHead title="Compliance by language">
<button disabled={busy} onClick={run} className="btn-primary">{busy ? <Spinner /> : '▶'} Run compliance check</button>
        </CardHead>
        <div className="flex flex-wrap gap-2 p-3">
          {codeLangs.length ? codeLangs.map((l) => {
            const v = data.byLanguage.find((b) => b.language === l.key);
            return (
              <span key={l.key} className={`pill ${!v ? 'bg-ink-800 text-slate-400' : v.severe ? 'bg-rose-500/15 text-rose-300' : 'bg-amber-500/15 text-amber-300'}`}>
                {l.lang}{v ? ` · ${v.violations}` : ' · ok'}
              </span>
            );
          }) : <span className="text-[11px] text-slate-600">No code languages detected — build context first.</span>}
        </div>
      </div>

      <div className="card">
        <div className="card-head">
          <span className="card-title">Violations ({data.findings.length})</span>
        </div>
        <div className="divide-y divide-ink-800">
          {data.findings.map((f) => (
            <div key={f.id} className="flex items-start gap-3 px-3 py-2.5">
              <SeverityPill severity={f.severity} />
              <div className="min-w-0 flex-1">
                <div className="text-[12px] font-medium text-slate-200">{f.title}</div>
                <div className="text-[11px] text-slate-400">{f.message}</div>
                <div className="mt-0.5 font-mono text-[10px] text-slate-600">{f.relPath}{f.line ? `:${f.line}` : ''} · {f.language} · {f.category}</div>
              </div>
              <button onClick={() => api.resolveCompliance(f.id).then(load)} className="btn-ghost">Resolve</button>
            </div>
          ))}
          {!data.findings.length && <Empty icon="📋" title="No violations" hint="Run a compliance check to audit the code against best practices for every language in the project." />}
        </div>
      </div>
    </div>
  );
}

function Rules({ codeStats, toast }) {
  const [lang, setLang] = useState('');
  // Keyed by language, so switching filters paints from cache instead of blanking the list.
  const res = useResource(`best-practices:${lang || 'all'}`, () => api.bestPractices(lang ? { language: lang } : {}), { interval: SAFETY_NET_MS });
  const data = res.data;

  if (!data) return <div className="p-4"><Resource {...res} rows={5} emptyTitle="No best practices for this language" /></div>;

  const CAT = {
    security: 'bg-rose-500/15 text-rose-300',
    performance: 'bg-amber-500/15 text-amber-300',
    reliability: 'bg-sky-500/15 text-sky-300',
    maintainability: 'bg-teal-500/15 text-teal-300',
    style: 'bg-slate-500/15 text-slate-400',
    testing: 'bg-violet-500/15 text-violet-300',
  };

  return (
    <div className="space-y-3">
      <div className="card">
        <div className="card-head">
        <span className="card-title">Knowledge base · {data.byLanguage.reduce((a, b) => a + b.count, 0)} rules across {data.byLanguage.length} languages</span>
<select value={lang} onChange={(e) => setLang(e.target.value)} className="rounded border border-ink-700 bg-ink-950 px-2 py-1 text-[11px]">
            <option value="">all languages</option>
            {data.byLanguage.map((b) => <option key={b.language} value={b.language}>{b.language} ({b.count})</option>)}
          </select>
        </div>
        <div className="max-h-[60vh] divide-y divide-ink-800 overflow-y-auto">
          {data.list.map((p) => (
            <div key={p.id} className="px-3 py-2.5">
              <div className="flex items-center gap-2">
                <span className="pill bg-ink-800 text-slate-400">{p.language}</span>
                <span className={`pill ${CAT[p.category] || CAT.style}`}>{p.category}</span>
                <span className="text-[12px] font-medium text-slate-200">{p.title}</span>
                <span className={`ml-auto pill ${p.severity === 'critical' ? 'bg-rose-600/25 text-rose-200' : p.severity === 'high' ? 'bg-orange-500/20 text-orange-300' : 'bg-slate-500/15 text-slate-400'}`}>{p.severity}</span>
      </div>
              <div className="mt-1 text-[11px] text-slate-400">{p.rule}</div>
              {p.rationale && <div className="mt-0.5 text-[10px] text-slate-600">{p.rationale}{p.source ? ` · ${p.source}` : ''}</div>}
            </div>
          ))}
          {!data.list.length && <Empty title="No rules" />}
        </div>
      </div>
    </div>
  );
}

const Stat = ({ label, value, suffix, tone }) => (
  <div className="card p-3">
    <div className="stat-label">{label}</div>
    <div className={`stat mt-1 ${tone === 'bad' ? 'text-rose-400' : tone === 'warn' ? 'text-amber-400' : tone === 'ok' ? 'text-emerald-400' : 'text-white'}`}>
      {value}<span className="text-sm text-slate-600">{suffix}</span>
    </div>
  </div>
);

const KIND_META = {
  'img-no-alt': { label: 'Images missing alt', tone: 'text-amber-300' },
  'click-non-interactive': { label: 'onClick on non-interactive (no role)', tone: 'text-rose-300' },
  'anchor-no-href': { label: 'Links without href', tone: 'text-amber-300' },
  'hardcoded-string': { label: 'Un-translated UI strings', tone: 'text-sky-300' },
};

/**
 * Frontend a11y/i18n audit — ISL applies its own accessibility and internationalisation gates to
 * the TARGET app. Deterministic static scan; the worst files can be seeded as real backlog work.
 */
function FrontendAudit({ toast }) {
  const [data, setData] = useState(null);
  const [busy, setBusy] = useState(false);
  const [seeding, setSeeding] = useState(false);
  const load = () => api.frontendAudit().then(setData).catch((e) => toast?.(e.message, { type: 'error' }));
  useEffect(() => { setBusy(true); load().finally(() => setBusy(false)); }, []);

  const seed = async () => {
    setSeeding(true);
    try {
      const r = await api.seedFrontendAudit(5);
      toast?.(`Seeded ${r.added} accessibility/i18n task(s) into the backlog`, { type: 'success' });
    } catch (e) {
      toast?.(e.message, { type: 'error' });
    } finally {
      setSeeding(false);
    }
  };

  if (busy && !data) return <div className="grid h-40 place-items-center text-slate-500"><Spinner /></div>;
  if (!data) return <Empty icon="○" title="No audit yet" hint="Scan the target frontend for accessibility and i18n gaps." />;

  const t = data.totals || {};
  return (
    <div className="space-y-4">
      <div className="grid gap-3 sm:grid-cols-4">
        {['click-non-interactive', 'img-no-alt', 'anchor-no-href', 'hardcoded-string'].map((k) => (
          <div key={k} className="card p-3">
            <div className="stat-label">{KIND_META[k].label}</div>
            <div className={`stat mt-1 ${t[k] ? KIND_META[k].tone : 'text-slate-600'}`}>{t[k] || 0}</div>
          </div>
        ))}
      </div>

      <div className="card">
        <div className="card-head">
        <span className="card-title">Worst files ({data.scanned} scanned · {t.total || 0} findings)</span>
<button onClick={seed} disabled={seeding} className="btn-primary" title="Add the top 5 files as accessibility/i18n backlog tasks">
            {seeding ? <Spinner /> : '＋'} Seed top 5 to backlog
          </button>
        </div>
        <div className="max-h-[50vh] divide-y divide-ink-800 overflow-y-auto">
          {(data.files || []).map((f, i) => (
            <div key={i} className="flex items-center gap-3 px-3 py-2 text-[12px]">
              <span className="pill bg-ink-800 text-slate-400">{f.count}</span>
              <span className="min-w-0 flex-1 truncate font-mono text-slate-300">{f.file}</span>
      </div>
          ))}
          {!data.files.length && <Empty icon="✓" title="No a11y/i18n issues found" hint="The target frontend passes ISL's static accessibility and i18n checks." />}
        </div>
      </div>
    </div>
  );
}
