import { Link, NavLink, useNavigate } from 'react-router-dom';
import { post, type AppConfig } from '../api';
import { isAdmin, isPlatformAdmin, useAuth } from '../auth';

// Neutral Fleety mark for clubs without an uploaded logo.
export function FleetyMark() {
  return (
    <svg viewBox="0 0 32 32" className="brand-mark" aria-hidden>
      <rect x="1" y="1" width="30" height="30" rx="7" fill="var(--accent, #e32636)" />
      <path
        fill="#ffffff"
        d="M16 4 L18 10 L18.4 13 L18.4 22 C18.4 24 18 26 16 27.6 C14 26 13.6 24 13.6 22 L13.6 13 L14 10 Z"
      />
      <path fill="#ffffff" d="M4 16.5 L13.6 14 L18.4 14 L28 16.5 L28 19.5 L18.4 19 L13.6 19 L4 19.5 Z" />
      <path fill="#ffffff" d="M11 24.5 L13.6 23.5 L18.4 23.5 L21 24.5 L21 26.5 L18.4 27 L13.6 27 L11 26.5 Z" />
    </svg>
  );
}

export function Brand({ config }: { config: AppConfig | null }) {
  return (
    <Link to="/" className="brand">
      {config?.logoUrl ? <img src={config.logoUrl} alt="" className="brand-logo" /> : <FleetyMark />}
      <span className="brand-name">
        {(config?.siteName ?? 'Fleety').toUpperCase()}
        {config?.subheading && <span className="brand-sub">{config.subheading.toUpperCase()}</span>}
      </span>
    </Link>
  );
}

export function TopBar() {
  const { me, config, refresh } = useAuth();
  const navigate = useNavigate();

  const logout = async () => {
    await post('/api/logout').catch(() => {});
    await refresh();
    navigate('/login');
  };

  return (
    <header className="topbar">
      <Brand config={config} />
      <nav className="topnav">
        <NavLink to="/" end>
          Live
        </NavLink>
        <NavLink to="/history">History</NavLink>
        {isAdmin(me) && <NavLink to="/admin">Admin</NavLink>}
        {isPlatformAdmin(me) && <NavLink to="/platform">Platform</NavLink>}
      </nav>
      <div className="topbar-right">
        {(isAdmin(me) || me?.user?.role === 'member') && (
          <button
            className="btn btn-ghost kiosk-launch"
            title="Full-screen board for a big display"
            onClick={() => {
              void document.documentElement.requestFullscreen?.().catch(() => {});
              navigate('/kiosk');
            }}
          >
            ▣ Kiosk
          </button>
        )}
        {me?.user ? (
          <>
            <Link className="username mono-label" to="/account">
              {(me.user.email ?? me.user.username).toUpperCase()}
            </Link>
            <button className="btn btn-ghost" onClick={() => void logout()}>
              Sign out
            </button>
          </>
        ) : (
          <Link className="btn btn-ghost" to="/login">
            Member sign in
          </Link>
        )}
      </div>
    </header>
  );
}
