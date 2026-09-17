import assert from "node:assert/strict";
import { createVerify, generateKeyPairSync } from "node:crypto";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { unzipSync } from "fflate";

import { AppearancePackSigner } from "../dist/delivery/pack-signer.js";

const ONE_PIXEL_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  "base64"
);

test("P-256 signer builds a schema-2 pack with an exact 24-hour offline-import license", async () => {
  const root = await mkdtemp(join(tmpdir(), "gongde-pack-"));
  const assetRoot = join(root, "assets");
  const source = join(assetRoot, "chick-pecking");
  await mkdir(source, { recursive: true });
  const manifest = {
    schema_version: 1,
    id: "official.chick-pecking",
    version: "1.0.0",
    name_zh: "小鸡啄米",
    name_en: "Pecking Chick",
    author: "NiuMa Merit",
    publisher: "NiuMa Merit",
    review_id: "test-review",
    canvas_width: 240,
    canvas_height: 250,
    preview: "preview.png",
    plus_y: 174,
    layers: [{ image: "body.png", frame: [0, 0, 1, 1], anchor: [0.5, 0.5], keyframes: [{ t: 0, x: 0, y: 0, rotation: 0, scale: 1, alpha: 1 }] }]
  };
  await writeFile(join(source, "manifest.json"), JSON.stringify(manifest));
  await writeFile(join(source, "preview.png"), ONE_PIXEL_PNG);
  await writeFile(join(source, "body.png"), ONE_PIXEL_PNG);
  const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const privateKeyFile = join(root, "private.pem");
  await writeFile(privateKeyFile, privateKey.export({ type: "pkcs8", format: "pem" }));
  const signer = new AppearancePackSigner({ assetRoot, privateKeyFile });
  const issuedAt = new Date("2026-09-17T00:00:00.000Z");
  const expiresAt = new Date("2026-09-18T00:00:00.000Z");
  const pack = signer.build({
    assetId: "official.chick-pecking",
    downloadId: "ent_0123456789abcdef01234567",
    issuedAt,
    expiresAt
  });
  const files = unzipSync(pack.content);
  const signed = JSON.parse(Buffer.from(files["manifest.json"]).toString("utf8"));
  assert.equal(signed.schema_version, 2);
  assert.equal(signed.license.import_before - signed.license.issued_at, 86400);
  assert.equal(signed.license.download_id, "ent_0123456789abcdef01234567");
  assert.match(signed.license.signature, /^[0-9a-f]{128}$/u);
  const message = Buffer.from(
    `NIUMA-PACK-LICENSE-V1\n${signed.id}\n${signed.version}\n${signed.license.issued_at}\n${signed.license.import_before}\n${signed.license.download_id}\n${signed.license.content_sha256}`
  );
  const verifier = createVerify("SHA256");
  verifier.update(message);
  verifier.end();
  assert.equal(verifier.verify({ key: publicKey, dsaEncoding: "ieee-p1363" }, Buffer.from(signed.license.signature, "hex")), true);
});
