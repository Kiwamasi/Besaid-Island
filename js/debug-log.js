// The admin panel's debug log on the profile page (js/profile.js): with the Debug box
// ticked, a log beside the Discord bot of every call involved, newest first, styled like
// the bot's log:
//   Page      each call this page makes to the Netlify API (from js/site-account.js)
//   Netlify   what the API did to answer it: Blobs reads and writes, Octopus, Discord
//   Job       the scheduled job's calls each minute, saved on Netlify while Debug is on
//             and brought by the live panel's usual ?energy-live answer
// Ticking it tells the API to start saving the job's calls (for an hour, renewed every
// RENEW_MS while the page is open); unticking stops it. It's remembered in this browser.
//
// window.debugLog.start({ toggle, column, request }), window.debugLog.stop()
(() => {
  const STORAGE_KEY = 'besaid-debug-log';
  const RENEW_MS = 30 * 60 * 1000;
  const MAX_LINES = 300;
  const timeFormat = new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  const untilFormat = new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit' });

  function html(tag, className, text) {
    const element = document.createElement(tag);
    if (className) element.className = className;
    if (text !== undefined) element.textContent = text;
    return element;
  }

  function remembered() {
    try {
      return localStorage.getItem(STORAGE_KEY) === 'on';
    } catch {
      return false;
    }
  }

  function remember(on) {
    try {
      localStorage.setItem(STORAGE_KEY, on ? 'on' : 'off');
    } catch {
      // Only a convenience: it starts unticked next time.
    }
  }

  window.siteDebug = { on: false };
  let session = null;

  function start({ toggle, column, request }) {
    stop();
    const note = html('p', 'profile-admin-note debug-note');
    const box = html('div', 'bot-log debug-log');
    box.setAttribute('role', 'log');
    box.setAttribute('aria-label', 'Debug log of API calls');
    const clear = html('button', 'profile-button', 'Clear');
    clear.type = 'button';
    const head = html('div', 'debug-head');
    head.append(html('h3', 'profile-admin-subtitle', 'Debug log'), clear);
    column.replaceChildren(head, note, box);

    // Lines newest last; job lines are kept by time and text so each shows once.
    let lines = [];
    const seen = new Set();
    const current = { renew: null };
    session = current;

    // order places a line: what the server did for a page call goes straight under that
    // call (just before it in time, as the newest is shown first), in the order done.
    function add(at, source, text, { error = false, order = at } = {}) {
      const key = `${source}|${at}|${text}`;
      if (seen.has(key)) return;
      seen.add(key);
      lines.push({ at, source, text, error, order });
    }

    function addCall(call) {
      const answer = call.status ? `${call.status}` : 'no answer';
      add(call.at, 'Page', `${call.method} ${call.query} → ${answer} · ${call.ms} ms`, {
        error: call.status === 0 || call.status >= 400
      });
      const inner = call.calls || [];
      inner.forEach((entry, index) => add(entry.at, 'Netlify', `↳ ${entry.text}`, {
        order: call.at - (inner.length - index) / 1000
      }));
      for (const entry of call.jobLog || []) add(entry.at, 'Job', entry.text);
    }

    function render() {
      lines.sort((first, second) => first.order - second.order);
      if (lines.length > MAX_LINES) lines = lines.slice(-MAX_LINES);
      box.replaceChildren(...(lines.length
        ? lines.slice().reverse().map(line => {
          const row = html('div', `bot-log-line${line.error ? ' is-error' : ''}`);
          row.append(
            html('time', 'bot-log-time', timeFormat.format(line.at)),
            html('span', `debug-source is-${line.source.toLowerCase()}`, line.source),
            html('span', '', line.text)
          );
          return row;
        })
        : [html('div', 'bot-log-line bot-log-empty', 'No calls yet. They show here as they happen.')]));
    }

    current.onCall = event => {
      if (!window.siteDebug.on) return;
      addCall(event.detail);
      render();
    };
    document.addEventListener('site-api-call', current.onCall);

    clear.addEventListener('click', () => {
      lines = [];
      seen.clear();
      render();
    });

    // Tells the API to save (or stop saving) the scheduled job's calls.
    async function tellServer(on) {
      try {
        const { debugUntil } = await request('POST', { action: 'debug', on });
        note.textContent = on && debugUntil
          ? `The scheduled job's calls are saved until ${untilFormat.format(debugUntil)} (renewed while this page is open).`
          : '';
      } catch (error) {
        note.textContent = `Couldn't ${on ? 'start' : 'stop'} the job's log: ${error.message}`;
      }
    }

    function setOn(on) {
      window.siteDebug.on = on;
      toggle.checked = on;
      column.hidden = !on;
      column.closest('.profile-admin')?.classList.toggle('has-debug', on);
      clearInterval(current.renew);
      if (on) {
        // The calls made before it was ticked, from this page's own record.
        for (const call of window.siteAccount.recentCalls()) addCall(call);
        render();
        current.renew = setInterval(() => tellServer(true), RENEW_MS);
      }
    }

    current.onToggle = () => {
      remember(toggle.checked);
      setOn(toggle.checked);
      tellServer(toggle.checked);
    };
    toggle.addEventListener('change', current.onToggle);
    current.toggle = toggle;
    current.column = column;

    if (remembered()) {
      setOn(true);
      tellServer(true);
    } else {
      setOn(false);
    }
  }

  // When the admin panel goes (signed out, someone else's profile): stops listening and
  // renewing. The server's job log turns itself off within the hour.
  function stop() {
    if (!session) return;
    clearInterval(session.renew);
    document.removeEventListener('site-api-call', session.onCall);
    session.toggle.removeEventListener('change', session.onToggle);
    window.siteDebug.on = false;
    session.column.hidden = true;
    session.column.closest('.profile-admin')?.classList.remove('has-debug');
    session = null;
  }

  window.debugLog = { start, stop };
})();
