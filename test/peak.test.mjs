/**
 * Peak-hour schedule: 01:00-04:00 and 06:00-10:00 UTC on weekdays only.
 *
 * 2026-11-09 is a Monday, 2026-11-07 a Saturday. The tests pin both the current
 * state and the next flip, because the badge alarm is scheduled from the flip.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { isPeak, nextPeakChange, peakLabel, utcWhen } from '../extension/peak.js';

const at = (iso) => new Date(iso);

test('isPeak follows the weekday UTC windows', () => {
  const cases = [
    ['2026-11-09T00:59:00Z', false],
    ['2026-11-09T01:00:00Z', true],
    ['2026-11-09T03:59:59Z', true],
    ['2026-11-09T04:00:00Z', false],
    ['2026-11-09T05:59:00Z', false],
    ['2026-11-09T06:00:00Z', true],
    ['2026-11-09T09:59:00Z', true],
    ['2026-11-09T10:00:00Z', false],
  ];
  for (const [iso, expected] of cases) {
    assert.equal(isPeak(at(iso)), expected, iso);
  }
});

test('weekends are off-peak all day', () => {
  for (const iso of [
    '2026-11-07T02:00:00Z', // Saturday
    '2026-11-07T07:00:00Z',
    '2026-11-08T02:00:00Z', // Sunday
    '2026-11-08T07:00:00Z',
  ]) {
    assert.equal(isPeak(at(iso)), false, iso);
  }
});

test('nextPeakChange lands on the next window edge', () => {
  const cases = [
    ['2026-11-09T00:30:00Z', '2026-11-09T01:00:00Z'],
    ['2026-11-09T02:00:00Z', '2026-11-09T04:00:00Z'],
    ['2026-11-09T04:30:00Z', '2026-11-09T06:00:00Z'],
    ['2026-11-09T09:00:00Z', '2026-11-09T10:00:00Z'],
    ['2026-11-09T12:00:00Z', '2026-11-10T01:00:00Z'],
  ];
  for (const [now, expected] of cases) {
    assert.equal(nextPeakChange(at(now)).toISOString(), at(expected).toISOString(), now);
  }
});

test('the next flip can be days away across a weekend', () => {
  assert.equal(nextPeakChange(at('2026-11-07T02:00:00Z')).toISOString(), at('2026-11-09T01:00:00Z').toISOString());
  assert.equal(nextPeakChange(at('2026-11-06T12:00:00Z')).toISOString(), at('2026-11-09T01:00:00Z').toISOString());
});

test('peakLabel names the next change, including a later day', () => {
  assert.deepEqual(peakLabel(at('2026-11-09T02:00:00Z')), {
    peak: true,
    text: 'Peak hours: DeepSeek API rates are higher until 04:00 UTC.',
  });
  assert.deepEqual(peakLabel(at('2026-11-09T00:30:00Z')), {
    peak: false,
    text: 'Off-peak: DeepSeek API rates are lower until 01:00 UTC.',
  });
  assert.deepEqual(peakLabel(at('2026-11-06T12:00:00Z')), {
    peak: false,
    text: 'Off-peak: DeepSeek API rates are lower until Mon 01:00 UTC.',
  });
});

test('utcWhen keeps same-day times short and labels other days', () => {
  const now = at('2026-11-09T12:00:00Z');
  assert.equal(utcWhen(at('2026-11-09T14:05:00Z'), now), '14:05 UTC');
  assert.equal(utcWhen(at('2026-11-10T01:00:00Z'), now), 'Tue 01:00 UTC');
});
