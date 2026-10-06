# ISL_Frontend_improvement — Making the dashboard great

> Companion to [ISL.md](ISL.md) and [ISL_IMPROVE.MD](ISL_IMPROVE.MD). This document is the
> roadmap for the **dashboard frontend** specifically: the React app in `dashboard/` that
> operators use to watch, steer and trust ISL.

ISL's agents check other codebases for accessibility, performance and UX defects. This dashboard is
subject to the same checks, and has failed them: unnamed form controls, index keys, missing focus
states, an unaudited contrast ratio. Each item below names the defect and how it was measured.

---

## 0. Frontend baseline — what we have today

> **Before proposing anything.** Check the item against what is here. Five constraints hold, and
> each exists because breaking it has already cost something measurable:
>
> 1. **One cache key, one endpoint.** `useResource` caches by key across the whole app; the same key
>    with two fetchers means whichever mounts first wins. This has crashed a page twice
>    (`deployments` held a number in one place and an array in another; `health` was two different
>    endpoints). `resourceKeys.test.js` enforces it.
> 2. **Prefer a tab to a page.** The nav is 30 entries after folding eight pages into five tab
>    shells. A new page needs to answer a question none of the existing ones does.
> 3. **Never assume an API shape.** Read fields defensively and normalise. `detected.ollama.models`
>    (the real shape was `detected.models`) shipped an always-empty list; `claims.selectable.features`
>    blanked a whole page.
> 4. **Tailwind cannot generate a class built at runtime.** `bg-${tint}-500/15` is never emitted —
>    it scans source text. Write whole class strings.
> 5. **The build resolves nothing.** A component or hook used but never imported compiles fine and
>    throws when the page opens. Run `npx vitest run` before believing a change works.

- **Stack:** React 18, Vite 5, Tailwind CSS 3 (+ PostCSS/autoprefixer). No component library —
  a small custom kit in `components/ui.jsx` (Empty, Spinner, `ago`, SeverityPill, pills, cards,
  stats) and `components/charts.jsx`. Hash routing via `useHashRoute`, with `merged.js` resolving a
  route to `{page, tab}` so pages folded into tabs keep their old URLs. A lightweight store hook +
  a WebSocket event feed. Alfred chat. ~35 view modules under `views/`, reached through 30 nav
  entries. 355 tests across 29 files.
- **Strengths:** dark-first, coherent visual language, a real event stream, an admin-configurable
  menu, an accent-token system, a command palette, and recently `.page-title/.page-sub` utilities
  and a shared `nav.js`.
- **Honest gaps** *(revised 2026-08-08 — several of the originals are now closed, and an item
  planned against a description that no longer matches the code is how a "fix" becomes a
  regression):*
  - **Still open — no TypeScript, and no linter.** Frontend tests now exist (355 across 29 files,
    vitest + testing-library), but nothing resolves identifiers at build time. That gap has produced
    three shipped crashes; `undefined-refs.test.js` covers the two narrow cases with no false
    positives (JSX components, hooks), and a real linter would cover the rest. **Highest-value
    remaining item in this document.**
  - **Closed — bundle.** Every view is a lazy chunk via `lazyView` (which reloads the page on a
    stale-chunk error instead of leaving a dead view). The entry bundle is ~240 KB / 77 KB gzipped.
  - **Closed — polling.** `useResource` with shared cache keys plus `liveKeys.js` mapping WebSocket
    events to the keys they invalidate. Per-view `setInterval` has been replaced by a long
    safety-net interval. One rule this created and a test now enforces: **one cache key, one
    endpoint** — the same key with two fetchers has crashed a page twice (`deployments`, `health`).
  - **Mostly closed — states.** `Resource` gives loading / empty / error one shape; `ErrorBoundary`
    contains a crashing view. Not every panel has been converted.
  - **Partly closed — accessibility.** Focus traps in all four overlays, a live announcer, roving
    tabindex in the tab shells, keyboard-operable filters, and a per-view axe audit in the test
    suite. **Contrast is still unproven**: it cannot be measured in jsdom and needs a real browser.
  - **Still open — desktop-only layout.** Tables and multi-column grids do not degrade for small
    screens.
  - **New, and worth stating.** The nav is 30 entries, five of which are tab shells over previously
    separate pages. Any proposal that adds a page should first ask whether it is a tab: the merge
    exists because 38 entries had made related things hard to follow.

The rest of this document is the map, in pillars, each with *why it matters*, *concrete
improvements*, and a *priority*.

---

## Implementation log (live)

*Appended every iteration; `✅` = shipped & verified in the running dashboard.*

### Iteration F17 — Nothing on screen may read "NaN" (Pillar 6) ✅
`Compliance` displayed **"Last run NaNd ago"**. `Date.now() - undefined` is NaN, every comparison
against NaN is false, so `ago()` fell through to its last line and printed a broken number where the
honest answer was "never". There are **29 call sites across 22 files**, any of which an endpoint with
nothing to report yet can hand a null timestamp — so the guard belongs in `ago()`, once, not at each
caller. A future timestamp (clock skew between server and browser) now reads "just now" instead of a
negative age.

*Shipped: a sweep test over all 30 views* asserting that no rendered text contains `NaN`,
`undefined`, `null` or `Invalid Date`. React renders `undefined` as nothing, so any such text can
only come from a **template literal** — which is precisely where a missing field escapes every other
check: the page renders, the accessibility audit passes, and the words are simply wrong.

*What the sweep actually caught, stated honestly:* five hits, and **all five were errors in my own
fixtures, not in the views**. `codeStats` really sends `totalFiles`/`totalLines`; `metrics.runs` is
an **object**, and the generic fixture's `runs: []` was shadowing it; runtime log lines are
`{ts, line, level}` objects, not strings; `summaryCommits` carries a `totals` block; coverage reports
`criticalCoverage`. Each was checked against the server before touching anything — otherwise the
"fix" would have been to break five correct views to match five wrong stubs.

The `ago()` defect was real and is fixed with its own tests. The sweep's lasting value is that the
next missing field to reach the screen fails a test instead of shipping.
*170 dashboard tests pass.*

### Iteration F16 — Accessibility measured on the real pages (Pillar 2 P0, Pillar 12) ✅
`components/a11y.test.jsx` ran axe over three shared components — `PageHeader`, `Empty` and a button
row. They passed, and always would: they were written for the test. **The pages an operator actually
looks at had never been audited**, so "the dashboard is accessible" rested on three components that
are a fraction of it.

*Shipped: `views/views.a11y.test.jsx`* — axe against eight whole views, on the rules that decide
whether a page works without a mouse or with a screen reader. Contrast is **excluded and said so**:
jsdom has no layout engine, so a green contrast result there would be meaningless.

*Two false greens had to be beaten out of it first, and both are worth recording:*
- The first version rendered and audited immediately. `render` is synchronous and the resource
  resolves a tick later, so axe was auditing the **loading skeleton** — no controls, therefore no
  violations, eight green ticks meaning nothing. It now waits for the skeleton to go.
- The stubs returned empty arrays, so tables and row actions never rendered. The test now asserts
  each view produced **at least one interactive control** before trusting the audit, and the stubs
  mirror the real server shapes (`services/inventory.js`, `cloudDetect.js`) field for field.

*Three real violations found and fixed:*
- `Runtime` — the compose-file `<select>` had **no accessible name**; a screen reader announced a
  combo box and nothing about what it chose.
- `Summary` — the per-commit checkbox had **no label**, so the selection control that drives the
  whole page was unusable non-visually.
- `Scope` — the enforce toggle is `role="switch"`, and `aria-checked={form.enforce}` **disappears
  entirely** when the field is absent, leaving a switch with no state: worse than a plain button,
  because it claims a role it cannot fulfil. Now `{!!form.enforce}`.

*Then extended from 8 views to 19*, which surfaced **18 more real violations** — and needed the
fixtures to be right first, because a view that crashes on a missing field renders nothing, and an
audit of nothing always passes:
- `KPI` — the five weight sliders and both number inputs had **no accessible name**. The labels were
  visible text in sibling elements, which associates nothing: a screen reader read seven unnamed
  controls that set how the fleet grades its own work.
- `Memory` and `Logs` — the scope and source `<select>`s had no name.
- `Fleet` — `<Toggle aria-checked={checked}>` receives `enabled` **from SQLite as `1`**, and React
  renders that verbatim as `aria-checked="1"`, which is not a valid ARIA value. Every agent's
  enable/disable switch had no state at all as far as a screen reader was concerned — the same class
  of bug as `Scope`, found twice, so it is a pattern rather than a slip.

*Two structural things fell out of it.* The stubs are now one shared `test/fixtures.js` — the smoke
test and the audit had their own copies, and two copies of a response shape drift until the *test*
fails for a reason unrelated to the code, which teaches whoever is on call to loosen the assertion.
And the audit distinguishes read-only views (`Plans`, `Telemetry`: cards and charts, no controls)
from interactive ones, asserting content rather than controls — demanding a button from a page that
correctly has none is the assertion being wrong, not the page.

*Then finished the fixtures*, taking the audit from 19 views to **27**. No further violations
surfaced — the eight added views were clean once they rendered — but getting them to render meant
mirroring eight more response shapes, and each mismatch was itself worth knowing:
`api.contextDocuments()` returns a **bare array** (the stub was wrapping every response in an
object, silently turning a list into something with no `.map`); `codeStats.byLanguage` is a **list**
of `{name, pct}` where the views filter it but a **keyed object** inside the context response — same
field name, two shapes, only one with `.filter`; `compliance.byLanguage` is a third shape again
(`{language, violations, severe}`); and `Health` calls `api.healthIndex()`, a different endpoint from
the `/api/health` the top bar reads.

*Verified: 128 dashboard tests pass, production build clean.*
**Scope, stated:** 27 of 36 views audited. `Compliance`, `Health` and `Reliability` render nothing
under the shared fixture even with their endpoint shapes present — something further in their state
machine needs feeding before an audit would be looking at the real page, and they are named in the
test file rather than dropped silently. `Admin`, `Governance`, `Projects` and `Settings` are gated on
a live session; `Workbench` and `Flow` run off the event stream.

### Iteration F15 — One answer for loading, empty and failed (Pillar 6, P0) ⚠️ (9 of 36 views)
Measured before: 26 views spun a `Spinner`, 19 had an `Empty`, **`Skeleton` existed in `ui.jsx` and
no view used it at all**, and failure handling ranged from a toast to a silent `.catch(() => {})`.

The silent catch is the one that matters, and F14 briefly made it worse: converting the polling
views to `useResource` dropped a `.catch` in `Runs.jsx` that had raised a toast, turning a reported
failure into an invisible one. A panel that renders nothing because the request failed looks exactly
like a panel that renders nothing because there is nothing to show — and the second is fine while
the first is a server the operator needs to know about.

*Shipped: `src/components/Resource.jsx`* — one component for all three states, taking a
`useResource` result directly. Error is checked **first**, including when stale data is still on
screen: numbers that stopped being live are worse than no numbers, because they look fine. Loading
renders a **skeleton** (finally adopting the component built in F7), and only on the first load — a
background refresh must not blank out a page the cache just painted. Empty treats `null`/`[]`/`{}`
as empty but **not** `0` or `""`, which are real values a system can legitimately report.
Adopted in the nine sites F14 converted, and every `useState`/`useRef`/`Spinner` import the two
iterations left dead was deleted.

*Then extended:* four more views converted (`Cloud`, `Compliance` — both panels — `Summary`,
`Scope`), taking the cache from 7 views to **18 of 36**, with **9** on the shared three-state
component. `Scope` now shares one cached copy with the top bar instead of both fetching it, and the
best-practices list is keyed by language so switching the filter paints from cache.

*A bug this shipped, and the guard that now catches it:* converting `Compliance` to a keyed resource
removed its `load()`, but a `<select onChange>` still called it — it would have thrown the first time
an operator changed the language filter. Nothing caught it: the build only checks syntax and the
project has **no linter**. So `views/converted.smoke.test.jsx` now renders every converted view
against a mocked API whose stubs mirror the **real** response shapes, plus one render against a
rejecting API asserting the operator sees an alert rather than an empty board. A dangling identifier
after a refactor is a runtime error, and this is what turns it into a failing test.

*Honest scope:* **18 of 36 views** on the cache, **9** on `Resource`. The rest still fetch by hand.
*Verified: 101 dashboard tests pass (22 new), production build clean.*

### Iteration F14 — Event-driven data, not polling (Pillar 3 P0, Pillar 7 P0) ✅
F4 shipped a shared SWR-style cache with WebSocket-driven invalidation, and adoption had stalled at
**7 of 36 views** — while eight other views and three widgets each ran their own `setInterval`
regardless. The iteration detail refetched a whole run **every 3 seconds**; the runtime every 4;
four more every 5. Roughly **5,520 requests an hour** with the dashboard merely open and nothing
happening — to learn "unchanged" almost every time, while the server was already pushing the truth
down a socket the page had open.

*(An earlier draft of this entry said no view used the cache at all. That was wrong: it came from
grepping for `useQuery`, a hook name this codebase never had. The polling figures below were counted
from the `setInterval` sites directly and stand.)*

*Shipped:* **`src/liveKeys.js`** — one table mapping each event type to the resource keys it makes
stale, because an event and the data it invalidates are one fact and splitting that across eight
views is how the two drift apart. `App.jsx`'s hard-coded two-event / three-key `if` chain was
**replaced** by it (and now reads only the newest event: a burst arrives as one batched store
update, and walking the buffer would invalidate the same keys dozens of times). Then ten fetch sites
were converted to `useResource`: Iterations, Runtime, Runs, Backlog, Explorer, Services, Context,
HealthWidget and TopBarInfo (×2). Every dead `useState`/`useRef` they left behind was deleted.

*Deliberately left alone:* `ActivitySpotlight`'s 1-second timer is a **clock** for elapsed time, not
a fetch; the bisect and context-build timers poll a long job's progress, which no event announces
per step. Converting those would have been change for its own sake.

*The safety net stays* — a dropped socket must degrade into a stale-but-eventually-correct page, not
a frozen one — but at 20–60s instead of 3–6s, and a test asserts it can never drift back into
polling range. *Verified: 79 dashboard tests pass (7 new, covering the mapping, malformed events off
the socket, and the wildcard shape a silent typo would break), production build clean.*
**5,520 → 840 requests/hour, an 85% reduction**, and updates now land the instant they happen
instead of up to six seconds later.

### Iteration F1 — Route code-splitting (Pillar 3, P0) ✅
All ~30 views converted to `React.lazy` + a `<Suspense>` boundary in `App.jsx`. *Verified: the
build now emits 31 separate chunks and the initial bundle dropped from **~408 KB to ~207 KB**
(~half); views load on demand; the app still renders.* — closes §3 "code-split by route".

### Iteration F2 — Accessibility baseline (Pillar 2, P0) ✅
Global `:focus-visible` rings (already present, kept), a `prefers-reduced-motion` block that
disables animations/transitions/shimmer, a **skip-to-content** link, `id="main"` + `tabIndex=-1`
on the content region, `aria-current="page"` + titles on the active nav item, and `aria-live`
on the toast region. *Verified: build clean, app renders.* — advances §2 (keyboard/focus/ARIA).

### Iteration F13 — Route error boundary (Pillar 4, P1) ✅
`components/ErrorBoundary.jsx` wraps the routed views (`key={view}` = fresh per view). A crash in
one view — a bad render, an unexpected API shape, LLM data rendered as a child — now shows a
friendly "this view hit an error + Reload" instead of blanking the whole app; navigating away
clears it. *Verified: 2 tests (renders children; catches a throwing child → shows the alert +
reload); **20 tests total**.* Directly contains the class of failure that first motivated the
`str()` coercion. — closes §4 "standard error surface / ErrorBoundary per route".

### Iteration F12 — Internationalisation (Pillar 9, P1) ✅
`src/i18n.js` — a `t(key)` lookup over **en + it** dictionaries, a persisted reactive locale
(`useLocale`), and graceful fallback (locale → English → key). Added a **language toggle** to the
header (EN/IT) and translated the nav group titles + skip link + toggle labels. *Verified
in-browser: toggling flips the nav from "Workspace/Improve/Fleet/Deploy" to "Spazio di lavoro/
Migliora/Flotta/Rilascio" live; 3 i18n tests pass (18 total).* — closes §9 "i18n the platform UI"
(v1); next: extract the remaining view strings.

### Iteration F11 — Coverage for the fragile logic (Pillar 12) ✅
Added `nav.test.js` (dashboard-config: hides items, applies custom labels, protects the
unhideable ones, drops empty groups) and `hooks.test.jsx` (useResource: fetch, **in-flight
dedup**, instant cache paint, and **live `invalidateResource` refetch**). *Verified: **15 tests
pass** across 4 files.* The nav-customization and data-cache logic — easy to break silently — is
now guarded, and the tests double as proof the WS-invalidation from F7 actually works.

### Iteration F10 — Automated accessibility checks (Pillars 2, 12) ✅
Added **axe-core** (`vitest-axe`) to the harness and an `a11y.test.jsx` that asserts the shared
components (PageHeader, Empty, a labelled form) have **no WCAG violations**. *Verified: `vitest
run` → **8 tests pass** (5 component + 3 axe).* Accessibility is now enforced automatically, not
just by hand. — advances §2 (a11y) + §12 (axe in CI). *(jsdom can't run color-contrast — a known
harmless warning; the assertions still pass.)*

### Iteration F9 — Frontend test harness (Pillar 12, P0) ✅
Installed Vitest + Testing Library + jsdom, added `vitest` test config (`src/test/setup.js`), a
`npm test` script, and a first component test suite (`ui.test.jsx`). *Verified: `vitest run` →
**5 tests pass** (PageHeader, Empty, SeverityPill, Skeleton, ago); production build unaffected.*
A change that breaks a component now fails the test run instead of the operator's screen. — closes
§12 "frontend tests" (v1); next: component tests per view + axe a11y assertions in CI.

### Iteration F8 — Memory view on the cache + shared header (Pillars 4, 1) ✅
Migrated the Memory view off `useState + setInterval` to `useResource` (instant paint + 8s
background refresh; mutations refetch via the returned `refetch`) and gave it the shared
`PageHeader`. *Verified in-browser: renders with the 🗃 header and cached data.* — three views now
on the cache (Security, Decisions, Memory).

### Iteration F7 — Live cache invalidation + shared components (Pillars 4, 7, 1) ✅
`useResource` now supports **WebSocket-driven invalidation**: mounted views subscribe, and
`invalidateResource(key)` (exact or `prefix:*` wildcard) refetches them the instant something
changes — App wires `iteration.finished`/`manager.brief` events to invalidate `decisions`,
`security:risk`, `runs:*`, so the UI is *live, not polled*. Added shared **`PageHeader`** and
**`Skeleton`** components to `ui.jsx` and adopted `PageHeader` in the Security view. *Verified:
build clean, Security renders via the shared header, 0 console errors.* — advances §4 (WS
invalidation) + §1 (component kit) + §7 (live updates).

### Iteration F4 — Shared query/cache hook (Pillar 4, P0) ✅
`useResource(key, fetcher, {interval})` in `hooks.js` — a small SWR-style hook with a module
cache (instant paint on revisit), in-flight dedup, background refresh and `{data, loading, error,
refetch}`, plus `invalidateResource`. Migrated the Security and Decisions views off the
per-view `useState + setInterval` pattern. *Verified: build clean, views render from cache.* —
advances §4 "query/cache layer".

### Iteration F5 — Accessible ConfirmDialog (Pillar 6, P2) ✅
`components/ConfirmDialog.jsx` `useConfirm()` — a promise-based modal replacing `window.confirm`:
focus moves to the confirm button, Escape/backdrop cancel, `role="dialog"` + `aria-modal`. Wired
into the Runs board's **Restart all** and **Clear all**. *Verified: build clean.* — closes §6
"confirmations for destructive actions".

### Iteration F6 — Responsive shell (Pillar 5, P0) ✅
The sidebar is now a slide-in **drawer on small screens** (hamburger in the header, backdrop,
closes on nav) and **static on desktop** (`lg:` breakpoint). *Verified in-browser: at 375px the
sidebar is off-canvas + hamburger shows + tap opens it; at 1280px it's static + hamburger hidden.*
— closes §5 "make the shell responsive".

### Iteration F3 — Security & Safety view (Pillar 11, P0) ✅
New lazy view `views/Security.jsx` (🔒 Security in the Fleet menu) surfacing the deterministic
gate: unsafe changes blocked, recent findings (with severity/kind/file), the active veto list,
and an "all clear" empty state. Backed by the Risk manager's brief (`gateFindings`/`gateVetoes`
now published). *Verified live in the browser: renders with stats + veto list.* — closes §11
"Security & Safety page".

---

## 1. A real design system

*Consistency is what makes a dense enterprise UI feel calm instead of chaotic.*

- **P0 — Token layer.** Formalise design tokens (color, spacing, radius, typography scale,
  elevation, motion) as CSS variables + a Tailwind theme, three layers (primitive → semantic →
  component). Today accents are ad-hoc; centralise them.
- **P0 — Componentise the repeated patterns.** Promote the recurring shapes — `Card`, `CardHead`,
  `StatTile`, `Pill`, `Table`, `Toolbar`, `PageHeader`, `Tabs`, `Field`, `Toast`, `ConfirmDialog`,
  `EmptyState`, `Skeleton` — into one documented kit and use them everywhere (many views hand-roll
  these today).
- **P1 — A shared `PageHeader` on every view** (title + one-line description + actions), using the
  new `.page-title/.page-sub` — several views already do, make it universal.
- **P1 — Consistent density & rhythm.** One spacing scale, one table style, one card style; kill
  the one-off paddings.
- **P2 — Consider shadcn/ui (Radix + Tailwind)** for accessible primitives (dialog, dropdown,
  tooltip, popover, tabs) instead of hand-rolling — huge a11y win for little cost.

## 2. Accessibility (WCAG 2.1 AA) — practise what we preach

- **P0 — Keyboard-first.** Every interactive control reachable and operable by keyboard; visible
  focus rings everywhere (not just where Tailwind defaults land); logical tab order; skip-to-content.
- **P0 — Semantic markup + ARIA.** Real `<button>`/`<a>` (no div-as-button), `<nav>/<main>/<h1..>`
  landmarks, labelled form fields, `aria-live` for the toast + event feed, `aria-current` on the
  active nav item, table headers associated with cells.
- **P0 — Focus management.** Trap focus in modals/dialogs, return focus on close, move focus to new
  content on route change, `Esc` closes overlays (the command palette and Alfred especially).
- **P1 — Contrast & color independence.** Audit every text/background pair to ≥ 4.5:1; never encode
  state in color alone (add icon/label to the status pills).
- **P1 — Reduced motion.** Honour `prefers-reduced-motion` for the spinners, shimmer and
  transitions.
- **P1 — Screen-reader pass.** Announce iteration/phase changes, run outcomes, and "gate blocked"
  events meaningfully; label icon-only buttons (export, pin, delete).

## 3. Performance

*An operator watching a live loop needs the UI to be instant and not thrash.*

- **P0 — Code-split by route. ✅ (F1)** `React.lazy` + Suspense per view so the initial bundle is
  small; the 400 KB monolith becomes a fast shell + lazy pages. *Shipped: 31 chunks, bundle ~half.*
- **P0 — Replace per-view polling with the WebSocket.** The app already has a live event bus; drive
  updates from it (invalidate/patch cached data on the relevant event) instead of N independent
  `setInterval`s. Keep a slow poll only as a fallback when the socket is down.
- **P1 — Memoise & virtualise.** `useMemo`/`useCallback` on derived lists; virtualise long lists
  (Logs, Memory, Audit, big tables) so thousands of rows don't render at once.
- **P1 — Debounce & batch.** Coalesce rapid event bursts (token streams, wave events) into batched
  state updates to avoid render storms.
- **P2 — Asset budget & analysis.** Add a bundle-size check to the build; lazy-load charts.

## 4. Data & state layer

*Per-view fetch+poll+useState is the source of most flicker, staleness and duplicated code.*

- **P0 — A query/cache layer. ✅ (v1, F4)** (TanStack Query or a small SWR-style hook): one cache
  keyed by endpoint, dedup in-flight requests, background refetch, `isLoading/isError/data` for free,
  WebSocket-driven invalidation. *Shipped: `useResource` hook (cache + dedup + interval) adopted in 2
  views. Next: migrate all views + WS-driven invalidation.*
- **P1 — Optimistic updates** for actions (approve/reject, pin memory, dismiss run, set goal) with
  rollback on failure, so the UI feels immediate.
- **P1 — Standard error surface. ✅ (F13)** One `ErrorBoundary` per route + a consistent inline
  error/retry component; the API client already normalises errors — surface them uniformly. *Shipped:
  per-view ErrorBoundary with a friendly fallback + reload. Next: a shared inline error component.*
- **P1 — Safe rendering of model output.** The `str()` coercion (LLM arrays/objects rendered as
  children) should be a shared helper used everywhere LLM data reaches JSX, plus sanitisation of any
  HTML/markdown Alfred renders.

## 5. Responsive & adaptive layout

- **P0 — Make the shell responsive. ✅ (F6)** Collapsible sidebar → drawer on small screens; the
  top bar, Alfred and the palette should work on a tablet. *Shipped: hamburger + drawer + backdrop
  under `lg:`, static sidebar above.*
- **P1 — Tables that degrade.** Horizontal scroll containers (started) everywhere, and a card/list
  fallback for the densest tables (Decisions matrix, Admin DB rows, Iterations) on narrow viewports.
- **P2 — Density toggle.** Comfortable/compact modes for different screen sizes and tastes.

## 6. UX polish & flow

- **P0 — Consistent loading/empty/error states** across all ~30 views (skeletons over spinners;
  helpful empty states that say what to do next).
- **P1 — Confirmations for destructive/outward actions** (restart-all, clear-all, change source
  folder, promote, delete user) — a shared `ConfirmDialog`, not `window.confirm`.
- **P1 — Keyboard shortcuts + a better command palette** (jump to view, run iteration, toggle loop,
  open Alfred), with a discoverable `?` cheatsheet.
- **P1 — Better feedback.** Toasts with actions (undo), progress for long tasks (build context,
  compliance check, research), and inline validation on forms.
- **P2 — Breadcrumbs / context** so a deep view (an iteration detail, a proposal) shows where it sits.

## 7. Real-time experience

- **P0 — A single resilient socket layer** (reconnect/backoff exists) that fans events out to the
  cache and to live components; a clear "connection lost / reconnecting" banner (not silent).
- **P1 — Live, calm updates.** Stream Alfred and implementer tokens smoothly; animate the phase
  strip and the run board without layout jumps; badge new items instead of reordering under the
  user.
- **P1 — Presence of the loop.** A persistent, glanceable status (looping/running/idle, current
  phase, today's count) in the header on every page.

## 8. Theming & personalization

- **P0 — Full light/dark parity.** Audit every view/panel for both themes (some are dark-only);
  the theme toggle already stamps `data-theme` — make every component honour it.
- **P1 — High-contrast + system-preference default** and persisted user choice.
- **P2 — Per-user layout prefs** (default view exists at the admin level; add per-user pins/favourites).

## 9. Internationalization

- **P1 — i18n the platform UI. ✅ (v1, F12)** Extract strings, add a locale layer (the operator
  here works in Italian; the UI is English-only). Right-to-left readiness as a stretch. *Shipped:
  `i18n.js` (en/it) + a language toggle + translated nav/chrome. Next: extract per-view strings.*
- **P2 — Localised dates/numbers** via `Intl`.

## 10. Data visualization

- **P1 — A consistent, accessible chart kit.** The Overview composition chart and the Decisions
  matrix are good; unify them (shared palette that's colorblind-safe, labelled axes, tooltips,
  keyboard/table fallback for screen readers).
- **P1 — Trend lines that matter.** Land-rate over time, score trend, tokens/cost per iteration,
  backlog burndown — surface the outcome metrics ISL_IMPROVE §10 calls for.

## 11. New / upgraded views worth building

- **P0 — Security & Safety page. ✅ (F3)** List every deterministic-gate finding (secrets, weakened
  controls, destructive ops) over time, with the vetoed runs — the gate is invisible today. *Shipped:
  🔒 Security view backed by the Risk manager's gate findings.*
- **P1 — Objective/Goal surface.** The 🎯 objective (Backlog) deserves a first-class place with
  progress toward it.
- **P1 — Diff/Explorer upgrade.** A proper diff viewer (syntax-highlighted, side-by-side) for
  proposals and iteration diffs; a faster file tree.
- **P1 — PR/Provenance view.** Show the PR drafts/links and per-commit provenance the backend now
  produces.
- **P2 — Onboarding tour** for a fresh install (create project → build context → arm loop).

## 12. Engineering quality (frontend)

- **P0 — TypeScript.** Migrate the dashboard to TS (or at least JSDoc types + `checkJs`) so props
  and API shapes are checked — this alone prevents a class of runtime crashes.
- **P0 — Frontend tests. ✅ (v1, F9)** Component tests (Vitest + Testing Library), a couple of
  end-to-end smoke tests (Playwright), and **automated a11y checks** (axe) in CI. *Shipped: Vitest +
  Testing Library harness, `npm test`, first suite green. Next: per-view tests, axe, Playwright smoke.*
- **P1 — Lint & format.** ESLint (react-hooks, jsx-a11y) + Prettier, enforced in CI; a
  pre-commit hook.
- **P1 — Error monitoring & CSP.** A client error boundary that reports, and a Content-Security-
  Policy for the served dashboard.
- **P2 — Storybook** for the component kit, doubling as living documentation and visual-regression
  surface.

---

## 13. Phased roadmap

**Now (foundations):** design-system tokens + shared component kit · code-split routes · a
query/cache layer replacing per-view polling · keyboard/focus/ARIA baseline · TypeScript + frontend
tests + a11y CI. *These remove the whole class of "inconsistent, slow, fragile, inaccessible".*

**Next (experience):** responsive shell + degrading tables · consistent loading/empty/error +
confirmations · full light/dark parity · resilient socket-driven live updates · Security/Safety +
Goal + Provenance views · unified accessible charts.

**Later (delight & reach):** i18n · high-contrast/density modes · diff/Explorer upgrade · onboarding
tour · Storybook + visual regression · per-user personalization.

---

## 20. Shipped in wave 7 — fewer pages, and a guard for the bug the build cannot see (2026-08-08)

### 20.1 Thirty-eight nav entries became thirty

Several answered the same question from slightly different angles. Following one run meant moving
between **Iterations, Runs and Flow**; learning whether the app boots meant choosing between
**Workbench and Repair**. Five merges:

| Page | Absorbs | Tabs |
|---|---|---|
| ⟳ Runs | Iterations, Flow | Problems · All runs · Live |
| 🔧 Workbench | Repair | Boot check · Diagnose & repair |
| 🩹 Metrics *(was Health)* | Analytics, Telemetry | Codebase health · Run analytics · Cost & tokens |
| 🔒 Security & Rules | Compliance, Governance | Gate findings · Best practices · Policy |
| 🗃 Memory | Decisions | What it knows · How it routes |

`components/TabbedView.jsx` renders the **existing view components unchanged**. That is the whole
design: a merge that rewrites view internals is a merge that quietly drops features, and this
project has already paid for that once.

**Four things that would have been lost silently, and were not.**

- **The compliance badge.** Badges are keyed by nav id, so the open-violations count had nowhere to
  render the moment Compliance stopped being an entry — and an absent badge reads as *zero
  violations*. `rollUpBadges` moves a count onto its hosting page.
- **Eight destinations in ⌘K.** The palette builds its jump list from the nav. Absorbed pages are
  re-added, and matching now runs over the **route id** as well as the label — the label is what a
  page is called *today*, and the query is usually what it was called when the operator learned it.
  Verified live: "telemetry" now finds *Cost & tokens*, "health" finds *Metrics*, "deploy" finds
  *Promote*. Before the fix all three returned nothing, which reads as a deleted feature.
- **`go('flow')` and its siblings.** `VALID_VIEWS` no longer contained those ids, so every such call
  scattered across the views fell back to Overview.
- **The error boundary's key.** Keyed by `view`, a tab change unmounted the whole subtree — the
  focus ring left the button just pressed and arrow-key movement stopped after one key. Keyed by
  `page` now, with a boundary and a Suspense boundary **inside** each panel.

**Measured in the browser afterwards:** 46 routes, no empty pages, zero console errors. Arrow keys
move selection *and* focus, including onto a tab whose chunk has never been fetched — the case that
previously dropped focus to `<body>`, verified at +30 ms.

`merged.js` also normalises the URL: wrapping round to the first tab wrote `#/runs/runs`, a second
address for a page that already had one, and therefore a second history entry and a second bookmark.

### 20.2 The Live flow had no memory

The panel showed three lines. It was not under-populated — it was showing nearly everything that
existed. `bus.js` decides which events are persisted, and its list had never moved past the agent
era: no `iteration.*`, no `impl.*`. A run's history existed only as a WebSocket broadcast, so
reloading emptied it. And of the 400 rows that *were* stored, 384 were `agent.tool_call`, a type the
Flow view's map did not handle.

Both fixed; the view now reads a stored history and merges the socket on top. **3 lines → 155**,
after a reload.

### 20.3 A guard for the class of bug that has now shipped three times

There is no linter configured, and Vite compiles JSX without resolving identifiers. A component or
hook used but never imported **builds cleanly** and throws only when a user opens that page. It has
happened three times: `trapRef` declared in one component and used in another; `TabbedView`
referenced before its import existed; `useResource` called in a view that never imported it.

`dashboard/src/undefined-refs.test.js` scans every `.jsx` file for two things, both chosen because
they have no false positives:

- **JSX element names** — capitalised, so never a DOM tag.
- **Hooks** — `use[A-Z]…` in call position. There is no such thing as a global hook, so a name that
  is nowhere bound is always a missing import.

Comments are stripped first: several files document their own usage with a JSX example in the
header, and a component named in prose is not a missing import. The file also tests **the detector**,
against both bugs it exists for — a guard nobody has seen fail is a guard nobody knows works.

### 20.4 Runtime, and Runs

- **Runtime** gained tabs: *Containers* (per-service stop / start / restart / rebuild, instead of
  only stack-wide controls) and *Prisma schema* (read-only, with the integrity verdict). Containers
  started outside ISL are adopted — previously the page showed "stopped" with an empty list while
  eleven containers ran, making every control unreachable in exactly the situation you need it.
- **Runs → All runs** gained filters: chips by outcome with counts, and a search over title, `#id`
  and *failure reason* — the reason is what an operator remembers, and it is not in the title. The
  history is fetched by the view at 250 runs rather than the 15 that ride along on `/api/state`;
  filtering 15 of 435 gave answers that looked like verdicts and were snapshots of the last hour.
- **Backlog** gained a health strip that states, in words, when the planner has run out of
  selectable work — the counts said "in progress", which reads as work underway.

---

## 19. Shipped in wave 6 — focus management (2026-08-08)

*Pillar 2, P0: "Trap focus in modals/dialogs, return focus on close."*

**Measured first.** Four overlays — `ConfirmDialog`, `CommandPalette`, `ProposalDetail`, `Chat` —
with four different subsets of correct behaviour between them, and **no focus trap in any of them**:

| overlay | Escape | moves focus in | `role="dialog"` | traps focus |
|---|---|---|---|---|
| ConfirmDialog | ✓ | ✓ | ✓ | ✗ |
| CommandPalette | ✓ | ✓ | ✗ | ✗ |
| ProposalDetail | ✓ | ✗ | ✓ | ✗ |
| Chat | ✗ | ✗ | ✗ | ✗ |

Tab from inside any of them walked out into the page behind. A sighted mouse user sees a dimmed
backdrop; a keyboard user has the focus ring on controls hidden underneath it, activating things
they cannot see. `ProposalDetail` was the worst of the four — it announced `role="dialog"` and
`aria-modal` while never moving focus into itself, which is worse than no role at all: a screen
reader says "dialog" and focus is still on the row behind.

**One hook, not four fixes** (`useFocusTrap`), because the divergence *is* the defect — each overlay
had drifted to a different subset, and a fifth would have invented a fifth. It remembers the trigger,
moves focus in (honouring `data-autofocus`, so the palette opens on its search field rather than the
first button), cycles Tab and Shift+Tab at both boundaries, owns Escape, and restores focus on
close — **only if the trigger is still in the document**, since an overlay opened from a row that the
action then deleted has nothing to return to and focusing a detached node sends focus to `<body>`.

**Two bugs found while building it, both of the kind that compiles:**

- `trapRef` was declared in `ProposalDetail` and used inside its `Panel` sub-component — **out of
  scope, a `ReferenceError` at runtime**. Vite builds it happily; nothing in the toolchain catches an
  undefined identifier. Same class as an earlier `skipCoverageGate` slip in the engine, which is now
  twice in one session and a standing argument for a linter.
- The focusable filter used `offsetParent !== null` as shorthand for "visible". That is null for
  anything inside a `position: fixed` ancestor — **every overlay in this app** — and null for
  everything in jsdom. Every trap would have found zero focusable elements and Tab would have done
  nothing inside a dialog. Caught by the tests, not by review.

*10 tests. jsdom has no native Tab navigation, so they fire the keydown the trap listens for and
assert what the trap itself does — the boundary wrap, Escape, initial focus, the restore. They do not
claim to test the browser's tab order in between, which the hook does not touch.*

### The run is announced, not just drawn ✅

*Pillar 2, P1: "Announce iteration/phase changes, run outcomes and gate-blocked events."*

Everything this dashboard says about a run in progress was **visual only** — the phase strip, the
pulsing dot, the score rings, the status pills. The toast has `aria-live`, but toasts fire on the
operator's own actions, never on the loop's. A screen-reader user opening the page during a run
learned nothing: no announcement when one started, moved phase, committed, or was vetoed.

**The hard part was saying less.** A live region wired to the event bus would speak dozens of times
a minute over whatever the user is reading, and they cannot switch it off — worse than the silence
it replaces. So `LiveAnnouncer` announces four things and nothing else: a run starting, its phase
changing, its outcome, and a gate refusing it. Phases are said in words (`implement` → "writing the
change"), because the pipeline's tokens mean nothing read aloud. Outcomes come from the event
stream rather than `activeRun`, which is cleared the instant a run ends — the announcement an
operator most wants is the one the state no longer holds.

*10 tests, half of which assert **silence**: no repeat of an unchanged state, nothing for routine
phase traffic, nothing for the tool calls and ticks that arrive many times a second, and `polite`
rather than `assertive`. Suite: 225 tests across 22 files.*

---

## 18. Shipped in wave 5 — the run becomes legible (2026-08-07)

*Two gaps found by asking what a screen answers, rather than what it displays.*

- **The judging gates now reach the UI ✅** — behaviour preservation and coverage-of-changed-lines
  end in a **judgement**, not a score, so neither had a home among the score rings and neither had
  ever been rendered. `components/GateRecord.jsx` gives them one: a pill pair on a Runs row, a full
  panel on the run detail with the least-covered files and the lines nothing executed.
  Three rules it holds to, each of which is a way of lying if broken: **absent is not zero** (a gate
  that never ran says "not measured", never 0%); **advisory is not a veto** (a failing advisory
  verdict is amber and says the change was not blocked — painting it the same red as a blocking
  failure claims the loop stopped when it did not); **colour is relative to the floor** (55% against
  a floor of 50 is a pass and must not read as a failure because 55 looks low).

- **Flow rewritten ✅** — it was the page you open *during* a run, and during a run it said
  `iteration in progress` and nothing else: not which run, not what it was trying to do, not which
  step, not for how long. Idle — which is most of the time — it showed an empty log and the word
  "idle", carrying no information at all.
  - **Now running**: the run's **plan title** (the answer to "what"; the phase only answers "how
    far"), a ten-segment pipeline strip, `step 4 of 10`, time in phase, total elapsed, and a plain
    sentence for what the current phase actually does — "the specialists are editing files in the
    sandbox" rather than the bare token `implement`.
  - **Phase by phase**: per-phase durations with a relative bar, derived from the `running`→terminal
    event pairs already on the bus. This answers the question a long run actually provokes — *is it
    stuck, or is this step just slow?* — which a list of events with relative timestamps cannot.
  - **Idle shows the last run**: status, score, plan title, gate verdicts, and whether the loop is
    armed (another run is coming) or stopped (nothing will start until you say so).
  - The store's `activeRun` was already maintained event-by-event for the top strip; Flow simply was
    never given it. No new endpoint, no polling.

- **Live flow: it was silent during the work ✅** — the event map covered thirteen of the ~35 types
  the bus emits, and **none of the ones produced during `implement`**. Measured: on runs that
  actually produce work, `implement` takes 991–3015 s (median ~38 min) while every other phase
  finishes in under 15 s. So for the ~95% of a run where files are being written, the "live" flow
  showed nothing at all and read as a stalled page.
  - `impl.task_started` / `impl.task_finished` now render as `task 1/2 · quality` → `task 1 landed ·
    3 file(s)`, with the failure reason when one fails.
  - `impl.tool` renders too, but **coalesced**: the implementer emits one event per file operation,
    so shown individually they push everything else off the screen. Consecutive calls within a task
    fold into one line carrying `×8`, timestamped by the most recent member. Folding happens in
    chronological order, before the reverse — folding after would group the wrong neighbours.
  - Also mapped: `survey.*`, `research.finished`, `workbench.*`, `agent.error`, `verify.started`,
    `proposal.rejected`, `reliability.applied`, and `control.tick` — the last of these matters most,
    because "nothing is happening" and "something is stopping it from happening" look identical on
    a timeline that drops control events, and the difference is the entire diagnosis.
  - **Clock time, not "just now".** During a run most entries are seconds apart, so a relative label
    reads identically on every line and orders nothing.

**A bug caught in review, not by a test.** The idle card first coloured its status pill with
``bg-${tint}-500/15``. Tailwind extracts class names by scanning source text, so a class assembled at
runtime is never generated and the element renders unstyled — a build failure that looks like a
design mistake. Replaced with whole class strings, and the reason is written above the map.

**A redundancy the test surfaced.** The first version printed the phase blurb both in the rail and
on every live phase row — the same sentence twice on one screen. The test failed with "found
multiple elements", which was the UI's problem, not the test's.

*10 new tests (16 assertions) covering the timing derivation and both states of the view. Suite: 192
tests across 19 files.*

---

## 17. Shipped in wave 4 — visual system (2026-08-06)

*A pass on the qualities that separate an enterprise console from a styled prototype. Deliberately
CSS-first: a mechanical JSX refactor damaged 14 files earlier in this project, so nothing here
rewrites component structure. The one change touching JSX rewrites a literal value inside a
className, never markup.*

**Measured before deciding.** 664 arbitrary pixel font sizes across 9 distinct values (including
8px and 9px); exactly **one** box-shadow in the whole stylesheet; `prefers-reduced-motion` declared
**twice** in two different layers; focus rings offset by 1px.

- **Type floor and a real scale ✅** — every 8px and 9px size raised to 10px across 16 files (32
  occurrences, zero remaining). At 8px the anti-aliasing does more work than the glyphs. The scale is
  now 5 sizes; `Logo.jsx` is explicitly exempt, because a wordmark is a logotype sized optically
  against its mark, not a text style.
- **An elevation scale ✅** — `--elev-1/2/3` defined **per theme**. Dark mode carries an
  `inset 0 1px 0 rgb(255 255 255 / .04)` top highlight, because a drop shadow is invisible against
  near-black; light mode uses real shadows. One shadow value for both themes is how a dark UI ends up
  looking flat and a light one muddy.
- **A focus ring that is actually reachable ✅** — *the substantive fix of this pass.* The improved
  ring was first written as a bare `:focus-visible` in `@layer base`, while a pre-existing
  `.btn/.input/a/select/textarea:focus-visible` rule sat in `@layer components` applying Tailwind's
  `outline-none` + `ring-offset-1`. **Cascade layers are resolved before specificity**, so the base
  rule reached no control in the application — the improvement was dead code. Fixed on the rule that
  wins, and the separation is now `outline-offset` rather than a `ring-offset` colour, so it shows
  the real background and stays correct in both themes instead of painting a dark halo on a white
  panel. *Verified at runtime, not from source: a real keyboard Tab onto the login input reports
  `:focus-visible` true, `outline: 2px solid rgb(218,31,56)`, `outline-offset: 2px`.*
- **Numbers that do not jitter ✅** — `tabular-nums` on `th, td, code, kbd, samp, time, .font-mono`
  and on `.stat`. Every figure here changes while you watch it; with proportional digits a count
  going 9 → 10 shoves its neighbours and no column of scores lines up.
- **Press depth on controls ✅** — `translateY(1px)`, not `scale()`: scaling a button nudges its
  neighbours in the dense toolbars this UI is full of.
- **Housekeeping ✅** — duplicate `prefers-reduced-motion` block removed (harmless until someone edits
  one copy and cannot work out why nothing changes); `.pill` hairline via `color-mix` with an
  `@supports not` fallback; `scroll-margin-block` so a tabbed-to control never lands under the sticky
  header.
- **The system is pinned by tests ✅** — `dashboard/src/design-system.test.js`, 12 assertions:
  readability floor, scale size, elevation defined in both themes, cards using the scale, focus
  offset **on the winning rule**, focus ring non-transparent and theme-agnostic, tabular figures,
  reduced-motion declared exactly once, transition durations inside the responsive range. Visual
  polish is the first thing to rot, and "the dashboard looks slightly cheaper than last month" is not
  something anyone files a bug for.

*Suite: 182 tests across 18 files, all passing. Build 2.76s.*

---

## 16. Shipped in wave 3 (2026-07-25)

- **⌘K command palette, upgraded ✅** — the existing palette now also searches the **hybrid knowledge
  index** (code files + their symbols, the fleet's lessons, and past landed changes) alongside views,
  actions and live data, so grounded "where is X handled?" search is one keystroke from anywhere.
  Its action list grew to cover every new subsystem: scan CVEs, compute safe upgrades, seed
  coverage/structural/a11y work, de-duplicate the backlog, research online, build embeddings, detect
  models, take a health snapshot. *Verified: "payment idempotency" → `idempotency.js`,
  `PaymentStep.jsx`, `payments.js` with their symbols, hybrid over 563 docs.*
- **Top-bar status chips ✅** — the two facts an operator needs from any page: **🧠 the model actually
  doing the work** (with an embeddings-on dot, and every role's model in the tooltip) and **🎯 the
  current improvement focus** (with an amber "advisory" warning when the scope is not enforced). Both
  click through to their settings, so the bar is a control, not a readout. Plus a persistent
  **⌕ Search ⌘K** button.
- **Settings → Models & LLM ✅** — model detection and per-phase selection in the UI (see ISL.md §28).
- **🎯 Scope page ✅** — the improvement-focus steering wheel (see ISL_IMPROVE).

## 15. Next wave — new frontend functions (added 2026-07-24)

*The backend now produces a lot the UI barely surfaces: a hybrid knowledge index, a review queue with
per-agent trust, blast radius, coverage/health/CVE signals, a bisect+revert tool, a scheduler. This
wave surfaces it where an operator can read it and act on it.*

- **P0 — Command palette (⌘K).** One fuzzy launcher for everything: jump to any view, run an action
  (arm/stop loop, run once, scan deps, seed coverage, build embeddings), and — crucially — **search
  the knowledge index inline** so the RAG search is one keystroke away from anywhere, not buried in
  Context. The single biggest usability lever.
- **P0 — Global knowledge search in the top bar.** Promote the 📚 Context "Knowledge search" to a
  persistent top-bar box (with the hybrid/lexical + embedded-count indicator), so grounded code+memory
  search is always available.
- **P0 — Syntax-highlighted diff viewer. ✅ (2026-07-25)** Turns "trust the score" into "see the
  change". *Shipped: `DiffViewer.jsx` gained a **dependency-free** tokenizer (comments, strings,
  numbers, keywords across JS/TS/Python/Go/Rust idiom) and inline **blast-radius annotation** — each
  file header carries `⟿ N` dependents with a sensitivity marker, and expanding a file lists the
  callers that **must keep working**, plus a warning when no test imports it. That last line is the
  reviewer's real question, and it belongs next to the change rather than a click away.*
  - ***No highlighting library.** A highlighter would add a large bundle to a dashboard whose whole
    point is being fast, and a diff needs far less than a full grammar. The tokenizer is written to be
    **incapable of losing text**: every branch consumes and re-emits its input verbatim, so a language
    it does not understand renders as plain — correct — text rather than mangled code. Highlighting is
    also toggleable, because a display aid you cannot switch off is a liability when you distrust it.*
  - ***Blast radius is fetched lazily and capped at 8 files**, since a reviewer needs it for what is in
    front of them and firing dozens of requests for a panel nobody scrolled to is a poor trade.*
  *Verified: **18 tests** asserting the property that actually matters — the rendered text is
  character-identical to the input across escaped quotes, template literals with expressions, regex
  literals, hash and slash comments, unicode and emoji, deep indentation, HTML-looking characters, and
  a 400-character token. A highlighter that drops a character is worse than none, because the reviewer
  approves a change they did not actually see. Live on a real 501-line diff: 527 highlighted spans,
  keywords and comments correctly classified, blast pills populated per file.*
- **P1 — Review queue as a first-class approval inbox. ✅ (2026-07-25)** *Shipped:
  `ReviewInbox.jsx`, now the default mode of ☑ Review (the list stays one click away as "Queue &
  trust" — scanning history is a different task and deserves a different shape). Keyboard-driven —
  **j/k** move, **a/r** decide, **?** help — with shortcuts suppressed while typing so they cannot
  fire from a search box. Each change shows its diff (through the viewer above), risk, trust, the
  reasons it was held, and the two signals the new governance layer produces: **which policy rule
  held it** (with version, and whether it is barred from auto-promotion) and **who originated it**.*
  ***The eligibility check is the point.*** *Segregation of duties is enforced server-side and returns
  409, but making someone discover a control by hitting it is a poor way to explain a rule. The inbox
  marks changes you authored as `yours` in the list, disables Approve/Reject, and states the reason
  before you act. `origin: autonomous loop` is shown explicitly when there is no human author, since
  that is why anyone eligible may decide.*
  *Verified live against 21 real pending changes; whole dashboard suite green (38/38, a11y included).*
- **P1 — Unified insight dashboard. ✅ (2026-07-25)** The "is ISL helping?" answer on one screen.
  Every number already existed; the problem was that answering that one question meant visiting five
  pages and holding the result in your head. *Shipped: `views/Insight.jsx` — health score and trend
  with its components, measured line coverage, review backlog, security posture, and cost efficiency.*
  - ***A summary that ROUTES, not a copy.*** *Each panel shows the headline and links to the view that
    owns the detail. Overview answers a different question — "what is happening right now" — and was
    left alone rather than merged into one crowded page.*
  - ***A number ISL has not measured is shown as "not measured", never as zero.*** *A summary is
    exactly where dishonesty hides: an unmeasured coverage, a cost with no configured rate or an
    unrun dependency scan would each read as a fact while being an absence. Each says what would fix
    it instead ("Run a dependency scan on 🔒 Security").*
  - ***Every figure carries its provenance.*** *"6.4% of lines" means nothing without "measured at
    ee830f8 + 20 uncommitted files, 25 Jul 09:22, suite green" — which is what the panel actually
    renders, including an amber warning when the suite was red and the numbers are only a floor.*
  *Verified live against the real project: health 42 (+1), 6.4% of lines over 348 measured files,
  21 awaiting review, 765 tokens per landed change, worst gap `middleware/auth.js` at 27.1%, and the
  two honest absences — dependency scan not run, 1 of 1 model call unpriced. Suite green (38/38).*
- **P1 — Live activity spotlight. ✅ (2026-07-25, with one gap stated below)** The loop runs for
  minutes and, from any page but Flow, gives no sign of life — so an operator cannot tell a working
  run from a hung one and opens Flow "just to check", which is the interruption this removes.
  *Shipped: `ActivitySpotlight.jsx`, a strip above the content driven entirely by the WebSocket events
  the store already receives — no polling, no new endpoint. Run id, positional phase progress across
  the ten pipeline stages, the current phase and its summary, time-in-phase and total time, and a
  pulsing dot (the cheapest "this is alive" signal, read without focusing on it). It renders **only
  while something is running**: a permanent "idle" bar would be furniture.*
  **Three real bugs, each found by running it against a live loop rather than by reviewing it.**
  1. ***The controller's `current` was unobservable.*** *`this.current = r?.iterationId` was assigned
     from the RESULT of a run — i.e. after it finished — and cleared immediately in the `finally`. So
     `state().current` was **null for the entire time a run was in flight**, which is exactly when
     anything would read it. Now captured from the `iteration.started` event the moment it exists.
     Verified: `running: true | current: 211`, where it had always been null.*
  2. ***The clocks reset themselves.*** *`Date.now()` inside the fold looked right and was wrong: the
     fold re-ran on every incoming event, so both timers restarted several times a minute. A clock
     that restarts is not a clock.*
  3. ***Run state cannot be derived from the event log at all.*** *The strip showed "starting" while
     the run had server-side reached `catalog → survey → plan → implement`. A raw WebSocket probe
     opened from the page proved delivery was fine (`iteration.started` ×1, `iteration.phase` ×5) —
     and showed the cause: **`manager.brief` alone arrives at ~170/minute**, filling the 500-entry
     event buffer in under three minutes. A run lasts longer, so `iteration.started` is EVICTED
     mid-run; any fold then concludes no run exists and every later phase event looks orphaned.
     Fixed structurally: the run is now tracked in the store, event by event, where each is seen once
     and nothing is evicted. The component just renders it.*
  *Verified: **11 deterministic tests** — silent when idle, correct phase segmentation (5 done / 1
  current / 4 pending), both clocks, the controller fallback for a client that connected mid-run, and
  clocks **omitted rather than shown as "0s"** in that fallback, because a fabricated measurement is
  worse than an absent one. Then live, with the page open BEFORE the run: **`#213 · plan · 37s · 43s`
  with phases `✓✓●·······`** — catalog and survey complete, plan in progress. Suite green (49/49).*
  *(One test assertion had to be tightened during this: `not.toMatch(/\d+s/)` over the whole strip
  matched `#9` followed by `starting`, failing for a reason unrelated to clocks. It now asserts on
  the clock elements themselves.)*
- **P1 — Per-user preferences, persisted. ✅ (2026-07-25)** Theme, density and locale lived in
  `localStorage`, which means they were per **browser**: a second machine, a private window or a
  cleared cache lost them, and nobody could set a default for a user. *Shipped: a `user_prefs` table
  (one JSON document per user — preferences are always read as a set, and a partial read is never
  useful), `GET|PUT /api/preferences`, and a `usePreferences` hook wired into theme, density and
  locale.*
  - ***localStorage is kept as the CACHE, not removed.*** *That is not redundancy: reading the server
    first would repaint after load, so the operator would watch their own theme flip on every visit.
    Local applies instantly; the server corrects it once, if it disagrees. Writes are best-effort —
    a preference that fails to save is a nuisance, not something worth putting in front of someone.*
  - ***Only what the server actually holds is applied.*** *An unset preference must not overwrite a
    local choice with a default the user never made.*
  - ***Scoped by the SESSION, never by a user id in the request***, and validated against an
    allow-list: these values are written back into the DOM (`data-theme`, `data-density`), so
    accepting arbitrary keys would let a stored string become another surface's input. Unrecognised
    keys and invalid values are dropped silently rather than failing the request.
  *Verified live: an XSS payload as `theme`, an invalid `density`, a path-traversal `locale` and an
  unknown key were **all dropped with the stored preferences left untouched**; a partial write
  preserved the other two; unauthenticated access returns 401. Then the round trip that proves it is
  the server and not the cache — **localStorage cleared, page reloaded starting at the `dark`
  default, and the server's `light`/`it` were applied and re-cached**. Dashboard suite green (38/38).*
- **P1 — In-app notification centre with history. ✅ (2026-07-25)** A toast is the wrong container
  for anything you might need later: gone in four seconds and unrecoverable. *Shipped in two halves,
  and the second was the one that mattered.*
  - ***Making the feed worth reading.*** *The centre existed but was a flat list. It gained
    **severity and kind filters with counts** (so "show me what was blocked" is one click), an
    unread-only toggle, per-item `new` markers, and — the part that turns a log into a tool — **an
    action link on every item** that opens the view where the thing can actually be dealt with.*
  - ***Putting the important things IN it.*** *None of the new controls emitted anything: an egress
    refusal, a refused self-approval, a budget stop — the events an operator is precisely not
    watching the screen for — lived only in the audit chain. All are now wired, through a new
    `notifyOnce()` with a time-window dedupe. That dedupe is not a nicety: a misconfigured provider
    fails on every phase of every iteration, and a feed buried under ten thousand identical rows has
    lost the one property that makes it worth having. Every occurrence is still recorded in full by
    the ledger and the audit chain; the dedupe governs only how often a HUMAN is interrupted.*
  *Verified live end-to-end: a real self-approval attempt returned 409 AND produced
  `warn · governance · Self-approval refused for "…"` in the feed, with the actor named and an "open
  review →" action. Filters render with real counts (12 error · 4 warning · 14 info across
  governance/iteration/rollback/system). Dashboard suite green (38/38).*
  **A bug caught while verifying:** backend links are written either as a plain view (`review`) or as
  `subject:id` (`iteration:206`) — the id identifies the thing, not a route. The raw string was being
  rendered ("open iteration:206 →") and would have navigated nowhere. Links are now parsed and mapped
  to a real view, with the id dropped.
- **P2 — Scheduler & windows visualiser. ✅ (2026-07-26)** *Shipped: `ScheduleGrid.jsx`, a 7 × 24 grid
  replacing the four-number form in Settings. The specific failure it prevents: an **overnight window**
  (22 → 05) does not mean "Monday 22:00 to Tuesday 05:00 if Monday is ticked" — the early hours belong
  to the PREVIOUS day's selection. A grid shows that at a glance; no sentence does.*
  ***The membership rule is recomputed client-side rather than trusting a summary***, so what is
  painted is what will fire. Duplicating a rule is normally a smell; the alternative here is a grid
  that shows something other than the truth, which is worse. "Never fired" is stated in words rather
  than left as an empty cell, which would read as a rendering gap instead of information.
  *Verified live: **168 cells** (7 × 24) with the current hour ringed, none open while the scheduler
  is disabled.*
- **P2 — Trust & decision-network explorer. ✅ (2026-07-26)** *Shipped: `CompetenceHeatmap.jsx` in 🧠
  Decisions, replacing the static matrix (removed, along with its two now-dead colour helpers, rather
  than left as a second copy of the same data).*
  ***The honesty problem a heatmap invites is colour.*** *One attempt landed is 100% and would glow
  brighter than 35-of-50, which is far stronger evidence. So **rate and confidence are encoded
  separately**: hue carries the land rate, paleness carries how little evidence stands behind it, and
  a cell under three attempts is drawn as explicitly *not judged* — no percentage at all — rather than
  as a colour that would mislead. Every class is spelled out literally, because Tailwind compiles what
  it finds in the SOURCE: a constructed `bg-${hue}-${step}` would have rendered the whole heatmap
  colourless while every value looked correct in the DOM.*
  *Verified live on real data: **39 cells, 13 coloured, 8 explicitly not judged**. 8 tests.*
- **P2 — Density-aware data tables. ✅ (2026-07-26)** *Shipped: `DataTable.jsx` — virtualised (only the
  visible slice is in the DOM), sortable, column-configurable with the choice persisted per table id,
  degrading to stacked cards below `sm`. Dependency-free: a virtualisation library is a large addition
  to a bundle whose point is being fast, and fixed-height windowing is a dozen lines.*
  ***Applied where the shape is actually tabular***, not everywhere the doc listed. Backlog and Memory
  rows carry a title, a description and hover actions; collapsing them into 28px rows would lose
  information, so they stayed rich lists. The licence inventory is one row per package with no
  nesting — that is a table, and it is now one. *Verified live after a real scan of **1,990 packages
  across 8 projects**: 23 flagged rows, sortable headers, column picker. 8 tests, including that a
  5,000-row dataset keeps fewer than 200 rows in the DOM and that nulls sort to the end
  deterministically.*
  **Found while testing:** `ResizeObserver` is absent in jsdom — and in some webviews, where the
  component would have thrown during mount and taken the view down. Now guarded with a window-resize
  fallback.
- **P2 — Guided onboarding tour. ✅ (2026-07-26)** *Shipped: `OnboardingTour.jsx` on Overview. ISL has
  a real prerequisite chain — project → context → embeddings → scope → loop — and getting it wrong
  produces a system that looks **broken** rather than unconfigured: the loop runs, finds nothing
  useful, and the operator concludes the product does not work.*
  ***It checks reality instead of tracking progress.*** *Each step asks the API whether it is already
  done, so someone who set everything up before ever seeing this gets a completed checklist, not a
  tutorial for work they finished — that is why people close tours. It shows only when a
  **non-optional** step is missing, and dismissal is persisted **server-side** (`tourDismissed`, added
  to the preferences allow-list as write-once true) so it does not return on another machine.*
  *Verified live: correctly **hidden** on this install, where every prerequisite is satisfied — a tour
  appearing here would have been the bug. 7 tests cover the other direction: it appears and names the
  missing step, ignores a missing optional step, never runs the checks once dismissed, treats a failing
  check as "not done" rather than erroring, and navigates to the view a step needs.*

---

## 14. Guiding principles

1. **The dashboard is held to the bar its agents enforce.** The same accessibility, UX and
   performance checks ISL runs against other codebases apply to this one.
2. **One system, not thirty pages.** Shared tokens and components over per-view bespoke UI.
3. **Live, not polled.** The event bus is the source of truth; the UI reflects it instantly.
4. **Fast by default.** Small initial bundle, virtualised lists, no render storms.
5. **Accessible by default.** Keyboard, focus, contrast, screen-reader — not an afterthought.
6. **Typed and tested.** A change that breaks a view should fail CI, not the operator's screen.

---

*An operator has to be able to tell, at a glance, what the system is doing and whether to trust it.
That is the standard every item above is measured against.*
