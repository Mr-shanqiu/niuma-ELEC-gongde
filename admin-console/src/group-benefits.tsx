import { useCallback, useEffect, useState } from "react";
import { Alert, Box, Button, Card, CardContent, Chip, CircularProgress, Stack, TextField, Typography } from "@mui/material";
import { useLogout, useNotify } from "react-admin";
import { codeUsable, distributionRequest, formatTime, groupAnnouncement, requireCodeSnapshot, revisionBody } from "./distribution-api";
import type { CodeSnapshot } from "./distribution-api";

export function GroupBenefitsPanel() {
  const notify = useNotify(), logout = useLogout();
  const [data, setData] = useState<CodeSnapshot | null>(null), [error, setError] = useState(""), [reason, setReason] = useState("");
  const [loading, setLoading] = useState(false), [busy, setBusy] = useState(false);
  const [clock, setClock] = useState(Date.now()), [clockOffset, setClockOffset] = useState(0), [readAt, setReadAt] = useState<string | null>(null);
  const load = useCallback(async (signal?: AbortSignal): Promise<boolean> => {
    setLoading(true); setError(""); setData(null);
    try {
      const result = await distributionRequest("/group-code", { signal });
      const snapshot = requireCodeSnapshot(result.data);
      if (snapshot.kind !== "GROUP" || snapshot.maxItems !== 10) throw new Error("群码类型或每批上限不符合 PRD，已禁止发布公告。");
      if (signal?.aborted) return false;
      setData(snapshot); setClockOffset(Date.parse(result.serverTime) - Date.now()); setClock(Date.now()); setReadAt(result.serverTime);
      return true;
    } catch (failure) {
      if (signal?.aborted) return false;
      setError(failure instanceof Error ? failure.message : "群码读取失败。");
      if ((failure as { status?: number }).status === 401) void logout();
      return false;
    } finally { if (!signal?.aborted) setLoading(false); }
  }, [logout]);
  useEffect(() => { const controller = new AbortController(); void load(controller.signal); return () => controller.abort(); }, [load]);
  useEffect(() => { const timer = window.setInterval(() => setClock(Date.now()), 1000); return () => window.clearInterval(timer); }, []);
  // GET reads are audited; no background polling that floods current-code audit.
  const now = clock + clockOffset, current = data ? codeUsable(data, now) : false;
  const remaining = current ? Math.ceil((Date.parse(data!.expiresAt!) - now) / 1000) : 0;
  const copy = async (announcement: boolean) => {
    if (!data || !codeUsable(data, Date.now() + clockOffset) || loading || busy || announcement && !data.redemptionEnabled) {
      notify("码不可用或公告尚未开放，请读取最新状态。", { type: "warning" }); return;
    }
    try { await navigator.clipboard.writeText(announcement ? groupAnnouncement(data) : data.code!); notify("已复制。", { type: "info" }); }
    catch { notify("自动复制失败，请手动选择当前码。", { type: "warning" }); }
  };
  const mutate = async (action: "pause" | "resume" | "rotate") => {
    if (!data || !data.familyId || data.revision === null || busy || loading || !window.confirm(action === "rotate" ? "立即换码使旧码立即失效，不取消已创建的合法领取。确认换码？" : action === "pause" ? "暂停新领取，不追溯取消既有合法领取。确认暂停？" : "确认恢复群码新领取？")) return;
    setBusy(true); setError("");
    try {
      await distributionRequest(`/code-families/${encodeURIComponent(data.familyId)}/${action}`, { method: "POST", body: revisionBody(data.revision, reason) });
      setReason("");
      const refreshed = await load();
      notify(refreshed ? "变更已成功，已重新读取最新状态。" : "变更已成功，但最新状态读取失败。请手动读取最新码，不要重复提交变更。", {
        type: refreshed ? "info" : "warning"
      });
    } catch (failure) { setData(null); setError(`${failure instanceof Error ? failure.message : "结果未确认。"} 请重新读取状态；不自动重试变更。`); }
    finally { setBusy(false); }
  };
  const disabled = !data || !data.familyId || data.revision === null || busy || loading || reason.trim().length < 5;
  return <Box className="dashboard-shell">
    <Box className="dashboard-heading"><div><Typography variant="overline">FAN GROUP BENEFITS</Typography><Typography variant="h4">粉丝群免费领取码</Typography></div><Chip label="三天轮换 · 每批 10 个 · 不扣次数" color="secondary" /></Box>
    <Card><CardContent>
      <Typography color="text.secondary" mb={2}>可反复使用，不是共享余额；刷新和服务重启不会自行换码。周期与时间以服务器北京时间为准。</Typography>
      {error && <Alert severity="warning" sx={{ mb: 2 }}>{error}</Alert>}{loading && <CircularProgress size={28} />}
      {data && <>
        <Chip label={data.status === "PAUSED" ? "已暂停新领取" : data.status === "INACTIVE" ? "未启用" : current ? "当前码有效" : "未生效或本轮已到期"} color={current ? "success" : "warning"} />
        <Typography component="code" sx={{ display: "block", fontSize: { xs: 26, sm: 40 }, fontWeight: 800, userSelect: "all", overflowWrap: "anywhere", my: 2 }}>{current ? data.code : "当前没有可发布的有效码"}</Typography>
        <Stack direction={{ xs: "column", sm: "row" }} spacing={3} mb={2}>
          <Box><Typography color="text.secondary">本周期开始</Typography><Typography>{formatTime(data.validFrom)}</Typography></Box>
          <Box><Typography color="text.secondary">失效 / 轮换边界</Typography><Typography>{formatTime(data.expiresAt)}</Typography></Box>
          <Box><Typography color="text.secondary">本轮剩余</Typography><Typography role="timer">{current ? `${Math.floor(remaining / 86400)} 天 ${Math.floor(remaining % 86400 / 3600)} 小时 ${Math.floor(remaining % 3600 / 60)} 分` : "不可新领取"}</Typography></Box>
        </Stack>
        {!data.redemptionEnabled && <Alert severity="warning">免费交付尚未开放或健康检查未通过。准备中的码不代表线上可领取，已禁止复制可用群公告。</Alert>}
        <Typography variant="caption" display="block" mt={2}>最近读取：{formatTime(readAt)} · 修订 {data.revision}</Typography>
      </>}
      <Stack direction="row" flexWrap="wrap" gap={1.5} my={2}>
        <Button variant="contained" disabled={!current || loading || busy} onClick={() => void copy(false)}>复制当前码</Button>
        <Button variant="outlined" disabled={!current || loading || busy || !data?.redemptionEnabled} onClick={() => void copy(true)}>复制群置顶公告</Button>
        <Button disabled={loading || busy} onClick={() => void load()}>读取最新码</Button>
      </Stack>
      <TextField label="暂停 / 恢复 / 换码原因（5 至 1000 字）" fullWidth multiline minRows={2} value={reason} disabled={busy || loading} onChange={event => setReason(event.target.value)} slotProps={{ htmlInput: { maxLength: 1000 } }} />
      <Stack direction="row" flexWrap="wrap" gap={1} mt={2}>
        <Button color="warning" variant="outlined" disabled={disabled || data?.status !== "ACTIVE"} onClick={() => void mutate("pause")}>暂停新领取</Button>
        <Button variant="outlined" disabled={disabled || data?.status !== "PAUSED"} onClick={() => void mutate("resume")}>恢复群码</Button>
        <Button variant="outlined" disabled={disabled || data?.status === "INACTIVE"} onClick={() => void mutate("rotate")}>立即换码</Button>
      </Stack>
    </CardContent></Card>
    <Card sx={{ mt: 3 }}><CardContent><Typography variant="h6" mb={1}>不影响历史合法交付</Typography><Typography color="text.secondary">码只在官网新领取扩展形象时核验；已下载文件可长期保存、随时导入和永久离线使用。服务器重下载期限不是本地使用期限。客户端与基础木鱼无需码直接免费下载；码不证明已关注或已进群。</Typography></CardContent></Card>
  </Box>;
}
