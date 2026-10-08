#!/usr/bin/env node
// Offline fixture preparation only. No environment loading, HTTP, SQL, COS or credentials.
// Use --local-fixture for isolated validation, or --creator-id <actual issued ID>.
import { randomBytes, createHash } from 'node:crypto';
import { mkdtemp, writeFile, chmod } from 'node:fs/promises';
import { zipSync, zlibSync } from 'fflate';
import { validateCreatorSourcePack } from '../dist/creators/pack-validation.js';
import { CreatorError } from '../dist/creators/types.js';

const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const args = process.argv.slice(2);
const local = args.length === 1 && args[0] === '--local-fixture';
const supplied = args.length === 2 && args[0] === '--creator-id' && /^[a-f0-9]{32}$/u.test(args[1]);
if (!local && !supplied) {
  process.stderr.write('Use --local-fixture or --creator-id <32 lowercase hex characters>.\n');
  process.exit(64);
}
const creatorId = local ? randomBytes(16).toString('hex') : args[1];
const table = Uint32Array.from({ length: 256 }, (_, byte) => {
  let value = byte;
  for (let bit = 0; bit < 8; bit += 1) value = (value >>> 1) ^ ((value & 1) ? 0xedb88320 : 0);
  return value >>> 0;
});
function chunk(type, bytes) {
  const output = Buffer.alloc(bytes.length + 12);
  output.writeUInt32BE(bytes.length); output.write(type, 4, 4, 'ascii'); bytes.copy(output, 8);
  let crc = 0xffffffff;
  for (const byte of output.subarray(4, output.length - 4)) crc = (crc >>> 8) ^ table[(crc ^ byte) & 255];
  output.writeUInt32BE((crc ^ 0xffffffff) >>> 0, output.length - 4);
  return output;
}
function image(rgb) {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(64, 0); header.writeUInt32BE(64, 4); header[8] = 8; header[9] = 6;
  const pixels = Buffer.alloc(64 * (1 + 64 * 4));
  for (let y = 0; y < 64; y += 1) {
    for (let x = 0; x < 64; x += 1) {
      const at = y * 257 + 1 + x * 4;
      const visible = (x - 32) ** 2 + (y - 32) ** 2 <= 26 ** 2;
      for (let channel = 0; channel < 3; channel += 1) pixels[at + channel] = visible ? rgb[channel] : 0;
      pixels[at + 3] = visible ? 255 : 0;
    }
  }
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', header),
    chunk('IDAT', Buffer.from(zlibSync(pixels))), chunk('IEND', Buffer.alloc(0))]);
}
const encode = files => Buffer.from(zipSync(files, { level: 6, mtime: new Date('2020-01-01T00:00:00Z') }));
function source(slug, version, schema, rgb) {
  const png = image(rgb);
  const layer = { image: 'sample.png', frame: [88, 48, 64, 64], anchor: [0.5, 0.5],
    keyframes: [0, 0.5, 1].map(t => ({ t, x: 0, y: t === 0.5 ? 3 : 0,
      rotation: t === 0.5 ? 2 : 0, scale: 1, alpha: 1, ...(schema === 3 ? { scale_y: 1 } : {}) })),
    ...(schema === 3 ? { interpolation: 'smoothstep' } : {}) };
  const manifest = { schema_version: schema, id: `creator.${creatorId}.${slug}`, version,
    name_zh: '\u5b98\u65b9\u9a8c\u6536\u6d4b\u8bd5-' + slug,
    name_en: 'Official acceptance test - ' + slug, author: 'Official acceptance test',
    publisher: 'community', review_id: 'pending', canvas_width: 240, canvas_height: 250,
    preview: 'sample.png', plus_y: 174, layers: [layer] };
  const files = { 'manifest.json': Buffer.from(JSON.stringify(manifest)), 'sample.png': png };
  return { slug, manifest, png, files, archive: encode(files), centerRgba: [...rgb, 255] };
}

try {
  const directory = await mkdtemp('/private/tmp/gongde-creator-acceptance-packs-20261004-');
  await chmod(directory, 0o700);
  const specifications = [
    ['accept-amber', '1.0.0', 1, [213, 103, 56], 'amber-release'],
    ['accept-amber', '1.1.0', 1, [173, 173, 173], 'amber-review-reject'],
    ['accept-amber', '1.2.0', 3, [230, 146, 56], 'amber-update'],
    ['accept-green', '1.0.0', 3, [58, 107, 82], 'green-release']
  ];
  const valid = [];
  let base;
  for (const [slug, version, schema, rgb, name] of specifications) {
    const fixture = source(slug, version, schema, rgb);
    const accepted = validateCreatorSourcePack(fixture.archive, { creatorId, slug });
    if (accepted.manifest.id !== fixture.manifest.id || accepted.manifest.version !== version) throw new Error('identity_mismatch');
    const path = `${directory}/${name}.nmgpack`;
    await writeFile(path, fixture.archive, { mode: 0o600 });
    valid.push({ path, workId: fixture.manifest.id, version, schema, bytes: fixture.archive.length,
      archiveSha256: digest(fixture.archive), revision: accepted.revision, pngSha256: digest(fixture.png),
      previewPixels: { width: 64, height: 64, centerRgba: fixture.centerRgba, cornerRgba: [0, 0, 0, 0] } });
    base ??= fixture;
  }
  const wrongId = { ...base.manifest, id: 'woodfish' };
  const negatives = [
    ['path-traversal', encode({ 'manifest.json': base.files['manifest.json'], '../sample.png': base.png })],
    ['hidden-trailing-data', Buffer.concat([base.archive, Buffer.from('UNDECLARED-TAIL')])],
    ['reserved-official-identity', encode({ 'manifest.json': Buffer.from(JSON.stringify(wrongId)), 'sample.png': base.png })]
  ];
  const rejected = [];
  for (const [name, archive] of negatives) {
    let code;
    try { validateCreatorSourcePack(archive, { creatorId, slug: base.slug }); }
    catch (error) { if (!(error instanceof CreatorError)) throw error; code = error.code; }
    if (!code) throw new Error('unsafe_fixture_accepted');
    const path = `${directory}/negative-${name}.nmgpack`;
    await writeFile(path, archive, { mode: 0o600 });
    rejected.push({ path, mutation: name, bytes: archive.length, archiveSha256: digest(archive), rejection: code });
  }
  const receipt = { schema: 'gongde-creator-acceptance-packs.v1', at: new Date().toISOString(), creatorId,
    localFixtureIdentity: local, scope: 'Offline guide-conformant source validation only; no HTTP, account, provider, review, native or publication claim',
    valid, rejected };
  const path = directory + '/receipt.json';
  await writeFile(path, JSON.stringify(receipt, null, 2) + '\n', { mode: 0o600 });
  process.stdout.write(JSON.stringify({ receipt: path, creatorId, localFixtureIdentity: local,
    valid: valid.length, rejected: rejected.length, directory }) + '\n');
} catch (error) {
  const code = error instanceof CreatorError ? error.code : 'acceptance_preparation_failed';
  process.stderr.write(JSON.stringify({ error: code }) + '\n'); process.exitCode = 1;
}
