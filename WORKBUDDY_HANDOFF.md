# 牛马电子功德 WorkBuddy 项目交接文档

交接日期：2026-09-10  
当前版本：`0.3.0`  
本地项目：`/Users/yue/Desktop/牛马电子功德`  
公开仓库：<https://github.com/Mr-shanqiu/niuma-ELEC-gongde>

## 1. 项目目标

“牛马电子功德”是一个 Windows 与 macOS 原生桌面小工具。它以透明、置顶、可拖动的桌面宠物形式展示木鱼和敲棒，在用户进行系统级键盘或鼠标操作时累计“功德”。

产品不是网页、浏览器插件或 Electron 应用，也不依赖 Python、Node.js 或用户额外安装的运行环境。

核心体验：

- 顶部常驻显示累计数字，不显示“功德总数”等文字标签。
- 中部平常完全为空，仅在敲击接触阶段短暂显示固定的 `+1`。
- 底部显示木鱼与敲棒；木鱼保持静止，只有敲棒执行落下和回弹动画。
- 总数在输入事件到达时立即增加，不能等待动画。
- 高频输入不建立动画欠账；当前动作结束后停止，不补敲历史事件。
- 不包含音效。

## 2. 不可改变的产品边界

除非用户以后明确重新授权，否则不得加入以下能力：

- 广告或品牌加持文案。
- 网络请求或服务端依赖。
- 安装量、活跃量、崩溃或使用行为遥测。
- 自动更新。
- 账号、云同步、排行榜或皮肤商城。
- 读取、保存或上传具体按键内容、键码、鼠标位置、窗口标题、当前应用、剪贴板或截图。
- Linux 版本。
- Electron、WebView、Python 或其他会明显增加包体的运行时。

当前客户端必须保持完全离线，功德总数及设置只保存在本机。单平台发布包目标小于 `5MB`。

## 3. 输入计数规则

- 任意全局键盘 `keyDown` 事件计数一次。
- 按住按键产生的系统自动重复事件按实际收到的 `keyDown` 次数计数。
- 鼠标左键、右键、中键和扩展按键的每次按下计数一次。
- 鼠标双击产生两次按下，因此计数两次。
- 一段连续滚轮底层事件合并为一次滚动手势，计数一次。
- 暂停状态下不计数、不播放动画。
- 总数按事件即时准确增加；动画可以限速，但不能影响账本。

隐私实现要求：

- macOS 使用只读的 `CGEventTap`，回调只根据事件类型计数。
- Windows 使用 `WH_KEYBOARD_LL` 与 `WH_MOUSE_LL`，Hook 回调只判断消息类型并通知 UI 线程。
- 不解读输入事件结构体中的键码、扫描码、坐标或窗口信息。

## 4. 当前技术实现

### 4.1 公共部分

- 语言：C++17；macOS 界面为 Objective-C++。
- 构建：CMake 加平台脚本。
- 资源：`assets/woodfish.png` 与 `assets/mallet.png`。
- 版本来源：`VERSION`，当前为 `0.3.0`。
- 无第三方运行库、WebView、音频、网络库或遥测 SDK。

### 4.2 macOS

- 主入口：`src/macos/app.mm`。
- 系统 API：AppKit、ApplicationServices、`CGEventTap`。
- 输入权限：需要用户在“隐私与安全性 > 输入监控”中允许。
- 架构：构建脚本同时生成 `arm64` 与 `x86_64`，合并为 Universal 2。
- 最低部署目标：macOS 10.15。
- 自启动：使用用户目录下的 LaunchAgent，不需要管理员权限。
- 开发包采用 ad-hoc 签名，因此二进制改变后可能需要重新授予输入监控权限。

### 4.3 Windows

- 主入口：`src/windows/app.cpp`。
- 系统 API：Win32、GDI+、低级键盘和鼠标 Hook。
- MSVC Runtime 静态链接，用户无需安装 Visual C++ 运行库。
- 自启动：当前用户的注册表 Run 项，不需要管理员权限。
- 构建目标：Windows x64。
- 当前 EXE 未签名，因此 Windows 显示“发布者未知”。

## 5. 当前真实完成状态

### 5.1 Windows 已完成的事实

- GitHub Actions 已在真实 `windows-2022` runner 上完成 MSVC Release 构建。
- 成功构建记录：<https://github.com/Mr-shanqiu/niuma-ELEC-gongde/actions/runs/34441378345>
- 对应修复提交：`ccc10a8`，修复 Win32 `LONG` 与 `int` 的坐标类型冲突。
- 构建产物为 64 位 PE 可执行文件。
- EXE 实测体积约 `712KB`。
- ZIP 实测体积约 `628KB`。
- ZIP 完整性检查通过。
- 用户已将产物放到真实 Windows 电脑运行，并确认应用能够正常运行。
- 用户目前报告的唯一明确 Windows 问题：启动时显示“发布者未知”。

本地 Windows 测试包：

`/Users/yue/Desktop/niuma-merit-windows-0.3.0-Release.zip`

SHA-256：

- EXE：`6ec4f46b93c420cb867603091e742c83045fe2fd16bb46dc64b30eef42d213e8`
- ZIP：`7cbb9e300a51ed0de74a789066cdb6082012590722116cbb6478c0cd7f0f6f95`

注意：“真实 Windows 电脑运行正常”只能证明该次测试机上的基础运行通过，不能自动扩展为 Windows 7、Windows 10、Windows 11 全版本兼容性结论，也不能替代性能、每项输入行为和自启动测试记录。

### 5.2 macOS 已完成的事实

- 原生 Universal 2 构建曾成功，包含 `arm64` 与 `x86_64`。
- 演示 DMG 曾成功生成并通过磁盘镜像校验。
- 最近已知演示 DMG：`/Users/yue/Desktop/牛马电子功德/dist/niuma-merit-macos-demo-0.3.0.dmg`。
- 最近已知 DMG 体积约 `1.08MB`，小于 `5MB` 目标。
- 静态离线审计曾通过。
- 登录后自启动 LaunchAgent 已实现并被 macOS 接受。
- 空闲 CPU 曾观察到接近 `0%`，RSS 曾观察到约 `35MB~46MB`。

尚不能宣称：

- 当前版本已完成 Developer ID 正式签名和苹果公证。
- 当前构建已在干净的 Intel Mac 上完成真实兼容性验收。
- 当前输入监控授权和全局计数已经完成最终发布级复测。

## 6. 当前发布与签名状态

### 6.1 Windows

当前 ZIP 和 EXE 是未签名测试包，所以 Windows 显示“发布者未知”。这不是运行故障。

已讨论的发布路线：

1. 推荐低成本路线：注册 Microsoft Store 个人开发者账户，将应用封装为 MSIX 并提交商店。新流程下个人账户可免费注册，但需要身份验证。由商店分发的 MSIX 会由 Microsoft 签名。
2. 如果官网直接托管 EXE/ZIP：必须另外使用可信 Authenticode 代码签名证书，才能显示经过验证的发布者。Microsoft Store 上架不会自动给官网 EXE 提供签名。
3. 自签名证书只适合内部测试，不能解决普通公众设备上的信任问题。

用户尚未正式授权购买证书，也尚未最终确认开始 Microsoft Store 上架。WorkBuddy 不得自行注册账户、提交商店、购买证书或发布 Release。

### 6.2 macOS

- 开发和本机测试不需要付费 Apple Developer Program。
- 面向公众从官网直接分发时，建议使用 Apple Developer Program、Developer ID Application、Hardened Runtime 和 notarization。
- 当前没有正式 Developer ID 签名或公证成功证据。
- WorkBuddy 不得索取、保存或提交 Apple ID 密码、证书私钥、notary 凭据或其他秘密。

## 7. 文件地图

- `README.md`：产品介绍和构建说明；其中“Windows 尚未真实构建”等状态已经过时，接手后应依据本文更新。
- `PRIVACY.md`：当前离线与输入隐私承诺。
- `WORK_PLAN.md`：早期详细开发执行方案。产品边界仍有效，但“当前尚未验收”等状态段落已经过时，不能覆盖本文的最新实测事实。
- `CMakeLists.txt`：双平台构建定义。
- `VERSION`：唯一版本号来源。
- `assets/woodfish.png`：木鱼资源。
- `assets/mallet.png`：敲棒资源。
- `src/macos/app.mm`：macOS 主实现。
- `src/macos/Info.plist.in`：macOS 应用元数据。
- `src/windows/app.cpp`：Windows 主实现。
- `src/windows/app.manifest`：Windows 清单与兼容设置。
- `src/windows/app.rc`：Windows 资源文件。
- `scripts/build-macos.sh`：Universal 2 macOS 开发构建与 ZIP 打包。
- `scripts/package-macos-dmg.sh`：macOS 演示 DMG 打包。
- `scripts/build-windows.ps1`：Windows x64 MSVC Release 构建、EXE 与 ZIP 输出。
- `scripts/audit-offline.sh`：静态隐私和离线边界审计。
- `.github/workflows/windows-build.yml`：公开仓库 Windows 云构建。

## 8. 文档与实现之间需要立即校正的地方

- `README.md` 仍称 Windows 未完成真实构建和验收；应改为“云端真实 Windows 工具链构建通过，用户真机基础运行通过，详细兼容性与性能矩阵仍未完成”。
- `WORK_PLAN.md` 是历史执行方案，其中多项“当前尚未验收”已经完成或部分完成。不得删除其产品约束，但应增加当前状态附录或由本文作为最新状态依据。
- `WORK_PLAN.md` 的早期视觉规格仍写“木鱼轻微受击”和顶部文字标签；用户后来明确要求木鱼不动、不要“功德总数”文字。因此当前用户确认优先于早期视觉描述。
- `README.md` 描述右键菜单包含暂停、清空、隐私说明、自启动与退出，但 Windows 与 macOS 的具体菜单能力需要逐项真机核对后再作双平台一致性声明。

## 9. WorkBuddy 接手后的推荐顺序

1. 读取本文、`README.md`、`PRIVACY.md`、`WORK_PLAN.md`、两个平台源码和构建脚本，建立当前事实清单。
2. 不改功能，先更新 `README.md` 中已经过时的 Windows 验收状态，并增加清晰的“测试包未签名”说明。
3. 对照用户已确认的最终视觉要求检查两平台：木鱼静止、敲棒运动、顶部只有数字、`+1` 平常隐藏且不被敲棒遮挡。
4. 在真实 Windows 机器补齐逐项测试记录：键盘、左/右/中/扩展鼠标按键、滚轮手势、高频输入、暂停、持久化、窗口拖动、右键菜单、自启动、CPU 与内存。
5. 明确记录 Windows 测试机系统版本；没有真实设备就不得声称 Windows 7/10/11 全兼容。
6. 在当前 macOS 版本重新构建、执行离线审计，并复测输入监控授权后的全局计数。
7. 与用户确认 Windows 发布路线：Microsoft Store MSIX，或官网直发并购买 Authenticode 证书。
8. 只有用户明确选择 Microsoft Store 后，才新增 MSIX 打包、商店清单和发布文档；账户注册、身份验证和提交动作交给用户确认。
9. 只有用户提供并授权使用正式签名身份后，才执行 macOS Developer ID 签名、公证或 Windows 正式签名。

## 10. 验收纪律

- 源码完成不等于产品完成。
- 云构建通过不等于真实用户场景全部通过。
- 单台 Windows 运行通过不等于所有目标 Windows 版本兼容。
- 未签名包不能称为正式可信发布包。
- 未看到苹果公证成功、staple 和 Gatekeeper 验证结果，不能称为 macOS 已公证。
- 每个结论必须注明是源码检查、构建结果、本机运行、真实设备测试还是正式发布验证。
- 不执行未经用户明确授权的登录、付款、证书申请、商店提交、GitHub Release 发布或其他外部写操作。

## 11. 2026-09-10 接管后已完成的修正

以下为源码级修正，均**只完成源码检查与 macOS 构建验证**，Windows 尚未重新走云端构建：

1. `scripts/audit-offline.sh`：消除“假通过”。`rg` 缺失时降级为 `grep`，工具执行出错判定为失败；扫描范围扩大到 `src/`、`scripts/`、`.github/` 与 `CMakeLists.txt`，并排除脚本自身。已用注入违规词做正反双向验证。
2. `src/windows/app.cpp`：
   - 新增暂停功能（`paused` 字段、右键“暂停/继续”、ini 持久化、暂停时不计数不启动动画）。
   - 右键菜单补齐“隐私说明”，菜单顺序与文案对齐 macOS；清空总功德增加二次确认。
   - 修复首次隐私说明弹窗把 `\n` 写成字面量的问题。
   - `+1` 改为仅在 `progress 0.30–0.70` 固定显示，去掉上浮与淡出；敲击节奏系数 `0.92 → 1.05`；接触相位 `0.36 → 0.42`；顶部数字改用等宽字体并加入超长数字缩号。
   - 新增“已暂停”提示（与 macOS 一致）。
   - 新增 `ApplyWindowDpi`，进程按窗口所在显示器 DPI 校正尺寸。
3. `src/macos/app.mm`：新增“已暂停”提示，与 Windows 保持一致。
4. `src/windows/app.manifest`：DPI 声明改为 `PerMonitorV2, PerMonitor`（原 `dpiAware=true` 会锁死 DPI 语境，导致 `WM_DPICHANGED` 永不触发）；版本号同步为 `0.3.0.0`。
5. `src/windows/app.rc`：新增 VERSIONINFO（产品名、版本、公司、原始文件名），文件保持 ASCII 以避免资源编译器编码风险。
6. `.github/workflows/windows-build.yml`：artifact 名称不再硬编码 `0.3.0`，改为读取 `VERSION`。
7. `README.md`：更新 Windows 真实构建状态、未签名说明、双平台实测数据与“尚未验收”清单；补充新仓库地址。
8. 本地 `git remote` 已更新为新仓库名；文档中的旧仓库地址已全部替换。

待验证：Windows 源码改动未经过任何 Windows 编译器验证，必须在 GitHub Actions 重新构建成功、并重新跑一遍真机逐项测试后才能称为“Windows 完成”。

## 12. WorkBuddy 接手提示词

将下面内容连同项目文件夹或公开仓库地址发送给 WorkBuddy：

```text
请接手“牛马电子功德”原生桌面小工具项目。

本地项目路径：/Users/yue/Desktop/牛马电子功德
公开仓库：https://github.com/Mr-shanqiu/niuma-ELEC-gongde

接手前必须先完整阅读：
1. WORKBUDDY_HANDOFF.md
2. README.md
3. PRIVACY.md
4. WORK_PLAN.md
5. CMakeLists.txt
6. src/macos/app.mm
7. src/windows/app.cpp
8. scripts 目录和 .github/workflows/windows-build.yml

以 WORKBUDDY_HANDOFF.md 的“当前真实完成状态”为最新状态来源；WORK_PLAN.md 中的产品边界与验收纪律仍然有效，但其中部分历史状态已经过时，不得据此重复声称 Windows 未构建。

不可改变的边界：只做 Windows 和 macOS 原生客户端；完全离线；不加入广告、联网、遥测、自动更新、账号、云同步或 Linux；不读取或保存具体按键、键码、鼠标坐标、窗口信息、剪贴板或截图；不得改成 Electron、WebView、Python 或要求用户安装运行环境；单平台包目标小于 5MB。

当前版本为 0.3.0。Windows 已通过 GitHub Actions 的真实 MSVC Release 构建，用户也已在真实 Windows 电脑确认基础运行正常；目前明确问题是未签名导致“发布者未知”。macOS 已有 Universal 2 演示 DMG 和离线审计历史证据，但尚未完成 Developer ID 正式签名、公证和最终发布级复测。

你的第一阶段任务不是重写项目，而是：
1. 核对实现与交接事实；
2. 更新 README 中过时的 Windows 状态；
3. 列出尚未完成的双平台真机测试项；
4. 检查当前视觉是否满足“木鱼不动、只让敲棒运动、顶部仅显示总数、+1 平常隐藏且绘制在敲棒之上”；
5. 给出下一步最小执行计划。

不要自行注册开发者账户、购买证书、提交 Microsoft Store、进行苹果公证或发布 GitHub Release。Windows 发布路线尚待用户最终选择：Microsoft Store MSIX，或官网直发并购买可信 Authenticode 证书。涉及登录、身份验证、付款、证书、商店提交或外部发布时必须先停下，明确告诉我需要我完成哪一项操作。

执行中必须把源码检查、构建成功、真机运行、兼容性验收和正式发布分别报告，不得互相替代。先向我提交接管审计和下一步计划，再等待我确认是否继续修改。
```

