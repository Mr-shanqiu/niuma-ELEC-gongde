import React, { useEffect, useRef, useState } from "react";
import { Alert, Box, Button, Card, CardContent, Checkbox, Chip, FormControlLabel, MenuItem,
  Select, Stack, TextField, Typography } from "@mui/material";

type Request = (path: string, init?: RequestInit) => Promise<any>;
type AutoReviewState = "queued" | "running" | "retry_wait" | "needs_review" | "approved" | "rejected";
type Review = { reviewId: string; versionId: string; workId: string; state: string;
  metadata: { titleZh: string; description: string; tags: string[]; creatorName?: string;
    sharingTermsVersion?: string; acceptPaidDistribution?: boolean; priceFen?: number;
    creatorDouyinNumber?: string | null; acceptFreeDistribution?: boolean; acceptAiContentReview?: boolean;
    aiTermsVersion?: string };
  reason: string | null; submittedAt: string;
  autoReview?: { state: AutoReviewState; attempts: number } };
const labels: Record<string, string> = { PENDING: "待审核", APPROVED: "已通过", REJECTED: "已拒绝", PUBLISHED: "已上架",
  UNPUBLISHED: "已下架", SUSPENDED: "已暂停", DRAFT: "草稿", OPEN: "待处理", RESOLVED: "已暂停作品", DISMISSED: "不采取处置" };
const autoReviewLabels: Record<AutoReviewState, string> = {
  queued: "排队中", running: "审核中", retry_wait: "等待重试",
  needs_review: "待人工复核", approved: "自动审核判断通过", rejected: "自动审核判断拒绝"
};
const checkLabels = { dataOnly: "文件为安全的数据包", realPreview: "已查看真实预览和动作",
  contentAcceptable: "名称、介绍与内容适合公开", rightsDeclaration: "已审查素材来源、当前免费分发及 AI 审核授权快照" };

function autoReviewSummary(value: unknown): string {
  if (!value || typeof value !== "object") return "尚无自动审核记录";
  const autoReview = (value as { autoReview?: { state?: unknown; attempts?: unknown } }).autoReview;
  if (!autoReview || typeof autoReview !== "object") return "尚无自动审核记录";
  const stage = typeof autoReview.state === "string" && autoReview.state in autoReviewLabels ?
    autoReviewLabels[autoReview.state as AutoReviewState] : "状态未知（未自动放行）";
  const attempts = Number.isSafeInteger(autoReview.attempts) && (autoReview.attempts as number) >= 0 ?
    String(autoReview.attempts) : "未提供";
  return `自动审核：${stage} · 尝试 ${attempts} 次`;
}

function errorText(error: unknown): string {
  const code = error instanceof Error ? error.message : "";
  if (code === "creator_disabled") return "共创服务暂未启用，当前没有开放投稿或分发。";
  if (code === "creator_admin_auth_required") return "管理员登录已过期，请重新登录。";
  if (code === "creator_review_changed" || code === "creator_complaint_changed") return "记录已被处理，请刷新列表。";
  return "社区操作暂时无法完成，请检查服务状态或稍后重试。";
}

type PreviewPlayer = { strike: () => void; destroy: () => void };

function CreatorVersionPreview({ version, onReady }: { version: any; onReady: (ready: boolean) => void }) {
  const stage = useRef<HTMLDivElement>(null);
  const [player, setPlayer] = useState<PreviewPlayer | null>(null);
  const [failed, setFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    const container = stage.current;
    let active = true;
    let mounted: PreviewPlayer | null = null;
    onReady(false); setPlayer(null); setFailed(false);
    if (!container) return;
    container.replaceChildren();
    const moduleUrl = new URL("/community-preview.js?v=free-community-20261008", location.origin).href;
    void import(/* @vite-ignore */ moduleUrl).then(module => {
      if (!active) return null;
      if (typeof module.mountCreatorPreview !== "function") throw new Error("creator_preview_unavailable");
      return module.mountCreatorPreview(container, version) as Promise<PreviewPlayer>;
    }).then(result => {
      if (!result) return;
      if (!active) { result.destroy(); return; }
      mounted = result; setPlayer(result); onReady(true);
    }).catch(() => { if (active) { setFailed(true); onReady(false); } });
    return () => { active = false; mounted?.destroy(); onReady(false); };
  }, [version, onReady, attempt]);

  return <Box className="creator-admin-preview" role="group" aria-label="当前投稿版本真实预览"
    data-preview-version={version.versionId} data-preview-ready={player ? "true" : "false"}
    sx={{ height: "auto", minHeight: 230, display: "grid", justifyItems: "center", alignContent: "center", gap: 1, my: 2, p: 2 }}>
    <Box ref={stage} sx={{ width: 240, height: 170, display: "grid", placeItems: "center" }} />
    {failed ? <Alert severity="warning">真实预览暂时无法加载，请确认登录状态和素材存储，不要批准此版本。</Alert> :
      <Typography variant="caption" role="status">{player ? `版本 ${version.versionLabel} · 真实文件预览` : "正在读取投稿文件的真实素材…"}</Typography>}
    <Stack direction="row" gap={1}>
      <Button variant="outlined" disabled={!player} onClick={() => player?.strike()}>播放动作</Button>
      {failed && <Button variant="outlined" onClick={() => setAttempt(value => value + 1)}>重试真实预览</Button>}
    </Stack>
  </Box>;
}

export function CreatorCommunityPanel({ request }: { request: Request }) {
  const [view, setView] = useState<"reviews" | "works" | "complaints">("reviews");
  const [state, setState] = useState("PENDING");
  const [offset, setOffset] = useState(0);
  const [records, setRecords] = useState<any[]>([]);
  const [selected, setSelected] = useState<any>(null);
  const [reason, setReason] = useState("");
  const [checks, setChecks] = useState({ dataOnly: false, realPreview: false, contentAcceptable: false, rightsDeclaration: false });
  const [previewReady, setPreviewReady] = useState(false);
  const [version, setVersion] = useState<any>(null);
  const [loading, setLoading] = useState(true), [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  const [reload, setReload] = useState(0);

  useEffect(() => {
    let active = true;
    setLoading(true); setNotice(""); setSelected(null); setVersion(null);
    request(`/creators/${view}?state=${state}&offset=${offset}`).then(result => {
      if (active) setRecords(result[view] ?? []);
    }).catch(error => { if (active) { setRecords([]); setNotice(errorText(error)); } })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [request, view, state, offset, reload]);

  useEffect(() => {
    setPreviewReady(false); setReason(""); setVersion(null);
    setChecks({ dataOnly: false, realPreview: false, contentAcceptable: false, rightsDeclaration: false });
    const versionId = selected?.versionId ?? selected?.publishedVersionId;
    if (!versionId) return;
    let active = true;
    request(`/creators/versions/${versionId}`).then(result => {
      if (!active) return;
      if (result.versionId !== versionId || !result.manifest || !result.images) throw new Error("creator_preview_invalid");
      setVersion(result);
    })
      .catch(error => { if (active) setNotice(errorText(error)); });
    return () => { active = false; };
  }, [request, selected]);

  const switchView = (next: typeof view) => {
    setView(next); setState(next === "reviews" ? "PENDING" : next === "works" ? "PUBLISHED" : "OPEN"); setOffset(0);
  };
  const mutation = async (path: string, body: unknown) => {
    setBusy(true); setNotice("");
    try {
      await request(path, { method: "POST", body: JSON.stringify(body) });
      setSelected(null); setReload(value => value + 1);
    } catch (error) { setNotice(errorText(error)); }
    finally { setBusy(false); }
  };
  const options = view === "reviews" ? ["PENDING", "APPROVED", "REJECTED"] :
    view === "works" ? ["PUBLISHED", "UNPUBLISHED", "SUSPENDED", "DRAFT"] : ["OPEN", "RESOLVED", "DISMISSED"];
  const metadata = view === "works" && selected?.publishedVersionId ? selected.publishedMetadata : selected?.metadata;
  const versionId = selected?.versionId ?? selected?.publishedVersionId;
  const freeConsentConfirmed = metadata?.sharingTermsVersion === "creator-free-distribution-v2-20261008" &&
    metadata?.acceptFreeDistribution === true && metadata?.acceptAiContentReview === true;
  const selectedCreatorId = selected?.creatorId ?? version?.creatorId ??
    (typeof selected?.workId === "string" ? /^creator\.([a-f0-9]{32})\./.exec(selected.workId)?.[1] : undefined);

  return <Box className="creator-admin-shell">
    <Box className="dashboard-heading"><div><Typography variant="overline">CO-CREATION REVIEW</Typography><Typography variant="h4">共创审核与作品管理</Typography></div><Chip label="免费分发 · 复用现有审核记录" color="secondary" /></Box>
    <Stack direction="row" flexWrap="wrap" gap={1} mb={2}>
      <Button variant={view === "reviews" ? "contained" : "outlined"} onClick={() => switchView("reviews")}>投稿审核</Button>
      <Button variant={view === "works" ? "contained" : "outlined"} onClick={() => switchView("works")}>公开作品与下架</Button>
      <Button variant={view === "complaints" ? "contained" : "outlined"} onClick={() => switchView("complaints")}>版权与内容举报</Button>
      <Select size="small" aria-label="记录状态" value={state} onChange={event => { setState(event.target.value); setOffset(0); }}>{options.map(value => <MenuItem key={value} value={value}>{labels[value]}</MenuItem>)}</Select>
      <Button disabled={loading || busy} onClick={() => setReload(value => value + 1)}>刷新</Button>
    </Stack>
    {notice && <Alert severity="warning" sx={{ mb: 2 }}>{notice}</Alert>}
    <Box className="creator-admin-grid">
      <Card><CardContent><Typography variant="h6">{labels[state]}记录</Typography>
        {loading ? <Typography color="text.secondary" py={3}>正在读取…</Typography> : records.length === 0 ? <Typography color="text.secondary" py={3}>暂无此状态的记录。</Typography> :
          <Stack gap={1} mt={2}>{records.map(record => {
            const key = record.reviewId ?? record.complaintId ?? record.workId;
            const selectedKey = selected?.reviewId ?? selected?.complaintId ?? selected?.workId;
            const recordMetadata = view === "works" && record.publishedVersionId ? record.publishedMetadata : record.metadata;
            return <Button className="creator-admin-record" key={key} variant={key === selectedKey ? "outlined" : "text"} onClick={() => setSelected(record)} disabled={busy}>
              <Box><Typography fontWeight={750}>{recordMetadata?.titleZh ?? (record.complaintId ? "内容举报" :
                view === "reviews" ? "送审文字快照未确认" : record.publishedVersionId ? "发布文字快照未确认" : record.workId)}</Typography>
                <Typography variant="caption" color="text.secondary">{labels[record.state]} · {new Date(record.submittedAt ?? record.createdAt).toLocaleString("zh-CN")}</Typography>
                {view === "reviews" && <Typography variant="caption" color={record.autoReview?.state === "needs_review" ? "warning.main" : "text.secondary"}>
                  {autoReviewSummary(record)}
                </Typography>}</Box>
            </Button>;
          })}</Stack>}
        <Stack direction="row" justifyContent="space-between" mt={2}><Button disabled={offset === 0 || loading || busy} onClick={() => setOffset(value => Math.max(0, value - 50))}>上一页</Button><Typography variant="caption" alignSelf="center">第 {Math.floor(offset / 50) + 1} 页</Typography><Button disabled={records.length < 50 || loading || busy} onClick={() => setOffset(value => value + 50)}>下一页</Button></Stack>
      </CardContent></Card>
      <Card><CardContent>
        {!selected ? <Typography color="text.secondary" py={4}>选择一份记录，查看确切版本、真实预览和审核资料。</Typography> : <>
          <Typography variant="overline">{view === "complaints" ? "REPORT DETAILS" :
            view === "works" && !selected.publishedVersionId ? "DRAFT METADATA" : "IMMUTABLE VERSION"}</Typography>
          <Typography variant="h5">{metadata?.titleZh ?? (view === "complaints" ? "举报详情" :
            view === "reviews" ? "送审文字快照未确认" : selected.publishedVersionId ? "发布文字快照未确认" : "草稿资料未确认")}</Typography>
          <Typography className="creator-admin-copy" color="text.secondary" my={2}>{metadata?.description ??
            (view === "complaints" ? selected.description : "对应文字记录未确认，不使用其他版本或当前草稿补齐。")}</Typography>
          {((view === "works" && selected.publishedVersionId) || view === "reviews") && !metadata &&
            <Alert severity="warning" sx={{ my: 2 }}>该版本文字快照缺失，未回退到当前草稿；预览文件不代表文字快照已确认。</Alert>}
          {metadata?.creatorName && <Typography variant="body2">作者：{metadata.creatorName}</Typography>}
          {metadata && <Box my={2}><Typography variant="body2">作品公开抖音号（本次版本快照）：{metadata.creatorDouyinNumber || "未填写，不影响发布或贡献"}</Typography>
            {metadata.creatorDouyinNumber && <Button size="small" variant="outlined" onClick={() => {
              void navigator.clipboard.writeText(metadata.creatorDouyinNumber!).then(() => setNotice("作品抖音号已复制。")).catch(() => setNotice("自动复制失败，请手动选择作品抖音号。"));
            }}>复制作品抖音号</Button>}
            <Typography variant="caption" color="text.secondary">作者主动填写，不是登录手机号，也不代表账号认证。待审修改需撤回后重新审核。</Typography></Box>}
          {selectedCreatorId && <Button size="small" href={`#/creatorPromotion?creatorId=${encodeURIComponent(selectedCreatorId)}`}>查看作者唯一码与贡献明细</Button>}
          {selected.appearanceNumber && <Typography variant="body2">作品编号：#{selected.appearanceNumber}</Typography>}
          <Typography className="creator-admin-id" variant="caption">作品：{selected.workId}</Typography>
          {view === "reviews" && <Alert severity={selected.autoReview?.state === "needs_review" ? "warning" : "info"} sx={{ my: 2 }}>
            <Typography fontWeight={700}>自动审核阶段</Typography>
            <Typography variant="body2">{autoReviewSummary(selected)}</Typography>
            {selected.autoReview?.state === "needs_review" &&
              <Typography variant="body2">AI 无法确认或审核过程异常，本项未自动放行；请按现有人工复核权限与核查项处理。</Typography>}
            {selected.autoReview?.state === "approved" &&
              <Typography variant="body2">自动审核判断不代替平台的审核状态，也不会自动勾选人工核查项。</Typography>}
            {selected.autoReview?.state === "rejected" &&
              <Typography variant="body2">自动审核判断拒绝不代表已执行人工决定；作品不会因此被自动上架。</Typography>}
            {!selected.autoReview && <Typography variant="body2">此投稿尚无自动审核记录，按现有人工复核流程处理。</Typography>}
          </Alert>}
          {typeof selected.reason === "string" && selected.reason.length > 0 &&
            <Alert severity="info" sx={{ my: 2 }}>{view === "complaints" ? "处理说明" : "审核说明"}：{selected.reason}</Alert>}
          {view === "complaints" && selected.state !== "OPEN" && !selected.reason &&
            <Alert severity="warning" sx={{ my: 2 }}>此记录已结案，但暂未读取到原始处理说明。</Alert>}
          {view === "complaints" && selected.decidedAt &&
            <Typography variant="caption" display="block">处理时间：{new Date(selected.decidedAt).toLocaleString()}</Typography>}
          {selected.category && <Typography variant="body2">举报类型：{selected.category}</Typography>}
          {versionId && <>
            {version?.versionId === versionId && <CreatorVersionPreview key={versionId} version={version} onReady={setPreviewReady} />}
            <Typography variant="caption" color={previewReady ? "success.main" : "text.secondary"}>{previewReady ? "该版本真实预览已加载，请播放动作并人工检查。" : "正在等待真实预览；未加载时不能批准。"}</Typography>
            {version && <Box my={2}><Typography className="creator-admin-id" variant="caption">版本 {version.versionLabel} · 文件 SHA-256：{version.archiveSha256}</Typography><Typography className="creator-admin-id" variant="caption">素材版本：{version.revision}</Typography></Box>}
          </>}
          {view === "reviews" && <Alert severity="info" sx={{ mt: 2 }}>
            <Typography fontWeight={700}>送审时冻结的分发与审核授权记录</Typography>
            <Typography variant="body2">条款版本：{typeof metadata?.sharingTermsVersion === "string" && metadata.sharingTermsVersion.trim() ?
              metadata.sharingTermsVersion : "未确认（记录缺失）"}</Typography>
            <Typography variant="body2">免费分发同意：{metadata?.acceptFreeDistribution === true ? "记录为已同意" : metadata?.acceptFreeDistribution === false ? "记录为未同意" : "未确认（记录缺失）"}</Typography>
            <Typography variant="body2">AI 审核同意：{metadata?.acceptAiContentReview === true ? "记录为已同意" : metadata?.acceptAiContentReview === false ? "记录为未同意" : "未确认（记录缺失）"}</Typography>
            <Typography variant="body2">AI 条款版本：{metadata?.aiTermsVersion ?? "未单独提供，须核对服务端授权证据"}</Typography>
            {metadata?.acceptPaidDistribution === true && <Typography variant="body2" color="warning.main">保留了历史收费授权，但它不证明作者已同意当前免费分发。</Typography>}
            <Typography variant="caption">只展示本次送审记录，不推断或补写作者同意，不以当前平台规则替代记录。</Typography>
          </Alert>}
          {view === "reviews" && selected.state === "PENDING" && <>
            <Alert severity="info" sx={{ mt: 2 }}>
              人工决定用于待复核、自动审核异常或尚无自动审核记录的例外情况。自动审核状态不会替代人工权限，也不会自动勾选以下核查项。
            </Alert>
            <Alert severity="info" sx={{ mt: 2 }}>
              <Typography fontWeight={700}>当前平台规则 · creator-free-distribution-v2-20261008（不代表送审同意记录）</Typography>
              <Typography variant="body2" mt={0.5}>审核通过后免费分发，不收下载费、不分成。首次独立新作实际发布才增加贡献，更新与重上架不重复计数；旧收费授权不能自动转为免费授权。程序安全门禁不可由人工或 AI 绕过。</Typography>
            </Alert>
            {!freeConsentConfirmed && <Alert severity="warning" sx={{ mt: 2 }}>当前免费分发或 AI 授权快照未确认，已禁止批准；请由作者补齐真实授权，不替作者勾选。</Alert>}
            <Typography variant="body2" mt={2}>资料按送审时冻结；批准将公开这一版本，而不是作者后续编辑的草稿。</Typography>
            <Stack mt={1}>{Object.entries(checkLabels).map(([key, label]) => <FormControlLabel key={key}
              control={<Checkbox checked={checks[key as keyof typeof checks]} disabled={busy || (key === "realPreview" && !previewReady)}
                onChange={event => setChecks(value => ({ ...value, [key]: event.target.checked }))} />} label={label} />)}</Stack>
          </>}
          {((view === "reviews" && selected.state === "PENDING") || view === "works" ||
            (view === "complaints" && selected.state === "OPEN")) && <TextField label="处理说明（拒绝、下架或举报处置至少 5 个字）" fullWidth multiline minRows={3} value={reason}
            onChange={event => setReason(event.target.value)} slotProps={{ htmlInput: { maxLength: 1000 } }} sx={{ mt: 2 }} disabled={busy} />}
          <Stack direction="row" useFlexGap flexWrap="wrap" gap={1} mt={2}>
            {view === "reviews" && selected.state === "PENDING" && <>
              <Button variant="contained" disabled={busy || !previewReady || !version || !freeConsentConfirmed || !Object.values(checks).every(Boolean)}
                onClick={() => void mutation(`/creators/reviews/${selected.reviewId}/decision`, { decision: "APPROVED", reason, checks })}>复核通过并免费上架</Button>
              <Button variant="outlined" color="warning" disabled={busy || reason.trim().length < 5}
                onClick={() => void mutation(`/creators/reviews/${selected.reviewId}/decision`, { decision: "REJECTED", reason, checks })}>拒绝并记录原因</Button>
            </>}
            {view === "works" && selected.state === "PUBLISHED" && <Button variant="outlined" color="warning" disabled={busy || reason.trim().length < 5}
              onClick={() => void mutation(`/creators/works/${encodeURIComponent(selected.workId)}/unpublish`, { reason })}>下架，停止新的获取</Button>}
            {view === "works" && selected.state !== "SUSPENDED" && <Button variant="outlined" color="error" disabled={busy || reason.trim().length < 5}
              onClick={() => void mutation(`/creators/works/${encodeURIComponent(selected.workId)}/suspend`, { reason })}>暂停违规作品</Button>}
            {view === "complaints" && selected.state === "OPEN" && <>
              <Button variant="contained" color="warning" disabled={busy || reason.trim().length < 5}
                onClick={() => void mutation(`/creators/complaints/${selected.complaintId}/decision`, { outcome: "SUSPEND", reason })}>暂停作品并结案</Button>
              <Button variant="outlined" disabled={busy || reason.trim().length < 5}
                onClick={() => void mutation(`/creators/complaints/${selected.complaintId}/decision`, { outcome: "DISMISS", reason })}>不处置并记录依据</Button>
            </>}
          </Stack>
          <Typography variant="caption" color="text.secondary" display="block" mt={3}>不删除原始文件和审核记录；无法回收用户已经合法导入的离线副本。举报仅后台处理，不公开展示或自动回复。</Typography>
        </>}
      </CardContent></Card>
    </Box>
  </Box>;
}
