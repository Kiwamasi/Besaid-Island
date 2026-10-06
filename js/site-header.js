// Builds the shared site header (nav links + account controls) inside
// <header class="site-header"></header>. Load it straight after that element,
// without defer/async, so the header is filled in before the page first paints.
// To add, rename or reorder a nav link, edit NAV_LINKS; every page picks it up.
//
// Browsing someone else's pages: opening a backlog or profile link that names someone
// (profile.html?user=bob) makes the nav's Backlog and Profile links go to bob's pages
// too, for the rest of the visit in that tab, until Home is clicked or you pick
// yourself on the Users page (window.siteNav.stopViewing()).
(() => {
  const NAV_LINKS = [
    { href: 'index.html', label: 'Home' },
    { href: 'backlog.html', label: 'Backlog' },
    { href: 'profile.html', label: 'Profile' },
    { href: 'users.html', label: 'Users' },
    { href: 'about.html', label: 'Stats' }
  ];
  // Pages that belong to one account, and follow whoever is being viewed.
  const PERSONAL_PAGES = ['backlog.html', 'profile.html'];
  const VIEWING_KEY = 'besaid-viewing';

  const header = document.querySelector('.site-header');
  if (!header) return;

  const currentPage = window.location.pathname.split('/').pop() || 'index.html';

  // sessionStorage can be unavailable (e.g. blocked site data); browsing still works,
  // the nav just doesn't follow the person being viewed.
  function readViewing() {
    try { return sessionStorage.getItem(VIEWING_KEY) || ''; } catch { return ''; }
  }
  function writeViewing(name) {
    try {
      if (name) sessionStorage.setItem(VIEWING_KEY, name);
      else sessionStorage.removeItem(VIEWING_KEY);
    } catch {
      // See readViewing.
    }
  }

  const linkedUser = (new URLSearchParams(window.location.search).get('user') || '').trim();
  if (PERSONAL_PAGES.includes(currentPage) && linkedUser) writeViewing(linkedUser);

  const nav = document.createElement('nav');
  nav.className = 'site-nav';
  nav.setAttribute('aria-label', 'Main navigation');
  const list = document.createElement('ul');
  const links = NAV_LINKS.map(({ href, label }) => {
    const link = document.createElement('a');
    link.dataset.page = href;
    link.textContent = label;
    if (href === currentPage) link.setAttribute('aria-current', 'page');
    if (href === 'index.html') link.addEventListener('click', () => stopViewing());
    const item = document.createElement('li');
    item.append(link);
    list.append(item);
    return link;
  });
  nav.append(list);

  function updateLinks() {
    const viewing = readViewing();
    for (const link of links) {
      const page = link.dataset.page;
      link.href = viewing && PERSONAL_PAGES.includes(page) ? `${page}?user=${encodeURIComponent(viewing)}` : page;
    }
  }

  function stopViewing() {
    writeViewing('');
    updateLinks();
  }

  updateLinks();

  // Filled in by js/site-account.js.
  const account = document.createElement('div');
  account.className = 'site-account';
  account.innerHTML = `
    <button class="site-account-signin" type="button" hidden>Sign in / Create account</button>
    <span class="account-name">Checking account…</span>
    <button class="site-account-signout" type="button" hidden>Sign Out</button>`;

  header.replaceChildren(nav, account);

  window.siteNav = {
    get viewing() { return readViewing(); },
    stopViewing
  };
})();
