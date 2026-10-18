import assert from 'node:assert/strict';
import test from 'node:test';
import { register } from 'node:module';
import { fileURLToPath } from 'node:url';

// Read-only in-memory TypeScript loading: no dist output, env file or network.
const loader = `import {readFileSync,existsSync} from 'node:fs';
import {createRequire} from 'node:module'; import {fileURLToPath} from 'node:url';
let ts, root; export function initialize(data){ts=createRequire(data.ts)(data.ts);root=data.root;}
export async function resolve(s,c,next){if(s.startsWith('.')&&c.parentURL?.startsWith(root)&&s.endsWith('.js')){
const u=new URL(s.slice(0,-3)+'.ts',c.parentURL);if(existsSync(fileURLToPath(u)))return {url:u.href,shortCircuit:true};}return next(s,c);}
export async function load(u,c,next){if(u.startsWith(root)&&u.endsWith('.ts'))return {format:'module',shortCircuit:true,
source:ts.transpileModule(readFileSync(fileURLToPath(u),'utf8'),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.ESNext}}).outputText};return next(u,c);}`;
register('data:text/javascript,' + encodeURIComponent(loader), { data: {
  ts: fileURLToPath(new URL('../node_modules/typescript/lib/typescript.js', import.meta.url)),
  root: new URL('../src/', import.meta.url).href
} });
const rules = await import('../src/free-distribution/codes.ts');
const secret = Buffer.alloc(32, 7);
const family = 'a'.repeat(32);
const item = (number = '100001', extra = {}) => ({ appearanceNumber: number, sourceKind: 'official',
  assetId: 'official.' + number, creatorId: null, versionId: 'v1', sourceRevision: 'f'.repeat(64),
  catalogRevision: 'r1', metadataSnapshot: { title: 'Frozen title' }, consentSnapshot: { free: true },
  deliveryBytesUpperBound: 1024, ...extra });
const error = code => value => value.code === code;

test('fixed Shanghai anchor and half-open 72-hour boundary', () => {
  const start = rules.FREE_DISTRIBUTION_ANCHOR_MS;
  assert.equal(new Date(start).toISOString(), '2026-10-07T16:00:00.000Z');
  assert.equal(rules.codeCycle(start).index, 0);
  assert.equal(rules.codeCycle(start + rules.FREE_CODE_CYCLE_MS - 1).index, 0);
  assert.equal(rules.codeCycle(start + rules.FREE_CODE_CYCLE_MS).index, 1);
  assert.equal(rules.codeCycle(start + rules.FREE_CODE_CYCLE_MS).validFrom.toISOString(), '2026-10-10T16:00:00.000Z');
  assert.throws(() => rules.codeCycle(start - 1), error('free_distribution_not_started'));
});
test('group and author live non-depleting permission matrix', () => {
  assert.deepEqual([0, 1, 2, 3, 4, 5].map(n => rules.batchLimit('CREATOR', n)), [0, 3, 6, 9, 10, 10]);
  for (let i = 0; i < 20; i += 1) assert.equal(rules.batchLimit('GROUP', 0), 10);
  assert.throws(() => rules.batchLimit('CREATOR', -1));
  assert.throws(() => rules.batchLimit('OTHER', 1));
});
test('strict complete-code normalization and ASCII lowercase support', () => {
  assert.equal(rules.normalizeCode('  nm-2345-abcd\n'), 'NM-2345-ABCD');
  assert.equal(rules.normalizeCode('nm2345abcd'), 'NM-2345-ABCD');
  for (const value of ['xxNM-2345-ABCD', 'NM-2345-ABCDyy', 'NM-2345-ABC0', 'NM-2345-ABCI',
    'NM-2345-ABCO', 'ＮＭ-2345-ABCD', 'NM 2345 ABCD', '', null]) {
    assert.throws(() => rules.normalizeCode(value), error('access_code_invalid'));
  }
});
test('HMAC key minimum and identity/cycle/generation/nonce domain isolation', () => {
  assert.throws(() => rules.deriveCode(Buffer.alloc(31), family, 0, 0, 0), error('free_distribution_secret_invalid'));
  const code = rules.deriveCode(secret, family, 0, 0, 0);
  assert.equal(rules.deriveCode(secret, family, 0, 0, 0), code);
  assert.match(code, /^NM-[23456789ABCDEFGHJKLMNPQRSTUVWXYZ]{4}-[23456789ABCDEFGHJKLMNPQRSTUVWXYZ]{4}$/);
  const variants = [code, rules.deriveCode(secret, 'b'.repeat(32), 0, 0, 0), rules.deriveCode(secret, family, 1, 0, 0),
    rules.deriveCode(secret, family, 0, 1, 0), rules.deriveCode(secret, family, 0, 0, 1), rules.deriveCode(Buffer.alloc(32, 8), family, 0, 0, 0)];
  assert.equal(new Set(variants).size, variants.length);
  assert.match(rules.codeDigest(secret, code), /^[a-f0-9]{64}$/);
  assert.equal(rules.codeDigest(secret, code.toLowerCase().replaceAll('-', '')), rules.codeDigest(secret, code));
});
test('256-bit anonymous tokens, canonical credentials and secure cookie contract', () => {
  const a = rules.newSessionToken(), b = rules.newSessionToken();
  assert.notEqual(a, b);
  assert.equal(Buffer.from(a, 'base64url').length, 32);
  assert.match(rules.sessionDigest(a), /^[a-f0-9]{64}$/);
  assert.notEqual(rules.sessionDigest(a), rules.sessionDigest(b));
  for (const invalid of ['', 'a'.repeat(42), a + '=', null]) assert.throws(() => rules.sessionDigest(invalid));
  assert.deepEqual(rules.DOWNLOAD_COOKIE_OPTIONS, { httpOnly: true, secure: true, sameSite: 'lax', path: '/', maxAge: 2592000000 });
});
test('claim amount, no repeated work, source and byte-budget gates', () => {
  rules.validateClaimItems([item()], 3);
  rules.validateClaimItems(Array.from({ length: 10 }, (_, i) => item(String(100001 + i))), 10);
  assert.throws(() => rules.validateClaimItems([], 10), error('claim_limit_exceeded'));
  assert.throws(() => rules.validateClaimItems(Array.from({ length: 4 }, (_, i) => item(String(100001 + i))), 3), error('claim_limit_exceeded'));
  assert.throws(() => rules.validateClaimItems([item(), item()], 10), error('claim_duplicate_work'));
  assert.throws(() => rules.validateClaimItems([item(), item('100002', { assetId: 'official.100001' })], 10), error('claim_duplicate_work'));
  assert.throws(() => rules.validateClaimItems([item('100001', { deliveryBytesUpperBound: rules.MAX_DELIVERY_BYTES + 1 })], 10), error('claim_file_too_large'));
  assert.throws(() => rules.validateClaimItems([item('100001', { sourceKind: 'community', creatorId: null })], 10), error('claim_snapshot_invalid'));
  assert.throws(() => rules.validateClaimItems([item('100000')], 10), error('claim_snapshot_invalid'));
});
test('stable digest is order-independent but freezes every version/source/consent field', () => {
  const a = item(), b = item('100002');
  assert.equal(rules.claimRequestDigest([a, b]), rules.claimRequestDigest([b, a]));
  assert.equal(rules.stableJson({ b: 1, a: 2 }), rules.stableJson({ a: 2, b: 1 }));
  for (const change of [{ catalogRevision: 'r2' }, { versionId: 'v2' }, { consentSnapshot: { free: false } },
    { snapshotRecord: { sourceObjectKey: 'private/original' } }]) {
    assert.notEqual(rules.claimRequestDigest([a]), rules.claimRequestDigest([{ ...a, ...change }]));
  }
  assert.throws(() => rules.stableJson({ value: undefined }), error('claim_snapshot_invalid'));
});
test('7-day server recovery is half-open; links <=5min and no local expiry', () => {
  const issued = new Date('2026-10-08T04:00:00.000Z');
  const end = issued.getTime() + rules.DOWNLOAD_WINDOW_MS;
  assert.equal(rules.downloadLinkExpiresAt(issued, issued).getTime(), issued.getTime() + 300000);
  assert.equal(rules.downloadLinkExpiresAt(issued, new Date(end - 1)).getTime(), end);
  assert.throws(() => rules.downloadLinkExpiresAt(issued, new Date(end)), error('claim_download_expired'));
});
test('short author numbers retain natural seven-digit growth', () => {
  assert.equal(rules.creatorPublicNumber(100001), 'C100001');
  assert.equal(rules.creatorPublicNumber(1000000), 'C1000000');
  assert.throws(() => rules.creatorPublicNumber(100000));
});
