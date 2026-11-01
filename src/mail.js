import nodemailer from 'nodemailer';

// Outgoing email over SMTP, configured by PINNERY_SMTP_*. Optional: with no host, `enabled` is
// false and callers show links to copy instead. Messages are short plain text with a simple HTML
// alternative. Nothing here logs recipients' links or tokens — just subject and address.
export function createMailer(env = process.env) {
  const host = env.PINNERY_SMTP_HOST;
  const from = env.PINNERY_SMTP_FROM;
  if (!host || !from) {
    if (host || from) console.warn('mail: PINNERY_SMTP_HOST and PINNERY_SMTP_FROM are both needed — email is off');
    return { enabled: false, send: async () => { throw new Error('email is not set up'); } };
  }
  const secure = env.PINNERY_SMTP_SECURE ? env.PINNERY_SMTP_SECURE === 'true' : env.PINNERY_SMTP_PORT === '465';
  const port = Number(env.PINNERY_SMTP_PORT) || (secure ? 465 : 587);
  const transport = nodemailer.createTransport({
    host,
    port,
    secure,
    auth: env.PINNERY_SMTP_USER ? { user: env.PINNERY_SMTP_USER, pass: env.PINNERY_SMTP_PASSWORD || '' } : undefined,
    connectionTimeout: 15000,
    greetingTimeout: 15000,
    socketTimeout: 30000,
  });
  console.log(`mail: sending via ${host}:${port} as ${from}`);

  async function send({ to, subject, text, html }) {
    try {
      await transport.sendMail({ from, to, subject, text, html });
      console.log(`mail: sent "${subject}" to ${to}`);
    } catch (err) {
      console.error(`mail: failed to send "${subject}" to ${to}: ${err.message}`);
      throw new Error(`couldn't send the email: ${err.message}`);
    }
  }

  return { enabled: true, send };
}

const escapeHtml = (s) => String(s).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

// A short message: a few lines of text, optionally a link with its own label, and a closing line.
export function message({ subject, lines, link, linkText, closing }) {
  const text = [...lines, link && `${linkText}: ${link}`, closing].filter(Boolean).join('\n\n');
  const html = `<!doctype html><html><body style="font: 15px/1.5 system-ui, sans-serif; color: #1b1b1f">`
    + lines.map((l) => `<p>${escapeHtml(l)}</p>`).join('')
    + (link ? `<p><a href="${escapeHtml(link)}" style="display: inline-block; padding: 10px 18px; background: #d6336c; color: #fff; border-radius: 10px; text-decoration: none; font-weight: 600">${escapeHtml(linkText)}</a></p>`
      + `<p style="color: #6b6b75; font-size: 13px">Or paste this into your browser: ${escapeHtml(link)}</p>` : '')
    + (closing ? `<p style="color: #6b6b75">${escapeHtml(closing)}</p>` : '')
    + '</body></html>';
  return { subject, text, html };
}
