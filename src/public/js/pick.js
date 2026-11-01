// The board picker the extension opens at /pick/<token> after it has sent the image. The token in
// the URL is the only credential (see routes.js createPickRoutes). Lists boards most-recent first
// so the last-used board is preselected, filters as you type, creates a board inline, and commits
// or discards the parked image.
//
// The extension's service worker watches this window's URL: navigating to /pick/<token>/done or
// /pick/<token>/cancelled tells it the outcome, so it can close the window and show the in-page
// toast. Opened by hand (no extension), those pages just say what happened.

import { el } from './ui.js';
import { icon } from './icons.js';

const $ = (id) => document.getElementById(id);
const filter = $('filter');
const list = $('boards');
const status = $('status');
const pinBtn = $('pin');

const m = location.pathname.match(/^\/pick\/([0-9a-f]{32})(?:\/(done|cancelled))?$/);
const token = m?.[1];
const base = `/pick/${token}`;
let boards = [];
let active = 0;      // index into the rendered rows
let rows = [];       // rendered rows: { el, board } or { el, create: name }
let busy = false;
let finished = false;

async function call(method, path, body) {
  const init = { method, headers: {} };
  if (body !== undefined) { init.body = JSON.stringify(body); init.headers['Content-Type'] = 'application/json'; }
  const res = await fetch(base + path, init);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(data.error || `HTTP ${res.status}`), { status: res.status });
  return data;
}

function notice(text, ...actions) {
  $('main').classList.add('hidden');
  $('notice').classList.remove('hidden');
  $('notice-text').textContent = text;
  $('notice-actions').replaceChildren(...actions.filter(Boolean));
  pinBtn.disabled = true;
}

function setStatus(text, kind = '') {
  status.textContent = text;
  status.className = `status ${kind}`;
}

function showPreview(item) {
  const thumb = $('thumb');
  thumb.onerror = () => thumb.classList.add('failed');
  thumb.src = `${base}/preview`;
  let host = '';
  try { host = new URL(item.source_url).hostname.replace(/^www\./, ''); } catch {}
  const cap = $('caption');
  cap.replaceChildren();
  if (item.page_title) cap.append(el('b', { text: item.page_title }), el('br'));
  cap.append(host || item.source_url || '');
}

const thumbUrl = (sha) => `${base}/t/400/${sha}`;

// `shared` is the owner's name for a board shared with the user (as an editor), shown under the name.
function row({ cls = '', cover, label, count, shared, onclick }) {
  const b = el('button', { class: `board ${cls}`, role: 'option', onclick });
  if (cover) b.append(el('img', { class: 'cover', src: thumbUrl(cover), alt: '' }));
  else b.append(el('div', { class: 'cover' }, icon(cls === 'create' ? 'plus' : 'image-outline')));
  b.append(el('span', { class: 'name' }, el('span', { text: label }), shared && el('span', { class: 'shared', text: `shared by ${shared}` })));
  if (count != null) b.append(el('span', { class: 'count', text: count }));
  return b;
}

function render() {
  const query = filter.value.trim().toLowerCase();
  const shown = boards.filter((b) => !query || b.name.toLowerCase().includes(query));
  rows = shown.map((b, idx) => ({
    board: b,
    el: row({ cover: b.cover?.sha256 || null, label: b.name, count: b.pin_count, shared: b.owner_name, onclick: () => select(idx) }),
  }));
  const exact = boards.some((b) => b.name.toLowerCase() === query);
  if (query && !exact) {
    const name = filter.value.trim();
    rows.push({ create: name, el: row({ cls: 'create', label: `Create “${name}”`, onclick: () => createBoard(name) }) });
  }
  if (!rows.length) {
    list.replaceChildren(el('div', { class: 'empty', text: 'No boards yet — type a name to create one.' }));
    select(-1);
    return;
  }
  list.replaceChildren(...rows.map((r) => r.el));
  select(Math.max(0, Math.min(active, rows.length - 1)));
}

// Highlight a row and label the Pin button for it. Clicking only selects; Pin does the work.
function select(idx) {
  const prev = rows[active]?.el;
  if (prev) { prev.classList.remove('active'); prev.setAttribute('aria-selected', 'false'); }
  active = idx;
  const r = rows[active];
  if (r) {
    r.el.classList.add('active');
    r.el.setAttribute('aria-selected', 'true');
    r.el.scrollIntoView({ block: 'nearest' });
  }
  pinBtn.replaceChildren(icon('pin'), document.createTextNode(r?.create ? 'Create and pin' : 'Pin'));
  pinBtn.disabled = busy || !r;
}

filter.addEventListener('input', () => { active = 0; render(); });
// Enter deliberately does nothing here: typing only filters (or offers "Create …").
filter.addEventListener('keydown', (e) => {
  if (e.key === 'ArrowDown') { e.preventDefault(); if (rows.length) select((active + 1) % rows.length); }
  else if (e.key === 'ArrowUp') { e.preventDefault(); if (rows.length) select((active - 1 + rows.length) % rows.length); }
  else if (e.key === 'Enter') e.preventDefault();
});
document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !busy && !finished) cancel(); });

// Create the board from the filter text and select it (clearing the filter so it shows in the list).
async function createBoard(name) {
  if (busy || !name) return null;
  busy = true;
  pinBtn.disabled = true;
  setStatus(`Creating “${name}”…`);
  try {
    const b = await call('POST', '/boards', { name });
    boards.unshift(b);
    filter.value = '';
    active = 0;
    setStatus('');
    return b;
  } catch (e) {
    fail(e);
    return null;
  } finally {
    busy = false;
    render();
  }
}

pinBtn.onclick = async () => {
  const r = rows[active];
  if (!r || busy) return;
  const board = r.board || await createBoard(r.create);
  if (board) await pin(board);
};

// Hand the outcome to the extension (it watches this URL) and to anyone reading the page.
function leave(outcome, params = {}) {
  finished = true;
  const q = new URLSearchParams(params).toString();
  location.replace(`${base}/${outcome}${q ? `?${q}` : ''}`);
}

async function pin(board) {
  if (busy) return;
  busy = true;
  filter.disabled = true;
  pinBtn.disabled = true;
  try {
    setStatus('Saving…');
    const { board: saved } = await call('POST', '/commit', { board_id: board.id });
    setStatus(`Pinned to “${saved.name}”`, 'ok');
    leave('done', { board: saved.id, name: saved.name });
  } catch (e) {
    busy = false;
    filter.disabled = false;
    pinBtn.disabled = false;
    fail(e);
  }
}

// Cancel or Escape: drop the parked image, then report "cancelled".
async function cancel() {
  if (finished) return;
  busy = true;
  pinBtn.disabled = true;
  await call('POST', '/discard').catch(() => {});
  setStatus('Not pinned');
  leave('cancelled');
}

// A 410 means the token is spent or the parked image timed out: nothing more to do here.
function fail(e) {
  if (e.status === 410) notice(e.message);
  else setStatus(e.message, 'error');
}

function showResult(outcome) {
  const q = new URLSearchParams(location.search);
  $('preview').classList.add('hidden');
  $('foot').classList.add('hidden');
  if (outcome === 'done') {
    const id = Number(q.get('board'));
    const name = q.get('name') || 'board';
    notice(`Pinned to “${name}”`, id ? el('a', { class: 'btn primary', href: `/b/${id}`, text: 'Open board' }) : null);
    document.title = `Pinned to ${name} — Pinnery`;
  } else {
    notice('Not pinned');
  }
}

async function init() {
  select(-1);
  if (!token) return notice('Nothing to pin — right-click an image and choose “Pin to Pinnery”.');
  if (m[2]) return showResult(m[2]);
  try {
    const info = await call('GET', '/info');
    showPreview(info.item);
    boards = info.boards;
    $('main').classList.remove('hidden');
    render();
    filter.focus();
  } catch (e) {
    notice(e.status === 410 ? e.message : `Couldn't load: ${e.message}`);
  }
}

init();
