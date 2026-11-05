#!/usr/bin/env node
/**
 * Chrome native-messaging host for the dsh web launcher.
 *
 * Protocol: 4-byte little-endian length prefix + UTF-8 JSON, both directions.
 * One request, one response: the extension uses chrome.runtime.sendNativeMessage,
 * so this process starts, acts, replies, and exits. The dsh server it starts is
 * detached and survives the host exiting.
 *
 * Requests:
 *   { type: "start",  workspace?: string, port?: number }
 *   { type: "status" }
 *   { type: "stop" }
 *
 * State file shapes:
 *   { state: "launching", pid, launchId, port, workspace, logFile, startedAt }
 *   { state: "ready",     pid, launchId, port, url, cleanUrl, workspace, logFile, startedAt }
 *
 * `launching` is written as soon as the child exists, so a launch that outlives
 * this process (slow first install, closed popup) is resumed instead of raced.
 * `launchId` is passed to the child in its environment, which makes the state
 * entry provable: stop never signals a pid that does not carry it.
 *
 * Never write anything to stdout except framed messages.
 */
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { connect } from 'node:net';
import os from 'node:os';
import path from 'node:path';

/** The popup validates the version field with the same parser; here it is the boundary check. */
import { parseVersion } from '../extension/lib.js';

const STATE_DIR =
  process.env.DSH_EXT_STATE_DIR ??
  path.join(process.env.XDG_STATE_HOME ?? path.join(os.homedir(), '.local', 'state'), 'dsh-chrome-ext');
const STATE_FILE = path.join(STATE_DIR, 'state.json');
/** Per-launch dsh output goes to /tmp: it must outlive the host (resume), not a reboot. */
const LOG_DIR = process.env.DSH_EXT_LOG_DIR ?? path.join(os.tmpdir(), 'dsh-chrome-ext', 'logs');
const HOST_LOG = path.join(STATE_DIR, 'host.log');

const NODE_BIN = process.env.DSH_EXT_NODE ?? process.execPath;
const NPX_BIN = process.env.DSH_EXT_NPX ?? path.join(path.dirname(NODE_BIN), 'npx');
const PACKAGE = process.env.DSH_EXT_PACKAGE ?? '@deepseek-ai/dsh';
/**
 * Pinned CLI version. `npx @deepseek-ai/dsh` resolves the `latest` dist-tag on
 * every launch, so a newly published release is downloaded again; an exact
 * version reuses the same npm `_npx` cache entry and never re-resolves.
 * Bump it deliberately, override it per launch from Settings in the popup, or
 * set DSH_EXT_DSH_VERSION.
 */
const PINNED_VERSION = process.env.DSH_EXT_DSH_VERSION ?? '0.2.2-rc.1';
const DEFAULT_PORT = 3080;
/** A cold `npx` install of the CLI can take minutes; the launch is resumable, so err high. */
const READY_TIMEOUT_MS = Number(process.env.DSH_EXT_READY_TIMEOUT_MS ?? 600_000);
const LAUNCH_ID_VAR = 'DSH_EXT_LAUNCH_ID';

/** The readiness line `dsh web: <tokenized url>`; the browser-handoff line never matches. */
const URL_LINE = /(?:^|\n)dsh web: (https?:\/\/\S+)/;

mkdirSync(STATE_DIR, { recursive: true });

/** `@scope/name` -> `@scope/name@1.2.3`; an already versioned spec is left alone. */
function packageSpec(pkg, version) {
  if (!version || pkg.includes('@', 1)) return pkg;
  return `${pkg}@${version}`;
}

function log(message) {
  try {
    writeFileSync(HOST_LOG, `${new Date().toISOString()} [host.mjs] ${message}\n`, { flag: 'a' });
  } catch {
    /* diagnostics must never break the protocol */
  }
}

function readState() {
  try {
    return JSON.parse(readFileSync(STATE_FILE, 'utf8'));
  } catch {
    return null;
  }
}

function writeState(state) {
  const temp = `${STATE_FILE}.${process.pid}.tmp`;
  writeFileSync(temp, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
  renameSync(temp, STATE_FILE);
}

function clearState() {
  rmSync(STATE_FILE, { force: true });
}

function alive(pid) {
  if (!Number.isInteger(pid) || pid <= 1) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === 'EPERM';
  }
}

/**
 * Is this pid the process this state entry started?
 * Linux answers from the inherited environment, which survives the npx -> npm
 * exec hand-off; elsewhere the answer is unknown and callers fall back to the
 * port being open.
 */
function ownsProcess(pid, launchId) {
  if (process.platform !== 'linux' || !launchId || !Number.isInteger(pid)) return 'unknown';
  try {
    return readFileSync(`/proc/${pid}/environ`, 'utf8').split('\0').includes(`${LAUNCH_ID_VAR}=${launchId}`)
      ? 'yes'
      : 'no';
  } catch (error) {
    return error.code === 'ENOENT' ? 'no' : 'unknown';
  }
}

/** The recorded launch is still ours and still running. */
function sameProcess(state) {
  if (!state || !Number.isInteger(state.pid)) return false;
  if (ownsProcess(state.pid, state.launchId) === 'no') return false;
  return alive(state.pid);
}

function portOpen(port, timeout = 400) {
  return new Promise((resolve) => {
    const socket = connect({ host: '127.0.0.1', port, timeout }, () => {
      socket.destroy();
      resolve(true);
    });
    socket.on('timeout', () => {
      socket.destroy();
      resolve(false);
    });
    socket.on('error', () => resolve(false));
  });
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function tail(text, lines = 12) {
  return text.trimEnd().split('\n').slice(-lines).join('\n');
}

/** Lines appended to the log since the previous call. */
function readAppended(file, offset) {
  if (!existsSync(file)) return { text: '', offset };
  const size = statSync(file).size;
  if (size <= offset) return { text: '', offset };
  const fd = openSync(file, 'r');
  try {
    const buffer = Buffer.alloc(size - offset);
    readSync(fd, buffer, 0, buffer.length, offset);
    return { text: buffer.toString('utf8'), offset: size };
  } finally {
    closeSync(fd);
  }
}

function cleanUrl(url) {
  const parsed = new URL(url);
  parsed.search = '';
  parsed.hash = '';
  return parsed.href;
}

/** The listener port an advertised URL names, including the scheme default. */
function portOf(url) {
  const parsed = new URL(url);
  if (parsed.port) return Number(parsed.port);
  return parsed.protocol === 'https:' ? 443 : 80;
}

/**
 * Watch the child's log until the readiness line appears.
 * `child` is set only for a launch this process started; a resumed launch is
 * watched through its pid instead.
 */
async function waitForUrl(logFile, pid, child, deadline) {
  let offset = 0;
  let seen = '';
  let exit = null;
  child?.once('exit', (code, signal) => {
    exit = { code, signal };
  });
  while (Date.now() < deadline) {
    const chunk = readAppended(logFile, offset);
    offset = chunk.offset;
    seen += chunk.text;
    const match = URL_LINE.exec(seen);
    if (match) return { url: match[1] };
    if (exit !== null) {
      return { error: `dsh exited (code ${exit.code}, signal ${exit.signal}) before printing its URL`, seen };
    }
    if (child === null && !alive(pid)) return { error: 'the launch exited before printing its URL', seen };
    await sleep(120);
  }
  return { error: `timed out after ${Math.round(READY_TIMEOUT_MS / 1000)}s waiting for the dsh web URL`, seen };
}

function readyReply(state, reused) {
  return { ok: true, running: true, starting: false, reused, ...state };
}

/** Record the advertised URL and return the reply for a finished launch. */
function finish(state, url, reused) {
  const ready = {
    state: 'ready',
    pid: state.pid,
    launchId: state.launchId,
    package: state.package,
    port: portOf(url),
    url,
    cleanUrl: cleanUrl(url),
    workspace: state.workspace,
    logFile: state.logFile,
    startedAt: state.startedAt,
  };
  writeState(ready);
  log(`ready: pid ${ready.pid} on ${ready.cleanUrl}`);
  return readyReply(ready, reused);
}

async function start({ workspace, port, version } = {}) {
  // Validate before touching the state file: a bad version must not restart or
  // resume anything, and npx would read it as a different package anyway.
  let spec;
  try {
    spec = packageSpec(PACKAGE, parseVersion(version) || PINNED_VERSION);
  } catch (error) {
    return { ok: false, error: error.message };
  }

  const previous = readState();
  if (previous?.state === 'ready' && sameProcess(previous) && (await portOpen(previous.port))) {
    log(`reusing pid ${previous.pid}`);
    return readyReply(previous, true);
  }
  if (previous?.state === 'launching' && sameProcess(previous)) {
    // A launch is already in flight (slow install, or the popup closed and
    // Chrome killed the previous host). Wait for it rather than starting a
    // second server that would fail with EADDRINUSE.
    log(`resuming launch pid ${previous.pid}`);
    const deadline = Date.parse(previous.startedAt) + READY_TIMEOUT_MS;
    const resumed = await waitForUrl(previous.logFile, previous.pid, null, deadline);
    if (resumed.url !== undefined) return finish(previous, resumed.url, true);
    if (!sameProcess(previous)) clearState();
    return { ok: false, error: resumed.error, logFile: previous.logFile, output: tail(resumed.seen, 20) };
  }
  if (previous) clearState();

  mkdirSync(LOG_DIR, { recursive: true });
  const stamp = new Date().toISOString().replaceAll(':', '-').replace(/\..*/, '');
  const logFile = path.join(LOG_DIR, `dsh-${stamp}-${process.pid}.log`);
  const logFd = openSync(logFile, 'a', 0o600);

  const targetPort = Number.isInteger(port) && port > 0 ? port : DEFAULT_PORT;
  const args = ['--yes', spec, 'web', '--no-open', '--port', String(targetPort)];
  const command = process.env.DSH_EXT_LAUNCH ?? NPX_BIN;
  const commandArgs = process.env.DSH_EXT_LAUNCH ? JSON.parse(process.env.DSH_EXT_LAUNCH_ARGS ?? '[]') : args;
  const cwd = workspace && existsSync(workspace) ? workspace : os.homedir();
  const launchId = randomUUID();

  log(`start: ${command} ${commandArgs.join(' ')} (cwd ${cwd})`);
  let child;
  try {
    child = spawn(command, commandArgs, {
      cwd,
      env: {
        ...process.env,
        // node must be reachable for the npx shebang, whatever Chrome's PATH was
        PATH: `${path.dirname(NODE_BIN)}:${process.env.PATH ?? ''}`,
        [LAUNCH_ID_VAR]: launchId,
      },
      stdio: ['ignore', logFd, logFd],
      detached: true,
    });
  } catch (error) {
    closeSync(logFd);
    return { ok: false, error: `could not start ${command}: ${error.message}` };
  }
  closeSync(logFd);

  if (child.pid === undefined) return { ok: false, error: `could not start ${command}` };
  child.unref();

  const pending = {
    state: 'launching',
    pid: child.pid,
    launchId,
    package: spec,
    port: targetPort,
    workspace: cwd,
    logFile,
    startedAt: new Date().toISOString(),
  };
  writeState(pending);

  const started = await waitForUrl(logFile, child.pid, child, Date.now() + READY_TIMEOUT_MS);
  if (started.error !== undefined) {
    try {
      process.kill(-child.pid, 'SIGTERM');
    } catch {
      /* already gone */
    }
    clearState();
    log(`start failed: ${started.error}`);
    return { ok: false, error: started.error, logFile, output: tail(started.seen ?? '', 20) };
  }
  return finish(pending, started.url, false);
}

async function status() {
  const state = readState();
  if (!state) return { ok: true, running: false, starting: false };
  if (!sameProcess(state)) {
    clearState();
    return { ok: true, running: false, starting: false, stale: true };
  }
  if (state.state === 'launching') {
    return { ok: true, running: false, starting: true, pid: state.pid, logFile: state.logFile, startedAt: state.startedAt };
  }
  if (!(await portOpen(state.port))) {
    clearState();
    return { ok: true, running: false, starting: false, stale: true };
  }
  return readyReply(state, true);
}

async function stop() {
  const state = readState();
  if (!state) return { ok: true, running: false, starting: false, stopped: false };

  const ownership = ownsProcess(state.pid, state.launchId);
  const open = state.state === 'ready' ? await portOpen(state.port) : null;
  // Never signal a pid that is not provably ours: a stale state file plus pid
  // reuse would otherwise kill an unrelated process group.
  if (!sameProcess(state) || (ownership === 'unknown' && open === false)) {
    clearState();
    log(`stop: state does not match pid ${state.pid}; nothing signalled`);
    return {
      ok: true,
      running: false,
      starting: false,
      stopped: false,
      warning: `pid ${state.pid} is not the recorded dsh launch; cleared stale state`,
    };
  }

  for (const signal of ['SIGTERM', 'SIGKILL']) {
    try {
      // npx leads a process group; kill the group so dsh dies with it.
      process.kill(-state.pid, signal);
    } catch {
      try {
        process.kill(state.pid, signal);
      } catch {
        /* already gone */
      }
    }
    for (let waited = 0; waited < 3000; waited += 100) {
      if (!alive(state.pid)) break;
      await sleep(100);
    }
    if (!alive(state.pid)) break;
  }
  clearState();
  log(`stopped pid ${state.pid}`);
  return { ok: true, running: false, starting: false, stopped: true };
}

async function handle(message) {
  switch (message?.type) {
    case 'start':
      return start(message);
    case 'status':
      return status();
    case 'stop':
      return stop();
    default:
      return { ok: false, error: `unknown request type ${JSON.stringify(message?.type)}` };
  }
}

function reply(payload) {
  const body = Buffer.from(JSON.stringify(payload), 'utf8');
  const header = Buffer.alloc(4);
  header.writeUInt32LE(body.length, 0);
  process.stdout.write(Buffer.concat([header, body]), () => process.exit(0));
}

async function respond(buffer) {
  const length = buffer.readUInt32LE(0);
  const body = buffer.subarray(4, 4 + length).toString('utf8');
  try {
    reply(await handle(JSON.parse(body)));
  } catch (error) {
    log(`error: ${error?.stack ?? error}`);
    reply({ ok: false, error: String(error?.message ?? error) });
  }
}

// Read exactly one frame rather than waiting for EOF: the reply must not depend
// on Chrome half-closing the pipe.
let received = Buffer.alloc(0);
let answering = false;
process.stdin.on('data', (chunk) => {
  if (answering) return;
  received = Buffer.concat([received, chunk]);
  if (received.length < 4) return;
  const length = received.readUInt32LE(0);
  if (received.length < 4 + length) return;
  answering = true;
  process.stdin.pause();
  void respond(received);
});
process.stdin.on('end', () => {
  if (!answering) reply({ ok: false, error: 'incomplete request' });
});
process.stdin.on('error', (error) => {
  log(`stdin error: ${error.message}`);
  process.exit(1);
});
