import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * THE DESIGN SYSTEM, PINNED.
 *
 * Visual polish is the first thing to rot: every one of these was true once, drifted, and had to be
 * put back. A rule nobody checks is a rule that lasts until the next hurried change, and "the
 * dashboard looks slightly cheaper than it did last month" is not something anyone files a bug for.
 *
 * These assert the properties that separate an enterprise console from a styled prototype — the
 * ones that are invisible when right and unmistakable when wrong.
 */
const SRC = path.dirname(fileURLToPath(import.meta.url));
const css = fs.readFileSync(path.join(SRC, 'index.css'), 'utf8');
const sourceFiles = ['views', 'components']
  .flatMap((dir) => fs.readdirSync(path.join(SRC, dir)).map((f) => path.join(SRC, dir, f)))
  .filter((f) => f.endsWith('.jsx') && !f.includes('.test.'));

describe('typography', () => {
  it('has no text below the 10px readability floor', () => {
    // 32 occurrences of 8–9px text existed. At that size the anti-aliasing does more work than the
    // glyphs, and on a 1440p monitor it is genuinely unreadable rather than merely dense.
    const offenders = sourceFiles.flatMap((f) => {
      const hits = (fs.readFileSync(f, 'utf8').match(/text-\[[0-9]px\]/g) || []);
      return hits.map((h) => `${path.basename(f)}: ${h}`);
    });
    expect(offenders).toEqual([]);
  });

  it('keeps the type scale to a small set of sizes', () => {
    // A scale is a small set used consistently. Nine arbitrary sizes is not a scale, it is a habit.
    //
    // Logo.jsx is deliberately exempt: a wordmark is a logotype, sized optically against the mark it
    // sits beside, and dragging it onto the text scale would be the tail wagging the dog.
    const sizes = new Set();
    for (const f of sourceFiles.filter((f) => !f.endsWith('Logo.jsx'))) {
      for (const m of fs.readFileSync(f, 'utf8').matchAll(/text-\[(\d+)px\]/g)) sizes.add(Number(m[1]));
    }
    expect([...sizes].sort((a, b) => a - b).length, `sizes in use: ${[...sizes].sort((a, b) => a - b)}`).toBeLessThanOrEqual(6);
  });
});

describe('surfaces and depth', () => {
  it('defines an elevation scale, not a single shadow', () => {
    for (const token of ['--elev-1', '--elev-2', '--elev-3']) {
      expect(css, `${token} is missing`).toContain(token);
    }
  });

  it('defines elevation for BOTH themes', () => {
    // A drop shadow is nearly invisible on a near-black background and heavy on a white one. One
    // set of values for both is how a dark UI ends up looking flat and a light one looks muddy.
    const dark = css.slice(0, css.indexOf("[data-theme='light']"));
    const light = css.slice(css.indexOf("[data-theme='light']"));
    expect(dark).toContain('--elev-1');
    expect(light).toContain('--elev-1');
  });

  it('cards use the scale rather than a hardcoded shadow', () => {
    const card = css.slice(css.indexOf('.card {'), css.indexOf('.card:hover'));
    expect(card).toMatch(/box-shadow:\s*var\(--elev-/);
  });
});

describe('keyboard focus', () => {
  /**
   * The rule that actually lands on buttons and inputs — the one in @layer components. Asserting the
   * bare `:focus-visible` in @layer base proves nothing: layers are resolved BEFORE specificity, so
   * a components rule wins over a base rule whatever the selectors look like. That is not a
   * hypothetical; the improved ring sat in base for a while and reached no control in the app.
   */
  const controlFocusRule = () => {
    const at = css.indexOf('.btn:focus-visible');
    expect(at, 'the shared control focus rule is gone').toBeGreaterThan(-1);
    return css.slice(at, css.indexOf('}', at));
  };

  it('separates the focus ring from the control it surrounds', () => {
    const offset = Number(controlFocusRule().match(/outline-offset:\s*(\d+)px/)?.[1] ?? 0);
    // At 1px the ring reads as a slightly thicker border on a dense dark panel, which is the same
    // as having no focus indicator at all.
    expect(offset).toBeGreaterThanOrEqual(2);
  });

  it('draws a ring that is actually visible', () => {
    const rule = controlFocusRule();
    // `outline-none` (Tailwind) compiles to `outline: 2px solid transparent`. Combined with a ring
    // utility that is later removed or restyled, it is how focus indicators disappear silently.
    expect(rule).not.toMatch(/outline:[^;]*transparent/);
    expect(rule).toMatch(/outline:\s*2px solid rgb\(var\(--brand-light\)\)/);
  });

  it('keeps the focus indicator theme-agnostic', () => {
    // A ring-offset painted with a fixed dark colour is a black halo on a white panel. The gap from
    // outline-offset shows the real background instead, so it is right in both themes.
    expect(controlFocusRule()).not.toMatch(/ink-950|ring-offset-\w/);
  });

  it('keeps a focused control clear of a sticky header', () => {
    expect(css).toMatch(/scroll-margin-block/);
  });
});

describe('data display', () => {
  it('uses tabular figures wherever numbers live', () => {
    // Every live figure here changes while you watch it. Proportional digits make a count going
    // 9 → 10 shove its neighbours, and no column of scores ever lines up.
    expect(css).toMatch(/font-variant-numeric:\s*tabular-nums/);
    expect(css, 'the KPI value must not jitter').toMatch(/\.stat\s*\{[^}]*tabular-nums/s);
  });
});

describe('motion', () => {
  it('honours prefers-reduced-motion exactly once', () => {
    // It was declared twice — identical blocks in two layers. Harmless until someone edits one of
    // them and cannot work out why the change has no effect.
    const count = (css.match(/@media \(prefers-reduced-motion: reduce\)/g) || []).length;
    expect(count).toBe(1);
  });

  it('keeps interaction timing in the range that reads as responsive', () => {
    // Under ~100ms is imperceptible, over ~300ms feels sluggish. Anything outside that on a control
    // is either wasted or annoying.
    const durations = [...css.matchAll(/transition[^;]*?(\d+(?:\.\d+)?)s\s+ease/g)]
      .map((m) => Number(m[1]) * 1000)
      .filter((ms) => ms > 0);
    expect(durations.length, 'no transitions found to check').toBeGreaterThan(0);
    for (const ms of durations) expect(ms, `${ms}ms is outside the responsive range`).toBeLessThanOrEqual(400);
  });
});
