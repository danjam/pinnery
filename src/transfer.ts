import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import express from 'express';
import type { Request } from 'express';
import type { Access } from './access.ts';
import type { BoardRow, Db, PinRow } from './db.ts';
import { errorMessage } from './errors.ts';
import { MAX_BYTES } from './fetch.ts';
import { ImageError, isSha } from './images.ts';
import type { Fingerprint, Store } from './images.ts';
import { createZipWriter, openZipFile, isSafeZipPath, ZipError } from './zip.ts';
import type { ZipEntry, ZipFile } from './zip.ts';

// Export and import: a zip with a folder per board holding each pin's original file, plus a
// top-level pins.json — { version: 1, exported_at, boards: [{ name, cover_sha256, pins: [...] }] }.
// Boards are matched by name on import, so the folder names are only for people browsing the zip.

const FORMAT_VERSION = 1;
// The archive is spooled to disk, not memory. Exports past 4 GiB are zip64, so imports go beyond it too.
const IMPORT_MAX_BYTES = 16 * 1024 ** 3;
const MANIFEST_MAX_BYTES = 32 * 1024 * 1024;

const EXT: Record<string, string> = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/gif': 'gif', 'image/avif': 'avif' };
const bad = (msg: string) => new ImageError(400, msg);

// A file-system-friendly folder name for a board, unique within `taken`.
function folderName(name: string, taken: Set<string>) {
  let base = name.replace(/[\\/:*?"<>|\x00-\x1f]/g, '_').replace(/^[\s.]+|[\s.]+$/g, '').slice(0, 80) || 'board';
  let candidate = base;
  for (let n = 2; taken.has(candidate.toLowerCase()); n++) candidate = `${base} (${n})`;
  taken.add(candidate.toLowerCase());
  return candidate;
}

// RFC 6266: an ASCII fallback plus the UTF-8 form.
function attachment(filename: string) {
  const ascii = filename.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(filename)}`;
}

// Both directions work on the user's own boards (access.OWNS): exports hold what's theirs, imports
// land in their account and merge by name among their boards only.
export interface TransferDeps {
  dataDir: string;
  access: Access;
  cleanName: (v: unknown) => string;
  cleanText: (v: unknown, max: number) => string | null;
}

type BoardStub = Pick<BoardRow, 'id' | 'name' | 'cover_pin_id'>;
type ExportedPin = Pick<PinRow, 'sha256' | 'source_url' | 'page_title' | 'created_at' | 'width' | 'height' | 'mime'> & { file: string };

// pins.json as it arrives: untrusted, so every field is unknown until readManifest has checked it.
interface RawPin { file?: unknown; source_url?: unknown; page_title?: unknown; created_at?: unknown }
interface RawBoard { name?: unknown; cover_sha256?: unknown; pins?: unknown }
interface RawManifest { version?: unknown; boards?: unknown }

interface ImportPin {
  entry: ZipEntry;
  source_url: string | null;
  page_title: string | null;
  created_at: string | null;
}
interface ImportBoard {
  name: string;
  cover_sha256: string | null;
  pins: ImportPin[];
}

export function createTransferRoutes(db: Db, store: Store, { dataDir, access, cleanName, cleanText }: TransferDeps) {
  const r = express.Router();

  const allBoards = db.prepare<{ user: number }, BoardStub>(`SELECT b.id, b.name, b.cover_pin_id FROM boards b WHERE ${access.OWNS} ORDER BY b.name COLLATE NOCASE, b.id`);
  const boardPins = db.prepare<[number], Omit<ExportedPin, 'file'> & { id: number }>('SELECT id, sha256, source_url, page_title, created_at, width, height, mime FROM pins WHERE board_id = ? ORDER BY id');
  const boardByName = db.prepare<{ name: string; user: number }, BoardStub>(`SELECT b.id, b.name, b.cover_pin_id FROM boards b WHERE b.name = @name AND ${access.OWNS} ORDER BY b.id LIMIT 1`);
  const insertBoard = db.prepare<[string, number]>('INSERT INTO boards (name, owner_id) VALUES (?, ?)');
  const hasSha = db.prepare<[number, string]>('SELECT 1 FROM pins WHERE board_id = ? AND sha256 = ? LIMIT 1');
  const pinBySha = db.prepare<[number, string], { id: number }>('SELECT id FROM pins WHERE board_id = ? AND sha256 = ? ORDER BY id LIMIT 1');
  const setCover = db.prepare<[number, number]>('UPDATE boards SET cover_pin_id = ? WHERE id = ?');
  const anyPin = db.prepare<[number]>('SELECT 1 FROM pins WHERE board_id = ? LIMIT 1');
  const deleteBoard = db.prepare<[number]>('DELETE FROM boards WHERE id = ?');
  const insertPin = db.prepare<Pick<PinRow, 'board_id' | 'sha256' | 'width' | 'height' | 'mime' | 'animated' | 'source_url' | 'page_title' | 'created_at'>>(`
    INSERT INTO pins (board_id, sha256, width, height, mime, animated, source_url, page_title, created_at)
    VALUES (@board_id, @sha256, @width, @height, @mime, @animated, @source_url, @page_title, @created_at)`);

  // ---- export -------------------------------------------------------------------------------
  // GET /export streams every board; ?board=<id> streams one. Images are stored uncompressed
  // (they already are); pins whose original file is missing are left out.

  r.get('/export', async (req, res) => {
    let boards: BoardStub[];
    if (req.query.board !== undefined) {
      const id = Number(req.query.board);
      const board = Number.isInteger(id) && id > 0 ? access.ownsBoard(req.user.id, id) : null;
      if (!board) throw new ImageError(404, 'board not found');
      boards = [board];
    } else {
      boards = allBoards.all({ user: req.user.id });
    }

    const taken = new Set<string>();
    const files: [string, string][] = []; // [entry name, path on disk]
    const manifest = {
      version: FORMAT_VERSION,
      exported_at: new Date().toISOString(),
      boards: boards.map((board) => {
        const folder = folderName(board.name, taken);
        const seen = new Set<string>();
        const pins: ExportedPin[] = [];
        let cover_sha256: string | null = null;
        for (const pin of boardPins.all(board.id)) {
          const file = store.original(pin.sha256);
          if (!file) continue;
          const name = `${folder}/${pin.sha256}.${EXT[pin.mime] || 'bin'}`;
          if (!seen.has(pin.sha256)) { seen.add(pin.sha256); files.push([name, file]); }
          if (pin.id === board.cover_pin_id) cover_sha256 = pin.sha256;
          pins.push({
            file: name,
            sha256: pin.sha256,
            source_url: pin.source_url,
            page_title: pin.page_title,
            created_at: pin.created_at,
            width: pin.width,
            height: pin.height,
            mime: pin.mime,
          });
        }
        return { name: board.name, cover_sha256, pins };
      }),
    };

    const stamp = manifest.exported_at.slice(0, 10);
    const filename = boards.length === 1 && req.query.board !== undefined ? `pinnery-${folderName(boards[0].name, new Set())}-${stamp}.zip` : `pinnery-export-${stamp}.zip`;
    res.status(200);
    res.set('Content-Type', 'application/zip');
    res.set('Content-Disposition', attachment(filename));
    res.set('Cache-Control', 'no-store');
    res.flushHeaders();

    const zip = createZipWriter(res);
    try {
      await zip.add('pins.json', Buffer.from(JSON.stringify(manifest, null, 2)));
      for (const [name, file] of files) {
        if (res.destroyed) return;
        await zip.add(name, fs.readFileSync(file), { compress: false });
      }
      await zip.end();
      res.end();
    } catch (e) {
      // Headers are gone, so the only honest answer is to cut the connection short.
      console.error('export failed:', e);
      res.destroy(e instanceof Error ? e : new Error(errorMessage(e)));
    }
  });

  // ---- import -------------------------------------------------------------------------------
  // POST /import, body: the zip. Boards are created, or merged into an existing board of the same
  // name. Each image goes through the normal fingerprint + save path, keeping source_url,
  // page_title and created_at; a pin whose board already holds that exact file is skipped, so
  // importing the same zip twice adds nothing. Covers are restored for boards that have none.

  const tmpDir = path.join(dataDir, 'tmp');

  // Spool the request body to a temp file, refusing anything over the cap.
  async function spool(req: Request) {
    if (Number(req.headers['content-length']) > IMPORT_MAX_BYTES) throw new ImageError(413, 'upload too large');
    fs.mkdirSync(tmpDir, { recursive: true });
    const file = path.join(tmpDir, `import-${crypto.randomBytes(8).toString('hex')}.zip`);
    let total = 0;
    const counter = new Transform({
      transform(chunk, enc, cb) {
        total += chunk.length;
        cb(total > IMPORT_MAX_BYTES ? new ImageError(413, 'upload too large') : null, chunk);
      },
    });
    try {
      await pipeline(req, counter, fs.createWriteStream(file));
    } catch (e) {
      fs.rmSync(file, { force: true });
      throw e;
    }
    if (!total) { fs.rmSync(file, { force: true }); throw bad('empty upload'); }
    return file;
  }

  // pins.json, checked field by field against what's actually in the zip. Returns the boards
  // with each pin resolved to its zip entry.
  function readManifest(zip: ZipFile): ImportBoard[] {
    const byName = new Map(zip.entries.map((e) => [e.name, e]));
    const manifestEntry = byName.get('pins.json');
    if (!manifestEntry) throw bad('not a Pinnery export: pins.json is missing');
    if (manifestEntry.size > MANIFEST_MAX_BYTES) throw bad('pins.json is too large');
    let manifest: RawManifest | null;
    try {
      manifest = JSON.parse(zip.read(manifestEntry).toString('utf8'));
    } catch {
      throw bad('pins.json is not valid JSON');
    }
    if (manifest?.version !== FORMAT_VERSION || !Array.isArray(manifest.boards)) {
      throw bad(`not a Pinnery export: expected pins.json with version ${FORMAT_VERSION} and a boards array`);
    }
    const rawBoards: (RawBoard | null)[] = manifest.boards;
    return rawBoards.map((board, i) => {
      const where = `board ${i + 1}`;
      let name: string;
      try { name = cleanName(board?.name); } catch (e) { throw bad(`${where}: ${errorMessage(e)}`); }
      const rawPins: unknown = board?.pins;
      if (!Array.isArray(rawPins)) throw bad(`${where} (${name}): pins must be an array`);
      const pinList: (RawPin | null)[] = rawPins;
      const pins = pinList.map((pin, j): ImportPin => {
        if (!isSafeZipPath(pin?.file)) throw bad(`${where} (${name}), pin ${j + 1}: invalid file path`);
        const entry = byName.get(pin.file);
        if (!entry) throw bad(`${where} (${name}): ${pin.file} is missing from the zip`);
        if (entry.size > MAX_BYTES) throw new ImageError(413, `${pin.file} is too large (limit ${MAX_BYTES / 1048576} MB)`);
        const created = typeof pin.created_at === 'string' ? new Date(pin.created_at) : null;
        return {
          entry,
          source_url: cleanText(pin.source_url, 2048),
          page_title: cleanText(pin.page_title, 500),
          created_at: created && !Number.isNaN(created.getTime()) ? created.toISOString() : null,
        };
      });
      return { name, cover_sha256: isSha(board?.cover_sha256) ? board.cover_sha256 : null, pins };
    });
  }

  r.post('/import', async (req, res) => {
    const file = await spool(req);
    let zip: ZipFile | null = null;
    try {
      try {
        zip = openZipFile(file, { maxEntrySize: Math.max(MAX_BYTES, MANIFEST_MAX_BYTES) });
      } catch (e) {
        if (e instanceof ZipError) throw bad(e.message);
        throw e;
      }
      const unsafe = zip.entries.find((e) => !isSafeZipPath(e.name));
      if (unsafe) throw bad(`unsafe path in zip: ${unsafe.name}`);
      const boards = readManifest(zip);

      // Pins are saved one at a time (fingerprinting is async, so no single transaction). A bad
      // file part-way through leaves the earlier pins in place — a re-import skips them — but a
      // board this run created and never filled is removed again.
      const summary = { boards_created: 0, boards_merged: 0, pins_added: 0, pins_skipped: 0 };
      const created: number[] = [];
      try {
        for (const board of boards) {
          let row = boardByName.get({ name: board.name, user: req.user.id });
          if (row) {
            summary.boards_merged++;
          } else {
            row = access.ownsBoard(req.user.id, Number(insertBoard.run(board.name, req.user.id).lastInsertRowid))!;
            created.push(row.id);
            summary.boards_created++;
          }
          for (const pin of board.pins) {
            let buf: Buffer;
            let info: Fingerprint;
            try {
              buf = zip.read(pin.entry);
              info = await store.fingerprint(buf);
            } catch (e) {
              if (e instanceof ZipError || e instanceof ImageError) throw bad(`${pin.entry.name}: ${e.message}`);
              throw e;
            }
            if (hasSha.get(row.id, info.sha256)) { summary.pins_skipped++; continue; }
            await store.save(buf, info);
            insertPin.run({ board_id: row.id, ...info, source_url: pin.source_url, page_title: pin.page_title, created_at: pin.created_at ?? new Date().toISOString() });
            summary.pins_added++;
          }
          if (board.cover_sha256 && row.cover_pin_id == null) {
            const cover = pinBySha.get(row.id, board.cover_sha256);
            if (cover) setCover.run(cover.id, row.id);
          }
        }
      } catch (e) {
        for (const id of created) if (!anyPin.get(id)) deleteBoard.run(id);
        throw e;
      }
      res.json(summary);
    } finally {
      zip?.close();
      fs.rmSync(file, { force: true });
    }
  });

  return r;
}
