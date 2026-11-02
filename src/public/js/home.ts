// The home page (the board list) and the board actions: new, rename, share, delete.
import { api, thumbUrl, exportUrl, errorMessage } from './api.ts';
import type { Board, BoardInfo, Share, Person } from './api.ts';
import { el, toast, menu, dialog, prompt, confirm } from './ui.ts';
import type { MenuItem } from './ui.ts';
import { icon } from './icons.ts';
import { view, actionsEl, state, setCrumbs, moreButton, isOwner, sharedBy, pinnable, signOut } from './page.ts';
import { navigate, renderBoardHeader } from './app.ts';

// ---- home ---------------------------------------------------------------------------------

export async function showHome() {
  state.board = null;
  state.pins = [];
  state.tiles.clear();
  state.boards = await api.boards();
  renderHome();
}

// A live update (live.ts) while the home page is open: refetch, and redraw if anything changed and
// the page is still the home page.
export async function refreshHome() {
  const boards = await api.boards();
  if (state.board || location.pathname !== '/') return;
  if (JSON.stringify(boards) === JSON.stringify(state.boards)) return;
  state.boards = boards;
  renderHome();
}

function renderHome() {
  document.title = 'Pinnery';
  setCrumbs();
  actionsEl.replaceChildren(
    el('button', { class: 'btn primary', onclick: newBoard }, icon('plus'), el('span', { text: 'New board' })),
    moreButton('Menu', [
      { label: 'Settings', icon: 'cog-outline', onclick: () => navigate('/settings') },
      '-',
      { label: 'Sign out', icon: 'logout', onclick: signOut },
    ]),
  );

  if (!state.boards.length) {
    view.replaceChildren(el('div', { class: 'empty' },
      el('h2', { text: 'Create your first board' }),
      el('p', { text: 'Boards hold your pins. Start one, then save images into it from the web or from here.' }),
      el('button', { class: 'btn primary', onclick: newBoard }, icon('plus'), el('span', { text: 'New board' })),
    ));
    return;
  }
  const grid = el('div', { class: 'boards' });
  for (const b of state.boards) grid.append(boardTile(b));
  grid.append(el('a', { class: 'board-tile new', href: '#', onclick: (e) => { e.preventDefault(); newBoard(); } },
    el('div', { class: 'cover' }, icon('plus')),
    el('div', { class: 'name', text: 'New board' }),
  ));
  view.replaceChildren(grid);
}

function boardTile(b: Board) {
  const cover = el('div', { class: 'cover' });
  if (b.cover) {
    const img = el('img', { src: thumbUrl(b.cover, 400), alt: '', loading: 'lazy' });
    cover.append(img);
  } else {
    cover.append(icon('image-outline'));
  }
  return el('a', { class: 'board-tile', href: `/b/${b.id}`, 'data-link': true },
    cover,
    el('div', { class: 'name', text: b.name }),
    el('div', { class: 'meta', text: `${b.pin_count} ${b.pin_count === 1 ? 'pin' : 'pins'}${isOwner(b) ? '' : ` · ${sharedBy(b)}`}` }),
    isOwner(b) && el('button', { class: 'btn icon-only more', 'aria-label': 'Board menu', onclick: (e) => {
      e.preventDefault();
      e.stopPropagation();
      menu(e.currentTarget, ownerItems(b));
    } }, icon('dots-horizontal')),
  );
}

// A board as the home page lists it, or the open board (which has no pin count of its own).
type OwnedBoard = BoardInfo & { pin_count?: number };

// The owner's board menu. Everything here is theirs alone.
export function ownerItems(b: OwnedBoard): MenuItem[] {
  return [
    { label: 'Rename', icon: 'pencil-outline', onclick: () => renameBoard(b) },
    { label: 'Share…', icon: 'share-variant-outline', onclick: () => shareBoard(b) },
    { label: 'Export board', icon: 'tray-arrow-down', onclick: () => location.assign(exportUrl(b.id)) },
    { label: 'Delete board', icon: 'delete-outline', danger: true, onclick: () => deleteBoard(b) },
  ];
}

// Share a board: who has it and as what, with a role to change or a Remove; below, everyone else
// as "Name · email" (the email masked for non-admins), filtered by name as you type, added as a
// viewer or an editor with one click.
async function shareBoard(b: BoardInfo) {
  let [shares, people] = await Promise.all([api.shares(b.id), api.directory()]);
  const report = (err: unknown) => toast(errorMessage(err), { error: true, ms: 6000 });
  await dialog((close) => {
    const current = el('div', { class: 'tokens' });
    const others = el('div', { class: 'tokens' });
    const filter = el('input', { class: 'field', placeholder: 'Find someone by name', autocomplete: 'off', spellcheck: false, oninput: () => drawOthers() });

    function drawCurrent() {
      if (!shares.length) return current.replaceChildren(el('p', { class: 'muted', text: 'Only you can see this board.' }));
      current.replaceChildren(...shares.map((s) => el('div', { class: 'token' },
        el('div', { class: 'token-info' },
          el('div', { class: 'token-name', text: s.display_name }),
          el('div', { class: 'muted', text: s.email }),
        ),
        el('select', { class: 'field role', 'aria-label': `Role for ${s.display_name}`, onchange: (e) => setRole(s, e.currentTarget.value as Share['role']) },   // only those two options
          el('option', { value: 'viewer', text: 'Viewer', selected: s.role === 'viewer' }),
          el('option', { value: 'editor', text: 'Editor', selected: s.role === 'editor' }),
        ),
        el('button', { class: 'btn ghost icon-only', 'aria-label': `Remove ${s.display_name}`, onclick: () => remove(s) }, icon('close')),
      )));
    }

    function drawOthers() {
      const q = filter.value.trim().toLowerCase();
      const have = new Set(shares.map((s) => s.user_id));
      const shown = people.filter((p) => !have.has(p.id) && (!q || p.display_name.toLowerCase().includes(q)));
      if (!shown.length) return others.replaceChildren(el('p', { class: 'muted', text: people.length > have.size ? 'Nobody matches.' : 'Everyone already has it.' }));
      others.replaceChildren(...shown.map((p) => el('div', { class: 'token' },
        el('div', { class: 'token-info' }, el('div', { class: 'token-name', text: `${p.display_name} · ${p.email}` })),
        el('button', { class: 'btn', text: 'Viewer', onclick: () => add(p, 'viewer') }),
        el('button', { class: 'btn', text: 'Editor', onclick: () => add(p, 'editor') }),
      )));
    }

    const draw = () => { drawCurrent(); drawOthers(); };

    async function add(p: Person, role: Share['role']) {
      try {
        const s = await api.setShare(b.id, p.id, role);
        shares.push(s);
        toast(`Shared with ${p.display_name} as ${role}`);
        draw();
      } catch (err) { report(err); }
    }
    async function setRole(s: Share, role: Share['role']) {
      try {
        Object.assign(s, await api.setShare(b.id, s.user_id, role));
        toast(`${s.display_name} is now ${role === 'editor' ? 'an editor' : 'a viewer'}`);
      } catch (err) { report(err); drawCurrent(); }
    }
    async function remove(s: Share) {
      try {
        await api.removeShare(b.id, s.user_id);
        shares = shares.filter((x) => x.user_id !== s.user_id);
        toast(`Removed ${s.display_name}`);
        draw();
      } catch (err) { report(err); }
    }

    draw();
    return [
      el('h2', { text: `Share “${b.name}”` }),
      el('p', { text: 'Viewers can look at the board. Editors can also add pins to it and delete pins in it. Renaming, deleting, the cover and moving pins out stay yours.' }),
      current,
      el('h3', { text: 'Add someone' }),
      filter,
      others,
      el('div', { class: 'actions' }, el('button', { class: 'btn primary', text: 'Done', onclick: () => close(true) })),
    ];
  }, { className: 'share' });
}

async function newBoard() {
  const name = await prompt({ title: 'New board', label: 'Board name', ok: 'Create' });
  if (!name) return null;
  const b = await api.createBoard(name);
  toast(`Created “${b.name}”`);
  if (!state.board) await showHome();
  return b;
}

async function renameBoard(b: BoardInfo) {
  const name = await prompt({ title: 'Rename board', value: b.name, ok: 'Rename' });
  if (!name || name === b.name) return;
  await api.updateBoard(b.id, { name });
  if (state.board?.id === b.id) { state.board.name = name; renderBoardHeader(); } else await showHome();
}

// Delete a board: pins can be moved to another board or deleted with it.
async function deleteBoard(b: OwnedBoard) {
  const others = pinnable(state.boards.length ? state.boards : await api.boards()).filter((x) => x.id !== b.id);
  const count = b.pin_count ?? state.pins.length;
  type Choice = { action: 'delete' } | { action: 'move'; to: number };
  let result: Choice | null | undefined;
  if (!count) {
    result = (await confirm({ title: `Delete “${b.name}”?`, message: 'This board is empty.' })) ? { action: 'delete' } : null;
  } else {
    result = await dialog<Choice>((close) => {
      const select = el('select', { class: 'field', disabled: !others.length },
        ...others.map((o) => el('option', { value: o.id, text: o.name })));
      const moveRadio = el('input', { type: 'radio', name: 'what', value: 'move', checked: others.length > 0, disabled: !others.length });
      const delRadio = el('input', { type: 'radio', name: 'what', value: 'delete', checked: !others.length });
      const sync = () => { select.disabled = !moveRadio.checked; };
      moveRadio.onchange = delRadio.onchange = sync;
      return [
        el('h2', { text: `Delete “${b.name}”?` }),
        el('p', { text: `It has ${count} ${count === 1 ? 'pin' : 'pins'}.` }),
        el('label', { class: 'inline' }, moveRadio, el('span', { text: 'Move the pins to' })),
        select,
        el('label', { class: 'inline' }, delRadio, el('span', { text: 'Delete the pins too' })),
        el('div', { class: 'actions' },
          el('button', { class: 'btn ghost', text: 'Cancel', onclick: () => close(undefined) }),
          el('button', { class: 'btn danger solid', text: 'Delete board', onclick: () =>
            close(moveRadio.checked ? { action: 'move', to: Number(select.value) } : { action: 'delete' }) }),
        ),
      ];
    });
  }
  if (!result) return;
  await api.deleteBoard(b.id, result.action === 'move' ? result.to : null);
  toast(`Deleted “${b.name}”`);
  if (state.board?.id === b.id) navigate('/'); else await showHome();
}
