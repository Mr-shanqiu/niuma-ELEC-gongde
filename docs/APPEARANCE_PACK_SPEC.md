# 牛马电子功德形象包规范 1.2

> 当前协议以 [全免费领取与共创 PRD 1.1](PRD_FREE_DOWNLOAD_AND_CO_CREATION.zh-CN.md) 第 14.1 节为准。下文 timed 授权、24 小时首次导入、旧体积限制和收费签发示例属于历史协议，已被新规则替代，不能作为新交付要求。保留原文用于识别与恢复历史文件，不修改其原始签名消息。

> 新版业务执行 [全免费领取与共创 PRD](PRD_FREE_DOWNLOAD_AND_CO_CREATION.zh-CN.md)。本协议的格式、签名与离线导入继续复用；下文“付费”“新订单”“人工逐件审核”和手工填写作品 ID 等历史流程由新版 PRD 替代，免费交付仍须经过安全校验及授权签发。

## 当前永久包与发布状态

- macOS 与 Windows 0.9.0 客户端已发布，支持 PRD 1.1 的签名永久模式；免费领取服务尚未部署、尚未启用。
- 新领取全免费；只保留既有付费订单的历史履行和合法恢复，不再创建新收费订单。
- 永久包使用 `license.mode = "perpetual"`，永久授权签名格式以 PRD 第 14.1 节为准，不沿用下文 timed 签名消息。不存在首次导入截止时间，保存的文件可永久导入并离线使用。
- 历史 timed 包仍须通过原始签名与内容校验；0.9.0 不因其首次导入日期已过而拒绝导入，不改写旧签名或伪造新授权。
- 服务启用后，服务器重新下载窗口为签发后 7 日；窗口到期只影响服务器重下，不影响本地永久导入。一次领取交付单个 `.nmgpack` 或一个包含多个独立包的 `.nmgpacks` 文件。
- 新源包、安全预算、投稿 ID 和审核流程以 PRD 第 14 节及 [创作者投稿规范](CREATOR_PACK_GUIDE.zh-CN.md) 为准。创作者只提交无授权源包，由平台安全校验与签发。
- 实际客户端：[macOS 0.9.0](https://download.gongde.zqscreen.cn/niuma-merit-macos-0.9.0.dmg)、[Windows 0.9.0](https://download.gongde.zqscreen.cn/niuma-merit-windows-0.9.0-setup.exe)、[GitHub v0.9.0](https://github.com/Mr-shanqiu/niuma-ELEC-gongde/releases/tag/v0.9.0)。macOS 为 Apple Development 签名、非 Developer ID、未公证；Windows 未签名，不能承诺没有系统安全提示。

下文适用范围为历史 macOS 与 Windows 0.7.0 及以后协议说明，不代表旧客户端支持新永久模式。

## 永久边界

- `.nmgpack` 是数据型 ZIP 包，不是插件，不能修改客户端功能。
- 客户端只读取根目录 `manifest.json` 和 manifest 明确声明的 PNG。
- 禁止脚本、动态库、可执行文件、字体、网络地址、子目录、符号链接和未声明文件。
- 导入、选择、渲染和删除均在本机完成；客户端不联网、不上传。
- 官网发布的用户作品必须经过平台安全检查和人工内容审核。

## 历史包类型（新交付以永久模式为准）

### Schema 1：制作源包

- `schema_version` 为 `1`。
- 不包含授权信息，用于官方审核、本地制作和服务端签发。
- 付费形象不得把 Schema 1 原包公开分发给用户。

### Schema 2：历史 24 小时首次导入包

- `schema_version` 为 `2`。
- 增加由平台 P-256 私钥签发的 `license`。
- 下载后最多24小时内允许首次导入。
- 导入成功后永久离线使用，本地重新加载不再检查日期。
- 下载链接有效期内可重复下载；过期后重新获取按当前官网按次价格创建新订单，历史权益码仍按其原有官方优惠处理。平台故障造成的交付失败不要求用户重复付款。
- 该机制减少随手转发和长期网盘传播，不承诺彻底防盗版。

```json
"license": {
  "mode": "timed",
  "issued_at": 1893456000,
  "import_before": 1893542400,
  "download_id": "minimum_16_character_id",
  "content_sha256": "64_lowercase_hex_characters",
  "signature": "128_lowercase_hex_characters"
}
```

签名消息固定为：

```text
NIUMA-PACK-LICENSE-V1
<id>
<version>
<issued_at>
<import_before>
<download_id>
<content_sha256>
```

`content_sha256` 对全部 PNG 按文件名排序后计算；每项依次写入 UTF-8 文件名、NUL、8字节大端长度和原始文件内容。签名是 P-256 ECDSA SHA-256，manifest 保存原始 `r || s` 的128位小写十六进制。

## 历史文件限制（新投稿与交付以 PRD 第 14 节为准）

- 包体最大50MB，`manifest.json` 最大64KB。
- 最多8个文件，全部位于 ZIP 根目录。
- PNG 单边最大2048像素。
- 最多6个图层，每层最多8个关键帧。
- 画布固定 `240 x 250`。
- 形象区为 `y=0..170`，瞬时 `+1` 从 `y=174` 开始，总数从 `y=210` 开始。
- `plus_y` 固定为 `174`。
- 同一 `id` 再次导入表示更新，完整校验后原子替换。

## 制作工具

本地制作源包（仅用于审核和测试）：

```bash
./scripts/appearance-pack.py build assets/appearance-packs/chick-pecking dist/sample-packs/chick-pecking-free.nmgpack
```

历史服务端签发 24 小时包示例（不用于新免费交付）：

```bash
./scripts/appearance-pack.py sign SOURCE OUTPUT \
  --private-key /secure/path/appearance-pack-private.pem \
  --valid-hours 24 \
  --download-id ORDER_SPECIFIC_RANDOM_ID
```

私钥只能保存在受控服务端 Secret 中，不得进入客户端、网站源码、日志或 Git。

## 历史 Schema 3 与创作者投稿说明

以下“付费交付”、手工填写作品 ID、订单和分成描述仅保留历史背景；新投稿与免费交付以开头引用的 PRD 1.1 为准。

- 当前两端源码均支持Schema 3：每层增加 `interpolation`（`linear`或`smoothstep`），每帧增加 `scale_y`。
- 无 `license` 的Schema 3是制作源包；有授权的Schema 3用于付费交付。
- Schema 3的几何、插值与裁剪以实际客户端验收为准，不把源码支持声称为所有旧版兼容。
- 创作者只投稿无授权源包，使用平台分配的 `creator.<creatorId>.<slug>`，不得自行签授权或冒用官方ID。
- 平台投稿采取更严格的ZIP、PNG与双端共同参数预算，见 [创作者投稿规范](CREATOR_PACK_GUIDE.zh-CN.md)。
- 创作者发布、订单、分成与合规门槛见 [实施方案](CREATOR_SYSTEM_PLAN.zh-CN.md)。
