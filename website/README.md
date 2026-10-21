# 官网说明与发布边界

当前规则以项目 `docs/PRD_FREE_DOWNLOAD_AND_CO_CREATION.zh-CN.md` 1.1 为准。0.9 客户端与新版官网采用全免费、永久离线交付流程；本文描述实现与发布边界，不代表客户端、API 或官网已经发布。

## 页面与免费流程

- 客户端：`download.html`，内置基础木鱼直接免费下载，无需账号、领取码、关注或进群。
- 统一形象库：`index.html#characters`，官方与创作者作品不分来源或收费入口，支持编号、作者、标签、关键词与每页 24 个分页。
- 详情：`appearance.html?number=...`，仅展示可公开作品、真实预览与作者选填的本人抖音号。
- 领取：`claim.html`，群码或作者推广码免费领取扩展形象，每批不超过当前权限且最多 10 个，最终文件不超过 16 MiB；重复使用不扣次数。
- 交付：`delivery.html?claim=...`，只根据服务器真实状态显示结果，一个批次提供一个 `.nmgpack` 或 `.nmgpacks` 文件。
- 创作者：`creator.html`，手机号验证码登录，无需昵称；源包制作使用外部工具，投稿分别确认免费分发与 AI 审核授权。
- 指南：`creator-guide.html` 与 `assets/creator-guide.zip`，无需登录或领取码。名称 20、介绍 40、标签最多 3 个；本人抖音号可选，不要求放入源包。
- 旧入口：`community.html` 恢复到统一库或同编号详情；`checkout.html` 仅保留受验证的历史订单与旧 GD 权益履行；`support.html` 不创建新赞赏。停止新收费不删除真实历史记录。
- 管理：`/admin/`，免费领取、码、作者、审核、作品、举报和历史交付；目录归属不构成操作权限。

## 永久文件与重下载

新交付文件采用 `licenseMode=perpetual`、`importExpiresAt=null`。下载后可长期保存，随时首次导入、重装后再次导入，永久离线使用；不需要客户端联网验码，也没有首次导入倒计时。服务器重下载入口仅保留首次成功签发后的 7 天，单次签名链接最长 5 分钟且不晚于该期限；这些期限不使本地文件失效。

永久包应使用 0.9 兼容客户端或服务端发布元数据规定的更新版本，不能把旧 0.8.4 安装产物当作已支持永久包。历史文件仍验证真实原签名，新兼容客户端不再限制其首次导入时间；历史服务端履行范围继续由原记录校验，不在新流程宣传旧首次导入限制。

## 下载元数据与 Mac 签名事实

- `download.html` 通过 `GET /api/gongde/v2/installers` 的 `data.items` 读取批准发布的 `releaseId/platform/format/version/bytes/sha256/publicDownloadUrl/perpetualCompatible`。
- `GET /api/gongde/v2/config` 提供 `minPerpetualClientVersion` 等真实平台状态。公开客户端下载不依赖领取码验证；新扩展形象领取需等待平台就绪。
- 不硬写旧版本安装包链接，不编造 0.9 GitHub Release 文件 URL。客户端实际发布后，再由正式发布元数据提供对应公开地址、版本、大小和摘要。
- 本轮 0.9.4（904.14）Mac 正式包为 Developer ID 分发签名并已完成 Apple 公证，`stapler` 票据已装订；Windows 0.9.4 正式包为 Authenticode 签名。更早的 0.9.4 候选（904.12、904.13）和 0.9.3 及以前为 ad-hoc 或 Apple Development 签名且未公证，只作为历史回退项保留，签名状态以 `DOWNLOADS.json` 中逐条记录为准。
- 系统可能阻止首次打开。只能在确认官方来源、文件完整性与愿意运行的前提下按安装说明处理单个应用；不关闭全局 Gatekeeper 或其他安全保护。“已损坏”“将损坏你的电脑”等提示不应绕过。

## 现有发布工具与证据

- 正式官网：`https://gongde.zqscreen.cn`；安装包独立分发域名：`https://download.gongde.zqscreen.cn`。这些域名不替代尚未发布的具体文件 URL。
- macOS 提供 DMG，Windows 提供安装 EXE；安装包不进入静态站归档，版本与摘要以当前批准发布元数据为准。
- 静态站：`./scripts/package-website.sh --site`，只构建并打包站点，不需要本机存在客户端安装包。`--site-only` 保留为同义别名。
- 下载材料：`./scripts/package-website.sh --downloads`，按 `release/downloads-manifest.json` 复制已发布的安装包并生成 `DOWNLOADS.json` 与 `SHA256SUMS.txt`。清单必须逐项写明源文件、字节数、摘要与签名状态；脚本会先核对，签名/公证声明与文件实际状态双向比对，缺文件、摘要不符或声明不符时直接失败且不动已有输出。回归测试见 `scripts/prepare-download-materials.test.mjs`。
- 全量：`./scripts/package-website.sh`（等同 `--all`），预览生成 + 静态站 + 下载材料。须有相应授权，本文不是执行命令。
- API 与静态站分别走专用受限发布器。新收费接口退役为 410，历史合法履行保留；不因回退重新开放新收费。
- `GET /healthz.txt` 应返回 `gongde-ok`。运行开放情况以实际服务状态和发布回执为准，本地源码、模拟测试与签名构建不等于上线或用户验收。
- 本轮仅整理官网说明，未联网、部署、签名、重建指南 ZIP 或修改发布配置。
