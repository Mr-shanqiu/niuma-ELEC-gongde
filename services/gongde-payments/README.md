# 牛马电子功德支付服务

这是与桌球业务隔离的支付与数字形象权益服务。桌球项目只提供经过验证的微信 Native、支付宝电脑网站支付底层适配器；本服务拥有独立商品、订单、回调、权益、交付和退款语义。

## 商户共用边界

- 共用范围仅限同一经营主体的微信支付商户号、支付宝企业商户、结算账户、腾讯云短信账号及受管密钥托管设施。
- 功德使用独立应用参数、`/api/gongde/*` 回调、`GD_` 订单前缀、`gongde` database、独立 Redis、手机号身份、权益与形象包签名密钥。
- 桌球订单、用户、会员、权益、退款和运营数据不得写入或查询功德账本；功德数据也不得反向进入桌球业务。
- 共享商户密钥不复制到项目目录，只能由生产环境以只读 secret 文件挂载。

## 安全状态

- 默认 `GONGDE_PAYMENT_MODE=disabled`，不能创建订单。
- `mock` 仅用于本地联调，不调用支付渠道。
- `live` 在持久化、回调、消费者规则和商户后台确认完成前固定拒绝启动。
- 商户私钥、平台公钥、APIv3 密钥只能通过只读文件挂载，禁止进入 Git。
- 生产环境会拒绝直接写入环境变量的支付密钥，并拒绝非 `/api/gongde/*` 的支付回调地址。
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

## 私有 COS 批次交付（默认未启用）

- 当前正式购买身份为匿名权益码，不需要手机号；每批最多 5 个形象，一个文件一次导入。本文较早的手机号/短信与 10 个数量说明不是当前官网购买流程。
- 付款确认及已付款订单查询后，独立服务异步预生成、上传签名批次；相同订单/交付资格/素材版本使用固定对象键。重启后先查询对象，不覆盖已有批次，不因 ECDSA 签名的随机性重复上传。
- `POST /api/gongde/orders/:orderNo/package-link` 保持原接口；浏览器访问原短时下载入口时重新验证订单，再通过 302 跳转到 COS 原生 HTTPS 地址。大文件不经过共享服务器；不需要修改网页或客户端，不要求 CORS。
- 新建功德专用私有桶，桶名以 `gongde-paid-` 开头。不能复用 `gongde-download-1460392746`、桌球或智家的业务桶；本模块不创建桶、不修改桶策略或 IAM。
- 桶 ACL 必须为 private 且仅所有者有 ACL 授权；桶策略必须不存在或仅含 Deny。服务通过独立 CAM 用户授权，不使用桶策略授予读取权限。上传前检查桶权限，上传时显式设置 private，发放签名链接前再次检查对象 ACL。短时桶检查缓存为 5 秒。
- 链接最长 120 秒，且不超过原交付截止时间；链接生成后、发送跳转前再次校验订单交付资格。已签发 COS 链接在短时有效期内是 bearer 凭据，不能在撤销权益时立即回收；撤销最晚在该短时链接失效时生效。
- COS 故障、未配置、权限不符合私有要求或上传繁忙时保留原服务下载，不把存储异常变成二次付款。云端上传并发最多 2，元数据缓存最多 128；暂时故障退避 30 秒，不无限重试。原下载期限保持不变。

生产启用所需独立配置（示例桶名仅为建议，尚未创建）：

```sh
GONGDE_PRIVATE_COS_MODE=enabled
GONGDE_PRIVATE_COS_BUCKET=gongde-paid-1460392746
GONGDE_PRIVATE_COS_REGION=ap-shanghai
GONGDE_PRIVATE_COS_SECRET_ID_FILE=/run/secrets/gongde_private_cos_secret_id
GONGDE_PRIVATE_COS_SECRET_KEY_FILE=/run/secrets/gongde_private_cos_secret_key
```

独立 CAM 用户仅需目标桶的 `GetBucketACL`、`GetBucketPolicy`，以及该桶 `paid-batches/v1/*` 的 `GetObject`、`PutObject`、`GetObjectACL`、`PutObjectACL`。不授予创建/删除桶、修改桶 ACL/策略、列举对象或删除对象。由桶所有者在新桶上设置该前缀 2 天过期删除的生命周期，避免无限积累文件；运行服务不获取删除权限。首次下载/导入仍只有原 24 小时，生命周期不是权益期限。

独立私有桶、CAM 用户、只读 secret 挂载尚未配置时，保持 `GONGDE_PRIVATE_COS_MODE=disabled`。代码完成不代表直连已上线或已通过实际测速。启用前需确认匿名 GET/HEAD 被拒绝、已付款下载文件的 SHA 与签名正确、过期链接被拒绝，以及云故障回退；未授权测试前不执行这些验收。

SDK 参数依据：[腾讯云预签名 URL 文档](https://cloud.tencent.com/document/product/436/36121)；权限依据：[COS API 授权策略](https://cloud.tencent.com/document/product/436/31923)。

## 免费创作者社区第一版（源码候选，尚未接入运行服务）

当前目标见 `../../docs/CREATOR_SYSTEM_PLAN.zh-CN.md` 的 2026-10-03 范围替换。较早的手机号、通行证和匿名权益码描述不代表当前官方新购价格；官方规则见 `../../docs/PURCHASE_AND_BATCH_DOWNLOAD_RULES.zh-CN.md`。

新增 `src/creators/configuration.ts`、`object-store.ts`、`repository.ts`、`free-service.ts`、`router.ts` 与迁移 `005_free_creator_community.sql`，提供用户名账号/密码/恢复码、持久会话、作品草稿、文件归属校验、私有上传、真实 PNG 预览、不可变审核快照、审核发布、拒绝、下架、暂停、公开免费目录和版权举报的源码实现。路由仍需接入 `server.ts`，网站、管理界面、举报处理和免费批次交付仍待实施。

- 默认关闭；启用须使用功德独立 MySQL，按既有迁移流程应用 004/005。MySQL DDL 不具备完整事务回滚，未知迁移结果不可盲目重跑。
- 使用单独的创作者 COS 只读 secret 挂载；不自动复用官方安装包、智家或桌球凭据，不创建桶、不改 IAM。
- 私有对象前缀为 `creator-submissions/v1/<creator-id>/<archive-sha256>/`。已存在的 `paid-batches/v1/` 授权不涵盖该前缀；该前缀不能使用付费临时批次的两天过期生命周期。
- 需目标桶 `GetBucketACL`、`GetBucketPolicy` 和该前缀 `PutObject`、`PutObjectACL`、`GetObject` 权限。只允许 private 桶 ACL、只包含所有者的授权、无 Allow 的桶策略；请求不公开原始 COS URL。
- 恢复码仅在注册或成功恢复时显示一次，数据库只存摘要。恢复密码会撤销全部旧会话并轮换恢复码；平台不通过知道用户名就代发新密码。
- 同源写请求、HttpOnly/SameSite/Secure Cookie、MySQL 频控、密码与存储并发限制独立于管理员身份。恢复码不得进入日志或作品介绍。
- 当前 HTTP 频控使用连接的真实对端地址，不信任任意 `X-Forwarded-For`。正式反向代理的受信地址解析必须接入并验收，不能把所有浏览器永久视为同一代理 IP。
- 人工审批必须分别确认数据包安全、真实预览、内容合适及版权声明；自动校验通过不等于版权事实已确认。
- 本块没有执行测试、编译、迁移、部署或 COS 调用，不能作为运行或上线证据。收费与结算开关必须保持 false。

### 免费社区交付与受信代理（2026-10-03 源码候选）

`POST /api/gongde/community/batches` 接收仅含作品 ID、版本 ID 和 revision 的所选列表，不接收价格、对象键或声明已审核的标志。服务端解析当前公开免费版本、实际审核记录和文件预算，读取不可变私有源并构建批次，回复文件前再次检查是否仍公开。浏览器得到一个 `.nmgpacks`，没有权益码或付费导入期限。

交付有独立开关 `GONGDE_CREATOR_FREE_DOWNLOADS_ENABLED=false`。只有该开关与 `GONGDE_CREATOR_CLIENT_COMPATIBILITY_ACCEPTED=true` 同时获实际验收并启用，能力接口才告知前端可下载。代码存在不能代替客户端实际导入验收。

`GONGDE_CREATOR_TRUSTED_PROXY_ADDRESSES` 只接受最多 8 个确切 IP。默认不信任任何转发头；仅当 TCP 对端在此白名单中才读取单值 `X-Real-IP`，且反向代理必须使用实际客户端地址覆盖该头，不得拼接浏览器值或链式转发。白名单不能猜测，部署前根据受控代理拓扑确认；错误或缺失头拒绝请求。应用频控键仅为地址摘要，不在浏览器或审计中暴露原始地址。
