import { useCallback, useEffect, useMemo, useState } from "react";
import { Alert, Button, Card, Col, DatePicker, Drawer, Input, Modal, Row, Select, Space, Table, Tooltip, Typography } from "antd";
import type { ColumnsType } from "antd/es/table";
import dayjs, { type Dayjs } from "dayjs";
import { CopyOutlined, ReloadOutlined } from "@ant-design/icons";
import { beijingDate, beijingDayRange } from "../Shell";
import { useDistributionRead, v2Shapes } from "../ui/api";
import type { ApiError } from "../ui/api";
import { parseClaimLink, type ClaimLink } from "../ui/claim-link";
import { useServerClock } from "../ui/clock";
import { usable } from "../ui/code-window";
import { ReadGate } from "../ui/ReadGate";
import { StatusTag, type Tone } from "../ui/StatusTag";
import { isUnauthorized, useSessionActions } from "../ui/session";

/**
 * Group code and its claims.
 *
 * Two independent reads: the current code, and the claims of one Beijing day.
 * Either can fail without taking the other down, and neither falls back to a
 * remembered value.
 */
type CodeSnapshot = {
  familyId: string | null;
  revision: number | null;
  kind: "GROUP" | "CREATOR";
  status: "ACTIVE" | "PAUSED" | "INACTIVE";
  code: string | null;
  validFrom: string | null;
  expiresAt: string | null;
  contributionCount: number;
  maxItems: number;
  redemptionEnabled: boolean;
};

type ClaimItem = { number: string; title: string; catalogRevision: string };
type Claim = {
  claimId: string;
  kind: string;
  sourceKind?: string | null;
  state: string;
  items: ClaimItem[];
  bytes: number | null;
  durationMs: number | null;
  error: string | null;
  codeFamilyId: string;
  createdAt: string;
  issuedAt: string | null;
  downloadExpiresAt: string | null;
};
type ClaimsPage = { items: Claim[]; total: number };
type Stats = { readyClaims: number | null; workClaims: number | null; verifiedCodes: number | null };

const claimStates: Record<string, { tone: Tone; label: string }> = {
  CREATED: { tone: "mute", label: "已创建" },
  PREPARING: { tone: "warn", label: "正在准备" },
  READY: { tone: "ok", label: "已就绪" },
  FAILED: { tone: "bad", label: "准备失败" },
  BLOCKED: { tone: "bad", label: "安全阻断" },
  EXPIRED: { tone: "mute", label: "交付已到期" }
};

/**
 * States the server accepts as a filter.
 *
 * `claimStates` keeps CREATED so an old record can still be explained, but the
 * server's `listClaims` rejects it with 400, so it must never be offered here.
 */
const filterStates = (["PREPARING", "READY", "FAILED", "BLOCKED", "EXPIRED"] as const)
  .map((value) => ({ value, label: claimStates[value].label }));

/** Read `#/code?claimId=…&date=…` and keep following it while the page stays mounted. */
function useClaimLink(): ClaimLink {
  const read = () => parseClaimLink(location.hash);
  const [link, setLink] = useState<ClaimLink>(read);
  useEffect(() => {
    const sync = () => setLink(read());
    addEventListener("hashchange", sync);
    return () => removeEventListener("hashchange", sync);
  }, []);
  return link;
}

const beijingTime = (value: string | null) => {
  if (!value || !Number.isFinite(Date.parse(value))) return "未提供";
  return new Intl.DateTimeFormat("zh-CN", {
    timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", hourCycle: "h23"
  }).format(new Date(value));
};

const count = (value: unknown) =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0
    ? value.toLocaleString("zh-CN")
    : "未统计";

/** Mirrors the server rule: a code is usable only inside its own window and while active. */
function announcement(snapshot: CodeSnapshot): string {
  const parts = new Intl.DateTimeFormat("zh-CN", {
    timeZone: "Asia/Shanghai", year: "numeric", month: "numeric", day: "numeric",
    hour: "2-digit", minute: "2-digit", hourCycle: "h23"
  }).formatToParts(new Date(snapshot.expiresAt!));
  const part = (type: Intl.DateTimeFormatPartTypes) => parts.find((item) => item.type === type)?.value ?? "";
  return `权益码：${snapshot.code}\n\n失效时间：${part("year")} 年 ${part("month")} 月 ${part("day")} 日 ${part("hour")}:${part("minute")}\n\n官网链接：https://gongde.zqscreen.cn/\n\n未及时更新请@群主。`;
}

type Action = "pause" | "resume" | "rotate";

const actionCopy: Record<Action, { title: string; ok: string; body: string; danger: boolean }> = {
  rotate: {
    title: "确认立即换码？",
    ok: "确认换码",
    body: "旧码立即失效，不会取消已经创建的合法领取。换码会连同原因与操作人写入审计。",
    danger: true
  },
  pause: {
    title: "确认暂停新领取？",
    ok: "确认暂停",
    body: "暂停后不再接受新的群码领取，已经创建的合法领取不受影响，也不会被追溯取消。",
    danger: true
  },
  resume: {
    title: "确认恢复群码新领取？",
    ok: "确认恢复",
    body: "恢复后当前码立即重新可用于新的领取。已经过期的周期不会因此延长。",
    danger: false
  }
};

export function CodeView() {
  const { message, endSession } = useSessionActions();
  // A link from today's issue list carries the day and the batch it came from;
  // landing on today's unfiltered list would hide the batch that was clicked.
  const link = useClaimLink();
  const [day, setDay] = useState<Dayjs>(() => dayjs(link.date ?? beijingDate(new Date()), "YYYY-MM-DD"));
  const [state, setState] = useState<string | undefined>();
  const [page, setPage] = useState(1);
  const [selected, setSelected] = useState<Claim | null>(null);
  // Cleared by the operator, not by a re-render: after "clear" the page is a
  // normal day view again.
  const [focusClaim, setFocusClaim] = useState<string | null>(link.claimId);

  // Same page, different hash (`#/code?claimId=…`) — the shell only remounts on
  // a nav change, so the query has to be followed here as well. The hash is the
  // whole truth: navigating to plain `#/code` clears a previous focus instead of
  // leaving a stale one on screen. A date the operator picked in the DatePicker
  // is untouched, because that does not change the hash.
  useEffect(() => {
    setDay(dayjs(link.date ?? beijingDate(new Date()), "YYYY-MM-DD"));
    setFocusClaim(link.claimId);
    setPage(1);
  }, [link.date, link.claimId]);

  const code = useDistributionRead<CodeSnapshot>("/group-code", { expectData: v2Shapes.codeSnapshot });
  const range = beijingDayRange(day.format("YYYY-MM-DD"));
  const claimsQuery = useMemo(() => {
    if (!range) return null;
    const query = new URLSearchParams({
      from: range.from, to: range.to, page: String(page), perPage: "25"
    });
    if (state) query.set("state", state);
    if (focusClaim) query.set("claimId", focusClaim);
    return `/claims?${query.toString()}`;
  }, [range, state, page, focusClaim]);
  const claims = useDistributionRead<ClaimsPage>(claimsQuery, { expectData: v2Shapes.claimsPage });
  const stats = useDistributionRead<Stats>(range ? `/stats?from=${encodeURIComponent(range.from)}&to=${encodeURIComponent(range.to)}` : null, { expectData: v2Shapes.stats });

  const serverTime = code.state.status === "ready" ? code.state.data.serverTime : null;
  const snapshot = code.state.status === "ready" ? code.state.data.data : null;
  // The clock wakes at the expiry boundary, not only on its regular tick: a code
  // that expires between ticks must stop looking valid immediately.
  const expiresAt = snapshot?.expiresAt ? Date.parse(snapshot.expiresAt) : NaN;
  const { now } = useServerClock(serverTime, Number.isFinite(expiresAt) ? expiresAt : null);

  // A 401 is a session problem, not a data problem; it is handled once, outside render.
  const unauthorized = (code.state.status === "error" && code.state.unauthorized);
  useEffect(() => { if (unauthorized) endSession(); }, [unauthorized, endSession]);

  const [action, setAction] = useState<Action | null>(null);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState("");

  const openAction = (value: Action) => {
    setActionError("");
    setAction(value);
  };

  const submit = async () => {
    if (!snapshot || snapshot.familyId === null || snapshot.revision === null || !action) return;
    const text = reason.trim();
    if (text.length < 5 || text.length > 1000) return;
    setBusy(true);
    setActionError("");
    try {
      const response = await fetch(
        `/api/gongde/v2/admin/code-families/${encodeURIComponent(snapshot.familyId)}/${action}`,
        {
          method: "POST",
          credentials: "same-origin",
          cache: "no-store",
          headers: { "content-type": "application/json" },
          // The revision travels with the write: a stale tab must conflict
          // rather than silently rotate a code it never saw.
          body: JSON.stringify({ revision: snapshot.revision, reason: text })
        }
      );
      const body = await response.json().catch(() => ({}));
      if (!response.ok) {
        throw Object.assign(new Error(typeof body.message === "string" ? body.message : "变更未确认。"), { status: response.status });
      }
      setAction(null);
      setReason("");
      // The write is confirmed, but the new state is a separate read.
      code.reload();
      message.success("变更已由服务端确认，正在重新读取当前码。");
    } catch (error) {
      const failure = error as ApiError;
      if (failure.status === 401) { endSession(); return; }
      setActionError(`${failure.message ?? "变更结果未确认。"} 请先重新读取最新状态，不要重复提交。`);
    } finally {
      setBusy(false);
    }
  };

  const copy = async (text: string, label: string) => {
    try {
      await navigator.clipboard.writeText(text);
      message.success(`已复制${label}。`);
    } catch {
      message.warning("自动复制失败，请手动选择文本。");
    }
  };

  // `now` is the anchored server clock (see `useServerClock`), or null when the
  // snapshot has not been read — in which case nothing is usable.
  const anchorNow = now ?? Number.NEGATIVE_INFINITY;
  const current = snapshot ? usable(snapshot, anchorNow) : false;
  const remaining = current && snapshot?.expiresAt
    ? Math.ceil((Date.parse(snapshot.expiresAt) - anchorNow) / 1000)
    : 0;
  // `revision !== null` alone is not enough: a response that omits `revision`
  // gives `undefined`, which satisfies `!== null` and would enable the write.
  const revisionReady = Boolean(
    snapshot && typeof snapshot.familyId === "string" && snapshot.familyId.length > 0 &&
    Number.isSafeInteger(snapshot.revision)
  );
  const reasonValid = reason.trim().length >= 5 && reason.trim().length <= 1000;

  const canPause = revisionReady && snapshot?.status === "ACTIVE";
  const canResume = revisionReady && snapshot?.status === "PAUSED";
  const canRotate = revisionReady && snapshot?.status !== "INACTIVE";

  return (
    <div className="page">
      <Card className="flat-card code-card" styles={{ body: { padding: 0 } }}>
        <Row>
          <Col xs={24} lg={14}>
            <div className="code-main">
              <ReadGate state={code.state} onRetry={code.reload} skeletonRows={3}>
                {(body) => {
                  const value = body.data;
                  // Same anchored clock as the side panel: a wrong laptop clock
                  // cannot make an expired code look usable, and time keeps
                  // moving between reads.
                  const live = usable(value, anchorNow);
                  return (
                    <>
                      <Typography.Text type="secondary" className="eyebrow-line">官方群免费领取码</Typography.Text>
                      <div className={`code-value${live ? "" : " is-idle"}`}>
                        {live ? value.code : value.status === "PAUSED" ? "已暂停新领取" : value.status === "INACTIVE" ? "未启用" : "本轮码已到期"}
                      </div>
                      <Space size={8} wrap>
                        <StatusTag tone={live ? "ok" : value.status === "PAUSED" ? "warn" : "mute"} dot>
                          {live ? "当前码有效" : value.status === "PAUSED" ? "已暂停" : value.status === "INACTIVE" ? "未启用" : "当前无有效码"}
                        </StatusTag>
                        <StatusTag tone="mute">GD + 6 位数字 · 三天轮换 · 不区分大小写</StatusTag>
                        {!value.redemptionEnabled ? <StatusTag tone="warn">免费交付尚未开放</StatusTag> : null}
                      </Space>
                      <div className="code-meta">
                        {[
                          ["本周期开始", beijingTime(value.validFrom)],
                          ["轮换边界", beijingTime(value.expiresAt)],
                          ["本轮剩余", live ? `${Math.floor(remaining / 86400)} 天 ${Math.floor((remaining % 86400) / 3600)} 小时 ${Math.floor((remaining % 3600) / 60)} 分` : "不可新领取"],
                          ["修订", value.revision === null ? "未提供" : String(value.revision)]
                        ].map(([label, text]) => (
                          <div key={label}>
                            <span className="code-meta-label">{label}</span>
                            <span className="code-meta-value">{text}</span>
                          </div>
                        ))}
                      </div>
                      <Typography.Text type="secondary" className="code-readat">
                        以服务器北京时间为准 · 最近读取 {beijingTime(body.serverTime)}
                      </Typography.Text>
                    </>
                  );
                }}
              </ReadGate>
            </div>
          </Col>

          <Col xs={24} lg={10}>
            <div className="code-side">
              <Typography.Text strong>发布到官方群</Typography.Text>
              <Typography.Paragraph type="secondary" className="code-side-note">
                复制内容取自服务器当前状态。码不可用时按钮禁用，不会复制旧码。
              </Typography.Paragraph>
              <Space direction="vertical" size={8} className="fill">
                <Button
                  type="primary"
                  block
                  icon={<CopyOutlined />}
                  disabled={!current}
                  onClick={() => snapshot?.code && copy(snapshot.code, "当前码")}
                >
                  复制当前码
                </Button>
                <Tooltip title={snapshot?.redemptionEnabled ? "" : "免费交付未开放时不复制公告，避免发出不能领取的码"}>
                  <Button
                    block
                    disabled={!current || !snapshot?.redemptionEnabled}
                    onClick={() => snapshot && copy(announcement(snapshot), "群置顶公告")}
                  >
                    复制群置顶公告
                  </Button>
                </Tooltip>
              </Space>

              <div className="code-divider" />
              <Typography.Text strong>变更需要填写原因</Typography.Text>
              <Typography.Paragraph type="secondary" className="code-side-note">
                原因 5 至 1000 字，连同当前修订号一起提交；记录已被他人修改时请求会失败，不会覆盖。
              </Typography.Paragraph>
              <Input.TextArea
                rows={2}
                maxLength={1000}
                showCount
                placeholder="原因（5 至 1000 字）"
                value={reason}
                disabled={busy}
                onChange={(event) => setReason(event.target.value)}
              />
              <Space wrap size={8} className="code-actions">
                <Button danger disabled={!canPause || !reasonValid || busy} onClick={() => openAction("pause")}>暂停新领取</Button>
                <Button disabled={!canResume || !reasonValid || busy} onClick={() => openAction("resume")}>恢复群码</Button>
                <Button danger type="primary" ghost disabled={!canRotate || !reasonValid || busy} onClick={() => openAction("rotate")}>
                  立即换码
                </Button>
              </Space>
              {/*
                Two different reasons the buttons are off. "No code family" is
                the server's own state; "revision not read" is a failed read.
                Saying the first one as the second would send the operator to
                reload a page that is already correct.
              */}
              {snapshot && snapshot.familyId === null ? (
                <Alert
                  type="info"
                  showIcon
                  className="code-warning"
                  message="当前没有生效的群码"
                  description="服务端返回的群码状态为未启用，因此没有可暂停或轮换的对象。启用流程不在本管理台。"
                />
              ) : !revisionReady && code.state.status !== "loading" ? (
                <Alert type="warning" showIcon className="code-warning" message="当前修订号未读取，已禁用变更" description="变更必须携带修订号。刷新成功后再操作。" />
              ) : null}
            </div>
          </Col>
        </Row>
      </Card>

      <Card
        className="flat-card"
        title={focusClaim ? "定位到的领取批次" : "当日领取批次"}
        extra={<Typography.Text type="secondary" className="card-extra">{day.format("YYYY-MM-DD")} · 北京时间一天</Typography.Text>}
        styles={{ body: { padding: 0 } }}
      >
        <div className="panel-toolbar">
          <DatePicker
            value={day}
            allowClear={false}
            onChange={(value) => { if (value) { setDay(value); setPage(1); } }}
            aria-label="选择北京时间日期"
          />
          <Select
            allowClear
            placeholder="全部状态"
            style={{ width: 150 }}
            value={state}
            onChange={(value) => { setState(value); setPage(1); }}
            options={filterStates}
          />
          <Button icon={<ReloadOutlined />} onClick={() => { claims.reload(); stats.reload(); }}>重新读取</Button>
          <span className="grow" />
          {focusClaim ? (
            <Button
              size="small"
              type="text"
              onClick={() => {
                // The hash stays the source of truth: clearing only the local
                // state would leave a link that re-focuses on reload.
                setFocusClaim(null);
                setPage(1);
                if (location.hash.includes("?")) history.replaceState(null, "", "#/code");
              }}
            >
              取消定位，查看当天全部批次
            </Button>
          ) : null}
          <span className="mini-stats">
            <span>有效批次 {stats.state.status === "ready" ? count(stats.state.data.data.readyClaims) : "未读取"}</span>
            <span className="sep">·</span>
            <span>作品领取 {stats.state.status === "ready" ? count(stats.state.data.data.workClaims) : "未读取"}</span>
            <span className="sep">·</span>
            <span>验码成功 {stats.state.status === "ready" ? count(stats.state.data.data.verifiedCodes) : "未读取"}</span>
          </span>
        </div>

        {stats.state.status === "error" ? (
          <Alert type="warning" showIcon className="inline-alert" message="当日统计未读取" description="上方批次列表是另一个请求，仍按真实记录展示。" />
        ) : null}

        <ReadGate
          state={claims.state}
          onRetry={claims.reload}
          emptyText="所选日期没有领取记录。"
          emptyHint="换一天或取消状态筛选再看。"
          skeletonRows={5}
        >
          {(body) => (
            <>
              <Table<Claim>
                rowKey="claimId"
                size="middle"
                dataSource={body.data.items}
                pagination={false}
                scroll={{ x: 880 }}
                columns={claimColumns((claim) => setSelected(claim))}
              />
              <div className="pager">
                <Typography.Text type="secondary">
                  空结果不等于读取失败；下载次数不在本页统计，见「今日运营」。
                </Typography.Text>
                <span className="grow" />
                <Button size="small" disabled={page === 1} onClick={() => setPage((value) => value - 1)}>上一页</Button>
                <span className="pager-page">第 {page} / {Math.max(1, Math.ceil(body.data.total / 25))} 页 · 共 {body.data.total} 条</span>
                <Button size="small" disabled={page * 25 >= body.data.total} onClick={() => setPage((value) => value + 1)}>下一页</Button>
              </div>
            </>
          )}
        </ReadGate>
      </Card>

      <Modal
        open={action !== null}
        title={action ? actionCopy[action].title : ""}
        okText={action ? actionCopy[action].ok : "确认"}
        okButtonProps={{ danger: action ? actionCopy[action].danger : false, loading: busy }}
        cancelText="取消"
        confirmLoading={busy}
        maskClosable={!busy}
        onCancel={() => { if (!busy) { setAction(null); setActionError(""); } }}
        onOk={() => void submit()}
      >
        {action ? (
          <Space direction="vertical" size={12} className="fill">
            <Alert type={actionCopy[action].danger ? "warning" : "info"} showIcon message={actionCopy[action].body} />
            <Typography.Text type="secondary">本次原因：{reason.trim() || "（未填写）"}</Typography.Text>
            <Typography.Text type="secondary">
              提交时使用当前修订 {snapshot?.revision ?? "未读取"}；失败会保留本对话框和你填写的原因。
            </Typography.Text>
            {actionError ? <Alert type="error" showIcon message="变更未完成" description={actionError} /> : null}
          </Space>
        ) : null}
      </Modal>

      <Drawer
        open={selected !== null}
        onClose={() => setSelected(null)}
        width={520}
        title={selected ? `批次 ${selected.claimId.slice(0, 8)}…${selected.claimId.slice(-4)}` : ""}
      >
        {selected ? (
          <div className="drawer-stack">
            <Space size={8} wrap>
              <StatusTag tone={claimStates[selected.state]?.tone ?? "warn"}>{claimStates[selected.state]?.label ?? selected.state}</StatusTag>
              <StatusTag tone="mute">{selected.kind === "GROUP" ? "官方群码" : "旧来源记录（已停用）"}</StatusTag>
            </Space>
            <Typography.Text type="secondary" className="wrap-anywhere">
              来源 family：{selected.codeFamilyId}（领取时冻结，不随换码改写）
            </Typography.Text>
            <Typography.Text>
              签发 {beijingTime(selected.issuedAt)} · 原记录交付截止 {beijingTime(selected.downloadExpiresAt)}
            </Typography.Text>
            <Typography.Text type="secondary">
              大小 / 耗时：{typeof selected.bytes === "number" ? `${(selected.bytes / 1048576).toFixed(2)} MiB` : "未提供"}
              {" / "}
              {typeof selected.durationMs === "number" ? `${selected.durationMs} ms` : "未提供"}
            </Typography.Text>
            {selected.error ? <Alert type="warning" showIcon message={selected.error} /> : null}
            <Table<ClaimItem>
              size="small"
              pagination={false}
              rowKey="number"
              dataSource={selected.items}
              columns={[
                { title: "编号", dataIndex: "number", width: 90 },
                { title: "名称", dataIndex: "title" },
                { title: "冻结 catalogRevision", dataIndex: "catalogRevision", render: (value: string) => <span className="mono">{value}</span> }
              ]}
            />
            <Alert
              type="info"
              showIcon
              message="截止时间只展示原始运营记录"
              description="不授予七天免费重下或历史订单找回权限。以后重新发起下载须重新付费或使用当期有效官方群码。此列表只读，不生成新订单或收费。"
            />
          </div>
        ) : null}
      </Drawer>
    </div>
  );
}

function claimColumns(onView: (claim: Claim) => void): ColumnsType<Claim> {
  return [
    {
      title: "批次",
      dataIndex: "claimId",
      render: (value: string) => (
        <Typography.Text copyable={{ text: value }} className="mono">
          {value.slice(0, 8)}…{value.slice(-4)}
        </Typography.Text>
      )
    },
    {
      title: "来源",
      dataIndex: "kind",
      render: (value: string) => (value === "GROUP" ? "官方群码" : "旧来源记录（已停用）")
    },
    {
      title: "状态",
      dataIndex: "state",
      render: (value: string) => {
        const meta = claimStates[value];
        return meta ? <StatusTag tone={meta.tone}>{meta.label}</StatusTag> : <StatusTag tone="warn">未确认状态</StatusTag>;
      }
    },
    { title: "形象数", dataIndex: "items", align: "right", render: (value: ClaimItem[]) => value.length },
    {
      title: "大小 / 耗时",
      key: "size",
      align: "right",
      render: (_: unknown, record: Claim) =>
        `${typeof record.bytes === "number" ? `${(record.bytes / 1048576).toFixed(2)} MiB` : "未提供"} / ${
          typeof record.durationMs === "number" ? `${record.durationMs} ms` : "未提供"}`
    },
    { title: "创建时间", dataIndex: "createdAt", render: (value: string) => beijingTime(value) },
    { title: "交付截止", dataIndex: "downloadExpiresAt", render: (value: string | null) => beijingTime(value) },
    {
      title: "",
      key: "action",
      align: "right",
      render: (_: unknown, record: Claim) => <Button size="small" onClick={() => onView(record)}>查看</Button>
    }
  ];
}
