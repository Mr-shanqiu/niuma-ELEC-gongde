import { useCallback, useEffect, useMemo, useState } from "react";
import { App as AntApp, Button, ConfigProvider, Layout, Menu, Typography } from "antd";
import zhCN from "antd/locale/zh_CN";
import { LogoutOutlined, MenuFoldOutlined, MenuUnfoldOutlined, ReloadOutlined } from "@ant-design/icons";
import { NAV, ROUTES, keyFromPath, type NavKey } from "./nav";
import { theme } from "./ui/tokens";

export type ShellProps = {
  onLogout: () => void;
  children: (key: NavKey, reloadToken: number) => React.ReactNode;
};

/**
 * Navigation shell.
 *
 * Uses the URL hash path (`#/orders`) so a page can be linked and reloaded. The
 * six entries are the only destinations; an unknown path falls back to 今日运营
 * rather than rendering an empty frame.
 */
export function Shell({ onLogout, children }: ShellProps) {
  const [active, setActive] = useState<NavKey>(() => keyFromPath(location.hash.replace(/^#/u, "")));
  const [collapsed, setCollapsed] = useState(false);
  const [reloadToken, setReloadToken] = useState(0);
  const [clock, setClock] = useState(() => new Date());

  useEffect(() => {
    const sync = () => setActive(keyFromPath(location.hash.replace(/^#/u, "")));
    addEventListener("hashchange", sync);
    return () => removeEventListener("hashchange", sync);
  }, []);

  useEffect(() => {
    const timer = window.setInterval(() => setClock(new Date()), 30_000);
    return () => window.clearInterval(timer);
  }, []);

  const navigate = useCallback((key: NavKey) => {
    location.hash = `#/${ROUTES[key].path}`;
    setActive(key);
  }, []);

  const meta = ROUTES[active];
  const items = useMemo(() => NAV.map((group) => ({
    key: group.key,
    type: "group" as const,
    label: collapsed ? undefined : group.label,
    children: group.items.map((item) => ({
      key: item.key,
      icon: item.icon,
      label: item.label
    }))
  })), [collapsed]);

  return (
    <ConfigProvider theme={theme} locale={zhCN}>
      <AntApp>
        <Layout className="shell">
          <Layout.Sider
            className="rail"
            width={224}
            collapsedWidth={64}
            collapsed={collapsed}
            trigger={null}
            breakpoint="lg"
            onBreakpoint={(broken) => setCollapsed(broken)}
          >
            <div className="brand-row">
              <span className="brand-seal" aria-hidden="true">功</span>
              {!collapsed && (
                <span className="brand-text">
                  <b>牛马电子功德</b>
                  <small>管理台</small>
                </span>
              )}
            </div>
            <Menu
              mode="inline"
              selectedKeys={[active]}
              onClick={({ key }) => navigate(key as NavKey)}
              items={items}
              className="rail-menu"
            />
            <div className="rail-foot">
              {collapsed ? null : (
                <Button type="link" size="small" icon={<LogoutOutlined />} onClick={onLogout}>退出登录</Button>
              )}
            </div>
          </Layout.Sider>

          <Layout>
            <Layout.Header className="topbar">
              <Button
                type="text"
                size="small"
                aria-label={collapsed ? "展开侧栏" : "收起侧栏"}
                icon={collapsed ? <MenuUnfoldOutlined /> : <MenuFoldOutlined />}
                onClick={() => setCollapsed((value) => !value)}
              />
              <Typography.Text className="crumb">{meta.group}</Typography.Text>
              <span className="crumb-sep" aria-hidden="true">/</span>
              <Typography.Title level={5} className="page-title">{meta.title}</Typography.Title>
              <span className="topbar-grow" />
              <span className="beijing">北京时间 · {beijingDate(clock)}</span>
              <Button
                type="text"
                icon={<ReloadOutlined />}
                aria-label="重新读取当前页"
                onClick={() => setReloadToken((value) => value + 1)}
              />
            </Layout.Header>

            <Layout.Content className="content">
              <p className="page-sub">{meta.subtitle}</p>
              <main key={`${active}:${reloadToken}`}>{children(active, reloadToken)}</main>
            </Layout.Content>
          </Layout>
        </Layout>
      </AntApp>
    </ConfigProvider>
  );
}

export function beijingDate(date: Date): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit"
  }).format(date);
}

/**
 * Beijing day boundaries for a `YYYY-MM-DD` value, as the API expects ISO instants.
 */
export function beijingDayRange(value: string): { from: string; to: string } | null {
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(value)) return null;
  const from = new Date(`${value}T00:00:00+08:00`);
  if (!Number.isFinite(from.getTime())) return null;
  return { from: from.toISOString(), to: new Date(from.getTime() + 86_400_000).toISOString() };
}
