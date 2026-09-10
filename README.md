# 牛马电子功德

仓库：<https://github.com/Mr-shanqiu/niuma-ELEC-gongde>

## 什么是本软件

这是一个无音效、低干扰的原生桌面木鱼，目标支持 Windows 与 macOS。软件在系统范围内监听键盘按下和全部鼠标按键，并将连续滚轮事件合并为一次滚动手势；只统计操作次数，不读取按键内容、鼠标坐标、窗口名称或剪贴板内容。

- 首次运行默认开启“登录后自动启动”，右键菜单可随时关闭或重新开启
- 右键菜单支持：隐私说明、登录后自动启动、退出
- 仅展示总数和实时 `+1` 动画，不展示品牌文案、广告位或排行榜
- 使用本地透明 PNG 绘制木鱼和敲棒，不包含音频、WebView 或远程资源
- 完全本地持久化（总数、窗口位置、隐私说明确认状态和自启动设置）

## 隐私与离线边界

- 客户端不联网，不包含网络框架与遥测/更新/广告 SDK。
- macOS 为支持系统级 `CGEventTap` 不启用 App Sandbox；源码不调用网络 API，构建时执行离线审计。
- 可下载官方发布页时统计下载请求，但不能得出真实安装量、启动量、活跃量或卸载量。
- 用户转发安装包不会被官方下载统计追踪。
- macOS 需要用户授予“输入监控”权限后才能全局计数。
- 自动启动仅在用户登录电脑后运行；不会联网，也不会请求管理员权限。

## 构建

### macOS（推荐）

```bash
./scripts/build-macos.sh
```

构建脚本会输出当前产物的实际尺寸：

- `APP`：`.app` 路径
- `ZIP`：压缩包路径
- `BINARY_BYTES`：通用二进制字节数
- `APP_KB`：完整 `.app` 大小（KB）
- `ZIP_BYTES`：压缩包字节数

生成演示 DMG：

```bash
./scripts/package-macos-dmg.sh
```

执行离线与隐私静态审计：

```bash
./scripts/audit-offline.sh
```

### 通用构建（CMake）

```bash
cmake -S . -B build -DCMAKE_BUILD_TYPE=Release
cmake --build build --config Release
```

### Windows

```powershell
./scripts/build-windows.ps1
```

## 构建与发布注意

- 正式发布前必须在真实签名后的发布产物上再次复测性能、体积和权限流程。
- 当前发布测试包**未签名**，Windows 会显示“发布者未知”，这是未签名的正常表现，不是运行故障。
- macOS 目前为 ad-hoc 签名，仅供本地开发测试；公开分发前需要 Developer ID 签名 + Hardened Runtime + 苹果公证。

## 实测记录

### Windows（云端真实构建 + 用户真机基础运行）

- GitHub Actions 已在真实 `windows-2022` runner 上用 MSVC Release 构建成功（`Visual Studio 17 2022`，x64）。
- 单平台产物：`niuma-merit.exe` 约 `711KB`，ZIP 约 `626KB`，均小于 `5MB` 目标。
- 静态链接 C/C++ Runtime，用户无需安装 VC 运行库。
- 用户已在**一台真实 Windows 电脑**上确认应用基础运行正常。
- 该结论只覆盖“单台机器 + 基础运行”，不等于 Windows 7 / 10 / 11 全版本兼容，也不替代逐项输入行为、自启动和性能测试。

### macOS（本机构建与运行）

- 本地构建脚本 `./scripts/build-macos.sh` 成功。
- `lipo -info`：`x86_64 arm64`（Universal 2）。
- `codesign -d --entitlements -` 不包含 App Sandbox 或网络 entitlement。
- `.app` 约 `768KB`，ZIP 约 `584KB`，均小于 `5MB` 目标。
- 启动 8 秒后实测：RSS 约 `35MB~46MB`，空闲 CPU 长时均值接近 `0%`。
- 登录后自启动 LaunchAgent 已实现并被 macOS 接受。

### 静态离线审计

- `./scripts/audit-offline.sh` 会扫描 `src/`、`scripts/`、`.github/` 与 `CMakeLists.txt`，确认不存在读取键码、鼠标坐标、窗口信息或联网能力的代码。
- 未安装 `rg` 时脚本自动降级为 `grep`；任一工具执行出错会被判定为审计失败，不会误报通过。

## 尚未验收（不声称已完成）

- Windows：系统版本兼容性矩阵（Windows 7 SP1 / Windows 10 22H2 / 当前 Windows 11）、多显示器混合 DPI、100%/125%/150%/200% 缩放、键盘与全部鼠标按键逐个验证、滚轮手势合并、高频输入、暂停、持久化、窗口拖动、自启动、CPU 与内存实测。
- macOS：干净环境首次权限引导流程、Intel Mac 真机运行、权限被系统撤销后的恢复、Developer ID 签名、苹果公证与 staple、Gatekeeper 验证。
- 两个平台：正式签名后的包体与性能复测。

## 环境说明

- 本机（macOS 开发机）未安装 `cmake`，通用 CMake 构建路径无法在本机复现；macOS 直接使用 `scripts/build-macos.sh`，Windows 使用 `scripts/build-windows.ps1` 或 GitHub Actions。
