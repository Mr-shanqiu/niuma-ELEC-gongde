// Real, authorized temp MySQL; isolated LIKE-cloned fixture tables in the named
// acceptance database. No dotenv, provider, COS, migration, product build or Git.
// GONGDE_FREE_MYSQL_LOCAL_PASSWORD=<temporary password> node this-file.mjs
import assert from 'node:assert/strict';
import { randomBytes, createHash } from 'node:crypto';
import { register } from 'node:module';
import { fileURLToPath } from 'node:url';
import mysql from 'mysql2/promise';

const password = process.env.GONGDE_FREE_MYSQL_LOCAL_PASSWORD;
if (!password) throw new Error('temporary_local_mysql_password_required');
const { installLocalOnlyIoBoundary } = await import('./free-creator-mysql-fixtures.local.mjs');
const io = installLocalOnlyIoBoundary({ host: '127.0.0.1', port: 34891 });
const pool = mysql.createPool({ host: '127.0.0.1', port: 34891, database: 'gongde_free_acceptance',
  user: 'root', password, timezone: 'Z', charset: 'utf8mb4', connectTimeout: 2000,
  connectionLimit: 5, multipleStatements: false });
const run = randomBytes(6).toString('hex');
const prefix = 'fr_' + run + '_';
const names = ['gongde_free_claims', 'gongde_free_delivery_artifacts', 'gongde_free_claim_items',
  'gongde_free_reports', 'gongde_free_audit'];
const tables = new Map(names.map(name => [name, prefix + name]));
const rewrite = text => text.replace(/\bgongde_[a-z_]+\b/g, name => tables.get(name) ?? name);
const sql = async (text, values = []) => (await pool.query(rewrite(text), values))[0];
// The worker still executes actual MySQL transactions, range locks and advisory
// locks. This adapter ONLY routes its table names to this run's owned SQL tables.
let isolatedPool = { async getConnection() {
  const c = await pool.getConnection();
  return { query(input, values) {
    return c.query(typeof input === 'string' ? rewrite(input) : { ...input, sql: rewrite(input.sql) }, values);
  }, beginTransaction: () => c.beginTransaction(), commit: () => c.commit(), rollback: () => c.rollback(),
  release: () => c.release(), destroy: () => c.destroy() };
} };
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
const { runFreeRetention, FREE_RETENTION_DELETED_ACTION } = await import('../src/free-distribution/retention.ts');
const now = new Date('2027-01-20T00:00:00.000Z'), DAY = 86400000;
const age = days => new Date(now.getTime() - days * DAY);
const id = () => randomBytes(16).toString('hex');
const digest = value => createHash('sha256').update(value).digest('hex');
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const createdTables = [], results = [];
let stage = 'setup', repairCount = 1;
const deadline = setTimeout(() => { process.stderr.write('LOCAL_RETENTION_TEST_DEADLINE\n'); process.exit(124); }, 90000);
async function reset() {
  // New pool identity isolates the worker's WeakMap cursor between cases;
  // repeated/concurrent worker calls inside one case still share that identity.
  isolatedPool = { ...isolatedPool };
  for (const name of names) await sql('DELETE FROM ' + name);
}
async function fixture(options = {}) {
  const claimId = id(), key = options.key ?? `free-claims/v2/${digest(claimId)}.nmgpack`;
  const format = key.endsWith('.nmgpacks') ? 'nmgpacks' : 'nmgpack';
  const asset = options.asset ?? 'official.retention-' + run;
  const version = options.version ?? 'v1';
  await sql(`INSERT INTO gongde_free_claims (id,session_id,kind,family_id,code_token_id,cycle_index,limit_snapshot,
    request_digest,idempotency_key,state,created_at,issued_at,download_expires_at)
    VALUES (?,?,'APPEARANCES',?,?,0,10,?,?,?, ?,?,?)`,
  [claimId,id(),id(),id(),digest(claimId),claimId,options.state ?? 'READY',age(options.issuedAge ?? 20),
    options.unissued ? null : age(options.issuedAge ?? 20),options.unissued ? null : age(options.expiresAge ?? 13)]);
  await sql(`INSERT INTO gongde_free_claim_items (claim_id,position,appearance_number,source_kind,asset_id,creator_id,
    version_id,source_revision,catalog_revision,metadata_snapshot_json,consent_snapshot_json,
    delivery_bytes_upper_bound,snapshot_record_json) VALUES (?,1,?,'official',?,NULL,?,?,'fixture','{}','{}',1,?)`,
  [claimId,options.number ?? 800001,asset,version,digest(version),options.snapshot ? JSON.stringify(options.snapshot) : null]);
  await sql(`INSERT INTO gongde_free_delivery_artifacts
    (claim_id,private_object_key,sha256,bytes,filename,format,license_mode,signer_version,created_at)
    VALUES (?,?,?,1,?,?,'perpetual','test-fixture',?)`,
  [claimId,key,digest(key),'fixture.' + format,format,age(options.artifactAge ?? options.issuedAge ?? 20)]);
  return { claimId, key, asset, version, number: options.number ?? 800001 };
}
async function report(f, state, executor = sql) {
  await executor(`INSERT INTO gongde_free_reports (id,appearance_number,version_id,category,description,state,created_at)
    VALUES (?,?,?,'copyright','Synthetic local report',?,?)`, [id(),f.number,f.version,state,age(1)]);
}
const tombstones = async () => (await sql('SELECT COUNT(*) AS n FROM gongde_free_audit WHERE action=?', [FREE_RETENTION_DELETED_ACTION]))[0].n;
async function worker(extra = {}) {
  const calls = [];
  const result = await runFreeRetention({ pool: isolatedPool, now, deleteFreeArtifact: async key => {
    assert.match(key, /^free-claims\/v2\/[a-f0-9]{64}\.(nmgpack|nmgpacks)$/); calls.push(key);
  }, ...extra });
  return { result, calls };
}
async function check(name, operation) {
  stage = name; await reset(); await operation();
  results.push({ name, passed: true }); process.stdout.write(JSON.stringify({ case: name, status: 'PASS' }) + '\n');
}
try {
  for (const [original, owned] of tables) {
    await pool.query(`CREATE TABLE \`${owned}\` LIKE \`${original}\``); createdTables.push(owned);
  }
  await check('fourteen_day_boundary_and_idempotence', async () => {
    const f = await fixture({ issuedAge: 14, expiresAge: 7 });
    const first = await worker(); assert.equal(first.result.deleted, 1); assert.deepEqual(first.calls, [f.key]);
    assert.equal(Number(await tombstones()), 1);
    const again = await worker(); assert.equal(again.result.deleted, 0); assert.deepEqual(again.calls, []);
  });
  await check('formal_nmgpacks_object_is_supported', async () => {
    const f = await fixture({ key: `free-claims/v2/${digest(id())}.nmgpacks` });
    const { calls, result } = await worker(); assert.deepEqual(calls, [f.key]); assert.equal(result.deleted, 1);
  });
  await check('recent_and_extended_redownload_windows_are_retained', async () => {
    await fixture({ issuedAge: 13.999, expiresAge: 6.999 });
    await fixture({ issuedAge: 20, expiresAge: -1 });
    await fixture({ issuedAge: 20, expiresAge: 6.999 });
    await fixture({ issuedAge: 20, artifactAge: 1 });
    const { calls } = await worker(); assert.deepEqual(calls, []);
  });
  await check('unissued_failed_and_blocked_claims_are_retained', async () => {
    await fixture({ unissued: true }); await fixture({ state: 'FAILED' }); await fixture({ state: 'BLOCKED' });
    assert.deepEqual((await worker()).calls, []);
  });
  await check('active_shared_object_reference_is_locked_and_retained', async () => {
    const old = await fixture(); await fixture({ key: old.key, issuedAge: 1, expiresAge: -6 });
    const { calls, result } = await worker(); assert.deepEqual(calls, []); assert.equal(result.protected, 1);
  });
  await check('active_version_reference_with_different_object_is_retained', async () => {
    const old = await fixture(); await fixture({ asset: old.asset, version: old.version, issuedAge: 1, expiresAge: -6 });
    assert.deepEqual((await worker()).calls, []);
  });
  for (const state of ['OPEN', 'INVESTIGATING', 'DISMISSED']) await check('report_' + state + '_preserves_artifact', async () => {
    const f = await fixture(); await report(f, state);
    const { calls, result } = await worker(); assert.deepEqual(calls, []);
    assert.equal(result.outcomes[0].reason, 'report_preservation');
  });
  await check('resolved_report_does_not_force_permanent_artifact_retention', async () => {
    const f = await fixture(); await report(f, 'RESOLVED'); assert.equal((await worker()).result.deleted, 1);
  });
  await check('blocked_shared_claim_preserves_the_same_formal_object', async () => {
    const f = await fixture(); await fixture({ key: f.key, state: 'BLOCKED' });
    assert.deepEqual((await worker()).calls, []);
  });
  await check('paid_creator_source_and_invalid_free_keys_never_reach_delete', async () => {
    for (const key of ['paid/' + digest(run) + '.nmgpack', 'creator-sources/' + digest(run),
      'free-claims/v2/../paid.nmgpack', 'free-claims/v2/' + 'A'.repeat(64) + '.nmgpack']) await fixture({ key });
    const f = await fixture(); await sql('UPDATE gongde_free_claim_items SET snapshot_record_json=? WHERE claim_id=?',
      [JSON.stringify({ sourceObjectKey: f.key, previouslyPublished: true, historicalPaid: true }),f.claimId]);
    assert.deepEqual((await worker()).calls, []);
  });
  await check('deletion_error_has_no_success_tombstone_and_can_retry', async () => {
    await fixture(); const failed = await worker({ deleteFreeArtifact: async () => { throw new Error('synthetic_delete_failure'); } });
    assert.equal(failed.result.failed, 1); assert.equal(failed.result.deleted, 0); assert.equal(Number(await tombstones()), 0);
    assert.equal((await worker()).result.deleted, 1);
  });
  await check('metadata_is_retained_even_after_one_hundred_eighty_days', async () => {
    await fixture({ issuedAge: 200, expiresAge: 193 });
    assert.equal((await worker()).result.deleted, 1);
    for (const table of ['gongde_free_claims', 'gongde_free_claim_items', 'gongde_free_delivery_artifacts']) {
      assert.equal(Number((await sql('SELECT COUNT(*) AS n FROM ' + table))[0].n), 1);
    }
  });
  await check('twenty_object_bound_and_next_scheduled_pass', async () => {
    for (let index = 0; index < 21; index++) await fixture({ asset: 'official.bound-' + index });
    const first = await worker(); assert.equal(first.result.scanned, 20); assert.equal(first.calls.length, 20);
    assert.equal((await worker()).result.deleted, 1);
  });
  await check('protected_oldest_twenty_do_not_starve_later_eligible_objects', async () => {
    for (let index = 0; index < 20; index++) {
      const f = await fixture({ issuedAge: 21, expiresAge: 14, number: 800100 + index,
        asset: 'official.protected-' + index });
      await report(f, 'OPEN');
    }
    const eligible = await fixture({ number: 801000, asset: 'official.eligible' });
    const first = await worker(); assert.equal(first.result.scanned, 20); assert.equal(first.result.protected, 20);
    assert.deepEqual(first.calls, []);
    const next = await worker(); assert.deepEqual(next.calls, [eligible.key]); assert.equal(next.result.deleted, 1);
  });
  await check('single_process_reentry_is_rejected', async () => {
    await fixture(); let enter, release;
    const entered = new Promise(resolve => { enter = resolve; }), gate = new Promise(resolve => { release = resolve; });
    let deletes = 0;
    const first = worker({ deleteFreeArtifact: async () => { deletes++; enter(); await gate; } });
    await entered;
    try { const second = await worker(); assert.equal(second.result.status, 'busy'); assert.deepEqual(second.calls, []); }
    finally { release(); }
    assert.equal((await first).result.deleted, 1); assert.equal(deletes, 1); assert.equal(Number(await tombstones()), 1);
  });
  await check('existing_database_worker_lock_prevents_another_process', async () => {
    await fixture(); const c = await pool.getConnection();
    const expression = "CONCAT('gongde-free-retention:v2:',MD5(DATABASE()))";
    try {
      assert.equal(Number((await c.query(`SELECT GET_LOCK(${expression},0) AS acquired`))[0][0].acquired), 1);
      const { calls, result } = await worker(); assert.equal(result.status, 'busy'); assert.deepEqual(calls, []);
    } finally { await c.query(`SELECT RELEASE_LOCK(${expression})`); c.release(); }
  });
  await check('uncommitted_report_is_observed_before_delete_not_after_it', async () => {
    const f = await fixture(); const c = await pool.getConnection(); let deletes = 0, pending;
    try {
      await c.beginTransaction();
      await c.query(rewrite('SELECT id FROM gongde_free_claims WHERE id=? FOR UPDATE'), [f.claimId]);
      await report(f, 'OPEN', (text, values) => c.query(rewrite(text), values));
      pending = worker({ deleteFreeArtifact: async () => { deletes++; } });
      await delay(30); assert.equal(deletes, 0); await c.commit();
      assert.equal((await pending).result.protected, 1); assert.equal(deletes, 0);
    } finally { await c.rollback(); c.release(); if (pending) await pending; }
  });
  await check('deadline_does_not_claim_an_unconfirmed_delete_succeeded', async () => {
    await fixture(); const { result } = await worker({ timeoutMs: 150, deleteFreeArtifact: () => new Promise(() => {}) });
    assert.equal(result.status, 'timed_out'); assert.equal(result.deleted, 0);
    assert.ok(result.elapsedMs < 1500); assert.equal(Number(await tombstones()), 0);
  });
  assert.equal(io.forbiddenIoAttempts, 0);
} catch (error) {
  results.push({ name: stage, passed: false, code: error.code ?? error.name,
    message: String(error.message).slice(0, 300) }); process.exitCode = 1;
} finally {
  for (const table of createdTables.reverse()) {
    try { await pool.query('DROP TABLE `' + table + '`'); }
    catch (error) { results.push({ name: 'owned_fixture_cleanup', passed: false, code: error.code ?? error.name }); process.exitCode = 1; }
  }
  await pool.end(); clearTimeout(deadline);
  process.stdout.write(JSON.stringify({ status: process.exitCode ? 'FAIL' : 'PASS',
    evidence: 'REAL_TEMP_MYSQL_008_SCHEMA_WITH_SYNTHETIC_DELETE_CALLBACK',
    target: { host: '127.0.0.1', port: 34891, database: 'gongde_free_acceptance' },
    passed: results.filter(row => row.passed).length, total: results.length, repairCount,
    production: false, bucketLifecycleAccepted: false, realCosDeletion: false,
    metadataDeletion: false, io, cases: results }) + '\n');
}
