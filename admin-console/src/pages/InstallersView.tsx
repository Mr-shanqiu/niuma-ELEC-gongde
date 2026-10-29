import { DateRangeFilter, useAdminRange } from "../ui/DateRangeFilter";
import { rangeQuery } from "../ui/date-range";
import { useMemo, useState } from "react";
import { Alert, Button, Card, Collapse, Descriptions, Space, Table, Typography } from "antd";
import type { ColumnsType } from "antd/es/table";
import { ReloadOutlined } from "@ant-design/icons";
import { useDistributionRead, useRead } from "../ui/api";
import { shapes, v2Shapes } from "../ui/api";
import { classifyDownloads, historicalRequests } from "../ui/downloads";
import type { DownloadReport } from "../ui/downloads";
import { ReadGate } from "../ui/ReadGate";
import { StatusTag } from "../ui/StatusTag";

/**
 * Installers: what is registered, and how often each file was requested.
 *
 * The registry is the same list the counting endpoint validates against, so a
 * file shown here is a file that can be requested by name. Counts come from the
 * download report; when counting is off the table still lists the registry and
 * says the numbers are unavailable instead of printing zeros.
 */
type Registration = {
  releaseId: string;
  platform: "macos" | "windows";
  version: string;
  sha256: string;
  publicDownloadUrl: string;
  references: string[];
};
type Retention = {
  asOf: string;
  registryStatus: string;
  minimumCompatibleVersion: string;
  items: Registration[];
};
type RegistryItem = DownloadReport["registry"]["items"][number];

const platformLabel: Record<string, string> = { macos: "Mac", windows: "Windows" };

/** A same-shaped version is comparable; anything else is not compared at all. */
function versionParts(value: string): number[] | null {
  const match = /^v?(\d+)\.(\d+)\.(\d+)$/u.exec(value);
  if (!match) return null;
  const parts = match.slice(1).map(Number);
  return parts.every(Number.isSafeInteger) ? parts : null;
}

function compareVersions(left: string, right: string): number {
  const a = versionParts(left);
  const b = versionParts(right);
  if (!a || !b) return 0;
  for (let index = 0; index < 3; index += 1) if (a[index] !== b[index]) return a[index] > b[index] ? 1 : -1;
  return 0;
}

const fileSize = (bytes: number) =>
  bytes >= 1048576 ? `${(bytes / 1048576).toFixed(2)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`;

export function InstallersView() {
  const [range,setRange]=useAdminRange();
  const [showHistory, setShowHistory] = useState(false);

  // The registry comes from the same loader the counting endpoint uses, so the
  // two cannot disagree about which file names are valid.
  const report = useRead<DownloadReport>(`/download-report?${rangeQuery(range)}`, { expect: shapes.downloadReport });
  const retention = useDistributionRead<Retention>("/installer-retention", { expectData: v2Shapes.retention });

  const reload = () => { report.reload(); retention.reload(); };

  const registry = report.state.status === "ready" || report.state.status === "empty" ? report.state.data : null;
  const items = registry?.registry.status === "available" ? registry.registry.items : [];
  // Costs per file and per platform are only shown when counting has a real
  // start. Without one the numbers are earlier recorded events, so they are
  // reported as history instead of being labelled 累计.
  const cell = classifyDownloads(report.state);
  const summary = cell.note === "ready" ? cell.summary : null;
  const historyCount = historicalRequests(cell);
  /**
   * Why a count is missing, in the words that match the cause: counting off
   * (未接入) and counting on without a start (无统计起点) are different facts,
   * and "no start" would be a false claim about a store that never counted.
   */
  const missingNote = cell.note === "unconfigured"
    ? (cell.reason === "coverage" ? "无统计起点" : "未接入")
    : "未读取";

  const counts = useMemo(() => {
    const map = new Map<string, { period: number; total: number }>();
    for (const entry of summary?.byFile ?? []) map.set(entry.fileName, { period: entry.period, total: entry.total });
    return map;
  }, [summary]);

  /** Current = newest version per platform, preferring the installer-format file at a tie. */
  const current = useMemo(() => {
    const picked = new Map<string, RegistryItem>();
    for (const item of items) {
      const existing = picked.get(item.platform);
      if (!existing) { picked.set(item.platform, item); continue; }
      const newer = compareVersions(item.version, existing.version);
      const preferred = (value: RegistryItem) =>
        value.platform === "macos" ? /\.dmg$/iu.test(value.name) : /\.exe$/iu.test(value.name);
      if (newer > 0 || (newer === 0 && preferred(item) && !preferred(existing))) picked.set(item.platform, item);
    }
    return picked;
  }, [items]);

  const history = items.filter((item) => current.get(item.platform)?.name !== item.name);
  /** Whether "there are no other versions" is a fact or just an unread list. */
  const registryRead = report.state.status === "ready" || report.state.status === "empty";

  const retentionBody = retention.state.status === "ready" ? retention.state.data.data : null;

  const columns: ColumnsType<RegistryItem> = [
    {
      title: "平台",
      dataIndex: "platform",
      width: 96,
      render: (value: string) => <StatusTag tone="mute">{platformLabel[value] ?? value}</StatusTag>
    },
    {
      title: "文件",
      dataIndex: "name",
      render: (value: string) => <span className="mono">{value}</span>
    },
    { title: "版本", dataIndex: "version", width: 90 },
    { title: "大小", dataIndex: "bytes", width: 96, align: "right", render: (value: number) => fileSize(value) },
    {
      title: "区间请求",
      key: "period",
      width: 104,
      align: "right",
      render: (_: unknown, record: RegistryItem) => {
        if (cell.note === "loading") return <span className="missing-value">读取中</span>;
        if (cell.note === "unread") return <span className="missing-value">未读取</span>;
        if (cell.note === "unconfigured") return <span className="missing-value">{missingNote}</span>;
        return (counts.get(record.name)?.period ?? 0).toLocaleString("zh-CN");
      }
    },
    {
      title: "累计请求",
      key: "total",
      width: 104,
      align: "right",
      render: (_: unknown, record: RegistryItem) => {
        if (cell.note === "loading") return <span className="missing-value">读取中</span>;
        if (cell.note === "unread") return <span className="missing-value">未读取</span>;
        // No start means no cumulative total; the history band below carries
        // the number that does exist.
        if (cell.note === "unconfigured") return <span className="missing-value">{missingNote}</span>;
        return (counts.get(record.name)?.total ?? 0).toLocaleString("zh-CN");
      }
    }
  ];

  return (
    <div className="page">
      <div className="page-toolbar"><DateRangeFilter value={range} onChange={setRange} /></div>
      <div className="page-toolbar">
        <Typography.Text type="secondary">
          默认每平台只显示一份当前登记版本；旧版本折叠在下面。上传只保存文件，不自动切换官网当前版本。
        </Typography.Text>
        <span className="grow" />
        <Button icon={<ReloadOutlined />} onClick={reload}>重新读取</Button>
      </div>

      {cell.note === "unconfigured" && cell.reason === "coverage" ? (
        <Alert
          type="warning"
          showIcon
          message="已接入计数，但没有配置统计起点"
          description="下方文件与版本来自登记表，仍然可信；没有起点就没有累计，请求数字只能按历史上已记录的请求单列。"
        />
      ) : null}
      {cell.note === "unconfigured" && cell.reason === "store" ? (
        <Alert
          type="info"
          showIcon
          message="下载统计未接入"
          description="服务端还没有启用下载计数的文件存储。下方文件与版本仍然可信，请求次数不显示 0，因为 0 会被读成「没人下载」。"
        />
      ) : null}
      {cell.note === "unread" ? (
        <Alert
          type="error"
          showIcon
          message={cell.reason === "read" ? "下载统计读取失败" : "下载登记读取失败"}
          description="这是读取失败，不是没有请求，也不是统计未接入；下方不会显示 0。"
          action={<Button size="small" onClick={report.reload}>重试</Button>}
        />
      ) : null}

      <Card className="flat-card" title="当前登记版本" styles={{ body: { padding: 0 } }}>
        <ReadGate
          state={report.state}
          onRetry={report.reload}
          emptyText="下载登记返回了空列表。"
          emptyHint="这不代表官网没有安装包，请核对登记文件。"
          skeletonRows={3}
        >
          {() => registry?.registry.status !== "available" ? (
            <Alert
              type="warning"
              showIcon
              className="inline-alert"
              message="当前下载登记未确认"
              description="登记文件不可读时，不能据此认定官网没有引用，也不能判断某个文件名是否仍有效。"
            />
          ) : (
            <Table<RegistryItem>
              rowKey="name"
              size="middle"
              pagination={false}
              columns={columns}
              dataSource={[...current.values()]}
              scroll={{ x: 720 }}
            />
          )}
        </ReadGate>
        <div className="panel-foot">
          <Typography.Text type="secondary">
            统计区间 {registryRead ? `${range.start} 至 ${range.end}（北京时间）` : "未读取"} · 显示已记录的请求，不是安装人数或独立用户；防刷限流可能省略部分请求。明细保留90天，每日汇总保留730天，累计数量单独保留。
          </Typography.Text>
        </div>
      </Card>

      {cell.note === "unconfigured" && cell.reason === "coverage" && historyCount !== null ? (
        <Card className="flat-card" title="历史已记录请求（覆盖不完整）" styles={{ body: { padding: 18 } }}>
          <Typography.Paragraph>
            统计起点未配置，因此这些记录不能当作「自接入起的累计」：
            <strong> {historyCount.toLocaleString("zh-CN")} 条</strong>
          </Typography.Paragraph>
          <Typography.Paragraph type="secondary" className="drawer-note">
            它们来自计数接入前的存储，覆盖哪些入口、是否完整都无法确认。这里不补造历史，也不把它们并入任何累计。
          </Typography.Paragraph>
        </Card>
      ) : null}

      {summary && cell.note === "ready" ? (
        <Card className="flat-card" title="按平台汇总" styles={{ body: { padding: 0 } }}>
          <div className="dl-grid">
            {(["windows", "macos"] as const).map((platform) => {
              const value = summary.byPlatform[platform];
              return (
                <div className="dl-row" key={platform}>
                  <div className="dl-platform"><span>{platformLabel[platform]}</span></div>
                  <div className="dl-cell">
                    <span className="dl-cell-label">区间</span>
                    <span className="dl-value">{value.period.toLocaleString("zh-CN")}</span>
                  </div>
                  <div className="dl-cell">
                    <span className="dl-cell-label">累计</span>
                    <span className="dl-value">{value.total.toLocaleString("zh-CN")}</span>
                  </div>
                </div>
              );
            })}
          </div>
          <div className="dl-note">
            <span>{cell.report.coverage.scopeNote} CDN 直链、GitHub 与转发安装包不在范围内。</span>
            <details>
              <summary>统计状态与历史记录</summary>
              <p>
                统计起点：
                {cell.report.coverage.startedAt
                  ? new Intl.DateTimeFormat("zh-CN", { timeZone: "Asia/Shanghai", dateStyle: "long", timeStyle: "short" })
                      .format(new Date(cell.report.coverage.startedAt))
                  : "未配置（累计因此不完整）"}
                。
                {summary.legacyCount > 0
                  ? ` 起点之前另有 ${summary.legacyCount.toLocaleString("zh-CN")} 条已记录请求，覆盖不完整，未计入上方累计。`
                  : ""}
                {summary.unattributed > 0
                  ? ` 另有 ${summary.unattributed.toLocaleString("zh-CN")} 次请求的文件已不在当前登记中：仍计入总数，平台按历史文件扩展名归类。`
                  : ""}
              </p>
            </details>
          </div>
        </Card>
      ) : null}

      <Card className="flat-card" title="登记与保留" styles={{ body: { padding: 18 } }}>
        <ReadGate
          state={retention.state}
          onRetry={retention.reload}
          emptyText="保留登记返回了空列表。"
          skeletonRows={2}
        >
          {(body) => {
            const value = body.data;
            if (!value || !Array.isArray(value.items)) {
              return <Alert type="warning" showIcon message="安装包引用登记尚未确认，所有安装文件保持保留。" />;
            }
            return (
              <div className="stack-12">
                {value.registryStatus === "unavailable" ? (
                  <Alert type="warning" showIcon message="当前下载登记未确认，不能据此认定官网没有引用。" />
                ) : null}
                <Descriptions column={2} size="small" colon={false} labelStyle={{ color: "var(--faint)" }}>
                  <Descriptions.Item label="永久离线包最低兼容版本">{value.minimumCompatibleVersion}</Descriptions.Item>
                  <Descriptions.Item label="登记读取">
                    {Number.isFinite(Date.parse(value.asOf))
                      ? new Intl.DateTimeFormat("zh-CN", { timeZone: "Asia/Shanghai", dateStyle: "medium", timeStyle: "short" }).format(new Date(value.asOf))
                      : "未提供"}
                  </Descriptions.Item>
                </Descriptions>
                <Collapse
                  ghost
                  items={[{
                    key: "refs",
                    label: <span className="rules-title">查看文件登记与校验信息</span>,
                    children: (
                      <div className="stack-10">
                        {value.items.map((item) => (
                          <div key={`${item.platform}:${item.releaseId}`} className="reg-row">
                            <Typography.Text strong>
                              {platformLabel[item.platform] ?? item.platform} · {item.version}
                            </Typography.Text>
                            <Typography.Text type="secondary" className="mono break-all">
                              发布编号 {item.releaseId}
                            </Typography.Text>
                            <Typography.Text type="secondary" className="mono break-all">
                              SHA-256 {item.sha256}
                            </Typography.Text>
                            <Typography.Text type="secondary" className="mono break-all">
                              正式地址 {item.publicDownloadUrl}
                            </Typography.Text>
                            <Typography.Text type="secondary">
                              引用：{item.references.length > 0 ? item.references.join("、") : "未记录"} · 旧安装文件仅隐藏，不删除
                            </Typography.Text>
                          </div>
                        ))}
                      </div>
                    )
                  }]}
                />
              </div>
            );
          }}
        </ReadGate>
      </Card>

      <Card
        className="flat-card"
        title="旧版本"
        extra={
          <Button size="small" type="text" onClick={() => setShowHistory((value) => !value)}>
            {/* The count is only real once the registry has been read; an
                unread list would otherwise render as "0 old versions". */}
            {showHistory ? "收起" : registryRead ? `排障时查看（${history.length}）` : "排障时查看（未读取）"}
          </Button>
        }
        styles={{ body: { padding: showHistory ? 0 : 0 } }}
      >
        {showHistory ? (
          !registryRead ? (
            <div className="todo-empty">登记尚未读取，无法判断是否存在其他版本。</div>
          ) : history.length === 0 ? (
            <div className="todo-empty">当前登记里没有其他版本。</div>
          ) : (
            <Table<RegistryItem>
              rowKey="name"
              size="middle"
              pagination={false}
              columns={columns}
              dataSource={history}
              scroll={{ x: 720 }}
            />
          )
        ) : (
          <div className="todo-empty">
            旧版本默认隐藏。它们仍保留在存储中，清理需要另行核对官网与最低兼容引用。
          </div>
        )}
      </Card>

      <Typography.Paragraph type="secondary" className="drawer-note">
        安装包内容不由 API 代理：此页只登记与计数，下载仍然指向登记的正式文件地址。
        {retentionBody ? "" : " 保留登记本次未读取，因此上面的引用说明可能不完整。"}
      </Typography.Paragraph>
    </div>
  );
}
