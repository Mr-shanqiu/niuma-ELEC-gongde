# 牛马电子功德

一个无音效、低干扰、纯本地运行的桌面小伙伴。你打字、点鼠标，它动一下，把日常忙碌攒成一点「功德」。支持 macOS 和 Windows。

**官网：[gongde.zqscreen.cn](https://gongde.zqscreen.cn/)**
**下载：[官网客户端下载](https://gongde.zqscreen.cn/download.html) · [GitHub 发行版](https://github.com/Mr-shanqiu/niuma-ELEC-gongde/releases)**

## 当前版本

- 官网和 [GitHub v0.9.5](https://github.com/Mr-shanqiu/niuma-ELEC-gongde/releases/tag/v0.9.5) 提供 macOS 0.9.5／905.1（Universal 2，Developer ID 签名、Apple 公证并装订）和 Windows 0.9.5（Authenticode 签名）。文件摘要以官方下载清单为准。
- 已发布 Windows 源码为 `3630053a950ef33ae2fd4f9e7b20b5395c373d4c`，位于 `codex/windows-legacy-compat-20261028`；已发布 Mac 源码在 `codex/macos-runtime-unified-20261026`，原始未提交差异于 `96b2690` 事后归档，安装器配方后续归档为 `74548a0`。
- 两个平台的安装包分别构建。仓库默认分支中的旧客户端入口及 `VERSION` 不能替代上述平台源码绑定；本分支整理的是官网、后台与发布追溯。
- 下载页只展示当前客户端。历史发行记录保留，源码中的后续修改不会自动改变已签安装包。

## 本地功能

右键菜单保留关于、登录后自动启动、更换形象、功德日历和退出。支持本地形象包、下班时间显示、功德日历，以及根据活动触发的幽默气泡。内置中文和英文文案各 800 条，气泡显示 15 秒，同一文案遵循七天不重复规则；文案包可通过文件关联导入。

客户端离线运行，不包含广告、遥测、账号、支付或联网自动更新。它只统计输入事件次数，不记录具体按键内容、鼠标坐标、窗口名称或剪贴板内容。macOS 全局计数需要「输入监控」权限。

扩展形象和文案包是受校验的本地数据文件，不允许执行代码或改变客户端权限。形象包使用 `.nmgpack` / `.nmgpacks`，文案包使用 `.nmgtext`。

## 源码目录

- `src/`：macOS、Windows 客户端及共享逻辑。
- `installer/`、`scripts/`、`.github/workflows/`：安装、构建与验证脚本。
- `website/`：官网源码。
- `admin-console/`：管理后台源码。
- `services/gongde-payments/`：订单、交付、形象包及相关服务源码。

本机凭据、环境配置、用户数据、运行日志、临时验收材料和私钥不属于公开源码。

## 从源码构建

macOS（先切换到对应平台源码分支）：

```bash
git switch codex/macos-runtime-unified-20261026
./scripts/build-macos.sh
./scripts/build-macos-installer.sh
```

Windows（先切换到对应平台源码分支）：

```powershell
git switch codex/windows-legacy-compat-20261028
./scripts/build-windows.ps1 -ClientOnly -ExpectedVersion 0.9.5
```

通用 CMake 构建：

```bash
cmake -S . -B build -DCMAKE_BUILD_TYPE=Release
cmake --build build --config Release
```

构建需要相应平台工具链。自行构建不等同于官方安装包，也不继承官方签名或公证。Apple 开发账号、证书和私钥必须由签名者自行保管。

## 许可证

源码许可证：[GPL v3](LICENSE)。分发衍生作品时须遵守许可证要求；第三方素材仍须具备相应授权。
