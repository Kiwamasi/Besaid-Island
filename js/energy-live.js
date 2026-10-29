// Live electricity use from the Octopus Home Mini, for the admin panel on the profile
// page (js/profile.js), drawn like the live graph in the Octopus app: the power being
// drawn now in large type, and a line of the last hour's demand under it. It asks the
// site API again every 30 seconds while the tab is visible, and pauses while it's hidden.
// Hovering the line (or the arrow keys once the chart has focus) reads off any moment.
//
// window.energyLive.start(container, { load, onUpdate }):
//   load()          resolves to the site API's ?energy-live answer:
//                   { readAt, demand, points: [[time, watts], …], today: { kwh, cost } | null, updatedAt }
//   onUpdate(live)  called after each answer (null after an error), e.g. for the Today tile
// window.energyLive.stop(), window.energyLive.refresh()
(() => {
  const SVG = 'http://www.w3.org/2000/svg';
  // Octopus limits how often it can be asked, and readings reach it a minute or so late
  // anyway, so every 30 seconds is plenty.
  const POLL_MS = 30000;
  // After an error, wait longer before asking again.
  const RETRY_MS = 60000;
  // After Octopus says "too many requests" (HTTP 429 from the site API), which pauses
  // live use on the server for 10 minutes.
  const RATE_LIMIT_WAIT_MS = 10 * 60 * 1000;
  const WINDOW_MS = 60 * 60 * 1000;
  // Readings further apart than this leave a gap in the line rather than joining up.
  const GAP_MS = 45000;
  // A newest reading older than this suggests the Home Mini has stopped reporting.
  const STALE_MS = 5 * 60 * 1000;
  const WIDTH = 640;
  const HEIGHT = 200;
  const PLOT = { left: 44, right: 10, top: 24, bottom: 24 };

  const timeFormat = new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/London', hour: '2-digit', minute: '2-digit' });
  const secondsFormat = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Europe/London', hour: '2-digit', minute: '2-digit', second: '2-digit'
  });
  const axisFormat = new Intl.NumberFormat(undefined, { maximumFractionDigits: 2 });
  const kwhFormat = new Intl.NumberFormat(undefined, { maximumFractionDigits: 2 });
  const poundFormat = new Intl.NumberFormat('en-GB', { style: 'currency', currency: 'GBP' });

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

  // A round step for the y axis giving about four gridlines.
  function niceStep(max) {
    const rough = max / 4;
    const power10 = 10 ** Math.floor(Math.log10(rough));
    return [1, 2, 2.5, 5, 10].map(step => step * power10).find(step => step >= rough);
  }

  // Runs of readings with no gap longer than GAP_MS, each drawn as its own line.
  function segments(points) {
    const runs = [];
    for (const point of points) {
      const run = runs.at(-1);
      if (run && point[0] - run.at(-1)[0] <= GAP_MS) run.push(point);
      else runs.push([point]);
    }
    return runs;
  }

  function drawChart(live, tooltip, frame, state) {
    const end = live.updatedAt || Date.now();
    const start = end - WINDOW_MS;
    const points = live.points.filter(([time]) => time >= start && time <= end);
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
    const x = time => PLOT.left + ((time - start) / WINDOW_MS) * plotWidth;
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

    // Times along the bottom, every quarter of an hour on the clock.
    const quarter = 15 * 60000;
    for (let time = Math.ceil(start / quarter) * quarter; time <= end; time += quarter) {
      const label = svg('text', { class: 'energy-axis', x: x(time), y: HEIGHT - 6, 'text-anchor': 'middle' });
      label.textContent = timeFormat.format(time);
      chart.append(label);
    }

    for (const run of segments(points)) {
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
      chart.append(
        svg('circle', { class: 'energy-live-pulse', cx: x(newest[0]), cy: y(newest[1]), r: 4 }),
        svg('circle', { class: 'energy-live-point', cx: x(newest[0]), cy: y(newest[1]), r: 4 })
      );
    }

    const cursor = svg('line', { class: 'energy-live-cursor', y1: PLOT.top, y2: PLOT.top + plotHeight, visibility: 'hidden' });
    const marker = svg('circle', { class: 'energy-live-marker', r: 4.5, visibility: 'hidden' });
    chart.append(cursor, marker);

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
        html('span', 'energy-tip-time', secondsFormat.format(time))
      );
      tooltip.hidden = false;
      const frameWidth = frame.clientWidth;
      const scale = frameWidth / WIDTH;
      const left = Math.min(Math.max(x(time) * scale - tooltip.offsetWidth / 2, 0), frameWidth - tooltip.offsetWidth);
      tooltip.style.left = `${left}px`;
      tooltip.style.top = `${Math.max(0, y(watts) * scale - tooltip.offsetHeight - 10)}px`;
    }

    function nearest(time) {
      let best = null;
      points.forEach(([pointTime], index) => {
        if (best === null || Math.abs(pointTime - time) < Math.abs(points[best][0] - time)) best = index;
      });
      return best;
    }

    chart.addEventListener('pointermove', event => {
      const box = chart.getBoundingClientRect();
      const plotX = ((event.clientX - box.left) / box.width) * WIDTH;
      setActive(nearest(start + ((plotX - PLOT.left) / plotWidth) * WINDOW_MS));
    });
    chart.addEventListener('pointerleave', () => setActive(null));
    chart.addEventListener('blur', () => setActive(null));
    // Arrow keys step a minute (six readings) at a time; Home and End jump to the ends.
    chart.addEventListener('keydown', event => {
      if (!points.length) return;
      const last = points.length - 1;
      const from = active ?? last;
      if (event.key === 'ArrowLeft') setActive(Math.max(0, from - 6));
      else if (event.key === 'ArrowRight') setActive(Math.min(last, from + 6));
      else if (event.key === 'Home') setActive(0);
      else if (event.key === 'End') setActive(last);
      else if (event.key === 'Escape') setActive(null);
      else return;
      event.preventDefault();
    });

    const watts = points.map(([, value]) => value);
    const average = watts.length ? watts.reduce((sum, value) => sum + value, 0) / watts.length : 0;
    chart.setAttribute('aria-label', points.length
      ? `Electricity demand over the last hour: now ${power(newest[1])}, peak ${power(max)}, average ${power(average)}. Use the arrow keys to read each minute.`
      : 'Electricity demand over the last hour: no readings.');

    // Keep the reading under the pointer (or keyboard) in place when the chart redraws.
    return { chart, restore: () => (state.hoverTime !== null && points.length ? setActive(nearest(state.hoverTime)) : null) };
  }

  let session = null;

  function start(container, { load, onUpdate = () => {} }) {
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
    now.append(html('span', 'energy-live-badge', 'Live'), reading, label);
    const meta = html('div', 'energy-live-meta');
    const head = html('div', 'energy-live-head');
    head.append(now, meta);
    const frame = html('div', 'energy-chart-frame');
    const tooltip = html('div', 'energy-tooltip');
    tooltip.hidden = true;
    tooltip.setAttribute('role', 'status');
    container.replaceChildren(head, frame);

    const state = { hoverTime: null };
    const current = { timer: null, version: 0, stopped: false, nextAt: null, loading: false };
    session = current;

    function showCountdown() {
      if (current.loading) countdown.textContent = 'Updating…';
      else if (document.hidden || current.nextAt === null) countdown.textContent = 'Paused';
      else countdown.textContent = `Next in ${Math.max(0, Math.ceil((current.nextAt - Date.now()) / 1000))}s`;
    }
    current.clock = setInterval(showCountdown, 1000);

    function render(live) {
      const stale = !live.readAt || (live.updatedAt || Date.now()) - live.readAt > STALE_MS;
      value.textContent = live.demand === null ? '–' : power(live.demand);
      label.textContent = !live.readAt
        ? "The Home Mini hasn't reported in the last hour"
        : stale
          ? `Last reading ${secondsFormat.format(live.readAt)}: the Home Mini may be offline`
          : `Using now · ${secondsFormat.format(live.readAt)}`;
      now.classList.toggle('is-stale', stale);
      meta.replaceChildren();
      if (live.today) {
        meta.append(
          html('span', 'energy-live-meta-label', 'Today so far'),
          html('span', 'energy-live-meta-value', [
            `${kwhFormat.format(live.today.kwh)} kWh`,
            live.today.cost !== null && `${poundFormat.format(live.today.cost / 100)} use`
          ].filter(Boolean).join(' · '))
        );
      }
      // Removing the old chart can blur it, which would forget the reading being read.
      const focused = frame.contains(document.activeElement);
      const hoverTime = state.hoverTime;
      const { chart, restore } = drawChart(live, tooltip, frame, state);
      frame.replaceChildren(chart, tooltip);
      state.hoverTime = hoverTime;
      if (focused) chart.focus({ preventScroll: true });
      restore();
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
      let wait = POLL_MS;
      current.loading = true;
      showCountdown();
      try {
        const live = await load();
        if (current.stopped || version !== current.version) return;
        // An older Netlify service doesn't know ?energy-live and answers with a backlog instead.
        if (!Array.isArray(live?.points)) throw new Error('The Netlify service is out of date: redeploy it (Netlify → Deploys → Trigger deploy).');
        render(live);
        onUpdate(live);
      } catch (error) {
        if (current.stopped || version !== current.version) return;
        wait = error.status === 429 ? RATE_LIMIT_WAIT_MS : RETRY_MS;
        value.textContent = '–';
        label.textContent = error.message;
        now.classList.add('is-stale');
        onUpdate(null);
      }
      current.loading = false;
      current.nextAt = Date.now() + wait;
      current.timer = setTimeout(tick, wait);
      showCountdown();
    }

    current.onVisibility = () => {
      if (!document.hidden) {
        tick();
        return;
      }
      clearTimeout(current.timer);
      current.nextAt = null;
      showCountdown();
    };
    document.addEventListener('visibilitychange', current.onVisibility);
    current.tick = tick;
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

  function refresh() {
    session?.tick();
  }

  window.energyLive = { start, stop, refresh };
})();
