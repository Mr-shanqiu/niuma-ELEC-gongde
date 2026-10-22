import assert from "node:assert/strict";
import test from "node:test";

/**
 * F5: one click, one navigation.
 *
 * `offerInstaller` starts a 1200ms timer and also navigates when the counting
 * request settles. Those two can arrive in either order, and a counting request
 * that fails still navigates. Without a latch the click assigned `location`
 * twice, which the review reproduced as two `location` assignments from one
 * click — a second request for the file and an extra history entry.
 *
 * The module is loaded with a stub `window`/`document`, and `location` is a
 * plain object so an assignment can be counted instead of navigating.
 */

const flush = () => new Promise((resolve) => setImmediate(resolve));

async function load() {
  const assignments = [];
  const counts = [];
  globalThis.window = { location: {}, setRequestScheduler() {} };
  globalThis.document = { body: { dataset: {} }, getElementById: () => null, querySelector: () => null, querySelectorAll: () => [] };
  globalThis.location = { set href(value) { assignments.push(value); }, get href() { return assignments.at(-1); } };
  globalThis.fetch = async (url) => { counts.push(url); return new Response(null, { status: 302 }); };
  const flow = await import('../free-flow.js');
  return { flow, assignments, counts };
}

/** A link whose click handler is the one `offerInstaller` installed. */
function link() {
  const listeners = [];
  return {
    href: '',
    addEventListener: (type, handler) => listeners.push({ type, handler }),
    click: (overrides = {}) => {
      const event = { metaKey: false, ctrlKey: false, shiftKey: false, button: 0, defaultPrevented: false, preventDefault() { this.defaultPrevented = true; }, ...overrides };
      for (const listener of listeners) if (listener.type === 'click') listener.handler(event);
      return event;
    }
  };
}

const URL_OK = 'https://download.gongde.zqscreen.cn/niuma-merit-macos-0.9.4-test.dmg';

test('F5: a resolved count navigates once and counts once', async () => {
  const { flow, assignments, counts } = await load();
  const anchor = link();
  flow.offerInstaller(anchor, URL_OK);
  assert.equal(anchor.href, '/api/gongde/downloads/niuma-merit-macos-0.9.4-test.dmg', 'the link itself goes through the counting redirect');
  anchor.click();
  await flush();
  assert.equal(counts.length, 1, 'exactly one counting request');
  assert.deepEqual(assignments, [URL_OK], 'exactly one navigation');
});

test('F5: a rejected count still navigates, and only once', async () => {
  const { flow, assignments, counts } = await load();
  globalThis.fetch = async (url) => { counts.push(url); throw new Error('network'); };
  const anchor = link();
  flow.offerInstaller(anchor, URL_OK);
  anchor.click();
  await flush();
  assert.equal(counts.length, 1);
  assert.deepEqual(assignments, [URL_OK]);
});

test('F5: the timeout navigates, and a late settle does not navigate again', async () => {
  const { flow, assignments } = await load();
  let settle;
  globalThis.fetch = () => new Promise((resolve, reject) => { settle = { resolve, reject }; });
  const anchor = link();
  flow.offerInstaller(anchor, URL_OK);
  anchor.click();

  // Let the 1200ms bound fire first: the visitor must not wait for a slow API.
  await new Promise((resolve) => setTimeout(resolve, 1300));
  assert.deepEqual(assignments, [URL_OK], 'the timer alone navigated');

  // The request settles afterwards; that must not navigate a second time.
  settle.resolve(new Response(null, { status: 302 }));
  await flush();
  assert.deepEqual(assignments, [URL_OK], 'a late success does not jump again');

  settle.reject(new Error('late failure'));
  await flush();
  assert.deepEqual(assignments, [URL_OK], 'a late failure does not jump again');
});

test('F5: a settle first is not followed by a second navigation from the timer', async () => {
  const { flow, assignments } = await load();
  const anchor = link();
  flow.offerInstaller(anchor, URL_OK);
  anchor.click();
  await flush();
  // Well past the 1200ms timer: it was cleared, and even if it ran it is latched.
  await new Promise((resolve) => setTimeout(resolve, 1300));
  assert.deepEqual(assignments, [URL_OK]);
});

test('F5: two clicks on the same link each navigate once, with one count each', async () => {
  const { flow, assignments, counts } = await load();
  const anchor = link();
  flow.offerInstaller(anchor, URL_OK);
  anchor.click();
  await flush();
  anchor.click();
  await flush();
  assert.equal(counts.length, 2, 'a second click is a second request, not a duplicate');
  assert.deepEqual(assignments, [URL_OK, URL_OK]);
});

test('F5: modified clicks keep the browser default and do not count', async () => {
  const { flow, assignments, counts } = await load();
  for (const modifier of ['metaKey', 'ctrlKey', 'shiftKey']) {
    const anchor = link();
    flow.offerInstaller(anchor, URL_OK);
    const event = anchor.click({ [modifier]: true });
    assert.equal(event.defaultPrevented, false, `${modifier} click must keep the default`);
    await flush();
  }
  const middle = link();
  flow.offerInstaller(middle, URL_OK);
  assert.equal(middle.click({ button: 1 }).defaultPrevented, false);
  await flush();
  assert.equal(counts.length, 0);
  assert.deepEqual(assignments, []);
});

test('F5: a URL whose name cannot be counted links straight to the file', async () => {
  const { flow, assignments, counts } = await load();
  const anchor = link();
  flow.offerInstaller(anchor, 'https://download.gongde.zqscreen.cn/');
  assert.equal(anchor.href, 'https://download.gongde.zqscreen.cn/');
  anchor.click();
  await flush();
  assert.equal(counts.length, 0, 'no counting request for an unnamed file');
  assert.deepEqual(assignments, [], 'the plain link is left to the browser');
});
