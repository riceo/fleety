import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { Navigate, NavLink, Outlet } from 'react-router-dom';
import { api, del, post, put, type Flight } from '../api';
import { isAdmin, useAuth } from '../auth';
import { TopBar } from '../components/TopBar';
import { BUILTIN_ICONS, ICON_KEYS } from '../icons';
import { fmtDateTime, fmtDuration, fmtNm, fmtAgo } from '../format';

// ---------- shared ----------

function useData<T>(path: string): [T | null, () => void] {
  const [data, setData] = useState<T | null>(null);
  const [tick, setTick] = useState(0);
  useEffect(() => {
    api<T>(path)
      .then(setData)
      .catch(() => {});
  }, [path, tick]);
  return [data, useCallback(() => setTick((t) => t + 1), [])];
}

function IconPreview({ icon, color }: { icon: string; color: string }) {
  const svg = (BUILTIN_ICONS[icon] ?? BUILTIN_ICONS['low-wing']).replaceAll('currentColor', color);
  return <span className="icon-preview" dangerouslySetInnerHTML={{ __html: svg }} />;
}

function Modal({ children, onClose }: { children: ReactNode; onClose: () => void }) {
  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        {children}
      </div>
    </div>
  );
}

export function AdminLayout() {
  const { me, loading } = useAuth();
  if (!loading && !isAdmin(me)) return <Navigate to="/login" replace />;
  return (
    <div className="app-shell">
      <TopBar />
      <div className="admin-layout">
        <nav className="admin-nav">
          <NavLink to="/admin" end>
            Aircraft
          </NavLink>
          <NavLink to="/admin/users">Users</NavLink>
          <NavLink to="/admin/airfields">Airfields</NavLink>
          <NavLink to="/admin/messages">Messages</NavLink>
          <NavLink to="/admin/flights">Flights</NavLink>
          <NavLink to="/admin/settings">Settings</NavLink>
          <NavLink to="/admin/status">Status</NavLink>
        </nav>
        <main className="admin-main">
          <Outlet />
        </main>
      </div>
    </div>
  );
}

// ---------- aircraft ----------

interface AdminAircraft {
  id: number;
  hex: string;
  registration: string;
  callsign: string;
  type_name: string;
  icao_type: string;
  nickname: string;
  operator: string;
  icon: string;
  icon_path: string | null;
  photo_path: string | null;
  color: string;
  enabled: number;
  category: 'fleet' | 'guest';
  visibility: 'public' | 'members';
  track_until: string | null;
  sort_order: number;
  notes: string;
}

const EMPTY_AC: Partial<AdminAircraft> = {
  registration: '',
  hex: '',
  callsign: '',
  type_name: '',
  nickname: '',
  operator: '',
  icon: 'low-wing',
  color: '#38bdf8',
  category: 'fleet',
  visibility: 'public',
  enabled: 1,
  track_until: null,
  notes: '',
};

function AircraftForm({ initial, onDone }: { initial: Partial<AdminAircraft>; onDone: () => void }) {
  const [f, setF] = useState<Partial<AdminAircraft>>(initial);
  const [error, setError] = useState('');
  const [looking, setLooking] = useState(false);
  const set = (k: keyof AdminAircraft, v: unknown) => setF((p) => ({ ...p, [k]: v }));
  const isEdit = !!initial.id;

  const lookup = async () => {
    if (!f.registration) return;
    setLooking(true);
    setError('');
    try {
      const r = await api<{ hex: string | null; typeName: string; operator: string; icaoType: string }>(
        `/api/admin/lookup?reg=${encodeURIComponent(f.registration)}`
      );
      if (r.hex) {
        setF((p) => ({
          ...p,
          hex: r.hex ?? p.hex,
          type_name: p.type_name || r.typeName,
          operator: p.operator || r.operator,
          icao_type: r.icaoType,
        }));
      } else {
        setError('No hex found for that registration — enter the 6-character ICAO hex manually.');
      }
    } catch {
      setError('Lookup failed — enter the hex manually.');
    } finally {
      setLooking(false);
    }
  };

  const save = async () => {
    setError('');
    const body = {
      hex: f.hex,
      registration: f.registration,
      callsign: f.callsign,
      typeName: f.type_name,
      icaoType: f.icao_type,
      nickname: f.nickname,
      operator: f.operator,
      icon: f.icon,
      color: f.color,
      enabled: f.enabled !== 0,
      category: f.category,
      visibility: f.visibility,
      trackUntil: f.track_until,
      sortOrder: f.sort_order ?? 0,
      notes: f.notes,
    };
    try {
      if (isEdit) await put(`/api/admin/aircraft/${initial.id}`, body);
      else await post('/api/admin/aircraft', body);
      onDone();
    } catch (err) {
      setError(err instanceof Error && err.message === 'hex_exists' ? 'An aircraft with that hex already exists.' : `Save failed: ${err}`);
    }
  };

  const upload = async (kind: 'icon' | 'photo', file: File) => {
    const fd = new FormData();
    fd.append('file', file);
    await api(`/api/admin/aircraft/${initial.id}/image?kind=${kind}`, { method: 'POST', body: fd });
    onDone();
  };

  return (
    <div className="form-grid">
      <h2>{isEdit ? `Edit ${initial.registration}` : 'Add aircraft'}</h2>
      <div className="form-row">
        <label>
          Registration
          <input value={f.registration ?? ''} onChange={(e) => set('registration', e.target.value.toUpperCase())} placeholder="G-ABCD" />
        </label>
        <button className="btn" onClick={() => void lookup()} disabled={looking || !f.registration}>
          {looking ? 'Looking up…' : 'Look up hex & type'}
        </button>
      </div>
      <div className="form-row">
        <label>
          ICAO hex
          <input value={f.hex ?? ''} onChange={(e) => set('hex', e.target.value.toLowerCase())} placeholder="4021ca" maxLength={6} />
        </label>
        <label>
          Callsign
          <input value={f.callsign ?? ''} onChange={(e) => set('callsign', e.target.value.toUpperCase())} placeholder="INV05" />
        </label>
      </div>
      <div className="form-row">
        <label>
          Type
          <input value={f.type_name ?? ''} onChange={(e) => set('type_name', e.target.value)} placeholder="Cessna 152" />
        </label>
        <label>
          Nickname
          <input value={f.nickname ?? ''} onChange={(e) => set('nickname', e.target.value)} placeholder="(optional)" />
        </label>
      </div>
      <div className="form-row">
        <label>
          Category
          <select value={f.category} onChange={(e) => set('category', e.target.value)}>
            <option value="fleet">Fleet</option>
            <option value="guest">Guest (temporary)</option>
          </select>
        </label>
        <label>
          Visibility
          <select value={f.visibility} onChange={(e) => set('visibility', e.target.value)}>
            <option value="public">Public (open site + kiosk)</option>
            <option value="members">Members only</option>
          </select>
        </label>
      </div>
      {f.category === 'guest' && (
        <div className="form-row">
          <label>
            Track until (auto-disables after)
            <input type="date" value={f.track_until ?? ''} onChange={(e) => set('track_until', e.target.value || null)} />
          </label>
        </div>
      )}
      <div className="form-row">
        <label>
          Map icon
          <select value={f.icon} onChange={(e) => set('icon', e.target.value)}>
            {ICON_KEYS.map((k) => (
              <option key={k} value={k}>
                {k}
              </option>
            ))}
          </select>
        </label>
        <label>
          Colour
          <input type="color" value={f.color ?? '#38bdf8'} onChange={(e) => set('color', e.target.value)} />
        </label>
        <IconPreview icon={f.icon ?? 'low-wing'} color={f.color ?? '#38bdf8'} />
      </div>
      <label>
        Notes
        <input value={f.notes ?? ''} onChange={(e) => set('notes', e.target.value)} />
      </label>
      <label className="check">
        <input type="checkbox" checked={f.enabled !== 0} onChange={(e) => set('enabled', e.target.checked ? 1 : 0)} />
        Tracking enabled
      </label>

      {isEdit && (
        <div className="upload-row">
          <label className="btn small">
            {initial.icon_path ? 'Replace custom icon' : 'Upload custom icon'}
            <input type="file" accept="image/png,image/jpeg,image/webp" hidden onChange={(e) => e.target.files?.[0] && void upload('icon', e.target.files[0])} />
          </label>
          {initial.icon_path && (
            <button className="btn btn-ghost small" onClick={() => void del(`/api/admin/aircraft/${initial.id}/image?kind=icon`).then(onDone)}>
              Remove icon
            </button>
          )}
          <label className="btn small">
            {initial.photo_path ? 'Replace photo' : 'Upload photo'}
            <input type="file" accept="image/png,image/jpeg,image/webp" hidden onChange={(e) => e.target.files?.[0] && void upload('photo', e.target.files[0])} />
          </label>
          {initial.photo_path && (
            <>
              <img className="photo-preview" src={`/uploads/${initial.photo_path}`} alt="" />
              <button className="btn btn-ghost small" onClick={() => void del(`/api/admin/aircraft/${initial.id}/image?kind=photo`).then(onDone)}>
                Remove photo
              </button>
            </>
          )}
        </div>
      )}

      {error && <p className="form-error">{error}</p>}
      <div className="form-actions">
        <button className="btn btn-primary" onClick={() => void save()}>
          {isEdit ? 'Save changes' : 'Add aircraft'}
        </button>
        <button className="btn btn-ghost" onClick={onDone}>
          Cancel
        </button>
      </div>
    </div>
  );
}

export function AircraftAdmin() {
  const [data, reload] = useData<{ aircraft: AdminAircraft[] }>('/api/admin/aircraft');
  const [editing, setEditing] = useState<Partial<AdminAircraft> | null>(null);

  const toggle = async (a: AdminAircraft) => {
    await put(`/api/admin/aircraft/${a.id}`, {
      hex: a.hex,
      registration: a.registration,
      callsign: a.callsign,
      typeName: a.type_name,
      icaoType: a.icao_type,
      nickname: a.nickname,
      operator: a.operator,
      icon: a.icon,
      color: a.color,
      enabled: a.enabled === 0,
      category: a.category,
      visibility: a.visibility,
      trackUntil: a.track_until,
      sortOrder: a.sort_order,
      notes: a.notes,
    });
    reload();
  };

  const remove = async (a: AdminAircraft) => {
    if (!window.confirm(`Stop tracking ${a.registration} and hide it? Its recorded history is kept.`)) return;
    await del(`/api/admin/aircraft/${a.id}`);
    reload();
  };

  return (
    <div>
      <div className="page-head">
        <h1>Aircraft</h1>
        <button className="btn btn-primary" onClick={() => setEditing(EMPTY_AC)}>
          Add aircraft
        </button>
      </div>
      <p className="muted small">
        Add any aircraft by registration — the hex, type and operator are looked up automatically. Guests can be
        set to auto-expire and hidden from the public site.
      </p>
      <table className="table">
        <thead>
          <tr>
            <th></th>
            <th>Reg</th>
            <th>Callsign</th>
            <th>Hex</th>
            <th>Type</th>
            <th>Category</th>
            <th>Visibility</th>
            <th>Tracking</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          {data?.aircraft.map((a) => (
            <tr key={a.id} className={a.enabled ? '' : 'row-disabled'}>
              <td>
                <IconPreview icon={a.icon} color={a.color} />
              </td>
              <td>
                <strong>{a.registration}</strong>
              </td>
              <td>{a.callsign}</td>
              <td className="mono">{a.hex}</td>
              <td>{a.nickname || a.type_name}</td>
              <td>
                {a.category}
                {a.category === 'guest' && a.track_until ? ` (until ${a.track_until})` : ''}
              </td>
              <td>{a.visibility === 'members' ? 'members only' : 'public'}</td>
              <td>
                <button className={`btn small ${a.enabled ? 'btn-primary' : ''}`} onClick={() => void toggle(a)}>
                  {a.enabled ? 'On' : 'Off'}
                </button>
              </td>
              <td className="row-actions">
                <button className="btn btn-ghost small" onClick={() => setEditing(a)}>
                  Edit
                </button>
                <button className="btn btn-ghost small danger" onClick={() => void remove(a)}>
                  Remove
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {editing && (
        <Modal onClose={() => setEditing(null)}>
          <AircraftForm
            initial={editing}
            onDone={() => {
              setEditing(null);
              reload();
            }}
          />
        </Modal>
      )}
    </div>
  );
}

// ---------- users ----------

interface AdminUser {
  id: number;
  username: string;
  role: 'member' | 'admin';
  must_change_password: number;
  last_login_at: number | null;
}

export function UsersAdmin() {
  const [data, reload] = useData<{ users: AdminUser[] }>('/api/admin/users');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [role, setRole] = useState('member');
  const [error, setError] = useState('');

  const add = async () => {
    setError('');
    try {
      await post('/api/admin/users', { username, password, role });
      setUsername('');
      setPassword('');
      reload();
    } catch (err) {
      setError(`Could not create user: ${err instanceof Error ? err.message : err}`);
    }
  };

  const resetPassword = async (u: AdminUser) => {
    const pw = window.prompt(`New temporary password for ${u.username} (they must change it on sign-in):`);
    if (!pw) return;
    try {
      await put(`/api/admin/users/${u.id}`, { password: pw });
      reload();
    } catch (err) {
      window.alert(`Failed: ${err instanceof Error ? err.message : err}`);
    }
  };

  const setUserRole = async (u: AdminUser, newRole: string) => {
    try {
      await put(`/api/admin/users/${u.id}`, { role: newRole });
      reload();
    } catch (err) {
      window.alert(`Failed: ${err instanceof Error ? err.message : err}`);
    }
  };

  const remove = async (u: AdminUser) => {
    if (!window.confirm(`Delete user ${u.username}?`)) return;
    try {
      await del(`/api/admin/users/${u.id}`);
      reload();
    } catch (err) {
      window.alert(`Failed: ${err instanceof Error ? err.message : err}`);
    }
  };

  return (
    <div>
      <h1>Members</h1>
      <div className="form-row inline-add">
        <input placeholder="Username" value={username} onChange={(e) => setUsername(e.target.value)} />
        <input placeholder="Temporary password" type="text" value={password} onChange={(e) => setPassword(e.target.value)} />
        <select value={role} onChange={(e) => setRole(e.target.value)}>
          <option value="member">Member</option>
          <option value="admin">Admin</option>
        </select>
        <button className="btn btn-primary" onClick={() => void add()} disabled={!username || password.length < 8}>
          Add member
        </button>
      </div>
      <p className="muted small">New members must change their password on first sign-in.</p>
      {error && <p className="form-error">{error}</p>}
      <table className="table">
        <thead>
          <tr>
            <th>Username</th>
            <th>Role</th>
            <th>Last sign-in</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          {data?.users.map((u) => (
            <tr key={u.id}>
              <td>
                <strong>{u.username}</strong>
                {u.must_change_password === 1 && <span className="muted small"> (must change password)</span>}
              </td>
              <td>
                <select value={u.role} onChange={(e) => void setUserRole(u, e.target.value)}>
                  <option value="member">member</option>
                  <option value="admin">admin</option>
                </select>
              </td>
              <td className="muted">{u.last_login_at ? fmtAgo(u.last_login_at) : 'never'}</td>
              <td className="row-actions">
                <button className="btn btn-ghost small" onClick={() => void resetPassword(u)}>
                  Reset password
                </button>
                <button className="btn btn-ghost small danger" onClick={() => void remove(u)}>
                  Delete
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// ---------- airfields ----------

interface Airfield {
  id: number;
  code: string;
  name: string;
  lat: number;
  lon: number;
  elevation_ft: number;
  radius_nm: number;
  is_base: number;
}

export function AirfieldsAdmin() {
  const [data, reload] = useData<{ airfields: Airfield[] }>('/api/admin/airfields');
  const [f, setF] = useState({ code: '', name: '', lat: '', lon: '', elevationFt: '', radiusNm: '3' });

  const add = async () => {
    await post('/api/admin/airfields', {
      code: f.code,
      name: f.name,
      lat: Number(f.lat),
      lon: Number(f.lon),
      elevationFt: Number(f.elevationFt),
      radiusNm: Number(f.radiusNm),
    });
    setF({ code: '', name: '', lat: '', lon: '', elevationFt: '', radiusNm: '3' });
    reload();
  };

  const toggleBase = async (a: Airfield) => {
    await put(`/api/admin/airfields/${a.id}`, {
      code: a.code,
      name: a.name,
      lat: a.lat,
      lon: a.lon,
      elevationFt: a.elevation_ft,
      radiusNm: a.radius_nm,
      isBase: a.is_base !== 1,
    });
    reload();
  };

  return (
    <div>
      <h1>Airfields</h1>
      <p className="muted small">
        Used to detect departures and landings. Add fields the fleet regularly visits — elevation and a sensible
        radius make landing detection much more reliable.
      </p>
      <div className="form-row inline-add">
        <input placeholder="Code (EGTO)" value={f.code} onChange={(e) => setF({ ...f, code: e.target.value.toUpperCase() })} style={{ width: '7rem' }} />
        <input placeholder="Name" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} />
        <input placeholder="Lat" value={f.lat} onChange={(e) => setF({ ...f, lat: e.target.value })} style={{ width: '6rem' }} />
        <input placeholder="Lon" value={f.lon} onChange={(e) => setF({ ...f, lon: e.target.value })} style={{ width: '6rem' }} />
        <input placeholder="Elev ft" value={f.elevationFt} onChange={(e) => setF({ ...f, elevationFt: e.target.value })} style={{ width: '5rem' }} />
        <button className="btn btn-primary" onClick={() => void add()} disabled={!f.code || !f.lat || !f.lon}>
          Add
        </button>
      </div>
      <table className="table">
        <thead>
          <tr>
            <th>Code</th>
            <th>Name</th>
            <th>Lat / Lon</th>
            <th>Elevation</th>
            <th>Radius</th>
            <th>Club base</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          {data?.airfields.map((a) => (
            <tr key={a.id}>
              <td>
                <strong>{a.code}</strong>
              </td>
              <td>{a.name}</td>
              <td className="mono">
                {a.lat.toFixed(4)}, {a.lon.toFixed(4)}
              </td>
              <td>{a.elevation_ft} ft</td>
              <td>{a.radius_nm} nm</td>
              <td>
                <input type="checkbox" checked={a.is_base === 1} onChange={() => void toggleBase(a)} />
              </td>
              <td className="row-actions">
                <button
                  className="btn btn-ghost small danger"
                  onClick={() => window.confirm(`Delete ${a.code}?`) && void del(`/api/admin/airfields/${a.id}`).then(reload)}
                >
                  Delete
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// ---------- flights ----------

export function FlightsAdmin() {
  const [data, reload] = useData<{ flights: Flight[] }>('/api/flights?limit=100');
  const [checked, setChecked] = useState<Set<number>>(new Set());

  const toggleCheck = (id: number) =>
    setChecked((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const merge = async () => {
    if (checked.size < 2) return;
    if (!window.confirm(`Merge ${checked.size} flights into one? (They must belong to the same aircraft.)`)) return;
    try {
      await post('/api/admin/flights/merge', { flightIds: [...checked] });
      setChecked(new Set());
      reload();
    } catch (err) {
      window.alert(`Merge failed: ${err instanceof Error ? err.message : err}`);
    }
  };

  const editRoute = async (f: Flight) => {
    const origin = window.prompt('Origin (ICAO/code):', f.route_origin ?? f.origin_code ?? '');
    if (origin === null) return;
    const dest = window.prompt('Destination (ICAO/code):', f.route_destination ?? f.dest_code ?? '');
    if (dest === null) return;
    await put(`/api/admin/flights/${f.id}`, { routeOrigin: origin, routeDestination: dest });
    reload();
  };

  const remove = async (f: Flight) => {
    if (!window.confirm(`Delete this flight record for ${f.registration}? Its positions are kept unassigned.`)) return;
    await del(`/api/admin/flights/${f.id}`);
    reload();
  };

  return (
    <div>
      <div className="page-head">
        <h1>Flights</h1>
        <button className="btn btn-primary" onClick={() => void merge()} disabled={checked.size < 2}>
          Merge selected ({checked.size})
        </button>
      </div>
      <p className="muted small">
        Coverage gaps can occasionally fragment one flight into several, or glue two together — select fragments and
        merge them, or edit routes the detector got wrong.
      </p>
      <table className="table">
        <thead>
          <tr>
            <th></th>
            <th>Aircraft</th>
            <th>Started</th>
            <th>Route</th>
            <th>Duration</th>
            <th>Distance</th>
            <th>End</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          {data?.flights.map((f) => (
            <tr key={f.id}>
              <td>
                <input type="checkbox" checked={checked.has(f.id)} onChange={() => toggleCheck(f.id)} />
              </td>
              <td>
                <strong>{f.registration}</strong> {f.callsign ?? ''}
              </td>
              <td>{fmtDateTime(f.started_at)}</td>
              <td>
                {f.route_origin ?? f.origin_code ?? '?'} → {f.route_destination ?? f.dest_code ?? '?'}
              </td>
              <td>{f.ended_at ? fmtDuration(f.ended_at - f.started_at) : 'open'}</td>
              <td>{fmtNm(f.distance_nm)}</td>
              <td className="muted">{f.end_confidence ?? '—'}{f.gap_count > 0 ? ` · ${f.gap_count} gaps` : ''}</td>
              <td className="row-actions">
                <button className="btn btn-ghost small" onClick={() => void editRoute(f)}>
                  Route
                </button>
                <button className="btn btn-ghost small danger" onClick={() => void remove(f)}>
                  Delete
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// ---------- kiosk messages ----------

interface Annotation {
  id: number;
  aircraft_id: number;
  text: string;
  mode: 'until' | 'next_flight';
  until_ts: number | null;
  status: 'pending' | 'active' | 'done';
  created_by: string;
  created_at: number;
  registration: string;
  callsign: string;
}

export function MessagesAdmin() {
  const [data, reload] = useData<{ annotations: Annotation[] }>('/api/admin/annotations');
  const [aircraft, setAircraft] = useState<{ id: number; registration: string; callsign: string }[]>([]);
  const [aircraftId, setAircraftId] = useState('');
  const [text, setText] = useState('');
  const [mode, setMode] = useState<'next_flight' | 'until'>('next_flight');
  const [until, setUntil] = useState('');
  const [error, setError] = useState('');

  useEffect(() => {
    api<{ aircraft: { id: number; registration: string; callsign: string }[] }>('/api/admin/aircraft')
      .then((r) => setAircraft(r.aircraft))
      .catch(() => {});
  }, []);

  const add = async () => {
    setError('');
    try {
      await post('/api/admin/annotations', {
        aircraftId: Number(aircraftId),
        text,
        mode,
        untilTs: mode === 'until' && until ? new Date(until).getTime() : undefined,
      });
      setText('');
      reload();
    } catch (err) {
      setError(`Could not add message: ${err instanceof Error ? err.message : err}`);
    }
  };

  const liveOnes = data?.annotations.filter((a) => a.status !== 'done' && !(a.mode === 'until' && (a.until_ts ?? 0) < Date.now())) ?? [];
  const pastOnes = data?.annotations.filter((a) => !liveOnes.includes(a)) ?? [];

  return (
    <div>
      <h1>Kiosk messages</h1>
      <p className="muted small">
        Shown on the big screen next to the aircraft and scrolled across the ticker — e.g. “PAX: Bob and Jess
        experience flight”. “Next flight” messages arm on take-off and clear automatically at landing.
      </p>
      <div className="setting-block form-grid">
        <div className="form-row">
          <label>
            Aircraft
            <select value={aircraftId} onChange={(e) => setAircraftId(e.target.value)}>
              <option value="">Choose…</option>
              {aircraft.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.registration} · {a.callsign}
                </option>
              ))}
            </select>
          </label>
          <label style={{ flex: 2 }}>
            Message
            <input value={text} onChange={(e) => setText(e.target.value)} placeholder="PAX: Bob and Jess experience flight" maxLength={200} />
          </label>
        </div>
        <div className="form-row">
          <label>
            Applies
            <select value={mode} onChange={(e) => setMode(e.target.value as 'next_flight' | 'until')}>
              <option value="next_flight">For the next flight (take-off → landing)</option>
              <option value="until">Until a set time</option>
            </select>
          </label>
          {mode === 'until' && (
            <label>
              Until
              <input type="datetime-local" value={until} onChange={(e) => setUntil(e.target.value)} />
            </label>
          )}
          <button className="btn btn-primary" onClick={() => void add()} disabled={!aircraftId || !text.trim() || (mode === 'until' && !until)}>
            Add message
          </button>
        </div>
        {error && <p className="form-error">{error}</p>}
      </div>

      <h3>Live & queued</h3>
      <table className="table">
        <thead>
          <tr>
            <th>Aircraft</th>
            <th>Message</th>
            <th>Applies</th>
            <th>Status</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          {liveOnes.map((a) => (
            <tr key={a.id}>
              <td>
                <strong>{a.registration}</strong> {a.callsign}
              </td>
              <td>{a.text}</td>
              <td className="muted">
                {a.mode === 'next_flight' ? 'next flight' : `until ${fmtDateTime(a.until_ts ?? 0)}`}
              </td>
              <td>{a.status === 'active' ? 'airborne now' : 'queued'}</td>
              <td className="row-actions">
                <button className="btn btn-ghost small danger" onClick={() => void del(`/api/admin/annotations/${a.id}`).then(reload)}>
                  Clear
                </button>
              </td>
            </tr>
          ))}
          {liveOnes.length === 0 && (
            <tr>
              <td colSpan={5} className="muted">
                No live messages.
              </td>
            </tr>
          )}
        </tbody>
      </table>
      {pastOnes.length > 0 && (
        <>
          <h3 style={{ marginTop: '1.2rem' }}>Recent</h3>
          <table className="table">
            <tbody>
              {pastOnes.slice(0, 10).map((a) => (
                <tr key={a.id}>
                  <td>
                    <strong>{a.registration}</strong>
                  </td>
                  <td className="muted">{a.text}</td>
                  <td className="muted">{fmtDateTime(a.created_at)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}
    </div>
  );
}

// ---------- settings ----------

export function SettingsAdmin() {
  const [data, reload] = useData<{ settings: Record<string, string> }>('/api/admin/settings');
  const [form, setForm] = useState<Record<string, string>>({});
  const [saved, setSaved] = useState(false);
  const s = { ...data?.settings, ...form };

  const save = async () => {
    await put('/api/admin/settings', form);
    setForm({});
    setSaved(true);
    setTimeout(() => setSaved(false), 2000);
    reload();
  };

  const rotate = async () => {
    if (!window.confirm('Rotate the kiosk link? The current TV/kiosk screens will need the new link.')) return;
    await post('/api/admin/kiosk-token/rotate');
    reload();
  };

  const setKey = (k: string, v: string) => setForm((p) => ({ ...p, [k]: v }));
  const publicOn = s.public_mode === '1';
  const kioskUrl = data ? `${window.location.origin}/kiosk?token=${data.settings.kiosk_token}` : '';

  return (
    <div className="settings-page">
      <h1>Settings</h1>

      <section className="setting-block">
        <h3>Site access</h3>
        <label className="check big-check">
          <input type="checkbox" checked={publicOn} onChange={(e) => setKey('public_mode', e.target.checked ? '1' : '0')} />
          Open to the world (no sign-in needed to view the map)
        </label>
        <p className="muted small">
          When off, only members and the kiosk screen can see the tracker. Turning it off also disconnects any
          anonymous viewers immediately. Aircraft marked “members only” stay hidden from public view either way.
        </p>
      </section>

      <section className="setting-block">
        <h3>Kiosk / big screen</h3>
        <p className="muted small">Open this link on the coffee-shop TV — it signs itself in with a view-only token:</p>
        <div className="form-row">
          <input readOnly value={kioskUrl} onFocus={(e) => e.target.select()} />
          <button className="btn small" onClick={() => void navigator.clipboard.writeText(kioskUrl)}>
            Copy
          </button>
          <button className="btn btn-ghost small" onClick={() => void rotate()}>
            Rotate link
          </button>
        </div>
      </section>

      <section className="setting-block">
        <h3>Branding & map</h3>
        <div className="form-row">
          <label>
            Site name
            <input value={s.site_name ?? ''} onChange={(e) => setKey('site_name', e.target.value)} />
          </label>
        </div>
        <div className="upload-row">
          {data?.settings.logo_path ? (
            <img className="logo-preview" src={`/uploads/${data.settings.logo_path}`} alt="Club logo" />
          ) : (
            <span className="muted small">No club logo uploaded yet — the fallback mark is shown.</span>
          )}
          <label className="btn small">
            {data?.settings.logo_path ? 'Replace logo' : 'Upload club logo'}
            <input
              type="file"
              accept="image/png,image/jpeg,image/webp"
              hidden
              onChange={(e) => {
                const file = e.target.files?.[0];
                if (!file) return;
                const fd = new FormData();
                fd.append('file', file);
                void api('/api/admin/branding/logo', { method: 'POST', body: fd }).then(reload);
              }}
            />
          </label>
          {data?.settings.logo_path && (
            <button className="btn btn-ghost small" onClick={() => void del('/api/admin/branding/logo').then(reload)}>
              Remove logo
            </button>
          )}
        </div>
        <div className="form-row">
          <label>
            Map style URL
            <input value={s.tile_style_url ?? ''} onChange={(e) => setKey('tile_style_url', e.target.value)} />
          </label>
        </div>
        <div className="form-row">
          <label>
            Map centre (lat,lon)
            <input value={s.map_center ?? ''} onChange={(e) => setKey('map_center', e.target.value)} />
          </label>
          <label>
            Zoom
            <input value={s.map_zoom ?? ''} onChange={(e) => setKey('map_zoom', e.target.value)} style={{ width: '5rem' }} />
          </label>
        </div>
      </section>

      <section className="setting-block">
        <h3>Data collection</h3>
        <div className="form-row">
          <label>
            Poll interval, aircraft active (ms)
            <input value={s.poll_fast_ms ?? ''} onChange={(e) => setKey('poll_fast_ms', e.target.value)} />
          </label>
          <label>
            Poll interval, idle (ms)
            <input value={s.poll_slow_ms ?? ''} onChange={(e) => setKey('poll_slow_ms', e.target.value)} />
          </label>
        </div>
        <div className="form-row">
          <label>
            Keep raw ADS-B JSON (days)
            <input value={s.raw_retention_days ?? ''} onChange={(e) => setKey('raw_retention_days', e.target.value)} />
          </label>
          <label>
            Watchdog ping URL (healthchecks.io)
            <input value={s.deadman_url ?? ''} onChange={(e) => setKey('deadman_url', e.target.value)} placeholder="(optional)" />
          </label>
        </div>
        <p className="muted small">
          Positions themselves are kept forever — only the verbose raw JSON is pruned. The watchdog URL is pinged
          while polling is healthy, so a dead tracker raises an alert.
        </p>
      </section>

      <div className="form-actions">
        <button className="btn btn-primary" onClick={() => void save()} disabled={Object.keys(form).length === 0}>
          Save settings
        </button>
        {saved && <span className="saved-note">Saved ✓</span>}
      </div>
    </div>
  );
}

// ---------- status ----------

interface StatusRes {
  poller: { lastPollAt: number; ok: boolean; error: string | null };
  recentPolls: { ts: number; provider: string; ok: number; error: string | null; aircraft_returned: number; duration_ms: number }[];
  counts: { positions: number; flights: number; aircraft: number; users: number };
  dbSizeBytes: number;
  sseClients: number;
}

export function StatusAdmin() {
  const [data, reload] = useData<StatusRes>('/api/admin/status');
  useEffect(() => {
    const t = setInterval(reload, 10_000);
    return () => clearInterval(t);
  }, [reload]);

  if (!data) return <p className="muted">Loading…</p>;
  return (
    <div>
      <h1>Status</h1>
      <div className="stat-tiles">
        <div className={`stat-tile ${data.poller.ok ? 'ok' : 'bad'}`}>
          <label>Data feed</label>
          <strong>{data.poller.ok ? 'Healthy' : 'Failing'}</strong>
          <span className="muted small">
            last poll {data.poller.lastPollAt ? fmtAgo(data.poller.lastPollAt) : 'never'}
            {data.poller.error ? ` — ${data.poller.error}` : ''}
          </span>
        </div>
        <div className="stat-tile">
          <label>Positions stored</label>
          <strong>{data.counts.positions.toLocaleString()}</strong>
        </div>
        <div className="stat-tile">
          <label>Flights recorded</label>
          <strong>{data.counts.flights.toLocaleString()}</strong>
        </div>
        <div className="stat-tile">
          <label>Database size</label>
          <strong>{(data.dbSizeBytes / 1024 / 1024).toFixed(1)} MB</strong>
        </div>
        <div className="stat-tile">
          <label>Live viewers</label>
          <strong>{data.sseClients}</strong>
        </div>
      </div>
      <h3>Recent polls</h3>
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
              <td>{fmtDateTime(p.ts)}</td>
              <td>{p.provider}</td>
              <td>{p.ok ? 'ok' : `error: ${p.error}`}</td>
              <td>{p.aircraft_returned}</td>
              <td>{p.duration_ms} ms</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
