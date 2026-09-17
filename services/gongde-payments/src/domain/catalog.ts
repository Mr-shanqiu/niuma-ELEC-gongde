export const OFFICIAL_CHARACTER_PASS = Object.freeze({
  id: "official-character-pass",
  version: 1,
  nameZh: "官方形象通行证",
  nameEn: "Official Character Pass",
  descriptionZh: "一次购买，解锁招财猫、仓鼠跑轮、海狮拍肚皮、小鸡啄米及以后发布的官方形象。",
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
  "official.chick-pecking"
]);
export const MAX_ASSETS_PER_DELIVERY = 10;
