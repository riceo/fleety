import { Link, NavLink, useNavigate } from 'react-router-dom';
import { post } from '../api';
import { isAdmin, useAuth } from '../auth';

// The Invicta horse fallback mark — the real club logo can be uploaded in
// Admin → Settings and takes over everywhere.
export function BrandMark() {
  return (
    <svg viewBox="0 0 32 32" className="brand-mark" aria-hidden>
      <rect x="1" y="1" width="30" height="30" rx="7" fill="#d1202f" />
      <path
        fill="#ffffff"
        d="M10 26 L23.5 26 C23.5 22.6 22.2 21 20 19.7 C22 17.5 22.8 14.4 21.4 11.7 C20.1 9.2 17.4 7.6 14.6 7.8 L14.1 5.6 L12.5 6.2 L12.8 8.5 C10.7 9.6 9.4 11.7 9.7 14 C9.9 15.5 10.8 16.8 12.1 17.5 L11.2 19.3 C10.2 20.8 9.8 22.6 10 24.4 Z"
      />
      <path fill="#ffffff" d="M14.6 7.8 L16.6 4.6 L17.6 8.2 Z" />
      <circle cx="14.6" cy="11.4" r="1" fill="#d1202f" />
    </svg>
  );
}

export function Brand({ siteName, logoUrl }: { siteName: string; logoUrl?: string | null }) {
  return (
    <Link to="/" className="brand">
      {logoUrl ? <img src={logoUrl} alt="" className="brand-logo" /> : <BrandMark />}
      <span className="brand-name">{siteName}</span>
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
      <Brand siteName={config?.siteName ?? 'FleetView'} logoUrl={config?.logoUrl} />
      <nav className="topnav">
        <NavLink to="/" end>
          Live
        </NavLink>
        <NavLink to="/history">History</NavLink>
        {isAdmin(me) && <NavLink to="/admin">Admin</NavLink>}
      </nav>
      <div className="topbar-right">
        {me?.user ? (
          <>
            <span className="username">{me.user.username}</span>
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
