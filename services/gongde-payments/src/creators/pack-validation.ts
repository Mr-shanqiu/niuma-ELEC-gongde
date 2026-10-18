import { createHash } from "node:crypto";
import { inflateRawSync, inflateSync } from "node:zlib";
import { z } from "zod";
import { CreatorError, creatorWorkId } from "./types.js";
import { CREATOR_UPLOAD_LIMITS as LIMITS } from "./policy.js";

export const CREATOR_TEMPLATE_ID = "creator.template";

const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const CRC_TABLE = Uint32Array.from({ length: 256 }, (_, input) => {
  let value = input;
  for (let bit = 0; bit < 8; bit += 1) value = (value >>> 1) ^ ((value & 1) ? 0xedb88320 : 0);
  return value >>> 0;
});
function crc32(data: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of data) crc = (crc >>> 8) ^ CRC_TABLE[(crc ^ byte) & 255];
  return (crc ^ 0xffffffff) >>> 0;
}
function invalid(code: string, field?: string): never {
  throw new CreatorError(code, 422, field);
}
function safePngName(name: string): boolean {
  return /^[a-z0-9][a-z0-9_-]{0,59}\.png$/u.test(name);
}
function range(data: Buffer, offset: number, length: number): Buffer {
  if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(length) ||
      offset < 0 || length < 0 || offset + length > data.length) {
    invalid("creator_zip_truncated");
  }
  return data.subarray(offset, offset + length);
}

interface ZipEntry {
  name: string; nameBytes: Buffer; flags: number; method: number;
  crc: number; compressed: number; original: number; localOffset: number;
}

// Inspect and bound both directories before any decompression. No filesystem extraction.
function readSourceZip(archive: Buffer): Map<string, Buffer> {
  if (archive.length < 22 || archive.length > LIMITS.archiveBytes) invalid("creator_archive_size_invalid");
  const end = archive.length - 22;
  const eocd = range(archive, end, 22);
  if (eocd.readUInt32LE(0) !== 0x06054b50 || eocd.readUInt16LE(20) !== 0 ||
      eocd.readUInt16LE(4) !== 0 || eocd.readUInt16LE(6) !== 0) {
    invalid("creator_zip_format_unsupported");
  }
  const count = eocd.readUInt16LE(10);
  if (count < 2 || count > LIMITS.files || eocd.readUInt16LE(8) !== count) {
    invalid("creator_zip_file_count_invalid");
  }
  const centralBytes = eocd.readUInt32LE(12);
  const centralOffset = eocd.readUInt32LE(16);
  if (centralOffset + centralBytes !== end) invalid("creator_zip_directory_invalid");
  const entries: ZipEntry[] = [];
  const names = new Set<string>();
  let cursor = centralOffset;
  let totalOriginal = 0;
  for (let index = 0; index < count; index += 1) {
    const header = range(archive, cursor, 46);
    if (header.readUInt32LE(0) !== 0x02014b50) invalid("creator_zip_directory_invalid");
    const flags = header.readUInt16LE(8);
    const method = header.readUInt16LE(10);
    const crc = header.readUInt32LE(16);
    const compressed = header.readUInt32LE(20);
    const original = header.readUInt32LE(24);
    const nameLength = header.readUInt16LE(28);
    const extraLength = header.readUInt16LE(30);
    const commentLength = header.readUInt16LE(32);
    const attributes = header.readUInt32LE(38);
    const fileMode = (attributes >>> 16) & 0xf000;
    if ((flags & ~0x0800) !== 0 || (method !== 0 && method !== 8) ||
        header.readUInt16LE(34) !== 0 || (attributes & 0x10) !== 0 ||
        (fileMode !== 0 && fileMode !== 0x8000) ||
        compressed === 0xffffffff || original === 0xffffffff || original < 1) {
      invalid("creator_zip_entry_unsupported");
    }
    const nameBytes = range(archive, cursor + 46, nameLength);
    if (nameBytes.some((byte) => byte < 32 || byte > 126)) invalid("creator_zip_filename_invalid");
    const name = nameBytes.toString("ascii");
    if ((name !== "manifest.json" && !safePngName(name)) || names.has(name)) {
      invalid("creator_zip_filename_invalid");
    }
    names.add(name);
    const limit = name === "manifest.json" ? LIMITS.manifestBytes : LIMITS.unpackedBytes;
    totalOriginal += original;
    if (original > limit || totalOriginal > LIMITS.unpackedBytes) invalid("creator_zip_unpacked_size_exceeded");
    cursor += 46 + nameLength + extraLength + commentLength;
    if (cursor > end) invalid("creator_zip_directory_invalid");
    entries.push({
      name, nameBytes, flags, method, crc, compressed, original,
      localOffset: header.readUInt32LE(42)
    });
  }
  if (cursor !== end || !names.has("manifest.json")) invalid("creator_zip_directory_invalid");
  entries.sort((left, right) => left.localOffset - right.localOffset);
  const payloads: Array<{ entry: ZipEntry; data: Buffer }> = [];
  let localEnd = 0;
  for (const entry of entries) {
    if (entry.localOffset !== localEnd) invalid("creator_zip_entry_layout_invalid");
    const local = range(archive, entry.localOffset, 30);
    const nameLength = local.readUInt16LE(26);
    const extraLength = local.readUInt16LE(28);
    if (local.readUInt32LE(0) !== 0x04034b50 || local.readUInt16LE(6) !== entry.flags ||
        local.readUInt16LE(8) !== entry.method || local.readUInt32LE(14) !== entry.crc ||
        local.readUInt32LE(18) !== entry.compressed || local.readUInt32LE(22) !== entry.original ||
        !range(archive, entry.localOffset + 30, nameLength).equals(entry.nameBytes)) {
      invalid("creator_zip_local_header_mismatch");
    }
    const offset = entry.localOffset + 30 + nameLength + extraLength;
    localEnd = offset + entry.compressed;
    if (localEnd > centralOffset) invalid("creator_zip_entry_layout_invalid");
    payloads.push({ entry, data: range(archive, offset, entry.compressed) });
  }
  if (localEnd !== centralOffset) invalid("creator_zip_entry_layout_invalid");
  const files = new Map<string, Buffer>();
  for (const { entry, data } of payloads) {
    let decoded: Buffer;
    try {
      decoded = entry.method === 0 ? Buffer.from(data) :
        inflateRawSync(data, { maxOutputLength: entry.original });
    } catch {
      invalid("creator_zip_decompression_failed", entry.name);
    }
    if (decoded.length !== entry.original || crc32(decoded) !== entry.crc) {
      invalid("creator_zip_content_mismatch", entry.name);
    }
    files.set(entry.name, decoded);
  }
  return files;
}

const finite = (low: number, high: number) => z.number().finite().min(low).max(high);
const label = z.string().min(1).max(80).refine((value) =>
  !/[\u0000-\u001f\u007f]/u.test(value) && value.trim().length > 0);
const frameBase = {
  t: finite(0, 1), x: finite(-480, 480), y: finite(-480, 480),
  rotation: finite(-180, 180), scale: finite(0.1, 4), alpha: finite(0, 1)
};
const geometry = {
  image: z.string().refine(safePngName),
  frame: z.tuple([finite(-240, 480), finite(-250, 480), finite(1, 480), finite(1, 480)]),
  anchor: z.tuple([finite(0, 1), finite(0, 1)])
};
const manifestBase = {
  id: z.string().min(3).max(80),
  version: z.string().min(1).max(32).regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/u),
  name_zh: label, name_en: label, author: label,
  publisher: z.literal("community"), review_id: z.literal("pending"),
  canvas_width: z.literal(240), canvas_height: z.literal(250),
  preview: z.string().refine(safePngName), plus_y: z.literal(174)
};
const SourceManifest = z.discriminatedUnion("schema_version", [
  z.object({
    ...manifestBase, schema_version: z.literal(1),
    layers: z.array(z.object({
      ...geometry, keyframes: z.array(z.object(frameBase).strict()).min(1).max(LIMITS.keyframesPerLayer)
    }).strict()).min(1).max(LIMITS.layers)
  }).strict(),
  z.object({
    ...manifestBase, schema_version: z.literal(3),
    layers: z.array(z.object({
      ...geometry, interpolation: z.enum(["linear", "smoothstep"]),
      keyframes: z.array(z.object({ ...frameBase, scale_y: finite(0.1, 4) }).strict())
        .min(1).max(LIMITS.keyframesPerLayer)
    }).strict()).min(1).max(LIMITS.layers)
  }).strict()
]);
export type CreatorSourceManifest = z.infer<typeof SourceManifest>;
export interface ValidatedCreatorPack {
  manifest: CreatorSourceManifest;
  files: ReadonlyMap<string, Buffer>;
  archiveSha256: string;
  revision: string;
  contentSha256: string;
  archiveBytes: number;
  unpackedBytes: number;
  decodedImageBytes: number;
  deliveryBytesUpperBound: number;
  images: ReadonlyArray<{ name: string; width: number; height: number }>;
}

function validatePng(data: Buffer, name: string): { width: number; height: number; decodedBytes: number } {
  if (data.length < 57 || !data.subarray(0, 8).equals(PNG_SIGNATURE)) invalid("creator_png_invalid", name);
  let cursor = 8;
  let width = 0;
  let height = 0;
  let channels = 0;
  let ended = false;
  let sawIdat = false;
  let idatClosed = false;
  const compressed: Buffer[] = [];
  while (cursor < data.length) {
    if (cursor + 12 > data.length) invalid("creator_png_truncated", name);
    const size = data.readUInt32BE(cursor);
    if (cursor + 12 + size > data.length) invalid("creator_png_truncated", name);
    const typeBytes = data.subarray(cursor + 4, cursor + 8);
    if (!/^[A-Za-z]{4}$/u.test(typeBytes.toString("ascii")) || (typeBytes[2] & 32) !== 0) {
      invalid("creator_png_chunk_invalid", name);
    }
    const type = typeBytes.toString("ascii");
    const chunk = data.subarray(cursor + 8, cursor + 8 + size);
    if (crc32(data.subarray(cursor + 4, cursor + 8 + size)) !== data.readUInt32BE(cursor + 8 + size)) {
      invalid("creator_png_crc_invalid", name);
    }
    if (cursor === 8 && type !== "IHDR") invalid("creator_png_header_invalid", name);
    if (type === "IHDR") {
      if (cursor !== 8 || size !== 13) invalid("creator_png_header_invalid", name);
      width = chunk.readUInt32BE(0);
      height = chunk.readUInt32BE(4);
      const color = chunk[9];
      if (width < 1 || height < 1 || width > LIMITS.imageDimension || height > LIMITS.imageDimension ||
          chunk[8] !== 8 || (color !== 2 && color !== 6) ||
          chunk[10] !== 0 || chunk[11] !== 0 || chunk[12] !== 0) {
        invalid("creator_png_export_format_invalid", name);
      }
      channels = color === 6 ? 4 : 3;
    } else if (type === "IDAT") {
      if (idatClosed || ended) invalid("creator_png_chunk_order_invalid", name);
      sawIdat = true;
      compressed.push(chunk);
    } else if (type === "IEND") {
      if (!sawIdat || size !== 0 || cursor + 12 !== data.length) invalid("creator_png_end_invalid", name);
      ended = true;
    } else {
      if (sawIdat) idatClosed = true;
      if (type === "acTL" || type === "fcTL" || type === "fdAT" || (typeBytes[0] & 32) === 0) {
        invalid("creator_png_chunk_unsupported", name);
      }
    }
    cursor += size + 12;
  }
  if (!ended || compressed.length === 0) invalid("creator_png_end_invalid", name);
  const rowBytes = width * channels + 1;
  const expectedBytes = rowBytes * height;
  let pixels: Buffer;
  try {
    pixels = inflateSync(Buffer.concat(compressed), { maxOutputLength: expectedBytes });
  } catch {
    invalid("creator_png_decode_failed", name);
  }
  if (pixels.length !== expectedBytes) invalid("creator_png_decoded_size_invalid", name);
  for (let row = 0; row < height; row += 1) {
    if (pixels[row * rowBytes] > 4) invalid("creator_png_filter_invalid", name);
  }
  return { width, height, decodedBytes: width * height * 4 };
}

export function validateCreatorSourcePack(
  archive: Buffer, owner: { creatorId: string; slug: string }, options?: { allowTemplateId?: boolean }
): ValidatedCreatorPack {
  const expectedId = creatorWorkId(owner.creatorId, owner.slug);
  const files = readSourceZip(archive);
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(files.get("manifest.json")!));
  } catch {
    invalid("creator_manifest_json_invalid");
  }
  const result = SourceManifest.safeParse(parsed);
  if (!result.success) {
    invalid("creator_manifest_invalid", result.error.issues[0]?.path.join("."));
  }
  const manifest = result.data;
  if (manifest.id !== expectedId &&
      !(options?.allowTemplateId === true && manifest.id === CREATOR_TEMPLATE_ID)) {
    invalid("creator_manifest_identity_mismatch", "id");
  }
  const declared = new Set(["manifest.json", manifest.preview]);
  for (const [index, layer] of manifest.layers.entries()) {
    declared.add(layer.image);
    if (manifest.schema_version === 1 && (layer.frame[1] < 0 || layer.frame[1] + layer.frame[3] > 170)) {
      invalid("creator_layer_reserved_area", "layers." + index);
    }
    let previous = -1;
    for (const [frameIndex, frame] of layer.keyframes.entries()) {
      const time = Math.fround(frame.t);
      if ((frameIndex === 0 && frame.t !== 0) || time <= previous) {
        invalid("creator_keyframe_time_invalid", "layers." + index + ".keyframes." + frameIndex);
      }
      previous = time;
    }
  }
  if (files.size !== declared.size || [...declared].some((name) => !files.has(name))) {
    invalid("creator_manifest_files_mismatch");
  }
  let unpackedBytes = 0;
  let decodedImageBytes = 0;
  const images: Array<{ name: string; width: number; height: number }> = [];
  const revisionHash = createHash("sha256");
  const contentHash = createHash("sha256");
  for (const name of [...files.keys()].sort()) {
    const data = files.get(name)!;
    unpackedBytes += data.length;
    revisionHash.update(name + "\0" + createHash("sha256").update(data).digest("hex") + "\n", "utf8");
    if (name === "manifest.json") continue;
    const image = validatePng(data, name);
    decodedImageBytes += image.decodedBytes;
    if (decodedImageBytes > LIMITS.decodedImageBytes) invalid("creator_image_memory_budget_exceeded");
    images.push({ name, width: image.width, height: image.height });
    const length = Buffer.alloc(8);
    length.writeBigUInt64BE(BigInt(data.length));
    contentHash.update(name, "utf8");
    contentHash.update(Buffer.from([0]));
    contentHash.update(length);
    contentHash.update(data);
  }
  return {
    manifest, files, images,
    archiveSha256: createHash("sha256").update(archive).digest("hex"),
    revision: revisionHash.digest("hex"), contentSha256: contentHash.digest("hex"),
    archiveBytes: archive.length, unpackedBytes, decodedImageBytes,
    deliveryBytesUpperBound: unpackedBytes + 8192
  };
}
