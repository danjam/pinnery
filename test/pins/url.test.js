import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { startServer } from '../helpers/server.js';
import { pngBuffer } from '../helpers/images.js';
import { newBoard } from '../helpers/pins.js';

// A tiny upstream serving a PNG, a text file, a redirect and a 404.
async function startUpstream(png) {
  const srv = http.createServer((req, res) => {
    if (req.url === '/img.png') res.writeHead(200, { 'content-type': 'image/png' }).end(png);
    else if (req.url === '/redirect') res.writeHead(302, { location: '/img.png' }).end();
    else if (req.url === '/text') res.writeHead(200, { 'content-type': 'text/plain' }).end('hello');
    else res.writeHead(404).end();
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  return { port: srv.address().port, close: () => new Promise((r) => { srv.closeAllConnections(); srv.close(r); }) };
}

describe('pins by URL', () => {
  let png, upstream, locked, open, lockedUser, openUser;
  before(async () => {
    png = await pngBuffer({ width: 40, height: 30, color: '#808000' });
    upstream = await startUpstream(png);
    locked = await startServer();
    open = await startServer({ env: { PINNERY_FETCH_ALLOW: '127.0.0.1/32' } });
    lockedUser = await locked.createUser('u@example.com', 'user-password-1');
    openUser = await open.createUser('u@example.com', 'user-password-1');
  });
  after(async () => { await upstream.close(); await locked.stop(); await open.stop(); });

  const base = () => `http://127.0.0.1:${upstream.port}`;

  it('blocks loopback by default (SSRF guard), for pins and picks', async () => {
    const b = await newBoard(lockedUser, 'B');
    const r = await lockedUser.post('/api/pins/url', { board_id: b.id, url: `${base()}/img.png` });
    assert.equal(r.status, 400);
    assert.match(r.body.error, /blocked/);
    assert.equal((await lockedUser.post('/api/pick/url', { url: `${base()}/img.png` })).status, 400);
    assert.equal((await lockedUser.get(`/api/boards/${b.id}/pins`)).body.pins.length, 0);
  });

  it('validates the request before fetching', async () => {
    const b = await newBoard(lockedUser, 'V');
    assert.equal((await lockedUser.post('/api/pins/url', { url: 'https://example.com/a.png' })).status, 400);
    assert.equal((await lockedUser.post('/api/pins/url', { board_id: b.id })).status, 400);
    assert.equal((await lockedUser.post('/api/pins/url', { board_id: b.id, url: 'file:///etc/passwd' })).status, 400);
    assert.equal((await lockedUser.post('/api/pins/url', { board_id: b.id, url: 'not a url' })).status, 400);
    assert.equal((await lockedUser.post('/api/pins/url', { board_id: 999999, url: 'https://example.com/a.png' })).status, 404);
  });

  it('fetches and pins when the address is allow-listed', async () => {
    const b = await newBoard(openUser, 'Fetched');
    const r = await openUser.post('/api/pins/url', { board_id: b.id, url: `${base()}/img.png`, page_title: 'From URL' });
    assert.equal(r.status, 201);
    assert.equal(r.body.mime, 'image/png');
    assert.equal(r.body.width, 40);
    assert.equal(r.body.source_url, `${base()}/img.png`);
    assert.equal(r.body.page_title, 'From URL');
    const orig = await openUser.fetch(`/i/${r.body.sha256}`);
    assert.deepEqual(Buffer.from(await orig.arrayBuffer()), png);

    const viaRedirect = await openUser.post('/api/pins/url', { board_id: b.id, url: `${base()}/redirect`, source_url: 'https://example.com/page' });
    assert.equal(viaRedirect.status, 201);
    assert.equal(viaRedirect.body.source_url, 'https://example.com/page');
  });

  it('maps upstream failures and non-images to errors', async () => {
    const b = await newBoard(openUser, 'Bad');
    assert.equal((await openUser.post('/api/pins/url', { board_id: b.id, url: `${base()}/text` })).status, 415);
    assert.equal((await openUser.post('/api/pins/url', { board_id: b.id, url: `${base()}/missing` })).status, 502);
  });

  it('picks by URL work too when allowed', async () => {
    const r = await openUser.post('/api/pick/url', { url: `${base()}/img.png` });
    assert.equal(r.status, 201);
    assert.match(r.body.token, /^[0-9a-f]{32}$/);
  });
});
