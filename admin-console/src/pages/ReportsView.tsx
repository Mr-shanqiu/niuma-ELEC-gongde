import { useState } from "react";
import { Alert, Button, Card, Descriptions, Empty, Input, Modal, Select, Space, Typography } from "antd";
import { ReloadOutlined } from "@ant-design/icons";
import { useDistributionRead, v2Shapes } from "../ui/api";
import type { ApiError } from "../ui/api";
import { ReadGate } from "../ui/ReadGate";
import { StatusTag, type Tone } from "../ui/StatusTag";
import { isUnauthorized, useSessionActions } from "../ui/session";

/**
 * Website reports.
 *
 * Resolving a report records the investigation and its basis. It does not
 * un-publish anything: the page says so, because "结案" and "已下架" are
 * different events with different audit trails.
 */
type Report = {
  id: string;
  number: string;
  versionId: string | null;
  state: "OPEN" | "RESOLVED";
  category: string;
  description: string;
  evidence: string | null;
  contact: string | null;
  createdAt: string;
  resolvedAt: string | null;
  resolution: string | null;
};
type ReportPage = { items: Report[]; total: number };

const stateMeta: Record<string, { tone: Tone; label: string }> = {
  OPEN: { tone: "warn", label: "待处理" },
  RESOLVED: { tone: "ok", label: "已处理" }
};

const beijingTime = (value: string | null) => {
  if (!value || !Number.isFinite(Date.parse(value))) return "未提供";
  return new Intl.DateTimeFormat("zh-CN", {
    timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23"
  }).format(new Date(value));
};

/** The endpoint accepts these four; offering fewer would hide real rows. */
const filterStates = [
  { value: "OPEN", label: "待处理" },
  { value: "INVESTIGATING", label: "调查中" },
  { value: "RESOLVED", label: "已处理" },
  { value: "DISMISSED", label: "已驳回" }
];

export function ReportsView() {
  const { message, endSession } = useSessionActions();
  const [state, setState] = useState("OPEN");
  const [page, setPage] = useState(1);
  const [selected, setSelected] = useState<Report | null>(null);
  const [reason, setReason] = useState("");
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [writeError, setWriteError] = useState("");

  const list = useDistributionRead<ReportPage>(`/reports?page=${page}&perPage=25&state=${state}`, { expectData: v2Shapes.reportsPage });

  const rows = list.state.status === "ready" ? list.state.data.data.items : [];
  const total = list.state.status === "ready" ? list.state.data.data.total : null;
  const pages = total === null ? 1 : Math.max(1, Math.ceil(total / 25));

  const close = () => {
    setConfirming(false);
    setWriteError("");
    setSelected(null);
    setReason("");
  };

  const resolve = async () => {
    if (!selected || busy) return;
    const text = reason.trim();
    if (text.length < 5 || text.length > 1000) return;
    setBusy(true);
    setWriteError("");
    try {
      const response = await fetch(`/api/gongde/v2/admin/reports/${encodeURIComponent(selected.id)}/resolve`, {
        method: "POST",
        credentials: "same-origin",
        cache: "no-store",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ reason: text })
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) {
        throw Object.assign(new Error(typeof body.message === "string" ? body.message : "处理结果未确认。"), { status: response.status });
      }
      if (body?.data?.ok !== true) {
        // A 200 without the documented confirmation is not a success.
        throw new Error("写入返回状态未确认，请刷新核对，不要重复提交。");
      }
      setConfirming(false);
      setSelected(null);
      setReason("");
      // The list is re-read because the write's effect on the other rows is unknown.
      list.reload();
      message.success("举报处理已由服务端确认，正在重新读取列表。");
    } catch (error) {
      const failure = error as ApiError;
      if (isUnauthorized(failure)) { endSession(); return; }
      setConfirming(false);
      setWriteError(`${failure.message} 请先刷新读取真实状态；不会自动重试写入。`);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="page">
      <div className="page-toolbar">
        <Select
          value={state}
          style={{ width: 140 }}
          aria-label="举报状态"
          disabled={busy}
          onChange={(value) => { setState(value); setPage(1); }}
          options={filterStates}
        />
        <span className="grow" />
        <Button icon={<ReloadOutlined />} onClick={list.reload} disabled={busy}>重新读取</Button>
      </div>

      {writeError ? (
        <Alert type="warning" showIcon message="上一次处理未确认" description={writeError} closable onClose={() => setWriteError("")} />
      ) : null}

      <div className="split">
        <Card className="flat-card" title="举报记录" styles={{ body: { padding: 0 } }}>
          <ReadGate
            state={list.state}
            onRetry={list.reload}
            emptyText="这个状态下没有举报。"
            emptyHint="切换状态可以看已处理或已驳回的记录。"
            skeletonRows={5}
          >
            {(body) => (
              <>
                <div className="report-list">
                  {body.data.items.length === 0 ? (
                    // An empty page and a failed read are different facts, so
                    // this is said in words instead of leaving a blank column.
                    <div className="todo-empty">这个状态下没有举报记录。切换状态可以看已处理或已驳回的记录。</div>
                  ) : null}
                  {body.data.items.map((item) => (
                    <button
                      type="button"
                      key={item.id}
                      className={`report-row${selected?.id === item.id ? " is-active" : ""}`}
                      onClick={() => { setSelected(item); setReason(""); setWriteError(""); }}
                    >
                      <span className="report-number">#{item.number}</span>
                      <span className="report-main">
                        <span>{item.category}</span>
                        <small>{beijingTime(item.createdAt)}</small>
                      </span>
                      <StatusTag tone={stateMeta[item.state]?.tone ?? "warn"}>{stateMeta[item.state]?.label ?? item.state}</StatusTag>
                    </button>
                  ))}
                </div>
                <div className="pager">
                  <Typography.Text type="secondary">共 {body.data.total} 条</Typography.Text>
                  <span className="grow" />
                  <Button size="small" disabled={page === 1 || busy} onClick={() => setPage((value) => value - 1)}>上一页</Button>
                  <span className="pager-page">第 {page} / {pages} 页</span>
                  <Button size="small" disabled={page >= pages || busy} onClick={() => setPage((value) => value + 1)}>下一页</Button>
                </div>
              </>
            )}
          </ReadGate>
        </Card>

        <Card className="flat-card" title="举报详情" styles={{ body: { padding: 18 } }}>
          {!selected ? (
            <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="选择左侧举报，查看编号、原始描述与处理依据。" />
          ) : (
            <>
              <Descriptions column={1} size="small" colon={false} labelStyle={{ width: 88, color: "var(--faint)" }}>
                <Descriptions.Item label="作品编号">#{selected.number}</Descriptions.Item>
                <Descriptions.Item label="状态">
                  <StatusTag tone={stateMeta[selected.state]?.tone ?? "warn"}>{stateMeta[selected.state]?.label ?? selected.state}</StatusTag>
                </Descriptions.Item>
                <Descriptions.Item label="类型">{selected.category}</Descriptions.Item>
                <Descriptions.Item label="提交时间">{beijingTime(selected.createdAt)}</Descriptions.Item>
                <Descriptions.Item label="版本">{selected.versionId ?? "未提供"}</Descriptions.Item>
              </Descriptions>
              <section className="report-section">
                <h4>原始举报描述</h4>
                <p className="report-copy">{selected.description}</p>
              </section>
              <section className="report-section">
                <h4>证据说明（不自动访问链接）</h4>
                <p className="report-copy">{selected.evidence ?? "未提供"}</p>
              </section>
              <section className="report-section">
                <h4>举报人联系方式（仅管理员可见）</h4>
                <p className="report-copy">{selected.contact ?? "未提供"}</p>
              </section>

              {selected.state === "OPEN" ? (
                <>
                  <Alert
                    type="info"
                    showIcon
                    className="inline-alert"
                    message="结案只记录调查结果"
                    description="它不会自动下架作品或暂停账号。需要处置时先在形象管理执行真实操作，再回到这里记录依据。"
                  />
                  <Input.TextArea
                    rows={3}
                    maxLength={1000}
                    showCount
                    value={reason}
                    disabled={busy}
                    onChange={(event) => setReason(event.target.value)}
                    placeholder="调查与处理依据（5 至 1000 字）"
                  />
                  <Button
                    type="primary"
                    className="report-submit"
                    disabled={busy || reason.trim().length < 5}
                    loading={busy}
                    onClick={() => setConfirming(true)}
                  >
                    记录处理结果并结案
                  </Button>
                </>
              ) : (
                <Alert
                  type="info"
                  showIcon
                  className="inline-alert"
                  message={`处理时间 ${beijingTime(selected.resolvedAt)}`}
                  description={selected.resolution ?? "未提供处理依据，请核对审计记录。"}
                />
              )}
              <Typography.Paragraph type="secondary" className="drawer-note">
                不删除原举报，不公开原始证据或联系方式，不回收已经合法下载的离线文件。
              </Typography.Paragraph>
            </>
          )}
        </Card>
      </div>

      <Modal
        open={confirming}
        title="确认结案？"
        okText="确认结案"
        cancelText="取消"
        confirmLoading={busy}
        maskClosable={!busy}
        onCancel={() => { if (!busy) setConfirming(false); }}
        onOk={() => void resolve()}
      >
        {selected ? (
          <Space direction="vertical" size={12} className="fill">
            <Alert
              type="info"
              showIcon
              message={`作品 #${selected.number} 的举报将被标记为已处理`}
              description="结案本身不会暂停账号或下架作品，只记录本次调查与处理依据。"
            />
            <Typography.Text type="secondary">本次依据：{reason.trim()}</Typography.Text>
            {writeError ? <Alert type="error" showIcon message="上次提交未完成" description={writeError} /> : null}
          </Space>
        ) : null}
      </Modal>
    </div>
  );
}
