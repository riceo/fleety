// Built-in top-view aircraft silhouettes (nose pointing up / north).
// Tinted per-aircraft, rasterized to ImageData for MapLibre addImage().

const wrap = (inner: string) =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><g fill="currentColor" stroke="#0b1626" stroke-width="1.2" stroke-linejoin="round">${inner}</g></svg>`;

export const BUILTIN_ICONS: Record<string, string> = {
  'low-wing': wrap(
    `<path d="M32 3 C34.5 3 36 8 36 14 L36 48 C36 52 35 56 32 58 C29 56 28 52 28 48 L28 14 C28 8 29.5 3 32 3 Z"/>
     <path d="M4 28 L28 24.5 L36 24.5 L60 28 L60 34 L36 35 L28 35 L4 34 Z"/>
     <path d="M18 52 L28 50 L36 50 L46 52 L46 56.5 L36 57.5 L28 57.5 L18 56.5 Z"/>`
  ),
  'high-wing': wrap(
    `<path d="M32 4 C35 4 36.5 9 36.5 15 L36 48 C36 52 35 56 32 58 C29 56 28 52 28 48 L27.5 15 C27.5 9 29 4 32 4 Z"/>
     <path d="M2 22.5 L27 19.5 L37 19.5 L62 22.5 L62 30 L37 31 L27 31 L2 30 Z"/>
     <path d="M19 52 L28 50 L36 50 L45 52 L45 56.5 L36 57.5 L28 57.5 L19 56.5 Z"/>`
  ),
  biplane: wrap(
    `<path d="M32 5 C35.5 5 37 10 37 15 L36.5 47 C36.5 51 35 55.5 32 57.5 C29 55.5 27.5 51 27.5 47 L27 15 C27 10 28.5 5 32 5 Z"/>
     <path d="M5 17.5 L27 15.5 L37 15.5 L59 17.5 L59 24 L37 25 L27 25 L5 24 Z"/>
     <path d="M9 28 L27.5 26.5 L36.5 26.5 L55 28 L55 34 L36.5 35 L27.5 35 L9 34 Z"/>
     <path d="M20 51 L28 49.5 L36 49.5 L44 51 L44 55.5 L36 56.5 L28 56.5 L20 55.5 Z"/>`
  ),
  jet: wrap(
    `<path d="M32 2 C35 2 37 7 37 13 L37 46 C37 51 35.5 55 32 58 C28.5 55 27 51 27 46 L27 13 C27 7 29 2 32 2 Z"/>
     <path d="M27 27 L5 42 L5 47 L27 39.5 L37 39.5 L59 47 L59 42 L37 27 Z"/>
     <path d="M27 50 L18 57 L18 60 L27 56.5 L37 56.5 L46 60 L46 57 L37 50 Z"/>`
  ),
  heli: wrap(
    `<ellipse cx="32" cy="30" rx="7" ry="13"/>
     <path d="M30.5 42 L33.5 42 L33 56 L36 56 L36 59 L28 59 L28 56 L31 56 Z"/>
     <path d="M12 10 L52 50 L49.5 52.5 L9.5 12.5 Z"/>
     <path d="M52 10 L12 50 L14.5 52.5 L54.5 12.5 Z"/>`
  ),
};

export const ICON_KEYS = Object.keys(BUILTIN_ICONS);

// Airfield marker roundels, drawn straight to canvas (rendered 2x).
export function renderRoundel(diameterPx: number, fill: string, ring: string, core: string): ImageData {
  const s = diameterPx * 2;
  const canvas = document.createElement('canvas');
  canvas.width = s;
  canvas.height = s;
  const ctx = canvas.getContext('2d')!;
  const c = s / 2;
  ctx.beginPath();
  ctx.arc(c, c, c - 2, 0, Math.PI * 2);
  ctx.fillStyle = fill;
  ctx.fill();
  ctx.lineWidth = s * 0.09;
  ctx.strokeStyle = ring;
  ctx.stroke();
  ctx.beginPath();
  ctx.arc(c, c, s * 0.14, 0, Math.PI * 2);
  ctx.fillStyle = core;
  ctx.fill();
  return ctx.getImageData(0, 0, s, s);
}

const SIZE = 128; // rendered at 2x for crisp retina display, pixelRatio: 2

export async function renderIcon(
  builtinKey: string,
  customUrl: string | null,
  color: string
): Promise<ImageData> {
  const canvas = document.createElement('canvas');
  canvas.width = SIZE;
  canvas.height = SIZE;
  const ctx = canvas.getContext('2d')!;
  const img = new Image();
  img.crossOrigin = 'anonymous';
  const src = customUrl
    ? customUrl
    : `data:image/svg+xml;base64,${btoa((BUILTIN_ICONS[builtinKey] ?? BUILTIN_ICONS['low-wing']).replaceAll('currentColor', color))}`;
  await new Promise<void>((resolve, reject) => {
    img.onload = () => resolve();
    img.onerror = () => reject(new Error('icon load failed'));
    img.src = src;
  });
  ctx.drawImage(img, 0, 0, SIZE, SIZE);
  return ctx.getImageData(0, 0, SIZE, SIZE);
}
