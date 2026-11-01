import express from 'express';
import type { Auth } from './auth.ts';
import type { Db, UserRow } from './db.ts';
import { ImageError } from './images.ts';

const toId = (v: unknown) => {
  const n = Number(v);
  return Number.isInteger(n) && n > 0 ? n : null;
};

// Settings → Users: admin-only management of accounts (server.ts mounts this behind requireAdmin).
// GET / lists everyone with their board and pin counts; PATCH /:id { is_admin } promotes or demotes;
// DELETE /:id removes the user with everything they own; POST /:id/reset hands over a reset link
// (auth.ts). The last admin can't be demoted or deleted, and nobody deletes themselves. Demoting
// or deleting ends the user's sessions and revokes their tokens on the spot.
export interface UserRoutesDeps {
  auth: Auth;
  deletePinRows: (ids: number[]) => { changes: number; shas: string[] };
  removeUnused: (shas: Iterable<string>) => void;
}

export function createUserRoutes(db: Db, { auth, deletePinRows, removeUnused }: UserRoutesDeps) {
  const r = express.Router();

  const listUsers = db.prepare<[], Pick<UserRow, 'id' | 'email' | 'display_name' | 'is_admin' | 'created_at'> & { last_seen_at: string | null; boards: number; pins: number }>(`
    SELECT u.id, u.email, u.display_name, u.is_admin, u.created_at,
           (SELECT MAX(last_used_at) FROM sessions WHERE user_id = u.id) AS last_seen_at,
           (SELECT COUNT(*) FROM boards WHERE owner_id = u.id) AS boards,
           (SELECT COUNT(*) FROM pins p JOIN boards b ON b.id = p.board_id WHERE b.owner_id = u.id) AS pins
    FROM users u ORDER BY u.display_name COLLATE NOCASE, u.id`);
  const getUser = db.prepare<[number], Pick<UserRow, 'id' | 'email' | 'display_name' | 'is_admin'>>('SELECT id, email, display_name, is_admin FROM users WHERE id = ?');
  const adminCount = db.prepare<[], { n: number }>('SELECT COUNT(*) AS n FROM users WHERE is_admin = 1');
  const endSessions = db.prepare<[number]>('DELETE FROM sessions WHERE user_id = ?');
  const userJson = <T extends { is_admin: number }>(u: T): Omit<T, 'is_admin'> & { is_admin: boolean } => ({ ...u, is_admin: !!u.is_admin });

  const findUser = (id: number | null) => {
    const user = id && getUser.get(id);
    if (!user) throw new ImageError(404, 'user not found');
    return user;
  };
  const lastAdmin = (user: { is_admin: number }) => !!user.is_admin && adminCount.get()!.n <= 1;

  r.get('/', (req, res) => res.json(listUsers.all().map(userJson)));

  const setAdmin = db.transaction((id: number | null, isAdmin: boolean) => {
    const user = findUser(id);
    if (!isAdmin && lastAdmin(user)) throw new ImageError(409, 'The last admin can’t be demoted.');
    db.prepare('UPDATE users SET is_admin = ? WHERE id = ?').run(isAdmin ? 1 : 0, id);
    if (!isAdmin && user.is_admin) endSessions.run(user.id);
    return getUser.get(user.id)!;
  });

  r.patch('/:id', (req, res) => {
    if (typeof req.body?.is_admin !== 'boolean') throw new ImageError(400, 'is_admin must be true or false');
    res.json(userJson(setAdmin(toId(req.params.id), req.body.is_admin)));
  });

  // Pins first, then boards, then the user — whose sessions, tokens and emailed links (including
  // invites they sent) cascade. Returns the pins' hashes: their files go after the commit, through
  // the refcount, so a file another user's pin shares stays.
  const deleteUser = db.transaction((id: number | null, callerId: number) => {
    const user = findUser(id);
    if (user.id === callerId) throw new ImageError(409, 'You can’t delete yourself — ask another admin.');
    if (lastAdmin(user)) throw new ImageError(409, 'The last admin can’t be deleted.');
    const boardPins = db.prepare<[number], { id: number }>('SELECT id FROM pins WHERE board_id = ?');
    const deleteBoard = db.prepare<[number]>('DELETE FROM boards WHERE id = ?');
    const shas: string[] = [];
    for (const { id: boardId } of db.prepare<[number], { id: number }>('SELECT id FROM boards WHERE owner_id = ?').all(user.id)) {
      shas.push(...deletePinRows(boardPins.all(boardId).map((p) => p.id)).shas);
      deleteBoard.run(boardId);
    }
    db.prepare('DELETE FROM users WHERE id = ?').run(user.id);
    return shas;
  });

  r.delete('/:id', (req, res) => {
    removeUnused(deleteUser(toId(req.params.id), req.user.id));
    res.json({ ok: true });
  });

  r.post('/:id/reset', auth.adminResetLink);

  return r;
}
