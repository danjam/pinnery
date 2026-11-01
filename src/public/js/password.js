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
    location.replace(next && /^\/(?![/\\])/.test(next) ? next : '/');
    return;
  }
  if (res.status === 401) { location.replace(`/login?next=${encodeURIComponent(location.pathname + location.search)}`); return; }
  const body = await res.json().catch(() => ({}));
  fail(body.error || `Couldn\u2019t change the password (${res.status})`);
  form.current.select();
});
