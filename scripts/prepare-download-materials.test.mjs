// Regression tests for prepare-download-materials.mjs.
//
// Run with: node --test scripts/prepare-download-materials.test.mjs
//
// Everything happens in a fresh temp root. The script never sees the real
// project, and the macOS cases need no signed release artifact: an ad-hoc copy
// of a system binary is enough to prove the trust claims are checked in both
// directions.

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const script = fileURLToPath(new URL("./prepare-download-materials.mjs", import.meta.url));
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const macOnly = { skip: process.platform !== "darwin" };

// A minimal PE32+ image. `signed` decides whether the certificate table
// (data directory 4) is populated.
function peBytes({ signed }) {
  const buffer = Buffer.alloc(0x200);
  buffer.write("MZ", 0, "latin1");
  const peOffset = 0x80;
  buffer.writeUInt32LE(peOffset, 0x3c);
  buffer.write("PE\0\0", peOffset, "latin1");
  const optionalOffset = peOffset + 24;
  buffer.writeUInt16LE(0x20b, optionalOffset);
  const securityDirectory = optionalOffset + 112 + 4 * 8;
  buffer.writeUInt32LE(signed ? 0x1a0 : 0, securityDirectory);
  buffer.writeUInt32LE(signed ? 0x40 : 0, securityDirectory + 4);
  return buffer;
}

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "gongde-download-materials-test-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const out = path.join(root, "out");
  fs.mkdirSync(out, { recursive: true });
  return { root, out };
}

// Write a source file and return the manifest entry describing it.
function entry(root, name, bytes, overrides = {}) {
  const source = path.join(root, name);
  fs.writeFileSync(source, bytes);
  return {
    name,
    source,
    platform: "Windows",
    version: "0.9.4",
    bytes: bytes.length,
    sha256: sha256(bytes),
    signature: "unsigned",
    notarization: "not-applicable",
    ...overrides
  };
}

function run(root, out, files, { args = [] } = {}) {
  const manifest = path.join(root, "manifest.json");
  fs.writeFileSync(manifest, JSON.stringify({ files }, null, 2));
  return spawnSync(process.execPath, [script, manifest, out, ...args], {
    encoding: "utf8",
    timeout: 30000
  });
}

function manifestOf(out) {
  return JSON.parse(fs.readFileSync(path.join(out, "DOWNLOADS.json"), "utf8"));
}

test("a matching Windows claim publishes the file and its provenance", (t) => {
  const { root, out } = fixture(t);
  const bytes = peBytes({ signed: true });
  const result = run(root, out, [entry(root, "setup.exe", bytes, {
    signature: "authenticode-sha256",
    publisher: "Example Publisher Ltd",
    certificateThumbprint: "003CB0952933A1A1ADD31A39A1D0C8AAF768A24F",
    sourceCommit: "4e1d6c2b46454153e386b8763c94aeda98a6ff33",
    buildRunId: "39195939014",
    timestamp: "rfc3161"
  })]);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /DOWNLOAD_MATERIALS_OK files=1/);

  const manifest = manifestOf(out);
  const item = manifest.files[0];
  assert.equal(item.sha256, sha256(bytes));
  assert.equal(item.url, "https://download.gongde.zqscreen.cn/setup.exe");
  // Provenance the manifest declared must survive into the published file.
  assert.equal(item.publisher, "Example Publisher Ltd");
  assert.equal(item.certificateThumbprint, "003CB0952933A1A1ADD31A39A1D0C8AAF768A24F");
  assert.equal(item.buildRunId, "39195939014");
  // The local source path must never be published.
  assert.equal(item.source, undefined);
  assert.ok(!fs.readFileSync(path.join(out, "DOWNLOADS.json"), "utf8").includes(root));
});

test("an unsigned claim is checked against the PE too", (t) => {
  const { root, out } = fixture(t);
  const result = run(root, out, [entry(root, "plain.exe", peBytes({ signed: false }))]);
  assert.equal(result.status, 0, result.stderr);
});

test("claiming Authenticode on a PE with no certificate table fails", (t) => {
  const { root, out } = fixture(t);
  const result = run(root, out, [entry(root, "plain.exe", peBytes({ signed: false }), {
    signature: "authenticode-sha256"
  })]);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /certificate table says "unsigned"/);
  assert.ok(!fs.existsSync(path.join(out, "DOWNLOADS.json")));
});

test("claiming unsigned on a signed PE fails", (t) => {
  const { root, out } = fixture(t);
  const result = run(root, out, [entry(root, "setup.exe", peBytes({ signed: true }))]);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /certificate table says "authenticode"/);
});

test("an unrecognized signature claim fails instead of passing unchecked", (t) => {
  const { root, out } = fixture(t);
  const result = run(root, out, [entry(root, "setup.exe", peBytes({ signed: true }), {
    signature: "developer id application"
  })]);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /unrecognized Windows signature claim/);
});

test("a macOS signature claim is verified against codesign", macOnly, (t) => {
  const { root, out } = fixture(t);
  const source = path.join(root, "client.dmg");
  fs.copyFileSync("/bin/echo", source);
  spawnSync("codesign", ["--remove-signature", source]);
  spawnSync("codesign", ["-s", "-", source]);

  const base = {
    name: "client.dmg",
    source,
    platform: "macOS",
    version: "0.9.4",
    bytes: fs.statSync(source).size,
    sha256: sha256(fs.readFileSync(source)),
    notarization: "not-notarized"
  };

  // An ad-hoc file may not be published as Developer ID, nor as unsigned.
  for (const wrong of ["Developer ID Application", "unsigned"]) {
    const result = run(root, out, [{ ...base, signature: wrong }]);
    assert.equal(result.status, 1, `${wrong} should have been rejected`);
    assert.match(result.stderr, /Do not carry a trust state over from another release|code object is not signed/);
  }

  // The truthful claim is accepted.
  const honest = run(root, out, [{ ...base, signature: "ad-hoc" }]);
  assert.equal(honest.status, 0, honest.stderr);
  assert.equal(manifestOf(out).files[0].signature, "ad-hoc");
});

test("duplicate output names are rejected", (t) => {
  const { root, out } = fixture(t);
  const bytes = peBytes({ signed: true });
  const result = run(root, out, [
    entry(root, "x.exe", bytes, { signature: "authenticode-sha256" }),
    entry(root, "y.exe", bytes, { name: "x.exe", signature: "authenticode-sha256" })
  ]);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /duplicate output name/);
});

test("names this script writes itself are rejected", (t) => {
  const { root, out } = fixture(t);
  for (const name of ["DOWNLOADS.json", "SHA256SUMS.txt", "downloads.json"]) {
    const result = run(root, out, [entry(root, "src.exe", peBytes({ signed: false }), { name })]);
    assert.equal(result.status, 1, `${name} should have been rejected`);
    assert.match(result.stderr, /choose a different output name/);
  }
});

test("a missing source fails and leaves the previous output alone", (t) => {
  const { root, out } = fixture(t);
  const kept = path.join(out, "old.exe");
  fs.writeFileSync(kept, "previous release");
  fs.writeFileSync(path.join(out, "DOWNLOADS.json"), JSON.stringify({ files: [{ name: "old.exe" }] }));
  fs.writeFileSync(path.join(out, "hand-placed-receipt.txt"), "receipt");

  const gone = entry(root, "new.exe", peBytes({ signed: false }));
  fs.rmSync(gone.source);
  const result = run(root, out, [gone]);

  assert.equal(result.status, 1);
  assert.match(result.stderr, /source file is missing/);
  assert.equal(fs.readFileSync(kept, "utf8"), "previous release");
  assert.equal(fs.readFileSync(path.join(out, "hand-placed-receipt.txt"), "utf8"), "receipt");
});

test("a byte or digest mismatch fails before anything is written", (t) => {
  const { root, out } = fixture(t);
  const bytes = peBytes({ signed: false });
  const wrongBytes = run(root, out, [entry(root, "a.exe", bytes, { bytes: bytes.length + 1 })]);
  assert.equal(wrongBytes.status, 1);
  assert.match(wrongBytes.stderr, /bytes but the manifest declares/);

  const wrongDigest = run(root, out, [entry(root, "b.exe", bytes, { sha256: "0".repeat(64) })]);
  assert.equal(wrongDigest.status, 1);
  assert.match(wrongDigest.stderr, /does not match the manifest/);

  assert.ok(!fs.existsSync(path.join(out, "DOWNLOADS.json")));
});

test("a missing required field fails", (t) => {
  const { root, out } = fixture(t);
  const incomplete = entry(root, "a.exe", peBytes({ signed: false }));
  delete incomplete.signature;
  const result = run(root, out, [incomplete]);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /missing required field "signature"/);
});

test("a rerun replaces only what the previous manifest produced", (t) => {
  const { root, out } = fixture(t);
  const first = run(root, out, [entry(root, "a.exe", peBytes({ signed: false }))]);
  assert.equal(first.status, 0, first.stderr);

  fs.writeFileSync(path.join(out, "hand-placed-receipt.txt"), "receipt");
  const second = run(root, out, [entry(root, "b.exe", peBytes({ signed: false }))]);
  assert.equal(second.status, 0, second.stderr);

  assert.ok(!fs.existsSync(path.join(out, "a.exe")), "the previous artifact should be replaced");
  assert.ok(fs.existsSync(path.join(out, "b.exe")));
  assert.equal(fs.readFileSync(path.join(out, "hand-placed-receipt.txt"), "utf8"), "receipt");
});

test("no usage arguments means a usage error, not a partial run", (t) => {
  const { out } = fixture(t);
  const result = spawnSync(process.execPath, [script], { encoding: "utf8" });
  assert.equal(result.status, 64);
  assert.equal(fs.readdirSync(out).length, 0);
});
