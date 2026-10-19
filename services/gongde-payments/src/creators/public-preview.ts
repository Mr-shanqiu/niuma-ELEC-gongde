import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { open, readdir, realpath } from "node:fs/promises";
import { join } from "node:path";
import type { IncomingMessage, ServerResponse } from "node:http";
import { z } from "zod";
import { decodePng, encodeRgbaPng } from "./review-renderer.js";
import { CREATOR_UPLOAD_LIMITS as LIMITS } from "./policy.js";
import { CreatorError } from "./types.js";
import type { CreatorSourceStore } from "./object-store.js";
import type { FreeVersionRecord } from "./repository.js";
import type { ValidatedCreatorPack } from "./pack-validation.js";
import type { OfficialCatalogEntry } from "../delivery/pack-signer.js";

export const PUBLIC_PREVIEW_RENDERER_VERSION = "public-preview-v1";
export const PUBLIC_PREVIEW_PROFILE = "card-480x340-v1";
export const PUBLIC_PREVIEW_MAX_BYTES = 4 * 1024 * 1024;
const WIDTH = 480, HEIGHT = 340, PAD = 8;
const sha = (data: Buffer | string) => createHash("sha256").update(data).digest("hex");
const hash = z.string().regex(/^[a-f0-9]{64}$/u);
const finite = (min: number, max: number) => z.number().finite().min(min).max(max);
const frameSchema = z.object({ t: finite(0, 1), x: finite(-480, 480), y: finite(-480, 480),
  rotation: finite(-180, 180), scale: finite(0.1, 4), scale_y: finite(0.1, 4).optional(), alpha: finite(0, 1) });
const layerSchema = z.object({ image: z.string().regex(/^[a-z0-9][a-z0-9_-]{0,59}\.png$/u),
  frame: z.tuple([finite(-240, 480), finite(-250, 480), finite(1, 480), finite(1, 480)]),
  anchor: z.tuple([finite(0, 1), finite(0, 1)]), interpolation: z.enum(["linear", "smoothstep"]).optional(),
  keyframes: z.array(frameSchema).min(1).max(LIMITS.keyframesPerLayer) });
const sourceSchema = z.object({ schema_version: z.union([z.literal(1), z.literal(3)]),
  id: z.string().min(1).max(100), version: z.string().min(1).max(32),
  canvas_width: finite(1, 2048), canvas_height: finite(1, 2048),
  layers: z.array(layerSchema).min(1).max(LIMITS.layers) });
type Frame = z.infer<typeof frameSchema>;
type SourceLayer = z.infer<typeof layerSchema>;
type Image = ReturnType<typeof decodePng>;
type Range = [number, number];

const identitySchema = z.discriminatedUnion("sourceKind", [
  z.object({ sourceKind: z.literal("community"), sourceId: z.string().regex(/^creator\.[a-f0-9]{32}\.[a-z0-9][a-z0-9-]{0,31}$/u),
    versionId: z.string().regex(/^[a-f0-9]{32}$/u), sourceRevision: hash }).strict(),
  z.object({ sourceKind: z.literal("official"), sourceId: z.string().regex(/^[a-z][a-z0-9.-]{2,79}$/u),
    versionId: z.string().min(1).max(32).regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/u), sourceRevision: hash }).strict()
]);
export type PublicPreviewIdentity = z.infer<typeof identitySchema>;
export interface PublicPreviewManifest {
  schema_version: 3; id: string; version: string; canvas_width: 480; canvas_height: 340;
  preview: "cover.png"; plus_y: number;
  layers: Array<Omit<SourceLayer, "interpolation"> & { interpolation: "linear" | "smoothstep" }>;
}
interface Asset { name: string; sha256: string; bytes: number; width: number; height: number; }
export interface PublicPreviewRecord {
  revision: string; identity: PublicPreviewIdentity; rendererVersion: string; profile: string;
  manifest: PublicPreviewManifest; assets: Asset[];
  coordinates: { origin: "bottom-left"; scale: number; offsetX: number; offsetY: number; sourceBounds: number[] };
}
export interface PublicPreviewPayload {
  revision: string; sourceRevision: string; rendererVersion: string; profile: string;
  coverUrl: string; coverWidth: number; coverHeight: number;
  manifest: PublicPreviewManifest; images: Record<string, string>;
  coordinates: PublicPreviewRecord["coordinates"];
}
function requireValue(value: unknown): asserts value {
  if (!value) throw new CreatorError("creator_public_preview_invalid", 503);
}
export function publicPreviewRevision(identity: PublicPreviewIdentity): string {
  requireValue(identitySchema.safeParse(identity).success);
  return sha(JSON.stringify([identity.sourceKind, identity.sourceId, identity.versionId, identity.sourceRevision,
    PUBLIC_PREVIEW_RENDERER_VERSION, PUBLIC_PREVIEW_PROFILE]));
}
export function creatorPreviewIdentity(version: Pick<FreeVersionRecord, "workId" | "versionId" | "revision">): PublicPreviewIdentity {
  return { sourceKind: "community", sourceId: version.workId, versionId: version.versionId, sourceRevision: version.revision };
}
export function officialPreviewIdentity(assetId: string, entry: OfficialCatalogEntry): PublicPreviewIdentity {
  return { sourceKind: "official", sourceId: assetId, versionId: entry.version, sourceRevision: entry.revision };
}
export function publicPreviewBase(identity: PublicPreviewIdentity): string {
  const revision = publicPreviewRevision(identity);
  return identity.sourceKind === "community" ?
    `/api/gongde/community/versions/${identity.versionId}/previews/${revision}` :
    `/api/gongde/v2/previews/official/${identity.sourceId}/${revision}`;
}
function assetName(name: string): boolean { return /^(?:cover|layer-[0-5])\.png$/u.test(name); }
function rangeProduct(a: Range, b: Range): Range {
  const values = [a[0] * b[0], a[0] * b[1], a[1] * b[0], a[1] * b[1]];
  return [Math.min(...values), Math.max(...values)];
}
function trigRange(low: number, high: number, sine: boolean): Range {
  const fn = sine ? Math.sin : Math.cos, values = [fn(low), fn(high)];
  const shift = sine ? Math.PI / 2 : 0;
  for (let k = Math.ceil((low - shift) / Math.PI); shift + k * Math.PI <= high; k += 1) values.push(fn(shift + k * Math.PI));
  return [Math.min(...values), Math.max(...values)];
}
function alphaBounds(image: Image): [number, number, number, number] | null {
  let left = image.width, top = image.height, right = -1, bottom = -1;
  for (let y = 0; y < image.height; y += 1) for (let x = 0; x < image.width; x += 1) {
    if (!image.rgba[(y * image.width + x) * 4 + 3]) continue;
    left = Math.min(left, x); right = Math.max(right, x); top = Math.min(top, y); bottom = Math.max(bottom, y);
  }
  return right < 0 ? null : [left / image.width, 1 - (bottom + 1) / image.height,
    (right + 1) / image.width, 1 - top / image.height];
}
// Interval bounds include every intermediate rotation and scale, not just the
// sampled review/contact-sheet frames. Transparent source margins do not shrink
// the visible character; layer frames/anchors themselves are left intact.
function motionBounds(layers: SourceLayer[], images: ReadonlyMap<string, Image>): [number, number, number, number] {
  let left = Infinity, bottom = Infinity, right = -Infinity, top = -Infinity;
  for (const layer of layers) {
    const pixels = alphaBounds(images.get(layer.image)!);
    if (!pixels) continue;
    const [x, y, w, h] = layer.frame, [u, v] = layer.anchor;
    for (let index = 0; index < layer.keyframes.length; index += 1) {
      const a = layer.keyframes[index], b = layer.keyframes[index + 1] ?? a;
      if (Math.max(a.alpha, b.alpha) === 0) continue;
      const sx: Range = [Math.min(a.scale, b.scale), Math.max(a.scale, b.scale)];
      const sy = rangeProduct(sx, [Math.min(a.scale_y ?? 1, b.scale_y ?? 1), Math.max(a.scale_y ?? 1, b.scale_y ?? 1)]);
      const radians: Range = [Math.min(a.rotation, b.rotation) * Math.PI / 180, Math.max(a.rotation, b.rotation) * Math.PI / 180];
      const cos = trigRange(...radians, false), sin = trigRange(...radians, true);
      for (const px of [pixels[0], pixels[2]]) for (const py of [pixels[1], pixels[3]]) {
        const dx = rangeProduct([(px - u) * w, (px - u) * w], sx);
        const dy = rangeProduct([(py - v) * h, (py - v) * h], sy);
        const cx = rangeProduct(dx, cos), ys = rangeProduct(dy, sin);
        const xs = rangeProduct(dx, sin), cy = rangeProduct(dy, cos);
        left = Math.min(left, x + w * u + Math.min(a.x, b.x) + cx[0] - ys[1]);
        right = Math.max(right, x + w * u + Math.max(a.x, b.x) + cx[1] - ys[0]);
        bottom = Math.min(bottom, y + h * v + Math.min(a.y, b.y) + xs[0] + cy[0]);
        top = Math.max(top, y + h * v + Math.max(a.y, b.y) + xs[1] + cy[1]);
      }
    }
  }
  requireValue([left, bottom, right, top].every(Number.isFinite) && right > left && top > bottom);
  return [left, bottom, right, top];
}
function pixel(image: Image, x: number, y: number): [number, number, number, number] {
  const floorX = Math.floor(x), floorY = Math.floor(y), dx = x - floorX, dy = y - floorY;
  const output = [0, 0, 0, 0];
  for (let yy = 0; yy < 2; yy += 1) for (let xx = 0; xx < 2; xx += 1) {
    const sx = Math.max(0, Math.min(image.width - 1, floorX + xx));
    const sy = Math.max(0, Math.min(image.height - 1, floorY + yy));
    const offset = (sy * image.width + sx) * 4;
    const weight = (xx ? dx : 1 - dx) * (yy ? dy : 1 - dy) * image.rgba[offset + 3] / 255;
    output[3] += weight;
    for (let channel = 0; channel < 3; channel += 1) output[channel] += image.rgba[offset + channel] * weight;
  }
  return [output[3] ? Math.round(output[0] / output[3]) : 0, output[3] ? Math.round(output[1] / output[3]) : 0,
    output[3] ? Math.round(output[2] / output[3]) : 0, Math.round(output[3] * 255)];
}
function resize(image: Image, width: number, height: number): Buffer {
  const rgba = Buffer.alloc(width * height * 4);
  for (let y = 0; y < height; y += 1) for (let x = 0; x < width; x += 1) {
    const color = pixel(image, (x + 0.5) * image.width / width - 0.5, (y + 0.5) * image.height / height - 0.5);
    for (let c = 0; c < 4; c += 1) rgba[(y * width + x) * 4 + c] = color[c];
  }
  return encodeRgbaPng(width, height, rgba);
}
function cover(manifest: PublicPreviewManifest, source: SourceLayer[], images: ReadonlyMap<string, Image>): Buffer {
  const width = 240, height = 170, rgba = Buffer.alloc(width * height * 4);
  for (const [index, layer] of manifest.layers.entries()) {
    const image = images.get(source[index].image)!, frame = layer.keyframes[0];
    const [x, y, w, h] = layer.frame, ax = x + w * layer.anchor[0], ay = y + h * layer.anchor[1];
    const angle = frame.rotation * Math.PI / 180, cos = Math.cos(angle), sin = Math.sin(angle);
    for (let py = 0; py < height; py += 1) for (let px = 0; px < width; px += 1) {
      const dx = (px + 0.5) * 2 - ax - frame.x, dy = HEIGHT - (py + 0.5) * 2 - ay - frame.y;
      const localX = (cos * dx + sin * dy) / frame.scale + ax;
      const localY = (-sin * dx + cos * dy) / (frame.scale * (frame.scale_y ?? 1)) + ay;
      const u = (localX - x) / w, v = (y + h - localY) / h;
      if (u < 0 || u >= 1 || v < 0 || v >= 1) continue;
      const color = pixel(image, u * image.width - 0.5, v * image.height - 0.5), offset = (py * width + px) * 4;
      const opacity = color[3] / 255 * frame.alpha, previous = rgba[offset + 3] / 255, alpha = opacity + previous * (1 - opacity);
      if (!alpha) continue;
      for (let c = 0; c < 3; c += 1) rgba[offset + c] = Math.round((color[c] * opacity + rgba[offset + c] * previous * (1 - opacity)) / alpha);
      rgba[offset + 3] = Math.round(alpha * 255);
    }
  }
  return encodeRgbaPng(width, height, rgba);
}

/** Pure, bounded derivation. Does not mutate or sign the source package. */
export function renderPublicPreview(identity: PublicPreviewIdentity, rawManifest: unknown, files: ReadonlyMap<string, Buffer>) {
  const parsed = sourceSchema.safeParse(rawManifest);
  requireValue(parsed.success);
  const source = parsed.data, revision = publicPreviewRevision(identity);
  requireValue(source.id === identity.sourceId && source.version === identity.versionId || identity.sourceKind === "community");
  const names = new Set(source.layers.map(layer => layer.image));
  let decodedBytes = 0, inputBytes = 0;
  for (const layer of source.layers) {
    requireValue(layer.keyframes.every((frame, index, frames) => index === 0 || frame.t > frames[index - 1].t));
  }
  // Bound the whole decode before starting any inflate/allocation.
  for (const name of names) {
    const bytes = files.get(name);
    requireValue(bytes && bytes.length >= 33);
    const width = bytes.readUInt32BE(16), height = bytes.readUInt32BE(20);
    requireValue(width >= 1 && height >= 1 && width <= LIMITS.imageDimension && height <= LIMITS.imageDimension);
    decodedBytes += width * height * 4; inputBytes += bytes.length;
  }
  requireValue(decodedBytes <= LIMITS.decodedImageBytes && inputBytes <= LIMITS.unpackedBytes);
  const images = new Map<string, Image>();
  for (const name of names) {
    const bytes = files.get(name)!;
    images.set(name, decodePng(bytes, bytes.readUInt32BE(16), bytes.readUInt32BE(20)));
  }
  const bounds = motionBounds(source.layers, images), scale = Math.min((WIDTH - PAD * 2) / (bounds[2] - bounds[0]),
    (HEIGHT - PAD * 2) / (bounds[3] - bounds[1]));
  const offsetX = (WIDTH - (bounds[2] - bounds[0]) * scale) / 2 - bounds[0] * scale;
  const offsetY = (HEIGHT - (bounds[3] - bounds[1]) * scale) / 2 - bounds[1] * scale;
  const manifest: PublicPreviewManifest = { schema_version: 3, id: source.id, version: source.version,
    canvas_width: WIDTH, canvas_height: HEIGHT, preview: "cover.png", plus_y: 0,
    layers: source.layers.map((layer, index) => ({ image: `layer-${index}.png`,
      frame: [layer.frame[0] * scale + offsetX, layer.frame[1] * scale + offsetY, layer.frame[2] * scale, layer.frame[3] * scale],
      anchor: [...layer.anchor], interpolation: layer.interpolation ?? "linear",
      keyframes: layer.keyframes.map(frame => ({ ...frame, x: frame.x * scale, y: frame.y * scale, scale_y: frame.scale_y ?? 1 })) })) };
  const output = new Map<string, Buffer>(), assets: Asset[] = [];
  const append = (name: string, bytes: Buffer, width: number, height: number) => {
    requireValue(bytes.length <= 1024 * 1024 && assets.reduce((n, asset) => n + asset.bytes, bytes.length) <= PUBLIC_PREVIEW_MAX_BYTES);
    output.set(name, bytes); assets.push({ name, sha256: sha(bytes), bytes: bytes.length, width, height });
  };
  append("cover.png", cover(manifest, source.layers, images), 240, 170);
  for (const [index, layer] of source.layers.entries()) {
    const image = images.get(layer.image)!, transformed = manifest.layers[index];
    const maximumScale = Math.max(...layer.keyframes.map(frame => frame.scale));
    const maximumY = Math.max(...layer.keyframes.map(frame => frame.scale_y ?? 1));
    const width = Math.max(1, Math.min(image.width, WIDTH, Math.ceil(transformed.frame[2] * maximumScale)));
    const height = Math.max(1, Math.min(image.height, HEIGHT, Math.ceil(transformed.frame[3] * maximumScale * maximumY)));
    append(transformed.image, resize(image, width, height), width, height);
  }
  const record: PublicPreviewRecord = { revision, identity: { ...identity }, rendererVersion: PUBLIC_PREVIEW_RENDERER_VERSION,
    profile: PUBLIC_PREVIEW_PROFILE, manifest, assets,
    coordinates: { origin: "bottom-left", scale, offsetX, offsetY, sourceBounds: bounds } };
  return { record, files: output };
}

function decodeRecord(bytes: Buffer, identity: PublicPreviewIdentity): PublicPreviewRecord {
  requireValue(bytes.length > 0 && bytes.length <= 65536);
  const record = JSON.parse(bytes.toString("utf8")) as PublicPreviewRecord;
  requireValue(record && record.revision === publicPreviewRevision(identity) &&
    identitySchema.safeParse(record.identity).success && publicPreviewRevision(record.identity) === record.revision &&
    record.rendererVersion === PUBLIC_PREVIEW_RENDERER_VERSION && record.profile === PUBLIC_PREVIEW_PROFILE &&
    record.manifest?.canvas_width === WIDTH && record.manifest.canvas_height === HEIGHT &&
    record.manifest.schema_version === 3 && Array.isArray(record.manifest.layers) &&
    record.manifest.layers.length >= 1 && record.manifest.layers.length <= LIMITS.layers &&
    Array.isArray(record.assets) && record.assets.length === record.manifest.layers.length + 1);
  const names = new Set<string>();
  for (const asset of record.assets) {
    requireValue(asset && assetName(asset.name) && !names.has(asset.name) && hash.safeParse(asset.sha256).success &&
      Number.isInteger(asset.bytes) && asset.bytes > 0 && asset.bytes <= 1024 * 1024 &&
      Number.isInteger(asset.width) && asset.width >= 1 && asset.width <= WIDTH &&
      Number.isInteger(asset.height) && asset.height >= 1 && asset.height <= HEIGHT);
    names.add(asset.name);
  }
  requireValue(names.has("cover.png") && record.assets.reduce((n, asset) => n + asset.bytes, 0) <= PUBLIC_PREVIEW_MAX_BYTES);
  for (const [index, layer] of record.manifest.layers.entries()) {
    requireValue(layer.image === `layer-${index}.png` && names.has(layer.image) &&
      Array.isArray(layer.frame) && layer.frame.length === 4 && layer.frame.every(Number.isFinite) &&
      layer.frame[2] > 0 && layer.frame[3] > 0 && Array.isArray(layer.anchor) && layer.anchor.length === 2 &&
      layer.anchor.every(value => Number.isFinite(value) && value >= 0 && value <= 1) &&
      ["linear", "smoothstep"].includes(layer.interpolation) && Array.isArray(layer.keyframes) &&
      layer.keyframes.length >= 1 && layer.keyframes.length <= LIMITS.keyframesPerLayer);
    for (const [i, frame] of layer.keyframes.entries()) requireValue([frame.t, frame.x, frame.y, frame.rotation,
      frame.scale, frame.scale_y, frame.alpha].every(Number.isFinite) && frame.t >= 0 && frame.t <= 1 &&
      (i === 0 || frame.t > layer.keyframes[i - 1].t) && frame.scale > 0 && frame.scale_y! > 0 && frame.alpha >= 0 && frame.alpha <= 1);
  }
  requireValue(record.coordinates?.origin === "bottom-left" && record.coordinates.scale > 0 &&
    [record.coordinates.scale, record.coordinates.offsetX, record.coordinates.offsetY].every(Number.isFinite));
  return record;
}
export function publicPreviewPayload(record: PublicPreviewRecord): PublicPreviewPayload {
  const base = publicPreviewBase(record.identity);
  return { revision: record.revision, sourceRevision: record.identity.sourceRevision,
    rendererVersion: record.rendererVersion, profile: record.profile, coverUrl: `${base}/cover.png`,
    coverWidth: 240, coverHeight: 170, manifest: structuredClone(record.manifest),
    coordinates: structuredClone(record.coordinates),
    images: Object.fromEntries(record.assets.map(asset => [asset.name, `${base}/${asset.name}`])) };
}

/** Durable private objects, public projection only after a caller proves publication. */
export class PublicPreviewStore {
  readonly #records = new Map<string, { until: number; record: PublicPreviewRecord | null }>();
  readonly #images = new Map<string, Buffer>();
  readonly #preparing = new Map<string, Promise<PublicPreviewRecord>>();
  readonly #lookups = new Map<string, Promise<PublicPreviewRecord | null>>();
  readonly #readWaiters: Array<() => void> = [];
  #activeReads = 0;
  #imageBytes = 0;
  #ioTail: Promise<unknown> = Promise.resolve();
  #queued = 0;
  constructor(readonly objects: Pick<CreatorSourceStore, "publicPreviewManifest" | "publicPreviewImage" | "putPublicPreview">) {}
  async #io<T>(operation: () => Promise<T>): Promise<T> {
    if (this.#queued >= 32) throw new CreatorError("creator_public_preview_busy", 503);
    this.#queued += 1;
    const pending = this.#ioTail.then(operation);
    this.#ioTail = pending.catch(() => {});
    try { return await pending; } finally { this.#queued -= 1; }
  }
  async #read<T>(operation: () => Promise<T>): Promise<T> {
    if (this.#queued >= 32) throw new CreatorError("creator_public_preview_busy", 503);
    this.#queued += 1;
    if (this.#activeReads < 4) this.#activeReads += 1;
    else await new Promise<void>(resolve => this.#readWaiters.push(resolve));
    try { return await operation(); }
    finally {
      this.#queued -= 1;
      const next = this.#readWaiters.shift();
      // Transfer the reserved slot directly: a new reader cannot steal it.
      if (next) next();
      else this.#activeReads -= 1;
    }
  }
  #remember(revision: string, record: PublicPreviewRecord | null) {
    this.#records.delete(revision);
    this.#records.set(revision, { record, until: Date.now() + (record ? 900000 : 10000) });
    while (this.#records.size > 256) this.#records.delete(this.#records.keys().next().value!);
  }
  async lookup(identity: PublicPreviewIdentity): Promise<PublicPreviewRecord | null> {
    const revision = publicPreviewRevision(identity), cached = this.#records.get(revision);
    if (cached && cached.until > Date.now()) return cached.record;
    const existing = this.#lookups.get(revision);
    if (existing) return existing;
    const pending = (async () => {
      const bytes = await this.#read(() => this.objects.publicPreviewManifest(revision));
      const record = bytes ? decodeRecord(bytes, identity) : null;
      this.#remember(revision, record); return record;
    })();
    this.#lookups.set(revision, pending);
    try { return await pending; }
    finally { this.#lookups.delete(revision); }
  }
  async payload(identity: PublicPreviewIdentity): Promise<PublicPreviewPayload | null> {
    // A derivative/storage failure does not hide an otherwise valid old card.
    try { const record = await this.lookup(identity); return record ? publicPreviewPayload(record) : null; }
    catch { return null; }
  }
  async prepare(identity: PublicPreviewIdentity, manifest: unknown, files: ReadonlyMap<string, Buffer>): Promise<PublicPreviewRecord> {
    const revision = publicPreviewRevision(identity), existing = this.#preparing.get(revision);
    if (existing) return existing;
    if (this.#preparing.size >= 2) throw new CreatorError("creator_public_preview_busy", 503);
    const pending = (async () => {
      const stored = await this.lookup(identity);
      if (stored) return stored;
      const result = renderPublicPreview(identity, manifest, files);
      await this.#io(() => this.objects.putPublicPreview(revision, result.files, Buffer.from(JSON.stringify(result.record))));
      this.#remember(revision, result.record); return result.record;
    })();
    this.#preparing.set(revision, pending);
    try { return await pending; } finally { this.#preparing.delete(revision); }
  }
  async image(identity: PublicPreviewIdentity, revision: string, name: string): Promise<{ bytes: Buffer; sha256: string }> {
    if (revision !== publicPreviewRevision(identity) || !assetName(name)) throw new CreatorError("creator_image_not_found", 404);
    const record = await this.lookup(identity), asset = record?.assets.find(item => item.name === name);
    if (!asset) throw new CreatorError("creator_image_not_found", 404);
    const key = `${revision}/${name}`;
    let bytes = this.#images.get(key);
    if (!bytes) {
      bytes = await this.#read(() => this.objects.publicPreviewImage(revision, name));
      if (bytes.length !== asset.bytes || sha(bytes) !== asset.sha256) throw new CreatorError("creator_public_preview_integrity_failed", 503);
      this.#images.set(key, bytes); this.#imageBytes += bytes.length;
      while (this.#images.size > 64 || this.#imageBytes > 32 * 1024 * 1024) {
        const oldest = this.#images.keys().next().value!;
        this.#imageBytes -= this.#images.get(oldest)!.length; this.#images.delete(oldest);
      }
    } else { this.#images.delete(key); this.#images.set(key, bytes); }
    return { bytes, sha256: asset.sha256 };
  }
}
const stores = new WeakMap<CreatorSourceStore, PublicPreviewStore>();
export function publicPreviewStore(objects: CreatorSourceStore): PublicPreviewStore {
  let store = stores.get(objects);
  if (!store) { store = new PublicPreviewStore(objects); stores.set(objects, store); }
  return store;
}
export async function prepareCreatorPublicPreview(objects: CreatorSourceStore, version: FreeVersionRecord, pack: ValidatedCreatorPack) {
  if (pack.revision !== version.revision || pack.archiveSha256 !== version.archiveSha256 || pack.manifest.id !== version.workId) {
    throw new CreatorError("creator_source_integrity_failed", 503);
  }
  return publicPreviewStore(objects).prepare(creatorPreviewIdentity(version), pack.manifest, pack.files);
}
export async function loadOfficialPublicPreview(root: string, assetId: string, entry: OfficialCatalogEntry) {
  requireValue(/^[a-z0-9][a-z0-9-]{0,63}$/u.test(entry.previewDirectory));
  const directory = join(root, entry.previewDirectory);
  requireValue(await realpath(directory) === directory);
  const entries = (await readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name, "en"));
  requireValue(entries.length >= 2 && entries.length <= LIMITS.files);
  const files = new Map<string, Buffer>();
  let total = 0;
  for (const entry of entries) {
    requireValue(entry.isFile() && !entry.isSymbolicLink() &&
      (entry.name === "manifest.json" || /^[a-z0-9][a-z0-9_-]{0,59}\.png$/u.test(entry.name)));
    const handle = await open(join(directory, entry.name), constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const stat = await handle.stat();
      requireValue(stat.isFile() && stat.size > 0 && stat.size <= LIMITS.unpackedBytes && total + stat.size <= LIMITS.unpackedBytes);
      const bytes = await handle.readFile(); total += bytes.length; files.set(entry.name, bytes);
    } finally { await handle.close(); }
  }
  const revision = sha([...files.keys()].sort().map(name => `${name}\0${sha(files.get(name)!)}\n`).join(""));
  requireValue(revision === entry.revision && files.has("manifest.json") && files.get("manifest.json")!.length <= LIMITS.manifestBytes);
  const manifest = JSON.parse(files.get("manifest.json")!.toString("utf8")) as { id: string; version: string };
  requireValue(manifest.id === assetId && manifest.version === entry.version);
  return { identity: officialPreviewIdentity(assetId, entry), manifest, files };
}
export function writePublicPreviewImage(request: IncomingMessage, response: ServerResponse, image: { bytes: Buffer; sha256: string }): void {
  const etag = `"${image.sha256}"`;
  const fresh = typeof request.headers["if-none-match"] === "string" &&
    request.headers["if-none-match"].split(",").some(value => value.trim() === etag);
  response.writeHead(fresh ? 304 : 200, { "content-type": "image/png", etag,
    "cache-control": "public, max-age=31536000, immutable", "x-content-type-options": "nosniff",
    ...(fresh ? {} : { "content-length": image.bytes.length }) });
  response.end(fresh ? undefined : image.bytes);
}
