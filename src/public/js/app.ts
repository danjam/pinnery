// The web app's entry: routing, the board view and multi-select. The home page, settings and
// adding pins are in their own modules; page.ts holds the state they share.
import { api, apiError, thumbUrl, errorMessage } from './api.ts';
import type { Pin } from './api.ts';
import { el, toast, confirm, prompt, pickBoard } from './ui.ts';
import type { MenuEntry } from './ui.ts';
import { icon } from './icons.ts';
import { layout, place } from './masonry.ts';
import type { Slot } from './masonry.ts';
import { openLightbox } from './lightbox.ts';
import { view, actionsEl, selectbar, selectCount, selMove, selDelete, selCancel, state, openBoard, setCrumbs, moreButton, isOwner, canAdd, sharedBy, pinnable, signOut } from './page.ts';
import { showHome, refreshHome, ownerItems } from './home.ts';
import { showSettings } from './settings.ts';
import { addPinDialog } from './add-pins.ts';
import { connectLive } from './live.ts';
import type { LiveEvent } from './live.ts';

// ---- routing ------------------------------------------------------------------------------

export function navigate(path: string) {
  history.pushState(null, '', path);
  route();
}

async function route() {
  const m = location.pathname.match(/^\/b\/(\d+)$/);
  const settingsTab = location.pathname.match(/^\/settings(?:\/([a-z]+))?$/);
  exitSelect();
  try {
    if (m) await showBoard(Number(m[1]));
    else if (settingsTab) await showSettings(settingsTab[1]);
    else await showHome();
  } catch (e) {
    toast(errorMessage(e), { error: true });
  }
}

document.addEventListener('click', (e) => {
  const a = e.target instanceof Element ? e.target.closest('a[data-link]') : null;
  if (!a || e.metaKey || e.ctrlKey || e.button) return;
  e.preventDefault();
  navigate(a.getAttribute('href')!);   // every data-link anchor has an href
});
window.addEventListener('popstate', route);

// ---- board view ---------------------------------------------------------------------------

let grid: HTMLElement | null = null;
let resizeObserver: ResizeObserver | null = null;

async function showBoard(id: number) {
  const { board, pins } = await api.boardPins(id);
  state.board = board;
  state.pins = pins;
  state.tiles.clear();
  if (!state.boards.length) api.boards().then((b) => { state.boards = b; }).catch(() => {});
  document.title = `${board.name} — Pinnery`;
  renderBoardHeader();

  grid = el('div', { class: 'grid' });
  const wrap = el('div', { class: 'grid-wrap' }, grid);
  view.replaceChildren(wrap);
  resizeObserver?.disconnect();
  resizeObserver = new ResizeObserver(() => relayout());
  resizeObserver.observe(wrap);
  renderGrid();
}

// Viewers get the sort toggle and the menu's general items; editors also Select and + Pin; owners
// the board's own menu items too. Select is for deleting (anyone who may) and moving (owners).
export function renderBoardHeader() {
  const b = openBoard();
  setCrumbs(b.name, state.pins.length, sharedBy(b));
  const ownerPart: MenuEntry[] = isOwner(b) ? [...ownerItems({ ...b, pin_count: state.pins.length }), '-'] : [];
  actionsEl.replaceChildren(...[
    el('button', {
      class: 'btn ghost', title: 'Toggle sort order',
      onclick: () => {
        state.order = state.order === 'desc' ? 'asc' : 'desc';
        localStorage.setItem('pinnery.order', state.order);
        renderBoardHeader();
        renderGrid();
      },
    }, icon(state.order === 'desc' ? 'sort-clock-descending-outline' : 'sort-clock-ascending-outline'),
      el('span', { text: state.order === 'desc' ? 'Newest first' : 'Oldest first' })),
    canAdd(b) && el('button', { class: `btn${state.selecting ? ' active' : ''}`, onclick: () => (state.selecting ? exitSelect() : enterSelect()) },
      icon('checkbox-multiple-marked-outline'), el('span', { text: 'Select' })),
    canAdd(b) && el('button', { class: 'btn primary', onclick: () => addPinDialog() }, icon('plus'), el('span', { text: 'Pin' })),
    moreButton('Board menu', [
      ...ownerPart,
      { label: 'Settings', icon: 'cog-outline', onclick: () => navigate('/settings') },
      { label: 'Sign out', icon: 'logout', onclick: signOut },
    ]),
  // Viewers can't add, so Select and + Pin are false: drop them (replaceChildren would show "false").
  ].filter((c) => c !== false));
  selMove.hidden = !isOwner(b);
}

function displayedPins() {
  return state.order === 'asc' ? [...state.pins].reverse() : state.pins;
}

// Only tiles within a screen of the viewport are in the DOM: a big board would otherwise mean
// thousands of elements. Every pin gets a slot (masonry.ts), so the grid has its full height, and
// scrolling mounts tiles as they come near and unmounts those left behind. state.tiles holds the
// mounted ones; selection and the lightbox work from the pin list, not the DOM. A focused tile
// stays mounted wherever it is, so focus isn't lost to the page.
const WINDOW_MARGIN = 1;   // screens kept mounted above and below the viewport
let order: Pin[] = [];     // displayedPins() as of the last relayout
let slots: Slot[] = [];    // order[i] goes in slots[i]
let thumbSize = 400;

export function renderGrid() {
  if (!grid) return;
  const pins = displayedPins();
  order = [];   // until relayout slots the new list
  slots = [];
  if (!pins.length) {
    state.tiles.clear();
    grid.replaceChildren(el('div', { class: 'empty' },
      el('h2', { text: 'No pins yet' }),
      canAdd(openBoard()) && el('p', {}, 'Right-click any image → ', el('kbd', { text: 'Pin to Pinnery' }), ', or use ', el('kbd', { text: '+ Pin' })),
      canAdd(openBoard()) && el('button', { class: 'btn primary', onclick: () => addPinDialog() }, icon('plus'), el('span', { text: 'Pin' })),
    ));
    grid.style.height = '';
    return;
  }
  // Keep the mounted tiles of pins still on the board, in display order; updateWindow adds the rest.
  const ids = new Set(pins.map((p) => p.id));
  for (const [id, t] of state.tiles) if (!ids.has(id)) { t.remove(); state.tiles.delete(id); }
  grid.replaceChildren(...pins.flatMap((p) => state.tiles.get(p.id) ?? []));
  relayout();
}

// Slot every pin, move the mounted tiles to their new slots, then mount what's now in view.
// Thumbnails are sized to the column width and screen density.
function relayout() {
  if (!grid || !state.pins.length) return;
  const pins = displayedPins();
  const result = layout(grid, pins);
  if (!result) return;
  order = pins;
  slots = result.slots;
  thumbSize = result.colW * devicePixelRatio > 400 ? 800 : 400;
  pins.forEach((p, i) => { const t = state.tiles.get(p.id); if (t) place(t, slots[i]); });
  updateWindow();
}

function focusedPin() {
  const active = document.activeElement;
  for (const [id, t] of state.tiles) if (t.contains(active)) return id;
  return undefined;
}

// Mount the tiles whose slots are near the viewport, in display order, and unmount the rest.
function updateWindow() {
  if (!grid?.isConnected || !slots.length) return;
  const margin = innerHeight * WINDOW_MARGIN;
  const top = -grid.getBoundingClientRect().top - margin;
  const bottom = top + innerHeight + 2 * margin;
  const focused = focusedPin();
  const keep = new Set<number>();
  // A focused tile below the window is never reached; it's already after the window in the DOM.
  if (focused !== undefined) keep.add(focused);
  let prev: HTMLElement | null = null;
  for (let i = 0; i < slots.length; i++) {
    const slot = slots[i];
    if (slot.y > bottom) break;   // slots' y never decreases down the list
    const pin = order[i];
    // A focused tile above the window still counts, so tiles mounted after it go after it.
    if (slot.y + slot.h < top && pin.id !== focused) continue;
    keep.add(pin.id);
    let t = state.tiles.get(pin.id);
    if (!t) {
      t = tile(pin);
      t.classList.toggle('selected', state.selected.has(pin.id));
      place(t, slot);
      const img = t.querySelector('img')!;   // every tile has its <img>
      img.src = thumbUrl(pin, thumbSize);
      // Already in the memory cache (a tile scrolled back into view): show it without the fade.
      if (img.complete && img.naturalWidth) img.classList.add('loaded');
      state.tiles.set(pin.id, t);
      if (prev) prev.after(t); else grid.prepend(t);
    }
    prev = t;
  }
  for (const [id, t] of state.tiles) if (!keep.has(id)) { t.remove(); state.tiles.delete(id); }
}

let windowFrame = 0;
function scheduleWindow() {
  if (!windowFrame) windowFrame = requestAnimationFrame(() => { windowFrame = 0; updateWindow(); });
}
window.addEventListener('scroll', scheduleWindow, { passive: true });
window.addEventListener('resize', scheduleWindow);

function tile(pin: Pin) {
  const img = el('img', { alt: pin.page_title || '', loading: 'lazy', decoding: 'async' });
  img.addEventListener('load', () => img.classList.add('loaded'));
  const t = el('div', { class: 'tile', tabindex: 0, role: 'button', dataset: { id: pin.id } },
    img,
    pin.animated ? el('span', { class: 'badge', text: pin.mime === 'image/gif' ? 'GIF' : 'ANIM' }) : null,
    el('span', { class: 'check' }, icon('check')),
  );
  const activate = () => {
    if (state.selecting) toggleSelect(pin.id);
    else openPin(pin);
  };
  t.addEventListener('click', activate);
  t.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); activate(); } });
  // Long-press on touch devices enters select mode.
  let pressTimer: ReturnType<typeof setTimeout> | undefined;
  t.addEventListener('touchstart', () => { pressTimer = setTimeout(() => { if (!state.selecting) { enterSelect(); toggleSelect(pin.id); } }, 500); }, { passive: true });
  t.addEventListener('touchend', () => clearTimeout(pressTimer));
  t.addEventListener('touchmove', () => clearTimeout(pressTimer), { passive: true });
  return t;
}

// The lightbox gets only the actions the user's role allows (see lightbox.ts).
function openPin(pin: Pin) {
  const pins = displayedPins().slice();
  const b = openBoard();
  openLightbox({
    pins,
    index: pins.findIndex((p) => p.id === pin.id),
    actions: {
      setCover: isOwner(b) && (async (p) => {
        await api.updateBoard(b.id, { cover_pin_id: p.id });
        toast('Cover updated');
      }),
      move: isOwner(b) && ((p) => movePins([p.id])),
      remove: canAdd(b) && ((p) => deletePins([p.id])),
    },
  });
}

// Remove pins from the local list after a move or delete and redraw.
function dropLocal(ids: number[]) {
  const gone = new Set(ids);
  state.pins = state.pins.filter((p) => !gone.has(p.id));
  renderBoardHeader();
  renderGrid();
}

async function movePins(ids: number[]) {
  if (!state.boards.length) state.boards = await api.boards();
  let to = await pickBoard({ title: `Move ${ids.length} ${ids.length === 1 ? 'pin' : 'pins'} to…`, boards: pinnable(state.boards), exclude: openBoard().id });
  if (to === undefined) return false;
  if (to === 'new') {
    const name = await prompt({ title: 'New board', label: 'Board name', ok: 'Create' });
    if (!name) return false;
    const b = await api.createBoard(name);
    state.boards.push(b);
    to = b.id;
  }
  await api.movePins(ids, to);
  const target = state.boards.find((b) => b.id === to);
  toast(`Moved to “${target?.name ?? 'board'}”`, { action: () => navigate(`/b/${to}`) });
  dropLocal(ids);
  exitSelect();
  return true;
}

async function deletePins(ids: number[]) {
  const n = ids.length;
  if (!(await confirm({ title: n === 1 ? 'Delete this pin?' : `Delete ${n} pins?`, message: 'This can\'t be undone.' }))) return false;
  await api.deletePins(ids);
  toast(n === 1 ? 'Deleted' : `Deleted ${n} pins`);
  dropLocal(ids);
  exitSelect();
  return true;
}

// ---- multi-select -------------------------------------------------------------------------

function enterSelect() {
  state.selecting = true;
  grid?.classList.add('selecting');
  renderBoardHeader();
  updateSelectbar();
}

function exitSelect() {
  state.selecting = false;
  for (const id of state.selected) state.tiles.get(id)?.classList.remove('selected');
  state.selected.clear();
  grid?.classList.remove('selecting');
  selectbar.hidden = true;
  if (state.board) renderBoardHeader();
}

function toggleSelect(id: number) {
  if (state.selected.has(id)) state.selected.delete(id); else state.selected.add(id);
  state.tiles.get(id)?.classList.toggle('selected', state.selected.has(id));
  updateSelectbar();
}

function updateSelectbar() {
  selectbar.hidden = !state.selecting;
  const n = state.selected.size;
  selectCount.textContent = n ? `${n} selected` : 'Select pins';
  selMove.disabled = !n;
  selDelete.disabled = !n;
}

// ---- live updates (live.ts) -----------------------------------------------------------------
// The board page refetches when its board is pinged, the home page on any ping, and both once
// after a reconnect. Pings come in bursts (an import sends one per board, a bulk delete one per
// board), so refreshes are batched, and run one at a time.

async function refreshBoard(id: number) {
  let data;
  try {
    data = await api.boardPins(id);
  } catch (e) {
    const status = apiError(e)?.status;
    // The board is gone, or no longer shared with this user: back home.
    if ((status === 403 || status === 404) && state.board?.id === id) {
      toast('That board is no longer available');
      navigate('/');
      return;
    }
    throw e;
  }
  if (state.board?.id !== id) return;   // navigated away meanwhile
  if (JSON.stringify(data) === JSON.stringify({ board: state.board, pins: state.pins })) return;
  state.board = data.board;
  state.pins = data.pins;
  document.title = `${data.board.name} — Pinnery`;
  if (state.selecting && !canAdd(data.board)) exitSelect();
  const ids = new Set(data.pins.map((p) => p.id));
  for (const s of state.selected) if (!ids.has(s)) state.selected.delete(s);
  renderBoardHeader();
  renderGrid();
  if (state.selecting) updateSelectbar();
}

let refreshTimer: ReturnType<typeof setTimeout> | undefined;
let refreshing = false;
let refreshAgain = false;

function scheduleRefresh() {
  clearTimeout(refreshTimer);
  refreshTimer = setTimeout(runRefresh, 150);
}

async function runRefresh() {
  if (refreshing) { refreshAgain = true; return; }
  refreshing = true;
  try {
    if (state.board) await refreshBoard(state.board.id);
    else if (location.pathname === '/') await refreshHome();
  } catch { /* a failed refresh changes nothing; the next ping or reconnect tries again */ }
  refreshing = false;
  if (refreshAgain) { refreshAgain = false; scheduleRefresh(); }
}

function onLive(e: LiveEvent) {
  // On a board page, the move dialog's list of boards is fetched again when next needed.
  if (e.type === 'boards' && state.board) state.boards = [];
  if (!state.board || (e.type === 'board' && e.id === state.board.id)) scheduleRefresh();
}

// Resync only once the first render is done, so its refetch can't race the first fetch.
const routed = route();
connectLive(onLive, () => { routed.then(scheduleRefresh); });

selMove.onclick = () => movePins([...state.selected]);
selDelete.onclick = () => deletePins([...state.selected]);
selCancel.onclick = exitSelect;

// Register the service worker that receives Android shares (it caches nothing else).
if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {});
