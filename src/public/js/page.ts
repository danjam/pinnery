// What the app's views share: the page's fixed elements, the app state, and small helpers for the
// header and for what a board's role allows.
import { api } from './api.ts';
import type { Board, BoardInfo, Pin, Role } from './api.ts';
import { el, menu } from './ui.ts';
import type { MenuEntry } from './ui.ts';
import { icon } from './icons.ts';

// index.html has all of these.
export const view = document.getElementById('view')!;
export const titleEl = document.getElementById('title')!;
export const actionsEl = document.getElementById('actions')!;
export const selectbar = document.getElementById('selectbar')!;
export const selectCount = document.getElementById('selectcount')!;
export const selMove = document.getElementById('sel-move') as HTMLButtonElement;
export const selDelete = document.getElementById('sel-delete') as HTMLButtonElement;
export const selCancel = document.getElementById('sel-cancel')!;
export const dropcover = document.getElementById('dropcover')!;

export const state: {
  boards: Board[];
  board: BoardInfo | null;
  pins: Pin[];
  order: 'asc' | 'desc';
  selecting: boolean;
  selected: Set<number>;
  tiles: Map<number, HTMLElement>;
} = {
  boards: [],
  board: null,        // current board row, or null on the home page
  pins: [],           // newest first, as the server sends them
  order: localStorage.getItem('pinnery.order') === 'asc' ? 'asc' : 'desc',
  selecting: false,
  selected: new Set(),
  tiles: new Map(),   // pin id -> tile element, for the board's mounted tiles (see app.ts)
};

// The open board, for the functions that only run on a board's page.
export function openBoard(): BoardInfo {
  if (!state.board) throw new Error('no board is open');
  return state.board;
}

// Is the event's target inside an element matching the selector? (Targets can be non-elements.)
export const within = (target: EventTarget | null, selector: string) => target instanceof Element && target.closest(selector) !== null;

// Breadcrumb after "Pinnery": nothing on the home page, else "/ <title>" with an optional count
// and note (both dimmed), e.g. "/ Trips (12) shared by Sam".
export function setCrumbs(title?: string, count?: number, note?: string) {
  titleEl.replaceChildren();
  if (title == null) return;
  titleEl.append(el('span', { class: 'sep', text: '/' }), el('span', { class: 'crumb', text: title }));
  if (count != null) titleEl.append(el('span', { class: 'count', text: `(${count})` }));
  if (note) titleEl.append(el('span', { class: 'count', text: note }));
}

export function moreButton(label: string, items: MenuEntry[]) {
  return el('button', { class: 'btn icon-only ghost', 'aria-label': label, onclick: (e) => menu(e.currentTarget, items) }, icon('dots-horizontal'));
}

// A board's `role` is the user's standing on it: owner, or editor / viewer of a board shared with
// them (`owner_name` says by whom). Owners do everything; editors add and delete pins; viewers look.
export const isOwner = (b: { role: Role }) => b.role === 'owner';
export const canAdd = (b: { role: Role }) => b.role !== 'viewer';
export const sharedBy = (b: BoardInfo) => (isOwner(b) ? '' : `shared by ${b.owner_name}`);
// Boards the user can pin into, named for a picker — shared ones say so.
export const pinnable = <B extends BoardInfo>(boards: B[]): B[] => boards.filter(canAdd).map((b) => ({ ...b, name: isOwner(b) ? b.name : `${b.name} (${sharedBy(b)})` }));

export async function signOut() {
  await api.logout();
  location.href = '/login';
}
