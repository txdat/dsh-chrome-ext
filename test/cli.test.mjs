/**
 * Unit tests for the managed CLI install (native/cli.mjs).
 *
 * The real npm is never run: `stubInstaller` materialises the tree the way an
 * install would, or exits non-zero so the npx fallback can be checked.
 */
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';

import { DEFAULT_PACKAGE, dshBin, installedVersion, resolveCli } from '../native/cli.mjs';
import { fakeTree, stubInstaller } from './stubs.mjs';

const tempDirs = [];
after(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
});

function tempDir() {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'dsh-cli-test-'));
  tempDirs.push(dir);
  return dir;
}

function env(dir, extra = {}) {
  return {
    ...process.env,
    DSH_EXT_DSH_BIN: '',
    FAKE_INSTALL_ARGV: path.join(dir, 'install-argv.txt'),
    FAKE_ARGV: path.join(dir, 'bin-argv.txt'),
    FAKE_NODE: process.execPath,
    FAKE_LAUNCHER: path.join(dir, 'unused-launcher.mjs'),
    ...extra,
  };
}

const installArgs = (dir) => readFileSync(path.join(dir, 'install-argv.txt'), 'utf8').trim().split('\n');
const manifestOf = (dir) => JSON.parse(readFileSync(path.join(dir, 'cli', 'package.json'), 'utf8'));

test('a tree at the requested version is used without running npm', async () => {
  const dir = tempDir();
  fakeTree(path.join(dir, 'cli'), '1.2.3');
  const { file: npm } = stubInstaller(dir);

  const result = await resolveCli({ version: '1.2.3', dir: path.join(dir, 'cli'), npm, env: env(dir) });

  assert.equal(result.via, 'cli');
  assert.equal(result.bin, dshBin(path.join(dir, 'cli')));
  assert.equal(existsSync(path.join(dir, 'install-argv.txt')), false, 'npm was not needed');
});

test('a missing or stale tree is installed in place at the exact version', async () => {
  const dir = tempDir();
  const cli = path.join(dir, 'cli');
  fakeTree(cli, '0.1.0');
  const { file: npm } = stubInstaller(dir);

  const result = await resolveCli({ version: '1.2.3', dir: cli, npm, env: env(dir), logFile: path.join(dir, 'install.log') });

  assert.equal(result.via, 'cli');
  assert.equal(installedVersion(cli), '1.2.3', 'the tree was replaced, not duplicated');
  assert.deepEqual(installArgs(dir), [
    'install',
    '--prefix',
    cli,
    '--no-audit',
    '--no-fund',
    '--prefer-offline',
  ]);
  assert.deepEqual(manifestOf(dir).dependencies, { [DEFAULT_PACKAGE]: '1.2.3' }, 'an exact dependency, never a range');
});

test('a failed install falls back to npx with a warning instead of failing the launch', async () => {
  const dir = tempDir();
  const cli = path.join(dir, 'cli');
  const { file: npm } = stubInstaller(dir, { fail: true });

  const result = await resolveCli({ version: '1.2.3', dir: cli, npm, env: env(dir), logFile: path.join(dir, 'install.log') });

  assert.equal(result.via, 'npx');
  assert.equal(result.bin, undefined);
  assert.match(result.warning, /install of @deepseek-ai\/dsh@1\.2\.3 failed/);
});

test('concurrent launches install once', async () => {
  const dir = tempDir();
  const cli = path.join(dir, 'cli');
  const { file: npm } = stubInstaller(dir, { delayMs: 300 });
  const environment = env(dir);

  const results = await Promise.all([
    resolveCli({ version: '1.2.3', dir: cli, npm, env: environment, logFile: path.join(dir, 'install.log'), timeoutMs: 10_000 }),
    resolveCli({ version: '1.2.3', dir: cli, npm, env: environment, logFile: path.join(dir, 'install.log'), timeoutMs: 10_000 }),
  ]);

  assert.deepEqual(
    results.map((result) => result.via),
    ['cli', 'cli'],
  );
  const log = readFileSync(path.join(dir, 'install-argv.txt'), 'utf8');
  assert.equal(log.trim().split('\n').length, 6, 'npm ran exactly once');
});

test('DSH_EXT_DSH_BIN wins over the managed tree', async () => {
  const dir = tempDir();
  const cli = path.join(dir, 'cli');
  fakeTree(cli, '1.2.3');
  const { file: npm } = stubInstaller(dir);

  const result = await resolveCli({
    version: '1.2.3',
    dir: cli,
    npm,
    env: env(dir, { DSH_EXT_DSH_BIN: '/opt/dsh/bin/dsh' }),
  });

  assert.deepEqual(result, { bin: '/opt/dsh/bin/dsh', via: 'env' });
});

test('a custom package is left to npx', async () => {
  const dir = tempDir();
  const { file: npm } = stubInstaller(dir);

  const result = await resolveCli({
    version: '1.2.3',
    dir: path.join(dir, 'cli'),
    npm,
    env: env(dir),
    pkg: '@example/dsh',
  });

  assert.equal(result.via, 'npx');
  assert.equal(existsSync(path.join(dir, 'install-argv.txt')), false, 'no install for an unknown layout');
});

test('a CLI dir whose parent does not exist yet is created', async () => {
  const dir = tempDir();
  const cli = path.join(dir, 'share', 'dsh-chrome-ext', 'cli');
  const { file: npm } = stubInstaller(dir);

  const result = await resolveCli({ version: '1.2.3', dir: cli, npm, env: env(dir), logFile: path.join(dir, 'install.log') });

  assert.equal(result.via, 'cli');
  assert.equal(installedVersion(cli), '1.2.3');
});

test('a lock left by a dead installer does not block the launch', async () => {
  const dir = tempDir();
  const cli = path.join(dir, 'cli');
  const { file: npm } = stubInstaller(dir);
  writeFileSync(`${cli}.lock`, JSON.stringify({ pid: 2 ** 22 + 7, at: new Date(0).toISOString() }));

  const result = await resolveCli({ version: '1.2.3', dir: cli, npm, env: env(dir), logFile: path.join(dir, 'install.log'), timeoutMs: 5_000 });

  assert.equal(result.via, 'cli');
  assert.equal(existsSync(`${cli}.lock`), false, 'the stale lock was cleared');
});
