import assert from "node:assert/strict";
import test from "node:test";
import { cp, chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";
import { join } from "node:path";

/**
 * F1: the built service can find its registry with no override, and it reads
 * the registry the release path actually updates.
 *
 * Two layouts are real:
 *
 *   /app/src/free-distribution/installers.json   authoritative
 *   /app/dist/...                                compiled modules
 *
 * A registry-only release overwrites the `src` file in place
 * (`registry-owner.py`: `REGISTRY_PATH` plus a Dockerfile that copies to that
 * exact path), so a stale build-time copy under `dist/` must never shadow it.
 * A container that ships only `dist/` still has to work, so the copy remains a
 * fallback — but only when the authoritative file is genuinely absent.
 */

const compiled = fileURLToPath(new URL("../dist/downloads/installer-registry.js", import.meta.url));
const dist = fileURLToPath(new URL("../dist/", import.meta.url));
const source = fileURLToPath(new URL("../src/free-distribution/installers.json", import.meta.url));

/** A registry whose only difference is `releaseId`, so a stale copy is visible. */
const registryWith = (releaseId) => JSON.stringify({
  schemaVersion: 1,
  items: [{
    name: "niuma-merit-macos-0.9.4-test.dmg",
    platform: "macos",
    format: "dmg",
    releaseId,
    version: "0.9.4",
    bytes: 1024,
    sha256: "a".repeat(64),
    perpetualCompatible: true,
    publicDownloadUrl: "https://download.gongde.zqscreen.cn/niuma-merit-macos-0.9.4-test.dmg"
  }]
});

/** Build a layout: `<root>/{dist,src}` with the compiled loader in `dist/`. */
async function layout(t) {
  const root = await mkdtemp(join(tmpdir(), "gongde-registry-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, "dist/downloads"), { recursive: true });
  await mkdir(join(root, "dist/free-distribution"), { recursive: true });
  await cp(compiled, join(root, "dist/downloads/installer-registry.js"));
  const load = async () => {
    const module = await import(pathToFileURL(join(root, "dist/downloads/installer-registry.js")).href);
    return module.loadInstallerRegistry;
  };
  return {
    root,
    load,
    async writeAuthoritative(releaseId) {
      await mkdir(join(root, "src/free-distribution"), { recursive: true });
      await writeFile(join(root, "src/free-distribution/installers.json"), registryWith(releaseId));
    },
    async writeBuildCopy(releaseId) {
      await mkdir(join(root, "dist/free-distribution"), { recursive: true });
      await writeFile(join(root, "dist/free-distribution/installers.json"), registryWith(releaseId));
    }
  };
}

const releaseIdOf = (registry) => registry.items[0]?.releaseId;

test("F1: the build emits the registry next to the compiled modules", async () => {
  const copied = join(dist, "free-distribution/installers.json");
  assert.ok((await stat(copied)).isFile(), "dist/free-distribution/installers.json must exist after npm run build");
  assert.deepEqual(await readFile(copied), await readFile(source), "the built copy is the shipped registry, not a stale one");
});

test("F1: the compiled loader reads the registry with no environment override", async () => {
  const { loadInstallerRegistry } = await import(pathToFileURL(compiled).href);
  const saved = process.env.GONGDE_FREE_INSTALLERS_FILE;
  delete process.env.GONGDE_FREE_INSTALLERS_FILE;
  try {
    const registry = loadInstallerRegistry();
    assert.equal(registry.status, "available", "no override must still find the shipped registry");
    assert.ok(registry.items.length > 0);
    for (const item of registry.items) assert.ok(item.name && item.platform && item.version && item.sha256);
  } finally {
    if (saved !== undefined) process.env.GONGDE_FREE_INSTALLERS_FILE = saved;
  }
});

test("F1: a registry-only update to src is read even when dist holds an older copy", async (t) => {
  const fixture = await layout(t);
  await fixture.writeBuildCopy("niuma-merit-macos-0.9.4-build-copy");
  await fixture.writeAuthoritative("niuma-merit-macos-0.9.4-published");
  const loadInstallerRegistry = await fixture.load();

  // The build copy is older on purpose: this is the state after a registry-only
  // release, which writes src and leaves the compiled tree alone.
  assert.equal(releaseIdOf(loadInstallerRegistry()), "niuma-merit-macos-0.9.4-published",
    "the authoritative src registry must win over the build-time copy");

  // Publishing again while the service runs is picked up on the next read.
  await fixture.writeAuthoritative("niuma-merit-macos-0.9.4-published-2");
  assert.equal(releaseIdOf(loadInstallerRegistry()), "niuma-merit-macos-0.9.4-published-2");
});

test("F1: a container that ships only dist still loads the registry", async (t) => {
  const fixture = await layout(t);
  await fixture.writeBuildCopy("niuma-merit-macos-0.9.4-dist-only");
  const loadInstallerRegistry = await fixture.load();
  const registry = loadInstallerRegistry();
  assert.equal(registry.status, "available", "no src directory means the build copy is the registry");
  assert.equal(releaseIdOf(registry), "niuma-merit-macos-0.9.4-dist-only");
});

test("F1: a malformed authoritative registry fails closed instead of using the older copy", async (t) => {
  const fixture = await layout(t);
  await fixture.writeBuildCopy("niuma-merit-macos-0.9.4-build-copy");
  await fixture.writeAuthoritative("niuma-merit-macos-0.9.4-published");
  await writeFile(join(fixture.root, "src/free-distribution/installers.json"), "{ not json");
  const loadInstallerRegistry = await fixture.load();
  assert.deepEqual(loadInstallerRegistry(), { status: "unavailable", items: [] },
    "a broken published registry must not be replaced by a stale build copy");
});

test("F1: an unreadable authoritative registry is a read failure, not a missing layout", async (t) => {
  const fixture = await layout(t);
  await fixture.writeBuildCopy("niuma-merit-macos-0.9.4-build-copy");
  await fixture.writeAuthoritative("niuma-merit-macos-0.9.4-published");
  const file = join(fixture.root, "src/free-distribution/installers.json");
  try {
    await chmod(file, 0o000);
    const loadInstallerRegistry = await fixture.load();
    // Running as root would still be able to read the file; then the published
    // value is the correct answer either way, so only the "stale copy" outcome
    // is forbidden.
    const registry = loadInstallerRegistry();
    assert.notEqual(releaseIdOf(registry), "niuma-merit-macos-0.9.4-build-copy",
      "a permission error must never fall back to the build copy");
  } finally {
    // Restore before the layout's own cleanup removes the tree.
    await chmod(file, 0o644);
  }
});

test("F1: no registry at all is unavailable, not an empty list", async (t) => {
  const fixture = await layout(t);
  const loadInstallerRegistry = await fixture.load();
  assert.deepEqual(loadInstallerRegistry(), { status: "unavailable", items: [] });
});

test("F1: an explicit override still wins over both shipped files", async (t) => {
  const fixture = await layout(t);
  await fixture.writeBuildCopy("niuma-merit-macos-0.9.4-build-copy");
  await fixture.writeAuthoritative("niuma-merit-macos-0.9.4-published");
  const override = join(fixture.root, "override.json");
  await writeFile(override, registryWith("niuma-merit-macos-0.9.4-override"));
  const loadInstallerRegistry = await fixture.load();
  assert.equal(releaseIdOf(loadInstallerRegistry({ GONGDE_FREE_INSTALLERS_FILE: override })), "niuma-merit-macos-0.9.4-override");
});
