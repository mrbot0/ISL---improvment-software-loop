import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';

/**
 * The tour has exactly two ways to be wrong, and both are worse than not having it:
 * showing up for someone who already finished the setup, and refusing to go away.
 */
const apiMock = {
  preferences: vi.fn(),
  savePreferences: vi.fn(() => Promise.resolve({})),
  projects: vi.fn(),
  context: vi.fn(),
  knowledge: vi.fn(),
  scope: vi.fn(),
  state: vi.fn(),
};
vi.mock('../api.js', () => ({ api: apiMock }));

const { default: OnboardingTour } = await import('./OnboardingTour.jsx');

const allDone = () => {
  apiMock.preferences.mockResolvedValue({ prefs: {} });
  apiMock.projects.mockResolvedValue([{ id: 'p1' }]);
  apiMock.context.mockResolvedValue({ ready: true });
  apiMock.knowledge.mockResolvedValue({ embedded: 500 });
  apiMock.scope.mockResolvedValue({ themes: {} });
  apiMock.state.mockResolvedValue({ iteration: { controller: { looping: true, todayCount: 3 } } });
};

beforeEach(() => {
  vi.clearAllMocks();
  allDone();
});

describe('OnboardingTour', () => {
  it('stays hidden when every prerequisite is already satisfied', async () => {
    render(<OnboardingTour />);
    await waitFor(() => expect(apiMock.state).toHaveBeenCalled());
    expect(screen.queryByText(/Getting ISL working/)).toBeNull();
  });

  it('appears when a prerequisite is missing, and names it', async () => {
    apiMock.context.mockResolvedValue({ ready: false, entries: [] });
    render(<OnboardingTour />);
    expect(await screen.findByText(/Getting ISL working/)).toBeTruthy();
    expect(screen.getByText(/Build the context/)).toBeTruthy();
    // The step that is done still shows, ticked — a checklist, not a tutorial.
    expect(screen.getByText(/4 of 5 done/)).toBeTruthy();
  });

  // An optional step alone must not summon the tour.
  it('does not appear for a missing OPTIONAL step', async () => {
    apiMock.knowledge.mockResolvedValue({ embedded: 0, mode: 'lexical' });
    render(<OnboardingTour />);
    await waitFor(() => expect(apiMock.state).toHaveBeenCalled());
    expect(screen.queryByText(/Getting ISL working/)).toBeNull();
  });

  it('stays hidden once dismissed, without even running the checks', async () => {
    apiMock.preferences.mockResolvedValue({ prefs: { tourDismissed: true } });
    apiMock.context.mockResolvedValue({ ready: false, entries: [] });
    render(<OnboardingTour />);
    await waitFor(() => expect(apiMock.preferences).toHaveBeenCalled());
    expect(screen.queryByText(/Getting ISL working/)).toBeNull();
    expect(apiMock.state).not.toHaveBeenCalled();
  });

  it('persists the dismissal server-side', async () => {
    apiMock.context.mockResolvedValue({ ready: false, entries: [] });
    render(<OnboardingTour />);
    fireEvent.click(await screen.findByText('dismiss'));
    expect(apiMock.savePreferences).toHaveBeenCalledWith({ tourDismissed: true });
    expect(screen.queryByText(/Getting ISL working/)).toBeNull();
  });

  // A build whose API lacks an endpoint must not be blocked from onboarding by an exception.
  it('treats a failing check as "not done" rather than erroring', async () => {
    apiMock.context.mockRejectedValue(new Error('404'));
    render(<OnboardingTour />);
    expect(await screen.findByText(/Getting ISL working/)).toBeTruthy();
  });

  it('navigates to the view a step needs', async () => {
    const onNavigate = vi.fn();
    apiMock.context.mockResolvedValue({ ready: false, entries: [] });
    render(<OnboardingTour onNavigate={onNavigate} />);
    fireEvent.click(await screen.findByText(/Build the context/));
    expect(onNavigate).toHaveBeenCalledWith('context');
  });
});
