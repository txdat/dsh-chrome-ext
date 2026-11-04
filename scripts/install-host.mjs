#!/usr/bin/env node
/**
 * Register native/host.sh as a Chrome native messaging host for every browser
 * config directory on this machine, allowing exactly this extension's ID.
 *
 * Chrome reads these manifests on demand, so no browser restart is needed.
 * Re-run after moving this checkout, changing the pinning key, or reinstalling a
 * browser.
 */
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { extensionId } from './id.mjs';

const HOST_NAME = 'com.txdat.dsh_web';
const root = path.join(import.meta.dirname, '..');
const manifestPath = path.join(root, 'extension', 'manifest.json');
const hostScript = path.join(root, 'native', 'host.sh');
const hostManifestPath = path.join(root, 'native', `${HOST_NAME}.json`);

const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
if (!manifest.key || manifest.key === 'REPLACE_WITH_GENERATED_KEY') {
  console.error('extension/manifest.json has no key; run "node scripts/gen-key.mjs --write" first.');
  process.exit(1);
}
const id = extensionId(manifest.key);
const home = os.homedir();
const configHome = process.env.XDG_CONFIG_HOME ?? path.join(home, '.config');

/** Browser config roots, native install and flatpak/snap variants. */
const candidates = [
  path.join(configHome, 'google-chrome'),
  path.join(configHome, 'google-chrome-beta'),
  path.join(configHome, 'google-chrome-unstable'),
  path.join(configHome, 'google-chrome-dev'),
  path.join(configHome, 'chromium'),
  path.join(home, '.var', 'app', 'com.google.Chrome', 'config', 'google-chrome'),
  path.join(home, '.var', 'app', 'com.google.ChromeDev', 'config', 'google-chrome-unstable'),
  path.join(home, '.var', 'app', 'org.chromium.Chromium', 'config', 'chromium'),
  path.join(home, 'snap', 'chromium', 'common', 'chromium'),
];

if (!existsSync(hostScript)) {
  console.error(`missing ${hostScript}`);
  process.exit(1);
}
chmodSync(hostScript, 0o755);

const hostManifest = {
  name: HOST_NAME,
  description: 'Runs `npx @deepseek-ai/dsh web --no-open` for the dsh web launcher extension.',
  path: hostScript,
  type: 'stdio',
  allowed_origins: [`chrome-extension://${id}/`],
};
writeFileSync(hostManifestPath, `${JSON.stringify(hostManifest, null, 2)}\n`);
chmodSync(hostManifestPath, 0o644);

const installed = [];
for (const browserConfig of candidates) {
  if (!existsSync(browserConfig)) continue;
  const targetDir = path.join(browserConfig, 'NativeMessagingHosts');
  mkdirSync(targetDir, { recursive: true });
  const target = path.join(targetDir, `${HOST_NAME}.json`);
  writeFileSync(target, `${JSON.stringify(hostManifest, null, 2)}\n`);
  installed.push(target);
}

if (installed.length === 0) {
  console.error('no Chrome/Chromium config directory found; nothing registered.');
  process.exit(1);
}

console.log(`host:      ${HOST_NAME}`);
console.log(`extension: chrome-extension://${id}/`);
console.log(`script:    ${hostScript}`);
for (const target of installed) console.log(`installed: ${target}`);
console.log('\nReload the unpacked extension, then click the toolbar button.');
console.log('Note: flatpak Chrome cannot exec a host on the host system; use the system package.');
