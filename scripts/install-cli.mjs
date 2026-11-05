#!/usr/bin/env node
/**
 * Install, or switch, the exact dsh CLI the extension launches.
 *
 * The native host does this on demand during `start`; this script is the
 * terminal path and the way to pre-install before the first click:
 *
 *   npm run install-cli                 # the pinned default
 *   npm run install-cli -- 0.1.7-rc.2   # or an explicit version
 *
 * One tree lives in the CLI dir and is replaced in place, so switching versions
 * never leaves a second copy behind.
 */
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';

import { parseVersion } from '../extension/lib.js';
import { DEFAULT_PACKAGE, DEFAULT_VERSION, cliDir, dshBin, installedVersion, resolveCli } from '../native/cli.mjs';

const argv = process.argv.slice(2);

if (argv.includes('-h') || argv.includes('--help')) {
  console.log(`Usage: npm run install-cli [-- VERSION]

Installs ${DEFAULT_PACKAGE} at VERSION (default ${DEFAULT_VERSION}) into
${cliDir()}, replacing whatever version is installed there.`);
  process.exit(0);
}

let version;
try {
  version = parseVersion(argv[0] ?? '') || DEFAULT_VERSION;
} catch (error) {
  console.error(`install-cli: ${error.message}`);
  process.exit(1);
}

const dir = cliDir();
const npm = process.env.DSH_EXT_NPM ?? path.join(path.dirname(process.env.DSH_EXT_NODE ?? process.execPath), 'npm');
const npmVersion = spawnSync(npm, ['--version'], { encoding: 'utf8' });

if (!existsSync(npm)) {
  console.error(`install-cli: no npm at ${npm} (set DSH_EXT_NPM)`);
  process.exit(1);
}
console.log(`install-cli: npm ${npmVersion.stdout?.trim() ?? '?'} -> ${DEFAULT_PACKAGE}@${version} in ${dir}`);

const logFile = path.join(dir, 'install.log');
const result = await resolveCli({
  version,
  dir,
  npm,
  logFile,
  log: (message) => console.log(`install-cli: ${message}`),
});

if (!result.bin || result.via === 'npx') {
  console.error(`install-cli: ${result.warning ?? 'install failed'}`);
  console.error(`install-cli: output is in ${logFile}`);
  process.exit(1);
}

console.log(`install-cli: ${result.via} -> ${result.bin} (installed ${installedVersion(dir)})`);
if (result.bin !== dshBin(dir)) console.log(`install-cli: note: ${dshBin(dir)} is the managed path`);
