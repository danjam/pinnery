// Script for password.html (kept out of the page so the CSP can forbid inline scripts).

const form = document.getElementById('change');
const error = document.getElementById('error');
const fail = (msg) => { error.textContent = msg; error.hidden = false; };
form.addEventListener('submit', async (e) => {
  e.preventDefault();
  error.hidden = true;
  if (form.next.value !== form.again.value) { fail('The new passwords don\u2019t match'); form.again.select(); return; }
  const res = await fetch('/api/password', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ current: form.current.value, new: form.next.value }),
  });
  if (res.ok) {
    // Back to where the gate caught us (same-origin only), else home.
    const next = new URLSearchParams(location.search).get('next');
    // Resolve it as the browser will and stay on our origin ("/\t/evil.com" means //evil.com).
    const target = next && next.startsWith('/') ? new URL(next, location.origin) : null;
    location.replace(target && target.origin === location.origin ? target.pathname + target.search + target.hash : '/');
    return;
  }
  if (res.status === 401) { location.replace(`/login?next=${encodeURIComponent(location.pathname + location.search)}`); return; }
  const body = await res.json().catch(() => ({}));
  fail(body.error || `Couldn\u2019t change the password (${res.status})`);
  form.current.select();
});
