// Live electricity use from the Octopus Home Mini, for the admin panel on the profile
// page (js/profile.js), drawn like the live graph in the Octopus app: the power being
// drawn now in large type, and a line of recent demand under it. Tabs pick the line's
// span: the last 15 minutes or hour of 10-second readings, or "All", the five-minute
// readings for as far back as Octopus keeps them, a day at a time with previous / next
// day buttons. It asks the site API again a few seconds after each minute's scheduled
// run while the tab is visible, and pauses while it's hidden. Hovering the line (or
// the arrow keys once the chart has focus) reads off any moment.
//
// window.energyLive.start(container, { load, loadHistory, setPaused, onUpdate }):
//   load()          resolves to the site API's ?energy-live answer:
//                   { readAt, demand, points: [[time, watts], …], today: { kwh } | null, updatedAt }
//   loadHistory(date)  resolves to the site API's ?energy-history answer for that UK day
//                   ('YYYY-MM-DD', or null for the newest), asked for only while "All" is
//                   chosen: { days, date, from, to, points: [[time, watts], …], complete,
//                   updatedAt, nextAt, error }
//   setPaused(on)   resolves to { paused } once readings are paused (or resumed) on the
//                   site API; without it there's no Pause button. While paused, ?energy-live
//                   answers with paused: true and the saved readings, and the page stops asking.
//   onUpdate(live)  called after each answer (null after an error), e.g. for the Today tile
// window.energyLive.stop()
(() => {
  const SVG = 'http://www.w3.org/2000/svg';
  // The site API only hands back what the scheduled Netlify job saved from Octopus at
  // the top of each minute, the same run that sets the Discord nickname. So the page
  // asks once a minute, a few seconds (settle) after the run, to show the reading the
  // nickname got (js/discord-bot.js times its status checks the same way). If the answer
  // is still the last run's, the job is late: it asks again every RECHECK_MS, up to
  // MAX_RECHECKS times, and learns to wait SETTLE_STEP_MS longer from then on (up to
  // MAX_SETTLE_MS), so it's usually one call a minute. Each minute the first try finds
  // the new run, settle creeps back by SETTLE_EASE_MS, down to SETTLE_MS.
  const RUN_MS = 60000;
  const SETTLE_MS = 6000;
  const SETTLE_STEP_MS = 5000;
  const SETTLE_EASE_MS = 1000;
  const MAX_SETTLE_MS = 21000;
  const RECHECK_MS = 5000;
  const MAX_RECHECKS = 3;
  let settle = SETTLE_MS;
  // The job updates the history every 5 minutes while it's still fetching older days and
  // every 15 after, and says when the next update is due (nextAt), so "All" asks for the
  // newest day again HISTORY_SETTLE_MS after that. If that answer is still the old one
  // (or an error), it waits HISTORY_RETRY_MS before asking again. Past days don't change
  // between updates, so each is only asked for once per update.
  const HISTORY_SETTLE_MS = 30000;
  const HISTORY_RETRY_MS = 5 * 60 * 1000;
  const MINUTE = 60000;
  const HOUR = 60 * MINUTE;
  const DAY = 24 * HOUR;
  // A newest reading older than this suggests the Home Mini has stopped reporting.
  const STALE_MS = 5 * 60 * 1000;
  const WIDTH = 640;
  const HEIGHT = 200;
  const PLOT = { left: 44, right: 10, top: 24, bottom: 24 };
  const VIEW_KEY = 'energy-live-view';

  // window: how far back the line goes (null: a whole day). gap: readings further apart
  // than this leave a gap in the line rather than joining up. step: how many readings
  // the arrow keys move.
  const VIEWS = {
    quarter: { label: '15 min', window: 15 * MINUTE, gap: 45000, step: 6, stepText: 'minute', span: 'the last 15 minutes' },
    hour: { label: '1 hour', window: HOUR, gap: 45000, step: 6, stepText: 'minute', span: 'the last hour' },
    all: { label: 'All', window: null, gap: 11 * MINUTE, step: 12, stepText: 'hour', span: null }
  };
  const FIVE_MINUTES = 5 * MINUTE;
  // Gaps between the times along the bottom; the smallest giving at most six labels.
  const TICK_STEPS = [5 * MINUTE, 15 * MINUTE, 30 * MINUTE, HOUR, 3 * HOUR, 6 * HOUR, 12 * HOUR, DAY, 2 * DAY, 7 * DAY, 14 * DAY];

  const london = { timeZone: 'Europe/London' };
  const timeFormat = new Intl.DateTimeFormat('en-GB', { ...london, hour: '2-digit', minute: '2-digit' });
  const secondsFormat = new Intl.DateTimeFormat('en-GB', { ...london, hour: '2-digit', minute: '2-digit', second: '2-digit' });
  const dayTimeFormat = new Intl.DateTimeFormat('en-GB', { ...london, weekday: 'short', hour: '2-digit', minute: '2-digit' });
  const dateFormat = new Intl.DateTimeFormat('en-GB', { ...london, day: 'numeric', month: 'short' });
  const fullFormat = new Intl.DateTimeFormat('en-GB', { ...london, weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
  const zoneFormat = new Intl.DateTimeFormat('en-GB', { ...london, timeZoneName: 'shortOffset' });
  // A 'YYYY-MM-DD' day's name, like "Thu 29 Oct", read as UTC so it's that date anywhere.
  const dayNameFormat = new Intl.DateTimeFormat('en-GB', { timeZone: 'UTC', weekday: 'short', day: 'numeric', month: 'short' });
  const dayName = date => {
    const [year, month, day] = date.split('-').map(Number);
    return dayNameFormat.format(Date.UTC(year, month - 1, day));
  };
  const axisFormat = new Intl.NumberFormat(undefined, { maximumFractionDigits: 2 });
  const kwhFormat = new Intl.NumberFormat(undefined, { maximumFractionDigits: 2 });

  const power = watts => (watts < 1000
    ? `${Math.round(watts)} W`
    : `${(watts / 1000).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })} kW`);

  function svg(tag, attributes = {}) {
    const element = document.createElementNS(SVG, tag);
    for (const [name, value] of Object.entries(attributes)) element.setAttribute(name, value);
    return element;
  }

  function html(tag, className, text) {
    const element = document.createElement(tag);
    if (className) element.className = className;
    if (text !== undefined) element.textContent = text;
    return element;
  }

  function readView() {
    try {
      const saved = localStorage.getItem(VIEW_KEY);
      return VIEWS[saved] ? saved : 'hour';
    } catch {
      return 'hour';
    }
  }

  function saveView(view) {
    try {
      localStorage.setItem(VIEW_KEY, view);
    } catch {
      // Only a convenience: the hour view is shown next time instead.
    }
  }

  // How far UK time is ahead of UTC then, so day and hour labels fall on UK clock times.
  function londonOffset(time) {
    const zone = zoneFormat.formatToParts(time).find(part => part.type === 'timeZoneName').value;
    const [, sign, hours, minutes] = zone.match(/^GMT(?:([+-])(\d+)(?::(\d+))?)?$/) || [];
    return sign ? (sign === '-' ? -1 : 1) * (Number(hours) * 60 + Number(minutes || 0)) * MINUTE : 0;
  }

  // A round step for the y axis giving about four gridlines.
  function niceStep(max) {
    const rough = max / 4;
    const power10 = 10 ** Math.floor(Math.log10(rough));
    return [1, 2, 2.5, 5, 10].map(step => step * power10).find(step => step >= rough);
  }

  // Runs of readings with no gap longer than gap, each drawn as its own line.
  function segments(points, gap) {
    const runs = [];
    for (const point of points) {
      const run = runs.at(-1);
      if (run && point[0] - run.at(-1)[0] <= gap) run.push(point);
      else runs.push([point]);
    }
    return runs;
  }

  // A day's five-minute readings, then the live readings newer than them that day
  // averaged into five minutes too, so today reaches the present between history updates.
  function joinHistory(history, live) {
    const points = history.points.slice();
    const after = points.at(-1)?.[0] ?? -Infinity;
    const buckets = new Map();
    for (const [time, watts] of live?.points || []) {
      const bucket = Math.floor(time / FIVE_MINUTES) * FIVE_MINUTES;
      if (bucket <= after || bucket < history.from || bucket >= history.to) continue;
      const sum = buckets.get(bucket) || [0, 0];
      buckets.set(bucket, [sum[0] + watts, sum[1] + 1]);
    }
    for (const [bucket, [total, count]] of buckets) points.push([bucket, Math.round(total / count)]);
    return points;
  }

  // tickStep, tipFormat and spanText are optional, for "All"'s whole days.
  function drawChart({ points: allPoints, start, end, view, live, tickStep: fixedStep, tipFormat: fixedTip, spanText: fixedSpan }, tooltip, frame, state) {
    const points = allPoints.filter(([time]) => time >= start && time <= end);
    const span = Math.max(end - start, MINUTE);
    const chart = svg('svg', {
      viewBox: `0 0 ${WIDTH} ${HEIGHT}`,
      class: 'energy-chart-svg energy-live-svg',
      role: 'img',
      tabindex: '0'
    });
    const plotWidth = WIDTH - PLOT.left - PLOT.right;
    const plotHeight = HEIGHT - PLOT.top - PLOT.bottom;
    const max = Math.max(0, ...points.map(([, watts]) => watts));
    // Kilowatts once the scale reaches 1 kW, so the axis reads like the Octopus app.
    const inKw = max >= 1000;
    const step = max > 0 ? niceStep(max) : 100;
    const top = Math.max(step, Math.ceil(max / step) * step);
    const x = time => PLOT.left + ((time - start) / span) * plotWidth;
    const y = watts => PLOT.top + plotHeight - (watts / top) * plotHeight;

    const gradient = svg('linearGradient', { id: 'energyLiveFill', x1: 0, y1: 0, x2: 0, y2: 1 });
    gradient.append(
      svg('stop', { offset: '0%', class: 'energy-live-stop-top' }),
      svg('stop', { offset: '100%', class: 'energy-live-stop-bottom' })
    );
    const defs = svg('defs');
    defs.append(gradient);
    chart.append(defs);

    for (let value = 0; value <= top + step / 1000; value += step) {
      chart.append(svg('line', { class: 'energy-grid', x1: PLOT.left, x2: WIDTH - PLOT.right, y1: y(value), y2: y(value) }));
      const tick = svg('text', { class: 'energy-axis', x: PLOT.left - 6, y: y(value) + 3, 'text-anchor': 'end' });
      tick.textContent = axisFormat.format(inKw ? value / 1000 : value);
      chart.append(tick);
    }
    const unit = svg('text', { class: 'energy-axis', x: PLOT.left - 6, y: PLOT.top - 6, 'text-anchor': 'end' });
    unit.textContent = inKw ? 'kW' : 'W';
    chart.append(unit);

    // Times along the bottom on round UK clock times: just the time within a day, the
    // weekday too over longer spans, and the date once they're a day or more apart.
    const tickStep = fixedStep || TICK_STEPS.find(each => span / each <= 6) || TICK_STEPS.at(-1);
    // Stepped in UK clock time, with each label's own offset, so they stay on the hour
    // across a clock change.
    const tickFormat = tickStep >= DAY ? dateFormat : span > DAY ? dayTimeFormat : timeFormat;
    for (let clock = Math.ceil((start + londonOffset(start)) / tickStep) * tickStep; ; clock += tickStep) {
      const time = clock - londonOffset(clock);
      if (time > end) break;
      if (time < start) continue;
      const label = svg('text', { class: 'energy-axis', x: x(time), y: HEIGHT - 6, 'text-anchor': 'middle' });
      label.textContent = tickFormat.format(time);
      chart.append(label);
    }

    for (const run of segments(points, view.gap)) {
      const line = run.map(([time, watts], index) => `${index ? 'L' : 'M'}${x(time).toFixed(1)},${y(watts).toFixed(1)}`).join('');
      if (run.length > 1) {
        chart.append(svg('path', {
          class: 'energy-live-area',
          d: `${line}L${x(run.at(-1)[0]).toFixed(1)},${y(0)}L${x(run[0][0]).toFixed(1)},${y(0)}Z`
        }));
      }
      chart.append(svg('path', { class: 'energy-live-line', d: line }));
    }

    // The newest reading, with a pulse to show the chart is live.
    const newest = points.at(-1);
    if (newest) {
      if (live) chart.append(svg('circle', { class: 'energy-live-pulse', cx: x(newest[0]), cy: y(newest[1]), r: 4 }));
      chart.append(svg('circle', { class: 'energy-live-point', cx: x(newest[0]), cy: y(newest[1]), r: 4 }));
    }

    const cursor = svg('line', { class: 'energy-live-cursor', y1: PLOT.top, y2: PLOT.top + plotHeight, visibility: 'hidden' });
    const marker = svg('circle', { class: 'energy-live-marker', r: 4.5, visibility: 'hidden' });
    chart.append(cursor, marker);

    // Readings within the last day only need the time; older ones need the date too.
    const tipFormat = fixedTip || (span > DAY ? fullFormat : secondsFormat);
    let active = null;
    function setActive(index) {
      active = index;
      const point = index === null ? null : points[index];
      if (!point) {
        cursor.setAttribute('visibility', 'hidden');
        marker.setAttribute('visibility', 'hidden');
        tooltip.hidden = true;
        state.hoverTime = null;
        return;
      }
      state.hoverTime = point[0];
      const [time, watts] = point;
      for (const [name, value] of [['x1', x(time)], ['x2', x(time)]]) cursor.setAttribute(name, value);
      marker.setAttribute('cx', x(time));
      marker.setAttribute('cy', y(watts));
      cursor.setAttribute('visibility', 'visible');
      marker.setAttribute('visibility', 'visible');
      tooltip.replaceChildren(
        html('strong', 'energy-tip-value', power(watts)),
        html('span', 'energy-tip-time', tipFormat.format(time))
      );
      tooltip.hidden = false;
      const frameWidth = frame.clientWidth;
      const scale = frameWidth / WIDTH;
      const left = Math.min(Math.max(x(time) * scale - tooltip.offsetWidth / 2, 0), frameWidth - tooltip.offsetWidth);
      tooltip.style.left = `${left}px`;
      tooltip.style.top = `${Math.max(0, y(watts) * scale - tooltip.offsetHeight - 10)}px`;
    }

    // Points are oldest first, so the nearest is found by halving.
    function nearest(time) {
      if (!points.length) return null;
      let low = 0;
      let high = points.length - 1;
      while (low < high) {
        const middle = (low + high) >> 1;
        if (points[middle][0] < time) low = middle + 1;
        else high = middle;
      }
      return low > 0 && time - points[low - 1][0] < points[low][0] - time ? low - 1 : low;
    }

    chart.addEventListener('pointermove', event => {
      const box = chart.getBoundingClientRect();
      const plotX = ((event.clientX - box.left) / box.width) * WIDTH;
      setActive(nearest(start + ((plotX - PLOT.left) / plotWidth) * span));
    });
    chart.addEventListener('pointerleave', () => setActive(null));
    chart.addEventListener('blur', () => setActive(null));
    // Arrow keys step a minute (or, in "All", an hour) at a time; Home and End jump to the ends.
    chart.addEventListener('keydown', event => {
      if (!points.length) return;
      const last = points.length - 1;
      const from = active ?? last;
      if (event.key === 'ArrowLeft') setActive(Math.max(0, from - view.step));
      else if (event.key === 'ArrowRight') setActive(Math.min(last, from + view.step));
      else if (event.key === 'Home') setActive(0);
      else if (event.key === 'End') setActive(last);
      else if (event.key === 'Escape') setActive(null);
      else return;
      event.preventDefault();
    });

    const watts = points.map(([, value]) => value);
    const average = watts.length ? watts.reduce((sum, value) => sum + value, 0) / watts.length : 0;
    const spanText = fixedSpan || view.span || `since ${fullFormat.format(start)}`;
    chart.setAttribute('aria-label', points.length
      ? `Electricity demand over ${spanText}: latest ${power(newest[1])}, peak ${power(max)}, average ${power(average)}. Use the arrow keys to read each ${view.stepText}.`
      : `Electricity demand over ${spanText}: no readings.`);

    // Keep the reading under the pointer (or keyboard) in place when the chart redraws.
    return { chart, restore: () => (state.hoverTime !== null && points.length ? setActive(nearest(state.hoverTime)) : null) };
  }

  // When to ask next: settle after the next run, and never for the run that saved
  // updatedAt again.
  function nextRunAt(updatedAt) {
    const now = Date.now();
    let at = Math.floor(now / RUN_MS) * RUN_MS + settle;
    if (at <= now) at += RUN_MS;
    if (updatedAt) at = Math.max(at, Math.floor(updatedAt / RUN_MS) * RUN_MS + RUN_MS + settle);
    return at;
  }

  let session = null;

  function start(container, { load, loadHistory = null, setPaused = null, onUpdate = () => {} }) {
    stop();
    const now = html('div', 'energy-live-now');
    const value = html('strong', 'energy-live-value', '–');
    const label = html('span', 'energy-live-label', 'Connecting to the Home Mini…');
    // Seconds until the next update, next to the wattage. Hidden from screen readers,
    // which would otherwise hear it every second.
    const countdown = html('span', 'energy-live-countdown');
    countdown.setAttribute('aria-hidden', 'true');
    const reading = html('span', 'energy-live-reading');
    reading.append(value, countdown);
    const badge = html('span', 'energy-live-badge', 'Live');
    now.append(badge, reading, label);
    const meta = html('div', 'energy-live-meta');
    const head = html('div', 'energy-live-head');
    head.append(now, meta);
    const tabs = html('div', 'energy-live-tabs');
    tabs.setAttribute('role', 'group');
    tabs.setAttribute('aria-label', 'Time span');
    const note = html('p', 'energy-live-note');
    note.hidden = true;
    const frame = html('div', 'energy-chart-frame');
    const tooltip = html('div', 'energy-tooltip');
    tooltip.hidden = true;
    tooltip.setAttribute('role', 'status');
    // Pause stops the scheduled job asking Octopus for live readings (and this page
    // asking the site API); the Discord bot is paused separately, in its own panel.
    const pauseButton = html('button', 'profile-button energy-live-pause', 'Pause');
    pauseButton.type = 'button';
    pauseButton.hidden = !setPaused;
    const controls = html('div', 'energy-live-controls');
    controls.append(tabs, pauseButton);
    // "All": a day at a time, like the half-hourly chart below (js/energy-chart.js).
    const previousDay = html('button', 'profile-button', '‹ Previous day');
    const nextDay = html('button', 'profile-button', 'Next day ›');
    previousDay.type = nextDay.type = 'button';
    const dayTitle = html('div', 'energy-chart-title');
    const dayNav = html('div', 'energy-chart-head energy-live-days');
    dayNav.append(previousDay, dayTitle, nextDay);
    dayNav.hidden = true;
    container.replaceChildren(head, controls, dayNav, frame, note);

    const state = { hoverTime: null };
    const current = {
      timer: null, version: 0, stopped: false, nextAt: null, loading: false, rechecks: 0, paused: false,
      dueAt: null, view: loadHistory ? readView() : 'hour', live: null,
      // history: the answer for the day shown. historyDate: the day chosen (null: the
      // newest). days: every day there is. dayCache: past days already fetched, kept
      // until the history's next update (historyUpdatedAt).
      history: null, historyDate: null, days: [], dayCache: new Map(), newestHistory: null, historyUpdatedAt: null,
      historyError: null, historyDueAt: 0, historyLoading: new Map()
    };
    session = current;

    const buttons = Object.entries(VIEWS)
      .filter(([name]) => name !== 'all' || loadHistory)
      .map(([name, view]) => {
        const button = html('button', 'energy-live-tab', view.label);
        button.type = 'button';
        button.dataset.view = name;
        button.addEventListener('click', () => {
          if (current.view === name) return;
          current.view = name;
          saveView(name);
          state.hoverTime = null;
          showTabs();
          redraw();
          // The history is asked for the first time "All" is opened, on its own: the
          // live readings already shown are as new as there are until the next run.
          if (name === 'all' && !current.historyDate && Date.now() >= current.historyDueAt) showDay(null);
        });
        return button;
      });
    tabs.append(...buttons);

    // Shows a day ('YYYY-MM-DD', or null for the newest), from the cache if it's there.
    function showDay(date) {
      current.historyDate = date;
      state.hoverTime = null;
      const cached = date ? current.dayCache.get(date)
        : Date.now() < current.historyDueAt && current.newestHistory;
      if (cached) {
        current.history = cached;
        redraw();
        return;
      }
      redraw();
      updateHistory(date).then(() => {
        if (!current.stopped && current.view === 'all' && current.historyDate === date) redraw();
      });
    }

    function stepDay(by) {
      const index = current.days.indexOf(current.history?.date);
      const target = current.days[index + by];
      if (index === -1 || !target) return;
      showDay(target === current.days.at(-1) ? null : target);
    }
    previousDay.addEventListener('click', () => stepDay(-1));
    nextDay.addEventListener('click', () => stepDay(1));

    function showTabs() {
      for (const button of buttons) {
        const selected = button.dataset.view === current.view;
        button.classList.toggle('is-active', selected);
        button.setAttribute('aria-pressed', String(selected));
      }
    }
    showTabs();

    function showCountdown() {
      if (current.loading) countdown.textContent = 'Updating…';
      else if (document.hidden || current.nextAt === null) countdown.textContent = 'Paused';
      else countdown.textContent = `Next in ${Math.max(0, Math.ceil((current.nextAt - Date.now()) / 1000))}s`;
    }
    current.clock = setInterval(showCountdown, 1000);

    function showNote(text) {
      note.textContent = text || '';
      note.hidden = !text;
    }

    function render(live) {
      // Measured from now: if the scheduled job stops, the saved readings just get older.
      const stale = live.paused || !live.readAt || Date.now() - live.readAt > STALE_MS;
      value.textContent = live.demand === null ? '–' : power(live.demand);
      badge.textContent = live.paused ? 'Paused' : 'Live';
      pauseButton.textContent = live.paused ? 'Resume' : 'Pause';
      label.textContent = live.paused
        ? `Readings paused${live.readAt ? ` · last ${secondsFormat.format(live.readAt)}` : ''}`
        : live.pausedUntil
        ? `Octopus says too many requests: readings paused until ${timeFormat.format(live.pausedUntil)}`
        : !live.readAt
        ? "The Home Mini hasn't reported in the last hour"
        : stale
          ? `Last reading ${secondsFormat.format(live.readAt)}: the Home Mini may be offline`
          : `Using now · ${secondsFormat.format(live.readAt)}`;
      now.classList.toggle('is-stale', stale);
      meta.replaceChildren();
      if (live.today) {
        meta.append(
          html('span', 'energy-live-meta-label', 'Today so far'),
          html('span', 'energy-live-meta-value', `${kwhFormat.format(live.today.kwh)} kWh`)
        );
      }
      redraw();
    }

    // The chart for the chosen tab, from the last answers kept.
    function redraw() {
      const view = VIEWS[current.view];
      const live = current.live;
      let chartData;
      dayNav.hidden = current.view !== 'all';
      if (current.view === 'all') {
        // The day asked for, once its answer is here; until then the day shown before.
        const history = current.history;
        if (!history) {
          dayNav.hidden = true;
          frame.replaceChildren(html('p', 'energy-live-empty', current.historyError || 'Loading the Home Mini history…'));
          showNote('');
          return;
        }
        const newest = history.date === current.days.at(-1);
        const points = newest ? joinHistory(history, live) : history.points;
        // Each point is five minutes' average power, so five minutes of it is used.
        const kwh = points.reduce((sum, [, watts]) => sum + watts, 0) * (FIVE_MINUTES / HOUR) / 1000;
        const name = dayName(history.date);
        dayTitle.replaceChildren(html('strong', '', name), html('span', 'energy-chart-total', `${kwhFormat.format(kwh)} kWh`));
        const index = current.days.indexOf(history.date);
        previousDay.disabled = index <= 0;
        nextDay.disabled = index === -1 || index === current.days.length - 1;
        chartData = {
          points, start: history.from, end: history.to, view, live: false,
          tickStep: 3 * HOUR, tipFormat: timeFormat, spanText: name
        };
        const notes = [];
        if (current.days.length) {
          notes.push(`Five-minute averages, ${dayName(current.days[0])} to ${dayName(current.days.at(-1))} (${current.days.length} ${current.days.length === 1 ? 'day' : 'days'})${history.complete ? ': as far back as the Home Mini goes.' : '. Older days are still being fetched from Octopus, a few at a time.'}`);
        }
        if (history.error) notes.push(`Octopus: ${history.error}`);
        // The 10-second archive kept on Netlify (netlify/lib/octopus.mjs, archiveTenSeconds).
        const archive = history.archive;
        if (archive) {
          const saved = archive.savedDays
            ? `${archive.savedDays} ${archive.savedDays === 1 ? 'day' : 'days'} saved, ${dayName(archive.firstSaved)} to ${dayName(archive.lastSaved)}`
            : 'nothing saved yet';
          notes.push(`10-second archive: ${saved}${archive.searching ? ', still looking for older days' : ', checked weekly'}.`);
          if (archive.error) notes.push(`Archive: ${archive.error}`);
        }
        if (current.historyError) notes.push(current.historyError);
        showNote(notes.join(' '));
      } else {
        if (!live) return;
        const end = live.updatedAt || Date.now();
        chartData = { points: live.points, start: end - view.window, end, view, live: !live.paused };
        showNote('');
      }
      // Removing the old chart can blur it, which would forget the reading being read.
      const focused = frame.contains(document.activeElement);
      const hoverTime = state.hoverTime;
      const { chart, restore } = drawChart(chartData, tooltip, frame, state);
      frame.replaceChildren(chart, tooltip);
      state.hoverTime = hoverTime;
      if (focused) chart.focus({ preventScroll: true });
      restore();
    }

    // One request a day at a time: clicking or switching tabs again shares the one in flight.
    function updateHistory(date) {
      const key = date || '';
      if (!current.historyLoading.has(key)) {
        current.historyLoading.set(key, fetchHistory(date).finally(() => current.historyLoading.delete(key)));
      }
      return current.historyLoading.get(key);
    }

    async function fetchHistory(date) {
      try {
        const history = await loadHistory(date);
        if (current.stopped) return;
        if (!Array.isArray(history?.days)) throw new Error('The Netlify service is out of date: redeploy it (Netlify → Deploys → Trigger deploy).');
        const updated = history.updatedAt !== current.historyUpdatedAt;
        // A new update can change any day near where it fetched, so start the cache again.
        if (updated) current.dayCache.clear();
        current.historyUpdatedAt = history.updatedAt;
        current.days = history.days;
        current.historyError = null;
        const newest = history.date === history.days.at(-1);
        if (newest) current.newestHistory = history;
        else current.dayCache.set(history.date, history);
        // Only the day still being asked for is shown (a click may have moved on).
        if (current.historyDate === date || (newest && !current.historyDate)) current.history = history;
        // Only asking for the newest day keeps it up to date, when the job's next update is in.
        if (!date) {
          current.historyDueAt = updated && history.nextAt
            ? Math.max(history.nextAt + HISTORY_SETTLE_MS, Date.now() + RUN_MS)
            : Date.now() + HISTORY_RETRY_MS;
        }
      } catch (error) {
        if (current.stopped) return;
        current.historyError = error.message;
        if (!date) current.historyDueAt = Date.now() + HISTORY_RETRY_MS;
      }
    }

    async function tick() {
      clearTimeout(current.timer);
      current.nextAt = null;
      if (current.stopped || !container.isConnected) return;
      if (document.hidden) {
        showCountdown();
        return;
      }
      const version = ++current.version;
      let nextAt;
      current.loading = true;
      showCountdown();
      // The newest day's history only while it's open in "All", and only once the job's
      // next update is due: it changes slowly, and past days don't change at all.
      const historyDue = current.view === 'all' && loadHistory && !current.historyDate && Date.now() >= current.historyDueAt;
      const historyUpdate = historyDue ? updateHistory() : null;
      try {
        const live = await load();
        await historyUpdate;
        if (current.stopped || version !== current.version) return;
        // An older Netlify service doesn't know ?energy-live and answers with a backlog instead.
        if (!Array.isArray(live?.points)) throw new Error('The Netlify service is out of date: redeploy it (Netlify → Deploys → Trigger deploy).');
        // Still the run already shown, and the next one is due: the job is running late.
        // Not when it's further behind than that (Octopus paused or failing), when
        // asking again soon wouldn't find anything new.
        const age = Date.now() - live.updatedAt;
        const late = current.live && live.updatedAt === current.live.updatedAt && !live.pausedUntil
          && age > RUN_MS && age < 2 * RUN_MS;
        current.paused = Boolean(live.paused);
        if (live.paused) {
          // Nothing new until Resume, so no more asking (coming back to the tab asks once,
          // in case it was resumed somewhere else).
          current.rechecks = 0;
          nextAt = null;
        } else if (late && current.rechecks < MAX_RECHECKS) {
          if (!current.rechecks) settle = Math.min(settle + SETTLE_STEP_MS, MAX_SETTLE_MS);
          current.rechecks++;
          nextAt = Date.now() + RECHECK_MS;
        } else {
          if (!current.rechecks && !late) settle = Math.max(settle - SETTLE_EASE_MS, SETTLE_MS);
          current.rechecks = 0;
          nextAt = nextRunAt(live.updatedAt);
        }
        current.live = live;
        render(live);
        onUpdate(live);
      } catch (error) {
        await historyUpdate;
        if (current.stopped || version !== current.version) return;
        current.rechecks = 0;
        nextAt = nextRunAt(null);
        value.textContent = '–';
        label.textContent = error.message;
        now.classList.add('is-stale');
        if (current.view === 'all') redraw();
        onUpdate(null);
      }
      current.loading = false;
      schedule(nextAt);
    }

    // null: no next time, while readings are paused.
    function schedule(at) {
      clearTimeout(current.timer);
      current.dueAt = at;
      current.nextAt = at;
      if (at !== null) current.timer = setTimeout(tick, at - Date.now());
      showCountdown();
    }

    pauseButton.addEventListener('click', async () => {
      const paused = !current.paused;
      pauseButton.disabled = true;
      try {
        const result = await setPaused(paused);
        if (current.stopped) return;
        // A tick still in flight would show the old setting.
        current.version++;
        current.loading = false;
        current.paused = result.paused;
        pauseButton.textContent = result.paused ? 'Resume' : 'Pause';
        if (current.live) {
          current.live = { ...current.live, paused: result.paused };
          render(current.live);
        }
        // Resumed: the next run asks Octopus again, and its reading is picked up after it.
        schedule(result.paused ? null : nextRunAt(null));
      } catch (error) {
        label.textContent = error.message;
      } finally {
        pauseButton.disabled = false;
      }
    });

    // Back on the tab: ask now only if a run has happened while it was hidden.
    current.onVisibility = () => {
      if (!document.hidden) {
        if (current.dueAt && Date.now() < current.dueAt) schedule(current.dueAt);
        else tick();
        return;
      }
      clearTimeout(current.timer);
      current.nextAt = null;
      showCountdown();
    };
    document.addEventListener('visibilitychange', current.onVisibility);
    tick();
  }

  function stop() {
    if (!session) return;
    session.stopped = true;
    clearTimeout(session.timer);
    clearInterval(session.clock);
    document.removeEventListener('visibilitychange', session.onVisibility);
    session = null;
  }

  window.energyLive = { start, stop };
})();
