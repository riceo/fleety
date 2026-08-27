import type { LiveAircraft } from '../api';
import { displayCallsign, fmtAgo, fmtAlt, fmtGs } from '../format';
import { isSparkly } from '../sparkle';

export function StatusBadge({ status }: { status: LiveAircraft['status'] }) {
  const label = status === 'airborne' ? 'Airborne' : status === 'ground' ? 'On stand' : 'No signal';
  return (
    <span className={`badge badge-${status}`}>
      <span className="badge-dot" />
      {label}
    </span>
  );
}

// ATC-style flight strip. Airborne aircraft get the expanded strip with photo
// and live data; everything else is a compact one-liner in the bay.
export function FlightStrip({
  a,
  selected,
  onClick,
}: {
  a: LiveAircraft;
  selected?: boolean;
  onClick?: () => void;
}) {
  const airborne = a.status === 'airborne';
  return (
    <button
      className={`strip${airborne ? ' strip-air' : ''}${selected ? ' selected' : ''}${isSparkly(a) ? ' sparkle' : ''}`}
      style={{ ['--strip-color' as string]: a.color }}
      onClick={onClick}
      aria-label={`${a.registration} ${a.nickname || a.typeName}, ${a.status}`}
    >
      {airborne && a.photoUrl && (
        <div className="strip-photo" style={{ backgroundImage: `url(${a.photoUrl})` }} />
      )}
      <div className="strip-body">
        <div className="strip-top">
          <span className="strip-callsign">{displayCallsign((airborne && a.liveCallsign) || a.callsign) || a.registration}</span>
          <StatusBadge status={a.status} />
        </div>
        <div className="strip-meta">
          <span className="mono-label">{a.registration}</span>
          <span className="strip-type">{a.nickname || a.typeName}</span>
          {a.category === 'guest' && <span className="guest-tag">GUEST</span>}
        </div>
        {airborne && a.pos && (
          <div className="strip-data">
            <span>
              <label>ALT</label> {fmtAlt(a.pos.altBaro)}
            </span>
            <span>
              <label>GS</label> {fmtGs(a.pos.gs)}
            </span>
            <span>
              <label>SQK</label> {a.pos.squawk ?? '——'}
            </span>
          </div>
        )}
        {!airborne && a.pos && <div className="strip-last mono-label">LAST CONTACT {fmtAgo(a.pos.ts).toUpperCase()}</div>}
        {(a.note || a.tagline) && <div className="strip-note">{a.note ?? a.tagline}</div>}
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
  const airborne = fleet.filter((a) => a.status === 'airborne');
  const ground = fleet.filter((a) => a.status !== 'airborne' && a.category === 'fleet');
  const guests = fleet.filter((a) => a.status !== 'airborne' && a.category === 'guest');
  return (
    <div className="strip-bay">
      <div className="bay-section">
        <h3 className="bay-head">
          In the air <span className="bay-count">{airborne.length.toString().padStart(2, '0')}</span>
        </h3>
        {airborne.map((a) => (
          <FlightStrip key={a.id} a={a} selected={a.id === selectedId} onClick={() => onSelect(a.id)} />
        ))}
        {airborne.length === 0 && (
          <div className="bay-quiet">
            <span className="bay-quiet-big">ALL QUIET</span>
            <span className="mono-label">FLEET ON THE GROUND AT ROCHESTER</span>
          </div>
        )}
      </div>
      <div className="bay-section">
        <h3 className="bay-head">
          On the ground <span className="bay-count">{ground.length.toString().padStart(2, '0')}</span>
        </h3>
        {ground.map((a) => (
          <FlightStrip key={a.id} a={a} selected={a.id === selectedId} onClick={() => onSelect(a.id)} />
        ))}
      </div>
      {guests.length > 0 && (
        <div className="bay-section">
          <h3 className="bay-head">
            Guest aircraft <span className="bay-count">{guests.length.toString().padStart(2, '0')}</span>
          </h3>
          {guests.map((a) => (
            <FlightStrip key={a.id} a={a} selected={a.id === selectedId} onClick={() => onSelect(a.id)} />
          ))}
        </div>
      )}
    </div>
  );
}
