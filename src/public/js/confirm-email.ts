// Script for confirm-email.html (kept out of the page so the CSP can forbid inline scripts).

import { errorMessage } from './api.ts';

// The page's HTML has these elements (and the card always starts with the brand).
const card = document.getElementById('card')!;
const error = document.getElementById('error')!;
const fail = (msg: string) => { error.textContent = msg; error.hidden = false; };
const token = location.pathname.split('/').pop();
// Show a message in place of the form (an unusable link, or a finished step), keeping the brand.
const replace = (...nodes: Node[]) => { card.replaceChildren(card.firstElementChild!, ...nodes, error); };
const p = (text: string, cls = 'muted') => Object.assign(document.createElement('p'), { textContent: text, className: cls });
const link = (href: string, text: string) => { const a = document.createElement('a'); a.className = 'btn primary'; a.href = href; a.textContent = text; return a; };
const api = async <T>(method: string, path: string, body?: unknown): Promise<T> => {
  const res = await fetch(path, { method, headers: body ? { 'Content-Type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined });
  const data: T & { error?: string } = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Something went wrong (${res.status})`);
  return data;
};
const intro = document.getElementById('intro')!;
const button = document.getElementById('confirm') as HTMLButtonElement;
try {
  const { email } = await api<{ email: string }>('GET', `/api/confirm-email/${token}`);
  intro.textContent = `Change your Pinnery sign-in email to ${email}?`;
  button.hidden = false;
  button.focus();
} catch (e) {
  replace(p(errorMessage(e)), link('/settings', 'Settings'));
}
button.addEventListener('click', async () => {
  button.disabled = true;
  try {
    const { email } = await api<{ email: string }>('POST', `/api/confirm-email/${token}`);
    replace(p(`Done — your sign-in email is now ${email}.`), link('/', 'Continue'));
  } catch (err) {
    fail(errorMessage(err));
    button.disabled = false;
  }
});
