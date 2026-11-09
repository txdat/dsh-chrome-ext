import { callHost, recall, remember, setBadge } from './lib.js';
import { nextPeakChange } from './peak.js';

const PEAK_ALARM = 'peak-boundary';

/**
 * One alarm at the exact next peak/off-peak flip keeps the badge honest while
 * the service worker sleeps. Chrome persists alarms across worker restarts.
 */
async function schedulePeakAlarm(now = new Date()) {
  const next = nextPeakChange(now);
  if (next) await chrome.alarms.create(PEAK_ALARM, { when: next.getTime() });
}

/** Keep the toolbar badge in sync without leaving the popup open. */
async function refresh() {
  try {
    const state = await callHost({ type: 'status' });
    await setBadge(state);
    await remember(state);
  } catch {
    await setBadge({ running: false });
  } finally {
    await schedulePeakAlarm();
  }
}

/** A boundary only changes the color, so no native host call is needed. */
async function syncBadge() {
  await setBadge(await recall());
  await schedulePeakAlarm();
}

chrome.runtime.onInstalled.addListener(refresh);
chrome.runtime.onStartup.addListener(refresh);
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === PEAK_ALARM) void syncBadge();
});
// The popup owns the lifecycle; the badge also follows what the popup stores.
chrome.storage.onChanged.addListener((changes) => {
  if (changes.state) setBadge(changes.state.newValue);
});

// Any worker wake re-creates the same absolute boundary, so a reload cannot
// leave the profile without an alarm even if onInstalled did not fire.
void schedulePeakAlarm();
