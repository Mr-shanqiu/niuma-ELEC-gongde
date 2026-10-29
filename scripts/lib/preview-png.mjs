// Pure-Node PNG codec used to derive the website's lightweight preview assets.
//
// The site build runs with plain `node` in CI and on the release machine, so a
// native image dependency (sharp, canvas) would have to be installed and kept
// in step on every one of them. These packs are 8-bit RGBA, non-interlaced and
// always have been; that is asserted here rather than assumed. Anything else
// stops the build instead of being silently re-encoded wrongly.

import { deflateSync, inflateSync } from 'node:zlib';

const SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

export function decode(buffer) {
  if (buffer.length < 8 || !buffer.subarray(0, 8).equals(SIGNATURE)) {
    throw new Error('preview_png_signature_invalid');
  }
  let offset = 8, width = 0, height = 0, bitDepth = 0, colorType = 0, interlace = 0;
  const chunks = [];
  while (offset + 8 <= buffer.length) {
    const length = buffer.readUInt32BE(offset);
    const type = buffer.toString('ascii', offset + 4, offset + 8);
    const data = buffer.subarray(offset + 8, offset + 8 + length);
    if (offset + 12 + length > buffer.length) throw new Error('preview_png_truncated');
    offset += 12 + length;
    if (type === 'IHDR') {
      if (length !== 13) throw new Error('preview_png_header_invalid');
      width = data.readUInt32BE(0); height = data.readUInt32BE(4);
      bitDepth = data[8]; colorType = data[9]; interlace = data[12];
      if (data[10] !== 0 || data[11] !== 0) throw new Error('preview_png_compression_invalid');
    } else if (type === 'IDAT') chunks.push(data);
    else if (type === 'IEND') break;
    else if (type === 'PLTE' || type === 'tRNS' || type === 'sBIT') {
      throw new Error('preview_png_palette_unsupported');
    }
  }
  if (!width || !height) throw new Error('preview_png_header_missing');
  if (bitDepth !== 8 || colorType !== 6 || interlace !== 0) {
    throw new Error(`preview_png_format_unsupported_${bitDepth}_${colorType}_${interlace}`);
  }
  if (!chunks.length) throw new Error('preview_png_pixels_missing');
  const raw = inflateSync(Buffer.concat(chunks));
  const stride = width * 4;
  if (raw.length !== (stride + 1) * height) throw new Error('preview_png_pixels_truncated');
  const pixels = Buffer.alloc(stride * height);
  let previous = Buffer.alloc(stride);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)];
    const line = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    const out = pixels.subarray(y * stride, (y + 1) * stride);
    for (let x = 0; x < stride; x++) {
      const left = x >= 4 ? out[x - 4] : 0;
      const up = previous[x];
      const upLeft = x >= 4 ? previous[x - 4] : 0;
      let value = line[x];
      if (filter === 1) value += left;
      else if (filter === 2) value += up;
      else if (filter === 3) value += (left + up) >> 1;
      else if (filter === 4) {
        const estimate = left + up - upLeft;
        const toLeft = Math.abs(estimate - left);
        const toUp = Math.abs(estimate - up);
        const toUpLeft = Math.abs(estimate - upLeft);
        value += toLeft <= toUp && toLeft <= toUpLeft ? left : toUp <= toUpLeft ? up : upLeft;
      } else if (filter !== 0) throw new Error(`preview_png_filter_invalid_${filter}`);
      out[x] = value & 0xff;
    }
    previous = out;
  }
  return { width, height, pixels };
}

/**
 * Area-average downscale.
 *
 * Averaging happens in premultiplied space: a plain RGB average lets the
 * invisible colour under transparent pixels bleed into the visible edge, which
 * shows up as a dark or coloured fringe on artwork that is mostly transparent.
 */
export function resize(source, width, height) {
  const { width: sourceWidth, height: sourceHeight, pixels } = source;
  if (width === sourceWidth && height === sourceHeight) return source;
  const out = Buffer.alloc(width * height * 4);
  const ratioX = sourceWidth / width, ratioY = sourceHeight / height;
  for (let y = 0; y < height; y++) {
    const top = y * ratioY, bottom = Math.min(sourceHeight, (y + 1) * ratioY);
    for (let x = 0; x < width; x++) {
      const left = x * ratioX, right = Math.min(sourceWidth, (x + 1) * ratioX);
      let red = 0, green = 0, blue = 0, alpha = 0, weight = 0;
      for (let sy = Math.floor(top); sy < Math.ceil(bottom); sy++) {
        const rowWeight = Math.min(bottom, sy + 1) - Math.max(top, sy);
        if (rowWeight <= 0) continue;
        for (let sx = Math.floor(left); sx < Math.ceil(right); sx++) {
          const columnWeight = Math.min(right, sx + 1) - Math.max(left, sx);
          if (columnWeight <= 0) continue;
          const area = columnWeight * rowWeight;
          const index = (sy * sourceWidth + sx) * 4;
          const sample = pixels[index + 3];
          red += pixels[index] * sample * area;
          green += pixels[index + 1] * sample * area;
          blue += pixels[index + 2] * sample * area;
          alpha += sample * area;
          weight += area;
        }
      }
      const target = (y * width + x) * 4;
      out[target + 3] = weight ? Math.round(alpha / weight) : 0;
      if (alpha > 0) {
        out[target] = Math.min(255, Math.round(red / alpha));
        out[target + 1] = Math.min(255, Math.round(green / alpha));
        out[target + 2] = Math.min(255, Math.round(blue / alpha));
      }
    }
  }
  return { width, height, pixels: out };
}

/** Crop a rectangle out of a decoded image. Bounds are clamped to the image. */
export function crop(source, left, top, width, height) {
  const x0 = Math.max(0, Math.min(source.width - 1, Math.round(left)));
  const y0 = Math.max(0, Math.min(source.height - 1, Math.round(top)));
  const w = Math.max(1, Math.min(source.width - x0, Math.round(width)));
  const h = Math.max(1, Math.min(source.height - y0, Math.round(height)));
  if (x0 === 0 && y0 === 0 && w === source.width && h === source.height) return source;
  const pixels = Buffer.alloc(w * h * 4);
  for (let y = 0; y < h; y++) {
    source.pixels.copy(pixels, y * w * 4, ((y0 + y) * source.width + x0) * 4, ((y0 + y) * source.width + x0 + w) * 4);
  }
  return { width: w, height: h, pixels };
}

/** Bounding box of pixels at or above an alpha threshold, or null when empty. */
export function alphaBounds(source, threshold = 1) {
  const { width, height, pixels } = source;
  let left = width, top = height, right = -1, bottom = -1;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (pixels[(y * width + x) * 4 + 3] < threshold) continue;
      if (x < left) left = x;
      if (x > right) right = x;
      if (y < top) top = y;
      if (y > bottom) bottom = y;
    }
  }
  return right < 0 ? null : { left, top, right: right + 1, bottom: bottom + 1 };
}

let crcTable = null;
function crc32(buffer) {
  if (!crcTable) {
    crcTable = new Int32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      crcTable[n] = c;
    }
  }
  let crc = -1;
  for (const byte of buffer) crc = crcTable[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ -1) >>> 0;
}

function chunk(type, data) {
  const head = Buffer.alloc(4);
  head.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([head, body, crc]);
}

/**
 * Encode as 8-bit RGBA PNG with per-row adaptive filtering.
 *
 * Soft artwork gradients gain most from Paeth, so each row picks its filter by
 * the usual minimum-sum-of-absolute-differences heuristic. Compression level 9
 * costs a few hundred milliseconds per pack and is worth it: these files are
 * downloaded once per first visit and then cached for a year.
 */
export function encode({ width, height, pixels }) {
  const stride = width * 4;
  const rows = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    const line = pixels.subarray(y * stride, (y + 1) * stride);
    const prior = y ? pixels.subarray((y - 1) * stride, y * stride) : Buffer.alloc(stride);
    let bestFilter = 0, bestScore = Infinity, bestRow = null;
    for (const filter of [0, 1, 2, 3, 4]) {
      const candidate = Buffer.alloc(stride);
      let score = 0;
      for (let x = 0; x < stride; x++) {
        const left = x >= 4 ? line[x - 4] : 0;
        const up = prior[x];
        const upLeft = x >= 4 ? prior[x - 4] : 0;
        let predicted = 0;
        if (filter === 1) predicted = left;
        else if (filter === 2) predicted = up;
        else if (filter === 3) predicted = (left + up) >> 1;
        else if (filter === 4) {
          const estimate = left + up - upLeft;
          const toLeft = Math.abs(estimate - left);
          const toUp = Math.abs(estimate - up);
          const toUpLeft = Math.abs(estimate - upLeft);
          predicted = toLeft <= toUp && toLeft <= toUpLeft ? left : toUp <= toUpLeft ? up : upLeft;
        }
        const value = (line[x] - predicted) & 0xff;
        candidate[x] = value;
        score += value < 128 ? value : 256 - value;
      }
      if (score < bestScore) { bestScore = score; bestFilter = filter; bestRow = candidate; }
    }
    rows[y * (stride + 1)] = bestFilter;
    bestRow.copy(rows, y * (stride + 1) + 1);
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8; header[9] = 6; header[10] = 0; header[11] = 0; header[12] = 0;
  return Buffer.concat([
    SIGNATURE,
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(rows, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}
