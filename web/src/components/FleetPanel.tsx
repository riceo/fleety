import type { LiveAircraft } from '../api';
import { fmtAgo, fmtAlt, fmtGs } from '../format';

export function StatusBadge({ status }: { status: LiveAircraft['status'] }) {
  const label = status === 'airborne' ? 'Airborne' : status === 'ground' ? 'On ground' : 'Offline';
  return <span className={`badge badge-${status}`}>{label}</span>;
}

export function AircraftCard({
  a,
  selected,
  onClick,
  big,
}: {
  a: LiveAircraft;
  selected?: boolean;
  onClick?: () => void;
  big?: boolean;
}) {
  return (
    <button
      className={`ac-card${selected ? ' selected' : ''}${big ? ' big' : ''}`}
      onClick={onClick}
      aria-label={`${a.registration} ${a.nickname || a.typeName}, ${a.status}`}
    >
      <div className="ac-card-photo" style={{ borderColor: a.color }}>
        {a.photoUrl ? (
          <img src={a.photoUrl} alt={a.registration} loading="lazy" />
        ) : (
          <div className="ac-card-photo-fallback" style={{ color: a.color }}>
            ✈
          </div>
        )}
      </div>
      <div className="ac-card-body">
        <div className="ac-card-title">
          <span className="ac-reg">{a.registration}</span>
          <span className="ac-callsign">{a.status === 'airborne' && a.liveCallsign ? a.liveCallsign : a.callsign}</span>
        </div>
        <div className="ac-card-sub">
          {a.nickname || a.typeName}
          {a.category === 'guest' && <span className="guest-tag">guest</span>}
        </div>
        <div className="ac-card-stats">
          <StatusBadge status={a.status} />
          {a.status === 'airborne' && a.pos && (
            <span className="ac-stats-text">
              {fmtAlt(a.pos.altBaro)} · {fmtGs(a.pos.gs)}
            </span>
          )}
          {a.status !== 'airborne' && a.pos && <span className="ac-stats-text muted">{fmtAgo(a.pos.ts)}</span>}
        </div>
      </div>
    </button>
  );
}

export function FleetPanel({
  fleet,
  selectedId,
  onSelect,
}: {
  fleet: LiveAircraft[];
  selectedId: number | null;
  onSelect: (id: number) => void;
}) {
  const order = { airborne: 0, ground: 1, offline: 2 } as const;
  const fleetAc = fleet.filter((a) => a.category === 'fleet').sort((x, y) => order[x.status] - order[y.status]);
  const guests = fleet.filter((a) => a.category === 'guest').sort((x, y) => order[x.status] - order[y.status]);
  return (
    <div className="fleet-panel">
      <div className="fleet-panel-section">
        <h3>Fleet</h3>
        {fleetAc.map((a) => (
          <AircraftCard key={a.id} a={a} selected={a.id === selectedId} onClick={() => onSelect(a.id)} />
        ))}
        {fleetAc.length === 0 && <p className="muted small">No aircraft configured yet.</p>}
      </div>
      {guests.length > 0 && (
        <div className="fleet-panel-section">
          <h3>Guest aircraft</h3>
          {guests.map((a) => (
            <AircraftCard key={a.id} a={a} selected={a.id === selectedId} onClick={() => onSelect(a.id)} />
          ))}
        </div>
      )}
    </div>
  );
}
