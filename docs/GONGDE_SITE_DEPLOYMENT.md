# 牛马电子功德官网部署合同

## 固定边界

- 官网：`https://gongde.zqscreen.cn`
- 下载：`https://download.gongde.zqscreen.cn`
- 官网前端仍为纯静态文件；付费身份、短信、订单和支付由隔离的 `gongde-payments` 服务提供，不能把业务 secret 放入静态站点。
- 容器内部监听 `8080`，只读文件系统，建议资源上限 `0.10 CPU / 64MiB`。
- `GET /healthz.txt` 必须返回 `200`、`text/plain` 和 `gongde-ok\n`。
- 不需要 SPA 回退；未知路径应返回归档中的 `404.html`。

## 构建与交付

三个步骤互相独立，因为输入和风险不同：

```sh
./scripts/package-website.sh --site        # 只打包静态站，不需要客户端安装包
./scripts/package-website.sh --downloads   # 只按清单生成下载材料
./scripts/package-website.sh               # 全量：预览 + 静态站 + 下载材料
```

`--site-only` 保留为 `--site` 的同义别名。旧的 `--site-only` 同时跳过预览和下载准备，把两个独立选择混成了一个。

静态站输出：

- `dist/gongde-deploy/gongde-site-<full-sha>.tar.gz`
- 同名 `.sha256`
- 同名 `.metadata.txt`

下载步骤需要 `release/downloads-manifest.json`（本机文件，不进入 Git；模板见 `release/downloads-manifest.example.json`）。清单逐项写明源文件路径、字节数、摘要、签名与公证状态。脚本在写入前核对每一项：

- 源文件缺失、字节数或摘要不符 → 直接失败，不写任何输出，也不清空已有目录；
- 签名与公证状态由文件本身判定后**双向比对**：`codesign` 判定 Developer ID Application / Apple Development / ad-hoc / unsigned，`xcrun stapler validate` 判定是否已公证，PE 证书表判定 Windows 是否 Authenticode 签名。清单写弱了同样失败——把已公证的 Developer ID 包写成 `unsigned` 会被拒绝，不只有反过来才报错；
- 取值不在已知集合内（例如无法归类的签名状态、拼错的声明）→ 失败，不当作“已核实”放行；
- 文件名必须是裸文件名且唯一；`DOWNLOADS.json` 与 `SHA256SUMS.txt` 由脚本自己生成，不能用作产物名；
- 成功时只清理上一版 `DOWNLOADS.json` 列出的产物，目录中手工放置的材料与回执保留。

清单里除 `source` 外的字段会原样带入 `DOWNLOADS.json`，因此 `publisher`、`certificateThumbprint`、`sourceCommit`、`buildRunId`、`timestamp` 等溯源信息不会在发布时丢失。

回归测试：`node --test scripts/prepare-download-materials.test.mjs`，全部在临时目录中运行，不接触真实项目。

安装包不进入静态站点归档。网站归档内没有软链接、运行时写目录、`.env`、密钥或绝对本机路径。

## 发布验收

- 桌面 Chrome：首页、隐私、联系、404 和下载链接。
- 桌面 Safari：首页布局、动画与下载链接。
- 移动端：导航、文字、形象区和下载区无横向溢出。
- `healthz.txt` 状态、Content-Type 和正文完全匹配。
- 所有页面 HTTPS，无混合内容。
- 浏览器控制台无错误。
- macOS、Windows 和形象包文件名、版本、字节数、SHA-256 与下载清单一致。
- 页脚备案号链接到工信部备案系统。
- 官网无第三方追踪脚本，客户端离线边界未改变。
- 免费下载不经过手机号或订单服务。
- 短信必须使用独立 `gongde_login` purpose、功德项目签名和模板；不得复用桌球业务路由或“智家”正式签名。
- 真实服务启用前必须完成持久化、支付回调、短信模板审核、频控和订单恢复验收。

生产 DNS、COS、Caddy、Compose、容器构建和回滚由桌球智慧屏 00 主控执行。

**分工更正（2026-10-20）**：站点静态文件的发布已由牛马项目自己承担，入口是 `deploy-gongde <archive> <sha256>`（见上文）。上面这句是历史口径，只对 Caddy、DNS、Compose 和主机级运维继续成立。

两者不是同一层，不要混用：

- `deploy-gongde` 只能发站点归档。服务端只接受固定的根级文件和 `assets/*`，远端执行固定的 `deploy <tree_sha> <archive_sha>`，**改不了 Caddyfile**。
- 主机配置改动（缓存头、反代、TLS）需要直连 `ace-zqscreen-dev` 操作 `/etc/caddy/Caddyfile`。该主机同时服务其他产品，改动前备份、`caddy validate` 通过后用 reload 而非 restart。具体边界见 `AGENTS.md` 的 Shared infrastructure 一节。

## 下载统计存储（013）

下载统计复用现有 MySQL 连接池。每次已接受的计数在同一事务中更新累计、北京时间日汇总和近期明细；数据库写入失败仍允许下载，并标记该次未确认计数。无访客身份、输入内容或新客户端遥测。

近期明细保存90天，可按准确时间查询；日汇总保存730天，较早区间须为北京时间整日；累计量和最早记录独立保存。超出保留范围或读取失败返回明确错误，不显示为零。文件管理页的历史累计仍包括正式计数起点前的记录，下载报表则将其单列。

迁移013仅创建五张统计专用表。切换前从原COS事件键导入，永久去重记录只针对这份有限的旧事件集合；切换后再补导入旧服务末尾写入的增量。初始化确认完成后才能激活SQL统计。旧COS对象不由导入器或应用定时任务删除，后续清理须另有明确范围和回执。

兼容恢复版本继续使用原COS写入并将统计读取明确标为不可用，新SQL记录保留。再次前滚前补导入COS增量，防止丢失或重复累计。不能在存储切换后直接恢复只会读取COS的普通旧版并把不完整数字当成完整统计。

## 2026-10-30 审计治理实施边界

两个Gongde公共域名已启用CDN的HTTP跳转HTTPS；原证书与回源不变。管理员登录按可信代理提供的客户端地址限流，v2无会话返回401。下载计数保护不阻断下载安装，触发保护或写入失败可能少计，数字不是独立用户人数。

本轮未更换会话架构，也未盲加CSP/COOP等强制头：会话吊销需要新的服务端状态及部署合同，CSP需先整理实际脚本/支付来源和报告渠道，不能通过限制未知支付路径冒充完成。它们作为后续加固项保留，不构成本轮已修复的声明。旧COS事件删除/生命周期、分支清理和破坏性Git瘦身须另定明确对象；本轮不执行。
