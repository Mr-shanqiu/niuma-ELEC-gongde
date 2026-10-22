import { useEffect, useMemo, useState } from "react";
import { Alert, Button, Card, Descriptions, Drawer, Empty, Input, Segmented, Space, Tooltip, Typography } from "antd";
import { SearchOutlined } from "@ant-design/icons";
import { api, shapes, useRead } from "../ui/api";
import type { ApiError } from "../ui/api";
import { StatusTag, type Tone } from "../ui/StatusTag";
import { useSessionActions } from "../ui/session";
import { usePreviewIndex } from "../ui/preview";

/**
 * Appearances: read-only this batch.
 *
 * Publishing, un-publishing and safety suspension are write operations whose
 * concurrency protection is a separate step, so the page does not offer them
 * here. What it does offer is the real state of each official appearance and a
 * number lookup, which is where 编号查询 lives now.
 *
 * Two facts come from the server and are never inferred from the preview: the
 * publication `state` and the material `revision`. A preview that fails to load
 * is a rendering problem, not a MISSING appearance.
 */
type Appearance = {
  id: string;
  assetId: string;
  appearanceNumber: string | null;
  name: string;
  revision: string | null;
  state: "PUBLISHED" | "UNPUBLISHED" | "MISSING";
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

export function AppearancesView() {
  const previews = usePreviewIndex();
  const [filter, setFilter] = useState<string>("all");
  const [query, setQuery] = useState("");
  const [detail, setDetail] = useState<Appearance | null>(null);

  const list = useRead<{ data: Appearance[]; total: number }>("/appearances", { expect: shapes.list });

  const items = list.state.status === "ready" ? list.state.data.data : [];
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
        message="本轮形象管理为只读"
        description="上下架与安全停发的正式写入（含并发修订校验）安排在下一实施段。这里只显示服务端当前状态，不提供按钮占位。"
      />

      {list.state.status === "error" ? (
        <Alert
          type={list.state.unauthorized ? "warning" : "error"}
          showIcon
          message={list.state.unauthorized ? "会话已过期，形象列表未读取" : "形象列表未读取"}
          description={`${list.state.message} 未知状态不会被画成「已下架」，筛选计数也不显示 0。`}
          action={<Button size="small" onClick={list.reload}>重试</Button>}
        />
      ) : list.state.status === "loading" ? (
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
              onOpen={() => setDetail(item)}
            />
          ))}
        </div>
      )}

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
              <Descriptions.Item label="服务端修订">{detail.revision ?? "无（资源缺失）"}</Descriptions.Item>
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
              description="这里播放的是官网同源的公开预览素材。它加载失败只说明这一屏没取到素材；资源是否存在只看上面的「服务端修订」与发布状态。"
            />
            <Alert
              type="info"
              showIcon
              message="「修订」是素材版本，不是发布状态版本"
              description="它随素材内容变化，不随上下架变化，因此不能用来判断这一行是否刚被别人改过。"
            />
          </div>
        ) : null}
      </Drawer>
    </div>
  );
}

function FaceCard({ item, slug, onOpen }: { item: Appearance; slug: string | null; onOpen: () => void }) {
  return (
    <div className={`face-card${item.state === "MISSING" ? " is-missing" : ""}${item.state === "UNPUBLISHED" ? " is-unpublished" : ""}`}>
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
      </div>
    </div>
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
