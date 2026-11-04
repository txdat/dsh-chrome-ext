import { callHost, openUrl, recall, remember, setBadge } from './lib.js';

const els = {
  status: document.getElementById('status'),
  open: document.getElementById('open'),
  stop: document.getElementById('stop'),
  workspace: document.getElementById('workspace'),
  port: document.getElementById('port'),
  details: document.getElementById('details'),
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

function render() {
  const running = state?.running === true;
  const starting = state?.starting === true;
  els.status.textContent = running
    ? `running on port ${state.port} (pid ${state.pid})`
    : starting
      ? 'starting dsh (first run downloads the CLI)…'
      : 'not running';
  els.status.className = `status ${running ? 'running' : starting ? 'starting' : ''}`;
  els.open.textContent = running ? 'Open tab' : starting ? 'Wait for startup' : 'Start and open';
  els.stop.disabled = !running && !starting;

  els.details.replaceChildren();
  if (!running) return;
  for (const [key, value] of Object.entries({
    url: state.cleanUrl,
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
    els.status.textContent = 'starting dsh (first run downloads the CLI)…';
    els.status.className = 'status starting';
    const port = Number.parseInt(els.port.value, 10);
    const started = await callHost({
      type: 'start',
      ...(els.workspace.value.trim() ? { workspace: els.workspace.value.trim() } : {}),
      ...(Number.isInteger(port) ? { port } : {}),
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
