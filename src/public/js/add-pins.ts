// Adding pins to the open board: the + Pin dialog, and drag-drop or paste anywhere on the page.
import { api, errorMessage } from './api.ts';
import type { Pin } from './api.ts';
import { el, toast, dialog } from './ui.ts';
import { state, openBoard, within, canAdd, dropcover } from './page.ts';
import { renderBoardHeader, renderGrid } from './app.ts';

// ---- adding pins --------------------------------------------------------------------------

function addedPin(pin: Pin) {
  if (state.board?.id !== pin.board_id) return;
  state.pins.unshift(pin);
  renderBoardHeader();
  renderGrid();
}

// Shared by the dialog, drag-drop and paste. `report(name, status, error)` gets progress; status
// is busy | ok | err.
type Report = (name: string, status: 'busy' | 'ok' | 'err', error?: string) => void;

async function addFiles(boardId: number, files: File[], report: Report = () => {}) {
  for (const file of files) {
    if (!file.type.startsWith('image/') && file.type !== '') { report(file.name, 'err', 'not an image'); continue; }
    report(file.name, 'busy');
    try {
      addedPin(await api.upload(boardId, file));
      report(file.name, 'ok');
    } catch (e) {
      report(file.name, 'err', errorMessage(e));
    }
  }
}

async function addUrl(boardId: number, url: string, report: Report = () => {}) {
  report(url, 'busy');
  try {
    addedPin(await api.pinFromUrl(boardId, url));
    report(url, 'ok');
  } catch (e) {
    report(url, 'err', errorMessage(e));
  }
}

const isHttpUrl = (s: string) => /^https?:\/\/\S+$/i.test(s.trim());

export function addPinDialog() {
  const board = openBoard();
  const boardId = board.id;
  dialog((close) => {
    const progress = el('div', { class: 'progress' });
    const lines = new Map();
    const WORDS = { busy: 'adding…', ok: 'added' };
    const report: Report = (name, status, error) => {
      const short = name.length > 48 ? `${name.slice(0, 45)}…` : name;
      let line = lines.get(name);
      if (!line) { line = el('div'); lines.set(name, line); progress.prepend(line); }
      line.className = status === 'err' ? 'err' : status === 'ok' ? 'ok' : '';
      line.replaceChildren(el('span', { text: short }), el('span', { text: status === 'err' ? error : WORDS[status] }));
    };

    const urlInput = el('input', { class: 'field', type: 'url', placeholder: 'Paste an image URL', autofocus: true });
    const submitUrl = () => {
      const url = urlInput.value.trim();
      if (!url) return;
      urlInput.value = '';
      addUrl(boardId, url, report);
    };
    const fileInput: HTMLInputElement = el('input', { type: 'file', accept: 'image/*', multiple: true, onchange: () => {
      addFiles(boardId, [...fileInput.files ?? []], report);
      fileInput.value = '';
    } });
    const drop = el('label', { class: 'dropzone' },
      el('div', { text: 'Drop images here, or click to choose files' }),
      fileInput,
    );
    drop.addEventListener('dragover', (e) => { e.preventDefault(); drop.classList.add('over'); });
    drop.addEventListener('dragleave', () => drop.classList.remove('over'));
    drop.addEventListener('drop', (e) => {
      e.preventDefault();
      e.stopPropagation();
      drop.classList.remove('over');
      addFiles(boardId, [...e.dataTransfer?.files ?? []], report);
    });

    const form = el('form', { onsubmit: (e) => { e.preventDefault(); submitUrl(); } },
      el('h2', { text: `Add to “${board.name}”` }),
      el('div', { class: 'row' }, urlInput, el('button', { class: 'btn primary', type: 'submit', text: 'Add' })),
      drop,
      el('p', { text: 'Or paste an image or URL with Ctrl+V / ⌘V.', style: 'margin-top:var(--space-3);font-size:13px' }),
      progress,
      el('div', { class: 'actions' }, el('button', { class: 'btn', type: 'button', text: 'Done', onclick: () => close(true) })),
    );
    form.addEventListener('paste', (e) => {
      const files = [...e.clipboardData?.files ?? []];
      if (files.length) { e.preventDefault(); addFiles(boardId, files, report); }
    });
    return form;
  });
}

// Drag-drop files anywhere on a board page the user can add to.
const addable = () => state.board && canAdd(state.board);
let dragDepth = 0;
document.addEventListener('dragenter', (e) => {
  if (!addable() || !e.dataTransfer?.types.includes('Files') || within(e.target, 'dialog')) return;
  dragDepth++;
  dropcover.hidden = false;
});
document.addEventListener('dragleave', () => {
  if (dragDepth > 0 && --dragDepth === 0) dropcover.hidden = true;
});
document.addEventListener('dragover', (e) => { if (addable()) e.preventDefault(); });
document.addEventListener('drop', (e) => {
  dragDepth = 0;
  dropcover.hidden = true;
  const board = state.board;
  if (!board || !canAdd(board) || within(e.target, 'dialog')) return;
  e.preventDefault();
  const files = [...e.dataTransfer?.files ?? []];
  if (files.length) addFiles(board.id, files, toastReport);
});

// Paste anywhere: image files, or a URL, go to the current board.
document.addEventListener('paste', (e) => {
  if (within(e.target, 'dialog, input, textarea')) return;
  const files = [...e.clipboardData?.files ?? []];
  const text = e.clipboardData?.getData('text/plain') ?? '';
  if (!files.length && !isHttpUrl(text)) return;
  const board = state.board;
  if (!board) { toast('Open a board to paste into it'); return; }
  if (!canAdd(board)) { toast('You can only look at this board'); return; }
  e.preventDefault();
  if (files.length) addFiles(board.id, files, toastReport);
  else addUrl(board.id, text.trim(), toastReport);
});

const toastReport: Report = (name, status, error) => {
  if (status === 'ok') toast('Pin added');
  else if (status === 'err') toast(`Couldn't add: ${error}`, { error: true, ms: 5000 });
};
