// Actual local MySQL integration. COS is the only mocked product dependency.
// No server.js, real configuration files, external providers or old suite execution.
import assert from 'node:assert/strict';
import { randomBytes, generateKeyPairSync, createVerify } from 'node:crypto';
import { writeFile, rm, realpath } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { mock } from 'node:test';
import { installLocalOnlyIoBoundary, MemoryCos, sourceFixture, sha256, jsonValue, unzip }
  from './free-creator-mysql-fixtures.local.mjs';

export function approvedPaidMysqlTarget(source, { allowSetupRoot = false } = {}) {
  assert.equal(source.GONGDE_PAID_LOCAL_MYSQL_APPROVED, '1', 'LOCAL_MYSQL_APPROVAL_REQUIRED');
  const text = source.GONGDE_PAID_LOCAL_MYSQL_URL;
  assert.ok(typeof text === 'string' && text.startsWith('mysql://'), 'LOCAL_TARGET_REQUIRED');
  const url = new URL(text);
  const port = Number(url.port), database = url.pathname.slice(1);
  const authority = text.slice(8).split(/[/?#]/u)[0];
  assert.ok(url.protocol === 'mysql:' && url.hostname === '127.0.0.1' &&
    authority.slice(authority.lastIndexOf('@') + 1) === `127.0.0.1:${port}` &&
    Number.isInteger(port) && port >= 10000 && port <= 65535 && !url.search && !url.hash &&
    /^gongde_paid_local_[a-f0-9]{24}$/u.test(database), 'LOCAL_TARGET_UNSAFE');
  const user = decodeURIComponent(url.username), password = decodeURIComponent(url.password);
  assert.ok(user === 'paid_local' || (allowSetupRoot && user === 'root'), 'LOCAL_PRODUCT_USER_REQUIRED');
  assert.match(password, /^[a-f0-9]{48}$/u, 'FICTIONAL_RANDOM_PASSWORD_REQUIRED');
  return Object.freeze({ host: '127.0.0.1', port, database, user, password });
}

const canonical = '/Users/yue/Desktop/牛马电子功德';
const acceptance = path.join(canonical, '.local-work/acceptance/paid-community-20261007');

async function runSuite() {
  // Guard completes before product imports or pool construction. Root is setup-only.
  const target = approvedPaidMysqlTarget(process.env);
  const artifact = process.env.GONGDE_PAID_LOCAL_MYSQL_ARTIFACT_DIR;
  assert.ok(typeof artifact === 'string' && artifact.startsWith(acceptance + '/mysql-run-') &&
    path.dirname(artifact) === acceptance && /\/mysql-run-[a-f0-9]{24}$/u.test(artifact), 'LOCAL_ARTIFACT_UNSAFE');
  assert.equal(await realpath(artifact), artifact, 'LOCAL_ARTIFACT_SYMLINK_FORBIDDEN');
  const io = installLocalOnlyIoBoundary(target);
  const secrets = [target.password];
  const redact = value => secrets.reduce((out, secret) => out.split(secret).join('[temporary-secret]'), String(value));
  const timer = setTimeout(() => process.exit(124), 40000);
  timer.unref();
  const cases = [];
  let pool, repository, runtime, keyFile;
  let fatal = null;
  const state = {};
  try {
    const { createPool } = await import('mysql2/promise');
    const { FreeCreatorRepository } = await import('../dist/creators/repository.js');
    const { FreeCreatorService, FREE_CREATOR_TERMS_VERSION: terms } = await import('../dist/creators/free-service.js');
    const { CreatorSourceStore } = await import('../dist/creators/object-store.js');
    const { validateCreatorSourcePack } = await import('../dist/creators/pack-validation.js');
    const { MySqlPaymentStore } = await import('../dist/storage/mysql-store.js');
    const { GongdeOrderService } = await import('../dist/domain/order-service.js');
    const { AppearancePackSigner } = await import('../dist/delivery/pack-signer.js');
    pool = createPool({ ...target, connectionLimit: 2, queueLimit: 16, connectTimeout: 3000,
      waitForConnections: true, timezone: 'Z', charset: 'utf8mb4', multipleStatements: false });
    repository = new FreeCreatorRepository({}, pool);
    const cos = new MemoryCos();
    const objects = new CreatorSourceStore({ bucket: 'gongde-paid-local-123', region: 'ap-local',
      secretId: 'FICTIONAL-MEMORY-ONLY', secretKey: 'FICTIONAL-MEMORY-ONLY' }, cos);
    const service = new FreeCreatorService(repository, objects);
    // The real runtime, configuration loader, service and repository remain active.
    mock.module(new URL('../dist/creators/object-store.js', import.meta.url).href, {
      namedExports: { CreatorSourceStore: class extends CreatorSourceStore {
        constructor(configuration) { super(configuration, cos); }
      } }
    });
    Object.assign(process.env, { NODE_ENV: 'test', GONGDE_STORE_MODE: 'mysql',
      GONGDE_MYSQL_HOST: target.host, GONGDE_MYSQL_PORT: String(target.port),
      GONGDE_MYSQL_DATABASE: target.database, GONGDE_MYSQL_USER: target.user,
      GONGDE_MYSQL_PASSWORD: target.password, GONGDE_CREATORS_ENABLED: 'true',
      GONGDE_CREATOR_PUBLIC_ORIGIN: 'http://127.0.0.1', GONGDE_CREATOR_PAID_SALES_ENABLED: 'true',
      GONGDE_CREATOR_PAYMENT_SCENARIO_APPROVED: 'true', GONGDE_CREATOR_COMMERCIAL_TERMS_APPROVED: 'true',
      GONGDE_CREATOR_CLIENT_COMPATIBILITY_ACCEPTED: 'true',
      GONGDE_CREATOR_COS_BUCKET: 'gongde-paid-local-123', GONGDE_CREATOR_COS_REGION: 'ap-local',
      GONGDE_CREATOR_COS_SECRET_ID: 'FICTIONAL-MEMORY-ONLY', GONGDE_CREATOR_COS_SECRET_KEY: 'FICTIONAL-MEMORY-ONLY' });
    const { createFreeCreatorRuntime } = await import('../dist/creators/runtime.js');
    runtime = createFreeCreatorRuntime(() => 'fictional-local-admin', true);
    const store = new MySqlPaymentStore(pool, pool);
    const orders = new GongdeOrderService(store);
    const pair = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
    keyFile = path.join(artifact, 'mysql-ephemeral-signing-key.pem');
    await writeFile(keyFile, pair.privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600, flag: 'wx' });
    const signer = new AppearancePackSigner({ assetRoot: path.join(canonical, 'assets/appearance-packs'), privateKeyFile: keyFile });
    const rows = async (sql, values = []) => (await pool.execute(sql, values))[0];
    const one = async (sql, values = []) => { const result = await rows(sql, values); assert.equal(result.length, 1); return result[0]; };
    const reject = (operation, code) => assert.rejects(operation, error => error.code === code || error.message === code);
    const sharing = { acceptPaidDistribution: true, sharingTermsVersion: terms };
    const metadata = title => ({ titleZh: title, description: 'Fictional local paid MySQL integration source.', tags: ['local'], ...sharing });
    const checks = { dataOnly: true, realPreview: true, contentAcceptable: true, rightsDeclaration: true };
    const add = async (name, operation) => {
      try { await operation(); cases.push({ name, status: 'PASS' }); }
      catch (error) { cases.push({ name, status: 'FAIL', code: error.code ?? error.name,
        detail: redact(error.message).slice(0, 1600) }); }
      process.stdout.write(JSON.stringify(cases.at(-1)) + '\n');
    };
    const publish = async (slug, version = '1.0.0', existing = null, pixel = 90) => {
      const work = existing ?? await service.createWork(state.account, { slug, ...metadata('Paid ' + slug) });
      const fixture = sourceFixture({ creatorId: state.account.creatorId, slug }, { version, pixel });
      const validated = validateCreatorSourcePack(fixture.archive, { creatorId: state.account.creatorId, slug });
      const uploaded = await service.upload(state.account, work.workId, fixture.archive);
      assert.equal(uploaded.revision, validated.revision);
      const submitted = await service.submit(state.account, work.workId, uploaded.versionId, sharing);
      await service.decide('fictional-local-admin', submitted.reviewId, { decision: 'APPROVED', reason: '', checks });
      return { work, uploaded, submitted, fixture };
    };
    const input = items => ({ channel: 'wechat', purchaseKind: 'appearance-batch', amountFen: 1,
      assetIds: items.map(item => item.assetId), marketItems: items });
    const manifest = content => JSON.parse(Buffer.from(unzip(content)['manifest.json']).toString('utf8'));
    const verifyPack = (pack, published) => {
      const signed = manifest(pack.content), license = signed.license;
      assert.equal(signed.id, published.work.workId); assert.equal(signed.version, published.uploaded.versionLabel);
      assert.equal(signed.review_id, published.submitted.reviewId);
      assert.deepEqual(Buffer.from(unzip(pack.content)['sprite.png']), published.fixture.png);
      assert.ok(license.import_before > license.issued_at && license.import_before - license.issued_at <= 86400);
      const verifier = createVerify('SHA256');
      verifier.update(`NIUMA-PACK-LICENSE-V1\n${signed.id}\n${signed.version}\n${license.issued_at}\n${license.import_before}\n${license.download_id}\n${license.content_sha256}`);
      verifier.end();
      assert.equal(verifier.verify({ key: pair.publicKey, dsaEncoding: 'ieee-p1363' }, Buffer.from(license.signature, 'hex')), true);
    };

    await add('MySQL 8.4 / migrations 001-006 / independent database-scoped product user', async () => {
      const identity = await one('SELECT DATABASE() AS db, VERSION() AS version, CURRENT_USER() AS account');
      assert.equal(identity.db, target.database); assert.match(identity.version, /^8\.4\./u);
      assert.match(identity.account, /^paid_local@/u); state.mysqlVersion = identity.version;
      assert.equal(await repository.ready(), true);
      const grants = (await rows('SHOW GRANTS FOR CURRENT_USER()')).map(row => Object.values(row)[0]);
      assert.ok(grants.some(grant => grant.includes('`' + target.database + '`.*')));
      assert.ok(grants.every(grant => !/ALL PRIVILEGES ON \*\.\*|GRANT OPTION/u.test(grant)));
      await assert.rejects(() => rows('SELECT User FROM mysql.user'), error => error.code === 'ER_TABLEACCESS_DENIED_ERROR');
      const tables = await rows('SELECT ENGINE AS engine FROM information_schema.tables WHERE table_schema = ?', [target.database]);
      assert.ok(tables.length >= 15 && tables.every(row => row.engine === 'InnoDB'));
      assert.equal(Number((await one('SELECT COUNT(*) AS n FROM gongde_orders')).n), 0);
    });
    await add('actual registration / paid metadata / free metadata and submission rejected', async () => {
      const password = randomBytes(24).toString('hex'); secrets.push(password);
      const registration = await service.register({ username: 'paid_' + randomBytes(5).toString('hex'),
        password, displayName: 'Fictional Paid Author', termsVersion: terms, acceptTerms: true }, sha256('local-paid-author'));
      secrets.push(registration.sessionToken, registration.recoveryKey);
      state.account = await service.requireAccount(registration.sessionToken);
      await reject(() => service.createWork(state.account, { slug: 'old-free', titleZh: 'Old Free',
        description: 'Fictional legacy consent declaration.', tags: [], sharingTermsVersion: 'creator-free-sharing-v1', acceptFreeSharing: true }), 'creator_metadata_invalid');
      state.first = await service.createWork(state.account, { slug: 'paid-first', ...metadata('Frozen paid title') });
      assert.equal(state.first.metadata.priceFen, 20);
      state.fixture = sourceFixture({ creatorId: state.account.creatorId, slug: state.first.slug });
      state.uploaded = await service.upload(state.account, state.first.workId, state.fixture.archive);
      await reject(() => service.submit(state.account, state.first.workId, state.uploaded.versionId,
        { sharingTermsVersion: 'creator-free-sharing-v1', acceptFreeSharing: true }), 'creator_sharing_acceptance_required');
      state.submitted = await service.submit(state.account, state.first.workId, state.uploaded.versionId, sharing);
      const pending = await one('SELECT metadata_snapshot_json AS metadata FROM gongde_creator_reviews WHERE review_id = ?', [state.submitted.reviewId]);
      assert.deepEqual(jsonValue(pending.metadata), { ...state.first.metadata, acceptPaidDistribution: true, creatorName: state.account.displayName });
      await service.updateWork(state.account, state.first.workId, metadata('Draft changed after submission'));
    });
    await add('review publishes frozen paid metadata / adminWorks and public preview visible', async () => {
      await service.decide('fictional-local-admin', state.submitted.reviewId, { decision: 'APPROVED', reason: '', checks });
      state.published = [{ work: state.first, uploaded: state.uploaded, submitted: state.submitted, fixture: state.fixture }];
      const admin = (await repository.adminWorks('PUBLISHED')).find(work => work.workId === state.first.workId);
      assert.ok(admin); assert.equal(admin.metadata.priceFen, 20);
      assert.equal(admin.publishedMetadata.titleZh, 'Frozen paid title');
      assert.equal(admin.publishedMetadata.acceptPaidDistribution, true);
      const discovered = (await service.publicWorks(0)).find(work => work.workId === state.first.workId);
      assert.ok(discovered); assert.equal(discovered.priceFen, 20); assert.equal(discovered.purchasable, true);
      assert.equal(discovered.preview.versionId, state.uploaded.versionId);
      assert.match(discovered.preview.images['sprite.png'], /^\/api\/gongde\/community\/versions\//u);
      assert.deepEqual(await service.image(state.uploaded.versionId, 'sprite.png', { audience: 'public' }), state.fixture.png);
      assert.equal((await runtime.numberWork(state.first.workId, false)).appearanceNumber, discovered.appearanceNumber);
      for (let index = 2; index <= 9; index++) state.published.push(await publish('paid-' + index));
    });
    await add('real runtime resolvePaidWorks freezes 20 fen / paid consent / source revision', async () => {
      state.ids = state.published.map(item => item.work.workId);
      state.revisions = Object.fromEntries(state.published.map(item => [item.work.workId, item.uploaded.revision]));
      state.snapshots = (await runtime.resolvePaidWorks(state.ids, state.revisions)).map(item => ({ sourceKind: 'community', ...item }));
      for (let index = 0; index < state.snapshots.length; index++) {
        const snapshot = state.snapshots[index];
        assert.equal(snapshot.unitPriceFen, 20); assert.equal(snapshot.revenueRuleVersion, terms);
        assert.equal(snapshot.versionId, state.published[index].uploaded.versionId);
        const version = await repository.getVersion(snapshot.versionId);
        assert.equal(version.approvedMetadata.acceptPaidDistribution, true);
        assert.equal(version.approvedMetadata.sharingTermsVersion, terms);
      }
      await reject(() => runtime.resolvePaidWorks([state.ids[0]], { [state.ids[0]]: 'f'.repeat(64) }), 'appearance_preview_outdated');
      const official = signer.officialSnapshot('official.chick-pecking');
      state.official = { sourceKind: 'official', assetId: 'official.chick-pecking', creatorId: null,
        workId: null, versionId: null, titleZh: 'Fictional official checkout fixture', unitPriceFen: 20,
        revenueRuleVersion: null, ...official };
    });
    await add('real MySqlPaymentStore commits mixed orders / exact 100 fen cap / zero creator share', async () => {
      const singleton = await orders.createMockCheckout(input([state.snapshots[0]])); secrets.push(singleton.buyerToken);
      assert.equal(singleton.amountFen, 20);
      for (const count of [6, 10]) {
        const selection = [state.official, ...state.snapshots.slice(0, count - 1)].map(item => ({ ...item }));
        const checkout = await orders.createMockCheckout(input(selection)); secrets.push(checkout.buyerToken);
        assert.equal(checkout.amountFen, 100); assert.equal(checkout.accessCode, null);
        const lines = await store.findMarketOrderItemsByOrder(checkout.orderNo);
        assert.equal(lines.length, count);
        assert.deepEqual(lines.map(line => line.amountFen), count === 6 ? [17, 17, 17, 17, 16, 16] : Array(10).fill(10));
        assert.deepEqual(lines.map(line => line.lineNo), Array.from({ length: count }, (_, index) => index + 1));
        const raw = await rows('SELECT * FROM gongde_market_order_items WHERE order_no = ? ORDER BY line_no', [checkout.orderNo]);
        assert.ok(raw.every(line => line.unit_price_fen === 20 && line.creator_share_bps === 0 &&
          line.creator_amount_fen === 0 && line.platform_amount_fen === line.amount_fen));
        for (let index = 1; index < count; index++) {
          assert.equal(raw[index].version_id, selection[index].versionId);
          assert.equal(raw[index].source_revision, selection[index].sourceRevision);
          assert.equal(raw[index].revenue_rule_version, terms);
        }
        assert.equal((await store.findOrder(checkout.orderNo)).amountFen, raw.reduce((sum, line) => sum + line.amount_fen, 0));
        selection[1].titleZh = 'Caller mutated after insertion ' + count;
        assert.equal((await store.findMarketOrderItemsByOrder(checkout.orderNo))[1].titleZh, lines[1].titleZh);
        assert.notEqual(lines[1].titleZh, selection[1].titleZh);
        if (count === 6) { state.checkout = checkout; state.lines = lines; }
      }
    });
    await add('real foreign-key line insert failure rolls back parent order and all lines', async () => {
      const bad = { ...state.snapshots[0], versionId: randomBytes(16).toString('hex') };
      const before = Number((await one('SELECT COUNT(*) AS n FROM gongde_orders')).n);
      const existing = await store.findOrder(state.checkout.orderNo);
      const orderNo = 'GD_' + new Date().toISOString().replace(/[-:TZ.]/gu, '').slice(0, 14) + randomBytes(5).toString('hex').toUpperCase();
      await assert.rejects(() => store.insertOrder({ ...existing, orderNo, assetIds: [state.official.assetId, bad.assetId],
        amountFen: 40 }, [{ ...state.official, amountFen: 20, createdAt: new Date() }, { ...bad, amountFen: 20, createdAt: new Date() }]),
      error => error.code === 'ER_NO_REFERENCED_ROW_2');
      assert.equal(await store.findOrder(orderNo), null);
      assert.equal((await store.findMarketOrderItemsByOrder(orderNo)).length, 0);
      assert.equal(Number((await one('SELECT COUNT(*) AS n FROM gongde_orders')).n), before);
    });
    await add('pending purchase cannot deliver / actual mock-payment fulfillment persists once', async () => {
      assert.equal((await store.findEntitlementsByOrder(state.checkout.orderNo)).length, 0);
      const line = state.lines[1];
      await reject(() => runtime.buildPaidPack(line, { orderNo: line.orderNo, assetId: line.assetId,
        scope: 'asset-download', state: 'PENDING', activatedAt: null, expiresAt: null }, signer), 'creator_paid_delivery_unavailable');
      const result = await orders.completeMockPayment(state.checkout.orderNo);
      assert.equal(result.order.state, 'FULFILLED'); assert.equal(result.entitlements.length, 6);
      await orders.completeMockPayment(state.checkout.orderNo);
      state.deliveries = await store.findEntitlementsByOrder(state.checkout.orderNo);
      assert.equal(state.deliveries.length, 6);
      assert.ok(state.deliveries.every(item => item.expiresAt - item.activatedAt === 86400000));
      state.delivery = state.deliveries.find(item => item.assetId === state.ids[0]);
      await runtime.authorizePaidItems(state.lines);
      verifyPack(await runtime.buildPaidPack(line, state.delivery, signer), state.published[0]);
    });
    await add('new published version does not change old paid order version or signed source', async () => {
      const replacement = await publish(state.first.slug, '2.0.0', state.first, 180);
      const fresh = await runtime.resolvePaidWorks([state.first.workId], { [state.first.workId]: replacement.uploaded.revision });
      assert.equal(fresh[0].versionId, replacement.uploaded.versionId);
      const persisted = (await store.findMarketOrderItemsByOrder(state.checkout.orderNo))[1];
      assert.equal(persisted.versionId, state.uploaded.versionId); assert.equal(persisted.sourceRevision, state.uploaded.revision);
      await runtime.authorizePaidItems([persisted]);
      verifyPack(await runtime.buildPaidPack(persisted, state.delivery, signer), state.published[0]);
      await reject(() => runtime.authorizePaidItems([{ ...persisted, sourceRevision: replacement.uploaded.revision }]), 'creator_paid_delivery_unavailable');
      await reject(() => runtime.buildPaidPack(persisted, { ...state.delivery, orderNo: 'different-order' }, signer), 'creator_paid_delivery_unavailable');
      await reject(() => runtime.buildPaidPack(persisted, { ...state.delivery, expiresAt: new Date(0) }, signer), 'creator_paid_delivery_unavailable');
    });
    await add('UNPUBLISHED blocks new sales/public preview but fulfills frozen paid orders', async () => {
      await repository.unpublish(state.first.workId, 'creator', state.account.creatorId);
      assert.equal((await repository.adminWorks('UNPUBLISHED'))[0].workId, state.first.workId);
      assert.ok(!(await service.publicWorks(0)).some(work => work.workId === state.first.workId));
      await reject(() => runtime.resolvePaidWorks([state.first.workId], state.revisions), 'creator_work_not_found');
      await reject(() => service.image(state.uploaded.versionId, 'sprite.png', { audience: 'public' }), 'creator_work_not_found');
      await runtime.authorizePaidItems([state.lines[1]]);
      verifyPack(await runtime.buildPaidPack(state.lines[1], state.delivery, signer), state.published[0]);
    });
    await add('SUSPENDED work refuses order authorization and delivery without COS read', async () => {
      await repository.unpublish(state.first.workId, 'admin', 'fictional-local-admin', true, 'Fictional local suspension');
      assert.ok((await repository.adminWorks('SUSPENDED')).some(work => work.workId === state.first.workId));
      const before = cos.reads.length;
      await reject(() => runtime.authorizePaidItems([state.lines[1]]), 'creator_paid_delivery_unavailable');
      await reject(() => runtime.buildPaidPack(state.lines[1], state.delivery, signer), 'creator_paid_delivery_unavailable');
      assert.equal(cos.reads.length, before);
    });
    await add('legacy free publication/consent is discoverable but not purchasable or deliverable', async () => {
      const legacy = await publish('legacy-free');
      const old = { titleZh: 'Fictional legacy free publication', description: 'Old free consent, not paid consent.',
        tags: [], priceFen: 0, sharingTermsVersion: 'creator-free-sharing-v1', acceptFreeSharing: true };
      await pool.execute('UPDATE gongde_creator_works SET price_fen = 0, published_metadata_json = ? WHERE work_id = ?', [JSON.stringify(old), legacy.work.workId]);
      await pool.execute('UPDATE gongde_creator_work_versions SET approved_metadata_json = ? WHERE version_id = ?', [JSON.stringify(old), legacy.uploaded.versionId]);
      await pool.execute('UPDATE gongde_creator_reviews SET metadata_snapshot_json = ? WHERE review_id = ?', [JSON.stringify(old), legacy.submitted.reviewId]);
      const publicWork = await service.publicWork(legacy.work.workId);
      assert.equal(publicWork.priceFen, 0); assert.equal(publicWork.purchasable, false);
      const count = Number((await one('SELECT COUNT(*) AS n FROM gongde_orders')).n);
      await reject(() => runtime.resolvePaidWorks([legacy.work.workId], { [legacy.work.workId]: legacy.uploaded.revision }), 'market_catalog_snapshot_invalid');
      await reject(() => orders.createPendingOrder({ channel: 'wechat', purchaseKind: 'appearance-batch', assetIds: [legacy.work.workId] }), 'asset_id_not_available');
      assert.equal(Number((await one('SELECT COUNT(*) AS n FROM gongde_orders')).n), count);
      // Also reject a paid-looking approved version backed only by a legacy review.
      await pool.execute('UPDATE gongde_creator_work_versions SET approved_metadata_json = ? WHERE version_id = ?',
        [JSON.stringify({ ...old, priceFen: 20, sharingTermsVersion: terms, acceptPaidDistribution: true }), legacy.uploaded.versionId]);
      await reject(() => repository.authorizePaidVersion(state.account.creatorId, legacy.work.workId,
        legacy.uploaded.versionId, legacy.uploaded.revision), 'creator_paid_delivery_unavailable');
    });
    await add('no creator settlements/payouts / only local MySQL network and memory COS', async () => {
      for (const table of ['gongde_creator_royalty_ledger', 'gongde_creator_settlements', 'gongde_creator_payouts'])
        assert.equal(Number((await one(`SELECT COUNT(*) AS n FROM ${table}`)).n), 0);
      assert.equal(io.forbiddenIoAttempts, 0); assert.ok(io.localTcpConnectAttempts > 0);
      assert.ok(cos.writes > 0 && cos.reads.length > 0);
    });
  } catch (error) {
    fatal = { code: error.code ?? error.name, detail: redact(error.message).slice(0, 1600) };
  } finally {
    if (runtime) await runtime.close().catch(() => { fatal ??= { code: 'RUNTIME_CLOSE_FAILED' }; });
    if (repository) await repository.close().catch(() => { fatal ??= { code: 'POOL_CLOSE_FAILED' }; });
    else if (pool) await pool.end().catch(() => { fatal ??= { code: 'POOL_CLOSE_FAILED' }; });
    mock.restoreAll();
    if (keyFile) await rm(keyFile, { force: true });
    clearTimeout(timer);
    const receipt = { evidence: 'ACTUAL_LOCAL_MYSQL_8_4_COMPILED_PRODUCT_WITH_MEMORY_FAKE_COS',
      notEvidenceFor: ['real COS', 'HTTP/browser', 'real payment/provider', 'native import', 'production'],
      mysqlVersion: state.mysqlVersion ?? null, passed: cases.filter(item => item.status === 'PASS').length,
      failed: cases.filter(item => item.status === 'FAIL').length, cases, fatal,
      io, ephemeralSigningKeyRemoved: true, completedAt: new Date().toISOString() };
    await writeFile(path.join(artifact, 'mysql-suite.json'), JSON.stringify(receipt, null, 2) + '\n', { mode: 0o600 });
    process.stdout.write(JSON.stringify({ passed: receipt.passed, failed: receipt.failed, fatal }) + '\n');
    if (fatal || receipt.failed || cases.length !== 12) process.exitCode = 1;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await runSuite().catch(error => {
    process.stderr.write(JSON.stringify({ status: 'NOT_EXECUTED_OR_FATAL', code: error.code ?? error.name }) + '\n');
    process.exitCode = 78;
  });
}
