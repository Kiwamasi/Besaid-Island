// Counts a page view and reports JavaScript errors to the site API, for the stats on
// the About page. Load after js/site-account.js on every page.
(() => {
  const account = window.siteAccount;
  if (!account) return;

  const page = window.location.pathname.split('/').pop() || 'index.html';
  const MAX_REPORTS = 5;
  let reports = 0;

  // Stats are best-effort: never let a failed report surface as another error.
  function send(body) {
    account.request('POST', body).catch(() => {});
  }

  function reportError(message, source, line) {
    if (reports >= MAX_REPORTS) return;
    reports++;
    send({ action: 'error', message: String(message), source: source || '', line, page });
  }

  window.addEventListener('error', event => {
    // Ignore errors from browser extensions and other sites' scripts.
    if (event.filename && new URL(event.filename, window.location.href).origin !== window.location.origin) return;
    reportError(event.message, event.filename && event.filename.split('/').pop(), event.lineno);
  });
  window.addEventListener('unhandledrejection', event => {
    const reason = event.reason;
    reportError(reason instanceof Error ? reason.message : reason, 'unhandled promise', null);
  });

  send({ action: 'view', page });
})();
