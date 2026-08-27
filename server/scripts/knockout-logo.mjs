// One-off: flood-fill the white background of the club logo to transparency,
// starting from the image border so the white horse (enclosed by outlines)
// is preserved. Usage: node scripts/knockout-logo.mjs <in.png> <out.png>
import sharp from 'sharp';

const [inPath, outPath] = process.argv.slice(2);
const { data, info } = await sharp(inPath).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
const { width, height } = info;
const idx = (x, y) => (y * width + x) * 4;
const isWhite = (x, y) => {
  const i = idx(x, y);
  return data[i] > 242 && data[i + 1] > 242 && data[i + 2] > 242;
};

const seen = new Uint8Array(width * height);
const stack = [];
for (let x = 0; x < width; x++) stack.push([x, 0], [x, height - 1]);
for (let y = 0; y < height; y++) stack.push([0, y], [width - 1, y]);

while (stack.length) {
  const [x, y] = stack.pop();
  if (x < 0 || y < 0 || x >= width || y >= height) continue;
  const s = y * width + x;
  if (seen[s]) continue;
  seen[s] = 1;
  if (!isWhite(x, y)) continue;
  data[idx(x, y) + 3] = 0;
  stack.push([x + 1, y], [x - 1, y], [x, y + 1], [x, y - 1]);
}

await sharp(data, { raw: { width, height, channels: 4 } })
  .png()
  .toFile(outPath);
console.log('done', width, 'x', height);
