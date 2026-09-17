# 牛马电子功德支付服务

这是与桌球业务隔离的支付与数字形象权益服务。桌球项目只提供经过验证的微信 Native、支付宝电脑网站支付底层适配器；本服务拥有独立商品、订单、回调、权益、交付和退款语义。

## 安全状态

- 默认 `GONGDE_PAYMENT_MODE=disabled`，不能创建订单。
- `mock` 仅用于本地联调，不调用支付渠道。
- `live` 在持久化、回调、消费者规则和商户后台确认完成前固定拒绝启动。
- 商户私钥、平台公钥、APIv3 密钥只能通过只读文件挂载，禁止进入 Git。
- 不接入微信开放平台登录。手机号只用于短信验证，订单绑定服务端 HMAC 生成的稳定内部标识；验证码和会话均有有效期。
- `GONGDE_SMS_MODE=disabled` 为默认值；`mock` 只用于本地测试。`live` 使用独立 Redis 原子状态机，并复用桌球项目同一腾讯云账号、【智家】签名和通用登录验证码模板。

## 本地模拟

设置 `GONGDE_PAYMENT_MODE=mock` 和 `GONGDE_PAYMENT_TEST_TOKEN` 后启动。测试接口使用 `x-gongde-test-token`，正式部署必须完全移除测试入口。

商品分为三类：

- `official-character-pass`：100 分，一次购买，绑定已验证手机号；首次可一次交付1至10个所选形象包。
- `official-asset-delivery`：20 分，仅已持有通行证的手机号可购买，每次生成1至10个24小时内可首次导入的形象包。
- `project-support`：100/500/1000 分自愿赞赏，不要求手机号，不发放任何商品或权益。

## 购买身份

- 基础安装包、形象浏览和动态预览不需要登录。
- 付费形象必须先完成短信验证；同一手机号以后可恢复资格并购买新的形象包交付。
- 短信用途固定为 `gongde_login`。会话默认30天，验证码5分钟有效、最多尝试5次，同一手机号60秒内不可重复发送；日额度按北京时间自然日计算。
- 每个 `asset-download` 交付资格有效24小时；成功导入客户端后由客户端永久离线保存。
- 客户端不接收手机号、会话或订单数据，导入成功后仍永久离线使用。
- 赞赏与购买订单完全分开，赞赏不会解锁功能，也不构成公益捐赠。

## MySQL 订单真相

- `GONGDE_STORE_MODE=memory` 只用于本地测试；正式环境使用 `mysql`。
- 功德使用独立 MySQL database 和最小权限用户，不进入桌球业务 database。
- 密码只通过 `GONGDE_MYSQL_PASSWORD_FILE` 指向的只读文件加载。
- 非秘密配置：`GONGDE_MYSQL_HOST`、`GONGDE_MYSQL_PORT`、`GONGDE_MYSQL_DATABASE`、`GONGDE_MYSQL_USER`、`GONGDE_MYSQL_CONNECTION_LIMIT`。
- 数据库变更按编号保存在 `migrations/*.sql`；`npm run db:migrate` 会记录并跳过已执行文件，只应由受控迁移任务执行。
- `/api/live` 只表示进程存活；`/api/ready` 同时检查 MySQL 与短信状态依赖。

## 腾讯云短信配置

正式短信只从服务器只读文件加载腾讯云密钥，不允许把密钥写入环境变量、源码或日志：

- `TENCENT_CLOUD_SECRET_ID_FILE`
- `TENCENT_CLOUD_SECRET_KEY_FILE`
- `GONGDE_SMS_IDENTITY_SECRET_FILE`
- `GONGDE_SMS_REDIS_URL_FILE`
- `TENCENT_CLOUD_SMS_SDK_APP_ID`
- `TENCENT_CLOUD_SMS_GONGDE_SIGN_NAME`，未设置时复用 `TENCENT_CLOUD_SMS_SIGN_NAME`
- `TENCENT_CLOUD_SMS_GONGDE_LOGIN_TEMPLATE_ID`，未设置时复用 `TENCENT_CLOUD_SMS_MEMBER_BIND_TEMPLATE_ID`

当前确认复用【智家】签名和现有通用验证码模板，但发送路由、`gongde_login` 用途、频控、登录会话和订单数据保持独立。

Redis 只保存手机号、IP、验证码、challenge 和 session 的 HMAC 标识。发送额度预占、五次错误锁定、一次性消费及30天登录会话均通过 Lua 原子执行；供应商返回结果不明时保留阻断标记，禁止自动重发。

## 形象包签发

- `GONGDE_PACK_DELIVERY_MODE=disabled` 为默认值；受控服务使用 `local`。
- `GONGDE_PACK_ASSET_ROOT` 只允许指向已审核官方素材目录。
- `GONGDE_PACK_SIGNING_KEY_FILE` 指向 P-256 私钥只读文件；私钥不得进入 Git、日志、静态网站或客户端。
- 下载接口要求订单 `buyerToken`，只为仍在24小时交付期内的 `asset-download` 权益生成 Schema 2 数据包。
- HTTP 响应使用 `private, no-store`，形象包由客户端使用内置公钥离线验证。
