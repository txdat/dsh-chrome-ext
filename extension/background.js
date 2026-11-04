import { callHost, remember, setBadge } from './lib.js';

/** Keep the toolbar badge in sync without leaving the popup open. */
async function refresh() {
  try {
    const state = await callHost({ type: 'status' });
    await setBadge(state);
    await remember(state);
  } catch {
    await setBadge({ running: false });
  }
}

chrome.runtime.onInstalled.addListener(refresh);
chrome.runtime.onStartup.addListener(refresh);
// The popup owns the lifecycle; the badge also follows what the popup stores.
chrome.storage.onChanged.addListener((changes) => {
  if (changes.state) setBadge(changes.state.newValue);
});
