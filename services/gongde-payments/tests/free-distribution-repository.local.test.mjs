import assert from 'node:assert/strict';
import test from 'node:test';
import { register, syncBuiltinESMExports } from 'node:module';
import { fileURLToPath } from 'node:url';
import net from 'node:net';
import tls from 'node:tls';
import http from 'node:http';
import https from 'node:https';

const forbidden = () => { throw new Error('free_distribution_local_network_forbidden'); };
net.connect = net.createConnection = net.Socket.prototype.connect = forbidden;
tls.connect = http.request = http.get = https.request = https.get = forbidden;
globalThis.fetch = forbidden;
syncBuiltinESMExports();
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
const { newSessionToken, DOWNLOAD_WINDOW_MS } = await import('../src/free-distribution/codes.ts');
const OWNER = 'c'.repeat(32), OTHER = 'd'.repeat(32), VERSION = 'e'.repeat(32);
const start = Date.parse('2026-10-08T04:00:00.000Z');
const clone = value => structuredClone(value);
const err = code => value => value.code === code;
const day = { from: '2026-10-08T00:00:00+08:00', to: '2026-10-09T00:00:00+08:00' };
const snapshot = (number = '100001', overrides = {}) => ({ appearanceNumber: number, sourceKind: 'official',
  assetId: 'official.' + number, creatorId: null, versionId: 'v1', sourceRevision: 'f'.repeat(64), catalogRevision: 'r1',
  metadataSnapshot: { title: 'Frozen title ' + number }, consentSnapshot: { free: true },
  snapshotRecord: { sourceObjectKey: 'private/source-' + number }, deliveryBytesUpperBound: 1024, ...overrides });

// This fixture exercises transaction ownership, SQL contracts and state-machine
// behavior, NOT real InnoDB locking/DDL. It intentionally refuses unknown SQL.
class Fixture {
  time = start;
  tail = Promise.resolve();
  log = [];
  metrics = { begins: 0, commits: 0, rollbacks: 0, releases: 0 };
  collision = false;
  staleConsistentCount = false;
  blocked = false;
  catalogChanged = false;
  validations = 0;
  state = {};
  constructor(options = {}) {
    for (const name of ['gongde_creators', 'gongde_creator_works', 'gongde_creator_reviews', 'gongde_free_creator_numbers',
      'gongde_free_creator_number_allocator', 'gongde_free_code_families', 'gongde_free_code_tokens', 'gongde_free_contributions',
      'gongde_free_excluded_fingerprints', 'gongde_free_download_sessions', 'gongde_free_claims', 'gongde_free_claim_items',
      'gongde_free_delivery_artifacts', 'gongde_free_audit', 'gongde_free_verification_events', 'gongde_free_rate_limits']) this.state[name] = [];
    this.state.gongde_creators.push({ creator_id: OWNER, state: 'ACTIVE', created_at: new Date(start) });
    this.state.gongde_free_creator_numbers.push({ creator_id: OWNER, serial: 100001, created_at: new Date(start) });
    this.state.gongde_free_creator_number_allocator.push({ allocator_id: 1, next_serial: 100002 });
    this.pool = { execute: (...args) => this.execute(...args), getConnection: async () => {
      let backup, releaseLock;
      return { execute: (...args) => this.execute(...args), beginTransaction: async () => {
        const previous = this.tail;
        this.tail = new Promise(resolve => { releaseLock = resolve; });
        await previous; backup = clone(this.state); this.metrics.begins += 1;
      }, commit: async () => { this.metrics.commits += 1; releaseLock(); },
      rollback: async () => { this.metrics.rollbacks += 1; this.state = backup; releaseLock(); },
      release: () => { this.metrics.releases += 1; } };
    } };
    this.repository = new FreeDistributionRepository(this.pool, { codeSecret: Buffer.alloc(32, 9), enabled: true,
      now: () => new Date(this.time), deliveryReady: () => true,
      validateItems: async () => { this.validations += 1; if (this.catalogChanged) throw Object.assign(new Error('claim_catalog_changed'), { code: 'claim_catalog_changed', status: 409 }); },
      checkSafety: async () => !this.blocked, ...options });
  }
  async tx(operation) {
    const c = await this.pool.getConnection(); await c.beginTransaction();
    try { const result = await operation(c); await c.commit(); return result; }
    catch (error) { await c.rollback(); throw error; } finally { c.release(); }
  }
  async execute(sql, values = []) {
    const q = sql.replace(/\s+/g, ' ').trim();
    this.log.push({ q, values: clone(values) });
    assert.ok(!/gongde_orders|gongde_market_order|royalty|settlement/.test(q), 'no historical payment writes or reads');
    let result;
    if (/^INSERT INTO/.test(q)) result = this.insert(q, values);
    else if (/^UPDATE /.test(q)) result = this.update(q, values);
    else if (/^SELECT /.test(q)) result = this.select(q, values);
    else throw new Error('unsupported_fixture_sql: ' + q);
    return [clone(result), []];
  }
  insert(q, values) {
    const match = /^INSERT INTO (\w+) \((.*?)\) VALUES \((.*?)\)/.exec(q);
    assert.ok(match, 'known INSERT shape');
    const [, table, fields, tokens] = match; let position = 0;
    const row = { ...({ gongde_free_code_families: { verification_count: 0 },
      gongde_free_code_tokens: { revoked_at: null }, gongde_free_contributions: { revoked_at: null, restored_at: null, reason: null },
      gongde_free_claims: { state: 'PREPARING', revision: 1, issued_at: null, download_expires_at: null, error_code: null,
        retryable: false, stage: 'queued', attempts: 0, lease_digest: null, lease_expires_at: null, generation_started_at: null }
    }[table] ?? {}) };
    const parts = tokens.split(',').map(value => value.trim());
    fields.split(',').map(value => value.trim()).forEach((field, index) => {
      const token = parts[index]; row[field] = token === '?' ? values[position++] : token === 'NULL' ? null :
        token.startsWith("'") ? token.slice(1, -1) : Number(token);
    });
    const data = this.state[table]; assert.ok(data, 'owned table only');
    let conflict;
    if (table === 'gongde_free_code_families') conflict = data.find(value => row.kind === 'GROUP' ? value.kind === 'GROUP' : value.creator_id === row.creator_id);
    if (table === 'gongde_free_code_tokens') {
      if (this.collision && Number(row.nonce) === 0) { this.collision = false; throw Object.assign(new Error('collision'), { code: 'ER_DUP_ENTRY' }); }
      conflict = data.find(value => value.code_digest === row.code_digest || (value.family_id === row.family_id && value.cycle_index === row.cycle_index && value.generation === row.generation));
    }
    if (table === 'gongde_free_contributions') conflict = data.find(value => value.work_id === row.work_id || value.content_fingerprint === row.content_fingerprint);
    if (table === 'gongde_free_claims') conflict = data.find(value => value.session_id === row.session_id && value.idempotency_key === row.idempotency_key);
    const key = ({ gongde_free_creator_numbers: 'creator_id', gongde_free_download_sessions: 'session_digest',
      gongde_free_delivery_artifacts: 'claim_id', gongde_free_excluded_fingerprints: 'content_fingerprint', gongde_free_rate_limits: 'bucket_digest' })[table];
    if (key) conflict ??= data.find(value => value[key] === row[key]);
    if (conflict) {
      if (q.includes('ON DUPLICATE KEY')) return { affectedRows: 0 };
      throw Object.assign(new Error('duplicate'), { code: 'ER_DUP_ENTRY' });
    }
    data.push(row); return { affectedRows: 1 };
  }
  update(q, values) {
    const match = /^UPDATE (\w+) SET (.*?) WHERE (.*)$/.exec(q); assert.ok(match);
    const [, table, assignments, where] = match;
    let position = 0;
    const changes = assignments.split(/,\s*(?=[a-z_]+\s*=)/).map(part => {
      const [field, expression] = part.split(/\s*=\s*/); const args = values.slice(position, position + (expression.match(/\?/g)?.length ?? 0));
      position += args.length; return { field, expression, args };
    });
    const lookup = /^(\w+) = (\?|1)/.exec(where); assert.ok(lookup);
    const key = lookup[1], wanted = lookup[2] === '?' ? values[position] : 1;
    const selected = this.state[table].filter(row => row[key] === wanted && (!where.includes('revoked_at IS NULL') || row.revoked_at == null));
    for (const row of selected) for (const { field, expression, args } of changes) {
      row[field] = expression === '?' ? args[0] : expression === 'NULL' ? null : expression === 'TRUE' ? true : expression === 'FALSE' ? false :
        expression.startsWith("'") ? expression.slice(1, -1) : expression.endsWith(' + 1') ? Number(row[field]) + 1 :
        expression.startsWith('COALESCE') ? row[field] ?? args[0] : expression === field ? row[field] : Number(expression);
    }
    return { affectedRows: selected.length };
  }
  select(q, v) {
    const data = name => this.state[name];
    if (q.includes('FROM gongde_creators c')) {
      const selected = data('gongde_creators').filter(row => (!v[0] || row.creator_id === v[0] ||
        'C' + data('gongde_free_creator_numbers').find(n => n.creator_id === row.creator_id)?.serial === v[0]) && (!v[3] || row.state === v[3]));
      return q.startsWith('SELECT COUNT') ? [{ n: selected.length }] : this.page(q, selected);
    }
    if (q.includes('FROM gongde_creators WHERE')) return data('gongde_creators').filter(row => row.creator_id === v[0]);
    if (q.includes('FROM gongde_free_creator_numbers WHERE')) return data('gongde_free_creator_numbers').filter(row => row.creator_id === v[0]);
    if (q.includes('FROM gongde_free_creator_number_allocator')) return data('gongde_free_creator_number_allocator');
    if (q.includes('FROM gongde_creator_works w JOIN gongde_creator_work_versions')) return data('gongde_creator_works').filter(row => row.work_id === v[0] && row.creator_id === v[1]);
    if (q.includes('FROM gongde_creator_works w LEFT JOIN gongde_appearance_numbers')) return data('gongde_creator_works').filter(row => row.work_id === v[0]);
    if (q.includes('FROM gongde_creator_works WHERE creator_id')) return [{ n: data('gongde_creator_works').filter(row => row.creator_id === v[0]).length }];
    if (q.includes('FROM gongde_creator_reviews')) return data('gongde_creator_reviews').filter(row => row.version_id === v[0] && row.state === 'APPROVED');
    if (q.includes('FROM gongde_free_code_families')) {
      let selected = data('gongde_free_code_families');
      if (q.includes('WHERE id = ?')) selected = selected.filter(row => row.id === v[0]);
      else if (q.includes('WHERE creator_id = ?')) selected = selected.filter(row => row.creator_id === v[0]);
      else if (q.includes("WHERE kind = 'GROUP'")) selected = selected.filter(row => row.kind === 'GROUP');
      else if (q.includes('COALESCE(SUM')) return [{ n: selected.filter(row => !v[0] || row.id === v[0]).reduce((n, row) => n + row.verification_count, 0) }];
      else if (q.includes('LEFT JOIN gongde_creators')) selected = selected.filter(row => (!v[0] || row.creator_id === v[0]) && (!v[2] || row.state === v[2]));
      return this.page(q, selected.map(row => ({ ...row, creator_state: data('gongde_creators').find(c => c.creator_id === row.creator_id)?.state })));
    }
    if (q.includes('FROM gongde_free_code_tokens')) {
      let selected = data('gongde_free_code_tokens');
      if (q.includes('WHERE code_digest')) selected = selected.filter(row => row.code_digest === v[0]);
      else if (q.includes('WHERE family_id')) selected = selected.filter(row => row.family_id === v[0] && row.cycle_index === v[1] && row.generation === v[2]);
      else if (q.includes('WHERE id')) selected = selected.filter(row => row.id === v[0]);
      return selected;
    }
    if (q.includes('FROM gongde_free_contributions')) {
      let selected = data('gongde_free_contributions');
      if (q.includes('WHERE work_id = ?')) selected = selected.filter(row => row.work_id === v[0]);
      else if (q.includes('WHERE content_fingerprint')) selected = selected.filter(row => row.content_fingerprint === v[0]);
      else if (q.includes('WHERE creator_id = ?')) selected = selected.filter(row => row.creator_id === v[0]);
      else if (q.includes('WHERE (? IS NULL OR creator_id')) selected = selected.filter(row => (!v[0] || row.creator_id === v[0]) && (!v[2] || row.state === v[2]));
      if (q.includes("state = 'ACTIVE'")) selected = selected.filter(row => row.state === 'ACTIVE');
      if (q.startsWith('SELECT COUNT')) return [{ n: this.staleConsistentCount && !q.includes('FOR SHARE') ? 1 : selected.length }];
      return this.page(q, selected);
    }
    if (q.includes('FROM gongde_free_excluded_fingerprints')) return data('gongde_free_excluded_fingerprints').filter(row => row.content_fingerprint === v[0]);
    if (q.includes('FROM gongde_free_download_sessions')) return data('gongde_free_download_sessions').filter(row => q.includes('session_digest = ?') ? row.session_digest === v[0] : row.id === v[0]);
    if (q.includes('FROM gongde_free_claim_items i JOIN gongde_free_claims')) {
      const eligible = data('gongde_free_claims').filter(row => row.issued_at &&
        (q.includes('c.issued_at >=') ? +row.issued_at >= +v[0] && +row.issued_at < +v[1] && (!v[2] || row.family_id === v[2]) : (!v[0] || row.family_id === v[0])));
      return [{ n: data('gongde_free_claim_items').filter(item => eligible.some(row => row.id === item.claim_id)).length }];
    }
    if (q.includes('FROM gongde_free_claim_items WHERE')) return data('gongde_free_claim_items').filter(row => row.claim_id === v[0]).sort((a, b) => a.position - b.position);
    if (q.includes('FROM gongde_free_delivery_artifacts')) return data('gongde_free_delivery_artifacts').filter(row => row.claim_id === v[0]);
    if (q.includes('FROM gongde_free_claims')) {
      let selected = data('gongde_free_claims');
      if (q.includes('WHERE id = ? AND session_id')) selected = selected.filter(row => row.id === v[0] && row.session_id === v[1]);
      else if (q.includes('WHERE id = ?')) selected = selected.filter(row => row.id === v[0]);
      else if (q.includes('WHERE session_id = ? AND idempotency_key')) selected = selected.filter(row => row.session_id === v[0] && row.idempotency_key === v[1]);
      else if (q.includes('lease_expires_at > ?')) selected = selected.filter(row => row.session_id === v[0] && row.state === 'PREPARING' && row.lease_expires_at && +row.lease_expires_at > +v[1] && row.id !== v[2]);
      else if (q.includes('WHERE created_at >= ?')) selected = selected.filter(row => +row.created_at >= +v[0] && +row.created_at < +v[1] && (!v[2] || row.family_id === v[2]) &&
        (!v[4] || (row.state === 'READY' && +row.download_expires_at <= +v[5] ? 'EXPIRED' : row.state) === v[4]));
      else if (q.includes('WHERE issued_at >= ?')) selected = selected.filter(row => row.issued_at && +row.issued_at >= +v[0] && +row.issued_at < +v[1] && (!v[2] || row.family_id === v[2]));
      else if (q.includes('WHERE issued_at IS NOT NULL')) selected = selected.filter(row => row.issued_at && (!v[0] || row.family_id === v[0]));
      else if (q.includes('WHERE (? IS NULL OR session_id')) selected = selected.filter(row => (!v[0] || row.session_id === v[0]) && (!v[2] || row.family_id === v[2]) && (!v[4] || row.state === v[4]) && (!v[6] || +row.created_at >= +v[7]));
      if (q.startsWith('SELECT COUNT')) return [{ n: selected.length }];
      return this.page(q, selected);
    }
    if (q.includes('FROM gongde_free_verification_events')) return [{ n: data('gongde_free_verification_events').filter(row => +row.occurred_at >= +v[0] && +row.occurred_at < +v[1] && (!v[2] || row.family_id === v[2])).length }];
    if (q.includes('FROM gongde_free_rate_limits')) return data('gongde_free_rate_limits').filter(row => row.bucket_digest === v[0]);
    throw new Error('unsupported_fixture_select: ' + q);
  }
  page(q, selected) {
    if (q.includes('ORDER BY created_at DESC') || q.includes('ORDER BY c.created_at DESC')) selected = [...selected].sort((a, b) => +b.created_at - +a.created_at || String(b.id ?? b.creator_id).localeCompare(String(a.id ?? a.creator_id)));
    const match = /LIMIT (\d+) OFFSET (\d+)/.exec(q);
    return match ? selected.slice(Number(match[2]), Number(match[2]) + Number(match[1])) : selected;
  }
}
function approvedMetadata() {
  const metadata = { titleZh: 'Real independent work', description: 'Description', tags: [], priceFen: 0,
    acceptFreeDistribution: true, acceptAiContentReview: true, sharingTermsVersion: consent.FREE_CREATOR_TERMS_VERSION,
    sharingTermsSha256: consent.FREE_CREATOR_TERMS_SHA256, aiReviewTermsVersion: consent.FREE_CREATOR_AI_TERMS_VERSION,
    aiReviewTermsSha256: consent.FREE_CREATOR_AI_TERMS_SHA256 };
  metadata.publicTextSha256 = consent.creatorPublicTextDigest(metadata); return metadata;
}
function publish(f, workId = 'community.real-one', owner = OWNER, metadata = approvedMetadata()) {
  const versionId = workId === 'community.real-one' ? VERSION : 'b'.repeat(32);
  f.state.gongde_creator_works.push({ work_id: workId, creator_id: owner, state: 'PUBLISHED', published_version_id: versionId,
    published_metadata_json: clone(metadata), approved_metadata_json: clone(metadata), version_state: 'APPROVED',
    validation_json: {}, source_manifest_json: {}, title_zh: metadata.titleZh, appearance_serial: 100020 });
  f.state.gongde_creator_reviews.push({ version_id: versionId, state: 'APPROVED', metadata_snapshot_json: clone(metadata) });
}
const earn = (f, workId = 'community.real-one', creatorId = OWNER, contentFingerprint = '1'.repeat(64)) =>
  f.tx(c => recordFreeContribution(c, { workId, creatorId, contentFingerprint }));
async function access(f) {
  const group = await f.repository.ensureGroupFamily();
  const current = await f.repository.getCurrentCode(group.id);
  const verified = await f.repository.verifyCode({ code: current.code });
  return { family: group, code: current.code, sessionToken: verified.sessionToken };
}
async function create(f, auth, key = 'confirm-one', items = [snapshot()]) {
  return (await f.repository.createClaim({ sessionToken: auth.sessionToken, idempotencyKey: key, items })).claim;
}
function artifact(claim, extra = {}) {
  const many = claim.items.length > 1;
  return { privateObjectKey: 'private/claims/' + claim.id, sha256: '8'.repeat(64), bytes: 2048,
    filename: `niuma-${many ? 'appearances' : 'appearance'}-${claim.id}.${many ? 'nmgpacks' : 'nmgpack'}`,
    format: many ? 'nmgpacks' : 'nmgpack', licenseMode: 'perpetual', signerVersion: 'test-perpetual-v1', ...extra };
}

test('default feature switch fails closed but real public numbers do not activate a family', async () => {
  const f = new Fixture({ enabled: undefined });
  assert.equal(await f.repository.ensureCreatorPublicNumber(OWNER), 'C100001');
  assert.equal(await f.repository.getCreatorFamily(OWNER), null);
  const group = await f.repository.getGroupCode();
  assert.equal(group.redemptionEnabled, false);
  await assert.rejects(() => f.repository.verifyCode({ code: group.code }), err('free_distribution_disabled'));
});
test('unique GROUP identity, persistent period token and collision nonce', async () => {
  const f = new Fixture(); f.collision = true;
  const [a, b] = await Promise.all([f.repository.ensureGroupFamily(), f.repository.ensureGroupFamily()]);
  assert.equal(a.id, b.id);
  const x = await f.repository.getCurrentCode(a.id), y = await f.repository.getCurrentCode(a.id);
  assert.equal(x.code, y.code);
  assert.equal(f.state.gongde_free_code_tokens.length, 1);
  assert.equal(f.state.gongde_free_code_tokens[0].nonce, 1);
  assert.ok(!JSON.stringify(f.log).includes(x.code), 'no plaintext code in SQL/log-shaped inputs');
});
test('success verification stores token digest; wrong code keeps prior authorization', async () => {
  const f = new Fixture(), auth = await access(f);
  assert.ok(!JSON.stringify(f.state).includes(auth.sessionToken));
  await assert.rejects(() => f.repository.verifyCode({ code: 'NM-2222-2222', sessionToken: auth.sessionToken }), err('access_code_invalid'));
  assert.equal((await f.repository.getSession(auth.sessionToken)).authorization.limit, 10);
  assert.equal(f.state.gongde_free_verification_events.length, 1);
});
test('anonymous session is absolute 30 days and clearAccess retains prior claims', async () => {
  const f = new Fixture(), auth = await access(f), claim = await create(f, auth);
  await f.repository.clearAccess(auth.sessionToken);
  assert.equal((await f.repository.getSession(auth.sessionToken)).authorization, null);
  assert.equal((await f.repository.getClaim({ sessionToken: auth.sessionToken, claimId: claim.id })).id, claim.id);
  await assert.rejects(() => create(f, auth, 'new-after-clear'), err('access_code_required'));
  f.time = start + 30 * 86400000;
  await assert.rejects(() => f.repository.getSession(auth.sessionToken), err('download_session_required'));
});
test('first free publication is contribution-idempotent and caller owns transaction', async () => {
  const f = new Fixture(); publish(f);
  const [first, second] = await Promise.all([earn(f), earn(f)]);
  assert.equal(first.created, true); assert.equal(second.created, false);
  assert.equal(first.familyId, second.familyId);
  assert.equal(f.state.gongde_free_contributions.length, 1);
  assert.equal(f.state.gongde_free_code_families.length, 1);
  assert.equal(f.metrics.begins, 2); assert.equal(f.metrics.commits, 2);
  assert.equal((await f.repository.getCreatorPromotion(OWNER)).maxItems, 3);
});
test('current new authorization and matching approved review are required for historical backfill', async () => {
  for (const change of ['paid', 'old-terms', 'wrong-review', 'not-published']) {
    const f = new Fixture(); publish(f);
    if (change === 'paid') f.state.gongde_creator_works[0].approved_metadata_json.priceFen = 20;
    if (change === 'old-terms') f.state.gongde_creator_works[0].published_metadata_json.sharingTermsVersion = 'creator-free-sharing-v1';
    if (change === 'wrong-review') f.state.gongde_creator_reviews[0].metadata_snapshot_json.publicTextSha256 = '0'.repeat(64);
    if (change === 'not-published') f.state.gongde_creator_works[0].state = 'DRAFT';
    await assert.rejects(() => earn(f));
    assert.equal(f.state.gongde_free_contributions.length, 0);
    assert.equal(f.state.gongde_free_code_families.length, 0);
  }
});
test('identical normalized content cannot become another contribution, including another author', async () => {
  const f = new Fixture(); publish(f); await earn(f);
  f.state.gongde_creators.push({ creator_id: OTHER, state: 'ACTIVE', created_at: new Date(start + 1) });
  publish(f, 'community.copy', OTHER);
  await assert.rejects(() => earn(f, 'community.copy', OTHER), err('contribution_duplicate_content'));
  assert.equal(f.state.gongde_free_contributions.length, 1);
  assert.equal(f.state.gongde_free_code_families.length, 1);
});
test('explicit sample fingerprint and stored synthetic flags are excluded', async () => {
  const f = new Fixture(); publish(f);
  await f.repository.registerExcludedFingerprint({ contentFingerprint: '1'.repeat(64), kind: 'SAMPLE', actor: 'admin', reason: 'guide sample fingerprint' });
  await assert.rejects(() => earn(f), err('contribution_sample_excluded'));
  const g = new Fixture(); publish(g); g.state.gongde_creator_works[0].validation_json.synthetic = true;
  await assert.rejects(() => earn(g), err('contribution_sample_excluded'));
});
test('revision/reason audit on revoke/restore; publication retry never re-grants revoked contribution', async () => {
  const f = new Fixture(); publish(f); await earn(f);
  const revoked = await f.repository.mutateContribution({ workId: 'community.real-one', action: 'revoke', expectedRevision: 1, actor: 'admin', reason: 'confirmed duplicate contribution' });
  assert.equal(revoked.revision, 2); assert.equal(revoked.state, 'REVOKED');
  assert.equal((await earn(f)).contribution.state, 'REVOKED');
  const inactive = await f.repository.getCreatorPromotion(OWNER);
  assert.equal(inactive.status, 'INACTIVE'); assert.equal(inactive.maxItems, 0);
  await assert.rejects(() => f.repository.mutateContribution({ workId: 'community.real-one', action: 'restore', expectedRevision: 1, actor: 'admin', reason: 'wrong old revision' }), err('admin_revision_conflict'));
  const restored = await f.repository.mutateContribution({ workId: 'community.real-one', action: 'restore', expectedRevision: 2, actor: 'admin', reason: 'review confirmed original rights' });
  assert.equal(restored.revision, 3); assert.equal(restored.state, 'ACTIVE');
  assert.equal(f.state.gongde_free_contributions.length, 1);
  assert.equal((await f.repository.getCreatorPromotion(OWNER)).maxItems, 3);
  assert.equal(f.state.gongde_free_audit.filter(row => row.action === 'contribution.restore').length, 1);
});
test('permission uses current locking contributions even when plain COUNT would be stale', async () => {
  const f = new Fixture(); publish(f); await earn(f);
  publish(f, 'community.real-two'); await earn(f, 'community.real-two', OWNER, '2'.repeat(64));
  f.staleConsistentCount = true;
  const family = await f.repository.getCreatorFamily(OWNER);
  assert.equal(family.limit, 6);
  assert.ok(f.log.some(row => row.q.includes("state = 'ACTIVE' FOR SHARE")));
});
test('more contributions increase permissions without changing current author code', async () => {
  const f = new Fixture(); publish(f); const initial = await earn(f);
  const a = await f.repository.getCurrentCode(initial.familyId);
  publish(f, 'community.real-two'); await earn(f, 'community.real-two', OWNER, '2'.repeat(64));
  const b = await f.repository.getCurrentCode(initial.familyId);
  assert.equal(a.code, b.code); assert.equal(a.authorization.limit, 3); assert.equal(b.authorization.limit, 6);
});
test('pause/resume and generation rotation preserve original claim and attribution', async () => {
  const f = new Fixture(), auth = await access(f), claim = await create(f, auth);
  const paused = await f.repository.mutateFamily({ familyId: auth.family.id, action: 'pause', expectedRevision: 1, actor: 'admin', reason: 'temporary operational pause' });
  assert.equal(paused.status, 'PAUSED'); assert.equal(paused.maxItems, 10); assert.equal(paused.revision, 2);
  assert.equal((await f.repository.getClaim({ sessionToken: auth.sessionToken, claimId: claim.id })).state, 'PREPARING');
  const resumed = await f.repository.mutateFamily({ familyId: auth.family.id, action: 'resume', expectedRevision: 2, actor: 'admin', reason: 'operational issue resolved' });
  assert.equal(resumed.code, auth.code);
  const rotated = await f.repository.mutateFamily({ familyId: auth.family.id, action: 'rotate', expectedRevision: 3, actor: 'admin', reason: 'immediate operator rotation' });
  assert.notEqual(rotated.code, auth.code); assert.equal(rotated.revision, 4);
  await assert.rejects(() => f.repository.verifyCode({ code: auth.code }), err('access_code_expired'));
  const recovered = await f.repository.findClaimByKey({ sessionToken: auth.sessionToken, idempotencyKey: 'confirm-one' });
  assert.equal(recovered.id, claim.id); assert.equal(recovered.codeFamilyId, auth.family.id);
});
test('fixed cycle boundary rejects prior code but idempotent old confirmation survives', async () => {
  const f = new Fixture(), auth = await access(f), claim = await create(f, auth);
  f.time = Date.parse('2026-10-10T15:59:59.999Z');
  await f.repository.verifyCode({ code: auth.code, sessionToken: auth.sessionToken });
  f.time += 1;
  await assert.rejects(() => f.repository.verifyCode({ code: auth.code }), err('access_code_expired'));
  assert.equal((await create(f, auth)).id, claim.id);
  await assert.rejects(() => create(f, auth, 'fresh-confirmation'), err('access_code_expired'));
});
test('frozen snapshotRecord and order-independent idempotency; conflict does not truncate', async () => {
  const f = new Fixture(), auth = await access(f), items = [snapshot(), snapshot('100002')];
  const claim = await create(f, auth, 'two-items', items);
  items[0].snapshotRecord.sourceObjectKey = 'changed-after-creation';
  assert.equal(claim.items[0].snapshotRecord.sourceObjectKey, 'private/source-100001');
  const retry = await f.repository.createClaim({ sessionToken: auth.sessionToken, idempotencyKey: 'two-items', items: [snapshot('100002'), snapshot()] });
  assert.equal(retry.created, false); assert.equal(retry.claim.id, claim.id);
  await assert.rejects(() => create(f, auth, 'two-items', [snapshot()]), err('claim_idempotency_conflict'));
  assert.equal(f.state.gongde_free_claims.length, 1);
});
test('findClaimByKey restores before catalog changes/unlist and does not re-run validation', async () => {
  const f = new Fixture(), auth = await access(f), claim = await create(f, auth);
  f.catalogChanged = true;
  const found = await f.repository.findClaimByKey({ sessionToken: auth.sessionToken, idempotencyKey: 'confirm-one' });
  assert.equal(found.id, claim.id); assert.equal(found.items[0].catalogRevision, 'r1'); assert.equal(f.validations, 1);
  assert.equal(await f.repository.findClaimByKey({ sessionToken: auth.sessionToken, idempotencyKey: 'different-key' }), null);
});
test('browser cookie possession is mandatory even with a known claim ID', async () => {
  const f = new Fixture(), auth = await access(f), claim = await create(f, auth);
  for (const token of [newSessionToken(), 'invalid']) await assert.rejects(() => f.repository.getClaim({ sessionToken: token, claimId: claim.id }), err('claim_not_found'));
  const other = await f.repository.verifyCode({ code: auth.code });
  await assert.rejects(() => f.repository.getClaim({ sessionToken: other.sessionToken, claimId: claim.id }), err('claim_not_found'));
  assert.equal(await f.repository.findClaimByKey({ sessionToken: other.sessionToken, idempotencyKey: 'confirm-one' }), null);
});
test('missing transactional catalog/safety validators fail closed', async () => {
  const f = new Fixture({ validateItems: undefined }), auth = await access(f);
  await assert.rejects(() => create(f, auth), err('claim_catalog_validator_missing'));
  const g = new Fixture({ checkSafety: undefined }), accessG = await access(g), claim = await create(g, accessG);
  await assert.rejects(() => g.repository.acquirePreparation(claim.id), err('claim_safety_validator_missing'));
});
test('per-session worker limit and session-before-claim lock order', async () => {
  const f = new Fixture(), auth = await access(f);
  const a = await create(f, auth, 'a'), b = await create(f, auth, 'b'), c = await create(f, auth, 'c');
  const leases = await Promise.all([a, b, c].map(claim => f.repository.acquirePreparation(claim.id)));
  assert.equal(leases.filter(Boolean).length, 2);
  assert.equal(await f.repository.acquirePreparation(a.id), null);
  const firstSession = f.log.findIndex(row => row.q.includes('download_sessions WHERE id = ? FOR UPDATE'));
  const firstClaim = f.log.findIndex((row, i) => i > firstSession && row.q === 'SELECT * FROM gongde_free_claims WHERE id = ? FOR UPDATE');
  assert.ok(firstSession >= 0 && firstClaim > firstSession);
});
test('expired lease is reclaimed and stale signer cannot overwrite new worker', async () => {
  const f = new Fixture(), auth = await access(f), claim = await create(f, auth);
  const first = await f.repository.acquirePreparation(claim.id);
  f.time += 30000;
  const second = await f.repository.acquirePreparation(claim.id);
  assert.ok(second); assert.notEqual(first.leaseToken, second.leaseToken);
  await assert.rejects(() => f.repository.markReady({ claimId: claim.id, leaseToken: first.leaseToken, artifact: artifact(claim) }), err('claim_lease_lost'));
  const ready = await f.repository.markReady({ claimId: claim.id, leaseToken: second.leaseToken, artifact: artifact(claim) });
  assert.equal(ready.state, 'READY'); assert.equal(ready.deliverArtifact.filename, artifact(claim).filename);
  assert.equal(f.state.gongde_free_delivery_artifacts.length, 1);
});
test('signed issuedAt is unified with 7-day window, alias artifact and perpetual null import limit', async () => {
  const f = new Fixture(), auth = await access(f), claim = await create(f, auth), lease = await f.repository.acquirePreparation(claim.id);
  f.time += 2000; const issuedAt = new Date(start + 1000).toISOString();
  const ready = await f.repository.markReady({ claimId: claim.id, leaseToken: lease.leaseToken, artifact: artifact(claim), issuedAt });
  assert.equal(ready.issuedAt, issuedAt);
  assert.equal(Date.parse(ready.downloadExpiresAt), Date.parse(issuedAt) + DOWNLOAD_WINDOW_MS);
  assert.equal(ready.importExpiresAt, null); assert.equal(ready.licenseMode, 'perpetual'); assert.deepEqual(ready.artifact, ready.deliverArtifact);
  assert.equal(ready.artifact.createdAt, issuedAt);
  const end = Date.parse(ready.downloadExpiresAt); f.time = end - 1;
  assert.equal(Date.parse((await f.repository.getDownloadAuthorization({ sessionToken: auth.sessionToken, claimId: claim.id })).linkExpiresAt), end);
  f.time = end;
  await assert.rejects(() => f.repository.getDownloadAuthorization({ sessionToken: auth.sessionToken, claimId: claim.id }), err('claim_download_expired'));
});
test('issuedAt outside generation interval cannot persist an artifact', async () => {
  const f = new Fixture(), auth = await access(f), claim = await create(f, auth), lease = await f.repository.acquirePreparation(claim.id);
  for (const issuedAt of [new Date(start - 1).toISOString(), new Date(start + 1).toISOString(), 'not-a-date']) {
    await assert.rejects(() => f.repository.markReady({ claimId: claim.id, leaseToken: lease.leaseToken, artifact: artifact(claim), issuedAt }), err('claim_issued_at_invalid'));
  }
  assert.equal(f.state.gongde_free_delivery_artifacts.length, 0);
});
test('failure before READY starts no download window; terminal failures cannot retry', async () => {
  const f = new Fixture(), auth = await access(f), claim = await create(f, auth), lease = await f.repository.acquirePreparation(claim.id);
  const failed = await f.repository.markFailed({ claimId: claim.id, leaseToken: lease.leaseToken, errorCode: 'claim_file_too_large', retryable: true });
  assert.equal(failed.state, 'FAILED'); assert.equal(failed.issuedAt, null); assert.equal(failed.downloadExpiresAt, null); assert.equal(failed.retryable, false);
  await assert.rejects(() => f.repository.retryClaim({ sessionToken: auth.sessionToken, claimId: claim.id }), err('claim_retry_not_allowed'));
});
test('recoverable failure retries the same frozen claim, never permission consumption', async () => {
  const f = new Fixture(), auth = await access(f), claim = await create(f, auth), lease = await f.repository.acquirePreparation(claim.id);
  await f.repository.markFailed({ claimId: claim.id, leaseToken: lease.leaseToken, errorCode: 'claim_generation_failed', retryable: true });
  f.time += 5000;
  const automatic = await f.repository.retrySystemClaim(claim.id);
  assert.equal(automatic.id, claim.id); assert.equal(automatic.attempts, 1);
  assert.equal(await f.repository.retrySystemClaim(claim.id), null, 'duplicate system retry starts no second task');
  const second = await f.repository.acquirePreparation(claim.id);
  await f.repository.markFailed({ claimId: claim.id, leaseToken: second.leaseToken, errorCode: 'claim_generation_failed', retryable: true });
  f.time += 15000;
  assert.equal((await f.repository.retrySystemClaim(claim.id)).attempts, 2);
  const third = await f.repository.acquirePreparation(claim.id);
  await f.repository.markFailed({ claimId: claim.id, leaseToken: third.leaseToken, errorCode: 'claim_generation_failed', retryable: true });
  assert.equal(await f.repository.retrySystemClaim(claim.id), null, 'automatic attempt budget cannot be reset');
  const retry = await f.repository.retryClaim({ sessionToken: auth.sessionToken, claimId: claim.id });
  assert.equal(retry.id, claim.id); assert.equal(retry.state, 'PREPARING'); assert.equal(retry.attempts, 0);
  assert.equal((await f.repository.getSession(auth.sessionToken)).authorization.limit, 10);
});
test('safety block is durable even when download call throws; ordinary catalog changes do not block', async () => {
  const f = new Fixture(), auth = await access(f), claim = await create(f, auth), lease = await f.repository.acquirePreparation(claim.id);
  await f.repository.markReady({ claimId: claim.id, leaseToken: lease.leaseToken, artifact: artifact(claim) });
  f.catalogChanged = true;
  assert.equal((await f.repository.getDownloadAuthorization({ sessionToken: auth.sessionToken, claimId: claim.id })).claim.state, 'READY');
  f.blocked = true;
  await assert.rejects(() => f.repository.getDownloadAuthorization({ sessionToken: auth.sessionToken, claimId: claim.id }), err('claim_blocked'));
  assert.equal(f.state.gongde_free_claims[0].state, 'BLOCKED');
  f.blocked = false;
  assert.equal((await f.repository.getClaim({ sessionToken: auth.sessionToken, claimId: claim.id })).state, 'BLOCKED');
});
test('admin contract: no-family creator, exact code shape and uncollected installer statistic', async () => {
  const f = new Fixture(), promotion = await f.repository.getCreatorPromotion(OWNER);
  assert.equal(promotion.familyId, null); assert.equal(promotion.revision, null); assert.equal(promotion.status, 'INACTIVE');
  assert.equal(promotion.authorPublicNumber, 'C100001'); assert.deepEqual(promotion.contributions, []);
  const code = await f.repository.getGroupCode();
  assert.deepEqual(Object.keys(code).sort(), ['familyId', 'revision', 'kind', 'status', 'code', 'validFrom', 'expiresAt', 'contributionCount', 'maxItems', 'redemptionEnabled'].sort());
  assert.equal(code.redemptionEnabled, true);
  assert.deepEqual(await f.repository.getStats(day), { readyClaims: 0, workClaims: 0, verifiedCodes: 0, installerRequests: null });
});
test('admin family revision CAS and reason validation have no mutation on conflict', async () => {
  const f = new Fixture(), code = await f.repository.getGroupCode();
  await assert.rejects(() => f.repository.mutateFamily({ familyId: code.familyId, action: 'rotate', expectedRevision: 9, actor: 'admin', reason: 'stale state' }), err('admin_revision_conflict'));
  await assert.rejects(() => f.repository.mutateFamily({ familyId: code.familyId, action: 'rotate', expectedRevision: 1, actor: 'admin', reason: 'ok' }), err('admin_reason_revision_required'));
  assert.equal((await f.repository.getGroupCode()).revision, 1);
});
test('admin lists safely project frozen metadata, exact total and real nullable delivery fields', async () => {
  const f = new Fixture(), auth = await access(f), claim = await create(f, auth);
  const listing = await f.repository.listClaims({ ...day, page: 1, perPage: 25 });
  assert.equal(listing.total, 1); assert.equal(listing.items[0].claimId, claim.id); assert.equal(listing.items[0].kind, 'GROUP');
  assert.equal(listing.items[0].bytes, null); assert.equal(listing.items[0].durationMs, null);
  assert.deepEqual(listing.items[0].items, [{ number: '100001', title: 'Frozen title 100001', catalogRevision: 'r1' }]);
  assert.ok(!JSON.stringify(listing).includes('private/')); assert.ok(!JSON.stringify(listing).includes(auth.code));
  const authors = await f.repository.listCreators({ q: 'C100001' });
  assert.equal(authors.total, 1); assert.equal(authors.items[0].authorPublicNumber, 'C100001'); assert.equal(authors.items[0].familyId, null);
  const contributionList = await f.repository.listContributions(); assert.deepEqual(contributionList, []);
});
test('READY and work statistics count first issuance once and explicit verifications only', async () => {
  const f = new Fixture(), auth = await access(f), claim = await create(f, auth), lease = await f.repository.acquirePreparation(claim.id);
  await f.repository.markReady({ claimId: claim.id, leaseToken: lease.leaseToken, artifact: artifact(claim) });
  await f.repository.getSession(auth.sessionToken); await f.repository.getDownloadAuthorization({ sessionToken: auth.sessionToken, claimId: claim.id });
  f.blocked = true; await f.repository.getClaim({ sessionToken: auth.sessionToken, claimId: claim.id });
  assert.deepEqual(await f.repository.getStats(day), { readyClaims: 1, workClaims: 1, verifiedCodes: 1, installerRequests: null });
});
test('admin dates require timezone, ordering, <=90d and truthful claim enum', async () => {
  const f = new Fixture();
  for (const range of [{ from: '2026-10-08', to: '2026-10-09' }, { from: day.to, to: day.from },
    { from: '2026-01-01T00:00:00Z', to: '2026-04-02T00:00:00Z' }, { from: '2026-02-30T00:00:00Z', to: '2026-03-02T00:00:00Z' },
    { from: day.from }]) await assert.rejects(() => f.repository.getStats(range), err('admin_date_range_invalid'));
  await assert.rejects(() => f.repository.listClaims({ ...day, state: 'CREATED' }), err('admin_claim_state_invalid'));
  await assert.rejects(() => f.repository.listClaims({ ...day, page: 0 }), err('pagination_invalid'));
});
test('fixed-window rate buckets are persistent hashed operations, not shared code balance', async () => {
  const f = new Fixture(), input = { key: 'claims:session:test-browser', limit: 2, windowMs: 60000 };
  assert.deepEqual(await f.repository.consumeLimit(input), { allowed: true, retryAfterSeconds: 0, remaining: 1 });
  assert.deepEqual(await f.repository.consumeLimit(input), { allowed: true, retryAfterSeconds: 0, remaining: 0 });
  assert.deepEqual(await f.repository.consumeLimit(input), { allowed: false, retryAfterSeconds: 60, remaining: 0 });
  assert.ok(!JSON.stringify(f.state.gongde_free_rate_limits).includes(input.key));
  f.time += 60000;
  assert.equal((await f.repository.consumeLimit(input)).allowed, true);
});
