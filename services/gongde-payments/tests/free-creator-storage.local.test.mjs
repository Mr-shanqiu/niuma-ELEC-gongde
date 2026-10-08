/** Local compiled-module tests with an explicit COS fake. Byte-stream fixtures,
 * not PNG decoder, live COS, database, native-client or production acceptance.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

process.env.CREATOR_SYSTEM_ENABLED = 'false';
process.env.CREATOR_PAID_SALES_ENABLED = 'false';
process.env.CREATOR_SETTLEMENT_ENABLED = 'false';
const { CreatorSourceStore } = await import('../dist/creators/object-store.js');
const { CREATOR_UPLOAD_LIMITS: limits } = await import('../dist/creators/policy.js');
const creatorId = '1'.repeat(32);
const hash = '2'.repeat(64);
const sdkMissingPolicy = { statusCode: 404, code: '404', ErrorStatus: 'Policy Not Found' };

function fixture(body, overrides = {}) {
  const calls = { acl: 0, policy: 0, read: 0 };
  const writes = [];
  const fake = {
    getBucketAcl(_parameters, callback) {
      calls.acl += 1;
      callback(null, overrides.acl ?? { ACL: 'private', Owner: { ID: 'local-owner' }, Grants: [] });
    },
    getBucketPolicy(_parameters, callback) {
      calls.policy += 1;
      if ('policyError' in overrides) callback(overrides.policyError);
      else if ('policy' in overrides) callback(null, { Policy: overrides.policy });
      else callback({ code: 'NoSuchBucketPolicy' });
    },
    putObject(parameters, callback) {
      writes.push(parameters);
      callback(overrides.writeError ?? null);
    },
    getObject({ Output }, callback) {
      calls.read += 1;
      Output.once('finish', () => callback(null, {}));
      Output.once('error', error => callback(error));
      Output.end(body);
    }
  };
  const store = new CreatorSourceStore({
    bucket: 'local-fake-never-connect', region: 'ap-shanghai',
    secretId: 'not-a-credential', secretKey: 'not-a-credential'
  }, fake);
  return { store, calls, writes };
}

const errorCode = expected => error => error.code === expected && error.status === 503;

function uploadFixture() {
  const archive = Buffer.from('local creator source fixture');
  return {
    archive,
    pack: {
      archiveSha256: createHash('sha256').update(archive).digest('hex'),
      manifest: { preview: 'preview.png' },
      files: new Map([['preview.png', Buffer.from('local preview byte-stream fixture')]])
    }
  };
}

test('image stream larger than the ZIP limit remains readable within unpacked budget', async () => {
  const body = Buffer.alloc(limits.archiveBytes + 1, 7);
  const { store, calls } = fixture(body);
  const result = await store.image(creatorId, hash, 'preview.png');
  assert.equal(result.length, body.length);
  assert.equal(result.compare(body), 0);
  assert.deepEqual(calls, { acl: 1, policy: 1, read: 1 });
});

test('image stream at exactly the unpacked limit remains readable', async () => {
  const body = Buffer.alloc(limits.unpackedBytes, 8);
  const { store } = fixture(body);
  assert.equal((await store.image(creatorId, hash, 'preview.png')).length, body.length);
});

test('image stream one byte above the unpacked limit is rejected', async () => {
  const { store } = fixture(Buffer.alloc(limits.unpackedBytes + 1));
  await assert.rejects(store.image(creatorId, hash, 'preview.png'), errorCode('creator_object_too_large'));
});

test('source archive still rejects one byte above its separate ZIP limit', async () => {
  const body = Buffer.alloc(limits.archiveBytes + 1);
  const sha = createHash('sha256').update(body).digest('hex');
  const { store } = fixture(body);
  await assert.rejects(store.source(creatorId, sha), errorCode('creator_object_too_large'));
});

test('source archive with a different digest is rejected after bounded reading', async () => {
  const { store } = fixture(Buffer.from('local byte-stream fixture'));
  await assert.rejects(store.source(creatorId, hash), errorCode('creator_source_integrity_failed'));
});

test('non-private bucket fails before any object read', async () => {
  const { store, calls } = fixture(Buffer.from('unused'), {
    acl: { ACL: 'public-read', Owner: { ID: 'local-owner' }, Grants: [] }
  });
  await assert.rejects(store.image(creatorId, hash, 'preview.png'), errorCode('creator_storage_not_private'));
  assert.equal(calls.read, 0);
  assert.equal(calls.policy, 0);
});

test('group grant is denied even when its grantee also claims the owner ID', async () => {
  const { store, calls } = fixture(Buffer.from('unused'), {
    acl: { ACL: 'private', Owner: { ID: 'local-owner' },
      Grants: [{ Grantee: { ID: 'local-owner', URI: 'local-fake-group' }, Permission: 'READ' }] }
  });
  await assert.rejects(store.image(creatorId, hash, 'preview.png'), errorCode('creator_storage_not_private'));
  assert.equal(calls.read, 0);
});

test('an allow bucket policy is denied before any object read', async () => {
  const { store, calls } = fixture(Buffer.from('unused'), {
    policy: { Statement: [{ Effect: 'Allow', Principal: '*', Action: '*', Resource: '*' }] }
  });
  await assert.rejects(store.image(creatorId, hash, 'preview.png'), errorCode('creator_storage_not_private'));
  assert.equal(calls.read, 0);
});

test('SDK explicit absent-policy response permits bounded image reading', async () => {
  const body = Buffer.from('local SDK absent-policy fixture');
  const { store, calls } = fixture(body, { policyError: sdkMissingPolicy });
  assert.deepEqual(await store.image(creatorId, hash, 'preview.png'), body);
  assert.deepEqual(calls, { acl: 1, policy: 1, read: 1 });
});

test('SDK nested explicit absent-policy response permits integrity-checked source reading', async () => {
  const body = Buffer.from('local nested SDK absent-policy fixture');
  const sha = createHash('sha256').update(body).digest('hex');
  const { store } = fixture(body, {
    policyError: { statusCode: 404, error: { code: '404', ErrorStatus: 'Policy Not Found' } }
  });
  assert.deepEqual(await store.source(creatorId, sha), body);
});

test('SDK explicit absent-policy response permits private source and preview writes', async () => {
  const { archive, pack } = uploadFixture();
  const { store, calls, writes } = fixture(Buffer.from('unused'), { policyError: sdkMissingPolicy });
  const result = await store.putSource(creatorId, archive, pack);
  const base = `creator-submissions/v1/${creatorId}/${pack.archiveSha256}`;
  assert.deepEqual(result, {
    sourceObjectKey: `${base}/source.nmgpack`,
    previewObjectKey: `${base}/images/preview.png`,
    imageNames: ['preview.png']
  });
  assert.equal(writes.length, 2);
  assert.deepEqual(writes.map(write => write.Key), [result.sourceObjectKey, result.previewObjectKey]);
  assert.deepEqual(writes[0].Body, archive);
  assert.deepEqual(writes[1].Body, pack.files.get('preview.png'));
  for (const write of writes) {
    assert.equal(write.ACL, 'private');
    assert.equal(write.CacheControl, 'private, no-store');
    assert.equal(write.ContentLength, write.Body.length);
  }
  assert.deepEqual(calls, { acl: 1, policy: 1, read: 0 });
});

for (const [label, policyError] of [
  ['bare 404', { statusCode: 404, code: '404' }],
  ['marker without normalized code', { statusCode: 404, ErrorStatus: 'Policy Not Found' }],
  ['missing bucket', { statusCode: 404, code: 'NoSuchBucket', ErrorStatus: 'Policy Not Found' }],
  ['nested missing bucket', {
    ...sdkMissingPolicy, error: { Code: 'NoSuchBucket' }
  }],
  ['nested lower-case missing bucket', {
    ...sdkMissingPolicy, error: { code: 'NoSuchBucket', ErrorStatus: 'Policy Not Found' }
  }],
  ['legacy marker with nested missing bucket', {
    statusCode: 404, code: 'NoSuchBucketPolicy', error: { Code: 'NoSuchBucket' }
  }],
  ['access denied', { statusCode: 403, code: 'AccessDenied', ErrorStatus: 'Access Denied' }],
  ['contradictory SDK status', { statusCode: 403, code: '404', ErrorStatus: 'Policy Not Found' }],
  ['contradictory legacy status', { statusCode: 403, code: 'NoSuchBucketPolicy' }],
  ['transport failure', { code: 'ETIMEDOUT' }],
  ['server failure', { statusCode: 500, code: '404', ErrorStatus: 'Policy Not Found' }],
  ['numeric rather than SDK code', { statusCode: 404, code: 404, ErrorStatus: 'Policy Not Found' }],
  ['conflicting root marker', {
    statusCode: 404, code: '404', ErrorStatus: 'Access Denied',
    error: { code: '404', ErrorStatus: 'Policy Not Found' }
  }]
]) {
  test(`policy ${label} blocks both reads and writes without replacing the error`, async () => {
    const { archive, pack } = uploadFixture();
    const { store, calls, writes } = fixture(Buffer.from('unused'), { policyError });
    await assert.rejects(store.image(creatorId, hash, 'preview.png'), error => error === policyError);
    await assert.rejects(store.putSource(creatorId, archive, pack), error => error === policyError);
    assert.equal(calls.read, 0);
    assert.equal(writes.length, 0);
  });
}

test('a non-private ACL blocks uploads even with an explicit absent-policy response', async () => {
  const { archive, pack } = uploadFixture();
  const { store, calls, writes } = fixture(Buffer.from('unused'), {
    acl: { ACL: 'public-read', Owner: { ID: 'local-owner' }, Grants: [] },
    policyError: sdkMissingPolicy
  });
  await assert.rejects(store.putSource(creatorId, archive, pack), errorCode('creator_storage_not_private'));
  assert.equal(calls.policy, 0);
  assert.equal(writes.length, 0);
});

test('an allow bucket policy blocks uploads before either object is written', async () => {
  const { archive, pack } = uploadFixture();
  const { store, writes } = fixture(Buffer.from('unused'), {
    policy: { Statement: [{ Effect: 'Allow', Principal: '*', Action: '*', Resource: '*' }] }
  });
  await assert.rejects(store.putSource(creatorId, archive, pack), errorCode('creator_storage_not_private'));
  assert.equal(writes.length, 0);
});

test('an upload failure is not retried and does not write the preview', async () => {
  const { archive, pack } = uploadFixture();
  const writeError = { code: 'local_write_failed' };
  const { store, calls, writes } = fixture(Buffer.from('unused'), {
    policyError: sdkMissingPolicy, writeError
  });
  await assert.rejects(store.putSource(creatorId, archive, pack), error => error === writeError);
  assert.equal(writes.length, 1);
  assert.equal(calls.read, 0);
});
