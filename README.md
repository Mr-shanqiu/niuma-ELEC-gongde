# 牛马电子功德

一个无音效、低干扰、纯本地运行的桌面小伙伴。你打字、点鼠标，它动一下，把日常忙碌攒成一点「功德」。支持 macOS 和 Windows。

**官网：[gongde.zqscreen.cn](https://gongde.zqscreen.cn/)**  
**下载：[官网客户端下载](https://gongde.zqscreen.cn/download.html) · [GitHub v0.9.3](https://github.com/Mr-shanqiu/niuma-ELEC-gongde/releases/tag/v0.9.3)**  
**共创：[创作者工作台](https://gongde.zqscreen.cn/creator.html)**

## 当前版本

- 默认分支的客户端源码版本：**0.9.3**，见 [VERSION](VERSION)。
- 当前公开安装包：**0.9.3**，macOS DMG 和 Windows 安装程序均已发布。
- 本次同步的是已发布 0.9.3 的客户端源码及相关构建输入；官网、后台和服务端独立发布，不表示默认分支已经同步它们的全部线上源码。
- 历史标签和安装包保留供追溯，请优先使用上面的当前下载入口。

### 0.9.3 的客户端界面

右键菜单只保留：关于、自启动、更换形象、功德日历、退出。输入权限的简短说明和对应平台的官网帮助链接放在「关于」内，不额外增加诊断菜单，也不包含全屏自动隐藏功能。

基础木鱼客户端可以直接免费下载，无需登录或领取码。扩展形象的领取及创作者投稿请在官网完成；客户端不验证付款状态，不需要账号或联网即可使用已经导入的形象。

## 隐私与本地形象包

客户端离线运行，不包含联网、广告、遥测、账号、支付或自动更新。功德数和设置保存在本机。

应用统计键盘按下、鼠标按键和滚轮手势等输入事件次数，不记录具体按键内容、鼠标坐标、窗口名称或剪贴板内容。macOS 全局计数需要用户授予「输入监控」权限；该权限用于接收输入事件，不用于读取输入内容。

形象包是受严格校验的本地数据文件，只包含允许的图片、元数据和动画参数，不允许执行代码或改变客户端权限。单包使用 `.nmgpack`，批次包使用 `.nmgpacks`，在更换形象窗口中导入并选择。官网每批最多选择 10 个形象；已导入形象可永久离线使用。

## 安装与权限帮助

- macOS：[Mac 安装、升级及输入监控帮助](https://gongde.zqscreen.cn/help-macos.html)。
- Windows：[Windows 安装及使用帮助](https://gongde.zqscreen.cn/help-windows.html)。
- 仓库中的说明：[免签名安装、升级与卸载指南](docs/INSTALL_UNSIGNED.md)。

当前 macOS 安装包使用 Apple Development 签名，**不是 Developer ID 签名，也没有公证**；Windows 安装包**未签名**。Windows 可能出现未知发布者或 SmartScreen 提示，macOS 可能阻止首次打开。不要为了运行本软件而全局关闭系统安全防护。

仅从官网和本仓库的 Releases 获取安装包。正式签名、公证及不同电脑上的兼容性不能由构建成功替代，也不表示本项目已获 SignPath 签名或认可。

### 当前发布文件的 SHA-256

| 文件 | SHA-256 |
| --- | --- |
| `niuma-merit-macos-0.9.3.dmg` | `e4adfd1b866de5fa9580bb4f2b0b7449e130c96f794d6419c531bcacc996f33c` |
| `niuma-merit-windows-0.9.3-setup.exe` | `a69bff99bf39285118b7a7c0c3185d3f050e27f58fe515fc7d858409b12a21c1` |

这些摘要对应已发布的原始安装文件，不是此次文档同步重新构建的文件。

## 从源码构建

macOS：

```bash
./scripts/build-macos.sh
./scripts/package-macos-dmg.sh
```

Windows 原生客户端：

```powershell
./scripts/build-windows.ps1 -ClientOnly -ExpectedVersion 0.9.3
```

通用 CMake 构建：

```bash
cmake -S . -B build -DCMAKE_BUILD_TYPE=Release
cmake --build build --config Release
```

构建需要相应平台的编译工具链。自行构建不等同于官方安装包，不保证具有相同签名或安装摘要。

## 发布与验收边界

0.9.3 的原始安装包已完成构建、发布和下载登记；这些结果不能代替所有系统版本的用户实机验收。本次 GitHub 默认分支同步不重复测试客户端、不重建安装包，也不修改线上服务。

Windows 系统版本、混合 DPI、多显示器和长时间运行的完整兼容矩阵，以及 Intel Mac 真机、干净环境首次权限引导、正式签名和公证，仍须按对应环境分别确认。

## 许可证与贡献

源码许可证：[GPL v3](LICENSE)。任何人可以自由使用、修改和分发；分发衍生作品（包括商用）时须遵守 GPLv3 的相同许可证要求。

维护者：[Yue Wang / Mr-shanqiu](https://github.com/Mr-shanqiu)。外部代码贡献须经维护者审查。向形象社区投稿时，还需遵守官网的素材授权、免费分发及审核要求，源码许可证不代替第三方素材授权。
