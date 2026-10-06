import { describe, it, expect } from 'vitest';
import { render } from '@testing-library/react';
import { axe } from 'vitest-axe';
import { PageHeader, Empty, SeverityPill } from './ui.jsx';

/**
 * Automated accessibility checks (ISL_Frontend §2/§12). axe-core asserts our shared
 * components have no WCAG violations — the dashboard must pass the same a11y bar ISL's
 * agents hold other apps to.
 */
describe('accessibility (axe)', () => {
  it('PageHeader has no violations', async () => {
    const { container } = render(<PageHeader title="Decisions" subtitle="learned routing" />);
    expect(await axe(container)).toHaveNoViolations();
  });

  it('Empty state has no violations', async () => {
    const { container } = render(<Empty icon="🧠" title="Nothing yet" hint="It fills up." />);
    expect(await axe(container)).toHaveNoViolations();
  });

  it('a simple labelled form has no violations', async () => {
    const { container } = render(
      <form>
        <label htmlFor="email">Email</label>
        <input id="email" type="email" />
        <SeverityPill severity="high" />
        <button type="submit">Save</button>
      </form>,
    );
    expect(await axe(container)).toHaveNoViolations();
  });
});
