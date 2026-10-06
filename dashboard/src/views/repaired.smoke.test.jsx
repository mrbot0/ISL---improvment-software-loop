import { describe, it, expect, vi } from 'vitest';
import { render } from '@testing-library/react';
import { mockApi, VIEW_PROPS } from '../test/fixtures.js';

/**
 * The files a failed mechanical refactor had to be repaired in, several of which no other test
 * touches. The build proves they PARSE; it does not prove they render. These do.
 */
vi.mock('../api.js', () => ({ api: mockApi() }));
vi.mock('../components/Toast.jsx', () => ({ useToast: () => vi.fn(), ToastHost: () => null }));

const REPAIRED = [
  ['Admin', () => import('./Admin.jsx')],
  ['Governance', () => import('./Governance.jsx')],
  ['Projects', () => import('./Projects.jsx')],
  ['Compliance', () => import('./Compliance.jsx')],
  ['Health', () => import('./Health.jsx')],
  ['Reliability', () => import('./Reliability.jsx')],
];

describe('views repaired after the CardHead refactor still render', () => {
  for (const [name, load] of REPAIRED) {
    it(`${name} mounts without throwing`, async () => {
      const { default: View } = await load();
      expect(() => render(<View {...VIEW_PROPS} />)).not.toThrow();
    });
  }

  it('the two repaired components mount too', async () => {
    const { default: ModelsPanel } = await import('../components/ModelsPanel.jsx');
    const { default: ScheduleGrid } = await import('../components/ScheduleGrid.jsx');
    expect(() => render(<ModelsPanel {...VIEW_PROPS} />)).not.toThrow();
    expect(() => render(<ScheduleGrid {...VIEW_PROPS} />)).not.toThrow();
  });
});
