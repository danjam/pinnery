import crypto from 'node:crypto';
import type { Request, Response } from 'express';
import type { Db, UserRow } from '../db.ts';
import { message } from '../mail.ts';
import type { MailMessage, Mailer } from '../mail.ts';
import type { Core } from './core.ts';
import { HOUR_MS, hex, linkBase, sha256 } from './util.ts';
import type { LinkKind } from './util.ts';

// Emailed links (see email_tokens in db.ts): how long each kind lives.
const TTL_MS: Record<LinkKind, number> = { invite: 24 * HOUR_MS, reset: HOUR_MS, email_change: 24 * HOUR_MS };
const TOKEN_RE = /^[0-9a-f]{64}$/;

export interface LinkRow {
  id: number;
  kind: LinkKind;
  email: string;
  user_id: number;
  expires_at: string;
}

export type Links = ReturnType<typeof createLinks>;

// ---- emailed links: invites, password resets, email changes ---------------------------------
// Each is a random token in a URL; only its hash is stored (email_tokens), with a kind, the email
// it concerns, the user it belongs to and an expiry. Checking one consumes it when it's used.
export function createLinks(db: Db, { linkFailures }: Core, { mailer, publicUrl }: { mailer: Mailer; publicUrl: string }) {
  const baseUrl = (req: Request) => linkBase(req, publicUrl);
  const insertLink = db.prepare<[string, LinkKind, string, number, string]>('INSERT INTO email_tokens (token_hash, kind, email, user_id, expires_at) VALUES (?, ?, ?, ?, ?)');
  const findLink = db.prepare<[string, LinkKind], LinkRow>('SELECT id, kind, email, user_id, expires_at FROM email_tokens WHERE token_hash = ? AND kind = ?');
  const deleteLink = db.prepare<[number | bigint]>('DELETE FROM email_tokens WHERE id = ?');
  const deleteUserLinks = db.prepare<[LinkKind, number]>('DELETE FROM email_tokens WHERE kind = ? AND user_id = ?');
  // Rows a week past their expiry go; until then an expired link can still be told from a used one.
  const purgeLinks = db.prepare("DELETE FROM email_tokens WHERE expires_at < strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-7 days')");
  const live = "expires_at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now')";

  // Make a link of the given kind. Returns { id, token, expires_at }; the caller builds the URL.
  function issueLink(kind: LinkKind, email: string, userId: number) {
    purgeLinks.run();
    const token = hex(crypto.randomBytes(32));
    const expires = new Date(Date.now() + TTL_MS[kind]).toISOString();
    const { lastInsertRowid } = insertLink.run(hex(sha256(token)), kind, email, userId, expires);
    return { id: lastInsertRowid, token, expires_at: expires };
  }

  // Look a presented token up. Returns the row, or null after answering: 404 for unknown/used,
  // 410 for expired. Guesses count against the client's IP.
  function lookupLink(req: Request, res: Response, kind: LinkKind, what: string): LinkRow | null {
    const ip = req.ip;
    if (linkFailures.throttled(ip)) { res.status(429).json({ error: 'too many attempts, try again later' }); return null; }
    const token = req.params.token;
    const row = typeof token === 'string' && TOKEN_RE.test(token) ? findLink.get(hex(sha256(token)), kind) : null;
    if (!row) {
      linkFailures.record(ip);
      res.status(404).json({ error: `This ${what} link isn't valid any more — it may have been used or cancelled.` });
      return null;
    }
    if (row.expires_at <= new Date().toISOString()) {
      res.status(410).json({ error: `This ${what} link has expired.` });
      return null;
    }
    return row;
  }

  // Send in the background and log the outcome; for emails nobody is waiting on.
  const sendQuietly = (to: string, msg: Omit<MailMessage, 'to'>) => mailer.enabled && mailer.send({ to, ...msg }).catch(() => {});

  function notifyPasswordChanged(user: Pick<UserRow, 'email' | 'display_name'>, base: string) {
    sendQuietly(user.email, message({
      subject: 'Your Pinnery password was changed',
      lines: [`Hi ${user.display_name},`, 'Your Pinnery password was changed just now. Your other browsers have been signed out.'],
      link: `${base}/forgot`,
      linkText: 'Reset your password',
      closing: 'If this was you, there’s nothing to do. If it wasn’t, reset your password with the link above (it needs your email address) and tell your Pinnery admin.',
    }));
  }

  return { baseUrl, deleteLink, deleteUserLinks, live, issueLink, lookupLink, sendQuietly, notifyPasswordChanged };
}
