import { useState } from 'react';
import { api } from '../api.js';
import { useResource, invalidateResource } from '../hooks.js';
import { CardHead, Empty, PageHeader, Spinner, ago } from '../components/ui.jsx';
import ReviewInbox from '../components/ReviewInbox.jsx';

/**
 * Review — the human approval surface. Every landed change is classified by its blast radius and
 * the acting agent's earned trust: low-risk work by a trusted agent auto-lands, while risky or
 * probationary work waits here for a human. The loop keeps running regardless (advisory by design);
 * this page is where a human blesses or rejects the risky ones, and sees which agents have earned
 * autonomy.
 */
const RISK = {
  high: 'bg-rose-500/15 text-rose-300',
  medium: 'bg-amber-500/15 text-amber-300',
  low: 'bg-slate-600/20 text-slate-400',
};
const TRUST = {
  proven: 'bg-emerald-500/15 text-emerald-300',
  trusted: 'bg-sky-500/15 text-sky-300',
  probation: 'bg-slate-600/20 text-slate-400',
};

export default function Review({ toast, user }) {
  // The inbox is the default: it is where the work happens. The list stays one click away for
  // scanning history, which is a different task and deserves a different shape.
  const [mode, setMode] = useState('inbox');
  const [tab, setTab] = useState('pending');
  const [busy, setBusy] = useState(null);
  const { data, loading } = useResource(
    'review:queue',
    () => api.reviewQueue(),
    { interval: 8000 },
  );
  const { data: budget } = useResource('change-budget', () => api.changeBudget(), { interval: 0 });

  const stats = data?.stats || { pending: 0, approved: 0, rejected: 0, auto: 0 };
  const trust = data?.trust || [];
  const autonomy = data?.autonomy;
  const all = data?.items || [];
  const items = tab === 'all' ? all : all.filter((i) => i.status === tab);

  const decide = async (id, verdict) => {
    setBusy(id);
    try {
      await api.decideReview(id, verdict);
      invalidateResource('review:queue');
      toast?.(verdict === 'approve' ? 'Change approved' : 'Change rejected', { type: verdict === 'approve' ? 'success' : 'warn' });
    } catch (e) {
      toast?.(e.message || 'Failed', { type: 'error' });
    } finally {
      setBusy(null);
    }
  };

  if (loading && !data) return <div className="grid h-40 place-items-center text-slate-500"><Spinner /></div>;

  return (
    <div className="mx-auto max-w-5xl space-y-4">
      <PageHeader title="☑ Review queue" subtitle="Risky or low-trust changes wait for a human here; trusted agents' low-risk work auto-lands. The autonomous loop never stalls — approval governs whether a human has blessed a change." />

      {autonomy?.mode === 'stabilize' && (
        <div className="rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-[12px] text-amber-200">
          🛡 Stabilise mode — {autonomy.reason}. Auto-land is suspended for all agents until health recovers.
        </div>
      )}

      <div className="grid gap-3 sm:grid-cols-4">
        <Stat label="Awaiting review" value={stats.pending} tone={stats.pending ? 'warn' : undefined} />
        <Stat label="Auto-approved" value={stats.auto} tone="ok" />
        <Stat label="Approved" value={stats.approved} tone="ok" />
        <Stat label="Rejected" value={stats.rejected} tone={stats.rejected ? 'bad' : undefined} />
      </div>

      <div className="flex gap-1">
        {[['inbox', '📥 Inbox'], ['queue', '☰ Queue & trust']].map(([id, label]) => (
          <button
            key={id}
            onClick={() => setMode(id)}
            className={`rounded-lg px-3 py-1.5 text-[12px] ${mode === id ? 'bg-ink-800 text-white' : 'text-slate-400 hover:bg-ink-900'}`}
          >
            {label}{id === 'inbox' && stats.pending ? ` (${stats.pending})` : ''}
          </button>
        ))}
      </div>

      {mode === 'inbox' && <ReviewInbox items={all} user={user} toast={toast} />}

      {mode === 'queue' && (<>
      {/* Per-agent trust ledger */}
      <div className="card">
        <CardHead title="Agent trust — earned from land history" />
        <div className="max-h-[30vh] divide-y divide-ink-800 overflow-y-auto">
          {trust.map((t) => (
            <div key={t.agent} className="flex items-center gap-3 px-3 py-2 text-[12px]">
              <span className={`pill ${TRUST[t.level] || TRUST.probation}`}>{t.level}</span>
              <span className="min-w-0 flex-1 truncate font-medium text-slate-200">{t.agent}</span>
              <div className="h-1.5 w-24 overflow-hidden rounded-full bg-ink-800">
                <div className={`h-full ${t.landRate >= 55 ? 'bg-emerald-500' : t.landRate >= 35 ? 'bg-amber-500' : 'bg-rose-500'}`} style={{ width: `${t.landRate}%` }} />
              </div>
              {t.rejected ? <span className="pill bg-rose-500/15 text-rose-300" title="human rejections counted against trust">✕{t.rejected}</span> : null}
              <span className="w-28 text-right text-slate-500">{t.landRate}% · {t.landed}/{t.attempts}</span>
            </div>
          ))}
          {!trust.length && <Empty icon="○" title="No history yet" hint="Trust is learned as agents land work." />}
        </div>
      </div>

      {budget && <ChangeBudget budget={budget} toast={toast} />}

      {/* Queue */}
      <div className="card">
        <div className="card-head">
          <div className="flex gap-1">
            {['pending', 'auto', 'approved', 'rejected', 'all'].map((t) => (
              <button
                key={t}
                onClick={() => setTab(t)}
                className={`rounded-md px-2.5 py-1 text-[12px] capitalize ${tab === t ? 'bg-ink-700 text-white' : 'text-slate-400 hover:text-slate-200'}`}
              >
                {t}{t === 'pending' && stats.pending ? ` (${stats.pending})` : ''}
              </button>
            ))}
          </div>
        </div>
        <div className="max-h-[50vh] divide-y divide-ink-800 overflow-y-auto">
          {items.map((it) => (
            <div key={it.id} className="px-3 py-2.5">
              <div className="flex items-start gap-3">
                <span className={`pill ${RISK[it.risk] || RISK.low}`}>{it.risk}</span>
                <div className="min-w-0 flex-1">
                  <div className="truncate text-[12px] text-slate-200">{it.title}</div>
                  <div className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[10px] text-slate-600">
                    <span className="font-mono">{it.commitSha?.slice(0, 8) || `#${it.iterationId}`}</span>
                    <span>· {it.agent}</span>
                    <span className={`pill ${TRUST[it.trustLevel] || TRUST.probation} !py-0`}>{it.trustLevel}</span>
                    <span>· {it.filesChanged} file{it.filesChanged === 1 ? '' : 's'} (+{it.additions}/-{it.deletions})</span>
                    <span>· {ago(it.createdAt)}</span>
                  </div>
                  {it.reasons?.length ? (
                    <div className="mt-1 text-[11px] text-slate-500">{it.reasons.join(' · ')}</div>
                  ) : null}
                </div>
                {it.status === 'pending' ? (
                  <div className="flex shrink-0 gap-1">
                    <button disabled={busy === it.id} onClick={() => decide(it.id, 'approve')} className="rounded-md bg-emerald-600/80 px-2.5 py-1 text-[11px] text-white hover:bg-emerald-600 disabled:opacity-50">Approve</button>
                    <button disabled={busy === it.id} onClick={() => decide(it.id, 'reject')} className="rounded-md bg-rose-600/70 px-2.5 py-1 text-[11px] text-white hover:bg-rose-600 disabled:opacity-50">Reject</button>
                  </div>
                ) : (
                  <span className={`pill shrink-0 ${it.status === 'rejected' ? 'bg-rose-500/15 text-rose-300' : it.status === 'auto' ? 'bg-slate-600/20 text-slate-400' : 'bg-emerald-500/15 text-emerald-300'}`}>
                    {it.status === 'auto' ? 'auto-approved' : it.status}
                  </span>
                )}
              </div>
            </div>
          ))}
          {!items.length && (
            <Empty icon="✓" title={tab === 'pending' ? 'Nothing awaiting review' : `No ${tab} items`} hint={tab === 'pending' ? 'Risky or low-trust changes will appear here for approval.' : 'Switch tabs to see other changes.'} />
          )}
        </div>
      </div>
      </>)}
    </div>
  );
}

const Stat = ({ label, value, tone }) => (
  <div className="card p-3">
    <div className="stat-label">{label}</div>
    <div className={`stat mt-1 ${tone === 'warn' ? 'text-amber-400' : tone === 'ok' ? 'text-emerald-400' : tone === 'bad' ? 'text-rose-400' : 'text-white'}`}>{value}</div>
  </div>
);

const BUDGET_FIELDS = [
  { key: 'softFiles', label: 'Soft files', hint: 'over this → review' },
  { key: 'softAdditions', label: 'Soft +lines', hint: 'over this → review' },
  { key: 'hardFiles', label: 'Hard files', hint: 'over this → vetoed' },
  { key: 'hardAdditions', label: 'Hard +lines', hint: 'over this → vetoed' },
  { key: 'refactorMultiplier', label: 'Refactor ×', hint: 'refactors move more code' },
];

/** Operator-tunable change-size budget: how much one iteration may change before review / veto. */
function ChangeBudget({ budget, toast }) {
  const [form, setForm] = useState(budget);
  const [saving, setSaving] = useState(false);
  const dirty = BUDGET_FIELDS.some((f) => Number(form[f.key]) !== Number(budget[f.key]));

  const save = async () => {
    setSaving(true);
    try {
      await api.setChangeBudget(form);
      invalidateResource('change-budget');
      toast?.('Change-size budget updated', { type: 'success' });
    } catch (e) {
      toast?.(e.message, { type: 'error' });
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="card p-3">
      <div className="flex items-center">
        <span className="card-title">Change-size budget</span>
        <span className="ml-2 text-[11px] text-slate-500">soft → routes to review · hard → vetoed at commit</span>
        <div className="flex-1" />
        {dirty && <button onClick={save} disabled={saving} className="btn-primary text-[11px]">{saving ? '…' : 'Save'}</button>}
      </div>
      <div className="mt-2 grid grid-cols-2 gap-2 sm:grid-cols-5">
        {BUDGET_FIELDS.map((f) => (
          <label key={f.key} className="block">
            <div className="stat-label" title={f.hint}>{f.label}</div>
            <input
              type="number" min="1"
              value={form[f.key] ?? ''}
              onChange={(e) => setForm({ ...form, [f.key]: e.target.value })}
              className="mt-1 w-full rounded-md border border-ink-800 bg-ink-950/60 px-2 py-1 text-[13px] text-slate-200"
            />
          </label>
        ))}
      </div>
    </div>
  );
}
