import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import type { ChildProcessByStdio } from 'node:child_process';
import type { Readable } from 'node:stream';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { startServer } from './helpers/server.ts';
import type { Server } from './helpers/server.ts';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

describe('startup', () => {
  let server: Server, dataDir: string, child: ChildProcessByStdio<null, Readable, Readable> | undefined;
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
    const proc = spawn(process.execPath, ['src/server.ts'], { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] });
    child = proc;
    let out = '';
    proc.stdout.on('data', (d) => { out += d; });
    proc.stderr.on('data', (d) => { out += d; });
    const code = await new Promise((resolve) => proc.once('exit', resolve));
    assert.equal(code, 1);
    assert.match(out, /can't listen on :\d+: .*EADDRINUSE/);
    assert.doesNotMatch(out, /listening on/);
  });
});

describe('PINNERY_PROXIES not a number', () => {
  it('refuses to start', { timeout: 10_000 }, async (t) => {
    const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'pinnery-test-'));
    t.after(() => fs.rm(dataDir, { recursive: true, force: true }));
    const env = {
      PATH: process.env.PATH,
      DATA_DIR: dataDir,
      PORT: '0',
      PINNERY_ADMIN_EMAIL: 'admin@example.com',
      PINNERY_PASSWORD: 'initial-pass-1',
      PINNERY_PROXIES: 'true',
    };
    const child = spawn(process.execPath, ['src/server.ts'], { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] });
    t.after(() => child.kill('SIGKILL'));
    let out = '';
    child.stderr.on('data', (d) => { out += d; });
    const code = await new Promise((resolve) => child.once('exit', resolve));
    assert.equal(code, 1);
    assert.match(out, /PINNERY_PROXIES must be the number of proxies.*refusing to start/);
  });
});

describe('database from a newer Pinnery', () => {
  it('refuses to start', { timeout: 10_000 }, async (t) => {
    const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'pinnery-test-'));
    t.after(() => fs.rm(dataDir, { recursive: true, force: true }));
    const db = new Database(path.join(dataDir, 'pinnery.db'));
    db.exec('CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)');
    db.pragma('user_version = 9999');
    db.close();
    const env = {
      PATH: process.env.PATH,
      DATA_DIR: dataDir,
      PORT: '0',
      PINNERY_ADMIN_EMAIL: 'admin@example.com',
      PINNERY_PASSWORD: 'initial-pass-1',
    };
    const child = spawn(process.execPath, ['src/server.ts'], { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] });
    t.after(() => child.kill('SIGKILL'));
    let out = '';
    child.stderr.on('data', (d) => { out += d; });
    const code = await new Promise((resolve) => child.once('exit', resolve));
    assert.equal(code, 1);
    assert.match(out, /schema version 9999.*refusing to start/);
  });
});

describe('shutdown', () => {
  it('exits cleanly on SIGTERM', { timeout: 10_000 }, async (t) => {
    const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'pinnery-test-'));
    t.after(() => fs.rm(dataDir, { recursive: true, force: true }));
    const env = {
      PATH: process.env.PATH,
      DATA_DIR: dataDir,
      PORT: '0',
      PINNERY_ADMIN_EMAIL: 'admin@example.com',
      PINNERY_PASSWORD: 'initial-pass-1',
    };
    const child = spawn(process.execPath, ['src/server.ts'], { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] });
    t.after(() => child.kill('SIGKILL'));
    let out = '';
    const listening = new Promise<void>((resolve) => {
      child.stdout.on('data', (d) => { out += d; if (out.includes('listening on')) resolve(); });
    });
    child.stderr.on('data', (d) => { out += d; });
    const exited = new Promise((resolve) => child.once('exit', (code, signal) => resolve({ code, signal })));
    await listening;
    child.kill('SIGTERM');
    assert.deepEqual(await exited, { code: 0, signal: null });
    assert.match(out, /SIGTERM: shutting down/);
  });
});

describe('leftover import files', () => {
  it('are cleared at startup', { timeout: 10_000 }, async (t) => {
    const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'pinnery-test-'));
    t.after(() => fs.rm(dataDir, { recursive: true, force: true }));
    await fs.mkdir(path.join(dataDir, 'tmp'));
    await fs.writeFile(path.join(dataDir, 'tmp', 'import-0123456789abcdef.zip'), 'partial upload');
    const env = {
      PATH: process.env.PATH,
      DATA_DIR: dataDir,
      PORT: '0',
      PINNERY_ADMIN_EMAIL: 'admin@example.com',
      PINNERY_PASSWORD: 'initial-pass-1',
    };
    const child = spawn(process.execPath, ['src/server.ts'], { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] });
    t.after(() => child.kill('SIGKILL'));
    let out = '';
    child.stderr.on('data', (d) => { out += d; });
    await new Promise<void>((resolve, reject) => {
      child.stdout.on('data', (d) => { out += d; if (/listening on/.test(out)) resolve(); });
      child.once('exit', (code) => reject(new Error(`exited ${code}: ${out}`)));
    });
    assert.match(out, /sweep: removed 1 leftover import file\(s\)/);
    await assert.rejects(fs.access(path.join(dataDir, 'tmp')), { code: 'ENOENT' });
  });
});
