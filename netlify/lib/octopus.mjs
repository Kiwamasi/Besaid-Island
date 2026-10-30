// Kiwamari's electricity use (kWh only, no costs) from the Octopus Energy API, for the
// admin panel on their profile page. Everything Octopus needs lives in Netlify's
// environment variables, never in the repo or the pages:
//   OCTOPUS_API_KEY   from the Octopus dashboard (Personal details → API access)
//   OCTOPUS_MPAN      the electricity meter point's MPAN
//   OCTOPUS_SERIAL    the electricity meter's serial number
//   OCTOPUS_ACCOUNT   the account number (A-XXXXXXXX); optional, for the tariff's name,
//                     and to find the Home Mini
//   OCTOPUS_DEVICE_ID optional: the Home Mini's smart device ID. Without it, it's
//                     looked up from OCTOPUS_ACCOUNT (the meter matching OCTOPUS_SERIAL).
//
// Live use (readLiveEnergy) comes from the Octopus Home Mini, through Octopus's
// GraphQL API rather than the REST one: it reports about every 10 seconds, where the
// meter's half-hourly readings reach the REST API about a day later.
//
// No costs are worked out or shown: two-rate tariffs (E-2R-…) have a day and a night
// price, but the API doesn't say which hours are night, so any cost would be a guess.

import { recordCall } from './debug-log.mjs';

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
  recordCall(`Octopus GET ${url.pathname}`);
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
// { at, nextAt, points, reachedFrom, chunkMs, complete, error }. Each update is one
// request: the readings since the newest kept and, until Octopus has nothing older,
// chunkMs further back. The first update is on the scheduled job's first run; then every
// HISTORY_BACKFILL_MS while there's older history to fetch, and every HISTORY_REFRESH_MS
// once it's all in. When the next one is due is kept in LIVE_KEY (historyDueAt), which
// the job reads every minute anyway, so the runs in between cost nothing.
const HISTORY_KEY = 'energy-history';
const HISTORY_REFRESH_MS = 15 * 60 * 1000;
const HISTORY_BACKFILL_MS = 5 * 60 * 1000;
// How far back each update reaches to begin with. If Octopus refuses that (perhaps too
// long a range), it's halved, down to HISTORY_MIN_CHUNK_MS, before the search back stops.
const HISTORY_CHUNK_MS = 3 * DAY_MS;
const HISTORY_MIN_CHUNK_MS = 6 * 60 * 60 * 1000;
const HISTORY_MAX_MS = 365 * DAY_MS;
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
  // Named by its operation, like "query live" or "mutation krakenToken".
  const [operation = 'query'] = query.match(/^\s*(?:query|mutation)\s+\w+/) || [];
  recordCall(`Octopus GraphQL ${operation.trim()}`);
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

// ---------- Tariff ----------

// The meter's current tariff code, like "E-1R-AGILE-24-10-01-C", from the account; null
// if there's none now. Only its name is shown: no prices, until they can all be had
// from Octopus (two-rate tariffs' night hours aren't in the API).
async function readTariff(now) {
  const account = await octopusGet(`/accounts/${encodeURIComponent(process.env.OCTOPUS_ACCOUNT)}/`);
  const point = account.properties
    ?.flatMap(property => property.electricity_meter_points || [])
    .find(meterPoint => meterPoint.mpan === process.env.OCTOPUS_MPAN);
  if (!point) throw new Error('That MPAN isn\'t on the Octopus account');
  const current = (point.agreements || []).find(agreement =>
    Date.parse(agreement.valid_from) <= now && (!agreement.valid_to || now < Date.parse(agreement.valid_to)));
  return current?.tariff_code || null;
}

// ---------- Summary ----------

// { tariff, latestReading, periods: { today, yesterday, week, month, year } }, all from
// the meter's half-hourly readings. Each period: { from, to, kwh }.
// days: the half-hourly readings for the chart, for each UK day in the last CHART_DAYS
// that has any, oldest first: [{ date: 'YYYY-MM-DD', readings: [[start, kWh], …] }].
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
  const [readings, tariff] = await Promise.all([
    getAll(`/electricity-meter-points/${mpan}/meters/${serial}/consumption/`, {
      period_from: iso(from), page_size: 25000, order_by: 'period'
    }),
    process.env.OCTOPUS_ACCOUNT ? readTariff(now) : null
  ]);

  const totals = Object.fromEntries(Object.entries(periods).map(([name, period]) => [name, { ...period, kwh: 0 }]));
  let latestReading = null;
  const chartDays = new Map();
  for (const reading of readings) {
    const start = Date.parse(reading.interval_start);
    const kwh = Number(reading.consumption) || 0;
    latestReading = Math.max(latestReading || 0, Date.parse(reading.interval_end));
    if (start >= chartFrom) {
      const date = londonDay.format(new Date(start));
      if (!chartDays.has(date)) chartDays.set(date, []);
      chartDays.get(date).push([start, round(kwh, 3)]);
    }
    for (const total of Object.values(totals)) {
      if (start >= total.from && start < total.to) total.kwh += kwh;
    }
  }
  for (const total of Object.values(totals)) total.kwh = round(total.kwh, 3);

  return {
    tariff,
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
// today      { kwh } since midnight UK time, or null if Octopus couldn't say. Up to
//            TODAY_REFRESH_MS old.
//
// Called once a minute by the scheduled job, never by the page. One request to Octopus:
// only the readings since the last answer (plus LIVE_OVERLAP_MS), with today's total
// added to the same request when it's due. store is the site's Netlify Blobs store.
// debug (on the answer, or on the error thrown) is true while the admin panel's Debug is
// on, so the scheduled job saves its calls for the debug log without another read.
export async function readLiveEnergy(store, now = Date.now()) {
  const existing = await store.getWithMetadata(LIVE_KEY, { type: 'json' });
  const saved = existing?.data || {};
  const debug = saved.debugUntil > now;
  try {
    return { ...(await readLiveReadings(store, existing, saved, now)), debug };
  } catch (error) {
    error.debug = debug;
    throw error;
  }
}

async function readLiveReadings(store, existing, saved, now) {
  if (saved.paused) throw new LivePaused();
  if (saved.blockedUntil > now) throw new OctopusRateLimit(saved.blockedUntil);
  if (saved.at && now - saved.at < LIVE_FRESH_MS) return { ...liveAnswer(saved), historyDue: false, archiveDue: false };

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
      ${todayDue ? 'today: smartMeterTelemetry(deviceId: $deviceId, grouping: FIVE_MINUTES, start: $midnight, end: $now) { consumptionDelta }' : ''}
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
    const wh = data.today.reduce((sum, reading) => sum + (number(reading.consumptionDelta) || 0), 0);
    today = { from: midnight, at: now, kwh: Math.round(wh) / 1000 };
  }

  // Only over the version read, so a Pause pressed while Octopus was being asked isn't
  // written over. The readings missed are asked for again next time.
  const next = {
    at: now, points, today, historyDueAt: saved.historyDueAt, archiveDueAt: saved.archiveDueAt, debugUntil: saved.debugUntil
  };
  await store.setJSON(LIVE_KEY, next, existing ? { onlyIfMatch: existing.etag } : { onlyIfNew: true });
  // historyDue and archiveDue tell the scheduled job to call updateEnergyHistory and
  // archiveTenSeconds after the nickname.
  return {
    ...liveAnswer(next),
    historyDue: !(saved.historyDueAt > now),
    archiveDue: !(saved.archiveDueAt > now)
  };
}

// Changes some of LIVE_KEY's fields, without writing over a change made at the same
// moment (the scheduled job and the Pause button both write it).
async function updateLive(store, fields) {
  for (let attempt = 0; attempt < 5; attempt++) {
    const existing = await store.getWithMetadata(LIVE_KEY, { type: 'json' });
    const next = { ...(existing?.data || {}), ...fields };
    const result = existing
      ? await store.setJSON(LIVE_KEY, next, { onlyIfMatch: existing.etag })
      : await store.setJSON(LIVE_KEY, next, { onlyIfNew: true });
    if (result.modified) return;
  }
  throw new Error('Could not save the live settings: try again');
}

// Pauses (or resumes) live readings: while paused, the scheduled job asks Octopus
// nothing for the live view or its history, and the Discord bot leaves the nickname as
// it is. The readings already saved stay. Answers with the new setting.
export async function setLivePaused(store, paused) {
  await updateLive(store, { paused });
  return { paused };
}

// The admin panel's Debug: while on, the scheduled job saves its calls for the debug
// log. It turns itself off after DEBUG_FOR_MS, so a page closed with it on doesn't
// leave the job writing the log for good; the page renews it while it's open.
const DEBUG_FOR_MS = 60 * 60 * 1000;
export async function setDebug(store, on, now = Date.now()) {
  const debugUntil = on ? now + DEBUG_FOR_MS : null;
  await updateLive(store, { debugUntil });
  return { debugUntil };
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
    pausedUntil: saved.blockedUntil > now ? saved.blockedUntil : null,
    // Until when the scheduled job saves its calls for the admin panel's debug log.
    debugUntil: saved.debugUntil > now ? saved.debugUntil : null
  };
}

// Called by the scheduled job after the nickname, when readLiveEnergy says it's due
// (historyDue). Errors other than "too many requests" are saved for the page to show,
// rather than thrown.
export async function updateEnergyHistory(store, now = Date.now()) {
  const saved = (await store.get(HISTORY_KEY, { type: 'json' })) || {};
  const limit = now - HISTORY_MAX_MS;
  const kept = (saved.points || []).filter(([time]) => time >= limit);
  const chunk = saved.chunkMs || HISTORY_CHUNK_MS;
  const from = kept.length ? kept.at(-1)[0] - HISTORY_OVERLAP_MS : now - chunk;
  // The first update asks for the newest chunk only; later ones also step further back.
  const reachedFrom = Math.max(limit, saved.reachedFrom ?? from);
  const older = kept.length && !saved.complete && reachedFrom > limit
    ? { from: Math.max(limit, reachedFrom - chunk), to: reachedFrom }
    : null;

  const context = { store, auth: (await store.get(AUTH_KEY, { type: 'json' })) || {} };
  const fields = '{ readAt consumptionDelta demand }';
  let data;
  let failure = null;
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
      const until = now + RATE_LIMIT_PAUSE_MS;
      await updateLive(store, { blockedUntil: until, historyDueAt: until });
      return;
    }
    failure = error;
  }

  let next;
  if (failure) {
    // Perhaps too long a range: ask for half as much next time. Once that's as small
    // as it goes, stop looking further back and keep updating the newest readings.
    const smaller = chunk / 2 >= HISTORY_MIN_CHUNK_MS;
    next = {
      points: kept,
      reachedFrom: saved.reachedFrom ?? null,
      chunkMs: smaller ? chunk / 2 : chunk,
      complete: Boolean(saved.complete || (older && !smaller)),
      error: failure.message
    };
  } else {
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
    next = {
      points: [...byTime].sort((first, second) => first[0] - second[0]),
      reachedFrom: older ? older.from : reachedFrom,
      chunkMs: chunk,
      // An empty answer for the older range means Octopus has nothing before it.
      complete: Boolean(saved.complete || (older && (!data?.older?.length || older.from <= limit))),
      error: null
    };
  }
  const nextAt = now + (next.complete ? HISTORY_REFRESH_MS : HISTORY_BACKFILL_MS);
  await store.setJSON(HISTORY_KEY, { ...next, at: now, nextAt });
  await updateLive(store, { historyDueAt: nextAt });
}

// For the live view's "All" tab, one UK day at a time, without asking Octopus:
// { days: ['YYYY-MM-DD', …] with readings, oldest first, date (the day asked for, or
// the newest), from, to (its midnights), points: [[time, watts], …] that day, every five
// minutes, complete (true once Octopus has nothing older), updatedAt, nextAt (when the
// next update is due), error }, or null before the first update.
export async function readSavedHistory(store, date, now = Date.now()) {
  const saved = await store.get(HISTORY_KEY, { type: 'json' });
  if (!saved?.at) return null;
  const points = saved.points || [];
  // Points are oldest first, so each day is named once, where it starts.
  const days = [];
  let dayEnd = -Infinity;
  for (const [time] of points) {
    if (time < dayEnd) continue;
    const { year, month, day } = londonDate(time);
    days.push(londonDay.format(new Date(time)));
    dayEnd = londonMidnight(year, month, day + 1);
  }
  const shown = days.includes(date) ? date : days.at(-1) || londonDay.format(new Date(now));
  const [year, month, day] = shown.split('-').map(Number);
  const from = londonMidnight(year, month, day);
  const to = londonMidnight(year, month, day + 1);
  return {
    days,
    date: shown,
    from,
    to,
    points: points.filter(([time]) => time >= from && time < to),
    complete: Boolean(saved.complete),
    updatedAt: saved.at,
    nextAt: saved.nextAt ?? null,
    error: saved.error || null,
    archive: await readArchiveState(store)
  };
}

// ---------- 10-second archive ----------
//
// Every 10-second Home Mini reading of each finished UK day, kept for good in its own
// Netlify Blobs store (passed in as archive), one entry per day, written once:
//   ten-seconds/YYYY-MM-DD  { date, from (its midnight), step: 10 (seconds), watts: [one
//                           per 10 seconds from midnight, null where there's no reading] }
// That's about 35 KB a day. Nobody knows how long Octopus keeps 10-second readings, so
// the first run also works back a day at a time until Octopus has none for
// ARCHIVE_EMPTY_STOP days running (or ARCHIVE_MAX_DAYS). After that it's checked once a
// week, fetching the days since. Each day is one request, ARCHIVE_STEP_MS apart, so it
// stays well inside Octopus's limit alongside the live readings and the history. When
// it's next due is kept in LIVE_KEY (archiveDueAt), like the history's. Its progress is
// in the stats store under ARCHIVE_STATE_KEY:
//   { newestChecked, oldestChecked (days asked about), savedDays, firstSaved, lastSaved
//     (days with readings), emptyRun, backfillDone, lastRunAt, nextAt, error }
const ARCHIVE_STATE_KEY = 'energy-archive-state';
const ARCHIVE_EVERY_MS = 7 * DAY_MS;
const ARCHIVE_STEP_MS = 5 * 60 * 1000;
const ARCHIVE_RETRY_MS = 60 * 60 * 1000;
// A day is archived once it's been over this long, so its last readings have arrived.
const ARCHIVE_SETTLE_MS = 60 * 60 * 1000;
const ARCHIVE_MAX_DAYS = 730;
const ARCHIVE_EMPTY_STOP = 2;
const TEN_SECONDS_MS = 10000;

// The UK day ('YYYY-MM-DD') by days after (or before) another, and a day's midnights.
function shiftDay(date, by) {
  const [year, month, day] = date.split('-').map(Number);
  return londonDay.format(new Date(londonMidnight(year, month, day + by)));
}

function dayBounds(date) {
  const [year, month, day] = date.split('-').map(Number);
  return { from: londonMidnight(year, month, day), to: londonMidnight(year, month, day + 1) };
}

// Called by the scheduled job when readLiveEnergy says archiveDue. Archives at most one
// day per call: the oldest-first search back, then the days since the newest checked.
export async function archiveTenSeconds(store, archive, now = Date.now()) {
  const state = (await store.get(ARCHIVE_STATE_KEY, { type: 'json' })) || {};
  const newestComplete = londonDay.format(new Date(now - ARCHIVE_SETTLE_MS - DAY_MS));
  const limit = londonDay.format(new Date(now - ARCHIVE_MAX_DAYS * DAY_MS));
  // Older days first: they're the ones Octopus may drop soonest.
  const target = !state.newestChecked ? newestComplete
    : !state.backfillDone ? shiftDay(state.oldestChecked, -1)
      : state.newestChecked < newestComplete ? shiftDay(state.newestChecked, 1)
        : null;

  const save = async (fields, nextAt) => {
    await store.setJSON(ARCHIVE_STATE_KEY, { ...state, ...fields, lastRunAt: now, nextAt });
    await updateLive(store, { archiveDueAt: nextAt });
  };
  if (!target) {
    await save({ error: null }, now + ARCHIVE_EVERY_MS);
    return;
  }

  const { from, to } = dayBounds(target);
  const context = { store, auth: (await store.get(AUTH_KEY, { type: 'json' })) || {} };
  let data;
  try {
    const deviceId = await homeMiniId(context);
    data = await graphql(context, `query archive($deviceId: String!, $from: DateTime!, $to: DateTime!) {
      day: smartMeterTelemetry(deviceId: $deviceId, grouping: TEN_SECONDS, start: $from, end: $to) { readAt demand }
    }`, { deviceId, from: iso(from), to: iso(to) });
  } catch (error) {
    if (error.rateLimited) {
      const until = now + RATE_LIMIT_PAUSE_MS;
      await updateLive(store, { blockedUntil: until, archiveDueAt: until });
      return;
    }
    // Tried again in an hour; the error shows on the "All" tab meanwhile.
    await save({ error: `${target}: ${error.message}` }, now + ARCHIVE_RETRY_MS);
    return;
  }

  // One slot per 10 seconds from midnight (8,640 a day; 8,280 or 9,000 when the clocks change).
  const watts = Array.from({ length: Math.round((to - from) / TEN_SECONDS_MS) }, () => null);
  let count = 0;
  for (const reading of data?.day || []) {
    const time = Date.parse(reading.readAt);
    const value = reading.demand === null || reading.demand === '' ? NaN : Number(reading.demand);
    const slot = Math.round((time - from) / TEN_SECONDS_MS);
    if (!Number.isFinite(value) || !(slot >= 0 && slot < watts.length)) continue;
    if (watts[slot] === null) count++;
    watts[slot] = Math.round(value);
  }
  if (count) await archive.setJSON(`ten-seconds/${target}`, { date: target, from, step: 10, watts });

  const fields = { error: null };
  if (!state.newestChecked || target > state.newestChecked) fields.newestChecked = target;
  if (!state.oldestChecked || target < state.oldestChecked) fields.oldestChecked = target;
  if (count) {
    fields.savedDays = (state.savedDays || 0) + 1;
    if (!state.firstSaved || target < state.firstSaved) fields.firstSaved = target;
    if (!state.lastSaved || target > state.lastSaved) fields.lastSaved = target;
  }
  // Searching back: stop after ARCHIVE_EMPTY_STOP empty days running, or at the limit.
  if (state.newestChecked && !state.backfillDone) {
    fields.emptyRun = count ? 0 : (state.emptyRun || 0) + 1;
    fields.backfillDone = fields.emptyRun >= ARCHIVE_EMPTY_STOP || target <= limit;
  }
  const next = { ...state, ...fields };
  const more = !next.backfillDone || next.newestChecked < newestComplete;
  await save(fields, now + (more ? ARCHIVE_STEP_MS : ARCHIVE_EVERY_MS));
}

// For the "All" tab's note: how much is archived. null before the first run.
async function readArchiveState(store) {
  const state = await store.get(ARCHIVE_STATE_KEY, { type: 'json' });
  if (!state?.lastRunAt) return null;
  return {
    savedDays: state.savedDays || 0,
    firstSaved: state.firstSaved || null,
    lastSaved: state.lastSaved || null,
    searching: !state.backfillDone,
    nextAt: state.nextAt ?? null,
    error: state.error || null
  };
}

function liveAnswer({ at, points = [], today }) {
  const newest = points.at(-1);
  return {
    readAt: newest?.[0] ?? null,
    demand: newest?.[1] ?? null,
    points,
    today: today ? { kwh: today.kwh } : null,
    updatedAt: at ?? null
  };
}
