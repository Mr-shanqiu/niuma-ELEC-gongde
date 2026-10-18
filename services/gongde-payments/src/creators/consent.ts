import { createHash } from "node:crypto";
import type { FreeWorkMetadata } from "./repository.js";

export const LEGACY_PAID_CREATOR_TERMS_VERSION = "creator-paid-distribution-v1";
export const FREE_CREATOR_TERMS_VERSION = "creator-free-distribution-v2-20261008";
export const FREE_CREATOR_AI_TERMS_VERSION = "creator-ai-review-v2-20261008";
export const FREE_CREATOR_TERMS =
  "我拥有或已取得本作品及全部素材的合法授权，包括使用其他 AI 工具时所需的授权。" +
  "我同意牛马电子功德存储、校验、预览、审核并向持有有效领取码的用户免费交付本作品。" +
  "平台不收取本作品下载费用，也不向作者支付分成。推广码提供可重复使用的领取权限，不是现金、余额或可提现收益。" +
  "合法领取的文件可长期保存、随时离线导入和使用，下架或更新不使这些本地文件失效；平台可因违规、侵权或安全问题暂停后续分发。" +
  "我不上传违法、有害、侵权内容或他人的个人信息。";
export const FREE_CREATOR_AI_TERMS =
  "我同意平台将本作品的图片、公开名称、介绍、标签、素材署名及我选填的公开抖音号提交给审核服务进行内容检查。" +
  "登录手机号、验证码、登录凭据和领取码不用于 AI 审核。";
const digest = (text: string) => createHash("sha256").update(text, "utf8").digest("hex");
export const FREE_CREATOR_TERMS_SHA256 = digest(FREE_CREATOR_TERMS);
export const FREE_CREATOR_AI_TERMS_SHA256 = digest(FREE_CREATOR_AI_TERMS);

// Explicit public-text whitelist. Never serialize an account or arbitrary metadata to AI.
export function creatorReviewPublicText(metadata: FreeWorkMetadata) {
  return { titleZh: metadata.titleZh, description: metadata.description, tags: [...metadata.tags],
    creatorDouyinNumber: metadata.creatorDouyinNumber ?? null };
}

export function creatorPublicTextDigest(metadata: FreeWorkMetadata): string {
  return digest(JSON.stringify(creatorReviewPublicText(metadata)));
}

export function hasCurrentFreeConsent(metadata: FreeWorkMetadata | null | undefined): boolean {
  return !!metadata && metadata.priceFen === 0 && metadata.acceptFreeDistribution === true &&
    metadata.sharingTermsVersion === FREE_CREATOR_TERMS_VERSION &&
    metadata.sharingTermsSha256 === FREE_CREATOR_TERMS_SHA256 && metadata.acceptAiContentReview === true &&
    metadata.aiReviewTermsVersion === FREE_CREATOR_AI_TERMS_VERSION &&
    metadata.aiReviewTermsSha256 === FREE_CREATOR_AI_TERMS_SHA256 &&
    metadata.publicTextSha256 === creatorPublicTextDigest(metadata);
}
