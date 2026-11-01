// Small DOM helpers, toasts, popup menus and <dialog>-based prompts.

import { icon } from './icons.js';

export function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k === 'class') node.className = v;
    else if (k === 'text') node.textContent = v;
    else if (k === 'html') node.innerHTML = v;
    else if (k.startsWith('on') && typeof v === 'function') node.addEventListener(k.slice(2), v);
    else if (k === 'dataset') Object.assign(node.dataset, v);
    else if (v === true) node.setAttribute(k, '');
    else node.setAttribute(k, v);
  }
  node.append(...children.flat().filter((c) => c != null && c !== false));
  return node;
}

// Toast with a countdown bar along its bottom edge. Hovering pauses both the bar and the dismiss
// timer; `action` makes it clickable (click runs it and dismisses). The extension's in-page toast
// (extension/content.js) mirrors this markup, styling and behaviour.
export function toast(message, { error = false, ms = 3000, action = null } = {}) {
  const t = el(action ? 'button' : 'div', {
    class: `toast${error ? ' error' : ''}${action ? ' clickable' : ''}`,
    role: 'status',
    style: `--toast-ms:${ms}ms`,
    onclick: action && (() => { dismiss(); action(); }),
  }, error && icon('alert-outline'), el('span', { class: 'msg', text: message }), el('span', { class: 'bar' }));
  let timer = null;
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
function toastHome() {
  const box = document.getElementById('toasts');
  const modal = [...document.querySelectorAll('dialog:modal')].at(-1);
  const home = modal || document.body;
  if (box.parentNode !== home) {
    home.append(box);
    if (modal) modal.addEventListener('close', () => document.body.append(box), { once: true });
  }
  return box;
}

// Popup menu anchored to an element. items: [{ label, icon, danger, onclick }] or '-' for a divider.
export function menu(anchor, items) {
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
let openMenu = null;
function onOutside(e) { if (openMenu && !openMenu.contains(e.target)) closeMenu(); }
function onEsc(e) { if (e.key === 'Escape') closeMenu(); }
export function closeMenu() {
  if (!openMenu) return;
  openMenu.remove();
  openMenu = null;
  document.removeEventListener('pointerdown', onOutside, { capture: true });
  document.removeEventListener('keydown', onEsc);
}

// Open a dialog with the given body nodes. Resolves with whatever close(value) is called with
// (undefined on Escape / backdrop click).
export function dialog(build, { className = '' } = {}) {
  return new Promise((resolve) => {
    const d = el('dialog', { class: className });
    let settled = false;
    const close = (value) => {
      if (settled) return;
      settled = true;
      d.close();
      resolve(value);
    };
    d.append(...[build(close)].flat().filter((c) => c != null && c !== false));
    d.addEventListener('close', () => { close(undefined); d.remove(); });
    d.addEventListener('click', (e) => { if (e.target === d) close(undefined); });
    document.body.append(d);
    d.showModal();
  });
}

export function prompt({ title, label = 'Name', value = '', ok = 'Save' }) {
  return dialog((close) => {
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

export function confirm({ title, message, ok = 'Delete', danger = true }) {
  return dialog((close) => [
    el('h2', { text: title }),
    message && el('p', { text: message }),
    el('div', { class: 'actions' },
      el('button', { class: 'btn ghost', text: 'Cancel', onclick: () => close(false) }),
      el('button', { class: `btn ${danger ? 'danger solid' : 'primary'}`, text: ok, onclick: () => close(true), autofocus: true }),
    ),
  ]);
}

// Choose a board. boards: [{id, name}], excluding `exclude`. Resolves with the id, or 'new' to create one.
export function pickBoard({ title, boards, exclude, ok = 'Move', allowNew = true }) {
  const options = boards.filter((b) => b.id !== exclude);
  return dialog((close) => {
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
