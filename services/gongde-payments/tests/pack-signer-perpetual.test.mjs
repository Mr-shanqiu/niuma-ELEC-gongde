import assert from "node:assert/strict";
import { createHash, createPublicKey, generateKeyPairSync, sign, verify } from "node:crypto";
import { cp, mkdtemp, mkdir, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { unzipSync, zipSync } from "fflate";

const project = fileURLToPath(new URL("../../../", import.meta.url));
const built = (name) => process.env.GONGDE_TEST_BUILD_ROOT
  ? pathToFileURL(resolve(process.env.GONGDE_TEST_BUILD_ROOT, name))
  : new URL(`../dist/${name}`, import.meta.url);
const { AppearancePackSigner } = await import(built("delivery/pack-signer.js"));
const { validateCreatorSourcePack } = await import(built("creators/pack-validation.js"));
const assetRoot = join(project, "assets/appearance-packs");
const sourcePNG = await readFile(join(assetRoot, "chick-pecking/body.png"));

// Independent protocol oracle: LF separators, no BOM and no trailing LF.
function message(manifest) {
  const l = manifest.license;
  return Buffer.from(l.mode === "perpetual"
    ? ["NIUMA-PACK-LICENSE-V2", "perpetual", manifest.id, manifest.version,
      l.issued_at, l.download_id, l.content_sha256].join("\n")
    : ["NIUMA-PACK-LICENSE-V1", manifest.id, manifest.version,
      l.issued_at, l.import_before, l.download_id, l.content_sha256].join("\n"));
}
function imageHash(files) {
  const hash = createHash("sha256");
  for (const name of Object.keys(files).filter((name) => name !== "manifest.json").sort()) {
    const length = Buffer.alloc(8);
    length.writeBigUInt64BE(BigInt(files[name].length));
    hash.update(name).update(Buffer.from([0])).update(length).update(files[name]);
  }
  return hash.digest("hex");
}
function decode(content) {
  const files = unzipSync(content);
  return { files, manifest: JSON.parse(Buffer.from(files["manifest.json"]).toString()) };
}
function encode(files, manifest) {
  return Buffer.from(zipSync({ ...files, "manifest.json": Buffer.from(JSON.stringify(manifest)) },
    { level: 0, mtime: new Date("2020-01-01T00:00:00Z") }));
}
function check(result, publicKey, schema, mode) {
  const { manifest, files } = decode(result.content);
  assert.equal(manifest.schema_version, schema);
  assert.equal(manifest.license.mode, mode);
  assert.deepEqual(Object.keys(manifest.license).sort(), (mode === "perpetual"
    ? ["mode", "issued_at", "download_id", "content_sha256", "signature"]
    : ["mode", "issued_at", "import_before", "download_id", "content_sha256", "signature"]).sort());
  assert.equal(manifest.license.content_sha256, imageHash(files));
  assert.equal(verify("sha256", message(manifest), { key: publicKey, dsaEncoding: "ieee-p1363" },
    Buffer.from(manifest.license.signature, "hex")), true);
  assert.equal(result.importBefore, mode === "perpetual" ? null : "2020-01-02T00:00:00.000Z");
  return { manifest, files };
}
async function fixture(t) {
  const parent = join(project, ".local-work/acceptance/perpetual-license");
  await mkdir(parent, { recursive: true });
  const root = await mkdtemp(join(parent, "fixtures-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const keys = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const privateKeyFile = join(root, "ephemeral-test-key.pem");
  await writeFile(privateKeyFile, keys.privateKey.export({ type: "pkcs8", format: "pem" }), { mode: 0o600 });
  return { root, ...keys, privateKeyFile,
    signer: new AppearancePackSigner({ assetRoot, privateKeyFile }) };
}
function communitySource(schema) {
  const creatorId = "a".repeat(32), slug = `protocol-${schema}`;
  const manifest = {
    schema_version: schema, id: `creator.${creatorId}.${slug}`, version: "1.0.0",
    name_zh: "Protocol fixture", name_en: "Protocol fixture", author: "Test Creator",
    publisher: "community", review_id: "pending", canvas_width: 240, canvas_height: 250,
    preview: "preview.png", plus_y: 174,
    layers: [{ image: "body.png", frame: [0, 0, 1, 1], anchor: [0.5, 0.5],
      ...(schema === 3 ? { interpolation: "linear" } : {}),
      keyframes: [{ t: 0, x: 0, y: 0, rotation: 0, scale: 1, alpha: 1,
        ...(schema === 3 ? { scale_y: 1 } : {}) }] }]
  };
  const archive = encode({ "preview.png": sourcePNG, "body.png": sourcePNG }, manifest);
  const validated = validateCreatorSourcePack(archive, { creatorId, slug });
  return { archive, creatorId, slug, reviewId: "b".repeat(32),
    revision: validated.revision, archiveSha256: validated.archiveSha256 };
}
const times = { issuedAt: new Date("2020-01-01T00:00:00Z"),
  expiresAt: new Date("2020-01-02T00:00:00Z"), downloadId: "protocol_0123456789abcdef" };
function run(command, args, options = {}) {
  const result = spawnSync(command, args, { cwd: project, encoding: "utf8", timeout: 60_000, ...options });
  assert.equal(result.status, 0, `${command} failed: ${result.error ?? ""}\n${result.stdout}\n${result.stderr}`);
  return result.stdout;
}

test("official V2 has exactly five fields and cannot be downgraded or reinterpreted as V1", async (t) => {
  const { signer, publicKey } = await fixture(t);
  const input = { assetId: "official.chick-pecking", ...times, licenseMode: "perpetual" };
  const result = signer.build({ ...input, expiresAt: undefined });
  const { manifest } = check(result, publicKey, 2, "perpetual");
  for (const field of ["id", "version"]) {
    const changed = structuredClone(manifest);
    changed[field] += "-tampered";
    assert.equal(verify("sha256", message(changed), { key: publicKey, dsaEncoding: "ieee-p1363" },
      Buffer.from(changed.license.signature, "hex")), false);
  }
  const changed = structuredClone(manifest);
  changed.license.mode = "timed";
  changed.license.import_before = changed.license.issued_at + 86400;
  assert.equal(verify("sha256", message(changed), { key: publicKey, dsaEncoding: "ieee-p1363" },
    Buffer.from(changed.license.signature, "hex")), false);
  check(signer.build({ ...input, licenseMode: undefined }), publicKey, 2, "timed");
  check(signer.build({ ...input, licenseMode: "timed" }), publicKey, 2, "timed");
  for (const licenseMode of ["unknown", "", "V2"]) {
    assert.throws(() => signer.build({ ...input, licenseMode }), /pack_license_mode_invalid/);
  }
  for (const issuedAt of [new Date(NaN), new Date("2019-12-31"), new Date("2101-01-01")]) {
    assert.throws(() => signer.build({ ...input, issuedAt }), /pack_import_window_invalid/);
  }
  assert.throws(() => signer.build({ ...input, downloadId: "contains\nnewline123" }), /pack_download_id_invalid/);
  assert.throws(() => signer.build({ ...input, assetId: "unregistered.pack" }), /pack_asset_not_registered/);
  assert.throws(() => signer.build({ ...input, licenseMode: "timed", expiresAt: undefined }), /pack_import_window_invalid/);
});

for (const schema of [1, 3]) test(`community schema ${schema} V2 retains source authorization gates and legacy V1`, async (t) => {
  const { signer, publicKey } = await fixture(t);
  const source = communitySource(schema);
  const input = { ...source, ...times, licenseMode: "perpetual" };
  check(signer.buildCommunity({ ...input, expiresAt: undefined }), publicKey, schema === 1 ? 2 : 3, "perpetual");
  check(signer.buildCommunity({ ...input, licenseMode: undefined }), publicKey, schema === 1 ? 2 : 3, "timed");
  assert.throws(() => signer.buildCommunity({ ...input, revision: "0".repeat(64) }), /revision_mismatch/);
  assert.throws(() => signer.buildCommunity({ ...input, archiveSha256: "0".repeat(64) }), /revision_mismatch/);
  assert.throws(() => signer.buildCommunity({ ...input, reviewId: "pending" }), /review_id_invalid/);
  assert.throws(() => signer.buildCommunity({ ...input, licenseMode: "unknown" }), /license_mode_invalid/);
  const files = unzipSync(source.archive);
  const manifest = JSON.parse(Buffer.from(files["manifest.json"]).toString());
  manifest.license = { mode: "perpetual" };
  assert.throws(() => signer.buildCommunity({ ...input, archive: encode(files, manifest) }));
});

test("internal officialCatalog clones real manifests and exactly budgets the largest perpetual stored ZIP", async (t) => {
  const { signer, publicKey } = await fixture(t);
  assert.equal(signer.sourceRoot(), await realpath(assetRoot));
  const catalog = signer.officialCatalog();
  assert.deepEqual(Object.keys(catalog).sort(), Object.keys(signer.revisions()).sort());
  assert.ok(Object.keys(catalog).length > 0);
  for (const [assetId, entry] of Object.entries(catalog)) {
    assert.deepEqual(Object.keys(entry).sort(),
      ["manifest", "version", "revision", "deliveryBytesUpperBound", "previewDirectory"].sort());
    assert.match(entry.previewDirectory, /^[a-z0-9]+(?:-[a-z0-9]+)*$/u);
    const source = JSON.parse(await readFile(join(signer.sourceRoot(), entry.previewDirectory, "manifest.json"), "utf8"));
    assert.deepEqual(entry.manifest, source);
    assert.equal(entry.manifest.id, assetId);
    assert.equal(entry.version, source.version);
    assert.equal(entry.revision, signer.revisions()[assetId]);
    assert.equal("license" in entry.manifest, false);
    const maximum = signer.build({ assetId, licenseMode: "perpetual",
      issuedAt: new Date("2100-01-01T00:00:00.000Z"), downloadId: "A".repeat(128) });
    const { manifest, files } = check(maximum, publicKey, source.schema_version === 3 ? 3 : 2, "perpetual");
    assert.equal(maximum.content.byteLength, entry.deliveryBytesUpperBound,
      "upper envelope must equal the largest valid stored delivery, including JSON and ZIP metadata");
    const imageBytes = Object.entries(files).filter(([name]) => name !== "manifest.json")
      .reduce((total, [, bytes]) => total + bytes.length, 0);
    assert.ok(entry.deliveryBytesUpperBound > imageBytes);
    assert.ok(Buffer.from(zipSync(files, { level: 9 })).length <= entry.deliveryBytesUpperBound);
    entry.manifest.version = "tampered";
    entry.manifest.layers[0].image = "missing.png";
    const again = decode(signer.build({ assetId, licenseMode: "perpetual", ...times }).content).manifest;
    assert.equal(again.version, manifest.version);
    assert.equal(again.layers[0].image, source.layers[0].image);
  }
});

test("real sourceRoot freezes old releases across an ordinary current-symlink update", async (t) => {
  const { root, privateKeyFile } = await fixture(t);
  const releaseA = join(root, "release-a"), releaseB = join(root, "release-b");
  await cp(assetRoot, releaseA, { recursive: true });
  await cp(assetRoot, releaseB, { recursive: true });
  const changedManifestPath = join(releaseB, "chick-pecking/manifest.json");
  const changed = JSON.parse(await readFile(changedManifestPath, "utf8"));
  changed.version = "2.0.0";
  await writeFile(changedManifestPath, JSON.stringify(changed));
  const current = join(root, "current");
  const linkType = process.platform === "win32" ? "junction" : "dir";
  await symlink(releaseA, current, linkType);
  const live = new AppearancePackSigner({ assetRoot: current, privateKeyFile });
  const frozenRoot = live.sourceRoot();
  const oldCatalog = live.officialCatalog();
  assert.equal(frozenRoot, await realpath(releaseA));
  const frozen = new AppearancePackSigner({ assetRoot: frozenRoot, privateKeyFile });
  await rm(current);
  await symlink(releaseB, current, linkType);
  assert.equal(live.sourceRoot(), await realpath(releaseB));
  const freshCatalog = live.officialCatalog();
  const id = "official.chick-pecking";
  assert.equal(freshCatalog[id].version, "2.0.0");
  assert.notEqual(freshCatalog[id].revision, oldCatalog[id].revision);
  assert.equal(freshCatalog[id].previewDirectory, oldCatalog[id].previewDirectory);
  assert.equal(frozen.sourceRoot(), frozenRoot);
  const oldDelivery = decode(frozen.build({ assetId: id, licenseMode: "perpetual", ...times }).content).manifest;
  const newDelivery = decode(live.build({ assetId: id, licenseMode: "perpetual", ...times }).content).manifest;
  assert.equal(oldDelivery.version, oldCatalog[id].version);
  assert.equal(newDelivery.version, "2.0.0");
  assert.deepEqual(JSON.parse(await readFile(join(frozenRoot, oldCatalog[id].previewDirectory, "manifest.json"), "utf8")),
    oldCatalog[id].manifest);
});

test("macOS native importer and Python tool agree on V1/V2, mixed batches and hostile fixtures", {
  skip: process.platform !== "darwin" || process.env.GONGDE_NATIVE_LICENSE_TEST !== "1"
}, async (t) => {
  const { root, signer, publicKey, privateKey } = await fixture(t);
  const macSource = await readFile(join(project, "src/macos/appearance_pack.mm"), "utf8");
  const pythonSource = await readFile(join(project, "scripts/appearance-pack.py"), "utf8");
  const pythonAnchors = JSON.parse(run("python3", ["-c",
    "import json,runpy; p=runpy.run_path('scripts/appearance-pack.py'); print(json.dumps([k.decode('ascii') for k in p['TRUSTED_PUBLIC_KEYS']]))"]));
  assert.equal(pythonAnchors.length, 2);
  for (const [index, name] of ["NMPublicKey", "NMCurrentPublicKey"].entries()) {
    const definition = macSource.match(new RegExp(`static const unsigned char ${name}\\[\\] = \\{([\\s\\S]*?)\\};`));
    assert.ok(definition, `${name} must retain its production definition`);
    const expected = Buffer.from([...definition[1].matchAll(/0x([0-9a-f]{2})/gu)].map((match) => parseInt(match[1], 16)));
    const der = createPublicKey(pythonAnchors[index]).export({ type: "spki", format: "der" });
    assert.deepEqual(der.subarray(-65), expected, `Python ${name} must match the client anchor exactly`);
  }
  // Test-only trust substitution in isolated copies, never in the product files.
  // Production binaries below are also tested with their real unchanged anchors.
  const jwk = publicKey.export({ format: "jwk" });
  const point = Buffer.concat([Buffer.from([4]), Buffer.from(jwk.x, "base64url"), Buffer.from(jwk.y, "base64url")]);
  const isolatedMac = macSource.replace('#import "appearance_pack.h"',
    `#import "${join(project, "src/macos/appearance_pack.h")}"`).replace(
    /static const unsigned char NMPublicKey\[\] = \{[\s\S]*?\};/,
    `static const unsigned char NMPublicKey[] = {${[...point].map((b) => `0x${b.toString(16)}`).join(",")}};`);
  assert.notEqual(isolatedMac, macSource);
  const isolatedMacPath = join(root, "appearance_pack-test.mm");
  await writeFile(isolatedMacPath, isolatedMac);
  const pythonPath = join(root, "appearance-pack-test.py");
  await writeFile(pythonPath, pythonSource.replace(/PUBLIC_KEY_PEM = b"""[\s\S]*?"""/,
    `PUBLIC_KEY_PEM = b"""${publicKey.export({ type: "spki", format: "pem" })}"""`));
  const cases = [];
  const add = async (name, content, accept, errorCode) => {
    const archive = join(root, `${name}.nmgpack`);
    await writeFile(archive, content);
    cases.push({ name, archive, accept, ...(errorCode ? { errorCode } : {}) });
    return archive;
  };
  const perpetual = signer.build({ assetId: "official.chick-pecking", ...times, licenseMode: "perpetual" });
  const timed = signer.build({ assetId: "official.chick-pecking", ...times });
  const { files, manifest } = decode(perpetual.content);
  await add("perpetual-old-issued", perpetual.content, true);
  await add("timed-expired-unchanged", timed.content, true);
  const future = signer.build({ assetId: "official.chick-pecking", ...times,
    issuedAt: new Date("2099-01-01"), expiresAt: new Date("2099-01-02") });
  await add("timed-future-issued", future.content, true);
  const futurePerpetual = signer.build({ assetId: "official.chick-pecking", ...times,
    issuedAt: new Date("2099-01-01"), licenseMode: "perpetual" });
  await add("perpetual-future-issued", futurePerpetual.content, true);
  const schema3 = signer.buildCommunity({ ...communitySource(3), ...times, licenseMode: "perpetual" });
  await add("perpetual-schema3", schema3.content, true);
  const mutations = [
    ["unknown-mode", (m) => { m.license.mode = "forever"; }, 37],
    ["extra-field", (m) => { m.license.extra = 1; }, 37],
    ["perpetual-with-deadline", (m) => { m.license.import_before = times.issuedAt.getTime() / 1000 + 86400; }, 37],
    ["missing-issued", (m) => { delete m.license.issued_at; }, 37],
    ["fractional-issued", (m) => { m.license.issued_at += 0.5; }, 37],
    ["string-issued", (m) => { m.license.issued_at = "bad"; }, 37],
    ["bad-mode-type", (m) => { m.license.mode = 1; }, 37],
    ["bad-signature", (m) => { m.license.signature = "0".repeat(128); }, 39],
    ["bad-hash", (m) => { m.license.content_sha256 = "0".repeat(64); }, 38],
    ["wrong-version", (m) => { m.version = "2.0.0"; }, 39],
    ["newline-version", (m) => { m.version = "1.0\n0"; }, 33],
    ["downgrade", (m) => { m.license.mode = "timed"; m.license.import_before = m.license.issued_at + 86400; }, 39],
    ["unsigned-platform-source", (m) => { m.schema_version = 1; delete m.license; }, 37]
  ];
  for (const [name, mutate, code] of mutations) {
    const modified = structuredClone(manifest);
    mutate(modified);
    await add(name, encode(files, modified), false, code);
  }
  const old = decode(timed.content);
  const promoted = structuredClone(old.manifest);
  promoted.license.mode = "perpetual";
  delete promoted.license.import_before;
  await add("timed-promoted-with-old-signature", encode(old.files, promoted), false, 39);
  for (const [name, value] of [["fractional-deadline", old.manifest.license.import_before + 0.5],
    ["backward-deadline", old.manifest.license.issued_at], ["oversized-window", old.manifest.license.issued_at + 86401]]) {
    const modified = structuredClone(old.manifest);
    modified.license.import_before = value;
    modified.license.signature = sign("sha256", message(modified), { key: privateKey, dsaEncoding: "ieee-p1363" }).toString("hex");
    await add(name, encode(old.files, modified), false, 37);
  }
  const foreign = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const untrusted = structuredClone(manifest);
  untrusted.license.signature = sign("sha256", message(untrusted), { key: foreign.privateKey, dsaEncoding: "ieee-p1363" }).toString("hex");
  await add("untrusted-signer", encode(files, untrusted), false, 39);
  const changedFiles = { ...files, "body.png": Buffer.from(files["body.png"]) };
  changedFiles["body.png"][changedFiles["body.png"].length - 1] ^= 1;
  await add("changed-image", encode(changedFiles, manifest), false, 38);

  const singleCases = join(root, "single-cases.json");
  await writeFile(singleCases, JSON.stringify(cases));
  const compile = (script, source, output) => run("xcrun", ["clang++", "-std=c++17", "-O1", "-fobjc-arc",
    "-Wno-deprecated-declarations", "-Wno-nullability-completeness", join(project, script), source,
    "-framework", "AppKit", "-framework", "ApplicationServices", "-framework", "Security", "-o", output]);
  const singleBinary = join(root, "test-single");
  compile("scripts/test-appearance-pack.mm", isolatedMacPath, singleBinary);
  process.stdout.write(run(singleBinary, ["--protocol", singleCases, join(root, "installed")]));
  for (const entry of cases.filter((entry) => entry.name !== "unsigned-platform-source")) {
    const result = spawnSync("python3", [pythonPath, "validate", entry.archive], { cwd: project, encoding: "utf8", timeout: 10_000 });
    assert.equal(result.status === 0, entry.accept, `${entry.name}: ${result.stdout} ${result.stderr}`);
  }
  const batchCases = [];
  const batch = async (name, contents, accept) => {
    const archive = join(root, `${name}.nmgpacks`);
    await writeFile(archive, Buffer.from(zipSync(Object.fromEntries(contents.map((content, i) => [`pack-${i}.nmgpack`, content])), { level: 0 })));
    batchCases.push({ name, archive, accept, count: contents.length });
  };
  await batch("all-perpetual", [perpetual.content, schema3.content], true);
  await batch("mixed-expired-v1-and-v2", [timed.content, schema3.content], true);
  await batch("bad-child-signature", [encode(files, untrusted), schema3.content], false);
  await batch("unsigned-child", [encode(files, { ...manifest, schema_version: 1, license: undefined }), schema3.content], false);
  const batchCasesPath = join(root, "batch-cases.json");
  await writeFile(batchCasesPath, JSON.stringify(batchCases));
  const batchBinary = join(root, "test-batch");
  compile("scripts/test-appearance-batch.mm", isolatedMacPath, batchBinary);
  process.stdout.write(run(batchBinary, ["--protocol", batchCasesPath, join(root, "batch-installed")]));

  // Real trusted historical artifact: read only, never re-sign or rewrite bytes.
  const historical = join(project, ".local-work/acceptance/paid-community-20261007/native-operator/signed-schema3.nmgpack");
  const historicalBytes = await readFile(historical);
  const history = decode(historicalBytes).manifest;
  assert.equal(history.license.mode, "timed");
  assert.ok(history.license.import_before * 1000 < Date.now(), "historical fixture must actually be expired");
  process.stdout.write(run("python3", ["scripts/appearance-pack.py", "validate", historical]));
  const realBinary = join(root, "test-real-trust");
  compile("scripts/test-appearance-pack.mm", join(project, "src/macos/appearance_pack.mm"), realBinary);
  const realCases = join(root, "real-cases.json");
  await writeFile(realCases, JSON.stringify([
    { name: "real-trusted-expired-v1", archive: historical, accept: true },
    { name: "production-rejects-ephemeral-key", archive: cases[0].archive, accept: false, errorCode: 39 }
  ]));
  process.stdout.write(run(realBinary, ["--protocol", realCases, join(root, "real-installed")]));
  assert.deepEqual(await readFile(historical), historicalBytes);
});
