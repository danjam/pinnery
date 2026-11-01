import { api, thumbUrl, exportUrl, errorMessage, apiError } from './api.ts';
import type { Board, BoardInfo, Pin, Role, Share, Person, Me, AdminUser, EmailedLink } from './api.ts';
import { el, toast, menu, dialog, prompt, confirm, pickBoard } from './ui.ts';
import type { MenuItem, MenuEntry } from './ui.ts';
import { icon } from './icons.ts';
import { layout } from './masonry.ts';
import { openLightbox } from './lightbox.ts';
import { appearanceSection } from './theme.ts';

// index.html has all of these.
const view = document.getElementById('view')!;
const titleEl = document.getElementById('title')!;
const actionsEl = document.getElementById('actions')!;
const selectbar = document.getElementById('selectbar')!;
const selectCount = document.getElementById('selectcount')!;
const selMove = document.getElementById('sel-move') as HTMLButtonElement;
const selDelete = document.getElementById('sel-delete') as HTMLButtonElement;
const selCancel = document.getElementById('sel-cancel')!;
const dropcover = document.getElementById('dropcover')!;

const state: {
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
  tiles: new Map(),   // pin id -> tile element, reused across re-layouts
};

// The open board, for the functions that only run on a board's page.
function openBoard(): BoardInfo {
  if (!state.board) throw new Error('no board is open');
  return state.board;
}

// Is the event's target inside an element matching the selector? (Targets can be non-elements.)
const within = (target: EventTarget | null, selector: string) => target instanceof Element && target.closest(selector) !== null;

// Chrome's install offer isn't in lib.dom.
interface BeforeInstallPromptEvent extends Event {
  prompt(): Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>;
}
declare global {
  interface WindowEventMap { beforeinstallprompt: BeforeInstallPromptEvent }
}

// ---- routing ------------------------------------------------------------------------------

function navigate(path: string) {
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

// ---- home ---------------------------------------------------------------------------------

async function showHome() {
  state.board = null;
  state.pins = [];
  state.tiles.clear();
  state.boards = await api.boards();
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

// Breadcrumb after "Pinnery": nothing on the home page, else "/ <title>" with an optional count
// and note (both dimmed), e.g. "/ Trips (12) shared by Sam".
function setCrumbs(title?: string, count?: number, note?: string) {
  titleEl.replaceChildren();
  if (title == null) return;
  titleEl.append(el('span', { class: 'sep', text: '/' }), el('span', { class: 'crumb', text: title }));
  if (count != null) titleEl.append(el('span', { class: 'count', text: `(${count})` }));
  if (note) titleEl.append(el('span', { class: 'count', text: note }));
}

function moreButton(label: string, items: MenuEntry[]) {
  return el('button', { class: 'btn icon-only ghost', 'aria-label': label, onclick: (e) => menu(e.currentTarget, items) }, icon('dots-horizontal'));
}

// A board's `role` is the user's standing on it: owner, or editor / viewer of a board shared with
// them (`owner_name` says by whom). Owners do everything; editors add and delete pins; viewers look.
const isOwner = (b: { role: Role }) => b.role === 'owner';
const canAdd = (b: { role: Role }) => b.role !== 'viewer';
const sharedBy = (b: BoardInfo) => (isOwner(b) ? '' : `shared by ${b.owner_name}`);
// Boards the user can pin into, named for a picker — shared ones say so.
const pinnable = <B extends BoardInfo>(boards: B[]): B[] => boards.filter(canAdd).map((b) => ({ ...b, name: isOwner(b) ? b.name : `${b.name} (${sharedBy(b)})` }));

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
function ownerItems(b: OwnedBoard): MenuItem[] {
  return [
    { label: 'Rename', icon: 'pencil-outline', onclick: () => renameBoard(b) },
    { label: 'Share…', icon: 'share-variant-outline', onclick: () => shareBoard(b) },
    { label: 'Export board', icon: 'tray-arrow-down', onclick: () => location.assign(exportUrl(b.id)) },
    { label: 'Delete board', icon: 'delete-outline', danger: true, onclick: () => deleteBoard(b) },
  ];
}

// Share a board: who has it and as what, with a role to change or a Remove; below, everyone else
// as "Name · email", filtered as you type, added as a viewer or an editor with one click.
async function shareBoard(b: BoardInfo) {
  let [shares, people] = await Promise.all([api.shares(b.id), api.directory()]);
  const report = (err: unknown) => toast(errorMessage(err), { error: true, ms: 6000 });
  await dialog((close) => {
    const current = el('div', { class: 'tokens' });
    const others = el('div', { class: 'tokens' });
    const filter = el('input', { class: 'field', placeholder: 'Find someone by name or email', autocomplete: 'off', spellcheck: false, oninput: () => drawOthers() });

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
      const shown = people.filter((p) => !have.has(p.id) && (!q || `${p.display_name} ${p.email}`.toLowerCase().includes(q)));
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

async function signOut() {
  await api.logout();
  location.href = '/login';
}

// ---- settings -----------------------------------------------------------------------------

const when = (iso: string | null) => (iso ? new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }) : 'never');
const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;

// An emailed link the server handed back ({ email, link, sent, error }): what happened to the email,
// and Copy/Share buttons for passing the link on by hand.
const linkStatus = ({ email, sent, error }: Pick<EmailedLink, 'email' | 'sent' | 'error'>) => (sent
  ? `Emailed to ${email}. You can also pass the link on yourself:`
  : error
    ? `Couldn’t email ${email} (${error}). Send them this link instead:`
    : `Send ${email} this link (email isn’t set up here):`);

function linkButtons(link: string, { title, text }: { title: string; text: string }) {
  const copy = el('button', { class: 'btn', text: 'Copy', onclick: async () => {
    try { await navigator.clipboard.writeText(link); toast('Link copied'); } catch { toast('Couldn’t copy — select the link instead', { error: true }); }
  } });
  const share = navigator.share && el('button', { class: 'btn', text: 'Share', onclick: () => navigator.share({ title, text, url: link }).catch(() => {}) });
  return el('div', { class: 'row' }, copy, share);
}

// Settings → Users (admins). Everyone with an account as "Name · email", and a menu per user: admin
// on or off, a password reset link to hand over (emailed too when mail is on), delete with counts.
// Demoting or deleting someone signs them out everywhere at once — yourself included.
function usersSection(me: Me) {
  const list = el('div', { class: 'tokens' });

  async function render() {
    const users = await api.users();
    list.replaceChildren(...users.map((u) => el('div', { class: 'token' },
      el('div', { class: 'token-info' },
        el('div', { class: 'token-name' },
          el('span', { text: `${u.display_name} · ${u.email}` }),
          u.is_admin && el('span', { class: 'tag', text: 'Admin' }),
        ),
        el('div', { class: 'muted', text: `${plural(u.boards, 'board')} · ${plural(u.pins, 'pin')} · last active ${when(u.last_seen_at)}` }),
      ),
      moreButton(`Options for ${u.display_name}`, userItems(u)),
    )));
  }

  function userItems(u: AdminUser): MenuEntry[] {
    const self = u.id === me.id;
    const remove: MenuEntry[] = self ? [] : ['-', { label: 'Delete user', icon: 'delete-outline', danger: true, onclick: () => deleteUser(u) }];
    return [
      u.is_admin
        ? { label: 'Remove admin', onclick: () => setAdmin(u, false) }
        : { label: 'Make admin', onclick: () => setAdmin(u, true) },
      { label: 'Reset password', onclick: () => resetPassword(u) },
      ...remove,
    ];
  }

  const report = (err: unknown) => toast(errorMessage(err), { error: true, ms: 6000 });

  async function setAdmin(u: AdminUser, isAdmin: boolean) {
    if (!isAdmin) {
      const who = u.id === me.id ? 'You’ll' : 'They’ll';
      const ok = await confirm({ title: `Remove admin from ${u.display_name}?`, message: `${who} be signed out everywhere, extension included, and keep ${u.id === me.id ? 'your' : 'their'} boards.`, ok: 'Remove admin' });
      if (!ok) return;
    }
    try {
      await api.setAdmin(u.id, isAdmin);
      toast(isAdmin ? `${u.display_name} is now an admin` : `${u.display_name} is no longer an admin`);
      await render();
    } catch (err) {
      report(err);
    }
  }

  async function resetPassword(u: AdminUser) {
    let r: EmailedLink;
    try { r = await api.resetUser(u.id); } catch (err) { return report(err); }
    await dialog((close) => [
      el('h2', { text: `Reset link for ${u.display_name}` }),
      el('p', { class: r.error ? 'error' : null, text: linkStatus(r) }),
      el('code', { class: 'link', text: r.link }),
      linkButtons(r.link, { title: 'Reset your Pinnery password', text: `A password reset link for ${u.email}` }),
      el('p', { text: `Works once, expires ${when(r.expires_at)}. It can’t be shown again — make another if it’s lost.` }),
      el('div', { class: 'actions' }, el('button', { class: 'btn primary', text: 'Done', onclick: () => close(true), autofocus: true })),
    ]);
  }

  async function deleteUser(u: AdminUser) {
    const ok = await confirm({
      title: `Delete ${u.display_name}?`,
      message: `${plural(u.boards, 'board')} and ${plural(u.pins, 'pin')} will be deleted, along with their sessions, extension tokens and pending invites. This can’t be undone.`,
      ok: 'Delete user',
    });
    if (!ok) return;
    try {
      await api.deleteUser(u.id);
      toast(`Deleted ${u.display_name}`);
      await render();
    } catch (err) {
      report(err);
    }
  }

  render().catch(report);
  return el('section', {},
    el('h2', { text: 'Users' }),
    el('p', { text: 'Everyone with an account. Admins can invite and manage users; the last admin can’t be removed. Deleting a user deletes their boards and pins.' }),
    list,
  );
}

// Settings → Invite someone (admins). An invite is a single-use signup link for one email, good
// for 24 hours. Only its hash is kept, so the link is shown once, here, with Copy and Share — and
// emailed too when mail is set up. Pending invites are listed and can be cancelled.
function invitesSection(mail: boolean) {
  const emailInput = el('input', { class: 'field', type: 'email', placeholder: 'Email address', required: true, autocomplete: 'off', spellcheck: false });
  const result = el('div');
  const list = el('div', { class: 'tokens' });

  async function renderInvites() {
    const invites = await api.invites();
    if (!invites.length) return list.replaceChildren(el('p', { class: 'muted', text: 'No pending invites.' }));
    list.replaceChildren(...invites.map((i) => el('div', { class: 'token' },
      el('div', { class: 'token-info' },
        el('div', { class: 'token-name', text: i.email }),
        el('div', { class: 'muted', text: `Invited ${when(i.created_at)} · expires ${when(i.expires_at)}` }),
      ),
      el('button', { class: 'btn danger', text: 'Cancel', onclick: async () => {
        await api.cancelInvite(i.id);
        toast(`Cancelled the invite for ${i.email}`);
        await renderInvites();
      } }),
    )));
  }

  function showLink(invite: EmailedLink) {
    result.replaceChildren(el('div', { class: 'linkbox' },
      el('p', { class: invite.error ? 'error' : 'muted', text: linkStatus(invite) }),
      el('code', { text: invite.link }),
      linkButtons(invite.link, { title: 'Join Pinnery', text: `An invite to Pinnery for ${invite.email}` }),
      el('p', { class: 'muted', text: `Works once, expires ${when(invite.expires_at)}. It can\u2019t be shown again — cancel and re-invite if it\u2019s lost.` }),
    ));
  }

  async function invite(email: string): Promise<void> {
    try {
      showLink(await api.createInvite(email));
      emailInput.value = '';
      await renderInvites();
    } catch (err) {
      const data = apiError(err)?.data;
      if (data?.code === 'pending_invite') {
        const again = await confirm({ title: `${email} already has a pending invite`, message: 'Cancel it and send a new one?', ok: 'Cancel and re-invite', danger: false });
        if (!again) return;
        await api.cancelInvite(data.invite_id!);   // the pending_invite error always carries it
        return invite(email);
      }
      toast(errorMessage(err), { error: true, ms: 6000 });
    }
  }

  const form = el('form', { class: 'invite-form' }, emailInput, el('button', { class: 'btn primary', type: 'submit', text: 'Invite' }));
  form.addEventListener('submit', (e) => { e.preventDefault(); invite(emailInput.value.trim()); });
  renderInvites().catch((err) => toast(errorMessage(err), { error: true }));

  return el('section', {},
    el('h2', { text: 'Invite someone' }),
    el('p', { text: mail
      ? 'They get an email with a signup link locked to their address, good for 24 hours. The link is shown here too, to copy or share.'
      : 'Email isn\u2019t set up here, so you pass the signup link on yourself: it\u2019s locked to their address and good for 24 hours.' }),
    form,
    result,
    el('h2', { text: 'Pending invites', style: 'margin-top: var(--space-4)' }),
    list,
  );
}

async function showSettings(tab?: string) {
  state.board = null;
  state.pins = [];
  state.tiles.clear();
  document.title = 'Settings — Pinnery';
  setCrumbs('Settings');
  actionsEl.replaceChildren(moreButton('Menu', [
    { label: 'Sign out', icon: 'logout', onclick: signOut },
  ]));

  const tokenList = el('div', { class: 'tokens' });
  async function renderTokens() {
    const tokens = await api.tokens();
    if (!tokens.length) {
      tokenList.replaceChildren(el('p', { class: 'muted', text: 'No tokens yet. Connecting the extension creates one.' }));
      return;
    }
    tokenList.replaceChildren(...tokens.map((t) => el('div', { class: 'token' },
      el('div', { class: 'token-info' },
        el('div', { class: 'token-name', text: t.name }),
        el('div', { class: 'muted', text: `Created ${when(t.created_at)} · last used ${when(t.last_used_at)}` }),
      ),
      el('button', { class: 'btn danger', text: 'Revoke', onclick: async () => {
        if (!(await confirm({ title: `Revoke “${t.name}”?`, message: 'The extension using this token will have to be connected again.', ok: 'Revoke' }))) return;
        await api.revokeToken(t.id);
        toast(`Revoked “${t.name}”`);
        await renderTokens();
      } }),
    )));
  }
  await renderTokens();

  // Account: who's signed in, with an editable display name. The email changes only through a
  // link sent to the new address, so it needs mail to be set up.
  const [me, { enabled: mail }] = await Promise.all([api.me(), api.mail().catch(() => ({ enabled: false }))]);
  const nameInput = el('input', { class: 'field', value: me.display_name, maxlength: 100, required: true, autocomplete: 'nickname' });
  const accountForm = el('form', { class: 'account-form' },
    el('label', { class: 'stacked' }, el('span', { text: 'Display name' }), nameInput),
    el('label', { class: 'stacked' }, el('span', { text: 'Email' }), el('input', { class: 'field', value: me.email, readonly: true })),
    el('div', { class: 'row' }, el('button', { class: 'btn primary', type: 'submit', text: 'Save' })));
  accountForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      const updated = await api.updateMe({ display_name: nameInput.value });
      nameInput.value = updated.display_name;
      toast('Display name saved');
    } catch (err) {
      toast(errorMessage(err), { error: true });
    }
  });

  // Password: current + new (twice). The user's other browsers are signed out; this one and their
  // tokens stay.
  const pwField = (label: string, autocomplete: string): [HTMLInputElement, HTMLLabelElement] => {
    const input = el('input', { class: 'field', type: 'password', autocomplete, required: true });
    return [input, el('label', { class: 'stacked' }, el('span', { text: label }), input)];
  };
  const [pwCurrent, pwCurrentRow] = pwField('Current password', 'current-password');
  const [pwNew, pwNewRow] = pwField('New password (at least 8 characters)', 'new-password');
  const [pwAgain, pwAgainRow] = pwField('New password again', 'new-password');
  const pwForm = el('form', { class: 'password-form' }, pwCurrentRow, pwNewRow, pwAgainRow,
    el('div', { class: 'row' }, el('button', { class: 'btn primary', type: 'submit', text: 'Change password' })));
  pwForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (pwNew.value !== pwAgain.value) return toast('The new passwords don\u2019t match', { error: true });
    try {
      await api.changePassword(pwCurrent.value, pwNew.value);
      pwForm.reset();
      toast('Password changed. Other browsers are signed out.');
    } catch (err) {
      toast(errorMessage(err), { error: true });
    }
  });

  const emailInput = el('input', { class: 'field', type: 'email', required: true, autocomplete: 'email', spellcheck: false });
  const emailPw = el('input', { class: 'field', type: 'password', required: true, autocomplete: 'current-password' });
  const emailForm = el('form', { class: 'email-form' },
    el('label', { class: 'stacked' }, el('span', { text: 'New email' }), emailInput),
    el('label', { class: 'stacked' }, el('span', { text: 'Current password' }), emailPw),
    el('div', { class: 'row' }, el('button', { class: 'btn primary', type: 'submit', text: 'Send confirmation' })));
  emailForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      const { email } = await api.requestEmailChange(emailInput.value, emailPw.value);
      emailForm.reset();
      await dialog((close) => [
        el('h2', { text: 'Check your inbox' }),
        el('p', { text: `We've sent a link to ${email}. Your sign-in email changes when you click it; the link works once and expires in 24 hours.` }),
        el('div', { class: 'actions' }, el('button', { class: 'btn primary', text: 'OK', onclick: () => close(true), autofocus: true })),
      ]);
    } catch (err) {
      toast(errorMessage(err), { error: true, ms: 6000 });
    }
  });

  // Import: the chosen zip is posted as-is; the server answers with counts, shown in a dialog.
  const importInput = el('input', { type: 'file', accept: '.zip,application/zip', hidden: true });
  const importButton = el('button', { class: 'btn primary', text: 'Import zip…', onclick: () => importInput.click() });
  importInput.addEventListener('change', async () => {
    const file = importInput.files?.[0];
    importInput.value = '';
    if (!file) return;
    importButton.disabled = true;
    importButton.textContent = 'Importing…';
    try {
      const s = await api.importZip(file);
      state.boards = [];
      await dialog((close) => [
        el('h2', { text: 'Import complete' }),
        el('p', { text: `Boards: ${s.boards_created} created, ${s.boards_merged} merged into existing. Pins: ${s.pins_added} added, ${s.pins_skipped} already present.` }),
        el('div', { class: 'actions' }, el('button', { class: 'btn primary', text: 'OK', onclick: () => close(true), autofocus: true })),
      ]);
    } catch (e) {
      toast(errorMessage(e), { error: true, ms: 6000 });
    } finally {
      importButton.disabled = false;
      importButton.textContent = 'Import zip…';
    }
  });

  // Tabs, each a stack of panels. The tab is part of the URL (/settings/<id>), so reloads and
  // links keep it; switching tabs swaps the panels in place without reloading the data.
  const tabs = [
    { id: 'appearance', label: 'Appearance', panels: () => [appearanceSection()] },
    { id: 'devices', label: 'Devices', panels: () => [
      appSection(),
      el('section', {},
        el('h2', { text: 'Chrome extension' }),
        el('p', { text: 'Right-click any image on the web and pin it to a board. Install it from the zip:' }),
        el('ol', {},
          el('li', { html: 'Download and unzip <code>pinnery-extension.zip</code> somewhere permanent — Chrome loads it from that folder.' }),
          el('li', { html: 'Open <code>chrome://extensions</code>, turn on <b>Developer mode</b> (top right), click <b>Load unpacked</b> and choose the unzipped <code>pinnery-extension</code> folder.' }),
          el('li', { html: 'Click <b>Details → Extension options</b> (or the Pinnery toolbar icon), enter this server\'s address and click <b>Connect</b>. Sign in here if asked and allow it; the extension gets its own token, listed under API tokens. It never sees your password.' }),
        ),
        el('a', { class: 'btn primary', href: '/extension.zip', text: 'Download Chrome extension' }),
      ),
      el('section', {},
        el('h2', { text: 'API tokens' }),
        el('p', { text: 'Each connected extension has its own token. Revoke one to sign that browser out of Pinnery.' }),
        tokenList,
      ),
    ] },
    { id: 'account', label: 'Account', panels: () => [
      el('section', {},
        el('h2', { text: 'Profile' }),
        el('p', {}, el('span', { text: 'Signed in as ' }), el('b', { text: me.display_name })),
        accountForm,
      ),
      el('section', {},
        el('h2', { text: 'Password' }),
        el('p', { text: 'Changing your password signs out your other browsers; extension tokens keep working.' }),
        pwForm,
      ),
      el('section', {},
        el('h2', { text: 'Change email' }),
        el('p', { text: mail
          ? 'Enter the new address and your password. We\u2019ll send a link there; nothing changes until you click it.'
          : 'Email isn\u2019t set up on this Pinnery, so your sign-in email can\u2019t be changed here.' }),
        mail && emailForm,
      ),
    ] },
    me.is_admin && { id: 'users', label: 'Users', panels: () => [invitesSection(mail), usersSection(me)] },
    { id: 'data', label: 'Import/Export', panels: () => [
      el('section', {},
        el('h2', { text: 'Export / import' }),
        el('p', { text: 'Export is a zip with a folder of original images per board and a pins.json of sources, titles and dates. Import the same zip here or on another Pinnery: boards are created or merged by name, and pins a board already has are skipped. A single board can be exported from its menu.' }),
        el('div', { class: 'row' },
          el('a', { class: 'btn primary', href: exportUrl(), text: 'Export all boards' }),
          importButton,
          importInput,
        ),
      ),
    ] },
  ].filter((t) => t !== false);
  let current = tabs.find((t) => t.id === tab) || tabs[0];
  const tabBar = el('nav', { class: 'settings-tabs', role: 'tablist', 'aria-label': 'Settings' });
  const body = el('div', { class: 'settings-body' });
  const show = (t: (typeof tabs)[number]) => {
    current = t;
    tabBar.replaceChildren(...tabs.map((x) => el('a', {
      href: `/settings/${x.id}`, role: 'tab', 'aria-selected': String(x === t),
      onclick: (e) => { e.preventDefault(); history.replaceState(null, '', `/settings/${x.id}`); show(x); },
    }, x.label)));
    body.replaceChildren(...t.panels().filter(Boolean));
  };
  show(current);
  const footer = el('footer', { class: 'settings-footer' });
  fetch('/healthz').then((r): Promise<{ version?: string }> => r.json()).then(({ version }) => { if (version) footer.textContent = `Pinnery v${version}`; }).catch(() => {});
  view.replaceChildren(el('div', { class: 'settings' }, tabBar, body, footer));
}

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
function renderBoardHeader() {
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
  // Known bug, kept as it was: for viewers the two canAdd() items are false, which
  // replaceChildren renders as the text "false". The cast hides that from tsc.
  ] as (Node | string)[]);
  selMove.hidden = !isOwner(b);
}

function displayedPins() {
  return state.order === 'asc' ? [...state.pins].reverse() : state.pins;
}

// Build or reuse tile elements in display order, lay them out, then start loading thumbnails
// at a size matched to the column width and screen density.
function renderGrid() {
  if (!grid) return;
  const pins = displayedPins();
  if (!pins.length) {
    grid.replaceChildren(el('div', { class: 'empty' },
      el('h2', { text: 'No pins yet' }),
      canAdd(openBoard()) && el('p', {}, 'Right-click any image → ', el('kbd', { text: 'Pin to Pinnery' }), ', or use ', el('kbd', { text: '+ Pin' })),
      canAdd(openBoard()) && el('button', { class: 'btn primary', onclick: () => addPinDialog() }, icon('plus'), el('span', { text: 'Pin' })),
    ));
    grid.style.height = '';
    return;
  }
  const seen = new Set();
  const nodes = pins.map((pin) => {
    seen.add(pin.id);
    let t = state.tiles.get(pin.id);
    if (!t) { t = tile(pin); state.tiles.set(pin.id, t); }
    return t;
  });
  for (const [id, t] of state.tiles) if (!seen.has(id)) { t.remove(); state.tiles.delete(id); }
  grid.replaceChildren(...nodes);
  relayout();
}

function relayout() {
  if (!grid || !state.pins.length) return;
  const pins = displayedPins();
  // renderGrid made a tile for every pin in the list.
  const colW = layout(grid, pins.map((p) => ({ el: state.tiles.get(p.id)!, width: p.width, height: p.height })));
  if (!colW) return;
  const size = colW * devicePixelRatio > 400 ? 800 : 400;
  for (const p of pins) {
    const img = state.tiles.get(p.id)!.querySelector('img')!;   // every tile has its <img>
    if (!img.dataset.size) {
      img.dataset.size = String(size);
      img.src = thumbUrl(p, size);
    }
  }
}

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

// The lightbox gets only the actions the user's role allows (see lightbox.js).
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

selMove.onclick = () => movePins([...state.selected]);
selDelete.onclick = () => deletePins([...state.selected]);
selCancel.onclick = exitSelect;

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

function addPinDialog() {
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

route();

// Register the service worker that receives Android shares (it caches nothing else).
if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {});

// Chrome offers installing as an app through this event; keep it for the Settings button.
let installPrompt: BeforeInstallPromptEvent | null = null;
window.addEventListener('beforeinstallprompt', (e) => { e.preventDefault(); installPrompt = e; });
window.addEventListener('appinstalled', () => { installPrompt = null; });
const installed = () => matchMedia('(display-mode: standalone)').matches;

// Settings → App: an install button when the browser offers it, else how to do it by hand.
function appSection(): HTMLElement {
  const body = el('div', { class: 'row' });
  const draw = () => {
    if (installed()) body.replaceChildren(el('p', { text: 'Installed — you\u2019re using the app.' }));
    else if (installPrompt) {
      body.replaceChildren(el('button', { class: 'btn primary', onclick: async () => {
        if (!installPrompt) return;
        installPrompt.prompt();
        const { outcome } = await installPrompt.userChoice;
        if (outcome === 'accepted') installPrompt = null;
        draw();
      } }, icon('download'), el('span', { text: 'Install app' })));
    } else body.replaceChildren(el('p', { text: 'Your browser isn\u2019t offering it right now. Use its menu: “Install app” or “Add to Home screen”.' }));
  };
  draw();
  // The offer can arrive after Settings has drawn (e.g. opened directly), so redraw when it does.
  window.addEventListener('beforeinstallprompt', () => queueMicrotask(draw));
  return el('section', {},
    el('h2', { text: 'App' }),
    el('p', { text: 'Install Pinnery as an app. On Android it then appears in the Share menu: share an image from Chrome (long-press → Share image) or your photos, and pick a board.' }),
    body,
  );
}
