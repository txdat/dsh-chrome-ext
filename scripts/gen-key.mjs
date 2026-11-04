#!/usr/bin/env node
/**
 * Generate the manifest `key` that pins the extension ID, so `allowed_origins`
 * in the native host manifest stays valid across reloads and machines.
 *
 * Idempotent by design: with a key already pinned this only prints the ID, so
 * `npm run setup` can be re-run (fresh clone, moved checkout) without silently
 * rotating the ID under an extension that is already loaded. Pass `--force`
 * (npm run rotate-key) to deliberately pin a new key.
 *
 * The private key is discarded: it is only needed to sign a .crx for
 * distribution, which the Chrome Web Store does on your behalf.
 *
 * Usage: node scripts/gen-key.mjs [--write] [--force]
 */
import { generateKeyPairSync } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { extensionId } from './id.mjs';

const PLACEHOLDER = 'REPLACE_WITH_GENERATED_KEY';
const manifestPath = path.join(import.meta.dirname, '..', 'extension', 'manifest.json');
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
const write = process.argv.includes('--write');
const force = process.argv.includes('--force');

const pinned = manifest.key && manifest.key !== PLACEHOLDER ? manifest.key : null;
if (pinned && !force) {
  console.log(`extension id: chrome-extension://${extensionId(pinned)}/`);
  console.log('key already pinned in extension/manifest.json; nothing to do.');
  console.log('pass --force (npm run rotate-key) to rotate it; that changes the extension ID.');
  process.exit(0);
}

const { publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const key = publicKey.export({ type: 'spki', format: 'der' }).toString('base64');
console.log(`extension id: chrome-extension://${extensionId(key)}/`);
console.log(`key: ${key}`);

if (!write) {
  console.log('\nno --write: extension/manifest.json unchanged');
  process.exit(0);
}
manifest.key = key;
writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
console.log(`\nwrote key into ${manifestPath}`);
console.log('reload the unpacked extension so Chrome picks up the new ID.');
