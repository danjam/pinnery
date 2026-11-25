import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { openZipFile } from '../src/zip.ts';
import { makeRoot } from './helpers/root.ts';
import { startServer } from './helpers/server.ts';
import type { Server } from './helpers/server.ts';

describe('GET /extension.zip', () => {
  let server: Server;
  let dir: string;
  before(async () => {
    server = await startServer();
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pinnery-extzip-'));
  });
  after(async () => {
    await server.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const download = async (): Promise<Buffer> => {
    const res = await (await server.adminClient()).fetch('/extension.zip');
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('content-type'), 'application/zip');
    return Buffer.from(await res.arrayBuffer());
  };

  it('stamps the fingerprint into manifest.json', async () => {
    const file = path.join(dir, 'ext.zip');
    fs.writeFileSync(file, await download());
    const z = await openZipFile(file);
    try {
      const entry = z.entries.find((e) => e.name === 'pinnery-extension/manifest.json');
      assert.ok(entry);
      const manifest = JSON.parse((await z.read(entry)).toString('utf8'));
      const { body } = await server.anon().get('/healthz');
      assert.equal(manifest.version_name, `${manifest.version}+${body.extension_fingerprint}`);
    } finally {
      await z.close();
    }
  });

  it('serves the same zip on every download instead of rebuilding it', async () => {
    const first = await download();
    // Zip entries carry the build time at 2-second resolution, so a rebuild would differ.
    await sleep(2100);
    assert.ok((await download()).equals(first));
  });
});

describe('GET /extension.zip when the build fails', () => {
  let server: Server, dir: string;
  before(async () => {
    dir = makeRoot({ extension: { 'manifest.json': 'not json' } });
    server = await startServer({ root: dir });
  });
  after(async () => {
    await server.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('answers 500 and retries on the next download', async () => {
    const admin = await server.adminClient();
    assert.equal((await admin.fetch('/extension.zip')).status, 500);
    fs.writeFileSync(path.join(dir, 'dist', 'extension', 'manifest.json'), JSON.stringify({ version: '1.0' }));
    assert.equal((await admin.fetch('/extension.zip')).status, 200);
  });
});
