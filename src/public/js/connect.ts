// The approval page the extension opens at /connect (via chrome.identity.launchWebAuthFlow). The
// server has already checked the query and the sign-in before serving this page. Allow or Cancel
// is POSTed back with the same parameters; the server answers with the extension's redirect URL
// (carrying a single-use code, or error=access_denied) and navigating there ends the flow.

import { errorMessage } from './api.ts';

// The page's HTML has every element looked up here.
const $ = (id: string) => document.getElementById(id)!;
const params = new URLSearchParams(location.search);
const name = params.get('name')?.trim().slice(0, 100) || 'Chrome';
$('name').textContent = `“${name}”`;
document.title = `Connect ${name} to Pinnery`;

async function decide(allow: boolean) {
  for (const id of ['allow', 'cancel']) ($(id) as HTMLButtonElement).disabled = true;
  $('error').hidden = true;
  try {
    const res = await fetch('/connect/decide', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        allow,
        redirect_uri: params.get('redirect_uri'),
        code_challenge: params.get('code_challenge'),
        code_challenge_method: params.get('code_challenge_method'),
        state: params.get('state'),
        name,
      }),
    });
    const data: { error?: string; redirect: string } = await res.json().catch(() => ({}));
    if (res.status === 401) { location.replace(`/login?next=${encodeURIComponent(location.pathname + location.search)}`); return; }
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
    $('ask').classList.add('hidden');
    $('done').classList.remove('hidden');
    $('done-text').textContent = allow ? 'Connected — you can close this window.' : 'Cancelled — you can close this window.';
    location.replace(data.redirect);
  } catch (e) {
    $('error').textContent = errorMessage(e);
    $('error').hidden = false;
    for (const id of ['allow', 'cancel']) ($(id) as HTMLButtonElement).disabled = false;
  }
}

$('allow').onclick = () => decide(true);
$('cancel').onclick = () => decide(false);
