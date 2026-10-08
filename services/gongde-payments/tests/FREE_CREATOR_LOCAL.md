# 免费创作者本地 HTTP 合同验收

本目录保留可重复运行的 HTTP 检查，而不是引用临时目录中的源码快照。测试直接导入当前构建的 creator router/runtime，监听随机的本机回环端口，注入虚构的存储与账号服务。

## 日常本地回归入口（2026-10-05）

`npm test` 先编译当前服务，再依次执行全部本地合同测试、12 项预算测试和 3 项模拟预览测试。HTTP 测试需要允许随机回环端口；监听被环境拒绝时仍返回失败，不跳过或标为通过。预算与预览分别使用 GC 参数、64 MiB 堆限制和每次新建的临时目录，避免覆盖其他任务的历史回执。

真实 MySQL 集成仍按下文的授权隔离数据库入口独立执行；数据库、实际浏览器、真实 COS、实际客户端导入、Windows 与生产闭环要求仍在最终验收矩阵中。日常本地回归通过不能替代这些门禁。

## 运行

在 `services/gongde-payments` 目录执行：

```sh
./node_modules/.bin/tsc -p tsconfig.json
node --test tests/free-creator-http.local.test.mjs
```

不安装依赖，不加载 `.env`。测试在导入模块前关闭创作者、付费创作者和分成开关；测试自己的 router 通过显式配置独立启用模拟免费下载。服务器在每个用例结束时关闭。

## 覆盖边界

- 匿名单包与多包的二进制响应和文件名。
- 下载关闭、不安全文件名、请求方法、内容类型和体积限制。
- 来源校验、限流、创作者私有资料和管理员接口的访问控制。
- 非可信代理头不能替代 TCP 来源；内部错误不向网页泄露。
- 创作者路由不拦截原官方购买路径；未启用 runtime 报告社区关闭。

## 不能证明的事项

注入服务不是数据库、COS 或真实账号。返回的二进制是路由测试夹具，不是可导入的形象包。通过此检查不能证明 MySQL 事务、迁移、审核真实素材、客户端导入或生产部署已完成。真实闭环验收必须另行取证。

## Storage byte budgets and private-bucket gates

After the authorized local service build, run:

```sh
node --max-old-space-size=64 --test --test-concurrency=1 tests/free-creator-storage.local.test.mjs
```

This suite imports the actual compiled object-store and always injects an in-memory COS fake. It makes no SDK requests and reads no credentials or .env. Its streams are not PNG fixtures. Eight isolated checks do not stand in for real COS, database, browser, native or production acceptance.

## Real source and preview byte-budget regressions

From the service directory, after the authorized local build:

```sh
node --expose-gc --max-old-space-size=64 tests/free-creator-budgets.local.test.mjs
node --expose-gc --max-old-space-size=64 tests/free-creator-preview.local.test.mjs
```

The budget suite retains the original12 real PNG/ZIP assertions with memory persistence/COS fakes. The preview suite loads the actual frontend module and real PNG fixtures with DOM/fetch/bitmap stubs; it is NOT_ACTUAL_BROWSER. Neither suite proves actual MySQL, live COS, GUI, Windows or production behavior.

## Real MySQL local integration preparation

The serial real-MySQL suite is free-creator-mysql.local.test.mjs, with import-safe
synthetic PNG/ZIP and explicit MemoryCos in free-creator-mysql-fixtures.local.mjs.
It uses actual compiled Repository, auth, object-store and service code, not a
fake repository. Twenty-one prepared cases are not twenty-one executed passes.

Offline connection-guard regression, requiring no database or approval:

    node --max-old-space-size=64 --test --test-concurrency=1 tests/free-creator-mysql-guard.local.test.mjs

Only after direct human approval of temporary local database startup and DDL,
from the service directory with the existing service already built:

    GONGDE_CREATOR_LOCAL_MYSQL_APPROVED=1 node --max-old-space-size=64 tests/run-free-creator-mysql.local.mjs

The launcher never installs or pulls anything. It fixes the local Docker socket,
exact cached MySQL 8.4 image, loopback-only high port, fresh local database name,
1 CPU and 512 MiB limit. It passes only canonical GONGDE_CREATOR_LOCAL_MYSQL_URL
and approval variables to the suite. The suite rejects a missing or inexact
approval, aliases, external hosts, ports below 10000 and non-test database names
before importing mysql2 or constructing a pool. An approval flag is a safety
gate, not a substitute for the actual human authorization.

Schema 005 extends 004; foundation 004 references the local official-order
schema. The launcher applies exactly one migration each for 001 through 005,
only via the dedicated account restricted to its new temporary database.
It does not call the production migration runner or enable creator sales.

The fixed work deadline is 50 seconds, followed by at most six seconds of
ownership-checked cleanup. Acquire the existing goal controller's <=60-second
lease in the same shell immediately before any authorized execution. Unknown
DDL, container writes or tests are not retried. Cleanup touches only the exact
fresh container with its matching per-run label; cleanup uncertainty is an error.
Synthetic credentials stay in memory and are redacted from retained output.

Receipts and suite artifacts live in a fresh private temporary directory, not
an old budget-test directory. Local SQL acceptance still does not prove HTTP
authentication, rendered browser operation, actual COS permissions, Windows
execution, native installation, deployment or complete goal acceptance.

## Actual browser and native gate (2026-10-03)

The prepared-only evidence is superseded only for the specific local layers recorded in `docs/RELEASE_2026-09-23.md`: actual MySQL 21/21, actual browser posting/review/public downloads/unpublish, actual Mac import of those downloaded files (single 1, batch 2), PNG byte preservation 2/2, and actual account/form regression 7/7. Synthetic admin + MemoryCos remain disclosed substitutes, not production/provider evidence.

`run-free-creator-browser.local.mjs` owns a fresh bounded loopback DB and server, requires `GONGDE_CREATOR_LOCAL_MYSQL_APPROVED=1`, emits readiness, and accepts `STOP_LOCAL_BROWSER_ENVIRONMENT` on stdin. Acquire a startup lease <=60 seconds, release it after recording readiness/session, and bound each test block. Never hold a lease over the whole live environment.

`free-creator-ui-closure.local.mjs` is executed through `ego-browser nodejs` with `globalThis.GONGDE_LOCAL_BROWSER_READY`: fresh emitted loopback URL, actual owned numeric space ID, owned temporary root, synthetic creator/admin logins. Optional `resumeWorkId` is only for an exact confirmed draft after a test-harness failure, never for replaying an unknown business write. The driver does not seed business records. It uses actual UI source uploads and real anonymous browser downloads; one selection is `.nmgpack`, multiple selections `.nmgpacks`.

`free-creator-form-regression.local.mjs` uses an existing owned space and the supplied loopback origin. Exactly one synthetic registration per run; no recovery-key log/file. `run-free-creator-form.local.mjs` auto-starts the approved temporary DB/server, feeds the fresh origin to that driver, stops the environment on completion, and records receipts under a private `gongde-creator-form-run-*` root. It also requires `GONGDE_CREATOR_FORM_SPACE_ID` to be the actual owned space. The work timer is 50 seconds; no tool installs or external providers.

Execute test sources, do not read or print application credentials. Ego function arguments must be JSON-serializable: omit an absent argument instead of passing explicit undefined. String evaluate functions need explicit IIFE invocation. Use stable keyboard interactions for forms; do not mutate temporary DOM attributes for later selectors or interpret a timed-out click as a business success.

Preserve the original failed-run receipts and exact passing layer. Cleanup removes only the labeled owned container/volumes, private test installation directories and owned browser space. Production, real COS, actual payments, Windows runtime and normal user libraries remain outside this local gate.
