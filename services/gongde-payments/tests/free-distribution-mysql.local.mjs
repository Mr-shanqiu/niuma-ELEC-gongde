import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { register } from 'node:module';
import { fileURLToPath } from 'node:url';
import mysql from 'mysql2/promise';

// ONLY the explicitly authorized disposable acceptance database. No .env,
// production configuration, Docker control, provider calls or artifact uploads.
// Supply the temporary test password through this process environment only.
const password = process.env.GONGDE_FREE_MYSQL_LOCAL_PASSWORD;
if (!password) throw new Error('temporary_local_mysql_password_required');
const configuration = { host: '127.0.0.1', port: 34891, database: 'gongde_free_acceptance',
  user: 'root', password, timezone: 'Z', charset: 'utf8mb4', connectTimeout: 2000, multipleStatements: false };
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const uid = () => randomBytes(16).toString('hex');
const sha = text => createHash('sha256').update(text).digest('hex');
const run = randomBytes(6).toString('hex');
const secret = randomBytes(32);
const anchor = Date.parse('2026-10-08T00:00:00+08:00');
let clock = anchor + 12 * 3600000;
let bootstrap, pool, stage = 'readiness', passed = 0;
const receipt = { target: 'gongde-free-090-acceptance', host: '127.0.0.1', port: 34891,
  database: 'gongde_free_acceptance', evidence: 'real MySQL transactions; fixture payloads, no actual signed-file/COS delivery', cases: [] };
const deadline = setTimeout(() => { process.stderr.write('LOCAL_MYSQL_ACCEPTANCE_DEADLINE\n'); process.exit(124); }, 120000);
deadline.unref();
async function query(connection, sql, values = []) { const [result] = await connection.execute(sql, values); return result; }
async function transaction(operation) {
  const connection = await pool.getConnection();
  try { await connection.beginTransaction(); const value = await operation(connection); await connection.commit(); return value; }
  catch (error) { await connection.rollback(); throw error; } finally { connection.release(); }
}
async function check(name, operation) {
  stage = name; await operation(); passed += 1; receipt.cases.push(name);
  process.stdout.write(JSON.stringify({ case: name, status: 'PASS' }) + '\n');
}
const errorCode = code => error => error?.code === code;

const loader = `import {readFileSync,existsSync} from 'node:fs';
import {createRequire} from 'node:module'; import {fileURLToPath} from 'node:url';
let ts, root; export function initialize(data){ts=createRequire(data.ts)(data.ts);root=data.root;}
export async function resolve(s,c,next){if(s.startsWith('.')&&c.parentURL?.startsWith(root)&&s.endsWith('.js')){
const u=new URL(s.slice(0,-3)+'.ts',c.parentURL);if(existsSync(fileURLToPath(u)))return {url:u.href,shortCircuit:true};}return next(s,c);}
export async function load(u,c,next){if(u.startsWith(root)&&u.endsWith('.ts'))return {format:'module',shortCircuit:true,
source:ts.transpileModule(readFileSync(fileURLToPath(u),'utf8'),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.ESNext}}).outputText};return next(u,c);}`;
register('data:text/javascript,' + encodeURIComponent(loader), { data: {
  ts: fileURLToPath(new URL('../node_modules/typescript/lib/typescript.js', import.meta.url)), root: new URL('../src/', import.meta.url).href
} });
const { FreeDistributionRepository, recordFreeContribution } = await import('../src/free-distribution/repository.ts');
const consent = await import('../src/creators/consent.ts');
const { DOWNLOAD_WINDOW_MS } = await import('../src/free-distribution/codes.ts');

function metadata(title) {
  const value = { titleZh: title, description: 'Temporary local transaction fixture', tags: [], priceFen: 0,
    acceptFreeDistribution: true, acceptAiContentReview: true, sharingTermsVersion: consent.FREE_CREATOR_TERMS_VERSION,
    sharingTermsSha256: consent.FREE_CREATOR_TERMS_SHA256, aiReviewTermsVersion: consent.FREE_CREATOR_AI_TERMS_VERSION,
    aiReviewTermsSha256: consent.FREE_CREATOR_AI_TERMS_SHA256 };
  value.publicTextSha256 = consent.creatorPublicTextDigest(value); return value;
}
async function creator(creatorId) {
  await query(pool, `INSERT INTO gongde_creators
    (creator_id,email,password_hash,display_name,state,created_at,updated_at)
    VALUES (?,NULL,'local-test-not-a-login-hash','Local acceptance','ACTIVE',?,?)`, [creatorId, new Date(clock), new Date(clock)]);
}
async function newVersion(connection, work, title) {
  const versionId = uid(), data = metadata(title), revision = sha(run + ':' + versionId);
  await query(connection, `INSERT INTO gongde_creator_work_versions
    (version_id,work_id,version_label,source_revision,archive_sha256,source_object_key,preview_object_key,
     source_manifest_json,validation_json,state,schema_version,archive_bytes,unpacked_bytes,decoded_image_bytes,
     delivery_bytes_upper_bound,created_at,reviewed_at,approved_metadata_json)
    VALUES (?,?,'1.0.0',?,?,?,NULL,?,?,'APPROVED',2,1024,2048,4096,4096,?,?,?)`,
  [versionId, work.workId, revision, revision, 'local-acceptance/' + versionId,
    JSON.stringify({ id: work.workId, version: '1.0.0' }), JSON.stringify({ localAcceptanceFixture: true }),
    new Date(clock), new Date(clock), JSON.stringify(data)]);
  await query(connection, `INSERT INTO gongde_creator_reviews
    (review_id,version_id,review_round,state,reviewer_reference,submitted_at,decided_at,metadata_snapshot_json)
    VALUES (?,?,1,'APPROVED','local-acceptance',?,?,?)`, [uid(), versionId, new Date(clock), new Date(clock), JSON.stringify(data)]);
  return { ...work, versionId, revision, metadata: data };
}
async function draft(creatorId, index) {
  const work = { workId: `local-free-${run}-${index}`, creatorId, fingerprint: sha(`normalized-test-content:${run}:${index}`) };
  return transaction(async connection => {
    await query(connection, `INSERT INTO gongde_creator_works
      (work_id,creator_id,slug,title_zh,description,tags_json,state,price_fen,created_at,updated_at)
      VALUES (?,?,?,'Local acceptance','Temporary fixture','[]','DRAFT',0,?,?)`,
    [work.workId, creatorId, `${run}-${index}`, new Date(clock), new Date(clock)]);
    const allocator = (await query(connection, 'SELECT next_serial FROM gongde_appearance_number_allocator WHERE allocator_id = 1 FOR UPDATE'))[0];
    const number = Number(allocator.next_serial);
    await query(connection, `INSERT INTO gongde_appearance_numbers (appearance_serial,source_kind,internal_id,created_at)
      VALUES (?,'community',?,?)`, [number, work.workId, new Date(clock)]);
    await query(connection, 'UPDATE gongde_appearance_number_allocator SET next_serial = ? WHERE allocator_id = 1', [number + 1]);
    return newVersion(connection, { ...work, number: String(number) }, `Acceptance ${index}`);
  });
}
async function publish(work, fingerprint = work.fingerprint) {
  return transaction(async connection => {
    // Same creator-first lock order as claim authorization and contribution edits.
    await query(connection, 'SELECT creator_id FROM gongde_creators WHERE creator_id = ? FOR UPDATE', [work.creatorId]);
    await query(connection, `UPDATE gongde_creator_works SET state = 'PUBLISHED',published_version_id = ?,
      published_metadata_json = ?,updated_at = ? WHERE work_id = ?`,
    [work.versionId, JSON.stringify(work.metadata), new Date(clock), work.workId]);
    return recordFreeContribution(connection, { workId: work.workId, creatorId: work.creatorId, contentFingerprint: fingerprint });
  });
}
function item(work) {
  return { appearanceNumber: work.number, sourceKind: 'community', assetId: work.workId, creatorId: work.creatorId,
    versionId: work.versionId, sourceRevision: work.revision, catalogRevision: work.versionId + ':' + work.revision,
    metadataSnapshot: work.metadata, consentSnapshot: work.metadata, deliveryBytesUpperBound: 4096,
    snapshotRecord: { workId: work.workId, sourceObjectKey: 'local-acceptance/' + work.versionId, sourceRevision: work.revision } };
}
function delivery(claim) {
  return { privateObjectKey: 'local-acceptance/delivery/' + claim.id, sha256: sha(claim.id), bytes: 2048,
    filename: `niuma-appearance-${claim.id}.nmgpack`, format: 'nmgpack', licenseMode: 'perpetual', signerVersion: 'local-fixture-v1' };
}

try {
  const readyDeadline = Date.now() + 40000;
  while (!bootstrap && Date.now() < readyDeadline) {
    try { bootstrap = await mysql.createConnection(configuration); await query(bootstrap, 'SELECT 1 AS ready'); }
    catch (error) { if (bootstrap) { await bootstrap.end().catch(() => {}); bootstrap = undefined; } await pause(500); }
  }
  if (!bootstrap) throw new Error('local_mysql_not_ready_within_40_seconds');
  const info = (await query(bootstrap, 'SELECT DATABASE() AS db, VERSION() AS version'))[0];
  assert.equal(info.db, 'gongde_free_acceptance'); assert.match(info.version, /^8\.4\./);
  receipt.mysqlVersion = info.version;
  const locked = (await query(bootstrap, "SELECT GET_LOCK('gongde_free_acceptance:repository-test',5) AS acquired"))[0];
  assert.equal(Number(locked.acquired), 1);
  stage = 'migrations_001_through_009';
  await query(bootstrap, `CREATE TABLE IF NOT EXISTS gongde_schema_migrations
    (filename VARCHAR(128) NOT NULL PRIMARY KEY,applied_at DATETIME(3) NOT NULL)
    ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci`);
  const directory = new URL('../migrations/', import.meta.url);
  const files = (await readdir(directory)).filter(name => /^00[1-9]_[A-Za-z0-9_-]+\.sql$/.test(name)).sort();
  assert.equal(files.length, 9); const migrationReceipt = { applied: [], skipped: [], additive008Replayed: false };
  for (const filename of files) {
    const applied = await query(bootstrap, 'SELECT filename FROM gongde_schema_migrations WHERE filename = ?', [filename]);
    if (applied.length && !filename.startsWith('008_')) { migrationReceipt.skipped.push(filename); continue; }
    const statements = (await readFile(new URL(filename, directory), 'utf8')).split(/;\s*(?:\n|$)/u).map(value => value.trim()).filter(Boolean);
    for (const statement of statements) await query(bootstrap, statement);
    if (applied.length) migrationReceipt.additive008Replayed = true;
    else { await query(bootstrap, 'INSERT INTO gongde_schema_migrations (filename,applied_at) VALUES (?,UTC_TIMESTAMP(3))', [filename]); migrationReceipt.applied.push(filename); }
  }
  receipt.migrations = migrationReceipt;
  process.stdout.write(JSON.stringify({ migrations: migrationReceipt, mysqlVersion: info.version }) + '\n');
  pool = mysql.createPool({ ...configuration, connectionLimit: 8, waitForConnections: true, queueLimit: 24 });
  const options = { codeSecret: secret, enabled: true, now: () => new Date(clock), deliveryReady: () => true,
    validateItems: async (connection, items) => {
      for (const selected of items) {
        const row = (await query(connection, `SELECT w.state,w.published_version_id,w.published_metadata_json,v.source_revision,v.state AS version_state
          FROM gongde_creator_works w JOIN gongde_creator_work_versions v ON v.work_id = w.work_id
          WHERE w.work_id = ? AND w.creator_id = ? AND v.version_id = ? FOR SHARE`, [selected.assetId, selected.creatorId, selected.versionId]))[0];
        assert.ok(row && row.state === 'PUBLISHED' && row.published_version_id === selected.versionId && row.version_state === 'APPROVED');
        assert.equal(row.source_revision, selected.sourceRevision);
        const approved = typeof row.published_metadata_json === 'string' ? JSON.parse(row.published_metadata_json) : row.published_metadata_json;
        assert.equal(consent.hasCurrentFreeConsent(approved), true);
      }
    }, checkSafety: async (connection, items) => {
      for (const selected of items) {
        if (selected.sourceKind === 'community') {
          const row = (await query(connection, 'SELECT state FROM gongde_creator_works WHERE work_id = ? FOR SHARE', [selected.assetId]))[0];
          if (!row || row.state === 'SUSPENDED') return false;
        } else {
          const row = (await query(connection, 'SELECT blocked FROM gongde_free_official_safety WHERE asset_id = ? FOR SHARE', [selected.assetId]))[0];
          if (row?.blocked) return false;
        }
      }
      return true;
    } };
  const repository = new FreeDistributionRepository(pool, options);
  const firstCreator = uid(), secondCreator = uid();
  await creator(firstCreator); await creator(secondCreator);
  let familyId, browser, firstWork, frozenClaim, readyClaim;
  const works = [];

  await check('short_number_allocation_same_creator_concurrent_and_internal_id_preserved', async () => {
    const watermark = Number((await query(pool, 'SELECT next_serial FROM gongde_free_creator_number_allocator WHERE allocator_id = 1'))[0].next_serial);
    const numbers = await Promise.all(Array.from({ length: 4 }, () => repository.ensureCreatorPublicNumber(firstCreator)));
    assert.deepEqual([...new Set(numbers)], ['C' + watermark]);
    assert.equal(await repository.ensureCreatorPublicNumber(secondCreator), 'C' + (watermark + 1));
    assert.equal((await query(pool, 'SELECT creator_id FROM gongde_free_creator_numbers WHERE serial = ?', [watermark]))[0].creator_id, firstCreator);
  });
  await check('new_contribution_once_in_real_publication_transaction', async () => {
    firstWork = await draft(firstCreator, 1); works.push(firstWork);
    const outcomes = await Promise.all(Array.from({ length: 4 }, () => publish(firstWork)));
    assert.equal(outcomes.filter(value => value.created).length, 1);
    assert.equal(new Set(outcomes.map(value => value.familyId)).size, 1); familyId = outcomes[0].familyId;
    assert.equal(Number((await query(pool, 'SELECT COUNT(*) AS n FROM gongde_free_contributions WHERE work_id = ?', [firstWork.workId]))[0].n), 1);
  });
  await check('duplicate_content_different_work_rolls_back_publication_and_no_contribution', async () => {
    const duplicate = await draft(firstCreator, 'duplicate');
    await assert.rejects(() => publish(duplicate, firstWork.fingerprint), errorCode('contribution_duplicate_content'));
    assert.equal((await query(pool, 'SELECT state FROM gongde_creator_works WHERE work_id = ?', [duplicate.workId]))[0].state, 'DRAFT');
    assert.equal(Number((await query(pool, 'SELECT COUNT(*) AS n FROM gongde_free_contributions WHERE creator_id = ?', [firstCreator]))[0].n), 1);
  });
  await check('author_3_6_9_10_permissions_repeated_shared_use_never_consumes', async () => {
    let originalCode;
    for (let n = 1; n <= 4; n += 1) {
      if (n > 1) { const work = await draft(firstCreator, n); works.push(work); await publish(work); }
      const current = await repository.getCurrentCode(familyId);
      originalCode ??= current.code; assert.equal(current.code, originalCode); assert.equal(current.authorization.limit, Math.min(3 * n, 10));
      const a = await repository.verifyCode({ code: current.code }), b = await repository.verifyCode({ code: current.code });
      for (const [index, auth] of [a, b].entries()) {
        const result = await repository.createClaim({ sessionToken: auth.sessionToken, idempotencyKey: `permission-${run}-${n}-${index}`, items: [item(firstWork)] });
        assert.equal(result.claim.limitSnapshot, Math.min(3 * n, 10));
        assert.equal((await repository.getSession(auth.sessionToken)).authorization.limit, Math.min(3 * n, 10));
        if (n === 1 && index === 0) { frozenClaim = result.claim; browser = auth; }
      }
      assert.equal((await repository.getCreatorFamily(firstCreator)).activeContributions, n);
    }
  });
  await check('shared_72_hour_boundary_group_and_creators_persist_across_repository_restart', async () => {
    const otherWork = await draft(secondCreator, 'other'); await publish(otherWork);
    const otherFamily = await repository.getCreatorFamily(secondCreator);
    let group = await repository.ensureGroupFamily();
    if (group.state !== 'ACTIVE') {
      await repository.mutateFamily({ familyId: group.id, action: group.state === 'REVOKED' ? 'restore' : 'resume', expectedRevision: group.revision, actor: 'local-acceptance', reason: 'local disposable group readiness' });
      group = await repository.ensureGroupFamily();
    }
    // A prior local suite may have used a different ephemeral key. Rotate only
    // this disposable GROUP generation, never any real or production family.
    await repository.mutateFamily({ familyId: group.id, action: 'rotate', expectedRevision: group.revision, actor: 'local-acceptance', reason: 'isolated disposable test generation' });
    const ids = [group.id, familyId, otherFamily.id];
    const current = await Promise.all(ids.map(value => repository.getCurrentCode(value)));
    assert.equal(new Set(current.map(value => value.authorization.expiresAt)).size, 1);
    const rebooted = new FreeDistributionRepository(pool, options);
    assert.equal((await rebooted.getCurrentCode(familyId)).code, current[1].code);
    clock = anchor + 72 * 3600000 - 1;
    await repository.verifyCode({ code: current[1].code });
    clock += 1;
    for (const code of current) await assert.rejects(() => repository.verifyCode({ code: code.code }), errorCode('access_code_expired'));
    for (const [index, identity] of ids.entries()) assert.notEqual((await repository.getCurrentCode(identity)).code, current[index].code);
    assert.equal((await repository.findClaimByKey({ sessionToken: browser.sessionToken, idempotencyKey: `permission-${run}-1-0` })).id, frozenClaim.id);
  });
  await check('concurrent_same_key_single_claim_real_session_lock', async () => {
    const code = await repository.getCurrentCode(familyId); browser = await repository.verifyCode({ code: code.code, sessionToken: browser.sessionToken });
    const key = 'concurrent-' + run;
    const responses = await Promise.all(Array.from({ length: 6 }, () => repository.createClaim({ sessionToken: browser.sessionToken, idempotencyKey: key, items: [item(works[1])] })));
    assert.equal(responses.filter(value => value.created).length, 1); assert.equal(new Set(responses.map(value => value.claim.id)).size, 1);
    const session = await repository.getSession(browser.sessionToken);
    assert.equal(Number((await query(pool, 'SELECT COUNT(*) AS n FROM gongde_free_claims WHERE session_id = ? AND idempotency_key = ?', [session.id, key]))[0].n), 1);
  });
  await check('ready_claim_freezes_version_update_and_ordinary_unlist_do_not_revoke', async () => {
    const lease = await repository.acquirePreparation(frozenClaim.id); assert.ok(lease);
    readyClaim = await repository.markReady({ claimId: frozenClaim.id, leaseToken: lease.leaseToken, artifact: delivery(frozenClaim), issuedAt: new Date(clock).toISOString() });
    const updated = await transaction(connection => newVersion(connection, firstWork, 'Updated fixture title'));
    await publish(updated, sha(run + ':updated-content'));
    await query(pool, "UPDATE gongde_creator_works SET state = 'UNLISTED' WHERE work_id = ?", [firstWork.workId]);
    const authorization = await repository.getDownloadAuthorization({ sessionToken: browser.sessionToken, claimId: frozenClaim.id });
    assert.equal(authorization.claim.items[0].versionId, firstWork.versionId);
    assert.equal(authorization.claim.items[0].metadataSnapshot.titleZh, firstWork.metadata.titleZh);
    assert.equal(authorization.claim.state, 'READY'); assert.equal(authorization.claim.importExpiresAt, null);
    assert.equal((await repository.getCreatorFamily(firstCreator)).activeContributions, 4);
  });
  await check('safety_block_entire_batch_durable_after_download_denial', async () => {
    await query(pool, "UPDATE gongde_creator_works SET state = 'SUSPENDED' WHERE work_id = ?", [firstWork.workId]);
    await assert.rejects(() => repository.getDownloadAuthorization({ sessionToken: browser.sessionToken, claimId: frozenClaim.id }), errorCode('claim_blocked'));
    assert.equal((await query(pool, 'SELECT state FROM gongde_free_claims WHERE id = ?', [frozenClaim.id]))[0].state, 'BLOCKED');
    await query(pool, "UPDATE gongde_creator_works SET state = 'UNLISTED' WHERE work_id = ?", [firstWork.workId]);
    assert.equal((await repository.getClaim({ sessionToken: browser.sessionToken, claimId: frozenClaim.id })).state, 'BLOCKED');
  });
  await check('lease_30_second_boundary_reclaim_and_stale_worker_fenced', async () => {
    const created = await repository.createClaim({ sessionToken: browser.sessionToken, idempotencyKey: 'lease-' + run, items: [item(works[1])] });
    const first = await repository.acquirePreparation(created.claim.id); assert.ok(first);
    clock = Date.parse(first.leaseExpiresAt) - 1; assert.equal(await repository.acquirePreparation(created.claim.id), null);
    clock += 1;
    await assert.rejects(() => repository.markReady({ claimId: created.claim.id, leaseToken: first.leaseToken, artifact: delivery(created.claim) }), errorCode('claim_lease_lost'));
    const next = await repository.acquirePreparation(created.claim.id); assert.ok(next);
    readyClaim = await repository.markReady({ claimId: created.claim.id, leaseToken: next.leaseToken, artifact: delivery(created.claim), issuedAt: new Date(clock).toISOString() });
    assert.equal(Number((await query(pool, 'SELECT COUNT(*) AS n FROM gongde_free_delivery_artifacts WHERE claim_id = ?', [created.claim.id]))[0].n), 1);
  });
  await check('seven_day_redownload_half_open_window_perpetual_local_license', async () => {
    const end = Date.parse(readyClaim.downloadExpiresAt); assert.equal(end, Date.parse(readyClaim.issuedAt) + DOWNLOAD_WINDOW_MS);
    clock = end - 1;
    const authorized = await repository.getDownloadAuthorization({ sessionToken: browser.sessionToken, claimId: readyClaim.id });
    assert.equal(Date.parse(authorized.linkExpiresAt), end); assert.equal(authorized.claim.importExpiresAt, null);
    clock = end;
    await assert.rejects(() => repository.getDownloadAuthorization({ sessionToken: browser.sessionToken, claimId: readyClaim.id }), errorCode('claim_download_expired'));
    assert.equal((await repository.getClaim({ sessionToken: browser.sessionToken, claimId: readyClaim.id })).state, 'EXPIRED');
  });
  receipt.status = 'PASS'; receipt.passed = passed; receipt.failed = 0; receipt.productFixes = 0;
  receipt.scope = '001..009 migrations and test fixtures only in the explicitly assigned disposable database; no container lifecycle changes';
  process.stdout.write(JSON.stringify(receipt) + '\n');
} catch (error) {
  // Never print connection configuration, password, cookies, codes or raw SQL.
  process.stderr.write(JSON.stringify({ status: 'FAIL', stage, passed, code: error.code ?? error.name, errno: error.errno ?? null, sqlState: error.sqlState ?? null }) + '\n');
  process.exitCode = 1;
} finally {
  clearTimeout(deadline);
  if (pool) await pool.end();
  if (bootstrap) { await query(bootstrap, "SELECT RELEASE_LOCK('gongde_free_acceptance:repository-test')").catch(() => {}); await bootstrap.end(); }
}
