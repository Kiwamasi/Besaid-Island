// Kiwamari's electricity use and costs from the Octopus Energy API, for the admin panel
// on their profile page. Everything Octopus needs lives in Netlify's environment
// variables, never in the repo or the pages:
//   OCTOPUS_API_KEY   from the Octopus dashboard (Personal details → API access)
//   OCTOPUS_MPAN      the electricity meter point's MPAN
//   OCTOPUS_SERIAL    the electricity meter's serial number
//   OCTOPUS_ACCOUNT   the account number (A-XXXXXXXX); optional, but needed for costs,
//                     as it's how the tariff and its prices are found
//
// Costs use the account's real tariff for each half hour: the unit rate in force then
// (so time-of-use tariffs like Agile and Go are priced correctly) plus the daily
// standing charge, both including VAT. Only single-rate tariffs (E-1R-…) are priced;
// Economy 7 style two-rate tariffs (E-2R-…) don't say in the API which hours are night.

const API = 'https://api.octopus.energy/v1';
const DAY_MS = 86400000;
const REQUEST_TIMEOUT_MS = 20000;

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

// A month at a time, side by side: a year of half-hourly prices (Agile) is about 17,500
// rows, and Octopus gives at most 1,500 a page.
async function unitRates(tariffCode, from, to) {
  const chunks = [];
  for (let start = from; start < to; start = Math.min(to, start + 31 * DAY_MS)) {
    chunks.push([start, Math.min(to, start + 31 * DAY_MS)]);
  }
  const path = `/products/${productCode(tariffCode)}/electricity-tariffs/${tariffCode}/standard-unit-rates/`;
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
    const priced = agreement.tariff.startsWith('E-1R-');
    const [units, standing] = await Promise.all([
      priced ? unitRates(agreement.tariff, start, end) : [],
      standingCharges(agreement.tariff, start, end)
    ]);
    return { ...agreement, priced, units, standing };
  }));
}

// ---------- Summary ----------

// { tariff, costs, latestReading, periods: { today, yesterday, week, month, year } }.
// Each period: { from, to, kwh, unitCost, standingCharge, complete } in kWh and pence;
// complete is false when some of its use couldn't be priced.
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
  const from = Math.min(...Object.values(periods).map(period => period.from));

  const mpan = encodeURIComponent(process.env.OCTOPUS_MPAN);
  const serial = encodeURIComponent(process.env.OCTOPUS_SERIAL);
  const [readings, agreements] = await Promise.all([
    getAll(`/electricity-meter-points/${mpan}/meters/${serial}/consumption/`, {
      period_from: iso(from), page_size: 25000, order_by: 'period'
    }),
    process.env.OCTOPUS_ACCOUNT ? readAgreements(from, now) : null
  ]);
  const agreementAt = time => agreements?.find(agreement => agreement.from <= time && time < agreement.to);

  const totals = Object.fromEntries(Object.entries(periods).map(([name, period]) =>
    [name, { ...period, kwh: 0, unitCost: 0, standingCharge: 0, complete: true }]));
  let latestReading = null;
  for (const reading of readings) {
    const start = Date.parse(reading.interval_start);
    const kwh = Number(reading.consumption) || 0;
    const agreement = agreementAt(start);
    const price = agreement?.priced ? rateAt(agreement.units, start) : null;
    latestReading = Math.max(latestReading || 0, Date.parse(reading.interval_end));
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

  const round = (value, places) => Math.round(value * 10 ** places) / 10 ** places;
  for (const total of Object.values(totals)) {
    total.kwh = round(total.kwh, 3);
    total.unitCost = round(total.unitCost, 2);
    total.standingCharge = round(total.standingCharge, 2);
  }
  return {
    tariff: agreementAt(now)?.tariff || null,
    costs: Boolean(agreements),
    latestReading,
    periods: totals
  };
}
