// Runs before first paint (a plain, blocking script in <head> of every page): applies the saved
// theme and accent so pages don't flash the default. Kept out of the HTML so the CSP needs no
// inline scripts. Not a module, so it can't be deferred.
try{var d=document.documentElement,t=localStorage.getItem('pinnery.theme'),a=localStorage.getItem('pinnery.accent'),c={green:'#2d8545',blue:'#1971c2',orange:'#c2410c'}[a];if(t==='light'||t==='dark')d.dataset.theme=t;if(c){d.dataset.accent=a;document.querySelector('link[rel=icon]').href='data:image/svg+xml,'+encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><circle cx="16" cy="16" r="14" fill="'+c+'"/><circle cx="16" cy="13" r="5" fill="#fff"/><path d="M15 18h2v9l-1 2-1-2z" fill="#fff"/></svg>')}}catch(e){}
