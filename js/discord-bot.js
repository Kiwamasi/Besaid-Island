// The Discord nickname bot's controls, in the admin panel on Kiwamari's profile page
// (js/profile.js). The bot itself runs on Netlify (netlify/lib/wattnick.mjs): once a
// minute it sets Kiwamari's nickname in the chosen servers to the Home Mini's reading.
// Here: invite it to a server, pause or resume it, and change its settings. The site
// API refuses all of this to anyone but the admin, and the bot's token stays on Netlify.
// While the tab is visible, the status line and log console refresh a few seconds after
// each run (the job runs at the top of every minute), with a countdown to the next one.
// That asks the site API only (?wattnick=status), never Discord or Octopus.
//
// window.discordBot.show(container, request): request is siteAccount.request.
(() => {
  const timeFormat = new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  // As in the nickname (netlify/lib/wattnick.mjs): "450W ⚡", "1.24kW ⚡".
  const power = watts => `${watts < 1000 ? `${Math.round(watts)}W` : `${(watts / 1000).toFixed(2)}kW`} ⚡`;

  function html(tag, className, text) {
    const element = document.createElement(tag);
    if (className) element.className = className;
    if (text !== undefined) element.textContent = text;
    return element;
  }

  function field(labelText, control, hint) {
    const label = html('label', 'form-field bot-field');
    label.append(html('span', 'bot-field-name', labelText), control);
    if (hint) label.append(html('span', 'bot-field-hint', hint));
    return label;
  }

  // A run happens at the top of every minute; the status is asked for this long after.
  const RUN_SETTLE_MS = 6000;
  const MINUTE_MS = 60000;

  let version = 0;
  // Stops the previous panel's countdown and polling when the panel is shown again.
  let stopPolling = () => {};

  async function show(container, request) {
    stopPolling();
    const shownVersion = ++version;
    container.replaceChildren(html('p', 'profile-admin-note', 'Loading…'));
    let panel;
    try {
      panel = await request('GET', null, '?wattnick');
    } catch (error) {
      if (shownVersion === version) container.replaceChildren(html('p', 'profile-admin-note', error.message));
      return;
    }
    if (shownVersion !== version) return;
    // An older Netlify service doesn't know ?wattnick and answers with a backlog instead.
    if (typeof panel.configured !== 'boolean') {
      container.replaceChildren(html('p', 'profile-admin-note', 'The Netlify service is out of date: redeploy it (Netlify → Deploys → Trigger deploy).'));
      return;
    }
    if (!panel.configured) {
      container.replaceChildren(html('p', 'profile-admin-note',
        'Not set up yet: add DISCORD_BOT_TOKEN on Netlify (Site configuration → Environment variables), then redeploy.'));
      return;
    }
    render(container, request, panel);
  }

  function render(container, request, { inviteUrl, settings, status, log = [], guilds, guildError, limits }) {
    // ---------- Status and quick controls ----------
    const badge = html('span', 'bot-badge');
    const summary = html('span', 'bot-summary');
    const head = html('div', 'bot-head');
    const toggle = html('button', 'profile-button');
    toggle.type = 'button';
    const actions = html('div', 'bot-actions');
    if (inviteUrl) {
      const invite = html('a', 'profile-button bot-invite', 'Invite to a server');
      invite.href = inviteUrl;
      invite.target = '_blank';
      invite.rel = 'noopener';
      actions.append(invite);
    }
    actions.append(toggle);
    const countdown = html('span', 'bot-countdown');
    // Hidden from screen readers, which would otherwise hear it every second.
    countdown.setAttribute('aria-hidden', 'true');
    head.append(badge, summary, countdown, actions);
    const error = html('p', 'bot-error');

    // ---------- Log console ----------
    const logBox = html('div', 'bot-log');
    logBox.setAttribute('role', 'log');
    logBox.setAttribute('aria-label', 'Discord bot log');
    let logShown = null;
    function showLog() {
      const key = JSON.stringify(log);
      if (key === logShown) return;
      logShown = key;
      logBox.replaceChildren(...(log.length
        ? log.map(entry => {
          const line = html('div', `bot-log-line${entry.message.startsWith('Error') ? ' is-error' : ''}`);
          line.append(html('time', 'bot-log-time', timeFormat.format(entry.at)), html('span', '', entry.message));
          return line;
        })
        : [html('div', 'bot-log-line bot-log-empty', 'Nothing yet. Settings changes and nicknames set will show here.')]));
    }

    function showStatus() {
      const nicks = Object.entries(status?.nicks || {}).filter(([id]) => settings.guildIds.includes(id));
      const lastNick = nicks.find(([, nick]) => nick)?.[1];
      badge.textContent = settings.enabled ? 'On' : 'Paused';
      badge.classList.toggle('is-on', settings.enabled);
      summary.textContent = settings.enabled
        ? [
          lastNick ? `Nickname "${lastNick}"` : 'Waiting for the first update (within a minute)',
          status?.lastNickAt && `set ${timeFormat.format(status.lastNickAt)}`,
          status?.lastRunAt && `last run ${timeFormat.format(status.lastRunAt)}`
        ].filter(Boolean).join(' · ')
        : settings.restoreOnPause ? 'Your name is put back while paused' : 'The last reading stays in your nickname while paused';
      toggle.textContent = settings.enabled ? 'Pause' : 'Resume';
      error.textContent = status?.lastError ? `${timeFormat.format(status.lastError.at)}: ${status.lastError.message}` : '';
    }

    // ---------- Settings form ----------
    const form = html('form', 'bot-form');
    const nickBase = html('input');
    nickBase.maxLength = limits.maxNickBase;
    nickBase.value = settings.nickBase;
    nickBase.placeholder = 'Kiwamari';
    const userId = html('input');
    userId.inputMode = 'numeric';
    userId.value = settings.userId;
    userId.placeholder = '17 to 20 digits';
    const interval = html('select');
    for (const minutes of limits.intervals) {
      const option = html('option', '', minutes === 1 ? 'Every minute' : `Every ${minutes} minutes`);
      option.value = String(minutes);
      option.selected = minutes === settings.intervalMinutes;
      interval.append(option);
    }

    const servers = html('fieldset', 'bot-servers');
    servers.append(html('legend', 'bot-field-name', 'Servers'));
    const serverBoxes = [];
    const known = new Set(guilds.map(guild => guild.id));
    // Servers saved earlier that the bot has since left still show, so they can be unticked.
    const listed = [...guilds, ...settings.guildIds.filter(id => !known.has(id)).map(id => ({ id, name: `${id} (bot not in this server)` }))];
    for (const guild of listed) {
      const label = html('label', 'bot-check');
      const box = html('input');
      box.type = 'checkbox';
      box.value = guild.id;
      box.checked = settings.guildIds.includes(guild.id);
      serverBoxes.push(box);
      label.append(box, html('span', '', guild.name));
      servers.append(label);
    }
    if (!listed.length) {
      servers.append(html('p', 'bot-field-hint', guildError
        ? `Couldn't ask Discord for the bot's servers: ${guildError}`
        : 'The bot isn’t in any servers yet. Invite it first, then reopen this page.'));
    }

    const restoreLabel = html('label', 'bot-check');
    const restore = html('input');
    restore.type = 'checkbox';
    restore.checked = settings.restoreOnPause;
    restoreLabel.append(restore, html('span', '', 'Put my name back when paused'));

    const preview = html('p', 'bot-field-hint');
    const updatePreview = () => {
      const base = nickBase.value.replace(/\s+/g, ' ').trim();
      const reading = status?.watts !== undefined && status?.watts !== null ? power(status.watts) : power(1240);
      preview.textContent = `Your nickname will look like "${base ? `${base} ${reading}` : reading}".`;
    };
    nickBase.addEventListener('input', updatePreview);
    updatePreview();

    const save = html('button', 'button-primary', 'Save');
    save.type = 'submit';
    const saveNote = html('span', 'bot-save-note');
    saveNote.setAttribute('role', 'status');
    const saveRow = html('div', 'bot-save');
    saveRow.append(save, saveNote);

    form.append(
      field('Name before the reading', nickBase),
      preview,
      field('Your Discord user ID', userId, 'Discord → User Settings → Advanced → Developer Mode, then right-click your name → Copy User ID.'),
      servers,
      field('Update', interval),
      restoreLabel,
      saveRow
    );

    async function send(changes, button) {
      button.disabled = true;
      saveNote.textContent = 'Saving…';
      try {
        const result = await request('POST', { action: 'wattnick-settings', settings: changes });
        settings = result.settings;
        saveNote.textContent = settings.enabled ? 'Saved. Applied within a minute.' : 'Saved.';
        showStatus();
        poll();
      } catch (failure) {
        saveNote.textContent = failure.message;
      } finally {
        button.disabled = false;
      }
    }

    form.addEventListener('submit', event => {
      event.preventDefault();
      send({
        nickBase: nickBase.value,
        userId: userId.value,
        guildIds: serverBoxes.filter(box => box.checked).map(box => box.value),
        intervalMinutes: Number(interval.value),
        restoreOnPause: restore.checked
      }, save);
    });
    toggle.addEventListener('click', () => send({ enabled: !settings.enabled }, toggle));

    // ---------- Countdown and polling ----------
    let timer = null;
    let clock = null;
    let polling = false;
    const nextRun = () => Math.ceil(Date.now() / MINUTE_MS) * MINUTE_MS;

    function showCountdown() {
      if (document.hidden) {
        countdown.textContent = 'Paused';
        return;
      }
      const seconds = Math.ceil((nextRun() - Date.now()) / 1000);
      countdown.textContent = polling || seconds >= 60 ? 'Checking…' : `Next run in ${seconds}s`;
    }

    async function poll() {
      clearTimeout(timer);
      if (!container.isConnected || document.hidden) return;
      polling = true;
      showCountdown();
      try {
        const fresh = await request('GET', null, '?wattnick=status');
        if (fresh.configured) {
          ({ settings, status, log } = fresh);
          showStatus();
          showLog();
        }
      } catch {
        // The next minute tries again; the status line keeps what it had.
      }
      polling = false;
      showCountdown();
      // A few seconds after the next run, so its result is there to show.
      timer = setTimeout(poll, nextRun() + RUN_SETTLE_MS - Date.now());
    }

    function onVisibility() {
      if (document.hidden) {
        clearTimeout(timer);
        showCountdown();
      } else {
        poll();
      }
    }

    stopPolling = () => {
      clearTimeout(timer);
      clearInterval(clock);
      document.removeEventListener('visibilitychange', onVisibility);
    };
    document.addEventListener('visibilitychange', onVisibility);
    clock = setInterval(() => {
      if (!container.isConnected) stopPolling();
      else showCountdown();
    }, 1000);
    timer = setTimeout(poll, nextRun() + RUN_SETTLE_MS - Date.now());

    showStatus();
    showLog();
    showCountdown();
    const logTitle = html('div', 'bot-field-name bot-log-title', 'Log');
    container.replaceChildren(head, error, logTitle, logBox, form);
  }

  window.discordBot = { show };
})();
