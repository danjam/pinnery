import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

// Minimal zip support (store/deflate, no encryption) — enough to hand out the extension folder and
// to export/import boards without pulling in a dependency. Zip64 is written only when an archive
// needs it (data past 4 GiB, or 65,535 or more entries), so ordinary exports stay
// plain zips; the reader handles both.

const SIG_LOCAL = 0x04034b50;
const SIG_CENTRAL = 0x02014b50;
const SIG_END = 0x06054b50;
const SIG_END64 = 0x06064b50;
const SIG_END64_LOCATOR = 0x07064b50;
const ZIP64_EXTRA = 0x0001;
const MAX32 = 0xffffffff;
const MAX16 = 0xffff;

function dosDateTime(d: Date) {
  const time = (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1);
  const date = ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
  return { time, date };
}

export function walk(dir: string, rel = ''): string[] {
  const out: string[] = [];
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
export interface ZipSink {
  write(buf: Buffer): boolean;
  on(event: 'drain' | 'close', listener: () => void): unknown;
  off(event: 'drain' | 'close', listener: () => void): unknown;
}

// `offset` is where the archive starts in the output, for one written after other data. Entry
// offsets are recorded relative to the start of the output, as readers expect.
export function createZipWriter(sink: ZipSink, { offset = 0 }: { offset?: number } = {}) {
  const { time, date } = dosDateTime(new Date());
  const centrals: Buffer[] = [];
  let entryCount = 0;

  // Wait for 'drain' when the sink is full — or 'close', so a dropped connection can't hang us.
  async function write(buf: Buffer) {
    offset += buf.length;
    if (sink.write(buf)) return;
    await new Promise<void>((resolve) => {
      const done = () => { sink.off('drain', done); sink.off('close', done); resolve(); };
      sink.on('drain', done);
      sink.on('close', done);
    });
  }

  async function add(entryName: string, data: Buffer, { compress = true }: { compress?: boolean } = {}) {
    const name = Buffer.from(entryName, 'utf8');
    const method = compress ? 8 : 0;
    const body = compress ? zlib.deflateRawSync(data, { level: 9 }) : data;
    const crc = zlib.crc32(data);

    // Entries are images and the manifest, far below 4 GiB, so only the offset can need zip64: it's
    // then written as 0xffffffff in the central record, with the real value in a zip64 extra field.
    if (data.length >= MAX32 || body.length >= MAX32) throw new ZipError(`${entryName}: entries of 4 GiB or more are not supported`);
    const offset64 = offset >= MAX32;
    const version = offset64 ? 45 : 20;   // version needed: 4.5 for zip64, else 2.0

    const local = Buffer.alloc(30);
    local.writeUInt32LE(SIG_LOCAL, 0);
    local.writeUInt16LE(version, 4);
    local.writeUInt16LE(0x0800, 6);       // flags: UTF-8 names
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(time, 10);
    local.writeUInt16LE(date, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);

    const centralExtra = offset64 ? zip64Extra([offset]) : Buffer.alloc(0);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(SIG_CENTRAL, 0);
    central.writeUInt16LE(offset64 ? 0x032d : 0x031e, 4); // made by: unix, 4.5 or 3.0
    central.writeUInt16LE(version, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt16LE(time, 12);
    central.writeUInt16LE(date, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(body.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt16LE(centralExtra.length, 30);
    central.writeUInt16LE(0, 32);         // comment
    central.writeUInt16LE(0, 34);         // disk
    central.writeUInt16LE(0, 36);         // internal attrs
    central.writeUInt32LE(0o100644 * 0x10000, 38); // external attrs: -rw-r--r-- (unix mode in the high word)
    central.writeUInt32LE(offset64 ? MAX32 : offset, 42);
    centrals.push(central, name, centralExtra);
    entryCount++;

    await write(Buffer.concat([local, name, body]));
  }

  async function end() {
    const cdOffset = offset;
    const cd = Buffer.concat(centrals);
    const parts = [cd];
    // Past the classic limits, a zip64 end record and its locator go before the classic one, whose
    // overflowing fields are then written as all ones.
    const count64 = entryCount >= MAX16;
    const size64 = cd.length >= MAX32;
    const cdOffset64 = cdOffset >= MAX32;
    if (count64 || size64 || cdOffset64) {
      const end64Offset = cdOffset + cd.length;
      const end64 = Buffer.alloc(56);
      end64.writeUInt32LE(SIG_END64, 0);
      end64.writeBigUInt64LE(44n, 4);       // size of the rest of this record
      end64.writeUInt16LE(0x0300 | 45, 12); // made by: unix, 4.5
      end64.writeUInt16LE(45, 14);          // version needed: 4.5
      end64.writeUInt32LE(0, 16);           // this disk
      end64.writeUInt32LE(0, 20);           // disk with the central directory
      end64.writeBigUInt64LE(BigInt(entryCount), 24);
      end64.writeBigUInt64LE(BigInt(entryCount), 32);
      end64.writeBigUInt64LE(BigInt(cd.length), 40);
      end64.writeBigUInt64LE(BigInt(cdOffset), 48);
      const locator = Buffer.alloc(20);
      locator.writeUInt32LE(SIG_END64_LOCATOR, 0);
      locator.writeUInt32LE(0, 4);          // disk with the zip64 end record
      locator.writeBigUInt64LE(BigInt(end64Offset), 8);
      locator.writeUInt32LE(1, 16);         // total disks
      parts.push(end64, locator);
    }
    const eocd = Buffer.alloc(22);
    eocd.writeUInt32LE(SIG_END, 0);
    eocd.writeUInt16LE(0, 4);
    eocd.writeUInt16LE(0, 6);
    eocd.writeUInt16LE(count64 ? MAX16 : entryCount, 8);
    eocd.writeUInt16LE(count64 ? MAX16 : entryCount, 10);
    eocd.writeUInt32LE(size64 ? MAX32 : cd.length, 12);
    eocd.writeUInt32LE(cdOffset64 ? MAX32 : cdOffset, 16);
    eocd.writeUInt16LE(0, 20);
    parts.push(eocd);
    await write(Buffer.concat(parts));
    return offset;
  }

  return { add, end };
}

// A zip64 extended-information extra field holding the given 64-bit values.
function zip64Extra(values: number[]) {
  const buf = Buffer.alloc(4 + 8 * values.length);
  buf.writeUInt16LE(ZIP64_EXTRA, 0);
  buf.writeUInt16LE(8 * values.length, 2);
  values.forEach((v, i) => buf.writeBigUInt64LE(BigInt(v), 4 + 8 * i));
  return buf;
}

// Zip every file under `dir`, stored beneath `prefix/` inside the archive. Returns a Buffer.
// `transform(rel, buf)` may return replacement bytes for a file (e.g. to stamp the manifest).
export async function zipDirectory(dir: string, prefix: string, transform: (rel: string, buf: Buffer) => Buffer = (rel, buf) => buf): Promise<Buffer> {
  const chunks: Buffer[] = [];
  const zip = createZipWriter({ write: (b) => { chunks.push(b); return true; }, on() {}, off() {} });
  for (const rel of walk(dir)) await zip.add(`${prefix}/${rel}`, transform(rel, fs.readFileSync(path.join(dir, rel))));
  await zip.end();
  return Buffer.concat(chunks);
}

// ---- reader -------------------------------------------------------------------------------

export class ZipError extends Error {}

// A relative path with no traversal: no leading slash, drive letter, backslash, NUL, or `.`/`..` segment.
export function isSafeZipPath(name: unknown): name is string {
  if (typeof name !== 'string' || !name || name.length > 1024) return false;
  if (name.startsWith('/') || /[\\\0]/.test(name) || /^[A-Za-z]:/.test(name)) return false;
  return name.split('/').every((seg) => seg !== '' && seg !== '.' && seg !== '..');
}

// Open a zip file on disk. Entries come from the central directory; `read(entry)` returns the
// inflated bytes (checked against the recorded CRC). Directory entries are left out. Throws
// ZipError for anything malformed or unsupported (encryption, other compression methods).
export interface ZipEntry {
  name: string;
  method: number;
  crc: number;
  compressedSize: number;
  size: number;
  offset: number;
}

export type ZipFile = ReturnType<typeof openZipFile>;

// A 64-bit zip field as a Number, refusing values past what a Number holds exactly.
function toSafe(v: bigint) {
  if (v > BigInt(Number.MAX_SAFE_INTEGER)) throw new ZipError('not a valid zip file');
  return Number(v);
}

// The 64-bit values in an extra block's zip64 field (header 0x0001), or none if it has none.
function zip64Values(extra: Buffer): number[] {
  for (let q = 0; q + 4 <= extra.length;) {
    const id = extra.readUInt16LE(q);
    const len = extra.readUInt16LE(q + 2);
    if (q + 4 + len > extra.length) break;
    if (id === ZIP64_EXTRA) {
      const out: number[] = [];
      for (let r = q + 4; r + 8 <= q + 4 + len; r += 8) out.push(toSafe(extra.readBigUInt64LE(r)));
      return out;
    }
    q += 4 + len;
  }
  return [];
}

export function openZipFile(file: string, { maxEntrySize = Infinity }: { maxEntrySize?: number } = {}) {
  const fd = fs.openSync(file, 'r');
  const size = fs.fstatSync(fd).size;

  function readAt(pos: number, len: number) {
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
    let count = tail.readUInt16LE(eocd + 10);
    let cdSize = tail.readUInt32LE(eocd + 12);
    let cdOffset = tail.readUInt32LE(eocd + 16);
    // Zip64: a locator right before the classic end record points at the zip64 end record, whose
    // values replace the classic ones.
    const locatorPos = size - tail.length + eocd - 20;
    if (locatorPos >= 0 && readAt(locatorPos, 4).readUInt32LE(0) === SIG_END64_LOCATOR) {
      const end64 = readAt(toSafe(readAt(locatorPos + 8, 8).readBigUInt64LE(0)), 56);
      if (end64.readUInt32LE(0) !== SIG_END64) throw new ZipError('not a valid zip file');
      count = toSafe(end64.readBigUInt64LE(32));
      cdSize = toSafe(end64.readBigUInt64LE(40));
      cdOffset = toSafe(end64.readBigUInt64LE(48));
    }

    const cd = readAt(cdOffset, cdSize);
    const entries: ZipEntry[] = [];
    let p = 0;
    for (let i = 0; i < count; i++) {
      if (p + 46 > cd.length || cd.readUInt32LE(p) !== SIG_CENTRAL) throw new ZipError('not a valid zip file');
      const flags = cd.readUInt16LE(p + 8);
      const method = cd.readUInt16LE(p + 10);
      const crc = cd.readUInt32LE(p + 16);
      let compressedSize = cd.readUInt32LE(p + 20);
      let uncompressedSize = cd.readUInt32LE(p + 24);
      const nameLen = cd.readUInt16LE(p + 28);
      const extraLen = cd.readUInt16LE(p + 30);
      const commentLen = cd.readUInt16LE(p + 32);
      let offset = cd.readUInt32LE(p + 42);
      const name = cd.subarray(p + 46, p + 46 + nameLen).toString('utf8');
      const extra = cd.subarray(p + 46 + nameLen, p + 46 + nameLen + extraLen);
      p += 46 + nameLen + extraLen + commentLen;
      if (p > cd.length) throw new ZipError('not a valid zip file');
      if (flags & 0x0001) throw new ZipError(`${name}: encrypted entries are not supported`);
      if (method !== 0 && method !== 8) throw new ZipError(`${name}: unsupported compression method ${method}`);
      // Fields written as 0xffffffff take their values, in order, from the zip64 extra field.
      if (uncompressedSize === MAX32 || compressedSize === MAX32 || offset === MAX32) {
        const values = zip64Values(extra);
        const next = () => {
          const v = values.shift();
          if (v === undefined) throw new ZipError(`${name}: missing zip64 sizes`);
          return v;
        };
        if (uncompressedSize === MAX32) uncompressedSize = next();
        if (compressedSize === MAX32) compressedSize = next();
        if (offset === MAX32) offset = next();
      }
      if (name.endsWith('/')) continue;
      entries.push({ name, method, crc, compressedSize, size: uncompressedSize, offset });
    }

    function read(entry: ZipEntry): Buffer {
      if (entry.size > maxEntrySize) throw new ZipError(`${entry.name}: too large`);
      const local = readAt(entry.offset, 30);
      if (local.readUInt32LE(0) !== SIG_LOCAL) throw new ZipError('not a valid zip file');
      const dataStart = entry.offset + 30 + local.readUInt16LE(26) + local.readUInt16LE(28);
      const raw = readAt(dataStart, entry.compressedSize);
      let data: Buffer;
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
