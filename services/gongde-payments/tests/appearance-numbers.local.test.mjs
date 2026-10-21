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
const consent = await import(new URL('creators/consent.js', build));

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
// Current free publication: price 0 and the v2 free terms, with the public text
// digest that hasCurrentFreeConsent() recomputes.
const approvedFreeMetadata = (changes = {}) => {
  const metadata = { titleZh: 'Approved title', description: 'Approved description', tags: [],
    creatorName: 'Approved author', priceFen: 0, acceptFreeDistribution: true, acceptAiContentReview: true,
    sharingTermsVersion: consent.FREE_CREATOR_TERMS_VERSION,
    sharingTermsSha256: consent.FREE_CREATOR_TERMS_SHA256,
    aiReviewTermsVersion: consent.FREE_CREATOR_AI_TERMS_VERSION,
    aiReviewTermsSha256: consent.FREE_CREATOR_AI_TERMS_SHA256, ...changes };
  metadata.publicTextSha256 = consent.creatorPublicTextDigest(metadata);
  return metadata;
};
const row = changes => ({ work_id: workId, creator_id: creatorId, slug: 'fixture', title_zh: 'Private draft title',
  description: 'Private draft description', tags_json: [], price_fen: 0, state: 'PUBLISHED', appearance_serial: 100020,
  published_version_id: 'b'.repeat(32), published_metadata_json: approvedFreeMetadata(),
  created_at: new Date(), updated_at: new Date(), ...changes });

test('complete short numbers only, no order/access-code interpretation or leading-zero alias', () => {
  assert.equal(normalizeAppearanceNumber(' 100001 '), '100001');
  assert.equal(normalizeAppearanceNumber('999999999'), '999999999');
  for (const value of ['10000', '000001', '0100001', '100 001', '#100001', 'GD-100001', '1e5', '100000', '1000000000', '１００００１']) {
    assert.throws(() => normalizeAppearanceNumber(value), fails('appearance_number_invalid', 400));
  }
});

// 006 is frozen: it bound the 19 official appearances that existed then and must
// keep doing exactly that, so a historical database reaches the same numbers.
test('migration 006 explicitly binds the 19 original official internal IDs without changing SKU/order tables', () => {
  const sql = readFileSync(new URL('../migrations/006_appearance_numbers.sql', import.meta.url), 'utf8');
  const pairs = [...sql.matchAll(/SELECT (100\d{3})(?: AS serial)?, '([^']+)'(?: AS asset_id)?/g)]
    .map(match => [match[2], match[1]]);
  assert.equal(pairs.length, 19);
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

// 011 adds the two appearances published after 006. It is a preparation artifact
// for an operation that already happened in production: it must be safe to run on
// an already-correct database, must refuse a conflicting binding instead of
// overwriting it, and must leave the allocator at or above MAX(serial)+1.
const bindingPairs = (sql, pattern) => [...sql.matchAll(pattern)].map(match => [match[1], match[2]]);
const migration011 = readFileSync(new URL('../migrations/011_official_number_bindings.sql', import.meta.url), 'utf8');
const migration006 = readFileSync(new URL('../migrations/006_appearance_numbers.sql', import.meta.url), 'utf8');
// The prose comments name the constructs this migration must not use, so check
// the statements themselves.
const migration011Statements = migration011.replace(/^\s*--.*$/gmu, '');
const seeded = bindingPairs(migration011Statements, /\((\d{6}), '([^']+)'\)/g).map(([number, id]) => [id, number]);
const cumulative = new Map([
  ...bindingPairs(migration006, /SELECT (100\d{3})(?: AS serial)?, '([^']+)'(?: AS asset_id)?/g)
    .map(([number, id]) => [id, number]),
  ...seeded
]);

test('the two migrations together bind every current official internal ID exactly once', () => {
  assert.equal(cumulative.size, OFFICIAL_ASSET_IDS.length);
  assert.deepEqual(new Set(cumulative.keys()), new Set(OFFICIAL_ASSET_IDS));
  assert.equal(new Set(cumulative.values()).size, OFFICIAL_ASSET_IDS.length);
  // Fixed mapping, not catalog order and not a title or slug.
  assert.equal(cumulative.get('official.offwork-button'), '100024');
  assert.equal(cumulative.get('official.wealth-button'), '100025');
  assert.equal(cumulative.get('official.lucky-cat'), '100001');
});

test('migration 011 inserts only missing bindings and fails closed on a conflict', () => {
  // The runner sends one statement at a time, so a stored program body would be
  // split into invalid fragments.
  assert.doesNotMatch(migration011Statements, /CREATE\s+(?:PROCEDURE|FUNCTION|TRIGGER)/i);
  // A conflict must surface as an error, never be swallowed.
  assert.doesNotMatch(migration011Statements, /INSERT\s+IGNORE|REPLACE\s+INTO/i);
  assert.doesNotMatch(migration011Statements, /UPDATE\s+gongde_appearance_numbers|DELETE\s+FROM\s+gongde_appearance_numbers/i);
  assert.doesNotMatch(migration011Statements, /gongde_(?:orders|entitlements|creator_works)/);
  // The one upsert is the allocator watermark; the binding table is insert-only.
  const upserts = migration011Statements.split(/;\s*(?:\n|$)/u).map(statement => statement.trim())
    .filter(statement => /ON DUPLICATE KEY UPDATE/i.test(statement))
    .map(statement => /INSERT INTO (\w+)/i.exec(statement)?.[1]);
  assert.deepEqual(upserts, ['gongde_appearance_number_allocator']);
  // Both conflict directions are guarded, and each guard's unique key names itself
  // in the ER_DUP_ENTRY message.
  assert.match(migration011, /uq_official_number_100024_100025_already_bound/);
  assert.match(migration011, /uq_official_offwork_wealth_bound_elsewhere/);
  assert.match(migration011, /n\.source_kind <> 'official' OR n\.internal_id <> s\.asset_id/);
  assert.match(migration011, /n\.source_kind = 'official' AND n\.internal_id = s\.asset_id/);
  // Only missing rows are inserted, so an exact existing pair is a no-op.
  const insert = migration011.slice(migration011.indexOf('INSERT INTO gongde_appearance_numbers'));
  assert.match(insert, /WHERE NOT EXISTS/);
  assert.match(insert, /n\.appearance_serial = s\.serial AND n\.source_kind = 'official' AND n\.internal_id = s\.asset_id/);
  // The watermark only moves forward, so a retry cannot rewind a live allocator.
  assert.match(migration011, /ON DUPLICATE KEY UPDATE next_serial = GREATEST\(next_serial,/);
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

// The fixture answers each of the repository's real reads. publicationState()
// now also requires the current free-consent evidence row and the approved
// review's checks, so the stub must serve those tables instead of returning a
// work row for every query.
function freeConsentEvidence(metadata = approvedFreeMetadata()) {
  return { version_id: 'b'.repeat(32), creator_id: creatorId, work_id: workId,
    terms_version: consent.FREE_CREATOR_TERMS_VERSION, terms_sha256: consent.FREE_CREATOR_TERMS_SHA256,
    ai_terms_version: consent.FREE_CREATOR_AI_TERMS_VERSION, ai_terms_sha256: consent.FREE_CREATOR_AI_TERMS_SHA256,
    source_revision: 'b'.repeat(64), archive_sha256: 'c'.repeat(64),
    public_text_sha256: metadata.publicTextSha256, review_id: 'd'.repeat(32),
    metadata_snapshot_json: metadata };
}
const approvedChecks = { dataOnly: true, realPreview: true, contentAcceptable: true, rightsDeclaration: true };
const versionRow = (state = 'APPROVED', metadata = approvedFreeMetadata()) => ({ version_id: 'b'.repeat(32),
  work_id: workId, creator_id: creatorId, slug: 'fixture', version_label: '2.0.0', state,
  source_revision: 'b'.repeat(64), archive_sha256: 'c'.repeat(64), source_object_key: 'private-source',
  preview_object_key: 'private-preview', source_manifest_json: {}, validation_json: { imageNames: ['preview.png'] },
  approved_metadata_json: metadata, delivery_bytes_upper_bound: 1000, created_at: new Date() });

test('community service checks published authority and emits approved metadata and permanent number only', async () => {
  const calls = [];
  const repository = new FreeCreatorRepository({}, { execute: async (sql, values) => {
    calls.push({ sql, values });
    if (sql.includes('SELECT w.*')) return [[row()]];
    if (sql.includes('gongde_creator_free_consents')) return [[freeConsentEvidence()]];
    if (sql.includes('FROM gongde_creator_reviews')) return [[{ metadata_snapshot_json: approvedFreeMetadata(),
      checks_json: approvedChecks }]];
    return [[versionRow()]];
  } });
  const result = await new FreeCreatorService(repository, {}).publicWork(workId);
  assert.equal(result.appearanceNumber, '100020');
  assert.equal(result.metadata.titleZh, 'Approved title');
  // Published free community work is not a paid product.
  assert.equal(result.purchasable, false);
  assert.equal(result.priceFen, 0);
  // sharePath now points at the unified appearance page, not the old community page.
  assert.equal(result.sharePath, '/appearance.html?number=100020');
  const authorization = calls[0].sql;
  for (const gate of ["w.state = 'PUBLISHED'", "c.state = 'ACTIVE'", 'published_metadata_json IS NOT NULL', 'gongde_appearance_numbers']) {
    assert.ok(authorization.includes(gate));
  }
  assert.ok(calls.some(call => call.sql.includes('gongde_creator_work_versions')));
  const rejectedVersion = new FreeCreatorRepository({}, { execute: async sql => {
    if (sql.includes('SELECT w.*')) return [[row()]];
    if (sql.includes('gongde_creator_free_consents')) return [[freeConsentEvidence()]];
    if (sql.includes('FROM gongde_creator_reviews')) return [[{ metadata_snapshot_json: approvedFreeMetadata(),
      checks_json: approvedChecks }]];
    return [[versionRow('REJECTED')]];
  } });
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
  assert.equal(adminWorks[0].metadata.priceFen, 0);
  assert.doesNotMatch(adminQueries[0], /price_fen\s*=\s*0/u);

  // A work that still carries the retired paid terms must not be published as a
  // paid product, and it no longer satisfies the current free-consent gate.
  const legacyMetadata = { titleZh: 'Approved legacy preview', description: 'Previously free approved work.', tags: [],
    creatorName: 'Approved author', priceFen: 0, sharingTermsVersion: 'creator-free-sharing-v1' };
  const legacyRepository = new FreeCreatorRepository({}, { execute: async sql => {
    if (sql.includes('SELECT w.*')) return [[row({ price_fen: 0, published_metadata_json: legacyMetadata })]];
    if (sql.includes('gongde_creator_free_consents')) return [[freeConsentEvidence(legacyMetadata)]];
    if (sql.includes('FROM gongde_creator_reviews')) return [[{ metadata_snapshot_json: legacyMetadata,
      checks_json: approvedChecks }]];
    return [[versionRow('APPROVED', legacyMetadata)]];
  } });
  await assert.rejects(new FreeCreatorService(legacyRepository, {}).publicWork(workId),
    fails('creator_work_not_found', 404));
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
  // A blanket row for every SELECT made the "pending review" probe look
  // non-empty and blocked the edit. Only the owned-work lookup returns a row;
  // the pending-review probe is empty, as it is for an editable draft.
  const connection = { beginTransaction: async () => {}, commit: async () => {}, rollback: async () => {}, release() {},
    execute: async (sql) => {
      calls.push(sql);
      if (!sql.startsWith('SELECT')) return [{ affectedRows: 1 }];
      if (sql.includes('PENDING_REVIEW')) return [[]];
      return [[row()]];
    } };
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
