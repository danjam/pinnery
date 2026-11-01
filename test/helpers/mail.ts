import net from 'node:net';

// A minimal SMTP sink for tests: accepts every message on 127.0.0.1 and keeps it in memory.
// It advertises no STARTTLS and no AUTH, so nodemailer talks plain SMTP.

export interface Mail {
  /** Envelope sender (MAIL FROM). */
  from: string;
  /** Envelope recipients (RCPT TO), as sent. */
  to: string[];
  /** Decoded Subject header. */
  subject: string;
  /** The whole message as received (dot-unstuffed, headers included). */
  raw: string;
  /** Decoded text/plain part: quoted-printable and base64 undone, links intact. */
  text: string;
  /** Decoded text/html part ('' if none). */
  html: string;
}

interface Envelope {
  from: string;
  to: string[];
}

interface Parsed {
  text?: string;
  html?: string;
}

// =XX escapes and "=\r\n" soft line breaks (RFC 2045), as bytes.
function decodeQp(s: string): Buffer {
  const bytes: number[] = [];
  const t = s.replace(/=\r?\n/g, '');
  for (let i = 0; i < t.length; i++) {
    if (t[i] === '=' && /^[0-9A-Fa-f]{2}$/.test(t.slice(i + 1, i + 3))) { bytes.push(parseInt(t.slice(i + 1, i + 3), 16)); i += 2; }
    else bytes.push(...Buffer.from(t[i]));
  }
  return Buffer.from(bytes);
}

const decodeBody = (body: string, encoding: string | undefined): string => {
  const enc = (encoding || '').toLowerCase();
  if (enc === 'quoted-printable') return decodeQp(body).toString('utf8');
  if (enc === 'base64') return Buffer.from(body.replace(/\s+/g, ''), 'base64').toString('utf8');
  return body;
};

// RFC 2047 encoded words (=?UTF-8?Q?...?= / =?UTF-8?B?...?=) in a header value.
const decodeWords = (v: string): string => v.replace(/=\?[^?]+\?([QqBb])\?([^?]*)\?=/g, (_: string, kind: string, data: string) => (
  kind.toLowerCase() === 'b' ? Buffer.from(data, 'base64').toString('utf8') : decodeQp(data.replace(/_/g, ' ')).toString('utf8')));

function parseHeaders(block: string): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const line of block.replace(/\r?\n[ \t]+/g, ' ').split(/\r?\n/)) {
    const i = line.indexOf(':');
    if (i > 0) headers[line.slice(0, i).trim().toLowerCase()] = line.slice(i + 1).trim();
  }
  return headers;
}

const splitMessage = (s: string): [string, string] => {
  const m = /\r?\n\r?\n/.exec(s);
  return m ? [s.slice(0, m.index), s.slice(m.index + m[0].length)] : [s, ''];
};

// Walk the MIME tree, collecting decoded text/plain and text/html bodies.
function parseEntity(raw: string, out: Parsed): Record<string, string> {
  const [head, body] = splitMessage(raw);
  const h = parseHeaders(head);
  const type = (h['content-type'] || 'text/plain').toLowerCase();
  const boundary = /boundary="?([^";]+)"?/i.exec(h['content-type'] || '')?.[1];
  if (type.startsWith('multipart/') && boundary) {
    for (const part of body.split(`--${boundary}`).slice(1)) {
      if (part.startsWith('--')) break;
      parseEntity(part.replace(/^\r?\n/, ''), out);
    }
  } else if (type.startsWith('text/plain') && out.text === undefined) {
    out.text = decodeBody(body, h['content-transfer-encoding']);
  } else if (type.startsWith('text/html') && out.html === undefined) {
    out.html = decodeBody(body, h['content-transfer-encoding']);
  }
  return h;
}

function parseMessage(env: Envelope, raw: string): Mail {
  const out: Parsed = {};
  const h = parseEntity(raw, out);
  return { from: env.from, to: env.to, subject: decodeWords(h.subject || ''), raw, text: out.text ?? '', html: out.html ?? '' };
}

const addr = (line: string): string => /<([^>]*)>/.exec(line)?.[1] ?? line.split(':').slice(1).join(':').trim();

export interface MailSink {
  port: number;
  messages: Mail[];
  waitFor: (predicate: (m: Mail) => boolean, timeoutMs?: number) => Promise<Mail>;
  clear: () => void;
  close: () => Promise<void>;
}

/**
 * Start the sink on a free 127.0.0.1 port.
 * `messages` is the live array of everything received so far. `waitFor` resolves with the first
 * message (already received or still to come) for which `predicate` is true, and rejects on timeout
 * (default 5000 ms). Mail is sent in the background by the server, so always `waitFor` rather
 * than reading `messages` straight after a request. `clear()` empties `messages`, so a later
 * `waitFor` can't match an earlier mail.
 */
export async function startMailSink(): Promise<MailSink> {
  const messages: Mail[] = [];
  const waiters = new Set<(m: Mail) => void>();
  const sockets = new Set<net.Socket>();

  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    socket.on('error', () => {});
    socket.setEncoding('utf8'); // decodes across chunks, so a multibyte character split between two stays whole
    let buf = '';
    let env: Envelope = { from: '', to: [] };
    let data: string[] | null = null; // lines of the message while in DATA
    const reply = (s: string) => socket.write(`${s}\r\n`);
    reply('220 pinnery-test-sink ESMTP');

    const finish = () => {
      const raw = data!.join('\r\n').replace(/^\./gm, ''); // dot-unstuffing
      data = null;
      const msg = parseMessage(env, raw);
      env = { from: '', to: [] };
      messages.push(msg);
      for (const w of [...waiters]) w(msg);
      reply('250 OK queued');
    };

    const onLine = (line: string): void => {
      if (data) {
        if (line === '.') return finish();
        data.push(line);
        return;
      }
      const cmd = line.slice(0, 4).toUpperCase();
      if (cmd === 'EHLO') { socket.write('250-pinnery-test-sink\r\n250 8BITMIME\r\n'); }
      else if (cmd === 'HELO') reply('250 pinnery-test-sink');
      else if (cmd === 'MAIL') { env = { from: addr(line), to: [] }; reply('250 OK'); }
      else if (cmd === 'RCPT') { env.to.push(addr(line)); reply('250 OK'); }
      else if (cmd === 'DATA') { data = []; reply('354 End data with <CR><LF>.<CR><LF>'); }
      else if (cmd === 'RSET') { env = { from: '', to: [] }; reply('250 OK'); }
      else if (cmd === 'NOOP') reply('250 OK');
      else if (cmd === 'QUIT') { reply('221 Bye'); socket.end(); }
      else reply('502 Not implemented');
    };

    socket.on('data', (chunk) => {
      buf += chunk;
      let i: number;
      while ((i = buf.indexOf('\r\n')) >= 0) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 2);
        onLine(line);
      }
    });
  });

  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });

  return {
    port: (server.address() as net.AddressInfo).port,
    messages,
    waitFor(predicate: (m: Mail) => boolean, timeoutMs = 5000): Promise<Mail> {
      const found = messages.find(predicate);
      if (found) return Promise.resolve(found);
      return new Promise<Mail>((resolve, reject) => {
        const timer = setTimeout(() => {
          waiters.delete(check);
          reject(new Error(`no matching mail within ${timeoutMs} ms (received ${messages.length}: ${messages.map((m) => JSON.stringify(m.subject)).join(', ') || 'none'})`));
        }, timeoutMs);
        const check = (m: Mail): void => {
          if (!predicate(m)) return;
          clearTimeout(timer);
          waiters.delete(check);
          resolve(m);
        };
        waiters.add(check);
      });
    },
    clear() { messages.length = 0; },
    close() {
      for (const s of sockets) s.destroy();
      return new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

/**
 * The full URL in a mail whose path starts with `pathPrefix` (e.g. '/signup/', '/reset/',
 * '/confirm-email/'), taken from the decoded text part, falling back to the HTML part.
 * Throws if there is none.
 */
export function linkFrom(message: Mail, pathPrefix: string): string {
  for (const body of [message.text, message.html]) {
    for (const [url] of body.matchAll(/https?:\/\/[^\s"'<>]+/g)) {
      try {
        if (new URL(url).pathname.startsWith(pathPrefix)) return url;
      } catch { /* not a URL */ }
    }
  }
  throw new Error(`no ${pathPrefix} link in mail "${message.subject}"`);
}

/** The token at the end of an emailed link, as used by /api/signup/:token and friends. */
export const tokenFromLink = (link: string): string => new URL(link).pathname.split('/').pop()!;
