# 牛马电子功德

## 什么是本软件

这是一个无音效、低干扰的原生桌面木鱼，目标支持 Windows 与 macOS。软件在系统范围内监听键盘按下和全部鼠标按键，并将连续滚轮事件合并为一次滚动手势；只统计操作次数，不读取按键内容、鼠标坐标、窗口名称或剪贴板内容。

- 首次运行默认开启“登录后自动启动”，右键菜单可随时关闭或重新开启
- 右键菜单支持：暂停/继续、清空总功德、隐私说明、登录后自动启动、退出
- 仅展示总数和实时 `+1` 动画，不展示品牌文案、广告位或排行榜
- 使用本地透明 PNG 绘制木鱼和敲棒，不包含音频、WebView 或远程资源
- 完全本地持久化（总数、暂停状态、窗口位置、隐私说明确认状态和自启动设置）

## 隐私与离线边界

- 客户端不联网，不包含网络框架与遥测/更新/广告 SDK。
- macOS 为支持系统级 `CGEventTap` 不启用 App Sandbox；源码不调用网络 API，构建时执行离线审计。
- 可下载官方发布页时统计下载请求，但不能得出真实安装量、启动量、活跃量或卸载量。
- 用户转发安装包不会被官方官方下载统计追踪。
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

- 正式发布前建议在真实签名后的发布产物上再次复测性能、体积和权限流程。
- Windows 需在真实 Windows 10/11（及目标兼容版本）上验证；如果暂无法验证需在交付文档中标注未验收设备。

## 实测记录（开发验收）

- macOS 本地构建脚本：`./scripts/build-macos.sh` 成功。
- `lipo -info`：`x86_64 arm64`。
- `codesign -d --entitlements - dist/牛马电子功德.app` 不包含 App Sandbox 或网络 entitlement。
- 启动 8 秒后实测：
  - RSS 约 `35MB~46MB`
  - 空闲 CPU 长时均值接近 `0%`（短启动抖动后稳定 `0`）
- 当前 macOS 演示产物小于 `5MB`；正式签名后必须重新测量最终发布包。

当前限制：

- 当前环境缺少 `cmake` 命令，`cmake -S . -B build...` 无法在本机直接复测。
- 未完成 Windows 真实构建与兼容性验收；请在真实 Windows 机器上执行 `scripts/build-windows.ps1`。
