// Real mysql2 sessions + current compiled repository. Synthetic data only.
// SQL/DDL may execute only in the new runner-owned loopback test database.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, writeFile, readdir } from 'node:fs/promises';
import { installLocalOnlyIoBoundary, sourceFixture } from './free-creator-mysql-fixtures.local.mjs';

assert.equal(process.env.GONGDE_NUMBERING_LOCAL_MYSQL_APPROVED, '1');
const receiptRoot = process.env.GONGDE_NUMBER_TEST_RECEIPT_ROOT;
assert.match(receiptRoot ?? '', /^\/private\/tmp\/gongde-numbering-local-[A-Za-z0-9]+$/u);
const build = process.env.GONGDE_NUMBER_TEST_BUILD;
assert.equal(build, new URL('build/', 'file://' + receiptRoot + '/').href);
const database = process.env.GONGDE_NUMBER_TEST_DATABASE, port = Number(process.env.GONGDE_NUMBER_TEST_PORT);
assert.match(database ?? '', /^gongde_numbering_local_[a-f0-9]{16}$/u);
assert.ok(Number.isInteger(port) && port >= 10000 && port <= 65535);
const password = process.env.GONGDE_NUMBER_TEST_PASSWORD;
assert.match(password ?? '', /^[a-f0-9]{48}$/u);
const target = { host: '127.0.0.1', port, database, user: 'numbering_local', password };
const io = installLocalOnlyIoBoundary(target);
const { createPool } = await import('mysql2/promise');
const { FreeCreatorRepository } = await import(new URL('creators/repository.js', build));
const { OFFICIAL_ASSET_IDS } = await import(new URL('domain/catalog.js', build));
const { AppearanceNumberRepository } = await import(new URL('domain/appearance-numbers.js', build));
const options = { ...target, connectionLimit: 4, queueLimit: 48, waitForConnections: true,
  connectTimeout: 2000, timezone: 'Z', charset: 'utf8mb4', multipleStatements: false };
const pool = createPool(options), secondPool = createPool(options);
const repository = new FreeCreatorRepository({}, pool), secondRepository = new FreeCreatorRepository({}, secondPool);
const numbers = new AppearanceNumberRepository({}, pool);
const rows = async (sql, values = [], connection = pool) => (await connection.execute({ sql, timeout: 3000 }, values))[0];
const one = async (sql, values = [], connection = pool) => {
  const found = await rows(sql, values, connection); assert.equal(found.length, 1); return found[0];
};
const hash = value => createHash('sha256').update(typeof value === 'string' ? value : JSON.stringify(value)).digest('hex');
const checked = [], migrationReceipts = [], expectedConflicts = [];
let stage = 'actual_engine_identity', failure = null, mysqlVersion = null, legacyBefore, legacyAfter;
let concurrency = null, bindings = null, partialRetry = null, schema = null;
const at = new Date('2026-10-05T01:00:00.000Z');
const accounts = ['1', '2', '3', '4'].map(character => ({ creatorId: character.repeat(32),
  username: 'numbering_fixture_' + character, displayName: 'Local Fixture ' + character,
  passwordHash: 'LOCAL_SYNTHETIC_NOT_LOGIN_HASH', recoveryDigest: null, state: 'ACTIVE' }));
const metadata = { titleZh: 'Local numbering fixture', description: 'Synthetic local numbering test only.',
  tags: ['local'], priceFen: 0, sharingTermsVersion: 'creator-free-sharing-v1' };
const workId = (account, slug) => 'creator.' + account.creatorId + '.' + slug;
const count = async table => Number((await one('SELECT COUNT(*) AS total FROM ' + table)).total);
const registryRows = () => rows('SELECT appearance_serial, source_kind, internal_id FROM gongde_appearance_numbers ORDER BY appearance_serial');
const counts = async () => ({ numbers: await count('gongde_appearance_numbers'), works: await count('gongde_creator_works'),
  audit: await count('gongde_creator_audit') });
const paidTables = ['gongde_orders', 'gongde_entitlements', 'gongde_access_accounts', 'gongde_market_order_items',
  'gongde_creator_royalty_ledger', 'gongde_creator_settlements', 'gongde_creator_settlement_entries', 'gongde_creator_payouts'];
async function snapshotPaid() {
  const result = {};
  for (const table of paidTables) {
    const [definition] = await rows('SHOW CREATE TABLE ' + table);
    const data = await rows('SELECT * FROM ' + table);
    const canonical = data.map(entry => JSON.stringify(entry)).sort();
    result[table] = { count: data.length, schemaSha256: hash(definition['Create Table']), rowsSha256: hash(canonical) };
  }
  return result;
}
async function applyStatements(statements, connection = pool) {
  const session = connection === pool ? await pool.getConnection() : connection;
  try {
    await session.beginTransaction();
    for (const sql of statements) await rows(sql, [], session);
    await session.commit();
  } catch (error) { await session.rollback(); throw error; }
  finally { if (connection === pool) session.release(); }
}
async function saveVersion(owner, slug, index) {
  const fixture = sourceFixture({ creatorId: owner.creatorId, slug }, { version: `${index}.0.0`, pixel: 80 + index });
  const version = { versionId: hash(workId(owner, slug) + ':' + index).slice(0, 32), workId: workId(owner, slug),
    creatorId: owner.creatorId, slug, versionLabel: fixture.manifest.version, state: 'READY',
    revision: hash(fixture.archive), archiveSha256: hash(fixture.archive), sourceObjectKey: 'local-fixture/source',
    previewObjectKey: 'local-fixture/preview', manifest: fixture.manifest,
    validation: { imageNames: ['sprite.png'], archiveBytes: fixture.archive.length,
      unpackedBytes: 2048, decodedImageBytes: 16 }, approvedMetadata: null,
    deliveryBytesUpperBound: 4096, createdAt: at.toISOString() };
  await repository.saveVersion(owner.creatorId, version); return version;
}

try {
  const engine = await one('SELECT VERSION() AS version, DATABASE() AS db, @@sql_mode AS sql_mode');
  mysqlVersion = engine.version; assert.match(mysqlVersion, /^8\.4\./u); assert.equal(engine.db, database);
  await rows(`CREATE TABLE gongde_schema_migrations (filename VARCHAR(128) NOT NULL PRIMARY KEY,
    applied_at DATETIME(3) NOT NULL) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci`);
  const names = await readdir(new URL('../migrations/', import.meta.url));
  const migrations = [];
  for (let index = 1; index <= 6; index += 1) {
    const prefix = String(index).padStart(3, '0') + '_';
    const matching = names.filter(name => name.startsWith(prefix) && name.endsWith('.sql'));
    assert.equal(matching.length, 1);
    const sql = await readFile(new URL('../migrations/' + matching[0], import.meta.url), 'utf8');
    const statements = sql.split(/;\s*(?:\n|$)/u).map(value => value.trim()).filter(Boolean);
    migrations.push({ name: matching[0], sql, statements });
    migrationReceipts.push({ filename: matching[0], sha256: hash(sql), statements: statements.length });
  }
  stage = 'apply_001_through_005_to_empty_owned_database';
  for (const migration of migrations.slice(0, 5)) {
    await applyStatements(migration.statements);
    await rows('INSERT INTO gongde_schema_migrations (filename, applied_at) VALUES (?, ?)', [migration.name, at]);
  }
  checked.push('actual_001_005_schema');
  stage = 'seed_historical_states_and_nonempty_paid_tables';
  for (const account of accounts) await repository.createAccount(account, 'creator-free-sharing-v1', 'd'.repeat(64));
  const legacy = [
    { slug: 'legacy-draft', state: 'DRAFT', versionState: 'READY' },
    { slug: 'legacy-published', state: 'PUBLISHED', versionState: 'APPROVED' },
    { slug: 'legacy-unpublished', state: 'UNPUBLISHED', versionState: 'APPROVED' },
    { slug: 'legacy-suspended', state: 'SUSPENDED', versionState: 'SUSPENDED' },
    { slug: 'legacy-rejected', state: 'DRAFT', versionState: 'REJECTED' }
  ];
  for (const item of legacy) {
    const id = workId(accounts[0], item.slug), versionId = hash(id).slice(0, 32);
    await rows(`INSERT INTO gongde_creator_works (work_id, creator_id, slug, title_zh, description, tags_json,
      state, price_fen, published_version_id, published_metadata_json, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?)`,
    [id, accounts[0].creatorId, item.slug, metadata.titleZh, metadata.description, '[]', item.state,
      item.state === 'DRAFT' ? null : versionId, item.state === 'DRAFT' ? null : JSON.stringify(metadata), at, at]);
    await rows(`INSERT INTO gongde_creator_work_versions (version_id, work_id, version_label, source_revision,
      archive_sha256, source_object_key, preview_object_key, source_manifest_json, validation_json, state,
      schema_version, archive_bytes, unpacked_bytes, decoded_image_bytes, delivery_bytes_upper_bound, created_at)
      VALUES (?, ?, '1.0.0', ?, ?, 'local-source', 'local-preview', '{}', '{}', ?, 1, 100, 100, 16, 1000, ?)`,
    [versionId, id, hash(id), hash('archive:' + id), item.versionState, at]);
  }
  await rows(`INSERT INTO gongde_orders (order_no, product_id, product_version, channel, purchase_kind, user_id,
    asset_id, asset_ids_json, amount_fen, currency, state, buyer_token_digest, provider_transaction_id,
    created_at, expires_at, paid_at, fulfilled_at)
    VALUES ('LOCAL_OLD_ORDER', 'official-appearance-batch', 1, 'wechat', 'appearance-batch', 'LOCAL_ACCOUNT',
      'official.lucky-cat', '["official.lucky-cat"]', 20, 'CNY', 'FULFILLED', ?, 'LOCAL_OLD_TRANSACTION', ?, ?, ?, ?)`,
  ['c'.repeat(64), at, at, at, at]);
  await rows(`INSERT INTO gongde_entitlements (id, order_no, user_id, product_id, scope, asset_id, entitlement_key,
    state, created_at) VALUES ('LOCAL_OLD_ENTITLEMENT', 'LOCAL_OLD_ORDER', 'LOCAL_ACCOUNT', 'official-appearance-batch',
      'asset-download', 'official.lucky-cat', 'LOCAL_OLD_KEY', 'ACTIVE', ?)`, [at]);
  await rows(`INSERT INTO gongde_access_accounts (id, code_digest, code_hint, state, created_at)
    VALUES ('LOCAL_ACCOUNT', ?, 'FAKE', 'ACTIVE', ?)`, ['e'.repeat(64), at]);
  await rows(`INSERT INTO gongde_market_order_items (order_no, line_no, source_kind, asset_id, version_label,
    source_revision, title_zh, unit_price_fen, amount_fen, creator_share_bps, creator_amount_fen, platform_amount_fen, created_at)
    VALUES ('LOCAL_OLD_ORDER', 1, 'official', 'official.lucky-cat', '1.0.0', ?, 'Local old SKU fixture', 20, 20, 0, 0, 20, ?)`,
  ['f'.repeat(64), at]);
  await rows(`INSERT INTO gongde_creator_royalty_ledger (entry_id, creator_id, entry_kind, amount_fen,
    idempotency_key, revenue_rule_version, occurred_at, available_at)
    VALUES (?, ?, 'LOCAL_FIXTURE', 20, 'LOCAL_LEDGER_EVENT', 'LOCAL_RULE', ?, ?)`, ['a'.repeat(32), accounts[0].creatorId, at, at]);
  await rows(`INSERT INTO gongde_creator_settlements (settlement_id, creator_id, statement_period, revision_number,
    state, gross_creator_fen, withholding_fen, net_payout_fen, payout_account_reference, revenue_rule_version,
    statement_sha256, created_at) VALUES (?, ?, '2026-10', 1, 'DRAFT', 20, 0, 20, 'LOCAL_FIXTURE_ONLY', 'LOCAL_RULE', ?, ?)`,
  ['b'.repeat(32), accounts[0].creatorId, 'a'.repeat(64), at]);
  await rows(`INSERT INTO gongde_creator_settlement_entries (allocation_id, settlement_id, ledger_entry_id, state, created_at)
    VALUES (?, ?, ?, 'RESERVED', ?)`, ['c'.repeat(32), 'b'.repeat(32), 'a'.repeat(32), at]);
  await rows(`INSERT INTO gongde_creator_payouts (payout_id, settlement_id, payout_no, channel, state, amount_fen, created_at, updated_at)
    VALUES (?, ?, 'LOCAL_PAYOUT', 'LOCAL_FIXTURE', 'DRAFT', 20, ?, ?)`, ['d'.repeat(32), 'b'.repeat(32), at, at]);
  legacyBefore = await snapshotPaid(); assert.ok(Object.values(legacyBefore).every(value => value.count === 1));

  stage = '006_partial_official_seed_and_full_resume';
  const numbering = migrations[5]; assert.equal(numbering.statements.length, 5);
  await applyStatements(numbering.statements.slice(0, 2));
  assert.equal(await count('gongde_appearance_numbers'), 19);
  const initialOfficial = await registryRows();
  await applyStatements(numbering.statements);
  await rows('INSERT INTO gongde_schema_migrations (filename, applied_at) VALUES (?, ?)', [numbering.name, at]);
  assert.deepEqual((await registryRows()).filter(entry => entry.source_kind === 'official'), initialOfficial);
  assert.equal(await count('gongde_appearance_numbers'), 24);
  assert.equal((await one('SELECT next_serial FROM gongde_appearance_number_allocator WHERE allocator_id = 1')).next_serial, 100025);
  partialRetry = { durablePartialOfficialRows: 19, fullResumeRows: 24, officialBindingsUnchanged: true };
  const expected = [
    [100001, 'official.lucky-cat'], [100002, 'official.hamster-wheel'], [100003, 'official.sea-lion-belly-pat'],
    [100004, 'official.chick-pecking'], [100005, 'zqscreen.caishen-ingot'], [100006, 'zqscreen.redpanda-wave'],
    [100007, 'zqscreen.shiba-tilt'], [100008, 'zqscreen.orange-cat-wave'], [100009, 'zqscreen.raccoon-cheer'],
    [100010, 'zqscreen.golden-toad-coin'], [100011, 'zqscreen.little-jiangshi-hop'], [100012, 'zqscreen.frog-puff'],
    [100013, 'zqscreen.bee-flap'], [100014, 'zqscreen.koi-bubbles'], [100015, 'zqscreen.kiss-couple'],
    [100016, 'zqscreen.baodan-charm'], [100017, 'zqscreen.woodpecker-peck'], [100018, 'zqscreen.zhuan-yun-bead'],
    [100019, 'zqscreen.treasure-basin']
  ];
  assert.deepEqual(new Set(expected.map(([, id]) => id)), new Set(OFFICIAL_ASSET_IDS));
  const actualOfficial = (await registryRows()).filter(entry => entry.source_kind === 'official');
  assert.deepEqual(actualOfficial.map(entry => [entry.appearance_serial, entry.internal_id]), expected);
  bindings = actualOfficial;
  for (const item of legacy) assert.match((await repository.ownedWork(accounts[0].creatorId, workId(accounts[0], item.slug))).appearanceNumber, /^[1-9][0-9]{5,8}$/u);
  checked.push('official_19_exact_bindings', 'all_four_work_states_and_rejected_version_backfilled', 'partial_resume_no_rebinding');
  const stableRegistry = await registryRows();
  await applyStatements(numbering.statements); assert.deepEqual(await registryRows(), stableRegistry);
  checked.push('006_full_sql_retry_idempotent');

  stage = '006_conflicting_identity_or_number_must_fail';
  for (const conflict of ['number', 'identity']) {
    const connection = await pool.getConnection();
    try {
      await connection.beginTransaction();
      if (conflict === 'number') await rows("UPDATE gongde_appearance_numbers SET internal_id = 'fixture.conflict' WHERE appearance_serial = 100001", [], connection);
      else await rows('UPDATE gongde_appearance_numbers SET appearance_serial = 100700 WHERE appearance_serial = 100001', [], connection);
      await assert.rejects(rows(numbering.statements[1], [], connection), error => {
        expectedConflicts.push({ conflict, code: error.code, errno: error.errno });
        return error.code === 'ER_DUP_ENTRY' && error.errno === 1062;
      });
    } finally { await connection.rollback(); connection.release(); }
    assert.deepEqual(await registryRows(), stableRegistry);
  }
  checked.push('conflicts_not_swallowed_no_rebinding');

  stage = '24_actual_concurrent_createWork_calls_across_two_pools';
  const connections = await Promise.all([pool.getConnection(), pool.getConnection(), secondPool.getConnection(), secondPool.getConnection()]);
  let sessionIds;
  try { sessionIds = await Promise.all(connections.map(async connection => (await one('SELECT CONNECTION_ID() AS id', [], connection)).id)); }
  finally { connections.forEach(connection => connection.release()); }
  assert.equal(new Set(sessionIds).size, 4);
  const beforeConcurrent = await counts();
  const selections = Array.from({ length: 24 }, (_, index) => ({ owner: accounts[index % 4], slug: 'parallel-' + index }));
  const settled = await Promise.allSettled(selections.map((item, index) =>
    (index % 2 ? secondRepository : repository).createWork(item.owner.creatorId, workId(item.owner, item.slug), item.slug, metadata)));
  const rejected = settled.filter(item => item.status === 'rejected');
  concurrency = { calls: 24, fulfilled: 24 - rejected.length, rejected: rejected.length,
    independentMysqlSessions: new Set(sessionIds).size, rejectionCodes: rejected.map(item => item.reason?.code ?? 'UNKNOWN') };
  assert.equal(rejected.length, 0, JSON.stringify(concurrency));
  const committed = await Promise.all(selections.map(item => repository.ownedWork(item.owner.creatorId, workId(item.owner, item.slug))));
  assert.equal(new Set(committed.map(item => item.appearanceNumber)).size, 24);
  const oldNumbers = new Set(stableRegistry.map(item => String(item.appearance_serial)));
  assert.ok(committed.every(item => !oldNumbers.has(item.appearanceNumber)));
  assert.deepEqual(await counts(), { numbers: beforeConcurrent.numbers + 24, works: beforeConcurrent.works + 24, audit: beforeConcurrent.audit + 24 });
  concurrency.uniqueCommittedNumbers = 24; concurrency.numbers = committed.map(item => item.appearanceNumber).sort();
  checked.push('actual_concurrent_unique_transactional_allocation');

  stage = 'concurrent_duplicate_createWork_rollback';
  const duplicateBefore = await counts(), duplicateId = workId(accounts[1], 'duplicate-race');
  const duplicateWatermark = (await one('SELECT next_serial FROM gongde_appearance_number_allocator WHERE allocator_id = 1')).next_serial;
  const duplicateRace = await Promise.allSettled([repository, secondRepository].map(repo =>
    repo.createWork(accounts[1].creatorId, duplicateId, 'duplicate-race', metadata)));
  assert.equal(duplicateRace.filter(result => result.status === 'fulfilled').length, 1);
  assert.equal(duplicateRace.find(result => result.status === 'rejected').reason.code, 'ER_DUP_ENTRY');
  assert.deepEqual(await counts(), { numbers: duplicateBefore.numbers + 1, works: duplicateBefore.works + 1, audit: duplicateBefore.audit + 1 });
  const duplicateNumber = (await repository.ownedWork(accounts[1].creatorId, duplicateId)).appearanceNumber;
  const duplicateStable = await counts();
  for (const repo of [repository, secondRepository]) await assert.rejects(
    repo.createWork(accounts[1].creatorId, duplicateId, 'duplicate-race', metadata), { code: 'ER_DUP_ENTRY' });
  assert.deepEqual(await counts(), duplicateStable);
  assert.equal((await one('SELECT next_serial FROM gongde_appearance_number_allocator WHERE allocator_id = 1')).next_serial, duplicateWatermark + 1);
  assert.equal((await secondRepository.ownedWork(accounts[1].creatorId, duplicateId)).appearanceNumber, duplicateNumber);
  checked.push('concurrent_duplicate_one_winner_no_extra_work_or_registry_or_audit');

  stage = 'failure_after_number_allocation_rolls_back_both_records';
  const forcedBefore = await counts(), forcedId = workId(accounts[2], 'forced-rollback');
  const forcedWatermark = (await one('SELECT next_serial FROM gongde_appearance_number_allocator WHERE allocator_id = 1')).next_serial;
  await pool.query("CREATE TRIGGER numbering_local_work_failure BEFORE INSERT ON gongde_creator_works FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'LOCAL_FIXTURE_ROLLBACK'");
  try {
    await assert.rejects(repository.createWork(accounts[2].creatorId, forcedId, 'forced-rollback', metadata), { code: 'ER_SIGNAL_EXCEPTION' });
  } finally { await pool.query('DROP TRIGGER numbering_local_work_failure'); }
  assert.deepEqual(await counts(), forcedBefore);
  assert.equal((await one('SELECT next_serial FROM gongde_appearance_number_allocator WHERE allocator_id = 1')).next_serial, forcedWatermark);
  assert.equal((await rows('SELECT internal_id FROM gongde_appearance_numbers WHERE internal_id = ?', [forcedId])).length, 0);
  checked.push('real_rollback_after_registry_insert_no_orphan');

  stage = 'allocator_capacity_fails_closed_without_work_or_number';
  const exhaustedBefore = await counts();
  await rows('UPDATE gongde_appearance_number_allocator SET next_serial = 1000000000 WHERE allocator_id = 1');
  try {
    await assert.rejects(repository.createWork(accounts[2].creatorId, workId(accounts[2], 'capacity-exhausted'), 'capacity-exhausted', metadata),
      error => error.code === 'appearance_numbers_unavailable' && error.status === 503);
    assert.deepEqual(await counts(), exhaustedBefore);
    await applyStatements(numbering.statements);
    assert.equal((await one('SELECT next_serial FROM gongde_appearance_number_allocator WHERE allocator_id = 1')).next_serial, 1000000000);
  } finally {
    await rows('UPDATE gongde_appearance_number_allocator SET next_serial = ? WHERE allocator_id = 1', [forcedWatermark]);
  }
  checked.push('allocator_rollback_watermark_and_capacity_no_rewind');

  stage = 'updates_approved_versions_unpublish_republish_reject_suspend_keep_number';
  const owner = accounts[3], slug = 'stable-cycle', id = workId(owner, slug);
  await repository.createWork(owner.creatorId, id, slug, metadata);
  const permanentNumber = (await repository.ownedWork(owner.creatorId, id)).appearanceNumber;
  const approved = await saveVersion(owner, slug, 1);
  const review = await repository.submit(owner.creatorId, id, approved.versionId);
  await repository.decide('LOCAL_ADMIN', review, 'APPROVED', 'Synthetic fixture approval', { dataOnly: true, realPreview: true, contentAcceptable: true, rightsDeclaration: true });
  await repository.updateWork(owner.creatorId, id, { ...metadata, titleZh: 'Updated draft title' });
  assert.equal((await repository.published(id)).work.appearanceNumber, permanentNumber);
  await repository.unpublish(id, 'creator', owner.creatorId);
  await assert.rejects(repository.published(id), error => error.code === 'creator_work_not_found' && error.status === 404);
  assert.equal((await repository.ownedWork(owner.creatorId, id)).appearanceNumber, permanentNumber);
  await repository.republishWork(owner.creatorId, id, approved.versionId, approved.revision, approved.archiveSha256);
  const revised = await saveVersion(owner, slug, 2);
  const rejectedReview = await repository.submit(owner.creatorId, id, revised.versionId);
  await repository.decide('LOCAL_ADMIN', rejectedReview, 'REJECTED', 'Synthetic fixture rejection', { dataOnly: false });
  const afterRejection = await repository.published(id);
  assert.equal(afterRejection.work.appearanceNumber, permanentNumber);
  assert.equal(afterRejection.version.versionId, approved.versionId);
  assert.equal((await repository.getVersion(revised.versionId)).state, 'REJECTED');
  await repository.unpublish(id, 'admin', 'LOCAL_ADMIN', true, 'Synthetic fixture suspension');
  assert.equal((await repository.ownedWork(owner.creatorId, id)).appearanceNumber, permanentNumber);
  await assert.rejects(repository.published(id), error => error.code === 'creator_work_not_found' && error.status === 404);
  const rejectedSlug = 'first-rejected', rejectedId = workId(owner, rejectedSlug);
  await repository.createWork(owner.creatorId, rejectedId, rejectedSlug, metadata);
  const firstRejectedNumber = (await repository.ownedWork(owner.creatorId, rejectedId)).appearanceNumber;
  const firstRejectedVersion = await saveVersion(owner, rejectedSlug, 1);
  const firstRejectedReview = await repository.submit(owner.creatorId, rejectedId, firstRejectedVersion.versionId);
  await repository.decide('LOCAL_ADMIN', firstRejectedReview, 'REJECTED', 'Synthetic first-version rejection', { dataOnly: false });
  assert.equal((await repository.ownedWork(owner.creatorId, rejectedId)).appearanceNumber, firstRejectedNumber);
  await assert.rejects(repository.published(rejectedId), error => error.code === 'creator_work_not_found' && error.status === 404);
  const nextId = workId(owner, 'after-rejection');
  await repository.createWork(owner.creatorId, nextId, 'after-rejection', metadata);
  const nextNumber = (await repository.ownedWork(owner.creatorId, nextId)).appearanceNumber;
  assert.notEqual(nextNumber, permanentNumber); assert.notEqual(nextNumber, firstRejectedNumber);
  assert.equal((await numbers.find(permanentNumber)).internalId, id);
  assert.equal((await numbers.find(firstRejectedNumber)).internalId, rejectedId);
  checked.push('version_update_and_all_moderation_transitions_keep_permanent_number', 'rejected_and_suspended_numbers_not_reissued');

  stage = 'real_schema_uniqueness_and_legacy_paid_snapshot';
  const [definition] = await rows('SHOW CREATE TABLE gongde_appearance_numbers');
  schema = definition['Create Table']; await writeFile(receiptRoot + '/numbering-schema.sql', schema + ';\n', { mode: 0o600 });
  assert.match(schema, /ENGINE=InnoDB/); assert.match(schema, /UNIQUE KEY `uq_gongde_appearance_identity`/);
  assert.match(schema, /CHECK/); assert.match(schema, /999999999/);
  const engines = await rows('SELECT TABLE_NAME AS table_name, ENGINE AS engine FROM information_schema.tables WHERE table_schema = ?', [database]);
  assert.ok(engines.every(entry => entry.engine === 'InnoDB'));
  const invalidBefore = await count('gongde_appearance_numbers');
  await assert.rejects(rows("INSERT INTO gongde_appearance_numbers (appearance_serial, source_kind, internal_id) VALUES (99999, 'official', 'fixture.out-of-range')"), { code: 'ER_CHECK_CONSTRAINT_VIOLATED' });
  assert.equal(await count('gongde_appearance_numbers'), invalidBefore);
  legacyAfter = await snapshotPaid(); assert.deepEqual(legacyAfter, legacyBefore);
  assert.equal(await count('gongde_schema_migrations'), 6);
  assert.equal(await repository.ready(), true);
  checked.push('actual_innodb_unique_and_check_constraints', 'eight_nonempty_paid_tables_schema_and_rows_unchanged');
  assert.equal(io.forbiddenIoAttempts, 0);
} catch (error) {
  failure = { stage, code: error.code ?? 'ASSERTION_OR_RUNTIME_ERROR', errno: error.errno ?? null,
    message: String(error.message ?? error).split(password).join('[temporary-secret]').slice(0, 2000) };
} finally {
  await Promise.all([pool.end(), secondPool.end()]);
  const receipt = { evidence: 'ACTUAL_LOCAL_MYSQL_8_4_ONLY', succeeded: failure === null, completedAt: new Date().toISOString(),
    mysqlVersion, database, migrations: migrationReceipts, checked, bindings, partialRetry, expectedConflicts,
    concurrency, legacyBefore, legacyAfter, schemaSha256: schema ? hash(schema) : null,
    localTcpConnectAttempts: io.localTcpConnectAttempts, forbiddenIoAttempts: io.forbiddenIoAttempts,
    noCosCalls: true, noProductionMigration: true, noBrowserOrNativeAcceptance: true, failure };
  await writeFile(receiptRoot + '/mysql-test-receipt.json', JSON.stringify(receipt, null, 2) + '\n', { mode: 0o600 });
  console.log(JSON.stringify(receipt));
  if (failure) process.exitCode = 1;
}
