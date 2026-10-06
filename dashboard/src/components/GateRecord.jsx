/**
 * What the two judging gates found on a run.
 *
 * Review, security, regression and test all end in a number, and a number has an obvious home on a
 * score ring. These two do not: the behaviour gate answers "did this refactor change what the suite
 * does?" and the coverage gate answers "does anything actually run the lines this change added?".
 * Both were computed and then existed only inside a log line, which meant the question an operator
 * has after a change goes wrong — *was this checked?* — had nowhere to be answered.
 *
 * Three rules the rendering has to hold to, because getting them wrong is worse than showing nothing:
 *
 *   - **Absent is not zero.** A run where the gate never executed shows "not measured", never 0%.
 *   - **Advisory is not a veto.** A failing advisory verdict is real information, but the change
 *     still landed. Painting it the same red as a blocking failure tells the operator the loop
 *     stopped when it did not.
 *   - **Colour is relative to the floor.** 55% against a floor of 50 is a pass and must not be red
 *     merely because 55 is a low-looking number.
 */

const pct = (n) => (n == null ? '—' : `${n}%`);

/** One labelled line inside a gate panel. */
const Row = ({ label, children }) => (
  <div className="flex gap-2 text-[11px]">
    <span className="w-24 shrink-0 text-slate-500">{label}</span>
    <span className="min-w-0 flex-1 text-slate-300">{children}</span>
  </div>
);

/**
 * The compact form: one pill per gate, for a dense list row.
 * Renders nothing at all when neither gate has anything to say — an empty slot beats a row of "—".
 */
export function GatePills({ gates }) {
  const cov = gates?.coverage;
  const beh = gates?.behaviour;
  if (!cov && !beh) return null;

  return (
    <>
      {cov && (cov.applicable ? (
        <span
          className={`pill ${cov.pass === false
            ? (cov.mode === 'enforce' ? 'bg-rose-500/15 text-rose-300' : 'bg-amber-500/15 text-amber-300')
            : 'bg-emerald-500/15 text-emerald-300'}`}
          title={`${cov.executable} executable line(s) added by this change · gate ${cov.mode || 'advisory'}`}
        >
          {pct(cov.pct)} of new lines tested{cov.mode === 'advisory' && cov.pass === false ? ' (advisory)' : ''}
        </span>
      ) : (
        <span className="pill bg-ink-800 text-slate-500" title={cov.reason || 'coverage was not measured on this run'}>
          coverage not measured
        </span>
      ))}
      {beh && (
        <span
          className={`pill ${beh.veto ? 'bg-rose-500/15 text-rose-300' : beh.checked ? 'bg-emerald-500/15 text-emerald-300' : 'bg-ink-800 text-slate-500'}`}
          title={beh.summary || ''}
        >
          {beh.veto ? 'behaviour changed' : beh.checked ? 'behaviour preserved' : 'behaviour not checked'}
        </span>
      )}
    </>
  );
}

/**
 * The full form: what was measured, and where it was worst.
 *
 * `detail` is the `gateDetail` from a run's own fetch; `gates` is the summary that rides on every
 * row. Given only the summary it still renders — it simply has no per-file breakdown to show.
 */
export function GateRecord({ gates, detail }) {
  const cov = detail?.coverage || gates?.coverage;
  const beh = detail?.behaviour || gates?.behaviour;
  if (!cov && !beh) return null;

  return (
    <div className="space-y-2.5 border-b border-ink-800 px-4 py-3">
      <h3 className="text-[10px] font-semibold uppercase tracking-wide text-slate-500">Judging gates</h3>

      {cov && (
        <div className="rounded border border-ink-800 bg-ink-950/40 p-2.5">
          <div className="mb-1.5 flex items-center gap-2">
            <span className="text-[11px] font-semibold text-slate-200">Coverage of the lines this change added</span>
            {cov.mode && (
              <span
                className={`pill ${cov.mode === 'enforce' ? 'bg-sky-500/15 text-sky-300' : 'bg-ink-800 text-slate-500'}`}
                title={cov.mode === 'enforce' ? 'a change under the floor is rolled back' : 'measured and recorded, but never blocking'}
              >
                {cov.mode}
              </span>
            )}
          </div>

          {!cov.applicable ? (
            // The reason matters more than the absence. "No coverage tooling in this repo" and
            // "this change added no executable lines" are different situations with different fixes.
            <div className="space-y-1">
              <Row label="Not measured">{cov.reason || 'no reason recorded'}</Row>
              {/* Which directories were considered, and what became of each. Without this, "no
                  coverage was produced" and "nothing was even looked at" read identically. */}
              {cov.triedDirs?.length > 0 && (
                <Row label="Looked in">
                  <ul className="space-y-0.5">
                    {cov.triedDirs.map((d) => (
                      <li key={d.dir}><span className="font-mono text-slate-400">{d.dir}</span> — {d.outcome}</li>
                    ))}
                  </ul>
                </Row>
              )}
              {cov.runners?.filter((r) => r.error).map((r) => (
                <Row key={`${r.id}-${r.dir}`} label={`${r.id} in ${r.dir}`}>
                  <div>exit {r.exitCode} · {r.error}</div>
                  {/* Runner output is raw test-suite noise and can run to hundreds of lines. It
                      scrolls inside its own box so it cannot push the rest of the run off-screen —
                      which is exactly what it was doing before the detail column became scrollable. */}
                  {r.output && (
                    <pre className="mt-1 max-h-32 overflow-auto whitespace-pre-wrap break-all rounded border border-ink-800 bg-ink-950/60 p-1.5 text-[10px] leading-relaxed text-slate-500">{r.output}</pre>
                  )}
                </Row>
              ))}
              {cov.blockers?.map((b) => (
                <Row key={b.dir} label="Unblock it">
                  <code className="font-mono text-slate-300">{b.install}</code> <span className="text-slate-500">in {b.dir}</span>
                </Row>
              ))}
            </div>
          ) : (
            <div className="space-y-1">
              <Row label="Exercised">
                <span className={cov.pass === false ? (cov.mode === 'enforce' ? 'text-rose-300' : 'text-amber-300') : 'text-emerald-300'}>
                  {pct(cov.pct)}
                </span>
                {' '}of {cov.executable} executable line(s) added
                {cov.floor != null && <span className="text-slate-500"> · floor {cov.floor}%</span>}
              </Row>
              {cov.verdict?.reason && cov.pass === false && (
                <Row label="Verdict">
                  {cov.verdict.reason}
                  {cov.mode !== 'enforce' && <span className="text-slate-500"> — advisory, the change was not blocked</span>}
                </Row>
              )}
              {cov.suiteGreen === false && (
                <Row label="Caveat">the suite was red, so this is a floor rather than a measurement</Row>
              )}
              {cov.unmeasuredFiles?.length > 0 && (
                <Row label="Not loaded">{cov.unmeasuredFiles.join(', ')}</Row>
              )}
              {cov.files?.length > 0 && (
                <ul className="mt-1.5 space-y-0.5">
                  {cov.files.map((f) => (
                    <li key={f.file} className="flex items-baseline gap-2 text-[11px]">
                      <span className={`w-10 shrink-0 text-right font-mono ${f.pct < (cov.floor ?? 50) ? 'text-amber-400' : 'text-slate-400'}`}>{pct(f.pct)}</span>
                      <span className="min-w-0 flex-1 truncate font-mono text-slate-400" title={f.file}>{f.file}</span>
                      {f.missedTotal > 0 && (
                        <span className="shrink-0 font-mono text-[10px] text-slate-600" title={`lines never executed: ${f.missedLines?.join(', ')}${f.missedTotal > (f.missedLines?.length || 0) ? ' …' : ''}`}>
                          {f.missedTotal} missed
                        </span>
                      )}
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}
        </div>
      )}

      {beh && (
        <div className="rounded border border-ink-800 bg-ink-950/40 p-2.5">
          <div className="mb-1.5 text-[11px] font-semibold text-slate-200">Behaviour preservation</div>
          {!beh.checked ? (
            <Row label="Not checked">{beh.summary || 'the gate did not run on this change'}</Row>
          ) : (
            <div className="space-y-1">
              <Row label="Result">
                <span className={beh.veto ? 'text-rose-300' : 'text-emerald-300'}>{beh.summary}</span>
              </Row>
              {beh.violations?.length > 0 && (
                <Row label="Violations">
                  <ul className="space-y-0.5">
                    {beh.violations.map((v, i) => <li key={i} className="text-rose-300/90">{v}</li>)}
                  </ul>
                </Row>
              )}
              {/* fail → pass is a behaviour change too. It is reported, never vetoed, and hiding it
                  would lose the "this refactor also fixed 3 tests" finding the gate exists to surface. */}
              {beh.notes?.length > 0 && (
                <Row label="Notes">
                  <ul className="space-y-0.5">
                    {beh.notes.map((n, i) => <li key={i} className="text-slate-400">{n}</li>)}
                  </ul>
                </Row>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
