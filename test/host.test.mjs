/**
 * Protocol and lifecycle tests for the native host.
 *
 * The real CLI is never started: `DSH_EXT_LAUNCH` points each test at a stub
 * launcher that prints the readiness line on an ephemeral port, which is
 * exactly the contract the host parses. No Chrome, no network, no dsh install.
 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';

const root = path.resolve(import.meta.dirname, '..');
/** host.mjs is invoked through node, so the checkout's file mode does not matter. */
const hostArgv = [process.execPath, path.join(root, 'native', 'host.mjs')];
/** host.sh must stay executable in git: Chrome execs this path directly. */
const wrapperArgv = [path.join(root, 'native', 'host.sh')];

const tempDirs = [];
after(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
});

function tempDir() {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'dsh-host-test-'));
  tempDirs.push(dir);
  return dir;
}

function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function killGroup(pid) {
  for (const signal of ['SIGKILL']) {
    try {
      process.kill(-pid, signal);
    } catch {
      try {
        process.kill(pid, signal);
      } catch {
        /* already gone */
      }
    }
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(predicate, timeoutMs = 10_000, label = 'condition') {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await sleep(50);
  }
  throw new Error(`timed out waiting for ${label}`);
}

/** A stub launcher announcing an ephemeral port, optionally after a delay. */
function stub(dir, { name, delayMs = 0, exit = false }) {
  const file = path.join(dir, name);
  writeFileSync(
    file,
    exit
      ? `console.log('dsh: startup failed: listen EADDRINUSE: address already in use 127.0.0.1:3080'); process.exit(1);\n`
      : `import net from 'node:net';
const server = net.createServer((socket) => socket.end());
setTimeout(() => {
  server.listen(0, '127.0.0.1', () => {
    console.log(\`dsh web: http://127.0.0.1:\${server.address().port}/?token=stub\`);
  });
}, ${delayMs});
setInterval(() => {}, 1 << 30);
`,
  );
  return file;
}

function env(dir, launcher) {
  return {
    ...process.env,
    DSH_EXT_STATE_DIR: dir,
    DSH_EXT_LOG_DIR: path.join(dir, 'logs'),
    DSH_EXT_READY_TIMEOUT_MS: '20000',
    DSH_EXT_LAUNCH: process.execPath,
    DSH_EXT_LAUNCH_ARGS: JSON.stringify([launcher]),
  };
}

/** Spawn the host, send one framed request, and read one framed reply. */
async function request(argv, message, environment, { keepStdinOpen = true } = {}) {
  const child = spawn(argv[0], argv.slice(1), { env: environment, stdio: ['pipe', 'pipe', 'pipe'] });
  const chunks = [];
  let stderr = '';
  child.stdout.on('data', (chunk) => chunks.push(chunk));
  child.stderr.on('data', (chunk) => {
    stderr += chunk;
  });

  const body = Buffer.from(JSON.stringify(message), 'utf8');
  const header = Buffer.alloc(4);
  header.writeUInt32LE(body.length, 0);
  child.stdin.write(Buffer.concat([header, body]));
  if (!keepStdinOpen) child.stdin.end();

  const code = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`host did not reply within 25s; stderr: ${stderr}`));
    }, 25_000);
    child.on('close', (exitCode) => {
      clearTimeout(timer);
      resolve(exitCode);
    });
    child.on('error', reject);
  });

  const out = Buffer.concat(chunks);
  assert.ok(out.length >= 4, `no reply frame (exit ${code}, stderr ${stderr})`);
  const reply = JSON.parse(out.subarray(4, 4 + out.readUInt32LE(0)).toString('utf8'));
  return { reply, code };
}

const stateOf = (dir) => {
  const file = path.join(dir, 'state.json');
  return existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : null;
};

/** Per-launch dsh logs only; host.log lives in the state dir, not here. */
const launchLogs = (dir) => readdirSync(path.join(dir, 'logs')).filter((name) => name.startsWith('dsh-'));

test('start replies with the parsed URL while stdin stays open', async () => {
  const dir = tempDir();
  const { reply } = await request(hostArgv, { type: 'start' }, env(dir, stub(dir, { name: 'ok.mjs' })));
  try {
    assert.equal(reply.ok, true);
    assert.equal(reply.running, true);
    assert.equal(reply.starting, false);
    assert.equal(reply.state, 'ready');
    assert.match(reply.url, /^http:\/\/127\.0\.0\.1:\d+\/\?token=stub$/);
    assert.equal(reply.cleanUrl, reply.url.replace('/?token=stub', '/'));
    assert.equal(reply.port, Number(new URL(reply.url).port));
    assert.ok(alive(reply.pid), 'the detached launcher survives the host exiting');
    assert.equal(stateOf(dir).state, 'ready');
    assert.ok(existsSync(path.join(dir, 'host.log')), 'host diagnostics stay in the state dir');
    assert.equal(launchLogs(dir).length, 1, 'the dsh log goes to its own dir');
    assert.ok(existsSync(reply.logFile), 'the reply names the dsh log');
  } finally {
    killGroup(reply.pid);
  }
});

test('the shell wrapper resolves node and speaks the same protocol', async () => {
  const dir = tempDir();
  const { reply } = await request(wrapperArgv, { type: 'status' }, env(dir, stub(dir, { name: 'unused.mjs' })), {
    keepStdinOpen: false,
  });
  assert.deepEqual(reply, { ok: true, running: false, starting: false });
});

test('start reuses a live server instead of spawning a second one', async () => {
  const dir = tempDir();
  const environment = env(dir, stub(dir, { name: 'ok.mjs' }));
  const first = await request(hostArgv, { type: 'start' }, environment);
  try {
    const again = await request(hostArgv, { type: 'start' }, environment);
    assert.equal(again.reply.reused, true);
    assert.equal(again.reply.pid, first.reply.pid);
    assert.equal(again.reply.url, first.reply.url);
    assert.equal(launchLogs(dir).length, 1, 'a second start must not write a second log');
  } finally {
    killGroup(first.reply.pid);
  }
});

test('stop kills the launched process group and clears the state', async () => {
  const dir = tempDir();
  const environment = env(dir, stub(dir, { name: 'ok.mjs' }));
  const started = await request(hostArgv, { type: 'start' }, environment);
  const stopped = await request(hostArgv, { type: 'stop' }, environment);
  assert.equal(stopped.reply.stopped, true);
  assert.equal(alive(started.reply.pid), false, 'the launcher is gone');
  assert.equal(stateOf(dir), null, 'state file removed');
});

test('a launch that outlives the host is resumed, not raced', async () => {
  const dir = tempDir();
  const environment = env(dir, stub(dir, { name: 'slow.mjs', delayMs: 2500 }));

  // Send the request and kill the host before the launcher prints its URL.
  const child = spawn(hostArgv[0], hostArgv.slice(1), { env: environment, stdio: ['pipe', 'pipe', 'pipe'] });
  const body = Buffer.from(JSON.stringify({ type: 'start' }), 'utf8');
  const header = Buffer.alloc(4);
  header.writeUInt32LE(body.length, 0);
  child.stdin.write(Buffer.concat([header, body]));

  await waitFor(() => stateOf(dir)?.state === 'launching', 10_000, 'the launching state');
  const launchingPid = stateOf(dir).pid;
  child.kill('SIGKILL');
  await sleep(200);

  try {
    const status = await request(hostArgv, { type: 'status' }, environment);
    assert.equal(status.reply.starting, true);
    assert.equal(status.reply.running, false);
    assert.equal(status.reply.pid, launchingPid);

    const resumed = await request(hostArgv, { type: 'start' }, environment);
    assert.equal(resumed.reply.ok, true);
    assert.equal(resumed.reply.running, true);
    assert.equal(resumed.reply.reused, true);
    assert.equal(resumed.reply.pid, launchingPid, 'resumed the same process');
    assert.equal(launchLogs(dir).length, 1, 'no second launcher');
  } finally {
    killGroup(launchingPid);
  }
});

test('stop refuses a pid it cannot prove it started', async () => {
  const dir = tempDir();
  const victim = spawn('/bin/sleep', ['60'], { stdio: 'ignore' });
  try {
    writeFileSync(
      path.join(dir, 'state.json'),
      JSON.stringify({
        state: 'ready',
        pid: victim.pid,
        launchId: 'not-the-launch-that-started-this-pid',
        port: 1,
        url: 'http://127.0.0.1:1/?token=x',
        cleanUrl: 'http://127.0.0.1:1/',
      }),
    );
    const stopped = await request(hostArgv, { type: 'stop' }, env(dir, stub(dir, { name: 'unused.mjs' })));
    assert.equal(stopped.reply.stopped, false);
    assert.match(stopped.reply.warning, /not the recorded dsh launch/);
    assert.ok(alive(victim.pid), 'the unrelated process must survive');
    assert.equal(stateOf(dir), null, 'stale state cleared');
  } finally {
    victim.kill('SIGKILL');
  }
});

test('a launcher that exits early reports its output and clears the state', async () => {
  const dir = tempDir();
  const { reply } = await request(
    hostArgv,
    { type: 'start' },
    env(dir, stub(dir, { name: 'fails.mjs', exit: true })),
  );
  assert.equal(reply.ok, false);
  assert.match(reply.error, /exited \(code 1/);
  assert.match(reply.output, /EADDRINUSE/);
  assert.equal(stateOf(dir), null);
});

test('an unknown request type is rejected', async () => {
  const dir = tempDir();
  const { reply } = await request(hostArgv, { type: 'nope' }, env(dir, stub(dir, { name: 'unused.mjs' })));
  assert.equal(reply.ok, false);
  assert.match(reply.error, /unknown request type "nope"/);
});
