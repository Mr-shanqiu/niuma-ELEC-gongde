# 管理台正式发布记录（2026-09-28）

## 发布范围

- 管理台地址：`https://gongde.zqscreen.cn/admin/`
- 管理员账号：`admin`
- 功能范围：管理员登录、经营概览、只读订单列表、订单详情、退出登录
- 权限边界：只读，不提供改价、退款、删除订单、修改支付状态或内容发布能力

## 生产发布标识

- API 发布归档：`gongde-api-705b870290dce9538576a70553364f2deb2f705be1dfcf4b51dd91f79fadd1a0.tar.gz`
- API 发布标识：`705b870290dce9538576a70553364f2deb2f705be1dfcf4b51dd91f79fadd1a0`
- API 镜像：`sha256:40e0027d6963e38954a84de93866e43f650dea8f668f42a4783fe44177c82798`
- 静态站发布归档：`gongde-site-9b7c6d8dafdeeb56b1298bb77c9f0bd9a2ed584053eaab30a04b941eef8e7be7.tar.gz`
- 静态站发布标识：`9b7c6d8dafdeeb56b1298bb77c9f0bd9a2ed584053eaab30a04b941eef8e7be7`
- 静态站发布目录：`/opt/zqscreen/app/releases/gongde-site-9b7c6d8dafde-20260928T020715Z-1753682`

## 验收结果

- 官网首页：HTTP 200
- 静态健康检查：`gongde-ok`
- 管理台入口：HTTP 200
- 管理台指纹 CSS/JS：全部 HTTP 200，内容类型正确
- 未登录访问会话接口：HTTP 401
- 生产管理员登录：HTTP 200
- 登录后会话、经营概览、订单列表：HTTP 200
- 数据库、短信、微信支付、支付宝、形象包交付：均为 `healthy`
- 退出登录：HTTP 200；原会话再次访问返回 HTTP 401
- 当前订单总数：0
- 生产依赖审计：0 个已知生产依赖漏洞
- 服务测试：35/35 通过

## 安全与维护

- 管理员密码不写入仓库、发布归档或本文档。
- 本机密码保存在 macOS 钥匙串，服务名为 `gongde.zqscreen.cn.admin`，账号为 `admin`。
- 生产密码和会话密钥由服务器受限密钥文件提供，运行时文件仅服务账号可读。
- 会话 Cookie 使用 `HttpOnly`、`Secure`、`SameSite=Strict`，有效期 8 小时。
- 登录失败限制为同一来源 15 分钟内最多 5 次。
- 静态发布器只允许 `/admin/` 入口及带指纹的 CSS/JS，不开放任意文件上传或通用 SPA 回退。

## 回退说明

- API 发布保留上一容器，可通过既有受限发布流程回退。
- 静态站每次发布生成独立 release 目录，可通过既有受限发布流程切回上一 release。
- 回退不需要修改数据库结构；本次管理台只读，不执行订单数据迁移。
