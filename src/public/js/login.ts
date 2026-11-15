// Script for login.html (kept out of the page so the CSP can forbid inline scripts).

import { nextPath } from './next.ts';
// The page's HTML has these elements.
const form = document.getElementById('login') as HTMLFormElement & {
  email: HTMLInputElement;
  password: HTMLInputElement;
};
const error = document.getElementById('error')!;

function showError(message: string) {
  error.textContent = message;
  error.hidden = false;
}

// A failed SSO sign-in comes back as /login?error=<code> (src/auth/oidc.ts).
const SSO_ERRORS: Record<string, string> = {
  sso_failed: 'Single sign-on failed. Try again, or sign in with your password.',
  sso_unverified: 'Your sign-in provider hasn\u2019t verified your email address, so it can\u2019t be matched to an account.',
  sso_no_account: 'There\u2019s no Pinnery account for that sign-in. Ask an admin for an invite, or sign in with your password.',
  sso_unavailable: 'The sign-in provider can\u2019t be reached right now. Sign in with your password.',
};
const ssoError = new URLSearchParams(location.search).get('error');
if (ssoError && Object.hasOwn(SSO_ERRORS, ssoError)) showError(SSO_ERRORS[ssoError]);

// Offer SSO when the server has it set up, carrying ?next= through.
const sso = document.getElementById('sso') as HTMLAnchorElement;
fetch('/api/oidc').then((r) => (r.ok ? r.json() : null)).then((s: { enabled: boolean; name?: string } | null) => {
  if (!s?.enabled) return;
  sso.textContent = `Sign in with ${s.name}`;
  sso.href = `/auth/oidc/start?next=${encodeURIComponent(nextPath())}`;
  sso.hidden = false;
}).catch(() => { /* no SSO button */ });

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
    location.replace(nextPath());
    return;
  }
  const body: { error?: string } = await res.json().catch(() => ({}));
  showError(body.error || `Sign in failed (${res.status})`);
  form.password.select();
});
