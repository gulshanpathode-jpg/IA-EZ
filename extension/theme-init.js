// Apply the saved theme before first paint so dark-mode users never see
// a light flash. sidepanel.js keeps this localStorage mirror in sync with
// chrome.storage; light is the default when nothing is saved.
try {
  if (localStorage.getItem('sf-theme') === 'dark')
    document.documentElement.setAttribute('data-theme', 'dark');
} catch (e) { /* storage blocked; fall back to light */ }
