/** Name of the native host; must match native/com.txdat.dsh_web.json and the file name. */
export const HOST_NAME = 'com.txdat.dsh_web';

/**
 * An exact CLI version, the only spec that keeps npx on one cache entry: ranges
 * (`^1.2.3`), tags (`latest`) and anything with blanks or extra arguments are
 * rejected. Lives here because the popup validates the input and native/host.mjs
 * re-validates whatever a caller sends.
 */
const VERSION_PATTERN = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.]+)?(?:\+[0-9A-Za-z.]+)?$/;

/**
 * '' means "use the host's built-in pin". Throws for anything that is not an
 * exact version, because npx would silently treat it as a different package.
 */
export function parseVersion(raw) {
  const value = String(raw ?? '').trim().replace(/^v/, '');
  if (value === '') return '';
  if (!VERSION_PATTERN.test(value)) {
    throw new Error(`"${raw}" is not an exact version (use e.g. 0.2.2-rc.1, not a tag or a range)`);
  }
  return value;
}

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

/** Popup settings survive Chrome restarts, unlike the per-open form values. */
export async function rememberSettings(settings) {
  await chrome.storage.local.set({ settings });
}

export async function recallSettings() {
  const { settings } = await chrome.storage.local.get('settings');
  return settings ?? null;
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
