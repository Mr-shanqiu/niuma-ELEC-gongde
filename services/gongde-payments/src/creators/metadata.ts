import { z } from "zod";
import type { FreeWorkMetadata } from "./repository.js";
import { FREE_CREATOR_TERMS_VERSION } from "./consent.js";
import { CreatorError } from "./types.js";

const text = (maximum: number) => z.string().transform(value => value.normalize("NFC").trim())
  .refine(value => Array.from(value).length >= 1 && Array.from(value).length <= maximum &&
    !/[\x00-\x1f\x7f-\x9f\u2028\u2029]/u.test(value));
const fields = z.object({ titleZh: text(20), description: text(40),
  tags: z.array(text(8)).max(3).optional(),
  creatorDouyinNumber: z.string().nullable().optional(),
  sharingTermsVersion: z.literal(FREE_CREATOR_TERMS_VERSION).optional(),
  acceptFreeDistribution: z.literal(true).optional()
}).strict();

export function normalizeCreatorDouyinNumber(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string") throw new CreatorError("creator_metadata_invalid", 400, "creatorDouyinNumber");
  const number = value.trim();
  if (!number) return null;
  if (!/^[A-Za-z0-9_.-]{1,32}$/u.test(number)) {
    throw new CreatorError("creator_metadata_invalid", 400, "creatorDouyinNumber");
  }
  return number;
}

export function parseCreatorMetadata(input: unknown, previous?: FreeWorkMetadata): FreeWorkMetadata {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new CreatorError("creator_metadata_invalid");
  const raw = input as Record<string, unknown>;
  const parsed = fields.safeParse({ ...raw,
    titleZh: raw.titleZh === undefined ? previous?.titleZh : raw.titleZh,
    description: raw.description === undefined ? previous?.description : raw.description,
    tags: raw.tags === undefined ? previous?.tags ?? [] : raw.tags });
  if (!parsed.success) {
    throw new CreatorError("creator_metadata_invalid", 400, String(parsed.error.issues[0]?.path[0] ?? "metadata"));
  }
  const creatorDouyinNumber = normalizeCreatorDouyinNumber(parsed.data.creatorDouyinNumber === undefined ?
    previous?.creatorDouyinNumber : parsed.data.creatorDouyinNumber);
  return { titleZh: parsed.data.titleZh, description: parsed.data.description,
    tags: [...new Set(parsed.data.tags)], creatorDouyinNumber, priceFen: 0,
    sharingTermsVersion: FREE_CREATOR_TERMS_VERSION };
}
