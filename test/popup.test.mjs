/**
 * Popup rendering tests with a stubbed DOM and `chrome.*`.
 *
 * popup.js is an ES module with top-level awaits, so every test imports a fresh
 * instance (cache-busted query) after installing fresh globals. No Chrome, no
 * native host: `sendNativeMessage` replies from a per-test table.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

let cases = 0;

function element(id) {
  return {
    id,
    value: '',
    textContent: '',
    className: '',
    hidden: false,
    disabled: false,
    children: [],
    listeners: {},
    focus() {},
    addEventListener(type, fn) {
      this.listeners[type] = fn;
    },
    replaceChildren() {
      this.children = [];
    },
    append(...kids) {
      this.children.push(...kids);
    },
  };
}

function install({ stored = {}, responses = {} } = {}) {
  const els = new Map();
  globalThis.document = {
    getElementById(id) {
      if (!els.has(id)) els.set(id, element(id));
      return els.get(id);
    },
    createElement: (tag) => ({ tag, textContent: '', hidden: false }),
  };
  const requests = [];
  globalThis.chrome = {
    runtime: {
      lastError: undefined,
      sendNativeMessage(_host, request, callback) {
        requests.push(request);
        callback(responses[request.type]?.(request) ?? { ok: true, running: false, starting: false });
      },
    },
    storage: {
      local: {
        async get(key) {
          return { [key]: stored[key] };
        },
        async set(values) {
          Object.assign(stored, values);
        },
      },
    },
    action: { async setBadgeBackgroundColor() {}, async setBadgeText() {} },
    tabs: {
      async query() {
        return [];
      },
      async create(tab) {
        globalThis.createdTab = tab;
      },
    },
  };
  return { els, requests, stored };
}

async function openPopup(options) {
  const fake = install(options);
  await import(`../extension/popup.js?case=${++cases}`);
  await new Promise((resolve) => setTimeout(resolve, 0));
  return fake;
}

test('an in-flight launch is described by its CLI version, not by a download', async () => {
  const { els } = await openPopup({
    stored: { state: { running: false, starting: true } },
    responses: {
      status: () => ({
        ok: true,
        running: false,
        starting: true,
        pid: 42,
        package: '@deepseek-ai/dsh@0.2.2-rc.1',
        logFile: '/tmp/x.log',
      }),
    },
  });
  const text = els.get('status').textContent;
  assert.match(text, /starting dsh@0\.2\.2-rc\.1/, `status said: ${text}`);
  assert.doesNotMatch(text, /download/i, 'a pinned version is cached, so no download is promised');
});

test('clicking start names the chosen version while the host works', async () => {
  let inflight = '';
  const { els, requests } = await openPopup({
    stored: { settings: { version: '0.1.7-rc.2' } },
    responses: {
      status: () => ({ ok: true, running: false, starting: false }),
      start: () => {
        inflight = els.get('status').textContent;
        return {
          ok: true,
          running: true,
          starting: false,
          state: 'ready',
          pid: 77,
          port: 8080,
          url: 'http://127.0.0.1:8080/?token=t',
          cleanUrl: 'http://127.0.0.1:8080/',
          package: '@deepseek-ai/dsh@0.1.7-rc.2',
          logFile: '/tmp/y.log',
          startedAt: 'now',
        };
      },
    },
  });

  assert.equal(els.get('version').value, '0.1.7-rc.2', 'the saved version is restored');
  await els.get('open').listeners.click();

  assert.match(inflight, /starting dsh@0\.1\.7-rc\.2/, `status said: ${inflight}`);
  assert.doesNotMatch(inflight, /download/i);
  assert.equal(requests.filter((request) => request.type === 'start')[0].version, '0.1.7-rc.2');
  assert.match(els.get('status').textContent, /running on port 8080/);
  assert.equal(globalThis.createdTab.url, 'http://127.0.0.1:8080/?token=t');
});
