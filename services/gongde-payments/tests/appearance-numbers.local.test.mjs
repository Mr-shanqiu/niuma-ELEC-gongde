import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { once } from 'node:events';

const build = process.env.GONGDE_NUMBER_TEST_BUILD;
if (!build?.startsWith('file:')) throw new Error('explicit_isolated_build_required');
const { normalizeAppearanceNumber, AppearanceNumberRepository, registerCommunityAppearanceNumber } =
  await import(new URL('domain/appearance-numbers.js', build));
const { queryAppearanceNumber } = await import(new URL('domain/appearance-number-query.js', build));
const { OFFICIAL_ASSET_IDS } = await import(new URL('domain/catalog.js', build));
const { FreeCreatorRepository } = await import(new URL('creators/repository.js', build));
const { FreeCreatorService } = await import(new URL('creators/free-service.js', build));
const { AdminObjectStore } = await import(new URL('admin/object-store.js', build));

const creatorId = 'a'.repeat(32), workId = `creator.${creatorId}.fixture`;
const official = { appearanceNumber: '100001', sourceKind: 'official', internalId: 'official.lucky-cat' };
const community = { appearanceNumber: '100020', sourceKind: 'community', internalId: workId };
const fails = (code, status) => error => error.code === code && error.status === status;
const dependencies = (item = official, changes = {}) => ({
  find: async () => item,
  officialState: async () => ({ state: 'PUBLISHED', revision: 'b'.repeat(64) }),
  communityWork: async () => ({ appearanceNumber: '100020', titleZh: 'Approved title', state: 'PUBLISHED' }),
  ...changes
});
const row = changes => ({ work_id: workId, creator_id: creatorId, slug: 'fixture', title_zh: 'Private draft title',
  description: 'Private draft description', tags_json: [], price_fen: 20, state: 'PUBLISHED', appearance_serial: 100020,
  published_version_id: 'b'.repeat(32), published_metadata_json: { titleZh: 'Approved title', description: 'Approved description',
    tags: [], creatorName: 'Approved author', acceptPaidDistribution: true, sharingTermsVersion: 'creator-paid-distribution-v1',
    priceFen: 20 }, created_at: new Date(), updated_at: new Date(), ...changes });

test('complete short numbers only, no order/access-code interpretation or leading-zero alias', () => {
  assert.equal(normalizeAppearanceNumber(' 100001 '), '100001');
  assert.equal(normalizeAppearanceNumber('999999999'), '999999999');
  for (const value of ['10000', '000001', '0100001', '100 001', '#100001', 'GD-100001', '1e5', '100000', '1000000000', '１００００１']) {
    assert.throws(() => normalizeAppearanceNumber(value), fails('appearance_number_invalid', 400));
  }
});

test('migration explicitly binds every current official internal ID without changing SKU/order tables', () => {
  const sql = readFileSync(new URL('../migrations/006_appearance_numbers.sql', import.meta.url), 'utf8');
  const pairs = [...sql.matchAll(/SELECT (100\d{3})(?: AS serial)?, '([^']+)'(?: AS asset_id)?/g)]
    .map(match => [match[2], match[1]]);
  assert.equal(pairs.length, 19);
  assert.deepEqual(new Set(pairs.map(([id]) => id)), new Set(OFFICIAL_ASSET_IDS));
  assert.equal(new Set(pairs.map(([, number]) => number)).size, 19);
  assert.equal(new Map(pairs).get('zqscreen.redpanda-wave'), '100006');
  assert.equal(new Map(pairs).get('zqscreen.kiss-couple'), '100015');
  assert.equal(new Map(pairs).get('zqscreen.zhuan-yun-bead'), '100018');
  assert.match(sql, /UNIQUE KEY uq_gongde_appearance_identity \(source_kind, internal_id\)/);
  assert.match(sql, /appearance_serial BETWEEN 100001 AND 999999999/);
  const backfill = sql.slice(sql.lastIndexOf('INSERT INTO gongde_appearance_numbers'));
  assert.match(backfill, /WHERE NOT EXISTS/);
  assert.doesNotMatch(backfill, /w\.state|PUBLISHED|REJECTED/);
  assert.doesNotMatch(sql, /(?:ALTER|UPDATE|DELETE FROM) gongde_(?:orders|entitlements|creator_works)/);
});

test('registry reads are parameterized and never allocate, including concurrent/repeated lookups', async () => {
  const calls = [];
  const repository = new AppearanceNumberRepository({}, { execute: async (sql, values) => {
    calls.push({ sql, values }); return [[{ appearance_serial: 100001, source_kind: 'official', internal_id: official.internalId }]];
  } });
  const results = await Promise.all(Array.from({ length: 12 }, () => repository.find('100001')));
  assert.ok(results.every(result => result.appearanceNumber === '100001'));
  assert.ok(calls.every(call => call.sql.startsWith('SELECT') && call.values[0] === '100001'));
  assert.deepEqual(await repository.officialNumbers([official.internalId]), { [official.internalId]: '100001' });
});

test('missing tables/bindings fail closed and database messages never reach number callers', async () => {
  const repository = new AppearanceNumberRepository({}, { execute: async () => { throw new Error('private db detail'); } });
  await assert.rejects(repository.find('100001'), fails('appearance_numbers_unavailable', 503));
  const missing = new AppearanceNumberRepository({}, { execute: async () => [[]] });
  assert.equal(await missing.find('100020'), null);
  await assert.rejects(missing.officialNumbers(OFFICIAL_ASSET_IDS), fails('appearance_numbers_unavailable', 503));
});

test('official lookup authorizes current publication and source revision, not registry existence', async () => {
  assert.equal((await queryAppearanceNumber('100001', dependencies())).internalId, official.internalId);
  for (const state of ['UNPUBLISHED', 'MISSING']) {
    await assert.rejects(queryAppearanceNumber('100001', dependencies(official, {
      officialState: async () => ({ state, revision: null })
    })), fails('appearance_not_found', 404));
    assert.equal((await queryAppearanceNumber('100001', dependencies(official, {
      officialState: async () => ({ state, revision: null })
    }), true)).sharePath, null);
  }
  await assert.rejects(queryAppearanceNumber('100001', dependencies(official, {
    officialState: async () => ({ state: 'PUBLISHED', revision: null })
  })), fails('appearance_not_found', 404));
  await assert.rejects(queryAppearanceNumber('100001', dependencies({ ...official, internalId: 'not-registered' })), fails('appearance_not_found', 404));
});

test('unknown, draft, rejected, unpublished and suspended number requests share a non-disclosing 404', async () => {
  await assert.rejects(queryAppearanceNumber('100020', dependencies(null)), fails('appearance_not_found', 404));
  for (const state of ['DRAFT', 'REJECTED', 'UNPUBLISHED', 'SUSPENDED']) {
    const current = { appearanceNumber: '100020', titleZh: 'Private title', state };
    await assert.rejects(queryAppearanceNumber('100020', dependencies(community, {
      communityWork: async () => current
    })), fails('appearance_not_found', 404));
    const admin = await queryAppearanceNumber('100020', dependencies(community, { communityWork: async (_id, permitted) => {
      assert.equal(permitted, true); return current;
    } }), true);
    assert.equal(admin.appearanceNumber, '100020'); assert.equal(admin.sharePath, null);
  }
});

test('community service checks published authority and emits approved metadata and permanent number only', async () => {
  const calls = [];
  const repository = new FreeCreatorRepository({}, { execute: async (sql, values) => {
    calls.push({ sql, values });
    if (sql.includes('SELECT w.*')) return [[row()]];
    return [[{ version_id: 'b'.repeat(32), work_id: workId, creator_id: creatorId, slug: 'fixture',
      version_label: '2.0.0', state: 'APPROVED', source_revision: 'b'.repeat(64), archive_sha256: 'c'.repeat(64),
      source_object_key: 'private-source', preview_object_key: 'private-preview', source_manifest_json: {},
      validation_json: { imageNames: ['preview.png'] }, approved_metadata_json: {},
      delivery_bytes_upper_bound: 1000, created_at: new Date() }]];
  } });
  const result = await new FreeCreatorService(repository, {}).publicWork(workId);
  assert.equal(result.appearanceNumber, '100020');
  assert.equal(result.metadata.titleZh, 'Approved title');
  assert.equal(result.purchasable, true);
  assert.equal(result.sharePath, '/community.html?number=100020');
  const authorization = calls[0].sql;
  for (const gate of ["w.state = 'PUBLISHED'", "c.state = 'ACTIVE'", 'published_metadata_json IS NOT NULL', 'gongde_appearance_numbers']) {
    assert.ok(authorization.includes(gate));
  }
  assert.ok(calls.some(call => call.sql.includes('gongde_creator_work_versions')));
  const rejectedVersion = new FreeCreatorRepository({}, { execute: async sql => sql.includes('SELECT w.*')
    ? [[row()]] : [[{ version_id: 'b'.repeat(32), work_id: workId, creator_id: creatorId, slug: 'fixture',
      version_label: '2.0.0', state: 'REJECTED', source_revision: 'b'.repeat(64), archive_sha256: 'c'.repeat(64),
      source_object_key: 'private-source', preview_object_key: 'private-preview', source_manifest_json: {},
      validation_json: { imageNames: ['preview.png'] }, approved_metadata_json: {},
      delivery_bytes_upper_bound: 1000, created_at: new Date() }]] });
  await assert.rejects(new FreeCreatorService(rejectedVersion, {}).publicWork(workId), fails('creator_work_not_found', 404));
  assert.doesNotMatch(JSON.stringify(result), /Private draft|private-source|private-preview/);
  const unavailable = new FreeCreatorRepository({}, { execute: async () => [[]] });
  await assert.rejects(unavailable.published(workId), fails('creator_work_not_found', 404));

  const adminQueries = [];
  const adminRepository = new FreeCreatorRepository({}, { execute: async sql => {
    adminQueries.push(sql); return [[row()]];
  } });
  const adminWorks = await adminRepository.adminWorks('PUBLISHED');
  assert.equal(adminWorks.length, 1);
  assert.equal(adminWorks[0].metadata.priceFen, 20);
  assert.doesNotMatch(adminQueries[0], /price_fen\s*=\s*0/u);

  const legacyMetadata = { titleZh: 'Approved legacy preview', description: 'Previously free approved work.', tags: [],
    creatorName: 'Approved author', priceFen: 0, sharingTermsVersion: 'creator-free-sharing-v1' };
  const legacyRepository = new FreeCreatorRepository({}, { execute: async sql => sql.includes('SELECT w.*')
    ? [[row({ price_fen: 0, published_metadata_json: legacyMetadata })]]
    : [[{ version_id: 'b'.repeat(32), work_id: workId, creator_id: creatorId, slug: 'fixture',
      version_label: '2.0.0', state: 'APPROVED', source_revision: 'b'.repeat(64), archive_sha256: 'c'.repeat(64),
      source_object_key: 'private-source', preview_object_key: 'private-preview', source_manifest_json: {},
      validation_json: { imageNames: ['preview.png'] }, approved_metadata_json: legacyMetadata,
      delivery_bytes_upper_bound: 1000, created_at: new Date() }]] });
  const legacyPreview = await new FreeCreatorService(legacyRepository, {}).publicWork(workId);
  assert.equal(legacyPreview.priceFen, 0);
  assert.equal(legacyPreview.purchasable, false);
});

test('allocation uses the creator transaction and a duplicate never gets a replacement number', async () => {
  const calls = [];
  const connection = {
    beginTransaction: async () => calls.push('begin'), commit: async () => calls.push('commit'),
    rollback: async () => calls.push('rollback'), release: () => calls.push('release'),
    execute: async (sql, values) => {
      calls.push(sql);
      if (sql.startsWith('SELECT state')) return [[{ state: 'ACTIVE' }]];
      if (sql.includes('COUNT(*)')) return [[{ total: 0 }]];
      if (sql.includes('SELECT next_serial')) {
        assert.match(sql, /FOR UPDATE/); return [[{ next_serial: 100020 }]];
      }
      if (sql.includes('INSERT INTO gongde_appearance_numbers')) {
        assert.deepEqual(values, [100020, workId]); return [{ affectedRows: 1 }];
      }
      if (sql.includes('UPDATE gongde_appearance_number_allocator')) {
        assert.deepEqual(values, [100021, 100020]); return [{ affectedRows: 1 }];
      }
      return [{ affectedRows: 1 }];
    }
  };
  const repository = new FreeCreatorRepository({}, { getConnection: async () => connection });
  const metadata = { titleZh: 'Fixture', description: 'Fixture description', tags: [] };
  await repository.createWork(creatorId, workId, 'fixture', metadata);
  assert.equal(calls[0], 'begin'); assert.ok(calls.includes('commit'));
  assert.ok(calls.findIndex(sql => sql.includes('INSERT INTO gongde_appearance_numbers')) <
    calls.findIndex(sql => sql.includes('INSERT INTO gongde_creator_works')));
  calls.length = 0;
  const execute = connection.execute;
  connection.execute = async (sql, values) => {
    if (sql.includes('INSERT INTO gongde_appearance_numbers')) { calls.push('duplicate'); throw Object.assign(new Error('duplicate'), { code: 'ER_DUP_ENTRY' }); }
    return execute(sql, values);
  };
  await assert.rejects(repository.createWork(creatorId, workId, 'fixture', metadata), { code: 'ER_DUP_ENTRY' });
  assert.ok(calls.includes('rollback')); assert.ok(!calls.includes('commit'));
  assert.ok(!calls.some(sql => sql.includes('INSERT INTO gongde_creator_works')));
});

test('changing work metadata and unpublishing does not update/delete/reallocate registry identities', async () => {
  const calls = [];
  const connection = { beginTransaction: async () => {}, commit: async () => {}, rollback: async () => {}, release() {},
    execute: async (sql) => { calls.push(sql); return sql.startsWith('SELECT') ? [[row()]] : [{ affectedRows: 1 }]; } };
  const repository = new FreeCreatorRepository({}, { getConnection: async () => connection });
  await repository.updateWork(creatorId, workId, { titleZh: 'Changed', description: 'Changed text', tags: [] });
  await repository.unpublish(workId, 'creator', creatorId);
  await repository.unpublish(workId, 'admin', 'local-admin', true, 'Fixture suspension');
  assert.ok(calls.some(sql => sql.startsWith('UPDATE gongde_creator_works')));
  assert.ok(!calls.some(sql => /(?:INSERT INTO|UPDATE|DELETE FROM) gongde_appearance_numbers/.test(sql)));
});

test('strict COS publication lookup does not fall back on missing, corrupt or invalid state', async () => {
  for (const payload of [null, '{broken', '{}', '{"publishedAssetIds":[42]}']) {
    const store = new AdminObjectStore({ bucket: 'fake', region: 'fake', publicBaseUrl: 'https://invalid.example' }, {
      getObject: (_request, callback) => payload === null ? callback(new Error('missing')) : callback(null, { Body: payload })
    });
    await assert.rejects(store.publishedAssetIdsStrict(OFFICIAL_ASSET_IDS));
  }
  const store = new AdminObjectStore({ bucket: 'fake', region: 'fake', publicBaseUrl: 'https://invalid.example' }, {
    getObject: (_request, callback) => callback(null, { Body: JSON.stringify({ publishedAssetIds: [official.internalId, 'unknown'] }) })
  });
  assert.deepEqual(await store.publishedAssetIdsStrict(OFFICIAL_ASSET_IDS), [official.internalId]);
});

test('loopback HTTP resolver exposes no private identity or metadata in errors and omits source keys', async () => {
  let visible = false;
  const server = createServer(async (request, response) => {
    try {
      const number = new URL(request.url, 'http://localhost').searchParams.get('number');
      const appearance = await queryAppearanceNumber(number, dependencies(community, { communityWork: async () => {
        if (!visible) throw Object.assign(new Error('private title and private object key'), { status: 404 });
        return { appearanceNumber: '100020', titleZh: 'Approved title', state: 'PUBLISHED', secret: 'must-not-escape' };
      } }));
      response.writeHead(200, { 'content-type': 'application/json' }); response.end(JSON.stringify({ appearance }));
    } catch (error) { response.writeHead(error.status ?? 503); response.end(JSON.stringify({ error: error.code })); }
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  try {
    const base = `http://127.0.0.1:${server.address().port}`;
    const unavailable = await fetch(`${base}/?number=100020`);
    assert.equal(unavailable.status, 404); assert.deepEqual(await unavailable.json(), { error: 'appearance_not_found' });
    visible = true;
    const response = await fetch(`${base}/?number=100020`);
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.appearance.sharePath, '/community.html?number=100020');
    assert.doesNotMatch(JSON.stringify(body), /must-not-escape|secret|private/);
  } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
});
