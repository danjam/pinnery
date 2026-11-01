// The board picker the extension opens at /pick/<token> after it has sent the image. The token in
// the URL is the only credential (see routes.ts createPickRoutes). Lists boards most-recent first
// so the last-used board is preselected, filters as you type, creates a board inline, and commits
// or discards the parked image.
//
// The extension's service worker watches this window's URL: navigating to /pick/<token>/done or
// /pick/<token>/cancelled tells it the outcome, so it can close the window and show the in-page
// toast. Opened by hand (no extension), those pages just say what happened.

import { el } from './ui.ts';
import { icon } from './icons.ts';
import { errorMessage } from './api.ts';

// The boards as /api/pick/:token/boards lists them (the pick page's own, trimmed view).
interface PickBoard {
  id: number;
  name: string;
  pin_count: number;
  cover: { sha256: string } | null;
  owner_name: string | null;   // null for the user's own boards
}

// The parked image, from /info.
interface PickItem {
  width: number;
  height: number;
  mime: string;
  animated: boolean;
  source_url: string | null;
  page_title: string | null;
  expires_in: number;
}

// A rendered row: an existing board, or the "Create …" row for the filter text.
type Row = { el: HTMLElement; board: PickBoard } | { el: HTMLElement; create: string };

// The page's HTML has every element looked up here.
const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const filter = $<HTMLInputElement>('filter');
const list = $('boards');
const status = $('status');
const pinBtn = $<HTMLButtonElement>('pin');

const m = location.pathname.match(/^\/pick\/([0-9a-f]{32})(?:\/(done|cancelled))?$/);
const token = m?.[1];
const base = `/pick/${token}`;
let boards: PickBoard[] = [];
let active = 0;      // index into the rendered rows
let rows: Row[] = [];       // rendered rows: { el, board } or { el, create: name }
let busy = false;
let finished = false;

async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
  const headers: Record<string, string> = {};
  const init: RequestInit = { method, headers };
  if (body !== undefined) { init.body = JSON.stringify(body); headers['Content-Type'] = 'application/json'; }
  const res = await fetch(base + path, init);
  const data: T & { error?: string } = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(data.error || `HTTP ${res.status}`), { status: res.status });
  return data;
}

// The HTTP status call() attached to an error it threw.
const statusOf = (e: unknown) => (e instanceof Error && 'status' in e ? e.status : undefined);

function notice(text: string, ...actions: (Node | null)[]) {
  $('main').classList.add('hidden');
  $('notice').classList.remove('hidden');
  $('notice-text').textContent = text;
  $('notice-actions').replaceChildren(...actions.filter((a) => a !== null));
  pinBtn.disabled = true;
}

function setStatus(text: string, kind = '') {
  status.textContent = text;
  status.className = `status ${kind}`;
}

function showPreview(item: PickItem) {
  const thumb = $<HTMLImageElement>('thumb');
  thumb.onerror = () => thumb.classList.add('failed');
  thumb.src = `${base}/preview`;
  let host = '';
  try { host = new URL(item.source_url ?? '').hostname.replace(/^www\./, ''); } catch {}
  const cap = $('caption');
  cap.replaceChildren();
  if (item.page_title) cap.append(el('b', { text: item.page_title }), el('br'));
  cap.append(host || item.source_url || '');
}

const thumbUrl = (sha: string) => `${base}/t/400/${sha}`;

// `shared` is the owner's name for a board shared with the user (as an editor), shown under the name.
function row({ cls = '', cover, label, count, shared, onclick }: {
  cls?: string;
  cover?: string | null;
  label: string;
  count?: number | null;
  shared?: string | null;
  onclick: () => void;
}) {
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
function select(idx: number) {
  const prev = rows[active]?.el;
  if (prev) { prev.classList.remove('active'); prev.setAttribute('aria-selected', 'false'); }
  active = idx;
  const r = rows[active];
  if (r) {
    r.el.classList.add('active');
    r.el.setAttribute('aria-selected', 'true');
    r.el.scrollIntoView({ block: 'nearest' });
  }
  pinBtn.replaceChildren(icon('pin'), document.createTextNode(r && 'create' in r ? 'Create and pin' : 'Pin'));
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
async function createBoard(name: string) {
  if (busy || !name) return null;
  busy = true;
  pinBtn.disabled = true;
  setStatus(`Creating “${name}”…`);
  try {
    const b = await call<PickBoard>('POST', '/boards', { name });
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
  const board = 'board' in r ? r.board : await createBoard(r.create);
  if (board) await pin(board);
};

// Hand the outcome to the extension (it watches this URL) and to anyone reading the page.
function leave(outcome: 'done' | 'cancelled', params: Record<string, string> = {}) {
  finished = true;
  const q = new URLSearchParams(params).toString();
  location.replace(`${base}/${outcome}${q ? `?${q}` : ''}`);
}

async function pin(board: PickBoard) {
  if (busy) return;
  busy = true;
  filter.disabled = true;
  pinBtn.disabled = true;
  try {
    setStatus('Saving…');
    const { board: saved } = await call<{ board: { id: number; name: string } }>('POST', '/commit', { board_id: board.id });
    setStatus(`Pinned to “${saved.name}”`, 'ok');
    leave('done', { board: String(saved.id), name: saved.name });
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
function fail(e: unknown) {
  if (statusOf(e) === 410) notice(errorMessage(e));
  else setStatus(errorMessage(e), 'error');
}

function showResult(outcome: string) {
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
  if (!m || !token) return notice('Nothing to pin — right-click an image and choose “Pin to Pinnery”.');
  if (m[2]) return showResult(m[2]);
  try {
    const info = await call<{ item: PickItem; boards: PickBoard[] }>('GET', '/info');
    showPreview(info.item);
    boards = info.boards;
    $('main').classList.remove('hidden');
    render();
    filter.focus();
  } catch (e) {
    notice(statusOf(e) === 410 ? errorMessage(e) : `Couldn't load: ${errorMessage(e)}`);
  }
}

init();
