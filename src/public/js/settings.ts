// The settings page: its tabs, and the panels that aren't about users (see settings-users.ts).
import { api, exportUrl, errorMessage } from './api.ts';
import { el, toast, dialog, confirm } from './ui.ts';
import { icon } from './icons.ts';
import { appearanceSection } from './theme.ts';
import { view, actionsEl, state, setCrumbs, moreButton, signOut } from './page.ts';
import { usersSection, invitesSection, when } from './settings-users.ts';

// Chrome's install offer isn't in lib.dom.
interface BeforeInstallPromptEvent extends Event {
  prompt(): Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>;
}
declare global {
  interface WindowEventMap { beforeinstallprompt: BeforeInstallPromptEvent }
}

export async function showSettings(tab?: string) {
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
