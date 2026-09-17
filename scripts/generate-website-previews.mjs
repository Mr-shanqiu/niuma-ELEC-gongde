#!/usr/bin/env node

// Generated website previews must always come from desktop-client assets.
// Never hand-edit website/assets/previews; rerun this script instead.

import { createHash } from "node:crypto";
import { deflateSync, inflateSync } from "node:zlib";
import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const outputDirectory = join(root, "website", "assets", "previews");
const assets = [
  ["assets/woodfish.png", "woodfish-body.png", false],
  ["assets/mallet.png", "woodfish-mallet.png", false],
  ["assets/scenes/lucky-cat/lucky-cat-base.png", "lucky-cat-base.png", false],
  ["assets/scenes/lucky-cat/lucky-cat-actor.png", "lucky-cat-paw.png", false],
  ["assets/scenes/hamster-wheel/runtime/hamster-habitat.png", "hamster-habitat.png", true],
  ["assets/scenes/hamster-wheel/runtime/hamster-pet.png", "hamster-pet.png", true],
  ["assets/appearance-packs/sea-lion-belly-pat/body.png", "sea-lion-body.png", false],
  ["assets/appearance-packs/sea-lion-belly-pat/flipper.png", "sea-lion-flipper.png", false],
  ["assets/appearance-packs/chick-pecking/body.png", "chick-body.png", false],
  ["assets/appearance-packs/chick-pecking/head.png", "chick-head.png", false],
];
const pngSignature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

function paeth(a, b, c) {
  const p = a + b - c;
  const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
}

function decodePng(buffer) {
  if (!buffer.subarray(0, 8).equals(pngSignature)) throw new Error("Not a PNG file");
  let offset = 8, width = 0, height = 0, colorType = -1, bitDepth = 0, interlace = 0;
  const idat = [];
  while (offset < buffer.length) {
    const length = buffer.readUInt32BE(offset);
    const type = buffer.toString("ascii", offset + 4, offset + 8);
    const data = buffer.subarray(offset + 8, offset + 8 + length);
    if (type === "IHDR") {
      width = data.readUInt32BE(0); height = data.readUInt32BE(4);
      bitDepth = data[8]; colorType = data[9]; interlace = data[12];
    } else if (type === "IDAT") idat.push(data);
    else if (type === "IEND") break;
    offset += length + 12;
  }
  if (bitDepth !== 8 || ![2, 6].includes(colorType) || interlace !== 0) {
    throw new Error(`Unsupported PNG format: depth=${bitDepth}, color=${colorType}, interlace=${interlace}`);
  }
  const channels = colorType === 6 ? 4 : 3;
  const stride = width * channels;
  const compressed = inflateSync(Buffer.concat(idat));
  const pixels = Buffer.alloc(width * height * channels);
  let input = 0;
  for (let y = 0; y < height; y += 1) {
    const filter = compressed[input++];
    const row = y * stride;
    for (let x = 0; x < stride; x += 1) {
      const raw = compressed[input++];
      const left = x >= channels ? pixels[row + x - channels] : 0;
      const above = y > 0 ? pixels[row + x - stride] : 0;
      const upperLeft = y > 0 && x >= channels ? pixels[row + x - stride - channels] : 0;
      if (filter === 0) pixels[row + x] = raw;
      else if (filter === 1) pixels[row + x] = (raw + left) & 255;
      else if (filter === 2) pixels[row + x] = (raw + above) & 255;
      else if (filter === 3) pixels[row + x] = (raw + Math.floor((left + above) / 2)) & 255;
      else if (filter === 4) pixels[row + x] = (raw + paeth(left, above, upperLeft)) & 255;
      else throw new Error(`Unsupported PNG filter: ${filter}`);
    }
  }
  const rgba = Buffer.alloc(width * height * 4);
  for (let source = 0, target = 0; source < pixels.length; source += channels, target += 4) {
    rgba[target] = pixels[source]; rgba[target + 1] = pixels[source + 1]; rgba[target + 2] = pixels[source + 2];
    rgba[target + 3] = channels === 4 ? pixels[source + 3] : 255;
  }
  return { width, height, rgba };
}

const crcTable = Array.from({ length: 256 }, (_, index) => {
  let value = index;
  for (let bit = 0; bit < 8; bit += 1) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  return value >>> 0;
});

function crc32(buffer) {
  let value = 0xffffffff;
  for (const byte of buffer) value = crcTable[(value ^ byte) & 255] ^ (value >>> 8);
  return (value ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data) {
  const name = Buffer.from(type, "ascii");
  const output = Buffer.alloc(data.length + 12);
  output.writeUInt32BE(data.length, 0); name.copy(output, 4); data.copy(output, 8);
  output.writeUInt32BE(crc32(Buffer.concat([name, data])), data.length + 8);
  return output;
}

function encodePng({ width, height, rgba }) {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0); header.writeUInt32BE(height, 4);
  header[8] = 8; header[9] = 6; header[10] = 0; header[11] = 0; header[12] = 0;
  const rows = Buffer.alloc(height * (width * 4 + 1));
  for (let y = 0; y < height; y += 1) rgba.copy(rows, y * (width * 4 + 1) + 1, y * width * 4, (y + 1) * width * 4);
  return Buffer.concat([pngSignature, pngChunk("IHDR", header), pngChunk("IDAT", deflateSync(rows, { level: 9 })), pngChunk("IEND", Buffer.alloc(0))]);
}

function removeGreenScreen(png) {
  const image = decodePng(png);
  for (let offset = 0; offset < image.rgba.length; offset += 4) {
    const red = image.rgba[offset], green = image.rgba[offset + 1], blue = image.rgba[offset + 2];
    const alpha = image.rgba[offset + 3];
    if (alpha === 0) continue;
    const excess = (green - Math.max(red, blue)) / 255;
    if (excess <= 0.08) continue;
    const factor = 1 - Math.min(Math.max((excess - 0.08) / 0.22, 0), 1);
    image.rgba[offset + 1] = Math.min(green, Math.max(red, blue));
    image.rgba[offset + 3] = Math.round(alpha * factor);
  }
  return encodePng(image);
}

await mkdir(outputDirectory, { recursive: true });
const sourceMap = { schemaVersion: 1, generatedFrom: "desktop-client-assets", files: {} };
for (const [sourceName, outputName, removeGreen] of assets) {
  const sourcePath = join(root, sourceName);
  const outputPath = join(outputDirectory, outputName);
  const source = await readFile(sourcePath);
  if (removeGreen) await writeFile(outputPath, removeGreenScreen(source));
  else await copyFile(sourcePath, outputPath);
  const output = await readFile(outputPath);
  sourceMap.files[outputName] = {
    source: sourceName,
    sourceSha256: createHash("sha256").update(source).digest("hex"),
    outputSha256: createHash("sha256").update(output).digest("hex"),
    processing: removeGreen ? "desktop-green-key" : "byte-for-byte-copy",
  };
}
await writeFile(join(outputDirectory, "source-map.json"), `${JSON.stringify(sourceMap, null, 2)}\n`);
