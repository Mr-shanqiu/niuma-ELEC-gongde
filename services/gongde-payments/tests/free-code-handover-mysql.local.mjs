import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { register } from 'node:module';
import { fileURLToPath } from 'node:url';
import mysql from 'mysql2/promise';

// Real MySQL 8.4 on the documented disposable port. Nothing here touches a
// shared database, a container other than the one the caller started, any
// provider or any object store. Only the GROUP family is used: its batch limit
// is the fixed maximum, so no contributions or creator rows are needed.
const password = process.env.GONGDE_FREE_MYSQL_LOCAL_PASSWORD;
if (!password) throw new Error('temporary_local_mysql_password_required');
const configuration = { host: '127.0.0.1', port: 34891, database: 'gongde_free_acceptance',
  user: 'root', password, timezone: 'Z', charset: 'utf8mb4', connectTimeout: 2000, multipleStatements: false };
const deadline = setTimeout(() => { process.stderr.write('LOCAL_HANDOVER_ACCEPTANCE_DEADLINE\n'); process.exit(124); }, 120000);
const anchor = Date.parse('2026-10-08T00:00:00+08:00');
const HOUR = 3600000;
let clock = anchor + 12 * HOUR;
let pool, stage = 'readiness', passed = 0;
const receipt = { target: 'gongde-free-code-handover', host: '127.0.0.1', port: 34891,
  database: 'gongde_free_acceptance', evidence: 'real MySQL transactions; no delivery, provider or object-store call', cases: [] };
const query = async (connection, sql, values = []) => (await connection.execute(sql, values))[0];
const transaction = async operation => {
  const connection = await pool.getConnection();
  try { await connection.beginTransaction(); const value = await operation(connection); await connection.commit(); return value; }
  catch (error) { await connection.rollback(); throw error; } finally { connection.release(); }
};
const check = async (name, operation) => {
  stage = name; await operation(); passed += 1; receipt.cases.push(name);
  process.stdout.write(JSON.stringify({ case: name, status: 'PASS' }) + '\n');
};
const code = expected => error => error?.code === expected;
// An official appearance snapshot: validateClaimItems only checks the frozen
// shape, and this suite supplies its own validateItems/safety as the runtime does.
const item = number => ({ appearanceNumber: number, sourceKind: 'official', assetId: 'official.local-' + number,
  creatorId: null, versionId: 'local-version', sourceRevision: 'a'.repeat(64), catalogRevision: 'local:1',
  metadataSnapshot: { title: 'Local handover fixture' }, consentSnapshot: { free: true }, deliveryBytesUpperBound: 1024 });

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
const { FreeDistributionRepository } = await import('../src/free-distribution/repository.ts');
const { CODE_HANDOVER_MS } = await import('../src/free-distribution/codes.ts');

try {
  const readyDeadline = Date.now() + 40000;
  let bootstrap;
  while (!bootstrap && Date.now() < readyDeadline) {
    try { bootstrap = await mysql.createConnection(configuration); await query(bootstrap, 'SELECT 1 AS ready'); }
    catch { if (bootstrap) { await bootstrap.end().catch(() => {}); bootstrap = undefined; } await new Promise(resolve => setTimeout(resolve, 500)); }
  }
  if (!bootstrap) throw new Error('local_mysql_not_ready_within_40_seconds');
  const info = (await query(bootstrap, 'SELECT DATABASE() AS db, VERSION() AS version'))[0];
  assert.equal(info.db, 'gongde_free_acceptance'); assert.match(info.version, /^8\.4\./);
  receipt.mysqlVersion = info.version;

  // The schema is built from the real migration files. A previous run of this
  // suite may already have applied 012; its columns are then already there, so
  // the ALTER is skipped rather than replayed and the run stays repeatable.
  stage = 'schema_from_real_migrations';
  await query(bootstrap, `CREATE TABLE IF NOT EXISTS gongde_schema_migrations
    (filename VARCHAR(128) NOT NULL PRIMARY KEY, applied_at DATETIME(3) NOT NULL)
    ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci`);
  const directory = new URL('../migrations/', import.meta.url);
  const files = (await readdir(directory)).filter(name => /^\d+_[A-Za-z0-9_-]+\.sql$/u.test(name)).sort();
  const applied = [];
  for (const filename of files) {
    const recorded = await query(bootstrap, 'SELECT filename FROM gongde_schema_migrations WHERE filename = ?', [filename]);
    if (recorded.length) continue;
    const statements = (await readFile(new URL(filename, directory), 'utf8'))
      .split(/;\s*(?:\n|$)/u).map(value => value.trim()).filter(Boolean);
    for (const statement of statements) await query(bootstrap, statement);
    await query(bootstrap, 'INSERT INTO gongde_schema_migrations (filename, applied_at) VALUES (?, UTC_TIMESTAMP(3))', [filename]);
    applied.push(filename);
  }
  receipt.migrationsApplied = applied;
  const columns = await query(bootstrap, `SELECT column_name FROM information_schema.columns
    WHERE table_schema = DATABASE() AND table_name = 'gongde_free_code_tokens'
    AND column_name IN ('handover_until', 'server_rotated_at')`);
  assert.equal(columns.length, 2, 'migration_012_columns_present');
  await bootstrap.end();

  pool = mysql.createPool({ ...configuration, connectionLimit: 4, waitForConnections: true, queueLimit: 16 });
  const options = { codeSecret: Buffer.from(randomBytes(32)), enabled: true, now: () => new Date(clock),
    deliveryReady: () => true, validateItems: async () => {}, checkSafety: async () => true };
  const repository = new FreeDistributionRepository(pool, options);
  const group = await repository.ensureGroupFamily();
  // A previous run of this suite may have paused or revoked the disposable
  // GROUP family. Bring it back through the audited mutations, never by SQL.
  if (group.state !== 'ACTIVE') {
    await repository.mutateFamily({ familyId: group.id, action: group.state === 'REVOKED' ? 'restore' : 'resume',
      expectedRevision: group.revision, actor: 'local-acceptance', reason: 'local disposable group readiness' });
  }
  // Every run uses a fresh random code secret, so rows left by an earlier run
  // are underivable now. This database is the dedicated disposable acceptance
  // database and this suite owns the GROUP family's handover rows, so they are
  // cleared here to the state a fresh database would have. Nothing outside the
  // GROUP family's own code/claim/session rows is touched, and no schema change
  // or production path is involved.
  stage = 'reset_disposable_group_family_rows';
  await transaction(async connection => {
    const claims = await query(connection, 'SELECT id FROM gongde_free_claims WHERE family_id = ?', [group.id]);
    if (claims.length) {
      const list = claims.map(() => '?').join(',');
      await query(connection, `DELETE FROM gongde_free_claim_items WHERE claim_id IN (${list})`, claims.map(row => row.id));
      await query(connection, `DELETE FROM gongde_free_delivery_artifacts WHERE claim_id IN (${list})`, claims.map(row => row.id));
      await query(connection, `DELETE FROM gongde_free_claims WHERE id IN (${list})`, claims.map(row => row.id));
    }
    await query(connection, 'DELETE FROM gongde_free_download_sessions WHERE current_code_token_id IN (SELECT id FROM gongde_free_code_tokens WHERE family_id = ?)', [group.id]);
    await query(connection, 'DELETE FROM gongde_free_code_tokens WHERE family_id = ?', [group.id]);
  });
  clock = anchor + 12 * HOUR;
  const current = await repository.getCurrentCode(group.id);

  await check('rotation_writes_persisted_handover_from_the_server_clock', async () => {
    const before = await query(pool, 'SELECT handover_until, server_rotated_at FROM gongde_free_code_tokens WHERE family_id = ? AND revoked_at IS NULL', [group.id]);
    assert.ok(before.length >= 1);
    assert.ok(before.every(row => row.handover_until == null && row.server_rotated_at == null), 'no handover before a rotation');
    const snapshot = await repository.getCurrentCode(group.id);
    clock = anchor + 13 * HOUR;
    const rotated = await repository.mutateFamily({ familyId: group.id, action: 'rotate', expectedRevision: snapshot.authorization.revision,
      actor: 'local-acceptance', reason: 'local handover acceptance rotation' });
    assert.equal(Date.parse(rotated.previousCodeHandoverUntil), clock + CODE_HANDOVER_MS);
    // The persisted row, not the returned object, is what the next request reads.
    // It is identified by its token id so a second run of this suite on the same
    // disposable database sees only its own rotation.
    const rows = await query(pool, `SELECT handover_until, server_rotated_at, revoked_at FROM gongde_free_code_tokens WHERE id = ?`,
      [snapshot.authorization.codeTokenId]);
    assert.equal(rows.length, 1);
    assert.equal(new Date(rows[0].handover_until).getTime(), clock + CODE_HANDOVER_MS);
    assert.equal(new Date(rows[0].server_rotated_at).getTime(), clock);
    assert.equal(new Date(rows[0].revoked_at).getTime(), clock);
    current.rotated = rotated; current.replaced = snapshot.code;
  });

  await check('replaced_code_creates_a_real_claim_inside_the_handover', async () => {
    const verified = await repository.verifyCode({ code: current.replaced });
    assert.equal(verified.session.authorization.handover, true);
    assert.equal(verified.session.authorization.handoverUntil, current.rotated.previousCodeHandoverUntil);
    const key = 'handover-real-' + randomBytes(6).toString('hex');
    const created = await repository.createClaim({ sessionToken: verified.sessionToken,
      idempotencyKey: key, items: [item('100031')] });
    assert.equal(created.created, true);
    assert.equal(created.claim.codeFamilyId, group.id);
    assert.equal(created.claim.state, 'PREPARING');
    // The new code works at the same time.
    const fresh = await repository.verifyCode({ code: current.rotated.code });
    assert.equal(fresh.session.authorization.handover, false);
    current.claim = created.claim; current.replacedSession = verified.sessionToken; current.key = key;
  });

  await check('boundary_refuses_the_replaced_code_for_new_claims_only', async () => {
    const until = Date.parse(current.rotated.previousCodeHandoverUntil);
    clock = until - 1;
    assert.equal((await repository.verifyCode({ code: current.replaced })).session.authorization.handover, true);
    clock = until;
    await assert.rejects(() => repository.verifyCode({ code: current.replaced }), code('access_code_expired'));
    // The claim made inside the window is untouched by the deadline.
    const stored = await repository.getClaim({ sessionToken: current.replacedSession, claimId: current.claim.id });
    assert.equal(stored.state, 'PREPARING');
    // The same idempotency key still returns the same claim: the deadline closes
    // NEW claims, it does not revoke one that already exists.
    const recovered = await repository.findClaimByKey({ sessionToken: current.replacedSession,
      idempotencyKey: current.key });
    assert.equal(recovered.id, current.claim.id);
  });

  await check('handover_crosses_the_cycle_boundary_without_moving_the_new_expiry', async () => {
    const boundary = anchor + 7 * 24 * HOUR;
    clock = boundary - 60000;
    const snapshot = await repository.getCurrentCode(group.id);
    assert.equal(Date.parse(snapshot.authorization.expiresAt), boundary);
    const rotated = await repository.mutateFamily({ familyId: group.id, action: 'rotate',
      expectedRevision: snapshot.authorization.revision, actor: 'local-acceptance', reason: 'local boundary handover' });
    assert.equal(Date.parse(rotated.previousCodeHandoverUntil), clock + CODE_HANDOVER_MS);
    // A manual rotation still does not restart the seven-day period.
    assert.equal(Date.parse(rotated.expiresAt), boundary);
    clock = boundary;
    const verified = await repository.verifyCode({ code: snapshot.code });
    assert.equal(verified.session.authorization.handover, true);
    const claim = await repository.createClaim({ sessionToken: verified.sessionToken,
      idempotencyKey: 'handover-boundary-' + Date.now(), items: [item('100032')] });
    assert.equal(claim.created, true);
    clock = Date.parse(rotated.previousCodeHandoverUntil);
    await assert.rejects(() => repository.verifyCode({ code: snapshot.code }), code('access_code_expired'));
    current.second = rotated;
  });

  await check('consecutive_rotations_never_extend_an_earlier_deadline', async () => {
    // The clock only ever moves forward, as a real server clock does; this
    // point is later than every earlier case in this suite.
    clock = anchor + 176 * HOUR;
    const first = await repository.getCurrentCode(group.id);
    const one = await repository.mutateFamily({ familyId: group.id, action: 'rotate',
      expectedRevision: first.authorization.revision, actor: 'local-acceptance', reason: 'local first handover' });
    clock += 10 * 60000;
    const two = await repository.mutateFamily({ familyId: group.id, action: 'rotate',
      expectedRevision: one.revision, actor: 'local-acceptance', reason: 'local second handover' });
    assert.equal(Date.parse(one.previousCodeHandoverUntil), anchor + 176 * HOUR + CODE_HANDOVER_MS);
    assert.equal(Date.parse(two.previousCodeHandoverUntil), clock + CODE_HANDOVER_MS);
    // Later than the first deadline: the first replaced code is gone, the second
    // is still inside its own hour.
    clock = Date.parse(one.previousCodeHandoverUntil);
    await assert.rejects(() => repository.verifyCode({ code: first.code }), code('access_code_expired'));
    assert.equal((await repository.verifyCode({ code: one.code })).session.authorization.handover, true);
    // And the persisted first deadline was not rewritten by the second rotate.
    const firstRow = await query(pool, 'SELECT handover_until FROM gongde_free_code_tokens WHERE id = ?',
      [first.authorization.codeTokenId]);
    assert.equal(firstRow.length, 1);
    assert.equal(new Date(firstRow[0].handover_until).getTime(), Date.parse(one.previousCodeHandoverUntil));
  });

  await check('pause_beats_the_handover_and_a_revoke_adds_none', async () => {
    clock = anchor + 186 * HOUR;
    const snapshot = await repository.getCurrentCode(group.id);
    const rotated = await repository.mutateFamily({ familyId: group.id, action: 'rotate',
      expectedRevision: snapshot.authorization.revision, actor: 'local-acceptance', reason: 'local handover then pause' });
    await repository.mutateFamily({ familyId: group.id, action: 'pause', expectedRevision: rotated.revision,
      actor: 'local-acceptance', reason: 'pause during the handover' });
    await assert.rejects(() => repository.verifyCode({ code: snapshot.code }), code('access_code_paused'));
    await repository.mutateFamily({ familyId: group.id, action: 'resume', expectedRevision: rotated.revision + 1,
      actor: 'local-acceptance', reason: 'resume inside the same hour' });
    // Pausing did not restart or extend the hour.
    assert.equal((await repository.getGroupCode()).previousCodeHandoverUntil, rotated.previousCodeHandoverUntil);
    assert.equal((await repository.verifyCode({ code: snapshot.code })).session.authorization.handover, true);
    // A revoke is a stop: the token it stops gets no handover row at all.
    const resumed = await repository.getGroupCode();
    const stopped = await repository.mutateFamily({ familyId: group.id, action: 'revoke',
      expectedRevision: resumed.revision, actor: 'local-acceptance', reason: 'local stop' });
    assert.equal(stopped.status, 'PAUSED');
    await assert.rejects(() => repository.verifyCode({ code: resumed.code }), code('access_code_paused'));
    // The token a revoke stops is the live one: revoked now, and never given a
    // rotation deadline. The earlier rotation's token is a different row.
    const stoppedToken = (await query(pool, `SELECT handover_until, server_rotated_at, revoked_at FROM gongde_free_code_tokens
      WHERE family_id = ? AND revoked_at = ? AND server_rotated_at IS NULL`, [group.id, new Date(clock)]))[0];
    assert.ok(stoppedToken, 'the stopped token exists'); assert.equal(stoppedToken.handover_until, null);
    await repository.mutateFamily({ familyId: group.id, action: 'restore',
      expectedRevision: resumed.revision + 1, actor: 'local-acceptance', reason: 'local restore' });
    await assert.rejects(() => repository.verifyCode({ code: resumed.code }), code('access_code_expired'));
  });

  await check('revoke_closes_every_open_handover_and_restore_cannot_revive_one', async () => {
    // Two rotations inside one hour leave two replaced codes mid-handover. A
    // revoke is a stop for the whole family, so both must close; otherwise the
    // restore below would bring codes back that the operator explicitly stopped.
    clock = anchor + 196 * HOUR;
    const before = await repository.getCurrentCode(group.id);
    const one = await repository.mutateFamily({ familyId: group.id, action: 'rotate',
      expectedRevision: before.authorization.revision, actor: 'local-acceptance', reason: 'first rotation before the stop' });
    clock += 10 * 60000;
    const two = await repository.mutateFamily({ familyId: group.id, action: 'rotate',
      expectedRevision: one.revision, actor: 'local-acceptance', reason: 'second rotation before the stop' });
    clock += 5 * 60000;
    assert.equal((await repository.verifyCode({ code: before.code })).session.authorization.handover, true);
    assert.equal((await repository.verifyCode({ code: one.code })).session.authorization.handover, true);
    const verified = await repository.verifyCode({ code: before.code });
    const created = await repository.createClaim({ sessionToken: verified.sessionToken,
      idempotencyKey: 'stop-during-handover-' + randomBytes(6).toString('hex'), items: [item('100033')] });
    assert.equal(created.created, true);
    const claim = created.claim;
    const stopAt = new Date(clock);
    const stopped = await repository.mutateFamily({ familyId: group.id, action: 'revoke',
      expectedRevision: two.revision, actor: 'local-acceptance', reason: 'operator stop during two handovers' });
    assert.equal(stopped.status, 'PAUSED');
    for (const value of [before.code, one.code, two.code]) {
      await assert.rejects(() => repository.verifyCode({ code: value }), code('access_code_paused'));
    }
    // The persisted rows agree: every handover is closed at the stop, and the
    // current token still has no deadline of its own.
    const open = await query(pool, `SELECT id FROM gongde_free_code_tokens
      WHERE family_id = ? AND server_rotated_at IS NOT NULL AND handover_until > ?`, [group.id, stopAt]);
    assert.equal(open.length, 0, 'no handover survives the stop');
    const current = (await query(pool, `SELECT handover_until FROM gongde_free_code_tokens
      WHERE family_id = ? AND server_rotated_at IS NULL AND revoked_at = ?`, [group.id, stopAt]))[0];
    assert.ok(current, 'the current token was stopped'); assert.equal(current.handover_until, null);
    // The admin snapshot no longer advertises a replaced code.
    assert.equal((await repository.getGroupCode()).previousCode, null);
    await repository.mutateFamily({ familyId: group.id, action: 'restore',
      expectedRevision: stopped.revision, actor: 'local-acceptance', reason: 'restore after the stop' });
    for (const value of [before.code, one.code]) {
      await assert.rejects(() => repository.verifyCode({ code: value }), code('access_code_expired'));
    }
    // The restore is not a no-op: the new code works again.
    const restored = await repository.getCurrentCode(group.id);
    assert.equal((await repository.verifyCode({ code: restored.code })).session.authorization.codeFamilyId, group.id);
    // The claim created before the stop is untouched.
    assert.equal((await repository.getClaim({ sessionToken: verified.sessionToken, claimId: claim.id })).state, 'PREPARING');
  });

  receipt.passed = passed;
  process.stdout.write(JSON.stringify({ status: 'PASS', ...receipt }) + '\n');
} catch (error) {
  process.stderr.write(JSON.stringify({ status: 'FAIL', stage, passed,
    code: error.code ?? error.name, message: String(error.message).slice(0, 200) }) + '\n');
  process.exitCode = 1;
} finally {
  clearTimeout(deadline);
  if (pool) await pool.end();
}
