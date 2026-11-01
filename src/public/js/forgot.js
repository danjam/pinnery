// Script for forgot.html (kept out of the page so the CSP can forbid inline scripts).

const card = document.getElementById('card');
const error = document.getElementById('error');
const fail = (msg) => { error.textContent = msg; error.hidden = false; };
const token = location.pathname.split('/').pop();
// Show a message in place of the form (an unusable link, or a finished step), keeping the brand.
const replace = (...nodes) => { card.replaceChildren(card.firstElementChild, ...nodes, error); };
const p = (text, cls = 'muted') => Object.assign(document.createElement('p'), { textContent: text, className: cls });
const link = (href, text) => { const a = document.createElement('a'); a.className = 'btn primary'; a.href = href; a.textContent = text; return a; };
const api = async (method, path, body) => {
  const res = await fetch(path, { method, headers: body ? { 'Content-Type': 'application/json' } : {}, body: body && JSON.stringify(body) });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Something went wrong (${res.status})`);
  return data;
};
const form = document.getElementById('form');
// `reset`: email is set up and PINNERY_PUBLIC_URL is set (see selfReset in auth.js).
const { reset } = await api('GET', '/api/mail').catch(() => ({ reset: true }));
if (!reset) {
  replace(p('This Pinnery can’t email reset links. Ask an admin to reset your password for you.'), link('/login', 'Back to sign in'));
} else {
  form.hidden = false;
  form.email.focus();
}
form.addEventListener('submit', async (e) => {
  e.preventDefault();
  error.hidden = true;
  form.querySelector('button').disabled = true;
  try {
    await api('POST', '/api/forgot', { email: form.email.value });
    replace(p('If that account exists, we’ve emailed a link to choose a new password. It works once and expires in an hour.'), link('/login', 'Back to sign in'));
  } catch (err) {
    fail(err.message);
    form.querySelector('button').disabled = false;
  }
});
