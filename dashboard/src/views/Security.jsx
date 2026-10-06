import { useState } from 'react';
import { api } from '../api.js';
import { useResource, invalidateResource } from '../hooks.js';
import { CardHead, Empty, PageHeader, Spinner } from '../components/ui.jsx';

/**
 * Security & Safety — the deterministic gate's window. Every change ISL makes is scanned,
 * before it can commit, for introduced secrets, weakened security controls, and
 * irreversible/destructive operations; the clear cases are VETOED. This page surfaces what
 * the gate has caught and blocked, so the first line of defence isn't invisible.
 *
 * Data comes from the Risk manager's live brief (it tracks the gate's findings).
 */
const SEV = {
  critical: 'bg-rose-500/15 text-rose-300',
  high: 'bg-amber-500/15 text-amber-300',
  medium: 'bg-sky-500/15 text-sky-300',
  low: 'bg-slate-500/15 text-slate-300',
};

export default function Security() {
  // Shared cache: paints instantly on revisit, refreshes every 6s in the background.
  const { data, loading } = useResource(
    'security:risk',
    () => api.managers().then((j) => {
      const list = Array.isArray(j) ? j : j.managers || j.briefs || [];
      return list.find((m) => m.name === 'Risk') || { gateFindings: [], gateVetoes: 0, stats: {} };
    }),
    { interval: 6000 },
  );
  const risk = data;
  if (loading && !risk) return <div className="grid h-40 place-items-center text-slate-500"><Spinner /></div>;
  if (!risk) return <div className="grid h-40 place-items-center text-slate-500"><Spinner /></div>;

  const findings = risk.gateFindings || [];
  const vetoes = risk.gateVetoes || 0;

  return (
    <div className="mx-auto max-w-5xl space-y-4">
      <PageHeader title="🔒 Security & Safety" subtitle="Every autonomous change is scanned before it can commit. Secrets, weakened security controls and destructive operations are vetoed — no matter the quality score." />

      <div className="grid gap-3 sm:grid-cols-3">
        <Stat label="Unsafe changes blocked" value={vetoes} tone={vetoes ? 'ok' : undefined} />
        <Stat label="Recent gate findings" value={findings.length} />
        <Stat label="Critical open" value={risk.stats?.critical ?? 0} tone={(risk.stats?.critical ?? 0) ? 'warn' : undefined} />
      </div>

      <div className="card p-3">
        <div className="card-title mb-2">Active vetoes</div>
        <ul className="grid gap-1 text-[12px] text-slate-400 sm:grid-cols-2">
          <li>🔑 Introduced secrets (keys, tokens, hardcoded credentials)</li>
          <li>🛡️ Removed auth / authorization / ownership checks</li>
          <li>🔓 Disabled TLS certificate verification</li>
          <li>💥 Destructive data ops (DROP/TRUNCATE/DELETE-all, rm -rf, migrate reset)</li>
        </ul>
        <div className="mt-2 text-[11px] text-slate-500">Plus penalties for eval, weak crypto/random, shell injection, and disabling logging/telemetry.</div>
      </div>

      <div className="card">
        <div className="card-head">
          <span className="card-title">Gate findings ({findings.length})</span>
        </div>
        <div className="max-h-[55vh] divide-y divide-ink-800 overflow-y-auto">
          {findings.map((f, i) => (
            <div key={i} className="flex items-start gap-3 px-3 py-2.5">
              <span className={`pill ${SEV[f.severity] || SEV.low}`}>{f.severity}</span>
              <div className="min-w-0 flex-1">
                <div className="text-[12px] text-slate-200">{f.message}</div>
                <div className="mt-0.5 text-[10px] text-slate-600">{f.kind}{f.file ? ` · ${f.file}` : ''}</div>
              </div>
            </div>
          ))}
          {!findings.length && (
            <Empty icon="✓" title="All clear" hint="No unsafe change has been caught. The gate scans every diff for secrets, weakened controls and destructive operations before anything can commit." />
          )}
        </div>
      </div>

      <Dependencies />
    </div>
  );
}

/**
 * Dependency & CVE surface — known vulnerabilities in the target app's *dependencies*
 * (npm audit), where the highest-severity issues usually live. The scan is slow and needs
 * the network, so it's cached server-side and refreshed on demand.
 */
function Dependencies() {
  const [busy, setBusy] = useState(false);
  const { data } = useResource(
    'security:deps',
    () => api.dependencies(),
    { interval: 8000 },
  );
  const scan = data?.scan;
  const running = data?.running || busy;
  const totals = scan?.totals || {};
  const projects = (scan?.projects || []).filter((p) => p.status === 'ok');
  const unavailable = (scan?.projects || []).filter((p) => p.status !== 'ok').length;

  const trigger = async () => {
    setBusy(true);
    try {
      await api.scanDependencies();
      invalidateResource('security:deps');
    } finally {
      setTimeout(() => setBusy(false), 4000);
    }
  };

  return (
    <div className="card">
      <div className="card-head">
        <span className="card-title">📦 Dependency vulnerabilities</span>
        <button className="btn-ghost text-[11px]" onClick={trigger} disabled={running}>
          {running ? 'Scanning…' : scan ? 'Rescan' : 'Scan now'}
        </button>
      </div>

      {!scan && (
        <div className="px-3 py-6">
          <Empty icon="📦" title="No scan yet" hint="Run npm audit across the target app's packages to surface known CVEs in its dependencies — usually where the most severe issues actually live." />
        </div>
      )}

      {scan && (
        <>
          <div className="grid gap-2 px-3 py-3 sm:grid-cols-5">
            <DepStat label="Critical" value={totals.critical || 0} cls="text-rose-300" />
            <DepStat label="High" value={totals.high || 0} cls="text-amber-300" />
            <DepStat label="Moderate" value={totals.moderate || 0} cls="text-sky-300" />
            <DepStat label="Low" value={totals.low || 0} cls="text-slate-300" />
            <DepStat label="Total" value={totals.total || 0} cls="text-white" />
          </div>

          <div className="divide-y divide-ink-800 border-t border-ink-800">
            {projects.map((p) => (
              <div key={p.dir} className="px-3 py-2.5">
                <div className="flex items-center justify-between">
                  <span className="font-mono text-[12px] text-slate-200">{p.dir}</span>
                  <span className="flex gap-1">
                    {p.vulnerabilities?.critical ? <span className={`pill ${SEV.critical}`}>{p.vulnerabilities.critical} crit</span> : null}
                    {p.vulnerabilities?.high ? <span className={`pill ${SEV.high}`}>{p.vulnerabilities.high} high</span> : null}
                    {p.vulnerabilities?.moderate ? <span className={`pill ${SEV.medium}`}>{p.vulnerabilities.moderate} mod</span> : null}
                    {!p.vulnerabilities?.total ? <span className="pill bg-emerald-500/15 text-emerald-300">clean</span> : null}</span>
      </div>
                {(p.top || []).slice(0, 3).map((t, i) => (
                  <div key={i} className="mt-1 flex items-start gap-2 text-[11px] text-slate-500">
                    <span className={`pill ${SEV[t.severity] || SEV.low} shrink-0`}>{t.severity}</span>
                    <span className="min-w-0"><span className="text-slate-400">{t.name}</span>{t.title ? ` — ${t.title}` : ''}</span>
                  </div>
                ))}
              </div>
            ))}
          </div>

          <div className="px-3 py-2 text-[10px] text-slate-600">
            {projects.length} package{projects.length === 1 ? '' : 's'} scanned{unavailable ? ` · ${unavailable} unavailable` : ''} · {scan.scannedAt ? new Date(scan.scannedAt).toLocaleString() : ''}
          </div>

          <Remediation />
        </>
      )}
    </div>
  );
}

/**
 * CVE auto-remediation — computes the semver-SAFE upgrades (lockfile-only, in an isolated worktree,
 * never --force) and reports which vulnerabilities they would close. Nothing is installed and the
 * real checkout is never touched; the output is an evidence-backed patch proposal.
 */
function Remediation() {
  const [busy, setBusy] = useState(false);
  const { data } = useResource('security:remediate', () => api.remediation(), { interval: 10000 });
  const r = data?.result;
  const running = data?.running || busy;

  const go = async () => {
    setBusy(true);
    try {
      await api.startRemediation();
      invalidateResource('security:remediate');
    } finally {
      setTimeout(() => setBusy(false), 5000);
    }
  };

  return (
    <div className="border-t border-ink-800 px-3 py-3">
      <div className="flex items-center gap-2">
        <span className="text-[12px] font-medium text-slate-200">Safe upgrades</span>
        <span className="text-[10px] text-slate-600">semver-safe only · lockfile-only · never touches your checkout</span>
<button className="btn-ghost text-[11px]" onClick={go} disabled={running}>
          {running ? 'Computing…' : r ? 'Recompute' : 'Compute safe fixes'}
        </button>
      </div>

      {r && !r.running && !r.error && (
        <div className="mt-2">
          <div className="text-[12px] text-slate-300">
            <span className="text-emerald-400 font-medium">{r.totalClosed}</span> vulnerabilit{r.totalClosed === 1 ? 'y' : 'ies'} closable safely
            {r.criticalClosed ? <span className="text-rose-300"> ({r.criticalClosed} critical)</span> : null}
          </div>
          <div className="mt-1 text-[10px] text-amber-400/80">Not test-verified — nothing was installed. Review the lockfile diff before applying.</div>
          <div className="mt-2 divide-y divide-ink-800">
            {(r.projects || []).filter((p) => p.closed?.total || p.error).map((p, i) => (
              <div key={i} className="py-1.5 text-[11px]">
                <span className="font-mono text-slate-300">{p.projectDir}</span>
                {p.error ? <span className="ml-2 text-rose-300">{p.error}</span> : (
                  <span className="ml-2 text-slate-500">
                    {p.before?.total} → {p.after?.total} vulns · closes {p.closed.total}
                    {p.closed.critical ? `, ${p.closed.critical} critical` : ''}{p.closed.high ? `, ${p.closed.high} high` : ''}
                    {p.changed?.length ? ` · ${p.changed.join(', ')}` : ''}
                  </span>
                )}
              </div>
            ))}
          </div>
        </div>
      )}
      {r?.error && <div className="mt-2 text-[11px] text-rose-300">{r.error}</div>}
    </div>
  );
}

const DepStat = ({ label, value, cls }) => (
  <div className="rounded-lg border border-ink-800 px-3 py-2">
    <div className="stat-label">{label}</div>
    <div className={`mt-0.5 text-lg font-semibold ${value ? cls : 'text-slate-600'}`}>{value}</div>
  </div>
);

const Stat = ({ label, value, tone }) => (
  <div className="card p-3">
    <div className="stat-label">{label}</div>
    <div className={`stat mt-1 ${tone === 'warn' ? 'text-amber-400' : tone === 'ok' ? 'text-emerald-400' : 'text-white'}`}>{value}</div>
  </div>
);
