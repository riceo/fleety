import { useCallback, useEffect, useState } from 'react';
import { Navigate } from 'react-router-dom';
import { api, post } from '../api';
import { isPlatformAdmin, useAuth } from '../auth';
import { FleetyMark, TopBar } from '../components/TopBar';

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

export function PlatformPage() {
  const { me, loading } = useAuth();
  const [clubs, setClubs] = useState<PlatformClub[]>([]);
  const [slug, setSlug] = useState('');
  const [name, setName] = useState('');
  const [error, setError] = useState('');

  const load = useCallback(() => {
    api<{ clubs: PlatformClub[] }>('/api/platform/clubs')
      .then((r) => setClubs(r.clubs))
      .catch(() => {});
  }, []);
  useEffect(load, [load]);

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
      </main>
    </div>
  );
}
