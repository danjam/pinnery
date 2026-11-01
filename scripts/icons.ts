// Render the extension icons from the app mark. Run: node scripts/icons.ts
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const svg = fs.readFileSync(path.join(root, 'src/public/icon.svg'));
const outDir = path.join(root, 'extension/icons');
fs.mkdirSync(outDir, { recursive: true });

for (const size of [16, 32, 48, 128]) {
  // The SVG viewBox is 32 units; scale the render density so it rasterises at the target size.
  const png = await sharp(svg, { density: (72 * size) / 32 }).resize(size, size).png().toBuffer();
  fs.writeFileSync(path.join(outDir, `icon${size}.png`), png);
  console.log(`icon${size}.png ${png.length} bytes`);
}

// Installable web app (PWA) icons: plain, plus a maskable one with the mark inside the 80% safe zone
// on the pink circle's colour, so launchers can crop it to any shape.
const appDir = path.join(root, 'src/public/app-icons');
fs.mkdirSync(appDir, { recursive: true });
for (const size of [192, 512]) {
  const png = await sharp(svg, { density: (72 * size) / 32 }).resize(size, size).png().toBuffer();
  fs.writeFileSync(path.join(appDir, `icon-${size}.png`), png);
  console.log(`app icon-${size}.png ${png.length} bytes`);
}
{
  const size = 512;
  const inner = Math.round(size * 0.8);
  const mark = await sharp(svg, { density: (72 * inner) / 32 }).resize(inner, inner).png().toBuffer();
  const png = await sharp({ create: { width: size, height: size, channels: 4, background: '#d6336c' } })
    .composite([{ input: mark, gravity: 'center' }]).png().toBuffer();
  fs.writeFileSync(path.join(appDir, 'maskable-512.png'), png);
  console.log(`app maskable-512.png ${png.length} bytes`);
}
