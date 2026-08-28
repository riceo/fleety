import sharp from 'sharp';
import fs from 'node:fs';
import path from 'node:path';

const W = 1200;
const H = 630;

export interface OgCardInput {
  uploadsDir: string;
  photoPath: string | null;
  logoPath: string | null;
  accent: string; // #rrggbb
  clubName: string;
  displayCallsign: string; // e.g. "INVICTA 06" (may equal registration)
  registration: string;
  typeName: string;
  nickname: string;
  description: string;
  tagline: string;
  live: { status: string; altBaro: number | null; gs: number | null } | null;
}

const xml = (s: string): string =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');

const truncate = (s: string, n: number): string => (s.length > n ? `${s.slice(0, n - 1).trimEnd()}…` : s);

const safeAccent = (a: string): string => (/^#[0-9a-fA-F]{6}$/.test(a) ? a : '#e32636');

// One-line status/metrics strip: live numbers when airborne, else a state word.
function statusChips(live: OgCardInput['live']): { label: string; value: string }[] {
  if (!live) return [{ label: 'STATUS', value: 'NO RECENT CONTACT' }];
  if (live.status === 'airborne') {
    const chips = [{ label: 'STATUS', value: 'AIRBORNE' }];
    if (live.altBaro != null) chips.push({ label: 'ALT', value: `${Math.round(live.altBaro).toLocaleString()} ft` });
    if (live.gs != null) chips.push({ label: 'GND SPEED', value: `${Math.round(live.gs)} kt` });
    return chips;
  }
  const word: Record<string, string> = {
    awake: 'TRANSPONDER LIVE',
    ground: 'ON THE GROUND',
    offline: 'NO RECENT CONTACT',
  };
  return [{ label: 'STATUS', value: word[live.status] ?? 'ON THE GROUND' }];
}

// A 1200×630 social share card: the aircraft photo (or a branded backdrop)
// with the callsign, type, blurb and current status painted over it.
export async function renderAircraftOgCard(input: OgCardInput): Promise<Buffer> {
  const accent = safeAccent(input.accent);
  const FONT = 'DejaVu Sans, Arial, sans-serif';

  let base: sharp.Sharp;
  const photoFull = input.photoPath ? path.join(input.uploadsDir, input.photoPath) : null;
  const hasPhoto = !!photoFull && fs.existsSync(photoFull);
  if (hasPhoto) {
    try {
      base = sharp(photoFull!).resize(W, H, { fit: 'cover', position: 'attention' });
    } catch {
      base = sharp({ create: { width: W, height: H, channels: 4, background: { r: 6, g: 10, b: 20, alpha: 1 } } });
    }
  } else {
    base = sharp({ create: { width: W, height: H, channels: 4, background: { r: 6, g: 10, b: 20, alpha: 1 } } });
  }

  // Club logo (top-left brand lockup). Bounded to a small box; composited on
  // TOP of the scrim so it stays legible over any photo. Skipped on any error.
  let logoBuf: Buffer | null = null;
  let logoW = 0;
  const LOGO_TOP = 40;
  const logoFull = input.logoPath ? path.join(input.uploadsDir, input.logoPath) : null;
  if (logoFull && fs.existsSync(logoFull)) {
    try {
      logoBuf = await sharp(logoFull)
        .resize(260, 52, { fit: 'inside', withoutEnlargement: true })
        .png()
        .toBuffer();
      logoW = (await sharp(logoBuf).metadata()).width ?? 0;
    } catch {
      logoBuf = null;
      logoW = 0;
    }
  }
  const nameX = 64 + (logoW ? logoW + 18 : 0);

  // Type/nickname already show in the subtitle, so the blurb line is the
  // human description or tagline only (blank when there's neither).
  const blurb = truncate(input.description || input.tagline || '', 96);
  const sub = truncate(
    [input.registration, input.nickname && input.nickname !== input.displayCallsign ? input.nickname : input.typeName]
      .filter(Boolean)
      .join('  ·  '),
    64
  );
  const chips = statusChips(input.live);
  const chipW = 340;
  const chipsSvg = chips
    .slice(0, 3)
    .map((c, i) => {
      const x = 64 + i * chipW;
      return `
        <text x="${x}" y="546" font-family="${FONT}" font-size="20" font-weight="700" letter-spacing="3" fill="#8b97b4">${xml(c.label)}</text>
        <text x="${x}" y="584" font-family="${FONT}" font-size="34" font-weight="800" fill="#eef2fb">${xml(c.value)}</text>`;
    })
    .join('');

  const overlay = `<svg width="${W}" height="${H}" xmlns="http://www.w3.org/2000/svg">
    <defs>
      <linearGradient id="scrim" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0%" stop-color="rgba(6,10,20,${hasPhoto ? '0.34' : '0.0'})"/>
        <stop offset="30%" stop-color="rgba(6,10,20,${hasPhoto ? '0.16' : '0.0'})"/>
        <stop offset="58%" stop-color="rgba(6,10,20,${hasPhoto ? '0.6' : '0.0'})"/>
        <stop offset="100%" stop-color="rgba(6,10,20,0.94)"/>
      </linearGradient>
      <radialGradient id="glow" cx="82%" cy="18%" r="60%">
        <stop offset="0%" stop-color="${accent}" stop-opacity="0.18"/>
        <stop offset="100%" stop-color="${accent}" stop-opacity="0"/>
      </radialGradient>
    </defs>
    ${hasPhoto ? '' : `<rect width="${W}" height="${H}" fill="url(#glow)"/>`}
    <rect width="${W}" height="${H}" fill="url(#scrim)"/>
    <rect x="0" y="0" width="10" height="${H}" fill="${accent}"/>
    <text x="${nameX}" y="82" font-family="${FONT}" font-size="24" font-weight="700" letter-spacing="4" fill="#c3ccdf">${xml(input.clubName.toUpperCase())}</text>
    <text x="64" y="404" font-family="${FONT}" font-size="92" font-weight="800" fill="#ffffff">${xml(input.displayCallsign)}</text>
    <text x="66" y="446" font-family="${FONT}" font-size="30" font-weight="600" letter-spacing="2" fill="#aeb9d2">${xml(sub)}</text>
    ${blurb ? `<text x="66" y="490" font-family="${FONT}" font-size="27" font-weight="500" fill="#dbe2f1">${xml(blurb)}</text>` : ''}
    <rect x="64" y="512" width="${W - 128}" height="1.5" fill="rgba(255,255,255,0.14)"/>
    ${chipsSvg}
    <text x="${W - 64}" y="86" text-anchor="end" font-family="${FONT}" font-size="22" font-weight="700" letter-spacing="3" fill="${accent}">● LIVE</text>
  </svg>`;

  // Scrim + text first, then the logo on top so it never sits under the scrim.
  const layers: sharp.OverlayOptions[] = [{ input: Buffer.from(overlay), top: 0, left: 0 }];
  if (logoBuf) layers.push({ input: logoBuf, top: LOGO_TOP, left: 64 });

  return base.composite(layers).jpeg({ quality: 82, progressive: true }).toBuffer();
}
