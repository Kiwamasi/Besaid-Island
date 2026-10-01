// Builds the shared site header (nav links + account controls) inside
// <header class="site-header"></header>. Load it straight after that element,
// without defer/async, so the header is filled in before the page first paints.
// To add, rename or reorder a nav link, edit NAV_LINKS; every page picks it up.
(() => {
  const NAV_LINKS = [
    { href: 'index.html', label: 'Home' },
    { href: 'backlog.html', label: 'Backlog' },
    { href: '#', label: 'Portfolio' }
  ];

  const header = document.querySelector('.site-header');
  if (!header) return;

  const currentPage = window.location.pathname.split('/').pop() || 'index.html';

  const nav = document.createElement('nav');
  nav.className = 'site-nav';
  nav.setAttribute('aria-label', 'Main navigation');
  const list = document.createElement('ul');
  for (const { href, label } of NAV_LINKS) {
    const link = document.createElement('a');
    link.href = href;
    link.textContent = label;
    if (href === currentPage) link.setAttribute('aria-current', 'page');
    const item = document.createElement('li');
    item.append(link);
    list.append(item);
  }
  nav.append(list);

  // Filled in by js/site-account.js.
  const account = document.createElement('div');
  account.className = 'site-account';
  account.innerHTML = `
    <button class="site-account-signin" type="button" hidden>Sign in / Create account</button>
    <span class="account-name">Checking account…</span>
    <button class="site-account-signout" type="button" hidden>Sign Out</button>`;

  header.replaceChildren(nav, account);
})();
