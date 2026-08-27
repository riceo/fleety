const TZ = 'Europe/London';

export const fmtAlt = (ft: number | null): string => (ft === null ? '—' : `${Math.round(ft).toLocaleString()} ft`);
export const fmtGs = (kt: number | null): string => (kt === null ? '—' : `${Math.round(kt)} kt`);
export const fmtNm = (nm: number): string => `${nm < 10 ? nm.toFixed(1) : Math.round(nm)} nm`;

export function fmtTime(ts: number): string {
  return new Intl.DateTimeFormat('en-GB', { timeZone: TZ, hour: '2-digit', minute: '2-digit' }).format(ts);
}

export function fmtTimeUTC(ts: number): string {
  return new Intl.DateTimeFormat('en-GB', { timeZone: 'UTC', hour: '2-digit', minute: '2-digit', second: '2-digit' }).format(ts);
}

// "INV01" -> "INVICTA 01" per the club's configured callsign rules.
export interface CallsignRule {
  prefix: string;
  spoken: string;
}

let activeRules: CallsignRule[] = [];
export function setCallsignRules(rules: CallsignRule[] | undefined): void {
  activeRules = rules ?? [];
}

export function displayCallsign(cs: string | null | undefined): string {
  if (!cs) return '';
  const clean = cs.trim().toUpperCase();
  for (const r of activeRules) {
    const m = new RegExp(`^${r.prefix.toUpperCase()}\\s?(\\d+)$`).exec(clean);
    if (m) return `${r.spoken.toUpperCase()} ${m[1]}`;
  }
  return clean;
}

export function fmtDateTime(ts: number): string {
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: TZ,
    day: '2-digit',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
  }).format(ts);
}

export function fmtDate(ts: number): string {
  return new Intl.DateTimeFormat('en-GB', { timeZone: TZ, weekday: 'short', day: '2-digit', month: 'short', year: 'numeric' }).format(ts);
}

export function fmtDuration(ms: number): string {
  const mins = Math.round(ms / 60000);
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return h > 0 ? `${h}h ${m.toString().padStart(2, '0')}m` : `${m}m`;
}

export function fmtAgo(ts: number, now = Date.now()): string {
  const s = Math.max(0, Math.round((now - ts) / 1000));
  if (s < 10) return 'now';
  if (s < 60) return `${s}s ago`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.round(h / 24)}d ago`;
}
