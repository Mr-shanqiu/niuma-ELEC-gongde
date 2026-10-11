# 牛马电子功德

> 当前业务以 [全免费领取与共创 PRD 1.1](docs/PRD_FREE_DOWNLOAD_AND_CO_CREATION.zh-CN.md) 为准。新领取全免费；旧收费、权益码和 24 小时首次导入规则已被替代，仅保留既有付费订单的历史履行与恢复。下文旧版本实测记录不是 0.9.2 的验收结果。

## 0.9.2 客户端交付与免费领取状态

- 当前国内公开下载与官网安装登记为 macOS / Windows 0.9.2。GitHub 安装文件以实际发行列表为准；源码版本号不替代制品和验收证据。
- 免费领取服务、统一形象库和创作者自动审核沿用已上线实现。真实群码领取、作者投稿与另一个浏览器使用作者码下载已有证据；本次客户端交付不代表官网/API 的冷首屏性能或整轮产品优化已经全部完成。
- 基础木鱼和公开安装包免费，不需要领取码。扩展形象的新领取全免费，统一形象库按有效群码或创作者码范围授权，每批最多 10 个；码不作为付款凭证。
- 新交付使用签名永久包，文件可永久导入并离线使用，没有 24 小时首次导入限制。0.9.0 客户端兼容验证历史 timed 包的原签名，不因旧首次导入日期已过而拒绝导入。
- 同一批次在服务器签发后 7 日内可重新下载；超过 7 日不再保证服务器重下，不影响已保存文件的永久导入与本地使用。单个形象交付 `.nmgpack`，多个形象交付一个 `.nmgpacks` 批次文件。
- 不再创建新收费订单；既有已付款订单仍按原订单上下文履行、恢复，不要求用户重复付款。
- 0.9.2 改善监听状态、首次使用引导和导入结果：区分仅点击计数、监听建立但待检查、已观察到全局输入；提供用户主动的约 10 秒跨应用自检，无输入时不判故障。只统计事件次数和相对时间，不采集输入内容、键值、坐标或窗口信息。
- 单包导入成功后明确询问是否启用；批次展示本次新增和当前形象，允许选择而不隐式切换到最后一项；重复、损坏和部分成功结果分别提示。失败提示使用简短中文，不向用户显示本机文件路径或子进程原始错误。
- Mac 0.9.2 已有本地 Universal 2 构建与正常启动 GUI 证据；用户已确认有效权限下计数持续稳定。Windows 0.9.2 已通过此前实际 MSVC CI 构建和制品绑定，数值版本为 `0.9.2.0`；本批 Win11 GUI 未执行，不将构建结果称为真机界面验收。
- 0.9.2 的关于页和抖音码改善保留；全屏自动隐藏设计已经取消，两端不提供该模式。0.9.2、0.9.0 安装文件和历史发布页保留，旧验收记录不冒充 0.9.2 验收。当前执行状态见 [WORK_PLAN.md](WORK_PLAN.md)。

## 项目资料入口

源码、官网、管理后台和支付服务属于同一个项目，目录归属与资料导航统一查看 [PROJECT_HOME.md](PROJECT_HOME.md)。
本文件负责产品介绍、下载与构建说明；任务执行记录查看 [WORK_PLAN.md](WORK_PLAN.md)，产品规划查看 [PRODUCT_ROADMAP.md](PRODUCT_ROADMAP.md)。

仓库：<https://github.com/Mr-shanqiu/niuma-ELEC-gongde>
许可证：[GPL v3](LICENSE) — 任何人可以自由使用、修改和分发，但如果分发衍生作品（包括商用），必须以相同许可证开源全部代码。

## 下载

- [macOS 0.9.2 DMG 国内下载](https://download.gongde.zqscreen.cn/niuma-merit-macos-0.9.2.dmg)：`2872994` 字节；SHA-256：`dbc8d72e41b33a9ab5b2e4f44b7e099fd15c6a9bd8bcb914682f1f97a0cd3fc7`。
- [Windows 0.9.2 安装程序国内下载](https://download.gongde.zqscreen.cn/niuma-merit-windows-0.9.2-setup.exe)：`3239118` 字节；SHA-256：`79f85fb1a7e1d94de27bebf850561f726705a3e22143f08f4a95a29230272c25`。
- [GitHub 客户端发行列表](https://github.com/Mr-shanqiu/niuma-ELEC-gongde/releases)：只以列表内实际公开的文件为准，不把候选分支、自动 CI 制品或源码归档当作已发布安装包。
- Windows 原包来自源码 `ad51bb018948edb76f3efc1213b44ed19af350e2`、[既有构建 38143857784](https://github.com/Mr-shanqiu/niuma-ELEC-gongde/actions/runs/38143857784)、安装制品 `11703279500`。发行复用这份原包，不以随后自动 CI 产物替换。
- [历史 GitHub v0.9.2 发布页](https://github.com/Mr-shanqiu/niuma-ELEC-gongde/releases)、[0.9.2 发布说明与验收边界](docs/RELEASE_0.9.2.zh-CN.md)
- 历史 [macOS 0.9.2 DMG](https://download.gongde.zqscreen.cn/niuma-merit-macos-0.9.2.dmg)：`2872994` 字节；SHA-256：`dbc8d72e41b33a9ab5b2e4f44b7e099fd15c6a9bd8bcb914682f1f97a0cd3fc7`。
- 历史 [Windows 0.9.2 安装程序](https://download.gongde.zqscreen.cn/niuma-merit-windows-0.9.2-setup.exe)：`3239118` 字节；SHA-256：`79f85fb1a7e1d94de27bebf850561f726705a3e22143f08f4a95a29230272c25`。
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

## 当前签名与安全提示

- Windows 版不做代码签名，因此系统可能显示“未知发布者”，SmartScreen 或安全软件也可能拦截。
- SmartScreen 警告与 Smart App Control 的执行阻止不是同一种提示。后者可能没有单文件“仍要运行”入口；已连接的 Win11 验收机在 Smart App Control 开启时发生启动错误 4551，不能把下载或安装完成当成客户端已正常运行。不要为此关闭系统保护。
- macOS 0.9.2 使用 Apple Development 签名，没有 Developer ID 分发签名和苹果公证，首次打开仍可能被 Gatekeeper 拦截，需要在 Finder 或“隐私与安全性”中按系统提示手动允许。
- 这些系统提示无法通过官网、开源或说明文档消除。请从上述正式国内地址或本仓库的 Releases 下载，并在需要时核对 SHA-256。
- 不建议为运行本软件而全局关闭操作系统或杀毒软件的安全防护。

### 代码签名政策

当前 Windows 安装包未签名，没有任何当前版本被表示为已获 SignPath 签名或认可。尚未取得并接入 SignPath Foundation 签名支持；不把申请、源码公开或下载量当作批准。

若未来获批并完成集成，Windows 签名版本才使用归属说明：“Free code signing provided by [SignPath.io](https://signpath.io), certificate by [SignPath Foundation](https://signpath.org).”这只描述预期服务，不代表当前已获批。

- 维护、代码审查和签名审批：Yue Wang（[Mr-shanqiu](https://github.com/Mr-shanqiu)）。
- 计划签名范围：来自公开仓库并通过 GitHub Actions 构建的本项目 Windows 客户端和安装程序；签名集成待审批，每次签名均需维护者人工批准。
- 外部贡献需经维护者审查。启用签名前，源码仓库和签名服务访问需使用多重身份验证。
- 签名申请不覆盖网站、支付服务、第三方应用或 macOS Developer ID 签名与公证。

## 历史实测记录（不代表 0.9.2 验收）

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

## 当前交付边界（2026-10-11）

官网默认 Mac 和 Windows 安装包均为 0.9.2；GitHub 下载以对应发行页实际提供的版本和原始文件为准。旧版制品仍保留，不要用旧校验值核对新版。Windows 0.9.2 原包来源为源码 ad51bb018948edb76f3efc1213b44ed19af350e2、Actions run 38143857784；原生源码的后续同步提交不改变此构建来源。Mac 原包沿用已接受的本地 universal 候选，不重建或重签名。

Mac 使用 Apple Development 签名，非 Developer ID，未公证；Windows 未签名。Windows 0.9.2 完整实机 GUI 验收未声明完成。用户确认取得有效输入权限后计数稳定，不重复测试或改动计数核心；系统权限说明与计数故障分别处理。官网首屏性能优化仍未全部完成，不把客户端发布当成整轮产品目标达成。
