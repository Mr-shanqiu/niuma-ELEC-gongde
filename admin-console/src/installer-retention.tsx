import { useEffect, useState } from "react";
import { Alert, Box, Button, Card, CardContent, Stack, Typography } from "@mui/material";
import { useLogout } from "react-admin";
import { distributionRequest, formatTime } from "./distribution-api";

type Registration = { releaseId: string; platform: string; version: string; sha256: string;
  publicDownloadUrl: string; references: string[]; deletionAllowed: false };
type Retention = { asOf: string; registryStatus: string; minimumCompatibleVersion: string; items: Registration[] };

function versionParts(value: string): number[] | null {
  const match = /^v?(\d+)\.(\d+)\.(\d+)$/u.exec(value);
  if (!match) return null;
  const parts = match.slice(1).map(Number);
  return parts.every(Number.isSafeInteger) ? parts : null;
}

function compareVersions(left: string, right: string): number {
  const a = versionParts(left), b = versionParts(right);
  if (!a || !b) return 0;
  for (let index = 0; index < 3; index += 1) {
    if (a[index] !== b[index]) return a[index] > b[index] ? 1 : -1;
  }
  return 0;
}

function currentInstallers(items: Registration[]): Registration[] {
  const selected = new Map<string, Registration>();
  const preferred = (item: Registration) => item.platform === "macos"
    ? /\.dmg(?:[?#]|$)/u.test(item.publicDownloadUrl)
    : /\.exe(?:[?#]|$)/u.test(item.publicDownloadUrl);
  for (const item of items) {
    const current = selected.get(item.platform);
    const newer = current ? compareVersions(item.version, current.version) : 1;
    if (!current || newer > 0 || (newer === 0 && preferred(item) && !preferred(current))) {
      selected.set(item.platform, item);
    }
  }
  return [selected.get("macos"), selected.get("windows")].filter((item): item is Registration => Boolean(item));
}

export function InstallerRetentionPanel() {
  const [data, setData] = useState<Retention | null>(null), [error, setError] = useState("");
  const [reload, setReload] = useState(0), [loading, setLoading] = useState(false);
  const [showHistory, setShowHistory] = useState(false);
  const logout = useLogout();
  useEffect(() => {
    const controller = new AbortController(); setLoading(true); setData(null); setError(""); setShowHistory(false);
    void distributionRequest("/installer-retention", { signal: controller.signal }).then(result => {
      if (!result.data || !Array.isArray(result.data.items) || !Number.isFinite(Date.parse(result.data.asOf)) ||
          !result.data.items.every((item: Registration) => typeof item.releaseId === "string" && Array.isArray(item.references) &&
            ["macos", "windows"].includes(item.platform) && typeof item.version === "string" && versionParts(item.version) !== null &&
            typeof item.publicDownloadUrl === "string" && typeof item.sha256 === "string")) {
        throw new Error("安装包引用登记尚未确认，所有安装包保持保留。");
      }
      if (!controller.signal.aborted) setData(result.data);
    }).catch(failure => {
      if (controller.signal.aborted) return;
      setError(failure instanceof Error ? failure.message : "安装包引用读取失败。");
      if (failure.status === 401) void logout();
    }).finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [reload, logout]);
  const current = data?.registryStatus !== "unavailable" ? currentInstallers(data?.items ?? []) : [];
  const history = data?.items.filter(item => !current.includes(item)) ?? [];
  const records = showHistory ? [...current, ...history] : current;
  return <Card sx={{ m: 2 }}><CardContent>
    <Stack direction="row" alignItems="center" justifyContent="space-between" gap={2}><Typography variant="h6">当前安装包</Typography><Button disabled={loading} onClick={() => setReload(value => value + 1)}>{loading ? "读取中" : "刷新"}</Button></Stack>
    <Typography variant="body2" color="text.secondary" sx={{ my: 2 }}>默认只显示下载登记中每个平台的最新版本：Mac 和 Windows 各一份。旧版本不再堆叠在日常列表中。</Typography>
    {error && <Alert severity="warning">{error}</Alert>}
    {data?.registryStatus === "unavailable" && <Alert severity="warning">当前下载登记未确认，不能据此认定官网没有引用。</Alert>}
    {data && <>
      <Stack gap={2} mt={2}>{records.map(item => <Box key={`${item.platform}:${item.releaseId}`} borderBottom="1px solid rgba(41,35,28,.14)" pb={2}>
        <Typography fontWeight={750}>{item.platform === "macos" ? "Mac" : "Windows"} · {item.version}{current.includes(item) ? " · 当前登记版本" : " · 旧版本"}</Typography>
        <Typography variant="body2">{item.platform === "macos" ? "01 · Mac 客户端安装包" : "01 · Windows 客户端安装包"}；免费下载安装，基础木鱼安装即用。</Typography>
        <details><summary style={{ cursor: "pointer", marginTop: 8 }}>查看文件登记与校验信息</summary>
          <Typography variant="body2">发布编号：{item.releaseId}</Typography>
          <Typography variant="body2">引用：客户端下载登记{item.references.includes("minimum-compatibility") ? "、最低兼容要求" : ""}。</Typography>
          <Typography className="creator-admin-id" variant="caption">SHA-256：{item.sha256}</Typography>
          <Typography className="creator-admin-id" variant="caption">正式文件地址：{item.publicDownloadUrl}</Typography>
        </details>
      </Box>)}</Stack>
      {data.registryStatus !== "unavailable" && current.length === 0 && <Typography mt={2}>暂无可确认的当前安装包登记。</Typography>}
      {data.registryStatus !== "unavailable" && history.length > 0 && <Button size="small" sx={{ mt: 2 }} onClick={() => setShowHistory(value => !value)}>{showHistory ? "收起旧版本" : `排障时查看旧版本（${history.length}）`}</Button>}
      <Typography variant="caption" display="block" mt={2}>登记读取：{formatTime(data.asOf)}。旧安装文件仅隐藏，不删除；需要清理文件时须另行核对官网、最低兼容与回退引用。</Typography>
      <details style={{ marginTop: 12 }}><summary style={{ cursor: "pointer" }}>兼容与保留说明</summary><Typography variant="body2">当前永久离线包最低兼容版本：{data.minimumCompatibleVersion}。此页面只展示已登记文件，不推断回退包或保留期限；登记不可用时不认为旧文件已无引用。</Typography></details>
    </>}
  </CardContent></Card>;
}
