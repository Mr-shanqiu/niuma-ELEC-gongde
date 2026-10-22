import { useCallback, useEffect, useMemo, useState } from "react";
import { Alert, Button, Card, Descriptions, Drawer, Empty, Input, Modal, Segmented, Space, Tooltip, Typography } from "antd";
import { SearchOutlined } from "@ant-design/icons";
import { ApiError, api, distributionApi, isSafetyEntry, patch, remove, shapes, useRead } from "../ui/api";
import { StatusTag, type Tone } from "../ui/StatusTag";
import { isUnauthorized, useSessionActions } from "../ui/session";
import { usePreviewIndex } from "../ui/preview";

/**
 * Appearances: the gallery, publishing, and the three safety/file operations.
 *
 * Four writes live here and each has its own version:
 *
 *   - 上架/下架      carries `publicationRevision`, which versions the whole
 *                    published set (not the material `revision` on a row).
 *   - 安全停发/解除   carries the safety object's own `revision`, protected by a
 *                    row lock on the server.
 *   - 独立文件      upload/delete by exact name; not tied to publishing.
 *   - 编号查询       read-only.
 *
 * A conflict never auto-replays: the page keeps what the operator chose, says
 * the server changed underneath, and asks for a re-read. That is the only
 * behaviour that cannot double-apply a write whose outcome is unknown.
 */
type Appearance = {
  id: string;
  assetId: string;
  appearanceNumber: string | null;
  name: string;
  revision: string | null;
  state: "PUBLISHED" | "UNPUBLISHED" | "MISSING";
};
type AppearanceList = { data: Appearance[]; total: number; publicationRevision: number };

type Safety = {
  assetId: string;
  blocked: boolean;
  revision: number;
  reason: string | null;
  updatedBy: string | null;
  updatedAt: string | null;
};

type AdminFile = {
  id: string;
  name: string;
  kind: "appearance" | "installer";
  size: number;
  lastModified: string | null;
  url: string;
};

type NumberResult = {
  appearanceNumber: string;
  titleZh: string;
  sourceKind: "official" | "community";
  state: string;
  internalId: string;
  sharePath: string | null;
};

const stateMeta: Record<Appearance["state"], { tone: Tone; label: string; hint: string }> = {
  PUBLISHED: { tone: "ok", label: "已上架", hint: "在首页图库中，可被新领取选中" },
  UNPUBLISHED: { tone: "mute", label: "已下架", hint: "不在首页图库，已创建的批次不受影响" },
  MISSING: { tone: "bad", label: "资源缺失", hint: "服务端没有这个形象的素材修订号" }
};

const beijingTime = (value: string | null) => {
  if (!value || !Number.isFinite(Date.parse(value))) return "未提供";
  return new Intl.DateTimeFormat("zh-CN", {
    timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23"
  }).format(new Date(value));
};

const fileSize = (bytes: number) =>
  bytes >= 1048576 ? `${(bytes / 1048576).toFixed(2)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`;

export function AppearancesView() {
  const previews = usePreviewIndex();
  const { message, endSession } = useSessionActions();
  const [filter, setFilter] = useState<string>("all");
  const [query, setQuery] = useState("");
  const [detail, setDetail] = useState<Appearance | null>(null);
  // Both children start a read on mount and keep it in `useCallback`; an inline
  // handler would be a new function on every render, so every render would
  // restart the read. Caught in the browser walkthrough: each click re-fetched
  // the safety list and the file list several times.
  const handleUnauthorized = useCallback(() => endSession(), [endSession]);

  const list = useRead<AppearanceList>("/appearances", { expect: shapes.appearances });
  // A re-read replaces the whole list state with `loading`. Keeping the last
  // read on screen means the grid, the safety panel and the file list are not
  // unmounted by a write — otherwise every publish dropped the operator's
  // safety selection and repainted the gallery as skeletons.
  const [snapshot, setSnapshot] = useState<AppearanceList | null>(null);
  useEffect(() => {
    if (list.state.status === "ready" || list.state.status === "empty") setSnapshot(list.state.data);
  }, [list.state]);

  const items = snapshot?.data ?? [];
  // The publication revision is only usable when the list itself was read; a
  // write built from a remembered value would be exactly the stale write this
  // version exists to stop. A stale `snapshot` is display-only.
  const publicationRevision = list.state.status === "ready" ? list.state.data.publicationRevision : null;
  const counts = useMemo(() => ({
    all: items.length,
    PUBLISHED: items.filter((item) => item.state === "PUBLISHED").length,
    UNPUBLISHED: items.filter((item) => item.state === "UNPUBLISHED").length,
    MISSING: items.filter((item) => item.state === "MISSING").length
  }), [items]);

  const rows = useMemo(() => {
    const text = query.trim();
    return items.filter((item) => {
      const matchState = filter === "all" || item.state === filter;
      const matchText = !text || item.name.includes(text) || (item.appearanceNumber ?? "").includes(text) || item.assetId.includes(text);
      return matchState && matchText;
    });
  }, [items, filter, query]);

  const unread = list.state.status === "error";

  /* ------------------------------------------------------------ publishing */

  const [pending, setPending] = useState<Appearance | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [publishError, setPublishError] = useState("");
  const [republish, setRepublish] = useState(false);

  const openPublish = (item: Appearance) => {
    setPublishError("");
    setRepublish(false);
    setPending(item);
  };

  // The only way out of a conflict: read the version again and reopen. It never
  // resends the refused write, and if the read fails the page cannot build a
  // write at all, because `publicationRevision` comes from a ready read only.
  const reloadAfterConflict = () => {
    setRepublish(false);
    setPending(null);
    list.reload();
  };

  // The gallery row is re-read after a write, so a reopen uses fresh state.
  useEffect(() => {
    if (!detail) return;
    const current = items.find((item) => item.assetId === detail.assetId);
    if (current && current !== detail) setDetail(current);
  }, [items, detail]);

  const submitPublish = async () => {
    const target = pending;
    // One write at a time per row, and never a second while one is unresolved.
    if (!target || busyId !== null || publicationRevision === null) return;
    const published = target.state !== "PUBLISHED";
    setBusyId(target.assetId);
    setPublishError("");
    try {
      const body = await patch<{ data: Appearance; publicationRevision: number }>(
        `/appearances/${encodeURIComponent(target.assetId)}`,
        { published, publicationRevision }
      );
      if (!Number.isSafeInteger(body.publicationRevision) || body.data?.state === undefined) {
        throw new Error("写入返回状态未确认，请重新读取核对，不要重复提交。");
      }
      setPending(null);
      message.success(body.data.state === "PUBLISHED" ? "已上架，服务端已确认。" : "已下架，服务端已确认。");
      // The new state is a separate read, not something the page infers.
      list.reload();
    } catch (error) {
      const failure = error as ApiError;
      if (isUnauthorized(failure)) { endSession(); return; }
      setPublishError(failure.message);
      // A conflict may already have refreshed the version; offering a reload is
      // the honest move, retrying the same write is not.
      if (failure.status === 409) setRepublish(true);
    } finally {
      setBusyId(null);
    }
  };

  return (
    <div className="page">
      <div className="page-toolbar">
        <Input
          allowClear
          prefix={<SearchOutlined />}
          placeholder="搜索名称、编号或资产 ID"
          style={{ width: 260 }}
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />
        <Segmented
          value={filter}
          disabled={unread}
          onChange={(value) => setFilter(String(value))}
          options={unread
            ? [{ value: "all", label: "计数未读取" }]
            : [
                { value: "all", label: `全部 ${counts.all}` },
                { value: "PUBLISHED", label: `已上架 ${counts.PUBLISHED}` },
                { value: "UNPUBLISHED", label: `已下架 ${counts.UNPUBLISHED}` },
                { value: "MISSING", label: `资源缺失 ${counts.MISSING}` }
              ]}
        />
        <span className="grow" />
        <Button onClick={list.reload}>重新读取</Button>
      </div>

      <Alert
        type="info"
        showIcon
        className="inline-alert"
        message="上下架只改变官网图库"
        description="不会回收已领取的批次，也不会延长或重新签发版本。安全停发是另一件事，见列表下方。"
      />

      {publishError ? (
        <Alert
          type="warning"
          showIcon
          message="上一次上下架未确认"
          description={publishError}
          action={republish ? <Button size="small" onClick={reloadAfterConflict}>重新读取</Button> : undefined}
          closable
          onClose={() => setPublishError("")}
        />
      ) : null}

      {list.state.status === "error" ? (
        <Alert
          type={list.state.unauthorized ? "warning" : "error"}
          showIcon
          message={list.state.unauthorized ? "会话已过期，形象列表未读取" : "形象列表未读取"}
          description={`${list.state.message} 未知状态不会被画成「已下架」，筛选计数也不显示 0。`}
          action={list.state.unauthorized ? undefined : <Button size="small" onClick={list.reload}>重试</Button>}
        />
      ) : snapshot === null ? (
        <div className="face-grid">
          {Array.from({ length: 8 }, (_, index) => (
            <div className="face-card" key={index} aria-hidden="true">
              <div className="face-figure-placeholder" />
              <div className="face-body">
                <div className="skeleton-line" style={{ width: "62%" }} />
                <div className="skeleton-line" style={{ width: "84%", marginTop: 6 }} />
              </div>
            </div>
          ))}
        </div>
      ) : rows.length === 0 ? (
        <div className="face-list">
          <Empty description={query.trim()
            ? `没有匹配「${query.trim()}」的形象。`
            : "这个筛选下确实没有形象，不是读取失败。"} />
        </div>
      ) : (
        <div className="face-grid">
          {rows.map((item) => (
            <FaceCard
              key={item.assetId}
              item={item}
              slug={previews.byAsset.get(item.assetId) ?? null}
              busy={busyId === item.assetId}
              canPublish={publicationRevision !== null && busyId === null}
              onOpen={() => setDetail(item)}
              onPublish={() => openPublish(item)}
            />
          ))}
        </div>
      )}

      {snapshot !== null && list.state.status !== "error" ? (
        <SafetyZone
          items={items}
          onChanged={list.reload}
          onUnauthorized={handleUnauthorized}
        />
      ) : null}

      <FileManager onUnauthorized={handleUnauthorized} />

      <NumberLookup />

      <Drawer
        open={detail !== null}
        onClose={() => setDetail(null)}
        width={520}
        title={detail ? `${detail.name} · #${detail.appearanceNumber ?? "未分配"}` : ""}
      >
        {detail ? (
          <div className="drawer-stack">
            <div className="preview-stage">
              <PackPreview slug={previews.byAsset.get(detail.assetId) ?? null} name={detail.name} size={300} height={210} />
            </div>
            <Descriptions column={1} size="small" colon={false} labelStyle={{ width: 96, color: "var(--faint)" }}>
              <Descriptions.Item label="发布状态">
                {stateMeta[detail.state]
                  ? <StatusTag tone={stateMeta[detail.state].tone}>{stateMeta[detail.state].label}</StatusTag>
                  : <span className="mono">{detail.state}（未识别的状态）</span>}
              </Descriptions.Item>
              <Descriptions.Item label="状态含义">
                {stateMeta[detail.state]?.hint ?? "服务端返回了本页没有定义的发布状态，不按已上架或已下架解释。"}
              </Descriptions.Item>
              <Descriptions.Item label="形象编号">#{detail.appearanceNumber ?? "未分配"}</Descriptions.Item>
              <Descriptions.Item label="素材修订">{detail.revision ?? "无（资源缺失）"}</Descriptions.Item>
              <Descriptions.Item label="资产 ID"><span className="mono">{detail.assetId}</span></Descriptions.Item>
              <Descriptions.Item label="预览目录">
                <span className="mono">
                  {previews.byAsset.get(detail.assetId)
                    ? `/assets/previews/packs/${previews.byAsset.get(detail.assetId)}/`
                    : previews.state.status === "error" ? "预览索引未读取" : "不在官网公开预览索引中"}
                </span>
              </Descriptions.Item>
            </Descriptions>
            <Alert
              type="info"
              showIcon
              message="预览失败不等于资源缺失"
              description="这里播放的是官网同源的公开预览素材。它加载失败只说明这一屏没取到素材；资源是否存在只看上面的「素材修订」与发布状态。"
            />
            <Alert
              type="info"
              showIcon
              message="「修订」是素材版本，不是发布状态版本"
              description="它随素材内容变化，不随上下架变化。上下架使用的是另一个整体版本号，两者不能互用。"
            />
            <Button
              onClick={() => { setDetail(null); openPublish(detail); }}
              disabled={detail.state === "MISSING" || publicationRevision === null || busyId !== null}
            >
              {detail.state === "PUBLISHED" ? "下架这个形象" : "上架这个形象"}
            </Button>
          </div>
        ) : null}
      </Drawer>

      <Modal
        open={pending !== null}
        title={pending?.state === "PUBLISHED" ? "确认下架？" : "确认上架？"}
        okText={pending?.state === "PUBLISHED" ? "确认下架" : "确认上架"}
        cancelText="取消"
        confirmLoading={busyId !== null}
        // After a conflict the version in this dialog is known to be stale, so
        // the confirm button stops being a way to send the same rejected write
        // again. The operator has to reload and reopen.
        okButtonProps={{ disabled: republish }}
        maskClosable={busyId === null}
        onCancel={() => { if (busyId === null) { setPending(null); setPublishError(""); } }}
        onOk={() => void submitPublish()}
      >
        {pending ? (
          <div className="stack-10">
            <p>
              <strong>{pending.name}</strong>
              <span className="mono"> · {pending.assetId}</span>
            </p>
            {pending.state === "PUBLISHED" ? (
              <p>下架后它不再出现在官网图库，也不会被新领取选中。
                <strong>已经领取的批次不受影响</strong>，已下载的离线文件不会被回收。</p>
            ) : (
              <p>上架后它出现在官网图库，可被新领取选中。上架不改变它的素材修订，也不代表已通过安全审查。</p>
            )}
            <p className="drawer-note">
              发布状态版本 {publicationRevision ?? "未读取"}。另一位管理员若在此期间改过发布状态，这次提交会被拒绝，而不是覆盖对方的修改。
            </p>
            {publishError ? (
              <Alert
                type="warning"
                showIcon
                message={publishError}
                action={republish
                  ? <Button size="small" onClick={reloadAfterConflict}>重新读取</Button>
                  : undefined}
              />
            ) : null}
            {republish ? (
              <p className="drawer-note">
                这个对话框里的发布状态版本已经不是服务端当前的版本，所以「确认」已停用。
                点击「重新读取」获取新版本后，再针对最新状态重新确认；本页不会自动重放这次提交。
              </p>
            ) : null}
          </div>
        ) : null}
      </Modal>
    </div>
  );
}

function FaceCard({ item, slug, busy, canPublish, onOpen, onPublish }: {
  item: Appearance;
  slug: string | null;
  busy: boolean;
  canPublish: boolean;
  onOpen: () => void;
  onPublish: () => void;
}) {
  const missing = item.state === "MISSING";
  return (
    <div className={`face-card${missing ? " is-missing" : ""}${item.state === "UNPUBLISHED" ? " is-unpublished" : ""}`}>
      <button type="button" className="face-figure" onClick={onOpen} aria-label={`查看 ${item.name} 的详情与动作预览`}>
        <span className="face-state">
          <StatusTag tone={stateMeta[item.state].tone}>{stateMeta[item.state].label}</StatusTag>
        </span>
        <PackPreview slug={slug} name={item.name} size={150} />
      </button>
      <div className="face-body">
        <div className="face-title">
          <button type="button" className="face-name" onClick={onOpen}>{item.name}</button>
          <span className="face-number">#{item.appearanceNumber ?? "未分配"}</span>
        </div>
        <div className="face-meta">
          <span>{item.revision ? `修订 ${item.revision.slice(0, 8)}` : "无修订"}</span>
          <span className="sep">·</span>
          <code>{item.assetId}</code>
        </div>
      </div>
      <div className="face-actions">
        <span className="grow" />
        <Button size="small" type="text" onClick={onOpen}>详情</Button>
        {/* A MISSING row has no material to publish, so the action is absent
            rather than present-and-failing. The server enforces the same rule. */}
        <Tooltip title={missing
          ? "没有素材修订，不能上架"
          : !canPublish ? "发布状态或列表尚未读取，暂不可写入" : undefined}>
          <Button
            size="small"
            type="text"
            className={`face-action${item.state === "PUBLISHED" ? " is-danger" : ""}`}
            disabled={missing || !canPublish}
            loading={busy}
            onClick={onPublish}
          >
            {item.state === "PUBLISHED" ? "下架" : "上架"}
          </Button>
        </Tooltip>
      </div>
    </div>
  );
}

/**
 * Safety suspension: separate object, separate revision, separate consequence.
 *
 * Un-publishing removes an appearance from the gallery; safety suspension blocks
 * re-downloads of every frozen batch containing it. They are not the same action
 * and their revisions cannot be swapped, so this block reads and writes
 * `/official-safety` and never touches the publication revision.
 */
function SafetyZone({ items, onChanged, onUnauthorized }: {
  items: Appearance[];
  onChanged: () => void;
  onUnauthorized: () => void;
}) {
  const { message } = useSessionActions();
  const [selectedId, setSelectedId] = useState<string>("");
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [confirming, setConfirming] = useState(false);
  const [states, setStates] = useState<Record<string, Safety> | null>(null);
  const [readError, setReadError] = useState("");

  const loadSafety = useCallback(async () => {
    setReadError("");
    setStates(null);
    try {
      const body = await distributionApi<{ items: Safety[]; total: number }>("/official-safety");
      // The endpoint answers `{ items, total }`. A `total` that disagrees with the
      // rows received is a partial read, and a partial safety list must not be
      // rendered as "nothing is suspended".
      if (!body.data || !Array.isArray(body.data.items) || !body.data.items.every(isSafetyEntry) ||
        body.data.total !== body.data.items.length) {
        throw new Error("官方安全状态列表未确认，未按「未停发」显示。");
      }
      setStates(Object.fromEntries(body.data.items.map((entry) => [entry.assetId, entry])));
    } catch (failure) {
      if (isUnauthorized(failure)) { onUnauthorized(); return; }
      setReadError(failure instanceof Error ? failure.message : "安全状态读取失败。");
    }
  }, [onUnauthorized]);

  useEffect(() => { void loadSafety(); }, [loadSafety]);

  const selected = selectedId ? states?.[selectedId] ?? null : null;
  const reasonLength = Array.from(reason.trim()).length;
  const reasonValid = reasonLength >= 5 && reasonLength <= 1000;
  const change = selected?.blocked ? "unblock" : "block";

  const submit = async () => {
    if (!selected || busy) return;
    setBusy(true);
    setError("");
    try {
      // The v2 router answers `{ data, serverTime }`. Reading the envelope as if
      // it were the row would make a successful write look unconfirmed, so the
      // unwrapping stays in `distributionApi` for writes as well as reads.
      const body = await distributionApi<Safety>(`/official-safety/${encodeURIComponent(selected.assetId)}/${change}`, {
        method: "POST",
        body: JSON.stringify({
          // The safety object's own revision. Using the publication revision here
          // would be accepted by the shape check and rejected by the server — or
          // worse, coincidentally pass and skip the real check.
          requireCurrentRevision: selected.revision,
          reason: reason.trim()
        })
      });
      const updated = body.data;
      if (!updated || updated.assetId !== selected.assetId || !isSafetyEntry(updated) ||
        updated.blocked !== (change === "block") || updated.revision <= selected.revision) {
        throw new Error("写入结果未确认，请重新读取核对，不要重复提交。");
      }
      setConfirming(false);
      setReason("");
      message.success(change === "block" ? "已安全停发，服务端已确认。" : "已解除停发，服务端已确认。");
      await loadSafety();
      onChanged();
    } catch (failure) {
      if (isUnauthorized(failure)) { onUnauthorized(); return; }
      setConfirming(false);
      setError(`${(failure as Error).message} 请先重新读取安全状态；不会自动重试。`);
      // A conflict means the revision moved; the panel is no longer trustworthy.
      if ((failure as ApiError).status === 409) await loadSafety();
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="safety-zone">
      <div className="safety-head">
        <span className="safety-title">安全停发 / 解除</span>
        <span className="file-meta">与上下架分开：停发会阻断整批重下载，不回收已下载的文件</span>
        <span className="grow" />
        <Button size="small" onClick={() => void loadSafety()}>刷新安全状态</Button>
      </div>

      {readError ? (
        <Alert
          type="error"
          showIcon
          className="inline-alert"
          message="安全状态未读取"
          description={`${readError} 这里不能显示「未停发」——那会把读取失败说成安全。`}
          action={<Button size="small" onClick={() => void loadSafety()}>重试</Button>}
        />
      ) : null}

      {error ? <Alert type="warning" showIcon className="inline-alert" message="上一次安全操作未确认" description={error} closable onClose={() => setError("")} /> : null}

      <Space wrap className="safety-actions">
        <select
          className="safety-reason"
          aria-label="选择官方形象"
          value={selectedId}
          disabled={busy || states === null}
          onChange={(event) => { setSelectedId(event.target.value); setReason(""); }}
          style={{ minWidth: 260, padding: "5px 8px", borderRadius: 8 }}
        >
          <option value="">选择官方形象</option>
          {items.map((item) => (
            <option key={item.assetId} value={item.assetId}>
              {item.appearanceNumber ? `#${item.appearanceNumber} · ` : ""}{item.name}
            </option>
          ))}
        </select>
      </Space>

      {selectedId && states !== null && !selected ? (
        <div className="safety-state">
          该形象的安全状态未确认，无法操作。
        </div>
      ) : selected ? (
        <>
          <div className="safety-state">
            <StatusTag tone={selected.blocked ? "bad" : "mute"}>{selected.blocked ? "已安全停发" : "未安全停发"}</StatusTag>
            <span>安全修订 {selected.revision}</span>
            <span>处理人 {selected.updatedBy ?? "无"}</span>
            <span>更新 {beijingTime(selected.updatedAt)}</span>
          </div>
          <div className="safety-state">原处理原因：{selected.reason ?? "尚无安全停发记录"}</div>
          <Input.TextArea
            className="safety-reason"
            rows={2}
            maxLength={1000}
            showCount
            value={reason}
            disabled={busy}
            onChange={(event) => setReason(event.target.value)}
            placeholder="本次安全操作原因（5 至 1000 字）"
          />
          <Space wrap className="safety-actions">
            <Button
              danger
              size="small"
              disabled={selected.blocked || !reasonValid || busy}
              onClick={() => setConfirming(true)}
            >
              安全停发，阻断重下载
            </Button>
            <Button
              size="small"
              disabled={!selected.blocked || !reasonValid || busy}
              onClick={() => setConfirming(true)}
            >
              解除停发
            </Button>
          </Space>
        </>
      ) : null}

      <Modal
        open={confirming}
        title={change === "block" ? "确认安全停发？" : "确认解除停发？"}
        okText={change === "block" ? "确认停发" : "确认解除"}
        cancelText="取消"
        confirmLoading={busy}
        maskClosable={!busy}
        onCancel={() => { if (!busy) setConfirming(false); }}
        onOk={() => void submit()}
      >
        {selected ? (
          <div className="stack-10">
            <p><strong>{items.find((item) => item.assetId === selected.assetId)?.name ?? selected.assetId}</strong></p>
            {change === "block" ? (
              <p>停发后停止新领取，并阻断包含它的旧批次重下载。<strong>已下载的离线文件不会回收</strong>，也不会重新签发版本。</p>
            ) : (
              <p>解除后旧批次重下时仍须全部条目安全且在原重下载窗口内。不会延长期限，也不重新签发版本。</p>
            )}
            <p className="drawer-note">安全修订 {selected.revision}。若在此期间被其他人改动，这次提交会被拒绝。</p>
            <p>原因：{reason.trim()}</p>
          </div>
        ) : null}
      </Modal>
    </section>
  );
}

/**
 * Separate upload files.
 *
 * A file here is not a signed appearance: deleting one does not un-publish
 * anything, and uploading one does not publish anything. Installers are refused
 * by the server because their retention conditions are not decided here.
 */
function FileManager({ onUnauthorized }: { onUnauthorized: () => void }) {
  const { message } = useSessionActions();
  const [files, setFiles] = useState<AdminFile[] | null>(null);
  // A read failure and a write failure are different facts. Sharing one string
  // made a failed list read render "读取中" forever and label it 文件操作未确认.
  const [readError, setReadError] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [removing, setRemoving] = useState<AdminFile | null>(null);

  const load = useCallback(async () => {
    setReadError("");
    setFiles(null);
    try {
      const body = await api<{ data: AdminFile[]; total?: number }>("/files?kind=appearance");
      if (!Array.isArray(body.data) || !body.data.every((entry) => entry && typeof entry.name === "string")) {
        throw new Error("文件列表未确认，未按「没有文件」显示。");
      }
      setFiles(body.data);
    } catch (failure) {
      if (isUnauthorized(failure)) { onUnauthorized(); return; }
      setReadError(failure instanceof Error ? failure.message : "文件列表读取失败。");
    }
  }, [onUnauthorized]);

  useEffect(() => { void load(); }, [load]);

  const upload = async (file: File) => {
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      const response = await fetch(`/api/gongde/admin/files?kind=appearance&name=${encodeURIComponent(file.name)}`, {
        method: "POST",
        credentials: "same-origin",
        headers: { "content-type": "application/zip" },
        body: file
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) {
        throw Object.assign(new Error(typeof body?.error === "string" ? body.error : "上传未确认。"), { status: response.status });
      }
      message.success(`已上传 ${file.name}。上传不会自动上架。`);
      await load();
    } catch (failure) {
      if (isUnauthorized(failure)) { onUnauthorized(); return; }
      setError(`${(failure as Error).message} 上传结果未确认时不要重复提交，请先看下面的列表。`);
      await load();
    } finally {
      setBusy(false);
    }
  };

  const removeFile = async () => {
    if (!removing || busy) return;
    setBusy(true);
    setError("");
    try {
      await remove(`/files?kind=appearance&name=${encodeURIComponent(removing.name)}`);
      message.success(`已删除 ${removing.name}。`);
      setRemoving(null);
      await load();
    } catch (failure) {
      if (isUnauthorized(failure)) { onUnauthorized(); return; }
      setError(`${(failure as Error).message} 删除结果未确认，请刷新列表核对。`);
      setRemoving(null);
      await load();
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card
      className="flat-card"
      title="独立文件"
      extra={<span className="card-extra">上传与删除都不改变上下架状态</span>}
      styles={{ body: { padding: 18 } }}
    >
      {error ? <Alert type="warning" showIcon className="inline-alert" message="文件操作未确认" description={error} closable onClose={() => setError("")} /> : null}
      {readError ? (
        <Alert
          type="error"
          showIcon
          className="inline-alert"
          message="文件列表未读取"
          description={`${readError} 这里不会显示「还没有独立上传的文件」——那会把读取失败说成没有文件。`}
          action={<Button size="small" onClick={() => void load()}>重试</Button>}
        />
      ) : null}
      <Space wrap>
        <label className="ant-btn ant-btn-sm" style={{ cursor: busy ? "not-allowed" : "pointer" }}>
          <input
            type="file"
            accept=".nmgpack"
            disabled={busy}
            style={{ display: "none" }}
            onChange={(event) => {
              const file = event.target.files?.[0];
              event.target.value = "";
              if (file) void upload(file);
            }}
          />
          {busy ? "处理中" : "上传 .nmgpack"}
        </label>
        <Button size="small" onClick={() => void load()} disabled={busy}>刷新列表</Button>
      </Space>
      {files === null ? (
        readError ? null : <div className="panel-loading" role="status">文件列表读取中</div>
      ) : files.length === 0 ? (
        <div className="todo-empty">还没有独立上传的文件。</div>
      ) : (
        <div className="stack-10" style={{ marginTop: 10 }}>
          {files.map((file) => (
            <div className="file-row" key={file.id}>
              <span className="file-name mono">{file.name}</span>
              <span className="file-meta">{fileSize(file.size)} · {beijingTime(file.lastModified)}</span>
              <Button size="small" danger type="text" disabled={busy} onClick={() => setRemoving(file)}>删除</Button>
            </div>
          ))}
        </div>
      )}
      <Typography.Paragraph type="secondary" className="drawer-note" style={{ marginTop: 10 }}>
        删除只移除这个上传文件，不会下架形象，也不影响已签发批次；资源是否缺失只看每一行的素材修订。
      </Typography.Paragraph>

      <Modal
        open={removing !== null}
        title="确认删除这个文件？"
        okText="确认删除"
        cancelText="取消"
        okButtonProps={{ danger: true }}
        confirmLoading={busy}
        maskClosable={!busy}
        onCancel={() => { if (!busy) setRemoving(null); }}
        onOk={() => void removeFile()}
      >
        <p className="mono">{removing?.name}</p>
        <p>只删除这个独立上传的文件。<strong>不会下架任何形象</strong>，也不影响已签发批次与已下载文件。</p>
      </Modal>
    </Card>
  );
}

/**
 * A still cover from the site's own preview directory.
 *
 * The slug comes from the site's public preview index, so an appearance that
 * has no preview says so for the real reason (it is not in the index) rather
 * than because a hard-coded name went stale.
 *
 * This is a static image, not the site's pack player: the player needs the
 * origin's release index and is not part of the console bundle. Copying the
 * prototype's 14 MB public tree to get animated playback is out of scope here,
 * so the console shows the same cover image the site ships.
 */
function PackPreview({ slug, name, size, height }: { slug: string | null; name: string; size: number; height?: number }) {
  const [failed, setFailed] = useState(false);
  const boxHeight = height ?? size;

  // A different appearance in the same slot must not inherit the previous failure.
  useEffect(() => { setFailed(false); }, [slug]);

  return (
    <div className="pack-thumb" style={{ width: size, height: boxHeight }}>
      {!slug || failed ? (
        <div className="pack-thumb-note">
          {slug ? "这一屏没有取到封面素材" : "没有对应的公开预览目录"}
          <small>资源是否存在请看服务端状态</small>
        </div>
      ) : (
        <img
          src={`/assets/previews/packs/${slug}/preview.png`}
          alt={`${name} 的公开封面`}
          loading="lazy"
          onError={() => setFailed(true)}
          style={{ width: "100%", height: "100%", objectFit: "contain" }}
        />
      )}
    </div>
  );
}

/**
 * Number lookup: the one place a 形象编号 is resolved. Kept on this page so the
 * console does not grow a second page that duplicates it.
 */
function NumberLookup() {
  const { message } = useSessionActions();
  const [value, setValue] = useState("");
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<NumberResult | null>(null);
  const [failure, setFailure] = useState("");

  const submit = async () => {
    const number = value.trim();
    setResult(null);
    setFailure("");
    if (!/^[1-9][0-9]{5,8}$/u.test(number)) {
      setFailure("请输入完整的 6 至 9 位形象编号，首位不能是 0。");
      return;
    }
    setLoading(true);
    try {
      const body = await api<{ appearance: NumberResult }>(`/appearance-numbers?number=${encodeURIComponent(number)}`, {}, (raw) => Boolean(raw.appearance));
      setResult(body.appearance);
    } catch (error) {
      const code = (error as ApiError).message;
      setFailure(code);
    } finally {
      setLoading(false);
    }
  };

  return (
    <Card className="flat-card" title="形象编号查询" extra={<Typography.Text type="secondary" className="card-extra">通用编号，不是订单号或群码</Typography.Text>}>
      <Space.Compact style={{ width: "100%", maxWidth: 460 }}>
        <Input
          value={value}
          onChange={(event) => setValue(event.target.value.replace(/\D/gu, "").slice(0, 9))}
          onPressEnter={() => void submit()}
          placeholder="6 至 9 位形象编号"
          inputMode="numeric"
          maxLength={9}
          aria-label="形象通用编号"
        />
        <Button type="primary" loading={loading} onClick={() => void submit()}>按编号查找</Button>
      </Space.Compact>
      {failure ? <Alert type="warning" showIcon className="inline-alert" message={failure} /> : null}
      {result ? (
        <Descriptions column={1} size="small" colon={false} className="lookup-result" labelStyle={{ width: 96, color: "var(--faint)" }}>
          <Descriptions.Item label="编号">#{result.appearanceNumber}</Descriptions.Item>
          <Descriptions.Item label="名称">{result.titleZh}</Descriptions.Item>
          <Descriptions.Item label="来源">{result.sourceKind === "official" ? "官方" : <Tooltip title="共创已暂停，存量作品只读"><span>社区（只读）</span></Tooltip>}</Descriptions.Item>
          {/*
            The lookup answers with the same state vocabulary as the gallery.
            Printing the raw enum here would show "PUBLISHED" next to cards
            that say 已上架, and an unknown state must not be relabelled.
          */}
          <Descriptions.Item label="状态">
            {stateMeta[result.state as Appearance["state"]]
              ? <StatusTag tone={stateMeta[result.state as Appearance["state"]].tone}>{stateMeta[result.state as Appearance["state"]].label}</StatusTag>
              : <span className="mono">{result.state}（未识别的状态）</span>}
          </Descriptions.Item>
          <Descriptions.Item label="内部 ID"><span className="mono">{result.internalId}</span></Descriptions.Item>
          {result.sharePath ? (
            <Descriptions.Item label="公开作品">
              <a href={result.sharePath} target="_blank" rel="noreferrer" onClick={() => message.info("在新标签页查看官网作品页")}>
                打开官网作品页
              </a>
            </Descriptions.Item>
          ) : null}
        </Descriptions>
      ) : null}
      <Typography.Paragraph type="secondary" className="drawer-note">
        当前只运营官方图库；存量社区作品仍可只读查询，但不开放共创投稿、作者码或社区发布。
      </Typography.Paragraph>
    </Card>
  );
}
