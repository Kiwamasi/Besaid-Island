// The admin panel's debug log: a record of the calls the Netlify functions make to
// Octopus, Discord, Gemini and Netlify Blobs. It's only kept while the admin has Debug
// ticked on their profile:
// - netlify/functions/backlog.mjs sends the calls it made back with its answer, when the
//   admin's page asks with debug=1 in the address
// - netlify/functions/wattnick.mjs (the scheduled job) saves each run's calls under
//   DEBUG_LOG_KEY while debugUntil (in the energy-live blob) hasn't passed, and
//   ?energy-live hands them to the page
// Recording itself is just a list in memory, so it costs nothing when it isn't kept.
// Each Netlify function copy handles one request at a time, so one list is enough.

export const DEBUG_LOG_KEY = 'debug-log';
// The scheduled job's newest entries kept.
const MAX_JOB_ENTRIES = 300;

let calls = [];

export function startRecording() {
  calls = [];
}

// The calls recorded since startRecording: [{ at, text }].
export function takeRecording() {
  const taken = calls;
  calls = [];
  return taken;
}

// Meter and account details are left out, in case the log is shown or copied.
function redact(text) {
  let clean = text;
  for (const name of ['OCTOPUS_MPAN', 'OCTOPUS_SERIAL', 'OCTOPUS_ACCOUNT', 'OCTOPUS_DEVICE_ID']) {
    const value = process.env[name]?.trim();
    if (value) clean = clean.split(value).join('…');
  }
  return clean;
}

export function recordCall(text) {
  calls.push({ at: Date.now(), text: redact(text) });
}

// A Netlify Blobs store whose reads and writes are recorded, like "Blobs get
// site-stats/energy-live". name is the store's name.
const STORE_METHODS = new Set(['get', 'getWithMetadata', 'getMetadata', 'set', 'setJSON', 'delete', 'list']);
export function recordedStore(store, name) {
  return new Proxy(store, {
    get(target, property) {
      const value = target[property];
      if (typeof value !== 'function') return value;
      if (!STORE_METHODS.has(property)) return value.bind(target);
      return (...args) => {
        const [key] = args;
        const what = typeof key === 'string' ? key : key?.prefix ? `${key.prefix}*` : '*';
        recordCall(`Blobs ${property} ${name}/${what}`);
        return value.apply(target, args);
      };
    }
  });
}

// Adds a run's calls to the scheduled job's saved log, newest last. store is the
// site-stats store without recording, so this write doesn't log itself.
export async function saveJobLog(store, entries) {
  if (!entries.length) return;
  const saved = (await store.get(DEBUG_LOG_KEY, { type: 'json' })) || [];
  await store.setJSON(DEBUG_LOG_KEY, [...saved, ...entries].slice(-MAX_JOB_ENTRIES));
}
