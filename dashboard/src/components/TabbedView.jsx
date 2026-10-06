import { Suspense, useEffect, useRef, useState } from 'react';
import { ErrorBoundary } from './ErrorBoundary.jsx';
import { Spinner } from './ui.jsx';

/**
 * MERGING PAGES WITHOUT REWRITING THEM.
 *
 * The dashboard had 38 nav entries, several of which answered the same question from slightly
 * different angles — to follow one run you moved between three pages, and to find out whether the
 * app boots you picked between two.
 *
 * This shell renders the EXISTING view components unchanged, one per tab. That is the whole design:
 * a merge that rewrites view internals is a merge that quietly drops features, and this project has
 * already paid for that once when a mechanical refactor damaged fourteen files. Here the views keep
 * every behaviour they had — only the way you reach them changes.
 *
 * Two properties that make the merge safe rather than merely tidy:
 *
 *   - **Deep links survive.** The old `#/runs` and `#/flow` still open the right tab, because a tab
 *     is addressed as `#/<page>/<tab>` and the removed ids are aliased. A link in a notification, a
 *     bookmark, or `onNavigate('flow')` from another view all keep working.
 *   - **Only the visible tab is mounted.** These views poll and hold subscriptions; mounting three
 *     at once would triple the request rate to show one.
 */
export default function TabbedView({ tabs, active, onTabChange, label }) {
  const [current, setCurrent] = useState(active || tabs[0]?.id);

  // The URL is the source of truth — a tab opened by deep link must win over local state.
  useEffect(() => {
    if (active && active !== current) setCurrent(active);
  }, [active]); // eslint-disable-line react-hooks/exhaustive-deps

  const tab = tabs.find((t) => t.id === current) || tabs[0];
  const listRef = useRef(null);

  /*
   * `focus` is passed by the arrow keys, not by a click — a click already focuses the button it
   * hits. Without it the selection moves and the focus does not, leaving the ring on a tab that has
   * just become `tabindex="-1"`: the panel a sighted user sees and the tab a screen reader
   * announces stop agreeing, which is the whole point of the roving tabindex.
   */
  const select = (id, { focus = false } = {}) => {
    setCurrent(id);
    onTabChange?.(id);
    // The button node survives the re-render, so it can be focused straight away.
    if (focus) listRef.current?.querySelector(`[id="tab-${id}"]`)?.focus();
  };

  return (
    <div className="flex h-full flex-col">
      {/* `role="tablist"` with arrow-key movement: a row of buttons is operable but announces
          nothing about being a set, and Tab through five tabs to reach content is tedious. */}
      <div
        role="tablist"
        aria-label={label}
        ref={listRef}
        className="mb-3 flex flex-wrap gap-1 border-b border-ink-800 pb-2"
        onKeyDown={(e) => {
          const i = tabs.findIndex((t) => t.id === current);
          if (e.key === 'ArrowRight') { e.preventDefault(); select(tabs[(i + 1) % tabs.length].id, { focus: true }); }
          if (e.key === 'ArrowLeft') { e.preventDefault(); select(tabs[(i - 1 + tabs.length) % tabs.length].id, { focus: true }); }
        }}
      >
        {tabs.map((t) => {
          const on = t.id === current;
          return (
            <button
              key={t.id}
              role="tab"
              id={`tab-${t.id}`}
              aria-selected={on}
              aria-controls={`panel-${t.id}`}
              // Only the active tab is in the tab order; arrows move between them. This is the
              // standard pattern and the reason the keydown handler above exists.
              tabIndex={on ? 0 : -1}
              onClick={() => select(t.id)}
              className={`rounded-lg px-3 py-1.5 text-[12px] transition-colors ${
                on ? 'bg-ink-800 font-medium text-white' : 'text-slate-400 hover:bg-ink-900 hover:text-slate-200'
              }`}
              title={t.hint || undefined}
            >
              {t.icon && <span className="mr-1.5">{t.icon}</span>}
              {t.label}
            </button>
          );
        })}
      </div>

      <div
        role="tabpanel"
        id={`panel-${tab?.id}`}
        aria-labelledby={`tab-${tab?.id}`}
        // Focusable so a keyboard user landing here from the tablist has somewhere to be.
        tabIndex={0}
        className="min-h-0 flex-1 overflow-auto"
      >
        {/* A boundary per panel, keyed by tab. App's boundary is keyed by page, so without this one
            a crash in a single tab would take the tablist with it and leave no way to switch away
            from the broken tab. Keyed by id so moving to another tab clears the error. */}
        {/*
          * A Suspense boundary of its own, INSIDE the shell. The views are lazy chunks, and App's
          * boundary sits above this component: the first time a tab is opened its chunk suspends,
          * and App's fallback replaces the tab bar along with the panel. Measured: arrowing to a
          * not-yet-loaded tab unmounted the focused button and dropped focus to <body>, so the next
          * arrow key did nothing. Keeping the fallback here means only the panel is ever replaced.
          */}
        <ErrorBoundary key={tab?.id}>
          <Suspense fallback={<div className="grid h-full place-items-center py-8 text-slate-500"><Spinner /></div>}>
            <TabPanel render={tab?.render} />
          </Suspense>
        </ErrorBoundary>
      </div>
    </div>
  );
}

/**
 * Calls the tab's render function from inside the boundary's subtree.
 *
 * `<ErrorBoundary>{tab.render()}</ErrorBoundary>` looks equivalent and is not: the call is
 * evaluated while building the element tree, before the boundary exists, so a throw escapes to the
 * boundary above and takes the tablist with it — the failure this design was meant to contain. A
 * component defined once at module scope also keeps a stable identity, so the panel is not
 * unmounted and refetched every time the parent re-renders.
 */
function TabPanel({ render }) {
  return render ? render() : null;
}
