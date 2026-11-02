// Home Suite page: the admin's controls for the Alexa speakers around the house. It's
// linked from the admin panel on the profile page rather than the nav, as nobody else
// can use it, and the site API refuses all of this to anyone but the admin.
//
// The speakers are reached through Spotify (netlify/lib/spotify.mjs). ?home-suite answers
// { configured, connected, playlists, speakers: [{ id, name, type, active, online, playing,
// track, artist, volume, supportsVolume }] }. playlists is whether the Spotify sign-in
// allows reading them; ?home-suite=playlists answers { total, playlists: [{ uri, name,
// owner, tracks, image }] }.
//
// POST home-suite takes { speaker, command, value } and answers with { speakers }, all of
// them, as starting music on one stops it on another. Commands: play, pause, stop,
// previous, next, volume (value 0 to 100), music (value is what to search for) and
// playlist (value is its uri). The speakers aren't polled, to keep requests down: they're
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
  const playlists = document.getElementById('suitePlaylists');
  const playlistsNote = document.getElementById('suitePlaylistsNote');
  const playlistList = document.getElementById('suitePlaylistList');

  let shownFor = null;
  let version = 0;
  // Each speaker's card, by ID, so an answer about all the speakers can update them.
  let cards = new Map();
  let playlistsLoaded = false;

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
    playlists.hidden = true;
    playlistList.replaceChildren();
    playlistsLoaded = false;
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
    // This stops whatever Spotify is playing: an Echo can't be powered down from outside.
    const off = html('button', 'suite-button suite-off', 'Turn off');
    off.title = 'Stops Spotify on this speaker';
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
      const blocked = disabled || !speaker.online;
      toggle.disabled = blocked;
      // Only the speaker Spotify is playing on has anything to skip or stop.
      previous.disabled = blocked || !speaker.active;
      next.disabled = blocked || !speaker.active;
      off.disabled = blocked || !speaker.playing;
      volume.disabled = blocked || !speaker.supportsVolume;
    }
    function show(fresh) {
      speaker = fresh;
      badge.textContent = !speaker.online ? 'Restricted' : speaker.playing ? 'Playing' : speaker.active ? 'Paused' : 'Idle';
      badge.classList.toggle('is-on', speaker.online && speaker.playing);
      playing.textContent = !speaker.online
        ? 'Spotify says it refuses remote control'
        : speaker.track ? [speaker.track, speaker.artist].filter(Boolean).join(' · ') : 'Nothing playing';
      toggle.textContent = speaker.playing ? 'Pause' : 'Play';
      toggle.setAttribute('aria-label', `${speaker.playing ? 'Pause' : 'Play'} ${speaker.name}`);
      volume.value = String(speaker.volume ?? 0);
      volumeValue.textContent = speaker.supportsVolume ? `${volume.value}%` : 'n/a';
      setDisabled(false);
    }

    async function send(command, value) {
      setDisabled(true);
      error.textContent = '';
      try {
        const result = await sendCommand(speaker.id, command, value);
        updateSpeakers(result.speakers);
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
    const usable = speakers.filter(speaker => speaker.online);
    musicSpeaker.replaceChildren(...usable.map(speaker => {
      const option = html('option', '', speaker.name);
      option.value = speaker.id;
      return option;
    }));
    // What was picked, or else the speaker already playing.
    const pick = usable.find(speaker => speaker.id === chosen) || usable.find(speaker => speaker.active);
    if (pick) musicSpeaker.value = pick.id;
    music.hidden = !usable.length;
  }

  // Keeps the cards in place, so focus isn't lost, unless the speakers themselves changed
  // (Spotify drops an Echo from its list once it's been quiet for a while).
  function updateSpeakers(speakers) {
    if (speakers.length === cards.size && speakers.every(speaker => cards.has(speaker.id))) {
      for (const speaker of speakers) cards.get(speaker.id).show(speaker);
    } else {
      showSpeakers(speakers);
    }
  }

  function playlistTile(playlist) {
    const tile = html('button', 'suite-playlist');
    tile.type = 'button';
    const image = playlist.image ? html('img', 'suite-playlist-image') : html('span', 'suite-playlist-image');
    if (playlist.image) {
      image.src = playlist.image;
      image.alt = '';
      image.loading = 'lazy';
    }
    const details = [playlist.owner, playlist.tracks === null ? '' : `${playlist.tracks} tracks`].filter(Boolean);
    tile.append(image, html('span', 'suite-playlist-name', playlist.name), html('span', 'suite-playlist-detail', details.join(' · ')));
    tile.setAttribute('aria-label', `Play ${playlist.name}`);
    tile.addEventListener('click', () => playPlaylist(playlist));
    const item = html('li');
    item.append(tile);
    return item;
  }

  async function playPlaylist(playlist) {
    const id = musicSpeaker.value;
    if (!id) {
      playlistsNote.textContent = 'There are no speakers to play on. Press Refresh, or play something on one from the Spotify app.';
      return;
    }
    const speakerName = musicSpeaker.selectedOptions[0].textContent;
    const tiles = [...playlistList.querySelectorAll('button')];
    for (const tile of tiles) tile.disabled = true;
    playlistsNote.textContent = `Starting ${playlist.name} on ${speakerName}…`;
    try {
      const result = await sendCommand(id, 'playlist', playlist.uri);
      updateSpeakers(result.speakers);
      playlistsNote.textContent = `Playing ${playlist.name} on ${speakerName}.`;
    } catch (failure) {
      playlistsNote.textContent = failure.message;
    } finally {
      for (const tile of tiles) tile.disabled = false;
    }
  }

  async function loadPlaylists() {
    if (playlistsLoaded) return;
    const shownVersion = version;
    playlists.hidden = false;
    playlistsNote.textContent = 'Loading playlists…';
    try {
      const answer = await account.request('GET', null, '?home-suite=playlists');
      if (shownVersion !== version) return;
      playlistList.replaceChildren(...answer.playlists.map(playlistTile));
      playlistsLoaded = true;
      playlistsNote.textContent = !answer.playlists.length
        ? 'No playlists on this Spotify account.'
        : `Press one to play it on the speaker picked under Play music.${answer.total > answer.playlists.length ? ` Showing the first ${answer.playlists.length} of ${answer.total}.` : ''}`;
    } catch (error) {
      if (shownVersion === version) playlistsNote.textContent = error.message;
    }
  }

  async function load() {
    const shownVersion = ++version;
    refresh.hidden = false;
    refresh.disabled = true;
    note.textContent = 'Asking Spotify…';
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
        connect.textContent = 'Connect Spotify';
        connect.hidden = false;
        connect.disabled = false;
        note.textContent = spotifyResult || "Spotify isn't connected yet.";
        spotifyResult = '';
        return;
      }
      showSpeakers(answer.speakers);
      // A sign-in from before the playlists were added still works for the speakers.
      connect.textContent = 'Reconnect Spotify';
      connect.hidden = answer.playlists;
      connect.disabled = false;
      note.textContent = [
        spotifyResult,
        !answer.speakers.length && "Spotify can't see any speakers right now. Play something on an Echo from the Spotify app, then press Refresh.",
        !answer.playlists && 'Reconnect Spotify to show your playlists here: it needs one more permission.'
      ].filter(Boolean).join(' ');
      spotifyResult = '';
      if (answer.playlists) loadPlaylists();
    } catch (error) {
      if (shownVersion !== version) return;
      note.textContent = error.message;
    } finally {
      if (shownVersion === version) refresh.disabled = false;
    }
  }

  music.addEventListener('submit', async event => {
    event.preventDefault();
    musicPlay.disabled = true;
    musicError.textContent = '';
    try {
      const result = await sendCommand(musicSpeaker.value, 'music', musicQuery.value.trim());
      updateSpeakers(result.speakers);
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
