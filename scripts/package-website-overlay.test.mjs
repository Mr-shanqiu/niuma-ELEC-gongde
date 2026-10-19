import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const scriptSource = new URL("./package-website-overlay.sh", import.meta.url);
const legacy = ["index.html", "app.js", "styles.css", "install.html", "checkout.html", "checkout.js", "support.html", "support.js"];
const preview = ["community-preview.js", "creator-community.css"];
const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
const macOnly = { skip: process.platform !== "darwin" };

function fixture(t, options = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "gongde-preview-overlay-test-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const out = path.join(root, "dist/gongde-deploy");
  const site = path.join(root, "website");
  const baseline = path.join(root, "baseline");
  const script = path.join(root, "scripts/package-website-overlay.sh");
  fs.mkdirSync(path.dirname(script), { recursive: true });
  fs.copyFileSync(scriptSource, script);
  for (const directory of [out, site, baseline]) fs.mkdirSync(directory, { recursive: true });
  const files = new Map();
  for (const name of [...legacy, ...preview, "community.html", "community.js", "assets/untouched.txt"]) {
    if (name === options.missingBase) continue;
    const body = Buffer.from("baseline:" + name + "\n");
    files.set(name, body);
    const destination = path.join(baseline, name);
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.writeFileSync(destination, body);
  }
  for (const name of [...legacy, ...preview]) fs.writeFileSync(path.join(site, name), "candidate:" + name + "\n");
  const tree = sha([...files].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
    .map(([name, body]) => sha(body) + "  ./" + name + "\n").join(""));
  const archive = path.join(out, "gongde-site-" + (options.wrongTree ? "b".repeat(64) : tree) + ".tar.gz");
  execFileSync("tar", ["-C", baseline, "-czf", archive, "."], { env: { ...process.env, COPYFILE_DISABLE: "1" } });
  fs.writeFileSync(archive + ".sha256", sha(fs.readFileSync(archive)) + "  " + path.basename(archive) + "\n");
  return { root, out, site, archive, script, files, tree };
}

function run(f, profile = true) {
  const args = profile ? ["--community-preview", f.archive] : [f.archive];
  const result = spawnSync("/bin/sh", [f.script, ...args], { encoding: "utf8", timeout: 15000 });
  const fields = Object.fromEntries(result.stdout.split("\n").filter((line) => line.includes("="))
    .map((line) => { const at = line.indexOf("="); return [line.slice(0, at), line.slice(at + 1)]; }));
  return { ...result, fields };
}

function unpack(f, archive) {
  const target = path.join(f.root, "result");
  fs.mkdirSync(target);
  execFileSync("tar", ["-xzf", archive, "-C", target]);
  return target;
}

test("preview profile replaces exactly two files and preserves all other bytes", macOnly, (t) => {
  const f = fixture(t);
  const r = run(f);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.fields.OVERLAY_PROFILE, "community-preview");
  assert.equal(r.fields.OVERLAY_FILES, preview.join(","));
  assert.equal(r.fields.BASE_TREE_SHA256, f.tree);
  assert.equal(r.fields.BASE_ARCHIVE_SHA256, sha(fs.readFileSync(f.archive)));
  const target = unpack(f, r.fields.SITE_ARCHIVE);
  for (const [name, body] of f.files) {
    assert.deepEqual(fs.readFileSync(path.join(target, name)),
      preview.includes(name) ? Buffer.from("candidate:" + name + "\n") : body);
  }
  assert.equal(r.fields.SITE_ARCHIVE_SHA256, sha(fs.readFileSync(r.fields.SITE_ARCHIVE)));
});

test("default profile retains the existing eight-file contract", macOnly, (t) => {
  const f = fixture(t);
  const r = run(f, false);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.fields.OVERLAY_FILES, legacy.join(","));
  const target = unpack(f, r.fields.SITE_ARCHIVE);
  for (const [name, body] of f.files) {
    assert.deepEqual(fs.readFileSync(path.join(target, name)),
      legacy.includes(name) ? Buffer.from("candidate:" + name + "\n") : body);
  }
});

test("preview profile rejects an absent baseline preview instead of adding a new entry", macOnly, (t) => {
  const f = fixture(t, { missingBase: "community-preview.js" });
  const r = run(f);
  assert.notEqual(r.status, 0);
  assert.equal(r.fields.SITE_ARCHIVE, undefined);
});

test("preview profile requires the existing community entry", macOnly, (t) => {
  const f = fixture(t, { missingBase: "community.html" });
  assert.notEqual(run(f).status, 0);
});

test("preview profile rejects a baseline archive checksum mismatch", macOnly, (t) => {
  const f = fixture(t);
  fs.writeFileSync(f.archive + ".sha256", "0".repeat(64) + "\n");
  assert.notEqual(run(f).status, 0);
});

test("preview profile binds the extracted baseline tree to the release name", macOnly, (t) => {
  const f = fixture(t, { wrongTree: true });
  const r = run(f);
  assert.equal(r.status, 65);
  assert.match(r.stderr, /immutable release name/);
});

test("preview source cannot be replaced by a symlink", macOnly, (t) => {
  const f = fixture(t);
  fs.unlinkSync(path.join(f.site, "creator-community.css"));
  fs.symlinkSync(path.join(f.site, "styles.css"), path.join(f.site, "creator-community.css"));
  assert.equal(run(f).status, 65);
});

test("an immutable output archive is never overwritten", macOnly, (t) => {
  const f = fixture(t);
  assert.equal(run(f).status, 0);
  const r = run(f);
  assert.equal(r.status, 65);
  assert.match(r.stderr, /refusing to overwrite/);
});

test("unknown profile arguments are rejected", macOnly, (t) => {
  const f = fixture(t);
  const r = spawnSync("/bin/sh", [f.script, "--all-files", f.archive], { encoding: "utf8", timeout: 15000 });
  assert.equal(r.status, 64);
});

