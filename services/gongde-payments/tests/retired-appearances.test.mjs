import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm, readdir } from 'node:fs/promises';
import { generateKeyPairSync } from 'node:crypto';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
const built = name => process.env.GONGDE_TEST_BUILD_ROOT
  ? pathToFileURL(resolve(process.env.GONGDE_TEST_BUILD_ROOT, name)) : new URL(`../dist/${name}`, import.meta.url);
const { AppearancePackSigner } = await import(built('delivery/pack-signer.js'));
const { RETIRED_OFFICIAL_ASSET_IDS } = await import(built('domain/catalog.js'));
const project = resolve(import.meta.dirname, '../../..');

test('retired source bytes remain signable for history but never enter the current library', async () => {
  const scratch = await mkdtemp(join(tmpdir(), 'gongde-retirement-'));
  try {
    const key = generateKeyPairSync('ec', { namedCurve: 'prime256v1' }).privateKey;
    const privateKeyFile = join(scratch, 'test-key.pem');
    await writeFile(privateKeyFile, key.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 });
    const signer = new AppearancePackSigner({ assetRoot: join(project, 'assets/appearance-packs'), privateKeyFile });
    const revisions = signer.revisions();
    const current = signer.officialCatalog();
    assert.equal(RETIRED_OFFICIAL_ASSET_IDS.size, 10);
    assert.equal(Object.keys(current).length, 11);
    for (const id of RETIRED_OFFICIAL_ASSET_IDS) {
      assert.equal(current[id], undefined, id);
      assert.match(revisions[id], /^[0-9a-f]{64}$/);
      const pack = signer.build({ assetId: id, downloadId: 'history_fixture_0123456789abcdef', issuedAt: new Date('2026-10-01T00:00:00Z'), expiresAt: new Date('2026-10-02T00:00:00Z'), licenseMode: 'perpetual' });
      assert.ok(pack.content.length > 100, id);
    }
    assert.ok(current['official.wealth-button']);
    assert.ok(current['official.offwork-button']);
    assert.equal((await readdir(join(project, 'assets/appearance-packs'))).length, 12); // eleven extensions and woodfish sample
  } finally { await rm(scratch, { recursive: true, force: true }); }
});
