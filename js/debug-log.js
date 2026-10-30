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

  // Who each line went to, shown in brackets after it. Page calls go to Netlify, or count
  // as Octopus's (Discord's, Google's) when Netlify only passed them on (see addCall).
  function serviceOf(source, text) {
    const call = text.replace(/^↳ /, '');
    if (source === 'Page' || call.startsWith('Blobs') || call.startsWith('No details')) return 'Netlify';
    if (call.startsWith('Octopus')) return 'Octopus';
    if (call.startsWith('Discord')) return 'Discord';
    if (call.startsWith('Gemini')) return 'Google';
    return 'Browser';
  }

  // What a page call asks the API for, by its query or POST action.
  const PAGE_CALLS = [
    [/^\?session/, 'Checked the sign-in is still good.'],
    [/^\?stats/, 'Fetched the Stats page numbers (views, errors, Gemini use).'],
    [/^\?whoami/, 'Asked Netlify for your IP and rough location (not stored).'],
    [/^\?recent/, 'Fetched the recently added games.'],
    [/^\?energy=fresh/, 'Asked for a fresh electricity summary: Octopus is asked if the saved one is over 5 minutes old.'],
    [/^\?energy=/, 'Fetched the electricity summary (tiles and half-hourly chart), saved for 30 minutes.'],
    [/^\?energy-live/, "Fetched the Home Mini's latest readings the scheduled job saved. Doesn't ask Octopus."],
    [/^\?energy-history/, "Fetched one day of the 5-minute history for the \"All\" tab. Doesn't ask Octopus."],
    [/^\?wattnick=status/, "Fetched the Discord bot's status and log. Doesn't ask Discord."],
    [/^\?wattnick/, "Fetched the Discord bot's settings, status and the servers it's in (asks Discord for those)."],
    [/^\?users/, 'Fetched the list of accounts.'],
    [/^\?profile=/, "Fetched a profile's details."],
    [/^\?user=/, "Fetched someone's backlog."],
    [/^view$/, 'Counted this page view for the Stats page.'],
    [/^error$/, 'Reported a JavaScript error for the Stats page.'],
    [/^debug$/, "Turned the scheduled job's debug logging on or off (on lasts an hour, renewed while open)."],
    [/^energy-settings$/, 'Paused or resumed the live readings.'],
    [/^wattnick-settings$/, 'Saved the Discord bot settings.'],
    [/^set-color$/, 'Saved your site colour.'],
    [/^categorize$/, 'Asked for a genre for a game (Gemini).'],
    [/^save game$/, 'Saved a game to the backlog.'],
    [/^(login|register)$/, 'Signed in or created an account.']
  ];

  // What a Blobs entry holds, by its key.
  const BLOB_KEYS = [
    [/energy-live$/, 'the live readings, plus the pause and debug switches and when the history and archive are next due'],
    [/octopus-auth$/, 'the saved Octopus sign-in and Home Mini ID'],
    [/energy-history$/, 'the 5-minute history'],
    [/energy-archive-state$/, "the 10-second archive's progress"],
    [/ten-seconds\//, "a day's 10-second readings in the archive"],
    [/wattnick-settings$/, 'the Discord bot settings'],
    [/wattnick-status$/, "the Discord bot's status"],
    [/wattnick-log$/, "the Discord bot's log"],
    [/debug-log/, 'this debug log'],
    [/\/energy$/, 'the saved electricity summary'],
    [/\/views$/, 'the page view counts'],
    [/\/errors$/, 'the error list'],
    [/gemini/, 'the Gemini usage counts'],
    [/\/recent$/, 'the recently added games'],
    [/settings-/, "an account's settings"],
    [/user-/, 'an account'],
    [/game-|public-game-backlog/, 'backlog games']
  ];
  const BLOB_VERBS = {
    get: 'Read', getWithMetadata: 'Read', getMetadata: 'Checked', set: 'Saved', setJSON: 'Saved', delete: 'Deleted', list: 'Listed'
  };

  const OUTSIDE_CALLS = [
    [/GraphQL query live/, "Fetched the Home Mini's newest 10-second readings since the last ones (and today's total when it's due)."],
    [/GraphQL query history/, 'Fetched 5-minute readings for the history: the newest, and older days while it searches back.'],
    [/GraphQL query archive/, "Fetched a whole day's 10-second readings for the archive."],
    [/GraphQL mutation krakenToken/, 'Signed in to Octopus (the sign-in lasts about an hour).'],
    [/GraphQL query homeMini/, "Looked up the Home Mini's device ID (done once, then saved)."],
    [/Octopus GET .*\/accounts\//, "Read the account to find the meter's current tariff."],
    [/Octopus GET .*\/consumption\//, "Fetched the meter's half-hourly readings."],
    [/Discord PATCH .*\/members\//, 'Changed your nickname in a server.'],
    [/Discord GET .*\/members\//, 'Read your current name in a server (for Append).'],
    [/Discord GET \/users\/@me\/guilds/, 'Listed the servers the bot is in.'],
    [/^Gemini/, "Asked Google's Gemini for a game's genre."],
    [/^Local mock/, 'The local mock answered this in the browser; nothing went to Netlify.']
  ];

  // The hover text for a line.
  function describe(source, text) {
    const call = text.replace(/^↳ /, '');
    if (source === 'Page') {
      const [, method, target] = call.match(/^(\w+) (\S+)/) || [];
      if (method === 'DELETE') return 'Removed a game from the backlog.';
      if (method === 'GET' && target === '/') return 'Fetched a backlog.';
      return PAGE_CALLS.find(([pattern]) => pattern.test(target || ''))?.[1] || 'A call to the site API on Netlify.';
    }
    const blob = call.match(/^Blobs (\w+)(?: \+ \w+)? (\S+)/);
    if (blob) {
      const what = BLOB_KEYS.find(([pattern]) => pattern.test(blob[2]))?.[1] || 'an entry';
      const verb = call.includes(' + ') ? 'Read and saved' : BLOB_VERBS[blob[1]] || blob[1];
      const note = blob[1] === 'getWithMetadata' ? ', with its version so it can be updated safely' : '';
      return `${verb} ${what}${note}.`;
    }
    return OUTSIDE_CALLS.find(([pattern]) => pattern.test(call))?.[1] || '';
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
    function add(at, source, text, { error = false, order = at, service = serviceOf(source, text) } = {}) {
      const key = `${source}|${at}|${text}`;
      if (seen.has(key)) return;
      seen.add(key);
      lines.push({ at, source, text, error, order, service });
    }

    // Calls made in the same millisecond each keep their own lines together.
    let sequence = 0;
    function addCall(call) {
      const answer = call.status ? `${call.status}` : 'no answer';
      const inner = call.calls || [];
      // A call Netlify only passed on to Octopus (or Discord, or Google) counts as theirs.
      const outside = [...new Set(inner.map(entry => serviceOf('Netlify', entry.text)).filter(service => service !== 'Netlify'))];
      // Fractions of a millisecond: big enough to survive rounding at today's timestamps
      // (about 1.7 trillion, where a double resolves about 0.0002), small enough to keep
      // each call within its millisecond with room for 40 server lines under it.
      const order = call.at + (++sequence % 50) * 0.02;
      add(call.at, 'Page', `${call.method} ${call.query} → ${answer} · ${call.ms} ms`, {
        error: call.status === 0 || call.status >= 400,
        order,
        service: outside.length ? outside.join(' + ') : 'Netlify'
      });
      inner.slice(-40).forEach((entry, index, shown) => add(entry.at, 'Netlify', `↳ ${entry.text}`, {
        order: order - (shown.length - index) * 0.0005
      }));
      // Asked for, but nothing came back: say so, rather than look like nothing happened.
      if (call.debugSent && call.status && !call.calls) {
        add(call.at, 'Netlify', "↳ No details came back from Netlify for this call (is the deployed function up to date?)", {
          error: true, order: order - 0.0005
        });
      }
      for (const entry of call.jobLog || []) add(entry.at, 'Job', entry.text);
    }

    function render() {
      lines.sort((first, second) => first.order - second.order);
      if (lines.length > MAX_LINES) lines = lines.slice(-MAX_LINES);
      box.replaceChildren(...(lines.length
        ? lines.slice().reverse().map(line => {
          const row = html('div', `bot-log-line${line.error ? ' is-error' : ''}`);
          const text = html('span', '', line.text);
          text.append(' ', html('span', 'debug-service', `(${line.service})`));
          row.append(
            html('time', 'bot-log-time', timeFormat.format(line.at)),
            html('span', `debug-source is-${line.source.toLowerCase()}`, line.source),
            text
          );
          // Hovering a line says what that call did.
          const passedOn = line.source === 'Page' && line.service !== 'Netlify'
            ? ` Netlify passed it on to ${line.service}.` : '';
          const description = `${describe(line.source, line.text)}${passedOn}`.trim();
          if (description) row.title = description;
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
