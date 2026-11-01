import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startServer } from './helpers/server.js';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

describe('startup', () => {
  let server, dataDir, child;
  before(async () => {
    server = await startServer();
    dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'pinnery-test-'));
  });
  after(async () => {
    child?.kill('SIGKILL'); // only still running if the bind wrongly succeeded
    await server.stop();
    await fs.rm(dataDir, { recursive: true, force: true });
  });

  it('exits non-zero with the reason when the port is taken', { timeout: 10_000 }, async () => {
    const env = {
      PATH: process.env.PATH,
      DATA_DIR: dataDir,
      PORT: new URL(server.url).port,
      PINNERY_ADMIN_EMAIL: 'admin@example.com',
      PINNERY_PASSWORD: 'initial-pass-1',
    };
    child = spawn(process.execPath, ['src/server.js'], { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { out += d; });
    const code = await new Promise((resolve) => child.once('exit', resolve));
    assert.equal(code, 1);
    assert.match(out, /can't listen on :\d+: .*EADDRINUSE/);
    assert.doesNotMatch(out, /listening on/);
  });
});

describe('PINNERY_TRUST_PROXY=true', () => {
  it('refuses to start', { timeout: 10_000 }, async (t) => {
    const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'pinnery-test-'));
    t.after(() => fs.rm(dataDir, { recursive: true, force: true }));
    const env = {
      PATH: process.env.PATH,
      DATA_DIR: dataDir,
      PORT: '0',
      PINNERY_ADMIN_EMAIL: 'admin@example.com',
      PINNERY_PASSWORD: 'initial-pass-1',
      PINNERY_TRUST_PROXY: 'true',
    };
    const child = spawn(process.execPath, ['src/server.js'], { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] });
    t.after(() => child.kill('SIGKILL'));
    let out = '';
    child.stderr.on('data', (d) => { out += d; });
    const code = await new Promise((resolve) => child.once('exit', resolve));
    assert.equal(code, 1);
    assert.match(out, /PINNERY_TRUST_PROXY=true .*refusing to start/);
  });
});
