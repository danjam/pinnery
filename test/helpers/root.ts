import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

// A throwaway copy of the app to run src/server.ts from, for startup cases the real checkout can't
// show (a missing or broken dist/). src/ is copied, not linked: paths.ts finds dist/ from its own
// real path. node_modules and dist/public are linked. `extension` replaces dist/extension with
// these files; null leaves dist/ out altogether. Returns the directory; remove it when done.
export function makeRoot({ extension }: { extension: Record<string, string> | null }): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pinnery-root-'));
  fs.cpSync(path.join(repo, 'src'), path.join(dir, 'src'), { recursive: true });
  fs.copyFileSync(path.join(repo, 'package.json'), path.join(dir, 'package.json'));
  fs.symlinkSync(path.join(repo, 'node_modules'), path.join(dir, 'node_modules'));
  if (extension) {
    fs.mkdirSync(path.join(dir, 'dist', 'extension'), { recursive: true });
    fs.symlinkSync(path.join(repo, 'dist', 'public'), path.join(dir, 'dist', 'public'));
    for (const [name, text] of Object.entries(extension)) fs.writeFileSync(path.join(dir, 'dist', 'extension', name), text);
  }
  return dir;
}
