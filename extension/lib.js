/** Name of the native host; must match native/com.txdat.dsh_web.json and the file name. */
export const HOST_NAME = 'com.txdat.dsh_web';

/** One request, one response. The host exits after replying. */
export function callHost(request) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendNativeMessage(HOST_NAME, request, (response) => {
      const failure = chrome.runtime.lastError;
      if (failure) {
        reject(new Error(describeHostError(failure.message ?? 'native host failed')));
        return;
      }
      if (!response) {
        reject(new Error('native host returned no response'));
        return;
      }
      resolve(response);
    });
  });
}

/** Chrome reports a missing host without saying how to install it. */
function describeHostError(message) {
  if (/not found|not registered|Access to the specified native messaging host is forbidden/i.test(message)) {
    return `${message} - run "npm run install-host" from the extension checkout, then retry`;
  }
  return message;
}

export async function remember(state) {
  await chrome.storage.local.set({ state: state ?? null });
}

export async function recall() {
  const { state } = await chrome.storage.local.get('state');
  return state ?? null;
}

export async function setBadge(state) {
  const running = state?.running === true;
  await chrome.action.setBadgeBackgroundColor({ color: running ? '#1f7a3d' : '#8a8f98' });
  await chrome.action.setBadgeText({ text: running ? 'ON' : '' });
}

/** Open the dsh web UI as a tab in this Chrome window. */
export async function openUrl(url) {
  const [active] = await chrome.tabs.query({ active: true, currentWindow: true });
  await chrome.tabs.create({ url, active: true, ...(active?.windowId ? { windowId: active.windowId } : {}) });
}
