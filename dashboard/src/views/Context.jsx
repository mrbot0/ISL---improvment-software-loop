import { useEffect, useRef, useState } from 'react';
import { api } from '../api.js';
import { useResource } from '../hooks.js';
import { SAFETY_NET_MS } from '../liveKeys.js';
import { CardHead, Empty, SeverityPill, Spinner } from '../components/ui.jsx';

/**
 * The Context Manager surface: the project profile derived from its docs, the
 * onboarding questions (auto-answered where the docs suffice, asked where they
 * don't), the document index, and the documentation findings.
 */
export default function Context({ toast }) {
  const [data, setData] = useState(null);
  const [docs, setDocs] = useState([]);
  const [busy, setBusy] = useState(null);
  const poll = useRef(null);

  const load = async () => {
    try {
      const [ctx, documents] = await Promise.all([api.context(), api.contextDocuments()]);
      setData(ctx);
      setDocs(documents);
    } catch (e) {
      toast?.(e.message, { type: 'error' });
    }
  };
  // The Context Agent's snapshot moves when the agent reports or a build finishes — both events —
  // so the 5-second poll that used to sit here is gone. The `poll` ref below is a different thing
  // and stays: it watches an LLM job that is already running, which no event announces per step.
  const { data: situation } = useResource('context:situation', api.contextSituation, { interval: SAFETY_NET_MS });
  useEffect(() => {
    load();
    return () => clearInterval(poll.current);
  }, []);

  // While a long LLM task runs, poll so the profile/questions appear when ready.
  const run = async (kind, fn, msg) => {
    setBusy(kind);
    try {
      const r = await fn();
      if (r?.busy) toast?.('Already running…', { type: 'info' });
      else toast?.(msg, { type: 'info' });
      clearInterval(poll.current);
      let n = 0;
      poll.current = setInterval(async () => {
        await load();
        if (++n > 60) clearInterval(poll.current);
      }, 4000);
    } catch (e) {
      toast?.(e.message, { type: 'error' });
    } finally {
      setBusy(null);
    }
  };

  if (!data) return <div className="grid h-40 place-items-center text-slate-500"><Spinner /></div>;

  const profile = data.profile;
  const pending = data.pending;

  return (
    <div className="mx-auto max-w-5xl space-y-4">
      <KnowledgeSearch toast={toast} />

      {/* actions */}
      <div className="flex flex-wrap items-center gap-2">
        <button disabled={busy} onClick={() => run('build', () => api.contextBuild(true), 'Building context from documents…')} className="btn-primary">
          {busy === 'build' ? <Spinner /> : '⟳'} Build context
        </button>
        <button disabled={busy} onClick={() => run('ingest', api.contextIngest, 'Re-indexing documents…')} className="btn-ghost">
          {busy === 'ingest' ? <Spinner /> : '⭳'} Re-index docs
        </button>
        <button disabled={busy} onClick={() => run('verify', api.contextVerify, 'Verifying documentation…')} className="btn-ghost">
          {busy === 'verify' ? <Spinner /> : '✓'} Verify docs
        </button>
        <div className="flex-1" />
        <span className="text-[11px] text-slate-500">
          {data.documents?.total ?? 0} docs · {pending} open question(s)
        </span>
      </div>

      <ContextAgentPanel situation={situation} />

      {!profile && (
        <Empty
          icon="📚"
          title="No project context yet"
          hint="Press “Build context” — the Context Manager will read the project's documentation, profile what the app is and its objective, and ask you only the questions the docs can't answer."
        />
      )}

      {profile && (
        <div className="card p-4">
          <div className="mb-2 flex items-center gap-2">
            <span className="card-title">Project profile</span>
            {pending === 0 ? (
              <span className="pill bg-emerald-500/15 text-emerald-300">ready</span>
            ) : (
              <span className="pill bg-amber-500/15 text-amber-300">{pending} question(s) open</span>
            )}
          </div>
          {profile.summary && <p className="text-[13px] leading-relaxed text-slate-300">{profile.summary}</p>}
          <div className="mt-3 grid gap-3 sm:grid-cols-2">
            <Field label="What it is" value={profile.whatItIs} />
            <Field label="Objective" value={profile.objective} />
            <Field label="Audience" value={profile.audience} />
            <div>
              <span className="stat-label">Stack</span>
              <div className="mt-1 flex flex-wrap gap-1">
                {(profile.stack || []).map((s, i) => (
                  <span key={i} className="pill bg-ink-800 text-slate-300">{s}</span>
                ))}
              </div>
            </div>
          </div>
          {profile.architecture && (
            <div className="mt-3">
              <span className="stat-label">Architecture</span>
              <p className="mt-0.5 text-[12px] leading-relaxed text-slate-400">{profile.architecture}</p>
            </div>
          )}
          {profile.keyFlows?.length > 0 && (
            <div className="mt-3">
              <span className="stat-label">Key flows</span>
              <ul className="mt-1 list-disc space-y-0.5 pl-5 text-[12px] text-slate-400">
                {profile.keyFlows.map((f, i) => <li key={i}>{f}</li>)}
              </ul>
            </div>
          )}
          {profile.areas?.length > 0 && (
            <div className="mt-3">
              <span className="stat-label">Codebase areas</span>
              <div className="mt-1 grid gap-1.5 sm:grid-cols-2">
                {profile.areas.map((a, i) => (
                  <div key={i} className="rounded border border-ink-800 bg-ink-950/40 p-2">
                    <div className="text-[12px] font-semibold text-slate-300">{a.name} {a.path && <span className="font-mono text-[10px] font-normal text-slate-500">{a.path}</span>}</div>
                    {a.responsibility && <div className="text-[11px] text-slate-400">{a.responsibility}</div>}
                    {a.cautions && <div className="mt-0.5 text-[10px] text-amber-400/80">⚠ {a.cautions}</div>}
                  </div>
                ))}
              </div>
            </div>
          )}
          {profile.invariants?.length > 0 && (
            <div className="mt-3">
              <span className="stat-label">Invariants (must never break)</span>
              <ul className="mt-1 list-disc space-y-0.5 pl-5 text-[12px] text-rose-300/90">
                {profile.invariants.map((f, i) => <li key={i}>{f}</li>)}
              </ul>
            </div>
          )}
          {profile.risks?.length > 0 && (
            <div className="mt-3">
              <span className="stat-label">Sensitive / fragile areas</span>
              <ul className="mt-1 list-disc space-y-0.5 pl-5 text-[12px] text-amber-300/80">
                {profile.risks.map((f, i) => <li key={i}>{f}</li>)}
              </ul>
            </div>
          )}
          {profile.glossary?.length > 0 && (
            <div className="mt-3">
              <span className="stat-label">Glossary</span>
              <div className="mt-1 grid gap-1 sm:grid-cols-2">
                {profile.glossary.map((g, i) => (
                  <div key={i} className="text-[12px]"><span className="font-semibold text-slate-300">{g.term}</span> <span className="text-slate-500">— {g.definition}</span></div>
                ))}
              </div>
            </div>
          )}
        </div>
      )}

      {/* questions */}
      {data.questions?.length > 0 && (
        <div className="card">
          <CardHead title="Onboarding questions" />
          <div className="divide-y divide-ink-800">
            {data.questions.map((q) => <Question key={q.id} q={q} onSaved={load} toast={toast} />)}
          </div>
        </div>
      )}

      {/* findings */}
      {data.findings?.length > 0 && (
        <div className="card">
          <div className="card-head">
          <span className="card-title">Documentation findings ({data.findings.length})</span>
        </div>
          <div className="divide-y divide-ink-800">
            {data.findings.map((f) => (
              <div key={f.id} className="flex items-start gap-3 px-3 py-2">
                <SeverityPill severity={f.severity === 'high' ? 'high' : f.severity === 'low' ? 'low' : 'medium'} />
                <div className="min-w-0 flex-1">
                  <div className="text-[12px] text-slate-300">{f.message}</div>
                  {f.relPath && <div className="font-mono text-[10px] text-slate-500">{f.relPath}</div>}
                </div>
                <span className="pill bg-ink-800 text-slate-400">{f.kind}</span>
                <button onClick={() => api.resolveFinding(f.id).then(load)} className="btn-ghost">Resolve</button>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* documents */}
      <div className="card">
        <div className="card-head">
          <span className="card-title">Documents ({docs.length})</span>
          <span className="text-[10px] text-slate-500">
            {Object.entries(data.documents?.byType || {}).map(([t, n]) => `${n} ${t}`).join(' · ')}
          </span>
        </div>
        <div className="max-h-96 divide-y divide-ink-800 overflow-y-auto">
          {docs.map((d) => (
            <div key={d.id} className="flex items-center gap-2 px-3 py-1.5">
              <span className="pill bg-ink-800 text-slate-400">{d.type}</span>
              <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-slate-400">{d.relPath}</span>
              {d.stale && <span className="pill bg-amber-500/15 text-amber-300">stale</span>}
              {d.error && <span className="pill bg-rose-500/15 text-rose-300" title={d.error}>error</span>}
              <span className="text-[10px] text-slate-600">{(d.chars / 1000).toFixed(1)}k</span>
            </div>
          ))}
          {!docs.length && <Empty title="No documents indexed" hint="ISL scans .md, .pdf, .docx, .txt and more across the project folder." />}
        </div>
      </div>
    </div>
  );
}

const Field = ({ label, value }) =>
  value ? (
    <div>
      <span className="stat-label">{label}</span>
      <div className="mt-0.5 text-[12px] text-slate-300">{value}</div>
    </div>
  ) : null;

/**
 * The Context Agent's live view: what the fleet is doing RIGHT NOW. This is the same
 * situational context every improvement agent gets injected into its prompt, so the
 * operator can see exactly what the agents can see.
 */
function ContextAgentPanel({ situation }) {
  const snap = situation?.snapshot;
  const it = snap?.activeIteration;
  const peers = (snap?.runningTasks || []).filter((t) => t.title);

  return (
    <div className="card p-4">
      <div className="mb-2 flex items-center gap-2">
        <span className="card-title">🧭 Context Agent</span>
        <span className="pill bg-indigo-500/15 text-indigo-300">live</span>
        <div className="flex-1" />
        <span className="text-[10px] text-slate-500">feeds situational context to every agent</span>
      </div>

      {!snap ? (
        <div className="text-[12px] text-slate-500">Gathering situational awareness…</div>
      ) : (
        <div className="space-y-3">
          <div className="grid gap-2 sm:grid-cols-3">
            <MiniStat label="Backlog code hotspots" value={snap.backlog?.functions ?? 0} />
            <MiniStat label="Backlog features" value={snap.backlog?.features ?? 0} />
            <MiniStat label="Open doc findings" value={snap.contextFindings ?? 0} tone={snap.contextFindings ? 'warn' : undefined} />
          </div>

          <div>
            <span className="stat-label">Current mission</span>
            {it?.title ? (
              <div className="mt-0.5 text-[12px] text-slate-300">
                <span className="font-mono text-[10px] text-slate-500">#{it.id}</span>{' '}
                {it.title}{' '}
                {it.live
                  ? <span className="pill bg-emerald-500/15 text-emerald-300">live · {it.phase}</span>
                  : <span className="pill bg-ink-800 text-slate-400">{it.status}</span>}
              </div>
            ) : (
              <div className="mt-0.5 text-[12px] text-slate-500">Idle — no iteration in flight.</div>
            )}
          </div>

          {peers.length > 0 && (
            <div>
              <span className="stat-label">What the fleet is doing {it?.live ? 'now' : '(last iteration)'}</span>
              <div className="mt-1 space-y-1">
                {peers.slice(0, 8).map((t, i) => (
                  <div key={i} className="flex items-center gap-2 text-[11px]">
                    <span className="pill bg-ink-800 text-slate-400">{t.agent || 'agent'}</span>
                    <span className="min-w-0 flex-1 truncate text-slate-300">{t.title}</span>
                    <span className={`pill ${t.status === 'done' ? 'bg-emerald-500/15 text-emerald-300' : t.status === 'running' ? 'bg-sky-500/15 text-sky-300' : t.status === 'failed' ? 'bg-rose-500/15 text-rose-300' : 'bg-ink-800 text-slate-400'}`}>{t.status}</span>
                  </div>
                ))}
              </div>
            </div>
          )}

          {snap.recentlyLanded?.length > 0 && (
            <div>
              <span className="stat-label">Recently landed</span>
              <div className="mt-1 space-y-0.5">
                {snap.recentlyLanded.map((c, i) => (
                  <div key={i} className="flex items-center gap-2 text-[11px]">
                    <span className="font-mono text-[10px] text-slate-500">{String(c.sha).slice(0, 8)}</span>
                    <span className="min-w-0 flex-1 truncate text-slate-400">{c.title}</span>
                    {c.score != null && <span className="pill bg-ink-800 text-slate-400">{c.score}</span>}
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

const MiniStat = ({ label, value, tone }) => (
  <div className="rounded border border-ink-800 bg-ink-950/40 p-2">
    <div className="stat-label">{label}</div>
    <div className={`text-lg font-semibold ${tone === 'warn' ? 'text-amber-400' : 'text-white'}`}>{value}</div>
  </div>
);

function Question({ q, onSaved, toast }) {
  const answered = q.answer && q.answer.trim();
  const [draft, setDraft] = useState(q.answer || '');
  const [busy, setBusy] = useState(false);

  const save = async () => {
    setBusy(true);
    try {
      await api.answerQuestion(q.id, draft);
      toast?.('Answer saved', { type: 'success' });
      onSaved?.();
    } catch (e) {
      toast?.(e.message, { type: 'error' });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="px-3 py-3">
      <div className="flex items-start gap-2">
        <span className={`mt-0.5 pill ${q.source === 'auto' ? 'bg-sky-500/15 text-sky-300' : answered ? 'bg-emerald-500/15 text-emerald-300' : 'bg-amber-500/15 text-amber-300'}`}>
          {q.source === 'auto' ? 'auto' : answered ? 'answered' : 'needs you'}
        </span>
        <div className="min-w-0 flex-1">
          <div className="text-[13px] font-medium text-slate-200">{q.question}</div>
          {q.rationale && <div className="mt-0.5 text-[10px] text-slate-500">{q.rationale}</div>}
          <div className="mt-2 flex gap-2">
            <textarea
              rows={draft.length > 60 ? 3 : 1}
              className="input min-h-[36px] flex-1 resize-y"
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              placeholder="Your answer…"
            />
            <button disabled={busy || draft === (q.answer || '')} onClick={save} className="btn-primary shrink-0 self-start">
              {busy ? <Spinner /> : 'Save'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

/**
 * Knowledge search — BM25 retrieval over the codebase's symbols + the fleet's shared memory.
 * The grounded, ranked search the agents and Alfred use instead of a blind keyword grep.
 */
function KnowledgeSearch({ toast }) {
  const [q, setQ] = useState('');
  const [data, setData] = useState(null);
  const [busy, setBusy] = useState(false);
  const [stats, setStats] = useState(null);
  const [building, setBuilding] = useState(false);

  useEffect(() => { api.knowledge('').then((d) => setStats(d.stats)).catch(() => {}); }, []);

  const search = async (e) => {
    e?.preventDefault?.();
    if (!q.trim()) return;
    setBusy(true);
    try { const d = await api.knowledge(q.trim()); setData(d); setStats(d.stats); }
    catch (err) { toast?.(err.message, { type: 'error' }); }
    finally { setBusy(false); }
  };
  const buildEmb = async () => {
    setBuilding(true);
    try {
      await api.buildEmbeddings();
      toast?.('Building embeddings in the background…', { type: 'info' });
      // poll stats until the build settles
      const t = setInterval(async () => {
        const d = await api.knowledge('').catch(() => null);
        if (d?.stats) { setStats(d.stats); if (!d.stats.building) { clearInterval(t); setBuilding(false); } }
      }, 4000);
    } catch (err) { toast?.(err.message, { type: 'error' }); setBuilding(false); }
  };

  const s = stats || data?.stats;
  const hybridReady = s && s.embedModel && s.embedded > 0;
  return (
    <div className="card p-3">
      <form onSubmit={search} className="flex items-center gap-2">
        <span className="text-slate-500">🔎</span>
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search code + memory (e.g. 'payment capture idempotency')…"
          className="min-w-0 flex-1 bg-transparent text-[13px] text-slate-200 outline-none placeholder:text-slate-600" />
        {s && (
          <span className="hidden items-center gap-1.5 text-[10px] text-slate-600 sm:flex">
            {s.documents} docs
            <span className={`pill ${hybridReady ? 'bg-emerald-500/15 text-emerald-300' : 'bg-ink-800 text-slate-500'}`}>
              {hybridReady ? `hybrid · ${s.embedded} embedded` : 'lexical'}
            </span>
          </span>
        )}
        <button type="submit" disabled={busy} className="btn-ghost text-[12px]">{busy ? '…' : 'Search'}</button>
        {s?.embedModel && (
          <button type="button" onClick={buildEmb} disabled={building || s.building} className="btn-ghost text-[11px]" title={`Embed the corpus with ${s.embedModel} for semantic search`}>
            {building || s.building ? `embedding ${s.buildProgress?.done ?? ''}/${s.buildProgress?.total ?? ''}…` : (hybridReady ? '↻ re-embed' : 'build embeddings')}
          </button>
        )}
      </form>
      {data && (
        <div className="mt-2 divide-y divide-ink-800 border-t border-ink-800">
          {data.mode && <div className="pt-1.5 text-[10px] text-slate-600">retrieval: {data.mode}</div>}
          {data.results.map((r) => (
            <div key={r.id} className="flex items-start gap-3 py-2 text-[12px]">
              <span className={`pill ${r.kind === 'memory' ? 'bg-amber-500/15 text-amber-300' : 'bg-sky-500/15 text-sky-300'}`}>{r.kind}</span>
              <div className="min-w-0 flex-1">
                <div className="truncate font-mono text-slate-300">{r.title}</div>
                <div className="truncate text-[11px] text-slate-500">{r.snippet}</div>
                {r.symbols?.length ? <div className="mt-0.5 truncate text-[10px] text-slate-600">{r.symbols.join(' · ')}</div> : null}
              </div>
              <span className="text-[10px] text-slate-600" title={`lexical ${r.lexical}${r.cosine != null ? ` · cosine ${r.cosine}` : ''}`}>
                {r.score}{r.cosine != null ? ` · cos ${r.cosine}` : ''}
              </span>
            </div>
          ))}
          {!data.results.length && <div className="py-3 text-[12px] text-slate-500">No matches for “{data.query}”.</div>}
        </div>
      )}
    </div>
  );
}
