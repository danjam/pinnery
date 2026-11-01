import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import sharp from 'sharp';

// Raster formats only. SVG is deliberately excluded: served inline it can run scripts.
export const MIMES = {
  jpeg: 'image/jpeg',
  png: 'image/png',
  webp: 'image/webp',
  gif: 'image/gif',
  avif: 'image/avif',
};

// Grid thumbnails: long-side widths. Both are made at save time and regenerated on demand if missing.
export const THUMB_SIZES = [400, 800];

const SHA_RE = /^[0-9a-f]{64}$/;
export const isSha = (s) => typeof s === 'string' && SHA_RE.test(s);

export function createStore(dataDir) {
  const originalsDir = path.join(dataDir, 'originals');
  const thumbsDir = path.join(dataDir, 'thumbs');
  fs.mkdirSync(originalsDir, { recursive: true });
  fs.mkdirSync(thumbsDir, { recursive: true });

  const originalPath = (sha) => path.join(originalsDir, sha.slice(0, 2), sha);
  const thumbPath = (sha, size) => path.join(thumbsDir, sha.slice(0, 2), `${sha}-${size}.webp`);

  // Write to a temp file in the same directory and rename, so a crash can't leave a partial file.
  function writeAtomic(file, buf) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.tmp-${crypto.randomBytes(4).toString('hex')}`;
    fs.writeFileSync(tmp, buf);
    fs.renameSync(tmp, file);
  }

  // Inspect bytes: throws if not a supported image. Width/height are as displayed (EXIF orientation applied).
  async function inspect(buf) {
    let meta;
    try {
      meta = await sharp(buf, { failOn: 'none' }).metadata();
    } catch {
      throw new ImageError(415, 'not a supported image');
    }
    const mime = MIMES[meta.format];
    if (!mime || !meta.width || !meta.height) throw new ImageError(415, `unsupported image format${meta.format ? `: ${meta.format}` : ''}`);
    const swap = meta.orientation >= 5 && meta.orientation <= 8;
    return {
      mime,
      width: swap ? meta.height : meta.width,
      height: swap ? meta.width : meta.height,
      animated: (meta.pages || 1) > 1 ? 1 : 0,
    };
  }

  async function makeThumb(source, size) {
    // Default sharp reads page 0 only, so animated GIF/WebP thumbs are a still of the first frame.
    return sharp(source, { failOn: 'none' })
      .rotate()
      .resize({ width: size, height: size, fit: 'inside', withoutEnlargement: true })
      .webp({ quality: 82 })
      .toBuffer();
  }

  // Everything the pins row needs, without writing anything: format, size and the content hash.
  async function fingerprint(buf) {
    const info = await inspect(buf);
    const sha256 = crypto.createHash('sha256').update(buf).digest('hex');
    return { ...info, sha256 };
  }

  // Store the bytes and thumbnails for a fingerprinted buffer (no-op for a hash already present).
  async function save(buf, { sha256 }) {
    const file = originalPath(sha256);
    if (!fs.existsSync(file)) writeAtomic(file, buf);
    for (const size of THUMB_SIZES) {
      if (!fs.existsSync(thumbPath(sha256, size))) writeAtomic(thumbPath(sha256, size), await makeThumb(buf, size));
    }
  }

  const inFlight = new Map();
  // Path to a thumbnail, generating it from the original if it's missing (thumbs/ is regenerable).
  async function thumb(sha, size) {
    const file = thumbPath(sha, size);
    if (fs.existsSync(file)) return file;
    const original = originalPath(sha);
    if (!fs.existsSync(original)) return null;
    if (!inFlight.has(file)) {
      inFlight.set(file, (async () => {
        writeAtomic(file, await makeThumb(original, size));
        return file;
      })().finally(() => inFlight.delete(file)));
    }
    return inFlight.get(file);
  }

  function original(sha) {
    const file = originalPath(sha);
    return fs.existsSync(file) ? file : null;
  }

  // Delete the original and its thumbs. ENOENT is fine; anything else propagates.
  function removeFiles(sha) {
    for (const f of [originalPath(sha), ...THUMB_SIZES.map((s) => thumbPath(sha, s))]) {
      try { fs.unlinkSync(f); } catch (e) { if (e.code !== 'ENOENT') throw e; }
    }
  }

  // Remove files for hashes no pin references, plus abandoned temp files. Returns the count.
  function sweep(referenced) {
    let removed = 0;
    for (const [dir, nameToSha] of [
      [originalsDir, (n) => n],
      [thumbsDir, (n) => n.replace(/-\d+\.webp$/, '')],
    ]) {
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
  constructor(status, message, extra = null) {
    super(message);
    this.status = status;
    this.extra = extra;
  }
}
