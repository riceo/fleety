import { useEffect, useState, type FormEvent } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { ApiError, post } from '../api';
import { useAuth } from '../auth';
import { Brand } from '../components/TopBar';

export function LoginPage() {
  const { me, config, refresh } = useAuth();
  const navigate = useNavigate();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [next, setNext] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState('');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);

  const mustChange = me?.user?.mustChangePassword;

  const login = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      const res = await post<{ mustChangePassword: boolean }>('/api/login', { email, password });
      await refresh();
      if (!res.mustChangePassword) navigate('/');
    } catch (err) {
      setError(
        err instanceof ApiError && err.code === 'invalid_credentials'
          ? 'Wrong email or password.'
          : 'Sign-in failed — try again.'
      );
    } finally {
      setBusy(false);
    }
  };

  // Escape hatch: a must-change session left overnight loses the typed current
  // password on refresh, so let the user sign out and start over.
  const signOut = async () => {
    await post('/api/logout', {}).catch(() => {});
    await refresh();
    setPassword('');
    setNext('');
    setConfirm('');
    setError('');
  };

  const forgot = async () => {
    if (!email) {
      setError('Enter your email first, then press “Forgot password”.');
      return;
    }
    setError('');
    await post('/api/forgot-password', { email }).catch(() => {});
    setNote('If that address has an account, a reset link is on its way.');
  };

  const changePassword = async (e: FormEvent) => {
    e.preventDefault();
    if (next !== confirm) {
      setError('New passwords do not match.');
      return;
    }
    setBusy(true);
    setError('');
    try {
      await post('/api/change-password', { current: password, next });
      await refresh();
      navigate('/');
    } catch (err) {
      setError(
        err instanceof ApiError && err.code === 'password_too_short'
          ? 'Password must be at least 8 characters.'
          : 'Password change failed — check your current password.'
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="login-page">
      <div className="login-card">
        <Brand config={config} />
        {mustChange ? (
          <>
            <h2>Set a new password</h2>
            <p className="muted small center">Your password was set by an admin — choose your own before continuing.</p>
            <form onSubmit={(e) => void changePassword(e)}>
              <input
                type="password"
                placeholder="Current password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                autoComplete="current-password"
                autoFocus={!password}
              />
              <input
                type="password"
                placeholder="New password (min 8 characters)"
                value={next}
                onChange={(e) => setNext(e.target.value)}
                autoComplete="new-password"
                autoFocus={!!password}
              />
              <input
                type="password"
                placeholder="Repeat new password"
                value={confirm}
                onChange={(e) => setConfirm(e.target.value)}
                autoComplete="new-password"
              />
              {error && <p className="form-error">{error}</p>}
              <button className="btn btn-primary" disabled={busy}>
                {busy ? 'Saving…' : 'Save and continue'}
              </button>
              <button type="button" className="btn btn-ghost small" onClick={() => void signOut()}>
                Sign out
              </button>
            </form>
          </>
        ) : (
          <>
            <h2>Member sign in</h2>
            <form onSubmit={(e) => void login(e)}>
              <input
                type="email"
                placeholder="Email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                autoComplete="email"
                autoFocus
              />
              <input
                type="password"
                placeholder="Password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                autoComplete="current-password"
              />
              {error && <p className="form-error">{error}</p>}
              {note && <p className="muted small">{note}</p>}
              <button className="btn btn-primary" disabled={busy}>
                {busy ? 'Signing in…' : 'Sign in'}
              </button>
              <button type="button" className="btn btn-ghost small" onClick={() => void forgot()}>
                Forgot password
              </button>
            </form>
            {config?.publicMode && (
              <p className="muted small center">
                Or <a href="/">continue to the public board</a>.
              </p>
            )}
          </>
        )}
      </div>
    </div>
  );
}

// Invite / reset link landing: /set-password?token=…
export function SetPasswordPage() {
  const { config, refresh } = useAuth();
  const navigate = useNavigate();
  const [params] = useSearchParams();
  // Capture the single-use token once, then scrub it from the address bar (as
  // the kiosk flow does) so it doesn't linger in history/referrers.
  const [token] = useState(() => params.get('token') ?? '');
  useEffect(() => {
    if (params.get('token')) window.history.replaceState(null, '', '/set-password');
  }, [params]);
  const [next, setNext] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (next !== confirm) {
      setError('Passwords do not match.');
      return;
    }
    setBusy(true);
    setError('');
    try {
      await post('/api/set-password', { token, password: next });
      await refresh();
      navigate('/');
    } catch (err) {
      setError(
        err instanceof ApiError && err.code === 'invalid_token'
          ? 'This link has expired or was already used — ask your club admin for a new one.'
          : 'Password must be at least 8 characters.'
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="login-page">
      <div className="login-card">
        <Brand config={config} />
        <h2>Choose your password</h2>
        <form onSubmit={(e) => void submit(e)}>
          <input
            type="password"
            placeholder="New password (min 8 characters)"
            value={next}
            onChange={(e) => setNext(e.target.value)}
            autoComplete="new-password"
            autoFocus
          />
          <input
            type="password"
            placeholder="Repeat password"
            value={confirm}
            onChange={(e) => setConfirm(e.target.value)}
            autoComplete="new-password"
          />
          {error && <p className="form-error">{error}</p>}
          <button className="btn btn-primary" disabled={busy || !token}>
            {busy ? 'Saving…' : 'Set password and sign in'}
          </button>
        </form>
      </div>
    </div>
  );
}
