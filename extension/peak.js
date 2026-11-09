/**
 * DeepSeek API peak hours, from the official pricing page: 01:00-04:00 and
 * 06:00-10:00 UTC, Monday through Friday. All other hours, weekends included,
 * are off-peak and billed at the lower rate.
 *
 * Chinese public holidays are off-peak as well, but they need a yearly
 * calendar; a weekday window that falls on one is reported as peak, which is a
 * conservative false positive, never a missed warning.
 */
const MINUTE = 60 * 1000;
const DAY = 24 * 60 * MINUTE;

/** Start and end of each peak window, in minutes since 00:00 UTC. */
export const PEAK_WINDOWS = [
  [60, 240], // 01:00-04:00
  [360, 600], // 06:00-10:00
];

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

function isWeekend(now) {
  const day = now.getUTCDay();
  return day === 0 || day === 6;
}

function minutesOfDay(now) {
  return now.getUTCHours() * 60 + now.getUTCMinutes();
}

/** True while DeepSeek bills the peak rate. */
export function isPeak(now = new Date()) {
  if (isWeekend(now)) return false;
  const minutes = minutesOfDay(now);
  return PEAK_WINDOWS.some(([start, end]) => minutes >= start && minutes < end);
}

/**
 * The next UTC minute at which the peak state flips, or null if none is found.
 * The badge uses it to schedule a `chrome.alarms` wake-up at the boundary.
 */
export function nextPeakChange(now = new Date()) {
  const current = isPeak(now);
  const midnight = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  const candidates = [];
  // A weekend can sit between now and the next weekday window, so scan a full
  // week plus one day instead of only today's boundaries.
  for (let day = 0; day <= 8; day += 1) {
    for (const [start, end] of PEAK_WINDOWS) {
      candidates.push(midnight + day * DAY + start * MINUTE, midnight + day * DAY + end * MINUTE);
    }
  }
  candidates.sort((a, b) => a - b);
  for (const time of candidates) {
    if (time > now.getTime() && isPeak(new Date(time)) !== current) return new Date(time);
  }
  return null;
}

/** `HH:MM` in UTC, the timezone the schedule is defined in. */
export function utcTime(date) {
  const hours = String(date.getUTCHours()).padStart(2, '0');
  const minutes = String(date.getUTCMinutes()).padStart(2, '0');
  return `${hours}:${minutes}`;
}

/** `HH:MM UTC` today, or `Mon 01:00 UTC` for a later day. */
export function utcWhen(date, now = new Date()) {
  const time = `${utcTime(date)} UTC`;
  const sameDay =
    date.getUTCFullYear() === now.getUTCFullYear() &&
    date.getUTCMonth() === now.getUTCMonth() &&
    date.getUTCDate() === now.getUTCDate();
  return sameDay ? time : `${WEEKDAYS[date.getUTCDay()]} ${time}`;
}

/**
 * Badge and popup copy. The next change is an off-peak start while peak or a
 * peak start while off-peak, so the sentence names what will happen next.
 */
export function peakLabel(now = new Date()) {
  const peak = isPeak(now);
  const next = nextPeakChange(now);
  const until = next ? ` until ${utcWhen(next, now)}` : '';
  return {
    peak,
    text: peak
      ? `Peak hours: DeepSeek API rates are higher${until}.`
      : `Off-peak: DeepSeek API rates are lower${until}.`,
  };
}
