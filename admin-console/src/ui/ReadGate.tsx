import { Alert, Button, Empty, Skeleton, Typography } from "antd";
import { ReloadOutlined } from "@ant-design/icons";
import type { ReadState } from "./api";

/**
 * The three states every page has to get right.
 *
 * A failed read is never rendered as an empty list: `error` keeps the button to
 * retry and says the last known data is not shown. `empty` says the request
 * succeeded and there was genuinely nothing, which is a different sentence.
 */
export function ReadGate<T>({
  state,
  onRetry,
  emptyText,
  emptyHint,
  skeletonRows = 4,
  children
}: {
  state: ReadState<T>;
  onRetry?: () => void;
  emptyText?: string;
  emptyHint?: string;
  skeletonRows?: number;
  children: (data: T) => React.ReactNode;
}) {
  if (state.status === "loading") {
    return (
      <div className="panel-loading" role="status" aria-live="polite">
        <Skeleton active paragraph={{ rows: skeletonRows }} title={{ width: "38%" }} />
      </div>
    );
  }
  if (state.status === "error") {
    return (
      <Alert
        type={state.unauthorized ? "warning" : "error"}
        showIcon
        message={state.unauthorized ? "会话已过期，这一块没有显示旧数据" : "读取失败，这一块没有显示旧数据"}
        description={
          <>
            {state.message}
            {state.unauthorized ? " 请重新登录后再看这一块。" : " 这不等于没有数据，也不要据此判断今天没有问题。"}
          </>
        }
        action={onRetry && !state.unauthorized ? (
          <Button size="small" icon={<ReloadOutlined />} onClick={onRetry}>重试</Button>
        ) : undefined}
      />
    );
  }
  if (state.status === "empty") {
    return (
      <div className="panel-empty">
        <Empty
          image={Empty.PRESENTED_IMAGE_SIMPLE}
          description={
            <span>
              {emptyText ?? "这个范围里确实没有记录。"}
              {emptyHint ? <Typography.Text type="secondary" className="empty-hint">{emptyHint}</Typography.Text> : null}
            </span>
          }
        />
      </div>
    );
  }
  return <>{children(state.data)}</>;
}

/** A single small failure, for a block that sits next to other blocks that did load. */
export function InlineFailure({ label, onRetry }: { label: string; onRetry?: () => void }) {
  return (
    <Alert
      type="warning"
      showIcon
      className="inline-failure"
      message={`${label}未读取`}
      description="这一块没有使用上一次的旧数据，也不显示 0。"
      action={onRetry ? <Button size="small" type="text" onClick={onRetry}>重试</Button> : undefined}
    />
  );
}
