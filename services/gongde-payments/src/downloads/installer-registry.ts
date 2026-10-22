import { readFileSync } from "node:fs";

/**
 * One installer registry for two readers.
 *
 * `/api/gongde/v2/installers` publishes this list to the website, and the
 * counting redirect only forwards to a URL it finds here. Reading them from two
 * places would let a name be countable while the visible button points
 * elsewhere, and would let anyone count (and be redirected by) a file name they
 * invented. So both go through this module, and the redirect target always comes
 * from the registry entry rather than from the request.
 */
export type RegisteredInstaller = {
  name: string;
  platform: "macos" | "windows";
  format: string;
  releaseId: string;
  version: string;
  bytes: number;
  sha256: string;
  publicDownloadUrl: string;
  perpetualCompatible: boolean;
};

export type InstallerRegistry = {
  /** "unavailable" is a read failure and never means "no installers". */
  status: "available" | "unavailable";
  items: RegisteredInstaller[];
};

const ALLOWED_HOSTS = [
  "download.gongde.zqscreen.cn",
  "github.com",
  "gongde-download-1460392746.cos.ap-shanghai.myqcloud.com"
];

/** The download bucket stores installers at the bucket root, so the object name is the URL's last segment. */
export function installerObjectName(value: string): string | null {
  try {
    const url = new URL(value);
    const segment = url.pathname.split("/").filter(Boolean).at(-1) ?? "";
    return /^[A-Za-z0-9][A-Za-z0-9._-]{0,119}$/u.test(segment) ? segment : null;
  } catch {
    return null;
  }
}

export function loadInstallerRegistry(source: NodeJS.ProcessEnv = process.env): InstallerRegistry {
  let raw: unknown;
  try {
    const path = source.GONGDE_FREE_INSTALLERS_FILE?.trim();
    raw = JSON.parse(path ? readFileSync(path, "utf8") :
      readFileSync(new URL("../free-distribution/installers.json", import.meta.url), "utf8"));
  } catch {
    return { status: "unavailable", items: [] };
  }
  const items = (raw as { items?: unknown } | null)?.items;
  if (!Array.isArray(items) || items.length > 12) return { status: "unavailable", items: [] };
  const parsed: RegisteredInstaller[] = [];
  const names = new Set<string>();
  for (const entry of items) {
    try {
      const value = entry as Record<string, unknown>;
      const url = new URL(String(value.publicDownloadUrl));
      const name = installerObjectName(url.href);
      // Any malformed entry makes the whole list untrustworthy: a partially
      // read registry could silently stop counting a platform.
      if (name === null || names.has(name)) return { status: "unavailable", items: [] };
      if (value.platform !== "windows" && value.platform !== "macos") return { status: "unavailable", items: [] };
      if (typeof value.version !== "string" || !/^\d+\.\d+\.\d+$/u.test(value.version)) return { status: "unavailable", items: [] };
      if (typeof value.sha256 !== "string" || !/^[a-f0-9]{64}$/u.test(value.sha256)) return { status: "unavailable", items: [] };
      if (typeof value.releaseId !== "string" || !/^[A-Za-z0-9._-]{1,128}$/u.test(value.releaseId)) return { status: "unavailable", items: [] };
      if (typeof value.format !== "string" || value.format.length === 0 || value.format.length > 16) return { status: "unavailable", items: [] };
      if (typeof value.perpetualCompatible !== "boolean") return { status: "unavailable", items: [] };
      if (!Number.isSafeInteger(value.bytes) || (value.bytes as number) < 1) return { status: "unavailable", items: [] };
      if (url.protocol !== "https:" || url.username || url.password || !ALLOWED_HOSTS.includes(url.hostname)) {
        return { status: "unavailable", items: [] };
      }
      names.add(name);
      parsed.push({
        name,
        platform: value.platform,
        format: value.format,
        releaseId: value.releaseId,
        version: value.version,
        bytes: value.bytes as number,
        sha256: value.sha256,
        publicDownloadUrl: url.href,
        perpetualCompatible: value.perpetualCompatible
      });
    } catch {
      return { status: "unavailable", items: [] };
    }
  }
  return { status: "available", items: parsed };
}

/**
 * Which website entry points actually go through the counting redirect, and
 * when that started.
 *
 * This is static configuration, not a health signal: it says what is supposed
 * to be counted. Whether the store answers is reported separately, so the admin
 * page can say "collection failed" instead of showing a confident zero.
 *
 * The start time has no default. A published total has to begin somewhere real,
 * and inventing today's date would present a partial count as a full one.
 */
export type DownloadCoverage = {
  status: "configured" | "unconfigured";
  startedAt: string | null;
  entries: string[];
};

/** Entries the site actually renders as counting links. Keep in step with `website/free-flow.js`. */
export const COUNTED_ENTRIES = ["download-page"] as const;

export function loadDownloadCoverage(source: NodeJS.ProcessEnv = process.env): DownloadCoverage {
  const startedAt = source.GONGDE_DOWNLOAD_COUNT_SINCE?.trim() ?? "";
  const parsed = Date.parse(startedAt);
  const configured = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/u.test(startedAt) && Number.isFinite(parsed);
  return {
    status: configured ? "configured" : "unconfigured",
    startedAt: configured ? new Date(parsed).toISOString() : null,
    entries: [...COUNTED_ENTRIES]
  };
}
