// Half-hourly electricity chart for the admin panel on the profile page (js/profile.js).
// "Day by day": one UK day at a time, with buttons to step through the days that have
// readings, a column per half hour in the trim colour. Hovering a column (or moving with
// the arrow keys once the chart has focus) shows its time and kWh; the same numbers are
// in a table. "Trend": every day Octopus has (up to about 500) as a line of its average
// power in kW, with a 7-day average over it to show the ups and downs.
//
// window.energyChart.show(container, days, trend): both as from the site API's ?energy
// answer: days [{ date: 'YYYY-MM-DD', readings: [[start, kWh], …] }], trend
// [[date, kWh, half hours read], …].
(() => {
  const SVG = 'http://www.w3.org/2000/svg';
  // Drawing size; the SVG scales to the panel's width.
  const WIDTH = 640;
  const HEIGHT = 220;
  const PLOT = { left: 40, right: 8, top: 22, bottom: 24 };
  const SLOTS = 48;
  const BAR_GAP = 2;
  const MAX_BAR = 24;
  const RADIUS = 4;
  const DAY_MS = 86400000;
  // The Trend view's smoothed line averages this many days.
  const TREND_WEEK = 7;
  // Which view was last open, kept in this browser.
  const VIEW_KEY = 'besaid-energy-chart-view';

  const timeFormat = new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/London', hour: '2-digit', minute: '2-digit' });
  const dayFormat = new Intl.DateTimeFormat(undefined, { timeZone: 'UTC', weekday: 'short', day: 'numeric', month: 'short' });
  const kwhFormat = new Intl.NumberFormat(undefined, { maximumFractionDigits: 3 });
  const totalFormat = new Intl.NumberFormat(undefined, { maximumFractionDigits: 1 });
  const kwFormat = new Intl.NumberFormat(undefined, { maximumFractionDigits: 2 });
  const monthFormat = new Intl.DateTimeFormat(undefined, { timeZone: 'UTC', month: 'short', year: '2-digit' });
  const yearDayFormat = new Intl.DateTimeFormat(undefined, { timeZone: 'UTC', day: 'numeric', month: 'short', year: 'numeric' });
  const shortDayFormat =new Intl.DateTimeFormat(undefined, { timeZone: 'UTC', day: 'numeric', month: 'short' });

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

  // The half hour of the UK day a reading starts in: 0 for 00:00, 47 for 23:30.
  function slotOf(start) {
    const [hours, minutes] = timeFormat.format(start).split(':').map(Number);
    return hours * 2 + (minutes >= 30 ? 1 : 0);
  }

  // A round step for the y axis giving about four gridlines: 0.1, 0.2, 0.25, 0.5, 1, 2…
  function niceStep(max) {
    const rough = max / 4;
    const power = 10 ** Math.floor(Math.log10(rough));
    return [1, 2, 2.5, 5, 10].map(step => step * power).find(step => step >= rough);
  }

  // A column with a rounded top and a square base.
  function columnPath(x, y, width, height) {
    const radius = Math.min(RADIUS, width / 2, height);
    const bottom = y + height;
    return `M${x},${bottom}V${y + radius}Q${x},${y} ${x + radius},${y}`
      + `H${x + width - radius}Q${x + width},${y} ${x + width},${y + radius}V${bottom}Z`;
  }

  // One slot per half hour. If a day has two readings in one slot (the hour repeated
  // when the clocks go back in October), they're added together.
  function slotsFor(day) {
    const slots = Array.from({ length: SLOTS }, () => null);
    for (const [start, kwh] of day.readings) {
      const index = slotOf(start);
      const slot = slots[index];
      slots[index] = slot ? { ...slot, kwh: slot.kwh + kwh } : { start, kwh };
    }
    return slots;
  }

  function drawChart(slots, tooltip, frame) {
    const chart = svg('svg', {
      viewBox: `0 0 ${WIDTH} ${HEIGHT}`,
      class: 'energy-chart-svg',
      role: 'img',
      tabindex: '0'
    });
    const plotWidth = WIDTH - PLOT.left - PLOT.right;
    const plotHeight = HEIGHT - PLOT.top - PLOT.bottom;
    const slotWidth = plotWidth / SLOTS;
    const barWidth = Math.min(MAX_BAR, slotWidth - BAR_GAP);
    const max = Math.max(...slots.map(slot => slot?.kwh || 0));
    const step = max > 0 ? niceStep(max) : 0.1;
    const top = Math.max(step, Math.ceil(max / step) * step);
    const y = value => PLOT.top + plotHeight - (value / top) * plotHeight;

    // Gridlines and y-axis values.
    for (let value = 0; value <= top + step / 1000; value += step) {
      chart.append(svg('line', {
        class: 'energy-grid', x1: PLOT.left, x2: WIDTH - PLOT.right, y1: y(value), y2: y(value)
      }));
      const tick = svg('text', { class: 'energy-axis', x: PLOT.left - 6, y: y(value) + 3, 'text-anchor': 'end' });
      tick.textContent = totalFormat.format(value);
      chart.append(tick);
    }
    const unit = svg('text', { class: 'energy-axis', x: PLOT.left - 6, y: PLOT.top - 6, 'text-anchor': 'end' });
    unit.textContent = 'kWh';
    chart.append(unit);

    // Hours along the bottom, every three hours.
    for (let hour = 0; hour <= 24; hour += 3) {
      const label = svg('text', {
        class: 'energy-axis',
        x: PLOT.left + hour * 2 * slotWidth,
        y: HEIGHT - 6,
        'text-anchor': hour === 0 ? 'start' : hour === 24 ? 'end' : 'middle'
      });
      label.textContent = `${String(hour % 24).padStart(2, '0')}:00`;
      chart.append(label);
    }

    // Columns, each with a hit area the full height of its slot.
    const bars = [];
    slots.forEach((slot, index) => {
      if (!slot) return;
      const x = PLOT.left + index * slotWidth + (slotWidth - barWidth) / 2;
      const height = Math.max(0, y(0) - y(slot.kwh));
      const bar = svg('path', { class: 'energy-bar', d: columnPath(x, y(slot.kwh), barWidth, height) });
      const hit = svg('rect', {
        class: 'energy-hit', x: PLOT.left + index * slotWidth, y: PLOT.top, width: slotWidth, height: plotHeight
      });
      hit.addEventListener('pointerenter', () => setActive(index));
      chart.append(bar, hit);
      bars[index] = bar;
    });

    let active = null;
    function setActive(index) {
      if (active !== null) bars[active]?.classList.remove('is-active');
      active = index;
      if (index === null || !slots[index]) {
        tooltip.hidden = true;
        return;
      }
      bars[index].classList.add('is-active');
      const slot = slots[index];
      const end = slot.start + 30 * 60000;
      tooltip.replaceChildren(
        html('strong', 'energy-tip-value', `${kwhFormat.format(slot.kwh)} kWh`),
        html('span', 'energy-tip-time', `${timeFormat.format(slot.start)}–${timeFormat.format(end)}`)
      );
      tooltip.hidden = false;
      // Above the column, kept inside the chart.
      const frameWidth = frame.clientWidth;
      const scale = frameWidth / WIDTH;
      const centre = (PLOT.left + (index + 0.5) * slotWidth) * scale;
      const left = Math.min(Math.max(centre - tooltip.offsetWidth / 2, 0), frameWidth - tooltip.offsetWidth);
      tooltip.style.left = `${left}px`;
      tooltip.style.top = `${Math.max(0, y(slot.kwh) * scale - tooltip.offsetHeight - 8)}px`;
    }

    chart.addEventListener('pointerleave', () => setActive(null));
    chart.addEventListener('blur', () => setActive(null));
    // Arrow keys move between half hours that have readings.
    const filled = slots.map((slot, index) => (slot ? index : null)).filter(index => index !== null);
    chart.addEventListener('keydown', event => {
      if (!filled.length) return;
      const position = active === null ? -1 : filled.indexOf(active);
      if (event.key === 'ArrowRight') setActive(filled[Math.min(filled.length - 1, position + 1)]);
      else if (event.key === 'ArrowLeft') setActive(filled[Math.max(0, position === -1 ? 0 : position - 1)]);
      else if (event.key === 'Escape') setActive(null);
      else return;
      event.preventDefault();
    });
    return chart;
  }

  function drawTable(slots) {
    const table = html('table', 'energy-table');
    const head = html('tr');
    for (const title of ['Time', 'kWh']) head.append(html('th', '', title));
    table.append(html('thead'));
    table.tHead.append(head);
    const body = html('tbody');
    for (const slot of slots) {
      if (!slot) continue;
      const row = html('tr');
      row.append(
        html('td', '', timeFormat.format(slot.start)),
        html('td', '', kwhFormat.format(slot.kwh))
      );
      body.append(row);
    }
    table.append(body);
    return table;
  }

  // ---------- Trend: every day's average power as a line ----------

  // A day's average power in kW: its kWh over the hours it has readings for, so a part
  // day or a clock-change day isn't skewed.
  function trendPoints(trend) {
    const points = trend.map(([date, kwh, halfHours]) => {
      const [year, month, day] = date.split('-').map(Number);
      return { date, time: Date.UTC(year, month - 1, day), kwh, kw: halfHours ? kwh / (halfHours / 2) : 0 };
    });
    // The average of the days in the TREND_WEEK days up to each one, which smooths out
    // weekdays and weekends so the ups and downs underneath show.
    points.forEach((point, index) => {
      const week = points.slice(0, index + 1).filter(other => point.time - other.time < TREND_WEEK * DAY_MS);
      point.weekKw = week.reduce((sum, other) => sum + other.kw, 0) / week.length;
    });
    return points;
  }

  function drawTrend(points, tooltip, frame) {
    const chart = svg('svg', {
      viewBox: `0 0 ${WIDTH} ${HEIGHT}`,
      class: 'energy-chart-svg energy-trend-svg',
      role: 'img',
      tabindex: '0'
    });
    const plotWidth = WIDTH - PLOT.left - PLOT.right;
    const plotHeight = HEIGHT - PLOT.top - PLOT.bottom;
    const first = points[0].time;
    const span = Math.max(DAY_MS, points.at(-1).time - first);
    const x = time => PLOT.left + ((time - first) / span) * plotWidth;
    const max = Math.max(...points.map(point => point.kw));
    const step = max > 0 ? niceStep(max) : 0.1;
    const top = Math.max(step, Math.ceil(max / step) * step);
    const y = value => PLOT.top + plotHeight - (value / top) * plotHeight;

    for (let value = 0; value <= top + step / 1000; value += step) {
      chart.append(svg('line', {
        class: 'energy-grid', x1: PLOT.left, x2: WIDTH - PLOT.right, y1: y(value), y2: y(value)
      }));
      const tick = svg('text', { class: 'energy-axis', x: PLOT.left - 6, y: y(value) + 3, 'text-anchor': 'end' });
      tick.textContent = kwFormat.format(value);
      chart.append(tick);
    }
    const unit = svg('text', { class: 'energy-axis', x: PLOT.left - 6, y: PLOT.top - 6, 'text-anchor': 'end' });
    unit.textContent = 'kW';
    chart.append(unit);

    // Dates along the bottom: the first of each month over a long span, otherwise
    // about six evenly spaced days.
    const labels = [];
    if (span > 60 * DAY_MS) {
      const start = new Date(first);
      for (let month = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + 1, 1)); month.getTime() <= points.at(-1).time;
        month = new Date(Date.UTC(month.getUTCFullYear(), month.getUTCMonth() + 1, 1))) {
        labels.push([month.getTime(), monthFormat.format(month)]);
      }
    } else {
      const every = Math.max(1, Math.round(span / DAY_MS / 6));
      for (let time = first; time <= points.at(-1).time; time += every * DAY_MS) labels.push([time, shortDayFormat.format(time)]);
    }
    // Thin out the labels if there are too many to read.
    const keep = Math.ceil(labels.length / 8);
    labels.filter((unused, index) => index % keep === 0).forEach(([time, text]) => {
      const left = x(time);
      const label = svg('text', {
        class: 'energy-axis',
        x: left,
        y: HEIGHT - 6,
        'text-anchor': left < PLOT.left + 20 ? 'start' : left > WIDTH - PLOT.right - 20 ? 'end' : 'middle'
      });
      label.textContent = text;
      chart.append(label);
    });

    const line = values => points.map((point, index) => `${index ? 'L' : 'M'}${x(point.time).toFixed(1)},${y(values(point)).toFixed(1)}`).join('');
    chart.append(
      svg('path', { class: 'energy-trend-daily', d: line(point => point.kw) }),
      svg('path', { class: 'energy-trend-week', d: line(point => point.weekKw) })
    );
    const guide = svg('line', { class: 'energy-trend-guide', y1: PLOT.top, y2: PLOT.top + plotHeight });
    const marker = svg('circle', { class: 'energy-live-marker', r: 4 });
    guide.style.display = marker.style.display = 'none';
    chart.append(guide, marker);

    let active = null;
    function setActive(index) {
      active = index;
      if (index === null) {
        tooltip.hidden = true;
        guide.style.display = marker.style.display = 'none';
        return;
      }
      const point = points[index];
      guide.setAttribute('x1', x(point.time));
      guide.setAttribute('x2', x(point.time));
      marker.setAttribute('cx', x(point.time));
      marker.setAttribute('cy', y(point.kw));
      guide.style.display = marker.style.display = '';
      tooltip.replaceChildren(
        html('strong', 'energy-tip-value', `${kwFormat.format(point.kw)} kW average`),
        html('span', 'energy-tip-detail', `${totalFormat.format(point.kwh)} kWh · ${TREND_WEEK}-day average ${kwFormat.format(point.weekKw)} kW`),
        html('span', 'energy-tip-time', dayFormat.format(point.time))
      );
      tooltip.hidden = false;
      const frameWidth = frame.clientWidth;
      const scale = frameWidth / WIDTH;
      const left = Math.min(Math.max(x(point.time) * scale - tooltip.offsetWidth / 2, 0), frameWidth - tooltip.offsetWidth);
      tooltip.style.left = `${left}px`;
      tooltip.style.top = `${Math.max(0, y(Math.max(point.kw, point.weekKw)) * scale - tooltip.offsetHeight - 8)}px`;
    }

    // The nearest day to the pointer.
    chart.addEventListener('pointermove', event => {
      const box = chart.getBoundingClientRect();
      const time = first + (((event.clientX - box.left) / box.width) * WIDTH - PLOT.left) / plotWidth * span;
      let nearest = 0;
      points.forEach((point, index) => {
        if (Math.abs(point.time - time) < Math.abs(points[nearest].time - time)) nearest = index;
      });
      if (nearest !== active) setActive(nearest);
    });
    chart.addEventListener('pointerleave', () => setActive(null));
    chart.addEventListener('blur', () => setActive(null));
    chart.addEventListener('keydown', event => {
      if (event.key === 'ArrowRight') setActive(Math.min(points.length - 1, active === null ? 0 : active + 1));
      else if (event.key === 'ArrowLeft') setActive(Math.max(0, active === null ? points.length - 1 : active - 1));
      else if (event.key === 'Escape') setActive(null);
      else return;
      event.preventDefault();
    });
    return chart;
  }

  function drawTrendTable(points) {
    const table = html('table', 'energy-table');
    const head = html('tr');
    for (const title of ['Day', 'kWh', 'Average kW', `${TREND_WEEK}-day kW`]) head.append(html('th', '', title));
    table.append(html('thead'));
    table.tHead.append(head);
    const body = html('tbody');
    // Newest first: it's the end people usually look for.
    for (const point of [...points].reverse()) {
      const row = html('tr');
      row.append(
        html('td', '', dayFormat.format(point.time)),
        html('td', '', totalFormat.format(point.kwh)),
        html('td', '', kwFormat.format(point.kw)),
        html('td', '', kwFormat.format(point.weekKw))
      );
      body.append(row);
    }
    table.append(body);
    return table;
  }

  function readView() {
    try { return localStorage.getItem(VIEW_KEY) === 'trend' ? 'trend' : 'day'; } catch { return 'day'; }
  }

  function saveView(view) {
    try { localStorage.setItem(VIEW_KEY, view); } catch { /* Only a convenience. */ }
  }

  // The Day / Trend switch above the chart. trend is the ?energy answer's trend (a
  // summary saved before it existed has none: Refresh fetches it).
  function show(container, days, trend) {
    const tabs = html('div', 'energy-live-tabs energy-chart-tabs');
    tabs.setAttribute('role', 'tablist');
    const body = html('div');
    const views = { day: 'Day by day', trend: 'Trend' };
    let view = readView();
    const buttons = Object.entries(views).map(([name, label]) => {
      const button = html('button', 'energy-live-tab', label);
      button.type = 'button';
      button.setAttribute('role', 'tab');
      button.addEventListener('click', () => {
        view = name;
        saveView(name);
        render();
      });
      tabs.append(button);
      return [name, button];
    });
    container.replaceChildren(tabs, body);

    function render() {
      for (const [name, button] of buttons) {
        button.classList.toggle('is-active', name === view);
        button.setAttribute('aria-selected', String(name === view));
      }
      if (view === 'trend') showTrend(body, trend);
      else showDays(body, days);
    }
    render();
  }

  function showTrend(container, trend) {
    if (!trend) {
      container.replaceChildren(html('p', 'energy-chart-empty', 'Press Refresh to load the trend.'));
      return;
    }
    if (!trend.length) {
      container.replaceChildren(html('p', 'energy-chart-empty', 'No readings from Octopus yet.'));
      return;
    }
    const points = trendPoints(trend);
    const kwh = points.reduce((sum, point) => sum + point.kwh, 0);
    const title = html('div', 'energy-chart-title');
    title.append(
      html('strong', '', `${yearDayFormat.format(points[0].time)} – ${yearDayFormat.format(points.at(-1).time)}`),
      html('span', 'energy-chart-total', `${points.length} ${points.length === 1 ? 'day' : 'days'} · ${totalFormat.format(kwh)} kWh`)
    );
    const legend = html('div', 'energy-trend-legend');
    legend.append(
      html('span', 'energy-trend-key is-daily', 'Each day'),
      html('span', 'energy-trend-key is-week', `${TREND_WEEK}-day average`)
    );
    const frame = html('div', 'energy-chart-frame');
    const tooltip = html('div', 'energy-tooltip');
    tooltip.hidden = true;
    tooltip.setAttribute('role', 'status');
    const chart = drawTrend(points, tooltip, frame);
    chart.setAttribute('aria-label', `Average electricity use each day, in kW, over ${points.length} days. Use the arrow keys to read each day.`);
    frame.append(chart, tooltip);
    const tableBox = html('details', 'energy-table-box');
    tableBox.append(html('summary', '', 'Show as table'), drawTrendTable(points));
    container.replaceChildren(title, legend, frame, tableBox);
  }

  // ---------- Day by day: one day's half hours as columns ----------

  function showDays(container, days) {
    if (!days?.length) {
      container.replaceChildren(html('p', 'energy-chart-empty', 'No half-hourly readings from Octopus in the last month.'));
      return;
    }
    let index = days.length - 1;

    const previous = html('button', 'profile-button', '‹ Previous day');
    const next = html('button', 'profile-button', 'Next day ›');
    previous.type = next.type = 'button';
    const title = html('div', 'energy-chart-title');
    const head = html('div', 'energy-chart-head');
    head.append(previous, title, next);
    const frame = html('div', 'energy-chart-frame');
    const tooltip = html('div', 'energy-tooltip');
    tooltip.hidden = true;
    tooltip.setAttribute('role', 'status');
    const tableBox = html('details', 'energy-table-box');
    tableBox.append(html('summary', '', 'Show as table'));
    container.replaceChildren(head, frame, tableBox);

    function render() {
      const day = days[index];
      const slots = slotsFor(day);
      const kwh = slots.reduce((sum, slot) => sum + (slot?.kwh || 0), 0);
      const [year, month, date] = day.date.split('-').map(Number);
      const name = dayFormat.format(new Date(Date.UTC(year, month - 1, date)));
      title.replaceChildren(
        html('strong', '', name),
        html('span', 'energy-chart-total',
          `${totalFormat.format(kwh)} kWh`)
      );
      const chart = drawChart(slots, tooltip, frame);
      chart.setAttribute('aria-label', `Half-hourly electricity use on ${name}: ${totalFormat.format(kwh)} kWh in total. Use the arrow keys to read each half hour.`);
      frame.replaceChildren(chart, tooltip);
      tableBox.replaceChildren(html('summary', '', 'Show as table'), drawTable(slots));
      previous.disabled = index === 0;
      next.disabled = index === days.length - 1;
    }

    previous.addEventListener('click', () => { index = Math.max(0, index - 1); render(); });
    next.addEventListener('click', () => { index = Math.min(days.length - 1, index + 1); render(); });
    render();
  }

  window.energyChart = { show };
})();
