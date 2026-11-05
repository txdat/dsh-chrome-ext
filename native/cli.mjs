/**
 * Managed CLI install for the dsh web launcher.
 *
 * `npx` keys its `_npx` cache by spec string, so `@deepseek-ai/dsh` and
 * `@deepseek-ai/dsh@0.2.2-rc.1` end up as two trees of the same version (~900 MB
 * each), and every launch revalidates the registry. Instead: keep exactly one
 * tree at `cliDir()` with an exact version, install it in place when the version
 * changes, and run `node_modules/.bin/dsh` directly. npx stays the fallback for
 * a machine where the install cannot happen.
 *
 * The lock makes concurrent launches install once; a lock left by a killed host
 * is taken over rather than blocking every later start.
 */
import { spawn } from 'node:child_process';
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const DEFAULT_PACKAGE = '@deepseek-ai/dsh';
/** Bump deliberately: this is the version a fresh install pins. */
export const DEFAULT_VERSION = '0.2.2-rc.1';
/** An installer lock older than this is treated as abandoned. */
const LOCK_STALE_MS = 15 * 60_000;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** One tree, outside the repo, shared by the host and scripts/install-cli.mjs. */
export function cliDir(env = process.env) {
  return (
    env.DSH_EXT_CLI_DIR ??
    path.join(env.XDG_DATA_HOME ?? path.join(os.homedir(), '.local', 'share'), 'dsh-chrome-ext', 'cli')
  );
}

export function dshBin(dir) {
  return path.join(dir, 'node_modules', '.bin', 'dsh');
}

/** Installed version at `dir`, or null when there is no usable tree. */
export function installedVersion(dir, pkg = DEFAULT_PACKAGE) {
  try {
    const file = path.join(dir, 'node_modules', ...pkg.split('/'), 'package.json');
    return JSON.parse(readFileSync(file, 'utf8')).version ?? null;
  } catch {
    return null;
  }
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

function lockIsStale(lockFile) {
  try {
    const { pid, at } = JSON.parse(readFileSync(lockFile, 'utf8'));
    const started = Date.parse(at);
    if (!Number.isFinite(started)) return true;
    return !alive(pid) || Date.now() - started > LOCK_STALE_MS;
  } catch {
    return true;
  }
}

async function acquireLock(lockFile, { timeoutMs, log }) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      writeFileSync(lockFile, JSON.stringify({ pid: process.pid, at: new Date().toISOString() }), { flag: 'wx' });
      return true;
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      if (lockIsStale(lockFile)) {
        rmSync(lockFile, { force: true });
        continue;
      }
      await sleep(200);
    }
  }
  log?.(`install: ${lockFile} was still held after ${timeoutMs}ms`);
  return false;
}

/** Exact dependency, never a range: `npm install` here must not resolve anything. */
function manifest(version, pkg) {
  return `${JSON.stringify({ name: 'dsh-chrome-ext-cli', private: true, dependencies: { [pkg]: version } }, null, 2)}\n`;
}

async function runInstall({ dir, npm, version, pkg, env, logFile, timeoutMs }) {
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, 'package.json'), manifest(version, pkg));
  const fd = openSync(logFile, 'a', 0o600);
  try {
    return await new Promise((resolve) => {
      const child = spawn(npm, ['install', '--prefix', dir, '--no-audit', '--no-fund', '--prefer-offline'], {
        env,
        stdio: ['ignore', fd, fd],
      });
      const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
      child.on('error', () => {
        clearTimeout(timer);
        resolve(false);
      });
      child.on('exit', (code) => {
        clearTimeout(timer);
        resolve(code === 0);
      });
    });
  } finally {
    closeSync(fd);
  }
}

/**
 * Where to launch dsh from: an explicit override, the managed tree (installed
 * first if the version differs), or npx as the fallback.
 *
 * Returns `{ bin, via }` on success and `{ via: 'npx', warning }` when the
 * caller should fall back, so a broken install never blocks the launch.
 */
export async function resolveCli({
  version,
  dir = cliDir(),
  npm,
  env = process.env,
  logFile = path.join(dir, 'install.log'),
  timeoutMs = 600_000,
  pkg = DEFAULT_PACKAGE,
  log,
}) {
  if (env.DSH_EXT_DSH_BIN) return { bin: env.DSH_EXT_DSH_BIN, via: 'env' };
  // A renamed package has an unknown bin layout: leave it to npx.
  if (pkg !== DEFAULT_PACKAGE) return { via: 'npx', warning: `managed install only covers ${DEFAULT_PACKAGE}` };
  if (installedVersion(dir) === version && existsSync(dshBin(dir))) return { bin: dshBin(dir), via: 'cli' };
  if (!npm || !existsSync(npm)) return { via: 'npx', warning: `npm not found at ${npm ?? '(unset)'}` };

  const lockFile = `${dir}.lock`;
  mkdirSync(path.dirname(lockFile), { recursive: true });
  if (!(await acquireLock(lockFile, { timeoutMs, log }))) return { via: 'npx', warning: 'another install is still running' };
  try {
    // A concurrent launch may have finished this very install while we waited.
    if (installedVersion(dir) === version && existsSync(dshBin(dir))) return { bin: dshBin(dir), via: 'cli' };
    log?.(`install: ${pkg}@${version} -> ${dir}`);
    const installed = await runInstall({ dir, npm, version, pkg, env, logFile, timeoutMs });
    if (installed && installedVersion(dir) === version) return { bin: dshBin(dir), via: 'cli' };
    return { via: 'npx', warning: `install of ${pkg}@${version} failed; see ${logFile}` };
  } catch (error) {
    return { via: 'npx', warning: `install failed: ${error.message}` };
  } finally {
    rmSync(lockFile, { force: true });
  }
}
