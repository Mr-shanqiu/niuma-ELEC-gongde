import { useMemo } from "react";
import { useApiRead } from "./api";
import type { ReadState } from "./api";

/**
 * The site's public preview index, read from the same origin the console is
 * served from (`/assets/previews/source-map.json`).
 *
 * Two things come from it, and neither is guessed here:
 *   - which asset ids have a public preview at all (19 of the 21 official ones
 *     do; the two button packs are not in the index)
 *   - the directory each preview lives in
 *
 * When the index cannot be read the gallery says so. A preview that fails to
 * load is a rendering problem; an asset absent from this index is a different
 * fact, and only the server decides the second one.
 */
export type PreviewIndex = {
  schemaVersion: number;
  packs: Record<string, { id?: string; version?: string }>;
};

const INDEX_URL = "/assets/previews/source-map.json";

/**
 * Module scope on purpose: a guard defined inside the hook gets a new identity
 * on every render, which would restart the read each time and never settle.
 */
const isPreviewIndex = (body: Record<string, unknown>): boolean =>
  typeof body.schemaVersion === "number" && Boolean(body.packs) && typeof body.packs === "object";

export function usePreviewIndex() {
  const read = useApiRead<PreviewIndex>(INDEX_URL, { expect: isPreviewIndex });

  const byAsset = useMemo(() => {
    const map = new Map<string, string>();
    if (read.state.status !== "ready" && read.state.status !== "empty") return map;
    for (const [slug, entry] of Object.entries(read.state.data.packs)) {
      if (typeof entry?.id === "string") map.set(entry.id, slug);
    }
    return map;
  }, [read.state]);

  return { state: read.state as ReadState<PreviewIndex>, byAsset, reload: read.reload };
}
