export const OFFICIAL_CHARACTER_PASS = Object.freeze({
  id: "official-character-pass",
  version: 1,
  nameZh: "官方形象通行证",
  nameEn: "Official Character Pass",
  descriptionZh: "一次购买，解锁当前已发布及以后发布的全部官方形象。",
  amountFen: 100,
  currency: "CNY" as const
});

export const OFFICIAL_ASSET_DELIVERY = Object.freeze({
  id: "official-asset-delivery",
  version: 1,
  nameZh: "官方形象包生成与下载",
  nameEn: "Official Character Pack Delivery",
  descriptionZh: "为已获得官方形象库资格的用户一次生成最多5个、24小时内可首次导入的形象包。",
  amountFen: 20,
  currency: "CNY" as const
});

export const PROJECT_SUPPORT = Object.freeze({
  id: "project-support",
  version: 1,
  nameZh: "自愿赞赏",
  nameEn: "Voluntary Support",
  descriptionZh: "自愿支持项目维护，不对应商品、功能或其他权益。",
  allowedAmountsFen: Object.freeze([100, 500, 1000]),
  currency: "CNY" as const
});

export const FIRST_OFFICIAL_ASSET_ID = "official.lucky-cat";
export const OFFICIAL_ASSET_IDS = Object.freeze([
  FIRST_OFFICIAL_ASSET_ID,
  "official.hamster-wheel",
  "official.sea-lion-belly-pat",
  "official.chick-pecking",
  "zqscreen.caishen-ingot",
  "zqscreen.redpanda-wave",
  "zqscreen.shiba-tilt",
  "zqscreen.orange-cat-wave",
  "zqscreen.raccoon-cheer",
  "zqscreen.golden-toad-coin",
  "zqscreen.little-jiangshi-hop",
  "zqscreen.frog-puff",
  "zqscreen.bee-flap",
  "zqscreen.koi-bubbles",
  "zqscreen.kiss-couple",
  "zqscreen.baodan-charm",
  "zqscreen.woodpecker-peck",
  "zqscreen.zhuan-yun-bead",
  "zqscreen.treasure-basin"
]);
export const OFFICIAL_ASSET_NAMES_ZH: Readonly<Record<string, string>> = Object.freeze({
  "official.lucky-cat": "招财猫",
  "official.hamster-wheel": "仓鼠跑轮",
  "official.sea-lion-belly-pat": "海狮拍肚皮",
  "official.chick-pecking": "小鸡啄米",
  "zqscreen.caishen-ingot": "财神元宝",
  "zqscreen.redpanda-wave": "小熊猫挥手",
  "zqscreen.shiba-tilt": "柴犬歪头",
  "zqscreen.orange-cat-wave": "橘猫招手",
  "zqscreen.raccoon-cheer": "浣熊加油",
  "zqscreen.golden-toad-coin": "金蟾吐币",
  "zqscreen.little-jiangshi-hop": "小僵尸蹦跳",
  "zqscreen.frog-puff": "青蛙鼓腮",
  "zqscreen.bee-flap": "蜜蜂振翅",
  "zqscreen.koi-bubbles": "锦鲤吐泡泡",
  "zqscreen.kiss-couple": "甜蜜亲亲",
  "zqscreen.baodan-charm": "爆单符",
  "zqscreen.woodpecker-peck": "啄木鸟啄击",
  "zqscreen.zhuan-yun-bead": "转运珠",
  "zqscreen.treasure-basin": "聚宝盆"
});
export const MAX_ASSETS_PER_DELIVERY = 10;
export const MAX_LEGACY_ASSETS_PER_DELIVERY = 5;
export const OFFICIAL_APPEARANCE_BATCH = Object.freeze({
  id: "official-appearance-batch", version: 1,
  nameZh: "官方形象包批次", nameEn: "Official Appearance Batch",
  descriptionZh: "按本次选择付费：每个0.2元，整批最多1元，一批最多10个；付款后24小时内下载并首次导入。",
  currency: "CNY" as const
});
export function appearanceBatchPriceFen(count: number): number {
  if (!Number.isInteger(count) || count < 1 || count > MAX_ASSETS_PER_DELIVERY) throw new Error("asset_selection_limit_exceeded");
  return Math.min(count * 20, 100);
}
