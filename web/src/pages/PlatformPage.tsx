import { useCallback, useEffect, useState } from 'react';
import { Navigate } from 'react-router-dom';
import { api, post, put } from '../api';
import { isPlatformAdmin, useAuth } from '../auth';
import { FleetyMark, TopBar } from '../components/TopBar';
import { fmtAgo } from '../format';

// Apex-domain landing (no club subdomain matched).

const FEATURES: { title: string; body: string }[] = [
  {
    title: 'Live ops board',
    body: "Your fleet on a dark ops-room map at your club's own address, updating in real time from ADS-B — including aircraft the public trackers have delisted.",
  },
  {
    title: 'Fully customisable',
    body: 'Your colours, your logo, your board name and subheading — plus curated themes from ops-dark to heritage to daylight. It looks like YOUR club, not our product.',
  },
  {
    title: 'Clubhouse kiosk',
    body: 'A full-screen mode built for the coffee-shop TV: aircraft photo cards, a departures ticker, event pings, and the board snaps to whatever is flying.',
  },
  {
    title: 'Flight history & replay',
    body: 'Every flight recorded from first fix to landing, with honest coverage-gap handling — then replayable on the map with a time slider.',
  },
  {
    title: 'Members & guests',
    body: 'Run the board public or members-only, set visibility per aircraft, and add temporary guest aircraft that can auto-expire — or stay forever.',
  },
  {
    title: 'Resilient data',
    body: 'Positions blend multiple ADS-B networks with automatic failover, dead-reckoning between pings, and an optional paid rescue tier for coverage blackspots.',
  },
];

function WaitlistForm() {
  const [email, setEmail] = useState('');
  const [marketing, setMarketing] = useState(false);
  const [state, setState] = useState<'idle' | 'busy' | 'done' | 'error'>('idle');

  const join = async () => {
    setState('busy');
    try {
      await post('/api/waitlist', { email, marketing });
      setState('done');
    } catch {
      setState('error');
    }
  };

  if (state === 'done') {
    return (
      <div className="waitlist-done">
        <p className="mono-label">YOU'RE ON THE LIST ✓</p>
        <p className="muted small">We'll be in touch when we're ready for your club.</p>
      </div>
    );
  }
  return (
    <>
      <div className="waitlist-row">
        <input
          type="email"
          placeholder="you@yourclub.co.uk"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && email.includes('@') && void join()}
        />
        <button className="btn btn-primary" onClick={() => void join()} disabled={state === 'busy' || !email.includes('@')}>
          {state === 'busy' ? 'Joining…' : 'Join the waitlist'}
        </button>
      </div>
      <label className="check waitlist-optin">
        <input type="checkbox" checked={marketing} onChange={(e) => setMarketing(e.target.checked)} />
        Also email me occasional Fleety product updates (optional — you can unsubscribe any time)
      </label>
      {state === 'error' && <p className="form-error">That didn't work — check the address and try again.</p>}
    </>
  );
}

export function LandingPage() {
  return (
    <div className="landing">
      <div className="landing-inner">
        <header className="landing-hero">
          <div className="brand">
            <FleetyMark />
            <span className="brand-name">
              FLEETY
              <span className="brand-sub">LIVE OPS BOARDS FOR FLYING CLUBS</span>
            </span>
          </div>
          <h1>Your club's aircraft, live on a board built for the clubhouse.</h1>
          <p className="muted">
            Fleet tracking, flight history and a departures ticker — in your club's colours, on the clubhouse
            TV, at your club's own address.
          </p>
          <p className="mono-label landing-domain">yourclub.fleety.live</p>
        </header>

        <section className="landing-features">
          {FEATURES.map((f) => (
            <div className="landing-feature" key={f.title}>
              <h3 className="mono-label">{f.title.toUpperCase()}</h3>
              <p>{f.body}</p>
            </div>
          ))}
        </section>

        <section className="landing-waitlist">
          <h2>Get your club on the board</h2>
          <p className="muted small">
            Fleety is onboarding clubs gradually. Leave your email and we'll get in touch — we only use it to
            talk to you about getting set up.
          </p>
          <WaitlistForm />
        </section>

        <footer className="landing-footer">
          <p className="landing-love">
            Built with <span aria-hidden="true">♥</span> by{' '}
            <a href="https://astramesa.com" target="_blank" rel="noreferrer">
              AstraMesa
            </a>
          </p>
          <p className="muted small">
            Fleety is operated by AstraMesa, a trading name of Platformation Ltd, registered in England and
            Wales, company no. 10414067. Registered office: 20-22 Wenlock Road, London, England, N1 7GU.
            Contact: <a href="mailto:ops@fleety.live">ops@fleety.live</a>.
          </p>
          <p className="muted small">
            <a href="/cookies">Cookie policy</a> · Map data ©{' '}
            <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noreferrer">
              OpenStreetMap
            </a>{' '}
            contributors · ADS-B data via adsb.lol
          </p>
        </footer>
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

        <PlatformStatus />

        <WaitlistAdmin />

        <RescuePanel />
      </main>
    </div>
  );
}

// ---------- shared-feed status (platform-wide poll log + DB size) ----------

interface PlatformStatusRes {
  poller: { lastPollAt: number; ok: boolean; error: string | null };
  recentPolls: { ts: number; provider: string; ok: number; error: string | null; aircraft_returned: number; duration_ms: number }[];
  dbSizeBytes: number;
}

function PlatformStatus() {
  const [data, setData] = useState<PlatformStatusRes | null>(null);
  const load = useCallback(() => {
    api<PlatformStatusRes>('/api/platform/status')
      .then(setData)
      .catch(() => {});
  }, []);
  useEffect(() => {
    load();
    const t = setInterval(load, 10_000);
    return () => clearInterval(t);
  }, [load]);
  if (!data) return null;
  return (
    <>
      <h1 style={{ marginTop: '2rem' }}>Platform — data feed</h1>
      <p className="muted small">
        The poller is shared across every club: {data.poller.ok ? 'healthy' : 'failing'}, last poll{' '}
        {data.poller.lastPollAt ? fmtAgo(data.poller.lastPollAt) : 'never'}
        {data.poller.error ? ` — ${data.poller.error}` : ''}. Database {(data.dbSizeBytes / 1024 / 1024).toFixed(1)} MB.
      </p>
      <table className="table">
        <thead>
          <tr>
            <th>Time</th>
            <th>Provider</th>
            <th>Result</th>
            <th>Aircraft</th>
            <th>Duration</th>
          </tr>
        </thead>
        <tbody>
          {data.recentPolls.map((p, i) => (
            <tr key={i}>
              <td className="muted">{fmtAgo(p.ts)}</td>
              <td>{p.provider}</td>
              <td>{p.ok ? 'ok' : `error: ${p.error}`}</td>
              <td>{p.aircraft_returned}</td>
              <td>{p.duration_ms} ms</td>
            </tr>
          ))}
        </tbody>
      </table>
    </>
  );
}

// ---------- waitlist ----------

interface WaitlistSignup {
  id: number;
  email: string;
  marketing_opt_in: number;
  created_at: number;
  source: string;
}

function WaitlistAdmin() {
  const [signups, setSignups] = useState<WaitlistSignup[] | null>(null);
  useEffect(() => {
    api<{ signups: WaitlistSignup[] }>('/api/platform/waitlist')
      .then((r) => setSignups(r.signups))
      .catch(() => {});
  }, []);
  if (!signups) return null;
  return (
    <>
      <h1 style={{ marginTop: '2rem' }}>Platform — waitlist</h1>
      {signups.length === 0 ? (
        <p className="muted small">No signups yet — send someone to fleety.live.</p>
      ) : (
        <table className="table">
          <thead>
            <tr>
              <th>Email</th>
              <th>Product updates</th>
              <th>Signed up</th>
            </tr>
          </thead>
          <tbody>
            {signups.map((s) => (
              <tr key={s.id}>
                <td>
                  <strong>{s.email}</strong>
                </td>
                <td>{s.marketing_opt_in === 1 ? '✓ opted in' : '—'}</td>
                <td className="muted">{fmtAgo(s.created_at)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </>
  );
}

// ---------- ADSBx rescue (platform infrastructure, platform bill) ----------

interface RescueInfo {
  configured: boolean;
  month: string | null;
  used: number;
  budget: number;
  aircraft: { id: number; registration: string; callsign: string; hex: string; club: string }[];
}

function RescuePanel() {
  const [info, setInfo] = useState<RescueInfo | null>(null);
  const [acId, setAcId] = useState('');
  const [probe, setProbe] = useState<'idle' | 'busy' | string>('idle');

  const load = useCallback(() => {
    api<RescueInfo>('/api/platform/rescue')
      .then(setInfo)
      .catch(() => {});
  }, []);
  useEffect(load, [load]);

  // One paid ADSBexchange request. Bootstraps rescue coverage when a flight
  // begins inside a free-network blackspot: a hit opens the flight, and the
  // automatic tier keeps probing from there.
  const check = async () => {
    setProbe('busy');
    try {
      const r = await post<{ found: boolean; posAgeSec: number | null }>('/api/platform/rescue-probe', {
        aircraftId: Number(acId),
      });
      setProbe(
        r.found
          ? `Contact${r.posAgeSec != null ? ` — position ${r.posAgeSec}s old` : ''} ✓`
          : 'No ADSBx contact'
      );
      load();
    } catch (err) {
      setProbe(
        err instanceof Error && err.message === 'budget_exhausted'
          ? 'Budget exhausted'
          : 'Check failed'
      );
    }
    setTimeout(() => setProbe('idle'), 6000);
  };

  if (!info) return null;
  return (
    <>
      <h1 style={{ marginTop: '2rem' }}>Platform — ADSBx rescue</h1>
      {!info.configured ? (
        <p className="muted small">
          Not configured. Set <code>ADSBX_API_KEY</code> (RapidAPI) to enable the paid rescue tier —
          automatic probing of aircraft that vanish mid-flight from the free networks, plus this manual check.
        </p>
      ) : (
        <>
          <p className="muted small">
            Each check is one paid ADSBexchange request against the platform budget — used{' '}
            <strong>
              {info.used.toLocaleString()} / {info.budget.toLocaleString()}
            </strong>{' '}
            this month{info.month ? ` (${info.month})` : ''}. Use it when an aircraft took off inside a
            free-network blackspot: a hit opens its flight and the automatic rescue tier takes over.
          </p>
          <div className="form-row inline-add">
            <select value={acId} onChange={(e) => setAcId(e.target.value)} style={{ minWidth: '18rem' }}>
              <option value="">Select aircraft…</option>
              {info.aircraft.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.club} — {a.registration}
                  {a.callsign ? ` (${a.callsign})` : ''}
                </option>
              ))}
            </select>
            <button className="btn btn-primary" onClick={() => void check()} disabled={!acId || probe === 'busy'}>
              {probe === 'busy' ? 'Checking…' : 'Check ADSBx'}
            </button>
            {probe !== 'idle' && probe !== 'busy' && <span className="mono-label">{probe}</span>}
          </div>
        </>
      )}
    </>
  );
}
