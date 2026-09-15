# 牛马电子功德形象包规范 1.0

适用客户端：macOS 0.5.0 至 0.5.2。

## 产品边界

- `.nmgpack` 是数据型 ZIP 包，不是插件，不具备修改客户端功能的能力。
- 客户端只读取根目录 `manifest.json` 和 manifest 明确声明的 PNG。
- 禁止脚本、动态库、可执行文件、字体、网络地址、子目录、符号链接和未声明文件。
- 客户端安装、选择、渲染和删除形象包均在本机完成，不联网、不上传。
- 网站、支付、账号和用户上传不属于 0.5.2。
- 未来用户作品只有经过运营方审核后才能在官网上架；本地客户端仍只执行相同的白名单数据规范。

## 文件和安全限制

- 包体最大 50MB，`manifest.json` 最大 64KB。
- 包内最多 8 个文件，必须全部位于 ZIP 根目录。
- PNG 单边最大 2048 像素，最多 6 个图层，每层最多 8 个关键帧。
- 画布固定为 `240 x 250`，客户端按自身显示比例缩放。
- 画布严格分为三个互不重叠的安全区：形象 `y=0..170`、瞬时 `+1` 为 `y=174..204`、每日总数为 `y=210..250`。
- `plus_y` 当前必须为 `174`；图层基础 frame 的顶部不得超过 `170`，动画越界部分仍会被客户端裁剪。
- manifest 使用严格字段集合；出现未知字段即拒绝安装。
- 同一 `id` 再次导入表示更新，客户端先完整校验再原子替换旧版本。

## Manifest

完整示例见 `assets/appearance-packs/woodfish-sample/manifest.json`。

- `schema_version`：当前固定为 `1`。
- `id`：全局稳定 ID，只允许小写字母、数字、点和短横线。
- `version`：形象包版本。
- `name_zh`、`name_en`：中英文名称。
- `author`：创作者名称。
- `publisher`：发布方名称。
- `review_id`：审核记录 ID；0.5.2 只作为包内可核对元数据，不触发联网验证。
- `canvas_width`、`canvas_height`：固定 `240`、`250`。
- `preview`：选择器预览 PNG。
- `plus_y`：敲击时 `+1` 的纵向设计坐标。
- `layers`：按数组顺序从后向前绘制的图层。

每个图层包含：

- `image`：PNG 文件名。
- `frame`：`[x, y, width, height]`。
- `anchor`：变换锚点 `[x, y]`，取值 `0..1`。
- `keyframes`：按 `t` 升序排列，`t` 取值 `0..1`。

每个关键帧必须完整包含 `t`、`x`、`y`、`rotation`、`scale`、`alpha`。客户端在相邻关键帧间线性插值；没有敲击时使用 `t=0`。

## 制作工具

```bash
./scripts/appearance-pack.py validate assets/appearance-packs/woodfish-sample
./scripts/appearance-pack.py build assets/appearance-packs/woodfish-sample dist/sample-packs/woodfish-sample.nmgpack
./scripts/appearance-pack.py validate dist/sample-packs/woodfish-sample.nmgpack
```

只有校验成功的包才可进入人工内容审核和后续官网发布流程。
