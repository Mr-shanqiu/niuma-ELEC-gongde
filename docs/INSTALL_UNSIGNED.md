# 安装、升级与卸载指南

当前官方下载入口：<https://gongde.zqscreen.cn/download.html>。安装图解：<https://gongde.zqscreen.cn/install.html>。GitHub 历史发行记录：<https://github.com/Mr-shanqiu/niuma-ELEC-gongde/releases>。

截至 2026-10-21，当前官网正式版本为 0.9.4：

- macOS（build 904.14）：<https://download.gongde.zqscreen.cn/niuma-merit-macos-0.9.4-90414-notarized-68b0aeeedd2f.dmg>。
- Windows（已签名）：<https://download.gongde.zqscreen.cn/niuma-merit-windows-0.9.4-signed-323514c9cbaf-setup.exe>。

旧版安装文件保留用于回退，不是当前默认下载。最新入口和校验值以[官网](https://gongde.zqscreen.cn/download.html)及其公开校验清单为准。

当前 Windows 客户端和安装包均有代码签名。macOS 客户端、安装器和 DMG 均有 Developer ID 分发签名，客户端与最终 DMG 已完成苹果公证并装订票据；系统仍可能询问是否打开从互联网下载的应用。

## Windows

### 当前 Windows 安装程序（EXE）

当前官网正式 Windows 版本为 0.9.4，下载使用 `.exe` 安装程序，不需要解压 ZIP。以后以官网公布的正式版本与校验值为准；使用 GitHub 发行页时核对该页的实际版本。仓库或验收候选中的版本号不代表已经正式发布。

1. 从官网获取 `.exe` 安装程序，双击开始安装。
2. 如果出现 SmartScreen 的“Windows 已保护你的电脑”，先核实文件来源与校验值；仅在系统确实提供“更多信息”和“仍要运行”时，按该提示处理。不要关闭系统安全防护。
3. 按安装向导完成安装；桌面快捷方式默认创建，也可在安装时关闭。卸载使用 Windows 的“已安装的应用”。

当前安装图解：https://gongde.zqscreen.cn/install.html 。高级用户可核对官网 SHA-256 清单；校验值不等于代码签名。

如果显示“应用程序控制策略已阻止此文件”、启动错误 4551，或 Smart App Control 拦截，这与一般 SmartScreen 提示不同。此类策略可能没有单文件放行按钮；请保留错误信息并联系开发者，不要关闭 Smart App Control、杀毒软件或其他系统保护。SHA-256 一致只说明文件一致，不能代替系统信任判断。

### 历史 ZIP 版本参考

下面原 ZIP 流程仅供历史版本参考，不适用于当前 EXE 安装程序；不要把历史版本号当成当前官方下载版本。

1. 仅在使用已核实的历史版本时，按该版本的 ZIP 文件名下载，例如 `niuma-merit-windows-0.7.1.zip`。
2. 将 ZIP 解压到一个固定文件夹，然后再运行 `niuma-merit.exe`。不要长期直接从“下载”或临时目录运行。
3. SmartScreen 可能显示“Windows 已保护你的电脑”或“未知发布者”。只有在确认文件来自上述官方 Releases，且校验值匹配时，才选择“更多信息”后继续运行。
4. 首次运行后，程序会在当前 Windows 用户范围注册 `.nmgpack` 文件类型，不需要管理员权限。

### 形象包

1. 新的永久形象包需要 0.9.0 或更高版本客户端，先正常运行一次以注册文件关联。
2. 在官网选择扩展形象，用有效群码或作者码免费领取。单个形象下载 `.nmgpack`，多个形象合为一个 `.nmgpacks` 文件，不需要逐个下载。
3. 双击已保存的文件完成导入，再右键宠物选择“更换形象”，选中目标形象并确认。不要仅凭“导入成功”判断桌面已经切换。
4. 领取码只在官网使用，客户端不联网核验付款或领取码。文件可永久导入并离线使用；服务器签发后 7 日内可重新下载，服务器重下期限不限制本地导入。基础木鱼随客户端免费提供，无需领取码。

### 升级

1. 右键宠物并选择“退出”。
2. 从官方入口下载新版 EXE 安装程序，按向导安装到原位置，不要另建多个同名副本。
3. 从安装后的快捷方式启动，并在“关于”中确认版本。功德数据与本地形象保存在用户数据目录，升级时不要删除该目录。
4. 只有历史便携 ZIP 版才使用“退出后替换固定目录中的 EXE”方式；不要把该方式套用到当前安装程序。若从便携版迁移，退出旧副本，不再通过旧路径启动。

### 卸载

1. 在右键菜单中关闭“登录后自动启动”，然后退出程序。
2. 当前 EXE 安装版使用 Windows“已安装的应用”中的卸载入口；只有历史便携 ZIP 版才直接删除其程序文件夹。
3. 本地功德记录与形象默认保留，避免误删；卸载旧程序本身不保证解决系统执行策略问题。

## macOS

### 首次安装

1. 从官网下载当前 DMG，核对同版本校验值，不要误用旧版或验收候选。
2. 打开 DMG，双击其中的安装器，选择“安装并打开”；安装器将应用放入“应用程序”并自动启动。
3. 本版已签名并公证。首次打开时如系统询问是否打开从互联网下载的应用，核对来源后确认；若提示已损坏或恶意软件，请停止并联系开发者。
4. 按应用内引导打开“输入监控”权限。该权限的系统名称范围大于本软件的实际用途；本软件只计数，不读取或保存输入内容。

新永久形象包同样需要 0.9.0 或更高版本；双击 `.nmgpack` 或 `.nmgpacks` 导入，再在“更换形象”中选择并确认。客户端不要求输入领取码，也没有首次导入到期限制。

### 升级

1. 退出旧版。
2. 打开新版 DMG，运行其中的安装器，按提示替换同名应用。
3. 始终使用同一应用名称和 `/Applications` 路径，不要并存多个副本。
4. 替换后 macOS 仍可能要求重新确认“输入监控”，无法保证永远不重复提示。使用相同签名身份与固定路径可以减少身份变化，但不能保证已有授权永远有效。
5. 只点击形象能计数、其他软件中的操作不能计数时，请按应用提示检查当前副本的“输入监控”授权，并按系统要求退出重开。卸载旧版再安装并不保证自动获得新副本的权限；不要删除用户数据或关闭系统保护来处理授权。

### 卸载

1. 在右键菜单中关闭登录后自动启动，然后退出。
2. 从“应用程序”删除“牛马电子功德”。本地功德记录会默认保留，避免误删。

## 安全校验

使用官网公布的同版本 SHA-256，或对应 GitHub 发行页实际提供的校验清单核对文件。不要用历史版本的校验值检查新版。校验值只能证明下载文件与项目发布的文件一致，不能替代操作系统的代码签名。

If you use the English UI: download the current release from the official website. Use the signed Windows EXE installer, or open the macOS DMG and run its one-click installer. ZIP instructions apply only to historical portable Windows builds. Permanent appearance packs require version 0.9.0 or later; import the saved file and then select the appearance. The current macOS build is Developer ID signed and notarized by Apple. macOS may still ask you to confirm opening software downloaded from the internet. SmartScreen warnings and Smart App Control execution blocks differ; a matching SHA-256 does not grant system trust. Do not disable system-wide security protection.
