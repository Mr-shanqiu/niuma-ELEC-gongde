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
- 声明 Developer ID 或已公证 → 用 `codesign` / `stapler` 核对实际文件，声明不成立就失败；
- 声明 Authenticode → 检查 PE 证书表；
- 成功时只清理上一版 `DOWNLOADS.json` 列出的产物，目录中手工放置的材料与回执保留。

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
