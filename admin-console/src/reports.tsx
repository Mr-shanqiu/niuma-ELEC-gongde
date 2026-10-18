import { useEffect, useState } from "react";
import { Alert, Box, Button, Card, CardContent, Chip, MenuItem, Select, Stack, TextField, Typography } from "@mui/material";
import { useLogout } from "react-admin";
import { distributionRequest, formatTime, requireReportRecord } from "./distribution-api";
import type { ReportRecord } from "./distribution-api";

const stateLabels = { OPEN: "待处理", RESOLVED: "已处理" };

export function ReportsPanel() {
  const [state, setState] = useState("OPEN");
  const [page, setPage] = useState(1), [reload, setReload] = useState(0);
  const [records, setRecords] = useState<ReportRecord[]>([]), [total, setTotal] = useState<number | null>(null);
  const [selected, setSelected] = useState<ReportRecord | null>(null), [reason, setReason] = useState("");
  const [loading, setLoading] = useState(false), [busy, setBusy] = useState(false);
  const [error, setError] = useState(""), [notice, setNotice] = useState("");
  const logout = useLogout();
  useEffect(() => {
    const controller = new AbortController(); setLoading(true); setError(""); setRecords([]); setTotal(null); setSelected(null); setReason("");
    const query = new URLSearchParams({ page: String(page), perPage: "25", state });
    void distributionRequest(`/reports?${query}`, { signal: controller.signal }).then(result => {
      if (!Array.isArray(result.data?.items) || !Number.isSafeInteger(result.data?.total) || result.data.total < 0) {
        throw new Error("官网举报列表结构尚未确认，未替代为原社区版权举报。");
      }
      const items = result.data.items.map(requireReportRecord);
      if (!controller.signal.aborted) { setRecords(items); setTotal(result.data.total); }
    }).catch(failure => {
      if (controller.signal.aborted) return;
      setError(failure instanceof Error ? failure.message : "官网举报读取失败。");
      if (failure.status === 401) void logout();
    }).finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [state, page, reload, logout]);
  const resolve = async () => {
    if (!selected || selected.state !== "OPEN" || loading || busy || reason.trim().length < 5 || reason.trim().length > 1000) return;
    if (!window.confirm("确认按填写的调查与处理依据结案？结案本身不自动暂停账号或作品。")) return;
    const report = selected;
    setBusy(true); setError(""); setNotice("");
    try {
      const result = await distributionRequest(`/reports/${encodeURIComponent(report.id)}/resolve`, { method: "POST", body: JSON.stringify({ reason: reason.trim() }) });
      if (result.data?.ok !== true) {
        throw new Error("写入返回状态未确认，请刷新检查，不要重复提交。");
      }
      setNotice("举报处理已由服务端确认；正在重新读取列表。如读取失败，请手动刷新，不要重复结案。");
      setSelected(null); setReason(""); setReload(value => value + 1);
    } catch (failure) {
      setSelected(null); setRecords([]); setTotal(null); setReason("");
      setError(`${failure instanceof Error ? failure.message : "处理结果未确认。"} 请先刷新读取真实状态；不会自动重试写入。`);
      if ((failure as { status?: number }).status === 401) void logout();
    } finally { setBusy(false); }
  };
  return <Box className="creator-admin-shell">
    <Box className="dashboard-heading"><div><Typography variant="overline">WEBSITE REPORTS</Typography><Typography variant="h4">官网作品编号举报</Typography></div><Chip label="统一作品编号 · 留存处理依据" color="secondary" /></Box>
    <Typography color="text.secondary" mb={2}>读取新版官网提交的举报，不替换原社区版权举报。调查材料按提交时保存；证据文字只展示，不自动打开、抓取链接或执行内容。</Typography>
    <Stack direction={{ xs: "column", sm: "row" }} flexWrap="wrap" gap={2} mb={2}>
      <Select value={state} aria-label="举报状态" disabled={busy} onChange={event => { setState(event.target.value); setPage(1); setNotice(""); }}>{Object.entries(stateLabels).map(([id, label]) => <MenuItem key={id} value={id}>{label}</MenuItem>)}</Select>
      <Button disabled={loading || busy} onClick={() => { setNotice(""); setReload(value => value + 1); }}>刷新</Button>
      <Button href="#/creatorCommunity" disabled={busy}>原社区版权举报入口</Button>
    </Stack>
    {notice && <Alert severity="info" sx={{ mb: 2 }}>{notice}</Alert>}{error && <Alert severity="warning" sx={{ mb: 2 }}>{error}</Alert>}
    <Box className="creator-admin-grid">
      <Card><CardContent><Typography variant="h6">举报记录</Typography>
        {loading && <Typography role="status" my={2}>正在读取真实官网举报…</Typography>}
        {!loading && !error && total === 0 && <Typography my={2}>暂无匹配举报。</Typography>}
        <Stack gap={1} my={2}>{records.map(item => <Button className="creator-admin-record" key={item.id} variant={selected?.id === item.id ? "outlined" : "text"} disabled={busy || loading} onClick={() => { setSelected(item); setReason(""); }}>
          <Box><Typography fontWeight={750}>#{item.number}</Typography><Typography variant="body2">{stateLabels[item.state]} · {item.category}</Typography><Typography variant="caption">{formatTime(item.createdAt)}</Typography></Box>
        </Button>)}</Stack>
        <Stack direction="row" alignItems="center" justifyContent="space-between" gap={1}>
          <Button disabled={loading || busy || page === 1} onClick={() => setPage(value => value - 1)}>上一页</Button><Typography variant="caption">第 {page} 页 · {total === null ? "总数未确认" : `${total} 条`}</Typography><Button disabled={loading || busy || total === null || page * 25 >= total} onClick={() => setPage(value => value + 1)}>下一页</Button>
        </Stack>
      </CardContent></Card>
      <Card><CardContent>{!selected ? <Typography color="text.secondary" my={3}>选择举报，查看作品编号、原始描述和处理依据。</Typography> : <>
        <Typography variant="h6">作品 #{selected.number}</Typography>
        <Typography className="creator-admin-id" variant="caption">举报 {selected.id} · 版本 {selected.versionId ?? "未提供"}</Typography>
        <Typography mt={2}>类型：{selected.category} · 状态：{stateLabels[selected.state]}</Typography>
        <Typography color="text.secondary">提交时间：{formatTime(selected.createdAt)}</Typography>
        <Typography fontWeight={750} mt={2}>原始举报描述</Typography><Typography className="creator-admin-copy">{selected.description}</Typography>
        <Typography fontWeight={750} mt={2}>证据说明（不自动访问链接）</Typography><Typography className="creator-admin-copy">{selected.evidence ?? "未提供"}</Typography>
        <Typography fontWeight={750} mt={2}>举报人提供的联系方式（仅管理员查看）</Typography><Typography className="creator-admin-copy">{selected.contact ?? "未提供"}</Typography>
        {selected.state !== "OPEN" && <Alert severity="info" sx={{ mt: 2 }}><Typography>处理时间：{formatTime(selected.resolvedAt)}</Typography><Typography className="creator-admin-copy">处理依据：{selected.resolution ?? "未提供，请核对审计记录"}</Typography></Alert>}
        {selected.state === "OPEN" && <>
          <Alert severity="info" sx={{ mt: 2 }}>本页结案只记录举报调查结果，不伪称已执行下架或安全阻断。需要处置作品时，先通过既有作品管理入口执行真实操作，再记录处理依据。</Alert>
          <TextField label="调查与处理依据（5 至 1000 字）" multiline minRows={3} fullWidth value={reason} onChange={event => setReason(event.target.value)} disabled={busy || loading} slotProps={{ htmlInput: { maxLength: 1000 } }} sx={{ mt: 2 }} />
          <Stack direction="row" flexWrap="wrap" gap={1} mt={2}><Button variant="contained" disabled={busy || loading || reason.trim().length < 5 || reason.trim().length > 1000} onClick={() => void resolve()}>记录处理结果并结案</Button></Stack>
        </>}
        <Stack direction="row" flexWrap="wrap" gap={1} mt={2}><Button href="#/appearanceNumbers" disabled={busy}>现有作品编号查询</Button><Button href="#/appearanceFiles" disabled={busy}>官方作品管理</Button><Button href="#/creatorCommunity" disabled={busy}>社区作品管理</Button></Stack>
        <Typography variant="caption" color="text.secondary" display="block" mt={2}>不删除原举报，不公开原始证据或联系方式，不回收合法下载的离线文件，也不另建作品审核系统。</Typography>
      </>}</CardContent></Card>
    </Box>
  </Box>;
}
