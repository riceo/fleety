import { useEffect, useState } from 'react';
import { Link, Navigate } from 'react-router-dom';
import { api, type Flight } from '../api';
import { useAuth } from '../auth';
import { TopBar } from '../components/TopBar';
import { fmtDateTime, fmtDuration, fmtNm, fmtAlt } from '../format';

interface AircraftLite {
  id: number;
  registration: string;
  callsign: string;
  type_name: string;
  color: string;
}

export function HistoryPage() {
  const { me, loading } = useAuth();
  const [aircraft, setAircraft] = useState<AircraftLite[]>([]);
  const [flights, setFlights] = useState<Flight[]>([]);
  const [filter, setFilter] = useState<number | ''>('');
  const [offset, setOffset] = useState(0);
  const [done, setDone] = useState(false);
  const PAGE = 50;

  useEffect(() => {
    api<{ aircraft: AircraftLite[] }>('/api/aircraft')
      .then((r) => setAircraft(r.aircraft))
      .catch(() => {});
  }, []);

  useEffect(() => {
    const q = new URLSearchParams();
    if (filter !== '') q.set('aircraftId', String(filter));
    q.set('limit', String(PAGE));
    q.set('offset', String(offset));
    api<{ flights: Flight[] }>(`/api/flights?${q}`)
      .then((r) => {
        setFlights((prev) => (offset === 0 ? r.flights : [...prev, ...r.flights]));
        setDone(r.flights.length < PAGE);
      })
      .catch(() => {});
  }, [filter, offset]);

  if (!loading && me && !me.user?.role && !me.user?.platformAdmin && !me.publicMode) return <Navigate to="/login" replace />;

  return (
    <div className="app-shell">
      <TopBar />
      <main className="page">
        <div className="page-head">
          <h1>Flight history</h1>
          <select
            value={filter}
            onChange={(e) => {
              setFilter(e.target.value === '' ? '' : Number(e.target.value));
              setOffset(0);
            }}
          >
            <option value="">All aircraft</option>
            {aircraft.map((a) => (
              <option key={a.id} value={a.id}>
                {a.registration} · {a.callsign || a.type_name}
              </option>
            ))}
          </select>
        </div>

        <div className="flight-list">
          {flights.map((f) => (
            <Link key={f.id} to={`/history/${f.id}`} className="flight-row">
              <span className="flight-color" style={{ background: f.color }} />
              <div className="flight-main">
                <strong>
                  {f.registration}
                  {f.callsign ? ` · ${f.callsign}` : ''}
                </strong>
                <span className="muted">{fmtDateTime(f.started_at)}</span>
              </div>
              <div className="flight-route">
                {f.route_origin ?? f.origin_code ?? '?'} → {f.ended_at ? (f.route_destination ?? f.dest_code ?? '?') : '…'}
                {!f.ended_at && <span className="badge badge-airborne">in flight</span>}
              </div>
              <div className="flight-stats muted">
                {f.ended_at ? fmtDuration(f.ended_at - f.started_at) : ''} · {fmtNm(f.distance_nm)} ·{' '}
                {fmtAlt(f.max_alt)}
              </div>
            </Link>
          ))}
          {flights.length === 0 && <p className="muted">No flights recorded yet — history builds up as the fleet flies.</p>}
        </div>
        {!done && flights.length > 0 && (
          <button className="btn" onClick={() => setOffset(offset + PAGE)}>
            Load more
          </button>
        )}
      </main>
    </div>
  );
}
