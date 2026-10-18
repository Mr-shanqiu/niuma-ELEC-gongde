import type { PoolConnection } from "mysql2/promise";

export type CodeFamilyKind = "GROUP" | "CREATOR";
export type FamilyState = "ACTIVE" | "PAUSED" | "REVOKED";
export type ContributionState = "ACTIVE" | "REVOKED";
export type ClaimState = "PREPARING" | "READY" | "FAILED" | "EXPIRED" | "BLOCKED";
export type FamilyAction = "pause" | "resume" | "rotate" | "revoke" | "restore";

export class FreeDistributionError extends Error {
  constructor(readonly code: string, readonly status: number, readonly details?: Record<string, unknown>) {
    // Deliberately never include input codes, cookies, SQL errors or object keys.
    super(code);
    this.name = "FreeDistributionError";
  }
}

export interface CodeFamily {
  id: string;
  kind: CodeFamilyKind;
  creatorId: string | null;
  publicNumber: string | null;
  state: FamilyState;
  generation: number;
  revision: number;
  activeContributions: number;
  limit: number;
  createdAt: string;
}

export interface Contribution {
  workId: string;
  creatorId: string;
  contentFingerprint: string;
  earnedAt: string;
  state: ContributionState;
  revision: number;
  revokedAt: string | null;
  restoredAt: string | null;
  reason: string | null;
}

export interface CodeAuthorization {
  codeFamilyId: string;
  codeTokenId: string;
  kind: CodeFamilyKind;
  publicNumber: string | null;
  cycleIndex: number;
  generation: number;
  revision: number;
  limit: number;
  serverNow: string;
  expiresAt: string;
}

export interface DownloadSession {
  id: string;
  createdAt: string;
  expiresAt: string;
  authorization: CodeAuthorization | null;
}

// These are SERVER-resolved snapshots, not accepted directly from a request body.
// validateItems must lock catalog/version/consent rows and reject stale snapshots.
export interface ClaimItemSnapshot {
  appearanceNumber: string;
  sourceKind: "official" | "community";
  assetId: string;
  creatorId: string | null;
  versionId: string;
  sourceRevision: string;
  catalogRevision: string;
  metadataSnapshot: Record<string, unknown>;
  consentSnapshot: Record<string, unknown>;
  snapshotRecord?: Record<string, unknown>;
  deliveryBytesUpperBound: number;
}

export interface DeliveryArtifactInput {
  privateObjectKey: string;
  sha256: string;
  bytes: number;
  filename: string;
  format: "nmgpack" | "nmgpacks";
  licenseMode: "perpetual";
  signerVersion: string;
}

export interface DeliveryArtifact extends DeliveryArtifactInput {
  createdAt: string;
}

export interface Claim {
  id: string;
  kind: "APPEARANCES";
  codeFamilyId: string;
  codeTokenId: string;
  cycleIndex: number;
  limitSnapshot: number;
  state: ClaimState;
  revision: number;
  createdAt: string;
  issuedAt: string | null;
  downloadExpiresAt: string | null;
  licenseMode: "perpetual";
  importExpiresAt: null;
  errorCode: string | null;
  retryable: boolean;
  stage: "queued" | "preparing_resources" | "generating_file";
  attempts: number;
  items: ClaimItemSnapshot[];
  artifact: DeliveryArtifact | null;
  deliverArtifact: DeliveryArtifact | null;
}

export interface AuditMutation {
  expectedRevision: number;
  actor: string;
  reason: string;
  requestId?: string;
}

export interface RepositoryOptions {
  // Dedicated distribution key. No creator-session/payment/signing-key fallback.
  codeSecret: Uint8Array;
  enabled?: boolean;
  now?: () => Date;
  // Mandatory for new claims. Pure database work inside this transaction only.
  validateItems?: (connection: PoolConnection, items: readonly ClaimItemSnapshot[]) => Promise<void>;
  // Mandatory before preparation/READY/download. Return false for safety/copyright
  // blocks, NOT ordinary unpublication, creator pause or a newer published version.
  checkSafety?: (connection: PoolConnection, items: readonly ClaimItemSnapshot[]) => Promise<boolean>;
  deliveryReady?: () => boolean;
}

export type FreeDistributionConnection = PoolConnection;
export interface AdminCodeSnapshot {
  familyId: string | null;
  revision: number | null;
  kind: CodeFamilyKind;
  status: "ACTIVE" | "PAUSED" | "INACTIVE";
  code: string | null;
  validFrom: string | null;
  expiresAt: string | null;
  contributionCount: number;
  maxItems: number;
  redemptionEnabled: boolean;
}
export interface AdminContribution {
  workId: string;
  revision: number;
  state: ContributionState;
  title?: string;
  number?: string;
  grantedAt: string;
  revokedAt: string | null;
  restoredAt: string | null;
  reason: string | null;
}
export interface AdminCreatorPromotion extends AdminCodeSnapshot {
  creatorId: string;
  authorPublicNumber: string;
  accountState: string;
  workCount: number;
  contributions: AdminContribution[];
}
export interface AdminCreatorSummary {
  creatorId: string;
  authorPublicNumber: string;
  accountState: string;
  workCount: number;
  contributionCount: number;
  maxItems: number;
  codeStatus: AdminCodeSnapshot["status"];
  familyId: string | null;
  revision: number | null;
}
export interface AdminClaimSummary {
  claimId: string;
  kind: CodeFamilyKind;
  authorPublicNumber: string | null;
  codeFamilyId: string;
  state: ClaimState;
  items: { number: string; title: string; catalogRevision: string }[];
  bytes: number | null;
  durationMs: number | null;
  createdAt: string;
  issuedAt: string | null;
  downloadExpiresAt: string | null;
  error: string | null;
}
export interface AdminQuery {
  page?: number;
  perPage?: number;
  from?: string;
  to?: string;
  state?: string;
  familyId?: string;
}
export interface AdminStats {
  readyClaims: number | null;
  workClaims: number | null;
  verifiedCodes: number | null;
  installerRequests: null;
}

export interface ListOptions {
  limit?: number;
  offset?: number;
  familyId?: string;
  creatorId?: string;
  state?: string;
}

export interface FreeDistributionStats {
  successfulVerifications: number;
  readyClaims: number;
  readyAppearanceItems: number;
  activeContributions: number;
  claimsByState: Partial<Record<ClaimState, number>>;
  clientFileRequests: null;
}
