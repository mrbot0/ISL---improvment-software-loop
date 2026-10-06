# ISL_IMPROVE — The road to being genuinely useful to everyone

> Companion to [ISL.md](ISL.md). ISL.md describes what ISL **is** today. This document
> describes what ISL must **become** to move from "a working local autonomous
> code-improvement loop" to "software that reliably makes the world's software better —
> safely, for anyone, at any scale."

The bar is deliberately high: *useful to all of humanity* means **trustworthy** (people can
rely on its changes), **universal** (it works on any codebase, in any language, for any team
size and budget), **safe** (it cannot be turned to harm), and **accessible** (a solo
maintainer of a critical open-source library benefits as much as a large company).

---

## Before proposing anything — the current structure (2026-08-08)

*An item planned against a description that no longer matches the code is how an "improvement"
becomes a regression. Four landed changes have already broken the target application, and every one
of them was a plausible-sounding task written without checking what was actually there.*

**Check these before writing a proposal.**

| If you are about to propose… | It already exists here | Propose instead |
|---|---|---|
| a deterministic check on the diff | `iteration/` — `securityGate`, `safetyGate`, `deadCode`, `regression`, `changeBudget`, `behaviourGate`, `changedLineCoverage`, `intentGate`, `schemaGuard` | a **new rule inside** one of these, or a new file only if the question is genuinely different |
| "the reviewer should catch X" | review is an LLM grader at weight 0.2, with a floor at `kpi.review_floor` | a **deterministic rule that names X**. "The reviewer disliked it" is not enforceable; "this identifier was deleted and never re-added" is |
| changing gate weights to fix a bad landing | the weighted average is why four bad changes landed | a **veto**. A weight cannot stop anything on its own; that is the arithmetic that caused the failures |
| a database or schema convenience | `runtime/schemaAgent.js`, read-only by design | keep it read-only. Nothing in ISL may issue DDL, edit a `.prisma` file, or pass `-v` to compose |
| a new dashboard page | the nav is 30 entries, five of them tab shells (`components/TabbedView.jsx`) | a **tab** inside an existing page, unless it answers a genuinely new question |
| polling for fresh data | `useResource` + `liveKeys.js` event→key invalidation | reuse the key. **One cache key, one endpoint** — violating it has crashed a page twice |
| storing an event | `bus.js` `DURABLE` decides what survives a restart | add the type to `DURABLE` if the history matters; leave it out if it is a stream |

**Three properties that must survive any change.**

1. **Nothing about the target project is a boot-time constant.** Every project-specific value is a
   live binding reassigned by `setActiveProjectConfig()`, and the DB handle is swappable. A module
   that captures `REPO_ROOT` at import time silently works on the wrong repository.
2. **The database has no undo.** No DDL, no volume deletion, no schema writes. Diagnostics report;
   they never repair.
3. **A diagnostic must not be able to fail the run it observes.** Post-commit checks are wrapped and
   swallow their own errors.

**How to justify a proposal.** Every entry in the implementation log below leads with a measurement,
because in this project reasoning has repeatedly disagreed with the data — the backlog looked like
it was producing bad proposals and was actually starved; the Live flow looked under-populated and
was showing everything that existed; "the AI text generation is broken" turned out to be a dead
container in front of untouched code. Measure first, then propose.

---

## 0. Honest baseline — where ISL is today

ISL already does something real and rare: it runs an end-to-end, self-improving loop that
plans, writes, grades and commits code changes, learns which specialist ships what (Decision
Network), and remembers what works (Shared Memory). That is a genuine foundation.

But measured against the bar above, the honest gaps are large:

- **Reliability is model-bound.** On the default local 36B model, land-rates are low (whole
  areas landing ~10–15%), plans sometimes come back empty, and quality is uneven. The loop is
  only as good as the model driving it.
- **The graders are themselves LLMs.** Scores are advisory, not guarantees — a change can be
  scored 99 and still be wrong (we saw this with dead code before adding a deterministic gate).
  *Update 2026-08-08: partially addressed, and the shape of what remains is now clearer.* A stack of
  deterministic vetoes sits in front of the score — parse, dead code, security, safety, regression,
  broken tests, refactor duplication, change budget, boot, changed-line coverage, intent, schema
  migration — plus a **review floor**, because a weighted average let four mechanical checks outvote
  the one judgement call. What is still true: the graders' *scores* remain advisory, and a change
  that satisfies every deterministic rule can still be the wrong change. The direction of travel is
  to keep converting "the reviewer disliked it" into a rule that names what it disliked.
- **The pipeline is JS/Node-centric.** "50+ languages" is true for *cataloguing*, but the
  test/boot/verify phases assume Node + Vitest. A Python, Go, Rust or ABAP change is not really
  verified.
- **It's single-node and single-user by design.** In-process, SQLite, one Ollama, one operator.
- **It doesn't touch real workflows.** It commits to a local branch; it does not open PRs,
  respond to review, or integrate with CI/issue trackers.
- **No objective proof it improves things.** "Committed" is not the same as "made the software
  better." There is no benchmark, no measured defect-reduction, no before/after evidence.

None of these are criticisms of the idea — they are the map of the work. The rest of this
document is that map, organised into ten pillars, each with *why it matters*, *concrete
improvements*, and a rough *priority*.

---

## THE ARCHITECTURE GAP — the most important finding (2026-07-17 evidence review)

A hard look at what ISL has actually *landed* on the target application's work branch (32 agent
commits, isolated from the branch's pre-existing diff):

- **~70% of the agents' output is TEST code** (+4,047 test lines vs +1,781 source lines).
- **Source changes are small and scattered** — ~1,781 lines across 45 files, del/ins ≈ 0.27 —
  i.e. local hardening (error handling, timeouts, logging, a few payment-provider endpoints), not
  structural change.
- **Refactoring is where the agents FAIL hardest** — the Decision Network's land-rates are
  ~100% for `resilience/services` but **0% for `refactor/frontend`** and **11% for
  `frontend/frontend`**.
- Commit rate ~28% historically (much of the rest was the empty/interrupted-run bugs since
  fixed, plus churn from modifying ISL itself).

**Verdict:** today ISL is a competent **test-writer + defensive-hardening bot on individual
files** — a real but narrow benefit. It does **NOT** improve the target application's
*architecture or structure*, and the frontend is no different (huge components stay huge,
duplication stays). Structure needs architectural judgement a small local model doesn't have, and an
autonomous loop is good at *adding* (tests, guards), not *restructuring*.

Closing this gap is the single highest-leverage thing ISL can do next. It rests on three pillars,
each with concrete, buildable work:

### A. Human-directed architectural goals (build on goal-setting)
*The human supplies the judgement; ISL supplies the execution and the safety net.*
- **P0 — Structured refactor goals ("recipes"), not free text.** Extend goal-setting from a
  sentence to a typed intent the fleet can execute precisely: `extract-service`,
  `unify-duplicate-clients`, `split-god-file`, `dedupe`, `extract-component`, `hoist-state`,
  `adopt-design-token`. Each recipe carries its own required inputs (source symbol(s), target
  module/name) and its own acceptance criteria.
- **P0 — A refactor plan step.** For a recipe, the planner emits a multi-file plan: create the
  new unit, move the code, **rewire every call-site**, delete the original — as one atomic task,
  not a per-file nibble.
- **P1 — Human approval gate for architectural change.** Anything that moves a public boundary is
  proposed, not auto-committed (graded autonomy, §1).

### B. A much stronger model on the phases that decide quality
*The provider abstraction (§2, shipped) is the enabler; now use it where it matters.*
- **P0 — Configure a frontier/strong model for `implement` + `review`** via
  `ISL_MODEL_IMPLEMENT` / `ISL_MODEL_REVIEW` (+ `ISL_LLM_PROVIDER`). A 36B local model can harden
  a file; it cannot reason about module boundaries. Restructuring is model-bound.
- **P0 — Multi-candidate + self-consistency for hard/structural tasks.** Sample N implementations,
  keep the one that best survives the gates (tests unchanged + no dead code + behaviour preserved).
- **P1 — Whole-codebase retrieval** (symbol graph / embeddings) so a structural change is grounded
  in the real architecture, not a keyword grep.

### C. Refactoring as a first-class, CONSTRAINED task with BEHAVIOURAL verification
*Stop asking for "improve the structure"; ask for a specific transformation and prove it's safe.*
- **P0 — Behaviour-preservation gate. ✅ (2026-07-31)** *Shipped: `src/iteration/behaviourGate.js`,
  applied in the engine's finalize phase to refactor-intent runs only.* The full suite now runs at
  the BASE commit and again against the change, and the two are compared suite by suite. "The tests
  pass" could never catch this, because it never asks what the tests did before.
  *The verdicts are deliberately asymmetric:* `pass → fail` **vetoes** — that is the whole point;
  `fail → pass` is **reported, never vetoed** (refusing an accidental fix would be perverse, and a
  human reading "this refactor also fixed 3 tests" learns something a veto would have hidden); and
  **fewer tests ran** vetoes too, because a suite that stays green while quietly collecting less is
  how coverage disappears with nothing going red.
  Counts are parsed polyglot-ly (vitest, jest, pytest, `node --test`, go, cargo) and `parseCounts`
  returns **null**, not zeros, when a runner cannot be read — the comparison then falls back to exit
  codes and says so, because a confident "0 tests, unchanged" from output we could not parse would
  be the gate lying about having checked. Likewise a gate that could compare nothing reports
  `checked: false` rather than passing. It fails **open** on a worktree error: this exists to catch a
  regression, not to block work it has no evidence against.
  The engine's inline refactor-intent test was **replaced** by the shared `isRefactorIntent` — two
  copies would let an agent dodge the "must delete something" rule by phrasing around the "must not
  change behaviour" one. The new veto has its own failure signature, remedy and agent-scoped lesson.
  *Found while building:* Node's built-in test runner was invisible to ISL. Every JS detector looks
  inside `node_modules`, so a project using `node --test` — increasingly common precisely because it
  needs no dependency — reported "no test suite detected" and the grader scored it **100 for running
  nothing at all**. A narrow detector (the package.json `test` script must literally invoke
  `node --test`) now catches it, placed last so an installed runner still wins.
  *Verified by 23 checks against a real repository with a real executed suite: a genuine refactor
  passes, an off-by-one introduced by a "cleanup" is vetoed, deleting tests to stay green is vetoed,
  an accidental fix is reported not blocked, and an uncomparable run never reads as a pass.*
- **P0 — Wire-in / replacement gate (extend the dead-code veto). ✅ (2026-07-17)** A refactor must
  show **deletions** and its new symbol must be referenced by **≥ N real call-sites** — otherwise
  it's the "added an abstraction, left the duplication" failure we already saw (#54) and it's vetoed.
  *Shipped: engine finalize now vetoes a refactor-intent iteration (agent=refactor or title matches
  refactor/split/extract/dedupe/…) with `additions ≥ 30 && deletions === 0` — the unambiguous
  duplicating-refactor signature. Verified: intent detection correct on 5 cases. Joins the existing
  dead-code veto. Next: require ≥ N wired call-sites for the new unit.*
- **P1 — Characterization tests first.** Before restructuring untested code, the fleet writes
  tests that pin the *current* behaviour, then refactors under them — turning today's test-writing
  strength into the safety net for structural work.
- **P1 — A STRUCTURAL backlog source. ✅ (2026-07-17)** Feed the backlog from real structural
  signals — duplicate code clusters, god-files (size/complexity), high cross-module coupling — as
  *refactor recipes*, instead of only per-function hotspots. This is what actually improves
  architecture. *Shipped: `src/iteration/structuralScan.js` finds god-files (≥500 lines) and
  over-complex files and emits `extract-component`/`split-god-file`/`reduce-complexity` recipes with
  acceptance criteria; `GET /api/structural` + `POST /api/structural/seed`. Verified on the target
  application: the worst offenders it found were a 3,355-line admin console component, an
  1,886-line page component and a 1,730-line admin route module, seeded to the backlog.
  Next: duplicate-cluster detection + cross-module coupling.*

### For the FRONTEND specifically
- **P0 — Component-graph awareness.** Detect the huge/duplicated components (e.g. the admin console
  component at ~3.5k lines) and target them with `extract-component` / `hoist-state` recipes under
  the same behavioural + wire-in gates.
- **P1 — Design-system adoption as a recipe.** `adopt-design-token` / `use-shared-component`
  replaces ad-hoc styles and hand-rolled patterns with the kit (see ISL_Frontend_improvment.MD),
  a genuine structural improvement the agents *can* do safely because it's constrained.

**Bottom line:** ISL will only produce real architectural and frontend-structural improvement when
a human names the transformation (A), a strong model executes it (B), and it's verified as a
behaviour-preserving, fully-wired change (C). Everything else stays additive.

---

## Implementation log (live)

### The four changes that broke the target app, and the gates that now stop them ✅ (2026-08-08)

*Triggered by an operator report — "ISL broke the target app's search bar" — which turned out to be
four separate landed changes, not one.*

**What was actually broken.** Traced from the symptom back to the run that produced it:

| Run | Review | Total | Damage |
|---|---|---|---|
| #91 | **35** | 63 | a scalar field added to a Prisma model with no migration → every read of the account model from the service that owns the catalogue failed; a whole class of users vanished from the app |
| #244 | **0** | 79 | `log?.info?(` (a missing `.`) and `Promise<void>` — TypeScript syntax in a `.js` file → the container of the service that owns the catalogue crash-looped |
| #245 | **0** | 80 | an `export { … }` block repeating all eleven symbols already exported inline → `Duplicate export`, the container of the service that handles payments crash-looped |
| #426 | **55** | 90 | the search route's personalisation deleted → the search bar |

Two of the reported faults were not faults at all. The AI text generation and the API fallbacks were
never touched by ISL — the text-generation client and its agent module are untouched and
syntactically clean. They *appeared* broken because the catalogue service's container was dead.
Checking that before writing a fix saved changing working code.

**The single common cause.** In all four the reviewer objected — 0, 0, 35, 55 — and in all four it
was overruled by arithmetic. Review weighs 0.2 and is the only grader that compares the change to
what was *asked for*; the other four measure mechanical properties of the result. A review of 0
beside four near-perfect mechanical scores totals 79, against a rollback threshold of 60.

The distribution made the fix obvious rather than arbitrary. Across 115 commits the review scores
form two clusters — `0·35·38·50·55` and `75·85·92·95·100` — **with nothing in between**. A floor at
70 sits in that gap: it stops the 31 commits the reviewer had objected to (27% of all commits) and
passes the 84 it approved.

**What was built.**

- `src/iteration/intentGate.js` — **intent preservation** and the **review floor**. A task whose
  title commits to adding or fixing `X`, producing a diff where `X` is deleted and never re-added,
  is rolled back. Scoped to the files the task declared, so a cleanup task in one file is not
  charged to an additive task in another.
- `src/iteration/schemaGuard.js` — a scalar Prisma field added with no migration in the same change.
  Relations are excluded; a re-indented model is not read as a set of new fields.
- `src/runtime/schemaAgent.js` — the state check, complementing the diff check: every model against
  the live database's `information_schema`, after each commit and on demand. Read-only.
- `kpi.review_floor` (default 70), tunable from the KPI page.

**Verified against the real diffs, not constructed ones.** Replaying the four runs from the
iteration database: #91 → SCHEMA + REVIEW; #244 → REVIEW; #245 → REVIEW; #426 → INTENT + REVIEW.

**Three defects found in my own gates while verifying them, each from real data rather than
reasoning.**

1. The intent gate classified intent from the title **and the rationale**, which looked more
   thorough and was the hole #426 went through. Its title said "Resolve TODO … regarding a
   user-preferences key"; its rationale said the TODO was *"unclear if it's dead code or a missing
   feature"* and that
   *"removing/clearing this ensures the search route is clean"*. Reading both, the gate saw a
   subtractive word and stood down. A model writing its own justification will always supply one, so
   intent is now judged from the title alone.
2. The schema guard read a **re-indented** model as eleven new fields. Adding one long field name
   realigns the whole Prisma block, so every line arrives as `-old` / `+new`. On #91's real diff it
   named three pre-existing fields alongside the one genuinely added.
3. A task declaring files that appear nowhere in the diff produced no change at all, and was
   therefore being checked against the whole diff — charging it with its neighbours' deletions.

**The planner defect underneath all of it.** #426's rationale is the important artefact: the planner
did not know whether the code was dead or unfinished, and authorised its removal anyway. Three
prohibitions were added to the planner prompt: never propose deleting code you do not understand
(uncertainty forbids removal, it does not licence it); a removal must be the title's own verb; and a
schema field requires its migration in the same task.

---

### The planner stopped re-proposing work that had just failed ✅ (2026-08-08)

**The arithmetic.** Candidates were ordered `weight DESC, failures ASC`. That makes failure a
*tie-break* — it separates two candidates of identical weight and nothing else — and weight is a
wide continuous score, so in practice it separated nothing. `bumpFunctionFailure` sets a failed
target back to `pending`, which returned it to the top of the very next batch, unchanged.

**Measured.** One function in the admin console component, weight 238, was planned in runs #437,
#438, #439 and #440 under near-identical titles, failing every time. Across every catalogued
function only 23 carried a single recorded failure: the signal existed and did nothing.

**What was built.** Failures now *divide* the weight quadratically — one failure halves a candidate,
two leaves a fifth, three a tenth — plus a cooldown that skips a target which failed within the last
three runs. Nothing is banned; a heavy target still outranks a trivial one, but it can no longer
monopolise the batch by being heavy.

**Before and after, on the live database:**

```
BEFORE  candidate A (4 failures, run 439) · candidate B (438) · candidate C (439)
AFTER   three other candidates                      ← all untried
```

The top three candidates were exactly the three that had just failed, and candidate C lives in the
search component — the loop was hammering the search bar too.

---

### The backlog was starving, not degrading ✅ (2026-08-08)

*The operator's read — "too many rollbacks, so the proposals must be bad" — was right about the
effect and wrong about the mechanism, which changes the cure.*

**What the data said.** Of 250 runs: **107 "no edits"**, 59 landed, 44 interrupted, 39 rolled back.
The dominant failure was not changes being rejected — it was the implementer producing nothing.

**Why.** A run reserves what it is about to work on (`in_progress` / `improving`); finishing releases
it, being interrupted does not, and interruption is how 134 of 435 runs ended. `pickFeatures` selects
only `pending`. So every interrupted run permanently removed its targets from consideration. On the
live database **67 of 160 features and 149 functions** were reserved by runs that had ended long ago,
leaving the planner **two features** to choose between. It did not start proposing nonsense; it ran
out of anything to propose and fell back to micro-edits on what was left.

Nothing surfaced this. The counts read "in progress", which looks like work underway.

**What was built.** `backlogClaims()` / `releaseStuckClaims()`, `GET /api/backlog/claims`,
`POST /api/backlog/reclaim`, and a strip on the Backlog page that states the situation in words. The
release refuses while a run is in progress — those reservations are real. `POST /api/backlog/reset`
now releases before deleting: it previously removed only `pending` rows, which on a starved backlog
meant deleting 2 items out of 160 and reporting success.

---

### A run's history now survives the tab that watched it ✅ (2026-08-08)

**The finding.** `bus.js` decides which event types reach the database, and the list had never moved
past the agent era — `agent.*`, `proposal.*`, `orchestrator.*`, and not one event from the iteration
pipeline. No `iteration.*`, no `impl.*`, no `survey.*`. A run's entire history existed only as a
WebSocket broadcast to whoever happened to be watching; closing the tab, reloading, or opening the
dashboard after the run finished left nothing.

Measured: **400 stored events across three types, 384 of them tool calls, and no trace of 435 runs.**

Worse, the Flow view's event map did not include `agent.tool_call` — so it discarded 96% of what
*was* stored. A freshly loaded page showed three lines.

**What was built.** The pipeline events are now durable (`impl.tool` included deliberately: it is
the only record of the longest phase of a run, the UI folds consecutive ones, and `trimEvents` caps
the table at 20k rows). The Flow view reads `/api/events` and merges the socket on top, deduplicating
by id where the event is durable — `emit` puts the row id on the broadcast — and by a composite key
where it is not.

**Result:** 3 lines → 155, after a reload, which is the condition that previously emptied it.

---

### The coverage gate now judges the change, not the repo ✅ (2026-08-06)

*§1 P0. The last item in the backlog that was unblocked and unbuilt.*

**The problem with the number we already had.** A repo-wide coverage percentage cannot see a change.
Twenty new lines that no test touches, added to a module sitting at 92%, move it to 91.8% — less
than the noise between two runs. The one part of the codebase that just became risky is the one part
the metric says nothing about.

**What was built.**

- `src/iteration/changedLines.js` — a unified-diff parser producing, per file, the line numbers **in
  the new file** that the change added. Only additions: a deleted line has no line to cover, and
  charging an author for context lines is charging them for inherited debt.
- Per-line readers in `coverageRun.js` — the existing parsers collapsed LCOV's `DA:` records into a
  total the moment they read them. `parseLcovLines` / `parseGoProfileLines` keep the resolution.
  vitest and jest now also emit `lcov` alongside `json-summary`, because a summary has no per-line
  data at all.
- `src/iteration/changedLineCoverage.js` — runs the project's own coverage tooling **against the
  sandbox with the change applied** and intersects the report with the changed lines.
- Wired into `engine.js` as the **last** gate: it is the most expensive check in the pipeline, so it
  only runs on a change that already survived review, security, regression, dead-code and tests.
- `GET`/`POST /api/coverage-gate` for mode (`off`/`advisory`/`enforce`) and floor.

**Two findings that changed the design, both from measurement rather than reasoning.**

1. **Non-code lines have to be filtered from the source, not trusted to the report.** Against
   vitest's v8 provider, a *comment* line inside a covered function is reported as a covered line —
   v8 attributes it to the enclosing executed range. Blank and comment-only added lines are now
   dropped before the report is consulted.
2. **"Did any line run?" does not work, and shipping it would have been a false green.** A
   brand-new exported function that no test ever calls reports `covered: 1 of 4`, because its
   `export function …` declaration executes on import. A `covered === 0` rule passes the exact
   change it exists to stop. The gate is therefore a **threshold** (default 50%: most of what this
   change added is never executed), and `test/coverageVerdict.test.js` pins that case by name.

**It ships advisory.** This is the first gate whose verdict depends on a project's own test
discipline rather than on something ISL can verify unilaterally, and it costs a full instrumented
suite run. Turning it straight to blocking on an unknown repo would stall a loop the operator
depends on, and they would switch it off permanently. Advisory records the number on every run — on
the commit's Provenance line — so the decision to enforce is made against this repo's real
distribution instead of a guess.

**Verified.** The diff parser was cross-checked against `git diff --numstat` over four ranges of
real history — **151 files, zero mismatches**. The gate was then run end-to-end against a purpose-built
repo with real vitest and a ground truth chosen in advance: a partially-tested change measured
50% of 4 executable lines (predicted 50% of 4); a wholly untested new function **failed**; a fully
exercised new function **passed at 100%**.

**ISL gained its first backend test suite in the process** — 22 tests under `test/`, run with
`node --test` (no new dependency). Shipping a gate that judges other projects' test discipline
without testing it would have been indefensible.

### Promotion now knows which commits are risky ✅ (2026-08-07)

*A merge conflict was the only thing that could stop a promotion.*

Everything ISL already knew about a commit — the score it landed with, whether a suite was red at
the time, whether a single test exercises the lines it added — sat in the run record and reached no
part of the decision. Twenty commits were promoted on the strength of having been committed at all.

**The contiguity constraint is the shape of the whole problem.** A promotion is a fast-forward, so
what lands is a **prefix**: a risky commit in the middle cannot be skipped, and an operator who
believes they excluded it has promoted it. `assessPromotion()` therefore computes the longest safe
prefix and says so in words. The prefix walk runs **oldest-first** against a list `git log` prints
newest-first — the single easiest thing here to get backwards, and a test pins it by name.

**Thresholds came from the repo's own distribution, not from round numbers.** The first version
blocked anything under 100 on every signal. Measured against the 102 committed runs:

| signal | median | <100 | <90 | <70 |
|---|---|---|---|---|
| security | **95** | 59 | **3** | 2 |
| test | 100 | 23 | 23 | **23** |
| workbench | 100 | **0** | 0 | 0 |

A five-point security deduction is the *normal passing value*, so `<100` marked **58% of the
history dangerous** — which teaches an operator to click past the warning. These also must not
re-litigate the engine's own gates: every one of these commits cleared the security veto and the
score threshold when it landed. Cut at `security < 90`, `test < 70`, `workbench < 90`, the risk
codes across 200 real commits fell to 3 security findings, 27 red-test commits and 26 conflicts.

Thin coverage is reported and **does not block** — a real risk, but not a defect, and blocking on it
would stop everything.

**Auto-fix, where it is honest.** `POST /api/deploy/autofix` boots a blocking commit in a throwaway
worktree and runs the repair loop against it, producing a diff. It refuses when the blocker is not
ISL's to fix — a conflict with the operator's own uncommitted edits is not repairable without
deciding which version of their work to discard, and the UI says that instead of offering a button
that cannot work.

*11 tests, including the prefix-order rule and "an ordinary security deduction is NOT a risk".*

### Repair, and getting a model without leaving the product ✅ (2026-08-07)

- **Repair page** — the workbench answers "does this CHANGE still boot?" as a gate inside a run.
  Nothing answered the question an operator actually has: *is the app broken right now, what
  exactly, and can you fix it?* `src/repair/repair.js` diagnoses **reality** (HEAD with the working
  tree overlaid, because a report about a codebase nobody has is worse than none) and repairs in a
  detached worktree, producing a diff. **It never writes to the checkout.** "All checks pass" is
  reported as a result, not a failure — a repair tool that always finds something to change is one
  that damages working software.
- **Models page** — choosing among installed models already existed; *obtaining* one meant leaving
  for a terminal. `pullModel()` streams real byte progress (a multi-gigabyte pull behind a spinner
  is indistinguishable from a hang), and `adoptModel()` **tests the model with a real completion
  before assigning it to any role**. "Applied automatically" must not mean "assigned on the strength
  of its name": the failure mode is every agent failing at once on the next run, reported as
  `fetch failed`, with nothing on screen connecting that to the swap.

### A crashed server stopped the loop for fifteen minutes ✅ (2026-08-07)

*Reported as "iterations don't start any more". They didn't.*

One loop drives one work branch, so `tick()` takes a leadership lease before planning — correct, and
not to be loosened: two loops on one branch produce interleaved commits nobody can untangle. But the
lease was released **only on a clean shutdown**. A crash or a hard kill skipped the handback, and the
successor then stood by for the full `LEADER_TTL_MS` of **15 minutes**, logging
`another process holds the loop (…) — standing by` while naming a pid that no longer existed.

Diagnosed from the row itself, not from the symptom:

```
holder      DESKTOP-B6P48EK:31100:a6ef11   ← process verified dead
lease_until 01:46:56                        ← 5.6 minutes still to run
last run    #393, 01:31:57
```

The supervisor log already showed a genuine crash earlier the same evening
(`server (gen 2) exited code=4294967295`), so this was costing real time, not only when someone
restarted deliberately.

**The fix**: a lease whose holder is a **dead process on this host** is reclaimed at once, instead of
waiting out the TTL. The safety argument is that the two ways to be wrong are not symmetric —
`process.kill(pid, 0)` on a recycled pid reports *alive*, so the successor waits exactly as it does
today (slow, correct); there is no path from "the process is running" to "dead". A holder on another
host is never judged, because no machine can ask another about its processes.

**Verified on the running system, not only in tests.** Hard-killed the server; the new process
reclaimed the lease from the dead pid and iteration **#394 started 8 seconds later**, against the
11+ minutes of dead time the previous restart had cost. *10 tests, including the two that must never
regress: a live holder keeps the role, and a holder on another host is never reclaimed.*

**Separately, and not the cause**: `fetch failed` on every implementer task while Ollama was down —
109 runs since 2026-07-17 carry that signature, so it long predates this. The runs were starting and
ending `empty` in 37 seconds. That is the model server being absent, not the loop being stuck.

### The parse gate could not see TypeScript, TSX or JSX ✅ (2026-08-07)

*Went looking for the missing `tsc --noEmit` type check and found something worse underneath it.*

`node --check` accepts `.js`, `.mjs` and `.cjs`. Nothing in `CHECKERS` matched `.ts`, `.tsx` or
`.jsx` — so for those extensions the loop hit `if (!checker) continue` and moved on. Not a missing
*type* check: **no syntax check at all**, on what is the largest category of file in any React or
TypeScript codebase, including ISL's own dashboard and the repo it is pointed at.

Measured before writing anything, against three deliberately broken files:

| file | before |
|---|---|
| `broken.js` | caught ✓ |
| `Broken.jsx` — unclosed element | **passed silently** |
| `broken.ts` — unparseable | **passed silently** |

`src/iteration/checkers/tsSyntax.mjs` parses with **whatever the target repo already has** — its own
`typescript`, or the `esbuild` that ships inside Vite — resolved from the file's own directory
upward. Not a copy pinned inside ISL: a parser on a different version from the project's own will
eventually disagree with the project's build about what is valid, and a gate that rejects code the
build accepts is worse than one that is occasionally absent. With neither available it exits 3 and
the caller records the language as **skipped**, never as a pass.

**A bug this found in itself, which end-to-end testing caught and unit testing did not.** The helper's
path was derived from `new URL(import.meta.url).pathname`, which is percent-encoded. On a checkout
whose folder contains a space — such as this project's own `ISL improvment software loop` — every
`.ts`/`.tsx`/`.jsx` file failed the gate with `cannot find module`. A verification tool rejecting
valid code because of where it is installed is the one failure mode it must never have. Invoked by
hand the checker was flawless; only running it through `parseCheckAll` exposed it. Now
`fileURLToPath`.

**One branch is unverified and is written to be wrong safely.** No repository on this machine has
TypeScript installed, so only the esbuild path was exercised. The TypeScript branch is therefore
wrapped and falls **through** to esbuild on any failure rather than reporting one: if a diagnostic's
shape differs from what it expects, the cost is that the file is parsed by esbuild instead of by
`tsc`. If it threw, the cost would be a valid change vetoed with a stack trace.

*7 tests, which assert the right thing in both environments: where a parser exists, broken files are
caught and valid ones are not; where none exists, the language is reported skipped rather than clean.*

### Both judging gates now leave a record ✅ (2026-08-07)

*Found while wiring the coverage gate above.*

The behaviour gate computed its verdict, assigned it to `behaviourResult`, and dropped it. The
declaration carried the comment *"recorded on the iteration"*; nothing ever wrote it, and nothing
ever read it. It had been that way long enough for the claim to read as fact.

The cost is not theoretical. These are the two gates that produce a **judgement** rather than a
score, so nothing else in the schema carries their finding — and the run that most needs the record
is the vetoed one, where the verdict lives for exactly as long as it takes the next line to `throw`.
"Was this change's coverage thin, or did the gate simply not run here?" had no answer at all: both
look identical when the field is absent.

- `behaviour_json` and `coverage_json` on `iterations`, via the existing per-project `ensureColumns`
  migration — verified to apply on project switch, not only at boot.
- Both written **before** their veto can throw.
- `rowToIter` exposes a one-line summary on every row (what a Runs row needs) and the full
  breakdown only on the detail fetch — the same split `plan_json` already uses, and for the same
  measured reason: tens of KB per `/api/state` refetch that nobody reads.
- The stored record is bounded by construction: ten worst files, twenty missed lines each, and a
  `missedTotal` beside them so a truncated list never reads as the whole of it. Runner stdout, which
  can be megabytes, is dropped. A real thin-coverage record measures **832 bytes**.
- `behaviourResult` itself is gone. Persisting happens where the gate runs, so the variable had no
  reader left — and leaving a dead one in place is what created this bug the first time.

*Six tests pin it, including the one that matters: a gate that never ran reads `null`, which is not
the same as a gate that ran and was satisfied.*

### The learning loop closes: a lesson is now measured, not just written ✅ (2026-07-31)
Writing a lesson is easy and feels like progress. Whether the fleet stops making the mistake is a
different question, and nothing asked it — a lesson was recorded, injected into every prompt forever,
and never checked.

*Shipped: `src/memory/lessonImpact.js`.* For each taught failure code it compares the recurrence rate
over the **30 runs before** the lesson was written with the **30 runs after**. Runs, not calendar
time: "everything before the lesson" stretches back through periods when the codebase, the model and
the gates were all different, so a lesson taught today would be measured against a project that no
longer exists.

**The verdict that matters is `not-landing`, and its honest reading is not "the agent is ignoring
us".** It is *"our diagnosis is wrong — this failure has a cause the agent cannot act on."* The live
data proves the point: the largest implementation failure in this project's history was `empty` (82
runs), and every lesson written about it was useless, because the real cause was `
` line endings
in `edit_file`. This measure, running from the start, would have pointed at the system instead of the
model months earlier. So the note it emits says exactly that — look for a tool refusing edits, an
environment difference, a guard that is too strict — *before* writing another lesson.

**The loop closes on the other side too.** The injected memory block is capped at twelve lines, so a
lesson whose failure has not recurred **steps aside** to make room for one still being ignored. That
is not forgetting: the memory stays, it is still on the Memory page, and the moment the failure
recurs the verdict flips and it comes straight back — asserted by a `relapse` scenario. The whole
thing is best-effort; an unreadable run history must never be the reason a prompt fails to build.
`GET /api/memory` now carries the verdicts, so the question "is any of this working?" has an answer.

*Verified by 18 checks, each scenario in its own process and its own database — sharing one let the
scenarios change each other's denominators, and the first version of the test reported "not-landing"
for a case that was exactly unchanged. That failure is what produced the bounded-window design.*

### Self-regulation: the fleet was learning things it could not act on ✅ (2026-07-31)
The learning loop was working mechanically — 266 memories, deduplicated, injected into every prompt.
Then we read what it had actually learned. The highest-ranked "lessons" an agent saw before every
task were:

```
"Recurring failure: implementation error — the implementer…"   ×77
"Iteration failure: Implementation error — the implementer…"   ×77   ← the same failure again
"Recurring error: ## empty — implementation error…"            ×77   ← and a third time
"Recurring failure: failed — cause not recognised"             ×20
"Recurring error: fetch failed"                                ×11
```

**None of those change what an agent does.** "cause not recognised" is a gap in our own classifier;
"fetch failed" is a network hiccup; and the first three are one failure written by three different
code paths. Two writers in `reliabilityManager` turned *every recorded error* into a "pitfall" by
restating its message.

Two compounding effects made it worse than noise:
- **The memory block is capped.** Twelve lines decide what the model reads, so every line spent on a
  dropped socket was a line not spent on something the agent could have done differently.
- **`recall` ranked by recurrence**, so the most *frequent* failure led — and the most frequent thing
  in any system is rarely the most instructive. An agent-scoped lesson about its own mistake lost to
  a generic global one that had simply happened more often.

*Shipped: `src/memory/lessons.js`*, holding one rule — **a memory earns a place in a prompt only if
it would change what the agent does next.** Infrastructure, interruptions, cancellations, a moved
base, and unclassified failures are recorded, clustered and shown on the Reliability page as before;
they are simply no longer *taught*. The curated catalogue moved here from `engine.js` (the original
was deleted, not copied) so the engine and the reliability manager teach the same lesson, and
`recall` now ranks pinned → scope-specific → recurrence → recency.

A one-time cleanup runs at boot: **27 restated-error entries removed, 239 real memories kept** — and
what remains is exactly the useful material, the `Shipped:` and `Rejected:` records of what worked
and what a human refused. Operator-pinned memories are never touched.

*Verified by 23 checks: every non-behavioural failure class teaches nothing, every curated lesson is
both present and **actionable** (asserted by requiring an imperative instruction, not a keyword — an
earlier version of that check failed a perfectly good lesson because it only looked for tool names),
agent-scoped lessons are addressed to the agent while global ones read as rules, the real veto
messages each reach their lesson end-to-end, and a lesson about your own work outranks a more
frequent general one.*

### Model-server resilience: a blink no longer costs an hour ✅ (2026-07-31)
`96 tasks` — the second-largest failure after the CRLF defect — died on `fetch failed`. The model
server was briefly unreachable while it reloaded a model or restarted, and `chat()` had **no retry
at all**: a hiccup measured in seconds threw away an agent's entire run.

*Shipped:* three retries with backoff (0.5s / 2s / 5s) around the request, on **transient failures
only**. The exclusions are the load-bearing part, and each has its own reason:
- an **abort** is the operator or the watchdog saying stop — retrying overrides a human;
- an **egress denial** is a policy refusal, and retrying a refusal until it succeeds is exactly how a
  boundary control becomes decorative;
- a **4xx** is our own bad request — an unknown model does not become known on the second attempt.
A 5xx *is* retried: "loading model" is the server's problem and passes next time. The backoff wait
honours the abort signal, so a cancelled run does not stay alive for seconds after the click.

*Verified by 12 checks against a real HTTP server that misbehaves on purpose, each in its own process
(`config.js` reads the host once at module evaluation, so a second scenario in the same process would
silently talk to the first one's port and prove nothing): recovery after two dropped connections, a
bounded failure when the server never returns, a 400 tried exactly once, a 503 retried exactly once,
and an abort that neither waits out the backoff nor keeps hammering.*

### Dashboard: the accessibility audit now covers the whole product ✅ (2026-07-31)
The three views that rendered nothing under the shared fixture — `Compliance`, `Health`,
`Reliability` — turned out to be fixture gaps, not broken pages. Each read a response shape the
fixture did not mirror: `reliabilityDb.errorClusters()` returns `agents` as a **list** split from a
`GROUP_CONCAT` and timestamps named `lastTs`/`firstTs`, `impact.top` rows carry a `reasons` array,
and the coverage endpoints were absent entirely.

With those aligned, **every view in the dashboard that can render standalone is now audited** — 30 of
them. Only `Admin`, `Governance`, `Projects` and `Settings` (gated on a live session) and
`Workbench`/`Flow` (event-stream driven) remain outside, and they are named in the test file with the
reason rather than quietly omitted. *138 dashboard tests pass.*

### Agent audit — the largest failure in the system was a line ending ✅ (2026-07-31)
Measured across every task ever run, by cause rather than by impression:

| cause | tasks |
|---|---|
| **the implementer finished without editing any file** | **103** |
| `fetch failed` (the model server dropped) | 96 |
| aborted / terminated | 28 |
| the planner targeted files that do not fit the repository | 16 |

The first one is not a reasoning failure. It is `

`.

**`edit_file` required a byte-exact match.** On Windows with `core.autocrlf=true` — git's default
there, and how this repository is checked out — every source file is **100% CRLF**. A language model
reading that file and quoting three lines back emits `
`, as models do. `src.split(old_string)`
found zero matches, the tool replied "copy the exact text", the model copied it again, produced
`
` again, and after three nudges the task ended having changed nothing. Reproduced exactly: the
identical edit fails with `
` and succeeds with `

`.

**On Linux and macOS the same code works perfectly**, which is precisely why it survived — a defect
you cannot see unless you run on the platform that has it. This is the concrete answer to *"ISL must
work on any PC"*.

*Fixed:* the match is line-ending-agnostic; the **write is not**. The replacement is applied to the
original text and only the new text's endings are converted to the file's own convention, so every
untouched byte stays as it was. Normalising the whole file would turn a three-line edit into a diff
claiming every line changed — tripping the change budget and reading as a rewrite in review.
`write_file` does the same, and a **new** file adopts the repository's convention (sniffed from
`.gitattributes` and real source files, never from `process.platform` — a Windows machine can hold an
LF repository).

**A second defect, in the path guard:** a new file whose parent directory did not exist was refused
outright. That killed the most ordinary task in any codebase — adding
`backend/server/middleware/__tests__/auth.test.js` next to the middleware it tests. Every `__tests__`
directory had to be created by someone, once. *Fixed:* one new directory is allowed when its
grandparent is real; two invented levels (`backend/server/src/routes/…` under a root whose real
layout is `backend/server/routes/`) is not a new directory but a wrong guess about the project's
shape, and stays refused.

*Verified by 21 checks on both platforms' conventions: the exact 103-failure scenario, an LF repo
left untouched, the uniqueness guarantee surviving the tolerance, regex metacharacters and `$` taken
literally, and the path guard accepting the ordinary new directory while still refusing the invented
layout.*

### Gate audit — three holes that let broken changes commit ✅ (2026-07-31)
Found by reading what the last twenty-five runs actually recorded, not by reasoning about the design.

- **A change that broke the test suite could commit.** There was no veto — a failing suite only
  lowered a weighted average, and `test` carries 0.15, so all-red tests with everything else
  near-perfect totals **83** against a threshold of 60. *Fixed: `test veto` in `finalize`.*
- **A file that does not compile could commit.** The review grader returns 0 with the parse errors
  attached, and 0 was all it did; review weighs 0.2, so a syntactically broken file totalled ~80.
  **Two runs landed one.** *Fixed: `parse veto`, which runs before every other judgement — nothing
  downstream can mean anything about source the language itself rejects.*
- **Pre-existing failures were scored against the change.** The grader already knew which failures
  it had not caused (it re-runs the suite at the base commit and says so in the summary) and then
  blamed the change anyway. Six of twenty-five runs committed with `test = 0` reading *"also fails
  at base; an earlier commit is the culprit"*. This is what made the first hole invisible: `test = 0`
  became normal, so a genuine break looked like every other run. *Fixed: the score is computed over
  attributable suites only; inherited failures are reported and bisected, never graded.*

**Two more defects surfaced while fixing those:**
- `build()` in `failure.js` **overwrote every signature's own remedy** with a generic "restart and
  fix it". Eight signatures carried specific, actionable remedies — "delete the code you replaced",
  "make the suite pass again", "move the guard, do not remove it" — and none of them ever reached
  the operator.
- A parse failure was recorded as **the first line of the checker's stderr**, which for `node --check`
  is the absolute file path. Three runs scored 0 on review with `…\hardening.js:270` as their entire
  explanation — indistinguishable from a score nobody computed, which is exactly how it was reported.
  *Fixed: `diagnosticFrom()` finds the line that carries the actual diagnosis and keeps the location
  beside it.*

*Verified by 22 checks: the attribution arithmetic on every mix of broken/inherited/passing suites,
the weighted-total maths proving a score could never have replaced these vetoes, a real syntax error
end-to-end through the parse checker, and each new signature's classification and remedy.*

*This log is appended every iteration as roadmap items are built; new improvements
discovered while building are added to the backlog below it. `✅` = shipped & verified.*

### Iteration 1 — Deterministic security gate (Pillar 1 & 6, P0) ✅
`src/iteration/securityGate.js` + wired into the `security` grader and a finalize **veto**.
Deterministically scans every diff and **vetoes** (rolls back, regardless of LLM score):
introduced **secrets** (private keys, AWS/Stripe/GitHub/Google/Slack keys, JWTs, hardcoded
credentials), **disabled TLS verification**, and **removed security controls** (auth /
authorization / ownership / csrf / rate-limit / bcrypt stripped). **Penalises** (without
veto): `eval`/`new Function`, `Math.random` for security material, shell-command
interpolation, weak hashes (md5/sha1), disabled security-lint. Skips test/fixture/doc files
to avoid false vetoes; records a global memory pitfall on veto. *Verified against 7 attack
patterns: correct veto/flag/pass on each.* — closes §1 "deterministic gates" (security
slice) and §6 "guardrails against harmful change" + "secrets hygiene".

### Iteration 2 — Polyglot verification adapters (Pillar 3, P0) ✅
`src/iteration/langRunners.js` — a language-runner registry; the reviewer's parse gate is now
**polyglot**: it syntax-checks every changed file in its own language (JS via `node --check`,
Python via `py_compile`, Ruby `ruby -c`, PHP `php -l`, Go `gofmt -e`) and **skips** languages
whose toolchain isn't installed instead of failing them. Also exposes `testCommandFor()`
mapping a project dir → the right test suite (vitest/pytest/go test/cargo). *Verified: a broken
Python file is now caught, not only a broken JS file; a clean file passes; absent toolchains
skip gracefully.* — closes §3 "per-language verification adapters (v1)".

### Iteration 3 — Polyglot test execution (Pillar 3, P0) ✅
The `test` grader is no longer Node-only: it derives candidate project dirs from the changed files
and runs whatever suite each has via `testCommandFor()` — **vitest / pytest / go test / cargo** —
skipping absent toolchains. *Verified: the target application's backend & frontend still resolve to
vitest; a polyglot repo would additionally run pytest/go test.* — closes the "run per-language TEST
suites" follow-up.

### Iteration 4 — Commit provenance (Pillar 1, P1) ✅
Every committed iteration's message now records **exactly what produced it**: the model, the
specialists that worked (`agent×N`), and the gates it passed (review / security + scan
findings / regression / tests / dead-code), plus an explicit "Generated autonomously by ISL"
line. Any landed change is now explainable and auditable from `git log` alone. — closes §1
"provenance & reproducibility (v1)".

### Iteration 5 — Safety gate: "do no harm" (Pillar 6, P1) ✅
`src/iteration/safetyGate.js` `scanSafety(diff)`, merged into the security phase's deterministic
gate. **Vetoes** irreversible/data-loss operations introduced in product code: `DROP TABLE/
DATABASE`, `TRUNCATE`, `DELETE FROM` with no `WHERE`, `deleteMany()`/`.drop()` with no filter,
`prisma migrate reset`/`--force`/`--accept-data-loss`, `rm -rf` and recursive `fs.rm`/`rmtree`
on non-temp paths. **Penalises** disabling logging/telemetry/monitoring/health-checks. Lenient
on migration/test/seed files and temp paths. *Verified on 8 cases: correct veto/flag/pass,
including passing a temp-dir delete and a DROP inside a migration.* Now the finalize security
veto covers **both** attacks (secrets/weakened controls) **and** accidental destruction. —
closes §6 "dedicated safety grader".

### Iteration 6 — Risk manager sees the gate (Pillar 6 / smarter managers) ✅
The engine now emits the security/safety findings on `iteration.finished`; the **Risk manager**
tracks them, surfaces "gate active — blocked N unsafe change(s)" in its brief, records each
blocked attack/destruction as a durable **insight** in shared memory, and broadcasts an alert.
The first line of defence is now visible and audited, not silent. — closes "surface findings +
feed the Risk manager".

### Iteration 7 — Goal-setting (Pillar 7, P0) ✅
A human can set a per-project **objective** the fleet plans toward. `GET|POST /api/goal` +
a "🎯 Objective" bar on the Backlog page. The planner injects the goal into its prompt AND
boosts backlog candidates that advance it (keyword/area match) to the top of the expected-value
ranking. Autonomy now amplifies human direction instead of only grinding the backlog. — closes
§7 "goal-setting".

### Iteration 8 — Entropy-based secret detection (Pillar 6, P1) ✅
Extends the security gate with a **Shannon-entropy** heuristic: a high-entropy, mixed-case+digit
string literal that matches no known vendor prefix is flagged as a possible hardcoded credential
(penalty, not veto — to tolerate rare false hits). *Verified: flags a random 20-char credential;
passes sha256 hashes, URLs and English prose.* — closes "entropy-based secret detection".

### Iteration 9 — Per-role model choice (Pillar 2, P0) ✅
`config.modelFor(role)` + env vars `ISL_MODEL_IMPLEMENT / _REVIEW / _SECURITY / _PLAN /
_RESEARCH` (each defaults to `OLLAMA_MODEL`, so behaviour is unchanged until set). Wired into
the **implementer, planner, reviewer and security grader** — so a strong model can do the work
that decides quality while a cheap one does triage. This is the seam where a frontier/cloud model
plugs into the phases that matter. — closes §2 "first-class strong-model support (v1)".

### Iteration 10 — LLM provider abstraction (Pillar 2, P0) ✅
`src/openaiProvider.js` + `config.llm` — `chat()` transparently routes to **any
OpenAI-compatible chat-completions API** (OpenAI, OpenRouter, Groq, Together, vLLM, LM Studio,
Ollama `/v1`) when `ISL_LLM_PROVIDER` + `ISL_LLM_BASE_URL` (+ key) are set; otherwise the local
Ollama path is used **unchanged**. Streaming, tool-calls and usage are mapped to the same shape,
so every caller is untouched. *Verified: default → Ollama (provider inactive); syntax + shape.*
This is how a frontier model plugs into the phases that decide quality. — closes §2 "true provider
abstraction".

### Iteration 11 — Pull-request publisher (Pillar 4, P0) ✅
`src/deploy/prPublisher.js` — on every committed iteration the engine builds a **reviewable PR
body** (what changed, the tasks, the gates passed, provenance) and **opens a real GitHub PR** when
`GITHUB_TOKEN` + `GITHUB_REPO` are set, otherwise writes a draft to `.data/pr-drafts/`. Fire-and-
forget, never blocks the pipeline. *Verified: PR body generated correctly; draft path when GitHub
unconfigured.* — closes §4 "PR-native output (v1)".

### Newly discovered while building (added to the backlog)
- **Make the gates config-driven.** Per-project allow/deny rules and severity tuning. *(P2)*
- **TS/TSX/JSX syntax check ✅ shipped 2026-08-07** (see the log below). A real `tsc --noEmit` *type*
  check — a project-level program, not a per-file parse — and a compile gate for compiled languages
  remain open. *(P1)*
- ~~**Coverage-of-changed-lines gate**~~ **✅ shipped 2026-08-06** — see the implementation log below.
- **Record provenance in the DB too** (not only the commit message) for the dashboard. *(P2)*
- **A dedicated Security/Safety dashboard page** listing every gate finding over time. *(P1)*
- **CI-as-a-gate** — trigger the project's real CI on the change and treat its result as a grader
  (needs a CI system; scaffolded via the PR publisher). *(P0 — infra)*
- **Cost controls per provider** (token→$ budget) once a paid provider is configured. *(P1)*

---

## Items requiring external systems (designed, not yet shippable here)

Some roadmap items cannot be honestly "shipped & verified" inside this local environment because
they need external services, credentials, or infrastructure. They are **designed** in the pillars
above; building them belongs in a real deployment, not this loop:

- **§4 PR-native output, CI-as-a-gate, issue-tracker & IDE integration** — needs GitHub/GitLab
  tokens, a CI system, and the IDE marketplaces.
- **§5 Postgres, durable job queue, multi-tenant isolation, sandboxed container execution** —
  needs a DB server, a queue/worker cluster, and a container runtime.
- **§8 open-source hosting, CPU/small-model path at scale, platform i18n** — deployment/community
  work.
- **§10 objective benchmark harness (SWE-bench-style)** — needs the benchmark datasets and a
  reproducible eval rig.
- **§2 continual learning / fine-tuning** — needs a training pipeline and preference data at scale.

These are tracked here so the roadmap stays honest: the deterministic-gate, decision, memory,
polyglot, goal and model work above is real and running; the infrastructure items are the next
phase and require a real environment to build against.

## 1. Trustworthy changes — correctness & safety first

*If people can't trust the changes, nothing else matters.*

- **P0 — Deterministic gates over LLM opinions.** Keep expanding non-LLM checks: type-checking
  / compilation as a hard gate (tsc, mypy, `go build`, `cargo check`), linters, and the
  existing dead-code + regression vetoes. An LLM score should *rank*, never *approve* alone.
- **P0 — Real test signal, not "tests pass".** Generate tests that would actually catch a break;
  gate on **coverage of the changed lines** and run **mutation testing** on the diff so a change
  that no test exercises cannot land.
- **P1 — Behaviour-preservation proof for refactors.** For behaviour-preserving changes, require
  the existing suite to pass unchanged *and* characterization tests around the touched code.
- **P1 — Static security analysis (SAST)** on every diff (Semgrep/CodeQL-class rules), plus
  secret-scanning, dependency-vuln checks, and a license/IP check on anything the model writes.
- **P1 — Provenance & reproducibility. ✅ (v1, Iter 4)** Every commit carries which model,
  prompt, context and memory produced it, so any change can be explained and, if needed,
  reverted with confidence. *Shipped: commit message records model + agents + gates passed;
  next: persist provenance in the DB for the dashboard.*
- **P2 — Graded autonomy.** Low-risk changes (docs, tests, isolated fixes) auto-land; anything
  touching auth, money, migrations, or public APIs requires human approval by policy.

## 2. Intelligence quality — the model layer

*The single biggest lever on usefulness.*

- **P0 — First-class strong-model support. ✅ (v1, Iter 9)** Make the best available models
  (frontier cloud and strong local) first-class, with clean provider abstraction, cost controls,
  and per-phase model choice (cheap to catalogue, strong to implement/review). *Shipped:
  `modelFor(role)` per-phase model choice wired into implement/plan/review/security. Next: a true
  multi-provider adapter (OpenAI/Anthropic) beyond Ollama, + cost controls.*
- **P0 — Better prompting & tool use.** Continue the work already begun (search_code, symbol
  windows, decision briefs, grouped memory, dead-code self-check): give the implementer richer
  repo navigation (call graphs, references, an LSP), and tighter loops with fewer wasted steps.
- **P1 — Self-consistency & verification.** For hard changes, sample multiple candidates and pick
  the one that best survives the gates, instead of trusting a single generation.
- **P1 — Retrieval over the whole codebase.** A proper code index (embeddings + symbol graph)
  so agents ground changes in the real architecture, not a keyword grep.
- **P2 — Continual learning that compounds.** The Decision Network and Memory are the seed; add
  fine-tuning / preference data from accepted vs rejected changes so the fleet measurably
  improves over months, per project.

## 3. True polyglot support

*"Any codebase" must mean any language, verified — not just catalogued.*

- **P0 — Per-language verification adapters. ✅ (v1, Iter 2)** A pluggable runner interface:
  build, test, lint, type-check and "does it boot" implemented per ecosystem (Node, Python, Go,
  Rust, Java/JVM, .NET, PHP, Ruby, and enterprise stacks like ABAP/Apex where feasible). *Shipped:
  polyglot syntax gate (JS/Python/Ruby/PHP/Go) with graceful skip; test-command registry. Next:
  actually run pytest/go test in the test phase, add tsc type-check.*
- **P1 — Language Server (LSP) integration** for real references/definitions/diagnostics across
  languages, replacing JS-shaped heuristics.
- **P1 — Monorepo & polyrepo awareness.** Detect workspaces, affected-package graphs, and only
  build/test what a change touches.
- **P2 — Framework-aware recipes.** Know the idioms of Django, Rails, Spring, Laravel, React,
  etc., so changes fit the framework, not just the language.

## 4. Real developer-workflow integration

*ISL is only useful if it plugs into how software is actually built.*

- **P0 — Pull-request native. ✅ (v1, Iter 11)** Open PRs on GitHub/GitLab/Bitbucket with a
  clear description, the plan, the evidence (tests/coverage/scans), and the provenance — instead of
  committing to a local branch. Respond to review comments and CI results and iterate. *Shipped:
  PR body + real GitHub PR when GITHUB_TOKEN+GITHUB_REPO set, else a draft file. Next: respond to
  review comments; GitLab/Bitbucket adapters.*
- **P0 — CI as a gate.** Trigger the project's real CI on the change and treat its result as a
  first-class grader; never land what CI would reject.
- **P1 — Issue-tracker integration.** Pull work from GitHub Issues / Jira / Linear; close the
  loop by referencing the issue and proposing the fix as a PR.
- **P1 — IDE surface.** A VS Code / JetBrains extension so a developer can invoke, review and
  steer ISL where they already work.
- **P2 — Bot etiquette.** Rate-limited, batched, well-labelled contributions that a human
  maintainer can review comfortably — never a flood of noise.

## 5. Scale & deployment — self-host and SaaS

*From one laptop to many teams, without changing the idea.*

- **P0 — Pluggable persistence.** Keep SQLite for local/single-project, add Postgres for
  multi-tenant/multi-node so state isn't a single file.
- **P0 — A real job queue & workers.** Move iterations onto a durable queue with horizontal
  workers, so many projects improve in parallel and a crash resumes cleanly.
- **P1 — Multi-tenant isolation.** Hard boundaries between orgs/projects: data, compute, secrets,
  and cost. RBAC beyond the current admin/user/viewer.
- **P1 — Observability & ops.** Metrics, tracing, structured logs, health/readiness, backups,
  and cost/usage dashboards per tenant.
- **P1 — Sandboxed execution.** Run untrusted target code and tests in isolated containers/VMs
  with no network and least privilege, not in the host process.
- **P2 — One-command self-host** (container image + compose/helm) and an optional hosted service.

## 6. Safety, security & governance

*"For all humanity" requires it cannot be turned against people.*

- **P0 — Prompt-injection resistance.** The target codebase is untrusted input; a comment or
  file must never be able to make an agent exfiltrate secrets, weaken security, or act outside
  its scope. Treat all repo content as data, enforce tool/scope allow-lists, and review egress.
- **P0 — Guardrails against harmful change. ✅ (v1, Iter 1)** Refuse to introduce backdoors,
  weaken crypto/auth, disable security controls, or build malware — even if "the task said so".
  A safety reviewer phase with veto power. *Shipped: deterministic security gate vetoes
  disabled-TLS and removed auth/authorization controls; next: extend to a full `safety` grader.*
- **P1 — Secrets hygiene. ✅ (v1, Iter 1)** Never read, log, or commit secrets; scan for and
  redact them; keep provider keys out of prompts and out of the target repo. *Shipped: secret
  scan vetoes committed secrets; next: entropy-based detection + redaction in logs.*
- **P1 — Compliance posture.** Data-handling transparency, retention controls, and a path to
  SOC2/GDPR-style requirements for hosted use; clear data boundaries for self-host.
- **P1 — Change accountability.** Signed commits, an immutable audit trail, and a kill-switch /
  global pause that any operator can hit.
- **P2 — Licensing & IP safety.** Detect and avoid introducing code that conflicts with the
  project's license; attribute where required.

## 7. Human collaboration & control

*Autonomy should amplify people, not replace their judgement.*

- **P0 — Goal-setting, not just backlog-grinding. ✅ (Iter 7)** Let a human set objectives
  ("harden auth this week", "reduce p95 latency", "raise test coverage to 70%") and have the fleet
  plan toward them. *Shipped: per-project objective (🎯 on Backlog) injected into the planner +
  boosts matching backlog to the top. Next: measure progress toward the goal.*
- **P1 — Review-first mode.** A mode where nothing lands without human approval, with the
  evidence laid out for a fast yes/no — for teams that want the loop but not the autonomy.
- **P1 — Explainable proposals.** Every change answers "what, why, what could break, how it was
  verified" in plain language a non-expert maintainer can act on.
- **P2 — Feedback that teaches.** A human "not like this" should update Memory and the Decision
  Network, so the fleet adapts to a team's taste.

## 8. Accessibility, openness & inclusion

*Useful to **everyone** means the under-resourced benefit, not only the well-funded.*

- **P0 — Runs on modest hardware.** A viable path with small local models (and CPU-only), so a
  maintainer without a GPU or a cloud budget can still use it.
- **P1 — Open source & self-hostable** with no lock-in, so public-good and safety-critical
  software (health, civic, education, infrastructure) can adopt it freely.
- **P1 — Internationalisation of the platform itself** (the dashboard, docs, Alfred) — not just
  English — and accessibility (WCAG) for the UI.
- **P1 — Great onboarding & docs** so non-experts and students can run and learn from it; a
  "teaching mode" that explains each change.
- **P2 — Programmes for critical/underfunded projects** (free hosted capacity, prioritised
  support for widely-depended-on open-source libraries).

## 9. Efficiency & sustainability

*Compute is a cost and a footprint; being useful at scale means being efficient.*

- **P0 — Incremental everything.** Catalogue/analyse only what changed; cache LLM calls and
  test results; skip re-work the Memory already knows the answer to.
- **P1 — Cost-aware scheduling.** Track tokens/compute per landed improvement; prefer cheap
  models where they suffice; set per-project budgets.
- **P1 — Right-sized models per phase** (small for triage, strong for hard implementation) to
  cut cost and energy without cutting quality.
- **P2 — Report the footprint.** Surface compute/energy per improvement so users can make
  informed trade-offs.

## 10. Measurable impact — prove it improves software

*Without evidence, "improvement" is just activity.*

- **P0 — Objective benchmarks.** Run ISL against public suites (SWE-bench-style, defect
  datasets) and report resolve-rate, regression-rate and quality deltas over time.
- **P0 — Outcome metrics, not vanity metrics.** Track bugs actually fixed, vulnerabilities
  closed, latency/throughput gained, coverage raised, tech-debt reduced — not just "commits".
- **P1 — Before/after evidence per change.** Each landed change ships a measurable claim
  ("N+1 → 2 queries", "coverage 42%→55%") that is verified, not asserted.
- **P1 — Longitudinal project health.** A trend line per project so a team sees the codebase
  getting healthier (or not) and can course-correct.
- **P2 — Independent evaluation & transparency reports** so the claims are auditable by outsiders.

---

## New high-value functions to add

Concrete capabilities beyond the pillars above — each a distinct, buildable feature that makes ISL
materially more useful. Grouped by what they unlock.

### Safer, self-correcting changes
- **P0 — Uptime supervisor & memory watchdog. ✅ (2026-07-24)** An autonomous control plane is
  useless if it silently dies. The server survived a bad *run* but not a hard crash or an
  out-of-memory kill (which no in-process handler can catch) — the real "ISL is down after a few
  hours" symptom. *Shipped: `supervisor.mjs` is now the long-lived process — it launches the server
  with a raised heap (`--max-old-space-size`, `--expose-gc`) and restarts it within seconds whenever
  it exits for ANY reason, with a crash-loop backoff that never gives up; the loop auto-resumes
  because its desired state is persisted. In the server, a **memory watchdog** samples RSS each
  minute and, before nearing the heap ceiling (`ISL_MEM_LIMIT_MB`, default 1400), exits *cleanly* so
  the supervisor reclaims memory with a planned blink instead of an OOM crash; the `events` table is
  now pruned (`trimEvents`) alongside logs, and a WAL checkpoint runs on the blink. Run via `npm run
  serve`. Verified: killing the server process mid-run brought it back automatically in ~8s (new PID)
  with the loop still running. Also hardened the bind path (2026-07-24): a restart that races the old
  process releasing the port now retries `listen` on EADDRINUSE (bounded) then exits for the
  supervisor, instead of a generic uncaughtException leaving the process up-but-not-listening.*
- **P0 — Regression bisect & auto-revert. ✅ (2026-07-24)** When a later run, CI, or the workbench
  catches a break, bisect the fleet's own recent commits, identify the culprit, and revert *just
  that commit* — so a bad change can't poison everything after it. ISL should be able to undo its
  own mistakes. *Shipped: `src/iteration/bisect.js` — `fleetCommits` lists the `[ai-iter#N]` commits
  on the work branch; `bisectRegression` binary-searches them for the first commit that fails
  verification, running the target's own test suite (auto-detected, or a caller-supplied command) in
  an isolated detached worktree at each step so the live branch is never mutated during the search;
  `revertCommit` does a clean `git revert` on the work branch via a worktree (history-preserving,
  conflict-aware — reports when a change is too entangled to auto-undo). Slow steps run in the
  background (`startBisect`/`getLastBisect`). `GET /api/regression/commits`, `GET|POST
  /api/regression/bisect`, `POST /api/regression/revert`, and a "Regression bisect & revert" panel
  on the 🩺 Reliability view (Find-regression → culprit → one-click Revert, plus a revert button per
  commit, guarded by confirm). Verified on the target application: 25 fleet commits found; bisect
  binary search correct on always-good (no culprit) and always-bad (oldest = first bad); revert
  produced a proper "Revert …" commit on a throwaway branch, live work branch untouched. Next:
  auto-trigger the bisect when a subsequent run's regression phase fails on unchanged code, and
  route the revert through the human review queue.*
- **P0 — Change blast-radius analysis. ✅ (2026-07-24)** Before implementing, compute what a change
  touches (callers via the symbol graph, the tests that cover it, the routes it feeds) and surface
  it — big blast radius routes to human review, and the implementer gets the exact callers it must
  not break. *Shipped: `src/iteration/blastRadius.js` — a deterministic reverse-dependency graph
  built from the target repo's own imports (import/from/require, + Python), cached 60s and
  invalidated on every commit. `blastRadius(file)` → dependents, tests, route modules, public-API
  symbols, sensitivity (auth/payment/migration) and a low/medium/high risk. The implementer now
  receives a "BLAST RADIUS — what this change can break" brief (the callers that must keep working +
  a preserve-the-API directive), `GET /api/blast-radius?file=` exposes it, and each structural
  refactor candidate on the 🩹 Health view shows a ⟿ blast pill so risky refactors are visible up
  front. Verified on the target application: the database-client module came back HIGH on both its
  dependent count and the routes it feeds, and the auth module HIGH and sensitive, while leaf
  god-file pages correctly read low. Next: use the risk to gate auto-land vs. the human review
  queue.*
- **P1 — Golden / characterization guardian.** A curated set of critical behaviours (the core domain
  invariant, the money ledger, auth) captured as golden tests that *every* iteration must keep green
  — a hard floor no change may cross, independent of the LLM graders.
- **P1 — Change-size budget. ✅ (2026-07-24)** Cap files/lines changed per iteration (configurable);
  an oversized diff is split or rejected, keeping every change reviewable. *Shipped:
  `src/iteration/changeBudget.js` — two operator-tunable thresholds: a **soft** cap (default 8 files /
  +400 lines) past which the change is routed to the human review queue, and a **hard** cap (default
  40 files / +2500 lines) past which it is VETOED at finalize and never commits (a runaway, not a
  reviewable improvement). Refactors get a configurable multiplier (×3) since they legitimately move
  code. The engine's finalize now enforces the hard veto (reusing its refactor-intent detection), and
  the review queue's "big diff" trigger reads the SAME configurable soft budget (single source of
  truth). `GET|POST /api/change-budget` + an editable "Change-size budget" card on the ☑ Review view.
  Verified: 3 files/+120 → ok, 12 files/+500 → review, 60 files/+5000 → veto, same as refactor →
  review (allowance applied); overrides persist and restore.*

### Targeting the *right* work
- **P0 — Incident / log-driven improvement.** Ingest the target app's real signals — error logs,
  Sentry issues, monitoring alerts — and target fixes at what is *actually breaking in production*,
  not just static hotspots. The highest-value work is what's on fire.
- **P0 — Coverage-driven backlog. ✅ (2026-07-24)** Measure per-file/per-line coverage and feed the
  *lowest-covered critical paths* into the backlog, so the test agent (ISL's strongest skill) is
  aimed where it matters most, not at random files. *Shipped: `src/iteration/coverageScan.js` reads
  both criticality and coverage straight off the blast-radius graph — a file's criticality = its
  dependents + routes it feeds + sensitivity, its coverage = whether ANY test file imports it (a
  static proxy, no test run needed / polyglot-safe). High-criticality + zero-test files are the gaps;
  `seedCoverageBacklog` turns the top ones into characterization-test tasks for the `tests` agent,
  prioritised by criticality. `GET /api/coverage` + `POST /api/coverage/seed` + a "Coverage gaps"
  section on the 🩹 Health view (critical-coverage %, ranked gaps, "seed top 5 tests"). Verified on
  the target application: **critical coverage just 18%**; the top gaps were the auth module (crit
  100), the frontend auth store and the async-wrapper helper — seeding created prioritised test
  tasks (#87, prio 70 …).*
- **P1 — Real per-line coverage. ✅ (2026-07-25)** Replace the static proxy with the measured number,
  because the proxy has one blind spot that matters: a file whose only test asserts that it imports
  cleanly counts as "covered" and vanishes from the backlog while being as dangerous as an untested
  one. *Shipped: `src/iteration/coverageRun.js` runs the target's OWN suite under its OWN coverage
  tooling and parses the machine-readable report. Safety: the suite runs in a detached git worktree
  at HEAD (the pipeline's existing sandbox), so a test that writes files or seeds a dev database
  cannot touch the operator's working tree; reports are written to ISL's `.data`, never into the
  target repo; and every failure path degrades to `available:false` + a reason, leaving the static
  proxy in charge. **Uncommitted changes are replayed into the sandbox**, because a HEAD-only run on
  a dirty checkout measures a codebase nobody has and reports it as the truth — the target
  application's own first run would have measured the pre-healing red suite. The result records
  `dirty` + the commit, and a measurement taken on a dirty tree is always reported stale, since its
  commit no longer identifies what was measured. Adapters: vitest, jest, pytest, go, cargo-llvm-cov;
  three parsers cover far more — istanbul `json-summary`, **LCOV** (the format
  nyc/jest/vitest/pytest-cov/karma all emit) and the go coverage profile (block ranges expanded to
  lines, an overlapping miss never un-covering a hit). `coverageScan` uses the measurement the
  moment it exists: a critical file is a gap when its measured line coverage is under 50%, not
  merely when nothing imports it, and the seeded task changes accordingly ("extend the existing
  tests to reach the uncovered branches, currently N%" vs "write characterization tests"). Result is
  cached in the per-project settings with the commit it was measured at. `GET
  /api/coverage/measured` + `POST /api/coverage/measure` (the run takes minutes, so POST starts it
  and returns; a second POST while one is in flight is a no-op), plus a "Measure coverage" button on
  🩹 Health and a `measured` / `static proxy` badge so a proxy is never presented as a measurement.
  **Runner detection is split from coverage-plugin detection**, which is what turns a dead end into
  a one-command fix. Verified on the target application: parsers checked against real fixtures of
  all three formats (9/9, including out-of-repo and node_modules rejection); the live run reported
  "vitest is installed in backend but its coverage provider is not — install it with: npm install -D
  @vitest/coverage-v8", and found the same block in `frontend`. The measurement itself is one `npm
  install -D @vitest/coverage-v8` away in the target repo. The install hint is **pinned to the
  vitest actually installed** in that directory: the provider is peer-locked to its runner, so the
  bare command resolves to the newest major and fails with ERESOLVE on any repo not already on it —
  exactly what happened on the target application (vitest 2.1.9 vs provider 4.1.10).*
- **P1 — Dependency & CVE management. ✅ (2026-07-24)** Scan dependencies for known vulnerabilities
  and outdated packages; propose safe, tested upgrades (respecting semver, lockfiles, and the test
  gates). *Shipped (scan half): `src/deploy/depScan.js` — discovers every npm project in the target
  repo (package.json + lockfile, depth ≤3), runs `npm audit --json` in each (60s timeout, tolerant
  of no-lockfile/no-npm/no-network → "unavailable"), aggregates severity totals + names the top
  critical/high advisories per project. Result cached server-side + refreshed by a background
  trigger (`getLastDependencyScan` / `startDependencyScan`), `GET /api/dependencies` + `POST
  /api/dependencies/scan`, surfaced as a 📦 **Dependency vulnerabilities** panel on the 🔒 Security
  view (severity totals, per-package breakdown, top advisories, rescan). Verified on the target
  application: **6 critical, 20 high and 79 moderate vulnerabilities**, aggregated per npm project
  with the worst advisories named. Next: turn a CVE into a safe-upgrade backlog task and feed the
  count into the Health Index.*
- **P1 — Flaky-test detection & quarantine. ✅ (2026-07-24)** Re-run suspect tests, detect
  nondeterminism, quarantine flakes so they stop blocking real work — and file them for a fix.
  *Shipped: `src/iteration/flaky.js` — two defences. (1) **Re-run confirmation in the test grader**:
  when a suite fails, it's re-run a bounded number of times (`flakyRetries` setting, default 1, 0
  disables); if it then passes, the failure was non-deterministic — the change is NOT rejected for
  it, the flake is recorded, and the suite reads as passing. Genuine failures re-run and stay failed,
  so nothing real slips through. (2) **On-demand detection** (`detectFlaky`): run a suite N times in
  an isolated worktree at HEAD and report whether the outcome is inconsistent. Durable `flaky_events`
  log + `flakyStats` (top offenders). `GET /api/flaky`, `POST /api/flaky/retries`, `POST
  /api/flaky/scan` + a "Flaky tests" panel on the 🩺 Reliability view (retry-guard selector, weekly
  flake count, top offenders, event stream). Verified: detector correct on always-pass (not flaky),
  always-fail (not flaky — consistent), and an alternating command (flaky, 3/6); the grader's
  confirm-and-record path proven; retry setting persists. Next: per-test (not per-suite) quarantine
  and auto-filing a fix task for a recurring offender.*
- **P2 — Real performance benchmarking.** Actually *measure* a hot path before and after (micro-bench
  / query count), so a "performance" change ships a verified number, not a claim.

### Working with humans & real workflows
- **P0 — Human review queue with per-agent trust. ✅ (2026-07-24)** A batched approval surface where
  low-risk change types auto-land and risky ones (auth, money, migrations, public API, big refactors)
  wait for a human; each agent earns a trust level from its land/approval history (the Decision
  Network already measures this). *Shipped: `src/core/trust.js` derives a per-agent trust level
  (probation / trusted / proven) from the Decision Network's real land history; `src/core/reviewQueue.js`
  classifies every landed change by blast-radius risk + sensitivity + size against the acting agent's
  trust — trusted agents' low-risk work is auto-approved, everything risky or probationary is held
  PENDING. Advisory by design (the change lands on the work branch so the autonomous loop never
  stalls — a hard project rule); the queue governs whether a human has blessed it. Wired into the
  engine's post-commit path, `GET /api/review-queue` + `POST /api/review-queue/:id/decide`, and a ☑
  **Review** view (stat cards, per-agent trust ledger with land-rate bars, tabbed queue with
  Approve/Reject and the exact reasons each change needs a human). Verified on the target
  application: `resilience` is the lone *trusted* agent (62% over 37), all others *probation*
  (frontend 12%/126, tests 16%/67) — so a change to the auth module by `tests` is flagged
  review/high for "sensitive area + many dependents + probation", while the same agent's leaf-file
  edit is review/low; approve/reject + re-decide guard all work. Next: gate promotion on approval,
  and feed rejections back as pitfalls that lower trust.*
- **P0 — Interactive refactor dry-run. ✅ (2026-07-24)** For a structural recipe, show the human the
  full multi-file plan (what moves where, which call-sites rewire) *before* it executes — a preview
  they approve or edit, so architectural change is directed, not surprising. *Shipped:
  `src/iteration/refactorPlan.js` — fully deterministic, no writes. `planRefactor(file)` parses the
  god-file's top-level symbols (functions / components / dialogs / sections / hooks / helpers /
  constants) with line spans, keeps the default export as the entry, proposes a grouping into target
  modules (big sections each get their own file; the rest grouped by kind), and — via the
  reverse-dependency graph — lists which call-sites reference *named* exports and would therefore
  rewire. `GET /api/refactor/plan?file=` + a "⧉ preview" toggle on each structural candidate in the
  🩹 Health view showing the proposed module layout and the rewire impact. Verified on the target
  application: **the 3,355-line admin console component (66 top-level symbols) → ~10 proposed
  modules** (each of its major tabs and panels its own file, plus grouped
  sections/dialogs/ui/constants), and **0 external rewires** because only its default export is
  imported — the reassuring truth surfaced before any change. Next: let the human edit the grouping
  and hand the approved plan to the implementer as the refactor's spec.*
- **P1 — Digest reports. ✅ (2026-07-24)** A daily/weekly "what improved" summary (commits, scores,
  gate blocks, health trend) delivered to the operator (in-app, and email/Slack when configured).
  *Shipped (in-app): `src/iteration/digest.js` — a fully deterministic roll-up over a time window
  (today / week / month) composed from data ISL already records: landed changes + land rate + avg
  score + files touched, the outcome mix (committed / interrupted / empty / rolled-back / errored),
  the Health Index + its delta, the security gate's blocked-unsafe-changes, and the outstanding
  dependency CVEs — with a one-line plain-language headline (the future email subject). `GET
  /api/digest?hours=` + a 📰 **Digest** view under Insight (window toggle, headline, stat cards,
  outcome mix, health, security posture, "what landed" list). Verified on the target application: "9
  changes landed today · 22 files touched · 36% land rate · health 41/100 · 6 critical CVE(s) to
  fix." Next: schedule it (daily/weekly) and deliver over email/Slack when configured.*
- **P1 — Auto-changelog / release notes. ✅ (2026-07-24)** Generate human-readable release notes from
  the landed improvements for each promotion, grouped by theme, with the evidence. *Shipped:
  `src/iteration/changelog.js` — buckets the landed commits by a keyword theme (Security /
  Reliability / Tests & coverage / Refactoring / Frontend & UX / Performance / Features) and renders
  markdown release notes with per-change evidence (sha, score, files) + a totals header. `GET
  /api/changelog` + a collapsible "Release notes" section on the ✔ Summary view with a copy-markdown
  button. Verified on the target application: 41 landed changes → Security(4) · Reliability(15) ·
  Tests(13) · Refactoring(3) · Features(5). Next: emit the notes automatically on each promotion.*
- **P2 — Feature-flag-aware changes.** Land risky behaviour behind a flag so it can be rolled out and
  rolled back without another deploy.

### Deeper capability
- **P0 — Codebase health index & trend. ✅ (2026-07-17)** One composite score per project
  (complexity, duplication, coverage, vuln count, doc coverage) tracked over time — the honest
  answer to "is ISL actually making this better?", visible as a trend line. *Shipped:
  `src/iteration/healthIndex.js` — deterministic composite
  (structure/complexity/testRatio/sizeSpread), persisted `health_snapshots` table, auto-snapshot on
  every commit, `GET /api/health-index` + a 🩹 **Health** dashboard view (score, component bars,
  trend line, biggest files, structural refactor candidates + "seed to backlog"). Verified: the
  target application = 41/100 (testRatio 22 the weakest — matches reality); snapshots persist +
  trend builds. Next: real coverage %, duplication, CVE count as inputs.*
- **P1 — Semantic code+docs index (RAG). ✅ (2026-07-24, hybrid vector + lexical)** An embedding +
  symbol-graph index the agents *and* Alfred query, so changes and answers are grounded in the whole
  architecture, not a keyword grep. *Shipped: `src/context/knowledgeIndex.js` — a **hybrid**
  retrieval index over a corpus of the product's code (every file keyed on its path + exported
  symbols + head, plus every shared-memory lesson). Two signals are blended: **lexical** BM25
  (camelCase/snake-aware tokenizer + exact-symbol boost) and **vector** cosine of a
  `nomic-embed-text` 768-dim embedding. Embeddings are cached in `knowledge_embeddings` keyed by a
  content hash, so a rebuild only re-embeds changed docs; the build runs in the background
  (`startEmbeddingBuild`) and is also a scheduled quiet-hours task. `GET /api/knowledge?q=`, `POST
  /api/knowledge/embed`, + a "Knowledge search" box on the 📚 Context view (shows hybrid vs lexical,
  embedded count, a build button, and per-result lexical+cosine). Falls back to pure lexical if no
  embed model. Verified on the target application: embeddings are semantically meaningful
  (cos(auth,jwt)=0.49 > cos(auth,css)=0.29); a hybrid query for "payment capture idempotency"
  returned **mode=hybrid** and the vector signal re-ranked the payment-capture module (lex 7.8 + cos
  0.50 → 0.60) ABOVE the lexically-higher idempotency helper — the exact win of blending. Note:
  full-corpus embedding is a slow background job on this single GPU (~6s/embed under load); it fills
  in incrementally + persists. Next: expose the index as an Alfred/agent tool, and tune the α blend
  weight.*
- **P1 — Apply ISL's own gates TO the target app. ✅ (2026-07-24, frontend a11y/i18n)** ISL improves
  accessibility, i18n and service contracts of other apps — so *audit* them: run axe on the target's
  frontend, find hardcoded user-facing strings, and contract-test the seams between its services, and
  feed the findings to the backlog. *Shipped (static frontend audit): `src/iteration/frontendAudit.js`
  — a deterministic pass over the target's JSX/TSX for high-signal, low-false-positive issues:
  `<img>` with no alt, `onClick` on non-interactive elements with no role, `<a onClick>` with no
  href, and un-translated visible strings (flagged ONLY in files that already use i18n, so it's a
  real translation gap). `GET /api/frontend-audit` + `POST /api/frontend-audit/seed` (worst files →
  frontend/ux backlog tasks) + a "Frontend a11y/i18n" tab on the 📋 Compliance view (per-kind totals,
  worst files, seed). Verified on the target application: **143 findings — 25 click-on-non-
  interactive (real a11y) + 118 un-translated strings**; seeding created prioritised tasks against
  the worst files (#90, #91…). Next: run axe against the live frontend for runtime a11y, and
  contract-test the service seams.*
- **P1 — Cross-project learning transfer. ✅ (2026-07-24)** Promote a proven pattern from one
  project's shared memory to others where the stack matches, so every project benefits from what any
  project learned. *Shipped: `src/core/crossProject.js` — reads each project's memory + stack
  signature (its `codeStats` language set) via isolated read-only handles (never swapping the live
  loop's active DB); `crossProjectPlan()` previews, per ordered project pair, the language-overlap
  similarity (Jaccard ≥ 0.34) and the PROVEN patterns (kind pattern/lesson/fix/insight, reinforced
  ≥2×) the source has and the target lacks. `applyCrossProjectTransfer({from,to})` copies them into
  the target — through the live `remember()` if the target is active, else a direct handle that
  creates the memory schema if the project is brand-new — each entry tagged `cross-project:<source>`
  and prefixed "[learned in <source>]" so provenance survives. `GET /api/cross-project` + `POST
  /api/cross-project/apply` + a "Cross-project learning transfer" panel on the 🗃 Memory view
  (per-project stack/pattern counts + per-pair Transfer button). Verified with the 2 real projects
  (the target application, ISL Self — both JavaScript, 100% stack match): transferred the target
  application's 2 proven "theme that landed" insights into ISL Self, tagged with origin; re-run
  transferred 0 (dedup/idempotent). Next: auto-transfer on a schedule and weight by the pattern's
  land rate.*
- **P2 — Scheduled improvement windows. ✅ (2026-07-24)** Run heavier passes (big refactors,
  dependency upgrades, benchmarks) on a schedule / during quiet hours, gated and rate-limited.
  *Shipped: `src/core/improvementWindows.js` — an operator-defined quiet-hours window (start/end
  hour, incl. overnight wrap; days of week) during which heavier passes fire: the CVE scan, seeding
  coverage + structural refactor tasks, a health snapshot, and cross-project transfer. Each task runs
  at most once per calendar day (rate-limited via a per-task run-log, and dedup-safe since seeds
  dedup by title). A 5-minute boot-time ticker (`startImprovementWindows`) checks the window; `GET`
  /`POST /api/schedule` + `POST /api/schedule/run-now` (force) + a "Scheduled improvement windows"
  card on the Settings view (enable, hours, day toggles, per-task toggles, run-now, last-run stamps).
  Off by default. Verified: in-window tick fires the enabled tasks; a second tick same-day is
  rate-limited to none; disable clears the window; run-now fired all four (dep scan, 3 coverage + 2
  structural seeds, health snapshot). Next: gate on the daily cap and route seeded heavy work through
  the review queue.*
- **P2 — Multi-repo, dependency-aware improvement.** Improve a shared library and its consumers
  together, so a change that ripples across repos is made coherently.

### Improvement Scope — human steering ✅ (2026-07-25)

**The problem, measured.** Left to itself the fleet optimised for what lands easiest: on the target
application the landed work was **backend 46% · frontend 32% · tests 14%**, with **UX at 1%** and
**Architecture at 1%** — against an intent of 20% and 15%. The operator was right: too many tests,
almost no real UX, frontend-design or architectural improvement. That is a governance gap, not a
model failure.

**Shipped:** `src/core/scope.js` + a 🎯 **Scope** page. The operator sets a weight per THEME (UX &
design, Frontend, Backend & API, Architecture, Security, Performance, Tests, Docs, Infra), a hard
**cap** per theme, free-text **directives**, **exclusions**, and **research topics**. When enforced:
- the **planner** re-weights every candidate by its theme's share (`0.4 + 0.6 × bias`) and *drops*
  candidates whose theme has hit its cap, before the model ever sees the list;
- `scopeBrief()` is injected **verbatim** into the planner prompt, **every agent's** working context
  (via the Context Agent) and the **researcher's** system prompt;
- the **online research** topics are generated from the top-weighted themes + the operator's research
  directives, so proposals match the direction instead of generic best practice.

The page also charts **intent vs. reality** so drift is visible, and shows the exact text the fleet
will read. Presets: *Product & UX push · Architecture & backend · Harden & secure · Balanced*.

*Verified: with a candidate list dominated by tests (4 of the top 5), scope shaping produced a batch
of `services · ux · frontend · refactor · tests` — **tests fell from 4/5 to 1/5**. Defaults favour
user-visible and structural work (UX 20 · Frontend 20 · Backend 20 · Architecture 15 · Security 10 ·
Performance 5 · Tests 5, capped at 25% · Docs 3 · Infra 2).*

### Next wave — new functions (added 2026-07-24)

**Status: 11 of 11 shipped and verified.** The last item — *real per-line coverage* — was blocked by
a prerequisite rather than by effort: it needs the target's suite to run under `--coverage`, and
the target application's backend suite was red, so any number would have been partial and
misleading. With the suite green (2026-07-25) it was built; see the entry below.

*Now that the deterministic guardrails and code-intelligence layer exist (blast radius, review queue
+ trust, coverage/structural/health scans, bisect+revert, dependency/CVE scan, the hybrid knowledge
index), the highest-value next step is to make them ACT — turn what ISL now sees into changes it
safely lands. Each of these composes signals ISL already produces.*

- **P0 — CVE auto-remediation. ✅ (2026-07-24, compute+verify half)** The dependency scan already finds
  the exact vulnerable packages; now act on them. For each advisory, compute the minimal safe bump
  (respecting semver + the lockfile) and report which CVEs it closes. *Shipped:
  `src/deploy/cveRemediate.js` — per npm project it runs `npm audit fix --package-lock-only` in an
  **isolated worktree**, re-audits, and returns before/after counts, the CVEs closed, and the
  manifest/lockfile diffstat. `GET|POST /api/dependencies/remediate` + a "Safe upgrades" panel on
  the 🔒 Security view. Verified on the target application's backend: **64 → 58 vulnerabilities, 6
  closable safely** (3 high, 2 moderate, 1 low) via a `package-lock.json`-only change (55+/47−).*
  **Two deliberate safety choices, both verified:**
  - *The worktree is created RAW — **not** `createSandbox`, which junctions `node_modules` back to
    the real checkout; running an installer there would mutate the user's actual dependencies.
    `--package-lock-only` installs nothing. Proven: the real `backend/package-lock.json` md5 was
    **identical before and after** the run.*
  - *`--force` is never used, so no breaking major bumps. (The target application's 1 critical
    needs a major bump and is therefore correctly left for a human.)*
  **Honest gap:** because nothing is installed, the upgrade is **not test-verified** here — the output
  is an evidence-backed patch proposal, labelled as such in the UI. Next: an opt-in isolated
  `npm install` + suite run to verify green, then auto-open it as a `security-upgrade` review item.
- **P0 — Rejection-driven learning + trust feedback. ✅ (2026-07-24)** A human **reject** in the review
  queue is the strongest signal ISL gets — capture it: write a scoped pitfall to shared memory ("this
  kind of change to this area was rejected because…"), and fold rejections into the trust score so an
  agent that keeps getting rejected loses auto-land latitude. Approvals reinforce it. Closes the loop
  between the review queue, the Decision Network, and shared memory. *Shipped: `reviewQueue.decideReview`
  now, on a reject, writes an `agent:<id>`-scoped **pitfall** memory with the change's risk + reasons;
  `trust.agentTrust` reads the review queue's approve/reject tally per agent and **demotes** — a
  majority-rejected agent (≥50% over ≥2) drops to `probation` (latitude 0) regardless of how well its
  work passed the machine gates, and notable rejections cap a `proven` agent at `trusted`. The trust
  ledger (☑ Review) shows a ✕N rejection pill. Verified: 3 rejects → 3 pitfall memories + rejected=3 +
  latitude 0; the real `quality` agent's ledger now reflects its human approvals. Next: decay old
  rejections so trust can recover.*
- **P0 — Auto-bisect on a fresh regression. ✅ (2026-07-24)** When a run's regression/test phase fails
  on code the current diff didn't touch, auto-trigger `bisectRegression` to find the culprit commit
  and surface it (with a one-click revert) instead of waiting for a human to notice. *Shipped:
  `bisect.failsAtBase()` re-runs a failing suite at the commit the iteration STARTED from, in an
  isolated worktree. If it fails there too the failure is **pre-existing** — the grader marks the
  result `preExisting`, says so in its summary, and the engine kicks off a **background auto-bisect**
  to find the real culprit (surfaced with one-click revert on 🩺 Reliability). The change still
  doesn't land onto a broken base, but the blame goes to the right commit.*
  **Two real findings while verifying this:**
  1. *The target application's backend suite is **already red at base** — 7 of 58 suites failing in
     one backend module's own test file. So iterations touching backend have been failing a gate for
     a break they did not cause — a real, previously invisible drag on the land rate. This detection
     now prevents that misattribution.*
  2. *It exposed a **bug in the bisect itself**: when EVERY commit in the window fails, the binary
     search returned the oldest as "the culprit" — which would send an operator to revert an
     innocent commit. Fixed: the bisect now requires a genuine good→bad boundary and otherwise
     reports `culprit: null` with a reason ("every commit checked already fails — the regression
     predates this window"), and the UI shows that instead of a false "all verified good". Verified:
     all-bad range → null + reason; all-good range → null, no reason. Bisecting the target
     application 30 commits back (to iter #62) found no good commit — that break predates the
     fleet's recent history.*
- **P1 — Real per-line coverage. ✅ (2026-07-25)** Upgrade the static coverage proxy to true coverage:
  run the target's suite with `--coverage` in a sandbox, parse the machine-readable report, and feed
  real per-line gaps on critical paths into the backlog. The proxy already picks the right files; this
  makes the target exact. *Shipped — `src/iteration/coverageRun.js`. Full entry under "Targeting the
  right work" above. Measured on the target application: **6.4% of lines repo-wide**, and it
  immediately corrected the proxy in both directions — the backend auth middleware reads "no tests"
  statically but is **27.1% covered** transitively through route tests, while the frontend auth
  store (crit 93, sensitive) is **0%: never executed**.*
- **P1 — Knowledge index as an agent + Alfred tool. ✅ (2026-07-24)** Expose `queryIndex` as a
  `search_knowledge` tool the implementer and Alfred can call, so a change is grounded in the whole
  architecture (and the fleet's past lessons) before it's written — not a blind grep. This is the
  payoff of the RAG index. *Shipped: a `search_knowledge` tool added to the implementer's toolset
  (`sandboxTools.js` — schema + async handler returning ranked files with their key symbols + any
  matching memory lesson) AND to Alfred (`chat.js`); the implementer's guidance now says "orient
  first" with it in unfamiliar areas. Verified end-to-end: the implementer handler for "where
  payment capture is retried" returned (hybrid) the payments module, the checkout-saga module with
  its registration symbol, and the ledger module with its capture and transaction symbols — exactly
  the right files + symbols, plus any lesson. Next: let the review/planner also cite the retrieved
  lessons.*
- **P1 — "Find a similar past change" retrieval. ✅ (2026-07-24)** Before implementing, retrieve the
  most similar PAST landed change (its title + files + score) so the implementer reuses a proven
  approach for a recurring shape of work. *Shipped: landed changes are now documents in the hybrid
  knowledge index (kind `change`, carrying sha + score); `similarChanges(query,k)` retrieves them
  (with a `kinds` filter added to `queryIndex` so changes rank among themselves, not crowded out by
  the code corpus). The implementer now gets a proactive **"PROVEN APPROACHES — the fleet landed
  similar work before"** note (top matches with score ≥ 80, best-effort so it never blocks), the
  `search_knowledge` tool labels change hits with their score, and `GET /api/similar-changes?q=`
  exposes it. Verified: "add tests for a backend service" → the past email-testing changes in a
  backend service; "refactor a complex frontend component" → the frontend-refactor commit (score
  99). Next: also surface the change's diff on demand so the approach is copy-able.*
- **P1 — Unified impact-ranked backlog. ✅ (2026-07-24)** Combine blast radius × coverage gap ×
  health contribution × (for CVEs) severity into ONE priority score, so the fleet always works the
  highest-leverage item next instead of per-source heuristics. *Shipped:
  `src/iteration/impactRank.js` — a composite leverage score per source file from deterministic
  signals off the blast graph + file scan: reach (0.30) · untested (0.25) · routes (0.15) ·
  sensitivity (0.12) · size (0.10) · complexity (0.08), each with the single action that moves it
  most (add tests / refactor / harden). `GET /api/impact` + a "Highest-leverage files" panel on the
  🩹 Health view. Verified on the target application: the auth module tops at **85** (wide reach,
  untested, feeds many routes, sensitive → "add tests"), then the frontend auth store, the
  async-wrapper helper and the API client — the honest "fix these first" list. Next: fold in CVE
  severity per file and let the planner pull its batch from this ranking.*
- **P1 — Health-gated autonomy. ✅ (2026-07-24)** If the Health Index drops more than N points below a
  recent peak, ISL narrows auto-land latitude until health recovers — a self-correcting governor.
  *Shipped: `src/core/autonomy.js` — `autonomyMode()` reads the Health Index trend; if the current
  score is ≥ `healthGuardDrop` (default 3, operator-tunable) below the peak of the last ~10 snapshots
  it enters **stabilise** mode. In stabilise mode `reviewQueue.classifyChange` revokes ALL auto-land
  latitude — every change, even a proven agent's low-risk one, routes to human review with the reason
  "codebase health is dropping". The loop keeps running; it just gets cautious exactly when the trend
  is wrong. `GET|POST /api/autonomy`, surfaced in `GET /api/review-queue` + a 🛡 stabilise banner on
  the ☑ Review view. Verified: real state normal (health 42); injecting a recent peak of 50 → mode
  stabilise (drop −8) and a proven+low-risk change flips from auto → review; back to normal on
  recovery. Next: also bias the planner's batch mix toward tests/refactors while stabilising.*
- **P1 — Auto-changelog / release notes. ✅ (2026-07-24)** Generate human-readable, theme-grouped
  release notes from the landed improvements for each promotion, with per-change evidence. *Shipped —
  `src/iteration/changelog.js`, `GET /api/changelog`, "Release notes" on the ✔ Summary view. See the
  "Working with humans" section above for detail.*
- **P2 — Backlog dedup. ✅ (2026-07-24)** Detect near-duplicate backlog items (structural, coverage,
  research, CVE) and merge them, so the backlog stays a crisp priority list rather than an accreting
  pile. *Shipped: `src/iteration/backlogDedup.js` — `findDuplicates` pairs pending features by a
  **high-precision** signal (same target file + same intent: test / refactor / a11y / security /
  perf), with a high-lexical-overlap fallback for file-less items; `dedupBacklog` defers the
  lower-priority of each pair. `GET /api/backlog/duplicates` + `POST /api/backlog/dedup` + a "⧉
  dedup" button on the Backlog view (previews the pairs, confirms, defers). Verified on the target
  application: **5 precise duplicates** found (two test tasks against the same image-optimiser
  helper, two against the same CSV helper, two refactors of the same search function…).*
  **Honest design correction:** I first built this with sentence EMBEDDINGS (as the item suggested)
  and it was wrong — the backlog is full of templated titles ("Fix accessibility in <one page>"
  vs "…<another page>") that embed at ~0.95 cosine despite targeting DIFFERENT files, so it produced 550
  false pairs from 34 items and would have merged distinct work. Sentence similarity is the wrong
  tool for a templated backlog; same-file+intent is the right, precise one. Next: extend the intent
  match to the specific function/symbol so two different functions in one god-file aren't merged.
- **P2 — Trust-gated auto-promotion. ✅ (2026-07-24)** A `proven`-trust agent's low-risk,
  human-approved change can auto-promote from the work branch toward the deploy branch, so the
  review queue's approvals actually ship without a second manual step. *Shipped:
  `src/deploy/autoPromote.js` — a commit qualifies only if (1) a human **approved** it, or it
  auto-approved under a **proven** agent (never probation, never rejected/pending), (2) its risk is
  low (medium allowed only for an explicitly human-approved change; high always needs a deliberate
  promote), and (3) autonomy is not in **stabilise** mode. Because promotion is a fast-forward, only
  a **contiguous prefix** can move — it walks base→tip and stops at the first non-qualifying commit,
  so it can never skip an unapproved change to ship a later one. `plan()` is a pure dry-run; the
  promote delegates to `promoteToMain`, which still refuses a non-fast-forward, dirty tree, or wrong
  checkout. `GET /api/auto-promote` (dry-run) + `POST …/enabled` + `POST …/run`, and a "Trust-gated
  auto-promotion" panel on the ⬆ Promote view with the per-commit verdicts. **OFF by default.**
  Verified on the target application: 7 commits ahead,
  **0 promotable** ("still awaiting human review" — correct, since most agents are on probation); a
  synthetic approved commit made the prefix extend to exactly 1 and **stop at the next pending one**;
  a run with auto-promotion disabled correctly refused. Next: fire it automatically after each
  approval instead of on demand.*

### Enterprise wave — new functions (added 2026-07-25)

*Everything above made ISL **capable**: it sees the codebase, judges its own changes, and lands them
safely. This wave is about making it **deployable inside a company** — where the blockers are not
capability but data boundaries, provable governance, identity, reproducibility, cost and scale. Each
item below is a gap ISL has TODAY, several of them found by building the features above rather than
imagined: the `node_modules` junction that forced CVE remediation to bypass the sandbox, the
module-level caches that had to be invalidated by hand on a project switch, the review queue that
cannot tell an author from an approver. Ordered by how hard each one blocks an enterprise rollout.*

- **P0 — LLM egress firewall + redaction ledger. ✅ (2026-07-25)** Every phase — plan, implement,
  review, security, research, Alfred, and the RAG index — sends source code, diffs, shared memory and
  retrieved chunks to a model. With `ISL_LLM_PROVIDER=openai` that content leaves the perimeter, and
  there was **no record of what was sent, no redaction, and no rule an operator could set**. For a
  regulated customer this single gap blocks adoption regardless of how good the improvements are.
  *Shipped: `src/core/egress.js` — one choke point every outbound payload passes through, wired into
  `ollama.js chat()` (which every phase already funnels through, so a phase added later is covered by
  construction) and into `knowledgeIndex.embed()`, the highest-volume path since it embeds the whole
  codebase.*
  - ***Fails closed, and the default IS closed.** Modes are `local-only` / `approved-vendors` / `any`,
    default `local-only`, so an install that upgrades into this feature cannot start sending code
    somewhere new because nobody had configured a policy yet. "Local" is decided by the **resolved
    hostname**, not the provider's name — an Ollama on a shared GPU box is remote and is treated as
    remote.*
  - ***Redaction reuses the security gate's own rules** (`SECRET_RULES` and `highEntropyLiterals` are
    now exported and imported, never copied — a drifted second copy of those patterns is a credential
    leaving the building). Local calls are ledgered but NOT redacted: degrading a prompt to a model on
    the operator's own machine costs answer quality and protects nothing already read from disk.*
  - ***A tripwire under the redactor.** Pattern matching only removes what it recognises, and a `.env`
    of bespoke internal tokens matches nothing. So the contents of forbidden files (`SECRET_GLOBS`)
    are fingerprinted and the call is DENIED if any of those lines appear in a payload — including a
    value quoted without its key, which is how a secret usually reaches a prompt.*
  - ***A hash-chained ledger.** One row per call — model, destination, bytes, redaction count and the
    SHA-256 of the exact payload. The hash, not the text: storing payloads would make the ledger a
    second copy of the customer's source to protect (opt-in if an operator wants it).*
  - *`GET|POST /api/governance/egress`, `/egress/ledger`, `/egress/preview`, `/egress/seal`, plus a
    **Data egress** tab on ⚖ Governance showing what the CURRENT provider config would do before a
    call proves it the hard way, and a redaction preview — the only way to trust a redactor is to
    watch it work on your own text.*
  **Found while building — the ledger was not operable.** A chain that can never be truncated grows
  without bound, and any retention policy would break verification permanently. Added **sealed
  checkpoints**: sealing records the head hash so archived rows can be deleted and verification
  RESUMES from the seal, while a gap with no checkpoint behind it is still reported as tampering.
  Sealing a chain that does not verify is refused outright — otherwise a checkpoint would launder a
  tampered history into a trusted one, the single thing this mechanism must never do.
  *Verified: 33 deterministic checks — host classification, `local-only` refusing a cloud call while
  still allowing the local model, unapproved-vendor refusal, live Stripe/AWS keys stripped with the
  surrounding code intact, `.env` content (and a bare secret value) tripping the wire while ordinary
  code does not, denials recorded as well as allows, payload text absent by default, altering a past
  row breaking verification at exactly that row, and sealing/archiving/resuming end-to-end. Then live
  on the running server: a real Alfred call ledgered as `chat | local | allow | qwen3.6:latest | 6165
  bytes`, chain verified.*

- **P0 — Policy-as-code gate engine. ✅ (2026-07-25)** The six hard vetoes and the review queue's
  routing rules were **hard-coded in JavaScript**. An organisation could not express "changes under
  `payments/**` need two approvals", "large frontend changes always get a human", "agents on probation
  never auto-land" without editing ISL's own source — and, worse, could not *prove after the fact
  which rules were in force* when a change landed. *Shipped: `src/core/policy.js`, a versioned rule
  document evaluated deterministically over facts ISL already computes (touched paths, risk class,
  sensitivity, area, agent, agent trust, change size).*
  **Three design decisions carry the weight, and one departs from this proposal on purpose:**
  1. ***Policy can only TIGHTEN, never loosen.*** *The original text said "replace the hard-coding".
     That is the wrong shape: replacing battle-tested veto logic with a config file means a gap in the
     config becomes a gap in the guardrails, and the failure mode is silent. Layering means the worst
     a broken policy can do is demand too many reviews. Verified explicitly — an `allow` rule cannot
     turn a `review` back into `auto`.*
  2. ***Every matching rule is evaluated and the most restrictive outcome wins***, not first-match, so
     rule ORDER is irrelevant and an operator cannot weaken a policy by putting a permissive rule
     first. Verified by evaluating the same facts against the rule list in both orders.*
  3. ***Validation refuses what would silently never fire.*** *An unknown condition key (`pathz` for
     `paths`) is rejected rather than ignored — a typo'd condition is the worst possible failure for a
     control, because it looks enforced and is not. Duplicate ids are refused too, since an id is how
     a rule identifies itself in the audit record. A rule matching everything must say `matchAll: true`.*
  *Simulation replays a draft against the real queue and reports what would change, which rules
  matched how often, and — importantly — **which rules never matched**, because a rule matching nothing
  is usually a typo'd glob rather than a rule with nothing to do. The matched rule ids and the policy
  version are persisted on the review item, so the **evidence pack now cites the policy that actually
  held a change** — the one control ISL can attest to historically rather than "as configured now".*
  *`GET|POST /api/governance/policy` (writing requires `governance.write`), `POST …/policy/simulate`.
  Ships **empty and disabled**: turning the feature on must change nothing until someone writes a rule.*
  *Verified: 29 deterministic checks, plus the migration test that matters — **replaying all 25 real
  queue items with an empty policy left every verdict untouched (0 altered), while a match-all rule
  held 20/20**, so the "no change" result proves a no-op rather than a dead code path. Live: a
  simulation of "hold everything by a probationary agent" against real history reported 22/25 matches
  but `wouldChange: 0` — the rule is redundant with existing behaviour, which is exactly the insight
  simulation exists to surface — and correctly flagged a deliberately typo'd rule as never matching.*
  **Honest limit:** the queue does not store the changed-file list, so **path rules cannot be
  simulated against history**. The response says so (`pathRulesSimulatable: false`) rather than
  reporting "no matches" and letting an operator conclude their path rule is harmless.

- **P0 — Hermetic containerised verification. ⚠️ (2026-07-28, built; container execution unverified
  here)** *Shipped: `src/sandbox/container.js` + `runVerified()` in `worktree.js`, with the test
  grader routed through it.* A verification step now runs in a per-project container: the worktree
  bind-mounted and nothing else, `--network none` by default with opt-in per step, memory and CPU
  capped, and the dependency cache as a **named volume** keyed by lockfile content — never a bind,
  which would write installed packages back into the operator's filesystem and reopen the very leak
  this closes. The image comes from the repo's own `.devcontainer/devcontainer.json` (comments and
  trailing commas tolerated), then a root `Dockerfile`, then a base image for the detected toolchain.
  **The honest-fallback rule is the load-bearing part.** With no runtime, the step runs on the host
  exactly as before and reports `isolated: false` with the reason — carried into the run record
  (`iterations.isolation`) and onto `/api/health`. A verification that quietly ran on the host while
  the UI implied a sandbox would be worse than no isolation at all, because the operator would trust
  a guarantee they did not have.
  **What is NOT verified:** this machine has the docker CLI but no running daemon, so container
  execution itself was never exercised. 30 checks cover what is genuinely testable without one — the
  exact argv (network off, single mount, volume-not-bind, caps), image resolution and its
  precedence, the content-addressed cache key (application code does not cold it; a dependency
  change does), and the fallback path, which is precisely this machine's state. The acceptance
  criteria — a test that writes outside the worktree cannot affect the host; two iterations without
  a shared dependency tree; a host with no Python verifying a pytest project — need a daemon and
  remain unproven.
  *Original problem statement:* Verification runs in a git worktree whose
  `node_modules` is **junctioned back to the real checkout** — documented in `worktree.js` as a
  performance necessity, and already the reason `cveRemediate` had to bypass `createSandbox` entirely
  to avoid mutating the operator's actual dependencies. Any test or install with a side effect reaches
  the developer's machine, and two parallel iterations share one dependency tree. The toolchain problem
  is the same shape: of the 53 language adapters, only those already installed on the host can run, so
  polyglot support is theoretical on a bare machine. Run every verification step inside a per-project
  container — built from the repo's own devcontainer/Dockerfile when present, otherwise a base image
  chosen from the detected toolchain — mounting the worktree and nothing else, **network off by
  default** with opt-in per step for dependency resolution, and a content-addressed layer cache keyed
  by the lockfile so a warm run stays near today's speed. When no container runtime exists, fall back
  to the current worktree path and **say so in the run record** rather than pretending the run was
  isolated. *Acceptance: a test that writes outside the worktree cannot affect the host; two iterations
  run concurrently without sharing dependencies; a host with no Python still verifies a pytest project.*

- **P0 — Tamper-evident audit chain + compliance evidence pack. ✅ (2026-07-25)** `audit()` wrote rows
  that anyone with database access could edit, and change-control evidence had to be reconstructed by
  hand from the dashboard — which is a summary written by the party being audited, not evidence.
  *Shipped in two halves:*
  - ***`src/platform/hashChain.js`** — the chain extracted from the egress ledger into one shared,
    table-agnostic implementation now used by BOTH the ledger and the platform `audit` table. Two
    copies of "is this history intact?" would eventually disagree, and the copy that drifted would be
    the one quietly declaring a tampered log clean. It proves INTEGRITY, not secrecy: someone who can
    write the database can still append, but cannot rewrite what is already there without verification
    failing at exactly that row. The audit table is migrated in place, and rows written before chaining
    are reported as `unchainedLegacy` rather than counted as verified — "integrity is proven from this
    date" is honest; implying the whole history is covered would not be. (On this install: 297 legacy
    rows, chained from here on.)*
  - ***`src/core/evidencePack.js`** — for one landed change, assembled mechanically from records ISL
    already keeps: the originating task, the plan the agent committed to BEFORE editing, every gate
    phase with its score, summary and raw inputs (what makes a verdict checkable rather than merely
    reported), the diff, the human decision and who made it, the governance configuration, and the
    integrity state of both chains. The pack then commits to itself with a SHA-256 digest, so a
    recipient can detect a doctored copy. `GET /api/governance/evidence/:id`, plus `?format=html` for a
    **self-contained** document — no external stylesheet, script or font, digest printed on the page —
    that an auditor can read without ISL, without the network and without a build step. Generating a
    pack is itself audited.*
  **Two limits stated in the pack rather than hidden:** the governance snapshot is the configuration as
  of generation, NOT point-in-time (ISL does not version its gate config yet — that is the
  policy-as-code item), and the absence of a review record is reported explicitly as "landed without an
  explicit human decision" instead of being omitted.
  *Verified: 22 deterministic checks — chaining new rows, rewriting an actor breaking verification at
  exactly that row with the reason stated, restoring the value restoring verification, deletion also
  caught, pack self-verification, a doctored pack failing, the HTML carrying no external references and
  printing its digest, and an unknown iteration returning null rather than a half-built pack. Live: a
  real login chained (`user.login → b27f2a6b…`), and iteration #205's pack rendered to a 30 KB
  self-contained HTML with all seven sections.*
  **Found while building — literal NUL bytes in two source files.** `platformDb.js` had `\0` where the
  chain's field separator should have been a space: functionally consistent, hence invisible to the
  passing tests, but silently part of the hash input and enough to make the file read as *binary* to
  grep. A repo-wide scan then found the same hazard in `core/governance.js`, where `globToRe` parked
  `**` on a literal NUL between replace passes — legitimate as a technique, since NUL cannot appear in
  a glob, but an invisible control character in source. Rewritten as a single pass with an ordered
  alternation and **proved equivalent across 330 glob/path pairs** before replacing it. Both files are
  now clean, and a NUL scan over `src/` and `dashboard/src/` is part of the verification. The dev
  egress ledger was reset, since its one row had been hashed with the old separator.

- **P0 — Enterprise identity: RBAC + segregation of duties. ✅ (2026-07-25, SSO/SCIM outstanding)**
  ISL had two roles — `admin` and everyone else — and, far more seriously, **nothing stopped the same
  identity from proposing a change and then approving it**. The review queue's trust model assumed
  good faith, which is exactly the assumption an auditor rejects: a control the controlled party can
  satisfy alone is not a control. *Shipped: `src/platform/rbac.js`.*
  - ***Capabilities per role, scoped per project** — `viewer` / `operator` / `approver` / `owner` /
    `auditor`. Deliberately NOT hierarchical: `auditor` is not a weaker `owner` but a different shape
    — full read of the audit chain and evidence packs, **no `code.read` at all**, so an outside
    auditor can verify the controls without being granted access to the customer's source. Modelling
    roles as levels would have silently handed them the code. A user with no explicit grant is an
    `operator`, never an approver: approval must always be granted deliberately.*
  - ***Segregation of duties is separate from capabilities, on purpose.** `review.decide` says you may
    approve changes; it never says you may approve *this* one. Authorship is compared at the moment of
    the decision inside `decideReview` — not at the route — so no future caller can forget the check
    and no combination of role grants can be assembled into self-approval. A platform admin is `owner`
    everywhere (a single-operator install needs that escape hatch), and SoD still refuses them.*
  - ***The refusal throws rather than returning a soft failure**, because a self-approval that "didn't
    work" but returned normally reads as a bug and gets retried, when it is a control firing. HTTP
    **409**, not 403: the identity IS permitted to approve changes — just not this one. Rejection is a
    decision too, so an author cannot bury their own change either.*
  - *`authored_by` added to the review queue by migration; NULL means the autonomous loop originated
    it, which is the honest reading for every pre-existing row and correctly carries no conflict. An
    unidentified approver is refused outright rather than defaulting to `'operator'`, which would have
    made every anonymous approval indistinguishable.*
  - *`GET|POST|DELETE /api/governance/roles` (granting roles itself requires `roles.write`, so an
    operator cannot promote themselves), plus step-up staleness (`needsStepUp`) for high-consequence
    actions: a week-old session proves someone logged in a week ago, not that the person at the
    keyboard is them.*
  *Verified: 29 deterministic checks — auditors blind to source, approvers unable to grant roles,
  unknown roles refused at grant time, case/whitespace unable to evade the identity comparison,
  loop-authored work approvable by anyone eligible, and the author blocked from both approving AND
  rejecting. Then live over HTTP: a self-approval attempt returned **409** with the control named, the
  item **stayed pending**, and the refusal landed in the audit chain as
  `review.self_approval_denied` with the chain still verifying.*
  **Still outstanding: OIDC/SAML SSO and SCIM provisioning.** They are the remaining half of this item
  and are deliberately not stubbed — ISL is the *client* in an OIDC flow and the *server* for SCIM, and
  shipping either unverified against a real identity provider would be exactly the unearned assurance
  the rest of this wave exists to prevent. The RBAC model above is the prerequisite they plug into:
  group→role mapping targets `project_roles`, and SCIM deprovisioning targets `destroyUserSessions`.

- **P1 — Cost & capacity governance. ✅ (2026-07-25)** ISL burns model tokens and wall-clock time
  continuously, and per-role model overrides let an operator quietly point the expensive phases at an
  expensive model. Nothing measured it and nothing capped it: **health-gated autonomy governed quality,
  but no governor existed for spend.** *Shipped: `src/core/costMeter.js`, metered from the same choke
  point as the egress firewall (`ollama.chat()`), so a phase added later is accounted for by
  construction.*
  **The honesty decision that shapes the whole module:** on a local Ollama the currency cost is
  approximately zero, so a dashboard reporting "€0.00 spent" would be true and completely useless — the
  real constraint is TOKENS and TIME. Three resources are therefore metered unconditionally (calls,
  tokens, milliseconds) and **money is derived only where the operator configured a rate for that
  model**. Unpriced calls are counted and surfaced rather than treated as free, because a cost budget
  that looks unbreached while most traffic went to an unpriced model is not a reassurance — it is a
  measurement gap. A local model IS free; an unconfigured cloud model is *unknown*, and conflating the
  two is exactly how a budget silently never fires.
  - ***Failed calls are metered too.*** *They consumed tokens upstream, and a meter that counted only
    successes would under-report precisely when things are going wrong.*
  - ***Soft vs hard.*** *Soft warns and signals degradation to cheaper models; hard stops NEW
    iterations while letting in-flight ones finish — abandoning a run mid-flight leaves a half-applied
    change behind, a far worse outcome than one run's worth of overspend. A resumed run is always
    allowed through for the same reason. Both **off by default**: a control plane that refused to work
    on upgrade because of a guessed budget would be indefensible.*
  - ***Validation catches the typos that would disarm the control***: a hard cap below the soft one
    (making the warning unreachable), a negative cap, an unknown period.
  - ***Efficiency returns null, not zero, when the denominator is missing.*** *"We spent X and produced
    nothing measurable yet" is the honest answer; a division that manufactures a reassuring figure from
    no landed changes is not.*
  - *`GET /api/governance/cost` (state + forecast + breakdown by purpose and model + efficiency),
    `POST …/cost/budget`, `POST …/cost/rates`, both requiring `governance.write`.*
  *Verified: 22 deterministic checks — accumulation, failed calls counted, soft trips without stopping
  work, hard stops with the reason, inverted/negative/unknown budgets refused, a priced model producing
  an exact expected cost (2.70 EUR from a hand-computed rate) while the local model stays *unpriced*
  rather than free. Then live: a real Alfred call metered as **3,059 tokens over 70.3 s**, split by
  purpose and model, reported as 1-of-1 unpriced with the caveat text, and **765 tokens per landed
  change** against 4 real landed changes.*

- **P1 — Durable work queue + horizontal workers. ⚠️ (2026-07-28, three of four; the pipeline is
  still single-process)** Delivered as the three pieces that stand on their own, with the fourth
  named honestly as not done.
  - ***Idempotency — `src/iteration/idempotency.js`.*** This was a live defect, not a future concern.
    The engine wrote `status='committed'` roughly a hundred lines AFTER `moveBranch`, past the health
    snapshot, the review-queue enqueue, the PR publisher and the whole memory block. A process death
    anywhere in that window left a row still saying `running` for work that HAD landed — so the
    reaper called it interrupted and the salvage path would replay its diff and commit the same
    change twice. Fixed in four places: the status is now persisted immediately after the git write;
    the reaper refuses to claim a run that has a `commit_sha` (and records it as committed instead);
    the salvage query excludes one; and `assertNotAlreadyCommitted` refuses outright. *The key design
    point:* `[ai-iter#N]` alone is **not** a valid key — ids restart from 1 when a project database
    is recreated, and this repo's work branch already carries four such collisions (#66, #68, #71,
    #74, unrelated titles days apart). So the key is the id **and** the window: only a commit made
    after the run started counts as that run's work.
  - ***Durable queue + leader election — `src/core/workQueue.js`.*** Leases that EXPIRE (a worker
    that dies stops renewing; expiry is the protocol, and it is the one that survives being killed
    rather than asked to stop), at-least-once delivery with unique idempotency keys, bounded retries
    so a poison job dies rather than draining every worker, and role leases so exactly one process
    drives the loop. The loop now checks leadership before every tick — not hypothetical, since the
    supervisor restarts on a clean exit and a slow shutdown racing a fast restart puts two servers on
    one database and one work branch.
  - ***Project-stamped caches — `src/core/projectCache.js`.*** Correctness used to depend on
    `activateProject` remembering to call each module's invalidator, and that list was already wrong:
    `knowledgeIndex` was never on it, so a project switch served the previous project's documents and
    vectors for up to five minutes. A stamped cache refuses to answer for a project it was not filled
    under, so leakage is impossible by construction rather than by memory. `blastRadius`,
    `coverageRun` and `knowledgeIndex` were **converted**, not wrapped — the module-scope variables
    are gone.
  - ***Not done: stateless horizontally-scalable workers.*** The ten phases share a sandbox directory
    and a git worktree, so distributing them needs shared storage that does not exist here. The
    acceptance criterion "two workers double throughput" remains unmet. What did change is that the
    single-writer assumption is now **enforced** rather than hoped for, and killing a worker
    mid-iteration no longer risks a duplicate commit.
  *Verified by 42 checks: the duplicate-commit refusal and its deliberate non-firing on reused ids,
  lease claim/renew/expiry/hand-off, poison-job death, two processes racing one role, and a cache
  that never serves another project's value.*

  *Original problem statement:* The control plane is a single Node process holding
  module-level singletons — the blast graph, the coverage memo, the loop, the managers. This session had
  to invalidate two of them by hand on a project switch, which is the symptom, not the disease: one long
  iteration blocks the box, a crash loses in-flight work (the supervisor restarts the process, but the
  iteration is gone), and no second machine can share the load. Move iteration phases onto a durable
  queue with at-least-once delivery and **idempotency keys** (a retried phase must never produce a
  second commit), leader-elect the schedulers (loop, improvement windows, cron), and make workers
  stateless and horizontally scalable, leasing a project only for the duration of a step. Every cached
  singleton becomes request-scoped or a keyed cache with explicit invalidation — so cross-project state
  leakage becomes structurally impossible instead of a bug to remember. *Acceptance: killing a worker
  mid-iteration resumes it elsewhere with no duplicate commit; two workers double throughput across
  independent projects; a project switch cannot leak another project's cached state.*

- **P1 — Public-contract diff gate. ✅ (2026-07-25)** The existing vetoes catch what the **tests** can
  see. A refactor that renames an exported symbol, drops a route, or removes a database column passes a
  fully green suite and breaks consumers downstream. `blastRadius` names the callers *inside* the repo;
  nothing at all protected the consumers outside it — and those are the ones that page someone at 3am.
  *Shipped: `src/iteration/contractDiff.js` — a deterministic snapshot of the public surface (HTTP
  routes and their mount prefixes, exported module symbols across JS/TS/Python/Go, Prisma models with
  field types AND optionality, enums, GraphQL types), diffed between two commits and classified.*
  - ***Ambiguity always resolves to the HIGHER severity.** A gate that under-reports is worse than
    useless: it converts "we didn't check" into "we checked and it was fine". So a NEW REQUIRED column
    is breaking (every existing writer fails), and optional→required is breaking (writes that used to
    succeed now get rejected — no happy-path test sees it). Dropping a column, table or enum value is
    breaking regardless of trust: those are the irreversible migrations.*
  - ***A removed mount prefix is its own finding**, because it relocates every route beneath it at once
    and is invisible in a per-route diff.*
  - ***Declared breaking changes are surfaced, not blocked.** Deliberately breaking an API is
    legitimate; doing it silently is not. `contractVerdict` forces review only when the breakage was
    undeclared, and the reason says "UNDECLARED" so an approver knows which they are looking at.*
  - *It reads source text rather than booting the app — a contract gate that needed the target's server
    to start would be unusable on exactly the polyglot repos ISL exists to manage. Wired into
    `classifyChange` (tighten-only, like policy), plus `GET /api/contract` and `GET /api/contract/diff`.*
  *Verified against the target application's REAL surface — **every route and mount prefix it
  serves, every exported module symbol, and every Prisma model it declares** — with 24 checks that
  break that real surface synthetically: removed route, removed export (with the rename correctly
  split into breaking + additive), dropped column, optional→required, new-required vs new-optional,
  dropped table, removed mount, and a purely additive change producing zero breaking findings.*
  **Two bugs found by running it for real, both worth the trouble.**
  1. *The first live run reported **every route in the codebase as "new" and 0 breaking changes** —
     a clean bill of health produced by comparing against **nothing**. Root cause: `scanFiles({ root
     })` only half-honoured its own parameter, relativising every emitted path against a hardcoded
     `REPO_ROOT`, so scanning any other checkout (a sandbox worktree at the base commit) produced
     `../../..` paths that resolved nowhere and silently yielded zero files. Fixed at the source —
     `walk` now takes the base it is relativising to — which also un-breaks `scanCoverage({ root
     })`, latently broken the same way.*
  2. *That failure mode is now **refused rather than reported**: an empty base surface against a
     non-empty head returns `ok: false` with the reason, because "the entire codebase is new and
     nothing broke" is the single most dangerous output a gate can produce.*
  *After the fix, the diff of the target application's working tree — the whole test-healing
  session, 25+ files including three production fixes — against HEAD is **0 breaking / 0 behavioural
  / 0 additive**, which is exactly right: none of it touched a route, an export or a column. Health
  index, structural, coverage, impact and frontend-audit all re-verified unchanged after the
  `scanFiles` fix.*
  **Honest gap:** the target application's schema encodes enums as `String` with a comment, so the
  enum path is implemented and unit-tested but has no real data to exercise here.

- **P1 — ISL self-evaluation harness. ✅ (2026-07-25, deterministic gates)** Models, prompts and gate
  thresholds were changed by judgement. There was **no way to answer "did that make ISL better?"** —
  the only feedback was the land rate, which moves for a dozen unrelated reasons. *Shipped:
  `src/core/evalHarness.js` — freeze a set of REAL past changes, replay them through the deterministic
  gates under a candidate configuration, and report what moved.*
  **Two limits are stated in every result rather than papered over:**
  - ***Only the deterministic gates are replayed*** *(security, safety, change-size, policy, review
    classification). They are pure functions of a diff and a config, so replay is exact and free. The
    LLM phases are not: replaying them needs real model calls, costs real money, and would not be
    reproducible anyway. A harness that scored them from stored text would be measuring its own fiction.*
  - ***Agreement is only as strong as the labels.*** *A verdict counts as labelled only where a human
    actually decided — `auto` is a machine decision, and treating it as ground truth would score the
    gates against themselves. This project has **3** labelled cases, so the harness reports
    `underpowered: true` and says to use the stability comparison instead, rather than printing a
    percentage computed from three samples.*
  **What IS reliable with no labels at all is verdict STABILITY**: replay every stored diff under
  baseline and candidate and count how many verdicts flip and in which direction. A flip toward
  *permissive* — held becomes auto — is the dangerous direction and is reported separately.
  `safeToPromote` is true only when nothing loosened; the harness declines to make any judgement call
  beyond that, because the rest belongs to a human.
  *Verified on ISL's real history — **75 stored diffs → 175 evaluations** — with 16 checks including
  the acceptance criterion: raising the size thresholds to absurd values produced **12 loosened
  verdicts** and `safeToPromote: false` with "REGRESSION RISK" named; tightening them produced 37
  tightened and 0 loosened; an unchanged config flipped nothing.*
  **A design bug the acceptance test caught, and the reason it was worth writing.** The first version
  defaulted unknown agent trust to `probation`, which always holds — so the size thresholds never
  applied to the ~50 cases with no recorded trust, and the harness reported **0 flips for a config
  change that clearly loosens**. A harness silently blind to the knob it exists to evaluate is worse
  than none. Fixed by removing the assumption entirely: a case with recorded trust replays at that
  trust (ground truth), and one without replays at **every** level, with a config counting as loosening
  if it loosens under any of them — the only assumption-free reading, and the strictly safer one.
  *`GET /api/governance/eval`, `POST …/eval/freeze` (explicit, so a set cannot move under you and make
  two scorecards incomparable), `POST …/eval/compare`.*
  **Outstanding:** shadow mode for the LLM phases, which needs the live-call budget the cost meter now
  makes measurable.

- **P1 — DORA metrics + post-deploy guardrail with auto-revert. ✅ (2026-07-28)** ISL measured its own
  gates but never learned whether a change **hurt production**: promotion was the last step, and then
  the loop forgot.
  *Shipped: `src/deploy/dora.js`.* Every `promoteToMain` now records a deployment — recorded inside
  the function rather than on the `deploy.promoted` event, because a listener that misses the event
  loses the deployment silently and the bake window would never open. Commit authorship is read from
  the commit itself (`Co-Authored-By: ISL Agents`, the `[ai-iter#N]` subject and the `agents …×n`
  segment of the Provenance line — the format `engine.js` actually writes), so ISL and human change
  are measured the same way and the comparison is reported whichever way it comes out.
  A **bake window** then watches three locally-real signals — recorded error events as a RATE against
  the pre-deploy hour, anomalies opened since, and the health index — and a breach opens a revert
  proposal with its evidence, writes an agent-scoped pitfall, and docks that agent's trust in
  `trust.js` (one breach caps latitude, two force probation). Executing the revert rather than
  proposing it needs `doraAutoRevert`, a separately-named standing authorisation that is off by
  default.
  *The honesty rule that shaped it:* ISL has no production telemetry, so a window that could read
  **nothing** closes as `unobserved`, never as `clean`, and is excluded from the change-failure-rate
  denominator instead of counting as a success. Building this surfaced a real trap — `computeHealth()`
  does not throw on an unreadable checkout (its divisors are guarded with `|| 1`), so it returns a
  plausible score computed from zero files; `readHealth()` now requires the scan to have seen source
  files before its number counts as a signal. *Verified by 40 checks over a real git repository with
  real commit messages: authorship and agent attribution, the unobserved-never-clean rule, breach
  detection, proposal-by-default, the executed revert leaving the operator's checkout untouched, and
  trust demotion.*
  *Still open:* the signals are the local ones. Wiring a real APM/error-tracking feed into
  `evaluateSignals` is the upgrade that makes the change-failure rate a production number rather than
  a repository-health one — the module is shaped for it (one function, one evidence contract), and
  until it exists the `unobserved` state is what keeps the metric honest.

---

## 11. Phased roadmap

**Now (make it trustworthy & real):**
strong-model support · type-check/compile + coverage/mutation gates · SAST + secret-scanning ·
prompt-injection & harmful-change guardrails · PR-native output + CI-as-a-gate · objective
benchmark harness. *These turn ISL from "interesting" into "safe to point at real code".*

**Next (make it universal & collaborative):**
per-language verification adapters + LSP · Postgres + job queue + sandboxed execution ·
goal-setting & review-first modes · multi-tenant isolation & RBAC · incremental analysis &
caching · issue-tracker + IDE integration.

**Later (make it useful to everyone):**
open-source & one-command self-host · modest-hardware/CPU path · platform i18n & accessibility ·
continual learning that compounds · programmes for critical open-source · public transparency &
impact reporting.

---

## 12. Guiding principles

1. **Safety over autonomy.** When unsure, ask a human. Never trade a security control for a task.
2. **Evidence over assertion.** A change ships with proof it helped and didn't break anything.
3. **Universal by default.** Any language, any budget, any team size — not just the well-funded.
4. **Transparent & explainable.** Anyone affected can understand what changed and why.
5. **Amplify people.** The goal is to free maintainers to do the work only humans can, not to
   sideline their judgement.
6. **Do no harm.** ISL exists to make software safer, more reliable and more accessible — and
   must refuse to do the opposite.

---

## 13. Top risks & how to mitigate

| Risk | Mitigation |
|------|-----------|
| Confidently-wrong changes land | Deterministic gates (compile/coverage/mutation/CI) that an LLM score can't override; graded autonomy; PR review. |
| Prompt injection from the target repo | Treat all repo content as untrusted data; tool/scope allow-lists; egress review; secrets never in prompts. |
| Malicious use (backdoors, malware) | A safety-reviewer veto; refusal policy; audit + signed commits; kill-switch. |
| Noise that overwhelms maintainers | Rate-limited, batched, well-explained PRs; review-first mode; quality gates before anything is proposed. |
| Cost/energy blow-ups at scale | Incremental analysis, caching, right-sized models, per-project budgets, footprint reporting. |
| Benefits only the well-resourced | Open source, self-host, CPU/small-model path, programmes for critical open-source. |
| "Improvement" that isn't real | Outcome metrics + benchmarks + before/after evidence, independently auditable. |

---

*The measure of success is not how many commits ISL makes, but whether the software the world
depends on becomes measurably safer, more reliable and more accessible — for everyone, not just
those who can afford it.*
