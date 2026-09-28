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
  descriptionZh: "为已获得官方形象通行证的手机号一次生成最多10个、24小时内可首次导入的形象包。",
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
export const MAX_ASSETS_PER_DELIVERY = 10;
