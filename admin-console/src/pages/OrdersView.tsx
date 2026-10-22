import { useEffect, useState } from "react";
import { Alert, Button, Card, DatePicker, Descriptions, Drawer, Input, Select, Space, Table, Tooltip, Typography } from "antd";
import type { ColumnsType } from "antd/es/table";
import type { Dayjs } from "dayjs";
import { ReloadOutlined } from "@ant-design/icons";
import { api, shapes, useRead } from "../ui/api";
import type { ApiError } from "../ui/api";
import { ReadGate } from "../ui/ReadGate";
import { StatusTag, type Tone } from "../ui/StatusTag";

type Order = {
  id: string;
  orderNo: string;
  purchaseKind: string;
  channel: "wechat" | "alipay" | null;
  amountFen: number;
  state: "PAID" | "FULFILLED";
  assetIds: string[];
  createdAt: string;
};
type MarketItem = {
  sourceKind: "official" | "community";
  assetId: string;
  titleZh: string;
  versionLabel: string;
  sourceRevision: string;
  amountFen: number;
};
type OrderDetail = Order & {
  providerTransactionId: string | null;
  paidAt: string | null;
  fulfilledAt: string | null;
  entitlements: Array<{ scope: string; assetId: string | null; state: string }>;
  marketItems: MarketItem[];
};

/**
 * Historic trades stay here rather than in a page of their own; the label says
 * which rule produced them so a 旧规则 row is not read as a current price.
 */
const kindNames: Record<string, string> = {
  "official-pass": "旧规则底账",
  "asset-delivery": "旧规则底账",
  "appearance-batch": "付费下载批次",
  support: "旧规则赞赏底账"
};

/** The server accepts exactly these two filters; offering more would be a dead control. */
const stateChoices = [
  { value: "PAID", label: "已支付" },
  { value: "FULFILLED", label: "已交付" }
];

const stateMeta: Record<string, { tone: Tone; label: string }> = {
  FULFILLED: { tone: "ok", label: "已交付" },
  PAID: { tone: "accent", label: "已支付" }
};

const beijingTime = (value: string | null) => {
  if (!value || !Number.isFinite(Date.parse(value))) return "未提供";
  return new Intl.DateTimeFormat("zh-CN", {
    timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", hourCycle: "h23"
  }).format(new Date(value));
};

const yuan = (fen: number) => `¥${(fen / 100).toFixed(2)}`;

export function OrdersView() {
  const [orderNo, setOrderNo] = useState("");
  const [appliedOrderNo, setAppliedOrderNo] = useState("");
  const [channel, setChannel] = useState<string | undefined>();
  const [state, setState] = useState<string | undefined>();
  const [range, setRange] = useState<[Dayjs | null, Dayjs | null] | null>(null);
  const [page, setPage] = useState(1);
  const [selected, setSelected] = useState<Order | null>(null);

  const query = new URLSearchParams({ page: String(page), perPage: "25" });
  if (appliedOrderNo) query.set("orderNo", appliedOrderNo);
  if (channel) query.set("channel", channel);
  if (state) query.set("state", state);
  if (range?.[0]) query.set("from", range[0].startOf("day").toISOString());
  if (range?.[1]) query.set("to", range[1].add(1, "day").startOf("day").toISOString());

  // 排序固定：服务端按创建时间倒序返回。表头不提供排序，避免出现点了箭头顺序不变的假交互。
  const list = useRead<{ data: Order[]; total: number }>(`/orders?${query.toString()}`, {
    expect: shapes.list,
    isEmpty: (body) => (body as { data: Order[] }).data.length === 0
  });

  useEffect(() => { setPage(1); }, [appliedOrderNo, channel, state, range]);

  const reset = () => {
    setOrderNo("");
    setAppliedOrderNo("");
    setChannel(undefined);
    setState(undefined);
    setRange(null);
    setPage(1);
  };

  const columns: ColumnsType<Order> = [
    {
      title: "订单号",
      dataIndex: "orderNo",
      render: (value: string) => <span className="mono">{value}</span>
    },
    {
      title: "类型",
      dataIndex: "purchaseKind",
      render: (value: string) => (
        <Space size={6}>
          <span>{kindNames[value] ?? value}</span>
          {value !== "appearance-batch" ? <StatusTag tone="mute">历史交易</StatusTag> : null}
        </Space>
      )
    },
    {
      title: "状态",
      dataIndex: "state",
      render: (value: string) => {
        const meta = stateMeta[value];
        return meta ? <StatusTag tone={meta.tone}>{meta.label}</StatusTag> : <StatusTag tone="warn">状态未确认</StatusTag>;
      }
    },
    {
      title: "渠道",
      dataIndex: "channel",
      render: (value: Order["channel"]) => (value === "wechat" ? "微信" : value === "alipay" ? "支付宝" : "原记录未提供")
    },
    { title: "金额", dataIndex: "amountFen", align: "right", render: (value: number) => yuan(value) },
    { title: "创建时间", dataIndex: "createdAt", render: (value: string) => beijingTime(value) },
    {
      title: "",
      key: "action",
      align: "right",
      render: (_: unknown, record: Order) => <Button size="small" onClick={() => setSelected(record)}>详情</Button>
    }
  ];

  return (
    <div className="page">
      <div className="page-toolbar">
        <Input.Search
          allowClear
          placeholder="订单号"
          style={{ width: 210 }}
          value={orderNo}
          enterButton="筛选"
          onChange={(event) => {
            setOrderNo(event.target.value);
            if (event.target.value === "") setAppliedOrderNo("");
          }}
          onSearch={(value) => { setAppliedOrderNo(value.trim()); setPage(1); }}
        />
        <Select
          allowClear
          placeholder="全部渠道"
          style={{ width: 130 }}
          value={channel}
          onChange={(value) => { setChannel(value); setPage(1); }}
          options={[{ value: "wechat", label: "微信支付" }, { value: "alipay", label: "支付宝" }]}
        />
        <Select
          allowClear
          placeholder="全部状态"
          style={{ width: 130 }}
          value={state}
          onChange={(value) => { setState(value); setPage(1); }}
          options={stateChoices}
        />
        <DatePicker.RangePicker
          style={{ width: 250 }}
          value={range}
          onChange={(value) => { setRange(value as [Dayjs | null, Dayjs | null] | null); setPage(1); }}
          placeholder={["开始日期", "结束日期"]}
        />
        <Button onClick={reset}>清空</Button>
        <span className="grow" />
        <Button icon={<ReloadOutlined />} onClick={list.reload}>重新读取</Button>
      </div>

      <Card className="flat-card" styles={{ body: { padding: 0 } }}>
        <ReadGate
          state={list.state}
          onRetry={list.reload}
          emptyText="这个范围内没有符合条件的有效订单。"
          emptyHint="筛选条件过窄时也会是空结果，这不等于读取失败。"
          skeletonRows={6}
        >
          {(body) => (
            <>
              <Table<Order>
                rowKey="orderNo"
                size="middle"
                columns={columns}
                dataSource={body.data}
                pagination={false}
                scroll={{ x: 900 }}
              />
              <div className="pager">
                <Typography.Text type="secondary">
                  共 {body.total.toLocaleString("zh-CN")} 条 · 固定按创建时间倒序 · 底账含旧规则与验收交易
                </Typography.Text>
                <span className="grow" />
                <Button size="small" disabled={page === 1} onClick={() => setPage((value) => value - 1)}>上一页</Button>
                <span className="pager-page">第 {page} / {Math.max(1, Math.ceil(body.total / 25))} 页</span>
                <Button size="small" disabled={page * 25 >= body.total} onClick={() => setPage((value) => value + 1)}>下一页</Button>
              </div>
            </>
          )}
        </ReadGate>
      </Card>

      <OrderDrawer order={selected} onClose={() => setSelected(null)} />
    </div>
  );
}

/** The detail is a second read: the list row is a summary and must not be extended by guesswork. */
function OrderDrawer({ order, onClose }: { order: Order | null; onClose: () => void }) {
  const [detail, setDetail] = useState<OrderDetail | null>(null);
  const [failure, setFailure] = useState("");

  useEffect(() => {
    if (!order) { setDetail(null); setFailure(""); return; }
    const controller = new AbortController();
    setDetail(null);
    setFailure("");
    void api<{ data: OrderDetail }>(`/orders/${encodeURIComponent(order.orderNo)}`, { signal: controller.signal }, shapes.orderDetail)
      .then((body) => { if (!controller.signal.aborted) setDetail(body.data); })
      .catch((error: unknown) => {
        if (controller.signal.aborted) return;
        setFailure((error as ApiError)?.message ?? "详情读取失败。");
      });
    return () => controller.abort();
  }, [order]);

  return (
    <Drawer
      open={order !== null}
      onClose={onClose}
      width={520}
      title={order ? `交易详情 · ${order.orderNo}` : "交易详情"}
    >
      {order ? (
        <div className="drawer-stack">
          {failure ? (
            <Alert type="error" showIcon message="详情未读取" description={`${failure} 上方列表里的摘要仍然有效，但商品快照不能据此补充。`} />
          ) : !detail ? (
            <div className="todo-empty">正在读取交易详情…</div>
          ) : (
            <>
              <Descriptions column={1} size="small" colon={false} labelStyle={{ width: 92, color: "var(--faint)" }}>
                <Descriptions.Item label="订单号"><span className="mono">{detail.orderNo}</span></Descriptions.Item>
                <Descriptions.Item label="订单类型">{kindNames[detail.purchaseKind] ?? detail.purchaseKind}</Descriptions.Item>
                <Descriptions.Item label="订单状态">
                  <StatusTag tone={stateMeta[detail.state]?.tone ?? "warn"}>{stateMeta[detail.state]?.label ?? detail.state}</StatusTag>
                </Descriptions.Item>
                <Descriptions.Item label="支付渠道">
                  {detail.channel === "wechat" ? "微信支付" : detail.channel === "alipay" ? "支付宝" : "原记录未提供"}
                </Descriptions.Item>
                <Descriptions.Item label="金额">{yuan(detail.amountFen)}</Descriptions.Item>
                <Descriptions.Item label="形象包">{detail.assetIds.length > 0 ? detail.assetIds.join("、") : "无"}</Descriptions.Item>
                <Descriptions.Item label="平台交易号">
                  {detail.providerTransactionId ?? <Typography.Text type="secondary">无</Typography.Text>}
                </Descriptions.Item>
                <Descriptions.Item label="创建时间">{beijingTime(detail.createdAt)}</Descriptions.Item>
                <Descriptions.Item label="支付时间">{beijingTime(detail.paidAt)}</Descriptions.Item>
                <Descriptions.Item label="交付时间">{beijingTime(detail.fulfilledAt)}</Descriptions.Item>
              </Descriptions>

              <div>
                <Typography.Text strong>订单商品快照</Typography.Text>
                <Typography.Paragraph type="secondary" className="drawer-note">
                  只展示原始交易商品与金额快照，不按当前作品或最新版本补齐，也不恢复共创分成或旧权益。
                  交易记录不代表后续免费重下资格。
                </Typography.Paragraph>
                {detail.marketItems.length === 0 ? (
                  <Alert type="info" showIcon message="这笔订单没有商品快照" description="历史交易可能只记录了总金额。这里不补造条目。" />
                ) : (
                  <Table<MarketItem>
                    size="small"
                    pagination={false}
                    rowKey={(item) => `${item.assetId}:${item.versionLabel}`}
                    dataSource={detail.marketItems}
                    columns={[
                      { title: "名称", dataIndex: "titleZh", render: (value: string) => value || "快照缺失" },
                      {
                        title: "来源",
                        dataIndex: "sourceKind",
                        render: (value: string) => (value === "official" ? "官方" : value === "community" ? "社区" : "未知来源")
                      },
                      { title: "订单版本", dataIndex: "versionLabel", render: (value: string) => value || "快照缺失" },
                      {
                        title: "Revision",
                        dataIndex: "sourceRevision",
                        render: (value: string) =>
                          typeof value === "string" && value.length > 0 ? (
                            <Tooltip title={value}>
                              <span className="mono">{value.slice(0, 12)}{value.length > 12 ? "…" : ""}</span>
                            </Tooltip>
                          ) : "快照缺失"
                      },
                      { title: "商品金额", dataIndex: "amountFen", align: "right", render: (value: number) => yuan(value) }
                    ]}
                  />
                )}
              </div>

              <details className="drawer-details">
                <summary>存量权益记录（不授予新下载权益）</summary>
                {detail.entitlements.length === 0 ? (
                  <Typography.Text type="secondary">无</Typography.Text>
                ) : (
                  <ul className="plain-list">
                    {detail.entitlements.map((item, index) => (
                      <li key={`${item.scope}:${item.assetId ?? index}`}>
                        {item.scope}{item.assetId ? ` · ${item.assetId}` : ""} · {item.state}
                      </li>
                    ))}
                  </ul>
                )}
              </details>
            </>
          )}
        </div>
      ) : null}
    </Drawer>
  );
}
