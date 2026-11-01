// Script for reset.html (kept out of the page so the CSP can forbid inline scripts).

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
try {
  const { email } = await api('GET', `/api/reset/${token}`);
  form.email.value = email;
  form.hidden = false;
  form.password.focus();
} catch (e) {
  replace(p(e.message), link('/forgot', 'Request a new link'));
}
// After saving: signed in here, other browsers signed out; extension tokens are the user's call.
const done = (tokens) => {
  const cont = link('/', 'Continue');
  if (!tokens) return replace(p('Password saved. You’re signed in here and your other browsers have been signed out.'), cont);
  const revoke = link('#', `Revoke ${tokens} extension token${tokens === 1 ? '' : 's'}`);
  revoke.addEventListener('click', async (e) => {
    e.preventDefault();
    try {
      await api('DELETE', '/api/tokens');
      replace(p('Extension tokens revoked. Connect the extension again where you still use it.'), cont);
    } catch (err) { fail(err.message); }
  });
  const keep = link('/', 'Keep them');
  keep.className = 'btn';
  replace(p('Password saved. You’re signed in here and your other browsers have been signed out.'),
    p(`You have ${tokens} extension token${tokens === 1 ? '' : 's'}. If someone else may have had your password, revoke them too.`), revoke, keep);
};
form.addEventListener('submit', async (e) => {
  e.preventDefault();
  error.hidden = true;
  if (form.password.value !== form.again.value) { fail('The passwords don’t match'); form.again.select(); return; }
  try {
    const { tokens } = await api('POST', `/api/reset/${token}`, { password: form.password.value });
    done(tokens);
  } catch (err) {
    fail(err.message);
  }
});
