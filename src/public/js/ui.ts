// Small DOM helpers, toasts, popup menus and <dialog>-based prompts.

import { icon } from './icons.ts';
import type { IconName } from './icons.ts';

// Anything el() takes as a child: nodes and text, with null / false skipped (so `cond && el(…)` works).
export type Child = Node | string | null | undefined | false;
type Children = (Child | Child[])[];

// onclick, oninput, …: the listener gets the event typed for the element it's on, with
// currentTarget narrowed to that element.
type Handlers<T extends HTMLElement> = {
  [E in keyof HTMLElementEventMap as `on${E}`]?:
    | ((e: HTMLElementEventMap[E] & { currentTarget: T }) => void)
    | null
    | false;
};
// Every other key is set as an attribute (true sets it empty, false / null skip it). `never`
// parameters let any listener type through the index signature; the Handlers keys above are what
// callers are actually checked against.
type AttrValue = string | number | boolean | null | undefined | Record<string, string | number>
  | ((e: never) => void);
type Attrs<T extends HTMLElement> = Handlers<T> & {
  class?: string | null | false;
  text?: string | number | null;
  html?: string;
  dataset?: Record<string, string | number>;
  [attr: string]: AttrValue;
};

// Drops the null / false children.
const shown = (c: Child): c is Node | string => c != null && c !== false;

export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs: Attrs<HTMLElementTagNameMap[K]> = {},
  ...children: Children
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k === 'class') node.className = String(v);
    else if (k === 'text') node.textContent = String(v);
    else if (k === 'html') node.innerHTML = String(v);
    // The cast is the one place the listener's event type is erased: k.slice(2) is a string.
    else if (k.startsWith('on') && typeof v === 'function') node.addEventListener(k.slice(2), v as EventListener);
    else if (k === 'dataset') Object.assign(node.dataset, v);
    else if (v === true) node.setAttribute(k, '');
    else node.setAttribute(k, String(v));
  }
  node.append(...children.flat().filter(shown));
  return node;
}

// Toast with a countdown bar along its bottom edge. Hovering pauses both the bar and the dismiss
// timer; `action` makes it clickable (click runs it and dismisses). The extension's in-page toast
// (extension/content.ts) mirrors this markup, styling and behaviour.
export function toast(
  message: string,
  { error = false, ms = 3000, action = null }: { error?: boolean; ms?: number; action?: (() => void) | null } = {},
): HTMLElement {
  const t = el(action ? 'button' : 'div', {
    class: `toast${error ? ' error' : ''}${action ? ' clickable' : ''}`,
    role: 'status',
    style: `--toast-ms:${ms}ms`,
    onclick: action && (() => { dismiss(); action(); }),
  }, error && icon('alert-outline'), el('span', { class: 'msg', text: message }), el('span', { class: 'bar' }));
  let timer: ReturnType<typeof setTimeout>;
  let left = ms;
  let since = 0;
  const dismiss = () => { clearTimeout(timer); t.remove(); };
  const start = () => { since = performance.now(); timer = setTimeout(dismiss, left); };
  t.addEventListener('mouseenter', () => { clearTimeout(timer); left -= performance.now() - since; });
  t.addEventListener('mouseleave', start);
  toastHome().append(t);
  start();
  return t;
}

// Where toasts live. While a modal dialog is open (the lightbox), everything outside it is inert
// and painted beneath it, so the container moves inside the top-most modal and back to <body>
// when that closes. Fixed positioning keeps it in the viewport corner either way, with one style.
// A popover="manual" container would paint above the modal too, but anything outside the dialog's
// subtree stays inert (whatwg/html#9936), so it couldn't be hovered or clicked.
function toastHome(): HTMLElement {
  const box = document.getElementById('toasts')!;   // every page that toasts has it
  const modal = [...document.querySelectorAll<HTMLDialogElement>('dialog:modal')].at(-1);
  const home = modal || document.body;
  if (box.parentNode !== home) {
    home.append(box);
    if (modal) modal.addEventListener('close', () => document.body.append(box), { once: true });
  }
  return box;
}

export interface MenuItem {
  label: string;
  icon?: IconName;
  danger?: boolean;
  onclick: () => void;
}

// Popup menu anchored to an element. items: [{ label, icon, danger, onclick }] or '-' for a divider.
export type MenuEntry = MenuItem | '-';

export function menu(anchor: HTMLElement, items: MenuEntry[]) {
  closeMenu();
  const m = el('div', { class: 'menu', role: 'menu' });
  for (const item of items) {
    if (item === '-') { m.append(el('hr')); continue; }
    m.append(el('button', {
      class: item.danger ? 'danger' : null,
      onclick: () => { closeMenu(); item.onclick(); },
    }, item.icon && icon(item.icon), el('span', { text: item.label })));
  }
  document.body.append(m);
  const r = anchor.getBoundingClientRect();
  const w = m.offsetWidth, h = m.offsetHeight;
  let left = Math.min(r.left, window.innerWidth - w - 8);
  let top = r.bottom + 6;
  if (top + h > window.innerHeight - 8) top = Math.max(8, r.top - h - 6);
  m.style.left = `${Math.max(8, left)}px`;
  m.style.top = `${top}px`;
  openMenu = m;
  setTimeout(() => {
    document.addEventListener('pointerdown', onOutside, { once: true, capture: true });
    document.addEventListener('keydown', onEsc);
  });
}
let openMenu: HTMLElement | null = null;
function onOutside(e: PointerEvent) { if (openMenu && !openMenu.contains(e.target as Node)) closeMenu(); }
function onEsc(e: KeyboardEvent) { if (e.key === 'Escape') closeMenu(); }
export function closeMenu() {
  if (!openMenu) return;
  openMenu.remove();
  openMenu = null;
  document.removeEventListener('pointerdown', onOutside, { capture: true });
  document.removeEventListener('keydown', onEsc);
}

// Open a dialog with the given body nodes. Resolves with whatever close(value) is called with
// (undefined on Escape / backdrop click).
export function dialog<T = unknown>(
  build: (close: (value?: T) => void) => Child | Child[],
  { className = '' }: { className?: string } = {},
): Promise<T | undefined> {
  return new Promise((resolve) => {
    const d = el('dialog', { class: className });
    let settled = false;
    const close = (value?: T) => {
      if (settled) return;
      settled = true;
      d.close();
      resolve(value);
    };
    d.append(...[build(close)].flat().filter(shown));
    d.addEventListener('close', () => { close(undefined); d.remove(); });
    d.addEventListener('click', (e) => { if (e.target === d) close(undefined); });
    document.body.append(d);
    d.showModal();
  });
}

export function prompt({ title, label = 'Name', value = '', ok = 'Save' }: { title: string; label?: string; value?: string; ok?: string }) {
  return dialog<string>((close) => {
    const input = el('input', { class: 'field', value, placeholder: label, maxlength: 100, autofocus: true });
    const form = el('form', { method: 'dialog', onsubmit: (e) => { e.preventDefault(); if (input.value.trim()) close(input.value.trim()); } },
      el('h2', { text: title }),
      input,
      el('div', { class: 'actions' },
        el('button', { class: 'btn ghost', type: 'button', text: 'Cancel', onclick: () => close(undefined) }),
        el('button', { class: 'btn primary', type: 'submit', text: ok }),
      ),
    );
    setTimeout(() => { input.focus(); input.select(); });
    return form;
  });
}

export function confirm({ title, message, ok = 'Delete', danger = true }: { title: string; message?: string; ok?: string; danger?: boolean }) {
  return dialog<boolean>((close) => [
    el('h2', { text: title }),
    message && el('p', { text: message }),
    el('div', { class: 'actions' },
      el('button', { class: 'btn ghost', text: 'Cancel', onclick: () => close(false) }),
      el('button', { class: `btn ${danger ? 'danger solid' : 'primary'}`, text: ok, onclick: () => close(true), autofocus: true }),
    ),
  ]);
}

// Choose a board. boards: [{id, name}], excluding `exclude`. Resolves with the id, or 'new' to create one.
export function pickBoard({ title, boards, exclude, ok = 'Move', allowNew = true }: {
  title: string;
  boards: { id: number; name: string }[];
  exclude?: number;
  ok?: string;
  allowNew?: boolean;
}) {
  const options = boards.filter((b) => b.id !== exclude);
  return dialog<number | 'new'>((close) => {
    const select = el('select', { class: 'field', autofocus: true },
      ...options.map((b) => el('option', { value: b.id, text: b.name })),
      allowNew && el('option', { value: 'new', text: '+ New board…' }),
    );
    if (!options.length && !allowNew) return [el('h2', { text: title }), el('p', { text: 'No other boards.' }),
      el('div', { class: 'actions' }, el('button', { class: 'btn', text: 'Close', onclick: () => close(undefined) }))];
    return [
      el('h2', { text: title }),
      select,
      el('div', { class: 'actions' },
        el('button', { class: 'btn ghost', text: 'Cancel', onclick: () => close(undefined) }),
        el('button', { class: 'btn primary', text: ok, onclick: () => close(select.value === 'new' ? 'new' : Number(select.value)) }),
      ),
    ];
  });
}
