import assert from "node:assert/strict";
import test from "node:test";
import { cp, mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { join } from "node:path";

/**
 * F1: the built service can find its registry with no override.
 *
 * The loader used to resolve a single path relative to the compiled module, so
 * `dist/downloads/installer-registry.js` looked for `dist/free-distribution/
 * installers.json` — a file `tsc` never emits. Every test passed because every
 * test set `GONGDE_FREE_INSTALLERS_FILE`; the deployed service read the whole
 * registry as "unavailable" and the website's installer list, the counting
 * redirect and the admin page all failed closed.
 *
 * So this test runs the *compiled* module in a directory that holds only what
 * the build produces, with the environment cleared of the override.
 */

const dist = fileURLToPath(new URL("../dist/", import.meta.url));
const source = fileURLToPath(new URL("../src/free-distribution/installers.json", import.meta.url));

const withoutOverride = () => {
  const saved = process.env.GONGDE_FREE_INSTALLERS_FILE;
  delete process.env.GONGDE_FREE_INSTALLERS_FILE;
  return () => { if (saved !== undefined) process.env.GONGDE_FREE_INSTALLERS_FILE = saved; };
};

test("F1: the build emits the registry next to the compiled modules", async () => {
  const copied = join(dist, "free-distribution/installers.json");
  assert.ok((await stat(copied)).isFile(), "dist/free-distribution/installers.json must exist after npm run build");
  assert.deepEqual(await readFile(copied), await readFile(source), "the built copy is the shipped registry, not a stale one");
});

test("F1: the compiled loader reads the registry with no environment override", async () => {
  const restore = withoutOverride();
  try {
    const { loadInstallerRegistry } = await import(pathToFileURL(join(dist, "downloads/installer-registry.js")).href);
    const registry = loadInstallerRegistry();
    assert.equal(registry.status, "available", "no override must still find the shipped registry");
    assert.ok(registry.items.length > 0);
    for (const item of registry.items) {
      assert.ok(item.name && item.platform && item.version && item.sha256);
    }
  } finally { restore(); }
});

test("F1: a container that ships only dist still loads the registry", async () => {
  // The release tarball ships src and builds on the host, but a container image
  // may ship only dist. Copy exactly what the build produces for the loader and
  // import it from there, so the src-relative fallback cannot be the one that
  // saves this test.
  const root = await mkdtemp(join(fileURLToPath(new URL("./", import.meta.url)), ".dist-only-"));
  try {
    await cp(join(dist, "downloads/installer-registry.js"), join(root, "downloads/installer-registry.js"), { recursive: false });
    await cp(join(dist, "free-distribution/installers.json"), join(root, "free-distribution/installers.json"));
    const restore = withoutOverride();
    try {
      const { loadInstallerRegistry } = await import(pathToFileURL(join(root, "downloads/installer-registry.js")).href);
      const registry = loadInstallerRegistry();
      assert.equal(registry.status, "available", "dist-only layout must work");
      assert.ok(registry.items.length > 0);
    } finally { restore(); }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("F1: a missing registry is still reported as unavailable, not as an empty list", async () => {
  const root = await mkdtemp(join(fileURLToPath(new URL("./", import.meta.url)), ".dist-broken-"));
  try {
    await cp(join(dist, "downloads/installer-registry.js"), join(root, "downloads/installer-registry.js"), { recursive: false });
    const restore = withoutOverride();
    try {
      const { loadInstallerRegistry } = await import(pathToFileURL(join(root, "downloads/installer-registry.js")).href);
      const registry = loadInstallerRegistry();
      assert.deepEqual(registry, { status: "unavailable", items: [] });
    } finally { restore(); }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("F1: an explicit override still wins over the shipped file", async () => {
  const root = await mkdtemp(join(fileURLToPath(new URL("./", import.meta.url)), ".override-"));
  const file = join(root, "installers.json");
  try {
    const { writeFile } = await import("node:fs/promises");
    await writeFile(file, JSON.stringify({ schemaVersion: 1, items: [] }));
    const { loadInstallerRegistry } = await import(pathToFileURL(join(dist, "downloads/installer-registry.js")).href);
    assert.deepEqual(loadInstallerRegistry({ GONGDE_FREE_INSTALLERS_FILE: file }), { status: "available", items: [] });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
