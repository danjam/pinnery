import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import sharp from 'sharp';

// Raster formats only. SVG is deliberately excluded: served inline it can run scripts.
export const MIMES: Record<string, string> = {
  jpeg: 'image/jpeg',
  png: 'image/png',
  webp: 'image/webp',
  gif: 'image/gif',
  avif: 'image/avif',
};

// Decoded size cap. A small, highly compressed file can declare a huge canvas, and decoding it
// (to inspect or thumbnail) allocates the full bitmap; sharp's own default is ~268 MP.
export const MAX_PIXELS = 100_000_000;
const SHARP_OPTS = { failOn: 'none', limitInputPixels: MAX_PIXELS } as const;
const isPixelLimit = (e: unknown) => e instanceof Error && /pixel limit/.test(e.message);

// Grid thumbnails: long-side widths. Both are made at save time and regenerated on demand if missing.
export const THUMB_SIZES = [400, 800];

const SHA_RE = /^[0-9a-f]{64}$/;
export const isSha = (s: unknown): s is string => typeof s === 'string' && SHA_RE.test(s);

// What inspecting an image yields; `animated` is 0 | 1 like the pins column.
export interface ImageInfo {
  mime: string;
  width: number;
  height: number;
  animated: number;
}
// Everything a pins row needs from the bytes: ImageInfo plus the content hash.
export interface Fingerprint extends ImageInfo {
  sha256: string;
}

export type Store = ReturnType<typeof createStore>;

const isNoEntry = (e: unknown) => e instanceof Error && 'code' in e && e.code === 'ENOENT';

export function createStore(dataDir: string) {
  const originalsDir = path.join(dataDir, 'originals');
  const thumbsDir = path.join(dataDir, 'thumbs');
  fs.mkdirSync(originalsDir, { recursive: true });
  fs.mkdirSync(thumbsDir, { recursive: true });

  const originalPath = (sha: string) => path.join(originalsDir, sha.slice(0, 2), sha);
  const thumbPath = (sha: string, size: number) => path.join(thumbsDir, sha.slice(0, 2), `${sha}-${size}.webp`);

  // Write to a temp file in the same directory and rename, so a crash can't leave a partial file.
  function writeAtomic(file: string, buf: Buffer) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.tmp-${crypto.randomBytes(4).toString('hex')}`;
    fs.writeFileSync(tmp, buf);
    fs.renameSync(tmp, file);
  }

  // Inspect bytes: throws if not a supported image. Width/height are as displayed (EXIF orientation applied).
  async function inspect(buf: Buffer): Promise<ImageInfo> {
    let meta;
    try {
      meta = await sharp(buf, SHARP_OPTS).metadata();
    } catch (e) {
      if (isPixelLimit(e)) throw new ImageError(413, `image too large (limit ${MAX_PIXELS / 1e6} megapixels)`);
      throw new ImageError(415, 'not a supported image');
    }
    // sharp reports AVIF as HEIF with AV1 compression; other HEIF (HEIC, i.e. HEVC) stays unsupported.
    const format = meta.format === 'heif' && meta.compression === 'av1' ? 'avif' : meta.format;
    const mime = MIMES[format];
    if (!mime || !meta.width || !meta.height) throw new ImageError(415, `unsupported image format${format ? `: ${format}` : ''}`);
    const orientation = meta.orientation ?? 0;
    const swap = orientation >= 5 && orientation <= 8;
    return {
      mime,
      width: swap ? meta.height : meta.width,
      height: swap ? meta.width : meta.height,
      animated: (meta.pages || 1) > 1 ? 1 : 0,
    };
  }

  async function makeThumb(source: Buffer | string, size: number): Promise<Buffer> {
    // Default sharp reads page 0 only, so animated GIF/WebP thumbs are a still of the first frame.
    return sharp(source, SHARP_OPTS)
      .rotate()
      .resize({ width: size, height: size, fit: 'inside', withoutEnlargement: true })
      .webp({ quality: 82 })
      .toBuffer();
  }

  // Everything the pins row needs, without writing anything: format, size and the content hash.
  async function fingerprint(buf: Buffer): Promise<Fingerprint> {
    const info = await inspect(buf);
    const sha256 = crypto.createHash('sha256').update(buf).digest('hex');
    return { ...info, sha256 };
  }

  // Store the bytes and thumbnails for a fingerprinted buffer (no-op for a hash already present).
  async function save(buf: Buffer, { sha256 }: { sha256: string }) {
    const file = originalPath(sha256);
    if (!fs.existsSync(file)) writeAtomic(file, buf);
    for (const size of THUMB_SIZES) {
      if (!fs.existsSync(thumbPath(sha256, size))) writeAtomic(thumbPath(sha256, size), await makeThumb(buf, size));
    }
  }

  const inFlight = new Map<string, Promise<string>>();
  // Path to a thumbnail, generating it from the original if it's missing (thumbs/ is regenerable).
  async function thumb(sha: string, size: number): Promise<string | null> {
    const file = thumbPath(sha, size);
    if (fs.existsSync(file)) return file;
    const original = originalPath(sha);
    if (!fs.existsSync(original)) return null;
    let job = inFlight.get(file);
    if (!job) {
      job = (async () => {
        writeAtomic(file, await makeThumb(original, size));
        return file;
      })().finally(() => inFlight.delete(file));
      inFlight.set(file, job);
    }
    return job;
  }

  function original(sha: string): string | null {
    const file = originalPath(sha);
    return fs.existsSync(file) ? file : null;
  }

  // Delete the original and its thumbs. ENOENT is fine; anything else propagates.
  function removeFiles(sha: string) {
    for (const f of [originalPath(sha), ...THUMB_SIZES.map((s) => thumbPath(sha, s))]) {
      try { fs.unlinkSync(f); } catch (e) { if (!isNoEntry(e)) throw e; }
    }
  }

  // Remove files for hashes no pin references, plus abandoned temp files. Returns the count.
  function sweep(referenced: Set<string>) {
    let removed = 0;
    const roots: [string, (name: string) => string][] = [
      [originalsDir, (n) => n],
      [thumbsDir, (n) => n.replace(/-\d+\.webp$/, '')],
    ];
    for (const [dir, nameToSha] of roots) {
      for (const shard of fs.readdirSync(dir)) {
        const shardDir = path.join(dir, shard);
        if (!fs.statSync(shardDir).isDirectory()) continue;
        for (const name of fs.readdirSync(shardDir)) {
          const sha = name.includes('.tmp-') ? null : nameToSha(name);
          if (sha && isSha(sha) && referenced.has(sha)) continue;
          try { fs.unlinkSync(path.join(shardDir, name)); removed++; } catch {}
        }
      }
    }
    return removed;
  }

  return { fingerprint, save, makeThumb, thumb, original, removeFiles, sweep };
}

// An error with an HTTP status and a message safe to show. `extra` is merged into the JSON body.
export class ImageError extends Error {
  status: number;
  extra: Record<string, unknown> | null;

  constructor(status: number, message: string, extra: Record<string, unknown> | null = null) {
    super(message);
    this.status = status;
    this.extra = extra;
  }
}
