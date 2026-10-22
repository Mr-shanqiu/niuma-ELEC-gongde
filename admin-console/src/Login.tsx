import { useState } from "react";
import { Alert, Button, Card, Form, Input, Typography } from "antd";
import { api } from "./ui/api";

/**
 * Login page. Keeps the existing session cookie flow (`POST /login` then a
 * `GET /session` check) and the product rules shown on the old page, because
 * those sentences are the operator's own reference for what the console does.
 */
export function Login({ onSuccess }: { onSuccess: () => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const submit = async (values: { username: string; password: string }) => {
    setBusy(true);
    setError("");
    try {
      await api("/login", { method: "POST", body: JSON.stringify(values) });
      await api("/session");
      onSuccess();
    } catch {
      // A wrong password and an unreachable API are different problems, so the
      // message stays generic but never claims the credentials were correct.
      setError("登录失败：账号或密码不正确，或服务暂时不可达。");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="login-page">
      <section className="login-story">
        <span className="brand-seal large" aria-hidden="true">功</span>
        <p className="login-brand">牛马电子功德</p>
        <h1>看清每一笔<br />认真经营。</h1>
        <small>
          基础木鱼免费；官方扩展形象每个 1 元，每批最多 10 个，无套餐，也可凭当期官方群码免费领取。
          每次新下载重新付费或验群码，已保存文件可长期离线使用。共创新投稿与推广暂停，交易底账仅供管理员只读运营查看。
        </small>
      </section>
      <section className="login-panel">
        <Typography.Text className="eyebrow">PRIVATE CONSOLE</Typography.Text>
        <Typography.Title level={2}>管理员登录</Typography.Title>
        <Form layout="vertical" onFinish={submit} requiredMark={false} autoComplete="on">
          <Form.Item label="管理员账号" name="username" rules={[{ required: true, message: "请输入账号" }]}>
            <Input size="large" autoComplete="username" autoFocus />
          </Form.Item>
          <Form.Item label="密码" name="password" rules={[{ required: true, message: "请输入密码" }]}>
            <Input.Password size="large" autoComplete="current-password" />
          </Form.Item>
          {error ? <Alert type="error" showIcon message={error} className="login-error" /> : null}
          <Button type="primary" size="large" htmlType="submit" block loading={busy}>
            {busy ? "正在验证" : "进入管理台"}
          </Button>
        </Form>
        <Card size="small" className="login-note">
          <Typography.Text type="secondary">
            这个入口只服务管理员。读取失败时会明确说未读取，不会把未知显示成 0。
          </Typography.Text>
        </Card>
      </section>
    </div>
  );
}
