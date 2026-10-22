import { StrictMode, useCallback, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { Alert, App as AntApp, Button, ConfigProvider, Result, Spin } from "antd";
import zhCN from "antd/locale/zh_CN";
import { theme } from "./ui/tokens";
import { SessionContext } from "./ui/session";
import { api, post, setUnauthorizedHandler, shapes } from "./ui/api";
import type { ApiError } from "./ui/api";
import { Login } from "./Login";
import { Shell } from "./Shell";
import type { NavKey } from "./nav";
import { TodayView } from "./pages/TodayView";
import { OrdersView } from "./pages/OrdersView";
import { CodeView } from "./pages/CodeView";
import { AppearancesView } from "./pages/AppearancesView";
import { ReportsView } from "./pages/ReportsView";
import { InstallersView } from "./pages/InstallersView";
import "./app.css";

type Attempt = "checking" | "signed-in" | "signed-out" | "unreachable";

/**
 * The console root.
 *
 * The session is one request: `GET /session`. A 401 shows the login page, and
 * anything else shows an unreachable notice — "the API did not answer" must not
 * be rendered as "you are logged out", because the operator would type a
 * correct password into a form that cannot succeed.
 */
function Console() {
  const [attempt, setAttempt] = useState<Attempt>("checking");
  const [failure, setFailure] = useState("");

  const check = useCallback(async () => {
    setAttempt("checking");
    setFailure("");
    try {
      await api<{ username: string }>("/session", {}, shapes.session);
      setAttempt("signed-in");
    } catch (error) {
      const status = (error as ApiError).status;
      if (status === 401) setAttempt("signed-out");
      else {
        setAttempt("unreachable");
        setFailure((error as Error).message || "管理接口暂时不可达。");
      }
    }
  }, []);

  useEffect(() => { void check(); }, [check]);

  const endSession = useCallback(() => setAttempt("signed-out"), []);

  // Any 401 from any request ends here, including reads on a page the operator
  // is already looking at. Pages do not each need their own wiring for it.
  useEffect(() => {
    setUnauthorizedHandler(endSession);
    return () => setUnauthorizedHandler(null);
  }, [endSession]);

  const logout = useCallback(async () => {
    try {
      await post("/logout", {});
    } finally {
      // The cookie may already be gone; the local state is what the UI follows.
      setAttempt("signed-out");
    }
  }, []);

  if (attempt === "checking") {
    return (
      <div className="boot">
        <Spin size="large" />
        <span>正在确认管理员会话…</span>
      </div>
    );
  }

  if (attempt === "unreachable") {
    return (
      <div className="boot">
        <Result
          status="warning"
          title="管理接口暂时不可达"
          subTitle={`${failure} 这不等于登录失效，所以不跳到登录页。`}
          extra={<Button type="primary" onClick={() => void check()}>重新检查</Button>}
        />
      </div>
    );
  }

  if (attempt === "signed-out") {
    return <Login onSuccess={() => setAttempt("signed-in")} />;
  }

  return (
    <SessionContext.Provider value={{ endSession }}>
      <Shell onLogout={() => void logout()}>
        {(key: NavKey) => <PageFor name={key} />}
      </Shell>
    </SessionContext.Provider>
  );
}

/** Six entries, no fallback to a blank frame: every key maps to a working page. */
function PageFor({ name }: { name: NavKey }) {
  switch (name) {
    case "today": return <TodayView />;
    case "orders": return <OrdersView />;
    case "code": return <CodeView />;
    case "appearances": return <AppearancesView />;
    case "reports": return <ReportsView />;
    case "installers": return <InstallersView />;
    default: return <Alert type="error" showIcon message="未知页面" description="刷新后重新选择左侧入口。" />;
  }
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <ConfigProvider theme={theme} locale={zhCN} componentSize="middle">
      <AntApp>
        <Console />
      </AntApp>
    </ConfigProvider>
  </StrictMode>
);
