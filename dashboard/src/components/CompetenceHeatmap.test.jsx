import { describe, it, expect } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import CompetenceHeatmap from './CompetenceHeatmap.jsx';

/**
 * The failure mode a heatmap invites is a confident colour over thin evidence: 1-of-1 landed is
 * 100% and would glow brighter than 35-of-50, which is far stronger evidence. These assert that
 * confidence and rate are encoded separately, and that a real Tailwind class comes out — a
 * constructed class name would render colourless while every value looked right in the DOM.
 */
const net = {
  agents: [
    { agent: 'quality', attempts: 50, landed: 35, landRate: 0.7 },
    { agent: 'frontend', attempts: 1, landed: 1, landRate: 1 },
    { agent: 'newbie', attempts: 0, landed: 0, landRate: null },
  ],
  areas: ['backend', 'frontend'],
  cells: [
    { agent: 'quality', area: 'backend', attempts: 50, landed: 35, failed: 15, landRate: 0.7 },
    { agent: 'quality', area: 'frontend', attempts: 4, landed: 0, failed: 4, landRate: 0 },
    { agent: 'frontend', area: 'frontend', attempts: 1, landed: 1, failed: 0, landRate: 1 },
  ],
};

const cellFor = (container, label) => [...container.querySelectorAll('button[title]')].find((b) => b.title.includes(label));

describe('CompetenceHeatmap', () => {
  it('says so when there is nothing to show', () => {
    render(<CompetenceHeatmap network={{ agents: [], areas: [], cells: [] }} />);
    expect(screen.getByText(/No competence data yet/i)).toBeTruthy();
  });

  it('emits real Tailwind classes, not constructed ones', () => {
    const { container } = render(<CompetenceHeatmap network={net} />);
    const strong = cellFor(container, 'quality · backend');
    // A template-built name like `bg-emerald-500/70` would exist here but not in the stylesheet.
    expect(strong.className).toMatch(/bg-emerald-500\/(20|40|70)/);
  });

  it('colours a poor rate red and a good rate green', () => {
    const { container } = render(<CompetenceHeatmap network={net} />);
    expect(cellFor(container, 'quality · backend').className).toMatch(/emerald/);
    expect(cellFor(container, 'quality · frontend').className).toMatch(/rose/);
  });

  // The whole point: a single lucky attempt must not read as mastery.
  it('refuses to judge a cell with too few attempts', () => {
    const { container } = render(<CompetenceHeatmap network={net} />);
    const thin = cellFor(container, 'frontend · frontend');
    expect(thin.className).not.toMatch(/emerald|amber|rose/);
    expect(thin.title).toMatch(/too few attempts/);
    expect(thin.textContent).toBe('·'); // no percentage is shown at all
  });

  it('shows the overall column only where there is evidence', () => {
    render(<CompetenceHeatmap network={net} />);
    expect(screen.getByText('70%')).toBeTruthy();      // quality, 50 attempts
    expect(screen.getAllByText('n/a').length).toBe(2); // frontend (1 attempt) and newbie (0)
  });

  it('drills into a cell and back out', () => {
    const { container } = render(<CompetenceHeatmap network={net} />);
    fireEvent.click(cellFor(container, 'quality · backend'));
    expect(screen.getByText(/35 landed \/ 15 failed over 50 attempt/)).toBeTruthy();
    fireEvent.click(cellFor(container, 'quality · backend'));
    expect(screen.queryByText(/35 landed/)).toBeNull();
  });

  it('states plainly when a pair has never been attempted', () => {
    const { container } = render(<CompetenceHeatmap network={net} />);
    fireEvent.click(cellFor(container, 'newbie · backend'));
    expect(screen.getByText(/never attempted work in this area/i)).toBeTruthy();
  });

  it('warns in the drill-down when the sample is too small to conclude', () => {
    const { container } = render(<CompetenceHeatmap network={net} />);
    fireEvent.click(cellFor(container, 'frontend · frontend'));
    expect(screen.getByText(/too few attempts to draw a conclusion/i)).toBeTruthy();
  });
});
