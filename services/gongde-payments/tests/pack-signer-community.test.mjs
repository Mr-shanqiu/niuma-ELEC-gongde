import assert from "node:assert/strict";
import { createHash, createVerify, generateKeyPairSync, randomBytes } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import test from "node:test";
import { unzipSync, zipSync } from "fflate";

const buildRoot = process.env.GONGDE_TEST_BUILD_ROOT;
const builtFile = (path) => buildRoot
  ? pathToFileURL(resolve(buildRoot, path))
  : new URL(`../dist/${path}`, import.meta.url);
const [{ AppearancePackSigner }, { validateCreatorSourcePack }] = await Promise.all([
  import(builtFile("delivery/pack-signer.js")),
  import(builtFile("creators/pack-validation.js"))
]);

const ASSET_ROOT = fileURLToPath(new URL("../../../assets/appearance-packs/", import.meta.url));
const TEST_IMAGE_A = await readFile(join(ASSET_ROOT, "chick-pecking", "body.png"));
const TEST_IMAGE_B = await readFile(join(ASSET_ROOT, "chick-pecking", "head.png"));

function imageHash(files) {
  const hash = createHash("sha256");
  for (const name of [...files.keys()].sort()) {
    const data = files.get(name);
    const length = Buffer.alloc(8);
    length.writeBigUInt64BE(BigInt(data.length));
    hash.update(name, "utf8");
    hash.update(Buffer.from([0]));
    hash.update(length);
    hash.update(data);
  }
  return hash.digest("hex");
}

function verifyLicense(manifest, publicKey) {
  const license = manifest.license;
  const message = Buffer.from(
    `NIUMA-PACK-LICENSE-V1\n${manifest.id}\n${manifest.version}\n${license.issued_at}\n${license.import_before}\n${license.download_id}\n${license.content_sha256}`,
    "utf8"
  );
  const verifier = createVerify("SHA256");
  verifier.update(message);
  verifier.end();
  return verifier.verify({ key: publicKey, dsaEncoding: "ieee-p1363" }, Buffer.from(license.signature, "hex"));
}

async function temporarySigner(t, assetRootOverride) {
  const root = await mkdtemp(join(tmpdir(), "gongde-community-pack-signer-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const assetRoot = join(root, "assets");
  const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const privateKeyFile = join(root, "test-private.pem");
  await writeFile(privateKeyFile, privateKey.export({ type: "pkcs8", format: "pem" }));
  return {
    root,
    assetRoot,
    signer: new AppearancePackSigner({ assetRoot: assetRootOverride ?? assetRoot, privateKeyFile }),
    publicKey
  };
}

async function sourcePack(root, schemaVersion) {
  const creatorId = randomBytes(16).toString("hex");
  const slug = schemaVersion === 1 ? "amber-one" : "green-three";
  const id = `creator.${creatorId}.${slug}`;
  const manifest = {
    schema_version: schemaVersion,
    id,
    version: "1.0.0",
    name_zh: "本地签名验收形象",
    name_en: "Local Signature Acceptance",
    author: "Local Test Creator",
    publisher: "community",
    review_id: "pending",
    canvas_width: 240,
    canvas_height: 250,
    preview: "preview.png",
    plus_y: 174,
    layers: [{
      image: "body.png",
      frame: [0, 0, 1, 1],
      anchor: [0.5, 0.5],
      ...(schemaVersion === 3 ? { interpolation: "linear" } : {}),
      keyframes: [{
        t: 0, x: 0, y: 0, rotation: 0, scale: 1, alpha: 1,
        ...(schemaVersion === 3 ? { scale_y: 1 } : {})
      }]
    }]
  };
  const archive = Buffer.from(zipSync({
    "manifest.json": Buffer.from(`${JSON.stringify(manifest)}\n`, "utf8"),
    "preview.png": TEST_IMAGE_A,
    "body.png": TEST_IMAGE_A
  }, { level: 0, mtime: new Date("2020-01-01T00:00:00.000Z") }));
  const validated = validateCreatorSourcePack(archive, { creatorId, slug });
  return { archive, creatorId, slug, id, validated };
}

for (const schemaVersion of [1, 3]) {
  test(`community schema ${schemaVersion} source becomes an existing-client licensed package`, async (t) => {
    const { root, signer, publicKey } = await temporarySigner(t);
    const source = await sourcePack(root, schemaVersion);
    const issuedAt = new Date("2026-10-07T00:00:00.000Z");
    const expiresAt = new Date(issuedAt.getTime() + 86_400_000);
    const reviewId = randomBytes(16).toString("hex");
    const result = signer.buildCommunity({
      archive: source.archive,
      creatorId: source.creatorId,
      slug: source.slug,
      reviewId,
      revision: source.validated.revision,
      archiveSha256: source.validated.archiveSha256,
      downloadId: randomBytes(16).toString("hex"),
      issuedAt,
      expiresAt
    });

    assert.match(result.filename, /^community-[A-Za-z0-9_-]+\.nmgpack$/u);
    assert.equal(result.importBefore, expiresAt.toISOString());
    const files = new Map(Object.entries(unzipSync(result.content))
      .map(([name, bytes]) => [name, Buffer.from(bytes)]));
    const manifest = JSON.parse(files.get("manifest.json").toString("utf8"));
    assert.equal(manifest.schema_version, schemaVersion === 1 ? 2 : 3);
    assert.equal(manifest.id, source.id);
    assert.equal(manifest.publisher, "community");
    assert.equal(manifest.review_id, reviewId);
    assert.equal(manifest.license.mode, "timed");
    assert.equal(manifest.license.import_before - manifest.license.issued_at, 86_400);
    const deliveredImages = new Map([...files].filter(([name]) => name !== "manifest.json"));
    assert.equal(manifest.license.content_sha256, imageHash(deliveredImages));
    assert.match(manifest.license.signature, /^[0-9a-f]{128}$/u);
    assert.equal(verifyLicense(manifest, publicKey), true);

    const modifiedImages = new Map(deliveredImages);
    const changedBody = Buffer.from(TEST_IMAGE_B);
    modifiedImages.set("body.png", changedBody);
    assert.notEqual(imageHash(modifiedImages), manifest.license.content_sha256);
    const alteredDeliveryAccepted = imageHash(modifiedImages) === manifest.license.content_sha256 &&
      verifyLicense(manifest, publicKey);
    assert.equal(alteredDeliveryAccepted, false,
      "client-side content-hash comparison must reject altered image bytes before trusting the valid old signature");

    const originalSourceFiles = unzipSync(source.archive);
    const changedArchive = Buffer.from(zipSync(Object.fromEntries(
      Object.entries(originalSourceFiles).map(([name, bytes]) => [name, name === "body.png" ? changedBody : bytes])
    ), { level: 0, mtime: new Date("2020-01-01T00:00:00.000Z") }));
    assert.throws(() => signer.buildCommunity({
      archive: changedArchive,
      creatorId: source.creatorId,
      slug: source.slug,
      reviewId,
      revision: source.validated.revision,
      archiveSha256: source.validated.archiveSha256,
      downloadId: randomBytes(16).toString("hex"),
      issuedAt,
      expiresAt
    }), /pack_community_source_revision_mismatch/u);

    assert.throws(() => signer.buildCommunity({
      archive: source.archive,
      creatorId: source.creatorId,
      slug: source.slug,
      reviewId,
      revision: source.validated.revision,
      archiveSha256: source.validated.archiveSha256,
      downloadId: randomBytes(16).toString("hex"),
      issuedAt,
      expiresAt: new Date(issuedAt.getTime() + 86_401_000)
    }), /pack_import_window_invalid/u);
  });
}

test("official snapshot reports source version/revision and bounds the largest signed ZIP", async (t) => {
  const { signer } = await temporarySigner(t, ASSET_ROOT);
  const snapshot = signer.officialSnapshot("official.chick-pecking");
  assert.equal(typeof snapshot.versionLabel, "string");
  assert.ok(snapshot.versionLabel.length > 0);
  assert.equal(snapshot.sourceRevision, signer.revisions()["official.chick-pecking"]);
  const actual = signer.build({
    assetId: "official.chick-pecking",
    downloadId: "A".repeat(128),
    issuedAt: new Date("2099-12-31T23:59:59.000Z"),
    expiresAt: new Date("2100-01-01T00:00:00.000Z")
  });
  assert.ok(actual.content.byteLength <= snapshot.deliveryBytesUpperBound);
  assert.ok(snapshot.deliveryBytesUpperBound > 0);
});
