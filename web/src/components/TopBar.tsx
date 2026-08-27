import { Link, NavLink, useNavigate } from 'react-router-dom';
import { post } from '../api';
import { isAdmin, useAuth } from '../auth';

// The real club logo ships with the app; an uploaded one (Admin → Settings)
// takes precedence.
export const DEFAULT_LOGO = '/invicta-logo.png';

export function Brand({ siteName, logoUrl }: { siteName: string; logoUrl?: string | null }) {
  return (
    <Link to="/" className="brand">
      <img src={logoUrl || DEFAULT_LOGO} alt="" className="brand-logo" />
      <span className="brand-name">
        {siteName.toUpperCase()}
        <span className="brand-sub">OPERATIONS BOARD</span>
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
            <span className="username mono-label">{me.user.username.toUpperCase()}</span>
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
