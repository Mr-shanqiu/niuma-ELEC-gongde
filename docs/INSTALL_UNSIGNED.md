# 免签名版安装、升级与卸载指南

官方下载地址：<https://github.com/Mr-shanqiu/niuma-ELEC-gongde/releases>

本项目当前不购买 Windows 代码签名证书，也不进行 macOS Developer ID 分发签名和苹果公证。操作系统可能显示安全警告，这些警告无法通过官网或开源代码自动消除。

## Windows

### 首次运行

1. 从 GitHub Releases 下载 `牛马电子功德-Windows-0.6.0.zip`。
2. 将 ZIP 解压到一个固定文件夹，然后再运行 `niuma-merit.exe`。不要长期直接从“下载”或临时目录运行。
3. SmartScreen 可能显示“Windows 已保护你的电脑”或“未知发布者”。只有在确认文件来自上述官方 Releases，且校验值匹配时，才选择“更多信息”后继续运行。
4. 首次运行后，程序会在当前 Windows 用户范围注册 `.nmgpack` 文件类型，不需要管理员权限。

### 形象包

1. 先运行一次 0.6.0 或更高版本客户端。
2. 双击从官方 Releases 下载的 `.nmgpack`。
3. 导入成功后会立即启用新形象。右键宠物并选择“更换形象”，可切换或删除本地形象。

### 升级

1. 右键宠物并选择“退出”。
2. 用新版 `niuma-merit.exe` 替换原来固定文件夹中的同名文件。
3. 启动新版。功德数据与本地形象包保存在用户数据目录，不会因替换 EXE 丢失。
4. 如果已启用登录后自动启动，新版启动时会刷新当前 EXE 路径。

### 卸载

1. 在右键菜单中关闭“登录后自动启动”，然后退出程序。
2. 删除程序文件夹即可。本地功德记录会默认保留，避免误删。

## macOS

### 首次安装

1. 从 GitHub Releases 下载 `牛马电子功德-macOS-0.6.0.dmg`。
2. 打开 DMG，将应用拖入“应用程序”，不要长期从 DMG 或下载目录运行。
3. 如果双击被拦截，在 Finder 中右键应用并选择“打开”。如果仍被拦截，在“系统设置 > 隐私与安全性”中确认自己下载的文件后手动允许。
4. 按应用内引导打开“输入监控”权限。该权限的系统名称范围大于本软件的实际用途；本软件只计数，不读取或保存输入内容。

### 升级

1. 退出旧版。
2. 将新版应用拖入“应用程序”，替换同名应用。
3. 始终使用同一应用名称和 `/Applications` 路径，不要并存多个副本。
4. 免签名版替换后，macOS 仍可能要求重新确认“输入监控”，无法保证永远不重复提示。

### 卸载

1. 在右键菜单中关闭登录后自动启动，然后退出。
2. 从“应用程序”删除“牛马电子功德”。本地功德记录会默认保留，避免误删。

## 安全校验

Releases 会同时提供 `SHA256SUMS.txt`。校验值只能证明下载文件与项目发布的文件一致，不能替代操作系统的代码签名。

If you use the English UI: download only from the official Releases page, extract the Windows ZIP to a permanent folder before running it, or copy the macOS app to Applications. These builds are intentionally not distribution-signed, so Windows SmartScreen and macOS Gatekeeper warnings may appear. Do not disable system-wide security protection; verify the SHA-256 file instead.
