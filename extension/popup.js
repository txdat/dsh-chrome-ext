import { callHost, openUrl, parseVersion, recall, recallSettings, remember, rememberSettings, setBadge } from './lib.js';

const els = {
  status: document.getElementById('status'),
  open: document.getElementById('open'),
  stop: document.getElementById('stop'),
  reset: document.getElementById('reset'),
  workspace: document.getElementById('workspace'),
  port: document.getElementById('port'),
  version: document.getElementById('version'),
  details: document.getElementById('details'),
  detailsPane: document.getElementById('details-pane'),
  error: document.getElementById('error'),
};

let state = null;

function busy(on) {
  els.open.disabled = on;
  els.stop.disabled = on || !(state?.running || state?.starting);
}

function showError(error) {
  els.error.hidden = error === null;
  els.error.textContent = error ?? '';
}

/** `@deepseek-ai/dsh@0.2.2-rc.1` -> `0.2.2-rc.1`; the status line stays short. */
function versionLabel(spec) {
  return spec ? spec.slice(spec.lastIndexOf('@') + 1) : '';
}

/**
 * A pinned launch is normally served from the npm cache, so the status names the
 * version instead of promising a download.
 */
function startingText(version) {
  return `starting dsh${version ? `@${version}` : ''}…`;
}

function render() {
  const running = state?.running === true;
  const starting = state?.starting === true;
  els.status.textContent = running
    ? `running on port ${state.port} (pid ${state.pid})`
    : starting
      ? startingText(versionLabel(state.package))
      : 'not running';
  els.status.className = `status ${running ? 'running' : starting ? 'starting' : ''}`;
  els.open.textContent = running ? 'Open tab' : starting ? 'Wait for startup' : 'Start and open';
  els.stop.disabled = !running && !starting;

  els.details.replaceChildren();
  els.detailsPane.hidden = !running;
  if (!running) return;
  for (const [key, value] of Object.entries({
    url: state.cleanUrl,
    version: state.package,
    via: state.via,
    log: state.logFile,
    started: state.startedAt,
  })) {
    if (!value) continue;
    const term = document.createElement('dt');
    term.textContent = key;
    const detail = document.createElement('dd');
    detail.textContent = value;
    els.details.append(term, detail);
  }
}

async function refresh() {
  showError(null);
  state = await callHost({ type: 'status' });
  await remember(state);
  await setBadge(state);
  render();
}

/** The process token is exchanged for a cookie on first load, so later opens use the clean URL. */
async function openTab(state) {
  await openUrl(state.tokenConsumed && state.cleanUrl ? state.cleanUrl : state.url);
  if (!state.tokenConsumed) {
    state.tokenConsumed = true;
    await remember(state);
  }
}

/**
 * The stored version is the only setting that outlives the popup: the pin is
 * meant to be stable, while workspace and port stay per-open like before.
 */
async function saveVersion() {
  try {
    const version = parseVersion(els.version.value);
    els.version.value = version;
    await rememberSettings({ version });
    showError(null);
    return version;
  } catch (error) {
    showError(error.message);
    return null;
  }
}

els.open.addEventListener('click', async () => {
  busy(true);
  showError(null);
  try {
    const current = await callHost({ type: 'status' });
    if (current.running) {
      state = current;
      await openTab(current);
      return;
    }
    // An invalid version must stop the click before the host is asked to launch.
    const version = await saveVersion();
    if (version === null) return;
    els.status.textContent = startingText(version);
    els.status.className = 'status starting';
    const port = Number.parseInt(els.port.value, 10);
    const started = await callHost({
      type: 'start',
      ...(els.workspace.value.trim() ? { workspace: els.workspace.value.trim() } : {}),
      ...(Number.isInteger(port) ? { port } : {}),
      ...(version ? { version } : {}),
    });
    if (!started.ok) {
      // The host records the launch before it waits, so a timeout still leaves a
      // resumable entry; report the failure instead of leaving stale text.
      state = { running: false, starting: false };
      showError([started.error, started.output].filter(Boolean).join('\n\n'));
      await remember(state);
      await setBadge(state);
      render();
      return;
    }
    state = { running: true, ...started };
    await remember(state);
    await setBadge(state);
    render();
    await openTab(state);
  } catch (error) {
    showError(error.message);
  } finally {
    busy(false);
  }
});

els.reset.addEventListener('click', async () => {
  els.workspace.value = '';
  els.port.value = '';
  els.version.value = '';
  await rememberSettings({ version: '' });
  showError(null);
  els.workspace.focus();
});

els.version.addEventListener('change', () => void saveVersion());

els.stop.addEventListener('click', async () => {
  busy(true);
  try {
    const result = await callHost({ type: 'stop' });
    state = { running: false, starting: false };
    await remember(state);
    await setBadge(state);
    render();
    // The host refuses to signal a pid it cannot prove it started.
    if (result.warning) showError(result.warning);
  } catch (error) {
    showError(error.message);
  } finally {
    busy(false);
  }
});

const saved = await recall();
state = saved;
const settings = await recallSettings();
els.version.value = settings?.version ?? '';
render();
if (saved) {
  try {
    await refresh();
  } catch (error) {
    // Stale saved state plus a missing host: explain it instead of a dead panel.
    state = { running: false, starting: false };
    render();
    showError(error.message);
  }
}
