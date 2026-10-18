# 真实环境候选

该目录只定义牛马电子功德自己的动态服务候选，不修改桌球业务 API、数据库或 Redis。

- `gongde-api`：加入独立 `zqscreen_gongde_backend`、公网出站网络和前端网关网络。
- `gongde-redis`：独立容器与独立卷，只承载验证码、限流和短会话。
- `gongde-db-bootstrap`：一次性创建 `gongde` database 及 `gongde_app`、`gongde_migrator` 两个最小权限用户。
- `gongde-db-migrate`：只使用 migrator 密码执行功德自己的 migration。
- 微信、支付宝、腾讯云短信 secret 只从桌球受管 generation 原位只读挂载，禁止复制。
- 共享的是商户通道和密钥托管，不共享订单、手机号身份、权益、退款记录或 Redis 状态；功德订单固定使用 `GD_` 前缀。
- 网关只应为 `gongde.zqscreen.cn` 精确匹配 `/api/*` 后反代 `gongde-api:8080`，其余路径仍交给静态站。
- 管理台使用独立的 `gongde_admin_password` 与 `gongde_admin_session_secret`，只开放只读订单接口，不复用支付或短信密钥。

该服务已有独立发布身份。日常静态站发布仅更新功德站点；API 发布、状态、健康检查、受控回退只通过固定强制命令和 root 发布器；受限运维入口仅可查看脱敏后的功德 API 白名单日志，或重启固定的功德 API 容器。没有 Docker 组、任意命令、shell、`exec`、sudo 通配规则或桌球服务/数据/凭据访问权。

已配置本机受限操作入口 `~/.local/bin/deploy-gongde-api`：

```text
deploy-gongde-api status
deploy-gongde-api health
deploy-gongde-api logs
deploy-gongde-api restart
deploy-gongde-api rollback-check <已登记release的SHA-256>
deploy-gongde-api rollback <已登记release的SHA-256>
deploy-gongde-api deploy <本机冻结API归档绝对路径> <归档SHA-256>
```

`logs` 只返回最近50行中白名单事件的时间、scope与event，不含明细。`restart` 只重启
Gongde API，返回后需等待`/api/ready`通过；若共享gateway绑定检查失败，应停止并交基础设施复核。
静态站继续通过 `~/.local/bin/deploy-gongde <冻结站点归档绝对路径> <归档SHA-256>` 单独发布。

**共享网关规则：** 桌球与牛马日常发布都不得重建共享 gateway。若基础设施确需重建，必须由基础设施流程单独重新核对网关容器身份、前端网络 endpoint 和可信代理地址绑定，并分别验收桌球 API 与牛马 API/发布状态；绑定或验收失败时停止，不得绕过保护。这是已确认的依赖，不代表它就是当前问题的根因。

运维入口变更的回退只恢复主控保存的原强制命令与精确 sudoers，并删除新增的固定 helper；不删除或轮换牛马发布 key，不回退应用 release，不重启共享 gateway 或桌球服务。

这不授予牛马网关、MySQL、Redis、桌球业务 API、密钥 generation 或 ACE 数据权限。源码、发布器实现和服务器实际权限仍须分别以代码审查及权限边界验收确认。
