import { useEffect, useState } from 'react';
import { api } from '../api.js';
import { Spinner } from '../components/ui.jsx';
import { useConfirm } from '../components/ConfirmDialog.jsx';

/**
 * The promotion gate. Iterations live on the work branch; this is where the
 * operator reviews what's ahead of main and fast-forwards it — the one place a
 * change crosses from "agent work" to "production".
 *
 * Commits are SELECTABLE: pick how far to promote. The work branch is linear, so
 * promoting "up to" a commit brings it and everything older, leaving newer commits
 * for a later promotion.
 */
export default function Deploy({ deploy, repo, actions }) {
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState(null);
  const [error, setError] = useState(null);
  const [selectedSha, setSelectedSha] = useState(null); // null = promote everything (the tip)

  const d = deploy || {};
  const commits = d.commits || [];
  const parse = (c) => {
    const [sha, ...msg] = c.split(' ');
    return { sha, msg: msg.join(' ') };
  };
  // Index of the selected commit; 0 (the tip / newest) when nothing is explicitly picked.
  const selIndex = selectedSha ? Math.max(0, commits.findIndex((c) => parse(c).sha === selectedSha)) : 0;
  const conflicts = d.conflictingCommits || {};
  const includedCount = commits.length ? commits.length - selIndex : 0;

  // Per-commit risk from what ISL recorded about each run, and how far it is safe to promote.
  const risk = d.risk || null;
  const riskBySha = Object.fromEntries((risk?.commits || []).map((c) => [c.sha, c]));
  const [fixing, setFixing] = useState(false);
  const [fixResult, setFixResult] = useState(null);

  const autofix = async (sha) => {
    setFixing(true);
    setFixResult(null);
    try {
      setFixResult(await api.autofixCommit(sha));
    } catch (e) {
      setFixResult({ error: e.message });
    } finally {
      setFixing(false);
    }
  };

  const promote = async ({ stash = false } = {}) => {
    setBusy(true);
    setError(null);
    try {
      const r = await actions.promote(selectedSha, stash ? { stash: true } : {}); // null → promote all
      setResult(r);
      setSelectedSha(null);
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  };

  // The authoritative check: a fast-forward installs ONE state — the tip — so the suite and the boot
  // check there settle it, whatever an individual commit's history says.
  const [verifying, setVerifying] = useState(false);
  const [verified, setVerified] = useState(null);
  const [confirm, confirmUI] = useConfirm();

  // The promote agent. Planning is read-only — it rehearses in a throwaway worktree and touches
  // nothing — so it can be run freely; applying is a separate, explicit step.
  const [planning, setPlanning] = useState(false);
  const [plan, setPlan] = useState(null);
  const [showLeftBehind, setShowLeftBehind] = useState(false);
  const buildPlan = async () => {
    setPlanning(true);
    setPlan(null);
    try {
      setPlan(await api.planPromotion());
    } catch (e) {
      setPlan({ ok: false, error: e.message });
    } finally {
      setPlanning(false);
    }
  };
  const verifyTip = async () => {
    const sha = selectedSha || commits[0]?.split(' ')[0];
    if (!sha) return;
    setVerifying(true);
    setVerified(null);
    try {
      setVerified(await api.verifyCommit(sha));
    } catch (e) {
      setVerified({ ok: false, error: e.message });
    } finally {
      setVerifying(false);
    }
  };

  return (
    <div className="mx-auto max-w-3xl space-y-3">
      {confirmUI}
      {/* pipeline */}
      <div className="card p-5">
        <h2 className="mb-4 text-sm font-semibold text-white">Deploy pipeline</h2>
        <div className="flex items-center justify-between">
          <Stage label="Work branch" sub={d.workBranch} sha={d.workSha} accent="sky" active />
          <Arrow count={d.ahead} />
          <Stage label="main (production)" sub="live branch" sha={d.mainSha} accent="emerald" active />
        </div>
      </div>

      <AutoPromote />
      <Dora />

      {/* promotion */}
      <div className="card p-5">
        <div className="flex items-start justify-between gap-4">
          <div>
            <h3 className="text-sm font-semibold text-white">
              {d.ahead > 0 ? `${includedCount} of ${d.ahead} commit(s) selected to promote` : 'main is up to date'}
            </h3>
            {/*
              * "Commits ahead" counts SHA identity, and a commit whose changes reached the base by
              * another route still counts while carrying nothing new. This branch read 49 ahead
              * with SIX files of real difference — an operator told there are 49 things to promote,
              * who then cannot promote any, concludes the tool is broken. It was telling the truth
              * in a way nobody could act on.
              */}
            {d.contentDiff && d.ahead > 0 && (
              <p className={`mt-0.5 text-[11px] ${d.contentDiff.identical ? 'text-amber-400' : 'text-slate-400'}`}>
                {d.contentDiff.identical
                  ? `…but the two branches are byte-for-byte identical — every one of those commits is already on ${d.baseBranch || 'the base'}.`
                  : `Only ${d.contentDiff.files} file(s) actually differ between the branches — the rest of those commits are already on ${d.baseBranch || 'the base'}.`}
              </p>
            )}
            <p className="mt-1 text-[11px] text-slate-500">
              Promotion fast-forwards <code className="font-mono">main</code>. Select a commit below to promote up to it —
              only clean fast-forwards of already-scored commits are allowed, never a rewrite.
            </p>
          </div>
          <div className="flex shrink-0 flex-wrap items-center gap-2">
            <button
              onClick={buildPlan}
              disabled={planning || busy || !d.ahead}
              className="btn-ghost"
              title="Work out which commits can land WITHOUT the broken ones — rehearsed with real cherry-picks in a throwaway copy. Nothing is changed."
            >
              {planning ? <><Spinner className="mr-1" /> planning…</> : '🧩 plan a promotion'}
            </button>
            <button
              onClick={verifyTip}
              disabled={verifying || busy || !d.ahead}
              className="btn-ghost"
              title="Run the real test suite and the boot check at the commit you would promote TO — this is what actually lands"
            >
              {verifying ? <><Spinner className="mr-1" /> verifying…</> : '✔ verify the tip'}
            </button>
            <button
              onClick={() => promote()}
              disabled={busy || !d.canPromote}
              className="btn-primary"
              title={d.blockedReason || 'Fast-forward main to the selected commit'}
            >
              {busy ? <><Spinner /> promoting…</> : `⬆ promote ${includedCount || ''} to main`}
            </button>
          </div>
        </div>

        {d.blockedReason && d.ahead > 0 && (
          <div className="mt-3 rounded-lg border border-amber-900/50 bg-amber-950/30 px-3 py-2 text-[11px] text-amber-300">
            <div>Cannot promote: {d.blockedReason}</div>
            {/* Naming the files turns "commit or stash first" from a chore into a decision: the
                block is almost always a handful of files, and knowing WHICH ones is the difference
                between resolving it and stashing 20 unrelated edits to find out. */}
            {!!d.blockingFiles?.length && (
              <>
                <ul className="mt-1.5 space-y-0.5 font-mono text-[10px] text-amber-200/80">
                  {d.blockingFiles.map((f) => <li key={f}>{f}</li>)}
                </ul>
                <p className="mt-1.5 text-[10px] text-amber-400/70">
                  {d.dirtyCount > d.blockingFiles.length
                    ? `Your other ${d.dirtyCount - d.blockingFiles.length} edited file(s) are not in the way — only these overlap what would be installed.`
                    : 'These are the files the incoming commits would overwrite.'}
                  {' '}Selecting an earlier commit below often promotes everything up to the conflict.
                </p>
                {/* The chore, done for you. Stashing ONLY the overlapping files and restoring them
                    after the fast-forward is exactly the manual sequence — and nothing is discarded
                    at any point, so the worst case is a normal conflict with the work still in the
                    stash. Being explicit about that is what makes it safe to offer as a button. */}
                <button
                  className="btn-ghost mt-2"
                  disabled={busy}
                  onClick={async () => {
                    if (!(await confirm({
                      title: `Set ${d.blockingFiles.length} edited file(s) aside and promote?`,
                      message: 'They are stashed, main is fast-forwarded, and they are restored on top. '
                        + 'Nothing is discarded: if restoring them conflicts with what was just promoted, '
                        + 'your work stays in the stash and you resolve it as a normal git conflict.',
                      confirmLabel: 'Stash & promote',
                      tone: 'primary',
                    }))) return;
                    promote({ stash: true });
                  }}
                  title="git stash push (only these files) → merge --ff-only → git stash pop"
                >
                  ⇄ set my edits aside and promote
                </button>
              </>
            )}
          </div>
        )}
        {/*
          * How far is it safe to go.
          *
          * Promotion is a fast-forward, so what lands is a contiguous PREFIX — a risky commit in
          * the middle cannot be skipped, and an operator who assumes otherwise promotes it. The
          * banner says the number, offers the one-click selection, and states the constraint.
          */}
        {risk && d.ahead > 0 && (
          <div className={`mt-3 rounded-lg border px-3 py-2 text-[11px] ${
            risk.blockedAt ? 'border-sky-900/50 bg-sky-950/25 text-sky-200' : 'border-emerald-900/50 bg-emerald-950/25 text-emerald-300'
          }`}>
            <div className="flex flex-wrap items-center gap-2">
              <span className="font-medium">
                {risk.safeCount} of {d.ahead} commit(s) carry no recorded risk
              </span>
              {risk.safeUpTo && risk.safeCount < d.ahead && (
                <button
                  className="btn-ghost"
                  onClick={() => setSelectedSha(risk.safeUpTo)}
                  title={`Select up to ${risk.safeUpTo} — the last commit before the first risky one`}
                >
                  select the safe {risk.safeCount}
                </button>
              )}
            </div>
            <p className="mt-1 opacity-80">{risk.note}</p>
            {risk.blockedAt && (
              <div className="mt-1.5 border-t border-white/10 pt-1.5">
                <div className="flex flex-wrap items-baseline gap-2">
                  <code className="font-mono">{risk.blockedAt.sha}</code>
                  <span className="min-w-0 flex-1 truncate opacity-80">{risk.blockedAt.subject}</span>
                  {risk.blockedAt.fixable && (
                    <button
                      className="btn-ghost"
                      disabled={fixing}
                      onClick={() => autofix(risk.blockedAt.sha)}
                      title="Boot this commit in a throwaway copy and try to repair it — produces a diff, changes nothing"
                    >
                      {fixing ? <><Spinner className="mr-1" /> repairing…</> : '🔧 Try to fix it'}
                    </button>
                  )}
                </div>
                <ul className="mt-1 space-y-0.5 opacity-80">
                  {risk.blockedAt.risks.filter((r) => r.blocks).map((r) => (
                    <li key={r.code}>· <strong>{r.label}</strong> — {r.detail || r.why}</li>
                  ))}
                </ul>
                {/* Not every blocker is ours to fix. Saying so beats a disabled button with no reason. */}
                {!risk.blockedAt.fixable && (
                  <p className="mt-1 opacity-60">This one is not something ISL can repair on your behalf.</p>
                )}
              </div>
            )}
          </div>
        )}

        {fixResult && (
          <div className={`mt-3 rounded-lg border px-3 py-2 text-[11px] ${
            fixResult.repaired ? 'border-emerald-900/50 bg-emerald-950/30 text-emerald-300' : 'border-amber-900/50 bg-amber-950/30 text-amber-300'
          }`}>
            {fixResult.notFixable ? fixResult.reason : fixResult.error || fixResult.summary}
            {fixResult.files?.length > 0 && (
              <ul className="mt-1 space-y-0.5 font-mono text-[10px] opacity-80">
                {fixResult.files.map((f) => <li key={f}>{f}</li>)}
              </ul>
            )}
          </div>
        )}

        {/*
          * THE PLAN.
          *
          * A fast-forward can only land a contiguous prefix, so one bad commit walls off everything
          * after it — which on this branch meant nothing could be promoted at all. The plan
          * cherry-picks the good commits onto a fresh branch instead, rehearsing every pick for
          * real, so what is offered here has already been proved to apply.
          */}
        {plan && (
          <div className={`mt-3 rounded-lg border px-3 py-2 text-[11px] ${
            plan.ok === false ? 'border-rose-900/50 bg-rose-950/30 text-rose-300' : 'border-sky-900/50 bg-sky-950/25 text-sky-200'
          }`}>
            {plan.ok === false ? (
              plan.error
            ) : (
              <>
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-medium">{plan.summary}</span>
                  {plan.plan?.length > 0 && (
                    <button
                      className="btn-primary"
                      disabled={busy}
                      onClick={async () => {
                        if (!(await confirm({
                          title: `Promote ${plan.plan.length} commit(s)?`,
                          message: `They are re-applied onto ${d.baseBranch || 'main'} in a throwaway copy and then fast-forwarded in — `
                            + `the ${plan.excluded?.length || 0} left behind never appear. `
                            + (d.blockingFiles?.length ? 'Your overlapping edits are set aside and restored.' : ''),
                          confirmLabel: `Promote ${plan.plan.length}`,
                          tone: 'primary',
                        }))) return;
                        setBusy(true);
                        setError(null);
                        try {
                          const r = await api.applyPromotionPlan(plan.plan.map((p) => p.sha), { stash: !!d.blockingFiles?.length });
                          if (r.ok === false) setError(r.error + (r.hint ? ` — ${r.hint}` : ''));
                          else { setResult(r); setPlan(null); }
                        } catch (e) {
                          setError(e.message);
                        } finally {
                          setBusy(false);
                        }
                      }}
                    >
                      ⬆ approve &amp; promote {plan.plan.length}
                    </button>
                  )}
                </div>
                <p className="mt-1 opacity-75">
                  {plan.plan?.length > 0
                    ? 'Each of these was cherry-picked for real in a throwaway copy before being offered — it is not a prediction that they apply, it is a record that they did.'
                    : 'Nothing here is a failure: the work these commits carry is already on the base branch, so promoting them would change nothing.'}
                </p>
                {/* The category that was missing entirely, and the reason this looked broken. */}
                {plan.alreadyPresent?.length > 0 && (
                  <p className="mt-1 opacity-75">
                    <strong>{plan.alreadyPresent.length}</strong> of them are <strong>already on the base</strong> — their
                    changes arrived by another route (an earlier promotion, a merge, a rebase), so a cherry-pick of them
                    is empty. They are not broken and there is nothing to do about them.
                  </p>
                )}
                {plan.excluded?.length > 0 && (
                  <>
                    <button className="mt-1.5 underline opacity-80 hover:opacity-100" onClick={() => setShowLeftBehind((v) => !v)}>
                      {showLeftBehind ? '▾ hide' : '▸ show'} the {plan.excluded.length} left behind
                    </button>
                    {showLeftBehind && (
                      <ul className="mt-1 max-h-64 space-y-0.5 overflow-auto">
                        {plan.excluded.map((e) => (
                          <li key={e.sha} className="flex gap-2">
                            {/* "You excluded it" and "git refused it" are different facts and the
                                operator acts on them differently — one is a decision to revisit,
                                the other is a dependency to resolve. */}
                            <span className={`shrink-0 font-mono ${e.direct ? 'text-rose-300' : 'text-slate-500'}`}>{e.sha}</span>
                            <span className="min-w-0 flex-1 opacity-75">
                              <span className="text-slate-300">{e.subject?.slice(0, 60)}</span>
                              {' — '}{e.why}
                            </span>
                          </li>
                        ))}
                      </ul>
                    )}
                  </>
                )}
              </>
            )}
          </div>
        )}

        {verified && (
          <div className={`mt-3 rounded-lg border px-3 py-2 text-[11px] ${
            verified.ok ? 'border-emerald-900/50 bg-emerald-950/30 text-emerald-300' : 'border-rose-900/50 bg-rose-950/30 text-rose-300'
          }`}>
            <div className="font-medium">{verified.error || verified.summary}</div>
            {/* "No suite exists here" and "every suite passed" are different claims; reporting the
                first as the second certifies something that was never checked. */}
            {verified.suitesRun === 0 && !verified.error && (
              <div className="mt-0.5 opacity-70">No test suite was found to run — the boot check is all this could verify.</div>
            )}
            {verified.suites?.filter((s) => s.ok === false).map((s) => (
              <pre key={`${s.dir}-${s.id}`} className="mt-1 max-h-40 overflow-auto rounded border border-ink-800 bg-ink-950/60 p-1.5 text-[10px] opacity-80">{s.output}</pre>
            ))}
          </div>
        )}

        {result && (
          <div className="mt-3 rounded-lg border border-emerald-900/50 bg-emerald-950/30 px-3 py-2 text-[11px] text-emerald-300">
            Promoted {result.promoted} commit(s) — main is now {result.to}.
            {result.stashed && (
              result.stashed.restored
                ? <div className="mt-0.5 opacity-80">Your {result.stashed.files.length} edited file(s) were set aside and restored.</div>
                : <div className="mt-0.5 text-amber-300">
                    Your {result.stashed.files.length} edited file(s) could not be re-applied cleanly — they are safe in
                    stash <code className="font-mono">{result.stashed.label}</code>. Run <code className="font-mono">git stash pop</code> and resolve.
                  </div>
            )}
          </div>
        )}
        {error && <p className="mt-3 text-[11px] text-rose-400">{error}</p>}
      </div>

      {/* selectable commits ahead */}
      {commits.length > 0 && (
        <div className="card">
          <div className="flex items-center gap-2 border-b border-ink-800 px-4 py-2.5">
            <h3 className="text-xs font-semibold uppercase tracking-wide text-slate-400">Commits ahead of main — select how far to promote</h3>
            <div className="flex-1" />
            <button onClick={() => setSelectedSha(null)} className="text-[10px] text-slate-500 hover:text-slate-300">
              select all
            </button>
          </div>
          <ul className="divide-y divide-ink-800/60">
            {commits.map((c, i) => {
              const { sha, msg } = parse(c);
              const included = i >= selIndex; // this commit + older ones will promote
              const isSelected = selectedSha ? sha === selectedSha : i === 0;
              // The commit that brought the file you have also edited. Every selection at or ABOVE
              // it fails identically, so marking it turns "commit or stash first" into "pick the
              // one below this line" — the difference between a decision and a guessing game.
              const conflictFiles = conflicts[sha];
              const blocksSelection = !!conflictFiles && included;
              return (
                <li key={sha}>
                  <button
                    onClick={() => setSelectedSha(sha)}
                    className={`flex w-full items-center gap-3 px-4 py-2 text-left text-[11px] transition-colors hover:bg-ink-800/40 ${
                      included ? '' : 'opacity-45'
                    } ${blocksSelection ? 'bg-amber-950/25' : ''}`}
                    title={
                      conflictFiles
                        ? `This commit changes ${conflictFiles.join(', ')}, which you have also edited. Select a commit BELOW this one to promote everything up to it.`
                        : included ? 'This commit will be promoted' : 'Select a newer commit to include this one'
                    }
                  >
                    <span
                      className={`grid h-3.5 w-3.5 shrink-0 place-items-center rounded-full border ${
                        isSelected ? 'border-brand bg-brand' : included ? 'border-emerald-600' : 'border-ink-600'
                      }`}
                    >
                      {isSelected && <span className="h-1.5 w-1.5 rounded-full bg-white" />}
                    </span>
                    <code className="font-mono text-slate-500">{sha}</code>
                    <span className="min-w-0 flex-1 truncate text-slate-300">{msg}</span>
                    {/* What ISL recorded about this commit's own run. A conflict is already shown
                        below; these are the risks that were previously invisible at promote time. */}
                    {riskBySha[sha]?.risks?.filter((r) => r.code !== 'conflict' && r.code !== 'unknown-origin').map((r) => (
                      <span
                        key={r.code}
                        className={`pill ${r.blocks ? 'bg-rose-500/15 text-rose-300' : 'bg-amber-500/15 text-amber-300'}`}
                        title={`${r.why}${r.detail ? ` — ${r.detail}` : ''}`}
                      >
                        {r.label}
                      </span>
                    ))}
                    {conflictFiles ? (
                      <span className="pill bg-amber-500/20 text-amber-300" title={conflictFiles.join(', ')}>
                        ⚠ conflicts with your edit
                      </span>
                    ) : isSelected ? (
                      <span className="pill bg-brand/20 text-brand-light">promote up to here</span>
                    ) : included ? (
                      <span className="text-[10px] text-emerald-400/70">included</span>
                    ) : (
                      <span className="text-[10px] text-slate-600">stays behind</span>
                    )}
                  </button>
                </li>
              );
            })}
          </ul>
        </div>
      )}
    </div>
  );
}

const Stage = ({ label, sub, sha, accent, active }) => (
  <div className={`flex-1 rounded-xl border p-4 text-center ${active ? '' : 'opacity-50'}`} style={{ borderColor: `${accent === 'emerald' ? '#34d39955' : '#38bdf855'}` }}>
    <div className="text-[13px] font-semibold text-white">{label}</div>
    <div className="text-[10px] text-slate-500">{sub}</div>
    <code className="mt-1 block font-mono text-[11px]" style={{ color: accent === 'emerald' ? '#34d399' : '#38bdf8' }}>{sha || '—'}</code>
  </div>
);

const Arrow = ({ count }) => (
  <div className="flex flex-col items-center px-4">
    <span className="text-lg text-slate-600">→</span>
    {count > 0 && <span className="rounded-full bg-amber-500/20 px-1.5 text-[10px] font-bold text-amber-300">+{count}</span>}
  </div>
);

/**
 * Trust-gated auto-promotion — the commits that have EARNED a fast-forward to the base branch:
 * human-approved, or auto-approved under a proven agent, at low risk, with health not dropping.
 * Only a contiguous prefix can move (fast-forward semantics), so it can never skip an unapproved
 * change. Off by default; the dry-run below is always safe to read.
 */
function AutoPromote() {
  const [s, setS] = useState(null);
  const [busy, setBusy] = useState(false);
  const load = () => api.autoPromote().then(setS).catch(() => {});
  useEffect(() => { load(); }, []);
  if (!s) return null;

  const toggle = async () => { setBusy(true); try { await api.setAutoPromote(!s.enabled); await load(); } finally { setBusy(false); } };
  const runNow = async () => {
    if (!window.confirm(`Fast-forward the base branch up to ${s.upToShort}? This promotes ${s.promotable} earned commit(s).`)) return;
    setBusy(true);
    try { const r = await api.runAutoPromote(); alert(r.promoted ? `Promoted ${r.count} commit(s) → ${r.upTo}` : `Not promoted: ${r.reason}`); await load(); }
    finally { setBusy(false); }
  };

  return (
    <div className="card p-5">
      <div className="flex items-center gap-2">
        <h2 className="text-sm font-semibold text-white">Trust-gated auto-promotion</h2>
        <span className={`pill ${s.enabled ? 'bg-emerald-500/15 text-emerald-300' : 'bg-ink-800 text-slate-400'}`}>{s.enabled ? 'enabled' : 'off'}</span>
        <div className="flex-1" />
        <button onClick={toggle} disabled={busy} className="btn-ghost text-[11px]">{s.enabled ? 'disable' : 'enable'}</button>
        {s.upTo && <button onClick={runNow} disabled={busy} className="btn-primary text-[11px]">⬆ promote {s.promotable}</button>}
      </div>
      <p className="mt-1 text-[11px] text-slate-500">
        Only human-approved (or proven-agent, low-risk auto-approved) commits qualify, and only as a contiguous prefix.
      </p>
      <div className="mt-3 text-[12px]">
        <span className="text-slate-400">{s.ahead} ahead</span>
        <span className="mx-2 text-slate-600">·</span>
        <span className={s.promotable ? 'text-emerald-400' : 'text-slate-500'}>{s.promotable} earned promotion</span>
        {s.upToShort && <><span className="mx-2 text-slate-600">·</span><span className="font-mono text-slate-400">up to {s.upToShort}</span></>}
      </div>
      {s.blockedBy && (
        <div className="mt-1 text-[11px] text-amber-400/90">
          Stops at {s.blockedBy.sha ? <span className="font-mono">{s.blockedBy.sha}</span> : null} — {s.blockedBy.reason}
        </div>
      )}
      <div className="mt-3 max-h-52 divide-y divide-ink-800 overflow-y-auto">
        {(s.commits || []).map((c) => (
          <div key={c.sha} className="flex items-start gap-2 py-1.5 text-[11px]">
            <span className={c.ok ? 'text-emerald-400' : 'text-slate-600'}>{c.ok ? '✓' : '✗'}</span>
            <span className="font-mono text-slate-600">{c.shortSha}</span>
            <span className="min-w-0 flex-1 truncate text-slate-300">{c.title.replace(/^\[ai-iter#\d+\]\s*/, '')}</span>
            <span className="hidden text-slate-600 sm:block">{c.reason}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

/**
 * DORA + the post-deploy guardrail.
 *
 * Two things a promotion gate could not say before: how ISL's change actually compares with the
 * team's, and whether what shipped then broke. The comparison is rendered whichever way it comes
 * out — a panel that could only ever show ISL winning would be worth nothing to the operator
 * deciding whether to trust it.
 *
 * `unobserved` is shown as its own state on purpose. A deployment whose signals could not be read
 * is NOT a success, and colouring it green would launder the exact number this panel exists to
 * report honestly.
 */
function Dora() {
  const [d, setD] = useState(null);
  const [busy, setBusy] = useState(false);
  const load = () => api.dora(30).then(setD).catch(() => {});
  useEffect(() => { load(); }, []);
  if (!d) return null;

  const toggleRevert = async () => {
    if (!d.autoRevert && !window.confirm(
      'Give standing authorisation to REVERT a promoted change automatically when its bake window breaches?\n\n'
      + 'Without this, a breach only opens a proposal for you to act on.',
    )) return;
    setBusy(true);
    try { await api.setDoraAutoRevert(!d.autoRevert); await load(); } finally { setBusy(false); }
  };
  const checkNow = async () => { setBusy(true); try { await api.doraCheck(); await load(); } finally { setBusy(false); } };

  const num = (v, suffix = '') => (v == null ? <span className="text-slate-600">—</span> : <>{v}{suffix}</>);
  const Row = ({ label, isl, human }) => (
    <div className="grid grid-cols-3 gap-2 border-t border-ink-800 py-1.5 text-[11px]">
      <span className="text-slate-400">{label}</span>
      <span className="text-right font-mono text-sky-300">{isl}</span>
      <span className="text-right font-mono text-slate-300">{human}</span>
    </div>
  );
  const STATE = {
    watching: 'bg-sky-500/15 text-sky-300',
    clean: 'bg-emerald-500/15 text-emerald-300',
    breached: 'bg-rose-500/15 text-rose-300',
    unobserved: 'bg-amber-500/15 text-amber-300',
  };

  return (
    <div className="card p-5">
      <div className="flex items-center gap-2">
        <h2 className="text-sm font-semibold text-white">Delivery performance &amp; post-deploy guardrail</h2>
        <span className="pill bg-ink-800 text-slate-400">{d.deployments} deploy{d.deployments === 1 ? '' : 's'} / {d.windowDays}d</span>
        <div className="flex-1" />
        <button onClick={checkNow} disabled={busy} className="btn-ghost text-[11px]">check now</button>
        <button onClick={toggleRevert} disabled={busy} className="btn-ghost text-[11px]">
          auto-revert: {d.autoRevert ? 'on' : 'off'}
        </button>
      </div>
      <p className="mt-1 text-[11px] text-slate-500">
        Each promotion is watched for {d.bakeWindowMinutes} minutes against recorded errors, open anomalies and the health
        index. A breach proposes a revert{d.autoRevert ? ' — and, with your standing authorisation, performs it' : ''}, docks the
        responsible agents&apos; trust, and teaches the fleet.
      </p>
      {d.caveat && <p className="mt-2 rounded bg-amber-500/10 px-2 py-1 text-[11px] text-amber-300/90">{d.caveat}</p>}

      <div className="mt-3">
        <div className="grid grid-cols-3 gap-2 text-[10px] uppercase tracking-wide text-slate-500">
          <span />
          <span className="text-right text-sky-400">ISL</span>
          <span className="text-right">human</span>
        </div>
        <Row label="Deployments / week" isl={num(d.isl.deploymentsPerWeek)} human={num(d.human.deploymentsPerWeek)} />
        <Row label="Lead time (median)" isl={num(d.isl.leadTimeMedianHours, 'h')} human={num(d.human.leadTimeMedianHours, 'h')} />
        <Row label="Change failure rate" isl={num(d.isl.changeFailureRate, '%')} human={num(d.human.changeFailureRate, '%')} />
        <Row label="Time to restore (median)" isl={num(d.isl.mttrMedianHours, 'h')} human={num(d.human.mttrMedianHours, 'h')} />
      </div>

      {d.comparison && (
        <div className={`mt-2 rounded px-2 py-1 text-[11px] ${d.comparison.islIsSafer ? 'bg-emerald-500/10 text-emerald-300' : 'bg-rose-500/10 text-rose-300'}`}>
          {d.comparison.islIsSafer
            ? `ISL's changes fail ${Math.abs(d.comparison.changeFailureRateDelta)} points less often than human ones.`
            : `ISL's changes fail ${Math.abs(d.comparison.changeFailureRateDelta)} points MORE often than human ones.`}
        </div>
      )}

      <DeployList
        items={d.recent}
        STATE={STATE}
        onResolve={async (id) => { setBusy(true); try { await api.resolveDoraBreach(id); await load(); } finally { setBusy(false); } }}
      />
    </div>
  );
}

/** The recent promotions and how each one's bake window turned out. */
function DeployList({ items, STATE, onResolve }) {
  if (!items?.length) {
    return <p className="mt-3 text-[11px] text-slate-600">No promotions recorded yet — the first one starts the metrics.</p>;
  }
  return (
    <div className="mt-3 max-h-56 divide-y divide-ink-800 overflow-y-auto">
      {items.map((x) => (
        <div key={x.id} className="py-1.5 text-[11px]">
          <div className="flex items-center gap-2">
            <span className={`pill ${STATE[x.bakeStatus] || 'bg-ink-800 text-slate-400'}`}>{x.bakeStatus}</span>
            <span className="font-mono text-slate-500">{x.to}</span>
            <span className="text-slate-400">{x.commits} commit{x.commits === 1 ? '' : 's'} ({x.islCommits} by ISL)</span>
            <div className="flex-1" />
            {x.bakeStatus === 'breached' && !x.resolvedAt && (
              <button onClick={() => onResolve(x.id)} className="btn-ghost text-[10px]">mark resolved</button>
            )}
            {x.revertedSha && <span className="font-mono text-rose-300">reverted → {x.revertedSha}</span>}
          </div>
          {x.breachReason && <div className="mt-0.5 text-rose-400/90">{x.breachReason}</div>}
          {x.bakeStatus === 'unobserved' && (
            <div className="mt-0.5 text-amber-400/80">No signal source was readable — not counted as a success.</div>
          )}
          {!!x.agents?.length && <div className="mt-0.5 text-slate-600">agents: {x.agents.join(', ')}</div>}
        </div>
      ))}
    </div>
  );
}
