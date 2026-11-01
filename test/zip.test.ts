import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { createZipWriter, openZipFile } from '../src/zip.ts';

const SIG_END64 = Buffer.from([0x50, 0x4b, 0x06, 0x06]);
const GiB = 1024 ** 3;

// Write a zip with the app's writer into memory. `offset` starts it that far into the output.
async function makeZip(entries: [string, Buffer][], { offset = 0, compress = true } = {}) {
  const chunks: Buffer[] = [];
  const z = createZipWriter({ write: (b) => { chunks.push(b); return true; }, on() {}, off() {} }, { offset });
  for (const [name, data] of entries) await z.add(name, data, { compress });
  await z.end();
  return Buffer.concat(chunks);
}

describe('zip64', () => {
  let dir: string;
  before(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pinnery-zip64-')); });
  after(() => fs.rmSync(dir, { recursive: true, force: true }));

  it('keeps small archives as plain zips', async () => {
    const zip = await makeZip([['a.txt', Buffer.from('hello')]]);
    assert.equal(zip.indexOf(SIG_END64), -1);
    assert.equal(zip.readUInt16LE(4), 20, 'version needed: 2.0');
  });

  it('writes and reads back more than 65,535 entries', async () => {
    const entries: [string, Buffer][] = Array.from({ length: 70_000 }, (_, i) => [`f/${i}.txt`, Buffer.from(String(i))]);
    const zip = await makeZip(entries, { compress: false });
    assert.notEqual(zip.indexOf(SIG_END64), -1);
    const file = path.join(dir, 'many.zip');
    fs.writeFileSync(file, zip);
    const z = openZipFile(file);
    try {
      assert.equal(z.entries.length, 70_000);
      assert.equal(z.read(z.entries[69_999]).toString(), '69999');
    } finally {
      z.close();
    }
  });

  it('writes and reads back entries past 4 GiB', async () => {
    // Start the archive 5 GiB into a sparse file: every offset needs 64 bits, no disk is used.
    const offset = 5 * GiB;
    const data = Buffer.from('past the 4 GiB mark');
    const zip = await makeZip([['a.txt', data], ['b.txt', Buffer.from('second')]], { offset });
    const file = path.join(dir, 'far.zip');
    const fd = fs.openSync(file, 'w');
    fs.writeSync(fd, zip, 0, zip.length, offset);
    fs.closeSync(fd);
    const z = openZipFile(file);
    try {
      assert.deepEqual(z.entries.map((e) => e.name), ['a.txt', 'b.txt']);
      assert.equal(z.entries[0].offset, offset);
      assert.ok(z.entries[1].offset > offset);
      assert.deepEqual(z.read(z.entries[0]), data);
      assert.equal(z.read(z.entries[1]).toString(), 'second');
    } finally {
      z.close();
    }
  });

  it('reads sizes from the zip64 extra field, as other zip tools write them', () => {
    // One stored entry whose central record has both sizes as 0xffffffff and the real ones in a
    // zip64 extra field (built by hand: our writer never needs this).
    const name = Buffer.from('x.txt');
    const data = Buffer.from('zip64 sizes');
    const crc = zlib.crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(45, 4);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26);
    const extra = Buffer.alloc(20);
    extra.writeUInt16LE(0x0001, 0);
    extra.writeUInt16LE(16, 2);
    extra.writeBigUInt64LE(BigInt(data.length), 4);
    extra.writeBigUInt64LE(BigInt(data.length), 12);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(45, 6);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(0xffffffff, 20);
    central.writeUInt32LE(0xffffffff, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt16LE(extra.length, 30);
    const body = Buffer.concat([local, name, data]);
    const cd = Buffer.concat([central, name, extra]);
    const eocd = Buffer.alloc(22);
    eocd.writeUInt32LE(0x06054b50, 0);
    eocd.writeUInt16LE(1, 8);
    eocd.writeUInt16LE(1, 10);
    eocd.writeUInt32LE(cd.length, 12);
    eocd.writeUInt32LE(body.length, 16);
    const file = path.join(dir, 'sizes.zip');
    fs.writeFileSync(file, Buffer.concat([body, cd, eocd]));
    const z = openZipFile(file);
    try {
      assert.equal(z.entries[0].size, data.length);
      assert.deepEqual(z.read(z.entries[0]), data);
    } finally {
      z.close();
    }
  });
});
