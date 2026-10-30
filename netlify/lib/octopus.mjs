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
//
// Octopus limits how often it can be asked, so what can be kept is kept, in the site's
// own (private) Netlify Blobs store that backlog.mjs passes in, rather than in memory:
// Netlify often starts a fresh copy of the function, which would forget it.
//   AUTH_KEY  { token, expires, deviceId }: the GraphQL sign-in token (an hour long, so
//             about one sign-in an hour) and the Home Mini's ID (looked up once)
//   LIVE_KEY  { at, points, today, blockedUntil, paused }: the last live answer, shared
//             by every open tab, when Octopus last said "too many requests", and whether
//             the admin has paused readings (kept here, as the job reads this anyway)

const GRAPHQL = 'https://api.octopus.energy/v1/graphql/';
const AUTH_KEY = 'octopus-auth';
const LIVE_KEY = 'energy-live';
// Kraken tokens last an hour; a new one is fetched a little before that.
const TOKEN_LIFETIME_MS = 50 * 60 * 1000;
// The live chart covers this much of the recent past.
const LIVE_WINDOW_MS = 60 * 60 * 1000;
// Only the scheduled job (netlify/functions/wattnick.mjs, once a minute) asks Octopus;
// the page reads what it saved (readSavedLive). This is a guard against two runs close
// together asking twice.
const LIVE_FRESH_MS = 25000;
// Readings reach Octopus a minute or more late, sometimes in batches, so each update
// asks from this long before the newest reading already kept, to catch late ones.
const LIVE_OVERLAP_MS = 3 * 60 * 1000;
// Today's total is asked for at most this often, in the same request as the readings.
const TODAY_REFRESH_MS = 10 * 60 * 1000;
// After Octopus says "too many requests", it isn't asked again for this long.
const RATE_LIMIT_PAUSE_MS = 10 * 60 * 1000;
// The live view's "All" tab: the Home Mini's five-minute readings for as far back as
// Octopus keeps them (up to HISTORY_MAX_MS), kept under HISTORY_KEY as
// { at, points, reachedFrom, complete, error }. The scheduled job updates it every
// HISTORY_REFRESH_MS, in one request that asks for the readings since the newest kept
// and, until Octopus has nothing older, another HISTORY_CHUNK_MS further back.
const HISTORY_KEY = 'energy-history';
const HISTORY_REFRESH_MS = 15 * 60 * 1000;
// The scheduled job calls updateEnergyHistory on the quarter hours; this guards against
// two runs close together asking twice, without skipping a run that starts a little
// earlier in its minute than the last one did.
const HISTORY_FRESH_MS = 10 * 60 * 1000;
const HISTORY_CHUNK_MS = 2 * DAY_MS;
const HISTORY_MAX_MS = 90 * DAY_MS;
// Five-minute totals can still grow after they're first read, so the newest few are
// asked for again.
const HISTORY_OVERLAP_MS = 15 * 60 * 1000;

const ukTime = new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/London', hour: '2-digit', minute: '2-digit' });

// Thrown when Octopus is refusing requests for now; the site API answers HTTP 429.
export class OctopusRateLimit extends Error {
  constructor(until) {
    super(`Octopus says too many requests, so live use is paused until ${ukTime.format(until)}`);
    this.until = until;
  }
}

// Thrown while the admin has paused live readings from the profile's live panel. Its
// message ends up in the Discord bot's log.
export class LivePaused extends Error {
  constructor() {
    super('Electricity readings are paused on the profile, so the nickname is left as it is');
  }
}

const RATE_LIMIT_PATTERN =/too many requests|rate.?limit|throttl/i;
const AUTH_PATTERN = /jwt|token|signature|expired|authenticat|unauthori[sz]ed/i;

async function graphqlPost(query, variables, token) {
  const response = await fetch(GRAPHQL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `JWT ${token}` } : {}) },
    body: JSON.stringify({ query, variables }),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
  });
  const result = await response.json().catch(() => null);
  const message = result?.errors?.map(error => error.message).join('; ') || '';
  if (response.status === 429 || RATE_LIMIT_PATTERN.test(message)) {
    throw Object.assign(new Error(message || 'Too many requests'), { rateLimited: true });
  }
  if (!response.ok && !message) throw new Error(`Octopus answered HTTP ${response.status} for GraphQL`);
  if (message) throw Object.assign(new Error(message), { auth: AUTH_PATTERN.test(message) });
  return result.data;
}

// A new sign-in token, saved for every copy of the function to use.
async function renewToken(context) {
  const data = await graphqlPost(
    'mutation krakenToken($apiKey: String!) { obtainKrakenToken(input: { APIKey: $apiKey }) { token } }',
    { apiKey: process.env.OCTOPUS_API_KEY }
  );
  const token = data?.obtainKrakenToken?.token;
  if (!token) throw new Error("Octopus didn't give a GraphQL token for that API key");
  context.auth = { ...context.auth, token, expires: Date.now() + TOKEN_LIFETIME_MS };
  await context.store.setJSON(AUTH_KEY, context.auth);
}

// A signed-in query. Only a refused token is renewed and the query tried again; any
// other error (a rate limit above all) goes straight back, so it isn't made worse.
async function graphql(context, query, variables = {}) {
  if (!context.auth.token || context.auth.expires <= Date.now()) await renewToken(context);
  try {
    return await graphqlPost(query, variables, context.auth.token);
  } catch (error) {
    if (!error.auth) throw error;
    await renewToken(context);
    return graphqlPost(query, variables, context.auth.token);
  }
}

// The Home Mini's device ID: OCTOPUS_DEVICE_ID, or the smart device on the account's
// electricity meter (the one with OCTOPUS_SERIAL, if the account has several), looked
// up once and saved.
async function homeMiniId(context) {
  if (process.env.OCTOPUS_DEVICE_ID) return process.env.OCTOPUS_DEVICE_ID.trim();
  if (context.auth.deviceId) return context.auth.deviceId;
  if (!process.env.OCTOPUS_ACCOUNT) {
    throw new Error('Add OCTOPUS_ACCOUNT (or OCTOPUS_DEVICE_ID) on Netlify to find the Home Mini');
  }
  const data = await graphql(context, `query homeMini($account: String!) {
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
  context.auth = { ...context.auth, deviceId: meter.smartDevices[0].deviceId };
  await context.store.setJSON(AUTH_KEY, context.auth);
  return context.auth.deviceId;
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

// The whole period in one request, a page at a time: most tariffs change price only a
// few times a year, so that's one page. Half-hourly tariffs (Agile, about 17,500 prices
// a year) take more pages, as Octopus gives at most 1,500 a page. kind is
// "standard-unit-rates" (one price) or, for two-rate tariffs, "day-unit-rates" /
// "night-unit-rates".
async function unitRates(tariffCode, kind, from, to) {
  const path = `/products/${productCode(tariffCode)}/electricity-tariffs/${tariffCode}/${kind}/`;
  return cleanRates(await getAll(path, { period_from: iso(from), period_to: iso(to), page_size: 1500 }));
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
//            Octopus couldn't say. Up to TODAY_REFRESH_MS old.
//
// Called once a minute by the scheduled job, never by the page. One request to Octopus:
// only the readings since the last answer (plus LIVE_OVERLAP_MS), with today's total
// added to the same request when it's due. store is the site's Netlify Blobs store.
export async function readLiveEnergy(store, now = Date.now()) {
  const existing = await store.getWithMetadata(LIVE_KEY, { type: 'json' });
  const saved = existing?.data || {};
  if (saved.paused) throw new LivePaused();
  if (saved.blockedUntil > now) throw new OctopusRateLimit(saved.blockedUntil);
  if (saved.at && now - saved.at < LIVE_FRESH_MS) return liveAnswer(saved);

  const context = { store, auth: (await store.get(AUTH_KEY, { type: 'json' })) || {} };
  const windowStart = now - LIVE_WINDOW_MS;
  const kept = (saved.points || []).filter(([time]) => time >= windowStart);
  const from = kept.length ? Math.max(windowStart, kept.at(-1)[0] - LIVE_OVERLAP_MS) : windowStart;
  const { year, month, day } = londonDate(now);
  const midnight = londonMidnight(year, month, day);
  const todayDue = !saved.today || saved.today.from !== midnight || now - saved.today.at >= TODAY_REFRESH_MS;

  let data;
  try {
    const deviceId = await homeMiniId(context);
    // grouping is an enum, so it goes in the query itself rather than as a variable.
    // TelemetryGrouping has no half-hour value, so today's total is summed from five-minute steps.
    // Octopus rejects a declared variable that isn't used, so $midnight is only there
    // (and only sent) when today's total is part of the request.
    data = await graphql(context, `query live($deviceId: String!, $from: DateTime!, $now: DateTime!${todayDue ? ', $midnight: DateTime!' : ''}) {
      recent: smartMeterTelemetry(deviceId: $deviceId, grouping: TEN_SECONDS, start: $from, end: $now) { readAt demand }
      ${todayDue ? 'today: smartMeterTelemetry(deviceId: $deviceId, grouping: FIVE_MINUTES, start: $midnight, end: $now) { consumptionDelta costDeltaWithTax }' : ''}
    }`, { deviceId, from: iso(from), now: iso(now), ...(todayDue ? { midnight: iso(midnight) } : {}) });
  } catch (error) {
    if (!error.rateLimited) throw error;
    const blockedUntil = now + RATE_LIMIT_PAUSE_MS;
    await store.setJSON(LIVE_KEY, { ...saved, blockedUntil });
    throw new OctopusRateLimit(blockedUntil);
  }

  const number = value => (value === null || value === undefined || value === '' ? null : Number(value));
  // New readings replace kept ones at the same time; the rest are added.
  const byTime = new Map(kept);
  for (const reading of data?.recent || []) {
    const time = Date.parse(reading.readAt);
    const watts = number(reading.demand);
    if (Number.isFinite(time) && Number.isFinite(watts) && time >= windowStart) byTime.set(time, watts);
  }
  const points = [...byTime].sort((first, second) => first[0] - second[0]);

  let today = saved.today?.from === midnight ? saved.today : null;
  if (todayDue && data?.today) {
    let wh = 0;
    let cost = 0;
    let priced = data.today.length > 0;
    for (const reading of data.today) {
      wh += number(reading.consumptionDelta) || 0;
      const delta = number(reading.costDeltaWithTax);
      if (delta === null || !Number.isFinite(delta)) priced = false;
      else cost += delta;
    }
    today = { from: midnight, at: now, kwh: Math.round(wh) / 1000, cost: priced ? Math.round(cost * 100) / 100 : null };
  }

  // Only over the version read, so a Pause pressed while Octopus was being asked isn't
  // written over. The readings missed are asked for again next time.
  const next = { at: now, points, today };
  await store.setJSON(LIVE_KEY, next, existing ? { onlyIfMatch: existing.etag } : { onlyIfNew: true });
  return liveAnswer(next);
}

// Pauses (or resumes) live readings: while paused, the scheduled job asks Octopus
// nothing for the live view or its history, and the Discord bot leaves the nickname as
// it is. The readings already saved stay. Answers with the new setting.
export async function setLivePaused(store, paused) {
  for (let attempt = 0; attempt < 5; attempt++) {
    const existing = await store.getWithMetadata(LIVE_KEY, { type: 'json' });
    const next = { ...(existing?.data || {}), paused };
    const result = existing
      ? await store.setJSON(LIVE_KEY, next, { onlyIfMatch: existing.etag })
      : await store.setJSON(LIVE_KEY, next, { onlyIfNew: true });
    if (result.modified) return { paused };
  }
  throw new Error('Could not save the pause setting: try again');
}

// For the profile's live view: the scheduled job's last answer, without asking Octopus.
// null if the job hasn't saved one yet. pausedUntil is set while Octopus is refusing
// requests ("too many requests"), when the readings stop updating.
// paused is true while the admin has paused readings. Today's total is left out once
// it's from an earlier day, as it can be after a pause over midnight.
export async function readSavedLive(store, now = Date.now()) {
  const saved = await store.get(LIVE_KEY, { type: 'json' });
  if (!saved?.at && !saved?.paused) return null;
  const { year, month, day } = londonDate(now);
  const today = saved.today?.from === londonMidnight(year, month, day) ? saved.today : null;
  return {
    ...liveAnswer({ ...saved, today }),
    paused: Boolean(saved.paused),
    pausedUntil: saved.blockedUntil > now ? saved.blockedUntil : null
  };
}

// Called by the scheduled job every HISTORY_REFRESH_MS (on the quarter hours), after the
// nickname, so it costs four requests an hour. Errors other than "too many requests" are saved for the page
// to show, rather than thrown, and stop the search further back.
export async function updateEnergyHistory(store, now = Date.now()) {
  const live = (await store.get(LIVE_KEY, { type: 'json' })) || {};
  if (live.paused || live.blockedUntil > now) return;
  const saved = (await store.get(HISTORY_KEY, { type: 'json' })) || {};
  if (saved.at && now - saved.at < HISTORY_FRESH_MS) return;

  const limit = now - HISTORY_MAX_MS;
  const kept = (saved.points || []).filter(([time]) => time >= limit);
  const from = kept.length ? kept.at(-1)[0] - HISTORY_OVERLAP_MS : now - HISTORY_CHUNK_MS;
  // The first run asks for the newest chunk only; later ones also step further back.
  const reachedFrom = Math.max(limit, saved.reachedFrom ?? from);
  const older = kept.length && !saved.complete && reachedFrom > limit
    ? { from: Math.max(limit, reachedFrom - HISTORY_CHUNK_MS), to: reachedFrom }
    : null;

  const context = { store, auth: (await store.get(AUTH_KEY, { type: 'json' })) || {} };
  const fields = '{ readAt consumptionDelta demand }';
  let data;
  try {
    const deviceId = await homeMiniId(context);
    // Octopus rejects a declared variable that isn't used, so the older range's
    // variables are only there when it's asked for.
    data = await graphql(context, `query history($deviceId: String!, $from: DateTime!, $now: DateTime!${older ? ', $olderFrom: DateTime!, $olderTo: DateTime!' : ''}) {
      newer: smartMeterTelemetry(deviceId: $deviceId, grouping: FIVE_MINUTES, start: $from, end: $now) ${fields}
      ${older ? `older: smartMeterTelemetry(deviceId: $deviceId, grouping: FIVE_MINUTES, start: $olderFrom, end: $olderTo) ${fields}` : ''}
    }`, { deviceId, from: iso(from), now: iso(now), ...(older ? { olderFrom: iso(older.from), olderTo: iso(older.to) } : {}) });
  } catch (error) {
    if (error.rateLimited) {
      await store.setJSON(LIVE_KEY, { ...live, blockedUntil: now + RATE_LIMIT_PAUSE_MS });
      return;
    }
    // Perhaps Octopus won't go back that far: stop looking further back, and keep
    // updating the newest readings.
    await store.setJSON(HISTORY_KEY, {
      ...saved, at: now, points: kept, reachedFrom, complete: Boolean(saved.complete || older), error: error.message
    });
    return;
  }

  const number = value => (value === null || value === undefined || value === '' ? null : Number(value));
  // The average power over each five minutes, from the watt-hours used in them; the
  // demand at that moment if Octopus gives no total.
  const byTime = new Map(kept);
  for (const reading of [...(data?.older || []), ...(data?.newer || [])]) {
    const time = Date.parse(reading.readAt);
    const wh = number(reading.consumptionDelta);
    const watts = Number.isFinite(wh) ? wh * 12 : number(reading.demand);
    if (Number.isFinite(time) && Number.isFinite(watts) && time >= limit) byTime.set(time, Math.round(watts));
  }
  const points = [...byTime].sort((first, second) => first[0] - second[0]);
  await store.setJSON(HISTORY_KEY, {
    at: now,
    points,
    reachedFrom: older ? older.from : reachedFrom,
    // An empty answer for the older range means Octopus has nothing before it.
    complete: Boolean(saved.complete || (older && !data?.older?.length) || (older && older.from <= limit)),
    error: null
  });
}

// For the live view's "All" tab, without asking Octopus: { points: [[time, watts], …]
// every five minutes, oldest first, complete (true once Octopus has nothing older),
// updatedAt, error }, or null before the scheduled job's first update.
export async function readSavedHistory(store) {
  const saved = await store.get(HISTORY_KEY, { type: 'json' });
  if (!saved?.at) return null;
  return { points: saved.points || [], complete: Boolean(saved.complete), updatedAt: saved.at, error: saved.error || null };
}

function liveAnswer({ at, points = [], today }) {
  const newest = points.at(-1);
  return {
    readAt: newest?.[0] ?? null,
    demand: newest?.[1] ?? null,
    points,
    today: today ? { kwh: today.kwh, cost: today.cost } : null,
    updatedAt: at ?? null
  };
}
