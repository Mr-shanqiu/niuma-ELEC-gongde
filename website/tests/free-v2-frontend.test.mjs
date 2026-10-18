import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import test from 'node:test';
const read = path => readFileSync(new URL(path, import.meta.url), 'utf8');
const api = await import('data:text/javascript;base64,' + Buffer.from(read('../free-api.js')).toString('base64'));
const memory = () => { const map = new Map(); return { getItem: key => map.get(key) || null, setItem: (key, value) => map.set(key, value), removeItem: key => map.delete(key) }; };
const item = (number = 100001) => ({ number: String(number), catalogRevision: 'opaque-revision', canClaim: true, deliveryBytesUpperBound: 1048576 });
test('appearance numbers use the complete authoritative range', () => {
  for (const value of [100001, 999999, 1000000, 999999999]) assert.equal(api.validNumber(value), true);
  for (const value of [100000, 99999, 1000000000, 'creator.foo', '', '../100001']) assert.equal(api.validNumber(value), false);
});
test('NFC codepoint counts preserve emoji and normalize equivalent characters', () => {
  assert.equal(api.codePoints(' e\u0301 '), 1); assert.equal(api.codePoints('🐟'), 1);
  assert.equal(api.metadata({ titleZh: '鱼'.repeat(20), description: '🐟'.repeat(40) }).description.length, 80);
  assert.throws(() => api.metadata({ titleZh: '鱼'.repeat(21), description: '鱼' }));
  assert.throws(() => api.metadata({ titleZh: '鱼', description: '鱼'.repeat(41) }));
});
test('creator number is optional, nullable, independently validated, and never read from phone', () => {
  const base = { titleZh: '琥珀豆', description: '敲一下', phone: 'private-value', author: 'not-an-account' };
  assert.equal(api.metadata(base).creatorDouyinNumber, null);
  assert.equal(api.metadata({ ...base, creatorDouyinNumber: ' abc_12.- ' }).creatorDouyinNumber, 'abc_12.-');
  assert.equal(api.metadata({ ...base, creatorDouyinNumber: '' }).creatorDouyinNumber, null);
  for (const value of ['https://douyin.com/foo', '<b>x</b>', '汉字', 'x'.repeat(33)]) assert.throws(() => api.metadata({ ...base, creatorDouyinNumber: value }));
});
test('tags normalize and deduplicate with a 3 by 8 budget; updates require a note', () => {
  assert.deepEqual(api.metadata({ titleZh: '豆', description: '好', tags: '可爱，可爱,动物' }).tags, ['可爱', '动物']);
  assert.throws(() => api.metadata({ titleZh: '豆', description: '好', tags: '1,2,3,4' }));
  assert.throws(() => api.metadata({ titleZh: '豆', description: '好', tags: '长'.repeat(9) }));
  assert.throws(() => api.metadata({ titleZh: '豆', description: '好', isUpdate: true }));
  assert.equal(api.metadata({ titleZh: '豆', description: '好', isUpdate: true, updateNote: '只改本人抖音号' }).updateNote, '只改本人抖音号');
});
test('anonymous selection keeps 10 and does not delete when creator limit becomes 3', () => {
  const selected = Array.from({ length: 10 }, (_, index) => item(100001 + index)); const storage = memory();
  api.writeSelection(selected, storage); assert.equal(api.readSelection(storage).length, 10);
  assert.equal(api.validateSelection(selected), null); assert.match(api.validateSelection(selected, 3), /最多 3/);
  assert.equal(api.readSelection(storage).length, 10);
});
test('duplicate, unavailable, unknown budget and oversized selections are rejected locally', () => {
  assert.ok(api.validateSelection([item(), item()]));
  assert.ok(api.validateSelection([{ ...item(), canClaim: false }]));
  assert.ok(api.validateSelection([{ ...item(), deliveryBytesUpperBound: undefined }]));
  assert.ok(api.validateSelection([{ ...item(), deliveryBytesUpperBound: 16 * 1048576 + 1 }]));
});
test('confirmation persists the same idempotency key on refresh and network retry', () => {
  const storage = memory(); let counter = 0; const id = () => `key-${++counter}`;
  const first = api.confirmation([item()], storage, id); first.sent = true; storage.setItem(api.CONFIRMATION_KEY, JSON.stringify(first));
  assert.deepEqual(api.confirmation([item()], storage, id), first);
  assert.notEqual(api.confirmation([item(100002)], storage, id).key, first.key);
});
test('code authorization is not a balance, expires at the boundary, and is bounded', () => {
  const value = { kind: 'CREATOR', maxItems: 3, expiresAt: '2026-10-10T00:00:00Z' };
  assert.equal(api.validAccess(value, Date.parse('2026-10-09T00:00:00Z')), true);
  assert.equal(api.validAccess(value, Date.parse(value.expiresAt)), false);
  assert.equal(api.validAccess({ ...value, maxItems: 15 }, 0), false);
  assert.equal(api.validAccess({ ...value, state: 'PAUSED' }, 0), false);
});
test('v2 response requires data, installers specifically return items', async () => {
  const original = globalThis.fetch;
  try {
    globalThis.fetch = async (url, options) => { assert.equal(url, '/api/gongde/v2/installers'); assert.equal(options.credentials, 'same-origin'); return new Response(JSON.stringify({ data: { items: [] }, serverTime: '2026-10-08T00:00:00Z', requestId: 'test' })); };
    assert.deepEqual(await api.request('/installers'), { items: [] });
    globalThis.fetch = async () => new Response(JSON.stringify({ installers: [] }));
    await assert.rejects(api.request('/installers'), /response_invalid/);
  } finally { globalThis.fetch = original; }
});
test('429 preserves Retry-After and is not disguised as a wrong code', async () => {
  const original = globalThis.fetch;
  try {
    globalThis.fetch = async () => new Response(JSON.stringify({ error: 'rate_limited', message: '等待' }), { status: 429, headers: { 'Retry-After': '17' } });
    await assert.rejects(api.post('/access/verify', { code: 'input-in-body' }), error => { assert.match(api.errorText(error), /17 秒/); assert.match(api.errorText(error), /权限没有被消费/); return true; });
  } finally { globalThis.fetch = original; }
});
test('HTTPS downloads reject credentials, javascript, and HTTP', () => {
  assert.equal(api.safeDownloadUrl('https://example.test/file.zip'), 'https://example.test/file.zip');
  for (const value of ['http://example.test/a', 'javascript:alert(1)', 'https://user:password@example.test/a']) assert.equal(api.safeDownloadUrl(value), null);
});
test('unified library, explicit 24 pagination, selection and creator metadata have no paid tabs', () => {
  const html = read('../index.html'), flow = read('../free-flow.js'), creator = read('../creator.html');
  assert.match(html, /library-previous/); assert.match(html, /library-next/); assert.match(flow, /result.items.length > 24/);
  assert.match(flow, /300/); assert.match(html, /popular7d/); assert.match(flow, /catalogRevision/);
  assert.doesNotMatch(html, /官方付费包|data-channel|payment-modal|support-open|¥/);
  assert.match(creator, /creatorDouyinNumber/); assert.match(creator, /0\/20/); assert.match(creator, /0\/40/);
  assert.doesNotMatch(creator, /name="displayName"|id="creator-register"|统一价格收费|24 小时/);
});
test('download page contains no access form and direct published links are independent of access', () => {
  const html = read('../download.html'), flow = read('../free-flow.js');
  assert.doesNotMatch(html, /name="code"|claim-code-form/);
  assert.match(flow, /item.publicDownloadUrl/); assert.match(flow, /\/installers/); assert.match(flow, /minPerpetualClientVersion/);
  assert.match(html, /基础木鱼/);
});
test('delivery is server-state driven with one main file, 7 day retention and bounded polling', () => {
  const html = read('../delivery.html'), flow = read('../free-flow.js');
  assert.equal((html.match(/id="delivery-download"/g) || []).length, 1);
  for (const state of ['PREPARING', 'READY', 'FAILED', 'EXPIRED', 'BLOCKED']) assert.ok(flow.includes(state));
  assert.match(flow, /90000/); assert.match(flow, /1000, 2000, 3000, 5000/);
  assert.match(flow, /downloadRetentionSeconds === 604800/); assert.match(flow, /importExpiresAt === null/);
  assert.match(html, /永久离线使用/); assert.match(html, /7 天/); assert.doesNotMatch(html, /首次导入截止/);
});
test('legacy restoration retains the original read and package verification but cannot create orders', () => {
  const checkout = read('../checkout.js'), support = read('../support.js');
  assert.match(checkout, /niuma-pack-order-receipts-v1/); assert.match(checkout, /niuma-pack-pending-checkout/);
  assert.match(checkout, /x-gongde-access-code/); assert.match(checkout, /package\?format=batch/);
  assert.doesNotMatch(checkout + support + read('../app.js') + read('../community.js'), /\/api\/gongde\/checkout|qrDataUrl|redirectUrl/);
  assert.doesNotMatch(checkout, /removeItem|24 \* 60/);
});
test('guide ZIP and webpage share free instructions, five required entries, and original QR', () => {
  const require = createRequire(new URL('../../services/gongde-payments/package.json', import.meta.url));
  const { unzipSync } = require('fflate'); const zip = unzipSync(readFileSync(new URL('../assets/creator-guide.zip', import.meta.url)));
  assert.deepEqual(Object.keys(zip).sort(), ['AI-PROMPT.txt', 'README.txt', 'example.nmgpack', 'manifest.json', 'sample.png'].sort());
  const text = new TextDecoder().decode(zip['README.txt']); const prompt = new TextDecoder().decode(zip['AI-PROMPT.txt']); const page = read('../creator-guide.html');
  for (const word of ['20', '40', '3', 'creatorDouyinNumber', '免费分发', '永久离线']) assert.ok(text.includes(word));
  assert.doesNotMatch(text + prompt, /0\.2 元|平台收费分发|24 小时/);
  assert.ok(page.includes(text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;')));
  assert.match(page, /assets\/developer-douyin\.png/); assert.match(page, /1872941388/);
  const manifest = JSON.parse(new TextDecoder().decode(zip['manifest.json'])); assert.equal(manifest.id, 'creator.template'); assert.equal(manifest.creatorDouyinNumber, undefined);
});
test('pending recovery keeps the original key and exact request; explicit new batch changes the key', () => {
  const storage = memory(), items = [item()];
  const original = api.confirmation(items, storage, () => 'original-key'); original.sent = true;
  storage.setItem(api.CONFIRMATION_KEY, JSON.stringify(original));
  assert.equal(api.pendingConfirmation(items, storage).key, 'original-key');
  assert.equal(api.pendingConfirmation([{ ...item(), catalogRevision: 'new-version' }], storage), null);
  api.clearConfirmation(storage);
  assert.equal(api.pendingConfirmation(items, storage), null);
  assert.equal(api.confirmation(items, storage, () => 'next-batch-key').key, 'next-batch-key');
});
test('promotion becomes unusable exactly at expiry and while suspended', () => {
  const expiresAt = '2026-10-10T00:00:00Z', value = { code: 'synthetic-code', maxItems: 3, expiresAt, status: 'ACTIVE', accountState: 'ACTIVE', redemptionEnabled: true };
  assert.equal(api.promotionUsable(value, Date.parse(expiresAt) - 1), true);
  assert.equal(api.promotionUsable(value, Date.parse(expiresAt)), false);
  assert.equal(api.promotionUsable({ ...value, state: 'SUSPENDED' }, 0), false);
  assert.equal(api.promotionUsable({ ...value, maxItems: 15 }, 0), false);
  const creator = read('../creator.js');
  assert.match(creator, /Math\.min\(30000,until\+1\)/);
  assert.match(creator, /!account\|\|!promotionUsable\(promotion\)/);
  assert.match(creator, /本次没有复制旧码/);
  assert.match(creator, /visibilitychange/);
});
test('report types and NFC codepoint limits match PRD18 and optional fields stay optional', () => {
  for (const category of ['copyright', 'harmful', 'malicious', 'other']) {
    assert.deepEqual(api.reportFields({ category, description: '🐟'.repeat(10) }), { category, description: '🐟'.repeat(10) });
  }
  assert.equal(api.reportFields({ category: 'copyright', description: 'e\u0301'.repeat(1000), evidenceText: '🐟'.repeat(1000), contact: '🐟'.repeat(120) }).description.length, 1000);
  for (const fields of [
    { category: 'unsafe', description: '鱼'.repeat(10) },
    { category: 'other', description: '鱼'.repeat(9) },
    { category: 'other', description: '鱼'.repeat(1001) },
    { category: 'other', description: '鱼'.repeat(10), evidenceText: '鱼'.repeat(1001) },
    { category: 'other', description: '鱼'.repeat(10), contact: '鱼'.repeat(121) }
  ]) assert.throws(() => api.reportFields(fields), error => Boolean(error.field));
  const html = read('../appearance.html');
  assert.match(html, /value="harmful"/); assert.match(html, /value="malicious"/);
  assert.doesNotMatch(html, /maxlength="2000"|value="privacy"/);
  for (const field of ['category', 'description', 'evidenceText', 'contact']) assert.ok(html.includes(`data-report-error="${field}"`));
});
test('withdraw uses the existing creator route and cannot fake an unconfirmed result', async () => {
  const id = 'creator.0123456789abcdef0123456789abcdef.bean';
  await api.withdrawCreatorWork(id, async (path, options) => {
    assert.equal(path, `/api/gongde/creators/works/${id}/withdraw`);
    assert.deepEqual(options, { method: 'POST', body: '{}' }); return { ok: true };
  });
  await assert.rejects(api.withdrawCreatorWork(id, async () => ({ ok: false })), /creator_response_invalid/);
  const creator = read('../creator.js');
  assert.match(creator, /撤回并修改/); assert.match(creator, /await withdrawCreatorWork\(workId, creatorRequest\)/);
  assert.match(creator, /await loadWork\(workId\)/);
});

// Small local DOM harness: no browser, server, provider, or real network is used.
let domModule = 0;
async function withFlow(page, mocks, operation) {
  const old = new Map(['document', 'window', 'location', 'sessionStorage', 'addEventListener', 'setTimeout', 'clearTimeout', '__flowTestApi'].map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  const elements = new Map(), timers = [], navigation = [], storage = mocks.storage || memory();
  class DomNode {
    constructor() { this.children = []; this.dataset = {}; this.listeners = new Map(); this.disabled = false; this.hidden = false; this.elements = { code: { value: '', focus() {} } }; this.textContent = ''; }
    append(...values) { this.children.push(...values); }
    replaceChildren(...values) { this.children = values; }
    addEventListener(event, operation) { this.listeners.set(event, operation); }
    querySelector() { return this.button ||= new DomNode(); }
    querySelectorAll() { return []; }
    focus() {}
    remove() {}
    async click() {
      if (this.disabled) return;
      const event = { currentTarget: this, preventDefault() {} };
      if (this.onclick) await this.onclick(event);
      if (this.listeners.get('click')) await this.listeners.get('click')(event);
    }
  }
  for (const match of read(page).matchAll(/id="([^"]+)"/g)) elements.set(match[1], new DomNode());
  const doc = { body: new DomNode(), getElementById: id => elements.get(id) || null,
    createElement: () => new DomNode(), querySelectorAll: () => [], addEventListener() {} };
  doc.body.dataset.flow = '';
  const assignments = { document: doc, window: {}, location: { search: mocks.search || '', href: 'https://local.test/', origin: 'https://local.test', assign: path => navigation.push(path) },
    sessionStorage: storage, addEventListener() {}, setTimeout: (operation, delay) => { timers.push({ operation, delay }); return timers.length; }, clearTimeout() {},
    __flowTestApi: { ...api, request: mocks.request, post: mocks.post } };
  for (const [key, value] of Object.entries(assignments)) Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  try {
    let source = read('../free-flow.js');
    source = source.replace(/^import \{ request[\s\S]*?from '\.\/free-api\.js';/, `const {request,post,errorText,validNumber,validAccess,readSelection,writeSelection,validateSelection,confirmation,pendingConfirmation,clearConfirmation,reportFields,CONFIRMATION_KEY,MAX_ITEMS,MAX_BYTES,PERMANENT_NOTE,safeDownloadUrl,normalizeText,codePoints}=globalThis.__flowTestApi;`);
    source = source.replace("import { mountCreatorPreview } from './community-preview.js';", "const mountCreatorPreview=async()=>{throw new Error('unused-preview');};");
    source += `\nexport {claim,delivery};\n// isolated-local-test-${++domModule}`;
    const flow = await import('data:text/javascript;base64,' + Buffer.from(source).toString('base64'));
    await operation({ flow, elements, timers, navigation, storage });
  } finally {
    for (const [key, descriptor] of old) { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else delete globalThis[key]; }
  }
}
test('lost creation response restores original claim after code expiry without verification or new permissions', async () => {
  const storage = memory(), selected = { ...item(), title: '测试豆' };
  api.writeSelection([selected], storage); const attempt = api.confirmation([selected], storage, () => 'original-request-key'); attempt.sent = true;
  storage.setItem(api.CONFIRMATION_KEY, JSON.stringify(attempt)); const calls = [];
  await withFlow('../claim.html', { storage,
    request: async path => {
      calls.push(path);
      if (path === '/config') return { enabled: true, ready: true, licenseMode: 'perpetual', importExpiresAt: null, downloadRetentionSeconds: 604800, minPerpetualClientVersion: 'test-version' };
      if (path === '/appearances/100001') return selected;
      if (path === '/access') return { kind: 'GROUP', maxItems: 10, expiresAt: '2020-01-01T00:00:00Z' };
      throw new Error('unexpected-read');
    },
    post: async (path, body, headers) => {
      calls.push(path); assert.equal(path, '/claims/appearances'); assert.deepEqual(body, { items: [{ number: '100001', catalogRevision: 'opaque-revision' }] });
      assert.equal(headers['Idempotency-Key'], 'original-request-key'); return { claimId: 'existing-claim', state: 'READY' };
    }
  }, async ({ flow, elements, navigation }) => {
    await flow.claim(); const before = calls.length;
    assert.equal(elements.get('claim-create').disabled, false); assert.equal(elements.get('claim-create').textContent, '恢复本次领取结果');
    await elements.get('claim-create').click();
    assert.deepEqual(calls.slice(before), ['/claims/appearances']);
    assert.deepEqual(navigation, ['delivery.html?claim=existing-claim']);
  });
});
test('original-key recovery remains available if config cannot be read', async () => {
  const storage = memory(); api.writeSelection([item()], storage);
  const value = api.confirmation([item()], storage, () => 'already-sent'); value.sent = true; storage.setItem(api.CONFIRMATION_KEY, JSON.stringify(value));
  await withFlow('../claim.html', { storage, request: async () => { throw new Error('config-unavailable'); }, post: async (_path, _body, headers) => {
    assert.equal(headers['Idempotency-Key'], 'already-sent'); return { claimId: 'restored', state: 'PREPARING' };
  } }, async ({ flow, elements, navigation }) => {
    await flow.claim(); assert.equal(elements.get('claim-create').disabled, false);
    await elements.get('claim-create').click(); assert.deepEqual(navigation, ['delivery.html?claim=restored']);
  });
});
test('READY again starts a new confirmation key without deleting the original delivery', async () => {
  const storage = memory(); const old = api.confirmation([item()], storage, () => 'old-ready-key');
  await withFlow('../delivery.html', { storage, search: '?claim=original-ready', request: async path => {
    assert.equal(path, '/claims/original-ready'); return { state: 'READY', items: [{ number: 100001, title: '豆' }], bytes: 100, sha256: 'a'.repeat(64), issuedAt: new Date().toISOString(), downloadExpiresAt: new Date(Date.now() + 604800000).toISOString(), licenseMode: 'perpetual', importExpiresAt: null };
  } }, async ({ flow, elements }) => {
    await flow.delivery(); assert.equal(elements.get('delivery-download').hidden, false);
    await elements.get('claim-again').click();
    assert.notEqual(api.confirmation([item()], storage, () => 'new-ready-key').key, old.key);
    assert.equal(elements.get('delivery-id').textContent, 'original-ready');
  });
});
test('PREPARING has no download and schedules its first bounded status poll at one second', async () => {
  await withFlow('../delivery.html', { search: '?claim=preparing', request: async () => ({ state: 'PREPARING', items: [], issuedAt: null, downloadExpiresAt: null }) }, async ({ flow, elements, timers }) => {
    await flow.delivery(); assert.equal(elements.get('delivery-download').hidden, true);
    assert.equal(timers[0].delay, 1000); assert.match(elements.get('delivery-retention').textContent, /尚未开始/);
  });
});
