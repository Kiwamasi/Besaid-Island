// Runs once a minute on Netlify's schedule (it can't be called from a browser). Four
// separate jobs, in order:
//   1. reads the Octopus Home Mini for the profile's live view (readLiveEnergy), always
//   2. updates the Discord nickname bot with that reading, if it's on (netlify/lib/wattnick.mjs)
//   3. when due, the live view's longer history (updateEnergyHistory)
//   4. when due, the 10-second archive (archiveTenSeconds): a day at a time, weekly
// 3 and 4 come last so they never hold up the nickname. While the admin panel's Debug
// is on, the run's calls are saved for its debug log (netlify/lib/debug-log.mjs).
import { getStore } from '@netlify/blobs';
import { recordedStore, saveJobLog, startRecording, takeRecording } from '../lib/debug-log.mjs';
import { archiveTenSeconds, octopusConfigured, readLiveEnergy, updateEnergyHistory } from '../lib/octopus.mjs';
import { runWattnick } from '../lib/wattnick.mjs';

// The same store as netlify/functions/backlog.mjs's statsStore().
const STATS_STORE_NAME = 'site-stats';
// The 10-second archive's day files, kept apart from everything else as they only grow.
const ARCHIVE_STORE_NAME = 'energy-archive';

export default async () => {
  startRecording();
  const statsStore = getStore({ name: STATS_STORE_NAME, consistency: 'strong' });
  const store = recordedStore(statsStore, STATS_STORE_NAME);
  const now = Date.now();

  let live = null;
  let debug = false;
  let readError = "Octopus isn't set up on Netlify";
  if (octopusConfigured()) {
    try {
      live = await readLiveEnergy(store, now);
      debug = live.debug;
      readError = null;
    } catch (error) {
      debug = Boolean(error.debug);
      readError = error.message;
    }
  }

  try {
    await runWattnick(store, live, readError, now);
  } catch (error) {
    console.error('wattnick run failed', error);
  }

  // Only when readLiveEnergy says they're due, so the other runs don't read the store
  // just to find they aren't. Not while readings are paused or Octopus is refusing
  // requests, when there's no live answer.
  if (live?.historyDue) {
    try {
      await updateEnergyHistory(store, now);
    } catch (error) {
      console.error('Home Mini history update failed', error);
    }
  }
  if (live?.archiveDue) {
    try {
      const archive = recordedStore(getStore({ name: ARCHIVE_STORE_NAME, consistency: 'strong' }), ARCHIVE_STORE_NAME);
      await archiveTenSeconds(store, archive, now);
    } catch (error) {
      console.error('Home Mini 10-second archive failed', error);
    }
  }

  const calls = takeRecording();
  if (!debug) return;
  try {
    // Saving the log is two calls of its own, noted so the log shows everything.
    await saveJobLog(statsStore, [...calls, { at: Date.now(), text: 'Blobs get + setJSON site-stats/debug-log (this log)' }]);
  } catch (error) {
    console.error('Debug log save failed', error);
  }
};

export const config = { schedule: '* * * * *' };
