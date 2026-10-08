# 牛马电子功德：访问、凭据引用与运维入口

更新日期：2026-10-08。所有日期与结果均是对应记录的观察时间，不代表永久有效。

## 1. 使用规则

这是本项目服务器、Git、AI 和 COS 访问的统一导航，不是密钥库、授权升级凭证、发布器替代品或新的任务检查点。

- 正式项目根目录：`/Users/yue/Desktop/牛马电子功德`。开始工作先读 `PROJECT_HOME.md`、本文件和 `WORK_PLAN.md` 最新检查点。
- 产品规则由 `docs/PRD_FREE_DOWNLOAD_AND_CO_CREATION.zh-CN.md` 决定；任务状态仍使用官方目标及 `WORK_PLAN.md`。
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
