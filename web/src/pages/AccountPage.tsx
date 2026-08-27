import { useState, type FormEvent } from 'react';
import { Navigate } from 'react-router-dom';
import { ApiError, post } from '../api';
import { useAuth } from '../auth';
import { TopBar } from '../components/TopBar';

export function AccountPage() {
  const { me, loading } = useAuth();
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState('');
  const [saved, setSaved] = useState(false);

  if (!loading && !me?.user) return <Navigate to="/login" replace />;

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError('');
    setSaved(false);
    if (next !== confirm) {
      setError('New passwords do not match.');
      return;
    }
    try {
      await post('/api/change-password', { current, next });
      setCurrent('');
      setNext('');
      setConfirm('');
      setSaved(true);
    } catch (err) {
      setError(
        err instanceof ApiError && err.code === 'password_too_short'
          ? 'Password must be at least 8 characters.'
          : 'Change failed — check your current password.'
      );
    }
  };

  return (
    <div className="app-shell">
      <TopBar />
      <main className="page">
        <div className="settings-page">
          <h1>Your account</h1>
          <section className="setting-block">
            <h3>Signed in as</h3>
            <p>
              <strong>{me?.user?.email ?? me?.user?.username}</strong>
              {me?.user?.platformAdmin && <span className="muted small"> · platform admin</span>}
            </p>
          </section>
          <section className="setting-block">
            <h3>Change password</h3>
            <form onSubmit={(e) => void submit(e)} className="form-grid" style={{ maxWidth: '380px' }}>
              <input
                type="password"
                placeholder="Current password"
                value={current}
                onChange={(e) => setCurrent(e.target.value)}
                autoComplete="current-password"
              />
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
              {saved && <p className="saved-note">Password changed ✓</p>}
              <button className="btn btn-primary" disabled={!current || !next}>
                Change password
              </button>
            </form>
          </section>
        </div>
      </main>
    </div>
  );
}
