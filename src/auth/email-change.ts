import type { Request, Response } from 'express';
import type { Db } from '../db.ts';
import { errorMessage } from '../errors.ts';
import { message } from '../mail.ts';
import type { Mailer } from '../mail.ts';
import type { Core } from './core.ts';
import type { Links } from './links.ts';
import { normaliseEmail, validEmail } from './util.ts';

// ---- email change ----
export function createEmailChange(db: Db, core: Core, links: Links, mailer: Mailer) {
  const { getUser, getUserByEmail, throttled, checkPassword } = core;
  const { baseUrl, deleteLink, deleteUserLinks, issueLink, lookupLink, sendQuietly } = links;

  // POST /api/email — body { email, password }, signed in. Sends a confirmation to the new address;
  // nothing changes until it's used. Needs mail: a link to copy would go to the wrong person.
  async function requestEmailChange(req: Request, res: Response) {
    if (!mailer.enabled) return res.status(409).json({ error: 'Email isn’t set up on this Pinnery, so the address can’t be changed here.' });
    if (req.session.kind !== 'session') return res.status(403).json({ error: 'sign in to change the email' });
    const ip = req.ip;
    if (throttled(ip)) return res.status(429).json({ error: 'too many attempts, try again later' });
    const user = getUser.get(req.user.id)!;
    const given = typeof req.body?.password === 'string' ? req.body.password : '';
    if (!await checkPassword(ip, given, user.password_hash)) return res.status(403).json({ error: 'wrong password' });
    const email = normaliseEmail(req.body.email);
    if (!validEmail(email)) return res.status(400).json({ error: 'enter an email address' });
    if (email === user.email) return res.status(400).json({ error: 'that’s already your email' });
    if (getUserByEmail.get(email)) return res.status(409).json({ error: 'That email already has an account.' });
    deleteUserLinks.run('email_change', user.id);
    const { id, token } = issueLink('email_change', email, user.id);
    try {
      await mailer.send({ to: email, ...message({
        subject: 'Confirm your new Pinnery email',
        lines: [`Hi ${user.display_name},`, `You asked to change your Pinnery sign-in email from ${user.email} to ${email}. Confirm it with the link below; it works once and expires in 24 hours.`],
        link: `${baseUrl(req)}/confirm-email/${token}`, linkText: 'Confirm this email',
        closing: 'If this wasn’t you, ignore this email — nothing changes until the link is used.',
      }) });
    } catch (err) {
      deleteLink.run(id);
      return res.status(502).json({ error: `${errorMessage(err)}. The address hasn’t changed.` });
    }
    res.json({ ok: true, email });
  }

  // GET /api/confirm-email/:token — what the page shows. POST — makes the change (a GET can't,
  // since mail scanners open links).
  function confirmEmailInfo(req: Request, res: Response) {
    const row = lookupLink(req, res, 'email_change', 'confirmation');
    if (row) res.json({ email: row.email });
  }

  // Reset links went to the old address, so they're cancelled, and the old address is told: if the
  // change wasn't the owner's doing, that's the only warning they get.
  function confirmEmail(req: Request, res: Response) {
    const row = lookupLink(req, res, 'email_change', 'confirmation');
    if (!row) return;
    const old = db.transaction(() => {
      const user = getUser.get(row.user_id);
      if (!user || getUserByEmail.get(row.email)) return null;
      db.prepare('UPDATE users SET email = ? WHERE id = ?').run(row.email, row.user_id);
      deleteLink.run(row.id);
      deleteUserLinks.run('reset', row.user_id);
      return user;
    })();
    if (!old) return res.status(409).json({ error: 'That email now belongs to another account, so it can’t be used.' });
    sendQuietly(old.email, message({
      subject: 'Your Pinnery email was changed',
      lines: [`Hi ${old.display_name},`, `Your Pinnery sign-in email was changed from ${old.email} to ${row.email} just now. This address can no longer sign in or reset the password.`],
      closing: 'If this was you, there’s nothing to do. If it wasn’t, tell your Pinnery admin straight away.',
    }));
    res.json({ ok: true, email: row.email });
  }

  return { requestEmailChange, confirmEmailInfo, confirmEmail };
}
