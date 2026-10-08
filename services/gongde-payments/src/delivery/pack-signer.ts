import { createHash, createPrivateKey, createSign } from "node:crypto";
import { lstatSync, readFileSync, readdirSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { zipSync } from "fflate";
import { validateCreatorSourcePack } from "../creators/pack-validation.js";

const MAX_PACK_BYTES = 50 * 1024 * 1024;
const MAX_MANIFEST_BYTES = 64 * 1024;
const ALLOWED_ASSETS: Readonly<Record<string, string>> = Object.freeze({
  "official.lucky-cat": "lucky-cat",
  "official.hamster-wheel": "hamster-wheel",
  "official.sea-lion-belly-pat": "sea-lion-belly-pat",
  "official.chick-pecking": "chick-pecking",
  "zqscreen.caishen-ingot": "caishen-ingot",
  "zqscreen.redpanda-wave": "red-panda-wave",
  "zqscreen.shiba-tilt": "shiba-tilt",
  "zqscreen.orange-cat-wave": "orange-cat-wave",
  "zqscreen.raccoon-cheer": "raccoon-cheer",
  "zqscreen.golden-toad-coin": "golden-toad-coin",
  "zqscreen.little-jiangshi-hop": "little-jiangshi-hop",
  "zqscreen.frog-puff": "frog-puff",
  "zqscreen.bee-flap": "bee-flap",
  "zqscreen.koi-bubbles": "koi-bubbles",
  "zqscreen.kiss-couple": "sweet-kiss",
  "zqscreen.baodan-charm": "baodan-charm",
  "zqscreen.woodpecker-peck": "woodpecker-peck",
  "zqscreen.zhuan-yun-bead": "fortune-bead",
  "zqscreen.treasure-basin": "treasure-basin"
});

interface SourceManifest {
  schema_version: number;
  id: string;
  version: string;
  preview: string;
  layers: Array<{ image: string }>;
  [key: string]: unknown;
}

interface PreparedSource {
  manifest: SourceManifest;
  pngFiles: Map<string, Buffer>;
  contentSha256: string;
}

export interface OfficialCatalogEntry {
  manifest: SourceManifest;
  version: string;
  revision: string;
  deliveryBytesUpperBound: number;
  previewDirectory: string;
}

function readRegularFile(path: string, label: string): Buffer {
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`${label}_invalid`);
  return readFileSync(path);
}

function safePngName(name: string): boolean {
  return /^[A-Za-z0-9._-]+\.png$/u.test(name) && !name.startsWith(".") && !name.includes("..");
}

function validatePng(data: Buffer, name: string): void {
  if (data.length < 24 || !data.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) || data.toString("ascii", 12, 16) !== "IHDR") {
    throw new Error(`pack_png_invalid:${name}`);
  }
  const width = data.readUInt32BE(16);
  const height = data.readUInt32BE(20);
  if (width < 1 || width > 2048 || height < 1 || height > 2048) throw new Error(`pack_png_dimensions_invalid:${name}`);
}

function contentHash(files: Map<string, Buffer>): string {
  const hash = createHash("sha256");
  for (const name of [...files.keys()].sort()) {
    const data = files.get(name)!;
    const length = Buffer.alloc(8);
    length.writeBigUInt64BE(BigInt(data.length));
    hash.update(name, "utf8");
    hash.update(Buffer.from([0]));
    hash.update(length);
    hash.update(data);
  }
  return hash.digest("hex");
}

function licenseMessage(manifest: SourceManifest & { license: Record<string, unknown> }): Buffer {
  const license = manifest.license;
  if (/[\r\n]/u.test(manifest.id) || /[\r\n]/u.test(manifest.version)) {
    throw new Error("pack_license_message_invalid");
  }
  if (license.mode === "perpetual") {
    return Buffer.from(
      `NIUMA-PACK-LICENSE-V2\nperpetual\n${manifest.id}\n${manifest.version}\n${license.issued_at}\n${license.download_id}\n${license.content_sha256}`,
      "utf8"
    );
  }
  return Buffer.from(
    `NIUMA-PACK-LICENSE-V1\n${manifest.id}\n${manifest.version}\n${license.issued_at}\n${license.import_before}\n${license.download_id}\n${license.content_sha256}`,
    "utf8"
  );
}

export type TimedPackLicenseOptions = {
  licenseMode?: "timed";
  issuedAt: Date;
  expiresAt: Date;
  downloadId: string;
};
export type PerpetualPackLicenseOptions = {
  licenseMode: "perpetual";
  issuedAt: Date;
  // A server re-download deadline is not a local import deadline.
  expiresAt?: Date;
  downloadId: string;
};
export type PackLicenseOptions = TimedPackLicenseOptions | PerpetualPackLicenseOptions;
type OfficialPackInput = { assetId: string };
type CommunityPackInput = {
  archive: Buffer;
  creatorId: string;
  slug: string;
  reviewId: string;
  revision: string;
  archiveSha256: string;
};
type SignedPack<Deadline extends string | null> = {
  filename: string;
  content: Buffer;
  importBefore: Deadline;
};

function prepareLicense(input: PackLicenseOptions, contentSha256: string) {
  const mode = input.licenseMode ?? "timed";
  if (mode !== "timed" && mode !== "perpetual") throw new Error("pack_license_mode_invalid");
  if (!/^[A-Za-z0-9_-]{16,128}$/u.test(input.downloadId)) throw new Error("pack_download_id_invalid");
  const issuedAt = Math.floor(input.issuedAt.getTime() / 1000);
  if (!Number.isSafeInteger(issuedAt) || issuedAt < 1_577_836_800 || issuedAt > 4_102_444_800) {
    throw new Error("pack_import_window_invalid");
  }
  const common = {
    issued_at: issuedAt,
    download_id: input.downloadId,
    content_sha256: contentSha256,
    signature: ""
  };
  if (mode === "perpetual") return { mode, ...common };
  const importBefore = Math.floor((input.expiresAt?.getTime() ?? NaN) / 1000);
  if (!Number.isSafeInteger(importBefore) || importBefore > 4_102_444_800 ||
      importBefore <= issuedAt || importBefore - issuedAt > 86_400) {
    throw new Error("pack_import_window_invalid");
  }
  return { mode, issued_at: issuedAt, import_before: importBefore,
    download_id: input.downloadId, content_sha256: contentSha256, signature: "" };
}

export interface PackSignerConfiguration {
  assetRoot: string;
  privateKeyFile: string;
}

export function loadPackSignerConfiguration(
  source: Record<string, string | undefined> = process.env
): PackSignerConfiguration {
  const assetRoot = source.GONGDE_PACK_ASSET_ROOT?.trim();
  const privateKeyFile = source.GONGDE_PACK_SIGNING_KEY_FILE?.trim();
  if (!assetRoot) throw new Error("GONGDE_PACK_ASSET_ROOT_required");
  if (!privateKeyFile) throw new Error("GONGDE_PACK_SIGNING_KEY_FILE_required");
  return { assetRoot, privateKeyFile };
}

export class AppearancePackSigner {
  readonly #privateKey;
  #revisionRoot = "";
  #revisions: Readonly<Record<string, string>> = {};
  #sourceRoot = "";
  #sources = new Map<string, PreparedSource>();

  // Internal only: freeze this immutable release path in a claim. Never serialize
  // it, or an officialCatalog() entry, directly into a public API response.
  sourceRoot(): string {
    return realpathSync(this.configuration.assetRoot);
  }

  revisions(): Readonly<Record<string, string>> {
    return this.#revisionsAt(this.sourceRoot());
  }

  #revisionsAt(root: string): Readonly<Record<string, string>> {
    if (root === this.#revisionRoot) return this.#revisions;
    const revisions: Record<string, string> = {};
    for (const [id, directory] of Object.entries(ALLOWED_ASSETS)) {
      const path = join(root, directory);
      const names = readdirSync(path).sort();
      if (names.length < 2 || names.length > 8) throw new Error("pack_file_count_invalid");
      const lines = names.map((name) => {
        if (name !== "manifest.json" && !safePngName(name)) throw new Error("pack_file_not_allowed");
        const data = readRegularFile(join(path, name), "pack_asset");
        if (data.length > MAX_PACK_BYTES) throw new Error("pack_file_too_large");
        return `${name}\0${createHash("sha256").update(data).digest("hex")}\n`;
      });
      revisions[id] = createHash("sha256").update(lines.join("")).digest("hex");
    }
    this.#revisions = Object.freeze(revisions);
    this.#revisionRoot = root;
    return this.#revisions;
  }

  constructor(private readonly configuration: PackSignerConfiguration) {
    const pem = readRegularFile(configuration.privateKeyFile, "pack_signing_key");
    this.#privateKey = createPrivateKey(pem);
    if (this.#privateKey.asymmetricKeyType !== "ec" || this.#privateKey.asymmetricKeyDetails?.namedCurve !== "prime256v1") {
      throw new Error("pack_signing_key_must_be_p256");
    }
  }

  prepareAssets(): void {
    for (const assetId of Object.keys(ALLOWED_ASSETS)) this.#source(assetId);
  }

  #source(assetId: string, releaseRoot = this.sourceRoot()): PreparedSource {
    const directoryName = ALLOWED_ASSETS[assetId];
    if (!directoryName) throw new Error("pack_asset_not_registered");
    // Releases are immutable; a current-symlink switch invalidates every cached source.
    if (releaseRoot !== this.#sourceRoot) {
      this.#sourceRoot = releaseRoot;
      this.#sources.clear();
    }
    const cached = this.#sources.get(assetId);
    if (cached) return cached;
    const root = join(releaseRoot, directoryName);
    const entries = readdirSync(root, { withFileTypes: true });
    if (entries.length < 2 || entries.length > 8 || entries.some((entry) => !entry.isFile() || entry.isSymbolicLink())) {
      throw new Error("pack_source_files_invalid");
    }
    const manifestBytes = readRegularFile(join(root, "manifest.json"), "pack_manifest");
    if (manifestBytes.length > MAX_MANIFEST_BYTES) throw new Error("pack_manifest_too_large");
    const manifest = JSON.parse(manifestBytes.toString("utf8")) as SourceManifest;
    if (![1, 3].includes(manifest.schema_version) || "license" in manifest || manifest.id !== assetId || !Array.isArray(manifest.layers) || !safePngName(manifest.preview)) {
      throw new Error("pack_manifest_invalid");
    }
    const declared = new Set([manifest.preview]);
    for (const layer of manifest.layers) {
      if (!layer || typeof layer.image !== "string" || !safePngName(layer.image)) throw new Error("pack_manifest_invalid");
      declared.add(layer.image);
    }
    const actual = new Set(entries.map((entry) => entry.name).filter((name) => name !== "manifest.json"));
    if (declared.size !== actual.size || [...declared].some((name) => !actual.has(name))) throw new Error("pack_manifest_files_mismatch");

    const pngFiles = new Map<string, Buffer>();
    for (const name of declared) {
      const data = readRegularFile(join(root, name), "pack_png");
      validatePng(data, name);
      pngFiles.set(name, data);
    }
    const source = { manifest, pngFiles, contentSha256: contentHash(pngFiles) };
    this.#sources.set(assetId, source);
    return source;
  }

  // Server-internal catalog, bound to one real source root for the whole read.
  // No filesystem writes and no order creation; callers own public projection.
  officialCatalog(): Record<string, OfficialCatalogEntry> {
    const root = this.sourceRoot();
    const revisions = this.#revisionsAt(root);
    const catalog: Record<string, OfficialCatalogEntry> = {};
    for (const [assetId, directory] of Object.entries(ALLOWED_ASSETS)) {
      const source = this.#source(assetId, root);
      // Exact upper envelope for build({ licenseMode: "perpetual" }): same pretty
      // JSON, trailing LF, PNG bytes, stored ZIP entries, timestamps and ZIP
      // metadata. Use the largest accepted issued_at/download_id/signature, not
      // a compressed source archive or a sum which omits the license/ZIP cost.
      const signedManifest = {
        ...source.manifest,
        schema_version: source.manifest.schema_version === 3 ? 3 : 2,
        license: {
          mode: "perpetual",
          issued_at: 4_102_444_800,
          download_id: "A".repeat(128),
          content_sha256: source.contentSha256,
          signature: "0".repeat(128)
        }
      };
      const archive: Record<string, Uint8Array> = {
        "manifest.json": Buffer.from(`${JSON.stringify(signedManifest, null, 2)}\n`, "utf8")
      };
      for (const [name, data] of source.pngFiles) archive[name] = data;
      const upperEnvelope = zipSync(archive, {
        level: 0,
        mtime: new Date("2020-01-01T00:00:00.000Z")
      });
      catalog[assetId] = {
        manifest: structuredClone(source.manifest),
        version: source.manifest.version,
        revision: revisions[assetId]!,
        deliveryBytesUpperBound: upperEnvelope.byteLength,
        previewDirectory: directory
      };
    }
    return catalog;
  }

  build(input: OfficialPackInput & TimedPackLicenseOptions): SignedPack<string>;
  build(input: OfficialPackInput & PerpetualPackLicenseOptions): SignedPack<null>;
  build(input: OfficialPackInput & PackLicenseOptions): SignedPack<string | null>;
  build(input: OfficialPackInput & PackLicenseOptions): SignedPack<string | null> {
    if (!ALLOWED_ASSETS[input.assetId]) throw new Error("pack_asset_not_registered");
    const { manifest, pngFiles, contentSha256 } = this.#source(input.assetId);
    const signedManifest = {
      ...manifest,
      schema_version: manifest.schema_version === 3 ? 3 : 2,
      license: prepareLicense(input, contentSha256)
    };
    const signer = createSign("SHA256");
    signer.update(licenseMessage(signedManifest));
    signer.end();
    const signature = signer.sign({ key: this.#privateKey, dsaEncoding: "ieee-p1363" });
    if (signature.length !== 64) throw new Error("pack_signature_invalid");
    signedManifest.license.signature = signature.toString("hex");

    const archive: Record<string, Uint8Array> = {
      "manifest.json": Buffer.from(`${JSON.stringify(signedManifest, null, 2)}\n`, "utf8")
    };
    for (const [name, data] of pngFiles) archive[name] = data;
    // PNG files are already compressed; deflating them again delays every download.
    const content = Buffer.from(zipSync(archive, { level: 0, mtime: new Date("2020-01-01T00:00:00.000Z") }));
    if (content.length > MAX_PACK_BYTES) throw new Error("pack_archive_too_large");
    return {
      filename: `${input.assetId}-${input.downloadId}.nmgpack`,
      content,
      importBefore: input.licenseMode === "perpetual" ? null : input.expiresAt!.toISOString()
    };
  }

  officialSnapshot(assetId: string): {
    versionLabel: string;
    sourceRevision: string;
    deliveryBytesUpperBound: number;
  } {
    if (!ALLOWED_ASSETS[assetId]) throw new Error("pack_asset_not_registered");
    const sourceRevision = this.revisions()[assetId];
    const source = this.#source(assetId);
    if (!sourceRevision) throw new Error("pack_asset_revision_missing");

    // Size the largest valid V1 license and ZIP it the same way build() does.
    // This is an exact upper envelope for this immutable static source: timestamps
    // are ten-digit seconds, download IDs are at most 128 bytes, and signatures
    // always occupy 128 hex characters.
    const signedManifest = {
      ...source.manifest,
      schema_version: source.manifest.schema_version === 3 ? 3 : 2,
      license: {
        mode: "timed",
        issued_at: 4_102_444_799,
        import_before: 4_102_444_800,
        download_id: "A".repeat(128),
        content_sha256: source.contentSha256,
        signature: "0".repeat(128)
      }
    };
    const archive: Record<string, Uint8Array> = {
      "manifest.json": Buffer.from(`${JSON.stringify(signedManifest, null, 2)}\n`, "utf8")
    };
    for (const [name, data] of source.pngFiles) archive[name] = data;
    const upperEnvelope = zipSync(archive, {
      level: 0,
      mtime: new Date("2020-01-01T00:00:00.000Z")
    });
    return {
      versionLabel: source.manifest.version,
      sourceRevision,
      deliveryBytesUpperBound: upperEnvelope.byteLength
    };
  }

  buildCommunity(input: CommunityPackInput & TimedPackLicenseOptions): SignedPack<string>;
  buildCommunity(input: CommunityPackInput & PerpetualPackLicenseOptions): SignedPack<null>;
  buildCommunity(input: CommunityPackInput & PackLicenseOptions): SignedPack<string | null>;
  buildCommunity(input: CommunityPackInput & PackLicenseOptions): SignedPack<string | null> {
    if (!/^[A-Za-z0-9_-]{16,128}$/u.test(input.downloadId)) {
      throw new Error("pack_download_id_invalid");
    }
    if (!/^[a-f0-9]{32}$/u.test(input.reviewId)) {
      throw new Error("pack_review_id_invalid");
    }
    if (!/^[a-f0-9]{64}$/u.test(input.revision) || !/^[a-f0-9]{64}$/u.test(input.archiveSha256)) {
      throw new Error("pack_community_source_identity_invalid");
    }
    // Validate the mode and dates before source processing, including legacy V1.
    prepareLicense(input, "");

    const pack = validateCreatorSourcePack(input.archive, {
      creatorId: input.creatorId,
      slug: input.slug
    });
    if (pack.archiveSha256 !== input.archiveSha256 || pack.revision !== input.revision) {
      throw new Error("pack_community_source_revision_mismatch");
    }

    const pngFiles = new Map([...pack.files].filter(([name]) => name !== "manifest.json"));
    const signedManifest = {
      ...pack.manifest,
      // Schema 1 cannot carry a license in existing clients; promote its exact
      // data shape to schema 2. Schema 3 already accepts an optional license.
      schema_version: pack.manifest.schema_version === 3 ? 3 : 2,
      publisher: "community",
      review_id: input.reviewId,
      license: prepareLicense(input, contentHash(pngFiles))
    };
    const signer = createSign("SHA256");
    signer.update(licenseMessage(signedManifest));
    signer.end();
    const signature = signer.sign({ key: this.#privateKey, dsaEncoding: "ieee-p1363" });
    if (signature.length !== 64) throw new Error("pack_signature_invalid");
    signedManifest.license.signature = signature.toString("hex");

    // V1/V2 bind ID/version, PNG hash and license fields. review_id retains
    // its existing structural validation; neither protocol signs that label.
    const archive: Record<string, Uint8Array> = {
      "manifest.json": Buffer.from(`${JSON.stringify(signedManifest, null, 2)}\n`, "utf8")
    };
    for (const [name, data] of pngFiles) archive[name] = data;
    const content = Buffer.from(zipSync(archive, {
      level: 0,
      mtime: new Date("2020-01-01T00:00:00.000Z")
    }));
    if (content.length > MAX_PACK_BYTES) throw new Error("pack_archive_too_large");
    return {
      filename: `community-${input.downloadId}.nmgpack`,
      content,
      importBefore: input.licenseMode === "perpetual" ? null : input.expiresAt!.toISOString()
    };
  }
}
