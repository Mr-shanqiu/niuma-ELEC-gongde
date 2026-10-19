// Offline producer acceptance only. Every source/base/archive belongs to this
// fresh synthetic fixture tree. No repo website writes or deployment claims.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';

const script = fs.readFileSync(new URL('./package-website-overlay.sh', import.meta.url));
const root = fs.mkdtempSync('/private/tmp/gongde-numbering-overlay-test-');
const fixed = ['index.html', 'app.js', 'community.html', 'community.js', 'install.html', 'admin/index.html'];
const assets = ['admin/assets/chunk-ZxCvBn90.js', 'admin/assets/index-QwErTy12.js', 'admin/assets/style-AbC12345.css'];
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const sorted = names => names.sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)));
const write = (root, name, bytes) => { const destination = path.join(root, name); fs.mkdirSync(path.dirname(destination), { recursive: true }); fs.writeFileSync(destination, bytes); };
const environment = directory => ({ PATH: process.env.PATH, HOME: directory, TMPDIR: directory, LANG: 'C', LC_ALL: 'C', COPYFILE_DISABLE: '1' });
const run = (command, args, directory) => spawnSync(command, args, { env: environment(directory), encoding: 'utf8', timeout: 30000, maxBuffer: 1024 * 1024 });
function files(directory, prefix = '') {
  const result = new Map();
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const name = prefix + entry.name;
    if (entry.isDirectory()) for (const [child, bytes] of files(path.join(directory, entry.name), name + '/')) result.set(child, bytes);
    else if (entry.isFile()) result.set(name, fs.readFileSync(path.join(directory, entry.name)));
    else throw new Error('fixture output contains non-regular entry');
  }
  return result;
}
const treeHash = tree => hash(sorted([...tree.keys()]).map(name => `${hash(tree.get(name))}  ./${name}\n`).join(''));
const parseReceipt = output => Object.fromEntries(output.trim().split('\n').map(line => { const index = line.indexOf('='); return [line.slice(0, index), line.slice(index + 1)]; }));
let fixtureCounter = 0;
function fixture() {
  const directory = path.join(root, String(++fixtureCounter)); fs.mkdirSync(directory);
  const source = path.join(directory, 'website'), baseTree = path.join(directory, 'base-tree'), out = path.join(directory, 'dist/gongde-deploy');
  fs.mkdirSync(source); fs.mkdirSync(baseTree); fs.mkdirSync(out, { recursive: true });
  write(directory, 'scripts/package-website-overlay.sh', script);
  for (const name of fixed) { write(baseTree, name, 'old:' + name); write(source, name, 'new:' + name); }
  const extras = ['checkout.html', 'checkout.js', 'support.html', 'support.js', 'creator.html', 'creator.js', 'creator-api.js',
    'creator-guide.html', 'creator-preview.html', 'styles.css', 'robots.txt', 'sitemap.xml', 'articles/retained.html',
    'assets/previews/source-map.json', 'assets/previews/packs/kept/manifest.json', 'assets/previews/packs/kept/body.png',
    'downloads/README.txt', 'downloads/retained.dmg', 'DOWNLOADS.json', 'admin/assets/old-LEgAcY12.js',
    'admin/assets/old-KeEpCss1.css', 'admin/assets/style-AbC12345.css', 'community-preview.js', 'creator-community.css'];
  for (const name of extras) { write(baseTree, name, Buffer.from('retained-base-bytes:' + name)); write(source, name, 'must-not-copy:' + name); }
  write(baseTree, 'binary-retained.dat', Buffer.from([0, 1, 10, 13, 255, 128]));
  for (const name of assets) write(source, name, 'new referenced bytes:' + name);
  write(source, 'admin/assets/unused-SpArE123.js', 'not referenced: do not include');
  write(source, 'admin/index.html', `<!doctype html><html><head>
    <link rel="stylesheet" href="./assets/style-AbC12345.css">
    <link rel="modulepreload" href="./assets/chunk-ZxCvBn90.js">
    <!-- <script src="/admin/assets/ghost-AbCd1234.js"></script> -->
    </head><body><script type="module" src="/admin/assets/index-QwErTy12.js"></script>
    <script>const text = '<script src="/admin/assets/not-real-AbCd1234.js">';</script></body></html>`);
  const instance = { directory, source, baseTree, out, base: null };
  instance.packBase = () => {
    const identity = treeHash(files(baseTree));
    instance.base = path.join(out, `gongde-site-${identity}.tar.gz`);
    const packed = run('/usr/bin/tar', ['-C', baseTree, '-czf', instance.base, '.'], directory);
    assert.equal(packed.status, 0, packed.stderr);
    fs.writeFileSync(instance.base + '.sha256', `${hash(fs.readFileSync(instance.base))}  ${path.basename(instance.base)}\n`);
  };
  instance.invoke = (profile = '--appearance-numbering') => run('/bin/sh', [path.join(directory, 'scripts/package-website-overlay.sh'),
    ...(profile ? [profile] : []), instance.base], directory);
  instance.packBase(); return instance;
}
function outputTree(instance, archive) {
  const extracted = path.join(instance.directory, 'extracted'); fs.mkdirSync(extracted);
  const unpacked = run('/usr/bin/tar', ['-xzf', archive, '-C', extracted], instance.directory);
  assert.equal(unpacked.status, 0, unpacked.stderr); return files(extracted);
}
function refused(instance, match) {
  const before = files(instance.out);
  const result = instance.invoke();
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, match);
  assert.deepEqual(files(instance.out), before, 'failure must not publish, overwrite or leave pending artifacts');
}
function tarEntry(name, type, body = Buffer.alloc(0), link = '') {
  const header = Buffer.alloc(512);
  const put = (value, offset, length) => header.write(value, offset, length, 'ascii');
  put(name, 0, 100); put('0000644\0', 100, 8); put('0000000\0', 108, 8); put('0000000\0', 116, 8);
  put(body.length.toString(8).padStart(11, '0') + '\0', 124, 12); put('00000000000\0', 136, 12);
  header.fill(32, 148, 156); put(type, 156, 1); put(link, 157, 100); put('ustar\0', 257, 6); put('00', 263, 2);
  const sum = header.reduce((total, byte) => total + byte, 0); put(sum.toString(8).padStart(6, '0') + '\0 ', 148, 8);
  return Buffer.concat([header, body, Buffer.alloc((512 - body.length % 512) % 512)]);
}
function maliciousBase(instance, entry) {
  fs.writeFileSync(instance.base, gzipSync(Buffer.concat([entry, Buffer.alloc(1024)])));
  fs.writeFileSync(instance.base + '.sha256', `${hash(fs.readFileSync(instance.base))}  ${path.basename(instance.base)}\n`);
}

test.after(() => fs.rmSync(root, { recursive: true, force: true }));

test('numbering overlay changes only exact entry/reference whitelist and retains every other byte', () => {
  const instance = fixture(), before = files(instance.baseTree);
  const result = instance.invoke(); assert.equal(result.status, 0, result.stderr);
  const receipt = parseReceipt(result.stdout), detail = JSON.parse(receipt.OVERLAY_RECEIPT_JSON);
  assert.equal(receipt.OVERLAY_PROFILE, 'appearance-numbering');
  assert.equal(receipt.BASE_TREE_SHA256, treeHash(before));
  assert.deepEqual(receipt.OVERLAY_FILES.split(','), [...fixed, ...assets]);
  assert.deepEqual(detail.replaced, [...fixed, 'admin/assets/style-AbC12345.css']);
  assert.deepEqual(detail.added, assets.filter(name => !before.has(name)));
  const after = outputTree(instance, receipt.SITE_ARCHIVE);
  const changed = sorted([...after.keys()].filter(name => !before.has(name) || !before.get(name).equals(after.get(name))));
  assert.deepEqual(changed, sorted([...fixed, ...assets]));
  for (const [name, bytes] of before) if (![...fixed, ...assets].includes(name)) assert.ok(bytes.equals(after.get(name)), name);
  for (const name of [...fixed, ...assets]) assert.ok(after.get(name).equals(fs.readFileSync(path.join(instance.source, name))), name);
  assert.equal(after.has('admin/assets/unused-SpArE123.js'), false);
  assert.equal(after.has('admin/assets/ghost-AbCd1234.js'), false);
  assert.equal(after.has('admin/assets/not-real-AbCd1234.js'), false);
  assert.equal(receipt.SITE_TREE_SHA256, treeHash(after));
  assert.equal(receipt.SITE_ARCHIVE_SHA256, hash(fs.readFileSync(receipt.SITE_ARCHIVE)));
  assert.equal(Number(receipt.SITE_ARCHIVE_BYTES), fs.statSync(receipt.SITE_ARCHIVE).size);
  assert.ok(Number(receipt.SITE_ARCHIVE_BYTES) <= 20 * 1024 * 1024);
  for (const entry of detail.files) {
    assert.equal(entry.afterSha256, hash(after.get(entry.path)));
    assert.equal(entry.beforeSha256, before.has(entry.path) ? hash(before.get(entry.path)) : null);
  }
});

test('all existing profiles retain their exact overlay whitelist and outside bytes', () => {
  const profiles = [
    [null, ['index.html', 'app.js', 'styles.css', 'install.html', 'checkout.html', 'checkout.js', 'support.html', 'support.js']],
    ['--community-preview', ['community-preview.js', 'creator-community.css']],
    ['--community-ui', ['community-preview.js', 'community.js', 'install.html', 'creator-guide.html']],
    ['--community-cache', ['community.html', 'community.js']]
  ];
  for (const [profile, whitelist] of profiles) {
    const instance = fixture(), before = files(instance.baseTree);
    const result = instance.invoke(profile); assert.equal(result.status, 0, result.stderr);
    const receipt = parseReceipt(result.stdout); assert.deepEqual(receipt.OVERLAY_FILES.split(','), whitelist);
    const after = outputTree(instance, receipt.SITE_ARCHIVE);
    for (const [name, bytes] of before) assert.ok(after.get(name).equals(whitelist.includes(name)
      ? fs.readFileSync(path.join(instance.source, name)) : bytes), profile + ':' + name);
    assert.deepEqual(sorted([...after.keys()]), sorted([...before.keys()]));
  }
});

test('missing fixed source file is rejected without publishing', () => {
  const instance = fixture(); fs.unlinkSync(path.join(instance.source, 'install.html')); refused(instance, /ENOENT|missing/u);
});
test('missing referenced source JS is rejected rather than copied from old assets', () => {
  const instance = fixture(); fs.unlinkSync(path.join(instance.source, assets[1])); refused(instance, /ENOENT|missing/u);
});
test('missing fixed base entry is rejected even when source has the entry', () => {
  const instance = fixture(); fs.unlinkSync(path.join(instance.baseTree, 'admin/index.html')); instance.packBase(); refused(instance, /missing from base/u);
});
test('missing base archive is rejected without any source-only fallback', () => {
  const instance = fixture(); fs.unlinkSync(instance.base); refused(instance, /ENOENT/u);
});
test('incorrect archive digest is rejected before extraction', () => {
  const instance = fixture(); fs.writeFileSync(instance.base + '.sha256', `${'0'.repeat(64)}  ${path.basename(instance.base)}\n`);
  refused(instance, /SHA256 mismatch/u);
});
test('correct archive digest with wrong immutable tree identity is rejected', () => {
  const instance = fixture(), original = instance.base;
  instance.base = path.join(instance.out, `gongde-site-${'0'.repeat(64)}.tar.gz`);
  fs.copyFileSync(original, instance.base);
  fs.writeFileSync(instance.base + '.sha256', `${hash(fs.readFileSync(instance.base))}  ${path.basename(instance.base)}\n`);
  refused(instance, /tree does not match/u);
});
test('illegal admin asset URLs, nonhashed names, extensions and duplicate references are rejected', () => {
  const urls = ['../assets/index-QwErTy12.js', '/admin/assets/../index-QwErTy12.js', '/admin/assets/%2e%2e/x-AbCd1234.js',
    '//outside.invalid/index-QwErTy12.js', 'https://outside.invalid/index-QwErTy12.js', '/admin/assets/index.js',
    '/admin/assets/index-QwErTy12.js?new=1', '/admin/assets/index-QwErTy12.js#fragment', '/admin/assets/index-QwErTy12.css',
    '/admin/assets/sub/index-QwErTy12.js', '/assets/index-QwErTy12.js'];
  for (const url of urls) {
    const instance = fixture(); write(instance.source, 'admin/index.html', `<script src="${url}"></script>`);
    refused(instance, /illegal admin asset/u);
  }
  const instance = fixture(); write(instance.source, 'admin/index.html', '<script src="/admin/assets/index-QwErTy12.js" src="../bad.js"></script>');
  refused(instance, /duplicate admin HTML attribute/u);
});
test('symbolic-link source file and asset directory are rejected without following them', () => {
  const file = fixture(); fs.unlinkSync(path.join(file.source, 'app.js'));
  write(file.directory, 'outside.js', 'outside fixture sentinel'); fs.symlinkSync(path.join(file.directory, 'outside.js'), path.join(file.source, 'app.js'));
  refused(file, /symbolic/u);
  assert.equal(fs.readFileSync(path.join(file.directory, 'outside.js'), 'utf8'), 'outside fixture sentinel');
  const directory = fixture(), original = path.join(directory.source, 'admin/assets');
  fs.renameSync(original, path.join(directory.directory, 'outside-assets'));
  fs.symlinkSync(path.join(directory.directory, 'outside-assets'), original); refused(directory, /symbolic/u);
});
test('symbolic-link base archive and checksum are rejected', () => {
  for (const suffix of ['', '.sha256']) {
    const instance = fixture(), original = instance.base + suffix, destination = original + '.outside';
    fs.renameSync(original, destination); fs.symlinkSync(destination, original);
    const result = instance.invoke(); assert.notEqual(result.status, 0); assert.match(result.stderr, /symbolic/u);
    assert.ok(fs.lstatSync(original).isSymbolicLink());
  }
});
test('archive path escape, symbolic links, hard links and special entries are rejected before materialization', () => {
  for (const [name, type, link] of [['../escape.txt', '0', ''], ['/absolute.txt', '0', ''],
    ['symlink', '2', '../outside'], ['hardlink', '1', 'index.html'], ['device', '3', '']]) {
    const instance = fixture(); maliciousBase(instance, tarEntry(name, type, Buffer.alloc(0), link));
    refused(instance, /unsafe archive path|escape|non-regular|symbolic/u);
    assert.equal(fs.existsSync(path.join(instance.directory, 'escape.txt')), false);
  }
});
test('an existing immutable output is never overwritten by a repeat invocation', () => {
  const instance = fixture(), first = instance.invoke(); assert.equal(first.status, 0, first.stderr);
  const receipt = parseReceipt(first.stdout), archive = fs.readFileSync(receipt.SITE_ARCHIVE), checksum = fs.readFileSync(receipt.SITE_ARCHIVE + '.sha256');
  refused(instance, /already exists/u);
  assert.ok(fs.readFileSync(receipt.SITE_ARCHIVE).equals(archive)); assert.ok(fs.readFileSync(receipt.SITE_ARCHIVE + '.sha256').equals(checksum));
});
test('output over 20MiB is rejected before archive or checksum publication', () => {
  const instance = fixture(); write(instance.source, 'app.js', randomBytes(20 * 1024 * 1024 + 65536));
  refused(instance, /20MiB/u);
});
test('base over 20MiB is rejected before decompression', () => {
  const instance = fixture(); fs.writeFileSync(instance.base, Buffer.alloc(20 * 1024 * 1024 + 1));
  fs.writeFileSync(instance.base + '.sha256', `${hash(fs.readFileSync(instance.base))}  ${path.basename(instance.base)}\n`);
  refused(instance, /base archive exceeds/u);
});
