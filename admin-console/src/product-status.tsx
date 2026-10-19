import { useEffect, useState } from "react";
import { Alert, Box, Button, Card, CardContent, Chip, Stack, Typography } from "@mui/material";

type Configuration = {
  mode: string; enabled: boolean; unitPriceFen: number; maxItems: number;
  paymentChannels: { wechat: boolean; alipay: boolean };
  idempotency: { ready: boolean; durable: boolean; scope: string };
};

export function ProductStatusPanel() {
  const [configuration, setConfiguration] = useState<Configuration | null>(null);
  const [error, setError] = useState("");
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    const controller = new AbortController(); setConfiguration(null); setError("");
    void fetch("/api/gongde/payment-config", { credentials: "same-origin", signal: controller.signal }).then(async response => {
      if (!response.ok) throw new Error("支付配置暂时不可读");
      const value = await response.json();
      if (typeof value.mode !== "string" || typeof value.enabled !== "boolean" ||
          !Number.isSafeInteger(value.unitPriceFen) || !Number.isSafeInteger(value.maxItems) ||
          typeof value.paymentChannels?.wechat !== "boolean" || typeof value.paymentChannels?.alipay !== "boolean" ||
          typeof value.idempotency?.ready !== "boolean" || typeof value.idempotency?.durable !== "boolean" ||
          typeof value.idempotency?.scope !== "string") throw new Error("支付配置结构未确认");
      if (!controller.signal.aborted) setConfiguration(value);
    }).catch(failure => {
      if (!controller.signal.aborted) setError(failure instanceof Error ? failure.message : "支付配置读取失败");
    });
    return () => controller.abort();
  }, [revision]);
  const aligned = configuration?.unitPriceFen === 100 && configuration.maxItems === 10;
  return <Card sx={{ mb: 3 }}><CardContent>
    <Stack direction="row" alignItems="center" justifyContent="space-between" gap={2}>
      <Typography variant="h6">当前产品规则与下载入口</Typography>
      <Button size="small" onClick={() => setRevision(value => value + 1)}>刷新支付配置</Button>
    </Stack>
    <Stack direction="row" flexWrap="wrap" gap={1} my={2}>
      <Chip label="基础木鱼 / 客户端直接免费" color="secondary" />
      <Chip label="扩展形象 ¥1 / 个 · 每批最多 10 个" />
      <Chip label="官方群码免费 · 三天轮换" />
      <Chip label="共创 / 作者码暂停" variant="outlined" />
    </Stack>
    <Typography variant="body2" color="text.secondary">无套餐、无长期下载权益；每次新下载重新付款或使用有效群码。已保存文件可永久离线使用。首次使用先安装 01 客户端，再导入 02 形象文件；图库仍在首页。</Typography>
    {error && <Alert severity="warning" sx={{ mt: 2 }}>{error}。未将未知状态显示为已开放。</Alert>}
    {configuration && <Box mt={2}>
      {!aligned && <Alert severity="error" sx={{ mb: 1 }}>服务端价格或批次上限与当前方案不一致，请先处理配置；不会在管理端自行改价。</Alert>}
      <Stack direction="row" flexWrap="wrap" gap={1}>
        <Chip size="small" label={configuration.mode === "live" ? "真实支付模式" : "非真实支付模式"} color={configuration.mode === "live" ? "success" : "warning"} />
        <Chip size="small" label={configuration.enabled ? "支付入口已配置" : "支付入口未开放"} color={configuration.enabled ? "success" : "warning"} />
        <Chip size="small" label={`微信：${configuration.paymentChannels.wechat ? "已配置" : "不可用"}`} />
        <Chip size="small" label={`支付宝：${configuration.paymentChannels.alipay ? "已配置" : "不可用"}`} />
        <Chip size="small" label={configuration.idempotency.ready && configuration.idempotency.durable ? "持久去重就绪" : "持久去重未确认"} color={configuration.idempotency.ready && configuration.idempotency.durable ? "success" : "warning"} />
      </Stack>
      <Typography variant="caption" display="block" mt={1}>服务端价格 ¥{(configuration.unitPriceFen / 100).toFixed(2)} / 个，上限 {configuration.maxItems} 个。以上是配置与就绪信息，不代表真实付款或用户下载验收通过。</Typography>
    </Box>}
    <Stack direction="row" flexWrap="wrap" gap={1} mt={2}>
      <Button href="#/orders">付费订单</Button><Button href="#/groupBenefits">官方群码</Button>
      <Button href="#/claims">领取记录</Button><Button href="#/appearanceFiles">形象管理</Button>
      <Button href="#/installerFiles">当前安装包</Button>
    </Stack>
  </CardContent></Card>;
}
