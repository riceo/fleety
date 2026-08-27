import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { Navigate, NavLink, Outlet } from 'react-router-dom';
import { api, del, post, put, type Flight } from '../api';
import { isAdmin, useAuth } from '../auth';
import { TopBar } from '../components/TopBar';
import { ImageCropper } from '../components/ImageCropper';
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
          <NavLink to="/admin/members">Members</NavLink>
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
  tagline: string;
  description: string;
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
  tagline: '',
  description: '',
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
      tagline: f.tagline,
      description: f.description,
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

  const upload = async (kind: 'icon' | 'photo', file: Blob, name: string) => {
    const fd = new FormData();
    fd.append('file', file, name);
    await api(`/api/admin/aircraft/${initial.id}/image?kind=${kind}`, { method: 'POST', body: fd });
    onDone();
  };

  // Selected files pass through the cropper first so what's uploaded is
  // exactly the frame that will be displayed (photo cards 3:2, icons square).
  const [cropping, setCropping] = useState<{ kind: 'icon' | 'photo'; file: File } | null>(null);
  const CROP_SPEC = {
    photo: { aspect: 3 / 2, outWidth: 1200, outType: 'image/jpeg' as const, name: 'photo.jpg', title: 'Position the photo' },
    icon: { aspect: 1, outWidth: 256, outType: 'image/png' as const, name: 'icon.png', title: 'Position the icon' },
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
            Track until — leave empty to keep the guest indefinitely
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
        Description (shown to viewers, e.g. “4-seat tourer — our IFR trainer”)
        <input value={f.description ?? ''} onChange={(e) => set('description', e.target.value)} maxLength={240} />
      </label>
      <label>
        Tagline (shown on the board & ticker, e.g. “Our aerobatic display ship — where's he displaying next?”)
        <input value={f.tagline ?? ''} onChange={(e) => set('tagline', e.target.value)} maxLength={160} />
      </label>
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
            <input
              type="file"
              accept="image/png,image/jpeg,image/webp"
              hidden
              onChange={(e) => {
                if (e.target.files?.[0]) setCropping({ kind: 'icon', file: e.target.files[0] });
                e.target.value = '';
              }}
            />
          </label>
          {initial.icon_path && (
            <button className="btn btn-ghost small" onClick={() => void del(`/api/admin/aircraft/${initial.id}/image?kind=icon`).then(onDone)}>
              Remove icon
            </button>
          )}
          <label className="btn small">
            {initial.photo_path ? 'Replace photo' : 'Upload photo'}
            <input
              type="file"
              accept="image/png,image/jpeg,image/webp"
              hidden
              onChange={(e) => {
                if (e.target.files?.[0]) setCropping({ kind: 'photo', file: e.target.files[0] });
                e.target.value = '';
              }}
            />
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

      {cropping && (
        <ImageCropper
          file={cropping.file}
          aspect={CROP_SPEC[cropping.kind].aspect}
          outWidth={CROP_SPEC[cropping.kind].outWidth}
          outType={CROP_SPEC[cropping.kind].outType}
          title={CROP_SPEC[cropping.kind].title}
          onDone={(blob) => {
            const { kind } = cropping;
            setCropping(null);
            void upload(kind, blob, CROP_SPEC[kind].name);
          }}
          onCancel={() => setCropping(null)}
        />
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
      tagline: a.tagline,
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

// ---------- members ----------

interface Member {
  id: number;
  username: string;
  email: string | null;
  role: 'member' | 'admin';
  last_login_at: number | null;
}

export function MembersAdmin() {
  const [data, reload] = useData<{ members: Member[] }>('/api/admin/members');
  const [email, setEmail] = useState('');
  const [name, setName] = useState('');
  const [role, setRole] = useState('member');
  const [error, setError] = useState('');
  const [shareLink, setShareLink] = useState('');

  const invite = async () => {
    setError('');
    setShareLink('');
    try {
      const res = await post<{ emailed: boolean; inviteLink: string | null }>('/api/admin/members', {
        email,
        name,
        role,
      });
      if (res.inviteLink) setShareLink(res.inviteLink);
      setEmail('');
      setName('');
      reload();
    } catch (err) {
      setError(`Could not invite: ${err instanceof Error ? err.message : err}`);
    }
  };

  const resetPassword = async (m: Member) => {
    const res = await post<{ emailed: boolean; resetLink: string | null }>(`/api/admin/members/${m.id}/reset`);
    if (res.resetLink) setShareLink(res.resetLink);
    else window.alert(`Reset link emailed to ${m.email}.`);
  };

  const setMemberRole = async (m: Member, newRole: string) => {
    try {
      await put(`/api/admin/members/${m.id}`, { role: newRole });
      reload();
    } catch (err) {
      window.alert(`Failed: ${err instanceof Error ? err.message : err}`);
    }
  };

  const remove = async (m: Member) => {
    if (!window.confirm(`Remove ${m.email ?? m.username} from this club? Their account keeps any other clubs.`)) return;
    try {
      await del(`/api/admin/members/${m.id}`);
      reload();
    } catch (err) {
      window.alert(`Failed: ${err instanceof Error ? err.message : err}`);
    }
  };

  return (
    <div>
      <h1>Members</h1>
      <div className="form-row inline-add">
        <input placeholder="email@example.com" type="email" value={email} onChange={(e) => setEmail(e.target.value)} />
        <input placeholder="Name (optional)" value={name} onChange={(e) => setName(e.target.value)} />
        <select value={role} onChange={(e) => setRole(e.target.value)}>
          <option value="member">Member</option>
          <option value="admin">Admin</option>
        </select>
        <button className="btn btn-primary" onClick={() => void invite()} disabled={!email.includes('@')}>
          Invite
        </button>
      </div>
      <p className="muted small">
        Invited members get an email with a set-password link. If email isn't configured, the link appears here to
        share by hand.
      </p>
      {shareLink && (
        <p className="form-row">
          <input readOnly value={shareLink} onFocus={(e) => e.target.select()} />
          <button className="btn small" onClick={() => void navigator.clipboard.writeText(shareLink)}>
            Copy link
          </button>
        </p>
      )}
      {error && <p className="form-error">{error}</p>}
      <table className="table">
        <thead>
          <tr>
            <th>Member</th>
            <th>Role</th>
            <th>Last sign-in</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          {data?.members.map((m) => (
            <tr key={m.id}>
              <td>
                <strong>{m.email ?? m.username}</strong>
              </td>
              <td>
                <select value={m.role} onChange={(e) => void setMemberRole(m, e.target.value)}>
                  <option value="member">member</option>
                  <option value="admin">admin</option>
                </select>
              </td>
              <td className="muted">{m.last_login_at ? fmtAgo(m.last_login_at) : 'never'}</td>
              <td className="row-actions">
                <button className="btn btn-ghost small" onClick={() => void resetPassword(m)}>
                  Reset password
                </button>
                <button className="btn btn-ghost small danger" onClick={() => void remove(m)}>
                  Remove
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

interface AirfieldDraft {
  code: string;
  name: string;
  lat: string;
  lon: string;
  elevationFt: string;
  radiusNm: string;
}

export function AirfieldsAdmin() {
  const [data, reload] = useData<{ airfields: Airfield[] }>('/api/admin/airfields');
  const [f, setF] = useState({ code: '', name: '', lat: '', lon: '', elevationFt: '', radiusNm: '3' });
  const [editingId, setEditingId] = useState<number | null>(null);
  const [draft, setDraft] = useState<AirfieldDraft | null>(null);

  const startEdit = (a: Airfield) => {
    setEditingId(a.id);
    setDraft({
      code: a.code,
      name: a.name,
      lat: String(a.lat),
      lon: String(a.lon),
      elevationFt: String(a.elevation_ft),
      radiusNm: String(a.radius_nm),
    });
  };

  const saveEdit = async (a: Airfield) => {
    if (!draft) return;
    await put(`/api/admin/airfields/${a.id}`, {
      code: draft.code,
      name: draft.name,
      lat: Number(draft.lat),
      lon: Number(draft.lon),
      elevationFt: Number(draft.elevationFt),
      radiusNm: Number(draft.radiusNm),
      isBase: a.is_base === 1,
    });
    setEditingId(null);
    setDraft(null);
    reload();
  };

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
          {data?.airfields.map((a) =>
            editingId === a.id && draft ? (
              <tr key={a.id}>
                <td>
                  <input
                    value={draft.code}
                    onChange={(e) => setDraft({ ...draft, code: e.target.value.toUpperCase() })}
                    style={{ width: '6rem' }}
                  />
                </td>
                <td>
                  <input value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} />
                </td>
                <td>
                  <input
                    value={draft.lat}
                    onChange={(e) => setDraft({ ...draft, lat: e.target.value })}
                    style={{ width: '6rem' }}
                  />{' '}
                  <input
                    value={draft.lon}
                    onChange={(e) => setDraft({ ...draft, lon: e.target.value })}
                    style={{ width: '6rem' }}
                  />
                </td>
                <td>
                  <input
                    value={draft.elevationFt}
                    onChange={(e) => setDraft({ ...draft, elevationFt: e.target.value })}
                    style={{ width: '4.5rem' }}
                  />
                </td>
                <td>
                  <input
                    value={draft.radiusNm}
                    onChange={(e) => setDraft({ ...draft, radiusNm: e.target.value })}
                    style={{ width: '3.5rem' }}
                  />
                </td>
                <td>
                  <input type="checkbox" checked={a.is_base === 1} onChange={() => void toggleBase(a)} />
                </td>
                <td className="row-actions">
                  <button
                    className="btn btn-primary small"
                    onClick={() => void saveEdit(a)}
                    disabled={!draft.code || !Number.isFinite(Number(draft.lat)) || !Number.isFinite(Number(draft.lon))}
                  >
                    Save
                  </button>
                  <button
                    className="btn btn-ghost small"
                    onClick={() => {
                      setEditingId(null);
                      setDraft(null);
                    }}
                  >
                    Cancel
                  </button>
                </td>
              </tr>
            ) : (
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
                  <button className="btn btn-ghost small" onClick={() => startEdit(a)}>
                    Edit
                  </button>
                  <button
                    className="btn btn-ghost small danger"
                    onClick={() => window.confirm(`Delete ${a.code}?`) && void del(`/api/admin/airfields/${a.id}`).then(reload)}
                  >
                    Delete
                  </button>
                </td>
              </tr>
            )
          )}
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

interface TickerEventRow {
  id: number;
  ts: number;
  text: string;
  registration: string | null;
}

function TickerBroadcast() {
  const [data, reload] = useData<{ events: TickerEventRow[] }>('/api/admin/ticker');
  const [text, setText] = useState('');

  const send = async () => {
    await post('/api/admin/ticker', { text });
    setText('');
    reload();
  };

  return (
    <section className="setting-block">
      <h3>Ticker broadcast</h3>
      <p className="muted small">
        Put any message straight on the tape — it shows for six hours (delete it early below). Departures and
        landings appear here too and can be removed if the detector got one wrong.
      </p>
      <div className="form-row">
        <label style={{ flex: 1 }}>
          Message
          <input
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder="BBQ at the clubhouse this Saturday — all welcome!"
            maxLength={200}
            onKeyDown={(e) => e.key === 'Enter' && text.trim() && void send()}
          />
        </label>
        <button className="btn btn-primary" onClick={() => void send()} disabled={!text.trim()}>
          Post to ticker
        </button>
      </div>
      {data && data.events.length > 0 && (
        <table className="table">
          <tbody>
            {data.events.slice(0, 12).map((e) => (
              <tr key={e.id}>
                <td className="mono">{fmtDateTime(e.ts)}</td>
                <td>{e.text}</td>
                <td className="muted">{e.registration ?? 'broadcast'}</td>
                <td className="row-actions">
                  <button
                    className="btn btn-ghost small danger"
                    onClick={() => void del(`/api/admin/ticker/${e.id}`).then(reload)}
                  >
                    Delete
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
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
      <h1>Messages & ticker</h1>
      <TickerBroadcast />
      <p className="muted small">
        Aircraft messages are shown on the board next to the aircraft and scrolled across the ticker — e.g. “PAX:
        Bob and Jess experience flight”. “Next flight” messages arm on take-off and clear automatically at landing.
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

interface ClubSettings {
  slug: string;
  name: string;
  subheading: string;
  theme: string;
  accent: string;
  logo_path: string | null;
  map_center: string;
  map_zoom: number;
  tile_style_url: string;
  public_mode: number;
  kiosk_token: string;
  callsign_rules: string;
}

const THEME_OPTIONS = [
  { key: 'ops', label: 'Ops board — condensed display + mono data (default)' },
  { key: 'terminal', label: 'Terminal — all-mono, phosphor green' },
  { key: 'heritage', label: 'Heritage — slab-serif, warm tones' },
  { key: 'daylight', label: 'Daylight — the light version' },
];

export function SettingsAdmin() {
  const [data, reload] = useData<{ club: ClubSettings }>('/api/admin/settings');
  const [form, setForm] = useState<Record<string, unknown>>({});
  const [rules, setRules] = useState<{ prefix: string; spoken: string }[] | null>(null);
  const [saved, setSaved] = useState(false);
  const club = data?.club;
  const val = <K extends keyof ClubSettings>(k: K, formKey: string): ClubSettings[K] | string =>
    (form[formKey] as string | undefined) ?? club?.[k] ?? '';
  const curRules: { prefix: string; spoken: string }[] =
    rules ?? (club ? (JSON.parse(club.callsign_rules || '[]') as { prefix: string; spoken: string }[]) : []);

  const save = async () => {
    await put('/api/admin/settings', { ...form, ...(rules ? { callsignRules: rules } : {}) });
    setForm({});
    setRules(null);
    setSaved(true);
    setTimeout(() => setSaved(false), 2000);
    reload();
    window.location.reload(); // theme/accent/name apply everywhere
  };

  const rotate = async () => {
    if (!window.confirm('Rotate the kiosk link? The current TV/kiosk screens will need the new link.')) return;
    await post('/api/admin/kiosk-token/rotate');
    reload();
  };

  const setKey = (k: string, v: unknown) => setForm((p) => ({ ...p, [k]: v }));
  const publicOn = form.publicMode !== undefined ? !!form.publicMode : club?.public_mode === 1;
  const kioskUrl = club ? `${window.location.origin}/kiosk?token=${club.kiosk_token}` : '';

  return (
    <div className="settings-page">
      <h1>Club settings</h1>

      <section className="setting-block">
        <h3>Access</h3>
        <label className="check big-check">
          <input type="checkbox" checked={publicOn} onChange={(e) => setKey('publicMode', e.target.checked)} />
          Open to the world (no sign-in needed to view the board)
        </label>
        <p className="muted small">
          When off, only members and the kiosk screen can see the tracker. Turning it off also disconnects any
          anonymous viewers immediately. Aircraft marked “members only” stay hidden from public view either way.
        </p>
      </section>

      <section className="setting-block">
        <h3>Kiosk / big screen</h3>
        <p className="muted small">Open this link on the clubhouse TV — it signs itself in with a view-only token:</p>
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
        <h3>Branding</h3>
        <div className="form-row">
          <label>
            Board name
            <input value={String(val('name', 'name'))} onChange={(e) => setKey('name', e.target.value)} />
          </label>
          <label>
            Subheading
            <input value={String(val('subheading', 'subheading'))} onChange={(e) => setKey('subheading', e.target.value)} />
          </label>
        </div>
        <div className="form-row">
          <label style={{ flex: 2 }}>
            Theme
            <select value={String(val('theme', 'theme'))} onChange={(e) => setKey('theme', e.target.value)}>
              {THEME_OPTIONS.map((t) => (
                <option key={t.key} value={t.key}>
                  {t.label}
                </option>
              ))}
            </select>
          </label>
          <label>
            Accent colour
            <input
              type="color"
              value={String(val('accent', 'accent')) || '#e32636'}
              onChange={(e) => setKey('accent', e.target.value)}
            />
          </label>
        </div>
        <div className="upload-row">
          {club?.logo_path ? (
            <img className="logo-preview" src={`/uploads/${club.logo_path}`} alt="Club logo" />
          ) : (
            <span className="muted small">No club logo uploaded yet — the neutral mark is shown.</span>
          )}
          <label className="btn small">
            {club?.logo_path ? 'Replace logo' : 'Upload club logo'}
            <input
              type="file"
              accept="image/png,image/jpeg,image/webp"
              hidden
              onChange={(e) => {
                const file = e.target.files?.[0];
                if (!file) return;
                const fd = new FormData();
                fd.append('file', file);
                void api('/api/admin/branding/logo', { method: 'POST', body: fd }).then(() => window.location.reload());
              }}
            />
          </label>
          {club?.logo_path && (
            <button
              className="btn btn-ghost small"
              onClick={() => void del('/api/admin/branding/logo').then(() => window.location.reload())}
            >
              Remove logo
            </button>
          )}
        </div>
      </section>

      <section className="setting-block">
        <h3>Callsigns</h3>
        <p className="muted small">
          How transmitted callsigns read on the board and ticker — e.g. prefix INV, spoken INVICTA turns “INV01”
          into “INVICTA 01”.
        </p>
        {curRules.map((r, i) => (
          <div className="form-row" key={i}>
            <label>
              Prefix
              <input
                value={r.prefix}
                onChange={(e) =>
                  setRules(curRules.map((x, j) => (j === i ? { ...x, prefix: e.target.value.toUpperCase() } : x)))
                }
                style={{ width: '7rem' }}
              />
            </label>
            <label>
              Spoken as
              <input
                value={r.spoken}
                onChange={(e) =>
                  setRules(curRules.map((x, j) => (j === i ? { ...x, spoken: e.target.value.toUpperCase() } : x)))
                }
              />
            </label>
            <button className="btn btn-ghost small danger" onClick={() => setRules(curRules.filter((_, j) => j !== i))}>
              Remove
            </button>
          </div>
        ))}
        <button className="btn small" onClick={() => setRules([...curRules, { prefix: '', spoken: '' }])}>
          Add rule
        </button>
      </section>

      <section className="setting-block">
        <h3>Map</h3>
        <div className="form-row">
          <label>
            Map style URL
            <input value={String(val('tile_style_url', 'tileStyleUrl'))} onChange={(e) => setKey('tileStyleUrl', e.target.value)} />
          </label>
        </div>
        <div className="form-row">
          <label>
            Map centre (lat,lon)
            <input value={String(val('map_center', 'mapCenter'))} onChange={(e) => setKey('mapCenter', e.target.value)} />
          </label>
          <label>
            Zoom
            <input value={String(val('map_zoom', 'mapZoom'))} onChange={(e) => setKey('mapZoom', e.target.value)} style={{ width: '5rem' }} />
          </label>
        </div>
      </section>

      <div className="form-actions">
        <button
          className="btn btn-primary"
          onClick={() => void save()}
          disabled={Object.keys(form).length === 0 && rules === null}
        >
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
