import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync, randomBytes, verify } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { register } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import mysql from 'mysql2/promise';
import { unzipSync } from 'fflate';

// Parent-authorized, disposable local database ONLY. Password is process-local:
// never read .env, production secrets, provider configuration or existing keys.
// Run: GONGDE_FREE_MYSQL_LOCAL_PASSWORD=<temporary value> node this-file.mjs
// No migration runner or fixture deletion. Random identities are retained in SQL.
const password = process.env.GONGDE_FREE_MYSQL_LOCAL_PASSWORD;
if (!password) throw new Error('temporary_local_mysql_password_required');
const db = { host: '127.0.0.1', port: 34891, database: 'gongde_free_acceptance', user: 'root',
  password, timezone: 'Z', charset: 'utf8mb4', connectTimeout: 2000, multipleStatements: false };
const run = randomBytes(8).toString('hex'), uid = () => randomBytes(16).toString('hex');
const sha = input => createHash('sha256').update(input).digest('hex');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const fixture = { creatorId: uid(), versionId: uid(), reviewId: uid(), slug: `http-${run}` };
fixture.workId = `creator.${fixture.creatorId}.${fixture.slug}`;
const adminToken = randomBytes(32).toString('hex');
const adminCookie = `local_http_test_admin=${adminToken}`;
let pool, numbers, runtime, server, directory, base, stage = 'initialization';
let familyId, accessCookie, selection, claimId, artifact, lastHttp, unlistedOfficialAsset, passed = 0;
const reportIds = [];
const cases = [], observed = [], skipped = [];
const deadline = setTimeout(() => { process.stderr.write('LOCAL_HTTP_ACCEPTANCE_DEADLINE\n'); process.exit(124); }, 90000);
deadline.unref();

// Transpile the current source modules in memory, rather than testing stale dist
// or writing any product build artifact. Imports still resolve actual modules.
const loader = `import {readFileSync,existsSync} from 'node:fs';
import {createRequire} from 'node:module';import {fileURLToPath} from 'node:url';
let ts,root;export function initialize(d){ts=createRequire(d.ts)(d.ts);root=d.root;}
export async function resolve(s,c,next){if(s.startsWith('.')&&c.parentURL?.startsWith(root)&&s.endsWith('.js')){
const u=new URL(s.slice(0,-3)+'.ts',c.parentURL);if(existsSync(fileURLToPath(u)))return {url:u.href,shortCircuit:true};}return next(s,c);}
export async function load(u,c,next){if(u.startsWith(root)&&u.endsWith('.ts'))return {format:'module',shortCircuit:true,
source:ts.transpileModule(readFileSync(fileURLToPath(u),'utf8'),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.ESNext}}).outputText};return next(u,c);}`;
register('data:text/javascript,' + encodeURIComponent(loader), { data: {
  ts: fileURLToPath(new URL('../node_modules/typescript/lib/typescript.js', import.meta.url)),
  root: new URL('../src/', import.meta.url).href
} });
const { createFreeDistributionRuntime } = await import('../src/free-distribution/runtime.ts');
const { recordFreeContribution } = await import('../src/free-distribution/repository.ts');
const { AppearancePackSigner } = await import('../src/delivery/pack-signer.ts');
const { PrivatePackageStore } = await import('../src/delivery/private-package-store.ts');
const { AppearanceNumberRepository, registerCommunityAppearanceNumber } = await import('../src/domain/appearance-numbers.ts');
const { FreeDistributionError } = await import('../src/free-distribution/types.ts');
const consent = await import('../src/creators/consent.ts');

async function sql(text, values = []) { return (await pool.execute(text, values))[0]; }
async function check(name, operation) {
  stage = name; await operation(); passed++; cases.push(name);
  process.stdout.write(JSON.stringify({ case: name, status: 'PASS' }) + '\n');
}
function envelope(result) {
  assert.ok(result.body && typeof result.body === 'object' && 'data' in result.body);
  assert.ok(Number.isFinite(Date.parse(result.body.serverTime)));
  assert.equal(typeof result.body.requestId, 'string');
  assert.match(result.headers.get('cache-control'), /private.*no-store/);
  return result.body.data;
}
async function http(path, { method = 'GET', body, cookie, admin = false, origin = base, crossSite = false, key } = {}) {
  const headers = { 'content-type': 'application/json' };
  if (method !== 'GET' && origin !== null) headers.origin = origin;
  if (crossSite) headers['sec-fetch-site'] = 'cross-site';
  const cookies = [cookie, admin ? adminCookie : null].filter(Boolean);
  if (cookies.length) headers.cookie = cookies.join('; ');
  if (key) headers['idempotency-key'] = key;
  // Only actual loopback HTTP is fetched. Returned simulated COS links are NEVER
  // requested. No real money, SMS, review-provider or public download traffic.
  const response = await fetch(base + '/api/gongde/v2' + path, { method, headers,
    body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(5000) });
  const result = { status: response.status, headers: response.headers, body: await response.json() };
  lastHttp = { method, path: path.split('?')[0], status: result.status,
    error: typeof result.body?.error === 'string' && /^[a-z_]+$/.test(result.body.error) ? result.body.error : null };
  return result;
}

// Real PrivatePackageStore, but its injected COS TRANSPORT is explicitly fake.
// It checks private ACL, upload/head metadata and link bounds in real store code.
function fakeCosTransport() {
  const objects = new Map();
  const owner = { ACL: 'private', Owner: { ID: 'local-fake-cos-owner' },
    Grants: [{ Grantee: { ID: 'local-fake-cos-owner' } }] };
  let uploads = 0;
  const missing = () => Object.assign(new Error('local_fake_cos_missing'), { statusCode: 404, code: 'NoSuchBucketPolicy' });
  return {
    objects, get uploads() { return uploads; },
    async getBucketAcl() { return owner; },
    async getBucketPolicy() { throw missing(); },
    async getObjectAcl({ Key }) { if (!objects.has(Key)) throw missing(); return owner; },
    async headObject({ Key }) {
      const value = objects.get(Key); if (!value) throw missing();
      return { headers: { 'content-length': String(value.content.length), 'x-cos-meta-sha256': value.sha256 } };
    },
    async putObject(input) {
      assert.equal(input.ACL, 'private'); assert.equal(input.CacheControl, 'private, no-store');
      const content = Buffer.from(input.Body), digest = sha(content);
      assert.equal(input.ContentLength, content.length); assert.equal(input.Headers['x-cos-meta-sha256'], digest);
      objects.set(input.Key, { content, sha256: digest }); uploads++;
      return { statusCode: 200 };
    },
    getObjectUrl(input) {
      assert.equal(input.Sign, true); assert.ok(objects.has(input.Key));
      const from = Math.floor(Date.now() / 1000);
      const url = new URL(`https://${input.Bucket}.cos.${input.Region}.myqcloud.com/${input.Key}`);
      url.searchParams.set('q-sign-time', `${from};${from + input.Expires}`);
      url.searchParams.set('q-signature', 'LOCAL_FAKE_COS_NOT_A_REAL_SIGNATURE');
      return url.href;
    }
  };
}
const fakeCos = fakeCosTransport();
const privateStore = new PrivatePackageStore({ bucket: 'gongde-paid-local-http-123456', region: 'ap-shanghai',
  secretId: 'LOCAL_FAKE_COS_ONLY', secretKey: 'LOCAL_FAKE_COS_ONLY' }, fakeCos);
const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
const adminIdentity = request => {
  if (!String(request.headers.cookie ?? '').split(';').some(part => part.trim() === adminCookie)) {
    throw new FreeDistributionError('admin_auth_required', 401);
  }
  return `local-http-${run}`;
};
const creatorDependencies = {
  setPublicationObserver() {},
  async requireAccount() { throw new FreeDistributionError('creator_auth_required', 401); },
  async loadFrozenSource() { throw new Error('unexpected_community_delivery_not_in_this_http_fixture'); }
};

async function sourceFixtures() {
  directory = await mkdtemp(join(tmpdir(), 'gongde-http-acceptance-'));
  const keyFile = join(directory, 'test-only-p256.pem'), codeFile = join(directory, 'test-only-code-key');
  await writeFile(keyFile, privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 });
  await writeFile(codeFile, randomBytes(32).toString('hex'), { mode: 0o600 });
  const assetRoot = join(directory, 'test-assets'); await mkdir(assetRoot);
  const mapping = {
    'official.lucky-cat': 'lucky-cat', 'official.hamster-wheel': 'hamster-wheel', 'official.sea-lion-belly-pat': 'sea-lion-belly-pat',
    'official.chick-pecking': 'chick-pecking', 'zqscreen.caishen-ingot': 'caishen-ingot', 'zqscreen.redpanda-wave': 'red-panda-wave',
    'zqscreen.shiba-tilt': 'shiba-tilt', 'zqscreen.orange-cat-wave': 'orange-cat-wave', 'zqscreen.raccoon-cheer': 'raccoon-cheer',
    'zqscreen.golden-toad-coin': 'golden-toad-coin', 'zqscreen.little-jiangshi-hop': 'little-jiangshi-hop', 'zqscreen.frog-puff': 'frog-puff',
    'zqscreen.bee-flap': 'bee-flap', 'zqscreen.koi-bubbles': 'koi-bubbles', 'zqscreen.kiss-couple': 'sweet-kiss',
    'zqscreen.baodan-charm': 'baodan-charm', 'zqscreen.woodpecker-peck': 'woodpecker-peck',
    'zqscreen.zhuan-yun-bead': 'fortune-bead', 'zqscreen.treasure-basin': 'treasure-basin'
  };
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aP6UAAAAASUVORK5CYII=', 'base64');
  for (const [id, folder] of Object.entries(mapping)) {
    const path = join(assetRoot, folder); await mkdir(path);
    await writeFile(join(path, 'manifest.json'), JSON.stringify({ schema_version: 1, id, version: '1.0.0',
      name: 'Local HTTP signing fixture', description: 'Local acceptance only', preview: 'body.png', layers: [{ image: 'body.png' }] }));
    await writeFile(join(path, 'body.png'), png);
  }
  const installerFile = join(directory, 'test-installers.json');
  await writeFile(installerFile, JSON.stringify({ items: ['windows', 'macos'].map(platform => ({ platform,
    format: platform === 'macos' ? 'dmg' : 'exe', releaseId: `http-test-${run}-${platform}`, version: '0.9.0',
    bytes: 1, sha256: sha(platform + run), publicDownloadUrl: `https://download.gongde.zqscreen.cn/LOCAL-TEST-NOT-A-RELEASE-${run}.${platform === 'macos' ? 'dmg' : 'exe'}`,
    perpetualCompatible: true })) }));
  Object.assign(process.env, { GONGDE_FREE_DISTRIBUTION_ENABLED: 'true', GONGDE_FREE_DISTRIBUTION_SECRET_FILE: codeFile,
    GONGDE_PACK_ASSET_ROOT: assetRoot, GONGDE_PACK_SIGNING_KEY_FILE: keyFile, GONGDE_FREE_INSTALLERS_FILE: installerFile,
    GONGDE_CREATOR_PUBLIC_ORIGIN: base, GONGDE_CREATOR_TRUSTED_PROXY_ADDRESSES: '' });
  const signer = new AppearancePackSigner({ assetRoot, privateKeyFile: keyFile }); signer.prepareAssets();
  return signer;
}
async function createSqlFixture() {
  const metadata = { titleZh: `HTTP${run}`, description: 'Local HTTP acceptance source', tags: [], priceFen: 0,
    creatorDouyinNumber: null, acceptFreeDistribution: true, acceptAiContentReview: true,
    sharingTermsVersion: consent.FREE_CREATOR_TERMS_VERSION, sharingTermsSha256: consent.FREE_CREATOR_TERMS_SHA256,
    aiReviewTermsVersion: consent.FREE_CREATOR_AI_TERMS_VERSION, aiReviewTermsSha256: consent.FREE_CREATOR_AI_TERMS_SHA256 };
  metadata.publicTextSha256 = consent.creatorPublicTextDigest(metadata);
  const revision = sha(run + ':local-sql-source'), connection = await pool.getConnection();
  try {
    await connection.beginTransaction();
    await connection.execute(`INSERT INTO gongde_creators
      (creator_id,email,password_hash,display_name,state,created_at,updated_at)
      VALUES (?,NULL,'LOCAL_TEST_NOT_A_LOGIN_HASH','Local HTTP acceptance','ACTIVE',UTC_TIMESTAMP(3),UTC_TIMESTAMP(3))`, [fixture.creatorId]);
    await connection.execute(`INSERT INTO gongde_creator_works
      (work_id,creator_id,slug,title_zh,description,tags_json,state,price_fen,created_at,updated_at)
      VALUES (?,?,?,?,?,'[]','DRAFT',0,UTC_TIMESTAMP(3),UTC_TIMESTAMP(3))`, [fixture.workId, fixture.creatorId, fixture.slug, metadata.titleZh, metadata.description]);
    await registerCommunityAppearanceNumber(connection, fixture.workId);
    await connection.execute(`INSERT INTO gongde_creator_work_versions
      (version_id,work_id,version_label,source_revision,archive_sha256,source_object_key,preview_object_key,
       source_manifest_json,validation_json,state,schema_version,archive_bytes,unpacked_bytes,decoded_image_bytes,
       delivery_bytes_upper_bound,created_at,reviewed_at,approved_metadata_json)
      VALUES (?,?,'1.0.0',?,?,?,NULL,?,?,'APPROVED',2,1024,2048,4096,4096,UTC_TIMESTAMP(3),UTC_TIMESTAMP(3),?)`,
    [fixture.versionId, fixture.workId, revision, revision, `local-http/${run}/${fixture.versionId}`,
      JSON.stringify({ schema_version: 1, id: fixture.workId, version: '1.0.0', preview: 'body.png', layers: [{ image: 'body.png' }] }),
      JSON.stringify({ imageNames: ['body.png'], localAcceptanceFixture: true }), JSON.stringify(metadata)]);
    await connection.execute(`INSERT INTO gongde_creator_reviews
      (review_id,version_id,review_round,state,reviewer_reference,submitted_at,decided_at,metadata_snapshot_json)
      VALUES (?,?,1,'APPROVED','LOCAL_HTTP_SQL_FIXTURE',UTC_TIMESTAMP(3),UTC_TIMESTAMP(3),?)`, [fixture.reviewId, fixture.versionId, JSON.stringify(metadata)]);
    await connection.execute(`UPDATE gongde_creator_works SET state='PUBLISHED',published_version_id=?,
      published_metadata_json=?,first_published_at=UTC_TIMESTAMP(3) WHERE work_id=?`, [fixture.versionId, JSON.stringify(metadata), fixture.workId]);
    const contribution = await recordFreeContribution(connection, { workId: fixture.workId, creatorId: fixture.creatorId, contentFingerprint: sha(run + ':content') });
    familyId = contribution.familyId;
    await connection.commit();
  } catch (error) { await connection.rollback(); throw error; } finally { connection.release(); }
  fixture.number = String((await sql("SELECT appearance_serial FROM gongde_appearance_numbers WHERE source_kind='community' AND internal_id=?", [fixture.workId]))[0].appearance_serial);
}

try {
  pool = mysql.createPool({ ...db, connectionLimit: 3, waitForConnections: true, queueLimit: 16 });
  await check('real_mysql_34891_existing_migrations_ready_no_replay', async () => {
    const info = (await sql('SELECT DATABASE() AS db,VERSION() AS version'))[0];
    assert.equal(info.db, 'gongde_free_acceptance'); assert.match(info.version, /^8\.4\./);
    const migrations = await sql("SELECT filename FROM gongde_schema_migrations WHERE filename REGEXP '^00[1-9]_' ORDER BY filename");
    assert.equal(migrations.length, 9);
    observed.push({ mysqlVersion: info.version, migrations: 9, migrationWrites: 0 });
    const badFixtures = await sql(`SELECT w.work_id FROM gongde_creator_works w JOIN gongde_creator_work_versions v ON v.version_id=w.published_version_id
      WHERE w.state='PUBLISHED' AND w.work_id LIKE 'local-free-%'
      AND JSON_EXTRACT(v.validation_json,'$.imageNames') IS NULL`);
    assert.equal(badFixtures.length, 0, 'shared_worker_preview_fixtures_must_be_unlisted_by_their_owner');
  });
  server = createServer(async (request, response) => {
    try {
      if (!runtime || !await runtime.handle(request, response, new URL(request.url, base))) {
        response.writeHead(404, { 'content-type': 'application/json' }); response.end(JSON.stringify({ error: 'not_runtime_route' }));
      }
    } catch { response.writeHead(500); response.end('{}'); }
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  base = `http://127.0.0.1:${server.address().port}`;
  const signer = await sourceFixtures();
  numbers = new AppearanceNumberRepository(db);
  const dependencies = { database: db, signer, packages: privateStore, creators: creatorDependencies, numbers,
    officialStates: async () => Object.fromEntries(['official.lucky-cat', 'official.hamster-wheel'].map(assetId =>
      [assetId, { state: assetId === unlistedOfficialAsset ? 'UNPUBLISHED' : 'PUBLISHED' }])),
    requireAdmin: adminIdentity };
  runtime = createFreeDistributionRuntime({ ...dependencies, packages: null });
  await check('config_no_store_fail_closed_without_private_store', async () => {
    const response = await http('/config'); assert.equal(response.status, 200);
    const data = envelope(response); assert.equal(data.ready, false); assert.equal(data.importExpiresAt, null);
    assert.equal(data.licenseMode, 'perpetual'); assert.equal(data.downloadRetentionSeconds, 604800);
    assert.equal(data.maxItems, 10); assert.equal(data.maxBatchBytes, 16 * 1024 * 1024);
    assert.equal(data.code, undefined); assert.equal(data.secret, undefined);
  });
  await runtime.close(); runtime = createFreeDistributionRuntime(dependencies);
  await createSqlFixture();
  await check('config_ready_real_sql_test_installer_metadata_fake_private_cos', async () => {
    const response = await http('/config'); assert.equal(response.status, 200); assert.equal(envelope(response).ready, true);
    assert.equal(fakeCos.uploads, 0);
  });
  await check('public_number_catalog_official_and_random_community_safe_projection', async () => {
    const response = await http('/appearances'); assert.equal(response.status, 200);
    const items = envelope(response).items;
    const official = items.find(item => item.authorPublicNumber === null), community = items.find(item => item.number === fixture.number);
    assert.ok(official && community); assert.match(official.number, /^[1-9][0-9]{5,8}$/);
    assert.equal(community.title, `HTTP${run}`);
    for (const item of items) for (const forbidden of ['snapshot', 'snapshotRecord', 'sourceObjectKey', 'code', 'phone', 'contact', 'evidence']) assert.equal(item[forbidden], undefined);
    const detail = await http(`/appearances/${official.number}`); assert.equal(detail.status, 200);
    selection = { items: [{ number: official.number, catalogRevision: envelope(detail).catalogRevision }] };
  });
  await check('admin_unauthorized_no_current_code_leak', async () => {
    for (const path of ['/admin/group-code', `/admin/creators/${fixture.creatorId}/promotion`, '/admin/claims', '/admin/stats', '/admin/reports?state=OPEN']) {
      const response = await http(path); assert.equal(response.status, 401); assert.equal(response.body.data, undefined);
    }
  });
  let creatorCode;
  await check('real_creator_promotion_and_verify_cookie_three_nonconsuming_permissions', async () => {
    const response = await http(`/admin/creators/${fixture.creatorId}/promotion`, { admin: true }); assert.equal(response.status, 200);
    const promotion = envelope(response); assert.equal(promotion.familyId, familyId); assert.equal(promotion.contributionCount, 1);
    assert.equal(promotion.maxItems, 3); creatorCode = promotion.code; assert.ok(creatorCode);
    const verified = await http('/access/verify', { method: 'POST', body: { code: creatorCode } }); assert.equal(verified.status, 200);
    assert.equal(envelope(verified).maxItems, 3);
    accessCookie = verified.headers.get('set-cookie').split(';')[0]; assert.match(accessCookie, /^gongde_download_session=/);
    assert.match(verified.headers.get('set-cookie'), /HttpOnly; SameSite=Lax/);
  });
  await check('csrf_missing_foreign_origin_and_cross_site_rejected_before_write', async () => {
    const before = Number((await sql('SELECT COUNT(*) AS n FROM gongde_free_claims WHERE family_id=?', [familyId]))[0].n);
    for (const options of [{ origin: null }, { origin: 'https://foreign.invalid' }, { crossSite: true }]) {
      const response = await http('/claims/appearances', { method: 'POST', body: selection, cookie: accessCookie, key: `csrf-${run}`, ...options });
      assert.equal(response.status, 403); assert.equal(response.body.error, 'origin_required');
    }
    assert.equal(Number((await sql('SELECT COUNT(*) AS n FROM gongde_free_claims WHERE family_id=?', [familyId]))[0].n), before);
  });
  const key = `claim-${run}`;
  await check('real_http_create_claim_async_ready_and_sql_frozen_items', async () => {
    const created = await http('/claims/appearances', { method: 'POST', body: selection, cookie: accessCookie, key }); assert.equal(created.status, 202);
    claimId = envelope(created).claimId;
    const end = Date.now() + 15000;
    while (Date.now() < end) {
      const response = await http(`/claims/${claimId}`, { cookie: accessCookie }); assert.equal(response.status, 200);
      const claim = envelope(response);
      if (claim.state === 'READY') { artifact = claim; break; }
      assert.equal(claim.state, 'PREPARING', `unexpected_claim_state:${claim.state}:${claim.errorCode ?? 'none'}`);
      await sleep(100);
    }
    assert.ok(artifact, 'claim_not_ready_in_15_seconds'); assert.equal(artifact.licenseMode, 'perpetual'); assert.equal(artifact.importExpiresAt, null);
    assert.equal(Date.parse(artifact.downloadExpiresAt) - Date.parse(artifact.issuedAt), 604800000);
    const persisted = (await sql('SELECT c.state,i.appearance_number,i.catalog_revision FROM gongde_free_claims c JOIN gongde_free_claim_items i ON i.claim_id=c.id WHERE c.id=?', [claimId]))[0];
    assert.equal(persisted.state, 'READY'); assert.equal(String(persisted.appearance_number), selection.items[0].number);
    assert.equal(persisted.catalog_revision, selection.items[0].catalogRevision); assert.equal(fakeCos.uploads, 1);
  });
  await check('download_link_real_private_store_fake_cos_and_random_p256_signature', async () => {
    const response = await http(`/claims/${claimId}/download-link`, { method: 'POST', body: {}, cookie: accessCookie }); assert.equal(response.status, 200);
    const link = envelope(response), url = new URL(link.url);
    assert.equal(url.hostname, 'gongde-paid-local-http-123456.cos.ap-shanghai.myqcloud.com');
    assert.ok(Date.parse(link.expiresAt) > Date.now()); assert.ok(Date.parse(link.expiresAt) <= Date.now() + 300000);
    assert.ok(Date.parse(link.expiresAt) <= Date.parse(artifact.downloadExpiresAt));
    const object = fakeCos.objects.get(decodeURIComponent(url.pathname.slice(1))); assert.ok(object);
    assert.equal(sha(object.content), artifact.sha256); assert.equal(object.content.length, artifact.bytes);
    const entries = unzipSync(object.content), manifest = JSON.parse(Buffer.from(entries['manifest.json']).toString('utf8'));
    assert.deepEqual(Object.keys(manifest.license).sort(), ['content_sha256', 'download_id', 'issued_at', 'mode', 'signature']);
    assert.equal(manifest.license.mode, 'perpetual'); assert.equal(manifest.license.download_id, claimId);
    const digest = createHash('sha256');
    for (const name of Object.keys(entries).filter(name => name !== 'manifest.json').sort()) {
      const bytes = Buffer.from(entries[name]), length = Buffer.alloc(8); length.writeBigUInt64BE(BigInt(bytes.length));
      digest.update(name, 'utf8').update(Buffer.from([0])).update(length).update(bytes);
    }
    assert.equal(digest.digest('hex'), manifest.license.content_sha256);
    const license = manifest.license;
    const message = `NIUMA-PACK-LICENSE-V2\nperpetual\n${manifest.id}\n${manifest.version}\n${license.issued_at}\n${license.download_id}\n${license.content_sha256}`;
    assert.equal(verify('SHA256', Buffer.from(message), { key: publicKey, dsaEncoding: 'ieee-p1363' }, Buffer.from(license.signature, 'hex')), true);
  });
  await check('idempotent_response_recovery_same_claim_no_extra_sql_or_upload', async () => {
    const replay = await http('/claims/appearances', { method: 'POST', body: selection, cookie: accessCookie, key }); assert.equal(replay.status, 200);
    assert.equal(envelope(replay).claimId, claimId);
    assert.equal(Number((await sql('SELECT COUNT(*) AS n FROM gongde_free_claims WHERE family_id=?', [familyId]))[0].n), 1);
    assert.equal(fakeCos.uploads, 1);
    const access = await http('/access', { cookie: accessCookie }); assert.equal(envelope(access).maxItems, 3);
  });
  await check('stale_selection_and_changed_idempotency_payload_409_no_claim', async () => {
    const stale = { items: [{ ...selection.items[0], catalogRevision: sha(run + ':stale') }] };
    const rejected = await http('/claims/appearances', { method: 'POST', body: stale, cookie: accessCookie, key: `stale-${run}` });
    assert.equal(rejected.status, 409); assert.equal(rejected.body.error, 'catalog_revision_changed');
    const conflict = await http('/claims/appearances', { method: 'POST', body: stale, cookie: accessCookie, key });
    assert.equal(conflict.status, 409); assert.equal(conflict.body.error, 'idempotency_conflict');
    assert.equal(Number((await sql('SELECT COUNT(*) AS n FROM gongde_free_claims WHERE family_id=?', [familyId]))[0].n), 1);
  });
  await check('claim_id_without_session_cannot_read_or_download', async () => {
    for (const options of [{}, { cookie: `gongde_download_session=${randomBytes(32).toString('hex')}` }]) {
      const read = await http(`/claims/${claimId}`, options); assert.ok([401, 404].includes(read.status));
      const download = await http(`/claims/${claimId}/download-link`, { ...options, method: 'POST', body: {} }); assert.ok([401, 404].includes(download.status));
      assert.equal(download.body.data, undefined);
    }
  });
  await check('cleared_authorization_existing_claim_recovers_new_claim_denied', async () => {
    const clear = await http('/access', { method: 'DELETE', cookie: accessCookie }); assert.equal(clear.status, 200);
    const recovered = await http('/claims/appearances', { method: 'POST', body: selection, cookie: accessCookie, key }); assert.equal(recovered.status, 200);
    assert.equal(envelope(recovered).claimId, claimId);
    const fresh = await http('/claims/appearances', { method: 'POST', body: selection, cookie: accessCookie, key: `fresh-${run}` }); assert.equal(fresh.status, 403);
    assert.equal(fresh.body.error, 'access_code_required');
  });
  await check('official_community_reports_original_normalized_text_admin_only_and_one_audit', async () => {
    const original = { description: `  Local report ${run}: <script>alert('literal')</script> SQL ' OR 1=1 -- e\u0301  `,
      evidenceText: `  Original evidence ${run}\nhttps://never-fetch.invalid/a <b>not HTML</b> e\u0301  `,
      contact: `  local-test-${run}@example.invalid  ` };
    for (const number of [selection.items[0].number, fixture.number]) {
      const created = await http('/reports', { method: 'POST', body: { number, category: 'other', ...original }, cookie: accessCookie }); assert.equal(created.status, 201);
      const id = envelope(created).reportId;
      reportIds.push(id);
      const stored = (await sql('SELECT * FROM gongde_free_reports WHERE id=?', [id]))[0];
      assert.equal(String(stored.appearance_number), number); assert.equal(stored.description, original.description.trim().normalize('NFC'));
      assert.equal(stored.evidence, original.evidenceText.trim().normalize('NFC')); assert.equal(stored.contact, original.contact.trim().normalize('NFC'));
      if (number === fixture.number) assert.equal(stored.version_id, fixture.versionId);
      const unauthorized = await http('/admin/reports?state=OPEN'); assert.equal(unauthorized.status, 401); assert.equal(unauthorized.body.data, undefined);
      const list = await http('/admin/reports?state=OPEN&page=1&perPage=100', { admin: true }); assert.equal(list.status, 200);
      const returned = envelope(list).items.find(report => report.id === id); assert.ok(returned);
      assert.equal(returned.description, stored.description); assert.equal(returned.evidence, stored.evidence); assert.equal(returned.contact, stored.contact);
      const noCsrf = await http(`/admin/reports/${id}/resolve`, { method: 'POST', body: { reason: 'Local investigation completed' }, admin: true, origin: null }); assert.equal(noCsrf.status, 403);
      const reason = `Local investigation ${run}; no implicit work suspension`;
      const resolved = await http(`/admin/reports/${id}/resolve`, { method: 'POST', body: { reason }, admin: true }); assert.equal(resolved.status, 200); assert.equal(envelope(resolved).ok, true);
      const duplicate = await http(`/admin/reports/${id}/resolve`, { method: 'POST', body: { reason: 'Never overwrite previous decision' }, admin: true }); assert.equal(duplicate.status, 409);
      const final = (await sql('SELECT * FROM gongde_free_reports WHERE id=?', [id]))[0]; assert.equal(final.state, 'RESOLVED'); assert.equal(final.resolution, reason);
      assert.equal(final.description, stored.description); assert.equal(final.evidence, stored.evidence); assert.equal(final.contact, stored.contact);
      assert.equal(Number((await sql("SELECT COUNT(*) AS n FROM gongde_free_audit WHERE subject=? AND action='report-resolve'", [id]))[0].n), 1);
    }
    const publicCard = envelope(await http(`/appearances/${fixture.number}`)); assert.equal(publicCard.contact, undefined); assert.equal(publicCard.evidence, undefined);
  });
  await check('admin_claims_stats_real_sql_and_random_family_isolation', async () => {
    const list = await http('/admin/claims?page=1&perPage=100', { admin: true }); assert.equal(list.status, 200);
    const record = envelope(list).items.find(item => item.claimId === claimId); assert.ok(record);
    assert.equal(record.codeFamilyId, familyId); assert.equal(record.state, 'READY'); assert.equal(record.downloadExpiresAt, artifact.downloadExpiresAt);
    const count = Number((await sql("SELECT COUNT(*) AS n FROM gongde_free_claims WHERE family_id=? AND state='READY'", [familyId]))[0].n); assert.equal(count, 1);
    const stats = await http('/admin/stats', { admin: true }); assert.equal(stats.status, 200);
    assert.ok(envelope(stats).readyClaims >= count); assert.equal(envelope(stats).installerRequests, null);
    assert.equal(Number((await sql('SELECT COUNT(*) AS n FROM gongde_free_delivery_artifacts WHERE claim_id=?', [claimId]))[0].n), 1);
  });
  let officialAsset, initialSafety;
  await check('official_safety_real_sql_concurrent_revision_atomic_audit_block_and_restore_download', async () => {
    officialAsset = (await sql("SELECT internal_id FROM gongde_appearance_numbers WHERE source_kind='official' AND appearance_serial=?", [selection.items[0].number]))[0].internal_id;
    const unauthorized = await http('/admin/official-safety'); assert.equal(unauthorized.status, 401);
    const list = await http('/admin/official-safety', { admin: true }); assert.equal(list.status, 200);
    initialSafety = envelope(list).items.find(item => item.assetId === officialAsset); assert.ok(initialSafety); assert.equal(initialSafety.blocked, false);
    const actionPath = `/admin/official-safety/${officialAsset}/block`;
    const missing = await http(actionPath, { method: 'POST', admin: true, body: { reason: 'Missing revision must not mutate safety' } }); assert.equal(missing.status, 400);
    const noCsrf = await http(actionPath, { method: 'POST', admin: true, origin: null, body: { requireCurrentRevision: initialSafety.revision, reason: 'No CSRF must not mutate safety' } }); assert.equal(noCsrf.status, 403);
    const auditBefore = Number((await sql("SELECT COUNT(*) AS n FROM gongde_free_audit WHERE subject=? AND action IN ('official-safety.block','official-safety.unblock')", [officialAsset]))[0].n);
    const attempts = await Promise.all([1, 2].map(index => http(actionPath, { method: 'POST', admin: true,
      body: { requireCurrentRevision: initialSafety.revision, reason: `Local official safety block ${run} ${index}` } })));
    assert.deepEqual(attempts.map(result => result.status).sort(), [200, 409]);
    const blocked = envelope(attempts.find(result => result.status === 200)); assert.equal(blocked.blocked, true); assert.equal(blocked.revision, initialSafety.revision + 1);
    const catalog = await http(`/appearances?q=${selection.items[0].number}`); assert.equal(catalog.status, 200); assert.equal(envelope(catalog).items.length, 0);
    const detail = await http(`/appearances/${selection.items[0].number}`); assert.equal(detail.status, 404);
    const denied = await http(`/claims/${claimId}/download-link`, { method: 'POST', body: {}, cookie: accessCookie }); assert.equal(denied.status, 403); assert.equal(denied.body.error, 'claim_blocked');
    assert.equal((await sql('SELECT state FROM gongde_free_claims WHERE id=?', [claimId]))[0].state, 'BLOCKED');
    const restored = await http(`/admin/official-safety/${officialAsset}/unblock`, { method: 'POST', admin: true,
      body: { requireCurrentRevision: blocked.revision, reason: `Local official safety restored ${run}` } });
    assert.equal(restored.status, 200); const final = envelope(restored); assert.equal(final.blocked, false); assert.equal(final.revision, blocked.revision + 1);
    const stale = await http(actionPath, { method: 'POST', admin: true, body: { requireCurrentRevision: initialSafety.revision, reason: 'Stale safety revision cannot overwrite' } }); assert.equal(stale.status, 409);
    const downloaded = await http(`/claims/${claimId}/download-link`, { method: 'POST', body: {}, cookie: accessCookie }); assert.equal(downloaded.status, 200);
    const persisted = (await sql('SELECT state,issued_at,download_expires_at FROM gongde_free_claims WHERE id=?', [claimId]))[0]; assert.equal(persisted.state, 'READY');
    assert.equal(new Date(persisted.issued_at).toISOString(), artifact.issuedAt); assert.equal(new Date(persisted.download_expires_at).toISOString(), artifact.downloadExpiresAt);
    assert.equal(Number((await sql("SELECT COUNT(*) AS n FROM gongde_free_audit WHERE subject=? AND action IN ('official-safety.block','official-safety.unblock')", [officialAsset]))[0].n), auditBefore + 2);
    assert.equal(Number((await sql("SELECT COUNT(*) AS n FROM gongde_free_audit WHERE subject=? AND action='official-safety.claim-restored'", [claimId]))[0].n), 1);
    assert.equal(fakeCos.uploads, 1);
  });
  await check('ordinary_official_unpublication_does_not_mutate_safety_or_revoke_frozen_claim', async () => {
    const before = (await sql('SELECT blocked,revision FROM gongde_free_official_safety WHERE asset_id=?', [officialAsset]))[0];
    unlistedOfficialAsset = officialAsset;
    try {
      const catalog = await http(`/appearances?q=${selection.items[0].number}`); assert.equal(envelope(catalog).items.length, 0);
      const link = await http(`/claims/${claimId}/download-link`, { method: 'POST', body: {}, cookie: accessCookie }); assert.equal(link.status, 200);
      const after = (await sql('SELECT blocked,revision FROM gongde_free_official_safety WHERE asset_id=?', [officialAsset]))[0]; assert.equal(after.blocked, before.blocked); assert.equal(after.revision, before.revision);
    } finally { unlistedOfficialAsset = undefined; }
  });
  await check('reports_tied_creation_times_sort_by_id_desc', async () => {
    assert.equal(reportIds.length, 2);
    const tied = new Date();
    await sql('UPDATE gongde_free_reports SET created_at=? WHERE id IN (?,?)', [tied, ...reportIds]);
    const list = await http('/admin/reports?state=RESOLVED&page=1&perPage=100', { admin: true }); assert.equal(list.status, 200);
    const own = envelope(list).items.filter(item => reportIds.includes(item.id)); assert.deepEqual(own.map(item => item.id), [...reportIds].sort().reverse());
  });
  await check('numbered_detail_get_public_query_rate_limit_120_per_minute', async () => {
    let accepted = 0, limited;
    for (let index = 0; index < 125; index++) {
      const response = await http(`/appearances/${selection.items[0].number}`);
      if (response.status === 429) { limited = response; break; }
      assert.equal(response.status, 200); accepted++;
    }
    assert.ok(limited, 'detail_rate_limit_not_enforced'); assert.ok(accepted <= 120);
    assert.equal(limited.body.error, 'rate_limited'); assert.ok(Number(limited.headers.get('retry-after')) > 0);
  });
  skipped.push({ case: 'legacy_payment_410', reason: 'Current source free runtime mounted on real HTTP, not full server.ts; do not invent a retirement adapter or invoke payment/provider bootstrap.' });
  process.stdout.write(JSON.stringify({ status: 'PASS', passed, failed: 0, cases, skipped,
    evidence: { http: 'current-source free runtime over loopback HTTP', sql: 'real MySQL 8.4 acceptance database',
      cos: 'real PrivatePackageStore with explicitly fake COS transport and simulated URLs',
      signer: 'temporary random P256 key; independent signature/content verification; NOT production trusted-key or client acceptance',
      installers: 'test-only readiness metadata; no real installer download', admin: 'injected local test identity guard, not production password login',
      publication: 'isolated prepared SQL test fixtures; no AI review/provider evidence' },
    observed, fixtureRun: run, sqlFixturesRetained: true, productChanges: 0 }) + '\n');
} catch (error) {
  // Do not dump SQL, connection details, temporary passwords, code, Cookie,
  // evidence/contact text or signed URLs. Assertion messages are deliberately
  // not serialized: handoff identifies the exact bounded failing case.
  process.stderr.write(JSON.stringify({ status: 'FAIL', stage, passed, code: error.code ?? error.name,
    errno: error.errno ?? null, sqlState: error.sqlState ?? null,
    actual: typeof error.actual === 'number' ? error.actual : null,
    expected: typeof error.expected === 'number' ? error.expected : null,
    lastHttp, fixtureRun: run, productChanges: 0 }) + '\n');
  process.exitCode = 1;
} finally {
  clearTimeout(deadline);
  // Only this script's own random fixture is unlisted; no worker rows deleted or
  // changed. Keep all SQL identities, claims, reports and audit for parent review.
  if (pool) await sql("UPDATE gongde_creator_works SET state='UNLISTED' WHERE work_id=? AND creator_id=? AND state='PUBLISHED'", [fixture.workId, fixture.creatorId]).catch(() => {});
  if (server) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
  if (runtime) await runtime.close();
  if (numbers) await numbers.close();
  if (pool) await pool.end();
  if (directory) await rm(directory, { recursive: true, force: true });
}
