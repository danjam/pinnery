// Where to go after signing in: the ?next= path if it's on our own origin, else home. Mirrors
// safeNext in src/auth.js: resolved as a URL so tricks like "/\t/evil.com" (read as //evil.com)
// fail the origin check, and a normalised path starting with // is refused as well.
export function nextPath() {
  const next = new URLSearchParams(location.search).get('next');
  if (!next || !next.startsWith('/') || next.length > 2048) return '/';
  let u;
  try { u = new URL(next, location.origin); } catch { return '/'; }
  if (u.origin !== location.origin) return '/';
  const path = u.pathname + u.search + u.hash;
  return path.startsWith('//') ? '/' : path;
}
