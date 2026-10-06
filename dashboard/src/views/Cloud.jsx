import { useState } from 'react';
import { api } from '../api.js';
import { SAFETY_NET_MS } from '../liveKeys.js';
import { Resource } from '../components/Resource.jsx';
import { useResource } from '../hooks.js';
import { CardHead, Empty, SeverityPill, Spinner, ago } from '../components/ui.jsx';

/** LLMs sometimes return list items as objects; coerce anything to readable text. */
const str = (x) => {
  if (x == null) return '';
  if (typeof x === 'string') return x;
  if (typeof x !== 'object') return String(x);
  if (x.risk && x.mitigation) return `${x.risk} — ${x.mitigation}`;
  return x.step || x.title || x.name || x.description || x.change || x.text || Object.values(x).filter((v) => typeof v === 'string').join(' — ') || JSON.stringify(x);
};

/**
 * Cloud / deployment surface. Distinct tabs for Terraform (IaC + drift against
 * landed code), GCP and AWS (detected resources + the release strategy the
 * Deployment manager defines for each).
 */
export default function Cloud({ toast }) {
  const [tab, setTab] = useState('terraform');
  const [busy, setBusy] = useState(null);

  const res = useResource('cloud', api.cloudReport, { interval: SAFETY_NET_MS });
  const { data, refetch: load } = res;

  if (!data) return <div className="p-4"><Resource {...res} rows={4} emptyTitle="No cloud report yet" /></div>;

  const det = data.detection;
  const run = (key, fn, msg) => async () => {
    setBusy(key);
    toast?.(msg, { type: 'info' });
    try {
      await fn();
      setTimeout(load, 5000);
    } catch (e) {
      toast?.(e.message, { type: 'error' });
    } finally {
      setBusy(null);
    }
  };

  const TABS = [
    ['terraform', `Terraform${det.terraform.fileCount ? ` (${det.terraform.fileCount})` : ''}`],
    ['gcp', `GCP${det.gcp.active ? ' ●' : ''}`],
    ['aws', `AWS${det.aws.active ? ' ●' : ''}`],
  ];

  return (
    <div className="mx-auto max-w-5xl space-y-4">
      <div className="grid gap-3 sm:grid-cols-4">
        <Stat label="Cloud target" value={det.clouds.length ? det.clouds.map((c) => c.toUpperCase()).join(' + ') : '—'} />
        <Stat label="Terraform files" value={det.terraform.fileCount} />
        <Stat label="IaC resources" value={det.terraform.resourceCount} />
        <Stat label="TF findings" value={data.terraformFindings.length} tone={data.terraformFindings.length ? 'warn' : 'ok'} />
      </div>

      <div className="flex gap-1">
        {TABS.map(([id, label]) => (
          <button key={id} onClick={() => setTab(id)} className={`rounded-lg px-3 py-1.5 text-[12px] ${tab === id ? 'bg-ink-800 text-white' : 'text-slate-400 hover:bg-ink-900'}`}>
            {label}
          </button>
        ))}
      </div>

      {tab === 'terraform' && <Terraform det={det} findings={data.terraformFindings} busy={busy} run={run} load={load} />}
      {tab === 'gcp' && <CloudTab cloud="gcp" det={det.gcp} plan={data.plans.gcp} busy={busy} run={run} />}
      {tab === 'aws' && <CloudTab cloud="aws" det={det.aws} plan={data.plans.aws} busy={busy} run={run} />}
    </div>
  );
}

function Terraform({ det, findings, busy, run, load }) {
  return (
    <div className="space-y-4">
      <div className="card p-4">
        <div className="mb-2 flex items-center gap-2">
          <span className="card-title">Infrastructure as Code</span>
          <div className="flex-1" />
          <button disabled={busy} onClick={run('tf', api.terraformCheck, 'Checking whether landed code needs Terraform changes…')} className="btn-primary">
            {busy === 'tf' ? <Spinner /> : '▶'} Check drift vs code
          </button>
        </div>
        {det.terraform.present ? (
          <>
            <div className="flex flex-wrap gap-1.5">
              {det.terraform.providers.map((p) => <span key={p} className="pill bg-violet-500/15 text-violet-300">{p}</span>)}
              <span className="pill bg-ink-800 text-slate-400">{det.terraform.resourceCount} resources</span>
            </div>
            {det.terraform.resourceTypes.length > 0 && (
              <div className="mt-2 text-[11px] text-slate-500">{det.terraform.resourceTypes.slice(0, 16).join(', ')}{det.terraform.resourceTypes.length > 16 ? '…' : ''}</div>
            )}
            <div className="mt-3 max-h-52 space-y-0.5 overflow-y-auto rounded-lg border border-ink-800 bg-ink-950/40 p-2">
              {det.terraform.files.map((f) => (
                <div key={f} className="font-mono text-[11px] text-slate-400">📄 {f}</div>
              ))}
            </div>
          </>
        ) : (
          <Empty icon="🏗" title="No Terraform in this project" hint="If the project uses another IaC tool, the deploy strategy still covers it." />
        )}
      </div>

      <div className="card">
        <div className="card-head">
          <span className="card-title">Terraform drift findings ({findings.length})</span>
        </div>
        <div className="divide-y divide-ink-800">
          {findings.map((f) => (
            <div key={f.id} className="flex items-start gap-3 px-3 py-2.5">
              <SeverityPill severity={f.severity} />
              <div className="min-w-0 flex-1">
                <div className="text-[12px] text-slate-300">{f.message}</div>
                {f.suggestion && <div className="mt-0.5 text-[11px] text-emerald-300/80">→ {f.suggestion}</div>}
                <div className="mt-0.5 font-mono text-[10px] text-slate-600">{f.relPath || '(general)'} · {f.kind} · {ago(f.ts)}</div>
              </div>
              <button onClick={() => api.resolveTerraform(f.id).then(load)} className="btn-ghost">Resolve</button>
            </div>
          ))}
          {!findings.length && <Empty icon="✓" title="No infrastructure drift" hint="Landed code changes are consistent with the Terraform. Every commit is checked automatically." />}
        </div>
      </div>
    </div>
  );
}

function CloudTab({ cloud, det, plan, busy, run }) {
  const label = cloud.toUpperCase();
  return (
    <div className="space-y-4">
      <div className="card p-4">
        <div className="mb-2 flex items-center gap-2">
          <span className="card-title">{label} deployment surface</span>
          {det.active ? <span className="pill bg-emerald-500/15 text-emerald-300">detected</span> : <span className="pill bg-ink-800 text-slate-400">not detected</span>}
          <div className="flex-1" />
          <button disabled={busy} onClick={run(`s-${cloud}`, () => api.defineStrategy(cloud), `Defining the ${label} release strategy…`)} className="btn-primary">
            {busy === `s-${cloud}` ? <Spinner /> : '✦'} {plan ? 'Redefine' : 'Define'} release strategy
          </button>
        </div>
        {det.signals.length ? (
          <ul className="list-disc space-y-0.5 pl-5 text-[12px] text-slate-400">
            {det.signals.map((s, i) => <li key={i}>{str(s)}</li>)}
          </ul>
        ) : (
          <p className="text-[12px] text-slate-500">No {label}-specific signals detected. You can still define a strategy for deploying to {label}.</p>
        )}
      </div>

      {plan ? (
        <div className="card p-4">
          <div className="mb-2 flex items-center gap-2">
            <span className="card-title">Release strategy · {plan.strategy}</span>
            <span className="pill bg-ink-800 text-slate-400">{plan.environment}</span>
<span className="text-[10px] text-slate-600">{ago(plan.ts)}</span>
          </div>
          {plan.summary && <p className="text-[13px] leading-relaxed text-slate-300">{str(plan.summary)}</p>}

          {plan.prerequisites?.length > 0 && (
            <Section title="Prerequisites">
              <ul className="list-disc space-y-0.5 pl-5 text-[12px] text-slate-400">{plan.prerequisites.map((s, i) => <li key={i}>{str(s)}</li>)}</ul>
            </Section>
          )}
          {plan.steps?.length > 0 && (
            <Section title="Deploy steps">
              <ol className="list-decimal space-y-1 pl-5 text-[12px] text-slate-300">{plan.steps.map((s, i) => <li key={i}>{str(s)}</li>)}</ol>
            </Section>
          )}
          {plan.terraform?.length > 0 && (
            <Section title="Infrastructure changes this release needs">
              <ul className="list-disc space-y-0.5 pl-5 text-[12px] text-violet-300/90">{plan.terraform.map((s, i) => <li key={i}>{str(s)}</li>)}</ul>
            </Section>
          )}
          {plan.rollback && (
            <Section title="Rollback">
              <p className="text-[12px] text-slate-300">{str(plan.rollback)}</p>
            </Section>
          )}
          {plan.risks?.length > 0 && (
            <Section title="Risks">
              <ul className="list-disc space-y-0.5 pl-5 text-[12px] text-amber-300/80">{plan.risks.map((s, i) => <li key={i}>{str(s)}</li>)}</ul>
            </Section>
          )}
        </div>
      ) : (
        <Empty icon="🚀" title={`No ${label} release strategy yet`} hint={`Press “Define release strategy” — the Deployment manager will produce a concrete, ${label}-specific plan grounded in this project's stack and IaC.`} />
      )}
    </div>
  );
}

const Section = ({ title, children }) => (
  <div className="mt-3">
    <div className="stat-label">{title}</div>
    <div className="mt-1">{children}</div>
  </div>
);

const Stat = ({ label, value, tone }) => (
  <div className="card p-3">
    <div className="stat-label">{label}</div>
    <div className={`stat mt-1 ${tone === 'warn' ? 'text-amber-400' : tone === 'ok' ? 'text-emerald-400' : 'text-white'}`}>{value}</div>
  </div>
);
