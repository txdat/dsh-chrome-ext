/**
 * Unit tests for the extension helpers that do not need Chrome.
 *
 * `extension/lib.js` only touches `chrome.*` inside functions, so importing it
 * in Node is safe; the version parser is shared with the native host, which
 * re-validates whatever the popup sends.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { parseVersion, setBadge } from '../extension/lib.js';

test('parseVersion keeps an exact version', () => {
  assert.equal(parseVersion('0.2.2-rc.1'), '0.2.2-rc.1');
  assert.equal(parseVersion('  v1.2.3  '), '1.2.3', 'a leading v is dropped, as npm accepts it');
  assert.equal(parseVersion('1.2.3+build.5'), '1.2.3+build.5');
  assert.equal(parseVersion('0.1.7-rc.2'), '0.1.7-rc.2');
});

test('parseVersion treats a blank entry as "use the built-in pin"', () => {
  for (const input of ['', '   ', undefined, null]) {
    assert.equal(parseVersion(input), '', String(input));
  }
});

test('parseVersion rejects tags, ranges and option-like input', () => {
  for (const input of [
    'latest',
    'next',
    '^1.2.3',
    '~1.2.3',
    '>=1.0.0',
    '1.x',
    '1.2',
    '1.2.3 - 2.0.0',
    '0.2.2 --registry http://x',
    '0.2.2; id',
    '0.2.2 0.2.3',
  ]) {
    assert.throws(() => parseVersion(input), /not an exact version/, input);
  }
});

function fakeChrome() {
  const calls = { color: null, text: null, title: null };
  globalThis.chrome = {
    action: {
      async setBadgeBackgroundColor({ color }) {
        calls.color = color;
      },
      async setBadgeText({ text }) {
        calls.text = text;
      },
      async setTitle({ title }) {
        calls.title = title;
      },
    },
  };
  return calls;
}

test('setBadge is red in a weekday peak window and green off-peak', async () => {
  const calls = fakeChrome();
  try {
    await setBadge({ running: true }, new Date('2026-11-09T02:00:00Z'));
    assert.equal(calls.color, '#c62828');
    assert.equal(calls.text, 'ON');
    assert.match(calls.title, /Peak hours/);

    await setBadge({ running: true }, new Date('2026-11-09T12:00:00Z'));
    assert.equal(calls.color, '#1f7a3d');
    assert.match(calls.title, /Off-peak/);

    await setBadge({ running: true }, new Date('2026-11-07T02:00:00Z'));
    assert.equal(calls.color, '#1f7a3d', 'a weekend is off-peak');

    await setBadge({ running: false }, new Date('2026-11-09T02:00:00Z'));
    assert.equal(calls.color, '#8a8f98');
    assert.equal(calls.text, '');
  } finally {
    delete globalThis.chrome;
  }
});
