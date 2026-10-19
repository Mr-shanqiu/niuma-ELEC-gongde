import { createHash } from "node:crypto";
import { inflateSync } from "node:zlib";
import { zipSync, zlibSync } from "fflate";
import { CREATOR_TEMPLATE_ID, validateCreatorSourcePack } from "./pack-validation.js";
import { CreatorError, creatorWorkId } from "./types.js";

const ZIP_MTIME = new Date("2020-01-01T00:00:00.000Z");
const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

type SourceOwner = { creatorId: string; slug: string };
type ValidatedPack = ReturnType<typeof validateCreatorSourcePack>;

function pngCrc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ ((crc & 1) === 1 ? 0xedb88320 : 0);
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function makePngChunk(type: string, data: Uint8Array): Buffer {
  const typeBytes = Buffer.from(type, "ascii");
  const crcInput = Buffer.concat([typeBytes, Buffer.from(data)]);
  const chunk = Buffer.allocUnsafe(data.byteLength + 12);
  chunk.writeUInt32BE(data.byteLength, 0);
  typeBytes.copy(chunk, 4);
  Buffer.from(data).copy(chunk, 8);
  chunk.writeUInt32BE(pngCrc32(crcInput), data.byteLength + 8);
  return chunk;
}

function normalizePng(input: Uint8Array, image: ValidatedPack["images"][number]): Buffer {
  const png = Buffer.from(input.buffer, input.byteOffset, input.byteLength);
  if (png.length < PNG_SIGNATURE.length || !png.subarray(0, 8).equals(PNG_SIGNATURE)) {
    throw new CreatorError("creator_png_normalization_failed", 400, image.name);
  }

  let offset = PNG_SIGNATURE.length;
  let ihdr: Buffer | undefined;
  let transparency: Buffer | undefined;
  let sawIdat = false;
  let endedIdat = false;
  let sawIend = false;
  let idatBytes = 0;
  const idatParts: Buffer[] = [];

  while (offset + 12 <= png.length) {
    const length = png.readUInt32BE(offset);
    const dataStart = offset + 8;
    const dataEnd = dataStart + length;
    const chunkEnd = dataEnd + 4;
    if (chunkEnd > png.length) {
      throw new CreatorError("creator_png_normalization_failed", 400, image.name);
    }
    const type = png.toString("ascii", offset + 4, offset + 8);
    const data = png.subarray(dataStart, dataEnd);

    if (type === "IHDR") {
      if (ihdr || offset !== PNG_SIGNATURE.length || length !== 13) {
        throw new CreatorError("creator_png_normalization_failed", 400, image.name);
      }
      ihdr = Buffer.from(data);
    } else if (type === "tRNS") {
      if (!ihdr || sawIdat || transparency || ihdr[9] !== 2 || length !== 6 ||
          data.readUInt16BE(0) > 255 || data.readUInt16BE(2) > 255 || data.readUInt16BE(4) > 255) {
        throw new CreatorError("creator_png_normalization_failed", 400, image.name);
      }
      transparency = Buffer.from(data);
    } else if (type === "IDAT") {
      if (!ihdr || endedIdat || sawIend || idatBytes + length > png.length) {
        throw new CreatorError("creator_png_normalization_failed", 400, image.name);
      }
      sawIdat = true;
      idatBytes += length;
      idatParts.push(Buffer.from(data));
    } else if (type === "IEND") {
      if (!sawIdat || length !== 0 || sawIend) {
        throw new CreatorError("creator_png_normalization_failed", 400, image.name);
      }
      sawIend = true;
      offset = chunkEnd;
      break;
    } else if (sawIdat) {
      endedIdat = true;
    }
    offset = chunkEnd;
  }

  if (!ihdr || !sawIdat || !sawIend || offset !== png.length) {
    throw new CreatorError("creator_png_normalization_failed", 400, image.name);
  }

  const width = ihdr.readUInt32BE(0);
  const height = ihdr.readUInt32BE(4);
  const bitDepth = ihdr[8];
  const colorType = ihdr[9];
  const channels = colorType === 2 ? 3 : colorType === 6 ? 4 : 0;
  if (width !== image.width || height !== image.height || bitDepth !== 8 || channels === 0 ||
      ihdr[10] !== 0 || ihdr[11] !== 0 || ihdr[12] !== 0) {
    throw new CreatorError("creator_png_normalization_failed", 400, image.name);
  }

  const rowBytes = width * channels;
  const expectedInflatedBytes = (rowBytes + 1) * height;
  if (!Number.isSafeInteger(expectedInflatedBytes) || expectedInflatedBytes <= 0) {
    throw new CreatorError("creator_png_normalization_failed", 400, image.name);
  }

  const compressed = Buffer.concat(idatParts, idatBytes);
  let pixels: Uint8Array;
  try {
    pixels = inflateSync(compressed, { maxOutputLength: expectedInflatedBytes });
  } catch {
    throw new CreatorError("creator_png_normalization_failed", 400, image.name);
  }
  if (pixels.byteLength !== expectedInflatedBytes) {
    throw new CreatorError("creator_png_normalization_failed", 400, image.name);
  }

  const normalizedIdat = zlibSync(pixels);
  return Buffer.concat([
    PNG_SIGNATURE,
    makePngChunk("IHDR", ihdr),
    ...(transparency ? [makePngChunk("tRNS", transparency)] : []),
    makePngChunk("IDAT", normalizedIdat),
    makePngChunk("IEND", Buffer.alloc(0))
  ]);
}

export function normalizeCreatorSourceArchive(
  archive: Buffer,
  owner: SourceOwner
): {
  archive: Buffer;
  pack: ReturnType<typeof validateCreatorSourcePack>;
  originalArchiveSha256: string;
  normalized: boolean;
} {
  const originalPack = validateCreatorSourcePack(archive, owner, { allowTemplateId: true });
  const originalArchiveSha256 = createHash("sha256").update(archive).digest("hex");
  const boundManifest = originalPack.manifest.id === CREATOR_TEMPLATE_ID ?
    Buffer.from(JSON.stringify({
      ...originalPack.manifest,
      id: creatorWorkId(owner.creatorId, owner.slug)
    }), "utf8") : undefined;
  const images = new Map(originalPack.images.map((image) => [image.name, image]));
  const entries = Object.create(null) as Record<string, Uint8Array>;

  for (const [name, bytes] of originalPack.files) {
    const image = images.get(name);
    entries[name] = name === "manifest.json" && boundManifest ? boundManifest :
      image ? normalizePng(bytes, image) : Buffer.from(bytes);
  }

  const zipped = zipSync(entries, { level: 0, mtime: ZIP_MTIME });
  const normalizedArchive = Buffer.from(zipped.buffer, zipped.byteOffset, zipped.byteLength);
  const pack = validateCreatorSourcePack(normalizedArchive, owner);

  return {
    archive: normalizedArchive,
    pack,
    originalArchiveSha256,
    normalized: !normalizedArchive.equals(archive)
  };
}
