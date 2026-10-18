import { OFFICIAL_ASSET_IDS, OFFICIAL_ASSET_NAMES_ZH } from "./catalog.js";
import { AppearanceNumberError, normalizeAppearanceNumber, type AppearanceNumberRecord } from "./appearance-numbers.js";

export interface NumberedAppearance extends AppearanceNumberRecord {
  titleZh: string;
  state: string;
  sharePath: string | null;
}
export interface OfficialAppearanceState { revision: string | null; state: "PUBLISHED" | "UNPUBLISHED" | "MISSING" }
export interface AppearanceNumberQueryDependencies {
  find(number: string): Promise<AppearanceNumberRecord | null>;
  officialState(assetId: string): Promise<OfficialAppearanceState>;
  communityWork(workId: string, admin: boolean): Promise<{ appearanceNumber: string; titleZh: string; state: string }>;
}

// A registry hit is an identity, never publication permission or a download grant.
export async function queryAppearanceNumber(value: string, dependencies: AppearanceNumberQueryDependencies,
  admin = false): Promise<NumberedAppearance> {
  const number = normalizeAppearanceNumber(value);
  const item = await dependencies.find(number);
  const missing = () => new AppearanceNumberError("appearance_not_found", 404);
  if (!item) throw missing();
  if (item.appearanceNumber !== number) throw new AppearanceNumberError("appearance_numbers_unavailable", 503);
  if (item.sourceKind === "official") {
    if (!(OFFICIAL_ASSET_IDS as readonly string[]).includes(item.internalId)) throw missing();
    const current = await dependencies.officialState(item.internalId);
    if (!admin && (current.state !== "PUBLISHED" || !current.revision)) throw missing();
    return { ...item, titleZh: OFFICIAL_ASSET_NAMES_ZH[item.internalId], state: current.state,
      sharePath: current.state === "PUBLISHED" ? `/index.html?number=${number}#characters` : null };
  }
  let current;
  try { current = await dependencies.communityWork(item.internalId, admin); }
  catch (error) {
    if ((error as { status?: number })?.status === 404) throw missing();
    throw new AppearanceNumberError("appearance_numbers_unavailable", 503);
  }
  if (!admin && current.state !== "PUBLISHED") throw missing();
  if (current.appearanceNumber !== number) throw new AppearanceNumberError("appearance_numbers_unavailable", 503);
  return { ...item, titleZh: current.titleZh, state: current.state,
    sharePath: current.state === "PUBLISHED" ? `/community.html?number=${number}` : null };
}
