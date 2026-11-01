import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { openDb, SchemaError, SCHEMA_VERSION } from '../src/db.ts';
import type { Db } from '../src/db.ts';

const version = (db: Db) => db.pragma('user_version', { simple: true });
const columns = (db: Db, table: string) => (db.pragma(`table_info(${table})`) as { name: string }[]).map((c) => c.name);

describe('schema versions', () => {
  let dataDir: string;
  beforeEach(() => { dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pinnery-test-')); });
  afterEach(() => fs.rmSync(dataDir, { recursive: true, force: true }));

  // Write straight to pinnery.db, bypassing openDb.
  const raw = (fn: (db: Db) => void) => {
    const db = new Database(path.join(dataDir, 'pinnery.db'));
    fn(db);
    db.close();
  };
  // console.log lines from openDb announcing a step it ran.
  const migrationsLogged = (t: { mock: { method: typeof import('node:test').mock.method } }) => {
    const log = t.mock.method(console, 'log', () => {});
    return () => log.mock.calls.filter((c) => /^db: migrated/.test(String(c.arguments[0]))).length;
  };

  it('starts a new database at the latest version without running steps', (t) => {
    const migrated = migrationsLogged(t);
    const db = openDb(dataDir);
    assert.equal(version(db), SCHEMA_VERSION);
    assert.ok(columns(db, 'boards').includes('owner_id'));
    assert.equal(migrated(), 0);
    db.close();
  });

  it('brings an unversioned database of the current shape to the latest version, once', (t) => {
    openDb(dataDir).close();
    raw((db) => db.pragma('user_version = 0'));
    const migrated = migrationsLogged(t);

    let db = openDb(dataDir);
    assert.equal(version(db), SCHEMA_VERSION);
    assert.equal(migrated(), SCHEMA_VERSION);
    db.close();

    db = openDb(dataDir);
    assert.equal(migrated(), SCHEMA_VERSION, 'the second open runs no steps');
    db.close();
  });

  it('upgrades a database from before accounts, keeping its data and backing it up first', (t) => {
    t.mock.method(console, 'log', () => {});
    raw((db) => db.exec(`
      CREATE TABLE boards (id INTEGER PRIMARY KEY, name TEXT NOT NULL, cover_pin_id INTEGER, created_at TEXT);
      CREATE TABLE pins (id INTEGER PRIMARY KEY, board_id INTEGER NOT NULL, sha256 TEXT NOT NULL, width INTEGER NOT NULL,
        height INTEGER NOT NULL, mime TEXT NOT NULL, animated INTEGER NOT NULL DEFAULT 0, source_url TEXT, page_title TEXT,
        dhash TEXT NOT NULL, created_at TEXT);
      CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE sessions (id INTEGER PRIMARY KEY, token_hash TEXT NOT NULL UNIQUE, kind TEXT NOT NULL DEFAULT 'session',
        name TEXT, created_at TEXT, last_used_at TEXT, expires_at TEXT);
      INSERT INTO boards (name) VALUES ('Garden');
      INSERT INTO pins (board_id, sha256, width, height, mime, dhash) VALUES (1, 'abc', 10, 20, 'image/png', 'ff');
      INSERT INTO settings VALUES ('dupe_threshold', '5');
    `));

    const db = openDb(dataDir);
    assert.equal(version(db), SCHEMA_VERSION);
    assert.ok(columns(db, 'boards').includes('owner_id'));
    assert.ok(columns(db, 'sessions').includes('user_id'));
    assert.ok(!columns(db, 'pins').includes('dhash'));
    assert.ok(columns(db, 'email_tokens').length > 0, 'missing tables are created');
    assert.equal(db.prepare("SELECT value FROM settings WHERE key = 'dupe_threshold'").get(), undefined);
    assert.deepEqual(db.prepare('SELECT name FROM boards').all(), [{ name: 'Garden' }]);
    assert.equal((db.prepare('SELECT count(*) AS n FROM pins').get() as { n: number }).n, 1);
    db.close();

    // Same tables, columns and indexes as a new database, so later steps can rely on version 1.
    const shape = (db: Db) => (db.prepare("SELECT type, name FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY name").all() as { type: string; name: string }[])
      .map((o) => (o.type === 'table' ? `${o.name}(${columns(db, o.name).sort().join(',')})` : o.name));
    const freshDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pinnery-test-'));
    t.after(() => fs.rmSync(freshDir, { recursive: true, force: true }));
    const fresh = openDb(freshDir);
    const upgraded = openDb(dataDir);
    assert.deepEqual(shape(upgraded), shape(fresh));
    fresh.close();
    upgraded.close();

    const backups = fs.readdirSync(path.join(dataDir, 'backups'));
    assert.equal(backups.length, 1);
    assert.match(backups[0], /^pre-accounts-.*\.db$/);
  });

  it('refuses a database from a newer Pinnery', () => {
    raw((db) => {
      db.exec('CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)');
      db.pragma(`user_version = ${SCHEMA_VERSION + 1}`);
    });
    assert.throws(() => openDb(dataDir), SchemaError);
    raw((db) => assert.equal(version(db), SCHEMA_VERSION + 1, 'left untouched'));
  });
});
