// Home Suite page: the admin's controls for the Alexa speakers around the house. It's
// linked from the admin panel on the profile page rather than the nav, as nobody else
// can use it, and the site API refuses all of this to anyone but the admin.
//
// The speakers are reached through Spotify (netlify/lib/spotify.mjs). ?home-suite answers
// { configured, connected, controls, speakers: [{ id, name, type, active, online, volume,
// playing, track, artist }] }. Until controls is true the server only lists what Spotify
// can see, with no way to send commands, so the speakers show as plain cards.
//
// POST home-suite takes { speaker, command, value } and answers with that speaker as it
// now is. Commands: play, pause, stop, previous, next, volume (value 0 to 100) and music
// (value is what to play). The speakers aren't polled, to keep requests down: they're
// asked for when the page opens and by Refresh.
(() => {
  const account = window.siteAccount;
  const note = document.getElementById('suiteNote');
  const refresh = document.getElementById('suiteRefresh');
  const connect = document.getElementById('suiteConnect');
  const list = document.getElementById('suiteSpeakers');
  const music = document.getElementById('suiteMusic');
  const musicQuery = document.getElementById('suiteMusicQuery');
  const musicSpeaker = document.getElementById('suiteMusicSpeaker');
  const musicPlay = document.getElementById('suiteMusicPlay');
  const musicError = document.getElementById('suiteMusicError');

  let shownFor = null;
  let version = 0;
  // Each speaker's card, by ID, so the music form can update the one it played on.
  let cards = new Map();

  // Spotify sends the browser back with how connecting went (see backlog.mjs). Read once
  // and taken out of the address, so a reload doesn't repeat the message.
  const SPOTIFY_RESULTS = {
    denied: 'Spotify access was declined.',
    failed: "Couldn't connect to Spotify: check the app's Client ID, secret and redirect URI, then try again."
  };
  const address = new URL(window.location.href);
  let spotifyResult = SPOTIFY_RESULTS[address.searchParams.get('spotify')] || '';
  if (address.searchParams.has('spotify')) {
    address.searchParams.delete('spotify');
    history.replaceState(history.state, '', address);
  }

  function html(tag, className, text) {
    const element = document.createElement(tag);
    if (className) element.className = className;
    if (text !== undefined) element.textContent = text;
    return element;
  }

  function sendCommand(id, command, value) {
    return account.request('POST', { action: 'home-suite', speaker: id, command, value });
  }

  function clearSpeakers() {
    cards = new Map();
    list.replaceChildren();
    music.hidden = true;
    connect.hidden = true;
    musicError.textContent = '';
  }

  // A speaker as Spotify lists it, before there are controls to send it commands.
  function deviceCard(device) {
    const card = html('li', 'suite-speaker');
    const head = html('div', 'suite-speaker-head');
    const badge = html('span', 'suite-badge', !device.online ? 'Restricted' : device.active ? 'Active' : 'Available');
    badge.classList.toggle('is-on', device.online && device.active);
    head.append(html('h2', 'suite-speaker-name', device.name), badge);
    const details = [device.type];
    if (device.volume !== null && device.volume !== undefined) details.push(`Volume ${device.volume}%`);
    if (!device.online) details.push('Spotify says it refuses remote control');
    card.append(head, html('p', 'suite-speaker-playing', details.join(' · ')));
    return card;
  }

  function speakerCard(first) {
    const card = html('li', 'suite-speaker');
    const head = html('div', 'suite-speaker-head');
    const badge = html('span', 'suite-badge');
    head.append(html('h2', 'suite-speaker-name', first.name), badge);
    const playing = html('p', 'suite-speaker-playing');

    const previous = html('button', 'suite-button', 'Previous');
    const toggle = html('button', 'suite-button suite-toggle');
    const next = html('button', 'suite-button', 'Next');
    // This stops whatever's playing: an Echo can't be powered down from outside.
    const off = html('button', 'suite-button suite-off', 'Turn off');
    off.title = 'Stops whatever is playing on this speaker';
    previous.setAttribute('aria-label', `Previous on ${first.name}`);
    next.setAttribute('aria-label', `Next on ${first.name}`);
    off.setAttribute('aria-label', `Turn off ${first.name}`);
    const buttons = [previous, toggle, next, off];
    for (const button of buttons) button.type = 'button';
    const controls = html('div', 'suite-controls');
    controls.append(...buttons);

    const volumeRow = html('label', 'suite-volume');
    const volumeValue = html('span', 'suite-volume-value');
    const volume = html('input');
    volume.type = 'range';
    volume.min = '0';
    volume.max = '100';
    volume.setAttribute('aria-label', `Volume on ${first.name}`);
    volumeRow.append(html('span', '', 'Volume'), volume, volumeValue);

    const error = html('p', 'suite-error');
    error.setAttribute('role', 'alert');
    card.append(head, playing, controls, volumeRow, error);

    let speaker = first;
    function setDisabled(disabled) {
      for (const button of buttons) button.disabled = disabled || !speaker.online;
      volume.disabled = disabled || !speaker.online;
    }
    function show(fresh) {
      speaker = fresh;
      badge.textContent = !speaker.online ? 'Offline' : speaker.playing ? 'Playing' : 'Idle';
      badge.classList.toggle('is-on', speaker.online && speaker.playing);
      playing.textContent = speaker.track
        ? [speaker.track, speaker.artist].filter(Boolean).join(' · ')
        : 'Nothing playing';
      toggle.textContent = speaker.playing ? 'Pause' : 'Play';
      toggle.setAttribute('aria-label', `${speaker.playing ? 'Pause' : 'Play'} ${speaker.name}`);
      volume.value = String(speaker.volume ?? 0);
      volumeValue.textContent = `${volume.value}%`;
      setDisabled(false);
    }

    async function send(command, value) {
      setDisabled(true);
      error.textContent = '';
      try {
        const result = await sendCommand(speaker.id, command, value);
        show(result.speaker);
      } catch (failure) {
        error.textContent = failure.message;
        // Back to what the speaker last said, as the slider may have moved.
        show(speaker);
      }
    }

    previous.addEventListener('click', () => send('previous'));
    toggle.addEventListener('click', () => send(speaker.playing ? 'pause' : 'play'));
    next.addEventListener('click', () => send('next'));
    off.addEventListener('click', () => send('stop'));
    volume.addEventListener('input', () => { volumeValue.textContent = `${volume.value}%`; });
    // Only when the slider is let go, so a drag is one request rather than dozens.
    volume.addEventListener('change', () => send('volume', Number(volume.value)));

    show(first);
    return { card, show };
  }

  function showSpeakers(speakers) {
    cards = new Map();
    list.replaceChildren(...speakers.map(speaker => {
      const made = speakerCard(speaker);
      cards.set(speaker.id, made);
      return made.card;
    }));
    const chosen = musicSpeaker.value;
    musicSpeaker.replaceChildren(...speakers.filter(speaker => speaker.online).map(speaker => {
      const option = html('option', '', speaker.name);
      option.value = speaker.id;
      return option;
    }));
    if ([...musicSpeaker.options].some(option => option.value === chosen)) musicSpeaker.value = chosen;
    music.hidden = !musicSpeaker.options.length;
  }

  async function load() {
    const shownVersion = ++version;
    refresh.hidden = false;
    refresh.disabled = true;
    note.textContent = 'Asking the speakers…';
    try {
      const answer = await account.request('GET', null, '?home-suite');
      if (shownVersion !== version) return;
      // An older Netlify service doesn't know ?home-suite and answers with a backlog instead.
      if (typeof answer.configured !== 'boolean') {
        throw new Error('The Netlify service is out of date: redeploy it (Netlify → Deploys → Trigger deploy).');
      }
      if (!answer.configured) {
        clearSpeakers();
        note.textContent = "Spotify isn't set up yet: add SPOTIFY_CLIENT_ID and SPOTIFY_CLIENT_SECRET on Netlify, then redeploy.";
        return;
      }
      if (!answer.connected) {
        clearSpeakers();
        connect.hidden = false;
        note.textContent = spotifyResult || "Spotify isn't connected yet.";
        spotifyResult = '';
        return;
      }
      connect.hidden = true;
      if (answer.controls) {
        showSpeakers(answer.speakers);
      } else {
        clearSpeakers();
        list.replaceChildren(...answer.speakers.map(deviceCard));
      }
      note.textContent = !answer.speakers.length
        ? "Spotify can't see any speakers right now. Play something on an Echo from the Spotify app, then press Refresh."
        : answer.controls ? '' : 'These are the speakers Spotify can see right now. The controls come next.';
    } catch (error) {
      if (shownVersion !== version) return;
      note.textContent = error.message;
    } finally {
      if (shownVersion === version) refresh.disabled = false;
    }
  }

  music.addEventListener('submit', async event => {
    event.preventDefault();
    const id = musicSpeaker.value;
    musicPlay.disabled = true;
    musicError.textContent = '';
    try {
      const result = await sendCommand(id, 'music', musicQuery.value.trim());
      cards.get(id)?.show(result.speaker);
      musicQuery.value = '';
    } catch (failure) {
      musicError.textContent = failure.message;
    } finally {
      musicPlay.disabled = false;
    }
  });

  connect.addEventListener('click', async () => {
    connect.disabled = true;
    try {
      const { url } = await account.request('POST', { action: 'spotify-connect' });
      window.location.href = url;
    } catch (error) {
      note.textContent = error.message;
      connect.disabled = false;
    }
  });

  refresh.addEventListener('click', load);

  function render() {
    if (account.status === 'checking') return;
    if (!account.user?.isAdmin) {
      shownFor = null;
      version++;
      clearSpeakers();
      refresh.hidden = true;
      note.textContent = account.status === 'unavailable'
        ? 'The account service is unavailable right now.'
        : 'Only the admin can use this page.';
      return;
    }
    if (shownFor === account.user.username) return;
    shownFor = account.user.username;
    load();
  }

  document.addEventListener('site-account-change', render);
  render();
})();
