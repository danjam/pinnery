// Appearance: mode (system / light / dark) and accent colour, remembered per browser. Each page
// applies the saved choice in an inline <head> script before the stylesheet loads (no flash); this
// module owns the Settings controls. The stylesheet uses light-dark() with `color-scheme`, so
// forcing a mode is one attribute (data-theme); accents swap --accent through data-accent.

import { el } from './ui.js';
import { icon } from './icons.js';

const MODE_KEY = 'pinnery.theme';
const ACCENT_KEY = 'pinnery.accent';

const MODES = [
  { id: 'system', label: 'System', icon: 'theme-light-dark' },
  { id: 'light', label: 'Light', icon: 'weather-sunny' },
  { id: 'dark', label: 'Dark', icon: 'weather-night' },
];
// Swatch colours match the --accent values in app.css (each passes 4.5:1 with white text).
const ACCENTS = [
  { id: 'pink', label: 'Pink', color: '#d6336c' },
  { id: 'green', label: 'Green', color: '#2d8545' },
  { id: 'blue', label: 'Blue', color: '#1971c2' },
  { id: 'orange', label: 'Orange', color: '#c2410c' },
];

function read(key, allowed, fallback) {
  try {
    const v = localStorage.getItem(key);
    return allowed.includes(v) ? v : fallback;
  } catch {
    return fallback;
  }
}

// The defaults (system mode, pink accent) are stored as "nothing", like the attributes.
function save(key, attr, value, fallback) {
  if (value === fallback) delete document.documentElement.dataset[attr];
  else document.documentElement.dataset[attr] = value;
  try {
    if (value === fallback) localStorage.removeItem(key);
    else localStorage.setItem(key, value);
  } catch {}
}

// The favicon is a separate image, so it gets its own accent-coloured copy (the head script does
// the same on load). Pink, the default, is the real file.
function setFavicon(accent) {
  const link = document.querySelector('link[rel=icon]');
  const color = ACCENTS.find((a) => a.id === accent)?.color;
  if (!link || !color) return;
  link.href = accent === 'pink' ? '/icon.svg' : `data:image/svg+xml,${encodeURIComponent(
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><circle cx="16" cy="16" r="14" fill="${color}"/><circle cx="16" cy="13" r="5" fill="#fff"/><path d="M15 18h2v9l-1 2-1-2z" fill="#fff"/></svg>`)}`;
}

// A row of toggle buttons; exactly one is pressed.
function choiceGroup(label, options, value, onPick, render) {
  const group = el('div', { class: 'choices', role: 'radiogroup', 'aria-label': label });
  const draw = () => group.replaceChildren(...options.map((o) => el('button', {
    class: 'choice',
    type: 'button',
    role: 'radio',
    'aria-checked': String(o.id === value),
    onclick: () => { value = o.id; onPick(value); draw(); },
  }, ...render(o))));
  draw();
  return group;
}

// Settings → Appearance.
export function appearanceSection() {
  const modes = choiceGroup('Mode', MODES, read(MODE_KEY, ['light', 'dark'], 'system'),
    (v) => save(MODE_KEY, 'theme', v, 'system'),
    (o) => [icon(o.icon), el('span', { text: o.label })]);
  const accents = choiceGroup('Accent colour', ACCENTS, read(ACCENT_KEY, ['green', 'blue', 'orange'], 'pink'),
    (v) => { save(ACCENT_KEY, 'accent', v, 'pink'); setFavicon(v); },
    (o) => [el('span', { class: 'swatch', style: `background:${o.color}` }), el('span', { text: o.label })]);
  return el('section', {},
    el('h2', { text: 'Appearance' }),
    el('p', { text: 'Remembered in this browser. The extension\'s board picker follows it too.' }),
    el('div', { class: 'setting' }, el('span', { class: 'setting-label', text: 'Mode' }), modes),
    el('div', { class: 'setting' }, el('span', { class: 'setting-label', text: 'Accent' }), accents),
  );
}
