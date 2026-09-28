#!/usr/bin/env node

// Published previews copy reviewed delivery inputs byte-for-byte.

import { createHash } from "node:crypto";
import { copyFile, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const outputDirectory = join(root, "website", "assets", "previews");
const artworkHeight = 170;
const packDefinitions = [
  ["lucky-cat", "assets/appearance-packs/lucky-cat"],
  ["hamster-wheel", "assets/appearance-packs/hamster-wheel"],
  ["sea-lion-belly-pat", "assets/appearance-packs/sea-lion-belly-pat"],
  ["chick-pecking", "assets/appearance-packs/chick-pecking"],
  ["caishen-ingot", "assets/appearance-packs/caishen-ingot"],
  ["red-panda-wave", "assets/appearance-packs/red-panda-wave"],
  ["shiba-tilt", "assets/appearance-packs/shiba-tilt"],
  ["orange-cat-wave", "assets/appearance-packs/orange-cat-wave"],
  ["raccoon-cheer", "assets/appearance-packs/raccoon-cheer"],
  ["golden-toad-coin", "assets/appearance-packs/golden-toad-coin"],
  ["little-jiangshi-hop", "assets/appearance-packs/little-jiangshi-hop"],
  ["frog-puff", "assets/appearance-packs/frog-puff"],
  ["bee-flap", "assets/appearance-packs/bee-flap"],
  ["koi-bubbles", "assets/appearance-packs/koi-bubbles"],
  ["sweet-kiss", "assets/appearance-packs/sweet-kiss"],
  ["baodan-charm", "assets/appearance-packs/baodan-charm"],
  ["woodpecker-peck", "assets/appearance-packs/woodpecker-peck"],
  ["fortune-bead", "assets/appearance-packs/fortune-bead"],
  ["treasure-basin", "assets/appearance-packs/treasure-basin"],
];

function sha256(buffer) {
  return createHash("sha256").update(buffer).digest("hex");
}

function fail(message) {
  throw new Error(`Appearance preview validation failed: ${message}`);
}

function validateManifest(slug, manifest) {
  if (manifest.canvas_width !== 240 || manifest.canvas_height !== 250 || manifest.plus_y !== 174) {
    fail(`${slug} must use the shared 240x250 canvas and plus_y 174`);
  }
  if (!Array.isArray(manifest.layers) || manifest.layers.length < 1) {
    fail(`${slug} has no renderable layers`);
  }

  let left = 240;
  let right = 0;
  let bottom = artworkHeight;
  let top = 0;
  for (const [index, layer] of manifest.layers.entries()) {
    if (!Array.isArray(layer.frame) || layer.frame.length !== 4 ||
        !Array.isArray(layer.anchor) || layer.anchor.length !== 2 ||
        !Array.isArray(layer.keyframes) || layer.keyframes.length < 1) {
      fail(`${slug} layer ${index} is incomplete`);
    }
    const [x, y, width, height] = layer.frame.map(Number);
    if (![x, y, width, height].every(Number.isFinite) || width <= 0 || height <= 0 ||
        (manifest.schema_version !== 3 && y + height > artworkHeight)) {
      fail(`${slug} layer ${index} leaves the shared artwork region`);
    }
    left = Math.min(left, Math.max(0, x));
    right = Math.max(right, Math.min(240, x + width));
    bottom = Math.min(bottom, Math.max(0, y));
    top = Math.max(top, Math.min(artworkHeight, y + height));
  }

  const visibleWidth = right - left;
  const visibleHeight = top - bottom;
  const maximumWidth = manifest.schema_version === 3 ? 240 : 220;
  if (visibleWidth < 150 || visibleWidth > maximumWidth || visibleHeight < 120 || visibleHeight > artworkHeight) {
    fail(`${slug} visible frame union ${visibleWidth}x${visibleHeight} is outside the shared visual envelope`);
  }
}

await rm(outputDirectory, { recursive: true, force: true });
await mkdir(outputDirectory, { recursive: true });

const sourceMap = {
  schemaVersion: 3,
  generatedFrom: "appearance-pack-manifests",
  canvas: { width: 240, height: 250, artworkHeight, plusY: 174 },
  visualEnvelope: { minWidth: 150, maxWidth: 220, minHeight: 120, maxHeight: 170 },
  packs: {},
};

for (const [slug, sourceDirectoryName] of packDefinitions) {
  const sourceDirectory = join(root, sourceDirectoryName);
  const destinationDirectory = join(outputDirectory, "packs", slug);
  const manifestBuffer = await readFile(join(sourceDirectory, "manifest.json"));
  const manifest = JSON.parse(manifestBuffer.toString("utf8"));
  validateManifest(slug, manifest);
  await mkdir(destinationDirectory, { recursive: true });

  const declaredFiles = [...new Set([
    "manifest.json",
    manifest.preview,
    ...manifest.layers.map((layer) => layer.image),
  ])];
  const files = {};
  for (const name of declaredFiles) {
    const sourcePath = join(sourceDirectory, name);
    const destinationPath = join(destinationDirectory, name);
    const source = await readFile(sourcePath);
    await copyFile(sourcePath, destinationPath);
    const projected = await readFile(destinationPath);
    files[name] = {
      source: `${sourceDirectoryName}/${name}`,
      sourceSha256: sha256(source),
      projectedSha256: sha256(projected),
      projection: "exact-copy",
    };
  }

  sourceMap.packs[slug] = {
    id: manifest.id,
    version: manifest.version,
    manifestSha256: sha256(manifestBuffer),
    assetSha256: sha256(Buffer.from(Object.keys(files).sort().map((name) => `${name}\0${files[name].sourceSha256}\n`).join(""))),
    files,
  };
}

// The default woodfish is native code, NOT the example importable pack.
// Extract its drawing parameters rather than maintaining a web-only design.
const mac = await readFile(join(root, "src/macos/app.mm"), "utf8");
const win = await readFile(join(root, "src/windows/app.cpp"), "utf8");
const macArt = mac.slice(mac.indexOf("NSAffineTransform *woodfishScale"), mac.indexOf("if (!self.previewOnly && striking"));
const winArt = win.slice(win.indexOf("Gdiplus::SolidBrush shadow(Gdiplus::Color(62"), win.indexOf("void DrawScene(Gdiplus::Graphics& graphics, ULONGLONG now)"));
function numbers(text, pattern, label) {
  const match = text.match(pattern);
  if (!match) fail(`native woodfish contract changed: ${label}`);
  return match.slice(1).flatMap((value) => value.replaceAll("f", "").split(",").map(Number));
}
const rect = /drawInRect:NSMakeRect\(([-\d., ]+)\)/g;
const macRects = [...macArt.matchAll(rect)].map((m) => m[1].split(",").map(Number));
const winRects = [...winArt.matchAll(/RectF\(([-\d.f, ]+)\)/g)].map((m) => m[1].replaceAll("f", "").split(",").map(Number));
if (macRects.length !== 3 || winRects.length !== 2) fail("native woodfish rectangle contract changed");
const native = {
  renderer: "native-woodfish-v1",
  provenance: { macOS: sha256(Buffer.from(mac)), Windows: sha256(Buffer.from(win)) },
  macOS: {
    scale: numbers(macArt, /woodfishScale scaleBy:([\d.]+)/, "scale")[0],
    center: numbers(macArt, /woodfishScale translateXBy:([\d.]+) yBy:([\d.]+)/, "center"),
    shadow: numbers(macArt, /shadowRect = NSMakeRect\(([-\d., ]+)\)/, "shadow"),
    body: macRects[0], shaft: macRects[1], head: macRects[2],
    pivot: numbers(macArt, /malletTransform translateXBy:([\d.]+) yBy:([\d.]+)/, "pivot"),
    angle: numbers(macArt, /malletTransform rotateByDegrees:([\d.]+) \+ ([\d.]+) \* strikeAmount/, "angle"),
    shaftSourceX: numbers(macArt, /shaftSource = NSMakeRect\(([\d.]+),/, "shaft crop")[0],
    headSourceWidth: numbers(macArt, /MIN\(([\d.]+), malletSourceSize.width\)/, "head crop")[0],
  },
  Windows: {
    shadow: numbers(winArt, /FillEllipse\(&shadow, ([-\d.f, ]+)\)/, "windows shadow"),
    body: winRects[0], mallet: winRects[1],
    pivot: numbers(winArt, /TranslateTransform\(([-\d.f, ]+)\)/, "windows pivot"),
    angle: numbers(winArt, /RotateTransform\(([\d.]+)f - ([\d.]+)f \* strikeAmount/, "windows angle"),
  },
};
const nativeDirectory = join(outputDirectory, "packs", "woodfish");
await mkdir(nativeDirectory, { recursive: true });
const nativeFiles = {};
for (const [name, sourceName] of [["body.png", "woodfish.png"], ["mallet.png", "mallet.png"]]) {
  const source = await readFile(join(root, "assets", sourceName));
  await writeFile(join(nativeDirectory, name), source);
  nativeFiles[name] = { source: `assets/${sourceName}`, sourceSha256: sha256(source), projectedSha256: sha256(source), projection: "exact-copy" };
}
const nativeManifest = Buffer.from(`${JSON.stringify(native, null, 2)}\n`);
await writeFile(join(nativeDirectory, "manifest.json"), nativeManifest);
nativeFiles["manifest.json"] = { sourceSha256: sha256(nativeManifest), projectedSha256: sha256(nativeManifest), projection: "native-code-extraction" };
sourceMap.packs.woodfish = { id: "builtin.woodfish", manifestSha256: sha256(nativeManifest), files: nativeFiles };

await writeFile(join(outputDirectory, "source-map.json"), `${JSON.stringify(sourceMap, null, 2)}\n`);
