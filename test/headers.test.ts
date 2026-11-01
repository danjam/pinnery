import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startServer } from './helpers/server.ts';
import type { Server } from './helpers/server.ts';

const publicDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'public');

describe('security headers', () => {
  let server: Server;
  before(async () => { server = await startServer(); });
  after(() => server.stop());

  for (const p of ['/login', '/forgot', '/healthz', '/api/me', '/js/boot.js', '/no-such-page']) {
    it(`are sent on ${p}`, async () => {
      const res = await server.anon().fetch(p);
      const csp = res.headers.get('content-security-policy');
      assert.match(csp ?? '', /script-src 'self'(;|$)/);
      assert.match(csp ?? '', /frame-ancestors 'none'/);
      assert.equal(res.headers.get('x-frame-options'), 'DENY');
      assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
    });
  }

  it('the pages have no inline scripts for the CSP to block', () => {
    for (const f of fs.readdirSync(publicDir).filter((n) => n.endsWith('.html'))) {
      const html = fs.readFileSync(path.join(publicDir, f), 'utf8');
      assert.doesNotMatch(html, /<script(?![^>]*\bsrc=)[^>]*>/, `${f} has an inline <script>`);
      assert.doesNotMatch(html, /\son[a-z]+=/i, `${f} has an inline event handler`);
    }
  });
});
