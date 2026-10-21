# 牛马电子功德

一个无音效、低干扰、纯本地运行的桌面小伙伴。你打字、点鼠标，它动一下，把日常忙碌攒成一点「功德」。支持 macOS 和 Windows。

**官网：[gongde.zqscreen.cn](https://gongde.zqscreen.cn/)**
**下载：[官网客户端下载](https://gongde.zqscreen.cn/download.html) · [GitHub 历史发行版](https://github.com/Mr-shanqiu/niuma-ELEC-gongde/releases)**

## 当前版本

- 当前客户端源码版本为 **0.9.4**，见 [VERSION](VERSION)。
- 官网当前提供 **macOS 0.9.4 / build 904.14 / Universal 2** 和 **Windows 0.9.4**。以[官方下载页](https://gongde.zqscreen.cn/download.html)及其校验清单为准。
- Mac 904.13 已修复异常形象包导入可能卡住的问题，并补齐英文导入错误提示；安装和异常包导入已在本机验收。
- Mac 904.14 使用官方登录启动接口，已完成开关、状态保留和实际重启自启动验收；客户端、安装器和 DMG 均已完成 Developer ID 签名，客户端与最终 DMG 已完成苹果公证并装订票据。Windows 客户端和安装程序均已完成代码签名。
- Mac 904.11 送签原包（SHA-256 `2f2f8e77…`）是历史交接材料，已被 904.14 取代，并非当前官网下载包。该分支已归档，仓库内不再提供下载。源码中的后续修改也不会自动改变已发布安装包。

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
