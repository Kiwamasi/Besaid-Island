// Kiwamari's electricity use and costs from the Octopus Energy API, for the admin panel
// on their profile page. Everything Octopus needs lives in Netlify's environment
// variables, never in the repo or the pages:
//   OCTOPUS_API_KEY   from the Octopus dashboard (Personal details → API access)
//   OCTOPUS_MPAN      the electricity meter point's MPAN
//   OCTOPUS_SERIAL    the electricity meter's serial number
//   OCTOPUS_ACCOUNT   the account number (A-XXXXXXXX); optional, but needed for costs,
//                     as it's how the tariff and its prices are found
//   OCTOPUS_NIGHT_HOURS  for two-rate (Economy 7 style) tariffs only: when the night
//                     rate applies, in GMT, like "00:30-07:30" (the default). The meter
//                     keeps GMT all year, so in summer that's an hour later on the clock.
//   OCTOPUS_DEVICE_ID optional: the Home Mini's smart device ID. Without it, it's
//                     looked up from OCTOPUS_ACCOUNT (the meter matching OCTOPUS_SERIAL).
//
// Live use (readLiveEnergy) comes from the Octopus Home Mini, through Octopus's
// GraphQL API rather than the REST one: it reports about every 10 seconds, where the
// meter's half-hourly readings reach the REST API about a day later.
//
// Costs use the account's real tariff for each half hour: the unit rate in force then
// (so time-of-use tariffs like Agile and Go are priced correctly) plus the daily
// standing charge, both including VAT. Two-rate tariffs (E-2R-…) have a day and a
// night price; the API doesn't say which hours are night, hence OCTOPUS_NIGHT_HOURS.

const API = 'https://api.octopus.energy/v1';
const DAY_MS = 86400000;
const REQUEST_TIMEOUT_MS = 20000;
// The profile's half-hourly chart covers the days with readings in this many past days.
const CHART_DAYS = 31;

export function octopusConfigured() {
  return Boolean(process.env.OCTOPUS_API_KEY && process.env.OCTOPUS_MPAN && process.env.OCTOPUS_SERIAL);
}

// ---------- Octopus API ----------

async function octopusGet(pathOrUrl, params = {}) {
  const url = new URL(pathOrUrl.startsWith('https://') ? pathOrUrl : `${API}${pathOrUrl}`);
  for (const [name, value] of Object.entries(params)) url.searchParams.set(name, value);
  const response = await fetch(url, {
    // The API key is the username, with no password.
    headers: { Authorization: `Basic ${Buffer.from(`${process.env.OCTOPUS_API_KEY}:`).toString('base64')}` },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
  });
  if (!response.ok) throw new Error(`Octopus answered HTTP ${response.status} for ${url.pathname}`);
  return response.json();
}

// Every page of a list.
async function getAll(path, params) {
  let page = await octopusGet(path, params);
  const results = [...page.results];
  while (page.next) {
    page = await octopusGet(page.next);
    results.push(...page.results);
  }
  return results;
}

const iso = time => new Date(time).toISOString();

// ---------- Octopus GraphQL API (Home Mini) ----------

const GRAPHQL = 'https://api.octopus.energy/v1/graphql/';
// Kraken tokens last an hour; a new one is fetched a little before that.
const TOKEN_LIFETIME_MS = 50 * 60 * 1000;
// The live chart covers this much of the recent past.
const LIVE_WINDOW_MS = 60 * 60 * 1000;
// Several open tabs (or a quick Refresh) within this long share one answer.
const LIVE_CACHE_MS = 8000;

// Kept between requests while Netlify keeps the function warm.
let kraken = null; // { token, expires }
let homeMiniId = null;
let liveCache = null; // { at, live }

async function graphqlPost(query, variables, token) {
  const response = await fetch(GRAPHQL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `JWT ${token}` } : {}) },
    body: JSON.stringify({ query, variables }),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
  });
  if (!response.ok) throw new Error(`Octopus answered HTTP ${response.status} for GraphQL`);
  const result = await response.json();
  if (result.errors?.length) throw new Error(result.errors.map(error => error.message).join('; '));
  return result.data;
}

async function krakenToken(renew = false) {
  if (!renew && kraken && kraken.expires > Date.now()) return kraken.token;
  const data = await graphqlPost(
    'mutation krakenToken($apiKey: String!) { obtainKrakenToken(input: { APIKey: $apiKey }) { token } }',
    { apiKey: process.env.OCTOPUS_API_KEY }
  );
  const token = data?.obtainKrakenToken?.token;
  if (!token) throw new Error("Octopus didn't give a GraphQL token for that API key");
  kraken = { token, expires: Date.now() + TOKEN_LIFETIME_MS };
  return token;
}

// A signed-in GraphQL query. A saved token Octopus no longer accepts is renewed once.
async function graphql(query, variables = {}) {
  const saved = Boolean(kraken && kraken.expires > Date.now());
  try {
    return await graphqlPost(query, variables, await krakenToken());
  } catch (error) {
    if (!saved) throw error;
    return graphqlPost(query, variables, await krakenToken(true));
  }
}

// The Home Mini's device ID: OCTOPUS_DEVICE_ID, or the smart device on the account's
// electricity meter (the one with OCTOPUS_SERIAL, if the account has several).
async function findHomeMini() {
  if (process.env.OCTOPUS_DEVICE_ID) return process.env.OCTOPUS_DEVICE_ID.trim();
  if (homeMiniId) return homeMiniId;
  if (!process.env.OCTOPUS_ACCOUNT) {
    throw new Error('Add OCTOPUS_ACCOUNT (or OCTOPUS_DEVICE_ID) on Netlify to find the Home Mini');
  }
  const data = await graphql(`query homeMini($account: String!) {
    account(accountNumber: $account) {
      electricityAgreements(active: true) {
        meterPoint { mpan meters(includeInactive: false) { serialNumber smartDevices { deviceId } } }
      }
    }
  }`, { account: process.env.OCTOPUS_ACCOUNT });
  const meters = (data?.account?.electricityAgreements || [])
    .flatMap(agreement => agreement.meterPoint?.meters || []);
  const withDevice = meters.filter(meter => meter.smartDevices?.length);
  const meter = withDevice.find(each => each.serialNumber === process.env.OCTOPUS_SERIAL) || withDevice[0];
  if (!meter) throw new Error('No Home Mini (smart device) found on the Octopus account');
  homeMiniId = meter.smartDevices[0].deviceId;
  return homeMiniId;
}

async function telemetry(deviceId, grouping, from, to) {
  // grouping is an enum, so it goes in the query itself rather than as a variable.
  const data = await graphql(`query telemetry($deviceId: String!, $start: DateTime!, $end: DateTime!) {
    smartMeterTelemetry(deviceId: $deviceId, grouping: ${grouping}, start: $start, end: $end) {
      readAt demand consumptionDelta costDeltaWithTax
    }
  }`, { deviceId, start: iso(from), end: iso(to) });
  return data?.smartMeterTelemetry || [];
}

// ---------- UK days ----------

const londonDay = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Europe/London', year: 'numeric', month: '2-digit', day: '2-digit'
});
const londonZone = new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/London', timeZoneName: 'shortOffset' });

function londonDate(time) {
  const [year, month, day] = londonDay.format(new Date(time)).split('-').map(Number);
  return { year, month, day };
}

// How far UK time is ahead of UTC at that moment: 0 in winter, an hour in summer.
function londonOffsetMs(time) {
  const zone = londonZone.formatToParts(new Date(time)).find(part => part.type === 'timeZoneName').value;
  const [, sign, hours, minutes] = zone.match(/^GMT(?:([+-])(\d+)(?::(\d+))?)?$/) || [];
  if (!sign) return 0;
  return (sign === '-' ? -1 : 1) * (Number(hours) * 60 + Number(minutes || 0)) * 60000;
}

// Midnight UK time on that date. Days past the end of a month roll over (day 0 is the
// last day of the month before), like Date.UTC.
function londonMidnight(year, month, day) {
  const utc = Date.UTC(year, month - 1, day);
  return utc - londonOffsetMs(utc);
}

// ---------- Tariffs ----------

// Newest first from Octopus; sorted oldest first here, for rateAt. Fixed tariffs list a
// price for paying by direct debit and one for not; direct debit is assumed.
function cleanRates(rates) {
  const directDebit = rates.some(rate => rate.payment_method === 'DIRECT_DEBIT');
  return rates
    .filter(rate => !(directDebit && rate.payment_method === 'NON_DIRECT_DEBIT'))
    .map(rate => ({
      from: Date.parse(rate.valid_from),
      to: rate.valid_to ? Date.parse(rate.valid_to) : Infinity,
      value: rate.value_inc_vat
    }))
    .sort((first, second) => first.from - second.from);
}

// The price in force at that moment, or null.
function rateAt(rates, time) {
  let low = 0;
  let high = rates.length - 1;
  let found = -1;
  while (low <= high) {
    const middle = (low + high) >> 1;
    if (rates[middle].from <= time) {
      found = middle;
      low = middle + 1;
    } else {
      high = middle - 1;
    }
  }
  return found !== -1 && time < rates[found].to ? rates[found].value : null;
}

// A tariff code like "E-1R-AGILE-24-10-01-C" belongs to the product "AGILE-24-10-01".
function productCode(tariffCode) {
  return tariffCode.split('-').slice(2, -1).join('-');
}

// When the night rate applies, as minutes after midnight GMT: { start, end, text }.
// The night can run past midnight ("23:30-06:30").
const DEFAULT_NIGHT_HOURS = '00:30-07:30';
function nightHours() {
  const parse = text => {
    const match = text.trim().match(/^(\d{1,2}):(\d{2})\s*-\s*(\d{1,2}):(\d{2})$/);
    if (!match) return null;
    const [start, end] = [[match[1], match[2]], [match[3], match[4]]].map(([hours, minutes]) => Number(hours) * 60 + Number(minutes));
    return start < 1440 && end <= 1440 && start !== end ? { start, end } : null;
  };
  const hours = parse(process.env.OCTOPUS_NIGHT_HOURS || '') || parse(DEFAULT_NIGHT_HOURS);
  const clock = minutes => `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;
  return { ...hours, text: `${clock(hours.start)}–${clock(hours.end)} GMT` };
}

function isNight(time, night) {
  const minutes = Math.floor((time % DAY_MS) / 60000);
  return night.start < night.end
    ? minutes >= night.start && minutes < night.end
    : minutes >= night.start || minutes < night.end;
}

// A month at a time, side by side: a year of half-hourly prices (Agile) is about 17,500
// rows, and Octopus gives at most 1,500 a page. kind is "standard-unit-rates" (one
// price) or, for two-rate tariffs, "day-unit-rates" / "night-unit-rates".
async function unitRates(tariffCode, kind, from, to) {
  const chunks = [];
  for (let start = from; start < to; start = Math.min(to, start + 31 * DAY_MS)) {
    chunks.push([start, Math.min(to, start + 31 * DAY_MS)]);
  }
  const path = `/products/${productCode(tariffCode)}/electricity-tariffs/${tariffCode}/${kind}/`;
  const lists = await Promise.all(chunks.map(([start, end]) =>
    getAll(path, { period_from: iso(start), period_to: iso(end), page_size: 1500 })));
  return cleanRates(lists.flat());
}

async function standingCharges(tariffCode, from, to) {
  const path = `/products/${productCode(tariffCode)}/electricity-tariffs/${tariffCode}/standing-charges/`;
  return cleanRates(await getAll(path, { period_from: iso(from), period_to: iso(to), page_size: 1500 }));
}

// The meter's tariffs (agreements) that overlap the time asked about, with their prices.
async function readAgreements(from, to) {
  const account = await octopusGet(`/accounts/${encodeURIComponent(process.env.OCTOPUS_ACCOUNT)}/`);
  const point = account.properties
    ?.flatMap(property => property.electricity_meter_points || [])
    .find(meterPoint => meterPoint.mpan === process.env.OCTOPUS_MPAN);
  if (!point) throw new Error('That MPAN isn\'t on the Octopus account');
  const agreements = (point.agreements || [])
    .map(agreement => ({
      tariff: agreement.tariff_code,
      from: Date.parse(agreement.valid_from),
      to: agreement.valid_to ? Date.parse(agreement.valid_to) : Infinity
    }))
    .filter(agreement => agreement.from < to && agreement.to > from);
  return Promise.all(agreements.map(async agreement => {
    const start = Math.max(from, agreement.from);
    const end = Math.min(to, agreement.to);
    const twoRate = agreement.tariff.startsWith('E-2R-');
    const priced = twoRate || agreement.tariff.startsWith('E-1R-');
    const [units, nightUnits, standing] = await Promise.all([
      priced ? unitRates(agreement.tariff, twoRate ? 'day-unit-rates' : 'standard-unit-rates', start, end) : [],
      twoRate ? unitRates(agreement.tariff, 'night-unit-rates', start, end) : [],
      standingCharges(agreement.tariff, start, end)
    ]);
    return { ...agreement, priced, twoRate, units, nightUnits, standing };
  }));
}

// ---------- Summary ----------

// { tariff, costs, latestReading, periods: { today, yesterday, week, month, year } }.
// Each period: { from, to, kwh, unitCost, standingCharge, complete } in kWh and pence;
// complete is false when some of its use couldn't be priced.
// days: the half-hourly readings for the chart, for each UK day in the last CHART_DAYS
// that has any, oldest first: [{ date: 'YYYY-MM-DD', readings: [[start, kWh, pence or
// null if unpriced, 1 if at the night rate else 0], …] }].
export async function readEnergySummary(now = Date.now()) {
  const { year, month, day } = londonDate(now);
  const daysSinceMonday = (new Date(Date.UTC(year, month - 1, day)).getUTCDay() + 6) % 7;
  const today = londonMidnight(year, month, day);
  const periods = {
    today: { from: today, to: now },
    yesterday: { from: londonMidnight(year, month, day - 1), to: today },
    week: { from: londonMidnight(year, month, day - daysSinceMonday), to: now },
    month: { from: londonMidnight(year, month, 1), to: now },
    year: { from: londonMidnight(year, 1, 1), to: now }
  };
  const chartFrom = londonMidnight(year, month, day - CHART_DAYS);
  const from = Math.min(chartFrom, ...Object.values(periods).map(period => period.from));
  const round = (value, places) => Math.round(value * 10 ** places) / 10 ** places;

  const mpan = encodeURIComponent(process.env.OCTOPUS_MPAN);
  const serial = encodeURIComponent(process.env.OCTOPUS_SERIAL);
  const [readings, agreements] = await Promise.all([
    getAll(`/electricity-meter-points/${mpan}/meters/${serial}/consumption/`, {
      period_from: iso(from), page_size: 25000, order_by: 'period'
    }),
    process.env.OCTOPUS_ACCOUNT ? readAgreements(from, now) : null
  ]);
  const agreementAt = time => agreements?.find(agreement => agreement.from <= time && time < agreement.to);
  const night = nightHours();
  const priceAt = (agreement, time) => {
    if (!agreement?.priced) return null;
    return rateAt(agreement.twoRate && isNight(time, night) ? agreement.nightUnits : agreement.units, time);
  };

  const totals = Object.fromEntries(Object.entries(periods).map(([name, period]) =>
    [name, { ...period, kwh: 0, unitCost: 0, standingCharge: 0, complete: true }]));
  let latestReading = null;
  const chartDays = new Map();
  for (const reading of readings) {
    const start = Date.parse(reading.interval_start);
    const kwh = Number(reading.consumption) || 0;
    const agreement = agreementAt(start);
    const price = priceAt(agreement, start);
    latestReading = Math.max(latestReading || 0, Date.parse(reading.interval_end));
    if (start >= chartFrom) {
      const date = londonDay.format(new Date(start));
      if (!chartDays.has(date)) chartDays.set(date, []);
      chartDays.get(date).push([
        start,
        round(kwh, 3),
        price === null ? null : round(kwh * price, 2),
        agreement?.twoRate && isNight(start, night) ? 1 : 0
      ]);
    }
    for (const total of Object.values(totals)) {
      if (start < total.from || start >= total.to) continue;
      total.kwh += kwh;
      if (price === null) total.complete = false;
      else total.unitCost += kwh * price;
    }
  }

  // The standing charge is per day, for every day in the period up to today.
  if (agreements) {
    for (const total of Object.values(totals)) {
      const start = londonDate(total.from);
      for (let offset = 0; ; offset++) {
        const dayStart = londonMidnight(start.year, start.month, start.day + offset);
        if (dayStart >= total.to) break;
        const charge = rateAt(agreementAt(dayStart)?.standing || [], dayStart);
        if (charge === null) total.complete = false;
        else total.standingCharge += charge;
      }
    }
  }

  for (const total of Object.values(totals)) {
    total.kwh = round(total.kwh, 3);
    total.unitCost = round(total.unitCost, 2);
    total.standingCharge = round(total.standingCharge, 2);
  }
  const current = agreementAt(now);
  return {
    tariff: current?.tariff || null,
    // For two-rate tariffs, the night hours used, like "00:30–07:30 GMT".
    nightHours: current?.twoRate ? night.text : null,
    costs: Boolean(agreements),
    latestReading,
    periods: totals,
    days: [...chartDays].sort(([first], [second]) => first.localeCompare(second))
      .map(([date, dayReadings]) => ({ date, readings: dayReadings.sort((first, second) => first[0] - second[0]) }))
  };
}

// ---------- Live (Home Mini) ----------

// { readAt, demand, points, today } for the profile's live panel:
// readAt     when the Home Mini's newest reading was taken (ms), or null
// demand     the power being drawn then, in watts
// points     [[time, watts], …] every 10 seconds over the last LIVE_WINDOW_MS, oldest first
// today      { kwh, cost } since midnight UK time, cost in pence with VAT (unit rates
//            only, no standing charge; null if Octopus didn't price it), or null if
//            Octopus couldn't say
export async function readLiveEnergy(now = Date.now()) {
  if (liveCache && now - liveCache.at < LIVE_CACHE_MS) return liveCache.live;
  const deviceId = await findHomeMini();
  const { year, month, day } = londonDate(now);
  const [recent, sinceMidnight] = await Promise.allSettled([
    telemetry(deviceId, 'TEN_SECONDS', now - LIVE_WINDOW_MS, now),
    telemetry(deviceId, 'THIRTY_MINUTES', londonMidnight(year, month, day), now)
  ]);
  if (recent.status === 'rejected') throw recent.reason;
  if (sinceMidnight.status === 'rejected') console.error('Home Mini daily total failed', sinceMidnight.reason);

  const number = value => (value === null || value === undefined || value === '' ? null : Number(value));
  const points = recent.value
    .map(reading => [Date.parse(reading.readAt), number(reading.demand)])
    .filter(([time, watts]) => Number.isFinite(time) && Number.isFinite(watts))
    .sort((first, second) => first[0] - second[0]);
  const newest = points.at(-1);

  let today = null;
  if (sinceMidnight.status === 'fulfilled') {
    let wh = 0;
    let cost = 0;
    let priced = true;
    for (const reading of sinceMidnight.value) {
      wh += number(reading.consumptionDelta) || 0;
      const delta = number(reading.costDeltaWithTax);
      if (delta === null || !Number.isFinite(delta)) priced = false;
      else cost += delta;
    }
    today = {
      kwh: Math.round(wh) / 1000,
      cost: priced && sinceMidnight.value.length ? Math.round(cost * 100) / 100 : null
    };
  }

  const live = { readAt: newest?.[0] ?? null, demand: newest?.[1] ?? null, points, today };
  liveCache = { at: now, live };
  return live;
}
