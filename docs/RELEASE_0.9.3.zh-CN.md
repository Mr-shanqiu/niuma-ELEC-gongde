# 0.9.3：五项菜单与平台权限帮助

日期：2026-10-12。此版本仅落实用户确认的客户端交互边界，不包含 R1f/R1g 预览提速候选。

## 产品改动

- 右键菜单只保留关于、登录后自动启动、更换形象、功德日历、退出。
- 关于中提供简短的平台说明及一个官网帮助链接；详细操作留在官网。
- Mac 链接：https://gongde.zqscreen.cn/help-macos.html。
- Windows 链接：https://gongde.zqscreen.cn/help-windows.html。
- 安装说明页新增两平台帮助入口。保留官网其他稳定流程和旧历史订单入口。
- 不更改计数监听、形象导入、自启动或日历核心；不增加联网计数、独立诊断菜单或全屏隐藏。

## 官网发布

静态站 tree：`37cd723b2fd6eeaae24a3c2577936d2e3373dc7f8b4a497321082c13e5d9f835`。
受管发布器返回 `GONGDE_DEPLOY_OK`，无需回滚；两个帮助页和 client-help.css 的线上字节与发布内容一致。候选以当前稳定官网导出为底板，仅加入上述四个文件，不使用整个本地官网目录覆盖生产。

本次只给服务器静态发布器追加三个固定帮助文件名，保持其摘要、归档类型、路径、健康和旁路保护；没有修改共享 ACE 本地部署工具。

## 客户端制品

| 平台 | 文件 | 字节 | SHA-256 |
| --- | --- | --- | --- |
| Mac | niuma-merit-macos-0.9.3.dmg | 3126070 | e4adfd1b866de5fa9580bb4f2b0b7449e130c96f794d6419c531bcacc996f33c |
| Windows | niuma-merit-windows-0.9.3-setup.exe | 3236042 | a69bff99bf39285118b7a7c0c3185d3f050e27f58fe515fc7d858409b12a21c1 |

- 双平台绑定源码：`af2286e616deca785baedf54c7c8c517aeff4b0d`。
- 独立分支：`codex/client-help-093-20261012`；从既有 v0.9.2 发布提交派生，未覆盖 main。
- Windows 构建 run：`38157142640`；制品 ID：`11709410570`。原生客户端为 x64；安装器引导程序 PE 为 x86 不代表内含客户端为 x86。
- Windows 安装器保留简体中文和英文、默认简体中文。
- Mac 通用 arm64/x86_64 原生构建与 DMG 打包完成。沿用既有 Apple Development 构建身份，未做 Developer ID 签名或公证。Windows 未正式代码签名。正式签名由用户处理，不能冒称已解决系统信任提示。
- 本次未重装本机、未重复计数/导入/升级测试、未运行 UU、未做 Windows 真机 GUI 验收或新建 Ego 空间。构建和元数据证据不冒充交互验收。

## 公共分发

两份新原包已通过原公共 COS 身份上传并认证读取核对，旧包禁止覆盖。公共 DOWNLOADS.json 摘要：`91cc83ce6eb8a1b8f0bb281b92dc78948198e05cb20a076ba97438c6a86b10eb`。旧 0.9.2 与 0.9.1 清单记录和原始对象保留；未修改 IAM、凭据权限或私有交付路径。

- Mac：https://download.gongde.zqscreen.cn/niuma-merit-macos-0.9.3.dmg。
- Windows：https://download.gongde.zqscreen.cn/niuma-merit-windows-0.9.3-setup.exe。
- GitHub：https://github.com/Mr-shanqiu/niuma-ELEC-gongde/releases/tag/v0.9.3。

## 默认安装登记已切换

用户于 2026-10-12 明确授权“切换”。准备脚本的 EXPECTED 已从原冻结输入修正，完成登记候选构建和受管激活。官网 v2 API 正式回读确认 Mac 与 Windows 默认版本均为 0.9.3，文件大小、摘要与上表一致。

只以稳定 API 镜像叠加新安装登记，现有六条旧记录及 0.9.0 最低兼容记录全部保留，公开接口共八条记录。编译业务清单摘要仍为 `a3ea3bce3fae5ecf20f69bcc95e8c91afae16455339efa79fbe95e97e712eb8e`，业务字节未改。旧容器保留用于恢复，受管 pending=false。未部署本地 R1f/R1g 源码，未重新进行计数验收。

## 证据与恢复

本次候选和回执：`.local-work/candidates/client-help-093-20261012/`。
执行状态唯一检查点：`WORK_PLAN.md`。上传权限的两次失败回执保留；实际正确运行身份为应用 UID/GID 65532，密钥内容未输出。切换前 API 镜像为 `sha256:7060b302652f489592d07a1ceb331d6b009e15d5ccc4e8e7766708ff7e3e3370`；切换后为 `sha256:d9e45f95607a645efe0c02017c063425ffb674f087ccedbd44e13ce2851cc1de`。登记摘要为 `a937853db82905af9e688c709714bd877e3f0665886a3b48156bfca9ae746774`。

官网帮助发布与公共原包上传已完成，不代表整体性能优化目标完成，不删除尚未完成事项。

### GitHub 与公共响应最终回执

v0.9.3 已于 2026-10-11T17:00:19Z 公开，非草稿、非预发布；GitHub 双附件服务端 digest 与上表一致。国内两个文件 HEAD 均为 HTTP 200，Content-Length 与上表一致。默认安装登记随后已单独完成切换及正式 API 回读，不把公共文件发布误记为安装登记激活。
