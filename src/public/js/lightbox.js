import { el } from './ui.js';
import { icon } from './icons.js';
import { originalUrl } from './api.js';

// Full-screen viewer over an ordered pin list. Actions call back into the board view, which
// owns the data; the lightbox just redraws from whatever list it's given. Only the actions passed
// get a button (and the Delete key): a shared board's viewer has none, its editor only Delete.
export function openLightbox({ pins, index, actions = {} }) {
  let i = index;
  let busy = false;   // an action's dialog is open: ignore keys and buttons until it settles
  const img = el('img', { alt: '' });
  const info = el('div', { class: 'info' });
  const counter = el('div', { class: 'counter', 'aria-live': 'polite' });
  const fullSize = el('a', { class: 'btn', target: '_blank', rel: 'noopener' }, icon('arrow-expand-all'), el('span', { text: 'Full size' }));
  const d = el('dialog', { class: 'lightbox' },
    el('div', { class: 'stage' },
      img,
      counter,
      el('button', { class: 'nav prev', 'aria-label': 'Previous', onclick: () => show(i - 1) }, icon('chevron-left')),
      el('button', { class: 'nav next', 'aria-label': 'Next', onclick: () => show(i + 1) }, icon('chevron-right')),
      el('button', { class: 'close', 'aria-label': 'Close', onclick: () => d.close() }, icon('close')),
    ),
    el('div', { class: 'bar' },
      info,
      fullSize,
      actions.setCover && el('button', { class: 'btn', onclick: () => run(actions.setCover) }, icon('image-outline'), el('span', { text: 'Set as cover' })),
      actions.move && el('button', { class: 'btn', onclick: () => run(actions.move, true) }, icon('folder-move-outline'), el('span', { text: 'Move' })),
      actions.remove && el('button', { class: 'btn danger', onclick: () => run(actions.remove, true) }, icon('delete-outline'), el('span', { text: 'Delete' })),
    ),
  );

  // Run an action on the current pin. `leaves`: a truthy result means the pin left the board.
  async function run(action, leaves = false) {
    if (busy) return;
    busy = true;
    try {
      if (await action(pins[i]) && leaves) remove();
    } finally {
      busy = false;
    }
  }

  function show(n) {
    if (!pins.length) return d.close();
    i = (n + pins.length) % pins.length;
    const pin = pins[i];
    img.src = originalUrl(pin);
    fullSize.href = originalUrl(pin);
    counter.textContent = `${i + 1} / ${pins.length}`;
    info.replaceChildren();
    let host = '';
    try { host = pin.source_url ? new URL(pin.source_url).hostname.replace(/^www\./, '') : ''; } catch {}
    const label = pin.page_title || host || 'Uploaded';
    info.append(pin.source_url
      ? el('a', { href: pin.source_url, target: '_blank', rel: 'noopener noreferrer', title: pin.source_url }, icon('open-in-new'), el('span', { text: label }))
      : el('span', { text: label }));
    info.append(el('span', { text: `· ${pin.width}×${pin.height}${pin.animated ? ' · animated' : ''}` }));
    d.querySelectorAll('.nav').forEach((b) => { b.hidden = pins.length < 2; });
  }

  // After a pin leaves the board (moved or deleted), drop it and show the next one.
  function remove() {
    pins.splice(i, 1);
    if (!pins.length) return d.close();
    show(Math.min(i, pins.length - 1));
  }

  d.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowLeft') show(i - 1);
    else if (e.key === 'ArrowRight') show(i + 1);
    else if (e.key === 'Delete' && actions.remove) run(actions.remove, true);   // opens the confirm, never deletes directly
    else if (e.key === 'f' || e.key === 'F') { if (!busy) window.open(originalUrl(pins[i]), '_blank', 'noopener'); }
  });
  d.addEventListener('click', (e) => { if (e.target === d || e.target === img.parentElement) d.close(); });
  d.addEventListener('close', () => d.remove());

  // Controls (bar, arrows, counter, close) fade after a moment without mouse movement or keys,
  // leaving just the image. They stay while hovered or focused, or while an action is running.
  const IDLE_MS = 2000;
  let idleTimer = null;
  const controls = () => d.querySelectorAll('.bar, .nav, .close, .counter');
  // :focus-visible, not :focus-within — showModal() focuses a control, which shouldn't pin them on.
  const engaged = () => busy || [...controls()].some((c) => c.matches(':hover, :focus-visible, :has(:focus-visible)'));
  function wake() {
    d.classList.remove('idle');
    clearTimeout(idleTimer);
    idleTimer = setTimeout(function sleep() {
      if (engaged()) idleTimer = setTimeout(sleep, IDLE_MS);
      else d.classList.add('idle');
    }, IDLE_MS);
  }
  d.addEventListener('pointermove', (e) => { if (e.pointerType === 'mouse') wake(); });
  d.addEventListener('keydown', wake);
  d.addEventListener('close', () => clearTimeout(idleTimer));

  // Touch: swipe between pins; a tap on the image shows or hides the controls (no mouse to wake them).
  let touchX = null;
  d.addEventListener('touchstart', (e) => { touchX = e.touches[0].clientX; }, { passive: true });
  d.addEventListener('touchend', (e) => {
    if (touchX == null) return;
    const dx = e.changedTouches[0].clientX - touchX;
    touchX = null;
    if (Math.abs(dx) > 50) show(dx < 0 ? i + 1 : i - 1);
    else if (e.target === img) {
      if (d.classList.contains('idle')) wake();
      else { clearTimeout(idleTimer); d.classList.add('idle'); }
    }
  });

  document.body.append(d);
  d.showModal();
  // Focus the dialog itself, not its first button: a focused control would keep the controls
  // from fading, and arrow keys are handled on the dialog anyway.
  d.tabIndex = -1;
  d.focus();
  show(i);
  wake();
}
