import { useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import { ApiError, post } from '../api';
import { useAuth } from '../auth';
import { Brand } from '../components/TopBar';

export function LoginPage() {
  const { me, config, refresh } = useAuth();
  const navigate = useNavigate();
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const mustChange = me?.user?.mustChangePassword;

  const login = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      const res = await post<{ user: { mustChangePassword: boolean } }>('/api/login', { username, password });
      await refresh();
      if (!res.user.mustChangePassword) navigate('/');
    } catch (err) {
      setError(
        err instanceof ApiError && err.code === 'invalid_credentials'
          ? 'Wrong username or password.'
          : 'Sign-in failed — try again.'
      );
    } finally {
      setBusy(false);
    }
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
      await post('/api/change-password', { current: current || password, next });
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
        <Brand siteName={config?.siteName ?? 'FleetView'} logoUrl={config?.logoUrl} />
        {mustChange ? (
          <>
            <h2>Set a new password</h2>
            <p className="muted">Your password was set by an admin — choose your own before continuing.</p>
            <form onSubmit={(e) => void changePassword(e)}>
              {!password && (
                <input
                  type="password"
                  placeholder="Current password"
                  value={current}
                  onChange={(e) => setCurrent(e.target.value)}
                  autoComplete="current-password"
                />
              )}
              <input
                type="password"
                placeholder="New password (min 8 characters)"
                value={next}
                onChange={(e) => setNext(e.target.value)}
                autoComplete="new-password"
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
            </form>
          </>
        ) : (
          <>
            <h2>Member sign in</h2>
            <form onSubmit={(e) => void login(e)}>
              <input
                placeholder="Username"
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                autoComplete="username"
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
              <button className="btn btn-primary" disabled={busy}>
                {busy ? 'Signing in…' : 'Sign in'}
              </button>
            </form>
            {config?.publicMode && (
              <p className="muted small center">
                Or <a href="/">continue to the public map</a>.
              </p>
            )}
          </>
        )}
      </div>
    </div>
  );
}
