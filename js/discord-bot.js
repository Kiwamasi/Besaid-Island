// The Discord nickname bot's controls, in the admin panel on Kiwamari's profile page
// (js/profile.js). The bot itself runs on Netlify (netlify/lib/wattnick.mjs): once a
// minute it sets Kiwamari's nickname in the chosen servers to the Home Mini's reading.
// Here: invite it to a server, pause or resume it, and change its settings. The site
// API refuses all of this to anyone but the admin, and the bot's token stays on Netlify.
//
// window.discordBot.show(container, request): request is siteAccount.request.
(() => {
  const timeFormat = new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  const power = watts => (watts < 1000 ? `${Math.round(watts)} W` : `${(watts / 1000).toFixed(2)} kW`);

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

  let version = 0;

  async function show(container, request) {
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

  function render(container, request, { inviteUrl, settings, status, guilds, guildError, limits }) {
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
    head.append(badge, summary, actions);
    const error = html('p', 'bot-error');

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
      const reading = status?.watts !== undefined && status?.watts !== null ? power(status.watts) : '1.24 kW';
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

    showStatus();
    container.replaceChildren(head, error, form);
  }

  window.discordBot = { show };
})();
