// Builds dist/: the web app (dist/public, from src/public) and the Chrome extension (dist/extension,
// from extension/), which is what the server serves and zips. Static files are copied as they are;
// scripts are bundled with esbuild, one file per script the pages and the extension manifest load,
// so each entry point and everything it imports ends up in a single .js. Run: npm run build
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as esbuild from 'esbuild';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const dist = path.join(root, 'dist');

type Entry = { src: string, out: string, format: 'esm' | 'iife' };

// A script a page or the manifest names as x.js may be written as x.ts or x.js.
function source(file: string): string {
  const ts = file.replace(/\.js$/, '.ts');
  if (fs.existsSync(ts)) return ts;
  if (fs.existsSync(file)) return file;
  throw new Error(`no source for ${path.relative(root, file)} (.ts or .js)`);
}

// The scripts an HTML page loads: <script type="module"> ones as modules, plain ones (boot.js, which
// must block first paint) as classic scripts. `base` is what root-relative src="/…" paths resolve to.
function pageScripts(html: string, dir: string, base: string): { src: string, module: boolean }[] {
  return [...fs.readFileSync(html, 'utf8').matchAll(/<script\b([^>]*)\bsrc="([^"]+)"/g)].map(([, attrs, src]) => ({
    src: src.startsWith('/') ? path.join(base, src) : path.join(dir, src),
    module: /\btype="module"/.test(attrs),
  }));
}

// Copy a source directory into dist, leaving out scripts (they're bundled), the directories that
// only hold scripts, and tsconfig.json.
function copyStatic(from: string, to: string, scriptDirs: string[]) {
  const skip = new Set(scriptDirs.map((d) => path.join(from, d)));
  fs.cpSync(from, to, {
    recursive: true,
    filter: (f) => !(/\.(js|ts)$/.test(f) || path.basename(f) === 'tsconfig.json' || skip.has(f)),
  });
}

function webEntries(): Entry[] {
  const pub = path.join(root, 'src/public');
  const entries = new Map<string, Entry>();
  for (const f of fs.readdirSync(pub).filter((n) => n.endsWith('.html'))) {
    for (const { src, module } of pageScripts(path.join(pub, f), pub, pub)) {
      entries.set(src, { src: source(src), out: path.join(dist, 'public', path.relative(pub, src)), format: module ? 'esm' : 'iife' });
    }
  }
  // The service worker isn't loaded by a page tag: app.js registers /sw.js.
  const sw = path.join(pub, 'sw.js');
  entries.set(sw, { src: source(sw), out: path.join(dist, 'public/sw.js'), format: 'iife' });
  return [...entries.values()];
}

function extensionEntries(): Entry[] {
  const ext = path.join(root, 'extension');
  const manifest = JSON.parse(fs.readFileSync(path.join(ext, 'manifest.json'), 'utf8'));
  const entry = (rel: string, format: Entry['format']): Entry => ({ src: source(path.join(ext, rel)), out: path.join(dist, 'extension', rel), format });
  const entries = [
    entry(manifest.background.service_worker, manifest.background.type === 'module' ? 'esm' : 'iife'),
    // Content scripts can't be modules.
    ...manifest.content_scripts.flatMap((c: { js: string[] }) => c.js.map((js) => entry(js, 'iife'))),
  ];
  for (const f of fs.readdirSync(ext).filter((n) => n.endsWith('.html'))) {
    for (const { src, module } of pageScripts(path.join(ext, f), ext, ext)) entries.push(entry(path.relative(ext, src), module ? 'esm' : 'iife'));
  }
  return entries;
}

async function bundle(entries: Entry[], target: string) {
  await Promise.all(entries.map((e) => esbuild.build({
    entryPoints: [e.src],
    outfile: e.out,
    bundle: true,
    format: e.format,
    target,
    charset: 'utf8',
    logLevel: 'warning',
  })));
}

fs.rmSync(dist, { recursive: true, force: true });
copyStatic(path.join(root, 'src/public'), path.join(dist, 'public'), ['js']);
copyStatic(path.join(root, 'extension'), path.join(dist, 'extension'), ['lib']);
// Chrome 110 is the extension's minimum_chrome_version; the web app targets current browsers.
await bundle(webEntries(), 'es2022');
await bundle(extensionEntries(), 'chrome110');
console.log(`built ${path.relative(process.cwd(), dist) || dist}`);
