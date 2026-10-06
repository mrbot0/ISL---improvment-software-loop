import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import CommandPalette from './CommandPalette.jsx';
import { ABSORBED_LABELS } from '../merged.js';

vi.mock('../api.js', () => ({ api: { knowledge: vi.fn().mockResolvedValue({ results: [] }) } }));

const nav = [
  { id: 'health', label: 'Metrics' },
  { id: 'deploy', label: 'Promote' },
  { id: 'runs', label: 'Runs' },
];

function open(onNavigate = vi.fn()) {
  render(
    <CommandPalette open onClose={() => {}} nav={nav} actions={[]} data={{}} onNavigate={onNavigate} />,
  );
  return { input: screen.getByPlaceholderText(/Go to a page/i), onNavigate };
}

const labels = () => screen.queryAllByRole('button').map((b) => b.textContent);

describe('CommandPalette finds pages by the name people actually type', () => {
  it('finds a merged page by the name it had before the merge', () => {
    // The regression this test exists for: Telemetry became the "Cost & tokens" tab, and searching
    // its old name returned nothing — which reads as "that feature is gone", not "it moved".
    const { input } = open();
    fireEvent.change(input, { target: { value: 'telemetry' } });
    expect(labels().join(' ')).toMatch(/Cost & tokens/);
  });

  it('finds Metrics by its old name, health', () => {
    const { input } = open();
    fireEvent.change(input, { target: { value: 'health' } });
    expect(labels().join(' ')).toMatch(/Metrics/);
  });

  it('finds Promote by its route id, deploy', () => {
    const { input } = open();
    fireEvent.change(input, { target: { value: 'deploy' } });
    expect(labels().join(' ')).toMatch(/Promote/);
  });

  it('offers every absorbed page as a destination', () => {
    open();
    const all = labels().join(' ');
    for (const label of Object.values(ABSORBED_LABELS)) expect(all).toContain(label);
  });

  it('navigates to the absorbed id so the right tab opens', () => {
    const { input, onNavigate } = open();
    fireEvent.change(input, { target: { value: 'repair' } });
    fireEvent.click(screen.getAllByRole('button').find((b) => b.textContent.includes('Diagnose & repair')));
    expect(onNavigate).toHaveBeenCalledWith('repair');
  });

  it('still ranks by the visible label rather than the hidden keyword', () => {
    const { input } = open();
    fireEvent.change(input, { target: { value: 'runs' } });
    expect(labels()[0]).toMatch(/Runs/);
  });
});
