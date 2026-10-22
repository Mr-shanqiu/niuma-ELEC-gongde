import assert from 'node:assert/strict';
import { generateKeyPairSync, randomBytes } from 'node:crypto';
import { cp, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { register } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import mysql from 'mysql2/promise';

// Real MySQL 8.4 on the documented disposable port, mounted under the ACTUAL
// free-distribution runtime over loopback HTTP. Only the GROUP code family is
// used: the handover is a property of the group announcement, and a creator
// family would need contribution rows to be ACTIVE. No provider, object store,
// payment or delivery traffic leaves this process.
//
// Run: GONGDE_FREE_MYSQL_LOCAL_PASSWORD=<temporary value> node this-file.mjs
const password = process.env.GONGDE_FREE_MYSQL_LOCAL_PASSWORD;
if (!password) throw new Error('temporary_local_mysql_password_required');
const database = { host: '127.0.0.1', port: 34891, database: 'gongde_free_acceptance', user: 'root',
  password, timezone: 'Z', charset: 'utf8mb4', connectTimeout: 2000, multipleStatements: false };
const deadline = setTimeout(() => { process.stderr.write('LOCAL_HANDOVER_HTTP_DEADLINE\n'); process.exit(124); }, 120000);
const run = randomBytes(8).toString('hex');
const adminCookie = `local_handover_admin=${randomBytes(32).toString('hex')}`;
let pool, runtime, server, base, directory, numbers, stage = 'initialization', passed = 0, lastHttp;
const cases = [];
const receipt = { target: 'free-code-handover-http', host: '127.0.0.1', port: 34891,
  database: 'gongde_free_acceptance', evidence: 'real runtime routes over loopback HTTP against real MySQL',
  cases };

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
const { createFreeDistributionRuntime } = await import('../src/free-distribution/runtime.ts');
const { AppearancePackSigner } = await import('../src/delivery/pack-signer.ts');
const { PrivatePackageStore } = await import('../src/delivery/private-package-store.ts');
const { AppearanceNumberRepository } = await import('../src/domain/appearance-numbers.ts');
const { FreeDistributionError } = await import('../src/free-distribution/types.ts');

const check = async (name, operation) => {
  stage = name; await operation(); passed += 1; cases.push(name);
  process.stdout.write(JSON.stringify({ case: name, status: 'PASS' }) + '\n');
};
// Real PrivatePackageStore; only its injected COS TRANSPORT is fake. It exists
// so `ready()` can prove the private bucket, which `/access/verify` requires
// before it will look at a code. Nothing is uploaded by this suite.
function fakeCosTransport() {
  const owner = { ACL: 'private', Owner: { ID: 'local-fake-cos-owner' },
    Grants: [{ Grantee: { ID: 'local-fake-cos-owner' } }] };
  return {
    async getBucketAcl() { return owner; },
    // A missing bucket policy is the private layout the store accepts; the ACL
    // above is what proves the bucket is not public.
    async getBucketPolicy() { throw Object.assign(new Error('local_fake_cos_missing'), { statusCode: 404, code: 'NoSuchBucketPolicy' }); },
    async getObjectAcl() { return owner; },
    async headObject() { throw Object.assign(new Error('local_fake_cos_missing'), { statusCode: 404 }); },
    async putObject() { throw new Error('this_suite_never_uploads'); },
    getObjectUrl() { throw new Error('this_suite_never_downloads'); }
  };
}
const adminIdentity = request => {
  if (!String(request.headers.cookie ?? '').split(';').some(part => part.trim() === adminCookie)) {
    throw new FreeDistributionError('admin_auth_required', 401);
  }
  return `local-handover-${run}`;
};
async function http(path, { method = 'GET', body, admin = false } = {}) {
  const headers = { 'content-type': 'application/json' };
  if (method !== 'GET') headers.origin = base;
  if (admin) headers.cookie = adminCookie;
  const response = await fetch(base + '/api/gongde/v2' + path, { method, headers,
    body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(30000) });
  const result = { status: response.status, headers: response.headers, body: await response.json() };
  lastHttp = { method, path: path.split('?')[0], status: result.status,
    error: typeof result.body?.error === 'string' && /^[a-z_]+$/u.test(result.body.error) ? result.body.error : null };
  return result;
}
const envelope = result => {
  assert.ok(result.body && typeof result.body === 'object' && 'data' in result.body, 'envelope');
  assert.match(result.headers.get('cache-control'), /private.*no-store/u);
  return result.body.data;
};
const verify = code => http('/access/verify', { method: 'POST', body: { code } });

try {
  pool = mysql.createPool({ ...database, connectionLimit: 3, waitForConnections: true, queueLimit: 16 });
  await check('real_mysql_34891_handover_schema_present', async () => {
    const info = (await pool.query('SELECT DATABASE() AS db, VERSION() AS version'))[0][0];
    assert.equal(info.db, 'gongde_free_acceptance'); assert.match(info.version, /^8\.4\./u);
    // Migration 012 is the only structural change this feature needs. It is
    // applied by the handover suite's real-migration runner; this check proves
    // the runtime will find the columns rather than fail mid-rotation.
    const columns = (await pool.query(`SELECT column_name FROM information_schema.columns
      WHERE table_schema = DATABASE() AND table_name = 'gongde_free_code_tokens'
      AND column_name IN ('handover_until', 'server_rotated_at')`))[0];
    assert.equal(columns.length, 2, 'migration_012_columns_present');
    receipt.mysqlVersion = info.version;
  });

  // Every run uses a fresh random code secret, so token rows left by an earlier
  // run are underivable now and any admin read would fail at derivation. This is
  // the dedicated disposable acceptance database and this suite owns the GROUP
  // family's own code/claim/session rows, so they are cleared to the state a
  // fresh database would have. Nothing outside the GROUP family is touched, and
  // no schema change or production path is involved. (The GROUP family row
  // itself, and therefore its revision, is preserved.)
  stage = 'reset_disposable_group_family_rows';
  await check('disposable_group_rows_are_reset_before_the_handover', async () => {
    const [group] = (await pool.query("SELECT id FROM gongde_free_code_families WHERE kind = 'GROUP'"))[0];
    if (!group) return;
    const connection = await pool.getConnection();
    try {
      await connection.beginTransaction();
      const [claims] = await connection.query('SELECT id FROM gongde_free_claims WHERE family_id = ?', [group.id]);
      if (claims.length) {
        const list = claims.map(() => '?').join(',');
        const ids = claims.map(row => row.id);
        await connection.query(`DELETE FROM gongde_free_claim_items WHERE claim_id IN (${list})`, ids);
        await connection.query(`DELETE FROM gongde_free_delivery_artifacts WHERE claim_id IN (${list})`, ids);
        await connection.query(`DELETE FROM gongde_free_claims WHERE id IN (${list})`, ids);
      }
      await connection.query(`DELETE FROM gongde_free_download_sessions
        WHERE current_code_token_id IN (SELECT id FROM gongde_free_code_tokens WHERE family_id = ?)`, [group.id]);
      await connection.query('DELETE FROM gongde_free_code_tokens WHERE family_id = ?', [group.id]);
      await connection.commit();
    } catch (error) { await connection.rollback(); throw error; } finally { connection.release(); }
  });

  directory = await mkdtemp(join(tmpdir(), 'gongde-handover-http-'));
  const keyFile = join(directory, 'test-only-p256.pem'), codeFile = join(directory, 'test-only-code-key');
  const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  await writeFile(keyFile, privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 });
  await writeFile(codeFile, randomBytes(32).toString('hex'), { mode: 0o600 });
  // The official root must be the real pack layout: the exclusion seed
  // fingerprints every official directory through the creator validator, which
  // rejects a manifest that is not a real schema-1/3 pack. Copying the
  // repository's own packs keeps this fixture local and read-only.
  const assetRoot = join(directory, 'test-assets'); await mkdir(assetRoot);
  await cp(fileURLToPath(new URL('../../../assets/appearance-packs/', import.meta.url)), assetRoot, { recursive: true });
  const installerFile = join(directory, 'test-installers.json');
  await writeFile(installerFile, JSON.stringify({ items: ['windows', 'macos'].map(platform => ({ platform,
    format: platform === 'macos' ? 'dmg' : 'exe', releaseId: `handover-test-${run}-${platform}`, version: '0.9.0',
    bytes: 1, sha256: '0'.repeat(64), publicDownloadUrl: `https://download.gongde.zqscreen.cn/LOCAL-TEST-NOT-A-RELEASE-${run}.${platform}`,
    perpetualCompatible: true })) }));

  server = createServer(async (request, response) => {
    try {
      if (!runtime || !await runtime.handle(request, response, new URL(request.url, base))) {
        response.writeHead(404, { 'content-type': 'application/json' }); response.end(JSON.stringify({ error: 'not_runtime_route' }));
      }
    } catch { response.writeHead(500); response.end('{}'); }
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  base = `http://127.0.0.1:${server.address().port}`;
  Object.assign(process.env, { GONGDE_FREE_DISTRIBUTION_ENABLED: 'true', GONGDE_FREE_DISTRIBUTION_SECRET_FILE: codeFile,
    GONGDE_PACK_ASSET_ROOT: assetRoot, GONGDE_PACK_SIGNING_KEY_FILE: keyFile, GONGDE_FREE_INSTALLERS_FILE: installerFile,
    GONGDE_CREATOR_PUBLIC_ORIGIN: base, GONGDE_CREATOR_TRUSTED_PROXY_ADDRESSES: '' });
  const signer = new AppearancePackSigner({ assetRoot, privateKeyFile: keyFile }); signer.prepareAssets();
  numbers = new AppearanceNumberRepository(database);
  const packages = new PrivatePackageStore({ bucket: 'gongde-handover-local-http-123456', region: 'ap-shanghai',
    secretId: 'LOCAL_FAKE_COS_ONLY', secretKey: 'LOCAL_FAKE_COS_ONLY' }, fakeCosTransport());
  runtime = createFreeDistributionRuntime({ database, signer, packages, numbers, requireAdmin: adminIdentity,
    officialStates: async () => Object.fromEntries(Object.keys(signer.officialCatalog())
      .map(assetId => [assetId, { state: 'PUBLISHED' }])),
    creators: { setPublicationObserver() {},
      async requireAccount() { throw new FreeDistributionError('creator_auth_required', 401); },
      async loadFrozenSource() { throw new Error('community_delivery_not_in_this_fixture'); } } });
  // `ready()` waits for the process-global exclusion seed, so the first request
  // that needs it can take several seconds. That is readiness, not a failure.
  const readyUntil = Date.now() + 60000;
  let ready = false;
  while (!ready && Date.now() < readyUntil) {
    const response = await http('/config');
    ready = response.status === 200 && response.body?.data?.ready === true;
    if (!ready) await new Promise(resolve => setTimeout(resolve, 100));
  }
  assert.ok(ready, 'free_runtime_never_became_ready');

  let original, first, second;
  await check('disposable_group_family_is_active_before_the_handover', async () => {
    const snapshot = envelope(await http('/admin/group-code', { admin: true }));
    assert.ok(snapshot.familyId);
    // A previous interrupted run of this suite may have left the disposable
    // GROUP family paused OR stopped, and the admin snapshot projects both as
    // PAUSED, so the state is read directly to pick the matching audited
    // mutation. Never by SQL: the mutation is what writes the audit row. A
    // non-ACTIVE snapshot intentionally carries no code, so the code is only
    // checked once the family is ACTIVE.
    if (snapshot.status !== 'ACTIVE') {
      const state = (await pool.query("SELECT state FROM gongde_free_code_families WHERE kind = 'GROUP'"))[0][0]?.state;
      const action = state === 'REVOKED' ? 'restore' : 'resume';
      const restored = envelope(await http(`/admin/code-families/${snapshot.familyId}/${action}`, { method: 'POST', admin: true,
        body: { revision: snapshot.revision, reason: 'local disposable group readiness for the handover suite' } }));
      assert.equal(restored.status, 'ACTIVE'); assert.ok(restored.code);
    } else assert.ok(snapshot.code);
  });

  await check('admin_rotation_returns_the_new_code_and_the_replaced_ones_deadline', async () => {
    const snapshot = envelope(await http('/admin/group-code', { admin: true }));
    assert.equal(snapshot.status, 'ACTIVE'); assert.ok(snapshot.code);
    original = { code: snapshot.code, revision: snapshot.revision, familyId: snapshot.familyId };
    first = envelope(await http(`/admin/code-families/${original.familyId}/rotate`, { method: 'POST', admin: true,
      body: { revision: original.revision, reason: 'local handover acceptance, first rotation' } }));
    assert.equal(first.previousCode, original.code);
    assert.ok(Date.parse(first.previousCodeHandoverUntil) > Date.now(), 'handover is in the future');
    // The new code takes effect immediately and is not marked as a handover.
    const fresh = await verify(first.code);
    assert.equal(fresh.status, 200);
    assert.equal(envelope(fresh).handover, undefined);
  });

  await check('http_verify_accepts_every_open_replaced_code_not_just_the_latest', async () => {
    // The route used to compare the submitted value against ONE remembered
    // previous code. Two rotations inside one hour leave two handover windows
    // open at once, so that comparison silently rejected the earlier code even
    // though the repository would have authorized it. This is the regression
    // test for that route-level defect.
    second = envelope(await http(`/admin/code-families/${original.familyId}/rotate`, { method: 'POST', admin: true,
      body: { revision: first.revision, reason: 'local handover acceptance, second rotation' } }));
    assert.equal(second.previousCode, first.code);
    assert.notEqual(second.previousCodeHandoverUntil, first.previousCodeHandoverUntil);
    for (const [label, code, until] of [['first replaced', original.code, first.previousCodeHandoverUntil],
      ['second replaced', first.code, second.previousCodeHandoverUntil]]) {
      const response = await verify(code);
      assert.equal(response.status, 200, `${label} code is still usable`);
      const data = envelope(response);
      assert.equal(data.handover, true, `${label} is marked as a handover`);
      assert.equal(data.handoverUntil, until, `${label} keeps its own deadline`);
    }
    const newest = await verify(second.code);
    assert.equal(newest.status, 200); assert.equal(envelope(newest).handover, undefined);
    // A code the group family never issued is still refused, so the widened
    // acceptance is not "anything goes".
    const foreign = await verify('GD000000');
    assert.equal(foreign.status, 400); assert.equal(foreign.body.error, 'access_code_invalid');
  });

  await check('pause_beats_every_open_handover_and_resume_does_not_extend_one', async () => {
    const paused = await http(`/admin/code-families/${original.familyId}/pause`, { method: 'POST', admin: true,
      body: { revision: second.revision, reason: 'local pause during the handover' } });
    assert.equal(paused.status, 200);
    // A paused family fails closed at the route, before any token is resolved:
    // every code — current or replaced — answers the same refusal, so a pause
    // cannot be walked around with an older code. This is the pre-existing
    // route contract; the repository's own 403 is what a direct caller sees.
    for (const code of [original.code, first.code, second.code]) {
      const refused = await verify(code);
      assert.equal(refused.status, 400); assert.equal(refused.body.error, 'access_code_invalid');
      assert.equal(refused.body.data, undefined);
    }
    const resumed = envelope(await http(`/admin/code-families/${original.familyId}/resume`, { method: 'POST', admin: true,
      body: { revision: envelope(paused).revision, reason: 'local resume inside the same hour' } }));
    // Pausing is not a rotation: it must not restart or push out either hour.
    assert.equal(resumed.previousCodeHandoverUntil, second.previousCodeHandoverUntil);
    const reopened = await verify(original.code);
    assert.equal(reopened.status, 200);
    assert.equal(envelope(reopened).handoverUntil, first.previousCodeHandoverUntil);
  });

  await check('admin_snapshot_names_only_the_most_recent_replacement', async () => {
    const snapshot = envelope(await http('/admin/group-code', { admin: true }));
    assert.equal(snapshot.code, second.code);
    assert.equal(snapshot.previousCode, first.code);
    assert.equal(snapshot.previousCodeHandoverUntil, second.previousCodeHandoverUntil);
    // The group announcement copy is built from this snapshot; the public
    // catalogue must never carry either code.
    const catalogue = await http('/appearances');
    assert.equal(catalogue.status, 200);
    assert.ok(!JSON.stringify(catalogue.body).includes(snapshot.code), 'current code is not public');
    assert.ok(!JSON.stringify(catalogue.body).includes(snapshot.previousCode), 'replaced code is not public');
  });

  // A revoke is a stop, not a pause: it must close every handover still open,
  // not only the current code, or a later restore would accept codes an operator
  // explicitly stopped. The route never sees this rule; it must fall out of the
  // repository's own authorization.
  await check('http_revoke_closes_every_open_handover_and_restore_cannot_revive_one', async () => {
    // The revision moves on every mutation, including the pause/resume above,
    // so the stop is submitted against the family's current revision.
    const current = envelope(await http('/admin/group-code', { admin: true }));
    assert.equal(current.code, second.code);
    const stopped = envelope(await http(`/admin/code-families/${original.familyId}/revoke`, { method: 'POST', admin: true,
      body: { revision: current.revision, reason: 'local stop during two open handovers' } }));
    assert.equal(stopped.status, 'PAUSED');
    assert.equal(stopped.previousCode, null, 'no replaced code is advertised after a stop');
    assert.equal(stopped.previousCodeHandoverUntil, null);
    for (const code of [original.code, first.code, second.code]) {
      const refused = await verify(code);
      assert.equal(refused.status, 400); assert.equal(refused.body.error, 'access_code_invalid');
    }
    const restored = envelope(await http(`/admin/code-families/${original.familyId}/restore`, { method: 'POST', admin: true,
      body: { revision: stopped.revision, reason: 'local restore after the stop' } }));
    assert.equal(restored.status, 'ACTIVE'); assert.ok(restored.code);
    // The codes that were mid-handover when the stop happened stay stopped. The
    // restore brings back only the code it generates now.
    for (const code of [original.code, first.code]) {
      const refused = await verify(code);
      assert.equal(refused.status, 410); assert.equal(refused.body.error, 'access_code_expired');
    }
    assert.equal((await verify(restored.code)).status, 200);
  });

  // Deadline, cycle-boundary, consecutive-deadline and claim-preservation
  // behaviour is time-driven and therefore proven where the clock is injectable:
  // free-distribution-repository.local.test.mjs (fake clock) and
  // free-code-handover-mysql.local.mjs (real MySQL transactions). This suite
  // proves the HTTP layer accepts and reports those decisions correctly.
  receipt.boundaryCoverage = 'free-distribution-repository.local.test.mjs + free-code-handover-mysql.local.mjs';
  process.stdout.write(JSON.stringify({ status: 'PASS', passed, failed: 0, ...receipt }) + '\n');
} catch (error) {
  process.stderr.write(JSON.stringify({ status: 'FAIL', stage, passed, code: error.code ?? error.name,
    message: String(error.message).slice(0, 200), lastHttp, fixtureRun: run }) + '\n');
  process.exitCode = 1;
} finally {
  clearTimeout(deadline);
  if (server) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
  if (runtime) await runtime.close().catch(() => {});
  // The number repository owns its own pool; leaving it open keeps the process
  // alive after the suite has already reported PASS.
  if (numbers) await numbers.close().catch(() => {});
  if (pool) await pool.end().catch(() => {});
  if (directory) await rm(directory, { recursive: true, force: true });
}
