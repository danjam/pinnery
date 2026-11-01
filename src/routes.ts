import path from 'node:path';
import express from 'express';
import type { Request } from 'express';
import { createAccess } from './access.ts';
import type { AccessBoard, BoardRole } from './access.ts';
import { linkBase } from './auth.ts';
import type { Db, PinRow } from './db.ts';
import { fetchImage, MAX_BYTES } from './fetch.ts';
import { ImageError, THUMB_SIZES, isSha } from './images.ts';
import type { Fingerprint, Store } from './images.ts';
import { message } from './mail.ts';
import type { Mailer } from './mail.ts';
import { publicDir } from './paths.ts';
import { createPending } from './pending.ts';
import type { PinMeta } from './pending.ts';
import { createTransferRoutes } from './transfer.ts';

const toId = (v: unknown) => {
  const n = Number(v);
  return Number.isInteger(n) && n > 0 ? n : null;
};
const bad = (msg: string) => new ImageError(400, msg);
const notFound = (what: string) => new ImageError(404, `${what} not found`);

const PIN_COLS = 'id, board_id, sha256, width, height, mime, animated, source_url, page_title, created_at';

const PICK_TOKEN_RE = /^[0-9a-f]{32}$/;

// Bulk delete/move: an explicit cap, well under SQLite's bound-variable limit (the ids go into IN (…)).
const MAX_BULK_IDS = 1000;

// A request under /pick/:token/…, where the token comes from the mount path.
type PickRequest = Request<{ token: string }>;

// A query-string value, when it's a single string.
const queryText = (req: Request, k: string) => {
  const v = req.query[k];
  return typeof v === 'string' ? v : null;
};

// A board with the counts and cover the lists need (see boardsSql).
interface BoardListRow {
  id: number;
  name: string;
  created_at: string;
  cover_pin_id: number | null;
  role: BoardRole;
  owner_name: string | null;
  pin_count: number;
  last_pin_at: string | null;
  // The shown cover (the chosen one, else the newest pin), null for an empty board.
  cover_sha256: string | null;
  cover_width: number | null;
  cover_height: number | null;
}

type ShareRole = 'viewer' | 'editor';
interface ShareRow {
  user_id: number;
  display_name: string;
  email: string;
  role: ShareRole;
  created_at: string;
}
interface Person {
  id: number;
  display_name: string;
  email: string;
}

export interface RoutesDeps {
  dataDir: string;
  mailer?: Mailer;
  publicUrl?: string;
}

export type Routes = ReturnType<typeof createRoutes>;

// The JSON API (behind the bearer/cookie auth) and the pick router (authenticated by a pick
// token alone — see createPickRoutes below) share the pending store and the board/pin helpers, so
// one factory builds both. Everything is scoped to a user (req.user, or the pick's creator) through
// access.ts: another user's ids are simply not found.
export function createRoutes(db: Db, store: Store, { dataDir, mailer, publicUrl = '' }: RoutesDeps) {
  const api = express.Router();
  api.use(express.json({ limit: '64kb' }));
  const access = createAccess(db);

  // ---- boards -------------------------------------------------------------------------------

  // ?sort=recent orders by latest activity (last pin, else creation) — what the extension's picker wants.
  const boardsSql = (rule: string) => `
    SELECT b.id, b.name, b.created_at, b.cover_pin_id, ${access.ROLE},
           (SELECT COUNT(*) FROM pins WHERE board_id = b.id) AS pin_count,
           (SELECT MAX(created_at) FROM pins WHERE board_id = b.id) AS last_pin_at,
           c.sha256 AS cover_sha256, c.width AS cover_width, c.height AS cover_height
    FROM boards b
    LEFT JOIN pins c ON c.id = COALESCE(b.cover_pin_id, (SELECT id FROM pins WHERE board_id = b.id ORDER BY id DESC LIMIT 1))
    WHERE ${rule}`;
  const RECENT = 'ORDER BY COALESCE(last_pin_at, b.created_at) DESC, b.id DESC';
  const listBoards = db.prepare<{ user: number }, BoardListRow>(`${boardsSql(access.SEES)} ORDER BY b.name COLLATE NOCASE`);
  const listBoardsRecent = db.prepare<{ user: number }, BoardListRow>(`${boardsSql(access.SEES)} ${RECENT}`);
  const boardRow = db.prepare<{ user: number; id: number | bigint }, BoardListRow>(`${boardsSql(access.SEES)} AND b.id = @id`);
  const getPin = db.prepare<[number | bigint], PinRow>(`SELECT ${PIN_COLS} FROM pins WHERE id = ?`);
  const insertBoard = db.prepare<[string, number]>('INSERT INTO boards (name, owner_id) VALUES (?, ?)');
  // role is the caller's standing (owner | editor | viewer); owner_name goes with it for "shared by".
  const boardPublic = ({ id, name, cover_pin_id, created_at, role, owner_name }: AccessBoard) => ({ id, name, cover_pin_id, created_at, role, owner_name });

  // A board the caller has just created or checked is there to read back.
  const readBoard = (user: number, id: number | bigint) => boardRow.get({ user, id })!;

  function boardJson(row: BoardListRow) {
    return {
      id: row.id,
      name: row.name,
      created_at: row.created_at,
      pin_count: row.pin_count,
      last_pin_at: row.last_pin_at,
      cover_pin_id: row.cover_pin_id,
      cover: row.cover_sha256 ? { sha256: row.cover_sha256, width: row.cover_width, height: row.cover_height } : null,
      role: row.role,
      owner_name: row.owner_name,
    };
  }

  function cleanName(v: unknown): string {
    const name = typeof v === 'string' ? v.trim() : '';
    if (!name) throw bad('name is required');
    if (name.length > 100) throw bad('name is too long');
    return name;
  }

  api.get('/boards', (req, res) => {
    res.json((req.query.sort === 'recent' ? listBoardsRecent : listBoards).all({ user: req.user.id }).map(boardJson));
  });

  api.post('/boards', (req, res) => {
    const name = cleanName(req.body?.name);
    const { lastInsertRowid } = insertBoard.run(name, req.user.id);
    res.status(201).json(boardJson(readBoard(req.user.id, lastInsertRowid)));
  });

  const renameBoard = db.prepare<[string, number]>('UPDATE boards SET name = ? WHERE id = ?');
  const setCover = db.prepare<[number | null, number]>('UPDATE boards SET cover_pin_id = ? WHERE id = ?');

  // Rename and cover are the owner's.
  api.patch('/boards/:id', (req, res) => {
    const id = toId(req.params.id);
    const board = id && access.ownsBoard(req.user.id, id);
    if (!board) throw notFound('board');
    const body = req.body || {};
    // Check both fields before saving either, so a rejected request changes nothing.
    const name = 'name' in body ? cleanName(body.name) : undefined;
    let coverId: number | null | undefined;
    if ('cover_pin_id' in body) {
      coverId = null;
      if (body.cover_pin_id !== null) {
        coverId = toId(body.cover_pin_id);
        const pin = coverId && getPin.get(coverId);
        if (!pin || pin.board_id !== board.id) throw bad('cover pin must belong to this board');
      }
    }
    if (name !== undefined) renameBoard.run(name, board.id);
    if (coverId !== undefined) setCover.run(coverId, board.id);
    res.json(boardJson(readBoard(req.user.id, board.id)));
  });

  // Delete a board. Body: { move_to: <board id> } re-homes its pins; otherwise they're deleted.
  // Returns the deleted pins' hashes, for removeUnused.
  const rehomePins = db.prepare<[number, number]>('UPDATE pins SET board_id = ? WHERE board_id = ?');
  const boardPinIds = db.prepare<[number], { id: number }>('SELECT id FROM pins WHERE board_id = ?');
  const deleteBoardRow = db.prepare<[number]>('DELETE FROM boards WHERE id = ?');
  const deleteBoard = db.transaction((id: number, moveTo: number | null) => {
    let shas: string[] = [];
    if (moveTo) {
      rehomePins.run(moveTo, id);
    } else {
      ({ shas } = deletePinRows(boardPinIds.all(id).map((r) => r.id)));
    }
    deleteBoardRow.run(id);
    return shas;
  });

  api.delete('/boards/:id', (req, res) => {
    const id = toId(req.params.id);
    if (!id || !access.ownsBoard(req.user.id, id)) throw notFound('board');
    let moveTo: number | null = null;
    if (req.body?.move_to != null) {
      moveTo = toId(req.body.move_to);
      if (!moveTo || moveTo === id || !access.canEditBoard(req.user.id, moveTo)) throw bad('invalid destination board');
    }
    removeUnused(deleteBoard(id, moveTo));
    res.json({ ok: true });
  });

  const boardPins = (order: 'ASC' | 'DESC') => db.prepare<[number], PinRow>(`SELECT ${PIN_COLS} FROM pins WHERE board_id = ? ORDER BY id ${order}`);
  const boardPinsAsc = boardPins('ASC');
  const boardPinsDesc = boardPins('DESC');
  api.get('/boards/:id/pins', (req, res) => {
    const id = toId(req.params.id);
    const board = id && access.canSeeBoard(req.user.id, id);
    if (!board) throw notFound('board');
    const pins = (req.query.order === 'asc' ? boardPinsAsc : boardPinsDesc).all(board.id);
    res.json({ board: boardPublic(board), pins });
  });

  // ---- sharing (the owner's) ----------------------------------------------------------------
  // A share is one row per (board, user) with a role; PUT adds or changes it, DELETE removes it.
  // Someone newly given a board hears about it by email when mail is on — quietly: a failed send
  // is logged by mail.ts and never fails the share.

  const listShares = db.prepare<[number], ShareRow>(`
    SELECT s.user_id, u.display_name, u.email, s.role, s.created_at
    FROM board_shares s JOIN users u ON u.id = s.user_id WHERE s.board_id = ? ORDER BY u.display_name COLLATE NOCASE, u.id`);
  const getShare = db.prepare<[number, number], { user_id: number; role: ShareRole }>('SELECT user_id, role FROM board_shares WHERE board_id = ? AND user_id = ?');
  const putShare = db.prepare<[number, number, ShareRole]>(`
    INSERT INTO board_shares (board_id, user_id, role) VALUES (?, ?, ?)
    ON CONFLICT(board_id, user_id) DO UPDATE SET role = excluded.role`);
  const dropShare = db.prepare<[number, number]>('DELETE FROM board_shares WHERE board_id = ? AND user_id = ?');
  const getUser = db.prepare<[number], Person>('SELECT id, display_name, email FROM users WHERE id = ?');
  // Everyone else, for the share picker: the least that tells people apart ("Name · email").
  const directory = db.prepare<[number], Person>('SELECT id, display_name, email FROM users WHERE id != ? ORDER BY display_name COLLATE NOCASE, id');

  const ownedBoard = (req: Request) => {
    const id = toId(req.params.id);
    const board = id && access.ownsBoard(req.user.id, id);
    if (!board) throw notFound('board');
    return board;
  };

  // Other people's emails reach non-admins masked (d***@example.com) everywhere here (directory,
  // share list, share reply): enough to tell apart two people with the same name, without giving
  // out their addresses. Admins see them in full anyway (Settings → Users).
  const maskEmail = (email: string) => {
    const at = email.lastIndexOf('@');
    return at > 0 ? `${email[0]}***${email.slice(at)}` : '***';
  };
  const emailsFor = <T extends { email: string }>(req: Request, rows: T[]): T[] =>
    req.user.is_admin ? rows : rows.map((r) => ({ ...r, email: maskEmail(r.email) }));

  api.get('/users/directory', (req, res) => res.json(emailsFor(req, directory.all(req.user.id))));

  api.get('/boards/:id/shares', (req, res) => res.json(emailsFor(req, listShares.all(ownedBoard(req).id))));

  // Body: { role: 'viewer' | 'editor' }. Answers with the share row; `added` says whether it's new.
  api.put('/boards/:id/shares/:userId', (req, res) => {
    const board = ownedBoard(req);
    const role: unknown = req.body?.role;
    if (role !== 'viewer' && role !== 'editor') throw bad('role must be viewer or editor');
    const userId = toId(req.params.userId);
    const user = userId && getUser.get(userId);
    if (!user) throw notFound('user');
    if (user.id === req.user.id) throw bad('that’s your own board');
    const added = !getShare.get(board.id, user.id);
    putShare.run(board.id, user.id, role);
    if (added && mailer?.enabled) {
      const link = `${linkBase(req, publicUrl)}/b/${board.id}`;
      mailer.send({ to: user.email, ...message({
        subject: `${req.user.display_name} shared “${board.name}” with you (${role === 'editor' ? 'Editor' : 'Viewer'})`,
        lines: [`Hi ${user.display_name},`,
          `${req.user.display_name} shared the Pinnery board “${board.name}” with you as ${role === 'editor' ? 'an editor: you can see its pins and add or delete them' : 'a viewer: you can see its pins'}.`],
        link, linkText: 'Open the board',
      }) }).catch(() => {});
    }
    res.json({ ...emailsFor(req, listShares.all(board.id)).find((s) => s.user_id === user.id), added });
  });

  api.delete('/boards/:id/shares/:userId', (req, res) => {
    const board = ownedBoard(req);
    const userId = toId(req.params.userId);
    if (!userId || !dropShare.run(board.id, userId).changes) throw notFound('share');
    res.json({ ok: true });
  });

  // ---- pins ---------------------------------------------------------------------------------

  const insertPin = db.prepare<Fingerprint & PinMeta & { board_id: number }>(`
    INSERT INTO pins (board_id, sha256, width, height, mime, animated, source_url, page_title)
    VALUES (@board_id, @sha256, @width, @height, @mime, @animated, @source_url, @page_title)`);

  function cleanText(v: unknown, max: number): string | null {
    if (v == null || v === '') return null;
    if (typeof v !== 'string') throw bad('expected a string');
    return v.slice(0, max);
  }

  // A pin's link back to its page: kept only if it's an http(s) URL, so a javascript: or data:
  // URL can never become a link.
  function cleanUrl(v: unknown): string | null {
    const s = cleanText(v, 2048);
    if (!s) return null;
    try {
      const { protocol } = new URL(s);
      return protocol === 'http:' || protocol === 'https:' ? s : null;
    } catch {
      return null;
    }
  }

  function insert(boardId: number, info: Fingerprint, { source_url, page_title }: PinMeta): PinRow {
    const { lastInsertRowid } = insertPin.run({ board_id: boardId, ...info, source_url, page_title });
    return getPin.get(lastInsertRowid)!;
  }

  // Store a fingerprinted image and insert its row (insertRow). Identical bytes share one file (see
  // images.ts), so the same image pinned twice — by anyone — is two rows and one original. The
  // original is written and the row inserted with no await between: once the row is in, the
  // refcount keeps the file, and before that no delete can run. Thumbs come after; if they fail,
  // the pin is removed again.
  async function storePin<T extends { id: number }>(buf: Buffer, info: Fingerprint, insertRow: () => T): Promise<T> {
    store.saveOriginal(buf, info);
    const row = insertRow();
    try {
      await store.saveThumbs(buf, info);
    } catch (e) {
      deletePins([row.id]);
      throw e;
    }
    return row;
  }

  // Fingerprint, store and insert.
  async function savePin(userId: number, boardId: number, buf: Buffer, meta: PinMeta) {
    if (!access.canEditBoard(userId, boardId)) throw notFound('board');
    const info = await store.fingerprint(buf);
    return storePin(buf, info, () => insert(boardId, info, meta));
  }

  // Server-side fetch of an image URL. Body: { board_id, url, source_url?, page_title? }.
  api.post('/pins/url', async (req, res) => {
    const body = req.body || {};
    const boardId = toId(body.board_id);
    if (!boardId) throw bad('board_id is required');
    if (typeof body.url !== 'string' || !body.url.trim()) throw bad('url is required');
    if (!access.canEditBoard(req.user.id, boardId)) throw notFound('board');
    const url = body.url.trim();
    const pageUrl = cleanUrl(body.source_url);
    const buf = await fetchImage(url, pageUrl && pageUrl !== url ? pageUrl : undefined);
    const pin = await savePin(req.user.id, boardId, buf, { source_url: pageUrl || url, page_title: cleanText(body.page_title, 500) });
    res.status(201).json(pin);
  });

  // Raw upload: the body is the file. Query: board_id, plus either name (a file upload — used as
  // the title) or source_url and page_title (a client that fetched the bytes itself).
  api.post('/pins/upload', express.raw({ type: () => true, limit: MAX_BYTES }), async (req, res) => {
    const boardId = toId(req.query.board_id);
    if (!boardId) throw bad('board_id is required');
    if (!Buffer.isBuffer(req.body) || !req.body.length) throw bad('empty upload');
    const pin = await savePin(req.user.id, boardId, req.body, {
      source_url: cleanUrl(queryText(req, 'source_url')),
      page_title: cleanText(queryText(req, 'page_title') ?? queryText(req, 'name'), 500),
    });
    res.status(201).json(pin);
  });

  // ---- picks (the extension and the share target) -------------------------------------------
  // The client sends the image first and chooses the board afterwards, on a page the server
  // serves (/pick/:token, see createPickRoutes). Here the bytes are fingerprinted and parked
  // board-less under a token (see pending.ts). That token is the pick page's only credential, so
  // it's returned once, to the bearer that created it. The entry remembers who that was.

  const pending = createPending();

  async function createPick(buf: Buffer, meta: PinMeta, userId: number) {
    const info = await store.fingerprint(buf);
    return { token: pending.put({ buf, info, meta, userId }) };
  }

  // Raw upload: the body is the file. Query: source_url and page_title.
  api.post('/pick/upload', express.raw({ type: () => true, limit: MAX_BYTES }), async (req, res) => {
    if (!Buffer.isBuffer(req.body) || !req.body.length) throw bad('empty upload');
    res.status(201).json(await createPick(req.body, { source_url: cleanUrl(queryText(req, 'source_url')), page_title: cleanText(queryText(req, 'page_title'), 500) }, req.user.id));
  });

  // Server-side fetch. Body: { url, source_url?, page_title? }.
  api.post('/pick/url', async (req, res) => {
    const body = req.body || {};
    if (typeof body.url !== 'string' || !body.url.trim()) throw bad('url is required');
    const url = body.url.trim();
    const pageUrl = cleanUrl(body.source_url);
    const buf = await fetchImage(url, pageUrl && pageUrl !== url ? pageUrl : undefined);
    res.status(201).json(await createPick(buf, { source_url: pageUrl || url, page_title: cleanText(body.page_title, 500) }, req.user.id));
  });

  api.get('/pins/:id', (req, res) => {
    const pin = access.canSeePin(req.user.id, toId(req.params.id) ?? 0);
    if (!pin) throw notFound('pin');
    res.json(pin);
  });

  function idList(v: unknown): number[] {
    if (!Array.isArray(v) || !v.length) throw bad('ids must be a non-empty array');
    if (v.length > MAX_BULK_IDS) throw bad(`at most ${MAX_BULK_IDS} pins at a time`);
    const ids: number[] = [];
    for (const id of v.map(toId)) {
      if (id === null) throw bad('invalid pin id');
      ids.push(id);
    }
    return [...new Set(ids)];
  }

  // Delete pin rows. Call inside a transaction, then pass the returned hashes to removeUnused once
  // it has committed: files go only after the rows are gone for good, never ahead of a rollback.
  // Id lists are bound as one JSON array (json_each), so each statement is prepared once whatever the length.
  const shasOfPins = db.prepare<[string], { sha256: string }>('SELECT DISTINCT sha256 FROM pins WHERE id IN (SELECT value FROM json_each(?))');
  const deletePinIds = db.prepare<[string]>('DELETE FROM pins WHERE id IN (SELECT value FROM json_each(?))');
  function deletePinRows(ids: number[]) {
    if (!ids.length) return { changes: 0, shas: [] };
    const json = JSON.stringify(ids);
    const shas = shasOfPins.all(json).map((r) => r.sha256);
    const { changes } = deletePinIds.run(json);
    return { changes, shas };
  }

  // Remove the files of any of these hashes no pin references. No await between the commit and
  // this call: a save of the same bytes could otherwise find the file, then lose it (see storePin).
  const stillUsed = db.prepare<[string]>('SELECT 1 FROM pins WHERE sha256 = ? LIMIT 1');
  function removeUnused(shas: Iterable<string>) {
    for (const sha of shas) if (!stillUsed.get(sha)) store.removeFiles(sha);
  }

  const deletePinsTx = db.transaction(deletePinRows);
  function deletePins(ids: number[]) {
    const { changes, shas } = deletePinsTx(ids);
    removeUnused(shas);
    return changes;
  }

  // Move pins; a board whose cover moves away falls back to its newest pin.
  const clearCovers = db.prepare<[string]>('UPDATE boards SET cover_pin_id = NULL WHERE cover_pin_id IN (SELECT value FROM json_each(?))');
  const movePinIds = db.prepare<[number, string]>('UPDATE pins SET board_id = ? WHERE id IN (SELECT value FROM json_each(?))');
  const movePins = db.transaction((ids: number[], boardId: number) => {
    const json = JSON.stringify(ids);
    clearCovers.run(json);
    return movePinIds.run(boardId, json).changes;
  });

  api.delete('/pins/:id', (req, res) => {
    const id = toId(req.params.id);
    if (!id || !access.canEditPins(req.user.id, [id])) throw notFound('pin');
    deletePins([id]);
    res.json({ ok: true });
  });

  // Bulk operations are all or nothing: one pin that isn't the user's and the whole list is "not found".
  api.post('/pins/delete', (req, res) => {
    const ids = idList(req.body?.ids);
    if (!access.canEditPins(req.user.id, ids)) throw notFound('pin');
    res.json({ deleted: deletePins(ids) });
  });

  // Moving pins out of a board is the owner's call; into one, an editor's.
  api.post('/pins/move', (req, res) => {
    const ids = idList(req.body?.ids);
    if (!access.ownsPins(req.user.id, ids)) throw notFound('pin');
    const boardId = toId(req.body?.board_id);
    if (!boardId || !access.canEditBoard(req.user.id, boardId)) throw bad('invalid destination board');
    res.json({ moved: movePins(ids, boardId) });
  });

  // ---- export / import (see transfer.ts) ---------------------------------------------------

  api.use(createTransferRoutes(db, store, { dataDir, access, cleanName, cleanText, cleanUrl, storePin }));

  // deletePinRows and removeUnused are for users.ts, which deletes a user's boards inside its own transaction.
  return { api, pick: createPickRoutes(), deletePinRows, removeUnused };

  // ---- /pick/:token — the board picker page and its token-scoped API ------------------------
  // No session or bearer: the pick token in the path is the credential, good for exactly one
  // parked image, acting as the user who parked it. It may list that user's boards, create one,
  // see the image, and commit or discard it. Committing or discarding consumes it. Nothing else is
  // reachable.

  function createPickRoutes() {
    const pick = express.Router();
    const page = path.join(publicDir, 'pick.html');
    // The picker offers the boards the user can pin into, most recent first.
    const pickBoards = db.prepare<{ user: number }, BoardListRow>(`${boardsSql(access.EDITS)} ${RECENT}`);

    // Everything the page shows and does is a sub-route of the token. The page itself is served
    // for any well-formed token — an expired one gets the "expired" notice from the page's JS —
    // and the done/cancelled pages come after the token has been consumed, so they skip the check.
    pick.use('/:token', (req, res, next) => {
      if (!PICK_TOKEN_RE.test(req.params.token)) return res.status(404).type('text').send('not found');
      res.set('Cache-Control', 'no-store');
      res.set('Referrer-Policy', 'no-referrer');
      next();
    });
    pick.get(['/:token', '/:token/done', '/:token/cancelled'], (req, res) => res.sendFile(page));

    const scoped = express.Router({ mergeParams: true });
    scoped.use(express.json({ limit: '4kb' }));
    scoped.use((req: PickRequest, res, next) => {
      const entry = pending.get(req.params.token);
      if (!entry) throw new ImageError(410, 'this pick has expired — right-click the image again');
      req.pick = entry;
      next();
    });

    // owner_name only for a board shared with the user (as an editor), so the page can mark it.
    const pickBoard = (row: BoardListRow) => {
      const b = boardJson(row);
      return { id: b.id, name: b.name, pin_count: b.pin_count, cover: b.cover && { sha256: b.cover.sha256 }, owner_name: b.role === 'owner' ? null : b.owner_name };
    };
    const boards = (req: Request) => pickBoards.all({ user: req.pick.userId }).map(pickBoard);

    // The image's details and the boards, most recent first.
    scoped.get('/info', (req, res) => {
      const { info, meta, expires } = req.pick;
      res.json({
        item: { width: info.width, height: info.height, mime: info.mime, animated: info.animated, ...meta, expires_in: Math.max(0, Math.round((expires - Date.now()) / 1000)) },
        boards: boards(req),
      });
    });

    scoped.get('/boards', (req, res) => res.json(boards(req)));

    scoped.post('/boards', (req, res) => {
      const { lastInsertRowid } = insertBoard.run(cleanName(req.body?.name), req.pick.userId);
      res.status(201).json(pickBoard(readBoard(req.pick.userId, lastInsertRowid)));
    });

    // The parked image itself, as a thumbnail.
    scoped.get('/preview', async (req, res) => {
      res.type('image/webp').send(await store.makeThumb(req.pick.buf, 400));
    });

    // Thumbnails the page needs: covers of the user's boards. Nothing else.
    scoped.get('/t/:size/:sha', async (req, res) => {
      const size = Number(req.params.size);
      const { sha } = req.params;
      const file = THUMB_SIZES.includes(size) && isSha(sha) && access.canSeeCoverSha(req.pick.userId, sha) ? await store.thumb(sha, size) : null;
      if (!file) return res.sendStatus(404);
      res.set('Cache-Control', 'private, max-age=600');
      res.type('image/webp').sendFile(file);
    });

    // Body: { board_id }. Saves the image to that board and consumes the token.
    scoped.post('/commit', async (req: PickRequest, res) => {
      const boardId = toId(req.body?.board_id);
      const board = boardId && access.canEditBoard(req.pick.userId, boardId);
      if (!board) throw notFound('board');
      const { buf, info, meta } = pending.take(req.params.token)!; // the scoped middleware's pending.get just found it
      const pin = await storePin(buf, info, () => insert(board.id, info, meta));
      res.status(201).json({ pin, board: { id: board.id, name: board.name } });
    });

    scoped.post('/discard', (req: PickRequest, res) => {
      pending.drop(req.params.token);
      res.json({ ok: true });
    });

    pick.use('/:token', scoped);
    return pick;
  }
}

// Image routes: originals by hash and thumbnails by size, for a signed-in user with a pin carrying
// that hash on a board they can see. Content-addressed, so the browser may keep them for good —
// but only its own copy (private): the answer depends on who asks.
export function createImageRoutes(db: Db, store: Store) {
  const r = express.Router();
  const access = createAccess(db);
  const mimeFor = (req: Request, sha: string) => isSha(sha) && access.canSeeSha(req.user.id, sha);
  const CACHE = 'private, max-age=31536000, immutable';

  r.get('/i/:sha', (req, res) => {
    const { sha } = req.params;
    const row = mimeFor(req, sha);
    const file = row && store.original(sha);
    if (!file) return res.sendStatus(404);
    res.set('Cache-Control', CACHE);
    res.set('Content-Security-Policy', "default-src 'none'");
    res.type(row.mime).sendFile(file);
  });

  r.get('/t/:size/:sha', async (req, res) => {
    const size = Number(req.params.size);
    const { sha } = req.params;
    if (!THUMB_SIZES.includes(size) || !mimeFor(req, sha)) return res.sendStatus(404);
    const file = await store.thumb(sha, size);
    if (!file) return res.sendStatus(404);
    res.set('Cache-Control', CACHE);
    res.type('image/webp').sendFile(file);
  });

  return r;
}
