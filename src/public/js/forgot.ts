// Script for forgot.html (kept out of the page so the CSP can forbid inline scripts).

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
const form = document.getElementById('form') as HTMLFormElement & { email: HTMLInputElement };
// `reset`: email is set up and PINNERY_PUBLIC_URL is set (see selfReset in auth/reset.ts).
const { reset } = await api<{ reset: boolean }>('GET', '/api/mail').catch(() => ({ reset: true }));
if (!reset) {
  replace(p('This Pinnery can’t email reset links. Ask an admin to reset your password for you.'), link('/login', 'Back to sign in'));
} else {
  form.hidden = false;
  form.email.focus();
}
form.addEventListener('submit', async (e) => {
  e.preventDefault();
  error.hidden = true;
  form.querySelector('button')!.disabled = true;
  try {
    await api('POST', '/api/forgot', { email: form.email.value });
    replace(p('If that account exists, we’ve emailed a link to choose a new password. It works once and expires in an hour.'), link('/login', 'Back to sign in'));
  } catch (err) {
    fail(errorMessage(err));
    form.querySelector('button')!.disabled = false;
  }
});
