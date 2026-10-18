import { deflateSync, inflateSync } from "node:zlib";
import type { ValidatedCreatorPack } from "./pack-validation.js";
import { CREATOR_UPLOAD_LIMITS as LIMITS } from "./policy.js";
import { CreatorError } from "./types.js";

const SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const BACKGROUND = [248, 248, 244] as const;
const PHASES = [0, 0.25, 0.5, 0.75, 1] as const;
const OUTPUT_BYTES = 8 * 1024 * 1024;
const CRC_TABLE = Uint32Array.from({ length: 256 }, (_, input) => {
  let value = input;
  for (let bit = 0; bit < 8; bit += 1) value = (value >>> 1) ^ ((value & 1) ? 0xedb88320 : 0);
  return value >>> 0;
});

interface Image {
  width: number;
  height: number;
  rgba: Buffer;
}

interface Frame {
  t: number;
  x: number;
  y: number;
  rotation: number;
  scale: number;
  scale_y?: number;
  alpha: number;
}

function requireValue(condition: boolean): asserts condition {
  if (!condition) throw new Error("Invalid review render input");
}

function crc32(data: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of data) crc = (crc >>> 8) ^ CRC_TABLE[(crc ^ byte) & 255];
  return (crc ^ 0xffffffff) >>> 0;
}

function paeth(a: number, b: number, c: number): number {
  const p = a + b - c;
  const da = Math.abs(p - a), db = Math.abs(p - b), dc = Math.abs(p - c);
  return da <= db && da <= dc ? a : db <= dc ? b : c;
}

// Only the already validated RGB/RGBA, 8-bit, non-interlaced PNG subset.
// Recheck its decoding envelope so no allocation depends on unchecked IHDR bytes.
function decodePng(data: Buffer, expectedWidth: number, expectedHeight: number): Image {
  requireValue(data.length >= 57 && data.length <= LIMITS.unpackedBytes &&
    data.subarray(0, 8).equals(SIGNATURE));
  let cursor = 8, width = 0, height = 0, channels = 0;
  let ended = false, sawIdat = false, idatClosed = false;
  let transparent: readonly number[] | undefined;
  const compressed: Buffer[] = [];
  while (cursor < data.length) {
    requireValue(cursor + 12 <= data.length);
    const length = data.readUInt32BE(cursor);
    requireValue(cursor + length + 12 <= data.length);
    const typeBytes = data.subarray(cursor + 4, cursor + 8);
    const type = typeBytes.toString("ascii");
    requireValue(/^[A-Za-z]{4}$/u.test(type) && (typeBytes[2] & 32) === 0);
    const chunk = data.subarray(cursor + 8, cursor + 8 + length);
    requireValue(crc32(data.subarray(cursor + 4, cursor + 8 + length)) ===
      data.readUInt32BE(cursor + 8 + length));
    requireValue(cursor !== 8 || type === "IHDR");
    if (type === "IHDR") {
      requireValue(cursor === 8 && length === 13);
      width = chunk.readUInt32BE(0);
      height = chunk.readUInt32BE(4);
      requireValue(width === expectedWidth && height === expectedHeight &&
        width >= 1 && height >= 1 && width <= LIMITS.imageDimension && height <= LIMITS.imageDimension &&
        chunk[8] === 8 && (chunk[9] === 2 || chunk[9] === 6) &&
        chunk[10] === 0 && chunk[11] === 0 && chunk[12] === 0);
      channels = chunk[9] === 6 ? 4 : 3;
    } else if (type === "IDAT") {
      requireValue(!idatClosed && !ended);
      sawIdat = true;
      compressed.push(chunk);
    } else if (type === "IEND") {
      requireValue(sawIdat && length === 0 && cursor + 12 === data.length);
      ended = true;
    } else {
      if (sawIdat) idatClosed = true;
      requireValue((typeBytes[0] & 32) !== 0 &&
        type !== "acTL" && type !== "fcTL" && type !== "fdAT");
      // RGB color-key transparency is an ancillary chunk accepted by validation.
      if (type === "tRNS") {
        requireValue(channels === 3 && !sawIdat && !transparent && length === 6);
        transparent = [chunk.readUInt16BE(0), chunk.readUInt16BE(2), chunk.readUInt16BE(4)];
        requireValue(transparent.every(value => value <= 255));
      }
    }
    cursor += length + 12;
  }
  requireValue(ended && channels > 0 && compressed.length > 0);
  const stride = width * channels;
  const expectedBytes = (stride + 1) * height;
  requireValue(width * height * 4 <= LIMITS.decodedImageBytes);
  const raw = inflateSync(Buffer.concat(compressed), { maxOutputLength: expectedBytes });
  requireValue(raw.length === expectedBytes);
  const rgba = Buffer.alloc(width * height * 4);
  let previous = Buffer.alloc(stride), current = Buffer.alloc(stride);
  for (let row = 0; row < height; row += 1) {
    const start = row * (stride + 1), filter = raw[start];
    requireValue(filter <= 4);
    for (let column = 0; column < stride; column += 1) {
      const left = column >= channels ? current[column - channels] : 0;
      const above = previous[column];
      const upperLeft = column >= channels ? previous[column - channels] : 0;
      const predictor = filter === 0 ? 0 : filter === 1 ? left : filter === 2 ? above :
        filter === 3 ? Math.floor((left + above) / 2) : paeth(left, above, upperLeft);
      current[column] = (raw[start + 1 + column] + predictor) & 255;
    }
    for (let x = 0; x < width; x += 1) {
      const source = x * channels, target = (row * width + x) * 4;
      rgba[target] = current[source];
      rgba[target + 1] = current[source + 1];
      rgba[target + 2] = current[source + 2];
      rgba[target + 3] = channels === 4 ? current[source + 3] :
        transparent && current[source] === transparent[0] && current[source + 1] === transparent[1] &&
          current[source + 2] === transparent[2] ? 0 : 255;
    }
    [previous, current] = [current, previous];
  }
  return { width, height, rgba };
}

function chunk(type: string, data: Buffer): Buffer {
  const result = Buffer.alloc(data.length + 12);
  result.writeUInt32BE(data.length, 0);
  result.write(type, 4, 4, "ascii");
  data.copy(result, 8);
  result.writeUInt32BE(crc32(result.subarray(4, result.length - 4)), result.length - 4);
  return result;
}

function encodePng(width: number, height: number, rgb: Buffer): Buffer {
  requireValue(width >= 1 && height >= 1 && width <= 1200 && height <= 512 &&
    rgb.length === width * height * 3);
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 2;
  const stride = width * 3;
  const scanlines = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y += 1) {
    rgb.copy(scanlines, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }
  return Buffer.concat([SIGNATURE, chunk("IHDR", header),
    chunk("IDAT", deflateSync(scanlines)), chunk("IEND", Buffer.alloc(0))]);
}

function background(width: number, height: number): Buffer {
  const rgb = Buffer.alloc(width * height * 3);
  for (let index = 0; index < rgb.length; index += 3) {
    rgb[index] = BACKGROUND[0];
    rgb[index + 1] = BACKGROUND[1];
    rgb[index + 2] = BACKGROUND[2];
  }
  return rgb;
}

function composite(rgb: Buffer, target: number, image: Image, source: number, alpha = 1): void {
  const opacity = image.rgba[source + 3] / 255 * alpha;
  for (let channel = 0; channel < 3; channel += 1) {
    rgb[target + channel] = Math.round(image.rgba[source + channel] * opacity +
      rgb[target + channel] * (1 - opacity));
  }
}

function thumbnail(image: Image): Buffer {
  const fit = Math.min(1, 512 / image.width, 512 / image.height);
  const width = Math.max(1, Math.floor(image.width * fit));
  const height = Math.max(1, Math.floor(image.height * fit));
  const rgb = background(width, height);
  for (let y = 0; y < height; y += 1) {
    const sy = Math.min(image.height - 1, Math.floor((y + 0.5) * image.height / height));
    for (let x = 0; x < width; x += 1) {
      const sx = Math.min(image.width - 1, Math.floor((x + 0.5) * image.width / width));
      composite(rgb, (y * width + x) * 3, image, (sy * image.width + sx) * 4);
    }
  }
  return encodePng(width, height, rgb);
}

// Endpoint clamping and interpolation match website/community-preview.js.
function sample(frames: readonly Frame[], phase: number, interpolation: string): Frame {
  requireValue(frames.length >= 1 && frames.length <= LIMITS.keyframesPerLayer);
  if (phase <= frames[0].t) return frames[0];
  if (phase >= frames[frames.length - 1].t) return frames[frames.length - 1];
  for (let index = 1; index < frames.length; index += 1) {
    const right = frames[index];
    if (phase > right.t) continue;
    const left = frames[index - 1];
    requireValue(right.t > left.t);
    let mix = (phase - left.t) / (right.t - left.t);
    if (interpolation === "smoothstep") mix = mix * mix * (3 - 2 * mix);
    const lerp = (a: number, b: number): number => a + (b - a) * mix;
    return {
      t: phase, x: lerp(left.x, right.x), y: lerp(left.y, right.y),
      rotation: lerp(left.rotation, right.rotation), scale: lerp(left.scale, right.scale),
      scale_y: lerp(left.scale_y ?? 1, right.scale_y ?? 1), alpha: lerp(left.alpha, right.alpha)
    };
  }
  throw new Error("Missing review frame");
}

function contactSheet(pack: ValidatedCreatorPack, images: ReadonlyMap<string, Image>): Buffer {
  const width = 240 * PHASES.length, height = 250;
  const rgb = background(width, height);
  for (const [panel, phase] of PHASES.entries()) {
    for (const layer of pack.manifest.layers) {
      const image = images.get(layer.image);
      requireValue(image !== undefined);
      const interpolation = "interpolation" in layer ? layer.interpolation : "linear";
      requireValue(interpolation === "linear" || interpolation === "smoothstep");
      const frame = sample(layer.keyframes, phase, interpolation);
      const [x, y, w, h] = layer.frame;
      const ax = x + w * layer.anchor[0], ay = y + h * layer.anchor[1];
      const sx = frame.scale, sy = frame.scale * (frame.scale_y ?? 1);
      const radians = frame.rotation * Math.PI / 180;
      const cos = Math.cos(radians), sin = Math.sin(radians);
      requireValue([x, y, w, h, ax, ay, sx, sy, frame.x, frame.y, cos, sin, frame.alpha]
        .every(Number.isFinite) && w > 0 && h > 0 && sx > 0 && sy > 0 &&
        frame.alpha >= 0 && frame.alpha <= 1);
      // Inverse Canvas transform at pixel centers. Manifest coordinates are
      // bottom-left; PNG rows are top-left. Clip each panel to its full canvas.
      for (let py = 0; py < height; py += 1) {
        const dy = height - (py + 0.5) - ay - frame.y;
        for (let px = 0; px < 240; px += 1) {
          const dx = px + 0.5 - ax - frame.x;
          const localX = (cos * dx + sin * dy) / sx + ax;
          const localY = (-sin * dx + cos * dy) / sy + ay;
          const u = (localX - x) / w, v = (y + h - localY) / h;
          if (u < 0 || u >= 1 || v < 0 || v >= 1) continue;
          const ix = Math.floor(u * image.width), iy = Math.floor(v * image.height);
          composite(rgb, (py * width + panel * 240 + px) * 3, image,
            (iy * image.width + ix) * 4, frame.alpha);
        }
      }
    }
  }
  return encodePng(width, height, rgb);
}

/** Render trusted decoding inputs, not ZIPs or author code. No partial result on failure. */
export function renderCreatorReviewImages(pack: ValidatedCreatorPack): Array<{ name: string; data: Buffer }> {
  try {
    requireValue(pack.manifest.canvas_width === 240 && pack.manifest.canvas_height === 250 &&
      pack.manifest.layers.length >= 1 && pack.manifest.layers.length <= LIMITS.layers);
    const names = new Set([pack.manifest.preview, ...pack.manifest.layers.map(layer => layer.image)]);
    requireValue(names.size <= 7 && pack.images.length <= LIMITS.files - 1 &&
      pack.decodedImageBytes <= LIMITS.decodedImageBytes);
    const metadata = new Map(pack.images.map(image => [image.name, image]));
    requireValue(metadata.size === pack.images.length);
    let decodedBytes = 0, inputBytes = 0;
    // Preflight the entire decode budget before inflating any image.
    for (const name of names) {
      const meta = metadata.get(name), data = pack.files.get(name);
      requireValue(/^[a-z0-9][a-z0-9_-]{0,59}\.png$/u.test(name) && meta !== undefined && data !== undefined);
      requireValue(Number.isSafeInteger(meta.width) && Number.isSafeInteger(meta.height) &&
        meta.width >= 1 && meta.height >= 1 && meta.width <= LIMITS.imageDimension &&
        meta.height <= LIMITS.imageDimension);
      decodedBytes += meta.width * meta.height * 4;
      inputBytes += data.length;
    }
    requireValue(decodedBytes <= LIMITS.decodedImageBytes && inputBytes <= LIMITS.unpackedBytes);
    const images = new Map<string, Image>();
    for (const name of names) {
      const meta = metadata.get(name)!;
      images.set(name, decodePng(pack.files.get(name)!, meta.width, meta.height));
    }
    const output: Array<{ name: string; data: Buffer }> = [];
    let outputBytes = 0;
    const append = (name: string, data: Buffer): void => {
      outputBytes += data.length;
      requireValue(output.length < 8 && outputBytes <= OUTPUT_BYTES);
      output.push({ name, data });
    };
    append("preview-" + pack.manifest.preview, thumbnail(images.get(pack.manifest.preview)!));
    for (const [index, layer] of pack.manifest.layers.entries()) {
      append("layer-" + (index + 1) + "-" + layer.image, thumbnail(images.get(layer.image)!));
    }
    append("animation-contact-sheet.png", contactSheet(pack, images));
    return output;
  } catch {
    throw new CreatorError("creator_review_render_failed", 503);
  }
}
