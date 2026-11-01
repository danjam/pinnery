// Runs before first paint (a plain, blocking script in <head> of every page): applies the saved
// theme and accent so pages don't flash the default. Kept out of the HTML so the CSP needs no
// inline scripts. Not a module, so it can't be deferred.
try {
  const root = document.documentElement;
  const theme = localStorage.getItem('pinnery.theme');
  const accent = localStorage.getItem('pinnery.accent');
  const colors: Record<string, string> = { green: '#2d8545', blue: '#1971c2', orange: '#c2410c' };
  const color: string | undefined = colors[accent ?? ''];
  if (theme === 'light' || theme === 'dark') root.dataset.theme = theme;
  if (color && accent) {
    root.dataset.accent = accent;
    // Every page has the <link rel="icon"> (a missing one throws into the catch, as before).
    document.querySelector<HTMLLinkElement>('link[rel=icon]')!.href = 'data:image/svg+xml,' + encodeURIComponent(
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><circle cx="16" cy="16" r="14" fill="' + color
      + '"/><circle cx="16" cy="13" r="5" fill="#fff"/><path d="M15 18h2v9l-1 2-1-2z" fill="#fff"/></svg>');
  }
} catch {}
