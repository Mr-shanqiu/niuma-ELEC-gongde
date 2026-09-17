import { createHash, createPrivateKey, createSign } from "node:crypto";
import { lstatSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { zipSync } from "fflate";

const MAX_PACK_BYTES = 50 * 1024 * 1024;
const MAX_MANIFEST_BYTES = 64 * 1024;
const ALLOWED_ASSETS: Readonly<Record<string, string>> = Object.freeze({
  "official.lucky-cat": "lucky-cat",
  "official.hamster-wheel": "hamster-wheel",
  "official.sea-lion-belly-pat": "sea-lion-belly-pat",
  "official.chick-pecking": "chick-pecking"
});

interface SourceManifest {
  schema_version: number;
  id: string;
  version: string;
  preview: string;
  layers: Array<{ image: string }>;
  [key: string]: unknown;
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
  return Buffer.from(
    `NIUMA-PACK-LICENSE-V1\n${manifest.id}\n${manifest.version}\n${license.issued_at}\n${license.import_before}\n${license.download_id}\n${license.content_sha256}`,
    "utf8"
  );
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

  constructor(private readonly configuration: PackSignerConfiguration) {
    const pem = readRegularFile(configuration.privateKeyFile, "pack_signing_key");
    this.#privateKey = createPrivateKey(pem);
    if (this.#privateKey.asymmetricKeyType !== "ec" || this.#privateKey.asymmetricKeyDetails?.namedCurve !== "prime256v1") {
      throw new Error("pack_signing_key_must_be_p256");
    }
  }

  build(input: {
    assetId: string;
    downloadId: string;
    issuedAt: Date;
    expiresAt: Date;
  }): { filename: string; content: Buffer; importBefore: string } {
    const directoryName = ALLOWED_ASSETS[input.assetId];
    if (!directoryName) throw new Error("pack_asset_not_registered");
    if (!/^[A-Za-z0-9_-]{16,128}$/u.test(input.downloadId)) throw new Error("pack_download_id_invalid");
    const issuedAt = Math.floor(input.issuedAt.getTime() / 1000);
    const importBefore = Math.floor(input.expiresAt.getTime() / 1000);
    if (!Number.isSafeInteger(issuedAt) || !Number.isSafeInteger(importBefore) || importBefore <= issuedAt || importBefore - issuedAt > 86_400) {
      throw new Error("pack_import_window_invalid");
    }

    const root = join(this.configuration.assetRoot, directoryName);
    const entries = readdirSync(root, { withFileTypes: true });
    if (entries.length < 2 || entries.length > 8 || entries.some((entry) => !entry.isFile() || entry.isSymbolicLink())) {
      throw new Error("pack_source_files_invalid");
    }
    const manifestBytes = readRegularFile(join(root, "manifest.json"), "pack_manifest");
    if (manifestBytes.length > MAX_MANIFEST_BYTES) throw new Error("pack_manifest_too_large");
    const manifest = JSON.parse(manifestBytes.toString("utf8")) as SourceManifest;
    if (manifest.schema_version !== 1 || manifest.id !== input.assetId || !Array.isArray(manifest.layers) || !safePngName(manifest.preview)) {
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
    const signedManifest = {
      ...manifest,
      schema_version: 2,
      license: {
        mode: "timed",
        issued_at: issuedAt,
        import_before: importBefore,
        download_id: input.downloadId,
        content_sha256: contentHash(pngFiles),
        signature: ""
      }
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
    const content = Buffer.from(zipSync(archive, { level: 9, mtime: new Date("2020-01-01T00:00:00.000Z") }));
    if (content.length > MAX_PACK_BYTES) throw new Error("pack_archive_too_large");
    return {
      filename: `${input.assetId}-${input.downloadId}.nmgpack`,
      content,
      importBefore: input.expiresAt.toISOString()
    };
  }
}
