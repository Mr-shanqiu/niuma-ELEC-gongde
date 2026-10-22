/**
 * Copy the JSON files the service reads at runtime into `dist/`.
 *
 * `tsc` only emits what it compiles, so a data file read with `readFileSync`
 * disappears from the build and the feature that needs it fails closed at
 * runtime while every test (which sets an override) still passes. This copy
 * runs as part of `npm run build` for that reason.
 *
 * The copy is only a fallback for containers that ship `dist/` alone. The
 * authoritative registry is `src/free-distribution/installers.json`, which the
 * registry-only release overwrites in place; the loader reads that first and
 * uses this copy only when it is genuinely absent.
 */
import { copyFile, mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";

const files = [
  ["free-distribution/installers.json"]
];

for (const [relative] of files) {
  const from = fileURLToPath(new URL(`../src/${relative}`, import.meta.url));
  const to = fileURLToPath(new URL(`../dist/${relative}`, import.meta.url));
  await mkdir(dirname(to), { recursive: true });
  await copyFile(from, to);
}
