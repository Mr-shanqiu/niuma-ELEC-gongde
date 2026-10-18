// Bounded offline acceptance: no .env, credentials, database, Redis, COS or AI.
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { deflateSync } from 'node:zlib';
import { Readable } from 'node:stream';
import ts from 'typescript';
import { zipSync } from 'fflate';

// Import source in-place without writing shared dist or consulting runtime config.
registerHooks({
  resolve(specifier, context, next) {
    if (specifier.startsWith('.') && specifier.endsWith('.js') && context.parentURL?.startsWith(new URL('../src/', import.meta.url).href)) {
      return next(specifier.slice(0, -3) + '.ts', context);
    }
    return next(specifier, context);
  },
  load(url, context, next) {
    if (!url.endsWith('.ts')) return next(url, context);
    return { format: 'module', shortCircuit: true, source: ts.transpileModule(readFileSync(new URL(url), 'utf8'),
      { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText };
  }
});
process.env.GONGDE_CREATOR_AUTO_REVIEW_ENABLED = 'false';
process.env.GONGDE_FREE_DISTRIBUTION_ENABLED = 'false';
globalThis.fetch = async () => { throw new Error('EXTERNAL_NETWORK_FORBIDDEN'); };
const { parseCreatorMetadata, normalizeCreatorDouyinNumber } = await import('../src/creators/metadata.ts');
const consent = await import('../src/creators/consent.ts');
const { FreeCreatorRepository } = await import('../src/creators/repository.ts');
const { FreeCreatorService } = await import('../src/creators/free-service.ts');
const { FreeCreatorBatchDelivery } = await import('../src/creators/free-batch-delivery.ts');
const { CreatorPhoneAuth } = await import('../src/creators/phone-auth.ts');
const { creatorRememberMe, creatorSessionExpiry } = await import('../src/creators/auth.ts');
const { validateCreatorSourcePack } = await import('../src/creators/pack-validation.ts');
const { creatorSourceContentFingerprint } = await import('../src/creators/content-fingerprint.ts');
const { loadCreatorReviewSettings } = await import('../src/creators/auto-review.ts');
const { createFreeCreatorRouter } = await import('../src/creators/router.ts');

const cases = [];
const add = (name, run) => cases.push({ name, run });
const owner = 'a'.repeat(32), originalVersionId = 'b'.repeat(32), originalReviewId = 'c'.repeat(32);
const workId = `creator.${owner}.test-work`;
const creator = { creatorId: owner, username: '~phone_opaque', displayName: 'private-account-name',
  passwordHash: 'phone-only-v1', recoveryDigest: null, state: 'ACTIVE' };
const metadata = (number = 'old.user') => parseCreatorMetadata({ titleZh: 'Example', description: 'Local fixture',
  tags: ['sample'], creatorDouyinNumber: number });
const approved = (number = 'old.user') => {
  const data = metadata(number);
  return { ...data, acceptFreeDistribution: true, acceptAiContentReview: true,
    sharingTermsSha256: consent.FREE_CREATOR_TERMS_SHA256,
    aiReviewTermsVersion: consent.FREE_CREATOR_AI_TERMS_VERSION,
    aiReviewTermsSha256: consent.FREE_CREATOR_AI_TERMS_SHA256,
    publicTextSha256: consent.creatorPublicTextDigest(data) };
};
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
function crc(bytes) {
  let value = 0xffffffff;
  for (const byte of bytes) {
    value ^= byte;
    for (let n = 0; n < 8; n++) value = (value >>> 1) ^ ((value & 1) ? 0xedb88320 : 0);
  }
  return (value ^ 0xffffffff) >>> 0;
}
function chunk(type, body) {
  const data = Buffer.alloc(body.length + 12);
  data.writeUInt32BE(body.length); data.write(type, 4, 4, 'ascii'); body.copy(data, 8);
  data.writeUInt32BE(crc(data.subarray(4, data.length - 4)), data.length - 4);
  return data;
}
const header = Buffer.alloc(13);
header.writeUInt32BE(1); header.writeUInt32BE(1, 4); header[8] = 8; header[9] = 6;
const image = Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', header),
  chunk('IDAT', deflateSync(Buffer.from([0, 12, 23, 34, 255]))), chunk('IEND', Buffer.alloc(0))]);
const manifest = { id: workId, version: '1.0', name_zh: 'Example', name_en: 'Example', author: 'Material credit',
  publisher: 'community', review_id: 'pending', schema_version: 1, canvas_width: 240, canvas_height: 250,
  plus_y: 174, preview: 'sprite.png', layers: [{ image: 'sprite.png', frame: [0, 0, 1, 1], anchor: [0.5, 0.5],
    keyframes: [{ t: 0, x: 0, y: 0, rotation: 0, scale: 1, alpha: 1 }] }] };
const archive = Buffer.from(zipSync({ 'manifest.json': Buffer.from(JSON.stringify(manifest)), 'sprite.png': image },
  { level: 0, mtime: new Date('2020-01-01T00:00:00Z') }));
const pack = validateCreatorSourcePack(archive, { creatorId: owner, slug: 'test-work' });
const now = new Date('2026-10-08T00:00:00Z');

// SQL-boundary simulator, not proof of MySQL DDL or concurrent lock behavior.
class Database {
  constructor() {
    this.state = {
      work: { work_id: workId, creator_id: owner, slug: 'test-work', title_zh: 'Example', description: 'Local fixture',
        tags_json: '["sample"]', creator_douyin_number: 'old.user', price_fen: 0,
        sharing_terms_version: consent.FREE_CREATOR_TERMS_VERSION, appearance_serial: 100001,
        state: 'PUBLISHED', published_version_id: originalVersionId, published_metadata_json: JSON.stringify(approved()),
        first_published_at: now, created_at: now, updated_at: now },
      versions: [{ version_id: originalVersionId, work_id: workId, creator_id: owner, slug: 'test-work',
        version_label: '1.0', source_revision: pack.revision, archive_sha256: pack.archiveSha256,
        source_object_key: 'private/source', preview_object_key: 'private/image', source_manifest_json: JSON.stringify(manifest),
        validation_json: JSON.stringify({ imageNames: ['sprite.png'], archiveBytes: archive.length, unpackedBytes: pack.unpackedBytes,
          decodedImageBytes: pack.decodedImageBytes }), delivery_bytes_upper_bound: pack.deliveryBytesUpperBound,
        schema_version: 1, state: 'APPROVED', approved_metadata_json: JSON.stringify(approved()), created_at: now }],
      reviews: [{ review_id: originalReviewId, version_id: originalVersionId, work_id: workId, appearance_serial: 100001,
        state: 'APPROVED', review_round: 1, metadata_snapshot_json: JSON.stringify(approved()), submitted_at: now,
        checks_json: JSON.stringify({ dataOnly: true, realPreview: true, contentAcceptable: true, rightsDeclaration: true }) }],
      consents: [{ consent_id: 'd'.repeat(32), version_id: originalVersionId, public_text_sha256: approved().publicTextSha256,
        creator_id: owner, work_id: workId, metadata_snapshot_json: JSON.stringify(approved()), review_id: originalReviewId,
        source_revision: pack.revision, archive_sha256: pack.archiveSha256 }],
      audit: [], rateBuckets: [], publicNumbers: [], nextSerial: 100001
    };
  }
  async getConnection() { return this; }
  async beginTransaction() { this.backup = structuredClone(this.state); }
  async commit() { this.backup = null; }
  async rollback() { this.state = this.backup; this.backup = null; }
  release() {}
  async end() {}
  async execute(raw, values = []) {
    const sql = raw.replace(/\s+/g, ' ').trim();
    const s = this.state, w = s.work;
    const rows = data => [data, []], write = () => [{ affectedRows: 1 }, []];
    if (sql.startsWith('SELECT w.*, n.appearance_serial')) {
      if (values[0] !== workId || (sql.includes('w.creator_id = ?') && values[1] !== owner) ||
          (sql.includes("w.state = 'PUBLISHED'") && w.state !== 'PUBLISHED')) return rows([]);
      return rows([w]);
    }
    if (sql.startsWith('SELECT version_id FROM gongde_creator_work_versions')) {
      return rows(s.versions.filter(v => v.work_id === values[0] && v.state === (sql.includes("state = 'READY'") ? 'READY' : 'PENDING_REVIEW')));
    }
    if (sql.startsWith('SELECT COUNT(*) AS total FROM gongde_creator_work_versions')) return rows([{ total: s.versions.length }]);
    if (sql.startsWith('SELECT COALESCE(MAX(review_round)')) {
      return rows([{ round: Math.max(0, ...s.reviews.filter(r => r.version_id === values[0]).map(r => r.review_round)) }]);
    }
    if (sql.startsWith('SELECT display_name, state FROM gongde_creators')) return rows([{ display_name: 'Creator C100001', state: 'ACTIVE' }]);
    if (sql.startsWith('SELECT state FROM gongde_creators')) return rows([{ state: 'ACTIVE' }]);
    if (sql.startsWith('SELECT creator_id FROM gongde_creators')) return rows(values[0] === owner ? [{ creator_id: owner }] : []);
    if (sql.startsWith('SELECT serial FROM gongde_free_creator_numbers')) return rows(s.publicNumbers.filter(n => n.creator_id === values[0]));
    if (sql.startsWith('SELECT next_serial FROM gongde_free_creator_number_allocator')) return rows([{ next_serial: s.nextSerial }]);
    if (sql.startsWith('INSERT INTO gongde_free_creator_numbers')) { s.publicNumbers.push({ creator_id: values[0], serial: values[1] }); return write(); }
    if (sql.startsWith('UPDATE gongde_free_creator_number_allocator')) { s.nextSerial = values[0]; return write(); }
    if (sql.startsWith('SELECT c.* FROM gongde_creators c JOIN gongde_creator_tokens')) return rows([{
      creator_id: owner, username: '~phone_' + owner.slice(0, 24), display_name: '作者 C' + owner,
      password_hash: 'phone-only-v1', recovery_digest: null, state: 'ACTIVE' }]);
    if (sql.startsWith('SELECT creator_id FROM gongde_creator_phone_identities')) return rows([{ creator_id: owner }]);
    if (sql.startsWith('SELECT * FROM gongde_creator_work_versions') || sql.startsWith('SELECT v.*, w.creator_id, w.slug')) {
      return rows(s.versions.filter(v => v.version_id === values[0] && (!sql.includes('AND work_id = ?') || v.work_id === values[1])));
    }
    if (sql.startsWith('SELECT state FROM gongde_creator_work_versions')) {
      return rows(s.versions.filter(v => v.version_id === values[0] && v.work_id === values[1]));
    }
    if (sql.startsWith('SELECT r.version_id, v.work_id FROM gongde_creator_reviews')) {
      return rows(s.reviews.filter(r => r.review_id === values[0]));
    }
    if (sql.startsWith('SELECT r.*, v.work_id, n.appearance_serial')) return rows(s.reviews.filter(r => r.review_id === values[0]));
    if (sql.startsWith('SELECT * FROM gongde_creator_reviews WHERE version_id')) {
      return rows(s.reviews.filter(r => r.version_id === values[0] && r.state === (sql.includes("state = 'APPROVED'") ? 'APPROVED' : 'PENDING')).slice(-1));
    }
    if (sql.startsWith('SELECT * FROM gongde_creator_reviews WHERE review_id')) return rows(s.reviews.filter(r => r.review_id === values[0]));
    if (sql.startsWith('SELECT * FROM gongde_creator_works')) return rows(values[0] === workId ? [w] : []);
    if (sql.startsWith('SELECT state FROM gongde_creator_works')) return rows(values[0] === workId && values[1] === owner ? [w] : []);
    if (sql.startsWith('SELECT consent_id FROM gongde_creator_free_consents')) {
      return rows(s.consents.filter(c => c.version_id === values[0] && c.public_text_sha256 === values[7]));
    }
    if (sql.startsWith('SELECT * FROM gongde_creator_free_consents')) return rows(s.consents.filter(c => c.version_id === values[0]));
    if (sql.startsWith('SELECT metadata_snapshot_json, checks_json FROM gongde_creator_reviews')) {
      return rows(s.reviews.filter(r => r.review_id === values[0] && r.version_id === values[1] && r.state === 'APPROVED'));
    }
    if (sql.startsWith('SELECT metadata_snapshot_json FROM gongde_creator_reviews')) {
      return rows(s.reviews.filter(r => r.review_id === values[0] && r.version_id === values[1] && r.state === 'APPROVED'));
    }
    if (sql.startsWith('SELECT w.state AS work_state, c.state AS creator_state')) {
      return rows(values[0] === workId && values[1] === owner ? [{ work_state: w.state, creator_state: 'ACTIVE' }] : []);
    }
    if (sql.startsWith('SELECT review_id FROM gongde_creator_reviews')) {
      return rows(s.reviews.filter(r => r.version_id === values[0] && r.state === 'APPROVED').slice(-1));
    }
    if (sql.startsWith('INSERT INTO gongde_creator_work_versions') && sql.includes('SELECT ?')) {
      const original = s.versions.find(v => v.version_id === values[2]);
      s.versions.push({ ...structuredClone(original), version_id: values[0], state: 'READY',
        approved_metadata_json: null, created_at: values[1] }); return write();
    }
    if (sql.startsWith('INSERT INTO gongde_creator_free_consents')) {
      s.consents.push({ consent_id: values[0], creator_id: values[1], work_id: values[2], version_id: values[3],
        public_text_sha256: values[8], metadata_snapshot_json: values[9], review_id: values[10],
        source_revision: values[11], archive_sha256: values[12] }); return write();
    }
    if (sql.startsWith('INSERT INTO gongde_creator_reviews')) {
      s.reviews.push({ review_id: values[0], version_id: values[1], work_id: workId, appearance_serial: 100001,
        review_round: values[2], state: 'PENDING', metadata_snapshot_json: values[3], submitted_at: values[4] }); return write();
    }
    if (sql.startsWith("UPDATE gongde_creator_work_versions SET state = 'PENDING_REVIEW'")) {
      s.versions.find(v => v.version_id === values[0]).state = 'PENDING_REVIEW'; return write();
    }
    if (sql.startsWith("UPDATE gongde_creator_work_versions SET state = 'REJECTED'")) {
      s.versions.find(v => v.version_id === values[0]).state = 'REJECTED'; return write();
    }
    if (sql.startsWith('UPDATE gongde_creator_work_versions SET state = ?, reviewed_at')) {
      Object.assign(s.versions.find(v => v.version_id === values[3]), { state: values[0], approved_metadata_json: values[2] }); return write();
    }
    if (sql.startsWith('UPDATE gongde_creator_works SET title_zh')) {
      Object.assign(w, { title_zh: values[0], description: values[1], tags_json: values[2], creator_douyin_number: values[3],
        sharing_terms_version: values[4], price_fen: 0, updated_at: values[5] }); return write();
    }
    if (sql.startsWith('UPDATE gongde_creator_works SET published_metadata_json')) {
      Object.assign(w, { published_metadata_json: values[0], price_fen: 0, sharing_terms_version: values[1], updated_at: values[2] }); return write();
    }
    if (sql.startsWith("UPDATE gongde_creator_works SET state = 'PUBLISHED'")) {
      Object.assign(w, { state: 'PUBLISHED', price_fen: 0, published_version_id: values[0],
        published_metadata_json: values[1], first_published_at: w.first_published_at ?? values[2], updated_at: values[3] }); return write();
    }
    if (sql.startsWith('UPDATE gongde_creator_works SET state = ?')) {
      Object.assign(w, { state: values[0], updated_at: values[1] }); return write();
    }
    if (sql.startsWith("UPDATE gongde_creator_reviews SET state = 'REJECTED'")) {
      for (const r of s.reviews.filter(r => r.version_id === values[2] && r.state === 'PENDING')) {
        Object.assign(r, { state: 'REJECTED', decision_reason: values[0], checks_json: '{"withdrawn":true}' });
      }
      return write();
    }
    if (sql.startsWith('UPDATE gongde_creator_reviews SET state = ?, reviewer_reference')) {
      Object.assign(s.reviews.find(r => r.review_id === values[5]), { state: values[0], checks_json: values[3], decision_reason: values[2] }); return write();
    }
    if (sql.startsWith('INSERT IGNORE INTO gongde_creator_rate_limits')) {
      if (!s.rateBuckets.some(b => b.digest === values[0])) s.rateBuckets.push({ digest: values[0], hits: 0, expiresAt: values[1] }); return write();
    }
    if (sql.startsWith('SELECT hits FROM gongde_creator_rate_limits')) return rows(s.rateBuckets.filter(b => b.digest === values[0]));
    if (sql.startsWith('UPDATE gongde_creator_rate_limits SET hits')) { s.rateBuckets.find(b => b.digest === values[0]).hits++; return write(); }
    if (sql.startsWith('DELETE FROM gongde_creator_rate_limits')) return write();
    if (sql.startsWith('INSERT INTO gongde_creator_audit')) { s.audit.push(values); return write(); }
    throw new Error(`UNHANDLED_LOCAL_SQL: ${sql}`);
  }
}
const fixture = () => {
  const db = new Database();
  const repository = new FreeCreatorRepository({}, db);
  let sourceReads = 0;
  const service = new FreeCreatorService(repository, { source: async () => { sourceReads++; return archive; } });
  return { db, repository, service, reads: () => sourceReads };
};
const checks = { dataOnly: true, realPreview: true, contentAcceptable: true, rightsDeclaration: true };
const contentFingerprint = creatorSourceContentFingerprint(archive, { creatorId: owner, slug: 'test-work' });
const submission = { acceptedFreeTermsVersion: consent.FREE_CREATOR_TERMS_VERSION,
  acceptedAiTermsVersion: consent.FREE_CREATOR_AI_TERMS_VERSION, previewRevision: pack.revision };

add('Douyin ASCII whitelist, optional/null/blank and 32/33 boundaries', () => {
  for (const value of [undefined, null, '', '   ']) assert.equal(normalizeCreatorDouyinNumber(value), null);
  assert.equal(normalizeCreatorDouyinNumber('  Ab_12-.  '), 'Ab_12-.');
  assert.equal(normalizeCreatorDouyinNumber('x'.repeat(32)), 'x'.repeat(32));
  for (const value of ['x'.repeat(33), 'https://douyin.com/user/a', '<b>x</b>', '中文', 'a b', 123]) {
    assert.throws(() => normalizeCreatorDouyinNumber(value), e => e.field === 'creatorDouyinNumber');
  }
});
add('NFC Unicode code points and title/intro/tag restrictions', () => {
  const input = { titleZh: '😀'.repeat(20), description: '😀'.repeat(40), tags: ['e\u0301', 'é'], creatorDouyinNumber: null };
  const data = parseCreatorMetadata(input);
  assert.equal(Array.from(data.titleZh).length, 20); assert.deepEqual(data.tags, ['é']);
  for (const [field, value] of [['titleZh', '😀'.repeat(21)], ['description', 'a'.repeat(41)],
    ['titleZh', ''], ['description', 'a\nb'], ['titleZh', 'a\u0085b'], ['tags', ['123456789']],
    ['tags', ['a', 'b', 'c', 'd']]]) assert.throws(() => parseCreatorMetadata({ ...input, [field]: value }), e => e.field === field);
});
add('Omitted number preserves one work, explicit clear does not mutate previous snapshot', () => {
  const previous = metadata('my.account');
  assert.equal(parseCreatorMetadata({ description: 'Updated' }, previous).creatorDouyinNumber, 'my.account');
  assert.equal(parseCreatorMetadata({ creatorDouyinNumber: null }, previous).creatorDouyinNumber, null);
  assert.equal(parseCreatorMetadata({ creatorDouyinNumber: '' }, previous).creatorDouyinNumber, null);
  assert.equal(previous.creatorDouyinNumber, 'my.account');
});
add('Paid declarations never imply v2 free consent', () => {
  const old = { ...metadata(), priceFen: 20, acceptPaidDistribution: true, sharingTermsVersion: 'creator-paid-distribution-v1' };
  assert.equal(consent.hasCurrentFreeConsent(old), false);
  assert.throws(() => parseCreatorMetadata({ titleZh: 'Example', description: 'Example', acceptPaidDistribution: true }));
  assert.equal(consent.hasCurrentFreeConsent(approved()), true);
  assert.equal(consent.hasCurrentFreeConsent({ ...approved(), creatorDouyinNumber: 'changed' }), false);
});
add('AI public-text whitelist includes active number and excludes account/private data', () => {
  const secretData = { ...approved(), phone: '13800000000', username: 'secret-login', updateNote: 'private update',
    sessionToken: 'secret-token', code: 'private-code', creatorName: 'account-only' };
  const text = consent.creatorReviewPublicText(secretData);
  assert.deepEqual(Object.keys(text), ['titleZh', 'description', 'tags', 'creatorDouyinNumber']);
  assert.equal(text.creatorDouyinNumber, 'old.user');
  assert.ok(!JSON.stringify(text).includes('13800000000'));
});
add('Published text update clones source, keeps original version and first-publication timestamp', async () => {
  const { db, repository } = fixture();
  const original = structuredClone(db.state.versions[0]);
  await repository.updateWork(owner, workId, metadata('new.user'));
  assert.equal(JSON.parse(db.state.work.published_metadata_json).creatorDouyinNumber, 'old.user');
  const reviewId = await repository.submit(owner, workId, originalVersionId, true);
  const review = await repository.getReview(reviewId);
  assert.notEqual(review.versionId, originalVersionId);
  assert.equal((await repository.getVersion(review.versionId)).revision, pack.revision);
  assert.deepEqual(db.state.versions[0], original);
  let event;
  process.env.GONGDE_FREE_DISTRIBUTION_ENABLED = 'true';
  repository.setPublicationObserver(async (connection, publication) => { assert.equal(connection, db); event = publication; });
  try { await repository.decide('local-admin', reviewId, 'APPROVED', 'Local approved', checks, undefined, contentFingerprint); }
  finally { process.env.GONGDE_FREE_DISTRIBUTION_ENABLED = 'false'; }
  assert.equal(event.contentFingerprint, contentFingerprint);
  assert.equal(event.workId, workId); assert.equal(event.versionId, review.versionId);
  assert.equal(JSON.parse(db.state.work.published_metadata_json).creatorDouyinNumber, 'new.user');
  assert.equal(db.state.work.first_published_at.getTime(), now.getTime());
  assert.equal(JSON.parse(db.state.versions[0].approved_metadata_json).creatorDouyinNumber, 'old.user');
});
add('Pending snapshot blocks edits/second submissions; withdrawal invalidates late results', async () => {
  const { db, repository } = fixture();
  await repository.updateWork(owner, workId, metadata('pending.user'));
  const reviewId = await repository.submit(owner, workId, originalVersionId, true);
  await assert.rejects(repository.updateWork(owner, workId, metadata('tamper')), e => e.code === 'creator_review_pending');
  await assert.rejects(repository.submit(owner, workId, originalVersionId, true), e => e.code === 'creator_review_pending');
  await repository.withdrawReview(owner, workId);
  await repository.updateWork(owner, workId, metadata(null));
  await assert.rejects(repository.decide('local-admin', reviewId, 'APPROVED', 'Late result', checks), e => e.code === 'creator_review_changed');
  assert.equal(JSON.parse(db.state.work.published_metadata_json).creatorDouyinNumber, 'old.user');
});
add('Rejected updates preserve old public number and metadata', async () => {
  const { db, repository } = fixture();
  await repository.updateWork(owner, workId, metadata(null));
  const reviewId = await repository.submit(owner, workId, originalVersionId, true);
  await repository.decide('local-admin', reviewId, 'REJECTED', 'Local rejection', checks);
  assert.equal(db.state.work.published_version_id, originalVersionId);
  assert.equal(JSON.parse(db.state.work.published_metadata_json).creatorDouyinNumber, 'old.user');
});
add('Unauthorized draft owner cannot edit or withdraw', async () => {
  const { repository } = fixture();
  await assert.rejects(repository.updateWork('e'.repeat(32), workId, metadata('tamper')), e => e.status === 404);
  await assert.rejects(repository.withdrawReview('e'.repeat(32), workId), e => e.status === 404);
});
add('Unlisting cancels pending publication; frozen old source remains deliverable', async () => {
  const { repository, service } = fixture();
  const frozen = (await service.resolveFreeWorks([workId], { [workId]: pack.revision }))[0];
  await repository.updateWork(owner, workId, metadata('new.user'));
  const reviewId = await repository.submit(owner, workId, originalVersionId, true);
  await repository.unpublish(workId, 'creator', owner);
  await assert.rejects(repository.decide('local-admin', reviewId, 'APPROVED', 'Late', checks), e => e.code === 'creator_review_changed');
  assert.deepEqual(await service.loadFrozenSource(frozen), archive);
  await repository.unpublish(workId, 'admin', 'local-admin', true, 'Safety pause');
  await assert.rejects(service.loadFrozenSource(frozen), e => e.code === 'creator_free_delivery_unavailable');
});
add('Frozen snapshot rejects tampered review/source identities', async () => {
  const { service } = fixture();
  const frozen = (await service.resolveFreeWorks([workId]))[0];
  await assert.rejects(service.loadFrozenSource({ ...frozen, reviewId: 'f'.repeat(32) }), e => e.code === 'creator_free_snapshot_changed');
  await assert.rejects(service.loadFrozenSource({ ...frozen, archiveSha256: '0'.repeat(64) }), e => e.code === 'creator_free_snapshot_changed');
});
add('Contribution observer failure rolls back publication, consent remains pending', async () => {
  const { db, repository } = fixture();
  const reviewId = await repository.submit(owner, workId, originalVersionId, true);
  repository.setPublicationObserver(async () => { throw new Error('distribution-write-failed'); });
  process.env.GONGDE_FREE_DISTRIBUTION_ENABLED = 'true';
  try { await assert.rejects(repository.decide('local-admin', reviewId, 'APPROVED', 'Local approved', checks, undefined, contentFingerprint), /distribution-write-failed/); }
  finally { process.env.GONGDE_FREE_DISTRIBUTION_ENABLED = 'false'; }
  assert.equal(db.state.work.published_version_id, originalVersionId);
  assert.equal(db.state.reviews.find(r => r.review_id === reviewId).state, 'PENDING');
});
add('Public detail returns reviewed number, never mutable draft number', async () => {
  const { repository, service } = fixture();
  await repository.updateWork(owner, workId, metadata('draft.only'));
  const detail = await service.publicWork(workId);
  assert.equal(detail.creatorDouyinNumber, 'old.user'); assert.equal(detail.canClaim, true);
  assert.equal((await repository.ownedWork(owner, workId)).creatorDouyinNumber, 'draft.only');
});
add('Old paid versions cannot resolve as new free selections', async () => {
  const { db, service } = fixture();
  const old = { ...metadata(), acceptPaidDistribution: true, priceFen: 20, sharingTermsVersion: 'creator-paid-distribution-v1' };
  db.state.versions[0].approved_metadata_json = JSON.stringify(old);
  db.state.consents = [];
  await assert.rejects(service.resolveFreeWorks([workId]), e => e.status === 404);
});

add('Text PATCH returns draftVersionId without modifying approved source', async () => {
  const { service, repository, db } = fixture();
  const result = await service.updateWork(creator, workId, { creatorDouyinNumber: 'text.update' });
  assert.notEqual(result.draftVersionId, originalVersionId);
  assert.equal((await repository.getVersion(result.draftVersionId)).state, 'READY');
  assert.equal(db.state.work.published_version_id, originalVersionId);
  assert.equal((await service.updateWork(creator, workId, { description: 'Second save' })).draftVersionId, result.draftVersionId);
});
add('Explicit legacy consent reuses original evidence, preserves paid approval and same version identity', async () => {
  const { service, repository, db } = fixture();
  const legacy = { titleZh: 'Example', description: 'Local fixture', tags: ['sample'], creatorName: 'Legacy author',
    acceptPaidDistribution: true, priceFen: 20, sharingTermsVersion: 'creator-paid-distribution-v1' };
  db.state.work.creator_douyin_number = null; db.state.work.price_fen = 20;
  db.state.work.sharing_terms_version = 'creator-paid-distribution-v1';
  db.state.work.published_metadata_json = JSON.stringify(legacy);
  db.state.versions[0].approved_metadata_json = JSON.stringify(legacy);
  db.state.reviews[0].metadata_snapshot_json = JSON.stringify(legacy); db.state.consents = [];
  const versionBefore = structuredClone(db.state.versions[0]), reviewBefore = structuredClone(db.state.reviews[0]);
  await assert.rejects(service.grantFreeConsent(creator, workId, { versionId: originalVersionId }), e => e.code === 'creator_sharing_acceptance_required');
  const result = await service.grantFreeConsent(creator, workId, { ...submission, versionId: originalVersionId });
  assert.equal(result.versionId, originalVersionId); assert.equal(result.evidenceReused, true);
  assert.deepEqual(db.state.versions[0], versionBefore); assert.deepEqual(db.state.reviews[0], reviewBefore);
  assert.equal((await service.publicWork(workId)).canClaim, true);
  assert.equal(await repository.authorizePaidVersion(owner, workId, originalVersionId, pack.revision), originalReviewId);
  assert.equal((await service.resolveFreeWorks([workId]))[0].versionId, originalVersionId);
  await service.grantFreeConsent(creator, workId, { ...submission, versionId: originalVersionId });
  assert.equal(db.state.consents.length, 1);
  // Historical fulfillment must not pass through today's free-only catalog.
  repository.published = async () => { throw new Error('HISTORICAL_PAID_USED_FREE_CATALOG'); };
  const item = { sourceKind: 'community', creatorId: owner, workId, versionId: originalVersionId, assetId: workId,
    sourceRevision: pack.revision, unitPriceFen: 20, creatorShareBps: 0, creatorAmountFen: 0, amountFen: 20,
    platformAmountFen: 20, revenueRuleVersion: 'creator-paid-distribution-v1', orderNo: 'local-old-paid' };
  const delivery = { scope: 'asset-download', orderNo: item.orderNo, assetId: workId, state: 'ACTIVE',
    activatedAt: new Date(), expiresAt: new Date(Date.now() + 60000) };
  const resultPack = await service.buildPaidPack(item, delivery, { buildCommunity(input) {
    assert.equal(input.reviewId, originalReviewId); assert.deepEqual(input.archive, archive);
    return { filename: 'local-history.nmgpack', content: Buffer.from('offline-signer-fixture'), importBefore: delivery.expiresAt.toISOString() };
  } });
  assert.equal(resultPack.filename, 'local-history.nmgpack');
});
add('Legacy evidence cannot be reused after public text change or missing approval checks', async () => {
  const { service, db } = fixture();
  db.state.consents = []; db.state.work.creator_douyin_number = 'changed';
  await assert.rejects(service.grantFreeConsent(creator, workId, { ...submission, versionId: originalVersionId }),
    e => e.code === 'creator_free_consent_requires_review');
  db.state.work.creator_douyin_number = 'old.user'; db.state.reviews[0].checks_json = '{}';
  await assert.rejects(service.grantFreeConsent(creator, workId, { ...submission, versionId: originalVersionId }),
    e => e.code === 'creator_free_consent_requires_review');
});
add('Content fingerprint ignores owner/names/version/credits but detects layout and PNG changes', () => {
  const changedOwner = 'e'.repeat(32);
  const source = { ...manifest, id: `creator.${changedOwner}.different`, name_zh: 'Renamed', name_en: 'Other name',
    author: 'Different credit', version: '99.0', preview: 'renamed.png',
    layers: manifest.layers.map(layer => ({ ...layer, image: 'renamed.png' })) };
  const repack = (value, png = image) => Buffer.from(zipSync({ 'manifest.json': Buffer.from(JSON.stringify(value)), 'renamed.png': png },
    { level: 0, mtime: new Date('2020-01-01T00:00:00Z') }));
  assert.equal(creatorSourceContentFingerprint(repack(source), { creatorId: changedOwner, slug: 'different' }), contentFingerprint);
  const layout = structuredClone(source); layout.layers[0].frame[0] = 1;
  assert.notEqual(creatorSourceContentFingerprint(repack(layout), { creatorId: changedOwner, slug: 'different' }), contentFingerprint);
  const changedPng = Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', header),
    chunk('IDAT', deflateSync(Buffer.from([0, 13, 23, 34, 255]))), chunk('IEND', Buffer.alloc(0))]);
  assert.notEqual(creatorSourceContentFingerprint(repack(source, changedPng), { creatorId: changedOwner, slug: 'different' }), contentFingerprint);
});
add('Beijing daily limit resets at 16:00 UTC and uses correct UTC expiry', async () => {
  const { repository, db } = fixture();
  await repository.consumeLimit('auto-review-provider', 'project', 1, 86400, new Date('2026-10-07T15:59:59.999Z'), 28800);
  assert.equal(db.state.rateBuckets[0].expiresAt.toISOString(), '2026-10-07T16:00:00.000Z');
  await assert.rejects(repository.consumeLimit('auto-review-provider', 'project', 1, 86400,
    new Date('2026-10-07T15:59:59.999Z'), 28800), e => e.code === 'creator_rate_limited');
  await repository.consumeLimit('auto-review-provider', 'project', 1, 86400, new Date('2026-10-07T16:00:00.000Z'), 28800);
  assert.equal(db.state.rateBuckets.length, 2);
});
add('AI endpoint/model/image capability are explicit deployment inputs, default budget 20', () => {
  const settings = { GONGDE_CREATOR_REVIEW_API_URL: 'https://review.invalid/v1/chat/completions',
    GONGDE_CREATOR_REVIEW_MODEL: 'offline-vision-model', GONGDE_CREATOR_REVIEW_SUPPORTS_IMAGES: 'true' };
  assert.equal(loadCreatorReviewSettings(settings).dailyLimit, 20);
  assert.throws(() => loadCreatorReviewSettings({ ...settings, GONGDE_CREATOR_REVIEW_SUPPORTS_IMAGES: 'false' }));
  assert.throws(() => loadCreatorReviewSettings({ ...settings, GONGDE_CREATOR_REVIEW_MODEL: '' }));
});
add('Free-disabled publication never invokes contribution observer or requires SQL008', async () => {
  const { repository } = fixture();
  let called = false;
  repository.setPublicationObserver(async () => { called = true; });
  const reviewId = await repository.submit(owner, workId, originalVersionId, true);
  await repository.decide('local-admin', reviewId, 'APPROVED', 'Local approved', checks);
  assert.equal(called, false); assert.equal(await repository.ensureCreatorPublicNumber(owner), null);
});

async function routeCall(service, method, path, payload) {
  const bytes = payload ? Buffer.from(JSON.stringify(payload)) : Buffer.alloc(0);
  const request = Object.assign(Readable.from(bytes.length ? [bytes] : []), { method,
    headers: { origin: 'https://local.invalid', 'sec-fetch-site': 'same-origin', 'content-type': 'application/json',
      cookie: `gongde_creator_session=${'a'.repeat(64)}` }, socket: { remoteAddress: '127.0.0.1' } });
  let status, body;
  const response = { writeHead(code) { status = code; }, end(value) { body = JSON.parse(value); } };
  service.repository.consumeLimit = async () => {};
  const router = createFreeCreatorRouter({ publicOrigin: 'https://local.invalid', secureCookie: true, trustedProxyAddresses: [] },
    service, () => 'local-admin');
  assert.equal(await router(request, response, new URL(path, 'https://local.invalid')), true);
  return { status, body };
}
add('Free-enabled account without contributions receives stable C100001 and session displays short identity', async () => {
  const { service, repository, db } = fixture();
  process.env.GONGDE_FREE_DISTRIBUTION_ENABLED = 'true';
  try {
    assert.equal(await repository.ensureCreatorPublicNumber(owner), 'C100001');
    assert.equal(await repository.ensureCreatorPublicNumber(owner), 'C100001');
    const result = await routeCall(service, 'GET', '/api/gongde/creators/session');
    assert.equal(result.status, 200); assert.equal(result.body.account.publicNumber, 'C100001');
    assert.equal(result.body.account.displayName, '作者 C100001'); assert.equal(result.body.account.phoneBound, true);
    assert.equal(result.body.account.username, undefined); assert.equal(db.state.publicNumbers.length, 1);
  } finally { process.env.GONGDE_FREE_DISTRIBUTION_ENABLED = 'false'; }
});
add('Withdraw button POST route invalidates pending review while old public image preview remains real', async () => {
  const { service, repository, db } = fixture();
  const reviewId = await repository.submit(owner, workId, originalVersionId, true);
  const response = await routeCall(service, 'POST', `/api/gongde/creators/works/${workId}/withdraw`, {});
  assert.equal(response.status, 200); assert.equal(response.body.ok, true);
  assert.equal(db.state.reviews.find(r => r.review_id === reviewId).state, 'REJECTED');
  const preview = await service.preview(originalVersionId, { audience: 'public' });
  assert.equal(preview.images['sprite.png'], `/api/gongde/community/versions/${originalVersionId}/images/sprite.png`);
  service.objects.image = async () => image;
  assert.deepEqual(await service.image(originalVersionId, 'sprite.png', { audience: 'public' }), image);
  await assert.rejects(service.preview(originalVersionId, { audience: 'creator', creatorId: 'e'.repeat(32) }), e => e.status === 404);
});
add('Submission enforces both current consents and exact preview before repository writes', async () => {
  const { service, repository } = fixture();
  repository.consumeLimit = async () => {};
  await assert.rejects(service.submit(creator, workId, originalVersionId,
    { acceptPaidDistribution: true, sharingTermsVersion: 'creator-paid-distribution-v1' }), e => e.code === 'creator_sharing_acceptance_required');
  await assert.rejects(service.submit(creator, workId, originalVersionId,
    { ...submission, acceptedAiTermsVersion: 'old' }), e => e.code === 'creator_ai_review_acceptance_required');
  await assert.rejects(service.submit(creator, workId, originalVersionId,
    { ...submission, previewRevision: '0'.repeat(64) }), e => e.code === 'creator_preview_outdated');
  const result = await service.submit(creator, workId, originalVersionId, submission);
  assert.notEqual(result.versionId, originalVersionId);
});
add('Missing signing adapter fails closed before storage access', async () => {
  const { service } = fixture();
  const selection = (await service.resolveFreeWorks([workId]))[0];
  let calls = 0;
  const delivery = new FreeCreatorBatchDelivery({ source: async () => { calls++; return archive; } });
  await assert.rejects(delivery.build([selection]), e => e.code === 'creator_free_batch_signer_required');
  assert.equal(calls, 0);
});
add('Phone acceptance errors precede SMS readiness/consumption; 30-day default retained', async () => {
  const auth = new CreatorPhoneAuth({ enabled: false, reason: 'local-disabled', runtime: null, environment: 'test' }, {});
  await assert.rejects(auth.login({ phone: '13800000000', challengeId: 'a'.repeat(24), code: '000000' }, 'local'),
    e => e.code === 'creator_terms_acceptance_required');
  assert.equal(creatorRememberMe(undefined), true);
  const started = Date.now();
  assert.ok(Math.abs(creatorSessionExpiry(true).getTime() - started - 30 * 86400000) < 1000);
  assert.ok(Math.abs(creatorSessionExpiry(false).getTime() - started - 8 * 3600000) < 1000);
});

const timeout = setTimeout(() => { process.stderr.write('OFFLINE_ACCEPTANCE_TIMEOUT\n'); process.exit(124); }, 20000);
timeout.unref();
let failures = 0;
for (const { name, run } of cases) {
  try { await run(); process.stdout.write(`PASS ${name}\n`); }
  catch (error) { failures++; process.stderr.write(`FAIL ${name}: ${error.stack}\n`); }
}
clearTimeout(timeout);
process.stdout.write(`${cases.length - failures}/${cases.length} offline cases passed; source_sha256=${sha(archive)}\n`);
process.exitCode = failures ? 1 : 0;
