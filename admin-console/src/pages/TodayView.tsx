import { useState } from "react";
import { Alert, Button, Card, Collapse, Space, Tooltip, Typography } from "antd";
import { ArrowRightOutlined, InfoCircleOutlined, ReloadOutlined } from "@ant-design/icons";
import { DateRangeFilter, useAdminRange } from "../ui/DateRangeFilter";
import { rangeQuery } from "../ui/date-range";
import { beijingDate } from "../Shell";
import { shapes, useDistributionRead, useRead, v2Shapes } from "../ui/api";
import type { ReadState } from "../ui/api";
import { classifyDownloads, historicalRequests } from "../ui/downloads";
import type { DownloadCell, DownloadReport, DownloadSummary } from "../ui/downloads";
import { ReadGate } from "../ui/ReadGate";
import { StatusTag, type Tone } from "../ui/StatusTag";

type Counts = { orders: number; amountFen: number; totalOrders: number; byState: Record<string,number> };
type Overview = {
  periods: { selectedDay: Counts; allTime: Counts };
  downloads: { status: string; summary: DownloadSummary | null };
  recent: Array<{ orderNo: string; purchaseKind: string; state: string; amountFen: number; createdAt: string }>;
  services: Record<string, string>;
};
type ClaimIssue = { claimId: string; state: string; error: string | null; workNumbers: string[]; createdAt: string; waitingSeconds: number };
type Operations = {
  asOf: string;
  claims: { status: string; failed: number | null; blocked: number | null; preparingTooLong: number | null; hasMore: boolean | null; items: ClaimIssue[] };
};
type PaymentConfig = {
  mode: string; enabled: boolean; unitPriceFen: number; maxItems: number;
  paymentChannels: { wechat: boolean; alipay: boolean };
  idempotency: { ready: boolean; durable: boolean };
};
type ReportPage = { items: Array<{ id: string }>; total: number };

const serviceNames: Record<string, string> = {
  database: "订单数据库", wechat: "微信支付", alipay: "支付宝", appearanceDelivery: "形象包交付"
};
const serviceStates: Record<string, { label: string; tone: Tone }> = {
  healthy: { label: "正常", tone: "ok" },
  disabled: { label: "未启用", tone: "mute" },
  error: { label: "异常", tone: "bad" }
};

const beijingStamp = (value: string | null, withTime = false) => {
  if (!value || !Number.isFinite(Date.parse(value))) return "未提供";
  return new Intl.DateTimeFormat("zh-CN", withTime
    ? { timeZone: "Asia/Shanghai", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }
    : { timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit" }
  ).format(new Date(value));
};

/**
 * A number on this page has four distinct "nothing to show" states, and they
 * must not collapse into one:
 *   loading        → 读取中
 *   the call failed → 未读取   (nothing is shown, and no stale value)
 *   not configured  → 未接入   (counting exists but was never switched on)
 *   counted, zero   → 0
 */
function Stat({ label, value, unit, sub, emphasis }: {
  label: string;
  value: number | "unread" | "unconfigured" | "loading" | null;
  unit?: string;
  sub?: React.ReactNode;
  emphasis?: boolean;
}) {
  return (
    <div className={`stat${emphasis ? " stat-emphasis" : ""}`}>
      <div className="stat-label">{label}</div>
      {typeof value === "number" ? (
        <div className="stat-value">
          {value.toLocaleString("zh-CN")}
          {unit ? <span className="stat-unit">{unit}</span> : null}
        </div>
      ) : (
        <div className="stat-value is-missing">
          {value === "unconfigured" ? "未接入" : value === "loading" ? "读取中" : "未读取"}
        </div>
      )}
      {sub ? <div className="stat-sub">{sub}</div> : null}
    </div>
  );
}

export function TodayView() {
  const [range, setRange] = useAdminRange();
  const query = rangeQuery(range);
  type FreeStats = {readyClaims:number|null;workClaims:number|null;verifiedCodes:number|null};
  const freeStats=useDistributionRead<FreeStats>(query?`/stats?${query}`:null,{expectData:v2Shapes.stats});
  const freeTotal=useDistributionRead<FreeStats>("/stats?scope=all",{expectData:v2Shapes.stats});

  const overview = useRead<Overview>(query ? `/overview?${query}` : null, { expect: shapes.overview });
  const downloads = useRead<DownloadReport>(query ? `/download-report?${query}` : null, { expect: shapes.downloadReport });
  const operations = useDistributionRead<Operations>("/operations", { expectData: v2Shapes.operations });
  // Loaded only when the rules section is opened: it is reference material, not
  // something the operator needs on every visit. `enabled` is a real gate, so
  // until it is opened nothing is requested and nothing is claimed as loading.
  const [rulesOpen, setRulesOpen] = useState(false);
  const config = useRead<PaymentConfig>("/payment-config", { enabled: rulesOpen, expect: shapes.paymentConfig });
  // Reports live on the v2 surface, not the legacy admin one.
  const reports = useDistributionRead<ReportPage>("/reports?page=1&perPage=1&state=OPEN", { expectData: v2Shapes.reportsPage });

  const reloadAll = () => {
    overview.reload(); downloads.reload(); operations.reload(); reports.reload();freeStats.reload();freeTotal.reload();
    // Only re-read the rules if they are on screen; opening them reads them.
    if (rulesOpen) config.reload();
  };

  const ready = (state: ReadState<unknown>) => state.status === "ready" || state.status === "empty";

  /* 订单：概览一个请求同时给出区间与累计，两者口径不同，分别标注。 */
  const orders = ready(overview.state) ? (overview.state as { data: Overview }).data.periods : null;
  const orderCell = orders ? { value: orders.selectedDay.orders, amount: orders.selectedDay.amountFen }
    : overview.state.status === "loading" ? "loading" as const : "unread" as const;

  /* 下载：三个口径分别处理，0 只在真正读到时才出现。 */
  const downloadCell = classifyDownloads(downloads.state);
  const macos = downloadCell.note === "ready" ? downloadCell.summary.byPlatform.macos : null;
  const windows = downloadCell.note === "ready" ? downloadCell.summary.byPlatform.windows : null;

  /* 领取异常：类别数与事项数是两个数字，不要合成一个「3 项」。 */
  const operationsBody = ready(operations.state) ? (operations.state as { data: { data: Operations } }).data.data : null;
  const claimList = operationsBody?.claims ?? null;
  const claimCounts = claimList && claimList.status === "available"
    ? {
        items: claimList.items.length,
        more: claimList.hasMore === true,
        categories: [
          ["准备失败", claimList.failed],
          ["安全阻断", claimList.blocked],
          ["准备超时", claimList.preparingTooLong]
        ].filter((entry): entry is [string, number] => typeof entry[1] === "number" && entry[1] > 0)
      }
    : null;

  const reportCell = reports.state.status === "ready" ? reports.state.data.data.total
    : reports.state.status === "loading" ? "loading" as const : "unread" as const;

  return (
    <div className="page">
      <div className="page-toolbar">
        <DateRangeFilter value={range} onChange={setRange} />
        <span className="grow" />
        <Button icon={<ReloadOutlined />} onClick={reloadAll}>重新读取</Button>
      </div>

      <div className="stat-band">
        <Stat
          label="区间有效订单"
          value={typeof orderCell === "object" ? orderCell.value : orderCell}
          unit="笔"
          sub={typeof orderCell === "object" ? <>订单金额 ¥{(orderCell.amount / 100).toFixed(2)}</> : "订单概览未读取"}
        />
        <Stat
          label="区间下载请求"
          value={downloadCell.note === "ready" ? macos!.period + windows!.period
            : downloadCell.note === "loading" ? "loading" : downloadCell.note === "unread" ? "unread" : "unconfigured"}
          unit="次"
          sub={
            downloadCell.note === "ready" ? (
              <Tooltip title="安装包下载入口收到的请求次数；重复下载会重复计数，不代表安装人数。">
                <span className="stat-hint">
                  Windows {windows!.period.toLocaleString("zh-CN")}
                  <span className="sep">·</span>
                  macOS {macos!.period.toLocaleString("zh-CN")}
                  <InfoCircleOutlined />
                </span>
              </Tooltip>
            ) : downloadCell.note === "unread" ? "下载统计未读取（不是 0）"
              : downloadCell.note === "loading" ? "正在读取"
              : downloadCell.reason === "coverage" ? "已接入但没有统计起点" : "下载统计未接入"
          }
        />
        <Stat
          label="当前领取异常"
          value={
            claimCounts ? claimCounts.items
              : operations.state.status === "loading" ? "loading"
              : claimList ? "unread"   // 队列本身不可用：不写 0
              : "unread"
          }
          unit="批"
          emphasis
          sub={
            claimCounts
              ? claimCounts.categories.length > 0
                ? <>
                    {claimCounts.categories.length} 类：
                    {claimCounts.categories.map(([label, count]) => `${label} ${count}`).join(" · ")}
                    {claimCounts.more ? " · 还有更多" : ""}
                  </>
                : "队列已读取，当前为 0 批"
              : "运营异常未读取"
          }
        />
        <Stat
          label="当前待处理举报"
          value={reportCell}
          unit="条"
          sub={typeof reportCell === "number" ? "官网形象编号举报 · 待处理" : "举报列表未读取"}
        />
      </div>

      <Card className="flat-card" title="运营总台 · 区间与累计" extra={<Space><a href="#/orders">全部支付订单 →</a><a href="#/code">免费领取明细 →</a></Space>}>
        <div className="stat-band">
          <Stat label="区间全部支付订单" value={orders?orders.selectedDay.totalOrders:overview.state.status==="loading"?"loading":"unread"} unit="笔" sub={orders?`累计 ${orders.allTime.totalOrders.toLocaleString()} 笔`:undefined} />
          <Stat label="区间已发放免费批次" value={freeStats.state.status==="ready"?freeStats.state.data.data.readyClaims:freeStats.state.status==="loading"?"loading":"unread"} unit="批"
            sub={freeTotal.state.status==="ready"?`累计 ${freeTotal.state.data.data.readyClaims===null?"未采集":freeTotal.state.data.data.readyClaims.toLocaleString()} 批`:freeTotal.state.status==="loading"?"累计读取中":"累计未读取"} />
          <Stat label="区间免费作品领取" value={freeStats.state.status==="ready"?freeStats.state.data.data.workClaims:freeStats.state.status==="loading"?"loading":"unread"} unit="个" />
          <Stat label="累计有效订单金额" value={orders?orders.allTime.amountFen/100:overview.state.status==="loading"?"loading":"unread"} unit="元" sub={orders?`累计有效订单 ${orders.allTime.orders.toLocaleString()} 笔`:undefined} />
        </div>
        {freeStats.state.status==="error"?<Alert type="error" showIcon message="免费领取区间统计未读取" action={<Button onClick={freeStats.reload}>重试</Button>} />:null}
        {orders?<Space wrap>{Object.entries(orders.selectedDay.byState).map(([state,count])=><StatusTag key={state} tone={state==="EXCEPTION"?"bad":"mute"}>{({PENDING_PAYMENT:"待支付",PAID:"已支付",FULFILLED:"已交付",EXPIRED:"已过期",CANCELED:"已取消",EXCEPTION:"异常",REFUND_PENDING:"退款处理中",REFUNDED:"已退款"} as Record<string,string>)[state]??state} {count}</StatusTag>)}</Space>:null}
        <p className="page-sub">支付订单按创建时间筛选，状态为当前状态；有效订单仅含已支付与已交付，金额不是按支付日计算的结算净收入。免费批次与作品按首次发放时间统计，不混入支付订单。下方待办与服务状态为当前快照。</p>
      </Card>

      <DownloadCard state={downloads.state} cell={downloadCell} onRetry={downloads.reload} />

      <Card
        className="flat-card"
        title="当前需要你处理"
        extra={<Typography.Text type="secondary" className="card-extra">只列会阻塞用户或影响收款的事</Typography.Text>}
        styles={{ body: { padding: 0 } }}
      >
        <ReadGate
          state={operations.state}
          onRetry={operations.reload}
          emptyText="当前没有需要处理的领取异常。"
          skeletonRows={3}
        >
          {(body) => <IssueList claims={body.data.claims} />}
        </ReadGate>
      </Card>

      <div className="health-line">
        <span className="health-title">服务状态</span>
        {ready(overview.state) ? (
          <>
            {Object.entries((overview.state as { data: Overview }).data.services).map(([key, value]) => {
              const meta = serviceStates[value] ?? { label: "状态未确认", tone: "warn" as Tone };
              return (
                <StatusTag key={key} tone={meta.tone} dot>
                  {serviceNames[key] ?? key} {meta.label}
                </StatusTag>
              );
            })}
            <StatusTag tone={downloadCell.note === "ready" ? "ok" : downloadCell.note === "unconfigured" ? "mute" : "warn"} dot>
              下载计数 · {downloadCell.note === "ready" ? "已接入" : downloadCell.note === "unconfigured" ? "未接入" : "未读取"}
            </StatusTag>
          </>
        ) : (
          <StatusTag tone="warn" dot>健康检查未读取</StatusTag>
        )}
      </div>

      <Collapse
        ghost
        className="rules-collapse"
        activeKey={rulesOpen ? ["rules"] : []}
        onChange={(keys) => setRulesOpen(Array.isArray(keys) ? keys.includes("rules") : keys === "rules")}
        items={[{
          key: "rules",
          label: <span className="rules-title">当前产品规则与服务端配置对照</span>,
          children: <Rules state={config.state} onRetry={config.reload} />
        }]}
      />
    </div>
  );
}

function IssueList({ claims }: { claims: Operations["claims"] }) {
  if (claims.status !== "available") {
    return (
      <Alert
        type="warning"
        showIcon
        className="inline-alert"
        message="领取异常队列未统计"
        description="这不代表没有失败。请到「群码与领取」按日期查看真实记录。"
      />
    );
  }
  if (claims.items.length === 0) {
    return <div className="todo-empty">当前没有准备失败、安全阻断或超时准备的批次。</div>;
  }
  return (
    <div className="todo-list">
      {claims.items.map((item) => (
        <a
          className="todo-row"
          key={item.claimId}
          href={`#/code?claimId=${encodeURIComponent(item.claimId)}&date=${beijingDate(new Date(item.createdAt))}`}
        >
          <StatusTag tone="bad">{item.state === "FAILED" ? "准备失败" : item.state === "BLOCKED" ? "安全阻断" : "准备超时"}</StatusTag>
          <span className="todo-main">
            <strong>
              {item.workNumbers.length > 0 ? item.workNumbers.map((number) => `#${number}`).join("、") : "作品编号未记录"}
              {item.error ? ` · ${item.error}` : ""}
            </strong>
            <small>
              批次 {item.claimId.slice(0, 8)}…{item.claimId.slice(-4)} · 已等待 {formatDuration(item.waitingSeconds)}
            </small>
          </span>
          <span className="todo-meta">{beijingStamp(item.createdAt, true)}</span>
          <ArrowRightOutlined className="todo-arrow" />
        </a>
      ))}
      {claims.hasMore ? <div className="todo-empty">只列出最早的一批；完整记录见「群码与领取」。</div> : null}
    </div>
  );
}

function formatDuration(seconds: number): string {
  if (seconds >= 86_400) return `${Math.floor(seconds / 86_400)} 天 ${Math.floor((seconds % 86_400) / 3600)} 小时`;
  if (seconds >= 3600) return `${Math.floor(seconds / 3600)} 小时 ${Math.floor((seconds % 3600) / 60)} 分`;
  return `${Math.max(0, Math.floor(seconds / 60))} 分钟`;
}

/**
 * Download counts, one row per platform.
 *
 * The long explanation is collapsed: the numbers are the point, and what the
 * numbers are *not* is one line plus a disclosure. The coverage sentence comes
 * from the server; the page never writes "采集完整" on its own.
 *
 * The four states come from `classifyDownloads`, so this page and 安装包 cannot
 * disagree about what "未接入" means.
 */
function DownloadCard({ state, cell, onRetry }: {
  state: ReadState<DownloadReport>;
  cell: DownloadCell;
  onRetry: () => void;
}) {
  const report = cell.note === "ready" || cell.note === "unconfigured" ? cell.report : null;
  const coverage = report?.coverage;
  const configured = cell.note === "ready";
  const history = historicalRequests(cell);
  const label = cell.note === "ready" ? "官网安装包入口已接入"
    : cell.note === "unconfigured" ? (cell.reason === "coverage" ? "已接入，但没有统计起点" : "未接入")
    : cell.note === "loading" ? "读取中" : "未读取";

  return (
    <Card
      className="flat-card"
      title={
        <Space size={8}>
          <span>客户端下载请求</span>
          {/* "已接入但没起点" is a warning: counting works, the total has no beginning. */}
          <StatusTag tone={cell.note === "ready" ? "ok" : cell.note === "unconfigured" ? (cell.reason === "coverage" ? "warn" : "mute") : "warn"} dot>
            {label}
          </StatusTag>
        </Space>
      }
      extra={
        <Typography.Text type="secondary" className="card-extra">
          {/*
            A failed read cannot say anything about the start time. Printing
            "统计起点未配置" here would turn "we do not know" into a
            configuration fact the server never reported.
          */}
          {configured ? `统计起点 ${beijingStamp(coverage!.startedAt)}`
            : cell.note === "unconfigured" ? (cell.reason === "coverage" ? "统计起点未配置" : "文件存储未启用")
            : cell.note === "loading" ? "正在读取统计起点" : "统计起点未读取"}
        </Typography.Text>
      }
      styles={{ body: { padding: 0 } }}
    >
      {cell.note === "unread" ? (
        <div className="inline-alert">
          {/*
            A 200 whose store read failed is not "未接入": the operator has to
            retry, and saying the feature was never switched on sends them to
            the wrong place.
          */}
          {cell.reason === "read" ? (
            <Alert
              type="error"
              showIcon
              message="下载统计读取失败"
              description="服务端接受了请求，但汇总没有读出来。这是读取失败，不是没有下载，也不是统计未接入。"
              action={<Button size="small" icon={<ReloadOutlined />} onClick={onRetry}>重试</Button>}
            />
          ) : (
            <ReadGate state={state} onRetry={onRetry}>{() => null}</ReadGate>
          )}
        </div>
      ) : cell.note === "loading" ? (
        <div className="todo-empty">正在读取下载统计…</div>
      ) : cell.note === "unconfigured" ? (
        <div className="inline-alert">
          {cell.reason === "coverage" ? (
            <>
              <Alert
                type="warning"
                showIcon
                message="已接入计数，但没有配置统计起点"
                description="没有起点就没有「累计」：下面的数字只能当作历史上已记录到的请求，覆盖不完整，不能与接入后的累计混用。"
              />
              {history !== null ? (
                <div className="dl-note">
                  <span>历史已记录请求 {history.toLocaleString("zh-CN")} 条（覆盖不完整，不并入累计）。</span>
                  <details>
                    <summary>口径、覆盖范围与限制</summary>
                    <p>
                      {coverage?.scopeNote ?? "只统计官网下载入口的请求。"}
                      这些请求来自计数接入前的记录，覆盖范围不明，不能代表官网全部下载。
                      同一动作重复点击会重复计数；已保存的文件离线使用不产生请求。
                    </p>
                  </details>
                </div>
              ) : null}
            </>
          ) : (
            <Alert
              type="info"
              showIcon
              message="下载统计未接入"
              description="服务端还没有启用下载计数的文件存储。这里不显示 0，因为 0 会被读成「这个区间没有下载」。"
            />
          )}
        </div>
      ) : (
        <>
          <div className="dl-grid">
            <PlatformRow label="Windows" icon="⊞" today={cell.summary.byPlatform.windows.period} total={cell.summary.byPlatform.windows.total} />
            <PlatformRow label="macOS" icon="" today={cell.summary.byPlatform.macos.period} total={cell.summary.byPlatform.macos.total} />
          </div>
          <div className="dl-note">
            <span>按官网安装包入口的请求计数，不是安装人数或独立用户。</span>
            <details>
              <summary>口径、覆盖范围与限制</summary>
              <p>
                {coverage?.scopeNote ?? "只统计官网下载入口的请求。"}
                同一动作重复点击会重复计数；已保存的文件离线使用不产生请求，因此这里也不能反推安装或导入人数。
                累计只从统计起点开始；更早的有效记录如保留，会在下方单列，不并入累计，也不补造。
                {cell.summary.legacyCount > 0
                  ? ` 历史已记录请求 ${cell.summary.legacyCount.toLocaleString("zh-CN")} 条，覆盖不完整，未计入上方累计。`
                  : ""}
                {cell.summary.unattributed > 0
                  ? ` 另有 ${cell.summary.unattributed.toLocaleString("zh-CN")} 次请求的文件已不在当前登记中：仍计入总数，平台按历史文件扩展名归类。`
                  : ""}
                {cell.summary.earliest ? ` 累计范围内最早一次请求：${beijingStamp(cell.summary.earliest, true)}。` : ""}
              </p>
            </details>
          </div>
        </>
      )}
    </Card>
  );
}

function PlatformRow({ label, icon, today, total }: { label: string; icon: string; today: number; total: number }) {
  return (
    <div className="dl-row">
      <div className="dl-platform">
        <span className="dl-icon" aria-hidden="true">{icon}</span>
        <span>{label}</span>
      </div>
      <div className="dl-cell">
        <span className="dl-cell-label">区间</span>
        <span className="dl-value">{today.toLocaleString("zh-CN")}</span>
      </div>
      <div className="dl-cell">
        <span className="dl-cell-label">累计</span>
        <span className="dl-value">{total.toLocaleString("zh-CN")}</span>
      </div>
    </div>
  );
}

function Rules({ state, onRetry }: { state: ReadState<PaymentConfig>; onRetry: () => void }) {
  // A section that is closed has not asked yet; saying "读取中" there would
  // describe a request that is not happening.
  const serverRule = state.status === "ready"
    ? `¥${(state.data.unitPriceFen / 100).toFixed(2)} / 每批上限 ${state.data.maxItems} / ${
        state.data.mode === "live" ? "真实支付模式" : `非真实支付模式（${state.data.mode}）`} · ${
        state.data.unitPriceFen === 100 && state.data.maxItems === 10 ? "与产品规则一致" : "与产品规则不一致，需先处理配置"}`
    : state.status === "error" ? "未读取，未与产品规则对照"
    : state.status === "loading" ? "读取中" : "尚未读取";
  const rows: Array<[string, string]> = [
    ["基础形象", "免费，客户端直接下载，无需登录或付款"],
    ["扩展形象", "每个 1 元，每批最多 10 个不同形象，无套餐"],
    ["官方群码", "GD + 6 位数字，七天轮换，每批最多 10 个"],
    ["下载权益", "每次新下载重新付费或凭当期群码；已保存文件永久可用"],
    ["共创", "投稿、作者码与推广暂停，历史记录只读"],
    ["服务端配置", serverRule]
  ];
  return (
    <>
      <div className="rules-grid">
        {rows.map(([key, value]) => (
          <div className="rules-row" key={key}>
            <span className="rules-key">{key}</span>
            <span className="rules-value">{value}</span>
          </div>
        ))}
      </div>
      {state.status === "error" ? (
        <div className="rules-error">
          <Typography.Text type="secondary">{state.message} 这一块没有读取成功，不代表配置正确。</Typography.Text>
          <Button size="small" icon={<ReloadOutlined />} onClick={onRetry}>重新读取服务端配置</Button>
        </div>
      ) : null}
    </>
  );
}
