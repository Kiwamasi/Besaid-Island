// Home Suite page: the admin's controls for the Alexa speakers around the house. It's
// linked from the admin panel on the profile page rather than the nav, as nobody else
// can use it, and the site API refuses all of this to anyone but the admin. Anyone else
// who opens the address is sent to the home page, including on signing out here.
//
// The speakers are reached through Spotify (netlify/lib/spotify.mjs). ?home-suite answers
// { configured, connected, playlists, speakers: [{ id, name, type, active, online, asleep,
// playing, track, trackUri, artist, image, volume, supportsVolume }] }. asleep is a speaker
// Spotify has listed before but not now; commands to it may well fail, and unconfirmed
// marks one where Spotify took a command but it never showed up. playlists is whether the
// Spotify sign-in allows reading them; ?home-suite=playlists answers { total, playlists:
// [{ uri, name, owner, owned, tracks, image }] }; owned is null if Spotify wouldn't say whose
// account this is. ?home-suite=tracks&playlist=uri&offset=n answers one page of a playlist's
// songs: { restricted, total, nextOffset, tracks: [{ uri, name, artist, album, duration,
// added, playable }] }.
//
// POST home-suite takes { speaker, command, value, track } and answers with { speakers },
// all of them, as starting music on one stops it on another. Commands: play, pause, stop,
// previous, next, move (brings what's playing here, at the same place in the track),
// volume (value 0 to 100), music (value is what to search for) and playlist (value is
// its uri, and track the song to start from, if any). The speakers aren't polled, to keep
// requests down: they're asked for when the page opens and by Refresh.
//
// Choosing a playlist fades the others away, glides its picture into place and lists its
// songs, which then start playing only when one is pressed. The songs start newest added
// first, and each column's arrow goes one way, then the other, then neither, which is the
// playlist's own order. Spotify still plays in the playlist's order, whatever's showing.
(() => {
  const account = window.siteAccount;
  const shell = document.getElementById('suiteShell');
  const note = document.getElementById('suiteNote');
  const refresh = document.getElementById('suiteRefresh');
  const connect = document.getElementById('suiteConnect');
  const layout = document.getElementById('suiteLayout');
  const library = document.getElementById('suiteLibrary');
  const list = document.getElementById('suiteSpeakers');
  const music = document.getElementById('suiteMusic');
  const musicQuery = document.getElementById('suiteMusicQuery');
  const musicSpeaker = document.getElementById('suiteMusicSpeaker');
  const musicPlay = document.getElementById('suiteMusicPlay');
  const musicError = document.getElementById('suiteMusicError');
  const playlists = document.getElementById('suitePlaylists');
  const playlistsView = document.getElementById('suitePlaylistsView');
  const playlistsHead = document.getElementById('suitePlaylistsHead');
  const playlistFilter = document.getElementById('suitePlaylistFilter');
  const playlistsNote = document.getElementById('suitePlaylistsNote');
  const playlistList = document.getElementById('suitePlaylistList');
  const detail = document.getElementById('suiteDetail');
  const back = document.getElementById('suiteBack');
  const detailArt = document.getElementById('suiteDetailArt');
  const detailInfo = document.getElementById('suiteDetailInfo');
  const detailName = document.getElementById('suiteDetailName');
  const detailSummary = document.getElementById('suiteDetailSummary');
  const detailNote = document.getElementById('suiteDetailNote');
  const playAll = document.getElementById('suitePlayAll');
  const trackHead = document.getElementById('suiteTrackHead');
  const tracksList = document.getElementById('suiteTracks');
  const tracksNote = document.getElementById('suiteTracksNote');

  // Filled shapes on a 24 by 24 grid.
  const ICONS = {
    back: 'M20 11H7.8l5.6-5.6L12 4l-8 8 8 8 1.4-1.4L7.8 13H20z',
    next: 'M16 5h2v14h-2zM4 5v14l11-7z',
    note: 'M12 3v10.55A4 4 0 1 0 14 17V7h4V3z',
    pause: 'M6 4h4v16H6zM14 4h4v16h-4z',
    play: 'M7 4.5v15l13-7.5z',
    power: 'M13 3h-2v10h2zm4.83 2.17-1.42 1.42A6.92 6.92 0 0 1 19 12a7 7 0 1 1-11.43-5.41L6.17 5.17A8.93 8.93 0 0 0 3 12a9 9 0 1 0 14.83-6.83z',
    previous: 'M6 5h2v14H6zM20 5v14L9 12z',
    sortAsc: 'M12 7l-6 8h12z',
    sortDesc: 'M12 17l6-8H6z',
    sortNone: 'M12 4l-5 6.5h10zM12 20l5-6.5H7z'
  };
  // The columns songs can sort by. first is the way a column sorts on its first press.
  const TRACK_SORTS = {
    name: { label: 'Title', first: 'asc', value: track => track.name },
    artist: { label: 'Artist', first: 'asc', value: track => track.artist },
    album: { label: 'Album', first: 'asc', value: track => track.album },
    added: { label: 'Added', first: 'desc', value: track => track.added },
    duration: { label: 'Length', first: 'desc', value: track => track.duration }
  };
  const addedFormat = new Intl.DateTimeFormat(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
  // A very long playlist stops here rather than spending dozens of requests on it.
  const MAX_TRACKS = 1000;
  // How many of the first songs ease in one after another, as more wouldn't be seen.
  const STAGGERED_ROWS = 14;

  let shownFor = null;
  let version = 0;
  // Each speaker's card, by ID, so an answer about all the speakers can update them.
  let cards = new Map();
  // Whether any speaker has music to move, which turns the other cards' Play into Move here.
  let anyActive = false;
  // The song playing now, marked in the open playlist's list.
  let currentTrackUri = '';
  let playlistsLoaded = false;
  let playlistsTotal = 0;
  // 'all', 'owned' or 'followed'.
  let shownPlaylists = 'all';
  // How the songs are sorted: key is a TRACK_SORTS key, or null for the playlist's own order.
  let trackSort = { key: 'added', direction: 'desc' };
  // The playlist open now and the tile it was opened from. changingView stops a second
  // click starting while one change of view is still animating.
  let openPlaylist = null;
  let openTile = null;
  let changingView = false;
  let scrollBeforeOpen = 0;
  // Bumped when a playlist is opened or closed, so a slow answer about the last one is dropped.
  let detailVersion = 0;
  let startingPlaylist = false;
  // What's been read of each playlist, so reopening one doesn't ask Spotify again:
  // uri → { tracks, total, nextOffset, restricted }.
  const savedTracks = new Map();

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

  function icon(name) {
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('aria-hidden', 'true');
    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    path.setAttribute('d', ICONS[name]);
    svg.append(path);
    return svg;
  }

  function iconButton(name, label, className = '') {
    const button = html('button', `suite-icon-button ${className}`.trim());
    button.type = 'button';
    button.title = label;
    button.setAttribute('aria-label', label);
    button.append(icon(name));
    return button;
  }

  // Runs an animation, or nothing for someone who has asked their device for less motion.
  // Answers with the Animation, or null.
  function animate(element, frames, options) {
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return null;
    return element.animate(frames, options);
  }

  // An animation cancelled on the way (the page changed) counts as finished.
  function finished(animation) {
    return animation ? animation.finished.catch(() => {}) : Promise.resolve();
  }

  function sendCommand(id, command, value, track) {
    return account.request('POST', { action: 'home-suite', speaker: id, command, value, track });
  }

  function clearSpeakers() {
    cards = new Map();
    list.replaceChildren();
    layout.hidden = true;
    music.hidden = true;
    connect.hidden = true;
    musicError.textContent = '';
    playlists.hidden = true;
    playlistList.replaceChildren();
    playlistsLoaded = false;
    detailVersion++;
    openPlaylist = null;
    openTile = null;
    detail.hidden = true;
    playlistsView.hidden = false;
  }

  function speakerCard(first) {
    const card = html('li', 'suite-speaker');
    const art = html('img', 'suite-speaker-art');
    art.alt = '';
    const badge = html('span', 'suite-badge');
    const head = html('div', 'suite-speaker-head');
    head.append(html('h3', 'suite-speaker-name', first.name), badge);
    const playing = html('p', 'suite-speaker-playing');
    const text = html('div', 'suite-speaker-text');
    text.append(head, playing);
    const now = html('div', 'suite-speaker-now');
    now.append(art, text);

    const previous = iconButton('previous', `Previous on ${first.name}`);
    const toggle = iconButton('play', '', 'suite-toggle');
    const next = iconButton('next', `Next on ${first.name}`);
    const move = html('button', 'suite-button', 'Move here');
    move.type = 'button';
    move.title = 'Bring what is playing to this speaker, at the same place in the song';
    move.setAttribute('aria-label', `Move the music to ${first.name}`);
    // This stops whatever Spotify is playing: an Echo can't be powered down from outside.
    const off = iconButton('power', `Turn off ${first.name}`, 'suite-off');
    const buttons = [previous, toggle, next, move, off];
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
    card.append(now, controls, volumeRow, error);

    let speaker = first;
    function setDisabled(disabled) {
      for (const button of buttons) button.disabled = disabled;
      volume.disabled = disabled;
    }
    function show(fresh) {
      speaker = fresh;
      card.classList.toggle('is-playing', speaker.online && speaker.playing);
      card.classList.toggle('is-restricted', !speaker.online);
      card.classList.toggle('is-asleep', Boolean(speaker.asleep));
      badge.textContent = !speaker.online ? 'Restricted' : speaker.asleep ? 'Asleep' : speaker.playing ? 'Playing' : speaker.active ? 'Paused' : '';
      badge.classList.toggle('is-on', speaker.online && speaker.playing);
      playing.textContent = !speaker.online
        ? 'Spotify says it refuses remote control'
        : speaker.unconfirmed ? "Spotify accepted this, but the speaker hasn't appeared. If you can't hear it, it didn't wake."
          : speaker.asleep ? "Spotify can't see it right now, but you can still try playing to it"
          : speaker.track ? [speaker.track, speaker.artist].filter(Boolean).join(' · ') : 'Nothing playing';
      art.hidden = !speaker.image;
      if (speaker.image) art.src = speaker.image;

      // Only the speaker Spotify is playing on has anything to skip or stop. Any other
      // offers to bring the music over, or to start it if there's none playing anywhere.
      controls.hidden = !speaker.online;
      const canMove = anyActive && !speaker.active;
      for (const button of [previous, next]) button.hidden = !speaker.active;
      off.hidden = !speaker.playing;
      move.hidden = !canMove;
      toggle.hidden = canMove;
      const action = speaker.playing ? 'Pause' : 'Play';
      toggle.replaceChildren(icon(speaker.playing ? 'pause' : 'play'));
      toggle.title = action;
      toggle.setAttribute('aria-label', `${action} ${speaker.name}`);

      volumeRow.hidden = !speaker.online || !speaker.supportsVolume;
      volume.value = String(speaker.volume ?? 0);
      volumeValue.textContent = `${volume.value}%`;
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
        // A failed command can put a speaker to sleep or leave the music elsewhere, so
        // the cards are brought up to date, leaving the message showing.
        try {
          const { speakers } = await account.request('GET', null, '?home-suite');
          if (speakers) updateSpeakers(speakers);
        } catch {
          // The cards keep what they had, and Refresh can try again.
        }
      }
    }

    previous.addEventListener('click', () => send('previous'));
    toggle.addEventListener('click', () => send(speaker.playing ? 'pause' : 'play'));
    next.addEventListener('click', () => send('next'));
    move.addEventListener('click', () => send('move'));
    off.addEventListener('click', () => send('stop'));
    volume.addEventListener('input', () => { volumeValue.textContent = `${volume.value}%`; });
    // Only when the slider is let go, so a drag is one request rather than dozens.
    volume.addEventListener('change', () => send('volume', Number(volume.value)));

    show(first);
    return { card, show };
  }

  function noteSpeakers(speakers) {
    const active = speakers.find(speaker => speaker.active);
    anyActive = Boolean(active);
    currentTrackUri = active?.trackUri || '';
    markCurrentTrack();
  }

  function showSpeakers(speakers) {
    noteSpeakers(speakers);
    cards = new Map();
    list.replaceChildren(...speakers.map(speaker => {
      const made = speakerCard(speaker);
      cards.set(speaker.id, made);
      return made.card;
    }));
    fillSpeakerPicker(speakers);
  }

  function fillSpeakerPicker(speakers) {
    const chosen = musicSpeaker.value;
    const usable = speakers.filter(speaker => speaker.online);
    musicSpeaker.replaceChildren(...usable.map(speaker => {
      const option = html('option', '', speaker.asleep ? `${speaker.name} (asleep)` : speaker.name);
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
      noteSpeakers(speakers);
      for (const speaker of speakers) cards.get(speaker.id).show(speaker);
      fillSpeakerPicker(speakers);
    } else {
      showSpeakers(speakers);
    }
  }

  // ---------- Playlists ----------

  function playlistImage(playlist) {
    if (!playlist.image) {
      const empty = html('span', 'suite-playlist-image');
      empty.append(icon('note'));
      return empty;
    }
    const image = html('img', 'suite-playlist-image');
    image.src = playlist.image;
    image.alt = '';
    return image;
  }

  function songCount(count) {
    return count === null || count === undefined ? '' : `${count} ${count === 1 ? 'song' : 'songs'}`;
  }

  function playlistTile(playlist) {
    const tile = html('button', 'suite-playlist');
    tile.type = 'button';
    const details = [playlist.owner, songCount(playlist.tracks)].filter(Boolean);
    const image = playlistImage(playlist);
    if (image.tagName === 'IMG') image.loading = 'lazy';
    tile.append(image, html('span', 'suite-playlist-name', playlist.name), html('span', 'suite-playlist-detail', details.join(' · ')));
    tile.addEventListener('click', () => showPlaylist(playlist, tile));
    const item = html('li');
    item.dataset.owned = String(playlist.owned);
    item.append(tile);
    return item;
  }

  function visiblePlaylists() {
    return [...playlistList.children].filter(item => !item.hidden);
  }

  function filterPlaylists() {
    for (const item of playlistList.children) {
      item.hidden = shownPlaylists !== 'all' && item.dataset.owned !== String(shownPlaylists === 'owned');
    }
    for (const button of playlistFilter.querySelectorAll('button')) {
      button.setAttribute('aria-pressed', String(button.dataset.filter === shownPlaylists));
    }
    const count = playlistList.children.length;
    // The filter only knows about the playlists that were read, so it says so.
    const more = playlistsTotal > count ? `Showing the first ${count} of ${playlistsTotal}.` : '';
    playlistsNote.textContent = !count
      ? 'No playlists on this Spotify account.'
      : !visiblePlaylists().length ? `No ${shownPlaylists} playlists here. ${more}`.trim() : more;
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
      playlistsTotal = answer.total;
      // Without knowing whose account this is, there's nothing to filter by.
      const canFilter = answer.playlists.some(playlist => playlist.owned !== null);
      playlistFilter.hidden = !canFilter;
      if (!canFilter) shownPlaylists = 'all';
      filterPlaylists();
    } catch (error) {
      if (shownVersion === version) playlistsNote.textContent = error.message;
    }
  }

  // ---------- One playlist's songs ----------

  function duration(ms) {
    const seconds = Math.round((ms || 0) / 1000);
    return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
  }

  function addedDate(added) {
    const date = new Date(added);
    return added && !Number.isNaN(date.getTime()) ? addedFormat.format(date) : '';
  }

  function sortButton(key) {
    const button = html('button', 'suite-sort');
    button.type = 'button';
    button.dataset.sort = key;
    button.addEventListener('click', () => {
      // One way, the other way, then neither.
      const { first } = TRACK_SORTS[key];
      const second = first === 'asc' ? 'desc' : 'asc';
      if (trackSort.key !== key) trackSort = { key, direction: first };
      else if (trackSort.direction === first) trackSort = { key, direction: second };
      else trackSort = { key: null, direction: null };
      showTrackSort();
      renderTracks();
    });
    return button;
  }

  function sortGroup(keys, className = '') {
    const group = html('div', `suite-sort-group ${className}`.trim());
    group.append(...keys.map(sortButton));
    return group;
  }

  function showTrackSort() {
    for (const button of trackHead.querySelectorAll('.suite-sort')) {
      const { label } = TRACK_SORTS[button.dataset.sort];
      const sorted = trackSort.key === button.dataset.sort;
      const direction = sorted ? trackSort.direction : null;
      button.classList.toggle('is-sorted', sorted);
      button.replaceChildren(label, icon(direction === 'asc' ? 'sortAsc' : direction === 'desc' ? 'sortDesc' : 'sortNone'));
      const state = direction === 'asc' ? 'ascending' : direction === 'desc' ? 'descending' : 'not sorted';
      button.setAttribute('aria-label', `Sort by ${label}, ${state}`);
    }
  }

  // Compares by the chosen column. A song with nothing to compare goes last either way,
  // and ties stay in the playlist's order.
  function compareTracks(first, second) {
    if (!trackSort.key) return first.number - second.number;
    const { value } = TRACK_SORTS[trackSort.key];
    const [left, right] = [value(first), value(second)];
    const leftEmpty = left === '' || left === null || left === undefined;
    const rightEmpty = right === '' || right === null || right === undefined;
    if (leftEmpty !== rightEmpty) return leftEmpty ? 1 : -1;
    if (leftEmpty) return first.number - second.number;
    const order = typeof left === 'number' ? left - right : String(left).localeCompare(String(right), undefined, { sensitivity: 'base', numeric: true });
    return (trackSort.direction === 'desc' ? -order : order) || first.number - second.number;
  }

  function renderTracks() {
    const saved = openPlaylist && savedTracks.get(openPlaylist.uri);
    tracksList.replaceChildren(...(saved ? [...saved.tracks].sort(compareTracks).map(trackRow) : []));
    markCurrentTrack();
  }

  function trackRow(track) {
    const button = html('button', 'suite-track');
    button.type = 'button';
    button.dataset.uri = track.uri;
    // Spotify can't start from a song that's a file on someone's computer.
    button.disabled = !track.playable;
    const title = html('span');
    title.append(html('span', 'suite-track-name', track.name), html('span', 'suite-track-artist', track.artist));
    button.append(
      html('span', 'suite-track-number', String(track.number)),
      title,
      html('span', 'suite-track-album', track.album),
      html('span', 'suite-track-added', addedDate(track.added)),
      html('span', 'suite-track-time', duration(track.duration))
    );
    button.setAttribute('aria-label', `Play ${track.name}${track.artist ? ` by ${track.artist}` : ''}`);
    button.addEventListener('click', () => startPlaylist(track));
    const item = html('li');
    item.append(button);
    return item;
  }

  function markCurrentTrack() {
    for (const row of tracksList.querySelectorAll('.suite-track')) {
      const current = Boolean(currentTrackUri) && row.dataset.uri === currentTrackUri;
      row.classList.toggle('is-current', current);
      if (current) row.setAttribute('aria-current', 'true');
      else row.removeAttribute('aria-current');
    }
  }

  function staggerRows() {
    [...tracksList.children].slice(0, STAGGERED_ROWS).forEach((row, index) => {
      animate(row, [{ opacity: 0, transform: 'translateY(6px)' }, { opacity: 1, transform: 'none' }], {
        duration: 260, delay: 90 + index * 22, easing: 'ease-out', fill: 'backwards'
      });
    });
  }

  function showTracksSummary(playlist, saved) {
    const count = saved.total ?? playlist.tracks;
    detailSummary.textContent = [playlist.owner, songCount(count)].filter(Boolean).join(' · ');
  }

  // Reads the songs a page at a time. In the playlist's own order each page is listed as
  // it comes, so a long playlist shows straight away and the rest arrives below it. Sorted,
  // the list waits for all of them: the newest are usually on the last page, and rows
  // shifting about under the pointer could start the wrong song.
  async function loadTracks(playlist, shownDetail) {
    let saved = savedTracks.get(playlist.uri);
    if (!saved) {
      saved = { tracks: [], total: null, nextOffset: 0, restricted: false };
      savedTracks.set(playlist.uri, saved);
    }
    const complete = () => saved.nextOffset === null || saved.tracks.length >= MAX_TRACKS;
    const alreadyRead = complete();
    if (alreadyRead || !trackSort.key) renderTracks();
    showTracksSummary(playlist, saved);
    trackHead.hidden = saved.restricted;
    try {
      while (!complete()) {
        tracksNote.textContent = saved.total ? `Loading songs… ${saved.tracks.length} of ${saved.total}` : 'Loading songs…';
        const query = new URLSearchParams({ 'home-suite': 'tracks', playlist: playlist.uri, offset: String(saved.nextOffset) });
        const page = await account.request('GET', null, `?${query}`);
        if (shownDetail !== detailVersion) return;
        const firstNumber = saved.tracks.length + 1;
        saved.tracks.push(...page.tracks.map((track, index) => ({ ...track, number: firstNumber + index })));
        saved.total = page.total;
        saved.nextOffset = page.nextOffset;
        saved.restricted = Boolean(page.restricted);
        trackHead.hidden = saved.restricted;
        showTracksSummary(playlist, saved);
        if (!trackSort.key) renderTracks();
        if (!trackSort.key && firstNumber === 1 && !detail.hidden) staggerRows();
      }
      if (!alreadyRead && trackSort.key) {
        renderTracks();
        if (!detail.hidden) staggerRows();
      }
      tracksNote.textContent = saved.restricted
        ? "Spotify only lists the songs in playlists you own or collaborate on, but you can still play this one."
        : saved.nextOffset !== null ? `Showing the first ${saved.tracks.length} songs, so newer ones may be missing.`
          : saved.tracks.length ? '' : 'There are no songs in this playlist.';
    } catch (error) {
      if (shownDetail !== detailVersion) return;
      // Whatever arrived before it failed is still worth showing.
      renderTracks();
      tracksNote.textContent = error.message;
    }
  }

  async function showPlaylist(playlist, tile) {
    if (changingView) return;
    changingView = true;
    openPlaylist = playlist;
    openTile = tile;
    scrollBeforeOpen = window.scrollY;
    const shownDetail = ++detailVersion;

    detailArt.replaceChildren(playlistImage(playlist));
    detailName.textContent = playlist.name;
    detailNote.textContent = '';
    tracksNote.textContent = '';
    tracksList.replaceChildren();
    // Started now, so the songs may well be there by the time the view changes.
    loadTracks(playlist, shownDetail);

    const chosenItem = tile.parentElement;
    const others = [playlistsHead, playlistsNote, ...visiblePlaylists().filter(item => item !== chosenItem)];
    const fades = others.map(element => animate(element, [
      { opacity: 1, transform: 'none' },
      { opacity: 0, transform: 'scale(0.96)' }
    ], { duration: 240, easing: 'ease-in', fill: 'forwards' }));
    await Promise.all(fades.map(finished));
    if (shownDetail !== detailVersion) {
      for (const fade of fades) fade?.cancel();
      changingView = false;
      return;
    }

    const from = tile.querySelector('.suite-playlist-image').getBoundingClientRect();
    playlistsView.hidden = true;
    detail.hidden = false;
    for (const fade of fades) fade?.cancel();
    if (library.getBoundingClientRect().top < 0) library.scrollIntoView({ block: 'start' });

    // The chosen picture glides from its tile to its place at the top of the songs.
    const picture = detailArt.firstElementChild;
    const to = picture.getBoundingClientRect();
    const glide = animate(picture, [
      {
        transformOrigin: 'top left',
        transform: `translate(${from.left - to.left}px, ${from.top - to.top}px) scale(${from.width / to.width})`
      },
      { transformOrigin: 'top left', transform: 'none' }
    ], { duration: 380, easing: 'cubic-bezier(0.2, 0.8, 0.2, 1)' });
    for (const element of [back, detailInfo]) {
      animate(element, [{ opacity: 0, transform: 'translateY(6px)' }, { opacity: 1, transform: 'none' }], {
        duration: 280, delay: 110, easing: 'ease-out', fill: 'backwards'
      });
    }
    staggerRows();
    back.focus({ preventScroll: true });
    await finished(glide);
    changingView = false;
  }

  async function closePlaylist() {
    if (changingView || !openPlaylist) return;
    changingView = true;
    detailVersion++;
    const leaving = animate(detail, [
      { opacity: 1, transform: 'none' },
      { opacity: 0, transform: 'translateY(6px)' }
    ], { duration: 170, easing: 'ease-in', fill: 'forwards' });
    await finished(leaving);
    detail.hidden = true;
    leaving?.cancel();
    playlistsView.hidden = false;
    window.scrollTo(0, scrollBeforeOpen);
    [playlistsHead, playlistsNote, ...visiblePlaylists()].forEach((element, index) => {
      animate(element, [{ opacity: 0, transform: 'scale(0.97)' }, { opacity: 1, transform: 'none' }], {
        duration: 260, delay: Math.min(index * 14, 160), easing: 'ease-out', fill: 'backwards'
      });
    });
    openTile?.focus({ preventScroll: true });
    openPlaylist = null;
    openTile = null;
    changingView = false;
  }

  // The whole playlist, or from one of its songs.
  async function startPlaylist(track) {
    if (startingPlaylist || !openPlaylist) return;
    const id = musicSpeaker.value;
    if (!id) {
      detailNote.textContent = 'There are no speakers to play on. Press Refresh, or play something on one from the Spotify app.';
      return;
    }
    const what = track?.name || openPlaylist.name;
    const speakerName = musicSpeaker.selectedOptions[0].textContent;
    startingPlaylist = true;
    playAll.disabled = true;
    detailNote.textContent = `Starting ${what} on ${speakerName}…`;
    try {
      const result = await sendCommand(id, 'playlist', openPlaylist.uri, track?.uri);
      updateSpeakers(result.speakers);
      detailNote.textContent = result.speakers.find(speaker => speaker.id === id)?.unconfirmed
        ? `Sent ${what} to ${speakerName}, but Spotify hasn't shown it playing there.`
        : `Playing ${what} on ${speakerName}.`;
    } catch (failure) {
      detailNote.textContent = failure.message;
    } finally {
      startingPlaylist = false;
      playAll.disabled = false;
    }
  }

  // ---------- Loading the page ----------

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
      layout.hidden = false;
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

  playlistFilter.addEventListener('click', event => {
    const button = event.target.closest('button');
    if (!button) return;
    shownPlaylists = button.dataset.filter;
    filterPlaylists();
  });

  // Empty cells keep the arrows above their columns. Title and Artist share one.
  trackHead.append(
    html('span'),
    sortGroup(['name', 'artist']),
    sortGroup(['album']),
    sortGroup(['added'], 'suite-sort-end'),
    sortGroup(['duration'], 'suite-sort-end')
  );
  showTrackSort();

  back.prepend(icon('back'));
  back.addEventListener('click', closePlaylist);
  playAll.addEventListener('click', () => startPlaylist(null));
  refresh.addEventListener('click', load);

  function render() {
    if (account.status === 'checking') return;
    if (!account.user?.isAdmin) {
      shownFor = null;
      version++;
      clearSpeakers();
      refresh.hidden = true;
      // The account service being down says nothing about who this is, so they stay and
      // can try again. replace, so Back doesn't land here and bounce them straight away.
      if (account.status !== 'unavailable') {
        shell.hidden = true;
        window.location.replace('index.html');
        return;
      }
      shell.hidden = false;
      note.textContent = 'The account service is unavailable right now.';
      return;
    }
    shell.hidden = false;
    if (shownFor === account.user.username) return;
    shownFor = account.user.username;
    load();
  }

  document.addEventListener('site-account-change', render);
  render();
})();
