// Half-hourly electricity chart for the admin panel on the profile page (js/profile.js).
// One UK day at a time, with buttons to step through the days that have readings.
// A column per half hour in the trim colour; on two-rate tariffs a shaded band marks
// the night-rate hours. Hovering a column (or moving with the arrow keys once the
// chart has focus) shows its time, kWh and cost; the same numbers are in a table.
//
// window.energyChart.show(container, days, costs): days as from the site API's
// ?energy answer, [{ date: 'YYYY-MM-DD', readings: [[start, kWh, pence|null, night], …] }].
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

  const timeFormat = new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/London', hour: '2-digit', minute: '2-digit' });
  const dayFormat = new Intl.DateTimeFormat(undefined, { timeZone: 'UTC', weekday: 'short', day: 'numeric', month: 'short' });
  const kwhFormat = new Intl.NumberFormat(undefined, { maximumFractionDigits: 3 });
  const totalFormat = new Intl.NumberFormat(undefined, { maximumFractionDigits: 1 });
  const poundFormat = new Intl.NumberFormat('en-GB', { style: 'currency', currency: 'GBP' });
  const pence = value => (value < 100 ? `${totalFormat.format(value)}p` : poundFormat.format(value / 100));

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
    for (const [start, kwh, cost, night] of day.readings) {
      const index = slotOf(start);
      const slot = slots[index];
      slots[index] = slot
        ? { ...slot, kwh: slot.kwh + kwh, cost: slot.cost === null || cost === null ? null : slot.cost + cost }
        : { start, kwh, cost, night: Boolean(night) };
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

    // Night-rate hours: a faint band behind the columns, labelled once.
    let bandStart = null;
    slots.forEach((slot, index) => {
      const night = Boolean(slot?.night);
      if (night && bandStart === null) bandStart = index;
      const endsHere = bandStart !== null && (!night || index === SLOTS - 1);
      if (!endsHere) return;
      const bandEnd = night ? index + 1 : index;
      chart.append(svg('rect', {
        class: 'energy-night-band',
        x: PLOT.left + bandStart * slotWidth,
        y: PLOT.top,
        width: (bandEnd - bandStart) * slotWidth,
        height: plotHeight
      }));
      const label = svg('text', { class: 'energy-night-label', x: PLOT.left + bandStart * slotWidth + 4, y: PLOT.top - 6 });
      label.textContent = 'Night rate';
      chart.append(label);
      bandStart = null;
    });

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
        html('span', 'energy-tip-detail', [
          slot.cost !== null && pence(slot.cost),
          slot.night ? 'Night rate' : null
        ].filter(Boolean).join(' · ')),
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

  function drawTable(slots, costs) {
    const table = html('table', 'energy-table');
    const head = html('tr');
    for (const title of ['Time', 'kWh', ...(costs ? ['Cost'] : [])]) head.append(html('th', '', title));
    table.append(html('thead'));
    table.tHead.append(head);
    const body = html('tbody');
    for (const slot of slots) {
      if (!slot) continue;
      const row = html('tr');
      row.append(
        html('td', '', `${timeFormat.format(slot.start)}${slot.night ? ' (night)' : ''}`),
        html('td', '', kwhFormat.format(slot.kwh))
      );
      if (costs) row.append(html('td', '', slot.cost === null ? '–' : pence(slot.cost)));
      body.append(row);
    }
    table.append(body);
    return table;
  }

  function show(container, days, costs) {
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
      const priced = slots.every(slot => !slot || slot.cost !== null);
      const cost = slots.reduce((sum, slot) => sum + (slot?.cost || 0), 0);
      const [year, month, date] = day.date.split('-').map(Number);
      const name = dayFormat.format(new Date(Date.UTC(year, month - 1, date)));
      title.replaceChildren(
        html('strong', '', name),
        html('span', 'energy-chart-total',
          `${totalFormat.format(kwh)} kWh${costs ? ` · ${priced ? '' : '~'}${poundFormat.format(cost / 100)} use` : ''}`)
      );
      const chart = drawChart(slots, tooltip, frame);
      chart.setAttribute('aria-label', `Half-hourly electricity use on ${name}: ${totalFormat.format(kwh)} kWh in total. Use the arrow keys to read each half hour.`);
      frame.replaceChildren(chart, tooltip);
      tableBox.replaceChildren(html('summary', '', 'Show as table'), drawTable(slots, costs));
      previous.disabled = index === 0;
      next.disabled = index === days.length - 1;
    }

    previous.addEventListener('click', () => { index = Math.max(0, index - 1); render(); });
    next.addEventListener('click', () => { index = Math.min(days.length - 1, index + 1); render(); });
    render();
  }

  window.energyChart = { show };
})();
