# 牛马电子功德

仓库：<https://github.com/Mr-shanqiu/niuma-ELEC-gongde>  
许可证：[GPL v3](LICENSE)。任何人可以自由使用、修改和分发；分发衍生作品（包括商用）时，须遵守 GPLv3 的相同许可证要求。

## 版本与下载状态

- 当前源码版本：`0.8.4`（见 [VERSION](VERSION)）。
- GitHub Releases 当前公开的安装包：`0.6.0` 免签名预发布版，见 [Releases](https://github.com/Mr-shanqiu/niuma-ELEC-gongde/releases)。
- `0.8.4` 尚未作为正式安装包发布；源码版本号不代表该版本已完成平台验收或可供下载。请以 Releases 中实际列出的文件为准。
- 社区投稿、审核和免费分享目前仍在验收中，尚未开放线上服务。

## 代码签名状态

目前正在申请 SignPath Foundation 的 Windows 代码签名支持，尚未获批或接入；当前下载仍为免签名版本。没有任何当前版本被表示为已获 SignPath 签名或认可。

若申请获批并完成集成，Windows 签名版本将使用归属说明：“Free code signing provided by [SignPath.io](https://signpath.io), certificate by [SignPath Foundation](https://signpath.org).”这描述的是预期服务，不代表当前已获批。

- 维护、代码审查和签名审批：Yue Wang（[Mr-shanqiu](https://github.com/Mr-shanqiu)）。
- 计划签名范围：来自公开仓库并通过 GitHub Actions 构建的本项目 Windows 客户端和安装程序；签名集成待审批，且每次签名均需维护者人工批准。
- 外部贡献需经维护者审查。启用签名前，源码仓库和签名服务访问需使用多重身份验证。
- 签名申请不覆盖网站、支付服务、第三方应用或 macOS Developer ID 签名与公证。

## 产品说明

这是一个无音效、低干扰的原生桌面木鱼，支持 Windows 和 macOS。应用只统计系统范围内的键盘按下、鼠标按键和滚轮手势次数，不读取具体按键内容、鼠标坐标、窗口名称或剪贴板内容。

客户端离线运行，不包含联网、广告、遥测、账号、支付或自动更新。功德数和设置保存在本机。macOS 需要用户授予“输入监控”权限以进行全局计数；权限用于接收输入事件，应用不读取事件内容。

形象包是受严格校验的本地数据文件，只包含图片和动画参数，不能修改客户端功能、权限或系统设置。macOS `0.7.0` 与 Windows `0.7.1` 源码已实现形象包导入和管理；这不代表对应版本已作为 GitHub Release 发布。

## 安装安全

本项目当前采用免签名分发。Windows 可能显示“未知发布者”或 SmartScreen 提示；macOS 可能阻止首次打开。请仅从本仓库的 [Releases](https://github.com/Mr-shanqiu/niuma-ELEC-gongde/releases) 获取实际公开的安装包，并按[免签名安装、升级与卸载指南](docs/INSTALL_UNSIGNED.md)操作。需要时核对发布页提供的 SHA-256。不要为了运行本软件而全局关闭系统安全防护。

## 构建

macOS：

```bash
./scripts/build-macos.sh
./scripts/package-macos-dmg.sh
./scripts/audit-offline.sh
```

Windows：

```powershell
./scripts/build-windows.ps1
```

通用 CMake 构建：

```bash
cmake -S . -B build -DCMAKE_BUILD_TYPE=Release
cmake --build build --config Release
```

本机构建环境可能缺少 CMake；请使用各平台构建脚本或 GitHub Actions。

## 历史验收记录

以下数据是 `0.6.0` 的历史记录，不代表 `0.8.4` 已验收：

- Windows `0.6.0` 曾在 GitHub Actions 的 `windows-2022` runner 上使用 MSVC Release 构建，并在一台真实 Windows 电脑上完成基础运行及海狮 `.nmgpack` 导入验收。
- macOS `0.6.0` 曾完成 Universal 2 构建、离线审计、DMG 完整性检查和本机运行检查。
- 这些记录不代表覆盖所有 Windows/macOS 版本、Intel Mac 真机、多显示器组合或所有权限恢复场景。

## 尚未完成的验收

- `0.8.4` Windows 与 macOS 安装包的正式验收和发布。
- Windows 系统版本、混合 DPI、多显示器、高频输入及长时间运行兼容性矩阵。
- macOS 干净环境首次权限引导、Intel Mac 真机、权限撤销恢复、Developer ID 签名、公证和 Gatekeeper 验证。
- 多台普通用户电脑上的下载、安全提示处理及升级流程。
- 免费创作者社区完整线上闭环验收。
