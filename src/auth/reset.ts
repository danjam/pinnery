import type { Request, Response } from 'express';
import type { Db, UserRow } from '../db.ts';
import { errorMessage } from '../errors.ts';
import { message } from '../mail.ts';
import type { Mailer } from '../mail.ts';
import type { Core } from './core.ts';
import type { Links } from './links.ts';
import { MIN_PASSWORD, normaliseEmail, validEmail } from './util.ts';

// ---- forgotten password ----
export function createReset(db: Db, core: Core, links: Links, { mailer, publicUrl }: { mailer: Mailer; publicUrl: string }) {
  const { getUser, getUserByEmail, forgotByIp, forgotByEmail, startSession, setPassword } = core;
  const { baseUrl, deleteUserLinks, issueLink, lookupLink, sendQuietly, notifyPasswordChanged } = links;

  // Make a reset link for a user, cancelling their older ones. For the forgot flow here and for an
  // admin handing one over by hand. Returns { link, expires_at }.
  function createResetLink(userId: number, base: string) {
    const user = getUser.get(userId);
    if (!user) throw new Error('no such user');
    deleteUserLinks.run('reset', userId);
    const { token, expires_at } = issueLink('reset', user.email, userId);
    return { link: `${base}/reset/${token}`, expires_at };
  }

  const resetMessage = (user: Pick<UserRow, 'display_name'>, link: string) => message({
    subject: 'Reset your Pinnery password',
    lines: [`Hi ${user.display_name},`, 'Someone asked to reset the password for this Pinnery account. The link works once and expires in an hour.'],
    link, linkText: 'Choose a new password',
    closing: 'If this wasn’t you, ignore this email — your password hasn’t changed.',
  });

  // POST /api/users/:id/reset (admins, see users.ts) — a reset link for that user, emailed when
  // mail is on and returned either way, like an invite: { email, link, expires_at, sent, error }.
  async function adminResetLink(req: Request, res: Response) {
    const id = Number(req.params.id);
    const user = Number.isInteger(id) && id > 0 ? getUser.get(id) : null;
    if (!user) return res.status(404).json({ error: 'user not found' });
    const { link, expires_at } = createResetLink(user.id, baseUrl(req));
    let sent = false, error: string | undefined;
    if (mailer.enabled) {
      try {
        await mailer.send({ to: user.email, ...resetMessage(user, link) });
        sent = true;
      } catch (err) {
        error = errorMessage(err);
      }
    }
    res.status(201).json({ email: user.email, link, expires_at, sent, error });
  }

  // Self-service password reset by email needs PINNERY_PUBLIC_URL as well as mail: the request comes
  // from someone not signed in, and without a fixed base the link would be built from their Host
  // header, so an attacker could have a real reset email point at their own site. Admins can still
  // hand out reset links (Settings → Users).
  const selfReset = mailer.enabled && !!publicUrl;

  // GET /api/mail — whether email is set up, and whether "forgot password" can email a link (the
  // forgot page and Settings adapt). Public.
  const mailStatus = (req: Request, res: Response) => res.json({ enabled: mailer.enabled, reset: selfReset });

  // POST /api/forgot — body { email }. The reply is the same whether or not the account exists, and
  // the email goes out in the background so the timing is too. Per-IP limit answers 429 before
  // any lookup; past the per-address limit the request is just dropped, with the same reply.
  function forgot(req: Request, res: Response) {
    const ip = req.ip;
    if (forgotByIp.throttled(ip)) return res.status(429).json({ error: 'too many requests, try again later' });
    const email = normaliseEmail(req.body?.email);
    if (!validEmail(email)) return res.status(400).json({ error: 'enter an email address' });
    forgotByIp.record(ip);
    const reply = () => res.json({ ok: true, mail: selfReset });
    if (!selfReset || forgotByEmail.throttled(email)) return reply();
    forgotByEmail.record(email);
    const user = getUserByEmail.get(email);
    if (user) {
      const { link } = createResetLink(user.id, baseUrl(req)); // PINNERY_PUBLIC_URL, see selfReset
      sendQuietly(user.email, resetMessage(user, link));
    }
    reply();
  }

  // GET /api/reset/:token — is the link still good? POST — body { password }: sets it, signs the
  // user's other browsers out, signs this one in, and says how many extension tokens they have so
  // the page can offer to revoke those too (DELETE /api/tokens, now that they're signed in).
  function resetInfo(req: Request, res: Response) {
    const row = lookupLink(req, res, 'reset', 'reset');
    if (row) res.json({ email: row.email });
  }

  async function reset(req: Request, res: Response) {
    const row = lookupLink(req, res, 'reset', 'reset');
    if (!row) return;
    const pw = typeof req.body?.password === 'string' ? req.body.password : '';
    if (pw.length < MIN_PASSWORD) return res.status(400).json({ error: `password must be at least ${MIN_PASSWORD} characters` });
    const user = getUser.get(row.user_id);
    if (!user) return res.status(404).json({ error: 'This reset link isn’t valid any more.' });
    await setPassword(user.id, pw, null);
    startSession(res, user.id);
    notifyPasswordChanged(user, baseUrl(req));
    const { n } = db.prepare<[number], { n: number }>("SELECT COUNT(*) AS n FROM sessions WHERE kind = 'token' AND user_id = ?").get(user.id)!;
    res.json({ ok: true, tokens: n });
  }

  return { mailStatus, forgot, resetInfo, reset, createResetLink, adminResetLink };
}
