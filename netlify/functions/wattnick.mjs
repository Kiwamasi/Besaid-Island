// Runs once a minute on Netlify's schedule (it can't be called from a browser). Three
// separate jobs, in order:
//   1. reads the Octopus Home Mini for the profile's live view (readLiveEnergy), always
//   2. updates the Discord nickname bot with that reading, if it's on (netlify/lib/wattnick.mjs)
//   3. when due, the live view's longer history (updateEnergyHistory), last so it
//      never holds up the nickname
import { getStore } from '@netlify/blobs';
import { octopusConfigured, readLiveEnergy, updateEnergyHistory } from '../lib/octopus.mjs';
import { runWattnick } from '../lib/wattnick.mjs';

// The same store as netlify/functions/backlog.mjs's statsStore().
const STATS_STORE_NAME = 'site-stats';

export default async () => {
  const store = getStore({ name: STATS_STORE_NAME, consistency: 'strong' });
  const now = Date.now();

  let live = null;
  let readError = "Octopus isn't set up on Netlify";
  if (octopusConfigured()) {
    try {
      live = await readLiveEnergy(store, now);
      readError = null;
    } catch (error) {
      readError = error.message;
    }
  }

  try {
    await runWattnick(store, live, readError, now);
  } catch (error) {
    console.error('wattnick run failed', error);
  }

  // Only when readLiveEnergy says it's due (straight away the first time, then every 5
  // minutes while fetching older history and every 15 once it's all in), so the other
  // runs don't read the store just to find it isn't. Not while readings are paused or
  // Octopus is refusing requests, when there's no live answer.
  if (!live?.historyDue) return;
  try {
    await updateEnergyHistory(store, now);
  } catch (error) {
    console.error('Home Mini history update failed', error);
  }
};

export const config = { schedule: '* * * * *' };
