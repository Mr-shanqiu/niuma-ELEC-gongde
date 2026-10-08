import { tmpdir } from 'node:os';
import { join } from 'node:path';
// NOT_ACTUAL_BROWSER: actual community-preview.js, stub DOM/fetch/bitmap only.
// Run with --expose-gc --max-old-space-size=64. No .env, SDK, or network requests.
import assert from 'node:assert/strict';
import { writeFileSync, mkdtempSync } from 'node:fs';
import { createRequire, syncBuiltinESMExports } from 'node:module';
import { createHash } from 'node:crypto';
import { inflateSync } from 'node:zlib';
import { performance } from 'node:perf_hooks';
import net from 'node:net';
import tls from 'node:tls';
import http from 'node:http';
import https from 'node:https';
import dgram from 'node:dgram';
import childProcess from 'node:child_process';

const HERE = mkdtempSync(join(tmpdir(), 'gongde-creator-local-')) + '/';
const MiB = 1024 * 1024;
const DEADLINE_MS = 30000;
const RSS_BUDGET = 224 * MiB;
const started = performance.now();
let networkAttempts = 0, active;
const forbidden = () => { networkAttempts += 1; throw new Error('offline_preview_network_forbidden'); };
net.connect = net.createConnection = net.Socket.prototype.connect = forbidden;
net.Server.prototype.listen = forbidden;
tls.connect = http.request = http.get = https.request = https.get = forbidden;
dgram.createSocket = dgram.Socket.prototype.send = dgram.Socket.prototype.bind = forbidden;
for (const name of ['exec', 'execFile', 'spawn', 'fork', 'execSync', 'execFileSync', 'spawnSync']) {
  childProcess[name] = () => { throw new Error('offline_preview_subprocess_forbidden'); };
}
syncBuiltinESMExports();
assert.equal(typeof globalThis.gc, 'function');
const timer = setTimeout(() => { process.stderr.write('OFFLINE_PREVIEW_DEADLINE_EXCEEDED\n'); process.exit(124); }, DEADLINE_MS);
timer.unref();
const require = createRequire(import.meta.url);
const { zlibSync } = require('fflate');
const CRC_TABLE = Uint32Array.from({ length: 256 }, (_, input) => {
  let value = input;
  for (let bit = 0; bit < 8; bit += 1) value = (value >>> 1) ^ ((value & 1) ? 0xedb88320 : 0);
  return value >>> 0;
});
function crc32(bytes) {
  let value = 0xffffffff;
  for (const byte of bytes) value = (value >>> 8) ^ CRC_TABLE[(value ^ byte) & 255];
  return (value ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const output = Buffer.alloc(data.length + 12);
  output.writeUInt32BE(data.length, 0); output.write(type, 4, 4, 'ascii'); data.copy(output, 8);
  output.writeUInt32BE(crc32(output.subarray(4, output.length - 4)), output.length - 4);
  return output;
}
const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(1, 0); ihdr.writeUInt32BE(1, 4); ihdr[8] = 8; ihdr[9] = 6;
const rgba = Buffer.from([0, 60, 90, 120, 255]);
const parts = [signature, chunk('IHDR', ihdr), chunk('IDAT', Buffer.from(zlibSync(rgba))), chunk('IEND', Buffer.alloc(0))];
function paddedPng(size) {
  const output = Buffer.alloc(size);
  const extra = size - parts.reduce((sum, part) => sum + part.length, 0);
  assert.ok(extra >= 12);
  let offset = 0;
  for (const part of parts.slice(0, 2)) { part.copy(output, offset); offset += part.length; }
  const length = extra - 12;
  output.writeUInt32BE(length, offset); output.write('npAd', offset + 4, 4, 'ascii');
  output.writeUInt32BE(crc32(output.subarray(offset + 4, offset + 8 + length)), offset + 8 + length);
  offset += extra;
  for (const part of parts.slice(2)) { part.copy(output, offset); offset += part.length; }
  assert.equal(offset, size);
  return output;
}
function assertValidPng(bytes) {
  assert.deepEqual(bytes.subarray(0, 8), signature);
  const types = [];
  let offset = 8;
  while (offset < bytes.length) {
    const length = bytes.readUInt32BE(offset), type = bytes.toString('ascii', offset + 4, offset + 8);
    assert.ok(offset + length + 12 <= bytes.length);
    assert.equal(crc32(bytes.subarray(offset + 4, offset + 8 + length)), bytes.readUInt32BE(offset + 8 + length));
    types.push(type);
    if (type === 'IDAT') assert.deepEqual(inflateSync(bytes.subarray(offset + 8, offset + 8 + length), { maxOutputLength: 5 }), rgba);
    offset += length + 12;
  }
  assert.deepEqual(types, ['IHDR', 'npAd', 'IDAT', 'IEND']);
  assert.equal(offset, bytes.length);
}
const imagePath = '/api/gongde/community/versions/' + 'b'.repeat(32) + '/images/sprite.png';
const specification = {
  manifest: { canvas_width: 240, canvas_height: 170, layers: [{ image: 'sprite.png', frame: [0, 0, 1, 1], anchor: [0.5, 0.5],
    keyframes: [{ t: 0, x: 0, y: 0, rotation: 0, scale: 1, alpha: 1 }] }] },
  images: { 'sprite.png': imagePath }
};
const noOp = () => {};
const trace = (operation, args) => { active.transforms?.push({ operation, args }); };
const context = { setTransform: noOp, clearRect: noOp, save: noOp,
  translate(...args) { trace('translate', args); }, scale(...args) { trace('scale', args); },
  rotate(...args) { trace('rotate', args); }, restore: noOp,
  drawImage(bitmap) { assert.equal(bitmap.fixture, true); active.drawCalls += 1; } };
const documentStub = {
  body: { dataset: { page: 'offline-budget-test' } }, hidden: false,
  createElement(tag) {
    assert.equal(tag, 'canvas'); active.canvasCalls += 1;
    return { width: 0, height: 0, setAttribute: noOp, getContext(kind) { assert.equal(kind, '2d'); return context; } };
  }
};
Object.defineProperty(globalThis, 'document', { configurable: true, value: documentStub });
Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { platform: 'OFFLINE-STUB' } });
Object.defineProperty(globalThis, 'devicePixelRatio', { configurable: true, value: 1 });
globalThis.window = globalThis; globalThis.parent = globalThis;
globalThis.location = { search: '', origin: 'https://offline.invalid' };
globalThis.matchMedia = () => ({ matches: true });
globalThis.requestAnimationFrame = () => { throw new Error('unexpected_animation_in_reduced_motion_stub'); };
globalThis.cancelAnimationFrame = noOp;
globalThis.addEventListener = noOp;
globalThis.fetch = async (path, options) => {
  assert.equal(path, imagePath, 'only the exact in-memory fixture URL is allowed');
  assert.deepEqual(options, { credentials: 'same-origin', cache: 'no-store' });
  assert.ok(active); active.fetchCalls += 1;
  return { ok: true, blob: async () => { active.blobCalls += 1; return active.blob; } };
};
globalThis.createImageBitmap = async blob => {
  assert.equal(blob, active.blob); active.bitmapCalls += 1;
  return { fixture: true, width: 1, height: 1, close() { active.closeCalls += 1; } };
};
// Directly execute the real current product module; no copied/transformed source.
const moduleUrl = new URL('../../../website/community-preview.js', import.meta.url);
const { mountCreatorPreview } = await import(moduleUrl.href);
const tests = [
  { name: 'valid 8MiB+1 PNG is accepted', bytes: 8 * MiB + 1, accepted: true },
  { name: 'valid 12MiB+1 PNG is rejected before bitmap creation', bytes: 12 * MiB + 1, accepted: false },
  { name: 'valid exact 12MiB PNG is accepted after the rejected load', bytes: 12 * MiB, accepted: true }
];
const results = [];
let harnessFailure;
for (const test of tests) {
  assert.ok(performance.now() - started < DEADLINE_MS);
  globalThis.gc();
  const bytes = paddedPng(test.bytes);
  assertValidPng(bytes);
  const path = HERE + 'preview-' + test.bytes + '.png';
  writeFileSync(path, bytes);
  active = { blob: new Blob([bytes], { type: 'image/png' }), fetchCalls: 0, blobCalls: 0,
    bitmapCalls: 0, canvasCalls: 0, drawCalls: 0, closeCalls: 0, mounted: false };
  assert.equal(active.blob.size, test.bytes);
  const container = { replaceChildren(canvas) { assert.equal(canvas.width, 240); assert.equal(canvas.height, 170); active.mounted = true; } };
  try {
    if (test.accepted) {
      const player = await mountCreatorPreview(container, specification);
      assert.equal(active.bitmapCalls, 1); assert.equal(active.canvasCalls, 1);
      assert.equal(active.drawCalls, 1); assert.equal(active.mounted, true);
      player.destroy(); player.destroy(); assert.equal(active.closeCalls, 1);
    } else {
      await assert.rejects(() => mountCreatorPreview(container, specification), error => error.message === 'creator_preview_invalid');
      assert.equal(active.bitmapCalls, 0); assert.equal(active.canvasCalls, 0); assert.equal(active.mounted, false);
    }
    assert.equal(active.fetchCalls, 1); assert.equal(active.blobCalls, 1);
    results.push({ name: test.name, passed: true, bytes: test.bytes, accepted: test.accepted,
      fixturePath: path, sha256: createHash('sha256').update(bytes).digest('hex'), counters: { ...active, blob: undefined } });
    console.log('PASS NOT_ACTUAL_BROWSER: ' + test.name);
  } catch (error) {
    results.push({ name: test.name, passed: false, bytes: test.bytes, accepted: test.accepted,
      fixturePath: path, message: error.message, code: error.code });
    console.log('FAIL NOT_ACTUAL_BROWSER: ' + JSON.stringify(results.at(-1)));
  }
  active = undefined;
  const maxRssBytes = process.resourceUsage().maxRSS * 1024;
  if (maxRssBytes > RSS_BUDGET) { harnessFailure = 'RSS sampling budget exceeded: ' + maxRssBytes; break; }
  await new Promise(resolve => setImmediate(resolve));
}
function tinyFixture() {
  active = { blob: new Blob([paddedPng(1024)], { type: 'image/png' }), fetchCalls: 0, blobCalls: 0,
    bitmapCalls: 0, canvasCalls: 0, drawCalls: 0, closeCalls: 0, mounted: false, transforms: [] };
  return { replaceChildren(canvas) { assert.equal(canvas.width, 240); assert.equal(canvas.height, 170); active.mounted = true; } };
}
function near(actual, expected) { assert.ok(Math.abs(actual - expected) < 1e-8, `${actual} != ${expected}`); }
const behaviorTests = [
  ...[
    { name: 'native 240x250 canvas fits without clipping', width: 240, height: 250, fit: 0.68, x: 38.4, y: 170 },
    { name: 'wide 480x170 canvas fits and is vertically centered', width: 480, height: 170, fit: 0.5, x: 0, y: 127.5 }
  ].map(test => ({ name: test.name, async run() {
    const container = tinyFixture();
    const input = { ...specification, manifest: { ...specification.manifest, canvas_width: test.width, canvas_height: test.height } };
    const player = await mountCreatorPreview(container, input);
    try {
      const translate = active.transforms.find(call => call.operation === 'translate').args;
      const scale = active.transforms.find(call => call.operation === 'scale').args;
      near(translate[0], test.x); near(translate[1], test.y);
      near(scale[0], test.fit); near(scale[1], -test.fit);
      assert.ok(translate[0] >= 0 && translate[0] + test.width * scale[0] <= 240 + 1e-8);
      assert.ok(translate[1] <= 170 && translate[1] - test.height * scale[0] >= -1e-8);
      assert.equal(active.drawCalls, 1); assert.equal(active.mounted, true);
    } finally { player.destroy(); }
    assert.equal(active.closeCalls, 1);
    return { width: test.width, height: test.height, fit: test.fit };
  } })),
  { name: 'invalid canvas dimensions reject before fetching or allocating bitmaps', async run() {
    for (const [width, height] of [[0, 170], [240, NaN], [Infinity, 170], [240, '170']]) {
      const container = tinyFixture();
      await assert.rejects(() => mountCreatorPreview(container, { ...specification,
        manifest: { ...specification.manifest, canvas_width: width, canvas_height: height } }),
      error => error.message === 'creator_preview_invalid');
      assert.equal(active.fetchCalls, 0); assert.equal(active.bitmapCalls, 0); assert.equal(active.canvasCalls, 0);
    }
    return { invalidDimensionCases: 4, networkRequests: 0 };
  } },
  { name: 'delayed first animation frame still plays the complete strike', async run() {
    const container = tinyFixture(), callbacks = new Map();
    let nextFrame = 1, player;
    globalThis.matchMedia = () => ({ matches: false });
    globalThis.requestAnimationFrame = callback => { const id = nextFrame++; callbacks.set(id, callback); return id; };
    globalThis.cancelAnimationFrame = id => { callbacks.delete(id); };
    function flush(now) {
      const entry = callbacks.entries().next().value;
      assert.ok(entry, 'an animation frame must remain scheduled');
      callbacks.delete(entry[0]); active.transforms.length = 0; entry[1](now);
    }
    const input = { ...specification, manifest: { ...specification.manifest,
      layers: [{ ...specification.manifest.layers[0], keyframes: [
        { t: 0, x: 0, y: 0, rotation: 0, scale: 1, alpha: 1 },
        { t: 0.5, x: 0, y: 5, rotation: 4, scale: 1, alpha: 1 },
        { t: 1, x: 0, y: 0, rotation: 0, scale: 1, alpha: 1 }
      ] }] } };
    try {
      player = await mountCreatorPreview(container, input);
      player.strike(); assert.equal(callbacks.size, 1);
      const delayedFirstFrame = performance.now() + 1000;
      flush(delayedFirstFrame);
      assert.equal(callbacks.size, 1, 'a delayed first frame must not skip the animation');
      near(active.transforms.find(call => call.operation === 'rotate').args[0], 0);
      flush(delayedFirstFrame + 110);
      assert.equal(callbacks.size, 1);
      near(active.transforms.find(call => call.operation === 'rotate').args[0], 4 * Math.PI / 180);
      const layerTranslation = active.transforms.filter(call => call.operation === 'translate')[1].args;
      near(layerTranslation[0], 0.5); near(layerTranslation[1], 5.5);
      flush(delayedFirstFrame + 221);
      assert.equal(callbacks.size, 0);
      near(active.transforms.find(call => call.operation === 'rotate').args[0], 0);
      assert.equal(active.drawCalls, 4);
    } finally {
      player?.destroy(); globalThis.matchMedia = () => ({ matches: true });
      globalThis.requestAnimationFrame = () => { throw new Error('unexpected_animation_in_reduced_motion_stub'); };
      globalThis.cancelAnimationFrame = noOp;
    }
    assert.equal(active.closeCalls, 1);
    return { firstFrameDelayMs: 1000, durationMs: 220, midpointPhase: 0.5 };
  } }
];
if (!harnessFailure) for (const test of behaviorTests) {
  assert.ok(performance.now() - started < DEADLINE_MS); globalThis.gc();
  try {
    const details = await test.run(); results.push({ name: test.name, passed: true, details });
    console.log('PASS NOT_ACTUAL_BROWSER: ' + test.name);
  } catch (error) {
    results.push({ name: test.name, passed: false, message: error.message, code: error.code });
    console.log('FAIL NOT_ACTUAL_BROWSER: ' + JSON.stringify(results.at(-1)));
  }
  active = undefined;
  if (process.resourceUsage().maxRSS * 1024 > RSS_BUDGET) { harnessFailure = 'RSS sampling budget exceeded'; break; }
  await new Promise(resolve => setImmediate(resolve));
}
clearTimeout(timer);
assert.equal(networkAttempts, 0);
assert.ok(performance.now() - started < DEADLINE_MS);
const passed = results.filter(result => result.passed).length;
const report = { evidence: 'NOT_ACTUAL_BROWSER', productModule: moduleUrl.href, actualProductModuleExecuted: true,
  total: results.length, scheduled: tests.length + behaviorTests.length, passed, failed: results.length - passed,
  elapsedMs: performance.now() - started, networkAttempts,
  resources: { singleProcess: true, deadlineMs: DEADLINE_MS, maxOldSpaceMiB: 64,
    sampledRssBudgetMiB: 224, maxRssBytes: process.resourceUsage().maxRSS * 1024 },
  harnessFailure, results,
  unproved: ['actual browser PNG decoding/rendering', 'real DOM/canvas/bitmap behavior', 'cookies/authentication',
    'HTTP/network/server integration', 'real browser space', 'DB/COS/native/production acceptance'] };
writeFileSync(HERE + 'preview-results.json', JSON.stringify(report, null, 2) + '\n');
console.log('OFFLINE_PREVIEW_RESULTS ' + JSON.stringify(report));
process.exitCode = report.failed || harnessFailure || results.length !== tests.length + behaviorTests.length ? 1 : 0;
