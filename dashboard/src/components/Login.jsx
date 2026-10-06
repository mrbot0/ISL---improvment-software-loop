import { useState } from 'react';
import { Spinner } from './ui.jsx';
import { Logo } from './Logo.jsx';

/**
 * The access panel. First-time accounts (the seeded admin, or anyone an admin
 * invites) have no password yet — the first sign-in sets it. We surface that so
 * a new operator understands they are *claiming* the account, not guessing it.
 */
export default function Login({ onLogin }) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [claimed, setClaimed] = useState(false);

  const submit = async (e) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const r = await onLogin(email.trim(), password);
      if (r?.claimed) setClaimed(true);
    } catch (err) {
      setError(err.message || 'Sign in failed');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="grid h-screen place-items-center bg-ink-950 px-4">
      <div className="w-full max-w-sm">
        <div className="mb-6 flex justify-center">
          <Logo size={34} subtitle="Improvement Software Loop" />
        </div>

        <form onSubmit={submit} className="card space-y-4 p-6">
          <div>
            <h1 className="font-display text-lg tracking-wide text-white">Sign in</h1>
            <p className="mt-1 text-[11px] leading-relaxed text-slate-500">
              First time here? Signing in with your invited email <strong className="text-slate-400">sets your password</strong> and claims the account.
            </p>
          </div>

          <label className="block">
            <span className="stat-label">Email</span>
            <input
              type="email"
              autoComplete="username"
              className="input mt-1"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="you@example.com"
              required
              autoFocus
            />
          </label>

          <label className="block">
            <span className="stat-label">Password</span>
            <input
              type="password"
              autoComplete="current-password"
              className="input mt-1"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="at least 8 characters"
              minLength={8}
              required
            />
          </label>

          {error && (
            <div className="rounded-lg border border-rose-900/60 bg-rose-950/40 px-3 py-2 text-[11px] text-rose-300">{error}</div>
          )}
          {claimed && (
            <div className="rounded-lg border border-emerald-900/60 bg-emerald-950/40 px-3 py-2 text-[11px] text-emerald-300">
              Account claimed — welcome.
            </div>
          )}

          <button type="submit" disabled={busy} className="btn-primary w-full justify-center py-2">
            {busy ? <Spinner /> : 'Sign in'}
          </button>
        </form>

        <p className="mt-4 text-center text-[10px] text-slate-600">ISL · autonomous software-improvement control plane</p>
      </div>
    </div>
  );
}
