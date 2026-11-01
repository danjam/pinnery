// Script for login.html (kept out of the page so the CSP can forbid inline scripts).

const form = document.getElementById('login');
const error = document.getElementById('error');
form.addEventListener('submit', async (e) => {
  e.preventDefault();
  error.hidden = true;
  const res = await fetch('/api/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: form.email.value, password: form.password.value }),
  });
  if (res.ok) {
    // ?next= continues to a same-origin page (the extension's /connect); anything else goes home.
    const next = new URLSearchParams(location.search).get('next');
    // Resolve it as the browser will and stay on our origin ("/\t/evil.com" means //evil.com).
    const target = next && next.startsWith('/') ? new URL(next, location.origin) : null;
    location.replace(target && target.origin === location.origin ? target.pathname + target.search + target.hash : '/');
    return;
  }
  const body = await res.json().catch(() => ({}));
  error.textContent = body.error || `Sign in failed (${res.status})`;
  error.hidden = false;
  form.password.select();
});
