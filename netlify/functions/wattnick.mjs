// Runs once a minute on Netlify's schedule (it can't be called from a browser): reads
// the Octopus Home Mini for the profile's live view, and updates the Discord nickname
// bot when it's on. See netlify/lib/wattnick.mjs.
import { getStore } from '@netlify/blobs';
import { runWattnick } from '../lib/wattnick.mjs';

// The same store as netlify/functions/backlog.mjs's statsStore().
const STATS_STORE_NAME = 'site-stats';

export default async () => {
  try {
    await runWattnick(getStore({ name: STATS_STORE_NAME, consistency: 'strong' }));
  } catch (error) {
    console.error('wattnick run failed', error);
  }
};

export const config = { schedule: '* * * * *' };
