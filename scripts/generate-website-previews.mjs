#!/usr/bin/env node

// Published previews copy reviewed delivery inputs byte-for-byte.

import { createHash } from "node:crypto";
import { copyFile, cp, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const outputDirectory = join(root, "website", "assets", "previews");
// Build into a scratch directory and swap it in only after every pack validates.
// A failed run must never leave the published previews deleted or half-written.
// The scratch directory lives under dist/ so a failed run cannot leak into a
// packaged site, and so the swap is a same-volume rename.
const stagingDirectory = join(root, "dist", ".previews-staging");
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
  // The two button packs were catalogued and served by the API long before they
  // were listed here, so their preview images 404'd on the site. Keep this list
  // in step with every catalogued official pack.
  ["wealth-button", "assets/appearance-packs/wealth-button"],
  ["offwork-button", "assets/appearance-packs/offwork-button"],
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

await rm(stagingDirectory, { recursive: true, force: true });
await mkdir(stagingDirectory, { recursive: true });

const sourceMap = {
  schemaVersion: 3,
  generatedFrom: "appearance-pack-manifests",
  canvas: { width: 240, height: 250, artworkHeight, plusY: 174 },
  visualEnvelope: { minWidth: 150, maxWidth: 220, minHeight: 120, maxHeight: 170 },
  packs: {},
};

for (const [slug, sourceDirectoryName] of packDefinitions) {
  const sourceDirectory = join(root, sourceDirectoryName);
  const destinationDirectory = join(stagingDirectory, "packs", slug);
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
// Both clients now draw the same geometry: Windows mirrors macOS through
// y = 250 - y, so one extraction drives both and Windows is derived. The
// Windows source is still checked, so a future divergence stops the build
// instead of silently publishing a preview that only came from macOS.
const mac = await readFile(join(root, "src/macos/app.mm"), "utf8");
const win = await readFile(join(root, "src/windows/app.cpp"), "utf8");
const macArt = mac.slice(mac.indexOf("NSAffineTransform *woodfishScale"), mac.indexOf("if (!self.previewOnly && striking"));
const winArt = win.slice(win.indexOf("const GraphicsState woodfishState"), win.indexOf("void DrawScene(Gdiplus::Graphics& graphics, ULONGLONG now)"));
function numbers(text, pattern, label) {
  const match = text.match(pattern);
  if (!match) fail(`native woodfish contract changed: ${label}`);
  return match.slice(1).flatMap((value) => value.replaceAll("f", "").split(",").map(Number));
}
if (!macArt) fail("native woodfish contract changed: macOS drawing block");
if (!winArt) fail("native woodfish contract changed: Windows drawing block");
const rect = /drawInRect:NSMakeRect\(([-\d., ]+)\)/g;
const macRects = [...macArt.matchAll(rect)].map((m) => m[1].split(",").map(Number));
if (macRects.length !== 3) fail("native woodfish rectangle contract changed");
// Rects are [x, y, w, h]. Windows works in top-left coordinates, so an
// absolutely positioned rect flips to `250 - y - h`. The mallet rects are
// relative to the pivot, which is why they flip to `-y - h` instead.
const flipAbsolute = ([x, y, w, h]) => [x, 250 - y - h, w, h];
const flipRelative = ([x, y, w, h]) => [x, -y - h, w, h];
const macSpec = {
  scale: numbers(macArt, /woodfishScale scaleBy:([\d.]+)/, "scale")[0],
  center: numbers(macArt, /woodfishScale translateXBy:([\d.]+) yBy:([\d.]+)/, "center"),
  shadow: numbers(macArt, /shadowRect = NSMakeRect\(([-\d., ]+)\)/, "shadow"),
  body: macRects[0], shaft: macRects[1], head: macRects[2],
  pivot: numbers(macArt, /malletTransform translateXBy:([\d.]+) yBy:([\d.]+)/, "pivot"),
  angle: numbers(macArt, /malletTransform rotateByDegrees:([\d.]+) \+ ([\d.]+) \* strikeAmount/, "angle"),
  shaftSourceX: numbers(macArt, /shaftSource = NSMakeRect\(([\d.]+),/, "shaft crop")[0],
  headSourceWidth: numbers(macArt, /MIN\(([\d.]+), malletSourceSize.width\)/, "head crop")[0],
};
// Assert the Windows source still mirrors this geometry. These are targeted
// checks against the current implementation, not a C++ parser: when Windows
// stops matching, the build fails and the reason is visible, rather than a
// macOS-only preview being published with a Windows provenance hash.
// Every check compares values, never just the shape of the expression: a
// matching call pattern with different numbers is exactly the drift these
// assertions exist to catch.
const winBody = numbers(winArt, /gFish\.image\.get\(\), RectF\(([-\d.f, ]+)\)/, "windows body");
const winMallets = [...winArt.matchAll(/gMallet\.image\.get\(\), RectF\(([-\d.f, ]+)\)/g)].map((m) => m[1].replaceAll("f", "").split(",").map(Number));
if (winMallets.length !== 2) fail("native woodfish contract changed: windows mallet draws");
const winPivot = numbers(winArt, /TranslateTransform\(([-\d.f, ]+)\);\s*graphics\.RotateTransform/, "windows pivot");
const winScale = numbers(winArt, /ScaleTransform\(([-\d.f, ]+)\)/, "windows scale");
const winCentre = numbers(winArt, /TranslateTransform\(([-\d.f, ]+)\);\s*graphics\.ScaleTransform/, "windows centre");
// The clip is the bottom 170 of the 250-high window, measured from the window
// top. It is not derived from the scale centre: keep the link to the window
// height explicit so a canvas change cannot silently pass.
const CANVAS_HEIGHT = 250;
const ARTWORK_HEIGHT = 170;
const winShaftCrop = numbers(winArt, /,\s*([\d.]+)f, 0\.0f, std::max\(1\.0f, sourceWidth - [\d.]+f\)/, "windows shaft crop");
const winHeadCrop = numbers(winArt, /([\d.]+)f, 0\.0f, std::min\(([\d.]+)f, sourceWidth\)/, "windows head crop");
const winAngle = numbers(winArt, /RotateTransform\(-\(([\d.]+)f \+ ([\d.]+)f \* strikeAmount\)\)/, "windows angle");
const sameRect = (left, right) => left.length === right.length && left.every((value, index) => Math.abs(value - right[index]) < 1e-6);
const winChecks = [
  ["overall scale", sameRect(winScale.slice(0, 2), [macSpec.scale, macSpec.scale])],
  ["scale centre", sameRect(winCentre.slice(0, 2), [macSpec.center[0], CANVAS_HEIGHT - macSpec.center[1]])],
  ["clip band", sameRect(numbers(winArt, /SetClip\(RectF\(([-\d.f, ]+)\)/, "windows clip"),
    [0, CANVAS_HEIGHT - ARTWORK_HEIGHT, 240, ARTWORK_HEIGHT])],
  ["body rect", sameRect(winBody, flipAbsolute(macSpec.body))],
  ["shadow rect", sameRect(numbers(winArt, /FillEllipse\(&shadow, ([-\d.f, ]+)\)/, "windows shadow"), flipAbsolute(macSpec.shadow))],
  ["pivot", sameRect(winPivot.slice(0, 2), [macSpec.pivot[0], CANVAS_HEIGHT - macSpec.pivot[1]])],
  ["angle", sameRect(winAngle.slice(0, 2), macSpec.angle)],
  ["shaft rect", sameRect(winMallets[0], flipRelative(macSpec.shaft))],
  ["head rect", sameRect(winMallets[1], flipRelative(macSpec.head))],
  ["shaft crop", winShaftCrop[0] === macSpec.shaftSourceX],
  ["head crop", winHeadCrop[1] === macSpec.headSourceWidth],
];
const winBroken = winChecks.filter(([, ok]) => !ok).map(([label]) => label);
if (winBroken.length) fail(`Windows woodfish no longer mirrors macOS: ${winBroken.join(", ")}`);
const native = {
  renderer: "native-woodfish-v2",
  provenance: { macOS: sha256(Buffer.from(mac)), Windows: sha256(Buffer.from(win)) },
  macOS: macSpec,
  // Windows draws the same geometry in top-left coordinates.
  Windows: {
    clip: [0, CANVAS_HEIGHT - ARTWORK_HEIGHT, 240, ARTWORK_HEIGHT],
    scale: macSpec.scale,
    center: [macSpec.center[0], 250 - macSpec.center[1]],
    shadow: flipAbsolute(macSpec.shadow),
    body: flipAbsolute(macSpec.body),
    shaft: flipRelative(macSpec.shaft),
    head: flipRelative(macSpec.head),
    pivot: [macSpec.pivot[0], 250 - macSpec.pivot[1]],
    angle: macSpec.angle,
    shaftSourceX: macSpec.shaftSourceX,
    headSourceWidth: macSpec.headSourceWidth,
  },
};
const nativeDirectory = join(stagingDirectory, "packs", "woodfish");
await mkdir(nativeDirectory, { recursive: true });
const nativeFiles = {};
for (const [name, sourceName] of [["body.png", "woodfish.png"], ["mallet.png", "mallet.png"]]) {
  const source = await readFile(join(root, "assets", sourceName));
  await writeFile(join(nativeDirectory, name), source);
  // Also publish the same bytes at a content-addressed public path. That path
  // already sits under the site's immutable rule, so a returning visitor finds
  // the artwork in cache instead of re-downloading 552 KB through the origin.
  // The stable packs/ copy stays: pages opened before this release still ask
  // for it, and their index has no publicPath to follow.
  const hash = sha256(source);
  const publicDirectory = join(stagingDirectory, "public", hash);
  await mkdir(publicDirectory, { recursive: true });
  await writeFile(join(publicDirectory, name), source);
  nativeFiles[name] = { source: `assets/${sourceName}`, sourceSha256: hash, projectedSha256: hash,
    projection: "exact-copy", publicPath: `/assets/previews/public/${hash}/${name}` };
}
const nativeManifest = Buffer.from(`${JSON.stringify(native, null, 2)}\n`);
await writeFile(join(nativeDirectory, "manifest.json"), nativeManifest);
nativeFiles["manifest.json"] = { sourceSha256: sha256(nativeManifest), projectedSha256: sha256(nativeManifest), projection: "native-code-extraction" };
sourceMap.packs.woodfish = { id: "builtin.woodfish", manifestSha256: sha256(nativeManifest), files: nativeFiles };

await writeFile(join(stagingDirectory, "source-map.json"), `${JSON.stringify(sourceMap, null, 2)}\n`);

// `public/` holds hand-published background art this script does not generate;
// carry it across so the swap stays a replacement of generated packs only.
await cp(join(outputDirectory, "public"), join(stagingDirectory, "public"),
  { recursive: true, force: true }).catch(() => {});

const previousDirectory = `${outputDirectory}.previous`;
await rm(previousDirectory, { recursive: true, force: true });
await rename(outputDirectory, previousDirectory);
try {
  await rename(stagingDirectory, outputDirectory);
} catch (error) {
  await rename(previousDirectory, outputDirectory);
  throw error;
}
await rm(previousDirectory, { recursive: true, force: true });
