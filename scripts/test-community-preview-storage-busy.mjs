import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

// Synthetic local dependency fixtures, not native-browser or SDK acceptance.
// Timers are real and the production fetch/PNG/security checks are unchanged.
const imagePath = '/api/gongde/community/versions/cfd82375bb8af46efddc621f5321c69e/images/sample.png';
const png = () => new Response(new Blob(['png-fixture'], { type: 'image/png' }));
const busy = (retryAfter) => new Response(JSON.stringify({ error: 'creator_storage_busy' }), {
  status: 503, headers: { 'content-type': 'application/json', ...(retryAfter === undefined ? {} : { 'retry-after': retryAfter }) }
});
let fixtureId = 0;

async function previewFixture(t, responses, specificationChanges = {}) {
  const calls = [], state = { decoded: 0, closed: 0, canvas: null };
  const context = Object.fromEntries(['setTransform', 'clearRect', 'save', 'translate', 'scale', 'rotate', 'drawImage', 'restore'].map(name => [name, () => {}]));
  const canvas = { setAttribute() {}, getContext: () => context };
  const replacements = {
    document: { body: { dataset: { page: 'synthetic-unit-fixture' } }, createElement: () => canvas },
    devicePixelRatio: 1,
    matchMedia: () => ({ matches: false }),
    cancelAnimationFrame: () => {},
    createImageBitmap: async () => { state.decoded++; return { close() { state.closed++; } }; },
    fetch: async (url, options) => {
      calls.push({ url, options });
      const next = responses.shift();
      assert.ok(next, 'unexpected extra image request');
      return typeof next === 'function' ? next() : next;
    }
  };
  const saved = new Map(Object.keys(replacements).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(replacements)) Object.defineProperty(globalThis, key, { value, writable: true, configurable: true });
  t.after(() => {
    for (const [key, descriptor] of saved) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete globalThis[key];
    }
  });
  const url = new URL('../website/community-preview.js', import.meta.url);
  url.searchParams.set('storage-busy-unit', String(++fixtureId));
  const { mountCreatorPreview } = await import(url.href);
  const frame = { t: 0, x: 0, y: 0, rotation: 0, scale: 1, alpha: 1 };
  const specification = {
    manifest: { canvas_width: 240, canvas_height: 250, layers: [{ image: 'sample.png', frame: [0, 0, 64, 64], anchor: [0.5, 0.5], keyframes: [frame, { ...frame, t: 1 }] }] },
    images: { 'sample.png': imagePath }, ...specificationChanges
  };
  const container = { replaceChildren(value) { state.canvas = value; } };
  return { calls, state, mount: () => mountCreatorPreview(container, specification) };
}

test('storage-busy retries once and mounts the unchanged PNG path', async t => {
  const f = await previewFixture(t, [busy(), png]);
  const player = await f.mount();
  assert.equal(f.calls.length, 2); assert.equal(f.state.decoded, 1); assert.ok(f.state.canvas);
  for (const call of f.calls) assert.deepEqual(call, { url: imagePath, options: { credentials: 'same-origin', cache: 'no-store' } });
  player.destroy(); assert.equal(f.state.closed, 1);
});

test('storage-busy stops after three attempts with real bounded waits', async t => {
  const f = await previewFixture(t, [busy(), busy(), busy()]);
  await assert.rejects(f.mount, { message: 'creator_preview_unavailable' });
  assert.equal(f.calls.length, 3); assert.equal(f.state.decoded, 0); assert.equal(f.state.canvas, null);
});

for (const status of [403, 404, 429]) test(`HTTP ${status} never retries or decodes`, async t => {
  const f = await previewFixture(t, [new Response('{}', { status })]);
  await assert.rejects(f.mount, { message: 'creator_preview_unavailable' });
  assert.equal(f.calls.length, 1); assert.equal(f.state.decoded, 0);
});

test('other HTTP 503 errors never retry', async t => {
  const f = await previewFixture(t, [new Response(JSON.stringify({ error: 'creator_service_unavailable' }), { status: 503 })]);
  await assert.rejects(f.mount, { message: 'creator_preview_unavailable' }); assert.equal(f.calls.length, 1);
});

test('a Retry-After beyond the short retry budget is not shortened', async t => {
  const f = await previewFixture(t, [busy('2')]);
  await assert.rejects(f.mount, { message: 'creator_preview_unavailable' }); assert.equal(f.calls.length, 1);
});

test('retry success cannot bypass PNG MIME validation', async t => {
  const f = await previewFixture(t, [busy(), new Response('{}', { headers: { 'content-type': 'application/json' } })]);
  await assert.rejects(f.mount, { message: 'creator_preview_invalid' }); assert.equal(f.state.decoded, 0);
});

test('retry success cannot bypass the unpacked-image byte budget', async t => {
  const f = await previewFixture(t, [busy(), { ok: true, blob: async () => ({ type: 'image/png', size: 12 * 1024 * 1024 + 1 }) }]);
  await assert.rejects(f.mount, { message: 'creator_preview_invalid' }); assert.equal(f.state.decoded, 0);
});

test('invalid image paths never fetch', async t => {
  const f = await previewFixture(t, [], { images: { 'sample.png': '/api/gongde/community/versions/invalid/images/sample.png' } });
  await assert.rejects(f.mount, { message: 'creator_preview_invalid' }); assert.equal(f.calls.length, 0);
});

test('invalid canvas dimensions never fetch', async t => {
  const f = await previewFixture(t, [], { manifest: { canvas_width: 0, canvas_height: 250 } });
  await assert.rejects(f.mount, { message: 'creator_preview_invalid' }); assert.equal(f.calls.length, 0);
});

const uiFiles = ['community-preview.js', 'community.js', 'install.html', 'creator-guide.html'];
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const macOnly = { skip: process.platform !== 'darwin' };
function overlayFixture(t, missingBase) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gongde-community-ui-overlay-unit-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const out = path.join(root, 'dist/gongde-deploy'), site = path.join(root, 'website'), baseline = path.join(root, 'baseline');
  const script = path.join(root, 'scripts/package-website-overlay.sh');
  fs.mkdirSync(path.dirname(script), { recursive: true });
  fs.copyFileSync(new URL('./package-website-overlay.sh', import.meta.url), script);
  for (const dir of [out, site, baseline]) fs.mkdirSync(dir, { recursive: true });
  const files = new Map();
  for (const name of [...uiFiles, 'community.html', 'creator-community.css', 'DOWNLOADS.json', 'installers/untouched.exe']) {
    if (name === missingBase) continue;
    const body = Buffer.from('baseline:' + name + '\n'); files.set(name, body);
    const dest = path.join(baseline, name); fs.mkdirSync(path.dirname(dest), { recursive: true }); fs.writeFileSync(dest, body);
  }
  for (const name of uiFiles) fs.writeFileSync(path.join(site, name), 'candidate:' + name + '\n');
  const tree = sha([...files].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([name, body]) => sha(body) + '  ./' + name + '\n').join(''));
  const archive = path.join(out, 'gongde-site-' + tree + '.tar.gz');
  execFileSync('tar', ['-C', baseline, '-czf', archive, '.'], { env: { ...process.env, COPYFILE_DISABLE: '1' } });
  fs.writeFileSync(archive + '.sha256', sha(fs.readFileSync(archive)) + '  ' + path.basename(archive) + '\n');
  const run = () => spawnSync('/bin/sh', [script, '--community-ui', archive], { encoding: 'utf8', timeout: 15000 });
  return { root, files, site, run };
}

test('community UI overlay changes exactly four files, preserving installers and all other bytes', macOnly, t => {
  const f = overlayFixture(t), result = f.run(); assert.equal(result.status, 0, result.stderr);
  const fields = Object.fromEntries(result.stdout.split('\n').filter(line => line.includes('=')).map(line => { const at = line.indexOf('='); return [line.slice(0, at), line.slice(at + 1)]; }));
  assert.equal(fields.OVERLAY_PROFILE, 'community-ui'); assert.equal(fields.OVERLAY_FILES, uiFiles.join(','));
  const target = path.join(f.root, 'result'); fs.mkdirSync(target); execFileSync('tar', ['-xzf', fields.SITE_ARCHIVE, '-C', target]);
  for (const [name, original] of f.files) assert.deepEqual(fs.readFileSync(path.join(target, name)), uiFiles.includes(name) ? Buffer.from('candidate:' + name + '\n') : original, name);
});

test('community UI overlay refuses a missing help page in its base', macOnly, t => {
  const f = overlayFixture(t, 'creator-guide.html'), result = f.run();
  assert.equal(result.status, 1); assert.match(result.stderr, /overlay file missing from base or source/);
});

test('community UI overlay refuses a symlink help source', macOnly, t => {
  const f = overlayFixture(t); fs.unlinkSync(path.join(f.site, 'creator-guide.html'));
  fs.symlinkSync('install.html', path.join(f.site, 'creator-guide.html'));
  const result = f.run(); assert.equal(result.status, 65); assert.match(result.stderr, /symbolic link/);
});
