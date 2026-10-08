import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

// Explicit fake requests and services only: no runtime, SQL, COS or credentials.
process.env.GONGDE_CREATORS_ENABLED = 'false';
process.env.GONGDE_CREATOR_PAID_SALES_ENABLED = 'false';
process.env.GONGDE_CREATOR_SETTLEMENTS_ENABLED = 'false';
const base = new URL('../dist/creators/', import.meta.url);
const load = name => import(new URL(name + '.js', base).href);
const { creatorClientKey, parseCreatorTrustedProxies } = await load('client-key');
const { CreatorError } = await load('types');
const { createFreeCreatorRouter } = await load('router');

const proxy = '192.0.2.10';
const client = '203.0.113.20';
const proxies = parseCreatorTrustedProxies(proxy);
const expectedKey = address => createHash('sha256')
  .update(`gongde-creator-client-v1\0${address}`).digest('hex');
function request(peer, headers = {}, rawHeaders) {
  return {
    method: 'GET', socket: { remoteAddress: peer }, headers,
    rawHeaders: rawHeaders ?? Object.entries(headers).flatMap(([name, value]) =>
      (Array.isArray(value) ? value : [value]).flatMap(item => [name, item]))
  };
}
function rejection(error, code, status) {
  assert.ok(error instanceof CreatorError);
  assert.equal(error.name, 'CreatorError');
  assert.equal(error.code, code);
  assert.equal(error.status, status);
  return true;
}

test('compiled parser preserves the explicit empty-list direct mode', () => {
  assert.deepEqual(parseCreatorTrustedProxies(), []);
  assert.deepEqual(parseCreatorTrustedProxies('   '), []);
});
test('compiled parser normalizes mapped IPv4 and IPv6 case, not network ranges', () => {
  assert.deepEqual(parseCreatorTrustedProxies(' ::FFFF:192.0.2.10, 2001:DB8::10,192.0.2.10 '),
    [proxy, '2001:db8::10']);
});
for (const value of [
  '192.0.2.0/24', '2001:db8::/64', '*', 'localhost',
  '192.0.2.10,', '[2001:db8::10]', '192.0.2.10:443',
  Array.from({ length: 9 }, (_, index) => `192.0.2.${index + 1}`).join(',')
]) {
  test(`compiled parser rejects non-exact or oversized configuration: ${value}`, () => {
    assert.throws(() => parseCreatorTrustedProxies(value),
      error => rejection(error, 'creator_proxy_configuration_invalid', 503));
  });
}

for (const [name, peer, realIp, trusted, canonical] of [
  ['IPv4', proxy, client, proxies, client],
  ['IPv6 peer case', '2001:DB8::10', client, ['2001:db8::10'], client],
  ['mapped IPv4 peer', '::FFFF:192.0.2.10', client, proxies, client],
  ['mapped IPv4 real IP', proxy, '::ffff:203.0.113.20', proxies, client],
  ['IPv6 real IP case', proxy, '2001:DB8::20', proxies, '2001:db8::20']
]) {
  test(`trusted ${name} uses only the valid overwritten real IP`, () => {
    const key = creatorClientKey(request(peer, {
      'x-real-ip': realIp, 'x-forwarded-for': '198.51.100.99',
      forwarded: 'for=198.51.100.98', 'true-client-ip': '198.51.100.97'
    }), trusted);
    assert.equal(key, expectedKey(canonical));
    assert.match(key, /^[a-f0-9]{64}$/u);
  });
}

const badHeaders = [
  ['missing', {}],
  ['fallback headers only', { 'x-forwarded-for': client, forwarded: `for=${client}` }],
  ['empty', { 'x-real-ip': '' }],
  ['array duplicate', { 'x-real-ip': [client, client] }],
  ['array singleton', { 'x-real-ip': [client] }],
  ['comma duplicate', { 'x-real-ip': `${client}, ${client}` }],
  ['comma chain', { 'x-real-ip': `${client}, 198.51.100.99` }],
  ['surrounding whitespace', { 'x-real-ip': ` ${client} ` }],
  ['IPv4 port', { 'x-real-ip': `${client}:443` }],
  ['bracketed IPv6', { 'x-real-ip': '[2001:db8::20]' }],
  ['invalid IPv4', { 'x-real-ip': '999.0.0.1' }],
  ['invalid IPv6', { 'x-real-ip': '2001:db8::zz' }],
  ['invalid mapped IPv4', { 'x-real-ip': '::ffff:999.0.0.1' }],
  ['duplicate raw fields despite single parsed value', { 'x-real-ip': client },
    ['X-Real-IP', client, 'x-ReAl-Ip', client]]
];
for (const [name, headers, rawHeaders] of badHeaders) {
  test(`trusted peer rejects ${name} without fallback`, () => {
    assert.throws(() => creatorClientKey(request(proxy, headers, rawHeaders), proxies),
      error => rejection(error, 'creator_proxy_client_invalid', 503));
  });
}

const untrusted = [
  ['no header', '198.51.100.30', {}],
  ['forged valid real IP', '198.51.100.30', { 'x-real-ip': client }],
  ['forged trusted peer in header', '198.51.100.30', { 'x-real-ip': proxy }],
  ['forged fallback headers', '198.51.100.30', { 'x-forwarded-for': proxy, forwarded: `for=${proxy}` }],
  ['malformed header cannot change peer rejection', '198.51.100.30', { 'x-real-ip': 'invalid' }],
  ['same subnet is not trusted', '192.0.2.11', { 'x-real-ip': client }],
  ['loopback is not exempt from a configured list', '127.0.0.1', {}],
  ['mapped loopback is not exempt', '::ffff:127.0.0.1', { 'x-real-ip': client }],
  ['mapped untrusted IPv4', '::ffff:198.51.100.30', { 'x-real-ip': client }],
  ['untrusted IPv6', '2001:db8::30', { 'x-real-ip': client }],
  ['IPv6 spelling is not an additional trusted alias', '2001:0db8:0:0:0:0:0:10', { 'x-real-ip': client }]
];
for (const [name, peer, headers] of untrusted) {
  test(`nonempty exact list denies ${name} with CreatorError/403`, () => {
    assert.throws(() => creatorClientKey(request(peer, headers), [...proxies, '2001:db8::10']),
      error => rejection(error, 'creator_proxy_peer_untrusted', 403));
  });
}

const invalidPeers = [undefined, '', 'invalid', '999.0.0.1', '192.0.2.10:443',
  '[2001:db8::10]', '2001:db8::zz', '::ffff:999.0.0.1'];
for (const peer of invalidPeers) {
  test(`invalid TCP peer ${JSON.stringify(peer)} fails closed in both modes`, () => {
    const fake = request(peer, { 'x-real-ip': client, 'x-forwarded-for': proxy });
    assert.throws(() => creatorClientKey(fake, proxies),
      error => rejection(error, 'creator_client_address_invalid', 403));
    assert.throws(() => creatorClientKey(fake, []),
      error => rejection(error, 'creator_client_address_invalid', 503));
  });
}

test('empty list keeps actual loopback identity despite forged or malformed headers', () => {
  for (const [headers, rawHeaders] of [
    [{}, undefined],
    [{ 'x-real-ip': client }, undefined],
    [{ 'x-real-ip': [client, proxy] }, undefined],
    [{ 'x-real-ip': 'invalid' }, undefined],
    [{ 'x-forwarded-for': client, forwarded: `for=${client}` }, undefined],
    [{ 'x-real-ip': client }, ['X-Real-IP', client, 'x-real-ip', proxy]]
  ]) {
    assert.equal(creatorClientKey(request('127.0.0.1', headers, rawHeaders), []), expectedKey('127.0.0.1'));
  }
});
test('empty list preserves mapped IPv4 and IPv6 TCP identity normalization', () => {
  assert.equal(creatorClientKey(request('::ffff:127.0.0.1', { 'x-real-ip': client }), []), expectedKey('127.0.0.1'));
  assert.equal(creatorClientKey(request('::1', { 'x-real-ip': client }), []), expectedKey('::1'));
});

const origin = 'http://127.0.0.1:49152';
const publicPath = '/api/gongde/community/works';
async function route(fake, trustedProxyAddresses = proxies, path = publicPath) {
  const calls = [];
  const service = {
    repository: { async consumeLimit(...args) { calls.push(['limit', ...args]); } },
    async publicWorks(offset) { calls.push(['works', offset]); return [{ workId: 'explicit-local-fixture' }]; }
  };
  const router = createFreeCreatorRouter({
    publicOrigin: origin, secureCookie: false, freeDownloadsEnabled: false, trustedProxyAddresses
  }, service, () => { calls.push(['admin']); throw new Error('unexpected admin call'); });
  const response = {
    writeHead(status, headers) { this.status = status; this.headers = headers; },
    end(value) { this.body = value; }
  };
  assert.equal(await router(fake, response, new URL(path, origin)), true);
  return { response, calls };
}
function assertDenied(result, code, status) {
  assert.equal(result.response.status, status);
  assert.deepEqual(JSON.parse(result.response.body), { error: code });
  assert.equal(result.response.headers['cache-control'], 'no-store');
  assert.deepEqual(result.calls, []);
}

test('compiled router accepts a trusted peer and uses the real-IP key for limiting', async () => {
  const { response, calls } = await route(request(proxy, { 'x-real-ip': client }));
  assert.equal(response.status, 200);
  assert.deepEqual(JSON.parse(response.body), { works: [{ workId: 'explicit-local-fixture' }] });
  assert.deepEqual(calls, [['limit', 'http', expectedKey(client), 600, 60], ['works', 0]]);
});
for (const [name, peer, headers] of untrusted) {
  test(`compiled router rejects ${name} before any business dependency`, async () => {
    assertDenied(await route(request(peer, headers), [...proxies, '2001:db8::10']),
      'creator_proxy_peer_untrusted', 403);
  });
}
for (const peer of [undefined, 'invalid']) {
  test(`compiled router returns 403 for missing/invalid TCP peer ${JSON.stringify(peer)}`, async () => {
    assertDenied(await route(request(peer, { 'x-real-ip': client })), 'creator_client_address_invalid', 403);
  });
}
for (const [name, headers, rawHeaders] of [badHeaders[0], badHeaders[3], badHeaders[11], badHeaders[13]]) {
  test(`compiled router retains the trusted ${name} header error contract`, async () => {
    assertDenied(await route(request(proxy, headers, rawHeaders)), 'creator_proxy_client_invalid', 503);
  });
}
for (const path of ['/api/gongde/creators/terms', '/api/gongde/admin/creators/complaints']) {
  test(`compiled router also guards ${path} before creator/admin dependencies`, async () => {
    assertDenied(await route(request('127.0.0.1', { 'x-real-ip': client }), proxies, path),
      'creator_proxy_peer_untrusted', 403);
  });
}
test('compiled router retains empty-list local mode without header identity escalation', async () => {
  for (const headers of [{}, { 'x-real-ip': client, 'x-forwarded-for': client }]) {
    const { response, calls } = await route(request('127.0.0.1', headers), []);
    assert.equal(response.status, 200);
    assert.deepEqual(calls, [['limit', 'http', expectedKey('127.0.0.1'), 600, 60], ['works', 0]]);
  }
});
