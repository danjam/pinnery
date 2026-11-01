import express from 'express';
import { ImageError } from './images.js';

const toId = (v) => {
  const n = Number(v);
  return Number.isInteger(n) && n > 0 ? n : null;
};

// Settings → Users: admin-only management of accounts (server.js mounts this behind requireAdmin).
// GET / lists everyone with their board and pin counts; PATCH /:id { is_admin } promotes or demotes;
// DELETE /:id removes the user with everything they own; POST /:id/reset hands over a reset link
// (auth.js). The last admin can't be demoted or deleted, and nobody deletes themselves. Demoting
// or deleting ends the user's sessions and revokes their tokens on the spot.
export function createUserRoutes(db, { auth, deletePinRows }) {
  const r = express.Router();

  const listUsers = db.prepare(`
    SELECT u.id, u.email, u.display_name, u.is_admin, u.created_at,
           (SELECT MAX(last_used_at) FROM sessions WHERE user_id = u.id) AS last_seen_at,
           (SELECT COUNT(*) FROM boards WHERE owner_id = u.id) AS boards,
           (SELECT COUNT(*) FROM pins p JOIN boards b ON b.id = p.board_id WHERE b.owner_id = u.id) AS pins
    FROM users u ORDER BY u.display_name COLLATE NOCASE, u.id`);
  const getUser = db.prepare('SELECT id, email, display_name, is_admin FROM users WHERE id = ?');
  const adminCount = db.prepare('SELECT COUNT(*) AS n FROM users WHERE is_admin = 1');
  const endSessions = db.prepare('DELETE FROM sessions WHERE user_id = ?');
  const userJson = (u) => ({ ...u, is_admin: !!u.is_admin });

  const findUser = (id) => {
    const user = id && getUser.get(id);
    if (!user) throw new ImageError(404, 'user not found');
    return user;
  };
  const lastAdmin = (user) => !!user.is_admin && adminCount.get().n <= 1;

  r.get('/', (req, res) => res.json(listUsers.all().map(userJson)));

  const setAdmin = db.transaction((id, isAdmin) => {
    const user = findUser(id);
    if (!isAdmin && lastAdmin(user)) throw new ImageError(409, 'The last admin can’t be demoted.');
    db.prepare('UPDATE users SET is_admin = ? WHERE id = ?').run(isAdmin ? 1 : 0, id);
    if (!isAdmin && user.is_admin) endSessions.run(id);
    return getUser.get(id);
  });

  r.patch('/:id', (req, res) => {
    if (typeof req.body?.is_admin !== 'boolean') throw new ImageError(400, 'is_admin must be true or false');
    res.json(userJson(setAdmin(toId(req.params.id), req.body.is_admin)));
  });

  // Pins first (through the refcount, so a file another user's pin shares stays), then boards, then
  // the user — whose sessions, tokens and emailed links (including invites they sent) cascade.
  const deleteUser = db.transaction((id, callerId) => {
    const user = findUser(id);
    if (user.id === callerId) throw new ImageError(409, 'You can’t delete yourself — ask another admin.');
    if (lastAdmin(user)) throw new ImageError(409, 'The last admin can’t be deleted.');
    const boardPins = db.prepare('SELECT id FROM pins WHERE board_id = ?');
    const deleteBoard = db.prepare('DELETE FROM boards WHERE id = ?');
    for (const { id: boardId } of db.prepare('SELECT id FROM boards WHERE owner_id = ?').all(id)) {
      deletePinRows(boardPins.all(boardId).map((p) => p.id));
      deleteBoard.run(boardId);
    }
    db.prepare('DELETE FROM users WHERE id = ?').run(id);
  });

  r.delete('/:id', (req, res) => {
    deleteUser(toId(req.params.id), req.user.id);
    res.json({ ok: true });
  });

  r.post('/:id/reset', auth.adminResetLink);

  return r;
}
