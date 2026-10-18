# 牛马电子功德

> 当前业务以 [全免费领取与共创 PRD 1.1](docs/PRD_FREE_DOWNLOAD_AND_CO_CREATION.zh-CN.md) 为准。新领取全免费；旧收费、权益码和 24 小时首次导入规则已被替代，仅保留既有付费订单的历史履行与恢复。下文旧版本实测记录不是 0.9.0 的验收结果。

## 0.9.1 发布与免费领取状态

- 本次提供 macOS / Windows 0.9.1 客户端；免费领取服务、统一形象库和创作者自动审核沿用已上线实现。真实群码领取、作者投稿与另一个浏览器使用作者码下载已有证据；这不代表双平台最终客户端验收全部通过。
- 基础木鱼和公开安装包免费，不需要领取码。扩展形象的新领取全免费，统一形象库按有效群码或创作者码范围授权，每批最多 10 个；码不作为付款凭证。
- 新交付使用签名永久包，文件可永久导入并离线使用，没有 24 小时首次导入限制。0.9.0 客户端兼容验证历史 timed 包的原签名，不因旧首次导入日期已过而拒绝导入。
- 同一批次在服务器签发后 7 日内可重新下载；超过 7 日不再保证服务器重下，不影响已保存文件的永久导入与本地使用。单个形象交付 `.nmgpack`，多个形象交付一个 `.nmgpacks` 批次文件。
- 不再创建新收费订单；既有已付款订单仍按原订单上下文履行、恢复，不要求用户重复付款。
- 0.9.1 改善关于页的长内容和抖音码展示；全屏自动隐藏设计已经取消，两端不提供该模式。Mac 已完成清理版菜单、形象切换、关于页及退出重启检查；Windows 构建和实际导入器回归通过，完整实机界面验收由用户在发布后完成，不将其标为已通过。
- 0.9.0 安装文件仍保留，可从历史发布页回退。当前执行状态见 [WORK_PLAN.md](WORK_PLAN.md)。

## 项目资料入口

源码、官网、管理后台和支付服务属于同一个项目，目录归属与资料导航统一查看 [PROJECT_HOME.md](PROJECT_HOME.md)。
本文件负责产品介绍、下载与构建说明；任务执行记录查看 [WORK_PLAN.md](WORK_PLAN.md)，产品规划查看 [PRODUCT_ROADMAP.md](PRODUCT_ROADMAP.md)。

仓库：<https://github.com/Mr-shanqiu/niuma-ELEC-gongde>
许可证：[GPL v3](LICENSE) — 任何人可以自由使用、修改和分发，但如果分发衍生作品（包括商用），必须以相同许可证开源全部代码。

## 下载

- [GitHub v0.9.1 发布页](https://github.com/Mr-shanqiu/niuma-ELEC-gongde/releases/tag/v0.9.1)
- [macOS 0.9.1 DMG 国内下载](https://download.gongde.zqscreen.cn/niuma-merit-macos-0.9.1.dmg)：`3134634` 字节；SHA-256：`a3b84bd6ae2a2781b907a3a090a0b8a668ef9897b59ce5f6a4ad325e61107cab`。
- [Windows 0.9.1 安装程序国内下载](https://download.gongde.zqscreen.cn/niuma-merit-windows-0.9.1-setup.exe)：`3230792` 字节；SHA-256：`ea2368ab64cbd7444823e1f0ad3cdd79f563bdb97a37eb40fd1182bc0ae6724e`。
- [0.9.1 发布说明与验收边界](docs/RELEASE_0.9.1.zh-CN.md)
- [历史 0.9.0 发布页与回退文件](https://github.com/Mr-shanqiu/niuma-ELEC-gongde/releases/tag/v0.9.0)
- [免签名安装、升级与卸载指南](docs/INSTALL_UNSIGNED.md)
- 此次 macOS 使用 Apple Development 签名，不是 Developer ID 分发签名，未公证；Windows 未签名。两端仍可能出现系统安全提示，不承诺无 Gatekeeper / SmartScreen 提示。

## 什么是本软件

这是一个无音效、低干扰的原生桌面木鱼，目标支持 Windows 与 macOS。软件在系统范围内监听键盘按下和全部鼠标按键，并将连续滚轮事件合并为一次滚动手势；只统计操作次数，不读取按键内容、鼠标坐标、窗口名称或剪贴板内容。

- 首次运行默认开启“登录后自动启动”，右键菜单可随时关闭或重新开启
- 右键菜单支持：关于、登录后自动启动、更换形象、功德日历、退出
- 仅展示总数和实时 `+1` 动画，不展示品牌文案、广告位或排行榜
- 使用本地透明 PNG 绘制形象，不包含音频、WebView 或远程资源
- macOS 0.7.0 与 Windows 0.7.1 支持双击导入纯数据 `.nmgpack`，可在一个窗口内预览、选择、更新和删除本地形象
- 完全本地持久化（总数、窗口位置、隐私说明确认状态和自启动设置）

## 隐私与离线边界

- 客户端不联网，不包含网络框架与遥测/更新/广告 SDK。
- macOS 为支持系统级 `CGEventTap` 不启用 App Sandbox；源码不调用网络 API，构建时执行离线审计。
- 可下载官方发布页时统计下载请求，但不能得出真实安装量、启动量、活跃量或卸载量。
- 用户转发安装包不会被官方下载统计追踪。
- 形象包只包含严格校验的 JSON、PNG 和关键帧数据，不能修改应用功能。投稿先通过程序安全校验，再交云端 AI 审核；符合条件的明确通过结果可自动上架，不确定或异常结果不自动放行。AI 审核不替代程序安全校验。
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
- `BASE_APP_ZIP_BYTES`：不含独立形象包的基础应用压缩包大小，必须小于 10MB
- `SAMPLE_PACK_BYTES`：单独生成的示例形象包大小，不计入基础应用上限

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

## 0.9.0 签名与安全提示

- Windows 版不做代码签名，因此系统可能显示“未知发布者”，SmartScreen 或安全软件也可能拦截。
- SmartScreen 警告与 Smart App Control 的执行阻止不是同一种提示。后者可能没有单文件“仍要运行”入口；已连接的 Win11 验收机在 Smart App Control 开启时发生启动错误 4551，不能把下载或安装完成当成客户端已正常运行。不要为此关闭系统保护。
- macOS 0.9.0 使用 Apple Development 签名，没有 Developer ID 分发签名和苹果公证，首次打开仍可能被 Gatekeeper 拦截，需要在 Finder 或“隐私与安全性”中按系统提示手动允许。
- 这些系统提示无法通过官网、开源或说明文档消除。请从上述正式国内地址或本仓库的 Releases 下载，并在需要时核对 SHA-256。
- 不建议为运行本软件而全局关闭操作系统或杀毒软件的安全防护。

## 历史实测记录（不代表 0.9.0 验收）

### Windows 0.6.0（云端真实构建 + 用户真机验收）

- GitHub Actions 已在真实 `windows-2022` runner 上用 MSVC Release 构建成功（`Visual Studio 17 2022`，x64）。
- 正式主分支构建记录：<https://github.com/Mr-shanqiu/niuma-ELEC-gongde/actions/runs/34935403077>。
- 产物：`niuma-merit.exe` 约 `2.27MB`，ZIP 约 `2.03MB`，低于不含形象包的 `10MB` 上限。
- 静态链接 C/C++ Runtime，用户无需安装 VC 运行库。
- 用户已在**一台真实 Windows 电脑**上确认 0.6.0 全局输入计数、基本界面和海狮 `.nmgpack` 导入正常。
- 真机结论只覆盖“单台机器 + 基础运行”，不等于 Windows 7 / 10 / 11 全版本兼容，也不替代逐项输入行为、自启动和性能测试。

### macOS（本机构建与运行）

- 本地构建脚本 `./scripts/build-macos.sh` 成功。
- `lipo -info`：`x86_64 arm64`（Universal 2）。
- `codesign -d --entitlements -` 不包含 App Sandbox 或网络 entitlement。
- 0.6.0 `.app` 约 `4.19MB`，ZIP 约 `4.04MB`，DMG 约 `4.44MB`；基础应用压缩包不超过 `10MB`，下载形象包单独计算。
- 演示 DMG 已通过 `hdiutil verify` 完整性校验。
- 启动 8 秒后实测：RSS 约 `35MB~46MB`，空闲 CPU 长时均值接近 `0%`。
- 登录后自启动 LaunchAgent 已实现并被 macOS 接受。

### 静态离线审计

- `./scripts/audit-offline.sh` 会扫描 `src/`、`scripts/`、`.github/` 与 `CMakeLists.txt`，确认不存在读取键码、鼠标坐标、窗口信息或联网能力的代码。
- 未安装 `rg` 时脚本自动降级为 `grep`；任一工具执行出错会被判定为审计失败，不会误报通过。

## 尚未验收（不声称已完成）

- Windows：系统版本兼容性矩阵（Windows 7 SP1 / Windows 10 22H2 / 当前 Windows 11）、多显示器混合 DPI、100%/125%/150%/200% 缩放、长时间高频输入、CPU 与内存实测。
- macOS：干净环境首次权限引导流程、Intel Mac 真机运行、权限被系统撤销后的恢复、Developer ID 签名、苹果公证与 staple、Gatekeeper 验证。
- 两个平台：多台普通用户电脑的免签名下载、安全提示处理与升级流程验收。

## 环境说明

- 本机（macOS 开发机）未安装 `cmake`，通用 CMake 构建路径无法在本机复现；macOS 直接使用 `scripts/build-macos.sh`，Windows 使用 `scripts/build-windows.ps1` 或 GitHub Actions。

## 本地形象包（历史 0.7 说明；永久包使用 0.9.0）

- 双击 `.nmgpack` 即可导入；同一形象 ID 再次导入会在完整校验后安全更新。
- “更换形象”直接展示全部内置形象和本机已安装形象，确认后立即切换；本地形象可删除，功德数据不受影响。
- 形象包只能包含 JSON 动画参数和 PNG，不能修改计数、权限、菜单或任何客户端功能。
- 基础应用 ZIP 上限为 `10MB`；单独下载的 `.nmgpack` 不计入基础应用体积。
- 制作和校验命令：`./scripts/appearance-pack.py build|validate`。
- 示例包输出：`dist/sample-packs/woodfish-sample.nmgpack`。
