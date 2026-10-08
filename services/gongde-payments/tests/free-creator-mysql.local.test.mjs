/**
 * PREPARATION ONLY until fresh, direct human approval of isolated local MySQL.
 * Main owns container lifecycle, user grants, DDL initialization and teardown.
 * This suite never creates a database, migrates, seeds via setup SQL, or starts Docker.
 * After authorized initialization, exact example from repository root:
 * env -i PATH="$PATH" HOME=/private/tmp/gongde-creator-budget-Z0kaE8 TZ=UTC \
 *   GONGDE_CREATOR_LOCAL_MYSQL_APPROVED=1 \
 *   GONGDE_CREATOR_LOCAL_MYSQL_URL='mysql://gongde_creator_local_test:FICTIONAL_LOCAL_TEST_PASSWORD@127.0.0.1:13306/gongde_creator_local_deadbeef' \
 *   node --max-old-space-size=96 services/gongde-payments/tests/free-creator-mysql.local.test.mjs
 * The credentials above are fictional local fixture values, never production accounts.
 * Guard: flag exactly 1, literal 127.0.0.1, explicit port 10000-65535, database
 * gongde_creator_local_<8-32 lowercase hex>, no query/hash/host aliases/default config.
 * Guard runs BEFORE mysql2/application import and BEFORE any pool construction.
 * Actual compiled Repository/auth/service + actual mysql2 pool; MemoryCos only.
 * Direct service integration, NOT HTTP/admin authentication/browser/real COS/native
 * or production acceptance. Administrative content/rights checks are synthetic.
 * 30s hard runtime timer, serial cases, connectTimeout 5s, no cleanup DDL.
 * Importing/executing this file runs the suite ONLY after its explicit approval guard.
 * Offline preparation syntax command: node --check <this file> (does not import/run it).
 */
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { performance } from 'node:perf_hooks';
import { approvedLocalMysqlTarget, installLocalOnlyIoBoundary, MemoryCos,
  sourceFixture, sha256, jsonValue, unzip } from './free-creator-mysql-fixtures.local.mjs';

let target;
try { target = approvedLocalMysqlTarget(process.env); }
catch (error) {
  console.error(JSON.stringify({ status: 'NOT_EXECUTED', reason: error.code, poolConstructed: false }));
  process.exit(78);
}
const io = installLocalOnlyIoBoundary(target);
const started = performance.now();
const deadline = setTimeout(() => { console.error('LOCAL_MYSQL_SUITE_DEADLINE_EXCEEDED'); process.exit(124); }, 30000);
deadline.unref();
const { createPool } = await import('mysql2/promise');
const { FreeCreatorRepository } = await import('../dist/creators/repository.js');
const { FreeCreatorService, FREE_CREATOR_TERMS_VERSION, FREE_CREATOR_TERMS } = await import('../dist/creators/free-service.js');
const { CreatorSourceStore } = await import('../dist/creators/object-store.js');
const { creatorTokenDigest, verifyCreatorPassword } = await import('../dist/creators/auth.js');
const poolOptions = Object.freeze({ ...target, connectionLimit: 2, waitForConnections: true,
  queueLimit: 16, connectTimeout: 5000, timezone: 'Z', charset: 'utf8mb4', multipleStatements: false });
const pool = createPool(poolOptions);
// Configuration is deliberately unused because the actual approved pool is injected.
// No production configuration or credential provider is resolved.
const repository = new FreeCreatorRepository({}, pool);
const cos = new MemoryCos();
const objects = new CreatorSourceStore({ bucket: 'fictional-local-mysql', region: 'offline',
  secretId: 'FICTIONAL-NOT-A-CREDENTIAL', secretKey: 'FICTIONAL-NOT-A-CREDENTIAL' }, cos);
const service = new FreeCreatorService(repository, objects);
const namespace = randomBytes(5).toString('hex');
const admin = 'fictional-local-admin-' + namespace;
const clientKey = sha256('local-mysql-author-' + namespace);
const anonymousKey = sha256('local-mysql-anonymous-' + namespace);
const state = {};
const secrets = [target.password];
const outputDirectory = process.env.GONGDE_CREATOR_LOCAL_MYSQL_ARTIFACT_DIR;
if (outputDirectory !== undefined) {
  assert.match(outputDirectory, /^\/private\/tmp\/gongde-creator-mysql-[A-Za-z0-9]+\/suite$/u,
    'Artifacts must belong to this fresh private local test run.');
  mkdirSync(outputDirectory, { mode: 0o700 });
}
const HERE = (outputDirectory || mkdtempSync('/private/tmp/gongde-creator-mysql-suite-')) + '/';
const allChecks = Object.freeze({ dataOnly: true, realPreview: true, contentAcceptable: true, rightsDeclaration: true });
const cases = [];
const add = (name, run) => cases.push({ name, run });
const rows = async (sql, values = []) => (await pool.execute(sql, values))[0];
const one = async (sql, values = []) => { const found = await rows(sql, values); assert.equal(found.length, 1); return found[0]; };
const fails = (operation, code, status) => assert.rejects(operation, error => error.code === code && (status === undefined || error.status === status));
const select = version => ({ workId: version.workId, versionId: version.versionId, revision: version.revision });
const sharing = { sharingTermsVersion: FREE_CREATOR_TERMS_VERSION, acceptPaidDistribution: true };
const metadata = title => ({ titleZh: title, description: 'Synthetic local integration work, not a production submission.', tags: ['local', 'fixture'], ...sharing });
const paidTables = ['gongde_market_order_items', 'gongde_creator_royalty_ledger', 'gongde_creator_settlements',
  'gongde_creator_settlement_entries', 'gongde_creator_payouts'];
async function paidCounts() {
  const counts = {};
  for (const table of paidTables) counts[table] = Number((await one('SELECT COUNT(*) AS total FROM ' + table)).total);
  return counts;
}
async function frozenVersion(versionId) {
  return one('SELECT version_id, work_id, source_revision, archive_sha256, source_object_key, source_manifest_json FROM gongde_creator_work_versions WHERE version_id = ?', [versionId]);
}
function assertFrozen(actual, expected) {
  for (const field of ['version_id', 'work_id', 'source_revision', 'archive_sha256', 'source_object_key']) assert.equal(actual[field], expected[field]);
  assert.deepEqual(jsonValue(actual.source_manifest_json), jsonValue(expected.source_manifest_json));
}
async function audit(action, subject, actorKind, actorReference) {
  const entry = await one('SELECT actor_kind, actor_reference, action, subject_reference, detail_json FROM gongde_creator_audit WHERE action = ? AND subject_reference = ?', [action, subject]);
  assert.equal(entry.actor_kind, actorKind); assert.equal(entry.actor_reference, actorReference);
  return jsonValue(entry.detail_json);
}

add('actual MySQL identity and pre-applied schema; no initializer in suite', async () => {
  const identity = await one('SELECT DATABASE() AS database_name, VERSION() AS server_version');
  assert.equal(identity.database_name, target.database); assert.match(identity.server_version, /^8\.4\./u);
  state.mysqlVersion = identity.server_version;
  assert.equal(await repository.ready(), true);
  await rows('SELECT username, password_hash, recovery_digest FROM gongde_creators LIMIT 0');
  await rows('SELECT source_revision, approved_metadata_json FROM gongde_creator_work_versions LIMIT 0');
  await rows('SELECT decision_reason, metadata_snapshot_json, checks_json FROM gongde_creator_reviews LIMIT 0');
  const engines = await rows('SELECT TABLE_NAME AS table_name, ENGINE AS engine FROM information_schema.tables WHERE table_schema = ? AND table_name IN (?, ?, ?, ?)',
    [target.database, 'gongde_creators', 'gongde_creator_tokens', 'gongde_creator_works', 'gongde_creator_reviews']);
  assert.equal(engines.length, 4); assert.ok(engines.every(row => row.engine === 'InnoDB'));
  state.paidBefore = await paidCounts();
});

add('two persistent signups, hashed secrets, agreements, sessions and audit', async () => {
  for (const label of ['a', 'b']) {
    const username = 'local_' + label + '_' + namespace, password = 'Fictional-local-' + label + '-' + namespace;
    secrets.push(password);
    const signup = await service.register({ username, password, displayName: 'Local Author ' + label.toUpperCase(),
      termsVersion: FREE_CREATOR_TERMS_VERSION, acceptTerms: true }, clientKey);
    secrets.push(signup.sessionToken, signup.recoveryKey);
    assert.match(signup.account.creatorId, /^[a-f0-9]{32}$/u);
    assert.deepEqual(Object.keys(signup.account).sort(), ['creatorId', 'displayName', 'username']);
    assert.match(signup.sessionToken, /^[a-f0-9]{64}$/u); assert.match(signup.recoveryKey, /^[a-f0-9]{64}$/u);
    const account = await service.requireAccount(signup.sessionToken);
    const stored = await one('SELECT creator_id, username, password_hash, recovery_digest, state, email FROM gongde_creators WHERE username = ?', [username]);
    assert.equal(stored.creator_id, account.creatorId); assert.equal(stored.state, 'ACTIVE'); assert.equal(stored.email, null);
    assert.equal(await verifyCreatorPassword(password, stored.password_hash), true);
    assert.notEqual(stored.password_hash, password); assert.equal(stored.recovery_digest, creatorTokenDigest(signup.recoveryKey));
    const agreement = await one('SELECT terms_version, terms_sha256 FROM gongde_creator_agreements WHERE creator_id = ?', [account.creatorId]);
    assert.equal(agreement.terms_version, FREE_CREATOR_TERMS_VERSION); assert.equal(agreement.terms_sha256, sha256(FREE_CREATOR_TERMS));
    const token = await one('SELECT token_digest, purpose, consumed_at FROM gongde_creator_tokens WHERE token_digest = ?', [creatorTokenDigest(signup.sessionToken)]);
    assert.equal(token.purpose, 'session'); assert.equal(token.consumed_at, null); assert.notEqual(token.token_digest, signup.sessionToken);
    await audit('account.create', account.creatorId, 'creator', account.creatorId);
    state[label] = { username, password, signup, account, token: signup.sessionToken };
  }
  assert.notEqual(state.a.account.creatorId, state.b.account.creatorId);
});

add('actual unique-key signup failure rolls back without agreement/token/audit additions', async () => {
  const before = Number((await one('SELECT COUNT(*) AS total FROM gongde_creator_audit')).total);
  await fails(() => service.register({ username: state.a.username, password: state.a.password, displayName: 'Duplicate Local Author',
    termsVersion: FREE_CREATOR_TERMS_VERSION, acceptTerms: true }, clientKey), 'ER_DUP_ENTRY');
  assert.equal(Number((await one('SELECT COUNT(*) AS total FROM gongde_creators WHERE username = ?', [state.a.username])).total), 1);
  assert.equal(Number((await one('SELECT COUNT(*) AS total FROM gongde_creator_agreements WHERE creator_id = ?', [state.a.account.creatorId])).total), 1);
  assert.equal(Number((await one('SELECT COUNT(*) AS total FROM gongde_creator_audit')).total), before);
});

add('independent real pool/service observes committed accounts and login sessions', async () => {
  const secondPool = createPool(poolOptions), secondRepository = new FreeCreatorRepository({}, secondPool);
  try {
    const secondService = new FreeCreatorService(secondRepository, objects);
    const persisted = await secondRepository.findAccount(state.a.username);
    assert.equal(persisted.creatorId, state.a.account.creatorId);
    assert.equal((await secondService.requireAccount(state.a.signup.sessionToken)).creatorId, persisted.creatorId);
    const login = await secondService.login({ username: state.a.username, password: state.a.password }, clientKey);
    secrets.push(login.sessionToken); state.a.loginBeforeRecovery = login.sessionToken;
    assert.equal((await service.requireAccount(login.sessionToken)).creatorId, persisted.creatorId);
  } finally { await secondRepository.close(); }
});

add('wrong password and unknown synthetic account fail without authenticated session', async () => {
  await fails(() => service.login({ username: state.a.username, password: 'Fictional-wrong-password-only' }, clientKey), 'creator_login_failed', 401);
  await fails(() => service.login({ username: 'absent_' + namespace, password: 'Fictional-wrong-password-only' }, clientKey), 'creator_login_failed', 401);
});

add('recovery rotates persistent recovery digest/password and revokes every prior A session only', async () => {
  state.a.newPassword = 'Fictional-recovered-' + namespace; secrets.push(state.a.newPassword);
  const recovered = await service.recover({ username: state.a.username, recoveryKey: state.a.signup.recoveryKey, password: state.a.newPassword }, clientKey);
  secrets.push(recovered.recoveryKey); assert.notEqual(recovered.recoveryKey, state.a.signup.recoveryKey);
  const stored = await one('SELECT password_hash, recovery_digest FROM gongde_creators WHERE creator_id = ?', [state.a.account.creatorId]);
  assert.equal(stored.recovery_digest, creatorTokenDigest(recovered.recoveryKey));
  assert.equal(await verifyCreatorPassword(state.a.newPassword, stored.password_hash), true);
  assert.equal(await verifyCreatorPassword(state.a.password, stored.password_hash), false);
  for (const token of [state.a.signup.sessionToken, state.a.loginBeforeRecovery]) await fails(() => service.requireAccount(token), 'creator_auth_required', 401);
  assert.equal(Number((await one("SELECT COUNT(*) AS total FROM gongde_creator_tokens WHERE creator_id = ? AND purpose = 'session'", [state.a.account.creatorId])).total), 0);
  assert.equal((await service.requireAccount(state.b.token)).creatorId, state.b.account.creatorId);
  await fails(() => service.recover({ username: state.a.username, recoveryKey: state.a.signup.recoveryKey, password: state.a.newPassword }, clientKey), 'creator_recovery_failed', 401);
  await audit('account.recover', state.a.account.creatorId, 'creator', state.a.account.creatorId);
});

add('new password login and logout persist session revocation; fresh active account for later cases', async () => {
  await fails(() => service.login({ username: state.a.username, password: state.a.password }, clientKey), 'creator_login_failed', 401);
  const login = await service.login({ username: state.a.username, password: state.a.newPassword }, clientKey); secrets.push(login.sessionToken);
  assert.equal((await service.requireAccount(login.sessionToken)).creatorId, state.a.account.creatorId);
  await service.logout(login.sessionToken);
  await fails(() => service.requireAccount(login.sessionToken), 'creator_auth_required', 401);
  assert.equal(Number((await one('SELECT COUNT(*) AS total FROM gongde_creator_tokens WHERE token_digest = ?', [creatorTokenDigest(login.sessionToken)])).total), 0);
  const fresh = await service.login({ username: state.a.username, password: state.a.newPassword }, clientKey); secrets.push(fresh.sessionToken);
  state.a.token = fresh.sessionToken; state.a.account = await service.requireAccount(fresh.sessionToken);
});

add('real free work creation for two authors with canonical owner identity', async () => {
  for (const label of ['a', 'b']) {
    const author = state[label]; author.slug = label + '-' + namespace;
    author.work = await service.createWork(author.account, { slug: author.slug, ...metadata('Original Local ' + label.toUpperCase()) });
    assert.equal(author.work.workId, 'creator.' + author.account.creatorId + '.' + author.slug);
    assert.equal(author.work.creatorId, author.account.creatorId); assert.equal(author.work.state, 'DRAFT'); assert.equal(author.work.metadata.priceFen, 0);
    assert.equal((await one('SELECT price_fen FROM gongde_creator_works WHERE work_id = ?', [author.work.workId])).price_fen, 0);
  }
});

add('real validated PNG/ZIP uploads and immutable revision deduplication in SQL', async () => {
  for (const label of ['a', 'b']) {
    const author = state[label]; author.fixture = sourceFixture({ creatorId: author.account.creatorId, slug: author.slug }, { pixel: label === 'a' ? 30 : 60 });
    writeFileSync(HERE + 'mysql-' + namespace + '-' + label + '.nmgpack', author.fixture.archive);
    const uploaded = await service.upload(author.account, author.work.workId, author.fixture.archive);
    author.version = await repository.getVersion(uploaded.versionId); author.frozen = await frozenVersion(uploaded.versionId);
    assert.equal(author.version.state, 'READY'); assert.equal(author.version.creatorId, author.account.creatorId);
    assert.equal(author.version.revision, author.frozen.source_revision); assert.equal(author.version.archiveSha256, sha256(author.fixture.archive));
    assert.equal(jsonValue(author.frozen.source_manifest_json).id, author.work.workId);
    const repeated = await service.upload(author.account, author.work.workId, author.fixture.archive);
    assert.equal(repeated.versionId, uploaded.versionId);
    assert.equal(Number((await one('SELECT COUNT(*) AS total FROM gongde_creator_work_versions WHERE work_id = ?', [author.work.workId])).total), 1);
  }
});

add('two-author work/update/upload/private-image/unpublish isolation against real ownership rows', async () => {
  const writesBefore = cos.writes;
  await fails(() => service.updateWork(state.b.account, state.a.work.workId, metadata('Unauthorized draft edit')), 'creator_work_not_found', 404);
  await fails(() => service.upload(state.b.account, state.a.work.workId, state.a.fixture.archive), 'creator_work_not_found', 404);
  await fails(() => service.image(state.a.version.versionId, 'sprite.png', { audience: 'creator', creatorId: state.b.account.creatorId }), 'creator_version_not_found', 404);
  await fails(() => repository.unpublish(state.a.work.workId, 'creator', state.b.account.creatorId), 'creator_work_not_found', 404);
  assert.equal(cos.writes, writesBefore); assertFrozen(await frozenVersion(state.a.version.versionId), state.a.frozen);
  assert.deepEqual(await service.image(state.a.version.versionId, 'sprite.png', { audience: 'creator', creatorId: state.a.account.creatorId }), state.a.fixture.png);
});

add('submission persists pending review and exposes only authorized private preview', async () => {
  const submitted = await service.submit(state.a.account, state.a.work.workId, state.a.version.versionId, sharing); state.a.firstReview = submitted.reviewId;
  const review = await one('SELECT state, review_round, metadata_snapshot_json FROM gongde_creator_reviews WHERE review_id = ?', [submitted.reviewId]);
  assert.equal(review.state, 'PENDING'); assert.equal(review.review_round, 1);
  assert.equal(jsonValue(review.metadata_snapshot_json).titleZh, 'Original Local A');
  assert.equal(jsonValue(review.metadata_snapshot_json).creatorName, 'Local Author A');
  assert.equal((await repository.getVersion(state.a.version.versionId)).state, 'PENDING_REVIEW');
  assert.equal((await service.reviewPreview(state.a.version.versionId)).workId, state.a.work.workId);
  assert.deepEqual(await service.image(state.a.version.versionId, 'sprite.png', { audience: 'admin' }), state.a.fixture.png);
  const pending = (await repository.reviews('PENDING')).find(reviewItem => reviewItem.reviewId === submitted.reviewId);
  assert.equal(pending.workId, state.a.work.workId); assert.equal(pending.reason, null);
  await fails(() => service.image(state.a.version.versionId, 'sprite.png', { audience: 'public' }), 'creator_work_not_found', 404);
  await fails(() => service.freeBatch({ items: [select(state.a.version)] }, anonymousKey), 'creator_free_delivery_retired', 410);
});

add('reject/resubmit records reason and immutable first round; repeated decision cannot mutate it', async () => {
  state.a.rejection = 'Synthetic local rejection for controlled resubmission.';
  await service.decide(admin, state.a.firstReview, { decision: 'REJECTED', reason: state.a.rejection,
    checks: { ...allChecks, realPreview: false, contentAcceptable: false } });
  const rejected = await one('SELECT state, decision_reason, metadata_snapshot_json FROM gongde_creator_reviews WHERE review_id = ?', [state.a.firstReview]);
  assert.equal(rejected.state, 'REJECTED'); assert.equal(rejected.decision_reason, state.a.rejection);
  assert.equal((await repository.reviews('REJECTED')).find(item => item.reviewId === state.a.firstReview).reason, state.a.rejection);
  assert.equal((await repository.getVersion(state.a.version.versionId)).state, 'REJECTED');
  await fails(() => service.decide(admin, state.a.firstReview, { decision: 'APPROVED', reason: '', checks: allChecks }), 'creator_review_changed', 409);
  state.a.approvedTitle = 'Approved Local A';
  await service.updateWork(state.a.account, state.a.work.workId, metadata(state.a.approvedTitle));
  state.a.approvedReview = (await service.submit(state.a.account, state.a.work.workId, state.a.version.versionId, sharing)).reviewId;
  assert.notEqual(state.a.approvedReview, state.a.firstReview);
  const next = await one('SELECT review_round, metadata_snapshot_json FROM gongde_creator_reviews WHERE review_id = ?', [state.a.approvedReview]);
  assert.equal(next.review_round, 2); assert.equal(jsonValue(next.metadata_snapshot_json).titleZh, state.a.approvedTitle);
  assert.equal(jsonValue((await one('SELECT metadata_snapshot_json FROM gongde_creator_reviews WHERE review_id = ?', [state.a.firstReview])).metadata_snapshot_json).titleZh, 'Original Local A');
  assertFrozen(await frozenVersion(state.a.version.versionId), state.a.frozen);
});

add('approve both owners through real transactional review/publication and freeze source metadata', async () => {
  state.b.approvedTitle = 'Original Local B';
  state.b.approvedReview = (await service.submit(state.b.account, state.b.work.workId, state.b.version.versionId, sharing)).reviewId;
  for (const label of ['a', 'b']) {
    const author = state[label]; await service.decide(admin, author.approvedReview, { decision: 'APPROVED', reason: '', checks: allChecks });
    const work = await repository.ownedWork(author.account.creatorId, author.work.workId);
    author.version = await repository.getVersion(author.version.versionId);
    assert.equal(work.state, 'PUBLISHED'); assert.equal(work.publishedVersionId, author.version.versionId);
    assert.equal(work.publishedMetadata.titleZh, author.approvedTitle); assert.equal(author.version.approvedMetadata.titleZh, author.approvedTitle);
    assert.equal(author.version.state, 'APPROVED'); assert.equal(await repository.approvedReviewId(author.version.versionId), author.approvedReview);
    assertFrozen(await frozenVersion(author.version.versionId), author.frozen);
  }
});

add('public preview, paid listing, and retired free delivery', async () => {
  const catalog = await service.publicWorks(0);
  for (const label of ['a', 'b']) {
    const author = state[label], item = catalog.find(work => work.workId === author.work.workId);
    assert.ok(item); assert.equal(item.priceFen, 20); assert.equal(item.purchasable, true);
    assert.equal(item.preview.versionId, author.version.versionId);
    assert.equal((await service.publicWork(author.work.workId)).metadata.titleZh, author.approvedTitle);
    assert.equal((await service.publicWork(author.work.workId)).purchasable, true);
    author.marketItem = { sourceKind: 'community', assetId: author.work.workId, creatorId: author.account.creatorId,
      workId: author.work.workId, versionId: author.version.versionId, versionLabel: author.version.versionLabel,
      sourceRevision: author.version.revision, titleZh: author.approvedTitle, unitPriceFen: 20, amountFen: 20,
      revenueRuleVersion: FREE_CREATOR_TERMS_VERSION, createdAt: new Date(), orderNo: 'synthetic-order-' + label,
      lineNo: 1, creatorShareBps: 0, creatorAmountFen: 0, platformAmountFen: 20 };
    await service.authorizePaidItems([author.marketItem]);
  }
  assert.deepEqual(await service.image(state.a.version.versionId, 'sprite.png', { audience: 'public' }), state.a.fixture.png);
  await fails(() => service.freeBatch({ items: [select(state.a.version)] }, anonymousKey), 'creator_free_delivery_retired', 410);
});

add('draft changes and a new unapproved source cannot mutate approved public version', async () => {
  state.a.draftTitle = 'Unpublished Local Draft A';
  await service.updateWork(state.a.account, state.a.work.workId, metadata(state.a.draftTitle));
  const nextFixture = sourceFixture({ creatorId: state.a.account.creatorId, slug: state.a.slug }, { version: '2.0.0', pixel: 120 });
  const uploaded = await service.upload(state.a.account, state.a.work.workId, nextFixture.archive);
  state.a.unapprovedVersion = await repository.getVersion(uploaded.versionId);
  assert.notEqual(uploaded.versionId, state.a.version.versionId); assert.notEqual(uploaded.revision, state.a.version.revision);
  assert.equal(state.a.unapprovedVersion.state, 'READY');
  await fails(() => service.freeBatch({ items: [select(state.a.unapprovedVersion)] }, anonymousKey), 'creator_free_delivery_retired', 410);
  await service.submit(state.a.account, state.a.work.workId, uploaded.versionId, sharing);
  const published = await service.publicWork(state.a.work.workId);
  assert.equal(published.metadata.titleZh, state.a.approvedTitle); assert.equal(published.preview.versionId, state.a.version.versionId);
  assertFrozen(await frozenVersion(state.a.version.versionId), state.a.frozen);
});

add('author unpublish denies anonymous images and atomic downloads while preserving private preview', async () => {
  await repository.unpublish(state.a.work.workId, 'creator', state.a.account.creatorId, false, 'Synthetic author unpublish.');
  assert.equal((await repository.ownedWork(state.a.account.creatorId, state.a.work.workId)).state, 'UNPUBLISHED');
  const readsBefore = cos.reads.length;
  await fails(() => service.publicWork(state.a.work.workId), 'creator_work_not_found', 404);
  await fails(() => service.image(state.a.version.versionId, 'sprite.png', { audience: 'public' }), 'creator_work_not_found', 404);
  await fails(() => service.authorizePaidItems([state.a.marketItem]), 'creator_paid_delivery_unavailable', 409);
  await fails(() => service.freeBatch({ items: [select(state.a.version)] }, anonymousKey), 'creator_free_delivery_retired', 410);
  await fails(() => service.freeBatch({ items: [select(state.b.version), select(state.a.version)] }, anonymousKey), 'creator_free_delivery_retired', 410);
  assert.equal(cos.reads.length, readsBefore);
  assert.deepEqual(await service.image(state.a.version.versionId, 'sprite.png', { audience: 'creator', creatorId: state.a.account.creatorId }), state.a.fixture.png);
  await service.authorizePaidItems([state.b.marketItem]);
  await fails(() => service.freeBatch({ items: [select(state.b.version)] }, anonymousKey), 'creator_free_delivery_retired', 410);
});

add('author republish reuses only the frozen approved version and cannot publish a draft-only work', async () => {
  await service.republish(state.a.account, state.a.work.workId);
  const work = await repository.ownedWork(state.a.account.creatorId, state.a.work.workId), published = await service.publicWork(state.a.work.workId);
  assert.equal(work.state, 'PUBLISHED'); assert.equal(work.metadata.titleZh, state.a.draftTitle);
  assert.equal(published.metadata.titleZh, state.a.approvedTitle); assert.equal(published.preview.versionId, state.a.version.versionId);
  assertFrozen(await frozenVersion(state.a.version.versionId), state.a.frozen);
  const draft = await service.createWork(state.a.account, { slug: 'draft-' + namespace, ...metadata('Never approved draft') });
  await fails(() => service.republish(state.a.account, draft.workId), 'creator_republish_not_available', 409);
  await fails(() => service.republish(state.a.account, state.a.work.workId), 'creator_republish_not_available', 409);
});

add('complaint stores exact work/version identity; cross-work version is rejected without insert', async () => {
  const reported = await service.report(state.a.work.workId, { versionId: state.a.version.versionId, category: 'copyright',
    description: 'Synthetic local copyright complaint for integration.' }, anonymousKey);
  state.a.complaintId = reported.complaintId;
  const complaint = await one('SELECT work_id, version_id, state, category FROM gongde_creator_complaints WHERE complaint_id = ?', [reported.complaintId]);
  assert.equal(complaint.work_id, state.a.work.workId); assert.equal(complaint.version_id, state.a.version.versionId);
  assert.equal(complaint.state, 'OPEN'); assert.equal(complaint.category, 'copyright');
  const before = Number((await one('SELECT COUNT(*) AS total FROM gongde_creator_complaints WHERE work_id = ?', [state.a.work.workId])).total);
  await fails(() => service.report(state.a.work.workId, { versionId: state.b.version.versionId, category: 'copyright',
    description: 'Synthetic invalid cross-work complaint identity.' }, anonymousKey), 'creator_version_changed', 409);
  assert.equal(Number((await one('SELECT COUNT(*) AS total FROM gongde_creator_complaints WHERE work_id = ?', [state.a.work.workId])).total), before);
  const listed = (await repository.complaints('OPEN')).find(item => item.complaintId === reported.complaintId);
  assert.equal(listed.workId, state.a.work.workId); assert.equal(listed.versionId, state.a.version.versionId);
});

add('administrative suspension denies public access and author attempts to clear it', async () => {
  await repository.unpublish(state.a.work.workId, 'admin', admin, true, 'Synthetic local administrative suspension.');
  assert.equal((await repository.ownedWork(state.a.account.creatorId, state.a.work.workId)).state, 'SUSPENDED');
  await fails(() => service.republish(state.a.account, state.a.work.workId), 'creator_republish_not_available', 409);
  await fails(() => repository.unpublish(state.a.work.workId, 'creator', state.a.account.creatorId), 'creator_work_suspended', 409);
  await fails(() => service.authorizePaidItems([state.a.marketItem]), 'creator_paid_delivery_unavailable', 409);
  await fails(() => service.image(state.a.version.versionId, 'sprite.png', { audience: 'public' }), 'creator_work_not_found', 404);
  await audit('work.suspend', state.a.work.workId, 'admin', admin);
});

add('complaint dismissal/suspension are actual transactions with admin identity and immutable audit', async () => {
  const reason = 'Synthetic local dismissal must not clear a separate suspension.';
  await repository.decideComplaint(admin, state.a.complaintId, 'DISMISS', reason);
  assert.equal((await one('SELECT state FROM gongde_creator_complaints WHERE complaint_id = ?', [state.a.complaintId])).state, 'DISMISSED');
  assert.equal((await repository.ownedWork(state.a.account.creatorId, state.a.work.workId)).state, 'SUSPENDED');
  const detail = await audit('complaint.dismiss', state.a.complaintId, 'admin', admin);
  assert.equal(detail.workId, state.a.work.workId); assert.equal(detail.reason, reason);
  await fails(() => repository.decideComplaint(admin, state.a.complaintId, 'SUSPEND', 'Synthetic duplicate decision.'), 'creator_complaint_changed', 409);
  const bReport = await service.report(state.b.work.workId, { versionId: state.b.version.versionId, category: 'unsafe',
    description: 'Synthetic local complaint suspension workflow.' }, anonymousKey);
  state.b.complaintId = bReport.complaintId;
  await repository.decideComplaint(admin, bReport.complaintId, 'SUSPEND', 'Synthetic local complaint resolution.');
  assert.equal((await one('SELECT state FROM gongde_creator_complaints WHERE complaint_id = ?', [bReport.complaintId])).state, 'RESOLVED');
  assert.equal((await repository.ownedWork(state.b.account.creatorId, state.b.work.workId)).state, 'SUSPENDED');
  assert.equal((await audit('complaint.suspend', bReport.complaintId, 'admin', admin)).workId, state.b.work.workId);
  await fails(() => service.publicWork(state.b.work.workId), 'creator_work_not_found', 404);
});

add('real review/version/publication audit binds actors and frozen source; paid tables unchanged', async () => {
  await audit('work.create', state.a.work.workId, 'creator', state.a.account.creatorId);
  const versionDetail = await audit('version.upload', state.a.version.versionId, 'creator', state.a.account.creatorId);
  assert.equal(versionDetail.revision, state.a.version.revision); assert.equal(versionDetail.archiveSha256, state.a.version.archiveSha256);
  await audit('review.submit', state.a.firstReview, 'creator', state.a.account.creatorId);
  await audit('review.rejected', state.a.firstReview, 'admin', admin);
  await audit('review.approved', state.a.approvedReview, 'admin', admin);
  await audit('work.unpublish', state.a.work.workId, 'creator', state.a.account.creatorId);
  const republish = await audit('work.republish_approved', state.a.work.workId, 'creator', state.a.account.creatorId);
  assert.equal(republish.versionId, state.a.version.versionId); assert.equal(republish.revision, state.a.version.revision);
  for (const label of ['a', 'b']) assertFrozen(await frozenVersion(state[label].version.versionId), state[label].frozen);
  assert.deepEqual(await paidCounts(), state.paidBefore);
  assert.equal(io.forbiddenIoAttempts, 0); assert.ok(io.localTcpConnectAttempts >= 2);
});

const results = [];
let fatal;
const safeMessage = error => {
  let text = String(error.message ?? error.code ?? 'error').slice(0, 1000);
  for (const secret of secrets.filter(Boolean)) text = text.split(secret).join('[REDACTED_LOCAL_TEST_SECRET]');
  return text;
};
try {
  for (const test of cases) {
    assert.ok(performance.now() - started < 30000);
    const begin = performance.now();
    try {
      await test.run(); results.push({ name: test.name, passed: true, elapsedMs: performance.now() - begin });
      console.log('PASS REAL_LOCAL_MYSQL: ' + test.name);
    } catch (error) {
      results.push({ name: test.name, passed: false, code: error.code, status: error.status,
        message: safeMessage(error), elapsedMs: performance.now() - begin });
      console.log('FAIL REAL_LOCAL_MYSQL: ' + JSON.stringify(results.at(-1)));
      // Real prerequisite failures stop dependent actions instead of fabricating pass/skip counts.
      break;
    }
  }
} catch (error) { fatal = { code: error.code, message: safeMessage(error) }; }
finally {
  try { await repository.close(); } catch (error) { fatal = { code: error.code, message: safeMessage(error) }; }
  clearTimeout(deadline);
}
const passed = results.filter(result => result.passed).length;
const report = { evidence: 'REAL_LOCAL_MYSQL_DIRECT_SERVICE_WITH_EXPLICIT_MEMORY_COS',
  namespace, target: { host: target.host, port: target.port, database: target.database }, mysqlVersion: state.mysqlVersion,
  totalExecuted: results.length, planned: cases.length, passed, failed: results.length - passed,
  remainingNotExecuted: cases.length - results.length, fatal, elapsedMs: performance.now() - started,
  io, resources: { deadlineMs: 30000, suggestedV8HeapMiB: 96, maxRssBytes: process.resourceUsage().maxRSS * 1024 },
  results, boundaries: ['No suite DDL/migration/setup seed/cleanup/docker orchestration', 'No fake repository or SQL executor',
    'COS ACL/policy/storage are explicit memory fakes, not durable provider evidence',
    'Admin/content/rights inputs synthetic; no HTTP admin auth, real preview browser, native import or production evidence',
    'Serial local state/transaction checks do not prove deployment, concurrency stress or external acceptance'] };
const reportPath = HERE + 'mysql-' + namespace + '-results.json';
writeFileSync(reportPath, JSON.stringify(report, null, 2) + '\n');
console.log('REAL_LOCAL_MYSQL_RESULTS ' + JSON.stringify({ ...report, reportPath }));
process.exitCode = fatal || report.failed || results.length !== cases.length || io.forbiddenIoAttempts ? 1 : 0;
