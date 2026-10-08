import { tmpdir } from 'node:os';
import { join } from 'node:path';
// Retained local 12-case acceptance. Run with --expose-gc --max-old-space-size=64.
// No .env loading. All generated artifacts remain in the assigned temporary root.
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs';
import { createRequire, syncBuiltinESMExports } from 'node:module';
import { createHash } from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { performance } from 'node:perf_hooks';
import net from 'node:net';
import tls from 'node:tls';
import http from 'node:http';
import https from 'node:https';
import dgram from 'node:dgram';
import childProcess from 'node:child_process';
import zlib from 'node:zlib';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const HERE = mkdtempSync(join(tmpdir(), 'gongde-creator-local-')) + '/';
const MiB = 1024 * 1024;
const DEADLINE_MS = 30000;
const RSS_BUDGET = 224 * MiB;
const started = performance.now();
const metrics = { networkAttempts: 0, peakSampledRss: 0, peakHeapUsed: 0,
  pngInflates: 0, maxPngInflatedBytes: 0, sourceInflates: 0, gcBetweenInflates: true };
function sample() {
  const memory = process.memoryUsage();
  metrics.peakSampledRss = Math.max(metrics.peakSampledRss, memory.rss);
  metrics.peakHeapUsed = Math.max(metrics.peakHeapUsed, memory.heapUsed);
}
function deadline() {
  assert.ok(performance.now() - started < DEADLINE_MS, 'local 30-second deadline');
}
const timer = setTimeout(() => {
  process.stderr.write('BUDGET_TEST_DEADLINE_EXCEEDED\n');
  process.exit(124);
}, DEADLINE_MS);
timer.unref();
const forbidden = () => { metrics.networkAttempts += 1; throw new Error('local_budget_network_forbidden'); };
net.connect = net.createConnection = net.Socket.prototype.connect = forbidden;
net.Server.prototype.listen = forbidden;
tls.connect = http.request = http.get = https.request = https.get = forbidden;
dgram.createSocket = dgram.Socket.prototype.send = dgram.Socket.prototype.bind = forbidden;
globalThis.fetch = forbidden;
for (const name of ['exec', 'execFile', 'spawn', 'fork', 'execSync', 'execFileSync', 'spawnSync']) {
  childProcess[name] = () => { throw new Error('local_budget_subprocess_forbidden'); };
}
assert.equal(typeof globalThis.gc, 'function', '--expose-gc is required for serial bounded decoding');
// Instrument only allocation lifetime/counters. Both original decoders and all
// original validator arguments, results, errors and thresholds remain unchanged.
for (const name of ['inflateSync', 'inflateRawSync']) {
  const real = zlib[name];
  zlib[name] = function (...args) {
    globalThis.gc();
    const result = Reflect.apply(real, zlib, args);
    if (name === 'inflateSync') {
      metrics.pngInflates += 1;
      metrics.maxPngInflatedBytes = Math.max(metrics.maxPngInflatedBytes, result.length);
    } else metrics.sourceInflates += 1;
    sample();
    return result;
  };
}
syncBuiltinESMExports();
const require = createRequire(import.meta.url);
const { zipSync, unzipSync, zlibSync } = require(ROOT + '/node_modules/fflate');
const load = name => import(new URL('../dist/creators/' + name + '.js', import.meta.url).href);
const { validateCreatorSourcePack } = await load('pack-validation');
const { CREATOR_UPLOAD_LIMITS: limits, MARKET_BATCH_BYTES } = await load('policy');
const { creatorWorkId } = await load('types');
const { CreatorSourceStore } = await load('object-store');
const { FreeCreatorService } = await load('free-service');
assert.equal(limits.archiveBytes, 8 * MiB);
assert.equal(limits.unpackedBytes, 12 * MiB);
assert.equal(limits.decodedImageBytes, 64 * MiB);
assert.equal(MARKET_BATCH_BYTES, 16 * MiB);

const CRC_TABLE = Uint32Array.from({ length: 256 }, (_, input) => {
  let value = input;
  for (let bit = 0; bit < 8; bit += 1) value = (value >>> 1) ^ ((value & 1) ? 0xedb88320 : 0);
  return value >>> 0;
});
function crc32(bytes) {
  let crc = 0xffffffff;
  for (let i = 0; i < bytes.length; i += 1) crc = (crc >>> 8) ^ CRC_TABLE[(crc ^ bytes[i]) & 255];
  return (crc ^ 0xffffffff) >>> 0;
}
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
function pngChunk(type, bytes) {
  const result = Buffer.alloc(bytes.length + 12);
  result.writeUInt32BE(bytes.length, 0);
  result.write(type, 4, 4, 'ascii');
  bytes.copy(result, 8);
  result.writeUInt32BE(crc32(result.subarray(4, result.length - 4)), result.length - 4);
  return result;
}
function pngPieces(width, height) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; ihdr[9] = 6;
  // Valid RGBA, transparent pixels, filter 0 on every row. One raw buffer only.
  const raw = Buffer.alloc((width * 4 + 1) * height);
  const idat = Buffer.from(zlibSync(raw, { level: 6 }));
  return [Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), pngChunk('IHDR', ihdr), pngChunk('IDAT', idat), pngChunk('IEND', Buffer.alloc(0))];
}
const smallPieces = pngPieces(1, 1);
const smallPng = Buffer.concat(smallPieces);
function paddedPng(totalBytes) {
  const baseBytes = smallPieces.reduce((sum, piece) => sum + piece.length, 0);
  const extraBytes = totalBytes - baseBytes;
  assert.ok(extraBytes >= 12, 'fixture needs space for one complete ancillary chunk');
  const body = Buffer.alloc(totalBytes);
  let cursor = 0;
  for (const piece of smallPieces.slice(0, 2)) { piece.copy(body, cursor); cursor += piece.length; }
  // npAd is a valid private ancillary chunk: lowercase/lowercase/uppercase/lowercase.
  // Its arbitrary binary payload is real PNG data, never ZIP trailing padding.
  const dataBytes = extraBytes - 12;
  body.writeUInt32BE(dataBytes, cursor);
  body.write('npAd', cursor + 4, 4, 'ascii');
  body.writeUInt32BE(crc32(body.subarray(cursor + 4, cursor + 8 + dataBytes)), cursor + 8 + dataBytes);
  cursor += extraBytes;
  for (const piece of smallPieces.slice(2)) { piece.copy(body, cursor); cursor += piece.length; }
  assert.equal(cursor, totalBytes);
  sample();
  return body;
}
const owner = slug => ({ creatorId: 'a'.repeat(32), slug });
function manifest(owned, names = ['sprite.png']) {
  return { id: creatorWorkId(owned.creatorId, owned.slug), version: '1.0.0',
    name_zh: 'Fictional byte-budget fixture', name_en: 'Fictional byte-budget fixture', author: 'fictional-local-budget',
    publisher: 'community', review_id: 'pending', canvas_width: 240, canvas_height: 250,
    preview: names[0], plus_y: 174, schema_version: 1,
    layers: names.map(image => ({ image, frame: [0, 0, 1, 1], anchor: [0.5, 0.5],
      keyframes: [{ t: 0, x: 0, y: 0, rotation: 0, scale: 1, alpha: 1 }] })) };
}
function zip(files, level = 6) {
  const bytes = zipSync(files, { level, mtime: new Date('2020-01-01T00:00:00Z') });
  sample();
  return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}
function filesFor(owned, image) {
  return { 'manifest.json': Buffer.from(JSON.stringify(manifest(owned))), 'sprite.png': image };
}
const unpackedSize = files => Object.values(files).reduce((sum, bytes) => sum + bytes.length, 0);
const storedSize = files => 22 + Object.entries(files).reduce((sum, [name, bytes]) => sum + 76 + 2 * Buffer.byteLength(name) + bytes.length, 0);
function archiveAt(targetBytes, slug) {
  const owned = owner(slug), baseline = filesFor(owned, smallPng);
  const zipOverhead = storedSize(baseline) - unpackedSize(baseline);
  const image = paddedPng(targetBytes - zipOverhead - baseline['manifest.json'].length);
  const files = filesFor(owned, image), archive = zip(files, 0);
  assert.equal(archive.length, targetBytes);
  return { owned, files, archive };
}
function unpackedAt(targetBytes, slug) {
  const owned = owner(slug), manifestBytes = Buffer.from(JSON.stringify(manifest(owned)));
  const files = { 'manifest.json': manifestBytes, 'sprite.png': paddedPng(targetBytes - manifestBytes.length) };
  assert.equal(unpackedSize(files), targetBytes);
  return { owned, files, archive: zip(files) };
}
const artifacts = [];
function saveFixture(name, fixture, extra = {}) {
  const path = HERE + name + '.nmgpack';
  writeFileSync(path, fixture.archive);
  const receipt = { name, path, archiveBytes: fixture.archive.length, unpackedBytes: unpackedSize(fixture.files),
    sha256: sha(fixture.archive), ...extra };
  artifacts.push(receipt);
  return receipt;
}
function rejected(run, code, status = 422) {
  assert.throws(run, error => error?.code === code && error?.status === status);
}

// This fake supplies local bytes to the actual object-store streams. It never
// constructs a COS client, issues an SDK request, or claims durable cloud data.
class MemoryCos {
  bodies = new Map();
  reads = [];
  writes = 0;
  getBucketAcl(_parameters, callback) {
    callback(null, { ACL: 'private', Owner: { ID: 'fictional-local-owner' },
      Grants: [{ Grantee: { ID: 'fictional-local-owner' }, Permission: 'FULL_CONTROL' }] });
  }
  getBucketPolicy(_parameters, callback) { callback({ code: 'NoSuchBucketPolicy' }); }
  putObject(parameters, callback) {
    assert.equal(parameters.ACL, 'private');
    assert.equal(parameters.ContentLength, parameters.Body.length);
    this.bodies.set(parameters.Key, parameters.Body);
    this.writes += 1;
    callback(null, {});
  }
  getObject(parameters, callback) {
    this.reads.push(parameters.Key);
    const body = this.bodies.get(parameters.Key);
    if (!body) { callback(new Error('local_fixture_object_missing')); return; }
    parameters.Output.on('error', () => {});
    void (async () => {
      for (let offset = 0; offset < body.length; offset += 64 * 1024) {
        await new Promise((resolve, reject) => parameters.Output.write(body.subarray(offset, offset + 64 * 1024), error => error ? reject(error) : resolve()));
      }
      await new Promise(resolve => parameters.Output.end(resolve));
      callback(null, {});
    })().catch(callback);
  }
}
function localService() {
  const cos = new MemoryCos(), versions = new Map(), works = new Map();
  const account = { creatorId: 'a'.repeat(32), username: 'fictional_budget', displayName: 'Fictional local budget', state: 'ACTIVE' };
  const repository = {
    consumeLimit: async () => {},
    ownedWork: async (creatorId, workId) => { assert.equal(creatorId, account.creatorId); assert.ok(works.has(workId)); return works.get(workId); },
    versions: async (_creatorId, workId) => [...versions.values()].filter(version => version.workId === workId),
    saveVersion: async (_creatorId, version) => { versions.set(version.versionId, version); },
    getVersion: async versionId => { assert.ok(versions.has(versionId)); return versions.get(versionId); },
    published: async (workId, versionId) => {
      const version = versions.get(versionId), work = works.get(workId);
      assert.ok(version && work && version.state === 'APPROVED' && work.state === 'PUBLISHED');
      return { version, work };
    },
    approvedReviewId: async () => 'c'.repeat(32)
  };
  const objects = new CreatorSourceStore({ bucket: 'fictional-local-budget', region: 'offline',
    secretId: 'FICTIONAL-NOT-A-CREDENTIAL', secretKey: 'FICTIONAL-NOT-A-CREDENTIAL' }, cos);
  return { service: new FreeCreatorService(repository, objects), cos, account, versions, works };
}
async function uploadImage(context, slug, imageBytes, fixtureName) {
  const owned = owner(slug), workId = creatorWorkId(owned.creatorId, owned.slug);
  context.works.set(workId, { workId, creatorId: owned.creatorId, slug: owned.slug, state: 'DRAFT',
    metadata: { titleZh: 'Fictional local fixture', description: 'Only an explicit local fake publication.',
      tags: [], priceFen: 0, sharingTermsVersion: 'creator-free-sharing-v1' } });
  const files = filesFor(owned, paddedPng(imageBytes)), archive = zip(files);
  assert.ok(archive.length <= limits.archiveBytes);
  const fixture = { owned, files, archive };
  const receipt = fixtureName ? saveFixture(fixtureName, fixture, { imageBytes }) : undefined;
  const preview = await context.service.upload(context.account, workId, archive);
  const version = context.versions.get(preview.versionId);
  assert.ok(version, 'actual service persisted into the explicit in-memory repository');
  assert.equal(version.validation.unpackedBytes, unpackedSize(files));
  assert.equal(version.validation.decodedImageBytes, 4);
  assert.equal(version.archiveSha256, sha(archive));
  // Simulated publication is fake-only. No DB or real moderation is performed.
  version.state = 'APPROVED'; version.approvedMetadata = context.works.get(workId).metadata;
  context.works.get(workId).state = 'PUBLISHED';
  return { version, receipt, imageSha256: sha(files['sprite.png']), imageBytes };
}
const selection = item => ({ workId: item.version.workId, versionId: item.version.versionId, revision: item.version.revision });
const cases = [];
const add = (group, name, run) => cases.push({ group, name, run });

add('archive-8MiB', 'valid stored ZIP exactly 8MiB is accepted', () => {
  const fixture = archiveAt(limits.archiveBytes, 'archive-at');
  const pack = validateCreatorSourcePack(fixture.archive, fixture.owned);
  assert.equal(pack.archiveBytes, limits.archiveBytes);
  assert.equal(pack.unpackedBytes, unpackedSize(fixture.files));
  assert.equal(pack.decodedImageBytes, 4);
  assert.deepEqual(pack.images, [{ name: 'sprite.png', width: 1, height: 1 }]);
  saveFixture('archive-at', fixture, { decodedImageBytes: pack.decodedImageBytes });
});
add('archive-8MiB', 'structurally valid stored ZIP exactly 8MiB+1 is rejected only by archive budget', () => {
  const fixture = archiveAt(limits.archiveBytes + 1, 'archive-over');
  rejected(() => validateCreatorSourcePack(fixture.archive, fixture.owned), 'creator_archive_size_invalid');
  const repacked = zip(fixture.files);
  const legal = validateCreatorSourcePack(repacked, fixture.owned);
  assert.equal(legal.unpackedBytes, unpackedSize(fixture.files));
  assert.equal(legal.files.get('sprite.png').length, fixture.files['sprite.png'].length);
  assert.equal(sha(legal.files.get('sprite.png')), sha(fixture.files['sprite.png']));
  saveFixture('archive-over', fixture, { samePayloadDeflatedAccepted: true });
});
add('unpacked-12MiB', 'valid deflated ZIP exactly 12MiB unpacked is accepted', () => {
  const fixture = unpackedAt(limits.unpackedBytes, 'unpacked-at');
  assert.ok(fixture.archive.length < limits.archiveBytes);
  const pack = validateCreatorSourcePack(fixture.archive, fixture.owned);
  assert.equal(pack.unpackedBytes, limits.unpackedBytes);
  assert.equal(pack.files.get('sprite.png').length, fixture.files['sprite.png'].length);
  assert.equal(pack.decodedImageBytes, 4);
  saveFixture('unpacked-at', fixture, { decodedImageBytes: pack.decodedImageBytes });
});
add('unpacked-12MiB', 'valid PNG payload exactly 12MiB+1 unpacked is rejected', () => {
  const fixture = unpackedAt(limits.unpackedBytes + 1, 'unpacked-over');
  assert.ok(fixture.archive.length < limits.archiveBytes);
  rejected(() => validateCreatorSourcePack(fixture.archive, fixture.owned), 'creator_zip_unpacked_size_exceeded');
  saveFixture('unpacked-over', fixture);
});
let encodedLargePng;
function decodedFixture(over) {
  encodedLargePng ??= Buffer.concat(pngPieces(2048, 2048));
  globalThis.gc();
  const owned = owner(over ? 'decoded-over' : 'decoded-at');
  const names = ['large1.png', 'large2.png', 'large3.png', 'large4.png', ...(over ? ['tiny.png'] : [])];
  const files = { 'manifest.json': Buffer.from(JSON.stringify(manifest(owned, names))) };
  for (const name of names) files[name] = name === 'tiny.png' ? smallPng : encodedLargePng;
  return { owned, files, archive: zip(files) };
}
add('decoded-64MiB', 'four real 2048x2048 PNGs total exactly 64MiB decoded and are accepted', () => {
  const fixture = decodedFixture(false);
  const pack = validateCreatorSourcePack(fixture.archive, fixture.owned);
  assert.equal(pack.images.length, 4);
  assert.ok(pack.images.every(image => image.width === 2048 && image.height === 2048));
  assert.equal(pack.decodedImageBytes, limits.decodedImageBytes);
  saveFixture('decoded-at', fixture, { decodedImageBytes: pack.decodedImageBytes });
});
add('decoded-64MiB', 'four large PNGs plus a real 1x1 PNG exceed decoded budget by the minimum 4 bytes', () => {
  const fixture = decodedFixture(true);
  assert.ok(fixture.archive.length < limits.archiveBytes && unpackedSize(fixture.files) < limits.unpackedBytes);
  rejected(() => validateCreatorSourcePack(fixture.archive, fixture.owned), 'creator_image_memory_budget_exceeded');
  saveFixture('decoded-over', fixture, { decodedImageBytes: 64 * MiB + 4, smallestLegalOverageBytes: 4 });
});

add('cross-layer', 'legal 8MiB PNG uploads and previews succeed while free delivery stays disabled', async () => {
  const context = localService(), item = await uploadImage(context, 'image-at', 8 * MiB);
  const body = await context.service.image(item.version.versionId, 'sprite.png', { audience: 'creator', creatorId: context.account.creatorId });
  assert.equal(body.length, 8 * MiB);
  assert.equal(sha(body), item.imageSha256);
  await assert.rejects(() => context.service.freeBatch({ items: [selection(item)] }, 'fictional-local-client'),
    { code: 'creator_free_delivery_retired', status: 410 });
});
let previewOverContext, previewOverItem;
const reproduction = {};
add('cross-layer', 'legal 8MiB+1 PNG uploads through the actual service/object-store with explicit local fakes', async () => {
  previewOverContext = localService();
  previewOverItem = await uploadImage(previewOverContext, 'image-over', 8 * MiB + 1, 'preview-over-uploadable');
  Object.assign(reproduction, previewOverItem.receipt, { expectedPreviewBytes: 8 * MiB + 1,
    uploadAccepted: true, persistedVersionState: 'fake-only APPROVED', expected: 'legal uploaded image remains readable' });
  assert.ok(previewOverItem.version.validation.unpackedBytes < limits.unpackedBytes);
  assert.ok(previewOverItem.receipt.archiveBytes < limits.archiveBytes);
});
add('cross-layer', 'CONTRACT: every legal uploaded preview must be readable, including 8MiB+1 PNG', async () => {
  assert.ok(previewOverItem && previewOverContext);
  await assert.doesNotReject(async () => {
    const body = await previewOverContext.service.image(previewOverItem.version.versionId, 'sprite.png',
      { audience: 'creator', creatorId: previewOverContext.account.creatorId });
    assert.equal(body.length, previewOverItem.imageBytes);
    assert.equal(sha(body), previewOverItem.imageSha256);
  }, 'actual validator-accepted/uploaded PNG must not be rejected by a lower preview byte cap');
});
add('cross-layer', 'free delivery rejects the same legal 8MiB+1 image without reading source objects', async () => {
  const readsBefore = previewOverContext.cos.reads.length;
  await assert.rejects(() => previewOverContext.service.freeBatch({ items: [selection(previewOverItem)] }, 'fictional-local-client'),
    { code: 'creator_free_delivery_retired', status: 410 });
  assert.equal(previewOverContext.cos.reads.length, readsBefore);
  reproduction.singletonDeliveryAccepted = false;
  previewOverItem = previewOverContext = undefined;
});
add('cross-layer', 'multiple legal community sources cannot use the retired free batch channel', async () => {
  const context = localService();
  const first = await uploadImage(context, 'batch-small-a', 7 * MiB);
  globalThis.gc();
  const second = await uploadImage(context, 'batch-small-b', 7 * MiB);
  await assert.rejects(() => context.service.freeBatch({ items: [selection(first), selection(second)] }, 'fictional-local-client'),
    { code: 'creator_free_delivery_retired', status: 410 });
});
add('cross-layer', 'two legal 8MiB images exceed 16MiB after metadata/envelope and fail preflight', async () => {
  const context = localService();
  const first = await uploadImage(context, 'batch-large-a', 8 * MiB);
  globalThis.gc();
  const second = await uploadImage(context, 'batch-large-b', 8 * MiB);
  const readsBefore = context.cos.reads.length;
  await assert.rejects(() => context.service.freeBatch({ items: [selection(first), selection(second)] }, 'fictional-local-client'),
    { code: 'creator_free_delivery_retired', status: 410 });
  assert.equal(context.cos.reads.length, readsBefore, 'reject conservative aggregate budget before source reads');
});

const results = [], counts = {};
let harnessFailure;
for (const test of cases) {
  deadline(); globalThis.gc();
  counts[test.group] ??= { passed: 0, failed: 0 };
  const testStarted = performance.now();
  try {
    await test.run();
    counts[test.group].passed += 1;
    results.push({ group: test.group, name: test.name, passed: true, elapsedMs: performance.now() - testStarted });
    console.log('PASS ' + test.group + ': ' + test.name);
  } catch (error) {
    counts[test.group].failed += 1;
    const observed = error.actual ?? error;
    const result = { group: test.group, name: test.name, passed: false,
      code: observed.code, status: observed.status, message: error.message, elapsedMs: performance.now() - testStarted };
    results.push(result);
    if (test.name.startsWith('CONTRACT:')) Object.assign(reproduction, { previewAccepted: false, observedCode: observed.code, observedStatus: observed.status });
    console.log('FAIL ' + JSON.stringify(result));
  }
  sample();
  const maxRss = process.resourceUsage().maxRSS * 1024;
  if (maxRss > RSS_BUDGET || metrics.peakSampledRss > RSS_BUDGET) {
    harnessFailure = 'RSS budget exceeded: ' + maxRss + ' bytes > ' + RSS_BUDGET;
    break;
  }
  await new Promise(resolve => setImmediate(resolve));
}
clearTimeout(timer);
deadline();
assert.equal(metrics.networkAttempts, 0);
const passed = results.filter(result => result.passed).length;
const failed = results.length - passed;
const report = { total: results.length, scheduled: cases.length, passed, failed, groups: counts,
  elapsedMs: performance.now() - started, limits: { singleProcess: true, deadlineMs: DEADLINE_MS,
    maxOldSpaceMiB: 64, sampledRssBudgetMiB: 224, maxRssBytes: process.resourceUsage().maxRSS * 1024,
    note: 'V8 heap is a CLI hard cap; RSS is sampled/checked, not an OS hard cap' }, metrics,
  harnessFailure, reproduction, artifacts, results,
  evidence: 'current dist validator, service and object-store previews; free delivery rejects before reads; explicit memory COS/repository only',
  unproved: ['real DB/transactions/DDL/authentication/approval', 'real COS ACL/policy/storage/durability',
    'browser rendering', 'native import acceptance', 'production/deployment', 'exact 16MiB envelope acceptance cutoff'] };
writeFileSync(HERE + 'results.json', JSON.stringify(report, null, 2) + '\n');
console.log('BUDGET_RESULTS ' + JSON.stringify(report));
process.exitCode = failed || harnessFailure || results.length !== cases.length ? 1 : 0;
