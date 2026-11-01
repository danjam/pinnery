import { getSetting, setSetting } from '../db.ts';
import type { Db } from '../db.ts';
import { hashPasswordSync, normaliseEmail, verifyHashSync } from './util.ts';

// Runs once per start, before anything else in auth.
export function seedAdmin(db: Db, password: string, adminEmail: string) {
  // ---- the seeded admin -----------------------------------------------------------------------
  // PINNERY_ADMIN_EMAIL + PINNERY_PASSWORD create the first user on first start, remembered by id
  // in `seed_admin_id` so a later email change doesn't matter. The env password is only a
  // bootstrap/recovery secret: the admin has to choose their own before doing anything else.
  // A database from before accounts (db.ts has backed it up and added the owner columns) hands its
  // boards, sessions and tokens to that user, who keeps the sign-in password of the day
  // (`login_hash`); the change is only forced if that was still PINNERY_PASSWORD.
  const seed = db.transaction(() => {
    const email = normaliseEmail(adminEmail);
    if (!email.includes('@')) throw new Error('PINNERY_ADMIN_EMAIL is not an email address');
    const legacy = getSetting(db, 'login_hash') || getSetting(db, 'password_hash');
    const forced = !legacy || verifyHashSync(password, legacy);
    const { lastInsertRowid: id } = db.prepare(
      'INSERT INTO users (email, display_name, password_hash, is_admin, must_change_password) VALUES (?, ?, ?, 1, ?)',
    ).run(email, email.split('@')[0], legacy || hashPasswordSync(password), forced ? 1 : 0);
    const boards = db.prepare('UPDATE boards SET owner_id = ? WHERE owner_id IS NULL').run(id).changes;
    const sessions = db.prepare('UPDATE sessions SET user_id = ? WHERE user_id IS NULL').run(id).changes;
    setSetting(db, 'seed_admin_id', id);
    db.prepare("DELETE FROM settings WHERE key = 'login_hash'").run();
    console.log(`accounts: created admin ${email} (id ${id})${legacy
      ? `, moved ${boards} board(s) and ${sessions} session(s)/token(s); password change required: ${forced ? 'yes' : 'no'}` : ''}`);
  });
  if (!getSetting(db, 'seed_admin_id')) seed();

  // Editing PINNERY_PASSWORD and restarting resets the seeded admin's password to it (the way back
  // in if it's forgotten), forces a change and drops that user's browser sessions. Other users and
  // all API tokens are untouched.
  const stored = getSetting(db, 'password_hash');
  if (!verifyHashSync(password, stored)) {
    setSetting(db, 'password_hash', hashPasswordSync(password));
    if (stored) {
      const adminId = Number(getSetting(db, 'seed_admin_id'));
      const { changes: reset } = db.prepare('UPDATE users SET password_hash = ?, must_change_password = 1 WHERE id = ?').run(hashPasswordSync(password), adminId);
      if (!reset) {
        console.warn(`PINNERY_PASSWORD changed, but the seeded admin (user ${adminId}) no longer exists — nothing reset`);
      } else {
        const { changes } = db.prepare("DELETE FROM sessions WHERE kind = 'session' AND user_id = ?").run(adminId);
        console.log(`PINNERY_PASSWORD changed: reset the seeded admin's password, dropped ${changes} session(s)`);
      }
    }
  }
}
