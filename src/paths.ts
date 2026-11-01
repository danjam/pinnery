import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Where the server finds its files. The web app and the extension are served from dist/, built
// from src/public and extension/ by `npm run build` (scripts/build.ts); the image builds it too.
export const rootDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
export const publicDir = path.join(rootDir, 'dist', 'public');
export const extensionDir = path.join(rootDir, 'dist', 'extension');

for (const dir of [publicDir, extensionDir]) {
  if (!fs.existsSync(dir)) {
    console.error(`${path.relative(rootDir, dir)} is missing — run npm run build first — refusing to start`);
    process.exit(1);
  }
}
