import React, { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import {
  Admin, Create, CreateButton, Datagrid, DateField, DateInput, DeleteButton, FileField, FileInput,
  FunctionField, List, NumberField, Resource, required, SelectInput, Show, SimpleForm, SimpleShowLayout,
  TextField, TextInput, TopToolbar, useLogin, useNotify
} from "react-admin";
import type { AuthProvider, DataProvider } from "react-admin";
import { Box, Button, Card, CardContent, Chip, CircularProgress, Stack, TextField as MuiTextField, Typography } from "@mui/material";
import { createTheme } from "@mui/material/styles";
import "./admin.css";

const API = "/api/gongde/admin";

async function request(path: string, init: RequestInit = {}) {
  const response = await fetch(`${API}${path}`, {
    credentials: "same-origin",
    ...init,
    headers: { "content-type": "application/json", ...(init.headers ?? {}) }
  });
  const body = await response.json().catch(() => ({ error: "invalid_response" }));
  if (!response.ok) {
    const error = new Error(body.error ?? "request_failed") as Error & { status?: number };
    error.status = response.status;
    throw error;
  }
  return body;
}

const authProvider: AuthProvider = {
  login: async ({ username, password }) => { await request("/login", { method: "POST", body: JSON.stringify({ username, password }) }); },
  logout: async () => { await request("/logout", { method: "POST", body: "{}" }); },
  checkAuth: async () => { await request("/session"); },
  checkError: async (error) => { if (error?.status === 401) throw error; },
  getIdentity: async () => { const session = await request("/session"); return { id: session.username, fullName: session.username }; },
  getPermissions: async () => ["read"]
};

const unsupported = () => Promise.reject(new Error("read_only_admin"));
const dataProvider: DataProvider = {
  getList: async (resource, params) => {
    if (resource === "appearances") return await request("/appearances");
    if (resource === "appearanceFiles" || resource === "installerFiles") {
      const kind = resource === "appearanceFiles" ? "appearance" : "installer";
      return await request(`/files?kind=${kind}`);
    }
    const query = new URLSearchParams({ page: String(params.pagination?.page ?? 1), perPage: String(params.pagination?.perPage ?? 25) });
    const filter = params.filter ?? {};
    if (filter.orderNo) query.set("orderNo", filter.orderNo);
    if (filter.accessCode) query.set("accessCode", filter.accessCode);
    if (filter.channel) query.set("channel", filter.channel);
    if (filter.state) query.set("state", filter.state);
    if (filter.from) query.set("from", new Date(`${filter.from}T00:00:00`).toISOString());
    if (filter.to) {
      const exclusive = new Date(`${filter.to}T00:00:00`);
      exclusive.setDate(exclusive.getDate() + 1);
      query.set("to", exclusive.toISOString());
    }
    return await request(`/orders?${query}`);
  },
  getOne: async (resource, params) => resource === "orders" ? await request(`/orders/${encodeURIComponent(String(params.id))}`) : unsupported(),
  create: async (resource, params) => {
    if (resource !== "appearanceFiles" && resource !== "installerFiles") return unsupported();
    const kind = resource === "appearanceFiles" ? "appearance" : "installer";
    const rawFile = params.data.file?.rawFile as File | undefined;
    if (!rawFile) throw new Error("请选择要上传的文件");
    const response = await fetch(`${API}/files?kind=${kind}&name=${encodeURIComponent(rawFile.name)}`, {
      method: "POST",
      credentials: "same-origin",
      headers: { "content-type": rawFile.type || "application/octet-stream" },
      body: rawFile
    });
    const body = await response.json().catch(() => ({ error: "invalid_response" }));
    if (!response.ok) {
      const error = new Error(body.error ?? "upload_failed") as Error & { status?: number };
      error.status = response.status;
      throw error;
    }
    return body;
  },
  delete: async (resource, params) => {
    if (resource !== "appearanceFiles" && resource !== "installerFiles") return unsupported();
    const kind = resource === "appearanceFiles" ? "appearance" : "installer";
    const name = String(params.previousData?.name ?? "");
    return await request(`/files?kind=${kind}&name=${encodeURIComponent(name)}`, { method: "DELETE" });
  },
  getMany: unsupported, getManyReference: unsupported, update: unsupported,
  updateMany: unsupported, deleteMany: unsupported
};

const theme = createTheme({
  palette: {
    mode: "light",
    primary: { main: "#d6532d", dark: "#a83b21", contrastText: "#ffffff" },
    secondary: { main: "#415b49" },
    background: { default: "#f4ecde", paper: "#fffaf1" },
    text: { primary: "#29231c", secondary: "#746858" },
    divider: "rgba(41,35,28,.14)"
  },
  typography: { fontFamily: '"Avenir Next", "PingFang SC", "Microsoft YaHei", sans-serif' },
  shape: { borderRadius: 14 },
  components: {
    MuiButton: { styleOverrides: { root: { borderRadius: 999, textTransform: "none", fontWeight: 750 } } },
    MuiPaper: { styleOverrides: { root: { backgroundImage: "none" } } },
    MuiTableCell: { styleOverrides: { head: { fontWeight: 800, color: "#746858" } } }
  }
});

const stateChoices = [
  ["PAID", "已支付"], ["FULFILLED", "已交付"]
].map(([id, name]) => ({ id, name }));
const kindNames: Record<string, string> = { "official-pass": "官方形象通行证", "asset-delivery": "形象包交付", support: "赞赏" };
const stateNames = Object.fromEntries(stateChoices.map(({ id, name }) => [id, name]));

function LoginPage() {
  const login = useLogin();
  const notify = useNotify();
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    setBusy(true);
    try { await login({ username, password }); }
    catch { notify("账号或密码不正确", { type: "error" }); }
    finally { setBusy(false); }
  };
  return <main className="login-page">
    <section className="login-story">
      <span className="seal">功</span>
      <p>牛马电子功德</p>
      <h1>看清每一笔<br />认真经营。</h1>
      <small>管理台只提供查看功能，不会修改、删除或退款任何订单。</small>
    </section>
    <form className="login-panel" onSubmit={submit}>
      <p className="eyebrow">PRIVATE CONSOLE</p>
      <h2>管理员登录</h2>
      <MuiTextField label="管理员账号" value={username} onChange={(event) => setUsername(event.target.value)} autoComplete="username" required fullWidth />
      <MuiTextField label="密码" type="password" value={password} onChange={(event) => setPassword(event.target.value)} autoComplete="current-password" required fullWidth />
      <Button type="submit" variant="contained" size="large" disabled={busy}>{busy ? "正在验证" : "进入只读管理台"}</Button>
    </form>
  </main>;
}

function StatusChip({ state }: { state: string }) {
  const tone = state === "FULFILLED" || state === "PAID" ? "success" : state === "PENDING_PAYMENT" ? "warning" : state === "EXCEPTION" ? "error" : "default";
  return <Chip size="small" color={tone} variant={tone === "default" ? "outlined" : "filled"} label={stateNames[state] ?? state} />;
}

function Dashboard() {
  const [data, setData] = useState<any>(null);
  const [error, setError] = useState(false);
  const [selectedDate, setSelectedDate] = useState(() => {
    const now = new Date();
    return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
  });
  useEffect(() => {
    setData(null);
    setError(false);
    const from = new Date(`${selectedDate}T00:00:00`);
    const to = new Date(from); to.setDate(to.getDate() + 1);
    request(`/overview?from=${encodeURIComponent(from.toISOString())}&to=${encodeURIComponent(to.toISOString())}`).then(setData).catch(() => setError(true));
  }, [selectedDate]);
  if (error) return <Box p={4}><Typography color="error">经营概览暂时无法读取，请稍后重试。</Typography></Box>;
  if (!data) return <Box className="dashboard-loading"><CircularProgress size={28} /></Box>;
  const serviceNames: Record<string, string> = { database: "订单数据库", wechat: "微信支付", alipay: "支付宝", appearanceDelivery: "形象包交付" };
  const statusNames: Record<string, string> = { healthy: "正常", disabled: "未启用", error: "异常" };
  const PeriodCard = ({ label, value }: { label: string; value: { orders: number; amountFen: number } }) => <Card><CardContent><span>{label}</span><strong>{value.orders}</strong><Typography variant="caption" color="text.secondary">实收 ¥{(value.amountFen / 100).toFixed(2)}</Typography></CardContent></Card>;
  return <Box className="dashboard-shell">
    <Box className="dashboard-heading"><div><Typography variant="overline">OVERVIEW</Typography><Typography variant="h4">经营概览</Typography></div><Stack direction="row" alignItems="center" gap={1.5}><MuiTextField label="查看日期" type="date" size="small" value={selectedDate} onChange={(event) => setSelectedDate(event.target.value)} slotProps={{ inputLabel: { shrink: true } }} /><Chip label="只看有效订单" color="secondary" /></Stack></Box>
    <Box className="metric-grid">
      <PeriodCard label="所选日期有效订单" value={data.periods.selectedDay} />
      <PeriodCard label="累计有效订单" value={data.periods.allTime} />
      <Card><CardContent><span>所选日期安装包下载</span><strong>{data.downloads.period}</strong></CardContent></Card>
      <Card><CardContent><span>累计安装包下载</span><strong>{data.downloads.total}</strong></CardContent></Card>
    </Box>
    <Card className="service-card"><CardContent><Typography variant="h6">服务状态</Typography><Stack direction="row" useFlexGap flexWrap="wrap" gap={1.2} mt={2}>{Object.entries(data.services).map(([key, value]) => <Chip key={key} variant="outlined" color={value === "healthy" ? "success" : value === "error" ? "error" : "default"} label={`${serviceNames[key]} · ${statusNames[String(value)]}`} />)}</Stack></CardContent></Card>
    <Card className="recent-card"><CardContent><Typography variant="h6">最近有效订单</Typography>{data.recent.length === 0 ? <p className="empty-copy">目前还没有已支付订单。</p> : <div className="recent-list">{data.recent.map((item: any) => <a href={`#/orders/${item.id}/show`} key={item.id}><div><b>{item.orderNo}</b><small>{kindNames[item.purchaseKind] ?? item.purchaseKind}</small></div><div><StatusChip state={item.state} /><strong>¥{(item.amountFen / 100).toFixed(2)}</strong></div></a>)}</div>}</CardContent></Card>
  </Box>;
}

const orderFilters = [
  <TextInput key="orderNo" source="orderNo" label="订单号" alwaysOn />,
  <TextInput key="accessCode" source="accessCode" label="权益码" alwaysOn />,
  <SelectInput key="channel" source="channel" label="支付渠道" choices={[{ id: "wechat", name: "微信支付" }, { id: "alipay", name: "支付宝" }]} />,
  <SelectInput key="state" source="state" label="订单状态" choices={stateChoices} />,
  <DateInput key="from" source="from" label="开始日期" />,
  <DateInput key="to" source="to" label="结束日期" />
];

function OrderList() {
  return <List title="有效订单" filters={orderFilters} perPage={25} sort={{ field: "createdAt", order: "DESC" }} actions={false}>
    <Datagrid rowClick="show" bulkActionButtons={false}>
      <TextField source="orderNo" label="订单号" />
      <FunctionField label="类型" render={(record: any) => kindNames[record.purchaseKind] ?? record.purchaseKind} />
      <FunctionField label="状态" render={(record: any) => <StatusChip state={record.state} />} />
      <FunctionField label="支付渠道" render={(record: any) => record.channel === "wechat" ? "微信" : "支付宝"} />
      <FunctionField label="金额" render={(record: any) => `¥${(record.amountFen / 100).toFixed(2)}`} />
      <DateField source="createdAt" label="创建时间" showTime />
    </Datagrid>
  </List>;
}

function AppearanceCatalogList() {
  return <List title="官方形象库" actions={false} pagination={false} sort={{ field: "name", order: "ASC" }}>
    <Datagrid bulkActionButtons={false}>
      <TextField source="name" label="形象名称" />
      <TextField source="assetId" label="形象 ID" />
      <FunctionField label="资源版本" render={(record: any) => record.revision ? `${record.revision.slice(0, 12)}…` : "缺失"} />
      <FunctionField label="状态" render={(record: any) => <Chip size="small" color={record.state === "PUBLISHED" ? "success" : "error"} label={record.state === "PUBLISHED" ? "已发布" : "资源缺失"} />} />
    </Datagrid>
  </List>;
}

function OrderShow() {
  return <Show title="订单详情" actions={false}>
    <SimpleShowLayout>
      <TextField source="orderNo" label="订单号" />
      <FunctionField label="订单类型" render={(record: any) => kindNames[record.purchaseKind] ?? record.purchaseKind} />
      <FunctionField label="订单状态" render={(record: any) => <StatusChip state={record.state} />} />
      <FunctionField label="支付渠道" render={(record: any) => record.channel === "wechat" ? "微信支付" : "支付宝"} />
      <NumberField source="amountFen" label="金额（分）" />
      <TextField source="userReference" label="用户匿名标识" emptyText="无" />
      <FunctionField label="形象包" render={(record: any) => record.assetIds?.length ? record.assetIds.join("、") : "无"} />
      <TextField source="providerTransactionId" label="支付平台交易号" emptyText="无" />
      <DateField source="createdAt" label="创建时间" showTime />
      <DateField source="paidAt" label="支付时间" showTime emptyText="未支付" />
      <DateField source="fulfilledAt" label="交付时间" showTime emptyText="未交付" />
      <FunctionField label="权益记录" render={(record: any) => record.entitlements?.length ? record.entitlements.map((item: any) => `${item.scope}${item.assetId ? ` · ${item.assetId}` : ""} · ${item.state}`).join("；") : "无"} />
    </SimpleShowLayout>
  </Show>;
}

function fileSize(bytes: number): string {
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
}

function ManagedFileActions({ label }: { label: string }) {
  return <TopToolbar><CreateButton label={label} /></TopToolbar>;
}

function ManagedFileList({ kind }: { kind: "appearance" | "installer" }) {
  const appearance = kind === "appearance";
  return <List
    title={appearance ? "形象包管理" : "安装包管理"}
    actions={<ManagedFileActions label={appearance ? "上传形象包" : "上传安装包"} />}
    pagination={false}
    sort={{ field: "lastModified", order: "DESC" }}
  >
    <Datagrid bulkActionButtons={false}>
      <TextField source="name" label="文件名" />
      <FunctionField label="大小" render={(record: any) => fileSize(record.size)} />
      <FunctionField label="下载量" render={(record: any) => record.downloads ?? 0} />
      <DateField source="lastModified" label="更新时间" showTime emptyText="未知" />
      <FunctionField label="公开地址" render={(record: any) => <a className="file-link" href={record.url} target="_blank" rel="noreferrer">打开</a>} />
      <DeleteButton label="删除" mutationMode="pessimistic" confirmTitle="确认删除这个文件？" confirmContent="删除后官网对应下载会立即失效，此操作无法撤销。" />
    </Datagrid>
  </List>;
}

function ManagedFileCreate({ kind }: { kind: "appearance" | "installer" }) {
  const appearance = kind === "appearance";
  return <Create title={appearance ? "上传形象包" : "上传安装包"} redirect="list">
    <SimpleForm>
      <Typography variant="body2" color="text.secondary" className="upload-note">
        {appearance ? "仅接受 .nmgpack 文件，单个不超过 20 MB。上传同名文件会更新现有版本。" : "仅接受 .dmg 或 .exe 文件，单个不超过 80 MB。请先在对应系统完成测试。"}
      </Typography>
      <FileInput
        source="file"
        label={appearance ? "选择形象包" : "选择安装包"}
        accept={appearance ? { "application/zip": [".nmgpack"] } : { "application/x-apple-diskimage": [".dmg"], "application/vnd.microsoft.portable-executable": [".exe"] }}
        maxSize={appearance ? 20 * 1024 * 1024 : 80 * 1024 * 1024}
        validate={required()}
      >
        <FileField source="src" title="title" />
      </FileInput>
    </SimpleForm>
  </Create>;
}

createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <Admin title="牛马电子功德管理台" theme={theme} dataProvider={dataProvider} authProvider={authProvider} loginPage={LoginPage} dashboard={Dashboard} requireAuth disableTelemetry>
      <Resource name="orders" options={{ label: "有效订单" }} list={OrderList} show={OrderShow} />
      <Resource name="appearances" options={{ label: "官方形象" }} list={AppearanceCatalogList} />
      <Resource name="appearanceFiles" options={{ label: "独立形象包" }} list={() => <ManagedFileList kind="appearance" />} create={() => <ManagedFileCreate kind="appearance" />} />
      <Resource name="installerFiles" options={{ label: "安装包" }} list={() => <ManagedFileList kind="installer" />} create={() => <ManagedFileCreate kind="installer" />} />
    </Admin>
  </React.StrictMode>
);
