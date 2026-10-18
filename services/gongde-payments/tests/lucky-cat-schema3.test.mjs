import assert from 'node:assert/strict';
import { generateKeyPairSync, verify } from 'node:crypto';
import { cp, mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { unzipSync } from 'fflate';
import { AppearancePackSigner } from '../dist/delivery/pack-signer.js';

test('schema3 signed delivery preserves native lucky-cat geometry and animation', async () => {
  const root = await mkdtemp(join(tmpdir(), 'gongde-cat-schema3-'));
  try {
    const assetRoot = join(root, 'assets');
    await mkdir(assetRoot);
    const source = new URL('../../../assets/appearance-packs/lucky-cat/', import.meta.url);
    await cp(source, join(assetRoot, 'lucky-cat'), { recursive: true });
    const original = JSON.parse(await readFile(new URL('manifest.json', source), 'utf8'));
    const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
    const privateKeyFile = join(root, 'test-key.pem');
    await writeFile(privateKeyFile, privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 });
    const signer = new AppearancePackSigner({ assetRoot, privateKeyFile });
    const result = signer.build({ assetId: original.id,
      downloadId: 'test_lucky_cat_0123456789',
      issuedAt: new Date('2026-09-23T00:00:00Z'),
      expiresAt: new Date('2026-09-24T00:00:00Z') });
    const files = unzipSync(result.content);
    const manifest = JSON.parse(Buffer.from(files['manifest.json']).toString());
    assert.equal(manifest.schema_version, 3);
    assert.deepEqual(manifest.layers, original.layers);
    assert.equal(manifest.license.import_before - manifest.license.issued_at, 86400);
    for (const name of ['body.png', 'paw.png', 'preview.png'])
      assert.deepEqual(Buffer.from(files[name]), await readFile(new URL(name, source)));
    const l = manifest.license;
    const message = Buffer.from(`NIUMA-PACK-LICENSE-V1\n${manifest.id}\n${manifest.version}\n${l.issued_at}\n${l.import_before}\n${l.download_id}\n${l.content_sha256}`);
    assert.equal(verify('sha256', message, { key: publicKey, dsaEncoding: 'ieee-p1363' }, Buffer.from(l.signature, 'hex')), true);
  } finally { await rm(root, { recursive: true, force: true }); }
});
