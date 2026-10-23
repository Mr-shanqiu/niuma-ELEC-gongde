import type { ReactNode } from "react";
import {
  AlertOutlined,
  AppstoreOutlined,
  CloudDownloadOutlined,
  DashboardOutlined,
  GiftOutlined,
  ProfileOutlined
} from "@ant-design/icons";

/**
 * Six entries, two groups.
 *
 * Historic trades live inside 付费订单 and the number lookup lives inside
 * 形象管理, so neither needs a page of its own. The paused co-creation, author
 * code and AI budget areas are deliberately absent: public submissions remain paused; historical records and restoration plans are preserved.
 */
export type NavKey = "today" | "orders" | "code" | "appearances" | "reports" | "installers";

export type NavItem = {
  key: NavKey;
  label: string;
  icon: ReactNode;
};

/**
 * No counts on the entries.
 *
 * A badge here would have to come from the page's own read, and the shell does
 * not read data. The earlier build showed a number that outlived a failed read,
 * which reads as "3 items waiting" while the page says nothing could be read.
 * Pending work is counted on 运营总台 instead, next to the data it comes from.
 */
export const NAV: Array<{ key: string; label: string; items: NavItem[] }> = [
  {
    key: "ops",
    label: "运营",
    items: [
      { key: "today", label: "运营总台", icon: <DashboardOutlined /> },
      { key: "orders", label: "付费订单", icon: <ProfileOutlined /> },
      { key: "code", label: "群码与领取", icon: <GiftOutlined /> }
    ]
  },
  {
    key: "content",
    label: "内容",
    items: [
      { key: "appearances", label: "形象管理", icon: <AppstoreOutlined /> },
      { key: "reports", label: "举报处理", icon: <AlertOutlined /> },
      { key: "installers", label: "安装包", icon: <CloudDownloadOutlined /> }
    ]
  }
];

export const ROUTES: Record<NavKey, { path: string; group: string; title: string; subtitle: string }> = {
  today: { path: "today", group: "运营", title: "运营总台", subtitle: "区间与累计订单、免费领取、双平台下载；待办和服务状态为当前快照" },
  orders: { path: "orders", group: "运营", title: "付费订单", subtitle: "只读底账，含旧规则交易；固定按最近创建倒序" },
  code: { path: "code", group: "运营", title: "群码与领取", subtitle: "当前官方群码在上，区间领取批次在下" },
  appearances: { path: "appearances", group: "内容", title: "形象管理", subtitle: "官方形象 · 上下架、安全停发与编号查询" },
  reports: { path: "reports", group: "内容", title: "举报处理", subtitle: "只记录调查与处理依据，不代替下架" },
  installers: { path: "installers", group: "内容", title: "安装包", subtitle: "当前登记版本与旧版本；下载请求按平台统计" }
};

export const NAV_KEYS = Object.keys(ROUTES) as NavKey[];

/**
 * Map a hash or path to a page key.
 *
 * The console uses `#/orders`, so the value arrives with a leading slash. An
 * unknown path falls back to 运营总台 rather than rendering an empty frame.
 */
export function keyFromPath(pathname: string): NavKey {
  const segment = pathname.replace(/^\/admin\/?/u, "").replace(/^\/+/u, "").split(/[/?]/u)[0];
  return (NAV_KEYS as string[]).includes(segment) ? segment as NavKey : "today";
}
