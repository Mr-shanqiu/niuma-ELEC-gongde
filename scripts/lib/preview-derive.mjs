// Static web derivatives of the official appearance packs.
//
// The published packs are delivery sources: full-resolution PNG layers that the
// desktop client imports. Serving those to a browser costs megabytes per page
// and the gallery only ever shows them inside a 240x170 canvas. This module
// derives a smaller set that the site can serve as ordinary immutable images:
//
//   cover.svg      the player's initial pose, with embedded small PNG layers
//   <layer>.png    each animation layer at display resolution
//
// What is deliberately *not* changed: the manifest. Frames, anchors, keyframes,
// canvas size and layer order are copied byte-for-byte in meaning, so the
// renderer draws exactly the same artwork at the same position. Only the image
// bytes behind each layer name are smaller. Client delivery packages are never
// touched.

import { createHash } from 'node:crypto';
import { stillSVG } from './preview-still.mjs';
import { alphaBounds, decode, encode, resize } from './preview-png.mjs';

/**
 * Bump when the derivation changes in a way that alters the pixels.
 *
 * It is part of every derived revision, so a change here retires the previous
 * derived directory instead of leaving two incompatible sets resolvable.
 */
export const DERIVATION_RULE = 'web-derivative-v4-first-frame';

/** Animation layers are drawn at 2x their design size: the card canvas is
 *  240x170 CSS pixels and most visitors are on a 2x-density display. */
export const LAYER_SCALE = 2;

/** Covers are fitted into the largest box the card ever displays at 2x. */
export const COVER_WIDTH = 480;
export const COVER_HEIGHT = 340;

/** The native woodfish has no manifest; its two files cover the same band. */
export const LAYER_WIDTH = 240 * LAYER_SCALE;
export const LAYER_HEIGHT = 170 * LAYER_SCALE;

/** Content hash of one pack directory, the same formula the delivery signer uses. */
export function packRevision(files) {
  const lines = Object.keys(files).sort().map((name) =>
    `${name}\0${createHash('sha256').update(files[name]).digest('hex')}\n`);
  return createHash('sha256').update(lines.join('')).digest('hex');
}

function fit(width, height, maximumWidth, maximumHeight) {
  const scale = Math.min(maximumWidth / width, maximumHeight / height, 1);
  return { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) };
}

// Palette-ish PNG: collapse each channel to 32 levels (round to multiples of
// 8). 255 must clamp to 248, the largest multiple of 8 in range: without the
// clamp, round(255/8)*8 is 256, which wraps a bright pixel's channel to 0 and
// turned warm whites into neon green on the live site once. Worst error stays
// 7/255. Alpha keeps its range except for clamping the invisible ends.
export function quantize(image) {
  const out = Buffer.alloc(image.pixels.length);
  for (let i = 0; i < out.length; i += 4) {
    out[i] = Math.min(248, Math.round(image.pixels[i] / 8) * 8);
    out[i + 1] = Math.min(248, Math.round(image.pixels[i + 1] / 8) * 8);
    out[i + 2] = Math.min(248, Math.round(image.pixels[i + 2] / 8) * 8);
    const alpha = image.pixels[i + 3];
    out[i + 3] = alpha < 8 ? 0 : alpha > 247 ? 255 : alpha;
  }
  return { width: image.width, height: image.height, pixels: out };
}

/**
 * Derive one pack.
 *
 * @param {object} pack  `{ slug, manifest, files: { name: Buffer } }`
 * @returns {{ cover: Buffer, layers: Record<string, Buffer>, stats: object }}
 */
export function derivePack({ slug, manifest, files }) {
  const coverName = manifest.preview;
  if (typeof coverName !== 'string' || !files[coverName]) {
    throw new Error(`${slug}: manifest preview image is missing`);
  }
  const coverSource = decode(files[coverName]);
  const bounds = alphaBounds(coverSource, 8);
  if (!bounds) throw new Error(`${slug}: cover image is fully transparent`);
  // The original preview is validated above, but the displayed still follows
  // the actual layer geometry instead of a differently framed poster.
  let cover;

  const layers = {};
  const stats = { slug, layers: {} };
  for (const layer of manifest.layers) {
    const name = layer.image;
    const source = files[name];
    if (!source) throw new Error(`${slug}: layer ${name} is missing`);
    const frame = layer.frame;
    if (!Array.isArray(frame) || frame.length !== 4) throw new Error(`${slug}: layer ${name} has no frame`);
    const [, , frameWidth, frameHeight] = frame.map(Number);
    if (!(frameWidth > 0) || !(frameHeight > 0)) throw new Error(`${slug}: layer ${name} has an empty frame`);
    const image = decode(source);
    // Never upscale: a source smaller than the target is published as-is so the
    // derivative can only ever lose detail, never invent it.
    const target = fit(image.width, image.height, frameWidth * LAYER_SCALE, frameHeight * LAYER_SCALE);
    const derived = encode(quantize(resize(image, target.width, target.height)));
    layers[name] = derived;
    stats.layers[name] = { bytes: derived.length, width: target.width, height: target.height, sourceBytes: source.length };
  }
  cover = stillSVG(manifest, layers);
  stats.cover = { bytes: cover.length, width: COVER_WIDTH, height: COVER_HEIGHT };
  return { cover, layers, stats };
}

/**
 * A derived revision identifies this exact set of bytes plus the rule and the
 * pack revision they came from. Anything that would change the pixels changes
 * it; nothing else does.
 */
export function derivedRevision({ assetId, previewRevision, cover, layers }) {
  const parts = [`rule\0${DERIVATION_RULE}\n`, `asset\0${assetId}\n`, `preview\0${previewRevision}\n`,
    `cover\0${createHash('sha256').update(cover).digest('hex')}\n`];
  for (const name of Object.keys(layers).sort()) {
    parts.push(`layer\0${name}\0${createHash('sha256').update(layers[name]).digest('hex')}\n`);
  }
  return createHash('sha256').update(parts.join('')).digest('hex');
}
