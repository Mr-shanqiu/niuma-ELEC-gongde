import { useEffect, useState } from "react";
import { Alert, Box, Button, Card, CardContent, Chip, Stack, TextField, Typography } from "@mui/material";
import { useLogout, useNotify } from "react-admin";
import { codeUsable, distributionRequest, formatTime, requireCreatorListItem, requirePromotion, revisionBody } from "./distribution-api";
import type { CreatorListItem, Promotion } from "./distribution-api";

export function CreatorPromotionPanel() {
  const initialId = new URLSearchParams(location.hash.split("?")[1] ?? "").get("creatorId") ?? "";
  const [creatorId, setCreatorId] = useState(initialId), [selectedId, setSelectedId] = useState(initialId);
  const [data, setData] = useState<Promotion | null>(null), [reason, setReason] = useState("");
  const [error, setError] = useState(""), [loading, setLoading] = useState(false), [busy, setBusy] = useState(false);
  const [reload, setReload] = useState(0), [serverOffset, setServerOffset] = useState(0), [clock, setClock] = useState(Date.now());
  const [listItems, setListItems] = useState<CreatorListItem[]>([]), [listTotal, setListTotal] = useState<number | null>(null);
  const [listPage, setListPage] = useState(1), [listReload, setListReload] = useState(0), [listLoading, setListLoading] = useState(false);
  const [listError, setListError] = useState(""), [search, setSearch] = useState(""), [accountState, setAccountState] = useState("");
  const [listQuery, setListQuery] = useState({ q: "", state: "" });
  const notify = useNotify(), logout = useLogout();
  useEffect(() => {
    const controller = new AbortController(); setListLoading(true); setListError(""); setListItems([]); setListTotal(null);
    const query = new URLSearchParams({ page: String(listPage), perPage: "25" });
    if (listQuery.q) query.set("q", listQuery.q);
    if (listQuery.state) query.set("state", listQuery.state);
    void distributionRequest(`/creators?${query}`, { signal: controller.signal }).then(result => {
      if (!Array.isArray(result.data?.items) || !Number.isSafeInteger(result.data?.total) || result.data.total < 0) {
        throw new Error("作者列表分页结构尚未确认。");
      }
      const items = result.data.items.map(requireCreatorListItem);
      if (!controller.signal.aborted) { setListItems(items); setListTotal(result.data.total); }
    }).catch(failure => {
      if (controller.signal.aborted) return;
      setListError(failure instanceof Error ? failure.message : "作者列表读取失败。");
      if (failure.status === 401) void logout();
    }).finally(() => { if (!controller.signal.aborted) setListLoading(false); });
    return () => controller.abort();
  }, [listPage, listReload, listQuery, logout]);
  useEffect(() => { const timer = window.setInterval(() => setClock(Date.now()), 1000); return () => window.clearInterval(timer); }, []);
  useEffect(() => {
    const controller = new AbortController(); setData(null); setReason("");
    if (!selectedId) return;
    setLoading(true); setError("");
    void distributionRequest(`/creators/${encodeURIComponent(selectedId)}/promotion`, { signal: controller.signal }).then(result => {
      const value = requirePromotion(result.data);
      if (value.creatorId !== selectedId) throw new Error("返回作者与请求不一致，未展示码。");
      if (!controller.signal.aborted) { setData(value); setServerOffset(Date.parse(result.serverTime) - Date.now()); }
    }).catch(failure => {
      if (controller.signal.aborted) return;
      setError(failure instanceof Error ? failure.message : "作者推广信息读取失败。");
      if (failure.status === 401) void logout();
    }).finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [selectedId, reload, logout]);
  const mutate = async (path: string, revision: number, confirmation: string) => {
    if (busy || loading || !window.confirm(confirmation)) return;
    setBusy(true); setError("");
    try {
      await distributionRequest(path, { method: "POST", body: revisionBody(revision, reason) });
      setData(null); setReload(value => value + 1); setListReload(value => value + 1); notify("变更已记录，正在读取最新权限。", { type: "info" });
    } catch (failure) { setData(null); setError(`${failure instanceof Error ? failure.message : "结果未确认。"} 请刷新；不自动重试变更。`); }
    finally { setBusy(false); }
  };
  const copy = async () => {
    if (!data || !codeUsable(data, Date.now() + serverOffset)) { notify("码已到期或不可用，请刷新。", { type: "warning" }); return; }
    try { await navigator.clipboard.writeText(data.code!); notify("作者当前码已复制。", { type: "info" }); }
    catch { notify("自动复制失败，请手动选择当前码。", { type: "warning" }); }
  };
  const usable = data && codeUsable(data, clock + serverOffset), disabled = !data?.familyId || data.revision === null || busy || loading || reason.trim().length < 5;
  return <Box className="dashboard-shell">
    <Box className="dashboard-heading"><div><Typography variant="overline">CREATOR PROMOTION</Typography><Typography variant="h4">作者推广与贡献</Typography></div><Chip label="一位作者一个逻辑码 · 不扣次数" color="secondary" /></Box>
    <Card sx={{ mb: 2 }}><CardContent><Typography variant="h6" mb={2}>作者列表</Typography>
      <Stack component="form" direction={{ xs: "column", sm: "row" }} flexWrap="wrap" gap={2} onSubmit={event => { event.preventDefault(); setListPage(1); setListQuery({ q: search.trim(), state: accountState.trim() }); }}>
        <TextField label="作者编号 / 内部 ID" value={search} onChange={event => setSearch(event.target.value)} disabled={busy} />
        <TextField label="账号状态（可不填）" helperText="按服务端原账号状态筛选，不是码状态" value={accountState} onChange={event => setAccountState(event.target.value)} disabled={busy} />
        <Button type="submit" variant="outlined" disabled={busy || listLoading}>查询作者</Button>
        <Button disabled={busy || listLoading} onClick={() => setListReload(value => value + 1)}>刷新列表</Button>
      </Stack>
      {listError && <Alert severity="warning" sx={{ mt: 2 }}>{listError}</Alert>}
      {listLoading && <Typography role="status" mt={2}>正在读取作者列表…</Typography>}
      {!listLoading && !listError && listTotal === 0 && <Typography mt={2}>没有匹配的作者。</Typography>}
      <Stack gap={1} mt={2}>{listItems.map(item => <Box key={item.creatorId} borderBottom="1px solid rgba(41,35,28,.14)" py={1}>
        <Typography fontWeight={750}>作者 {item.authorPublicNumber} · 账号 {item.accountState}</Typography>
        <Typography variant="body2">作品 {item.workCount} · 有效贡献 {item.contributionCount} · 每批 {item.maxItems} · 码状态 {item.codeStatus}</Typography>
        <Button size="small" disabled={busy || loading} onClick={() => { setCreatorId(item.creatorId); setSelectedId(item.creatorId); setReload(value => value + 1); }}>查看当前码与贡献明细</Button>
      </Box>)}</Stack>
      <Stack direction="row" justifyContent="space-between" alignItems="center" gap={1} mt={2}>
        <Button disabled={busy || listLoading || listPage === 1} onClick={() => setListPage(value => value - 1)}>上一页</Button>
        <Typography>第 {listPage} 页 · {listTotal === null ? "总数未确认" : `共 ${listTotal} 位`}</Typography>
        <Button disabled={busy || listLoading || listTotal === null || listPage * 25 >= listTotal} onClick={() => setListPage(value => value + 1)}>下一页</Button>
      </Stack>
      <Typography variant="caption" color="text.secondary">列表不显示明文码或手机号；只有明确读取作者推广详情才产生当前码查看审计。</Typography>
    </CardContent></Card>
    <Card><CardContent><Typography color="text.secondary" mb={2}>从作品 / 审核详情进入作者，或输入内部作者 ID。编号、作品数和贡献数读取服务端，不以投稿次数或公开作品数代替有效贡献。</Typography>
      <Stack component="form" direction={{ xs: "column", sm: "row" }} gap={2} onSubmit={event => { event.preventDefault(); setSelectedId(creatorId.trim()); setReload(value => value + 1); }}>
        <TextField label="内部作者 ID" value={creatorId} onChange={event => setCreatorId(event.target.value)} required fullWidth disabled={busy} />
        <Button type="submit" variant="contained" disabled={busy || loading || !creatorId.trim()}>读取作者</Button>
        <Button disabled={busy || loading || !selectedId} onClick={() => setReload(value => value + 1)}>刷新</Button>
      </Stack>{loading && <Typography role="status" mt={2}>正在读取真实推广状态…</Typography>}{error && <Alert severity="warning" sx={{ mt: 2 }}>{error}</Alert>}
    </CardContent></Card>
    {data && <Card sx={{ mt: 2 }}><CardContent>
      <Typography variant="h6">作者 {data.authorPublicNumber}</Typography><Typography>账号状态：{data.accountState} · 作品数：{data.workCount} · 有效贡献 N：{data.contributionCount}</Typography>
      <Typography mt={1}>服务端每批上限：{data.maxItems} 个 · min(3 × N, 10) = {Math.min(3 * data.contributionCount, 10)}（N = 0 未激活）</Typography>
      {data.maxItems !== Math.min(3 * data.contributionCount, 10) && <Alert severity="warning">服务端权限与规则不一致，需协调排查；后台不自行改写权限。</Alert>}
      <Typography mt={1}>码状态：{data.status} · 码修订：{data.revision}</Typography>
      <Typography component="code" sx={{ display: "block", fontSize: 26, overflowWrap: "anywhere", userSelect: "all", my: 2 }}>{usable ? data.code : data.contributionCount === 0 ? "尚无有效贡献，推广码未激活" : "已暂停、未生效或已到期"}</Typography>
      <Typography>本周期：{formatTime(data.validFrom)} 至 {formatTime(data.expiresAt)}（北京时间）</Typography>
      {!data.redemptionEnabled && <Alert severity="warning" sx={{ mt: 2 }}>免费交付尚未开放或健康检查未通过，请勿宣传为可用领取权限。</Alert>}
      <Button sx={{ my: 2 }} variant="outlined" disabled={!usable || busy || loading} onClick={() => void copy()}>复制当前作者码</Button>
      <TextField label="操作原因（5 至 1000 字；每次操作重新填写）" fullWidth multiline minRows={2} value={reason} onChange={event => setReason(event.target.value)} disabled={busy || loading} slotProps={{ htmlInput: { maxLength: 1000 } }} />
      <Stack direction="row" flexWrap="wrap" gap={1} my={2}>
        <Button color="warning" variant="outlined" disabled={disabled || data.status !== "ACTIVE"} onClick={() => { if (data.familyId && data.revision !== null) void mutate(`/code-families/${encodeURIComponent(data.familyId)}/pause`, data.revision, "暂停此作者码的新领取，不回收既有合法交付，也不改账号状态。确认暂停？"); }}>暂停作者码</Button>
        <Button variant="outlined" disabled={disabled || data.status !== "PAUSED"} onClick={() => { if (data.familyId && data.revision !== null) void mutate(`/code-families/${encodeURIComponent(data.familyId)}/resume`, data.revision, "恢复此作者码，账号或作品仍受独立安全状态限制。确认恢复？"); }}>恢复作者码</Button>
        <Button variant="outlined" disabled={disabled || data.status === "INACTIVE"} onClick={() => { if (data.familyId && data.revision !== null) void mutate(`/code-families/${encodeURIComponent(data.familyId)}/rotate`, data.revision, "旧码立即失效；贡献、权限和归因保留。确认换码？"); }}>立即换码</Button>
      </Stack>
      <Typography variant="h6" mt={3}>按作品贡献明细</Typography><Typography variant="body2" color="text.secondary">首次独立新作发布增加贡献；更新、重审、重上架不重复增加，主动下架不扣贡献。只按真实作品撤销或恢复，不能直接编辑总数。</Typography>
      {data.contributions.length === 0 ? <Typography my={2}>暂无贡献记录。</Typography> : <Stack gap={2} mt={2}>{data.contributions.map(item => <Box key={item.workId} borderBottom="1px solid rgba(41,35,28,.14)" pb={2}>
        <Typography fontWeight={750}>{item.number ? `#${item.number} · ` : ""}{item.title ?? item.workId}</Typography><Typography className="creator-admin-id" variant="caption">{item.workId} · 修订 {item.revision}</Typography>
        <Typography>状态：{item.state === "ACTIVE" ? "有效贡献" : "已撤销"} · 授予：{formatTime(item.grantedAt)}</Typography><Typography variant="body2">撤销：{formatTime(item.revokedAt)} · 恢复：{formatTime(item.restoredAt)} · 原因：{item.reason ?? "未提供"}</Typography>
        <Button sx={{ mt: 1 }} color={item.state === "ACTIVE" ? "warning" : "primary"} variant="outlined" disabled={disabled} onClick={() => void mutate(`/contributions/${encodeURIComponent(item.workId)}/${item.state === "ACTIVE" ? "revoke" : "restore"}`, item.revision, item.state === "ACTIVE" ? "撤销此作品贡献会重算作者单批上限，不回收合法文件。确认撤销？" : "恢复此作品原贡献，不重复授予。确认恢复？")}>{item.state === "ACTIVE" ? "撤销贡献" : "恢复贡献"}</Button>
      </Box>)}</Stack>}
    </CardContent></Card>}
  </Box>;
}
