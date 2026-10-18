export type CodeSnapshot = {
  familyId: string | null; revision: number | null; kind: "GROUP" | "CREATOR";
  status: "ACTIVE" | "PAUSED" | "INACTIVE"; code: string | null;
  validFrom: string | null; expiresAt: string | null;
  contributionCount: number; maxItems: number; redemptionEnabled: boolean;
};
export type Contribution = {
  workId: string; revision: number; state: "ACTIVE" | "REVOKED";
  title?: string; number?: string; grantedAt: string;
  revokedAt: string | null; restoredAt: string | null; reason: string | null;
};
export type Promotion = CodeSnapshot & {
  creatorId: string; authorPublicNumber: string; accountState: string;
  workCount: number; contributions: Contribution[];
};
export type Envelope<T> = { data: T; serverTime: string; requestId?: string };
export type CreatorListItem = {
  creatorId: string; authorPublicNumber: string; accountState: string; workCount: number;
  contributionCount: number; maxItems: number; codeStatus: "ACTIVE" | "PAUSED" | "INACTIVE";
  familyId: string | null; revision: number | null;
};
export type ReportRecord = {
  id: string; number: string; versionId: string | null; state: "OPEN" | "RESOLVED";
  category: string; description: string; evidence: string | null; contact: string | null;
  createdAt: string; resolvedAt: string | null; resolution: string | null;
};

export async function distributionRequest(path: string, init: RequestInit = {}): Promise<Envelope<any>> {
  const response = await fetch(`/api/gongde/v2/admin${path}`, {
    ...init, credentials: "same-origin", cache: "no-store",
    headers: { "content-type": "application/json", ...(init.headers ?? {}) }
  });
  const body = await response.json().catch(() => null);
  if (!response.ok) {
    const error = new Error(typeof body?.message === "string" ? body.message : response.status === 409 ?
      "记录已变更，请刷新后重新确认操作和原因。" : response.status === 401 ?
      "管理员会话已过期，请重新登录。" : "分发接口暂时不可用，请稍后重试。") as Error & { status?: number };
    error.status = response.status;
    if (response.status === 429) error.message += ` 请等待 ${response.headers.get("retry-after") ?? "服务提示的"} 秒。`;
    throw error;
  }
  if (!body || !("data" in body) || !Number.isFinite(Date.parse(body.serverTime))) {
    throw new Error("接口响应结构尚未确认，未采用旧数据或推测值。请协调服务端接口。");
  }
  return body;
}

export function requireCodeSnapshot(value: any): CodeSnapshot {
  const familyValid = value && (typeof value.familyId === "string" && Boolean(value.familyId) &&
    Number.isSafeInteger(value.revision) && value.revision >= 0 ||
    value.kind === "CREATOR" && value.familyId === null && value.revision === null &&
    value.status === "INACTIVE" && value.code === null && value.validFrom === null &&
    value.expiresAt === null && value.contributionCount === 0 && value.maxItems === 0);
  if (!value || !familyValid ||
      !["GROUP", "CREATOR"].includes(value.kind) || !["ACTIVE", "PAUSED", "INACTIVE"].includes(value.status) ||
      !(value.code === null || typeof value.code === "string") ||
      ![value.validFrom, value.expiresAt].every(item => item === null || typeof item === "string" && Number.isFinite(Date.parse(item))) ||
      !Number.isSafeInteger(value.contributionCount) || value.contributionCount < 0 ||
      !Number.isSafeInteger(value.maxItems) || value.maxItems < 0 || value.maxItems > 10 ||
      typeof value.redemptionEnabled !== "boolean") {
    throw new Error("码状态或修订字段尚未确认，已禁用变更和公告复制。");
  }
  return value;
}

export function requireCreatorListItem(value: any): CreatorListItem {
  const familyValid = value && (typeof value.familyId === "string" && Boolean(value.familyId) &&
    Number.isSafeInteger(value.revision) && value.revision >= 0 ||
    value.familyId === null && value.revision === null && value.codeStatus === "INACTIVE" &&
    value.contributionCount === 0 && value.maxItems === 0);
  if (!value || !familyValid || typeof value.creatorId !== "string" || !value.creatorId ||
      typeof value.authorPublicNumber !== "string" || !value.authorPublicNumber ||
      typeof value.accountState !== "string" || !value.accountState ||
      ![value.workCount, value.contributionCount, value.maxItems].every(item => Number.isSafeInteger(item) && item >= 0) ||
      value.maxItems > 10 || !["ACTIVE", "PAUSED", "INACTIVE"].includes(value.codeStatus)) {
    throw new Error("作者列表结构尚未确认，未补写作者、贡献或修订信息。");
  }
  return value;
}

export function requireReportRecord(value: any): ReportRecord {
  if (!value || typeof value.id !== "string" || !value.id ||
      typeof value.number !== "string" || !/^[1-9][0-9]{5,8}$/.test(value.number) ||
      !(value.versionId === null || typeof value.versionId === "string") ||
      !["OPEN", "RESOLVED"].includes(value.state) ||
      typeof value.category !== "string" || typeof value.description !== "string" ||
      !(value.evidence === null || typeof value.evidence === "string") ||
      !(value.contact === null || typeof value.contact === "string") ||
      typeof value.createdAt !== "string" || !Number.isFinite(Date.parse(value.createdAt)) ||
      !(value.resolvedAt === null || typeof value.resolvedAt === "string" && Number.isFinite(Date.parse(value.resolvedAt))) ||
      !(value.resolution === null || typeof value.resolution === "string")) {
    throw new Error("官网举报返回结构尚未确认，未使用社区版权举报或推测数据补齐。");
  }
  return value;
}

export function requirePromotion(value: any): Promotion {
  requireCodeSnapshot(value);
  if (value.kind !== "CREATOR" || typeof value.creatorId !== "string" ||
      typeof value.authorPublicNumber !== "string" || typeof value.accountState !== "string" ||
      !Number.isSafeInteger(value.workCount) || value.workCount < 0 || !Array.isArray(value.contributions) ||
      !value.contributions.every((item: any) => item && typeof item.workId === "string" &&
        Number.isSafeInteger(item.revision) && item.revision >= 0 && ["ACTIVE", "REVOKED"].includes(item.state))) {
    throw new Error("作者或贡献明细结构尚未确认，未显示推测的贡献总数。");
  }
  return value;
}

export function formatTime(value?: string | null): string {
  if (!value || !Number.isFinite(Date.parse(value))) return "未提供";
  return new Intl.DateTimeFormat("zh-CN", {
    timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23"
  }).format(new Date(value));
}
export function codeUsable(data: CodeSnapshot, now: number): boolean {
  return data.status === "ACTIVE" && Boolean(data.code) && Boolean(data.validFrom) &&
    Boolean(data.expiresAt) && Date.parse(data.validFrom!) <= now && Date.parse(data.expiresAt!) > now && data.maxItems > 0;
}
export function groupAnnouncement(data: CodeSnapshot): string {
  return `牛马电子功德基础木鱼直接免费下载，更多形象凭群码免费领取。当前群权益码：${data.code}，每批最多 10 个，可重复领取、不扣次数。此码有效至北京时间 ${formatTime(data.expiresAt)}，每三天更新；已下载形象可长期保存、随时导入。官网下载：https://gongde.zqscreen.cn/`;
}
export function revisionBody(revision: number, reason: string): string {
  if (!Number.isSafeInteger(revision) || revision < 0 || reason.trim().length < 5 || reason.trim().length > 1000) {
    throw new Error("必须使用当前修订号并填写 5 至 1000 字的操作原因。");
  }
  return JSON.stringify({ revision, reason: reason.trim() });
}
