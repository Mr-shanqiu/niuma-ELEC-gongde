# 真实环境候选

该目录只定义牛马电子功德自己的动态服务候选，不修改桌球业务 API、数据库或 Redis。

- `gongde-api`：加入独立 `zqscreen_gongde_backend`、公网出站网络和前端网关网络。
- `gongde-redis`：独立容器与独立卷，只承载验证码、限流和短会话。
- `gongde-db-bootstrap`：一次性创建 `gongde` database 及 `gongde_app`、`gongde_migrator` 两个最小权限用户。
- `gongde-db-migrate`：只使用 migrator 密码执行功德自己的 migration。
- 微信、支付宝、腾讯云短信 secret 只从桌球受管 generation 原位只读挂载，禁止复制。
- 网关只应为 `gongde.zqscreen.cn` 精确匹配 `/api/*` 后反代 `gongde-api:8080`，其余路径仍交给静态站。

该候选不能独立上线。桌球 00 主控仍需串行增加独立网络、把现有 MySQL 加入该网络、增加精确 Caddy 路由，并建立动态服务发布与回退入口。
