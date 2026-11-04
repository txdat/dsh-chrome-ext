#!/usr/bin/env node
/**
 * Generate the manifest `key` that pins the extension ID, so `allowed_origins`
 * in the native host manifest stays valid across reloads and machines.
 *
 * The private key is discarded: it is only needed to sign a .crx for
 * distribution, which the Chrome Web Store does on your behalf.
 *
 * Usage: node scripts/gen-key.mjs [--write]
 */
import { generateKeyPairSync } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { extensionId } from './id.mjs';

const manifestPath = path.join(import.meta.dirname, '..', 'extension', 'manifest.json');
const { publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const key = publicKey.export({ type: 'spki', format: 'der' }).toString('base64');
const id = extensionId(key);

console.log(`extension id: chrome-extension://${id}/`);
console.log(`key: ${key}`);

if (process.argv.includes('--write')) {
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  manifest.key = key;
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  console.log(`\nwrote key into ${manifestPath}`);
  console.log('reload the unpacked extension so Chrome picks up the pinned ID.');
} else {
  console.log('\npass --write to put this key into extension/manifest.json');
}
