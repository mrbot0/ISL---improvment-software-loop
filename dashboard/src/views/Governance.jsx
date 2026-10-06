import { useEffect, useState } from 'react';
import { api } from '../api.js';
import { CardHead, Empty, PageHeader, Spinner } from '../components/ui.jsx';
import DataTable from '../components/DataTable.jsx';
import CostBudget from '../components/CostBudget.jsx';

/**
 * ⚖ Governance — the controls an organisation needs before it lets an autonomous agent near its
 * code: the quality bar a change must clear, the paths the fleet may never touch, a repo-wide
 * secret scan, the dependency licence position, and outbound webhooks so ISL fits an existing
 * ops stack instead of demanding a watched dashboard.
 */
const SEV = { critical: 'bg-rose-500/15 text-rose-300', high: 'bg-amber-500/15 text-amber-300', medium: 'bg-sky-500/15 text-sky-300', low: 'bg-slate-600/20 text-slate-400' };

export default function Governance({ toast }) {
  const [tab, setTab] = useState('gates');
  const TABS = [['cost', 'Cost & budget'], ['gates', 'Quality gates'], ['protected', 'Protected paths'], ['egress', 'Data egress'], ['evidence', 'Audit & evidence'], ['secrets', 'Secret scan'], ['licences', 'Licences'], ['webhooks', 'Webhooks']];
  return (
    <div className="mx-auto max-w-5xl space-y-4">
      <PageHeader title="⚖ Governance" subtitle="The organisation's controls: the bar a change must clear, the code the fleet may never touch, and the compliance evidence a review needs — all deterministic." />
      <div className="flex flex-wrap gap-1">
        {TABS.map(([id, label]) => (
          <button key={id} onClick={() => setTab(id)} className={`rounded-lg px-3 py-1.5 text-[12px] ${tab === id ? 'bg-ink-800 text-white' : 'text-slate-400 hover:bg-ink-900'}`}>{label}</button>
        ))}
      </div>
      {tab === 'cost' && <CostBudget toast={toast} />}
      {tab === 'gates' && <Gates toast={toast} />}
      {tab === 'protected' && <Protected toast={toast} />}
      {tab === 'egress' && <Egress toast={toast} />}
      {tab === 'evidence' && <Evidence toast={toast} />}
      {tab === 'secrets' && <Secrets toast={toast} />}
      {tab === 'licences' && <Licences toast={toast} />}
      {tab === 'webhooks' && <Webhooks toast={toast} />}
    </div>
  );
}

function Gates({ toast }) {
  const [g, setG] = useState(null);
  const [form, setForm] = useState(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => { api.qualityGates().then((r) => { setG(r); setForm(r); }).catch(() => {}); }, []);
  if (!form) return <div className="grid h-32 place-items-center"><Spinner /></div>;
  const dirty = JSON.stringify(form) !== JSON.stringify(g);
  const save = async () => {
    setBusy(true);
    try { const r = await api.setQualityGates(form); setG(r); setForm(r); toast?.('Quality gates updated', { type: 'success' }); }
    catch (e) { toast?.(e.message, { type: 'error' }); } finally { setBusy(false); }
  };
  const Toggle = ({ k, label, hint }) => (
    <label className="flex items-start gap-2.5 rounded-lg border border-ink-800 p-3">
      <input type="checkbox" checked={!!form[k]} onChange={(e) => setForm({ ...form, [k]: e.target.checked })} className="mt-0.5 accent-brand" />
      <span className="min-w-0">
        <span className="block text-[12px] text-slate-200">{label}</span>
        <span className="block text-[10px] text-slate-600">{hint}</span>
      </span>
    </label>
  );
  return (
    <div className="card p-4">
      <p className="mb-3 text-[11px] text-slate-500">The bar every change must clear. These are the organisation's thresholds — enforced deterministically, not left to a model's judgement.</p>
      <div className="grid gap-4 sm:grid-cols-2">
        <label className="block">
          <span className="mb-1 block text-[11px] font-medium text-slate-400">Minimum score to commit</span>
          <input type="number" min="0" max="100" value={form.minScore} onChange={(e) => setForm({ ...form, minScore: +e.target.value })} className="input" />
          <span className="mt-1 block text-[10px] text-slate-600">a change scoring below this is rolled back</span>
        </label>
        <label className="block">
          <span className="mb-1 block text-[11px] font-medium text-slate-400">Highest risk allowed to auto-land</span>
          <select value={form.maxRisk} onChange={(e) => setForm({ ...form, maxRisk: e.target.value })} className="input">
            <option value="low">low only</option><option value="medium">up to medium</option><option value="high">any (not recommended)</option>
          </select>
          <span className="mt-1 block text-[10px] text-slate-600">anything above goes to human review</span>
        </label>
      </div>
      <div className="mt-3 grid gap-2 sm:grid-cols-3">
        <Toggle k="requireTests" label="Require a test" hint="the change must add or touch a test" />
        <Toggle k="requireGreenBuild" label="Require a green build" hint="compile/typecheck must pass" />
        <Toggle k="blockOnHighCve" label="Block on critical CVE" hint="no promotion while one is open" />
      </div>
      <div className="mt-4"><button className="btn-primary" disabled={busy || !dirty} onClick={save}>{busy ? '…' : dirty ? 'save gates' : 'saved'}</button></div>
    </div>
  );
}

function Protected({ toast }) {
  const [paths, setPaths] = useState(null);
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => { api.protectedPaths().then((r) => { setPaths(r.paths); setText(r.paths.join('\n')); }).catch(() => {}); }, []);
  if (paths == null) return <div className="grid h-32 place-items-center"><Spinner /></div>;
  const dirty = text !== paths.join('\n');
  const save = async () => {
    setBusy(true);
    try {
      const r = await api.setProtectedPaths(text.split('\n').map((s) => s.trim()).filter(Boolean));
      setPaths(r.paths); setText(r.paths.join('\n')); toast?.('Protected paths updated', { type: 'success' });
    } catch (e) { toast?.(e.message, { type: 'error' }); } finally { setBusy(false); }
  };
  return (
    <div className="card p-4">
      <p className="mb-2 text-[11px] text-slate-500">
        Glob patterns the fleet may <strong className="text-slate-300">never</strong> modify autonomously. A hard boundary
        enforced before any model sees the task — one pattern per line (<code className="font-mono">**/migrations/**</code>).
      </p>
      <textarea value={text} onChange={(e) => setText(e.target.value)} rows={10}
        className="w-full rounded-lg border border-ink-800 bg-ink-950/60 p-2 font-mono text-[12px] text-slate-200 outline-none" />
      <div className="mt-3 flex items-center gap-2">
        <button className="btn-primary" disabled={busy || !dirty} onClick={save}>{busy ? '…' : dirty ? 'save paths' : 'saved'}</button>
        <span className="text-[11px] text-slate-600">{paths.length} rule(s) active</span>
      </div>
    </div>
  );
}

/**
 * Data egress — the boundary control. Two things an operator must be able to see without reading
 * source: what the CURRENT provider configuration would do, and the immutable record of what has
 * already been sent. The redaction preview exists because the only way to trust a redactor is to
 * watch it work on your own text.
 */
function Egress({ toast }) {
  const [d, setD] = useState(null);
  const [ledger, setLedger] = useState(null);
  const [hosts, setHosts] = useState('');
  const [sample, setSample] = useState('');
  const [preview, setPreview] = useState(null);
  const [busy, setBusy] = useState(false);

  const load = () => {
    api.egress().then((r) => { setD(r); setHosts((r.policy.approvedHosts || []).join('\n')); }).catch(() => {});
    api.egressLedger(100).then(setLedger).catch(() => {});
  };
  useEffect(() => { load(); }, []);

  const save = async (patch) => {
    setBusy(true);
    try { await api.setEgress(patch); toast?.('Egress policy updated', { type: 'success' }); load(); }
    catch (e) { toast?.(e.message, { type: 'error' }); } finally { setBusy(false); }
  };

  const runPreview = async () => {
    try { setPreview(await api.egressPreview(sample)); }
    catch (e) { toast?.(e.message, { type: 'error' }); }
  };

  if (!d) return <div className="grid h-32 place-items-center"><Spinner /></div>;
  const chainOk = d.chain?.ok;

  return (
    <div className="space-y-3">
      {/* What the current configuration would actually do — before a call proves it the hard way. */}
      <div className={`card border ${d.current.wouldBeAllowed ? 'border-ink-800' : 'border-rose-500/40'}`}>
        <CardHead title="Current destination">
<span className={`pill ${d.current.destination === 'local' ? 'bg-emerald-500/15 text-emerald-300' : 'bg-amber-500/15 text-amber-300'}`}>{d.current.destination}</span>
      </CardHead>
        <div className="px-3 py-3 text-[12px] text-slate-400">
          <span className="font-mono text-slate-300">{d.current.host}</span> · {d.current.provider}
          {d.current.wouldBeAllowed
            ? <span className="ml-2 text-emerald-400">allowed by the current policy</span>
            : <span className="ml-2 text-rose-400">would be REFUSED by the current policy — model calls will fail until the policy or the provider changes</span>}
        </div>
      </div>

      <div className="card">
        <div className="card-head">
          <span className="card-title">Egress policy</span>
          <span className="ml-2 text-[11px] text-slate-500">what may leave this machine, and what is stripped first</span>
        </div>
        <div className="space-y-3 px-3 py-3">
          {Object.entries(d.modes).map(([mode, desc]) => (
            <label key={mode} className="flex cursor-pointer items-start gap-2 text-[12px]">
              <input type="radio" name="egress-mode" className="mt-0.5" checked={d.policy.mode === mode} disabled={busy} onChange={() => save({ mode })} />
              <span>
                <span className="text-slate-200">{mode}</span>
                <span className="block text-[11px] text-slate-500">{desc}</span>
              </span>
            </label>
          ))}
          {d.policy.mode === 'approved-vendors' && (
            <div>
              <div className="stat-label mb-1">Approved hosts (one per line)</div>
              <textarea value={hosts} onChange={(e) => setHosts(e.target.value)} rows={3}
                className="w-full rounded-lg bg-ink-900 p-2 font-mono text-[11px] text-slate-300" placeholder="api.your-approved-vendor.com" />
              <button onClick={() => save({ approvedHosts: hosts.split('\n').map((s) => s.trim()).filter(Boolean) })} disabled={busy} className="btn-ghost mt-1 text-[11px]">save hosts</button>
            </div>
          )}
          <label className="flex items-center gap-2 text-[12px] text-slate-400">
            <input type="checkbox" checked={!!d.policy.redact} disabled={busy} onChange={(e) => save({ redact: e.target.checked })} />
            Redact credentials from remote payloads
          </label>
          <label className="flex items-center gap-2 text-[12px] text-slate-400">
            <input type="checkbox" checked={!!d.policy.capturePayloads} disabled={busy} onChange={(e) => save({ capturePayloads: e.target.checked })} />
            Store full payloads in the ledger
            <span className="text-[10px] text-slate-600">— makes the ledger a second copy of your source code; off by default</span>
          </label>
        </div>
      </div>

      {/* Redaction preview: paste anything, see exactly what would leave. */}
      <div className="card">
        <div className="card-head">
          <span className="card-title">Redaction preview</span><span className="ml-2 text-[11px] text-slate-500">paste a prompt — see what would actually be sent</span>
        </div>
        <div className="space-y-2 px-3 py-3">
          <textarea value={sample} onChange={(e) => setSample(e.target.value)} rows={4}
            className="w-full rounded-lg bg-ink-900 p-2 font-mono text-[11px] text-slate-300" placeholder={'const stripe = "sk_live_…";'} />
          <button onClick={runPreview} disabled={!sample.trim()} className="btn-ghost text-[11px]">preview</button>
          {preview && (
            <pre className="max-h-40 overflow-auto whitespace-pre-wrap rounded-lg bg-ink-900 p-2 font-mono text-[11px] text-slate-300">
              {preview.redacted}
              {'\n\n'}<span className="text-slate-500">{preview.redactions} value(s) redacted</span>
            </pre>
          )}
        </div>
      </div>

      <div className="card">
        <div className="card-head flex-wrap gap-y-1">
          <span className="card-title">Egress ledger</span>
          <span className={`pill ml-2 ${chainOk ? 'bg-emerald-500/15 text-emerald-300' : 'bg-rose-500/15 text-rose-300'}`}
            title={chainOk ? 'Every row hashes onto the previous one — nothing was altered or removed' : d.chain?.reason}>
            {chainOk ? 'chain verified' : `chain BROKEN at #${d.chain?.brokenAt}`}
          </span>
          <span className="ml-2 text-[11px] text-slate-500">
            {d.summary.calls} calls · {d.summary.remoteCalls} remote · {d.summary.denied} denied · {d.summary.redactions} redactions</span>
<button onClick={async () => { await api.sealEgress('manual retention'); toast?.('Ledger sealed and archived', { type: 'success' }); load(); }}
            className="btn-ghost text-[11px]" title="Seal the chain up to now and archive it — verification resumes from the sealed hash">seal & archive</button>
        </div>
        {!ledger?.entries?.length && <div className="px-3 py-6"><Empty icon="🛡" title="No calls recorded yet" hint="Every model call ISL makes — local or remote — lands here with its byte count and payload hash." /></div>}
        <div className="max-h-[45vh] divide-y divide-ink-800 overflow-y-auto">
          {(ledger?.entries || []).map((e) => (
            <div key={e.id} className="flex items-center gap-2 px-3 py-1.5 text-[11px]">
              <span className={`pill ${e.decision === 'deny' ? 'bg-rose-500/15 text-rose-300' : 'bg-slate-600/20 text-slate-400'}`}>{e.decision}</span>
              <span className={`pill ${e.destination === 'remote' ? 'bg-amber-500/15 text-amber-300' : 'bg-slate-600/20 text-slate-500'}`}>{e.destination}</span>
              <span className="text-slate-400">{e.purpose}</span>
              <span className="min-w-0 flex-1 truncate font-mono text-slate-500">{e.host}{e.model ? ` · ${e.model}` : ''}</span>
              {e.redactions > 0 && <span className="pill bg-sky-500/15 text-sky-300" title="credentials stripped before sending">−{e.redactions}</span>}
              {e.tripwires?.length > 0 && <span className="pill bg-rose-500/15 text-rose-300" title={e.tripwires.join(', ')}>tripwire</span>}
              <span className="text-slate-600">{e.bytes}B</span>
              <span className="hidden font-mono text-slate-700 sm:block" title={`payload sha256 ${e.payload_sha}`}>{e.payload_sha.slice(0, 8)}</span>
            </div>
          ))}
        </div>
        {!!ledger?.checkpoints?.length && (
          <div className="border-t border-ink-800 px-3 py-2 text-[10px] text-slate-600">
            {ledger.checkpoints.length} sealed checkpoint(s) — earlier rows were archived; the chain still verifies across the gap.
          </div>
        )}
      </div>
    </div>
  );
}

/**
 * Audit & evidence — the answer to "who authorised this change, what verified it, and can you prove
 * the record wasn't edited afterwards?". The chain badge is deliberately prominent: an audit trail
 * whose integrity is unknown is not an audit trail.
 */
function Evidence({ toast }) {
  const [trail, setTrail] = useState(null);
  const [changes, setChanges] = useState(null);
  const [pack, setPack] = useState(null);

  const load = () => {
    api.auditTrail(60).then(setTrail).catch(() => {});
    api.evidenceList().then((r) => setChanges(r.changes)).catch(() => {});
  };
  useEffect(() => { load(); }, []);

  const open = async (id) => {
    if (pack?.subject?.iterationId === id) return setPack(null); // toggle
    try { setPack(await api.evidencePack(id)); }
    catch (e) { toast?.(e.message, { type: 'error' }); }
  };

  const chain = trail?.chain;

  return (
    <div className="space-y-3">
      <div className="card">
        <div className="card-head flex-wrap gap-y-1">
          <span className="card-title">Platform audit trail</span>
          {chain && (
            <span className={`pill ml-2 ${chain.ok ? 'bg-emerald-500/15 text-emerald-300' : 'bg-rose-500/15 text-rose-300'}`}
              title={chain.ok ? 'Every chained row hashes onto the previous one' : chain.reason}>
              {chain.ok ? 'chain verified' : `chain BROKEN at #${chain.brokenAt}`}
            </span>
          )}
          {/* Rows written before chaining existed are stated, never counted as verified. */}
          {chain?.unchainedLegacy > 0 && (
            <span className="ml-2 text-[11px] text-slate-500" title="Written before hash chaining was introduced — integrity is proven from that point on, not before.">
              {chain.rows} chained · {chain.unchainedLegacy} predate chaining
            </span>
          )}
          <div className="flex-1" />
          <button onClick={load} className="btn-ghost text-[11px]">refresh</button>
        </div>
        <div className="max-h-[30vh] divide-y divide-ink-800 overflow-y-auto">
          {(trail?.entries || []).map((e) => (
            <div key={e.id} className="flex items-center gap-2 px-3 py-1.5 text-[11px]">
              <span className="w-32 shrink-0 text-slate-600">{new Date(e.ts).toLocaleString()}</span>
              <span className="text-slate-300">{e.action}</span>
              <span className="text-slate-500">{e.actor}</span>
              <span className="min-w-0 flex-1 truncate text-slate-600">{e.target || ''}</span>
              {e.row_hash
                ? <span className="font-mono text-[10px] text-slate-700" title={`row hash ${e.row_hash}`}>{e.row_hash.slice(0, 8)}</span>
                : <span className="pill bg-slate-600/20 text-slate-500" title="Written before hash chaining">unchained</span>}
            </div>
          ))}
          {!trail?.entries?.length && <div className="px-3 py-6"><Empty icon="📜" title="No audit entries" hint="Logins, project switches, approvals and policy changes land here." /></div>}
        </div>
      </div>

      <div className="card">
        <div className="card-head">
          <span className="card-title">Change evidence packs</span>
          <span className="ml-2 text-[11px] text-slate-500">one landed change → the whole change-control record, in one signed file</span>
        </div>
        <div className="max-h-[40vh] divide-y divide-ink-800 overflow-y-auto">
          {(changes || []).map((c) => (
            <div key={c.id}>
              <div className="flex items-center gap-2 px-3 py-2 text-[12px]">
                <span className="pill bg-ink-800 text-slate-400">#{c.id}</span>
                <span className="min-w-0 flex-1 truncate text-slate-300">{c.plan_title || '(untitled)'}</span>
                <span className="font-mono text-[10px] text-slate-600">{(c.commit_sha || '').slice(0, 7)}</span>
                <span className="text-slate-600">{c.files_changed}f +{c.additions}−{c.deletions}</span>
                <button onClick={() => open(c.id)} className="btn-ghost text-[11px]">{pack?.subject?.iterationId === c.id ? 'close' : 'build pack'}</button>
                <a href={api.evidenceHtmlUrl(c.id)} target="_blank" rel="noreferrer" className="btn-ghost text-[11px]" title="Self-contained HTML an auditor can read without ISL">↓ html</a>
              </div>
              {pack?.subject?.iterationId === c.id && (
                <div className="space-y-1 border-t border-ink-800 bg-ink-950/50 px-3 py-2 text-[11px] text-slate-400">
                  <div><span className="text-slate-500">Authorised by:</span> {pack.approval.reviewed
                    ? <>{pack.approval.status} — {pack.approval.decidedBy || 'auto'} ({pack.approval.routing}, risk {pack.approval.risk})</>
                    : <span className="text-amber-300">no explicit human decision recorded</span>}</div>
                  <div><span className="text-slate-500">Verified by:</span> {pack.verification.phases.filter((p) => p.status === 'ok').length}/{pack.verification.phases.length} phases · total score {pack.verification.scores.total ?? '—'}</div>
                  <div><span className="text-slate-500">Record integrity:</span>{' '}
                    <span className={pack.integrity.auditChain?.ok ? 'text-emerald-400' : 'text-rose-400'}>audit {pack.integrity.auditChain?.ok ? 'verified' : 'BROKEN'}</span>
                    {' · '}
                    <span className={pack.integrity.egressChain?.ok ? 'text-emerald-400' : 'text-rose-400'}>egress {pack.integrity.egressChain?.ok ? 'verified' : 'BROKEN'}</span>
                  </div>
                  <div className="break-all font-mono text-[10px] text-slate-600">digest {pack.digest}</div>
                </div>
              )}
            </div>
          ))}
          {changes && !changes.length && <div className="px-3 py-6"><Empty icon="🧾" title="No landed changes yet" hint="A change becomes evidenceable once it has a commit." /></div>}
          {!changes && <div className="grid h-24 place-items-center"><Spinner /></div>}
        </div>
      </div>
    </div>
  );
}

function Secrets({ toast }) {
  const [d, setD] = useState(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => { api.repoSecrets().then(setD).catch(() => {}); }, []);
  const scan = async () => {
    setBusy(true);
    try { const r = await api.scanRepoSecrets(); setD(r); toast?.(`Scanned ${r.scanned} files — ${r.total} finding(s)`, { type: r.total ? 'warn' : 'success' }); }
    catch (e) { toast?.(e.message, { type: 'error' }); } finally { setBusy(false); }
  };
  return (
    <div className="card">
      <div className="card-head">
          <span className="card-title">Repository secret scan</span>
        <span className="ml-2 text-[11px] text-slate-500">the whole tree — credentials committed before ISL arrived</span>
<button onClick={scan} disabled={busy} className="btn-ghost text-[11px]">{busy ? 'scanning…' : d?.total != null ? 'rescan' : 'scan now'}</button>
      </div>
      {d?.total == null && <div className="px-3 py-6"><Empty icon="🔑" title="Not scanned yet" hint="Find private keys, cloud credentials, tokens and connection strings that are already in the repository." /></div>}
      {d?.total === 0 && <div className="px-3 py-6"><Empty icon="✓" title="No secrets found" hint={`${d.scanned} files scanned. Values are never echoed — only their location.`} /></div>}
      {d?.total > 0 && (
        <>
          <div className="flex flex-wrap gap-2 px-3 py-3">
            {Object.entries(d.bySeverity).map(([s, n]) => <span key={s} className={`pill ${SEV[s] || SEV.low}`}>{n} {s}</span>)}
            <span className="text-[11px] text-slate-600">{d.scanned} files scanned</span>
          </div>
          <div className="max-h-[50vh] divide-y divide-ink-800 overflow-y-auto border-t border-ink-800">
            {d.findings.map((f, i) => (
              <div key={i} className="flex items-start gap-3 px-3 py-2 text-[12px]">
                <span className={`pill ${SEV[f.severity]}`}>{f.severity}</span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate font-mono text-slate-300">{f.file}:{f.line}</span>
                  <span className="block truncate text-[10px] text-slate-600">{f.kind} · {f.excerpt}</span>
                </span>
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  );
}

function Licences({ toast }) {
  const [d, setD] = useState(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => { api.licences().then(setD).catch(() => {}); }, []);
  const scan = async () => {
    setBusy(true);
    try { const r = await api.scanLicences(); setD(r); toast?.(`${r.flaggedCount} licence(s) need review`, { type: r.flaggedCount ? 'warn' : 'success' }); }
    catch (e) { toast?.(e.message, { type: 'error' }); } finally { setBusy(false); }
  };
  const CAT = { permissive: 'bg-emerald-500/15 text-emerald-300', copyleft: 'bg-rose-500/15 text-rose-300', unknown: 'bg-amber-500/15 text-amber-300' };
  return (
    <div className="card">
      <div className="card-head">
          <span className="card-title">Dependency licences</span>
        <span className="ml-2 text-[11px] text-slate-500">read from the installed tree — no network</span>
<button onClick={scan} disabled={busy} className="btn-ghost text-[11px]">{busy ? 'scanning…' : d?.flaggedCount != null ? 'rescan' : 'scan now'}</button>
      </div>
      {d?.flaggedCount == null && <div className="px-3 py-6"><Empty icon="⚖" title="Not scanned yet" hint="Inventory every dependency licence and flag copyleft or unrecognised ones for legal review." /></div>}
      {d?.byLicence?.length > 0 && (
        <>
          <div className="flex flex-wrap gap-1.5 px-3 py-3">
            {d.byLicence.slice(0, 12).map((l) => (
              <span key={l.license} className={`pill ${CAT[l.category]}`}>{l.license} × {l.count}</span>
            ))}
          </div>
          <div className="border-t border-ink-800 px-3 py-2 text-[11px] text-slate-500">
            {d.projects.map((p) => `${p.dir}: ${p.packages}`).join(' · ')} — <span className={d.flaggedCount ? 'text-amber-400' : 'text-emerald-400'}>{d.flaggedCount} need review</span>
          </div>
          {/* Virtualised: a monorepo's flagged-licence list runs to thousands of packages, and this
              list is perfectly tabular — one row, one package, no nesting. Sortable by licence is the
              point: legal review groups by licence, not by package name. */}
          <div className="border-t border-ink-800">
            <DataTable
              id="licences"
              rows={d.flagged}
              rowKey={(f, i) => `${f.name}@${f.version}:${i}`}
              maxHeight="42vh"
              columns={[
                { key: 'license', label: 'Licence', width: 140, render: (f) => <span className="pill bg-ink-800 text-slate-400">{f.license}</span> },
                { key: 'name', label: 'Package', value: (f) => `${f.name}@${f.version}`, render: (f) => <span className="font-mono text-slate-300">{f.name}@{f.version}</span> },
                { key: 'why', label: 'Why flagged', render: (f) => <span className="text-slate-500">{f.why}</span> },
              ]}
            />
          </div>
        </>
      )}
    </div>
  );
}

function Webhooks({ toast }) {
  const [d, setD] = useState(null);
  const [url, setUrl] = useState('');
  const [secret, setSecret] = useState('');
  const [busy, setBusy] = useState(false);
  const load = () => api.webhooks().then(setD).catch(() => {});
  useEffect(() => { load(); }, []);
  if (!d) return <div className="grid h-32 place-items-center"><Spinner /></div>;
  const add = async () => {
    setBusy(true);
    try { await api.addWebhook({ url, secret }); setUrl(''); setSecret(''); load(); toast?.('Webhook added', { type: 'success' }); }
    catch (e) { toast?.(e.message, { type: 'error' }); } finally { setBusy(false); }
  };
  const del = async (id) => { await api.deleteWebhook(id); load(); };
  return (
    <div className="card">
      <div className="card-head">
          <span className="card-title">Outbound webhooks</span><span className="ml-2 text-[11px] text-slate-500">notify Slack, CI or a ticket system — signed with HMAC-SHA256 when a secret is set</span>
        </div>
      <div className="flex flex-wrap gap-2 px-3 py-3">
        <input value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://hooks.example.com/isl" className="input min-w-[240px] flex-1" />
        <input value={secret} onChange={(e) => setSecret(e.target.value)} placeholder="signing secret (optional)" className="input w-52" />
        <button onClick={add} disabled={busy || !url.trim()} className="btn-primary">add</button>
      </div>
      <div className="border-t border-ink-800 px-3 py-2 text-[10px] text-slate-600">events: {d.events.join(' · ')}</div>
      <div className="divide-y divide-ink-800 border-t border-ink-800">
        {d.hooks.map((h) => (
          <div key={h.id} className="flex items-center gap-3 px-3 py-2 text-[12px]">
            <span className="min-w-0 flex-1 truncate font-mono text-slate-300">{h.url}</span>
            {h.hasSecret && <span className="pill bg-emerald-500/15 text-emerald-300">signed</span>}
            {h.lastStatus && <span className="text-[10px] text-slate-600">{h.lastStatus}</span>}
            <button onClick={() => del(h.id)} className="btn-ghost text-[11px]">remove</button>
          </div>
        ))}
        {!d.hooks.length && <div className="px-3 py-6"><Empty icon="🔔" title="No webhooks" hint="Add one so landed changes, blocked-unsafe changes and critical CVEs reach your existing tools." /></div>}
      </div>
    </div>
  );
}
