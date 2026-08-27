import { useCallback, useEffect, useState } from 'react';
import { Navigate } from 'react-router-dom';
import { api, post, put } from '../api';
import { isPlatformAdmin, useAuth } from '../auth';
import { FleetyMark, TopBar } from '../components/TopBar';
import { fmtAgo } from '../format';

// Apex-domain landing (no club subdomain matched).
export function LandingPage() {
  return (
    <div className="login-page">
      <div className="login-card landing-card">
        <div className="brand">
          <FleetyMark />
          <span className="brand-name">
            FLEETY
            <span className="brand-sub">LIVE OPS BOARDS FOR FLYING CLUBS</span>
          </span>
        </div>
        <p className="muted center">
          Your club's aircraft, live on a board built for the clubhouse — flight history, departures ticker,
          kiosk mode and more. Each club flies at its own address.
        </p>
        <p className="mono-label center">yourclub.fleety.live</p>
      </div>
    </div>
  );
}

interface PlatformClub {
  id: number;
  slug: string;
  name: string;
  theme: string;
  publicMode: boolean;
  url: string;
  members: number;
  aircraft: number;
}

interface PlatformUser {
  id: number;
  username: string;
  email: string | null;
  platform_admin: number;
  last_login_at: number | null;
  clubs: string | null; // "invicta:admin,downland:member"
}

export function PlatformPage() {
  const { me, loading } = useAuth();
  const [clubs, setClubs] = useState<PlatformClub[]>([]);
  const [users, setUsers] = useState<PlatformUser[]>([]);
  const [slug, setSlug] = useState('');
  const [name, setName] = useState('');
  const [error, setError] = useState('');

  const load = useCallback(() => {
    api<{ clubs: PlatformClub[] }>('/api/platform/clubs')
      .then((r) => setClubs(r.clubs))
      .catch(() => {});
    api<{ users: PlatformUser[] }>('/api/platform/users')
      .then((r) => setUsers(r.users))
      .catch(() => {});
  }, []);
  useEffect(load, [load]);

  const togglePlatformAdmin = async (u: PlatformUser) => {
    const making = u.platform_admin !== 1;
    if (
      !window.confirm(
        making
          ? `Make ${u.email ?? u.username} a platform admin? They get admin access to EVERY club.`
          : `Remove platform admin from ${u.email ?? u.username}?`
      )
    )
      return;
    try {
      await put(`/api/platform/users/${u.id}`, { platformAdmin: making });
      load();
    } catch (err) {
      window.alert(`Failed: ${err instanceof Error ? err.message : err}`);
    }
  };

  if (!loading && !isPlatformAdmin(me)) return <Navigate to="/" replace />;

  const create = async () => {
    setError('');
    try {
      await post('/api/platform/clubs', { slug, name });
      setSlug('');
      setName('');
      load();
    } catch (err) {
      setError(`Could not create club: ${err instanceof Error ? err.message : err}`);
    }
  };

  return (
    <div className="app-shell">
      <TopBar />
      <main className="page">
        <h1>Platform — clubs</h1>
        <p className="muted small">
          Each club lives at its own subdomain. Creating a club makes you its first admin — set it up, invite
          the club's own admin from Admin → Members, then step back.
        </p>
        <div className="form-row inline-add">
          <input
            placeholder="subdomain (e.g. downland)"
            value={slug}
            onChange={(e) => setSlug(e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, ''))}
            style={{ width: '14rem' }}
          />
          <input placeholder="Club name (e.g. Downland Flying Group)" value={name} onChange={(e) => setName(e.target.value)} />
          <button className="btn btn-primary" onClick={() => void create()} disabled={!slug || !name.trim()}>
            Create club
          </button>
        </div>
        {error && <p className="form-error">{error}</p>}
        <table className="table">
          <thead>
            <tr>
              <th>Club</th>
              <th>Address</th>
              <th>Theme</th>
              <th>Access</th>
              <th>Members</th>
              <th>Aircraft</th>
            </tr>
          </thead>
          <tbody>
            {clubs.map((c) => (
              <tr key={c.id}>
                <td>
                  <strong>{c.name}</strong>
                </td>
                <td className="mono">
                  <a href={c.url}>{c.slug}.fleety.live</a>
                </td>
                <td>{c.theme}</td>
                <td>{c.publicMode ? 'public' : 'private'}</td>
                <td>{c.members}</td>
                <td>{c.aircraft}</td>
              </tr>
            ))}
          </tbody>
        </table>

        <h1 style={{ marginTop: '2rem' }}>Platform — users</h1>
        <p className="muted small">
          Every account across every club. Club roles are managed inside each club (Admin → Members); platform
          admins have full access to all clubs and this panel.
        </p>
        <table className="table">
          <thead>
            <tr>
              <th>User</th>
              <th>Clubs</th>
              <th>Last sign-in</th>
              <th>Platform admin</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {users.map((u) => (
              <tr key={u.id}>
                <td>
                  <strong>{u.email ?? u.username}</strong>
                </td>
                <td className="muted small">{u.clubs ? u.clubs.split(',').join(' · ') : '—'}</td>
                <td className="muted">{u.last_login_at ? fmtAgo(u.last_login_at) : 'never'}</td>
                <td>{u.platform_admin === 1 ? '✓' : ''}</td>
                <td className="row-actions">
                  <button className="btn btn-ghost small" onClick={() => void togglePlatformAdmin(u)}>
                    {u.platform_admin === 1 ? 'Remove platform admin' : 'Make platform admin'}
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </main>
    </div>
  );
}
