import assert from 'node:assert/strict';
import test, { mock } from 'node:test';
import { once } from 'node:events';
import { generateKeyPairSync, createVerify } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { zipSync, unzipSync } from 'fflate';
import { AppearancePackSigner } from '../dist/delivery/pack-signer.js';
import { validateCreatorSourcePack } from '../dist/creators/pack-validation.js';
import { CreatorError } from '../dist/creators/types.js';
import { createFreeCreatorRouter } from '../dist/creators/router.js';

// Only loopback HTTP, synthetic orders and temporary test keys are used here.
for (const key of Object.keys(process.env)) if (key.startsWith('GONGDE_')) delete process.env[key];
const assetRoot = fileURLToPath(new URL('../../../assets/appearance-packs/', import.meta.url));
const acceptanceRoot = fileURLToPath(new URL('../../../.local-work/acceptance/', import.meta.url));

test('actual HTTP checkout gates a mixed batch, freezes source identity and signs one paid file', { timeout: 15000 }, async t => {
  await mkdir(acceptanceRoot, { recursive: true });
  const root = await mkdtemp(join(acceptanceRoot, 'paid-http-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const keyFile = join(root, 'test-key.pem');
  await writeFile(keyFile, privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 });
  const adminPasswordFile = join(root, 'admin-password.txt');
  const adminSessionFile = join(root, 'admin-session.txt');
  const adminPassword = 'synthetic-local-admin-password';
  await writeFile(adminPasswordFile, adminPassword, { mode: 0o600 });
  await writeFile(adminSessionFile, 'synthetic-local-session-secret-at-least-32-bytes', { mode: 0o600 });
  const signer = new AppearancePackSigner({ assetRoot, privateKeyFile: keyFile });
  const creatorId = 'c'.repeat(32), slug = 'http-test', workId = `creator.${creatorId}.${slug}`;
  const image = await readFile(join(assetRoot, 'chick-pecking', 'body.png'));
  const manifest = { schema_version: 3, id: workId, version: '1.0.0', name_zh: 'Local test',
    name_en: 'Local test', author: 'Synthetic fixture', publisher: 'community', review_id: 'pending',
    canvas_width: 240, canvas_height: 250, preview: 'preview.png', plus_y: 174,
    layers: [{ image: 'body.png', frame: [0, 0, 1, 1], anchor: [0.5, 0.5], interpolation: 'linear',
      keyframes: [{ t: 0, x: 0, y: 0, rotation: 0, scale: 1, scale_y: 1, alpha: 1 }] }] };
  const archive = Buffer.from(zipSync({ 'manifest.json': Buffer.from(JSON.stringify(manifest)),
    'preview.png': image, 'body.png': image }, { level: 0 }));
  const source = validateCreatorSourcePack(archive, { creatorId, slug });
  const snapshot = { assetId: workId, creatorId, workId, versionId: 'd'.repeat(32),
    versionLabel: '1.0.0', sourceRevision: source.revision, titleZh: 'Local test', unitPriceFen: 20,
    revenueRuleVersion: 'creator-paid-distribution-v1', deliveryBytesUpperBound: source.deliveryBytesUpperBound };
  let suspended = false;
  let suspendDuringPrepare = false;
  let suspendDuringDownload = false;
  mock.module(new URL('../dist/delivery/private-package-store.js', import.meta.url).href, { namedExports: {
    loadPrivatePackageConfiguration() { return {}; },
    PrivatePackageStore: class {
      async prepare(input) {
        if (suspendDuringPrepare) {
          suspended = true;
          throw new Error('synthetic_storage_failure');
        }
        return { bytes: input.content.length };
      }
      async downloadUrl() {
        if (suspendDuringDownload) suspended = true;
        throw new Error('synthetic_storage_failure');
      }
    }
  } });
  const configuration = { publicOrigin: '', secureCookie: false, trustedProxyAddresses: [],
    freeDownloadsEnabled: true, paidDownloadsEnabled: true };
  const service = { repository: { async consumeLimit() {} },
    async publicWorks() { return [{ workId, priceFen: 20, purchasable: true }]; } };
  const creatorRouter = createFreeCreatorRouter(configuration, service, () => 'synthetic-admin');
  mock.module(new URL('../dist/creators/runtime.js', import.meta.url).href, { namedExports: {
    createFreeCreatorRuntime(_admin, available) {
      assert.equal(available, true);
      return {
        handle: creatorRouter, async close() {},
        async numberWork() { throw new CreatorError('appearance_numbers_unavailable', 503); },
        async resolvePaidWorks(ids, revisions) {
          if (ids.some(id => id !== workId || revisions[id] !== source.revision)) {
            throw new CreatorError('appearance_preview_outdated', 409);
          }
          return ids.map(() => ({ ...snapshot }));
        },
        async authorizePaidItems(items) {
          if (suspended) throw new CreatorError('creator_work_suspended', 409);
          assert.ok(items.every(item => item.versionId === snapshot.versionId && item.sourceRevision === source.revision));
        },
        async buildPaidPack(item, delivery, activeSigner) {
          assert.equal(item.versionId, snapshot.versionId);
          return activeSigner.buildCommunity({ archive, creatorId, slug, reviewId: 'e'.repeat(32),
            revision: source.revision, archiveSha256: source.archiveSha256, downloadId: delivery.id,
            issuedAt: delivery.activatedAt, expiresAt: delivery.expiresAt });
        }
      };
    }
  } });
  Object.assign(process.env, { HOST: '127.0.0.1', PORT: '0', GONGDE_PAYMENT_MODE: 'mock',
    GONGDE_PAYMENT_TEST_TOKEN: 'local-paid-test-token-0123456789', GONGDE_STORE_MODE: 'memory',
    GONGDE_PACK_DELIVERY_MODE: 'local', GONGDE_PACK_ASSET_ROOT: assetRoot, GONGDE_PACK_SIGNING_KEY_FILE: keyFile,
    GONGDE_ADMIN_USERNAME: 'test-admin', GONGDE_ADMIN_PASSWORD_FILE: adminPasswordFile,
    GONGDE_ADMIN_SESSION_SECRET_FILE: adminSessionFile });
  const { server } = await import('../dist/server.js');
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); mock.restoreAll(); });
  if (!server.listening) await once(server, 'listening');
  const origin = `http://127.0.0.1:${server.address().port}`;
  configuration.publicOrigin = origin;
  const request = (path, options = {}) => fetch(origin + path, { ...options,
    headers: { origin, 'sec-fetch-site': 'same-origin', 'content-type': 'application/json', ...options.headers } });
  const post = (path, body, headers = {}) => request(path, { method: 'POST', body: JSON.stringify(body), headers });
  const listing = await request('/api/gongde/community/works');
  assert.equal((await listing.json()).works[0].priceFen, 20);
  const free = await post('/api/gongde/community/batches', { items: [{ workId }] });
  assert.notEqual(free.status, 200);
  assert.equal(free.headers.get('content-disposition'), null);
  const officialId = 'official.chick-pecking';
  const body = { channel: 'wechat', purchaseKind: 'appearance-batch', assetIds: [officialId, workId],
    previewRevisions: { [officialId]: signer.revisions()[officialId], [workId]: source.revision } };
  const stale = await post('/api/gongde/checkout', { ...body, previewRevisions: { ...body.previewRevisions, [workId]: 'f'.repeat(64) } });
  assert.equal(stale.status, 409);
  const started = await post('/api/gongde/checkout', body);
  assert.equal(started.status, 201);
  const checkout = await started.json();
  assert.equal(checkout.amountFen, 40);
  const adminDetailPath = `/api/gongde/admin/orders/${checkout.orderNo}`;
  assert.equal((await request(adminDetailPath)).status, 401);
  const adminLogin = await post('/api/gongde/admin/login', { username: 'test-admin', password: adminPassword });
  assert.equal(adminLogin.status, 200);
  const adminHeaders = { cookie: adminLogin.headers.get('set-cookie').split(';')[0] };
  assert.equal((await request(adminDetailPath, { headers: adminHeaders })).status, 404);
  const headers = { authorization: `Bearer ${checkout.buyerToken}` };
  assert.equal((await post(`/api/gongde/orders/${checkout.orderNo}/package-link`, {}, headers)).status, 410);
  const paid = await post(`/api/gongde/test/orders/${checkout.orderNo}/pay`, {}, { 'x-gongde-test-token': process.env.GONGDE_PAYMENT_TEST_TOKEN });
  assert.equal(paid.status, 200);
  const queried = await request(`/api/gongde/orders/${checkout.orderNo}`, { headers });
  assert.equal((await queried.json()).order.state, 'FULFILLED');
  const adminDetail = await request(adminDetailPath, { headers: adminHeaders });
  assert.equal(adminDetail.status, 200);
  const adminOrder = (await adminDetail.json()).data;
  assert.equal(adminOrder.marketItems.length, 2);
  assert.deepEqual(new Set(adminOrder.marketItems.map(item => item.sourceKind)), new Set(['official', 'community']));
  for (const item of adminOrder.marketItems) {
    assert.equal(item.amountFen, 20);
    assert.equal(item.unitPriceFen, 20);
    assert.equal(item.creatorAmountFen, 0);
    assert.equal(item.platformAmountFen, 20);
    assert.equal(item.sourceRevision, body.previewRevisions[item.assetId]);
  }
  const communityItem = adminOrder.marketItems.find(item => item.sourceKind === 'community');
  assert.equal(communityItem.versionId, snapshot.versionId);
  assert.equal(communityItem.versionLabel, snapshot.versionLabel);
  assert.equal(communityItem.titleZh, snapshot.titleZh);
  const linked = await post(`/api/gongde/orders/${checkout.orderNo}/package-link`, {}, headers);
  assert.equal(linked.status, 200);
  const link = await linked.json();
  assert.equal(link.count, 2);
  assert.match(link.filename, /\.nmgpacks$/u);
  const downloaded = await request(link.downloadUrl);
  assert.equal(downloaded.status, 200);
  const contents = unzipSync(new Uint8Array(await downloaded.arrayBuffer()));
  assert.equal(Object.keys(contents).length, 2);
  const manifests = Object.values(contents).map(bytes => JSON.parse(Buffer.from(unzipSync(bytes)['manifest.json']).toString('utf8')));
  assert.deepEqual(new Set(manifests.map(pack => pack.id)), new Set(body.assetIds));
  for (const pack of manifests) {
    const license = pack.license;
    const verifier = createVerify('SHA256');
    verifier.update(`NIUMA-PACK-LICENSE-V1\n${pack.id}\n${pack.version}\n${license.issued_at}\n${license.import_before}\n${license.download_id}\n${license.content_sha256}`);
    verifier.end();
    assert.equal(verifier.verify({ key: publicKey, dsaEncoding: 'ieee-p1363' }, Buffer.from(license.signature, 'hex')), true);
    assert.equal(license.import_before - license.issued_at, 86400);
  }
  suspendDuringDownload = true;
  const interruptedDownload = await request(link.downloadUrl);
  assert.equal(interruptedDownload.status, 409);
  assert.equal(interruptedDownload.headers.get('content-disposition'), null);
  assert.equal((await interruptedDownload.json()).error, 'creator_work_suspended');
  suspendDuringDownload = false;
  suspended = false;
  suspendDuringPrepare = true;
  const interruptedLink = await post(`/api/gongde/orders/${checkout.orderNo}/package-link`, {}, headers);
  assert.equal(interruptedLink.status, 409);
  assert.equal((await interruptedLink.json()).error, 'creator_work_suspended');
  suspendDuringPrepare = false;
  assert.equal((await post(`/api/gongde/orders/${checkout.orderNo}/package-link`, {}, headers)).status, 409);
  suspended = false;
  const officialCheckout = await post('/api/gongde/checkout', { ...body,
    assetIds: [officialId], previewRevisions: { [officialId]: signer.revisions()[officialId] } });
  assert.equal(officialCheckout.status, 201);
  const officialOrder = await officialCheckout.json();
  assert.equal(officialOrder.amountFen, 20);
  const actualRevisions = AppearancePackSigner.prototype.revisions;
  const revised = mock.method(AppearancePackSigner.prototype, 'revisions', function () {
    return { ...actualRevisions.call(this), [officialId]: 'f'.repeat(64) };
  });
  try {
    const payment = await post(`/api/gongde/test/orders/${officialOrder.orderNo}/pay`, {},
      { 'x-gongde-test-token': process.env.GONGDE_PAYMENT_TEST_TOKEN });
    assert.equal(payment.status, 200);
    const unavailable = await post(`/api/gongde/orders/${officialOrder.orderNo}/package-link`, {},
      { authorization: `Bearer ${officialOrder.buyerToken}` });
    assert.equal(unavailable.status, 503);
    assert.equal((await unavailable.json()).error, 'market_order_source_unavailable');
  } finally { revised.mock.restore(); }
});
