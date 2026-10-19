import { useEffect, useState } from "react";
import { Alert, Box, Button, Card, CardContent, Chip, Stack, Table, TableBody, TableCell, TableHead, TableRow, Typography } from "@mui/material";
import { useLogout } from "react-admin";
import { distributionRequest, formatTime } from "./distribution-api";
import { GroupBenefitsPanel } from "./group-benefits";

type ClaimIssue = { claimId: string; state: string; error: string | null; sourceKind: string | null;
  authorPublicNumber: string | null; creatorId: string | null; workNumbers: string[]; createdAt: string; waitingSeconds: number };
type ReviewIssue = { reviewId: string; number: string | null; title: string | null; creatorId: string;
  authorPublicNumber: string | null; submittedAt: string; waitingSeconds: number; autoState: string | null; reasonCode: string | null };
type Overview = {
  asOf: string; thresholds: { claimPreparingMinutes: number; reviewWaitingHours: number };
  claims: { status: string; failed: number | null; blocked: number | null; preparingTooLong: number | null; hasMore: boolean | null; items: ClaimIssue[] };
  reviews: { status: string; pending: number | null; waitingTooLong: number | null; needsReview: number | null; budgetHeld: number | null; hasMore: boolean | null; items: ReviewIssue[] };
  budget: { status: string; mode: string; dailyLimit: number | null; used: number | null; remaining: number | null; startsAt: string; resetsAt: string };
};
const count = (value: unknown) => typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : "未统计";
const duration = (seconds: number) => seconds >= 86400 ? `${Math.floor(seconds / 86400)} 天 ${Math.floor(seconds % 86400 / 3600)} 小时` :
  seconds >= 3600 ? `${Math.floor(seconds / 3600)} 小时 ${Math.floor(seconds % 3600 / 60)} 分` : `${Math.floor(seconds / 60)} 分钟`;
const phase: Record<string, string> = { queued: "排队中", running: "审核中", retry_wait: "等待重试", needs_review: "需要复核" };
const claimState: Record<string, string> = { FAILED: "准备失败", BLOCKED: "安全阻断", PREPARING: "准备时间较长" };
function claimLink(item: ClaimIssue) {
  const date = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(item.createdAt));
  return `#/claims?${new URLSearchParams({ date, claimId: item.claimId })}`;
}

export function OperationsPanel() {
  const [data, setData] = useState<Overview | null>(null), [error, setError] = useState("");
  const [reload, setReload] = useState(0), [loading, setLoading] = useState(false);
  const logout = useLogout();
  useEffect(() => {
    const controller = new AbortController(); setData(null); setError(""); setLoading(true);
    void distributionRequest("/operations", { signal: controller.signal }).then(result => {
      const value = result.data;
      if (!value || !Number.isFinite(Date.parse(value.asOf)) || !value.thresholds || !value.budget ||
        ![value.claims, value.reviews].every(section => section && ["available", "unavailable"].includes(section.status) && Array.isArray(section.items))) {
        throw new Error("运营接口尚未就绪，未将缺失数据显示为零。");
      }
      if (!controller.signal.aborted) setData(value);
    }).catch(failure => {
      if (controller.signal.aborted) return;
      setError(failure instanceof Error ? failure.message : "运营状态读取失败。");
      if (failure.status === 401) void logout();
    }).finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [reload, logout]);
  return <Box className="dashboard-shell">
    <Box className="dashboard-heading"><div><Typography variant="overline">OPERATIONS</Typography><Typography variant="h4">运营与异常总览</Typography></div><Chip label="只读定位 · 不自动重试或放行" color="secondary" /></Box>
    <Stack direction="row" flexWrap="wrap" gap={1} mb={2}>
      <Button variant="contained" disabled={loading} onClick={() => setReload(value => value + 1)}>{loading ? "读取中" : "刷新异常"}</Button>
      <Button href="#/claims">四项领取统计</Button><Button href="#/creatorPromotion">作者来源与贡献</Button>
      <Button href="#/creatorCommunity">审核与作品</Button><Button href="#/installerFiles">安装包引用与保留</Button>
    </Stack>
    <GroupBenefitsPanel compact />
    {error && <Alert severity="warning" sx={{ my: 2 }}>{error}</Alert>}
    {loading && <Typography role="status" mt={2}>正在读取已有领取和审核记录，不发起领取或 AI 审核。</Typography>}
    {data && <>
      <Typography variant="caption" display="block" my={2}>读取时间：{formatTime(data.asOf)}（北京时间）。异常取当前状态，最多列出最早 25 条；不是新增用户、安装人数或关注人数。</Typography>
      <Card sx={{ mb: 2 }}><CardContent>
        <Typography variant="h6">领取准备异常</Typography>
        <Typography my={1}>准备失败 {count(data.claims.failed)} · 准备超过 {data.thresholds.claimPreparingMinutes} 分钟 {count(data.claims.preparingTooLong)} · 安全阻断 {count(data.claims.blocked)}</Typography>
        <Typography variant="body2" color="text.secondary">准备耗时从已有准备起点计算，未记录起点时用创建时间。超时仅是排查提示，不会重建批次或绕过安全阻断。</Typography>
        {data.claims.status !== "available" ? <Alert severity="warning" sx={{ mt: 2 }}>领取异常未统计，请查看既有领取记录；不代表没有失败。</Alert> : data.claims.items.length === 0 ? <Typography mt={2}>当前没有符合条件的领取异常。</Typography> :
          <Box sx={{ overflowX: "auto", mt: 2 }}><Table size="small" aria-label="领取异常队列"><TableHead><TableRow>{["作品 / 批次", "领取来源", "状态", "时间", "定位"].map(label => <TableCell key={label}>{label}</TableCell>)}</TableRow></TableHead><TableBody>{data.claims.items.map(item => <TableRow key={item.claimId}>
            <TableCell>{item.workNumbers.map(number => `#${number}`).join("、") || "作品编号未记录"}<Typography variant="caption" className="creator-admin-id">{item.claimId}</Typography></TableCell>
            <TableCell>{item.sourceKind === "GROUP" ? "群码" : item.sourceKind === "CREATOR" ? "作者码" : "来源未记录"}<br />{item.authorPublicNumber ?? "无作者归因"}</TableCell>
            <TableCell>{claimState[item.state] ?? item.state}{item.error && <Typography variant="caption" display="block">{item.error}</Typography>}</TableCell>
            <TableCell>{formatTime(item.createdAt)}<Typography variant="caption" display="block">距准备起点 {duration(item.waitingSeconds)}</Typography></TableCell>
            <TableCell><Button size="small" href={claimLink(item)}>定位批次</Button>{item.creatorId && <Button size="small" href={`#/creatorPromotion?creatorId=${encodeURIComponent(item.creatorId)}`}>来源作者</Button>}</TableCell>
          </TableRow>)}</TableBody></Table></Box>}
        {data.claims.hasMore && <Typography variant="body2" mt={2}>还有其他异常，请到领取记录按日期和状态查看。</Typography>}
      </CardContent></Card>
      <Card sx={{ mb: 2 }}><CardContent>
        <Typography variant="h6">审核等待与复核</Typography>
        <Typography my={1}>待审核 {count(data.reviews.pending)} · 等待超过 {data.thresholds.reviewWaitingHours} 小时 {count(data.reviews.waitingTooLong)} · 需要复核 {count(data.reviews.needsReview)} · 因预算待复核 {count(data.reviews.budgetHeld)}</Typography>
        <Typography variant="body2" color="text.secondary">等待阈值是运营提示，不是审核承诺。列表包含长时间待审、等待重试与需要复核的投稿；进入详情仍须核查真实预览与授权。</Typography>
        {data.reviews.status !== "available" ? <Alert severity="warning" sx={{ mt: 2 }}>审核队列未统计，请进入审核页面；不代表没有待审投稿。</Alert> : data.reviews.items.length === 0 ? <Typography mt={2}>当前没有符合条件的审核异常。</Typography> :
          <Box sx={{ overflowX: "auto", mt: 2 }}><Table size="small" aria-label="审核异常队列"><TableHead><TableRow>{["作品", "作者", "状态", "等待", "定位"].map(label => <TableCell key={label}>{label}</TableCell>)}</TableRow></TableHead><TableBody>{data.reviews.items.map(item => <TableRow key={item.reviewId}>
            <TableCell>{item.number ? `#${item.number} · ` : "编号未记录 · "}{item.title ?? "送审标题未记录"}</TableCell>
            <TableCell>{item.authorPublicNumber ?? "作者编号未记录"}</TableCell><TableCell>{item.autoState ? phase[item.autoState] ?? "阶段未确认" : "尚无自动审核记录"}{item.reasonCode === "creator_rate_limited" && <Typography variant="caption" color="warning.main" display="block">触发审核预算上限，需复核</Typography>}</TableCell>
            <TableCell>{duration(item.waitingSeconds)}<Typography variant="caption" display="block">{formatTime(item.submittedAt)}</Typography></TableCell>
            <TableCell><Button size="small" href={`#/creatorCommunity?reviewId=${encodeURIComponent(item.reviewId)}`}>定位投稿</Button></TableCell>
          </TableRow>)}</TableBody></Table></Box>}
        {data.reviews.hasMore && <Typography variant="body2" mt={2}>还有其他记录，请进入审核队列分页查看。</Typography>}
      </CardContent></Card>
      <Card><CardContent>
        <Typography variant="h6">AI 审核预算提示</Typography>
        <Typography my={1}>自动审核：{data.budget.mode === "automatic" ? "已启用" : data.budget.mode === "disabled" ? "未启用" : "配置不可用"}</Typography>
        <Typography>本日预算已占用 {count(data.budget.used)} / 上限 {count(data.budget.dailyLimit)} · 剩余 {count(data.budget.remaining)}</Typography>
        <Typography variant="body2" mt={1}>北京时间周期：{formatTime(data.budget.startsAt)} 至 {formatTime(data.budget.resetsAt)}</Typography>
        {data.budget.status !== "available" && <Alert severity="warning" sx={{ mt: 2 }}>预算使用情况未统计，不视为剩余充足。</Alert>}
        {data.budget.remaining === 0 && <Alert severity="warning" sx={{ mt: 2 }}>本周期预算已用完。现有待复核投稿不会因次日额度恢复自动重送，请按审核详情处理。</Alert>}
        <Typography variant="body2" color="text.secondary" mt={2}>这是现有限流桶中已占用的审核尝试次数，不是模型成功次数、Token 数或费用。此页面不会调用收费 AI、修改预算或重新送审。</Typography>
      </CardContent></Card>
    </>}
  </Box>;
}
