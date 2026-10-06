import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { ErrorBoundary } from './ErrorBoundary.jsx';

const Boom = () => { throw new Error('kaboom'); };
const Ok = () => <div>healthy view</div>;

describe('ErrorBoundary', () => {
  it('renders children when there is no error', () => {
    render(<ErrorBoundary><Ok /></ErrorBoundary>);
    expect(screen.getByText('healthy view')).toBeInTheDocument();
  });

  it('catches a crashing child and shows the fallback + reload', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    render(<ErrorBoundary><Boom /></ErrorBoundary>);
    expect(screen.getByRole('alert')).toBeInTheDocument();
    expect(screen.getByText(/kaboom/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /reload view/i })).toBeInTheDocument();
    console.error.mockRestore();
  });
});
