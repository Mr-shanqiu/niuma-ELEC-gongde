import { useEffect, useState } from "react";
import { Alert, Box, Button, Card, CardContent, Chip, MenuItem, Select, Stack, Table, TableBody, TableCell, TableHead, TableRow, TextField, Typography } from "@mui/material";
import { useLogout } from "react-admin";
import { distributionRequest, formatTime } from "./distribution-api";

type Claim = { claimId: string; kind: string; authorPublicNumber: string | null; codeFamilyId: string; state: string;
  items: { number: string; title: string; catalogRevision: string }[]; bytes: number | null; durationMs: number | null;
  createdAt: string; issuedAt: string | null; downloadExpiresAt: string | null; error: string | null };
type Stats = { readyClaims: number | null; workClaims: number | null; verifiedCodes: number | null; installerRequests: number | null };
const states = { CREATED: "已创建", PREPARING: "正在准备", READY: "已就绪", FAILED: "准备失败", BLOCKED: "安全阻断", EXPIRED: "服务器重下载已到期" };
const count = (value: unknown) => typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : "未采集";
const beijingToday = () => new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());

export function FreeClaimsPanel() {
  const [date, setDate] = useState(beijingToday), [state, setState] = useState(""), [page, setPage] = useState(1), [reload, setReload] = useState(0);
  const [items, setItems] = useState<Claim[]>([]), [total, setTotal] = useState<number | null>(null), [stats, setStats] = useState<Stats | null>(null), [selected, setSelected] = useState<Claim | null>(null);
  const [listError, setListError] = useState(""), [statsError, setStatsError] = useState(""), [loading, setLoading] = useState(false);
  const logout = useLogout();
  useEffect(() => {
    const controller = new AbortController(); setLoading(true); setItems([]); setTotal(null); setStats(null); setSelected(null); setListError(""); setStatsError("");
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) { setListError("请选择有效日期。"); setLoading(false); return; }
    const from = new Date(`${date}T00:00:00+08:00`), to = new Date(from.getTime() + 86400000);
    if (!Number.isFinite(from.getTime())) { setListError("请选择有效日期。"); setLoading(false); return; }
    const query = new URLSearchParams({ from: from.toISOString(), to: to.toISOString(), page: String(page), perPage: "25" }); if (state) query.set("state", state);
    const readList = async () => {
      try {
        const result = await distributionRequest(`/claims?${query}`, { signal: controller.signal });
        if (!Array.isArray(result.data?.items) || !Number.isSafeInteger(result.data?.total) || result.data.total < 0 ||
            !result.data.items.every((item: any) => typeof item.claimId === "string" && typeof item.state === "string" && Array.isArray(item.items))) throw new Error("领取列表结构尚未确认，未以历史订单或样例替代。");
        if (!controller.signal.aborted) { setItems(result.data.items); setTotal(result.data.total); }
      } catch (error) { if (!controller.signal.aborted) { setListError(error instanceof Error ? error.message : "领取记录读取失败。"); if ((error as { status?: number }).status === 401) void logout(); } }
    };
    const readStats = async () => {
      try {
        const result = await distributionRequest(`/stats?from=${encodeURIComponent(from.toISOString())}&to=${encodeURIComponent(to.toISOString())}`, { signal: controller.signal });
        if (!result.data || typeof result.data !== "object" || Array.isArray(result.data)) throw new Error("统计结构尚未确认。");
        if (!controller.signal.aborted) setStats(result.data);
      } catch (error) { if (!controller.signal.aborted) setStatsError(error instanceof Error ? error.message : "统计读取失败。"); }
    };
    // Missing statistics must not hide genuine claim records.
    void (async () => { await readList(); if (!controller.signal.aborted) await readStats(); if (!controller.signal.aborted) setLoading(false); })();
    return () => controller.abort();
  }, [date, state, page, reload, logout]);
  return <Box className="dashboard-shell">
    <Box className="dashboard-heading"><div><Typography variant="overline">FREE DISTRIBUTION</Typography><Typography variant="h4">免费领取记录与统计</Typography></div><Chip label="READY 首次计数 · 非粉丝 / 安装人数" color="secondary" /></Box>
    <Stack direction={{ xs: "column", sm: "row" }} flexWrap="wrap" gap={2} mb={2}>
      <TextField label="北京日期" type="date" value={date} slotProps={{ inputLabel: { shrink: true } }} onChange={event => { setDate(event.target.value); setPage(1); }} />
      <Select value={state} aria-label="领取状态" displayEmpty onChange={event => { setState(event.target.value); setPage(1); }}><MenuItem value="">全部状态</MenuItem>{Object.entries(states).map(([id, label]) => <MenuItem key={id} value={id}>{label}</MenuItem>)}</Select>
      <Button variant="outlined" disabled={loading} onClick={() => setReload(value => value + 1)}>刷新</Button><Button href="#/orders">查看历史有效订单</Button>
    </Stack>
    {statsError && <Alert severity="warning" sx={{ mb: 2 }}>统计尚不可用：{statsError}</Alert>}
    <Box className="metric-grid" mb={2}>{[["有效形象领取批次", stats?.readyClaims], ["作品领取次数", stats?.workClaims], ["成功验码次数", stats?.verifiedCodes], ["客户端文件请求次数", stats?.installerRequests]].map(([label, value]) => <Card key={String(label)}><CardContent><span>{label}</span><strong>{count(value)}</strong></CardContent></Card>)}</Box>
    <Typography variant="body2" color="text.secondary" mb={2}>统计为所选北京时间一天；有效批次只在首次 READY 计一次，作品按 READY 批次条目计数。轮换不清空 family 归因；未采集不等于零，不推算粉丝、安装或导入人数。</Typography>
    {listError && <Alert severity="warning" sx={{ mb: 2 }}>{listError}</Alert>}
    <Card><CardContent>{loading && <Typography role="status">正在读取真实领取记录…</Typography>}{!loading && !listError && total === 0 && <Typography>所选日期暂无领取记录。</Typography>}
      <Box sx={{ overflowX: "auto" }}><Table size="small" aria-label="免费领取批次"><TableHead><TableRow>{["批次", "来源 / 作者", "状态", "条目", "大小 / 耗时", "创建时间", "服务器重下载期限", "详情"].map(label => <TableCell key={label}>{label}</TableCell>)}</TableRow></TableHead><TableBody>{items.map(item => <TableRow key={item.claimId}>
        <TableCell sx={{ overflowWrap: "anywhere" }}>{item.claimId}</TableCell><TableCell>{item.kind === "GROUP" ? "群码" : item.kind === "CREATOR" ? "作者码" : item.kind}<br />{item.authorPublicNumber ?? "无作者归因"}</TableCell><TableCell>{states[item.state as keyof typeof states] ?? item.state}</TableCell><TableCell>{item.items.length}</TableCell>
        <TableCell>{typeof item.bytes === "number" ? `${(item.bytes / 1048576).toFixed(2)} MiB` : "未提供"} / {typeof item.durationMs === "number" ? `${item.durationMs} ms` : "未提供"}</TableCell>
        <TableCell>{formatTime(item.createdAt)}</TableCell><TableCell>{formatTime(item.downloadExpiresAt)}</TableCell><TableCell><Button size="small" onClick={() => setSelected(item)}>查看</Button></TableCell>
      </TableRow>)}</TableBody></Table></Box>
      <Stack direction="row" gap={2} alignItems="center" justifyContent="space-between" mt={2}><Button disabled={loading || page === 1} onClick={() => setPage(value => value - 1)}>上一页</Button><Typography>第 {page} 页 · {total === null ? "总数未确认" : `共 ${total} 条`}</Typography><Button disabled={loading || total === null || page * 25 >= total} onClick={() => setPage(value => value + 1)}>下一页</Button></Stack>
    </CardContent></Card>
    {selected && <Card sx={{ mt: 2 }}><CardContent><Typography variant="h6">批次 {selected.claimId}</Typography><Typography className="creator-admin-id" variant="caption">来源 family：{selected.codeFamilyId}（领取时冻结，不随换码改写）</Typography><Typography>签发：{formatTime(selected.issuedAt)} · downloadExpiresAt：{formatTime(selected.downloadExpiresAt)}</Typography>{selected.error && <Alert severity="warning" sx={{ my: 2 }}>{selected.error}</Alert>}<Stack gap={1} my={2}>{selected.items.map(item => <Box key={item.number}><Typography>#{item.number} · {item.title}</Typography><Typography className="creator-admin-id" variant="caption">冻结 catalogRevision：{item.catalogRevision}</Typography></Box>)}</Stack><Typography color="text.secondary">服务器重下载窗口为签发后 7 天，不是本地首次导入期限；保存的合规文件可永久离线使用。此列表只读，不生成新订单或收费。</Typography><Button sx={{ mt: 2 }} onClick={() => setSelected(null)}>关闭详情</Button></CardContent></Card>}
  </Box>;
}
