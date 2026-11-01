import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';

export type Db = Database.Database;

// Rows as the schema below stores them. SQLite has no boolean: flags are 0 | 1.
export interface UserRow {
  id: number;
  email: string;
  display_name: string;
  password_hash: string;
  is_admin: number;
  must_change_password: number;
  created_at: string;
}

export interface BoardRow {
  id: number;
  name: string;
  owner_id: number;
  cover_pin_id: number | null;
  created_at: string;
}

export interface PinRow {
  id: number;
  board_id: number;
  sha256: string;
  width: number;
  height: number;
  mime: string;
  animated: number;
  source_url: string | null;
  page_title: string | null;
  created_at: string;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id                    INTEGER PRIMARY KEY,
  email                 TEXT NOT NULL UNIQUE,     -- trimmed and lowercased
  display_name          TEXT NOT NULL,
  password_hash         TEXT NOT NULL,            -- salt:scrypt, see auth.ts
  is_admin              INTEGER NOT NULL DEFAULT 0,
  must_change_password  INTEGER NOT NULL DEFAULT 0,
  created_at            TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE TABLE IF NOT EXISTS boards (
  id            INTEGER PRIMARY KEY,
  name          TEXT NOT NULL,
  owner_id      INTEGER NOT NULL REFERENCES users(id),
  cover_pin_id  INTEGER REFERENCES pins(id) ON DELETE SET NULL,
  created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE TABLE IF NOT EXISTS pins (
  id          INTEGER PRIMARY KEY,
  board_id    INTEGER NOT NULL REFERENCES boards(id),
  sha256      TEXT NOT NULL,
  width       INTEGER NOT NULL,
  height      INTEGER NOT NULL,
  mime        TEXT NOT NULL,
  animated    INTEGER NOT NULL DEFAULT 0,
  source_url  TEXT,
  page_title  TEXT,
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX IF NOT EXISTS pins_board ON pins(board_id, id);
CREATE INDEX IF NOT EXISTS pins_sha256 ON pins(sha256);

-- A board shared with another user: a viewer looks, an editor also adds and deletes pins in it.
-- Everything else stays the owner's (see access.ts). Goes with the board or the user.
CREATE TABLE IF NOT EXISTS board_shares (
  board_id    INTEGER NOT NULL REFERENCES boards(id) ON DELETE CASCADE,
  user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role        TEXT NOT NULL CHECK (role IN ('viewer', 'editor')),
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  PRIMARY KEY (board_id, user_id)
);
CREATE INDEX IF NOT EXISTS board_shares_user ON board_shares(user_id);

-- Key/value: password_hash (the PINNERY_PASSWORD last seen) and seed_admin_id (see auth.ts).
CREATE TABLE IF NOT EXISTS settings (
  key    TEXT PRIMARY KEY,
  value  TEXT NOT NULL
);

-- Browser sessions and API tokens (kind = 'token'), each belonging to a user.
CREATE TABLE IF NOT EXISTS sessions (
  id            INTEGER PRIMARY KEY,
  token_hash    TEXT NOT NULL UNIQUE,
  user_id       INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind          TEXT NOT NULL DEFAULT 'session',
  name          TEXT,
  created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  last_used_at  TEXT,
  expires_at    TEXT
);

-- Single-use links sent by email (or copied by hand): invites, password resets and email-change
-- confirmations. Only the token's hash is kept, so a link can't be shown again after it's made.
-- user_id is the inviter for an invite, else the user the link acts on; it goes with the user.
CREATE TABLE IF NOT EXISTS email_tokens (
  id          INTEGER PRIMARY KEY,
  token_hash  TEXT NOT NULL UNIQUE,
  kind        TEXT NOT NULL,            -- invite | reset | email_change
  email       TEXT NOT NULL,            -- invitee, account email, or the new address
  user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  expires_at  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS email_tokens_user ON email_tokens(user_id, kind);
`;

// The database's schema version lives in its header (PRAGMA user_version). SCHEMA above is the
// latest shape, and only an empty database gets it, starting at the latest version. An existing one
// runs only the steps above its version, in order, never SCHEMA. To change the schema, update SCHEMA
// and append a step that brings an existing database to the same shape. Never edit or reorder a
// step that has shipped.
// Each step runs in a transaction that also records its version, so a failed step leaves the
// database at the version before it.
const MIGRATIONS: ((db: Db) => void)[] = [
  // 1: databases from before versioning (user_version 0). Their shape varies, so this step looks
  // at the tables. Later steps can rely on version 1 and needn't.
  (db) => {
    // From before accounts: these tables didn't exist. As they were at version 1; don't edit.
    db.exec(`
      CREATE TABLE IF NOT EXISTS users (
        id                    INTEGER PRIMARY KEY,
        email                 TEXT NOT NULL UNIQUE,
        display_name          TEXT NOT NULL,
        password_hash         TEXT NOT NULL,
        is_admin              INTEGER NOT NULL DEFAULT 0,
        must_change_password  INTEGER NOT NULL DEFAULT 0,
        created_at            TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
      );
      CREATE TABLE IF NOT EXISTS board_shares (
        board_id    INTEGER NOT NULL REFERENCES boards(id) ON DELETE CASCADE,
        user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        role        TEXT NOT NULL CHECK (role IN ('viewer', 'editor')),
        created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
        PRIMARY KEY (board_id, user_id)
      );
      CREATE INDEX IF NOT EXISTS board_shares_user ON board_shares(user_id);
      CREATE TABLE IF NOT EXISTS email_tokens (
        id          INTEGER PRIMARY KEY,
        token_hash  TEXT NOT NULL UNIQUE,
        kind        TEXT NOT NULL,
        email       TEXT NOT NULL,
        user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
        expires_at  TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS email_tokens_user ON email_tokens(user_id, kind);
      CREATE INDEX IF NOT EXISTS pins_board ON pins(board_id, id);
      CREATE INDEX IF NOT EXISTS pins_sha256 ON pins(sha256);
    `);
    // From before duplicate detection was removed: a NOT NULL dhash column and a dupe_threshold
    // setting, neither written any more.
    if (hasColumn(db, 'pins', 'dhash')) db.exec('ALTER TABLE pins DROP COLUMN dhash');
    db.prepare("DELETE FROM settings WHERE key = 'dupe_threshold'").run();
    // From before accounts: the owner columns are added nullable (SQLite can't add a NOT NULL
    // foreign key to an existing table); auth.ts fills them in when it seeds the admin.
    if (!hasColumn(db, 'boards', 'owner_id')) db.exec('ALTER TABLE boards ADD COLUMN owner_id INTEGER REFERENCES users(id)');
    if (!hasColumn(db, 'sessions', 'user_id')) db.exec('ALTER TABLE sessions ADD COLUMN user_id INTEGER REFERENCES users(id) ON DELETE CASCADE');
  },
];
export const SCHEMA_VERSION = MIGRATIONS.length;

// The database was written by a newer Pinnery. Running older code on it could lose data.
export class SchemaError extends Error {}

export function openDb(dataDir: string): Db {
  fs.mkdirSync(dataDir, { recursive: true });
  const db = new Database(path.join(dataDir, 'pinnery.db'));
  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = NORMAL');
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');

  const version = db.pragma('user_version', { simple: true }) as number;
  if (version > SCHEMA_VERSION) {
    db.close();
    throw new SchemaError(`the database is at schema version ${version}, but this Pinnery only knows up to ${SCHEMA_VERSION}: it was used by a newer Pinnery`);
  }
  if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table'").get()) {
    db.transaction(() => {
      db.exec(SCHEMA);
      db.pragma(`user_version = ${SCHEMA_VERSION}`);
    })();
    return db;
  }
  if (version === 0 && preAccounts(db)) backup(db, dataDir);
  for (let v = version + 1; v <= SCHEMA_VERSION; v++) {
    db.transaction(() => {
      MIGRATIONS[v - 1](db);
      db.pragma(`user_version = ${v}`);
    })();
    console.log(`db: migrated to schema version ${v}`);
  }
  return db;
}

// table_info lists nothing for a table that doesn't exist (yet).
const columnsOf = (db: Db, table: string) => db.pragma(`table_info(${table})`) as { name: string }[];
const hasColumn = (db: Db, table: string, column: string) => columnsOf(db, table).some((c) => c.name === column);

// A database from before accounts: it has sessions, but they belong to nobody. Snapshot it before
// migrating, to <dataDir>/backups/pre-accounts-<timestamp>.db.
const preAccounts = (db: Db) => columnsOf(db, 'sessions').length > 0 && !hasColumn(db, 'sessions', 'user_id');

function backup(db: Db, dataDir: string) {
  const dir = path.join(dataDir, 'backups');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `pre-accounts-${new Date().toISOString().replace(/[:.]/g, '-')}.db`);
  db.prepare('VACUUM INTO ?').run(file);
  console.log(`accounts: backed up the database to ${file}`);
}

export function getSetting(db: Db, key: string): string | null {
  const row = db.prepare<[string], { value: string }>('SELECT value FROM settings WHERE key = ?').get(key);
  return row ? row.value : null;
}

export function setSetting(db: Db, key: string, value: string | number | bigint) {
  db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
    .run(key, String(value));
}
