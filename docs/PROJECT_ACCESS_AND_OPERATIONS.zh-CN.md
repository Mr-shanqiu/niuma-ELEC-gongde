# 牛马电子功德：访问、凭据引用与运维入口

更新日期：2026-10-12。所有日期与结果均是对应记录的观察时间，不代表永久有效。最新状态以末尾的最新发布检查点为准；之前章节中的“当前”均指该章节记录的观察时间。

## 1. 使用规则

这是本项目服务器、Git、AI 和 COS 访问的统一导航，不是密钥库、授权升级凭证、发布器替代品或新的任务检查点。

- 正式项目根目录：`/Users/yue/Desktop/牛马电子功德`。开始工作先读 `PROJECT_HOME.md`、本文件和 `WORK_PLAN.md` 最新检查点。
- 产品规则以 `docs/WORK_PLAN_BASIC_FREE_PAID_PACKS.zh-CN.md` 及用户后续确认、实际发布回执为准；旧全免费PRD不覆盖现行规则；任务状态仍使用官方目标及 `WORK_PLAN.md`。
- 本文只记录入口、角色、范围、凭据文件引用和证据位置，不保存 SecretId、SecretKey、API key、密码、cookie、验证码或签名下载 URL。
- 已有凭据和权限应优先复用。一次失败不能推导为用户没有授权，也不能据此反复要求用户提供密钥、登录或重建账户。
- 人类授权、云端策略、凭据挂载、应用可读性、功能开关和真实操作成功是不同层次，必须分别判断。
- 既有凭据已失效、控制台确需登录、或确实需要新增权限时，说明已核查的记录、失败操作和最小差异；不重复询问已确认事项。
- 接管者不得凭本文扩大到其他项目、未经授权的 IAM 修改、付款、数据导出或系统权限绕过。

## 2. 服务器与部署

| 项目 | 已登记入口或范围 |
| --- | --- |
| 服务器 | SSH 批准别名 `ace-zqscreen-dev`；不猜地址、账号或替代凭据 |
| API 发布 | `/Users/yue/.local/bin/deploy-gongde-api`；专用部署身份及固定受管命令 |
| 静态官网发布 | `/Users/yue/.local/bin/deploy-gongde`；专用网站归档入口 |
| 公共下载历史发布入口 | `/Users/yue/.local/bin/publish-gongde-downloads`；其固定制品合同可能早于当前版本，不能假定可发布任意新对象 |
| 资产历史入口 | `/Users/yue/.local/bin/deploy-gongde-assets`；仅按现有合同操作 |
| 服务源码 | `services/gongde-payments`；包括历史订单及当前共创实现 |
| 正式网站 | `https://gongde.zqscreen.cn` |
| 国内安装包下载 | `https://download.gongde.zqscreen.cn` |
| API 受管状态根 | 服务器 `/var/lib/gongde-api-deploy`；不是任意写入目录 |
| 共享部署基础设施 | `/Users/yue/.codex/worktrees/8016/ACE天梯系统/deploy/production`；保持外部所有权，不复制成第二套部署工具 |

### 持久连接

复用以下已登记连接引用，统一使用 ControlMaster auto、ControlPersist 30m：

| 角色 | ControlPath |
| --- | --- |
| 已获授权的常规服务器操作 | `/Users/yue/.ssh/controlmasters/%C` |
| API 专用包装器 | `/Users/yue/.ssh/controlmasters/gongde-api/%C` |
| 静态站专用包装器 | `/tmp/gongde-deploy-ssh/%C` |

恢复后先读取访问说明与检查点，通过 `ssh -G` 核对批准配置、通过 `ssh -O check` 确认连接状态；不输出多余连接信息。连接消失不等于服务器权限消失。使用包装器时沿用其指定账号、密钥引用与控制目录；不得混用其他项目连接。

若存在仍在运行的终端/session，优先续接同一 session。同一个交互 SSH 会话的操作必须串行。未知结果的发布、迁移或写入不能直接重放，先查原命令结果与受管状态。

阻塞操作前记录不超过 60 秒的官方目标操作租约；完成持久工作块后更新现有检查点。不要新建项目看门狗或第二套任务登记系统。

### 最近已登记状态

2026-10-08 本轮原包装器状态成功返回：API 源归档摘要 `456a8bddd996d4236311597cd0ab8febb44d77fcb1e304a240d32d574c7edea8`，镜像 `sha256:15bb9929fa6478c0c0c01ef208a3a75832cf21ff9109c1249584e1399bb0ff25`，健康且无待恢复操作。这是该次观察，不是本次全免费 API 已部署的声明。

更改受管准入、迁移或运行配置时保持原锁、归档摘要校验、备份与回滚合同。只发布本项目，不能为整理资料中断桌球或智家服务。

## 3. Git、构建与安装包

本节表格保留 0.9.0 的历史交付引用。当前官网默认下载已提升为 0.9.2，见末尾发布检查点；不能把历史分支、提交或构建号当成当前来源。

| 项目 | 已登记事实 |
| --- | --- |
| GitHub 仓库 | `https://github.com/Mr-shanqiu/niuma-ELEC-gongde` |
| 本轮客户端分支 | `codex/free-distribution-090`；只描述本轮，不要求未来永久使用此分支 |
| 本轮客户端提交 | `601707b292bc3cf42ebe1fc43fb4dbb1c0847647` |
| Windows 构建 | Actions run `37780163623`，已成功；不等于安装后的用户 GUI 验收 |
| 版本发布 | `https://github.com/Mr-shanqiu/niuma-ELEC-gongde/releases/tag/v0.9.0` |

Git 凭据复用本机已有 Git/ GitHub CLI 的登录与凭据管理，禁止把 token 写入远程 URL、文档或命令。本文不记录或假定凭据提供者；遇到认证失败先检查错误与已有配置，不直接要求新 token。

只有明确授权 Git 操作时才检查或修改 Git。共享工作区使用精确文件清单提交，不使用 `git add -A`，不覆盖他人的改动，不自动提交 `.local-work`。

0.9.0 已在 GitHub 与国内公共 COS 发布两个安装包，精确版本、大小和摘要见：

- 服务端配置：`services/gongde-payments/src/free-distribution/installers.json`。
- 本地发布回执：`.local-work/candidates/free-090-deploy/client-cos-publication.json`。
- macOS 是 Apple Development 签名，不是 Developer ID，也没有公证；Windows 未签名。不得把构建成功描述为无系统提示或已获 SignPath 批准。

客户端发布成功不代表官网、后台、服务、迁移或免费分发开关均已更新。

## 4. AI 审核与相关服务凭据

| 用途 | 使用方式与边界 |
| --- | --- |
| 共创 AI 审核 | 项目独立“牛马审核”密钥；服务引用 `GONGDE_CREATOR_REVIEW_API_KEY_FILE`，不借用其他项目 AI key |
| AI 开关 | `GONGDE_CREATOR_AUTO_REVIEW_ENABLED`；开关、文件存在、应用可读、真实审核结果分别记录 |
| 已登记生产预算 | `GONGDE_CREATOR_REVIEW_DAILY_LIMIT=20`；旧文档中的 100 是示例，不是预算授权 |
| 包签名 | `GONGDE_PACK_SIGNING_KEY_FILE`；私钥只在服务内部使用，不进入官网、客户端、仓库或测试回执 |
| 管理登录 | `GONGDE_ADMIN_PASSWORD_FILE`、`GONGDE_ADMIN_SESSION_SECRET_FILE`；与创作者/下载者会话分离 |
| 数据库 | `GONGDE_MYSQL_PASSWORD_FILE`；不打印完整数据库 URL、连接配置或密码 |
| 短信 | 现有腾讯云短信专用配置及 `TENCENT_CLOUD_SECRET_ID_FILE` / `TENCENT_CLOUD_SECRET_KEY_FILE`；不能因此当作 COS 身份或其他项目短信授权 |

服务器 secret 采用固定只读文件挂载。当前已登记入口在降权前把允许的 secret 投影到容器 `/tmp/gongde-runtime-secrets/<环境变量名>`，归属应用 UID/GID 65532，权限 0400。

`docker exec` 的环境可能仍指向原 `/run/secrets`，不能假定它继承 PID1 修改后的环境；原挂载对降权应用不可读不等于密钥缺失。诊断时先核对既有运行时投影和应用 UID，禁止打印密钥值或整个环境。

2026-10-08 已登记：独立审核 key 投影可被应用读取，自动审核配置接入，日上限 20。实际模型标识、端点、视觉能力从受管配置及当前实现确认；不能从“DeepSeek”名称或文件路径推定模型版本。真实作品审核须有单独结果记录。

参考：`docs/CREATOR_AUTO_REVIEW.zh-CN.md` 的安全审核合同，以及 `WORK_PLAN.md` 的生产接入记录。旧配置示例与旧收费描述不得覆盖 PRD 1.1 和已登记预算。

## 5. COS 身份与范围

### 三种用途不能混为一谈

| 用途 | 已登记桶/配置 | 凭据引用 | 证据边界 |
| --- | --- | --- | --- |
| 公共安装包、官方展示/上架资料 | `gongde-download-1460392746`，`ap-shanghai` | `GONGDE_COS_SECRET_ID_FILE` / `GONGDE_COS_SECRET_KEY_FILE` | 已有公共发布能力；0.9.0 发布回读成功；不据此推定私有前缀权限 |
| 私有已签发下载包 | `gongde-paid-1460392746`，`ap-shanghai` | `GONGDE_PRIVATE_COS_SECRET_ID_FILE` / `GONGDE_PRIVATE_COS_SECRET_KEY_FILE` | 之前专门配置并完成私有上传/回读/签名传输；不是未处理过的空白权限 |
| 创作者原始/规范化源包 | 既有创作者私有存储配置，精确桶与前缀须从该角色已登记配置核对 | `GONGDE_CREATOR_COS_SECRET_ID_FILE` / `GONGDE_CREATOR_COS_SECRET_KEY_FILE` | 独立角色；不得因另一用途失败而借用此身份绕过限制 |

历史私有下载凭据由专用 `gongde-download-publisher` 身份按当时批准路径接入。该历史来源名称不表示与当前公共运行身份相同；是否同一身份必须核对已批准配置，不能仅凭名称判断。

私有配置固定为：

```text
GONGDE_PRIVATE_COS_MODE=enabled
GONGDE_PRIVATE_COS_BUCKET=gongde-paid-1460392746
GONGDE_PRIVATE_COS_REGION=ap-shanghai
GONGDE_PRIVATE_COS_SECRET_ID_FILE=/run/secrets/gongde_private_cos_secret_id
GONGDE_PRIVATE_COS_SECRET_KEY_FILE=/run/secrets/gongde_private_cos_secret_key
```

这是文件引用，不含凭据值；实际诊断使用已批准入口的应用投影。

### 之前已经完成的事项

- 2026-10-01 已准备并部署私有桶运行配置及两个独立只读 secret 挂载；当时不是要求用户再次提供腾讯云登录或创建新密钥。
- 后续已完成应用 UID 65532 下的真实合成对象 PUT、HEAD、私有对象 ACL、签名 GET 和匿名 GET 拒绝闭环；当时上传与下载均成功。
- 历史曾修正 SDK 对无桶策略的 404 语义判断，随后补充既有策略所需的对象 ACL 读取能力。不能把代码误判、SDK 语义或未知对象 HEAD 403 一概解释为无 COS 权限。
- 精确历史记录：`docs/RELEASE_2026-09-23.md` 中的私有 COS 接入/权限修正/验收章节；外部基础设施回执 `.../deploy/production/STATUS.md` 中“2026-10-01 20:56 功德私有 COS 专用配置协作检查点”及后续合成传输复验章节。该外部文件只作证据引用，不取得写入权限。

### 本轮新前缀的独立问题

- 历史已付费下载前缀为 `paid-batches/v1/`。新免费下载使用 `free-claims/v2/`，避免历史两天清理规则破坏七天重下载承诺。
- 2026-10-08，现有私有下载身份对固定自有合成样例 `free-claims/v2/release-090-readiness/ci-owned-synthetic.nmgpack` 的 PUT 返回 `AccessDenied` / HTTP 403；没有写入对象、没有修改 IAM。
- 回执：`.local-work/candidates/free-090-deploy/private-prefix-actual-object.json`。
- **该结果只证明这次请求被拒绝，不证明项目整体没有 COS 权限，也尚不能单独定位为 CAM 前缀限制。** 需核对真实身份、目标资源、请求动作（包括显式私有 ACL）、CAM 和桶策略中的允许/拒绝条件。
- 不存在对象的 HEAD 403 可能受列举权限及不存在语义影响，不能证明 PUT 被禁止或对象真实存在。
- 现有策略不允许查询桶生命周期/版本历史/列举，不意味着既有对象读写权限没有配置。不要为诊断方便申请全桶管理或账号管理员。

当前尚未封存 CAM 策略名称、策略 ID 和完整资源/动作列表的非秘密快照。找到既有授权记录或取得正常只读控制台访问后补登记真实引用，不能填猜测值。先核对原策略，只有确认存在差异再提出最小变更。

### 保留与隐私

私有包不能开放匿名读取；短时签名 URL 不写入日志、文档或 Git。新领取包按 PRD 首次签发后七天允许服务器重下载，链接最长五分钟，本地导入永久有效。

十四天清理须结合数据库引用、有效领取、未结举报及冻结材料保留条件；不是直接给整个桶套十四天生命周期。不要改变或删除历史 paid 前缀、源包与其他项目对象。

## 6. 遇到拒绝时的固定排查顺序

1. 查本文件、`WORK_PLAN.md` 和对应历史回执，确认已有授权及曾成功的范围。
2. 区分失败层：本机文件、SSH transport、受管入口、容器投影、应用 UID、SDK、云端策略或业务开关。
3. 核对正确角色、桶、地域、完整对象路径和具体 API 动作；不打印凭据或客户数据。
4. 对比旧成功操作与新请求的实际差异；缺对象的 HEAD、被拒绝的生命周期读取都不能代替 PUT 结论。
5. 在当前授权内优先读取已有非秘密配置、策略及回执；只做必要、有界的诊断，不反复试错、不扩展测试范围。
6. 若确认需要新增权限，记录最小动作/资源/角色、保留策略与回滚方式，再按云端变更边界执行；绝不申请泛化管理员权限作为修复。
7. 已授权变更完成后，只验收对应链路并记录结果，不重跑无关支付、短信或模型调用。

明确区分：`已授权`、`已配置`、`应用可读`、`针对性验证成功`、`已部署`。任何记录不得用其中一项替代其他项。

## 7. 后续维护

入口、角色、范围或凭据引用变更时同步更新本文，并在 `WORK_PLAN.md` 记录日期、责任任务、操作结果和下一步；保持同一套检查点。无需把密钥复制到本地作为“备份文档”。

新会话遇到已有权限问题，先查这份文档及证据，再判断是否需要用户配合。文档不能保证外部凭据永久有效，但应避免重复索取已处理的授权和混淆不同身份。

### 2026-10-08 补充：请求动作差异结果

现有私有身份读取桶 ACL 确认 owner-only 后，省略显式 ACL 请求头的同一自有合成对象 PUT 仍返回 AccessDenied403；没有写入对象或修改 IAM。这排除了“仅额外 ACL 请求动作造成拒绝”的解释，但尚未确定具体 CAM 资源/条件规则。回执 `.local-work/candidates/free-090-deploy/private-actions-receipt.json`。正常控制台仍需独立登录；不能将控制台未登录误述为服务端 COS 凭据不存在。

### 2026-10-08 补充：旧前缀正对照通过

同一既有私有身份、同一1368字节自有样例和同款SDK，在 `paid-batches/v1/db011cac79e57438e3d48c41cb79bc600eb9bb406babb262b6ea0821b447ce56.nmgpack` 单次上传、认证回读、内容摘要及owner-only对象ACL检查全部通过。只有新 `free-claims/v2/` 对象请求被拒，问题已收敛到对象资源范围/路径相关差异，不能说该身份失效或没有上传权限。完整CAM具体条款仍待正常只读核对，不推定策略名称。回执 `.local-work/candidates/free-090-deploy/private-old-prefix-control.json`。对象仅自有合成CI样例，不是客户订单交付，不列举或删除历史对象。

### 2026-10-08 补充：用户保存策略后的实测

已只读确认原策略为 `GongdePaidBatchPrivatePolicy`，ID `288245491`，当前修改前版本2，关联既有 `gongde-download-publisher` 用户。原桶动作仅 GetBucketACL/GetBucketPolicy；原对象动作 GetObject/PutObject/GetObjectACL/PutObjectACL/HeadObject，仅限 `paid-batches/v1/*`。策略用法及 JSON 来自正常 Chrome 控制台观察，不是推测。

用户明确报告已保存追加的新免费前缀策略。随后沿原私有运行身份及同一持久SSH，使用固定自有1368字节样例、显式private ACL，实际 `free-claims/v2/release-090-readiness/ci-owned-synthetic.nmgpack` PUT成功，认证GET字节摘要一致，桶与对象ACL均owner-only。回执 `.local-work/candidates/free-090-deploy/private-after-policy-save.json`。证明新路径上传/认证读取/私有性检查已生效，不表示所有新动作或全免费业务已上线；DeleteObject尚未实测。

桌面控制工具后来明确拒绝当前CAM编辑URL，已停止浏览器操作，未自行保存IAM修改或切换工具绕过。策略保存由用户完成。今后应先复用这一已确认范围，不再重新索取密钥或建桶。

## 2026-10-09 当前实际部署与权限结果

本节替代上文候选/待验证描述作为当前检查点，旧记录仍保留历史语义。

- API 正式 source `2d23d7eb8441490b3761bf91cda345db137e64bb347e13c10a922040717b4fc0`，image `sha256:c7a5fcce514e301032f92c2b3a6ebd9580f78bdb7a123617b16d66469c858617`。免费配置 ready=true，新收费关闭，原已付款履行路由保留。007/008/009 已由原迁移器实际执行；真实备份、隔离恢复及21张旧表保留通过。
- 官网/后台内容摘要 `b311257efe0dff9e56e4951327fb57a5aef66046ace482b1f86cb06649c97aec`，归档摘要 `19cfd41d482b6ce5999775afe11f494caf3ab3bd4c9470ed3f264d99a61cda45`。两者不同，静态发布器第二参数必须使用归档摘要，不能用文件名中的内容摘要。
- 静态发布器增加免费流程7个固定文件名，保留原归档安全、摘要、健康、回滚及旁路保护检查。仅服务器 `/usr/local/sbin/deploy-gongde-root` 已更新；共享 ACE 本地工具并未移动或修改。
- 私有桶新前缀 PUT、GET、桶/对象私有 ACL 及自有探针 DeleteObject/Head404 均已实际通过。使用原私有凭据和批准别名；不要求重新提供密钥、不重建桶、不切换公共安装产物身份。
- 新免费专用 secret 只在 `/var/lib/gongde-api-deploy/secrets/gongde_free_distribution_secret`，root600，映射容器 FILE 路径；不要记录值、复制到本机/Git，或使用旧付款/群码密钥替代。
- 正式网关 HTTP + 真实私有 COS 单包/双包领取已通过，原键幂等、权限不消耗、永久无导入到期、7天重下均已确认。不能将此称为浏览器 GUI 或用户验收。

### 后续确认

2026-10-09 已沿正常 HTTPS 把本地免费版提交 c9e42d6 推送到 `codex/free-distribution-090`。此前 GitHub 连接错误已恢复，不需要更换 Git 凭据或远端。

同日使用用户主动提供的旧 GD 权益，经正式网关与原认证头只读确认：旧官方权益仍有效，原账户两笔订单可查询，用户20260930原订单仍为FULFILLED。仅保存脱敏元数据；不在文档、Git或回执中保存权益码，不触发付款。没有把无授权403或不存在订单404称为成功履行。

## 2026-10-09 补记：当前官网、审核投影与真实作品投产

本节按主控已完成的真实投产事实更新当前状态；上文 image c7 与早期候选描述保留为历史记录。本次文档补记不代表重新执行发布或验收，不记录任何码值、手机号、cookie、签名 URL、密码或密钥值。

### 官网实际材料

- 当前官网 release：`/opt/zqscreen/app/releases/gongde-site-43fe1e5b2f01-20261008T194553Z-40842`。
- 实际 `creator.js` SHA-256：`867466e8e598b8ab583907e0b5c311f45c1e284966eaa01cd5347399983f0759`。
- `creator.html` 使用查询串 `creator.js?v=free-v2-20261009-867466e8`，对应上述实际脚本材料；不把查询串本身当成内容摘要或完整 GUI 验收。

### API 管理投影修正与镜像切换

API 源包仍为 `2d23d7eb8441490b3761bf91cda345db137e64bb347e13c10a922040717b4fc0`，未另行改变业务源包。仅 root 管理的 entrypoint 投影修正以下三项已启用审核设置：

```text
GONGDE_CREATOR_REVIEW_API_URL=https://api.deepseek.com/chat/completions
GONGDE_CREATOR_REVIEW_MODEL=deepseek-flash
GONGDE_CREATOR_REVIEW_SUPPORTS_IMAGES=true
```

- 旧 image：`sha256:c7a5fcce514e301032f92c2b3a6ebd9580f78bdb7a123617b16d66469c858617`。
- 当前新 image：`sha256:bc4522b17c1e69af7277c3602d4aa94bf22ecac0cd2143a93d1bcd376ad7f982`。
- 两镜像 compiled dist 清单摘要相同：`b4b4449f5794317c458a950176485b83030d13a0870b6c37a6e16c02ecb190c1`。这证明所登记编译材料清单一致，不表示两个镜像整体字节相同。
- 原 guarded switch 已成功，旧容器保留；本次没有 SQL、IAM 或密钥变更。原独立审核 key 与日限 20 继续复用，不重新索取凭据或扩大预算。
- 原 native receipts 继承其原产物与证据范围，不声称针对新 image 重跑客户端 GUI，也不把镜像切换成功当作双端安装验收。

### 真实共创与作者码领取结果

真实作品“下班按钮”，作品编号 `100024`，作者展示编号 `C100004`，已有正常用户上传与明确授权。实际 AI 自动审核结果为 `APPROVED`，attempts=1，decided=`2026-10-08T20:22:12.615Z`，作品已 `PUBLISHED`。有效贡献 N=1，作者码每批权限 maxItems=3；不是管理员造作者身份、合成探针或人工复核冒充 AI 通过。

该作者码在正常公开网页验证成功，领取状态为 `READY`；实际下载 2000931 bytes，SHA-256 `c9528e4422c3fe3646aed83c37d90f82cfadd64bf8562dfa7c12bd151bde17c0`。只登记作者/作品编号、状态、权限及文件摘要，不保存码值、登录信息或签名下载 URL。

因此真实生产投稿、授权、自动审核、发布、首次贡献及作者码领取已有上述可核对结果，不能再仅用此前 Mock 或合成供应商探针描述当前进度。Mac/Windows 真实 GUI 验收仍由主控继续收口；本节不宣布 GUI 验收或 PRD 全目标完成。

### 2026-10-09 Ego 后台正常登录恢复

用户明确授权后，已独立复用现有后台凭据完成 Ego 正常表单登录，并进入「共创审核与作品管理」。此前是浏览器后台会话未恢复，不是密码失效、服务器授权缺失或官网拒绝访问。

需要再次恢复时，先核对本文件与最新检查点；使用批准 SSH 别名、持久连接和当前 Gongde 容器配置中登记的 `GONGDE_ADMIN_USERNAME` / `GONGDE_ADMIN_PASSWORD_FILE`。仅在明确登录授权范围内，将既有凭据从已批准入口直接以内存交给本站正常登录表单；不打印密码，不复制到文档、临时文件或 Git，不重设密码，不使用用户电脑密码代替后台密码，不扩大服务器权限。

Ego 正常登录成功不解除其他浏览器工具已经明确给出的访问拒绝。本次没有重试被拒绝的 Chrome 电脑控制会话，也没有把登录成功当作管理业务全功能验收或双平台交付完成。

## 2026-10-10 0.9.1 发布检查点

- 国内安装文件及GitHub v0.9.1已正式发布，源码HEAD0159cbb0416e9814463b99580e372f1882c6d2ce。Git普通传输失败后，沿同一仓库既有gh授权的Git Data API上传，提交SHA与本地一致，分支为非强制快进；没有使用替代凭据或放宽网络安全。
- SSH使用批准别名ace-zqscreen-dev与常规ControlPath /Users/yue/.ssh/controlmasters/%C，ControlMaster auto、ControlPersist30m；本次受管配置覆盖启用成功。
- 当前服务镜像sha256:394f35bd5684d854bd446d8c7a955a1d8c8a3c1668188f255047416f444ca378；业务归档摘要仍2d23d7eb8441490b3761bf91cda345db137e64bb347e13c10a922040717b4fc0，编译业务不变。覆盖内容仅安装登记JSON。
- 登记JSON是非秘密公共数据，0644供UID65532读取。密钥依然沿用原权限及映射，不得连带更改。
- 当前就绪逻辑要求windows/macos各有0.9.0 perpetualCompatible记录；提升默认下载时应保留这些兼容条目。直接删除曾导致ready=false，已受管恢复。最终0.9.1在前，0.9.0标记历史回退；ready=true已实际确认。
- 本次未改共享ACE部署工具、旧公共对象、生产密钥、IAM、数据库或付费/短信/模型配置。发布记录及回退证据在.local-work/candidates/release-091-20261010/。
- Windows完整实机测试由用户发布后完成，未通过此次文件发布替代该验收。

## 2026-10-11 当前静态官网发布检查点

- 官网内容摘要更新为b2659f1eec33a53bee06267966af3070ea70e0d634e3915de0f115e6d64b698a；归档SHA256为1a3b464c616253c19bc168a7f5e84d04b58a5ec3265c5a6dee1f5cb6c77c4796。
- 以上一冻结43fe官网为基础，仅覆盖index.html、pack-player.js，用于Windows木鱼木棒裁切修复；其他静态内容、API镜像/配置及安装包不变。
- 原deploy-gongde包装器正式返回GONGDE_DEPLOY_OK，release=/opt/zqscreen/app/releases/gongde-site-b2659f1eec33-20261010T165240Z-3148818，rollback=not_needed。
- 批准别名ace-zqscreen-dev，原静态站专用身份及ControlPath /tmp/gongde-deploy-ssh/%C，auto/30m；未改密钥、IAM或共享部署工具。证据：.local-work/candidates/woodfish-web-fix-20261011/deploy-result.txt。
- 用户自行进行Windows Edge显示验收，本次没有代理该实机测试。

## 2026-10-11 短领取码发布后的当前服务绑定

- 当前 API 源包 9ce05ebfdb5bfda84427b06c215dc5caee971c68bd45766a18bd0714ab73ab21，镜像 sha256:c58171f5f63bb4ce22c49edff4b75bed16d6c8d0b0d139918c628d0cdb6ea157；此前源包2d23与镜像394f为保留的历史版本，不能再称为当前部署。
- 原 API 专用发布器因精确免费版本限制拒绝新包后，沿既有主控 owner 流程完成精确候选构建与原受管 switch；不修改发布器、不关闭版本准入或免费限制。免费交付与审核的 root 策略仅重新绑定这份已授权候选，其他字段及 secret 权限保持不变；旧策略备份在远端受管工作目录。
- 远端操作引用：/var/lib/gongde-api-deploy/short-code-release-20261011/owner.py，build/activate 结果与原策略备份在同目录。它是本次固定短码候选的 owner，不是通用发布器，不接受任意源包或镜像。不得重复激活未知结果；先查既有 activation-complete 回执和原发布器 status。
- 当前官网 tree 23ba6386b11569caf349484702af03e89cd80c22fe70beb28e08055deda8005d，静态发布器返回成功。证据：.local-work/candidates/short-code-deploy-20261011/。
- 领取码已改 GD 加六位数字，不接受旧格式；码明文仍只能由管理员或所属作者通过正常接口读取，不记在运维文档或日志。无本次新增原生/浏览器完整验收声明。

## 2026-10-11 0.9.2 发布与预览边界

以下是已有发布回执的归档，不代表重新测试、部署或变更权限。

- 官网默认 macOS 与 Windows 下载均为 0.9.2；配置 enabled=true、ready=true、maxItems=10。0.9.1 回退文件及两端 0.9.0 最低永久兼容记录继续保留，不得为提升默认版本删除最低兼容记录。
- macOS 正式文件 `niuma-merit-macos-0.9.2.dmg`，2872994 字节，SHA-256 `dbc8d72e41b33a9ab5b2e4f44b7e099fd15c6a9bd8bcb914682f1f97a0cd3fc7`。本机普通匿名 HTTPS 完整回读一致；Apple Development 签名，非 Developer ID，未公证。
- Windows 正式文件 `niuma-merit-windows-0.9.2-setup.exe`，3239118 字节，SHA-256 `79f85fb1a7e1d94de27bebf850561f726705a3e22143f08f4a95a29230272c25`。来源提交 `ad51bb018948edb76f3efc1213b44ed19af350e2`，Actions run `38143857784`，制品 `11703279500`，原生版本资源为 0.9.2.0。既有批准服务器普通匿名 HTTPS 完整回读一致；本机匿名下载曾超时，不把服务器回读描述为本机浏览器或 Windows GUI 验收。Windows 未签名，0.9.2 完整实机 GUI 验收未声明完成。
- API 仍使用稳定 R1e 源归档 `7cebd6d7babff37888977a088040ec413204553afa90c4f93cd2b378a03b4d46`，当前镜像 `sha256:7060b302652f489592d07a1ceb331d6b009e15d5ccc4e8e7766708ff7e3e3370`。本次只覆盖安装登记 JSON；56 个编译业务文件未改。登记摘要 `33f521140400fff88f56d86164addec8c64c86f86b551c1617f5260ca307a691`，compiled dist 清单摘要 `a3ea3bce3fae5ecf20f69bcc95e8c91afae16455339efa79fbe95e97e712eb8e`。
- 静态官网内容摘要 `7e012fc11ef35680746500af1c1873833e45a9b584b84d13d5aab18301f02877`，归档摘要 `bc16c4339d92174b39327d808fd2883875d5fbfbdefcbd9070971789ed030964`。当前静态 release 为 `/opt/zqscreen/app/releases/gongde-site-7e012fc11ef3-20261011T114856Z-405452`；安装登记发布没有重发静态官网。
- 安装包发布仍复用公共 COS 原身份和已授权路径，不修改 IAM、密钥权限、数据库、短信或审核日限。受管操作及原 activation 回执在 `/var/lib/gongde-api-deploy/mac092-installer-registry-20261011` 和 `/var/lib/gongde-api-deploy/win092-installer-registry-20261011`。这些是固定候选的已完成事务，不是通用发布入口；未知结果不得盲目重放。
- 计数核心以用户实际使用结果收口：输入权限有效时一直稳定。不再重复测试计数、重装客户端、调整 TCC 或借 UU 远控重跑。升级后的权限说明与计数逻辑缺陷是不同事项。
- 新增 R1f 预览并发未通过完整内容验收，已实际回退；失败的本地候选不得混入构建或发布。定位为源存储共享两槽直接拒绝与新增四路读取冲突，不是 COS 凭据缺失或需要扩大 IAM。修正仍待用户对已告知的新增缺陷作出决定，官网首屏速度目标尚未完成。

精确制品与证据见 `docs/RELEASE_0.9.2.zh-CN.md`、`.local-work/acceptance/quality-20261011/native-092-publication-receipt.json`、`.local-work/acceptance/quality-20261011/native-092-windows-server-readback.json` 及 `.local-work/handoffs/r1f-preview-read-saturation-20261011.md`。GitHub 0.9.2 已依据独立发布及读取回执确认公开并成为 latest，原安装包与国内交付一致；回执入口为 `.local-work/handoffs/native-092-github-20261011.md`。此次仅在独立分支绑定客户端源码和 README，未覆盖 main，也不代表默认分支已同步全部官网、后台与服务源码。执行进度只维护 `WORK_PLAN.md`。

## 2026-10-12 平台帮助与客户端 0.9.3 分发

- 新帮助页已通过原静态包装器部署，静态 tree `37cd723b2fd6eeaae24a3c2577936d2e3373dc7f8b4a497321082c13e5d9f835`；原始稳定页面保持，三个固定帮助文件名加入服务器静态受管合同，防护不变。
- 公共 COS 原身份仍有效。运行时秘密目录所有者为 UID/GID 65532、0700；执行发布辅助程序时使用 `docker exec -u 65532:65532` 的原应用读取身份，不能假定容器 UID 0 可读取，也不应更改秘密权限或要求重新提供密钥。
- 两份 0.9.3 原包上传及认证回读成功；公共清单摘要 `91cc83ce6eb8a1b8f0bb281b92dc78948198e05cb20a076ba97438c6a86b10eb`，旧 0.9.2/0.9.1 原包保留。
- 官网 v2 API 默认安装登记尚为 0.9.2；新登记准备脚本的替换范围错误在执行前被停止，等待修正确认。尚未产生新登记事务，不得盲目声称已激活或重放旧 0.9.2 事务。
- 制品身份、签名真实状态与回执见 `docs/RELEASE_0.9.3.zh-CN.md`。正式签名继续由用户负责，无新增证书、IAM、秘密权限或私有分发变更。

## 2026-10-12 默认客户端 0.9.3 切换完成

- 用户明确授权“切换”；已修正固定登记操作文件的 EXPECTED 绑定并完成 registry-only 构建与受管激活，不重放旧事务。
- 正式 v2 /installers 回读：Mac、Windows 默认均为 0.9.3，共八条记录，原六条旧记录全部保留。双平台默认制品大小和 SHA-256 与 0.9.3 原包一致。
- 源归档仍为 `7cebd6d7babff37888977a088040ec413204553afa90c4f93cd2b378a03b4d46`；当前镜像 `sha256:d9e45f95607a645efe0c02017c063425ffb674f087ccedbd44e13ce2851cc1de`，登记摘要 `a937853db82905af9e688c709714bd877e3f0665886a3b48156bfca9ae746774`。compiled dist 清单摘要 `a3ea3bce3fae5ecf20f69bcc95e8c91afae16455339efa79fbe95e97e712eb8e` 未变。
- 固定事务目录 `/var/lib/gongde-api-deploy/client093-installer-registry-20261012`；操作文件 `/var/lib/gongde-api-deploy/client093-installer-registry-owner-20261012.py`。这是已完成的固定事务，不是通用发布器，不得盲目重放。
- activation 返回 result=ok、previous_container_preserved=true；最终受管状态 pending=false。常规 SSH 复用 ace-zqscreen-dev、ControlPath /Users/yue/.ssh/controlmasters/%C、auto/30m。未改 IAM、密钥、数据库、短信预算或审核日限。
- 本机安装软件未替换，计数/导入及 Windows GUI 不重复测试；正式签名仍由用户处理，未夹带 R1f/R1g。事实及证据见 docs/RELEASE_0.9.3.zh-CN.md 与本次候选目录；执行检查点沿用 WORK_PLAN.md。

## 2026-10-15 方向1完整官网 UI 发布

用户批准后通过原静态发布包装器上线：tree `da6615938f3b975dd36b51ba76ed5d2121dc2710fb4d1f8c05c7f86ce5a93e7a`，archive SHA-256 `202fcc758dd926ab7a0092ff9f3526e22f338f801f97c4d0aebfbaf76060ed08`；release `/opt/zqscreen/app/releases/gongde-site-da6615938f3b-20261015T052123Z-2134915`，GONGDE_DEPLOY_OK，rollback=not_needed。以86c172368c65静态树为基线保留管理端，仅覆盖公共页面、必要前端行为及新视觉素材。API、数据库、客户端、IAM、网关合同和发布器均未修改。第一次配置管道退出255发生于切换之前，同一配置单独读取成功；原入口一次重试成功，不将首次失败推定为权限缺失。证据 `.local-work/candidates/ui-v4-production-20261015/publish-retry.log`。发布器必要健康检查通过，不等同于真实支付或完整浏览器验收。

## 2026-10-15 用户/Dot反馈统一发布
沿原 deploy-gongde 包装器成功发布13个官网文件覆盖，不改发布合同或权限。tree `5522e0952045ef4797703e5d2601822a5d9c09947b82f5d56e471cf4517e6ac0`，archive SHA256 `c01fc5199855f18ce94069504f9421285f90b49d8ef3573d24f91cf4b9041743`；release `/opt/zqscreen/app/releases/gongde-site-5522e0952045-20261015T063053Z-2197506`，GONGDE_DEPLOY_OK，rollback=not_needed。冻结基线为da6615938f3b，保留现有管理员/API/数据库/客户端。日志 `.local-work/candidates/ui-feedback-fixes-20261015/publish.log`，精确覆盖与摘要见同目录candidate.json。已统一FAQ/隐私规则、中文支付状态/路线提示、分享复制反馈、图库文字、安装标题、基础木鱼免费卡片；未进行额外产品验收，不据此声明支付回调或客户端下载复测通过。

## 2026-10-15 渐进式下载旅程上线
静态tree `53867df05803dce9b7fbd5c5b5c7e1792095892fc6accfe34c8161cd37173ffa`；archive SHA256 `646291c3755c383175b19f0e828cfbb070c874f8b58409f6460f4aa910dc355b`；release `/opt/zqscreen/app/releases/gongde-site-53867df05803-20261015T085820Z-2329899`。既有deploy-gongde返回GONGDE_DEPLOY_OK、退出0、无需回滚。基于5522e095静态树覆盖11个官网文件，含首页确认弹窗、精简付款/群码页、下载文件定位提示与获批标题状态修正；原下载与付款保护保留，未更改服务端或客户端。精确候选与发布日志位于 `.local-work/candidates/journey-production-20261015/`。没有本轮真实下载或付款复测声明。

## 2026-10-15 旧待付款订单恢复修复发布
当前API源包 `b4798b046d9126aab79a0af3f989a5b8ca816900d95cb43674454848b82ba9fa`，镜像 `sha256:2a5f9e06882f73e13110d823a3b43918eed8f9774bfa3abaa710cd40b4f76220`；受管状态健康且无pending。以原1fde8a14为基线仅覆盖三个TS文件，无迁移。固定owner事务 `/var/lib/gongde-api-deploy/download-recovery-fixed-20261015` 已完成构建、激活，原容器保留；事务不是任意部署入口，不重复激活。只增本次源包+镜像绑定，保留原投影、策略、锁与回滚。
官网tree `aab026d5a6be04c69b3eca9babaeea38343d4933ac83d6f0d441ffaa3ca5a82d`、archive SHA256 `258da11445a8e9fc382eed462a58bf182acd83270193209ae1bf0be488a8af73`；原静态包装器成功，release `/opt/zqscreen/app/releases/gongde-site-aab026d5a6be-20261015T095811Z-2384782`，无需回滚。付款到期提示、同单入口恢复与渠道关闭同步已上线。资料 `.local-work/candidates/order-recovery-20261015/`。本地15项检查及线上配置/脚本一致性通过，真实付款和Dot旧单浏览器复测未执行。

## 2026-10-15 官网静态性能与当前系统安装包预取
静态tree `fdbb1e5179ff353f1a25d5f7e410a85311bc7387535fd282a6afc99bffcba13e`，archive SHA256 `b559a72b289b792a8b399a50d06f1125b21a34f291f3e2f6a225b5fb0d2e606d`，release `/opt/zqscreen/app/releases/gongde-site-fdbb1e5179ff-20261015T153456Z-2685274`；原deploy-gongde成功，无需回滚。复用现有固定Caddy策略5f0fb72d，不修改发布器或缓存规则：公开JS/CSS进入assets/runtime/<64hex>/，新WebP进入assets/previews/public/<64hex>/，HTML继续重验证。runtime版本器现纳入V4/journey子目录并统一模块导入，发布应继续调用scripts/version-website-assets.mjs，不能手工发根目录脚本而漏掉版本目录。
下载页依据OS仅预取一个当前安装包；通过原公开登记的字节数/SHA和浏览器SRI校验，预取完成后在用户点击时保存缓存Blob；未完成/失败仍使用原同源附件链接。免费公开安装包的该逻辑不适用于付费或群码形象包，不更改其已验收下载机制。未来提升默认客户端版本时应同步更新download-onboarding.js的固定映射，不能借旧版路径预取新登记包。
API仍为b4798b04/2a5f9e06，安装包0.9.3原字节与签名保持。未开CDN、未改COS/IAM。材料.local-work/candidates/web-performance-20261015/；10项合成浏览器检查通过，原生安装与真实支付未执行。

## 2026-10-16 暴富按钮与下载量排序发布
已沿原受管流程发布，API源f76c8778c40ad8ae3cc7502c84b644393afbb3575200898dbf567597ecde7dd9、image sha256:8c72bf85db8ab344c75306b9159fa5462167328e6609027ecfd773432f206235；官网tree60d1ae7ceb795f5959f338c1447de476d0311be6f029d7f90149b11bba472d79、archiveSHA9afbe74c3670208bf0e8b18515ce0508095691a0b5873dd0970ed9473fb570c3，原静态包装器成功，无需回滚。固定事务位于/var/lib/gongde-api-deploy/wealth-ranking-20261016，保留原锁、前序绑定、策略备份及旧容器；不得重放已完成操作。
官方新增100025（official.wealth-button）；资产release08dadf86d74855189c2e456a1f97b3f43ea833a352c075b3b6987a06e7bfe365，旧19目录未改。服务器Gongde专用资产合同和本地prepare只追加wealth-button映射，未修改ACE共享部署工具或密钥/IAM。上架沿既有COS角色与编号分配器，原6个下架项不恢复。
排序采用现有数据库的已签发群码批次及已履行付款明细只读累计，不检测客户端保存、不重复计入下载重试。没有迁移或新埋点。客户端0.9.3原字节不变；未重跑浏览器、付款或客户端验收。详细发布回执见WORK_PLAN.md及.local-work/candidates/baofu-publish-ranking-20261016/。

## 2026-10-16 初始排序与新品三天展示
当前API源470b9f2da2b395af36f11c05aa0995d926e2dad9c4837d4777b3cc6a4278de0b、image sha256:9791376577392b7a7144b094674a95a40dc3ecc169a6fb58f5c361d8e565e6e3；原owner受管激活成功并保留前驱f76c8778容器，无迁移。唯一固定事务/var/lib/gongde-api-deploy/catalog-ordering-20261016，已完成，不得重放。保留原发布锁、秘密投影、精确源/镜像策略和回滚，非通用新发布入口。
COS appearance-packs/catalog-state.json在既有上架写入流程中增补firstPublishedAt映射，沿用原凭据/路径，无新密钥或IAM；历史暴富日期承接上一次独立新增的真实updatedAt，不批量赋予旧作品新品资格。默认排序新品展示72小时从第三位起，过期自动退出；木鱼首位。静态版本60d1ae7c及原客户端0.9.3不变。详情及回执在WORK_PLAN.md与.local-work/candidates/catalog-ordering-20261016/，无新增产品验收通过声明。

## 2026-10-16 图库刷新连续性上线
原静态包装器部署成功，tree dfdf84a2fd1d498f078398f542ced9a510a1cf897133651c004ca64deb0757fc；archive SHA256 57d1b83b0c55d7ef32ace82e01a792a9386c9628597f5e3e633c6a3baa7545ff；release /opt/zqscreen/app/releases/gongde-site-dfdf84a2fd1d-20261015T182145Z-2837519，rollback=not_needed。沿现有runtime内容摘要机制，仅覆盖首页、图库脚本、V4样式三个源文件，保留管理端和其余静态内容。缓存仅本机公开展示数据，不落权益码/订单/下载凭据；最新状态未确认时不允许缓存卡片新增选择。未改变IAM、COS、API或客户端，也未执行新产品验收。材料.local-work/candidates/gallery-continuity-20261016/，不得重放旧API owner事务。

## 2026-10-16 Windows 项目会话通信入口
牛马Mac主控019fe783-0713-7e70-8a68-ae2ff3bc0966对应Windows项目会话01a140af-26bd-7e73-ace9-4e540790a73e，目录C:\Users\s1582\Documents\Codex\2026-10-16\niuma-win。整机主控为01a14054-11cf-7f32-831f-cc26affc4365；项目会话不接管整机设置、权限和软件安装。
接入完整说明在/Users/yue/Library/Application Support/MacWinTaskBridge/项目接入说明.txt。使用原dispatch.py --project niuma及唯一大写任务编号和UTF-8说明文件，必须先有用户对应任务授权；不要重复派发unknown/submitting任务。回执直接返回牛马Mac主控，仅是结果通知，不自动授权新操作或互相无限发信。
只读核验沿ssh -F /Users/yue/.ssh/windows-nearby.conf -o BatchMode=yes win-nearby；精确查找已知threadId的UTF8会话JSONL，只提取当前任务结果，不读auth或无关会话。共享桌面/浏览器串行，能力另行验收。NIUMA-LINK-20261016-A由本机监控助手已派发；当前会话身份/目录已只读核对，终态与回执唤醒等待匹配结果，未宣称产品或桌面验收通过。

### Windows 通信验收终态及目录注意（2026-10-16）
NIUMA-LINK-20261016-A已完成端到端通信核验：回执直接进入本Mac主控并在新一轮处理，SSH读取对应Windows会话找到匹配任务完成正文，不再处于仅派发或queued的未确认状态。浏览器/桌面/产品能力没有随之验收。
登记的牛马独立cwd与任务实际cwd不一致：元数据为C:\Users\s1582\Documents\Codex\2026-10-16\niuma-win，完成正文报告实际为C:\Users\s1582\Documents\Codex。后续派发必须在任务中明确工作目录并要求实际执行时指定，不能依赖会话标签或元数据宣称目录隔离；本轮没有改配置或补派任务。完整证据与边界见WORK_PLAN.md最新记录。

## 2026-10-16 暴富包发行者与附件提示修复发布
沿原受管流程完成：资产release34d7248b5dc98f7d591cb9920d3a8ff3bd24c2f42101de8497b40662e813858a，仅暴富manifest改为NiuMa Merit/1.0.1，旧发布及已签发包不动；不放宽客户端校验、不改素材发布器。API源66d6372dea067d3dbc46308615d5249a733b8d4f4ec265e8949bad5645738454，镜像sha256:1e99b06d435f71bbc9780123755043faeb06520fb359703bd5a7410c150d7edc，仅两文件附件命名一致性改动，无迁移。固定owner/策略目录pack-metadata-fix-20261016，保留前驱和回滚，已完成不可重放。
官网tree57e82afa9a9d7e052fe95779a498fdbad04fde8408a95f6ce68a4525c6e99b06，archiveSHAc8e02251965b19dc857b4b882b4dacd55a27f2823c8e9e667aec9172e92810c7，原静态包装器成功无需回滚；材料.local-work/candidates/pack-metadata-fix-20261016/。不含客户端新功能二进制，当前正式安装登记0.9.3保持，真实Windows修复后导入尚未复测。秘密/IAM/COS策略/原数据库及其他项目不变，未执行Git。

## 2026-10-17 双端0.9.4官网下载更新
Mac/Windows当前公开登记均为0.9.4。Mac DMG3053803bytes，SHA256 c917fe932be950e9fa1ee518e3c88cc745c8e22a5bef14122b225d976ee3eb77；Windows安装器3185821bytes，SHA256 a44d544300c385b65c4bb4da0fc70d263cce473051836d86204ba67dd76b8f55，Actions38995668038，源02443c35be6554f13b5ee68dfdf81a182acd4241。真实签名状态Mac ad-hoc/未公证、Windows未签名，未冒充可信商业签名。静态tree704d1d9f，API registry-only image8bcfde3f，编译业务dist未变，原API源引用66d6372d保持。固定owner /var/lib/gongde-api-deploy/client094-installer-registry-owner-20261017.py及原plan提供专用回滚（保留旧容器与镜像）。本地回执 .local-work/candidates/release-094-registry-20261017/activation-result.json 及 public-installers-after.json；COS发布回执 .local-work/candidates/mac-stability-094-20261017/publication.json。未替换正在运行的实验应用。

## 2026-10-17 下班按钮官方来源恢复
用户明确要求100024改为官方而非共创上架。该编号现绑定official.offwork-button，保留created_at及原首次上架时间，历史领取/订单和原投稿档案不删除。资产release5cd7e149a6be255eb17f5f9318369218b95ed3b46d4126642c8db76d3f3b8550；最终API源78e50c5302c49a5fe9907e08df88d6dddbfa6305333ca415fe427bdb483bbfb0，image143f76869ee6fc59687ad664141667e0cc54532b24b9d3e176c6fd3fccfc58e0。0.9.4双端登记十项摘要aa87787a保持。最终owner /var/lib/gongde-api-deploy/offwork-official-20261017-api-signer-owner.py，原容器/源/素材保留，沿受管回滚；编号与COS状态回退须同时参考单独before回执，不能只回退API当作整项撤销。材料 .local-work/candidates/offwork-official-20261017/，最终公开100024为official且canClaim=true，官方public preview ready。共创投稿仍暂停，未改客户端或进行真实付款。

## 2026-10-18 关闭安装包自动预取
用户要求仅在主动点击后下载安装包。静态tree `cdd254a4a658b0fa3793865ce51d47786d7f5b53e5ae8d2fc9fbb5112947c4af`，archiveSHA `28f44621adaf83c5e660576b07c60da7e4373710de509653aeca7d08f2d0608f`；原deploy-gongde包装器成功，release `/opt/zqscreen/app/releases/gongde-site-cdd254a4a658-20261018T130709Z-2245491`，无需回滚。以原704d1d9f冻结归档仅覆盖download-onboarding.js，通过既有runtime版本器生成cc96e3b3并保留前两版；管理站及其他源文件不变。Mac/Windows浏览器各加载观察10秒均无安装包请求，主动点击Windows原附件链接下载与正式0.9.4原包大小/SHA一致。移除的是预取及其SRI/Blob缓存路径，版本/大小/SHA元数据和正常附件下载保留。公开安装包、API、COS、CDN、DNS、权限均未改。材料 `.local-work/candidates/disable-installer-prefetch-20261018/`。


## 2026-10-19 牛马官网与下载接入华为云 CDN

官网 `gongde.zqscreen.cn` 与下载 `download.gongde.zqscreen.cn` 已分别接入中国大陆网站加速和文件下载加速。DNSPod 中只修改这两条默认线路为华为提供的 CNAME，TTL600；其余记录不变。旧值均为 A `124.222.44.169`，回退时只恢复这两条，保留当前服务器。

两份全时500GB/6个月资源包共176元，代金券全额抵扣、现金0；第一份已生效至2027-04-19，第二份2027-04-19起至2027-10-18。各包独立到期，未用流量不结转；耗尽或失效后遵循供应商按需规则。

正常回源保持 HTTPS/IP/HOST/SNI 对应原服务器。下载仍由网关反代原公共 COS 文件，安装包未迁移或替换。源站 immutable 缓存头透传，双端0.9.4摘要与原文件一致，重复下载及官网摘要静态资源均实测 CDN TCP_HIT。HTML保留重验证；`/api/*`在节点TTL0、强制缓存关闭、参数完整保留，领取/订单等接口继续 private,no-store。

官网API通过专用随机回源验证头认可CDN覆写的访客IP，其他直连继续使用peer，原应用代理白名单不变。实际验证：直连伪造IP忽略；正确回源验证值配非法IP按原应用规则拒绝；CDN覆写客户端伪造头后图库GET正常。网关只平滑更新牛马路由，未重启/替换任何容器。未来重建镜像为 `zqscreen-gateway:gongde-huawei-cdn-20261019`，两个既有release指针各自派生，旧目标完整保留。不要用共享源码的旧网关配置重建而覆盖本次变更。

证书复用现有两域名证书。CDN将 `/.well-known/acme-challenge` 单独回源HTTP80、精确HOST，保留Caddy自动续签验证链路，已用自有合成路径从CDN验证且清理临时路由。同步服务 `gongde-huawei-cdn-cert-sync.service` 和timer同名前缀已启用，每天两次检查；只在源证书变化时上传，校验证书域名、KEY匹配及有效期。首次运行成功，两域名专用身份实际同证书API写入与摘要回读通过。专用IAM身份 `gongde-cdn-cert-sync` 无控制台密码，权限仅两域名HTTPS更新及相关只读；不扩大到DNS、采购或其他项目。

服务代码/状态/回滚材料位于服务器 `/var/lib/gongde-api-deploy/huawei-cdn-20261019/`；独立云凭据只在 `/var/lib/gongde-api-deploy/secrets/gongde_huawei_cdn_cert_sync.json`，root600。回源验证值只在既有网关Caddy数据卷专用文件，文档不记录值。原Caddy证书KEY没有进入本机文件、日志或Git；一次性下载的专用云凭据已从本机私有系统临时目录清理。

继续维护沿批准 `ace-zqscreen-dev` 及原ControlMaster auto/30m，保持共享生产锁和牛马锁。同步故障先查看该服务的脱敏状态，不打印密钥或完整配置。若需业务回退，先恢复两条DNS的原A值，再在原事务内恢复牛马旧路由、Caddyfile/entrypoint及各自旧release指针；旧镜像/文件不删除。正式公开客户端、官网正文/教程和业务API镜像不变。完整接入证据、实际指针及操作边界见WORK_PLAN.md最新完成记录和本机CDN验收目录。


## 2026-10-19 Windows 0.9.4 正式签名包上线

Windows当前官网下载为3215176字节，SHA256 `323514c9cbafe8b48a4999a156bbebec5d922950e676e69c6a0c163d6616b3ac`，新不可变键 `niuma-merit-windows-0.9.4-signed-323514c9cbaf-setup.exe`。内外Authenticode签名同证书、SHA256/RFC3161核验已通过；附件显示中文正式文件名，原未签名对象与全部旧版本保留。Mac当前仍c917fe93/3053803字节，未冒充朋友待返还的Developer ID公证成品。

API源引用仍78e50c53，当前registry-only镜像 `sha256:c850a853adeeeea167ba9204958bee387fda7aa5c1150e20d8091ae308c4da02`；只更新一条Windows登记，三方compiled-dist清单SHA a7df7ac8保持。原受管锁、switch、配置投影、自动回退与前驱容器保留；静态官网仍cdd254a4，未发布后置的一键Mac教程。

服务器事务 `/var/lib/gongde-api-deploy/windows-signed-download-20261019` 与 `windows-signed-registry-20261019`；固定owner `/var/lib/gongde-api-deploy/windows-signed-registry-owner-20261019.py`，planSHA a2dfa217a0964280f186d601b1d883925c7dd8400dccde9196f3501ff61d171f。均已完成，不重放；需要回退时先沿此固定owner与原回执审核当前状态，不复用旧20261017事务。凭据继续按应用UID65532读取已有运行时投影，docker exec默认root在降权/无DAC能力容器中不一定可读，不改变密钥权限。

公开installers/config回读200、ready=true，公共下载清单与摘要同步且匿名回读一致，实际完整CDN下载与已签文件相同、后续TCP_HIT。用户签后下载安装流程由用户自行验收，不能把本次发布核验称为已完成GUI验收。完整回执见本机candidates/windows-signed-publish-094-20261019及WORK_PLAN最新检查点。


## 2026-10-20 Mac0.9.4/904.12未公证修复版上线

Mac官网下载现为5585870字节、SHA256 `1ed7c4ed8bd8c5b1817bc100c8e75c226a583f31879ebef5d68a0b2fdbad178b`，不可变键`niuma-merit-macos-0.9.4-90412-1ed7c4ed8bd8.dmg`。Universal2、ad-hoc本地临时签名，无Developer ID/苹果公证；当前下载卡片和一键安装图解已说明首次系统确认。Windows继续原签名323514c9包，旧版本对象保留，预取仍禁用。

API源引用78e50c53不变，当前registry-only image `sha256:4eaf762bedd4a0bd250ecede49905830bbc319d24da0a4f299b8d2eab1d204b1`，仅Mac一条登记改变，compiled-dist清单a7df7ac8不变。固定owner `/var/lib/gongde-api-deploy/macos-adhoc-registry-owner-20261020.py`，planSHA4a61eb68fabab12a0f99032fcae10f31e7040df135b8ecc24d4fea31d2bf786e；事务macos-adhoc-download-20261020、macos-adhoc-registry-20261020均完成，禁止重放。原准入/锁/状态投影/自动回退与前驱镜像保持。

静态站tree5bed32fa、归档SHA6818f651沿原包装器发布成功，完整release见WORK_PLAN；既有白名单、网关/CDN/DNS/证书不改。公开API/清单/完整DMG回读、CDN TCP_HIT、浏览器按钮及图解均通过。本次没有实际安装904.12或重启验收，不把发布验证写成功能实机通过。证据本机candidates/macos-adhoc-publish-094-20261020。

## 2026-10-20 Mac0.9.4/904.13 导入修复版上线

当前 Mac 官网默认下载为 5604167 字节、SHA-256 `ca633d1f3fc77882408f144667cd217ced4c4c237f8350c46b53ed2fec0024d2`，新不可变键 `niuma-merit-macos-0.9.4-90413-ca633d1f3fc7.dmg`。安装器、输入监控计数和异常形象包导入已在本机实测；异常包及时返回可读错误。仍为 Universal2、ad-hoc 本地签名、未获苹果公证。全新用户首次下载和系统重启后的自启动不属于这次实测结论。

只更新 Mac 一条安装登记和公开下载清单；Windows 已签名包继续使用原摘要 `323514c9cbaf`。新 registry-only 镜像 `sha256:45e1912b08ae6b5c2b0b9fe670125a488fd2ef2d0b2d07d77a4a36ecb28596e6`，业务编译产物未变，前驱容器保留。固定 owner `/var/lib/gongde-api-deploy/macos-importfix-registry-owner-20261020.py`，plan SHA-256 `474ce80f9e8442254a32e1359387e2e8f3bb385f52df33c576b9c1e052121dbc`；新对象与登记事务已完成，不得重放。静态官网从现有实时 API 读取下载登记，本次无需重新部署静态站；原 CDN/DNS/证书、预取设置及其他服务不变。回执见 `.local-work/candidates/macos-importfix-publish-094-20261020/PUBLICATION_COMPLETE.json`。

## 2026-10-20 官网四项功能/教程资源版本化

官网静态 tree `c81981cb240f90251a919c2ecd7c64dcfcac8763c668234cece99d8258c29f1b`，archive SHA `da07d675dd597f0bb19fad21d779654574f8a16c67880583e4b99f2f6a2de023`，沿原 deploy-gongde 成功发布，无需回滚。以此前已发布图片压缩归档为基线，home-feature.js/css、installation-guide.js/css 纳入现有内容版本目录，runtime `50824fc19c4558f7b4f32c45dbc22cb27b70e6370bf731cffef87a2dcdfb74d1`；源文件内容与预览、管理站保持原样。18页引用检查通过，公开四文件字节匹配且重复GET均TCP_HIT，首页功能切换及双系统教程翻页已在ego-browser验收。HTML保留no-cache，API、木鱼预览缓存策略、304、网关/CDN/DNS和客户端安装包未修改。材料 `.local-work/candidates/website-four-assets-versioning-20261020/PUBLICATION.json`。

## 2026-10-20 管理端群置顶公告精简

静态站 tree `14362f33c4450061c8650bb61c8c8bd9c52ef7f53076afa2c768ac71b9f0f0d8`，archive SHA `658696f6b5dd1be359b5403f6ea0ce81940e10637081f2395810946a28d61043`，原deploy-gongde发布成功。仅群置顶公告函数及对应admin入口/哈希bundle更新为四段短文；当期码和失效时间仍读取服务器快照，计算时区不变。公开入口/JS/CSS字节校验通过，动态格式检查通过；未进行已登录剪贴板按钮实测。公众站runtime50824fc1保持，API、群码轮换/领取、安装包与所有配置未改。材料 `.local-work/candidates/admin-group-announcement-20261020/PUBLICATION.json`。

## 2026-10-21 Mac904.14 正式发布

官网Mac默认下载已更新为Developer ID签名、苹果公证的904.14（Universal2），对象 `niuma-merit-macos-0.9.4-90414-notarized-68b0aeeedd2f.dmg`，5567360字节，SHA256 `68b0aeeedd2f2fe813a4a8289cae006e7cf50abebc9f2ccc9e08950650d65ad3`。旧Mac对象保留，Windows默认仍为323514c9已签名版。本次沿原COS运行身份、受管registry-only激活及静态发布器完成，未修改共享网关/CDN配置。公开清单/API、CDN实际回读、浏览器下载通过。回执见 `.local-work/candidates/macos-notarized-publish-90414-20261021/PUBLICATION_COMPLETE.json`。本节替代此前Mac未公证状态；未同步GitHub Releases。

## 2026-10-21 项目转移导航

当前交接快照见 [PROJECT_HANDOFF.zh-CN.md](PROJECT_HANDOFF.zh-CN.md)。正式Mac904.14签名公证已发布，木鱼预览与内容寻址也已部署（treeb9acc5a9/runtimebd91ac6d）；不要从本文件早期章节恢复旧的0.9.0/免费共创或未公证状态。转移Git源码不转移浏览器登录、SSH/Keychain或生产准入；外部ACE部署工具保持原所有权。本轮仅整理文档，未迁移凭据、修改服务器或重复核验线上。

### 缓存上线状态纠正

按用户提示只读核对公网与源站：当前站点容器镜像为gongde-site:b9acc5a9，浏览器runtime为bd91ac6d。此前ca10ac1e/2475a0c1现为前驱版本。缓存第一步已完成，不能因旧IMPLEMENTATION或交接快照再次部署；状态证据见 `.local-work/acceptance/cdn-cache-status-20261021/`。API及双端安装包绑定仍沿用原发布事实。本次仅核对与更正文档。
