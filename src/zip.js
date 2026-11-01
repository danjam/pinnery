import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

// Minimal zip support (store/deflate, no zip64, no encryption) — enough to hand out the extension
// folder and to export/import boards without pulling in a dependency.

const SIG_LOCAL = 0x04034b50;
const SIG_CENTRAL = 0x02014b50;
const SIG_END = 0x06054b50;

function dosDateTime(d) {
  const time = (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1);
  const date = ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
  return { time, date };
}

export function walk(dir, rel = '') {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const relPath = rel ? `${rel}/${entry.name}` : entry.name;
    if (entry.isDirectory()) out.push(...walk(path.join(dir, entry.name), relPath));
    else if (entry.isFile()) out.push(relPath);
  }
  return out;
}

// ---- writer -------------------------------------------------------------------------------

// Writes a zip entry by entry to `sink` (anything with write(buf) -> boolean and 'drain', e.g. an
// HTTP response). `add` resolves once the entry is handed to the sink, honouring backpressure;
// `end` writes the central directory and returns the total size. Entries are deflated unless
// `compress` is false (already-compressed images: storing is faster and no bigger).
export function createZipWriter(sink) {
  const { time, date } = dosDateTime(new Date());
  const centrals = [];
  let offset = 0;

  // Wait for 'drain' when the sink is full — or 'close', so a dropped connection can't hang us.
  async function write(buf) {
    offset += buf.length;
    if (sink.write(buf)) return;
    await new Promise((resolve) => {
      const done = () => { sink.off('drain', done); sink.off('close', done); resolve(); };
      sink.on('drain', done);
      sink.on('close', done);
    });
  }

  async function add(entryName, data, { compress = true } = {}) {
    const name = Buffer.from(entryName, 'utf8');
    const method = compress ? 8 : 0;
    const body = compress ? zlib.deflateRawSync(data, { level: 9 }) : data;
    const crc = zlib.crc32(data);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(SIG_LOCAL, 0);
    local.writeUInt16LE(20, 4);           // version needed: 2.0
    local.writeUInt16LE(0x0800, 6);       // flags: UTF-8 names
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(time, 10);
    local.writeUInt16LE(date, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(SIG_CENTRAL, 0);
    central.writeUInt16LE(0x031e, 4);     // made by: unix, 3.0
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt16LE(time, 12);
    central.writeUInt16LE(date, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(body.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt16LE(0, 30);         // extra
    central.writeUInt16LE(0, 32);         // comment
    central.writeUInt16LE(0, 34);         // disk
    central.writeUInt16LE(0, 36);         // internal attrs
    central.writeUInt32LE(0o100644 * 0x10000, 38); // external attrs: -rw-r--r-- (unix mode in the high word)
    central.writeUInt32LE(offset, 42);
    centrals.push(central, name);

    await write(Buffer.concat([local, name, body]));
  }

  async function end() {
    const cdOffset = offset;
    const cd = Buffer.concat(centrals);
    const eocd = Buffer.alloc(22);
    eocd.writeUInt32LE(SIG_END, 0);
    eocd.writeUInt16LE(0, 4);
    eocd.writeUInt16LE(0, 6);
    eocd.writeUInt16LE(centrals.length / 2, 8);
    eocd.writeUInt16LE(centrals.length / 2, 10);
    eocd.writeUInt32LE(cd.length, 12);
    eocd.writeUInt32LE(cdOffset, 16);
    eocd.writeUInt16LE(0, 20);
    await write(Buffer.concat([cd, eocd]));
    return offset;
  }

  return { add, end };
}

// Zip every file under `dir`, stored beneath `prefix/` inside the archive. Returns a Buffer.
// `transform(rel, buf)` may return replacement bytes for a file (e.g. to stamp the manifest).
export async function zipDirectory(dir, prefix, transform = (rel, buf) => buf) {
  const chunks = [];
  const zip = createZipWriter({ write: (b) => { chunks.push(b); return true; } });
  for (const rel of walk(dir)) await zip.add(`${prefix}/${rel}`, transform(rel, fs.readFileSync(path.join(dir, rel))));
  await zip.end();
  return Buffer.concat(chunks);
}

// ---- reader -------------------------------------------------------------------------------

export class ZipError extends Error {}

// A relative path with no traversal: no leading slash, drive letter, backslash, NUL, or `.`/`..` segment.
export function isSafeZipPath(name) {
  if (typeof name !== 'string' || !name || name.length > 1024) return false;
  if (name.startsWith('/') || /[\\\0]/.test(name) || /^[A-Za-z]:/.test(name)) return false;
  return name.split('/').every((seg) => seg !== '' && seg !== '.' && seg !== '..');
}

// Open a zip file on disk. Entries come from the central directory; `read(entry)` returns the
// inflated bytes (checked against the recorded CRC). Directory entries are left out. Throws
// ZipError for anything malformed or unsupported (encryption, zip64, other compression methods).
export function openZipFile(file, { maxEntrySize = Infinity } = {}) {
  const fd = fs.openSync(file, 'r');
  const size = fs.fstatSync(fd).size;

  function readAt(pos, len) {
    if (pos < 0 || len < 0 || pos + len > size) throw new ZipError('not a valid zip file');
    const buf = Buffer.alloc(len);
    let done = 0;
    while (done < len) {
      const n = fs.readSync(fd, buf, done, len - done, pos + done);
      if (!n) throw new ZipError('not a valid zip file');
      done += n;
    }
    return buf;
  }

  try {
    // End-of-central-directory record: fixed 22 bytes plus an optional comment of up to 64 KiB.
    const tail = readAt(Math.max(0, size - 22 - 65535), Math.min(size, 22 + 65535));
    let eocd = -1;
    for (let i = tail.length - 22; i >= 0; i--) {
      if (tail.readUInt32LE(i) === SIG_END && tail.readUInt16LE(i + 20) === tail.length - 22 - i) { eocd = i; break; }
    }
    if (eocd < 0) throw new ZipError('not a valid zip file');
    const count = tail.readUInt16LE(eocd + 10);
    const cdSize = tail.readUInt32LE(eocd + 12);
    const cdOffset = tail.readUInt32LE(eocd + 16);
    if (count === 0xffff || cdSize === 0xffffffff || cdOffset === 0xffffffff) throw new ZipError('zip64 archives are not supported');

    const cd = readAt(cdOffset, cdSize);
    const entries = [];
    let p = 0;
    for (let i = 0; i < count; i++) {
      if (p + 46 > cd.length || cd.readUInt32LE(p) !== SIG_CENTRAL) throw new ZipError('not a valid zip file');
      const flags = cd.readUInt16LE(p + 8);
      const method = cd.readUInt16LE(p + 10);
      const crc = cd.readUInt32LE(p + 16);
      const compressedSize = cd.readUInt32LE(p + 20);
      const uncompressedSize = cd.readUInt32LE(p + 24);
      const nameLen = cd.readUInt16LE(p + 28);
      const extraLen = cd.readUInt16LE(p + 30);
      const commentLen = cd.readUInt16LE(p + 32);
      const offset = cd.readUInt32LE(p + 42);
      const name = cd.subarray(p + 46, p + 46 + nameLen).toString('utf8');
      p += 46 + nameLen + extraLen + commentLen;
      if (flags & 0x0001) throw new ZipError(`${name}: encrypted entries are not supported`);
      if (method !== 0 && method !== 8) throw new ZipError(`${name}: unsupported compression method ${method}`);
      if (compressedSize === 0xffffffff || uncompressedSize === 0xffffffff || offset === 0xffffffff) throw new ZipError('zip64 archives are not supported');
      if (name.endsWith('/')) continue;
      entries.push({ name, method, crc, compressedSize, size: uncompressedSize, offset });
    }

    function read(entry) {
      if (entry.size > maxEntrySize) throw new ZipError(`${entry.name}: too large`);
      const local = readAt(entry.offset, 30);
      if (local.readUInt32LE(0) !== SIG_LOCAL) throw new ZipError('not a valid zip file');
      const dataStart = entry.offset + 30 + local.readUInt16LE(26) + local.readUInt16LE(28);
      const raw = readAt(dataStart, entry.compressedSize);
      let data;
      try {
        data = entry.method === 8 ? zlib.inflateRawSync(raw, { maxOutputLength: Math.max(1, entry.size) }) : raw;
      } catch {
        throw new ZipError(`${entry.name}: corrupt entry`);
      }
      if (data.length !== entry.size || zlib.crc32(data) !== entry.crc) throw new ZipError(`${entry.name}: corrupt entry`);
      return data;
    }

    return { entries, read, close: () => fs.closeSync(fd) };
  } catch (e) {
    fs.closeSync(fd);
    throw e;
  }
}
