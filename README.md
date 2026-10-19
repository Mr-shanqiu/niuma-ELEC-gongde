# 牛马电子功德

一个无音效、低干扰、纯本地运行的桌面小伙伴。你打字、点鼠标，它动一下，把日常忙碌攒成一点「功德」。支持 macOS 和 Windows。

**官网：[gongde.zqscreen.cn](https://gongde.zqscreen.cn/)**  
**下载：[官网客户端下载](https://gongde.zqscreen.cn/download.html) · [GitHub 历史发行版](https://github.com/Mr-shanqiu/niuma-ELEC-gongde/releases)**

## 当前源码与送签版本

- 当前客户端源码版本为 **0.9.4**，见 [VERSION](VERSION)。
- 最新 Mac 送签原包为 **0.9.4 / build 904.11 / Universal 2（Intel 与 Apple Silicon）**，使用一键安装方式。
- [Mac 送签原包、校验值和说明](https://github.com/Mr-shanqiu/niuma-ELEC-gongde/tree/codex/macos-signing-094-20261019/signing/macos-0.9.4-904.11)。当前原包为 ad-hoc 签名，尚未完成 Developer ID 签名和 Apple 公证；送签交付不代表已签名正式发布。
- Windows 0.9.4 客户端及安装包正在准备正式代码签名；签名前原文件不代表已获得可信签名。
- 这次源码同步不替换官网、COS 或 CDN 上的安装文件。正式下载与签名状态以实际发布说明及文件为准。

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

macOS：

```bash
./scripts/build-macos.sh
./scripts/build-macos-installer.sh
```

Windows：

```powershell
./scripts/build-windows.ps1 -ClientOnly -ExpectedVersion 0.9.4
```

通用 CMake 构建：

```bash
cmake -S . -B build -DCMAKE_BUILD_TYPE=Release
cmake --build build --config Release
```

构建需要相应平台工具链。自行构建不等同于官方安装包，也不继承官方签名或公证。Apple 开发账号、证书和私钥必须由签名者自行保管。

## 许可证

源码许可证：[GPL v3](LICENSE)。分发衍生作品时须遵守许可证要求；第三方素材仍须具备相应授权。
