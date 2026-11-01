// Settings → Users (admins): inviting people and managing accounts.
import { api, errorMessage, apiError } from './api.ts';
import type { Me, AdminUser, EmailedLink } from './api.ts';
import { el, toast, dialog, confirm } from './ui.ts';
import type { MenuEntry } from './ui.ts';
import { moreButton } from './page.ts';

// ---- settings -----------------------------------------------------------------------------

export const when = (iso: string | null) => (iso ? new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }) : 'never');
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
export function usersSection(me: Me) {
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
export function invitesSection(mail: boolean) {
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
