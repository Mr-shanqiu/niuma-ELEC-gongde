# 牛马电子功德官网部署合同

## 固定边界

- 官网：`https://gongde.zqscreen.cn`
- 下载：`https://download.gongde.zqscreen.cn`
- 官网前端仍为纯静态文件；付费身份、短信、订单和支付由隔离的 `gongde-payments` 服务提供，不能把业务 secret 放入静态站点。
- 容器内部监听 `8080`，只读文件系统，建议资源上限 `0.10 CPU / 64MiB`。
- `GET /healthz.txt` 必须返回 `200`、`text/plain` 和 `gongde-ok\n`。
- 不需要 SPA 回退；未知路径应返回归档中的 `404.html`。

## 构建与交付

运行：

```sh
./scripts/package-website.sh
```

脚本输出：

- `dist/gongde-deploy/gongde-site-<full-sha>.tar.gz`
- 同名 `.sha256`
- 同名 `.metadata.txt`
- `dist/gongde-deploy/downloads/` 安装包与形象包
- `dist/gongde-deploy/downloads/DOWNLOADS.json`
- `dist/gongde-deploy/downloads/SHA256SUMS.txt`

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
