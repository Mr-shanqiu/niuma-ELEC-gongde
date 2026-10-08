import { createHash } from "node:crypto";
import { zipSync } from "fflate";
import type { CreatorSourceStore } from "./object-store.js";
import { validateCreatorSourcePack } from "./pack-validation.js";
import { CREATOR_UPLOAD_LIMITS, MARKET_BATCH_BYTES } from "./policy.js";
import { CreatorError, creatorWorkId } from "./types.js";

const MAX_ITEMS = 10;
const ZIP_MTIME = new Date("2020-01-01T00:00:00.000Z");
const SHA256 = /^[a-f0-9]{64}$/u;

export interface FreeBatchSelection {
  workId: string;
  creatorId: string;
  slug: string;
  versionId: string;
  revision: string;
  archiveSha256: string;
  reviewId: string;
}

interface RemainingBudget {
  sourceBytes: number;
  unpackedBytes: number;
  deliveryBytes: number;
}

interface PreparedFreePack {
  body: Buffer;
  archiveBytes: number;
  unpackedBytes: number;
}

function metadataId(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 &&
    Buffer.byteLength(value, "utf8") <= 128 && value.trim() === value &&
    !/[\u0000-\u001f\u007f]/u.test(value);
}

function snapshotSelections(items: readonly FreeBatchSelection[]): FreeBatchSelection[] {
  if (!Array.isArray(items) || items.length < 1 || items.length > MAX_ITEMS) {
    throw new CreatorError("creator_free_batch_count_invalid");
  }
  const selections: FreeBatchSelection[] = [];
  const seen = new Set<string>();
  for (const [index, item] of items.entries()) {
    const field = `items.${index}`;
    if (!item || typeof item !== "object" ||
        typeof item.creatorId !== "string" || typeof item.slug !== "string") {
      throw new CreatorError("creator_free_batch_selection_invalid", 400, field);
    }
    // Copy every field before the first await; callers cannot change an in-flight selection.
    const selection: FreeBatchSelection = {
      workId: item.workId,
      creatorId: item.creatorId,
      slug: item.slug,
      versionId: item.versionId,
      revision: item.revision,
      archiveSha256: item.archiveSha256,
      reviewId: item.reviewId
    };
    if (selection.workId !== creatorWorkId(selection.creatorId, selection.slug)) {
      throw new CreatorError("creator_free_batch_identity_invalid", 400, field + ".workId");
    }
    if (typeof selection.archiveSha256 !== "string" || !SHA256.test(selection.archiveSha256) ||
        typeof selection.revision !== "string" || !SHA256.test(selection.revision) ||
        !metadataId(selection.versionId) || !metadataId(selection.reviewId) ||
        selection.reviewId.toLowerCase() === "pending") {
      throw new CreatorError("creator_free_batch_selection_invalid", 400, field);
    }
    if (seen.has(selection.workId)) {
      throw new CreatorError("creator_free_batch_duplicate_work", 400, field + ".workId");
    }
    seen.add(selection.workId);
    selections.push(Object.freeze(selection));
  }
  return selections;
}

function requireBudget(bytes: number, remaining: number, field: string): void {
  if (bytes > remaining) {
    throw new CreatorError("creator_free_batch_size_exceeded", 413, field);
  }
}

// Stored ZIP entries have a 30-byte local header and a 46-byte central header,
// each followed by the filename, plus one 22-byte end-of-directory record.
// All names here are safe ASCII, with no comments, extras, directories or ZIP64.
function storedZipBytes(files: Readonly<Record<string, Uint8Array>>): number {
  let bytes = 22;
  for (const [name, data] of Object.entries(files)) {
    bytes += 76 + 2 * Buffer.byteLength(name, "utf8") + data.byteLength;
  }
  return bytes;
}

function storedZip(files: Record<string, Uint8Array>, maximum: number): Buffer {
  requireBudget(storedZipBytes(files), maximum, "deliveryBytes");
  const zipped = zipSync(files, { level: 0, mtime: ZIP_MTIME });
  requireBudget(zipped.byteLength, maximum, "deliveryBytes");
  // Share the completed archive allocation rather than copying it again.
  return Buffer.from(zipped.buffer, zipped.byteOffset, zipped.byteLength);
}

/**
 * Delivery-only boundary: callers must resolve approved, currently published,
 * free community versions and bind versionId/reviewId to that database snapshot.
 * This class never accepts prices, descriptions, arbitrary object keys or
 * official sources. It rechecks immutable source identity, SHA and revision;
 * versionId is a database identity, not the manifest's human version label.
 */
export class FreeCreatorBatchDelivery {
  // Bound builds across instances as well as source reads within each build.
  // Reject excess requests instead of retaining an unbounded waiting queue.
  static #activeBuilds = 0;

  constructor(private readonly objects: CreatorSourceStore,
    private readonly signPack?: (input: { archive: Buffer; selection: Readonly<FreeBatchSelection> }) => Buffer | Promise<Buffer>) {}

  async build(items: readonly FreeBatchSelection[]): Promise<{
    body: Buffer;
    fileName: string;
    contentType: string;
  }> {
    const selections = snapshotSelections(items);
    if (!this.signPack) throw new CreatorError("creator_free_batch_signer_required", 503);
    if (FreeCreatorBatchDelivery.#activeBuilds !== 0) {
      throw new CreatorError("creator_free_batch_busy", 503);
    }
    FreeCreatorBatchDelivery.#activeBuilds += 1;
    try {
      const isBatch = selections.length > 1;
      const entries = Object.create(null) as Record<string, Uint8Array>;
      let sourceBytes = 0;
      let unpackedBytes = 0;
      let deliveryBytes = isBatch ? 22 : 0;
      for (const [index, selection] of selections.entries()) {
        const name = `community-${String(index + 1).padStart(2, "0")}.nmgpack`;
        const entryBytes = isBatch ? 76 + 2 * Buffer.byteLength(name, "ascii") : 0;
        // Serial preparation keeps only one source and validated image set live;
        // completed inner archives alone remain until the outer ZIP is built.
        const prepared = await this.#prepare(selection, {
          sourceBytes: MARKET_BATCH_BYTES - sourceBytes,
          unpackedBytes: MARKET_BATCH_BYTES - unpackedBytes,
          deliveryBytes: MARKET_BATCH_BYTES - deliveryBytes - entryBytes
        });
        sourceBytes += prepared.archiveBytes;
        unpackedBytes += prepared.unpackedBytes;
        deliveryBytes += entryBytes + prepared.body.length;
        if (!isBatch) {
          // Both native importers require 2-10 entries in a .nmgpacks file.
          // A singleton uses their existing standalone .nmgpack contract.
          return {
            body: prepared.body,
            fileName: "community-pack.nmgpack",
            contentType: "application/octet-stream"
          };
        }
        entries[name] = prepared.body;
      }
      // Native .nmgpacks is a ZIP of root .nmgpack archives, not a ZIP of
      // assets or a new batch manifest. Return only after every item succeeds.
      return {
        body: storedZip(entries, MARKET_BATCH_BYTES),
        fileName: "community-packs.nmgpacks",
        contentType: "application/octet-stream"
      };
    } finally {
      FreeCreatorBatchDelivery.#activeBuilds -= 1;
    }
  }

  async #prepare(selection: FreeBatchSelection, budget: RemainingBudget): Promise<PreparedFreePack> {
    const archive = await this.objects.source(selection.creatorId, selection.archiveSha256);
    if (!Buffer.isBuffer(archive) || archive.length === 0 ||
        archive.length > CREATOR_UPLOAD_LIMITS.archiveBytes) {
      throw new CreatorError("creator_free_batch_source_size_invalid", 503);
    }
    requireBudget(archive.length, budget.sourceBytes, "sourceBytes");
    // Verify before decompression even if a different store implementation is injected.
    if (createHash("sha256").update(archive).digest("hex") !== selection.archiveSha256) {
      throw new CreatorError("creator_free_batch_source_integrity_failed", 503);
    }
    const pack = validateCreatorSourcePack(archive, {
      creatorId: selection.creatorId,
      slug: selection.slug
    });
    if (pack.manifest.id !== selection.workId || pack.manifest.publisher !== "community") {
      throw new CreatorError("creator_free_batch_source_identity_invalid", 503);
    }
    if (pack.archiveSha256 !== selection.archiveSha256 || pack.revision !== selection.revision) {
      throw new CreatorError("creator_free_batch_revision_mismatch", 409);
    }
    // Never turn an unsigned submission into a downloadable appearance. The
    // claim owner's trusted signer supplies the independently signed inner pack.
    const body = await this.signPack!({ archive, selection: Object.freeze({ ...selection }) });
    if (!Buffer.isBuffer(body) || body.length === 0) throw new CreatorError("creator_free_batch_signer_invalid", 503);
    requireBudget(body.length, budget.deliveryBytes, "deliveryBytes");
    const unpackedBytes = pack.unpackedBytes;
    requireBudget(unpackedBytes, budget.unpackedBytes, "unpackedBytes");
    return {
      body,
      archiveBytes: archive.length,
      unpackedBytes
    };
  }
}
