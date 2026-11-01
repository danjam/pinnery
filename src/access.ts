// Who may see and change what. Every board, pin and image lookup that answers a request goes
// through here, so the rule lives in one place. A board is the owner's; sharing it (board_shares)
// lets a viewer see it, its pins and their images, and an editor also add pins to it and delete
// pins in it. Renaming, deleting, the cover, sharing, export and moving pins out stay the owner's.
// Unknown ids and other people's ids look the same to a caller: null.

import type { BoardRow, Db, PinRow } from './db.ts';

// A board as access hands it out: the user's standing on it and whose it is, for the UI.
export type BoardRole = 'owner' | 'editor' | 'viewer';
export interface AccessBoard extends BoardRow {
  role: BoardRole;
  owner_name: string | null;
}

export type Access = ReturnType<typeof createAccess>;

export function createAccess(db: Db) {
  // Fragments over `boards b`, the user bound as @user. Parenthesised: callers append them with AND.
  const OWNS = '(b.owner_id = @user)';
  const shared = (extra = '') => `EXISTS (SELECT 1 FROM board_shares s WHERE s.board_id = b.id AND s.user_id = @user${extra})`;
  const SEES = `(${OWNS} OR ${shared()})`;
  const EDITS = `(${OWNS} OR ${shared(" AND s.role = 'editor'")})`;
  // The user's standing on the board — owner | editor | viewer — and whose board it is, for the UI.
  const ROLE = `CASE WHEN b.owner_id = @user THEN 'owner' ELSE (SELECT role FROM board_shares WHERE board_id = b.id AND user_id = @user) END AS role,
    (SELECT display_name FROM users WHERE id = b.owner_id) AS owner_name`;

  const BOARD = `b.id, b.name, b.owner_id, b.cover_pin_id, b.created_at, ${ROLE}`;
  const PIN = 'p.id, p.board_id, p.sha256, p.width, p.height, p.mime, p.animated, p.source_url, p.page_title, p.created_at';

  type ByUser = { user: number; id: number };
  const boardWhere = (rule: string) => db.prepare<ByUser, AccessBoard>(`SELECT ${BOARD} FROM boards b WHERE b.id = @id AND ${rule}`);
  const seeBoard = boardWhere(SEES);
  const editBoard = boardWhere(EDITS);
  const ownBoard = boardWhere(OWNS);

  const seePin = db.prepare<ByUser, PinRow>(`SELECT ${PIN} FROM pins p JOIN boards b ON b.id = p.board_id WHERE p.id = @id AND ${SEES}`);
  // How many of a list of pins sit on boards matching the rule — a bulk caller wants all of them.
  // (COUNT without GROUP BY always yields a row.)
  // The ids are bound as one JSON array, so each rule's statement is prepared once.
  const pinsMatching = (rule: string) => {
    const stmt = db.prepare<{ ids: string; user: number }, { n: number }>(
      `SELECT COUNT(*) AS n FROM pins p JOIN boards b ON b.id = p.board_id WHERE p.id IN (SELECT value FROM json_each(@ids)) AND ${rule}`,
    );
    return (userId: number, ids: number[]) => stmt.get({ ids: JSON.stringify(ids), user: userId })!.n;
  };
  const editablePins = pinsMatching(EDITS);
  const ownedPins = pinsMatching(OWNS);

  // An image is visible when some pin on a visible board carries its hash.
  const seeSha = db.prepare<{ sha: string; user: number }, { mime: string }>(`SELECT p.mime FROM pins p JOIN boards b ON b.id = p.board_id WHERE p.sha256 = @sha AND ${SEES} LIMIT 1`);
  // A cover (chosen, else newest pin) of a visible board — all the pick page may show.
  const seeCoverSha = db.prepare<{ sha: string; user: number }>(`
    SELECT 1 FROM boards b
    JOIN pins p ON p.id = COALESCE(b.cover_pin_id, (SELECT id FROM pins WHERE board_id = b.id ORDER BY id DESC LIMIT 1))
    WHERE p.sha256 = @sha AND ${SEES} LIMIT 1`);

  return {
    SEES,
    EDITS,
    OWNS,
    ROLE,
    canSeeBoard: (userId: number, boardId: number) => seeBoard.get({ user: userId, id: boardId }) ?? null,
    canEditBoard: (userId: number, boardId: number) => editBoard.get({ user: userId, id: boardId }) ?? null,
    ownsBoard: (userId: number, boardId: number) => ownBoard.get({ user: userId, id: boardId }) ?? null,
    canSeePin: (userId: number, pinId: number) => seePin.get({ user: userId, id: pinId }) ?? null,
    // True when every id is a pin on a board the user may edit (delete from) or owns (move out of).
    canEditPins: (userId: number, ids: number[]) => editablePins(userId, ids) === ids.length,
    ownsPins: (userId: number, ids: number[]) => ownedPins(userId, ids) === ids.length,
    canSeeSha: (userId: number, sha: string) => seeSha.get({ user: userId, sha }) ?? null,
    canSeeCoverSha: (userId: number, sha: string) => !!seeCoverSha.get({ user: userId, sha }),
  };
}
