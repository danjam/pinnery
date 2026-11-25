import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
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
    const z = await openZipFile(file);
    try {
      assert.equal(z.entries.length, 70_000);
      assert.equal((await z.read(z.entries[69_999])).toString(), '69999');
    } finally {
      await z.close();
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
    const z = await openZipFile(file);
    try {
      assert.deepEqual(z.entries.map((e) => e.name), ['a.txt', 'b.txt']);
      assert.equal(z.entries[0].offset, offset);
      assert.ok(z.entries[1].offset > offset);
      assert.deepEqual(await z.read(z.entries[0]), data);
      assert.equal((await z.read(z.entries[1])).toString(), 'second');
    } finally {
      await z.close();
    }
  });

  // One stored entry, built by hand, whose central record has both sizes as 0xffffffff and the
  // real ones in a zip64 extra field (`extra` overrides it). With `end64At`, a zip64 locator before
  // the end record points there.
  function handZip({ extra, end64At }: { extra?: Buffer; end64At?: number } = {}) {
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
    if (!extra) {
      extra = Buffer.alloc(20);
      extra.writeUInt16LE(0x0001, 0);
      extra.writeUInt16LE(16, 2);
      extra.writeBigUInt64LE(BigInt(data.length), 4);
      extra.writeBigUInt64LE(BigInt(data.length), 12);
    }
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
    const locator = Buffer.alloc(end64At === undefined ? 0 : 20);
    if (end64At !== undefined) {
      locator.writeUInt32LE(0x07064b50, 0);
      locator.writeBigUInt64LE(BigInt(end64At), 8);
      locator.writeUInt32LE(1, 16);
    }
    const eocd = Buffer.alloc(22);
    eocd.writeUInt32LE(0x06054b50, 0);
    eocd.writeUInt16LE(1, 8);
    eocd.writeUInt16LE(1, 10);
    eocd.writeUInt32LE(cd.length, 12);
    eocd.writeUInt32LE(body.length, 16);
    return { data, zip: Buffer.concat([body, cd, locator, eocd]) };
  }

  const open = async (name: string, zip: Buffer) => {
    const file = path.join(dir, name);
    fs.writeFileSync(file, zip);
    return await openZipFile(file);
  };

  it('reads sizes from the zip64 extra field, as other zip tools write them', async () => {
    const { zip, data } = handZip();
    const z = await open('sizes.zip', zip);
    try {
      assert.equal(z.entries[0].size, data.length);
      assert.deepEqual(await z.read(z.entries[0]), data);
    } finally {
      await z.close();
    }
    // after another extra field, as Info-ZIP writes them (a 5-byte extended timestamp first)
    const ts = Buffer.from([0x55, 0x54, 0x05, 0x00, 0x01, 0, 0, 0, 0]);
    const field = Buffer.alloc(20);
    field.writeUInt16LE(0x0001, 0);
    field.writeUInt16LE(16, 2);
    field.writeBigUInt64LE(BigInt(data.length), 4);
    field.writeBigUInt64LE(BigInt(data.length), 12);
    const z2 = await open('sizes-after-ts.zip', handZip({ extra: Buffer.concat([ts, field]) }).zip);
    try {
      assert.deepEqual(await z2.read(z2.entries[0]), data);
    } finally {
      await z2.close();
    }
  });

  it('refuses malformed zip64 records', async () => {
    // sizes marked as zip64 with no zip64 field to read them from
    await assert.rejects(open('no-extra.zip', handZip({ extra: Buffer.alloc(0) }).zip), /x\.txt: missing zip64 sizes/);
    // a size past what a Number holds exactly
    const huge = Buffer.alloc(20);
    huge.writeUInt16LE(0x0001, 0);
    huge.writeUInt16LE(16, 2);
    huge.writeBigUInt64LE(2n ** 60n, 4);
    huge.writeBigUInt64LE(11n, 12);
    await assert.rejects(open('huge.zip', handZip({ extra: huge }).zip), /not a valid zip file/);
    // a locator pointing at something that isn't a zip64 end record
    await assert.rejects(open('bad-end64.zip', handZip({ end64At: 0 }).zip), /not a valid zip file/);
  });
});

// Export and import run alongside other requests, so the zip work must not hold the event loop.
// On a fully synchronous path the awaits settle as microtasks, before any setImmediate can run.
describe('zip I/O yields to the event loop', () => {
  let dir: string;
  before(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pinnery-zip-async-')); });
  after(() => fs.rmSync(dir, { recursive: true, force: true }));

  const data = Buffer.alloc(4 * 1024 * 1024, 'pinnery ');
  const yielded = () => {
    const state = { ticked: false };
    setImmediate(() => { state.ticked = true; });
    return state;
  };

  it('while deflating an entry', async () => {
    const state = yielded();
    await makeZip([['big.txt', data]]);
    assert.ok(state.ticked);
  });

  it('while opening a zip and inflating an entry', async () => {
    const file = path.join(dir, 'big.zip');
    fs.writeFileSync(file, await makeZip([['big.txt', data]]));
    const state = yielded();
    const z = await openZipFile(file);
    try {
      assert.deepEqual(await z.read(z.entries[0]), data);
      assert.ok(state.ticked);
    } finally {
      await z.close();
    }
  });
});

describe('zip edge cases', () => {
  let dir: string;
  before(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pinnery-zip-edge-')); });
  after(() => fs.rmSync(dir, { recursive: true, force: true }));

  // A sink that is always full: every write waits for the event named by `release`.
  function fullSink(release: 'drain' | 'close') {
    const chunks: Buffer[] = [];
    const emitter = new EventEmitter();
    const sink = {
      write: (b: Buffer) => { chunks.push(b); setImmediate(() => emitter.emit(release)); return false; },
      on: (ev: string, fn: () => void) => { emitter.on(ev, fn); },
      off: (ev: string, fn: () => void) => { emitter.off(ev, fn); },
    };
    return { sink, chunks, emitter };
  }

  for (const release of ['drain', 'close'] as const) {
    it(`waits for '${release}' when the sink is full`, async () => {
      const { sink, chunks, emitter } = fullSink(release);
      const z = createZipWriter(sink);
      await z.add('a.txt', Buffer.from('hello'));
      await z.end();
      assert.ok(chunks.length > 0);
      assert.equal(emitter.listenerCount('drain') + emitter.listenerCount('close'), 0, 'listeners are removed');
    });
  }

  it('refuses an entry whose deflate data is corrupt', async () => {
    const zip = await makeZip([['a.txt', Buffer.alloc(1000, 'a')]]);
    zip[30 + zip.readUInt16LE(26) + zip.readUInt16LE(28)] = 0x07; // final block, reserved type 3
    const file = path.join(dir, 'corrupt.zip');
    fs.writeFileSync(file, zip);
    const z = await openZipFile(file);
    try {
      await assert.rejects(z.read(z.entries[0]), /a\.txt: corrupt entry/);
    } finally {
      await z.close();
    }
  });
});
