/**
 * Service-worker wiring: the badge boundary alarm must be scheduled when the
 * worker starts and rescheduled after it fires. No native host, no Chrome.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

let cases = 0;

function install() {
  const alarms = [];
  const listeners = { alarm: [], installed: [], startup: [], storage: [] };
  globalThis.chrome = {
    runtime: {
      lastError: undefined,
      onInstalled: { addListener: (fn) => listeners.installed.push(fn) },
      onStartup: { addListener: (fn) => listeners.startup.push(fn) },
      sendNativeMessage(_host, _request, callback) {
        callback({ ok: true, running: true, starting: false, port: 3080, pid: 1 });
      },
    },
    alarms: {
      async create(name, info) {
        alarms.push({ name, ...info });
      },
      onAlarm: { addListener: (fn) => listeners.alarm.push(fn) },
    },
    storage: {
      local: {
        async get(key) {
          return { [key]: { running: true } };
        },
        async set() {},
      },
      onChanged: { addListener: (fn) => listeners.storage.push(fn) },
    },
    action: {
      async setBadgeBackgroundColor() {},
      async setBadgeText() {},
      async setTitle() {},
    },
  };
  return { alarms, listeners };
}

async function load() {
  await import(`../extension/background.js?case=${++cases}`);
}

test('startup schedules one alarm at the next peak boundary', async () => {
  const { alarms, listeners } = install();
  await load();
  alarms.length = 0; // ignore the scheduling done by the worker wake itself
  listeners.startup[0]();
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(alarms.length, 1);
  assert.equal(alarms[0].name, 'peak-boundary');
  assert.ok(alarms[0].when > Date.now(), 'the alarm is in the future');
  delete globalThis.chrome;
});

test('the boundary alarm refreshes the badge and schedules the next one', async () => {
  const { alarms, listeners } = install();
  await load();
  alarms.length = 0;
  listeners.alarm[0]({ name: 'peak-boundary' });
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(alarms.length, 1);
  assert.equal(alarms[0].name, 'peak-boundary');
  assert.ok(alarms[0].when > Date.now());
  delete globalThis.chrome;
});
