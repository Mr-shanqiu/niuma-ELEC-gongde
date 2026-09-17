# 牛马电子功德形象包规范 1.1

适用客户端：macOS 与 Windows 0.7.0 及以后版本。

## 永久边界

- `.nmgpack` 是数据型 ZIP 包，不是插件，不能修改客户端功能。
- 客户端只读取根目录 `manifest.json` 和 manifest 明确声明的 PNG。
- 禁止脚本、动态库、可执行文件、字体、网络地址、子目录、符号链接和未声明文件。
- 导入、选择、渲染和删除均在本机完成；客户端不联网、不上传。
- 官网发布的用户作品必须经过平台安全检查和人工内容审核。

## 两种包

### Schema 1：制作源包

- `schema_version` 为 `1`。
- 不包含授权信息，用于官方审核、本地制作和服务端签发。
- 付费形象不得把 Schema 1 原包公开分发给用户。

### Schema 2：24小时首次导入包

- `schema_version` 为 `2`。
- 增加由平台 P-256 私钥签发的 `license`。
- 下载后最多24小时内允许首次导入。
- 导入成功后永久离线使用，本地重新加载不再检查日期。
- 下载链接有效期内可重复下载；过期后重新生成需要新的20分形象包交付订单。
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

## 文件限制

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

未来网站签发24小时包：

```bash
./scripts/appearance-pack.py sign SOURCE OUTPUT \
  --private-key /secure/path/appearance-pack-private.pem \
  --valid-hours 24 \
  --download-id ORDER_SPECIFIC_RANDOM_ID
```

私钥只能保存在受控服务端 Secret 中，不得进入客户端、网站源码、日志或 Git。
