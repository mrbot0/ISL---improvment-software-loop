import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import DiffViewer from './DiffViewer.jsx';

/**
 * The property that matters for a diff viewer is not that it highlights prettily — it is that it is
 * INCAPABLE of altering what the reviewer reads. A highlighter that drops or reorders a character is
 * worse than no highlighter, because the reviewer approves a change they did not actually see.
 *
 * The tokenizer is not exported (it is an implementation detail), so it is exercised through the
 * rendered output: whatever goes in must come out, character for character.
 */

const wrap = (body) => `diff --git a/x.js b/x.js\n--- a/x.js\n+++ b/x.js\n@@ -1,1 +1,1 @@\n${body}`;

/** The text content of the rendered code lines, minus the +/- markers the component adds. */
function renderedBody(diff) {
  const { container } = render(<DiffViewer diff={diff} showBlast={false} />);
  const pre = container.querySelector('pre');
  return [...pre.querySelectorAll(':scope > div')]
    .map((d) => d.textContent)
    .filter((t) => !/^(diff |index |\+\+\+|---|@@)/.test(t));
}

describe('DiffViewer — the tokenizer must never alter the text', () => {
  const cases = [
    ['plain code', '+const x = 1;'],
    ['a string containing a keyword', '+const s = "return function class";'],
    ['a template literal with an expression', '+const t = `hello ${name} for ${1 + 2}`;'],
    ['an escaped quote inside a string', `+const q = 'it\\'s fine';`],
    ['a trailing line comment', '+let n = 42; // return this'],
    ['a hash comment (python/shell)', '+# def not_a_keyword():'],
    ['a regex-looking literal', '+const re = /^[a-z]+\\/[0-9]*$/g;'],
    ['unicode and emoji', '+const msg = "città — ✓ 🎯";'],
    ['deep indentation preserved', '+        return { a: 1 };'],
    ['a removed line', '-  delete this.thing;'],
    ['a context line', '   unchanged();'],
    ['a line that is only whitespace', '+   '],
    ['characters that look like HTML', '+if (a < b && c > d) return "<script>";'],
    ['a very long single-token line', `+const z = "${'x'.repeat(400)}";`],
  ];

  for (const [label, line] of cases) {
    it(`preserves ${label} exactly`, () => {
      const [out] = renderedBody(wrap(line));
      // The marker is rendered separately but is part of the visible text, so the round trip is
      // compared against the original line as written.
      expect(out).toBe(line.startsWith(' ') ? line : line);
    });
  }

  it('preserves a multi-line body in order', () => {
    const body = ['+const a = 1;', '-const b = 2;', ' const c = 3;'].join('\n');
    expect(renderedBody(wrap(body))).toEqual(['+const a = 1;', '-const b = 2;', ' const c = 3;']);
  });

  it('renders nothing but a notice for an empty diff', () => {
    render(<DiffViewer diff="" showBlast={false} />);
    expect(screen.getByText(/No diff/i)).toBeTruthy();
  });

  it('counts additions and deletions per file', () => {
    render(<DiffViewer diff={wrap(['+a', '+b', '-c'].join('\n'))} showBlast={false} />);
    // Header totals and the per-file row both report the same counts.
    expect(screen.getAllByText('+2').length).toBeGreaterThan(0);
    expect(screen.getAllByText('−1').length).toBeGreaterThan(0);
  });

  it('splits a multi-file diff', () => {
    const two = [
      'diff --git a/one.js b/one.js', '@@ -1 +1 @@', '+one',
      'diff --git a/two.py b/two.py', '@@ -1 +1 @@', '+two',
    ].join('\n');
    render(<DiffViewer diff={two} showBlast={false} />);
    expect(screen.getByText('one.js')).toBeTruthy();
    expect(screen.getByText('two.py')).toBeTruthy();
  });
});
