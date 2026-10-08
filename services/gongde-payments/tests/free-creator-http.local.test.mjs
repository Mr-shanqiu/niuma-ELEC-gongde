import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
// Never load the real creator database or credential configuration in this suite.
process.env.GONGDE_CREATORS_ENABLED = 'false';
process.env.GONGDE_CREATOR_PAID_SALES_ENABLED = 'false';
process.env.GONGDE_CREATOR_SETTLEMENTS_ENABLED = 'false';
const base = new URL('../dist/creators/', import.meta.url);
const load = name => import(new URL(name + '.js', base).href);
const { createFreeCreatorRouter } = await load('router');
const { createFreeCreatorRuntime } = await load('runtime');
const { CreatorError } = await load('types');
const bytes = Buffer.from([80, 75, 3, 4, 0, 255, 128, 1]);
const batchPath = '/api/gongde/community/batches';
async function app(options, run) {
  const calls = { batch: [], limits: [], account: 0, admin: 0 };
  const service = {
    repository: { async consumeLimit(...args) {
      calls.limits.push(args);
      if (options.rateError) throw new CreatorError('creator_rate_limited', 429);
    } },
    async freeBatch(payload, clientKey) {
      calls.batch.push({ payload, clientKey });
      if (options.serviceError) throw new Error('private diagnostic must stay internal');
      return { body: bytes, fileName: options.fileName ?? 'community-pack.nmgpack', contentType: 'application/octet-stream' };
    },
    async publicWorks(offset) { return [{ workId: 'public-fixture', offset }]; },
    async requireAccount() { calls.account++; throw new CreatorError('creator_auth_required', 401); }
  };
  const requireAdmin = () => { calls.admin++; throw new CreatorError('creator_admin_auth_required', 401); };
  let handler;
  const server = createServer(async (req, res) => {
    try {
      if (!await handler(req, res, new URL(req.url, origin))) {
        res.writeHead(404, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ outsideCreatorScope: true }));
      }
    } catch {
      res.writeHead(500); res.end('unexpected test harness error');
    }
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const origin = 'http://127.0.0.1:' + server.address().port;
  const runtime = options.disabledRuntime ? createFreeCreatorRuntime(requireAdmin) : null;
  handler = runtime ? runtime.handle : createFreeCreatorRouter({
    publicOrigin: origin, secureCookie: false, trustedProxyAddresses: [],
    freeDownloadsEnabled: options.enabled ?? true
  }, service, requireAdmin);
  const request = (path = batchPath, init = {}) => fetch(origin + path, {
    method: 'POST', body: JSON.stringify({ items: [{ workId: 'fixture', versionId: 'fixture', revision: 'fixture' }] }),
    ...init, headers: { origin, 'sec-fetch-site': 'same-origin', 'content-type': 'application/json', ...init.headers }
  });
  try { await run({ request, calls, origin }); }
  finally {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    if (runtime) await runtime.close();
  }
}
test('retired free route never returns a binary pack', async () => app({}, async ({ request, calls }) => {
  const response = await request();
  assert.equal(response.status, 503);
  assert.equal((await response.json()).error, 'creator_paid_checkout_unavailable');
  assert.equal(response.headers.get('content-disposition'), null);
  assert.equal(calls.batch.length, 0);
}));
test('legacy multi-pack request is also blocked before service delivery', async () => app({ fileName: 'community-packs.nmgpacks' }, async ({ request, calls }) => {
  const response = await request();
  assert.equal(response.status, 503);
  assert.equal((await response.json()).error, 'creator_paid_checkout_unavailable');
  assert.equal(calls.batch.length, 0);
}));
test('download capability remains fail-closed', async () => app({ enabled: false }, async ({ request, calls }) => {
  const response = await request();
  assert.equal(response.status, 503);
  assert.equal((await response.json()).error, 'creator_paid_checkout_unavailable');
  assert.equal(calls.batch.length, 0);
}));
test('legacy filename values cannot affect the retired route response', async () => app({ fileName: '../escape.nmgpack' }, async ({ request }) => {
  const response = await request();
  assert.equal(response.status, 503);
  assert.equal(response.headers.get('content-disposition'), null);
  assert.equal((await response.json()).error, 'creator_paid_checkout_unavailable');
}));
test('cross-origin write is denied before invoking dependencies', async () => app({}, async ({ request, calls }) => {
  const response = await request(batchPath, { headers: { origin: 'https://untrusted.invalid' } });
  assert.equal(response.status, 403);
  assert.equal(calls.batch.length + calls.limits.length, 0);
}));
test('cross-site write is denied', async () => app({}, async ({ request }) => {
  assert.equal((await request(batchPath, { headers: { 'sec-fetch-site': 'cross-site' } })).status, 403);
}));
test('binary body cannot bypass the JSON contract', async () => app({}, async ({ request, calls }) => {
  const response = await request(batchPath, { headers: { 'content-type': 'application/octet-stream' } });
  assert.equal(response.status, 503);
  assert.equal((await response.json()).error, 'creator_paid_checkout_unavailable');
  assert.equal(calls.batch.length, 0);
}));
test('unsupported method is denied', async () => app({}, async ({ request }) => {
  assert.equal((await request(batchPath, { method: 'DELETE' })).status, 405);
}));
test('oversize JSON request is denied without batch generation', async () => app({}, async ({ request, calls }) => {
  const response = await request(batchPath, { body: ' '.repeat(16385) });
  assert.equal(response.status, 503);
  assert.equal((await response.json()).error, 'creator_paid_checkout_unavailable');
  assert.equal(calls.batch.length, 0);
}));
test('rate limit response preserves retry-after', async () => app({ rateError: true }, async ({ request, calls }) => {
  const response = await request();
  assert.equal(response.status, 429);
  assert.equal(response.headers.get('retry-after'), '60');
  assert.equal(calls.batch.length, 0);
}));
test('public listing requires neither creator nor admin account', async () => app({}, async ({ request, calls }) => {
  const response = await request('/api/gongde/community/works', { method: 'GET', body: undefined });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).works.length, 1);
  assert.equal(calls.account + calls.admin, 0);
}));
test('admin complaint data requires admin authorization', async () => app({}, async ({ request, calls }) => {
  const response = await request('/api/gongde/admin/creators/complaints', { method: 'GET', body: undefined });
  assert.equal(response.status, 401);
  assert.equal(calls.admin, 1);
}));
test('creator private work list requires creator authorization', async () => app({}, async ({ request, calls }) => {
  const response = await request('/api/gongde/creators/works', { method: 'GET', body: undefined });
  assert.equal(response.status, 401);
  assert.equal(calls.account, 1);
}));
test('creator router leaves original official purchase routes untouched', async () => app({}, async ({ request, calls }) => {
  const response = await request('/api/gongde/orders', { method: 'GET', body: undefined });
  assert.equal(response.status, 404);
  assert.equal((await response.json()).outsideCreatorScope, true);
  assert.equal(calls.batch.length + calls.limits.length + calls.account + calls.admin, 0);
}));
test('spoofed proxy headers cannot reach the retired delivery service', async () => app({}, async ({ request, calls }) => {
  assert.equal((await request()).status, 503);
  assert.equal((await request(batchPath, { headers: { 'x-real-ip': '203.0.113.20', 'x-forwarded-for': '203.0.113.20' } })).status, 503);
  assert.equal(calls.batch.length, 0);
}));
test('retired route does not invoke or leak service diagnostics', async () => app({ serviceError: true }, async ({ request }) => {
  const response = await request();
  assert.equal(response.status, 503);
  assert.deepEqual(await response.json(), { error: 'creator_paid_checkout_unavailable' });
}));
test('actual disabled runtime reports the community closed', async () => app({ disabledRuntime: true }, async ({ request }) => {
  const response = await request('/api/gongde/community/status', { method: 'GET', body: undefined });
  assert.equal(response.status, 200);
  const status = await response.json();
  assert.equal(status.enabled, false);
  assert.equal(status.ready, false);
  assert.equal(status.freeBatchDelivery, false);
  assert.equal(status.paidBatchDelivery, false);
  assert.equal(status.termsVersion, 'creator-paid-distribution-v1');
}));
