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

    // One group per page call and one per scheduled job run, each a single line with a
    // summary ("Blobs 3 reads · Octopus 1"); clicking it shows the calls inside. groups
    // is oldest first; expanded holds the keys of the open ones, kept across redraws.
    let groups = [];
    const byKey = new Map();
    const expanded = new Set();
    const current = { renew: null };
    session = current;

    // "Blobs 3 reads, 1 write · Octopus 1 · Discord 1" for a group's calls.
    function summarise(details) {
      let reads = 0;
      let writes = 0;
      const others = new Map();
      for (const { text } of details) {
        const call = text.replace(/^↳ /, '');
        const blob = call.match(/^Blobs (\w+)(?: \+ (\w+))?/);
        if (blob) {
          for (const method of [blob[1], blob[2]].filter(Boolean)) {
            if (/^(set|setJSON|delete)$/.test(method)) writes++;
            else reads++;
          }
        } else if (!call.startsWith('No details')) {
          const service = serviceOf('Netlify', call);
          others.set(service, (others.get(service) || 0) + 1);
        }
      }
      const parts = [];
      if (reads || writes) {
        parts.push(`Blobs ${[reads && `${reads} ${reads === 1 ? 'read' : 'reads'}`, writes && `${writes} ${writes === 1 ? 'write' : 'writes'}`].filter(Boolean).join(', ')}`);
      }
      for (const [service, count] of others) parts.push(`${service} ${count}`);
      return parts.join(' · ');
    }

    // Who a group went to: Netlify, or the outside services it reached through Netlify.
    function serviceOfGroup(details) {
      const outside = [...new Set(details.map(({ text }) => serviceOf('Netlify', text)).filter(service => service !== 'Netlify'))];
      return outside.length ? outside.join(' + ') : 'Netlify';
    }

    // Calls made in the same millisecond keep their own places. pageSeen stops a call
    // being added twice (ticking Debug again replays the page's recent calls).
    let sequence = 0;
    const pageSeen = new WeakSet();
    function addCall(call) {
      if (pageSeen.has(call)) return;
      pageSeen.add(call);
      const answer = call.status ? `${call.status}` : 'no answer';
      const details = (call.calls || []).map(entry => ({ at: entry.at, text: entry.text }));
      // Asked for, but nothing came back: say so, rather than look like nothing happened.
      const missing = call.debugSent && call.status && !call.calls;
      if (missing) details.push({ at: call.at, text: 'No details came back from Netlify for this call', error: true });
      const group = {
        key: `page|${call.at}|${++sequence}`,
        at: call.at,
        order: call.at + (sequence % 50) * 0.02,
        source: 'Page',
        text: `${call.method} ${call.query} → ${answer} · ${call.ms} ms`,
        error: call.status === 0 || call.status >= 400 || missing,
        details,
        seen: new Set()
      };
      groups.push(group);
      for (const entry of call.jobLog || []) addJobEntry(entry);
    }

    // The job's calls come as a list each minute; they're grouped by run (calls within
    // a few seconds of each other) and each kept once.
    // The job's saved list comes back whole each minute, including runs from before this
    // page was opened; those are skipped, as is everything before Clear.
    let clearedAt = Math.round(performance.timeOrigin);
    function addJobEntry(entry) {
      if (entry.at < clearedAt) return;
      const minute = Math.floor((entry.at - 30000) / 60000);
      const key = `job|${minute}`;
      let group = byKey.get(key);
      if (!group) {
        group = { key, at: entry.at, order: entry.at, source: 'Job', text: 'Scheduled run', error: false, details: [], seen: new Set() };
        byKey.set(key, group);
        groups.push(group);
      }
      const id = `${entry.at}|${entry.text}`;
      if (group.seen.has(id)) return;
      group.seen.add(id);
      group.details.push({ at: entry.at, text: entry.text });
      group.at = Math.min(group.at, entry.at);
      group.order = group.at;
    }

    function line(at, source, text, service, { error = false, description = '' } = {}) {
      const row = html('div', `bot-log-line${error ? ' is-error' : ''}`);
      const words = html('span', '', text);
      words.append(' ', html('span', 'debug-service', `(${service})`));
      row.append(html('time', 'bot-log-time', timeFormat.format(at)), html('span', `debug-source is-${source.toLowerCase()}`, source), words);
      if (description) row.title = description;
      return row;
    }

    function render() {
      groups.sort((first, second) => first.order - second.order);
      if (groups.length > MAX_LINES) {
        for (const gone of groups.slice(0, groups.length - MAX_LINES)) byKey.delete(gone.key);
        groups = groups.slice(-MAX_LINES);
      }
      if (!groups.length) {
        box.replaceChildren(html('div', 'bot-log-line bot-log-empty', 'No calls yet. They show here as they happen.'));
        return;
      }
      const rows = [];
      for (const group of groups.slice().reverse()) {
        const details = group.details.slice().sort((first, second) => first.at - second.at);
        const summary = summarise(details);
        const service = serviceOfGroup(details);
        const open = expanded.has(group.key);
        const passedOn = group.source === 'Page' && service !== 'Netlify' ? ` Netlify passed it on to ${service}.` : '';
        const description = group.source === 'Job'
          ? 'The scheduled job that runs every minute: the live reading, the Discord nickname, and the history or archive when due.'
          : `${describe('Page', group.text)}${passedOn}`.trim();
        const text = `${details.length ? (open ? '▾ ' : '▸ ') : ''}${group.text}${summary ? ` · ${summary}` : ''}`;
        const row = line(group.at, group.source, text, service, { error: group.error, description });
        if (details.length) {
          row.classList.add('is-group');
          row.tabIndex = 0;
          row.setAttribute('role', 'button');
          row.setAttribute('aria-expanded', String(open));
          row.dataset.key = group.key;
        }
        rows.push(row);
        if (!open) continue;
        for (const detail of details) {
          const detailRow = line(detail.at, 'Netlify', `↳ ${detail.text}`, serviceOf('Netlify', detail.text), {
            error: detail.error, description: describe('Netlify', detail.text)
          });
          detailRow.classList.add('is-detail');
          rows.push(detailRow);
        }
      }
      box.replaceChildren(...rows);
    }

    // Clicking (or Enter / Space on) a group opens or closes it.
    function toggleGroup(row) {
      const key = row?.dataset.key;
      if (!key) return;
      if (expanded.has(key)) expanded.delete(key);
      else expanded.add(key);
      render();
      box.querySelector(`[data-key="${CSS.escape(key)}"]`)?.focus();
    }
    box.addEventListener('click', event => toggleGroup(event.target.closest('.is-group')));
    box.addEventListener('keydown', event => {
      if (event.key !== 'Enter' && event.key !== ' ') return;
      const row = event.target.closest('.is-group');
      if (!row) return;
      event.preventDefault();
      toggleGroup(row);
    });

    current.onCall = event => {
      if (!window.siteDebug.on) return;
      addCall(event.detail);
      render();
    };
    document.addEventListener('site-api-call', current.onCall);

    clear.addEventListener('click', () => {
      groups = [];
      byKey.clear();
      expanded.clear();
      clearedAt = Date.now();
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
