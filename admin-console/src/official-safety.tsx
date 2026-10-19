import { useCallback, useEffect, useState } from "react";
import { Alert, Box, Button, MenuItem, Stack, TextField, Typography } from "@mui/material";
import { useLogout, useNotify } from "react-admin";
import { distributionRequest, formatTime } from "./distribution-api";

type Safety = { assetId: string; blocked: boolean; revision: number; reason: string | null;
  updatedBy: string | null; updatedAt: string | null };
type Appearance = { assetId: string; name: string; appearanceNumber?: string; state: string };
function snapshot(value: any): Safety {
  if (!value || typeof value.assetId !== "string" || typeof value.blocked !== "boolean" ||
    !Number.isSafeInteger(value.revision) || value.revision < 0 ||
    !(value.reason === null || typeof value.reason === "string") ||
    !(value.updatedBy === null || typeof value.updatedBy === "string") ||
    !(value.updatedAt === null || typeof value.updatedAt === "string" && Number.isFinite(Date.parse(value.updatedAt)))) {
    throw new Error("官方安全状态未确认，已禁用停发和恢复；不以普通上下架状态代替。");
  }
  return value;
}

export function OfficialSafetyPanel({ appearances }: { appearances: Appearance[] }) {
  const [items, setItems] = useState<Safety[]>([]), [selectedId, setSelectedId] = useState("");
  const [loading, setLoading] = useState(false), [busy, setBusy] = useState(false);
  const [error, setError] = useState(""), [reason, setReason] = useState("");
  const [readAt, setReadAt] = useState<string | null>(null);
  const notify = useNotify(), logout = useLogout();
  const load = useCallback(async (signal?: AbortSignal): Promise<boolean> => {
    setLoading(true); setError(""); setItems([]);
    try {
      const response = await distributionRequest("/official-safety", { signal });
      if (!Array.isArray(response.data?.items) || !Number.isSafeInteger(response.data?.total) || response.data.total !== response.data.items.length) {
        throw new Error("官方安全列表未确认，未补写默认操作状态。");
      }
      const values = response.data.items.map(snapshot);
      if (signal?.aborted) return false;
      setItems(values); setReadAt(response.serverTime); return true;
    } catch (failure) {
      if (signal?.aborted) return false;
      setError(failure instanceof Error ? failure.message : "安全状态读取失败。");
      if ((failure as { status?: number }).status === 401) void logout();
      return false;
    } finally { if (!signal?.aborted) setLoading(false); }
  }, [logout]);
  useEffect(() => { const controller = new AbortController(); void load(controller.signal); return () => controller.abort(); }, [load]);
  const selected = items.find(item => item.assetId === selectedId);
  const change = async (blocked: boolean) => {
    if (!selected || loading || busy || selected.blocked === blocked) return;
    const text = reason.trim().normalize("NFC");
    if (Array.from(text).length < 5 || Array.from(text).length > 1000) return;
    if (!window.confirm(blocked ? "安全停发会停止此作品的新领取，并阻断包含它的旧批次重下载，不回收已下载的离线文件。确认停发？" :
      "确认恢复安全分发？旧批次重下时仍须全部条目安全且在原重下载窗口内；不会延长期限或重新签发版本。")) return;
    setBusy(true); setError("");
    try {
      const response = await distributionRequest(`/official-safety/${encodeURIComponent(selected.assetId)}/${blocked ? "block" : "unblock"}`, {
        method: "POST", body: JSON.stringify({ requireCurrentRevision: selected.revision, reason: text })
      });
      const updated = snapshot(response.data);
      if (updated.assetId !== selected.assetId || updated.blocked !== blocked || updated.revision <= selected.revision) {
        throw new Error("写入结果未确认，请刷新核对，勿重复提交。");
      }
      setReason("");
      const refreshed = await load();
      notify(refreshed ? "安全操作已成功，已重读最新状态。" : "安全操作已成功，但重读失败，请手动刷新，不要重复提交。", { type: refreshed ? "info" : "warning" });
    } catch (failure) {
      setItems([]); setError(`${failure instanceof Error ? failure.message : "操作结果未确认。"} 请先刷新状态；不自动重试安全写入。`);
    } finally { setBusy(false); }
  };
  const validReason = Array.from(reason.trim().normalize("NFC")).length >= 5 && Array.from(reason.trim().normalize("NFC")).length <= 1000;
  return <Box mt={3} pt={3} borderTop="1px solid rgba(41,35,28,.14)">
    <Typography variant="h6">官方形象安全停发 / 恢复</Typography>
    <Alert severity="warning" sx={{ my: 2 }}>与上方普通下架分开。普通下架只停止新领取，不应阻断旧批次；安全停发用于版权、违规或安全事件，会阻断整批重下载，不静默漏掉条目。</Alert>
    {error && <Alert severity="warning" sx={{ mb: 2 }}>{error}</Alert>}
    <Stack direction={{ xs: "column", sm: "row" }} gap={2}>
      <TextField select fullWidth label="选择官方形象" value={selectedId} disabled={busy} onChange={event => { setSelectedId(event.target.value); setReason(""); }}>
        <MenuItem value="">请选择形象</MenuItem>{appearances.map(item => <MenuItem key={item.assetId} value={item.assetId}>{item.appearanceNumber ? `#${item.appearanceNumber} · ` : ""}{item.name}</MenuItem>)}
      </TextField><Button disabled={busy || loading} onClick={() => void load()}>{loading ? "读取中" : "刷新安全状态"}</Button>
    </Stack>
    {selected && <Box my={2}><Typography fontWeight={750}>{selected.blocked ? "已安全停发" : "未安全停发"} · 当前安全修订 {selected.revision}</Typography>
      <Typography className="creator-admin-id" variant="caption">{selected.assetId}</Typography>
      <Typography className="creator-admin-copy" variant="body2">原处理原因：{selected.reason ?? "尚无安全停发记录"}</Typography>
      <Typography variant="caption" display="block">处理人：{selected.updatedBy ?? "无"} · 更新：{formatTime(selected.updatedAt)} · 最近读取：{formatTime(readAt)}</Typography></Box>}
    {selectedId && !selected && !loading && <Typography color="warning.main" my={2}>该形象的安全状态未确认，无法操作。</Typography>}
    <TextField label="本次安全操作原因（5 至 1000 字）" value={reason} onChange={event => setReason(event.target.value)} fullWidth multiline minRows={2} disabled={busy || loading || !selected} sx={{ mt: 2 }} slotProps={{ htmlInput: { maxLength: 1000 } }} />
    <Stack direction="row" flexWrap="wrap" gap={1} mt={2}>
      <Button color="error" variant="outlined" disabled={!selected || selected.blocked || !validReason || loading || busy} onClick={() => void change(true)}>安全停发，阻断重下载</Button>
      <Button variant="outlined" disabled={!selected || !selected.blocked || !validReason || loading || busy} onClick={() => void change(false)}>恢复安全分发</Button>
    </Stack>
    <Typography variant="caption" color="text.secondary" display="block" mt={2}>每次提交必须携带当前 requireCurrentRevision 和原因；冲突时重新读取，不把普通发布状态当作安全状态，也不触及历史收费订单。</Typography>
  </Box>;
}
