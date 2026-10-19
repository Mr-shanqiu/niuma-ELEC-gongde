// Local adversarial acceptance only. No .env, database, COS, browser or SDK.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createServer, request as httpRequest } from 'node:http';
import { readFile, writeFile, mkdtemp } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';

process.env.GONGDE_CREATORS_ENABLED = 'false';
process.env.GONGDE_CREATOR_PAID_SALES_ENABLED = 'false';
process.env.GONGDE_CREATOR_SETTLEMENTS_ENABLED = 'false';
const compiled = new URL('../dist/creators/', import.meta.url);
const load = name => import(new URL(name + '.js', compiled).href);
const { validateCreatorSourcePack } = await load('pack-validation');
const { creatorWorkId, CreatorError } = await load('types');
const { createFreeCreatorRouter } = await load('router');
const require = createRequire(import.meta.url);
const { zipSync } = require('fflate');
const { deflateSync } = await import('node:zlib');
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const deadlineMs = 20000, rssBudgetBytes = 192 * 1024 * 1024;
const started = performance.now();
const timer = setTimeout(() => {
  process.stderr.write('LOCAL_SECURITY_DEADLINE_EXCEEDED\n');
  process.exit(124);
}, deadlineMs);
timer.unref();
const owned = { creatorId: 'a'.repeat(32), slug: 'local-security' };
const cases = [], results = [], bindings = [];
let openServers = 0, maxOpenServers = 0, loopbackRequests = 0;
for (const name of ['pack-validation', 'policy', 'types', 'router', 'client-key']) {
  const body = await readFile(new URL(name + '.js', compiled));
  bindings.push({ path: new URL(name + '.js', compiled).pathname, bytes: body.length, sha256: sha(body) });
}
const table = Uint32Array.from({ length: 256 }, (_, input) => {
  let value = input;
  for (let bit = 0; bit < 8; bit++) value = (value >>> 1) ^ ((value & 1) ? 0xedb88320 : 0);
  return value >>> 0;
});
function crc32(bytes) {
  let value = 0xffffffff;
  for (const byte of bytes) value = (value >>> 8) ^ table[(value ^ byte) & 255];
  return (value ^ 0xffffffff) >>> 0;
}
function chunk(type, bytes) {
  const out = Buffer.alloc(bytes.length + 12);
  out.writeUInt32BE(bytes.length, 0); out.write(type, 4, 4, 'ascii'); bytes.copy(out, 8);
  out.writeUInt32BE(crc32(out.subarray(4, out.length - 4)), out.length - 4);
  return out;
}
function pngParts(raw = Buffer.from([0, 31, 63, 127, 255]), corruptZlib = false) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(1, 0); ihdr.writeUInt32BE(1, 4); ihdr[8] = 8; ihdr[9] = 6;
  const data = deflateSync(raw);
  if (corruptZlib) data[data.length - 1] ^= 1;
  return [Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', ihdr), chunk('IDAT', data), chunk('IEND', Buffer.alloc(0))];
}
const validPng = Buffer.concat(pngParts());
function manifest(names) {
  return { id: creatorWorkId(owned.creatorId, owned.slug), version: '1.0.0',
    name_zh: 'Fictional local security fixture', name_en: 'Fictional local security fixture',
    author: 'fictional-local-security', publisher: 'community', review_id: 'pending',
    schema_version: 1, canvas_width: 240, canvas_height: 250, plus_y: 174, preview: names[0],
    layers: names.map(image => ({ image, frame: [0, 0, 1, 1], anchor: [0.5, 0.5],
      keyframes: [{ t: 0, x: 0, y: 0, rotation: 0, scale: 1, alpha: 1 }] })) };
}
function pack(images = { 'sprite.png': validPng }) {
  const files = { 'manifest.json': Buffer.from(JSON.stringify(manifest(Object.keys(images)))), ...images };
  return Buffer.from(zipSync(files, { level: 0, mtime: new Date('2020-01-01T00:00:00Z') }));
}
const validArchive = pack();
const validTwoImages = pack({ 'imagea.png': validPng, 'imageb.png': validPng });
function zipEntries(bytes) {
  const end = bytes.length - 22;
  assert.equal(bytes.readUInt32LE(end), 0x06054b50);
  const count = bytes.readUInt16LE(end + 10), entries = [];
  let offset = bytes.readUInt32LE(end + 16);
  for (let index = 0; index < count; index++) {
    assert.equal(bytes.readUInt32LE(offset), 0x02014b50);
    const nameBytes = bytes.readUInt16LE(offset + 28);
    const localOffset = bytes.readUInt32LE(offset + 42);
    entries.push({ centralOffset: offset, localOffset, nameBytes,
      name: bytes.toString('utf8', offset + 46, offset + 46 + nameBytes) });
    offset += 46 + nameBytes + bytes.readUInt16LE(offset + 30) + bytes.readUInt16LE(offset + 32);
  }
  assert.equal(offset, end);
  return entries;
}
function add(name, run) { cases.push({ name, run }); }
function rejectedArchive(name, make, expectedCode) {
  add(name, () => {
    const bytes = make(); let observed;
    assert.throws(() => validateCreatorSourcePack(bytes, owned), error => {
      observed = { code: error.code, status: error.status, name: error.name };
      assert.ok(error instanceof CreatorError);
      assert.equal(error.status, 422);
      assert.match(error.code, /^creator_/u);
      if (expectedCode) assert.equal(error.code, expectedCode);
      return true;
    });
    return { fixtureBytes: bytes.length, fixtureSha256: sha(bytes), observed };
  });
}
add('control: intact single-image archive is accepted', () => {
  const parsed = validateCreatorSourcePack(validArchive, owned);
  assert.equal(parsed.images.length, 1);
  assert.equal(parsed.decodedImageBytes, 4);
  assert.deepEqual(parsed.files.get('sprite.png'), validPng);
  return { fixtureSha256: sha(validArchive), images: 1 };
});
add('control: intact two-image archive is accepted before duplicate-name mutation', () => {
  assert.equal(validateCreatorSourcePack(validTwoImages, owned).images.length, 2);
  return { fixtureSha256: sha(validTwoImages), images: 2 };
});
rejectedArchive('PNG: truncated signature is rejected', () => pack({ 'sprite.png': validPng.subarray(0, 7) }));
rejectedArchive('PNG: IHDR CRC mutation is rejected', () => {
  const parts = pngParts(); parts[1][parts[1].length - 1] ^= 1;
  return pack({ 'sprite.png': Buffer.concat(parts) });
});
rejectedArchive('PNG: valid compression and CRC do not permit row filter 5',
  () => pack({ 'sprite.png': Buffer.concat(pngParts(Buffer.from([5, 31, 63, 127, 255]))) }),
  'creator_png_filter_invalid');
rejectedArchive('PNG: short decompressed row is rejected',
  () => pack({ 'sprite.png': Buffer.concat(pngParts(Buffer.from([0, 31, 63, 127]))) }));
rejectedArchive('PNG: excess decompressed row is rejected',
  () => pack({ 'sprite.png': Buffer.concat(pngParts(Buffer.from([0, 31, 63, 127, 255, 0]))) }));
rejectedArchive('PNG: invalid zlib checksum with valid chunk CRC is rejected',
  () => pack({ 'sprite.png': Buffer.concat(pngParts(undefined, true)) }));
rejectedArchive('PNG: IDAT before IHDR is rejected', () => {
  const parts = pngParts();
  return pack({ 'sprite.png': Buffer.concat([parts[0], parts[2], parts[1], parts[3]]) });
});
rejectedArchive('PNG: unknown critical chunk is rejected', () => {
  const parts = pngParts();
  return pack({ 'sprite.png': Buffer.concat([parts[0], parts[1], chunk('ABCD', Buffer.alloc(0)), parts[2], parts[3]]) });
});
rejectedArchive('ZIP: inconsistent EOCD entry counts are rejected', () => {
  const out = Buffer.from(validArchive), end = out.length - 22;
  out.writeUInt16LE(out.readUInt16LE(end + 10) + 1, end + 8); return out;
});
rejectedArchive('ZIP: central-directory offset outside the archive is rejected', () => {
  const out = Buffer.from(validArchive); out.writeUInt32LE(0x7fffffff, out.length - 22 + 16); return out;
});
rejectedArchive('ZIP: local filename differing from the central filename is rejected', () => {
  const out = Buffer.from(validArchive), item = zipEntries(out).find(entry => entry.name === 'manifest.json');
  Buffer.from('manifesz.json').copy(out, item.localOffset + 30); return out;
});
rejectedArchive('ZIP: conflicting local and central compression methods are rejected', () => {
  const out = Buffer.from(validArchive), item = zipEntries(out).find(entry => entry.name === 'sprite.png');
  assert.equal(out.readUInt16LE(item.centralOffset + 10), 0);
  out.writeUInt16LE(8, item.localOffset + 8); return out;
});
rejectedArchive('ZIP: duplicate canonical image names are rejected', () => {
  const out = Buffer.from(validTwoImages), item = zipEntries(out).find(entry => entry.name === 'imageb.png');
  assert.equal(item.nameBytes, Buffer.byteLength('imagea.png'));
  Buffer.from('imagea.png').copy(out, item.centralOffset + 46);
  Buffer.from('imagea.png').copy(out, item.localOffset + 30); return out;
});
const fakeBody = Buffer.from([80, 75, 3, 4, 0, 255, 128, 1]);
const client = '203.0.113.20';
const clientKey = address => sha(Buffer.from('gongde-creator-client-v1\0' + address));
async function app(options, run) {
  const calls = { limits: [], batch: [], publicWorks: [], account: 0, admin: 0 };
  const service = {
    repository: { async consumeLimit(...args) {
      calls.limits.push(args);
      if (options.rateError) throw new CreatorError('creator_rate_limited', 429);
    } },
    async freeBatch(payload, key) {
      calls.batch.push({ payload, key });
      return { body: fakeBody, fileName: 'local-fake.nmgpack', contentType: 'application/octet-stream' };
    },
    async publicWorks(offset) { calls.publicWorks.push(offset); return []; },
    async requireAccount() { calls.account++; throw new CreatorError('creator_auth_required', 401); }
  };
  const requireAdmin = () => { calls.admin++; throw new CreatorError('creator_admin_auth_required', 401); };
  let handler, origin;
  const server = createServer(async (req, res) => {
    try {
      if (!await handler(req, res, new URL(req.url, origin))) { res.writeHead(404); res.end(); }
    } catch { res.writeHead(500); res.end('local_harness_failure'); }
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  openServers++; maxOpenServers = Math.max(maxOpenServers, openServers);
  const port = server.address().port; origin = 'http://127.0.0.1:' + port;
  handler = createFreeCreatorRouter({ publicOrigin: origin, secureCookie: false,
    freeDownloadsEnabled: true,
    trustedProxyAddresses: options.trustedProxyAddresses ?? ['127.0.0.1'] }, service, requireAdmin);
  async function request({ originFields = [['Origin', origin]], proxyFields = [['X-Real-IP', client]],
    site = 'same-origin', method = 'POST' } = {}) {
    const body = JSON.stringify({ items: [{ workId: 'fixture', versionId: 'fixture', revision: 'fixture' }] });
    const headers = [['Host', '127.0.0.1:' + port], ...originFields, ['Sec-Fetch-Site', site],
      ['Content-Type', 'application/json'], ['Content-Length', String(Buffer.byteLength(body))], ...proxyFields].flat();
    loopbackRequests++;
    return await new Promise((resolve, reject) => {
      const req = httpRequest({ hostname: '127.0.0.1', port, path: '/api/gongde/community/batches',
        method, headers, agent: false }, res => {
        const buffers = []; let count = 0;
        res.on('data', bytes => { count += bytes.length; if (count > 65536) res.destroy(new Error('local_response_too_large')); else buffers.push(bytes); });
        res.once('error', reject);
        res.once('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(buffers) }));
      });
      req.once('error', reject); req.setTimeout(1500, () => req.destroy(new Error('local_request_timeout')));
      req.end(body);
    });
  }
  try { return await run({ request, calls, origin }); }
  finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); openServers--; }
}
function assertDenied(response, calls, status, code) {
  assert.equal(response.status, status);
  assert.equal(response.headers['cache-control'], 'no-store');
  const data = JSON.parse(response.body.toString('utf8'));
  assert.match(data.error, /^creator_/u);
  if (code) assert.equal(data.error, code);
  assert.equal(calls.limits.length + calls.batch.length + calls.publicWorks.length + calls.account + calls.admin, 0);
  return { status: response.status, code: data.error, businessCalls: 0 };
}
add('HTTP control: valid request still cannot bypass payment into the retired free delivery', () => app({}, async ({ request, calls }) => {
  const response = await request(); assert.equal(response.status, 503);
  assert.equal(response.headers['cache-control'], 'no-store');
  assert.deepEqual(JSON.parse(response.body.toString('utf8')), { error: 'creator_paid_checkout_unavailable' });
  assert.equal(calls.batch.length, 0);
  return { status: 503, retiredFreeDelivery: true };
}));
for (const [name, options, args, status, code] of [
  ['missing Origin', {}, () => ({ originFields: [] }), 403],
  ['duplicate equal Origin fields', {}, origin => ({ originFields: [['Origin', origin], ['Origin', origin]] }), 403],
  ['duplicate distinct Origin fields', {}, origin => ({ originFields: [['Origin', origin], ['oRiGiN', 'https://untrusted.invalid']] }), 403],
  ['null Origin', {}, () => ({ originFields: [['Origin', 'null']] }), 403],
  ['bad Origin before missing real-IP header', {}, () => ({ originFields: [['Origin', 'https://untrusted.invalid']], proxyFields: [] }), 403],
  ['bad Origin before duplicate real-IP fields', {}, () => ({ originFields: [['Origin', 'https://untrusted.invalid']], proxyFields: [['X-Real-IP', client], ['X-Real-IP', client]] }), 403],
  ['cross-site before missing real-IP header', {}, () => ({ site: 'cross-site', proxyFields: [] }), 403],
  ['unsupported method before Origin and proxy checks', {}, () => ({ method: 'DELETE', originFields: [], proxyFields: [] }), 405],
  ['missing real-IP header', {}, () => ({ proxyFields: [] }), 503, 'creator_proxy_client_invalid'],
  ['duplicate same-case real-IP fields', {}, () => ({ proxyFields: [['X-Real-IP', client], ['X-Real-IP', client]] }), 503, 'creator_proxy_client_invalid'],
  ['duplicate mixed-case real-IP fields', {}, () => ({ proxyFields: [['X-Real-IP', client], ['x-ReAl-Ip', client]] }), 503, 'creator_proxy_client_invalid'],
  ['untrusted TCP peer cannot self-assert proxy identity', { trustedProxyAddresses: ['192.0.2.10'] }, () => ({}), 403, 'creator_proxy_peer_untrusted']
]) {
  add('HTTP: ' + name + ' is rejected before business calls', () => app(options, async ({ request, calls, origin }) =>
    assertDenied(await request(args(origin)), calls, status, code)));
}
add('HTTP: direct mode ignores actual repeated and malformed proxy headers', () => app({ trustedProxyAddresses: [] }, async ({ request, calls }) => {
  const response = await request({ proxyFields: [['X-Real-IP', 'invalid'], ['x-real-ip', client], ['X-Forwarded-For', client]] });
  assert.equal(response.status, 503); assert.equal(calls.batch.length, 0);
  assert.deepEqual(JSON.parse(response.body.toString('utf8')), { error: 'creator_paid_checkout_unavailable' });
  assert.deepEqual(calls.limits, [['http', clientKey('127.0.0.1'), 600, 60]]);
  return { status: 503, actualLoopbackIdentityPreserved: true };
}));
add('HTTP: Origin rejection precedes a mock exhausted limiter; valid Origin retains Retry-After', () => app({ rateError: true }, async ({ request, calls }) => {
  const first = await request({ originFields: [['Origin', 'https://untrusted.invalid']] });
  const rejected = assertDenied(first, calls, 403);
  const second = await request();
  assert.equal(second.status, 429); assert.equal(second.headers['retry-after'], '60');
  assert.deepEqual(JSON.parse(second.body.toString('utf8')), { error: 'creator_rate_limited' });
  assert.equal(calls.limits.length, 1); assert.equal(calls.batch.length, 0);
  return { invalidOrigin: rejected, validOriginStatus: 429, retryAfter: '60', mockLimiterOnly: true };
}));
add('HTTP: distinct overwritten real IPs have distinct actual-router limit keys', () => app({}, async ({ request, calls }) => {
  assert.equal((await request()).status, 503);
  assert.equal((await request({ proxyFields: [['X-Real-IP', '203.0.113.21'], ['X-Forwarded-For', client]] })).status, 503);
  assert.equal(calls.batch.length, 0);
  assert.notEqual(calls.limits[0][1], calls.limits[1][1]);
  return { separateKeys: true, mockRepositoryOnly: true };
}));
let harnessFailure;
for (const entry of cases) {
  const caseStarted = performance.now();
  try {
    assert.ok(caseStarted - started < deadlineMs);
    const details = await entry.run();
    results.push({ name: entry.name, passed: true, elapsedMs: performance.now() - caseStarted, details });
  } catch (error) {
    results.push({ name: entry.name, passed: false, elapsedMs: performance.now() - caseStarted,
      error: { name: error.name, message: error.message, code: error.code, status: error.status } });
  }
  if (process.resourceUsage().maxRSS * 1024 > rssBudgetBytes) { harnessFailure = 'local_rss_budget_exceeded'; break; }
}
clearTimeout(timer);
const report = { schema: 'gongde-creator-adversarial-local-security.v1',
  at: new Date().toISOString(), classification: 'LOCAL_COMPILED_VALIDATOR_AND_LOOPBACK_HTTP_WITH_EXPLICIT_FAKES_NOT_PRODUCTION',
  scheduled: cases.length, total: results.length, passed: results.filter(row => row.passed).length,
  failed: results.filter(row => !row.passed).length, elapsedMs: performance.now() - started,
  bindings, results, harnessFailure, loopbackRequests, openServers, maxOpenServers,
  resources: { deadlineMs, rssBudgetBytes, maxRssBytes: process.resourceUsage().maxRSS * 1024,
    v8Arguments: process.execArgv, rssIsSampledNotOsHardCap: true },
  boundaries: { productionAccess: false, externalNetwork: false, databaseOrCosAccess: false,
    credentialsOrEnvFilesRead: false, originalSdkRebuiltOrRetransferred: false, browserUsed: false,
    productSourceChanged: false, freeDeliveryProductionEnabled: false, fakeDeliveryBytesNotNativePackEvidence: true,
    deployedModuleEquivalenceProven: false, goalComplete: false },
  unproved: ['current deployed Origin and limiter/proxy behavior', 'real DB rate quotas and concurrency',
    'production archive rejection and save atomicity', 'anonymous production archive/native delivery',
    'Mac browser first-install and F1 admission', 'Windows0.8.4 native acceptance', 'disclosed caller cache repair'] };
const output = process.env.GONGDE_LOCAL_SECURITY_RECEIPT ??
  join(await mkdtemp(join(tmpdir(), 'gongde-local-security-')), 'results.json');
const text = JSON.stringify(report, null, 2) + '\n';
await writeFile(output, text, { flag: 'wx', mode: 0o600 });
console.log(JSON.stringify({ receiptPath: output, receiptSha256: sha(Buffer.from(text)),
  scheduled: report.scheduled, passed: report.passed, failed: report.failed, elapsedMs: report.elapsedMs,
  openServers, maxOpenServers, harnessFailure, failedCases: results.filter(row => !row.passed), goalComplete: false }));
process.exitCode = report.failed || harnessFailure || report.total !== report.scheduled || openServers ? 1 : 0;
