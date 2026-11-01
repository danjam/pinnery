import type { Request, Response } from 'express';
import type { Db } from '../db.ts';
import { errorMessage } from '../errors.ts';
import { message } from '../mail.ts';
import type { Mailer } from '../mail.ts';
import type { Core } from './core.ts';
import type { Links } from './links.ts';
import { MIN_PASSWORD, hashPassword, normaliseEmail, validEmail } from './util.ts';

// ---- invites (admins) ----
export function createInvites(db: Db, { getUserByEmail, startSession }: Core, { baseUrl, deleteLink, live, issueLink, lookupLink }: Links, mailer: Mailer) {
  const pendingInvites = db.prepare<[], { id: number; email: string; created_at: string; expires_at: string }>(`SELECT id, email, created_at, expires_at FROM email_tokens WHERE kind = 'invite' AND ${live} ORDER BY id`);
  const pendingInviteFor = db.prepare<[string], { id: number }>(`SELECT id FROM email_tokens WHERE kind = 'invite' AND email = ? AND ${live}`);

  // POST /api/invites — body { email }. Emails the signup link when mail is on; the link is in the
  // reply either way (shown once — only its hash is kept), with `sent` and any send error.
  async function createInvite(req: Request, res: Response) {
    const email = normaliseEmail(req.body?.email);
    if (!validEmail(email)) return res.status(400).json({ error: 'enter an email address' });
    if (getUserByEmail.get(email)) return res.status(409).json({ error: 'That email already has an account.', code: 'has_account' });
    const pending = pendingInviteFor.get(email);
    if (pending) return res.status(409).json({ error: 'That email already has a pending invite.', code: 'pending_invite', invite_id: pending.id });
    const { id, token, expires_at } = issueLink('invite', email, req.user.id);
    const link = `${baseUrl(req)}/signup/${token}`;
    let sent = false, error: string | undefined;
    if (mailer.enabled) {
      try {
        await mailer.send({ to: email, ...message({
          subject: `${req.user.display_name} invited you to Pinnery`,
          lines: [`${req.user.display_name} (${req.user.email}) has invited you to Pinnery, a place to save images into boards.`, 'Choose a name and password to get started. This link works once and expires in 24 hours.'],
          link, linkText: 'Create your account',
          closing: 'If you weren’t expecting this, you can ignore it.',
        }) });
        sent = true;
      } catch (err) {
        error = errorMessage(err);
      }
    }
    res.status(201).json({ id, email, expires_at, link, sent, error });
  }

  function listInvites(req: Request, res: Response) {
    res.json(pendingInvites.all());
  }

  function cancelInvite(req: Request, res: Response) {
    const id = Number(req.params.id);
    const { changes } = Number.isInteger(id) && id > 0 ? db.prepare("DELETE FROM email_tokens WHERE id = ? AND kind = 'invite'").run(id) : { changes: 0 };
    if (!changes) return res.status(404).json({ error: 'invite not found' });
    res.json({ ok: true });
  }

  // GET /api/signup/:token — what the signup page needs: the locked email.
  function inviteInfo(req: Request, res: Response) {
    const row = lookupLink(req, res, 'invite', 'invite');
    if (row) res.json({ email: row.email });
  }

  // POST /api/signup/:token — body { display_name, password }. Creates the (non-admin) user,
  // consumes the invite and signs them in.
  function signup(req: Request, res: Response) {
    const row = lookupLink(req, res, 'invite', 'invite');
    if (!row) return;
    const name = typeof req.body?.display_name === 'string' ? req.body.display_name.trim() : '';
    if (!name || name.length > 100) return res.status(400).json({ error: 'display name must be 1–100 characters' });
    const pw = typeof req.body.password === 'string' ? req.body.password : '';
    if (pw.length < MIN_PASSWORD) return res.status(400).json({ error: `password must be at least ${MIN_PASSWORD} characters` });
    const userId = db.transaction(() => {
      if (getUserByEmail.get(row.email)) return null;
      const { lastInsertRowid } = db.prepare('INSERT INTO users (email, display_name, password_hash) VALUES (?, ?, ?)').run(row.email, name, hashPassword(pw));
      deleteLink.run(row.id);
      return lastInsertRowid;
    })();
    if (!userId) return res.status(409).json({ error: 'That email already has an account — sign in instead.' });
    startSession(res, userId);
    res.status(201).json({ ok: true });
  }

  return { createInvite, listInvites, cancelInvite, inviteInfo, signup };
}
