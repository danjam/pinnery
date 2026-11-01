// Script for signup.html (kept out of the page so the CSP can forbid inline scripts).

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
const form = document.getElementById('form') as HTMLFormElement & {
  email: HTMLInputElement;
  name: HTMLInputElement;
  password: HTMLInputElement;
  again: HTMLInputElement;
};
try {
  const { email } = await api<{ email: string }>('GET', `/api/signup/${token}`);
  form.email.value = email;
  form.hidden = false;
  form.name.focus();
} catch (e) {
  replace(p(errorMessage(e), 'muted'), link('/login', 'Sign in'));
}
form.addEventListener('submit', async (e) => {
  e.preventDefault();
  error.hidden = true;
  if (form.password.value !== form.again.value) { fail('The passwords don’t match'); form.again.select(); return; }
  try {
    await api('POST', `/api/signup/${token}`, { display_name: form.name.value, password: form.password.value });
    location.replace('/');
  } catch (err) {
    fail(errorMessage(err));
  }
});
