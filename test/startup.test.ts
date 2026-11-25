import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import type { ChildProcessByStdio } from 'node:child_process';
import type { Readable } from 'node:stream';
import fsSync from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { makeRoot } from './helpers/root.ts';
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

// Start src/server.ts in `cwd` and wait until it is listening (then stop it) or exits.
async function run(env: Record<string, string>, cwd = root): Promise<{ code: number | null; out: string }> {
  const child = spawn(process.execPath, ['src/server.ts'], { cwd, env: { PATH: process.env.PATH, PORT: '0', ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '', stopping = false;
  child.stdout.on('data', (d) => { out += d; if (!stopping && out.includes('listening on')) { stopping = true; child.kill('SIGTERM'); } });
  child.stderr.on('data', (d) => { out += d; });
  // A startup that hangs mustn't outlive the test (each test's own timeout is shorter than this).
  const hung = setTimeout(() => child.kill('SIGKILL'), 20_000);
  const code = await new Promise<number | null>((resolve) => child.once('exit', resolve));
  clearTimeout(hung);
  return { code, out };
}

describe('required settings', () => {
  it('refuses to start without PINNERY_ADMIN_EMAIL and PINNERY_PASSWORD', { timeout: 10_000 }, async (t) => {
    const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'pinnery-test-'));
    t.after(() => fs.rm(dataDir, { recursive: true, force: true }));
    const both = await run({ DATA_DIR: dataDir });
    assert.equal(both.code, 1);
    assert.match(both.out, /PINNERY_ADMIN_EMAIL and PINNERY_PASSWORD are not set — refusing to start/);
    const one = await run({ DATA_DIR: dataDir, PINNERY_ADMIN_EMAIL: 'admin@example.com' });
    assert.equal(one.code, 1);
    assert.match(one.out, /PINNERY_PASSWORD is not set — refusing to start/);
  });

  it('refuses to start without a build', { timeout: 10_000 }, async (t) => {
    const dir = makeRoot({ extension: null });
    t.after(() => fsSync.rmSync(dir, { recursive: true, force: true }));
    const { code, out } = await run({ DATA_DIR: path.join(dir, 'data'), PINNERY_ADMIN_EMAIL: 'admin@example.com', PINNERY_PASSWORD: 'initial-pass-1' }, dir);
    assert.equal(code, 1);
    assert.match(out, /dist\/public is missing — run npm run build first — refusing to start/);
  });
});

describe('PINNERY_PASSWORD changed', () => {
  const env = (dataDir: string, password: string) => ({ DATA_DIR: dataDir, PINNERY_ADMIN_EMAIL: 'admin@example.com', PINNERY_PASSWORD: password });

  it('resets the seeded admin\'s password and drops their sessions', { timeout: 20_000 }, async (t) => {
    const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'pinnery-test-'));
    t.after(() => fs.rm(dataDir, { recursive: true, force: true }));
    assert.equal((await run(env(dataDir, 'initial-pass-1'))).code, 0);
    const changed = await run(env(dataDir, 'recovery-pass-1'));
    assert.equal(changed.code, 0);
    assert.match(changed.out, /PINNERY_PASSWORD changed: reset the seeded admin's password, dropped 0 session\(s\)/);
    const db = new Database(path.join(dataDir, 'pinnery.db'), { readonly: true });
    t.after(() => db.close());
    assert.equal(db.prepare("SELECT must_change_password FROM users WHERE email = 'admin@example.com'").pluck().get(), 1);
  });

  it('says so when the seeded admin is gone', { timeout: 20_000 }, async (t) => {
    const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'pinnery-test-'));
    t.after(() => fs.rm(dataDir, { recursive: true, force: true }));
    assert.equal((await run(env(dataDir, 'initial-pass-1'))).code, 0);
    const db = new Database(path.join(dataDir, 'pinnery.db'));
    db.prepare("UPDATE settings SET value = '999' WHERE key = 'seed_admin_id'").run();
    db.close();
    const changed = await run(env(dataDir, 'recovery-pass-1'));
    assert.equal(changed.code, 0);
    assert.match(changed.out, /PINNERY_PASSWORD changed, but the seeded admin \(user 999\) no longer exists — nothing reset/);
  });
});

describe('orphaned image files', () => {
  it('are removed at startup', { timeout: 20_000 }, async (t) => {
    const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'pinnery-test-'));
    t.after(() => fs.rm(dataDir, { recursive: true, force: true }));
    const env = { DATA_DIR: dataDir, PINNERY_ADMIN_EMAIL: 'admin@example.com', PINNERY_PASSWORD: 'initial-pass-1' };
    assert.equal((await run(env)).code, 0);
    const sha = 'ab'.repeat(32);
    await fs.mkdir(path.join(dataDir, 'originals', 'ab'));
    await fs.writeFile(path.join(dataDir, 'originals', 'ab', sha), 'no pin has this');
    await fs.writeFile(path.join(dataDir, 'originals', 'ab', `${sha}.tmp-1234abcd`), 'a write a crash cut short');
    await fs.writeFile(path.join(dataDir, 'originals', 'stray'), 'not a shard directory');
    const { code, out } = await run(env);
    assert.equal(code, 0);
    assert.match(out, /sweep: removed 2 orphaned file\(s\)/);
    assert.deepEqual(await fs.readdir(path.join(dataDir, 'originals', 'ab')), []);
  });
});
