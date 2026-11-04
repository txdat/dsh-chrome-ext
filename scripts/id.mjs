import { createHash } from 'node:crypto';

/**
 * Chrome's extension ID for a `key` manifest field: the first 16 bytes of
 * SHA-256 over the DER public key, each nibble mapped to a-p.
 */
export function extensionId(base64Key) {
  const digest = createHash('sha256').update(Buffer.from(base64Key, 'base64')).digest();
  return [...digest.subarray(0, 16).toString('hex')]
    .map((nibble) => String.fromCharCode(97 + Number.parseInt(nibble, 16)))
    .join('');
}
