export type CreatorState = "PENDING_EMAIL" | "ACTIVE" | "SUSPENDED";
export type PaidEligibility = "NOT_REQUESTED" | "PENDING" | "APPROVED" | "REJECTED" | "SUSPENDED";
export type WorkState = "DRAFT" | "PUBLISHED" | "UNPUBLISHED" | "SUSPENDED";
export type VersionState =
  | "VALIDATING" | "INVALID" | "READY" | "PENDING_REVIEW"
  | "APPROVED" | "REJECTED" | "SUSPENDED";
export type PayoutState =
  | "DRAFT" | "PENDING_APPROVAL" | "APPROVED" | "SUBMITTED"
  | "AWAITING_CONFIRMATION" | "UNKNOWN" | "SUCCEEDED" | "FAILED" | "CANCELED";

export interface CreatorProfile {
  id: string;
  email: string;
  displayName: string;
  state: CreatorState;
  paidEligibility: PaidEligibility;
  acceptedTermsVersion: string | null;
  createdAt: Date;
  emailVerifiedAt: Date | null;
}

export interface CreatorWork {
  id: string;
  creatorId: string;
  slug: string;
  titleZh: string;
  description: string;
  state: WorkState;
  priceFen: number;
  publishedVersionId: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface CreatorWorkVersion {
  id: string;
  workId: string;
  versionLabel: string;
  revision: string;
  archiveSha256: string;
  sourceObjectKey: string;
  state: VersionState;
  schemaVersion: 1 | 3;
  archiveBytes: number;
  unpackedBytes: number;
  decodedImageBytes: number;
  deliveryBytesUpperBound: number;
  createdAt: Date;
}

export class CreatorError extends Error {
  constructor(
    readonly code: string,
    readonly status: number = 400,
    readonly field?: string
  ) {
    super(code);
    this.name = "CreatorError";
  }
}

export function creatorWorkId(creatorId: string, slug: string): string {
  if (!/^[a-f0-9]{32}$/u.test(creatorId)) throw new CreatorError("creator_identity_invalid");
  if (!/^[a-z0-9](?:[a-z0-9-]{0,30}[a-z0-9])?$/u.test(slug)) {
    throw new CreatorError("creator_work_slug_invalid");
  }
  return "creator." + creatorId + "." + slug;
}
