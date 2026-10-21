# 牛马电子功德项目交接说明

更新日期：2026-10-21，时区 Asia/Shanghai。交接方为当前 Codex 会话，接手方为用户指定的新会话、工具或维护者。

本次交接的当前状态是：**双端0.9.4客户端已正式提供下载，Mac904.14已签名并公证；木鱼预览几何修正和图片内容寻址也已部署，公网与源站均确认使用b9acc5a9/runtimebd91ac6d。** 用户最新要求是更新交接文档，不是发布缓存优化候选，也不是搬迁仓库、服务器或凭据。

本说明是交接快照，不另建目标登记或执行检查点。项目入口仍是 `PROJECT_HOME.md`，持续执行记录仍是 `WORK_PLAN.md`，访问边界仍是 `AGENTS.md` 和访问运维文档。历史记录中的“当前”按其条目日期理解。

## 接手后先读什么

1. [项目总入口](/Users/yue/Desktop/牛马电子功德/PROJECT_HOME.md)和[执行约束](/Users/yue/Desktop/牛马电子功德/AGENTS.md)。
2. 本文中的“当前正式交付”“已发布的木鱼预览和缓存优化”和“下一动作”。
3. [访问与运维](/Users/yue/Desktop/牛马电子功德/docs/PROJECT_ACCESS_AND_OPERATIONS.zh-CN.md)及[执行记录末尾](/Users/yue/Desktop/牛马电子功德/WORK_PLAN.md)。不必重读全部历史对话。
4. 要继续缓存优化时，再读候选目录的 `IMPLEMENTATION.md`、`EXEC-PLAN.md` 和 `PLAN.md`。

已完成、已裁定事项直接复用结果。不要因为换会话而重新验收客户端、重复查签名、重做压图、重发站点或恢复已取消的产品方向。

## 项目位置和工作区状态

唯一正式根目录是 `/Users/yue/Desktop/牛马电子功德`。`/Users/yue/Documents/ChatGPT/牛马电子功德` 是历史兼容链接，不是另一个仓库。

| 内容 | 根目录下的位置 |
| --- | --- |
| 原生客户端 | `src/macos/`、`src/windows/`、`src/`共享逻辑 |
| 客户端构建与安装 | `scripts/`、`installer/`、`.github/workflows/` |
| 公开官网 | `website/` |
| 管理端 | `admin-console/` |
| 订单、群码、签包及交付服务 | `services/gongde-payments/` |
| 形象及文案素材 | `assets/`、`imports/` |
| 产品规则和正式说明 | `docs/`、`PRODUCT_ROADMAP.md` |
| 本机候选、验收和交接证据 | `.local-work/`，归属见 `.local-work/INDEX.md` |
| 冻结安装包和静态站归档 | `dist/`及已登记的 `.local-work/candidates/` |

仓库地址：<https://github.com/Mr-shanqiu/niuma-ELEC-gongde>。

本次文档编辑前只读记录：分支 `codex/free-distribution-090`，HEAD `0159cbb0416e9814463b99580e372f1882c6d2ce`；有101条已跟踪变更、141条未跟踪条目。目录条目不等于文件数量，文档更新后数量可能变化。

**Git当前提交不是完整的本机状态，也不是线上部署内容的完整副本。** 本地存在其他协作方的未提交成果，不能 reset、clean、全量暂存或用远端覆盖。本次没有提交、推送、改分支、改仓库公开性或同步GitHub Releases。

## 当前产品规则

产品规则正文见 [基础免费与扩展形象双路线](/Users/yue/Desktop/牛马电子功德/docs/WORK_PLAN_BASIC_FREE_PAID_PACKS.zh-CN.md)。当前适用规则如下：

- 基础客户端和内置木鱼免费，无需账号、付款或群码。
- 扩展形象每个1元，每批最多10个不同形象，没有套餐或封顶价；也可以使用当期有效官方群码免费领取。
- 群码为GD加6位数字，不区分大小写，当前周期仍为72小时。可重复领取，不扣共享额度。不要把历史示例码写成当前有效码，读取管理端当期快照。
- 付款购买本次下载，不提供面向用户的历史订单找回和永久免费重新下载权益；当前交易故障恢复与服务端保留交付文件，不等于历史订单权益。
- 当前已下载的官方形象包是长期有效本地文件，可保存、重复导入和离线使用，未绑定领取人的电脑。原文件技术上可以转发给别人导入。
- 单形象文件为 `.nmgpack`，批量为 `.nmgpacks`，双击导入，不需要解压。文案包为 `.nmgtext`。
- 暂停新的公开共创、投稿和作者权益扩展；共创群可讨论建议与AI学习，但不能因此恢复投稿、结算、分成等功能。
- 客户端完全本地运行，不加入账户、付款校验、联网授权、遥测或自动更新。系统输入权限用于全局活动计数，不宣传成系统只授予“次数权限”。

以下事项**仅讨论，未授权实施**：群码改七天、形象包下载后24小时导入失效、恢复付费历史订单重新下载、仓库由公开改私有。用户曾提出“过期报损坏”，本会话建议应真实提示过期，不能把该讨论当作已确定需求。

## 当前正式交付

### 官网和服务

| 项 | 最后已核实发布状态 |
| --- | --- |
| 官网 | <https://gongde.zqscreen.cn/> |
| 客户端下载页 | <https://gongde.zqscreen.cn/download.html> |
| 公开安装包域名 | `https://download.gongde.zqscreen.cn`，公共COS加华为云CDN |
| 静态站tree | `b9acc5a9a5d0729ed94084b50ef0540ff90e02831da46f0852d4ada15d4552cd` |
| 该tree本机对应归档SHA256 | `aa85303b2dabf4489abfc8345fb4fddbd9a576594c300eff53cc86a993917310` |
| 浏览器runtime | `bd91ac6d61f0e2ae7405ddb5f76051318b56b4b5f5e9d752aebe638a6f7c40cf` |
| API镜像 | `sha256:a92e406aa9d5e999ced4478a715da950b755c835cc1d00facba5448fe8879061` |
| API源发布标识 | `78e50c5302c49a5fe9907e08df88d6dddbfa6305333ca415fe427bdb483bbfb0` |

API最近切换只增加Mac安装包登记的镜像层，编译业务dist保持原字节，不是重新部署全部业务逻辑。Mac/API状态沿用已有发布回执。缓存优化状态因用户指出交接记载过期，已只读核对公网首页及源站实际运行镜像；没有重新部署或重跑完整验收。

完整发布回执：[Mac904.14发布完成](/Users/yue/Desktop/牛马电子功德/.local-work/candidates/macos-notarized-publish-90414-20261021/PUBLICATION_COMPLETE.json)。

### Mac正式包

- 版本0.9.4，build904.14，Intel与Apple Silicon双架构。
- 对象名 `niuma-merit-macos-0.9.4-90414-notarized-68b0aeeedd2f.dmg`。
- 大小5,567,360字节。
- SHA256：`68b0aeeedd2f2fe813a4a8289cae006e7cf50abebc9f2ccc9e08950650d65ad3`。
- 客户端Bundle ID `cn.niuma.merit`，安装器 `cn.niuma.merit.installer`。
- 客户端、外层安装器和DMG均有Developer ID签名，团队标识 `PJ5GZS2USL`；客户端及最终DMG分别完成公证并装订票据。
- 流程是DMG内双击一键安装器，安装并打开应用，随后按提示处理输入监控；不提供拖拽版第二套安装方案。
- macOS13及以上使用 `SMAppService.mainAppService`，旧系统保留LaunchAgent兼容路径；默认申请自启动，右键菜单可以关闭。已验证尊重系统中的关闭状态，不应每次启动强行重开。
- 用户已确认菜单开关、开关状态保留、键鼠计数，以及实际重启后的自启动。签后成品已独立核对签名、票据、Gatekeeper和原始产品内容，并实际从官网按钮下载比对摘要；不把该项说成全新设备安装实测。

实际签后成品及本机核对记录位于 `.local-work/acceptance/macos-signing-return-90414-20261021/`；发布下载证据位于同名 `macos-notarized-publish-90414-20261021/` 目录。桌面保留 `牛马电子功德-macOS-0.9.4-904.14-已公证.dmg`。

朋友持有签名账号及私钥，本项目没有因此取得其开发者凭据。对现成程序签名、公证不需要源码。若以后重新送签，沿已确认的两轮流程先处理内层客户端，再处理最终安装包；原904.11送签目录不能代替904.14。

### Windows正式包

- 版本0.9.4，x64；客户端和安装器均已签名。
- 对象名 `niuma-merit-windows-0.9.4-signed-323514c9cbaf-setup.exe`。
- 大小3,215,176字节。
- SHA256：`323514c9cbafe8b48a4999a156bbebec5d922950e676e69c6a0c163d6616b3ac`。
- 回执 `.local-work/candidates/windows-signed-publish-094-20261019/PUBLICATION_COMPLETE.json`；该历史回执中的用户安装pending是当时状态，不应自动触发新一轮验收。
- 朋友机器旧形象导入冲突经备份隔离旧形象目录后已恢复，用户确认批量导入和“暴富”删除正常，本次事件结案；未为此修改或重签Windows客户端。

旧包和回退产物保留。`dist/current/`及无构建号的 `dist/`历史文件名不能作为当前正式版判断依据。

## 已完成并应复用的成果

| 事项 | 当前结论和证据入口 |
| --- | --- |
| Mac异常形象包导入死锁、英文错误提示 | 904.13已修，904.14延续；正常与异常包验收结论复用，不归因为此前WindowServer崩溃 |
| Mac自启动接口与重启 | 904.14已完成，见 `acceptance/macos-login-startup-20261020/USER_MANUAL_ACCEPTANCE.json` |
| Mac旧版卡顿观察 | 用户曾结束观察，后来旧版本运行时又出现WindowServer崩溃；不要把它写成操作系统级根因已彻底证明。当前版本计数和自启动结案，不重启旧版复测 |
| 官方文案与气泡 | 中英文各800条已纳入；展示15秒、同条七天不重复、取消每天五条上限；保留本地文案包导入，未做新一轮文案审稿 |
| 官网图片压缩和图标拆分 | 已发布，见 `candidates/image-compress-20261020/PUBLICATION.json` |
| 四个JS/CSS内容版本化 | 已发布，见 `candidates/website-four-assets-versioning-20261020/PUBLICATION.json` |
| 管理端短群公告 | 已发布，顺序为权益码、失效时间、官网链接、未及时更新请@群主，见 `candidates/admin-group-announcement-20261020/PUBLICATION.json` |
| 群码领取恢复和退出入口 | 已由协作方实施发布，见 `candidates/claim-flow-fix-20261020/PUBLICATION.json`；不要沿用早期“未实施”条目 |
| 官网抖音群入口、复制群号 | 已由协作方发布，见 `candidates/douyin-group-entry-20261020/PUBLICATION.json`；原“只记录不接入”已被后续实施替代 |
| 首页功能卡及彩蛋文案 | 已发布，见 `candidates/home-cards-20261020/PUBLICATION-easter-copy.json` |
| 桌面整理 | 保留项目与当前公证DMG；送签ZIP及形象包归入 `archive/desktop-gongde-cleanup-20261021/` |

上表 `.local-work/` 内路径以该目录为基准。抖音群号为117093216342，群码与网页权益领取码是两种不同东西；不要把用户当期领取码公开到官网。二维码原图和裁剪素材在 `handoffs/douyin-group-qr-20261020/`。用户已在后续反馈中确认二维码可识别；群号搜索入群仍不要擅自承诺。

## 已发布的木鱼预览和缓存优化

目录：[cdn-cache-20261021](/Users/yue/Desktop/牛马电子功德/.local-work/candidates/cdn-cache-20261021)。

- `PLAN.md`：原性能方案与第九节独立复核。原新增Caddy规则、把source-map顺带覆盖、静态official路径零前端改动等提案已被纠正。
- `EXEC-PLAN.md`：修订路线，当前只做第一步木鱼图片；官方形象封面静态化是第二步，本轮未做。
- `IMPLEMENTATION.md`：本地实现与验证记录，包含协作方后续修订；需按最新正文读，不沿用先前旧包信息。

### 实现范围

1. Windows客户端木鱼已经按Mac几何翻转绘制；官网旧manifest/播放器未同步。生成器现在提取Mac几何，派生Windows参数，并定向校验Windows源码；无需引入通用C++解析器。
2. 新 `native-woodfish-v2` 在网页共用Mac规范坐标绘制，保留v1分支，renderer使用明确白名单。棒身局部y翻转是 `-y-h`，此前所谓2px差异实际就是正确转换。
3. 木鱼PNG同时输出到 `/assets/previews/public/<图片SHA256>/<文件名>.png`，索引增加 `publicPath`，播放器保持字节校验；首页preload完整URL与读取一致。
4. 修复卡片选择器 `.library-card`，并补本地模块版本参数。正式发布还会由runtime版本器生成内容寻址脚本地址。
5. 不改Caddy/CDN配置、不改API业务、不修改或重签客户端。

### 当前已发布tree的本机归档绑定

- tree：`b9acc5a9a5d0729ed94084b50ef0540ff90e02831da46f0852d4ada15d4552cd`。
- 归档：`dist/gongde-deploy/gongde-site-b9acc5a9a5d0729ed94084b50ef0540ff90e02831da46f0852d4ada15d4552cd.tar.gz`。
- 本次交接读取的大小：20,312,628字节。
- 本次交接读取的归档SHA256：`aa85303b2dabf4489abfc8345fb4fddbd9a576594c300eff53cc86a993917310`，与同名 `.sha256` 一致。
- runtime：`bd91ac6d61f0e2ae7405ddb5f76051318b56b4b5f5e9d752aebe638a6f7c40cf`。
- `88fdec50…`是中间包，已被替代，不要部署。

相同内容tree的压缩归档重新打包后，归档SHA可能因文件元数据等发生变化。tree不是压缩归档摘要。后续若重新打包，应重新绑定精确产物，不能复制旧摘要或覆盖冻结回执来冒充原包。

### 复核结果和剩余限制

- 坐标关系成立，clip带来自250高窗口中底部170高绘图区，与缩放中心无关。最新脚本断言及输出clip字段已改为 `CANVAS_HEIGHT - ARTWORK_HEIGHT`。
- 角度数值、双轴缩放、缩放中心和素材裁剪检查已补；不要把定向断言称为能证明任意未来C++改动的完整解析器。
- renderer白名单、卡片入口和详情页入口已由协作方补验，已有渲染/动画/preload结果可复用。本会话没有重新运行浏览器或性能测试。
- 索引和manifest仍是稳定地址。完整缓存旧文件的旧页面可继续使用；缓存缺失或逐出的旧页面可能校验失败，需要刷新。最新实施记录承认并提出接受这一限制，不再宣称完整兼容。接手方应向用户说明这一发布影响，不把协作方文档中的“决定”当作额外生产授权。
- 三个runtime是一份当前正式runtime加两份历史，不是“三份历史”。保留目录中包含一个未部署中间runtime，不能据此声称每个runtime都曾上线。
- 本地测试代理 `website/local-verify-server.py` 只供验证，不应进入公开归档；其源码存在不等于服务正在运行。本次不启动、终止或探测其他协作方进程。
- 打包脚本在完成静态归档后，可能因缺少历史默认DMG而在复制下载包阶段退出失败；静态归档与安装包发布是不同交付。不要为“修好打包”重建或替换已公证客户端。

**当前结果：缓存优化已部署，不再等待部署授权，也不能重复发布。** 源站镜像为 `gongde-site:b9acc5a9…`，公网首页已引用runtimebd91ac6d及两张内容寻址木鱼图片。状态证据位于 `.local-work/acceptance/cdn-cache-status-20261021/`；这是独立的现状核对，不伪造原操作者的部署时间或发布回执。

## 后续工作和下一动作

| 优先顺序 | 下一动作 | 授权或完成条件 |
| --- | --- | --- |
| 1 | 接收当前工作区及本文，保留未提交改动、候选与回执 | 本轮仅文档交接，不自动搬迁 |
| 2 | 复用已发布b9acc5a9/runtimebd91ac6d及状态证据 | 缓存第一步已完成，不再排队发布 |
| 3 | 若用户提出新改动，再基于当前正式tree准备差异 | 不重复激活旧包，不覆盖其他协作方后续发布 |
| 4 | 既有本地渲染/入口验证继续复用，出现相关新失败才补验 | 不重复支付、客户端全验或并发性能测试 |
| 5 | 官方封面及动画图层静态化 | 独立后续范围，需要API和静态资源发布顺序、下架/保留约定；未实施 |

304原因、更多压图和并发性能深挖本期暂缓。原小样本耗时不是最终收益保证，不为增加报告继续重测。

## 访问方式和生产边界

现有权限与操作记录详见 [访问与运维](/Users/yue/Desktop/牛马电子功德/docs/PROJECT_ACCESS_AND_OPERATIONS.zh-CN.md)，以下仅提供接手导航。

| 角色 | 既有入口 | 限制 |
| --- | --- | --- |
| 静态官网发布 | `/Users/yue/.local/bin/deploy-gongde` | 接受固定目录内冻结归档和归档SHA；不能传Caddyfile |
| API受管发布 | `/Users/yue/.local/bin/deploy-gongde-api` | 沿现有准入、锁、投影、健康和回滚合同 |
| 常规主机连接 | SSH批准别名 `ace-zqscreen-dev` | 访问能力不等于任意生产配置变更授权 |
| 下载历史入口 | `/Users/yue/.local/bin/publish-gongde-downloads` | 固定旧合同，不能假设能发当前任意对象 |
| 外部共享部署工具 | `/Users/yue/.codex/worktrees/8016/ACE天梯系统/deploy/production` | 外部基础设施依赖，不搬进本项目、不为整理而编辑 |

静态发布器要求归档位于 `/Users/yue/Desktop/牛马电子功德/dist/gongde-deploy/`。如果换机器或改变根目录，该路径约束和外部工具必须由其所有者处理；仅修改本文路径不会迁移发布能力。未取得生产授权前，不在新机器试发验证。

连接沿用ControlMaster auto和ControlPersist30m；常规ControlPath为 `/Users/yue/.ssh/controlmasters/%C`，API专用连接和静态站专用连接分别按现有包装器使用，不混用身份。连接过期时可按原配置恢复，不据此要求用户重新给密码或密钥。

主机同时服务其他产品。不得为整理、交接或牛马优化中断桌球、智家等服务。共享 `/etc/caddy/Caddyfile` 不归本项目所有；若以后用户明确授权修改，必须备份、validate、reload，不能改全局头或直接重启。容器内站点Caddy配置与共享主机网关也不是同一层。

COS角色必须分开：公共安装包使用已有公共发布配置；已签发付费/领取包使用私有配置；创作者原始素材是另一角色。Secret文件名及挂载引用见运维文档，不导出值。包签名私钥只在服务侧，文案发布密钥与形象签包能力不得随意互换。

不读取或输出私钥、`.env`、authorized_keys、sudo配置和完整运行环境。浏览器登录状态、Keychain和SSH访问不会随Git仓库自动转移。本次不创建密钥或更改IAM。

若需Windows远端协作，先使用既有访问记录与用户授权，不自动新建线程、派发任务或把旧完成回调当成人类指令。当前接手不要求重新运行双端验收。

## 构建与发布注意事项

- 客户端构建入口为 `scripts/build-macos.sh`、`scripts/build-macos-installer.sh`、Windows构建脚本及对应Actions；源码构建不会继承正式成品签名或苹果公证。
- `scripts/package-website.sh` 正常路径会生成预览、构建管理端和打静态包，随后处理下载产物。它可能把当前工作区其他改动带入，不能为整理交接直接运行。
- `--site-only` 跳过预览生成，但仍会打包现有工作区和管理端；不能把它理解成“只含本次变更”或“旧预览一定正确”。
- `scripts/version-website-assets.mjs` 管理runtime内容寻址及历史保留；HTML带runtime和预览索引哈希。不能只改几个 `?v=` 字符串便声称已解决正式发布的全部缓存问题。
- 本次已完成的缓存优化只发布静态站，不使用打包脚本生成的旧unsigned下载清单替换当前已签名客户端下载清单。
- 安装包、API登记、COS清单和静态官网是不同发布对象。重试前先确认未知结果，不能因一次连接中断重复激活。
- 真实付款、法律承诺、敏感权限和浏览器人工接管继续按对应工具规则处理；过去一次批准不等于任何未来敏感操作都已批准。

## 转移时需要带走什么

用户尚未指定转移目标，本次不执行实际迁移。根据目的区分：

1. **换同一台Mac上的AI工具或会话：** 让接手方直接打开正式根目录，读取本文和入口文档；不需要重新克隆或复制第二份源码。
2. **换电脑或私有工作目录：** 保留当前未提交源码与资源、必要的 `.local-work/`交接和验收记录、准确的签名成品、当前线上冻结归档及后续新候选。仅克隆Git会漏掉本机未提交和忽略的资料。
3. **只交源码：** 不能据此声称交出了签名产物、回退资料、生产凭据或部署权限；GitHub旧送签分支也不是最新全部资料。

迁移材料应按清单筛选，不把整个 `.local-work/`、WeChat临时附件、用户数据目录或凭据目录不加区分发给第三方。源码、公开静态包与本机私有证据的接收权限不同。

至少保留这些路径及其引用关系：

- 本文、`PROJECT_HOME.md`、`AGENTS.md`、`WORK_PLAN.md`、`docs/PROJECT_ACCESS_AND_OPERATIONS.zh-CN.md`、`.local-work/INDEX.md`。
- `.local-work/candidates/cdn-cache-20261021/`与已发布tree对应的 `b9acc5a9…tar.gz`及同名摘要。
- `.local-work/candidates/macos-notarized-publish-90414-20261021/`、对应acceptance、`macos-signing-return-90414-20261021/`签后原件和核对记录。
- `.local-work/candidates/windows-signed-publish-094-20261019/`及其精确Windows正式成品；按已登记路径找原文件，不为交接重建。
- 前一正式版本 `ca10ac1e…tar.gz`及摘要，回退所依赖的旧文件保持原路径，除非另有迁移计划。
- 领取流程、群二维码及首页改版发布回执，避免接手方从早期文档误判为未实施。

本次未重开官方目标：读取时目标登记为无活动目标。本文不是后台自动续跑指令；若接手方所在会话有其他活动目标，先确认归属，不擅自覆盖。

## 用户协作偏好

- 以实际结果为进展，已完成事项不反复分析、验证和汇报。
- 一般可逆工作合理自行决定；确实需要确认时说明具体原因，不让用户重复授权。
- 当前重点是收尾与运营，不随意重启长期客户端开发。
- 桌面测试结束清理辅助光标和自己创建的进程，不误杀用户或其他协作方程序，不再运行已知旧牛马副本。
- 当前约定不做移动端验收；不能沿用历史部署文档自动扩展为手机端全验。
- 结束时说明做了什么、尚有什么限制、文件在哪里。未实施、未部署、用户反馈通过和独立实测通过要分清。
