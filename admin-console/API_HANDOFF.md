# Admin v2 integration contract: local-only candidate

Owner: admin-console subtask. No production/credentials/paid API/deployment/Git.

PRD fixes admin paths, not their complete response fields or claim list/statistics paths. Parent has explicitly agreed to implement admin claims, stats, creator list and contribution interfaces against this handoff. These are implementation contracts, not evidence that the service has already implemented or passed them. UI fails closed on unavailable/mismatched data; no fake records or substituted historical orders. No further messaging tool is needed.

## Common

All v2 successes use the PRD22.1 JSON envelope below, including POST responses. `serverTime` and `requestId` are top-level, never placed inside `data`. ISO timestamps include timezone; all operational dates display Asia/Shanghai.

```json
{
  "data": {},
  "serverTime": "2026-10-08T12:00:00+08:00",
  "requestId": "server-generated-request-id"
}
```

Existing admin Cookie; `Cache-Control: private, no-store`; same-origin JSON writes and Origin/CSRF checks. Error response has no success `data`: `{error,message,field?,details:{},requestId}`. Stale revision HTTP409; rate limit HTTP429 plus Retry-After seconds. Writes exactly `{revision,reason}` (5..1000 chars); revision is a server-issued nonnegative integer, not a source archive revision. Never fabricate a zero revision. After confirmed mutation, separately re-read. If mutation succeeded but re-read failed, show that exact outcome, clear cached code and prohibit repeating the mutation from that stale state; manual GET refresh only. Unknown write outcomes also require a read before any deliberate retry.

## Codes / contributions

- GET `/api/gongde/v2/admin/group-code`: data `{familyId,revision:number,kind:'GROUP',status:'ACTIVE'|'PAUSED'|'INACTIVE',code:string|null,validFrom:ISO|null,expiresAt:ISO|null,contributionCount:0,maxItems:10,redemptionEnabled:boolean}`. readiness must include actual delivery health, not just key availability.
- GET `/api/gongde/v2/admin/creators/{creatorId}/promotion`: same with `kind:'CREATOR'`, plus `{creatorId,authorPublicNumber,accountState,workCount,contributions}`. Zero contribution is inactive; counts/limits from service.
- `contributions`: complete records `{workId,revision:number,state:'ACTIVE'|'REVOKED',title?,number?,grantedAt,revokedAt:ISO|null,restoredAt:ISO|null,reason:string|null}`. No aggregate-total edit.
- POST `/code-families/{familyId}/pause|resume|rotate`: current FAMILY revision; controls code, not account state. Preserve contribution/attribution.
- POST `/contributions/{workId}/revoke|restore`: current CONTRIBUTION revision.

Family POST success `data` is the complete updated code snapshot from GET group-code (with kind GROUP/CREATOR as appropriate), including the new family revision. Contribution POST success `data` is the complete updated contribution record, including its new contribution revision. Frontend will still GET promotion afterward to read the contribution count and limit atomically from the server; it never locally increments/decrements N.

For creator accounts with zero contributions, promotion GET must still provide account summary and `status:'INACTIVE'`, `code:null`, `validFrom:null`, `expiresAt:null`, `contributionCount:0`, `maxItems:0`. For accounts that never received contributions, `contributions:[]`; revoked historical contributions must remain in the list with their own revisions. If NO family has ever been created, return `familyId:null,revision:null`: the frontend now supports this unactivated state and disables family operations without inventing an ID/revision. Group code still requires a real persisted family. No code is generated or activated merely because the account exists.

## Creator list contract

GET `/api/gongde/v2/admin/creators?page=1&perPage=25&q=...&state=...` returns envelope `data:{items,total}`. `q` optional: exact public author number or internal creator ID; `state` optional actual account state. Parent may support richer search separately, never search/display phone numbers here. Page/perPage positive integers, page starts at 1; perPage defaults 25, maximum 100; invalid input returns HTTP400, not silent truncation. `total` counts all matching rows before pagination. Stable newest-first order with creatorId tie-break; filtering precedes pagination.

Each item is:

```ts
{
  creatorId: string;
  authorPublicNumber: string;
  accountState: string; // existing authoritative account enum
  workCount: number; // all owned work identities, not version/upload count
  contributionCount: number; // count of ACTIVE contribution records
  maxItems: number; // min(3 * contributionCount, 10), N=0 gives 0
  codeStatus: 'ACTIVE' | 'PAUSED' | 'INACTIVE';
  familyId: string | null; // null only when no family has ever been created
  revision: number | null; // family revision, null alongside absent family
}
```

Do not include plaintext code, phone, login credentials, private source URLs or cookies in list items. Code-view auditing occurs ONLY on the explicit promotion GET. Author list does not replace promotion GET or provide a writable total; account state and code state must remain distinct. No account-pause button is added until its real existing route and request contract are confirmed. Frontend now provides this creator list with pagination/search/account-state filter and explicit promotion-detail access, while retaining existing review/work entry points and direct internal-ID lookup.

## Claims/statistics contract

- GET `/api/gongde/v2/admin/claims?from=ISO&to=ISO&page=1&perPage=25&state=...`: data `{items,total}`; from inclusive/to exclusive Beijing day; descending createdAt. State choices CREATED/PREPARING/READY/FAILED/BLOCKED/EXPIRED must match actual service enum; unknown statuses are never called successful.
- Item `{claimId,kind:'GROUP'|'CREATOR',authorPublicNumber:string|null,codeFamilyId,state,items:[{number,title,catalogRevision}],bytes:number|null,durationMs:number|null,createdAt,issuedAt:ISO|null,downloadExpiresAt:ISO|null,error:string|null}`. Frozen items, safe error only; no code, phone, Cookie, private object key or signed URL.
- GET `/api/gongde/v2/admin/stats?from=ISO&to=ISO`: data `{readyClaims:number|null,workClaims:number|null,verifiedCodes:number|null,installerRequests:number|null}`. Missing/null means uncollected, never zero; READY counted once, no inferred installs/followers. Stats not filtered by claim state.
- `from` is inclusive, `to` exclusive, both timezone-qualified ISO8601. Reject invalid/reversed ranges with HTTP400. UI sends a single Beijing calendar day, maximum service query window 90 days. Claim `page` starts at 1, default perPage=25, maximum 100; stable order createdAt DESC / claimId DESC. `total` is exact matching count before pagination; empty is `{items:[],total:0}`, not a 404 and not an invented empty fallback. Stats error must not hide valid claim list data.
- Claim `items` contain the frozen title/number/catalogRevision at creation, never current catalog fallback. Null `issuedAt`/`downloadExpiresAt` before signing; real downloadExpiresAt after signing is issuedAt + 604800 seconds. Null bytes/duration means not yet known, not zero. BLOCKED means the entire batch is blocked, no silent omitted items. `error` contains safe operator-facing text or null, never raw exception dumps/private object addresses.
- Statistics aggregate by first READY timestamp for `readyClaims`, by frozen per-work entries from those READY transitions for `workClaims`, by successful explicit verification event time for `verifiedCodes`, and by actually collected successful public installer file request time for `installerRequests`. Empty but fully measured periods are numeric 0. Unimplemented/uncollected metrics are null. Counts are not depleted permissions, unique people, installs, offline imports or Douyin followers. Failed/blocked records do not gain extra READY counts; successful retry never recounts a claim already counted READY. Rotation preserves family attribution.
- Stats ignores claim-state filter; it has its own date bounds. No plaintext code/phone/Cookie/signed URL/source object key is exposed by either endpoint, including diagnostics.
- No invented retry/block mutation. Reuse existing account pause and work-suspend interfaces only after confirming their real routes and contracts; the existing work-suspend/review/report buttons remain in the existing creator panel. No new unauthorized operation buttons are added.

## Existing review / build integration

Keep existing `/api/gongde/admin/creators` review/work/report/version APIs and decision body. Review metadata is frozen: show `creatorDouyinNumber`, never phone/draft fallback. Approval requires `sharingTermsVersion='creator-free-distribution-v2-20261008'`, `acceptFreeDistribution=true`, `acceptAiContentReview=true`, true version preview and existing checks. Optional `aiTermsVersion` shown if supplied; creator agent/parent must confirm name or existing bound-consent evidence. No second review system.

Build now writes `admin-console/dist` instead of `website/admin` to respect exclusive website ownership. Parent must explicitly integrate final built files into deployment candidate website/admin. Local build is not publishing/deployment.

## New website numbered reports: confirmed SQL008 contract

This section supersedes the earlier proposed report fields/actions. Parent confirmed SQL008 columns: id, appearance_number, version_id, category, description, evidence, contact, state, resolved_at, resolution, created_at. There is NO row revision and no sourceKind/title in this interface. Do not fabricate those fields, split official/community truth, or add DISMISSED as a database state. Existing creator copyright complaints remain unchanged.

### GET /api/gongde/v2/admin/reports

Query: page=1, perPage=25, state=OPEN or RESOLVED. Frontend always sends one of those real states. No unsupported number/source/category filter or all-state query is sent. Data returns exact filtered pagination {items,total}; records ordered stably by createdAt DESC / id DESC. Common PRD22.1 success envelope remains {data,serverTime,requestId}; the list payload goes inside data.

```ts
{
  items: [{
    id: string;
    number: string; // appearance_number, stable official/community public number
    versionId: string | null; // version_id, not substituted with current version
    category: string;
    description: string;
    evidence: string | null;
    contact: string | null;
    state: 'OPEN' | 'RESOLVED';
    createdAt: string;
    resolvedAt: string | null;
    resolution: string | null;
  }];
  total: number;
}
```

Empty matching result is {items:[],total:0}. SQL nullable fields map to JSON null, not guessed values or absent invented snapshots. Timestamps use timezone-qualified ISO8601. The UI renders evidence/contact as plain text only; never automatically follows URLs or exports private contact details. This administrator-only contact field is explicitly authorized by the parent contract, not part of public catalog output. No cookie, code, credential, private object URL or unredacted log is added.

### POST /api/gongde/v2/admin/reports/:id/resolve

Frontend submits exactly {reason: trimmedString}, length 5..1000. No revision or outcome is required/sent; the real table has no row revision. Parent may accept optional revision for compatibility but must not invent a row revision or make it mandatory. Success envelope data is {ok:true}, not an updated report or a revision snapshot.

Server performs the single OPEN -> RESOLVED conditional status UPDATE and corresponding administrator audit in one transaction, preserving original report/evidence/contact. Persist actual resolved_at and resolution. An already-resolved/concurrently processed report must not be blindly overwritten; return a safe conflict/known result according to the runtime contract, and the UI will read real status before any deliberate new action. Admin authentication, same-origin JSON and CSRF/Origin protection remain mandatory.

The UI only treats data.ok===true as acknowledged handling. It then re-reads the real list; it never fabricates a resolved row from the success acknowledgement. A successful write followed by failed GET remains a confirmed write plus a separately reported read failure; refresh manually, do not resubmit. Unknown response or write failure clears stale selected/list data and requires refresh; no automatic POST retry.

RESOLVED records the operator's investigation/handling explanation, including an explanation if no enforcement was justified. No separate dismiss state/button. Marking a report resolved does not claim a work/account was suspended. Operators use existing numbered-work lookup and actual official/community management pages for independent enforcement, then record the true outcome in reason. No second review system, provider call, deletion or public evidence publication is introduced.

Local TypeScript acceptance is separate from parent runtime/production acceptance. No report was created or resolved against any server by this subtask.

## Official safety: implemented in this exclusively authorized runtime block

GET `/api/gongde/v2/admin/official-safety` returns common envelope with `data:{items,total}`. This is the complete registered official asset set, including normally unpublished and safety-blocked works. Item shape:

```ts
{
  assetId: string;
  blocked: boolean;
  revision: number;
  reason: string | null;
  updatedBy: string | null;
  updatedAt: string | null;
}
```

An absent safety row is an observed `blocked:false,revision:0` baseline, with reason/updatedBy/updatedAt null; GET never creates safety rows. Revision zero means no persisted safety operation, not an invented positive row revision. Only registered official asset IDs are writable. No catalog/file path or signing credential is returned.

POST `/api/gongde/v2/admin/official-safety/{assetId}/block|unblock` requires exactly:

```ts
{ requireCurrentRevision: number; reason: string; }
```

`requireCurrentRevision` is REQUIRED, integer >=0, defaulted only from the actual GET snapshot, never from UI guesses. Trim/NFC normalize reason; length 5..1000 Unicode code points. No `published`, implicit account operation or unspecified parameter is accepted. Success envelope `data` is the full updated safety item above, new revision strictly greater than supplied. Stale revision or already-target-state is HTTP409; missing auth HTTP401; invalid body HTTP400; unregistered asset HTTP404. Existing admin guard and same-origin/CSRF protection apply.

In one transaction, serialize absent-row creation via unique-key insert, SELECT FOR UPDATE, compare current revision, update blocked/revision/reason/operator/time and insert gongde_free_audit action `official-safety.block` or `official-safety.unblock` with old/new state and requestId. Failure rolls back both state and audit. No migration/schema change.

Blocked official assets are excluded from public catalog and detail. Download authorization checks the table immediately for ALL frozen batch items; a single unsafe item blocks the whole batch. Unblock does not republish an ordinarily unpublished work. On the next owned download request, a previously signed BLOCKED official batch may return to READY only after session-first/claim-row locking, unexpired ORIGINAL download window and current safety checks for EVERY frozen item. Recovery is atomically audited as `official-safety.claim-restored`; versions, artifact, issuedAt and downloadExpiresAt are not replaced or extended. Other remaining safety blocks prevent recovery. No new claim/quota consumption or silent partial pack.

Ordinary official publish/unpublish remains the existing appearance module. It does NOT write gongde_free_official_safety and does not revoke frozen legitimate claims. UI presents safety operations separately from the ordinary buttons, requires reason/revision, confirms consequences and handles successful-write/failed-re-read as two separate outcomes.

Public numbered detail GET now consumes the same `public-query` 120/minute bucket as list GET. Admin report ordering is now `created_at DESC,id DESC` for stable pagination. Local tests do not imply production deployment, full payment-retirement acceptance or real COS/client acceptance.

### 本工作块本地验收回执

当前安全停发实现通过唯一一次有界 HTTP 验收：19/19，fixtureRun `774f01b3af5ef7cd`；后台 TypeScript 检查通过。新增覆盖同 revision 并发仅一个成功、事务审计、官方目录排除、旧 claim 即时下载阻断及恢复、普通下架不写 safety、不阻断旧 claim、举报同时间按 id 降序、编号详情 public-query 120/min。

证据为当前 free runtime 真实本地 HTTP + 隔离真实 MySQL；COS transport、安装包 readiness 与管理员身份是明确的测试替身，签名使用临时随机 P256。普通下架用注入的 publication 依赖模拟，不代表完整 legacy admin 下架路由验收。未测完整 server.ts 的支付 410，未重跑后台全量构建、未做页面交互验收、未访问生产、未部署。原 15/15 和本轮 19/19 的分层记录见 `.local-work/acceptance/free-090-http/receipt.json`，未补造 SHA 或执行时间。
