# agent-gateway 與官方 Claude Code：Claude Messages API 通訊差異報告

2026-10-15 更新：依 EasyCLIProxyAPI 的實際核心 **CLIProxyAPI v8.0.29** 重新比對，已修正 final-body CCH、四個 subscription beta、request ID 與 caller system 位置。簡短 PoC 曾通過，但 OpenCode 完整請求仍因 top-level caller system 回傳 extra usage 拒絕；移到對話中的 system 後，真正 OpenCode CLI 文字及 `read` 工具續接皆成功。沿用 `.tmp/.credentials.json`。比較版本、單一變因證據與未匹配的 legacy/cache/transport 範圍見 [重新比對報告](CLAUDE_EASYCLIPROXY_COMPARISON.md)。

## 1. 結論

agent-gateway 的 Claude 路徑照抄官方 Claude Code 推論呼叫的**手勢**：`POST /v1/messages?beta=true`、body 帶 `stream:true`、OAuth bearer、`anthropic-version`、`x-app`、`anthropic-beta: oauth-2025-04-20`、官方 system 區塊組合（billing + 互動 CLI 前綴 + caller 指令，§3.3/§8）、官方 default 形狀的 `cache_control` 標記、`metadata.user_id`、SSE 讀取。User-Agent 照官方 `$0()` 產生器（pin 版本 2.1.299；**用戶明確核准的 Claude 專屬例外**，推翻先前「UA 用自身身分」的指示，見 §9.1），`Accept: application/json` 與官方 SDK 預設一致（§3.2）。bundled SDK 0.128.0 的八個 `X-Stainless-*` header 加 `anthropic-dangerous-direct-browser-access`（Messages 共九個、Models 不帶 timeout 共八個）與 basic billing 區塊也照抄（用戶核准的 native identity 範圍，§3.2/§3.3）。

三類與 Codex 路徑不同的地方：

1. **上游完全不同**：`https://api.anthropic.com/v1/messages`，不是 `chatgpt.com/backend-api/codex/responses`；Claude 分支**不經過** `normalizeResponsesRequest`，所以 Responses Lite wrapper、Codex headers、`store`/`include`/`prompt_cache_key`、`ultra`→`max` 等規則一律不會出現在 Claude 請求裡。
2. **thinking 需要 gateway 自有的回放狀態**：Claude 的 `thinking`/`redacted_thinking` 區塊帶簽章，工具回合續接時必須原樣送回。OpenAI 相容 API 不會把這些內容回傳給 client，所以 gateway 自己在 Claude home 下存一份（§7）。這在官方 CLI 沒有對應實作（官方自己保存完整 transcript）。
3. **官方 2.1.299 的 `/v1/models` 能力抓取被關掉**（§5），gateway 仍照該程式碼路徑的分頁/認證形狀呼叫它，屬於超出官方現況的額外請求；本次實測接受並回傳 14 個模型，多頁情境未實測。

## 2. 基線、範圍與證據方法

| 基線 | 固定版本 |
|---|---|
| 官方 Claude Code（主要抄錄來源） | 本機 native release `2.1.299`：`/home/scott/.local/share/claude/versions/2.1.299`，SHA256 `2d894a4b1bfaaa9aab72aeff7803e3c73bc2510f279a171f6b8f59f72d17d077`，內嵌 `GIT_SHA c416f56ec7eca27e49747c35af51d5c92c856ba1`、`BUILD_TIME 2026-10-13T21:37:33Z` |
| 官方 Claude Code 原始碼參考（僅插件路徑） | `references/claude-code` @ `9b4f0d6ef8ceaf62f6b46babb9a4d84bec541a2e`（`v2.1.299-1-g9b4f0d6`） |
| agent-gateway | 本工作區（未提交） |

證據方法：以 Python `mmap` 唯讀該 ELF 檔內嵌的 minified JavaScript（offset ≳ 214,000,000 才是 JS 區），**未執行 CLI、未讀取任何憑證或對話記錄**。下文 `@<offset>` 皆指該 SHA256 檔的位元組偏移；換版後偏移會失效，必須重新比對。

`references/claude-code` 只有 `plugins/security-guidance/hooks/llm.py` 這類**插件**直接 HTTP 呼叫（OAuth/beta/system 首塊可佐證），不是 CLI 的 streaming/auth 實作；該插件的 structured-output beta 與主 CLI 不同，本報告不混用。

判讀標記：`[v]` 表示該項目已由原始碼或測試確認（或已記錄為範圍限制），**不代表已對上游實測**。

## 3. Endpoint 與 headers

### 3.1 Endpoint

| 用途 | agent-gateway | 官方 2.1.299 |
|---|---|---|
| 推論 | `POST https://api.anthropic.com/v1/messages?beta=true`，body 一律帶 `stream:true` | beta messages resource `@218933955` 使用 `?beta=true`；主推論呼叫在 body 設 `stream:true` `@226675303`（SDK client `@218975339`，`timeout` 預設 `600000`） |
| 模型目錄 | `GET https://api.anthropic.com/v1/models?limit=1000`，`has_more` 為 true 時用 `last_id` 加 `&after_id=<last_id>` 續頁，沒有頁數上限 | `models.list({betas:[oauth-2025-04-20], limit:1000})` `@233338777`；分頁形狀是 SDK `Page`：`has_more`/`last_id`/`after_id` `@218854348`。整個能力抓取被 `Dzn(){return!1}` `@217921071` 關閉 |
| token refresh | `POST https://platform.claude.com/v1/oauth/token` | 同 URL（prod 常數 `@214897810`） |

`has_more` 為 true 卻沒有游標、或游標重複（會無限轉頁）→ 502，不靜默回短清單；回應沒有 `data` 陣列或模型沒有 `id` 同樣 502。

### 3.2 Headers

| Header | agent-gateway | 官方 2.1.299 | 判讀 |
|---|---|---|---|
| `authorization` | `Bearer <claudeAiOauth.accessToken>` | 訂閱登入走 `wRs()` `@218608550`：`authToken = oauthAccessToken`、**不帶** `x-api-key` | 一致；gateway 也不帶 `x-api-key` |
| `anthropic-version` | `2023-06-01` | SDK 預設 `@218991784` | 一致 |
| `x-app` | `cli` | `Nl()` `@219076570`：背景模式為 `cli-bg`，否則 `cli` | gateway 一律 `cli` |
| `user-agent` | `claude-cli/2.1.299 (external, <effective entrypoint>[, agent-sdk/…][, client-app/…])`（`CLAUDE_CLI_VERSION` 常數；entrypoint 經啟動解析，見 §3.3） | `$0()` `@218027148`：同形狀，另有 `, workload/…`（來自內部 async context）；env 由啟動期 `T` `@215050094` 先正規化 | **照抄**（用戶明確核准的 Claude 專屬例外，推翻先前 own-UA 指示，§9.1）：SDK 後綴 truthiness 與順序一致；gateway 無 workload context，走官方 absent-context 分支不帶該後綴 |
| `anthropic-beta` | CLI marker（非 Haiku）→ OAuth marker → interleaved / redact / token-count / context-management（依能力；redact 限互動 cli）→ prompt-caching-scope → effort / structured-output（依功能） | native SL `@217935458` 與 CLIProxyAPI v8.0.29 `claudeCodeCLIBetas` | 2026-10-15 補齊四個既有缺漏與 marker 順序；完整差異與未複製的 feature betas 見重新比對報告 |
| `x-claude-code-session-id` | gateway 依 `alias + model + 對話開頭` 雜湊 | header 名稱常數 `kDt = "X-Claude-Code-Session-Id"` `@217823927`，值為 CLI 自己的 session UUID | 名稱一致、值非官方 session（§9） |
| `x-client-request-id` | 第一方 Messages 每次 send 產生新 UUID，401 retry 也重建 | native fetch wrapper `@219095310`；CLIProxyAPI `applyClaudeHeadersWithNativeProfile` | 2026-10-15 補齊；與 conversation session 分開 |
| `content-type` / `accept` | Messages：`application/json` / `application/json`；Models：（無 body）/ `application/json` | SDK buildHeaders `@218991503` 首項 `Accept:"application/json"`；beta messages resource `@218933955` 保留該預設，streaming 也不改 Accept（串流由 body `stream:true` `@226675303` 決定） | 一致。**更正**：先前版本宣稱「streaming 時接受 SSE → 一致」是錯的——gateway 當時 Messages 送 `text/event-stream`，與官方 SDK 預設不同；現已改為 `application/json` 對齊（單元/端到端測試及本次 Sonnet 5 上游實測通過，§11） |
| `x-stainless-*` | 照 bundled SDK 0.128.0 送八個 `x-stainless-*` 加 `anthropic-dangerous-direct-browser-access`（Messages 九個、Models 不帶 timeout 八個）：`x-stainless-lang:js`、`package-version:0.128.0`（`YT` `@218715152`）、`os`/`arch`（`x()`/`D()` 映射 `@218716552`，平台六欄如 `Djn` 只算一次快取）、`runtime:node`、`runtime-version:process.version`、`retry-count:0`（`maxRetries:0` `@226673293`，401 恢復與 Models 各頁都是新發送仍為 0）、`x-stainless-timeout`（`buildRequest` `@218990687`：預設 timeout 只加在副本、`buildHeaders` 看原始 options，所以**只有明確傳入 truthy timeout 才送**：Messages 600000→`600`，Models 不送）、`anthropic-dangerous-direct-browser-access:true` | SDK `buildHeaders` `@218991503` + `te()`/`Djn()` `@218716552` | **照抄**（用戶核准的 native identity 範圍）。gateway 僅 node ≥22，不模擬 Deno/browser 分支；`x()` 對 OS 先小寫化、`D()` 對 arch 大小寫敏感且 fallback 原樣回傳，gateway 逐字照抄 |
| `anthropic-workspace-id` / `anthropic-user-profile-id` | 不送 | 有 workspace/profile 資訊時才加 `@218975339` | 官方也是條件式；gateway 沒有該資料 |
| `x-claude-remote-*` / `x-claude-code-agent-id` / `x-anthropic-additional-protection` | 不送 | 遠端容器、subagent、`CLAUDE_CODE_ADDITIONAL_PROTECTION` 等條件分支 `@219078540` | 官方條件分支，非必要集合 |

### 3.3 啟動期 entrypoint 解析與 basic billing（用戶核准的 native identity 範圍）

**Entrypoint**（`T` `@215050094`、`Le` `@214625500`）：gateway 用一個共用解析器（UA 與 billing 同一個值，不修改 `process.env`）：

- 非空 `CLAUDE_CODE_ENTRYPOINT` 原樣保留，唯一例外是 `local_agent` → `local-agent`；純空白值原樣保留。
- 缺失或空：`CLAUDE_CODE_ACTION` 依 `Le`（trim/lower 後 `1/true/yes/on`）→ `claude-code-github-action`，否則 `cli`。
- gateway 一律互動模式：不做官方 `cli`→`sdk-cli` 轉換、不探 argv 的 mcp/print 分支。
- 來源層級：`wSo` 單獨看 raw env 時備援是 `unknown`，但生產流程裡 `T` 在啟動期已把 env 正規化過，所以正常 CLI 情境不會出現 `unknown`；gateway 直接用解析後的值。

**Billing**（`wSo` `@218606801`、`qB`/`Im` `@222259800`、`XB` 鹽 `59cf53e54c78`）：system **文字區塊**（不是 HTTP header），basic 形狀固定為
`x-anthropic-billing-header: cc_version=2.1.299.<fingerprint>; cc_entrypoint=<effective>; cch=00000;`

- 指紋：取第一則 pre-normalization user 候選的文字（字串內容整段；陣列只取第一個 text 塊；圖片無文字或 tool_result 得空字串**且不再往後找**；system/developer 不是候選；在相連 user 合併**之前**算），UTF-16 第 4/7/20 碼元（缺→`0`），`sha256("59cf53e54c78" + 碼元 + "2.1.299")` 前 3 個 hex。
- `cch=00000` 是 builder 的 **placeholder**，送出前依 CLIProxyAPI `claude_signing.go` 計算 final-body XXH64 checksum。先前「沒有 JS 改寫所以是固定值」的結論錯誤：native code 區有相同 seed，不能只從嵌入 JS 推論 wire 值。詳見重新比對報告與 `signing.tdd.test.ts`。
- Opt-out 只認 `CLAUDE_CODE_ATTRIBUTION_HEADER` 依 `ys`（trim/lower `0/false/no/off`）；未設/空/其他值都保持開啟。
- lifecycle/workload/subagent/prev-req/prompt-id/turn/index/gateway 等可選欄位**全部省略**（用戶選 BASIC）；不發明 ID。
- 本次 Sonnet 5 實測接受已簽 CCH 的 billing 區塊與 headers，文字／工具回合成功（§11）。未做單變因對照，故不斷言先前「extra usage」錯誤的唯一成因。

## 4. 憑證與 OAuth refresh

| 項目 | agent-gateway | 官方 2.1.299 |
|---|---|---|
| 檔案 | `<claude-home>/.credentials.json`，頂層 `claudeAiOauth`；**未知頂層欄位原樣保留** | 同檔名/結構 `@217333107`（目錄由 `CLAUDE_CONFIG_DIR` 決定，`@214757561`） |
| 解析失敗 | 只報「檔案不是有效 JSON」與路徑，**不帶出檔案內容片段** | 官方 JSON 解析錯誤訊息可能含片段；gateway 刻意截短 |
| 寫入 | 暫存檔 + rename，`0600` | 原子寫入 + `0600` `@217333107` |
| 需要 refresh 的時機 | `now + 300000 >= expiresAt`；`expiresAt` 為 null 時視為不過期 | `OH()` `@217754567` 完全相同 |
| 跨 process 鎖 | 同一把鎖：目錄 `<home>/.oauth_refresh.lock`，外加舊版 `realpath(<home>) + ".lock"`；`mkdir` 取得、mtime 當擁有憑證（stamp 到下一整秒 +5ms）、每 5000ms 先 `stat` 比對再重 stamp、`stale` 60000ms 內不搶、超過才 takeover；心跳發現被搶走 → **中止進行中的 refresh POST**（AbortController），輪替後的憑證絕不寫到別人的鎖下；釋放 = `rmdir`，但只在 mtime 仍是自己的 stamp 時刪，已被搶走時連心跳都還沒發現也不刪 | 官方 bundle proper-lockfile v4 `@215028300`（probe `@215028513`、getMtime `@215028875`、acquire `@215029205`、update/ECOMPROMISED `@215029977`、compromised `@215030747`、release `@215031597`、`stale>=2000`/`update∈[1000,stale/2]` clamp `@215030880`）；設定 `nGn` `@217997780`：`{lockfilePath:<home>/.oauth_refresh.lock, realpath:false, stale:60000, update:5000}`；舊鎖路徑 `xE` `@217997977`，兩把一起拿的是 `pOs` `@217998206`；native wrapper 在鎖被搶走時取消 refresh |
| 鎖被別人拿時 | 重試 5 次、每次 `1000 + rand*1000` ms，其後**不 POST**，改讀盤面憑證：已被兄弟輪替就採納，否則沿用舊 token 並 warn | `Za` `@218001100` 相同：`lock_busy`/`lock_timeout` 不發 refresh 請求 |
| refresh 請求 | JSON body：`grant_type:"refresh_token"`、`refresh_token`、`client_id`、`scope`（空格分隔），有 `expires_in` 才加；`Content-Type: application/json`；timeout 30s | `vwe()` `@217749927` 相同欄位與 timeout |
| scope 來源 | 預設訂閱者（無 `clientId`，且已記錄 `user:inference` 或有 `subscriptionType`）→ 展開為 base 清單 `user:profile user:inference user:sessions:claude_code user:mcp_servers user:file_upload user:plugins`，並保留原本已有的 `user:projects:read\|write`；其他情況照原本記錄的 scopes（完全沒有則用 base 清單） | 展開條件與寫法 `EHo` `@214897545`（保留清單 `pHr` `@214897455`、inference 檢查 `k4n` `@214897077`），由 `Za` 在 `@218003400` 決定；scope 常數與 `Lgt()` `@214897026`（`user:plugins` 在 prod 為 true `@214898400`） |
| scope 被拒 | **HTTP 400** `invalid_scope` 且原本是展開清單時，用**記錄的** scopes 重試一次（其他狀態碼帶 `invalid_scope` 也不重試）；只有 `invalid_grant` 才算 refresh token 已死 | 同一處 `@218003400` 傳 `invalidScopeRetried`，由 `Gvo` `@217759664` 判斷 HTTP 400 `invalid_scope`；`Ewe` `@217759471` 只認 `invalid_grant` |
| client id | 憑證檔的 `clientId`，沒有則 `9d1c250a-e61b-44d9-88ed-5944d1962f5e` | `un().CLIENT_ID` `@214898400` |
| 回應處理 | `expiresAt = now + expires_in*1000`；回應沒給 `refresh_token` 時**保留舊值**；有 `refresh_token_expires_in` 才更新 | 相同規則 `@217749927` |
| 同 process 併發 | 共用 Promise single-flight | 同 `@218001100` |
| 輪替保護 | 送出後重讀檔案做 compare-and-swap：檔中 refresh token 已不同 → 採納檔案內容，不覆寫 | `KCr({postedRefreshToken,…})` `@217983336` |
| 帳號身分 | 讀 `<home>/.config.json`，再 `<home>/.claude.json` 的 `oauthAccount.accountUuid`（**不**拿 `organizationUuid` 代用：那是組織不是使用者），作為狀態檔索引的一部分；每個請求重讀，換登入不會沿用舊帳號的身分。**讀不到 accountUuid 時一律 400**（`claude_account_required`）：沒有可佐證的帳號身分就無法保證簽章回放隔離（同一 home 換登入會共用狀態鍵），官方正常登入的 home 一定有這筆記錄 | `oauthAccount` 位置 `@214971963`、讀取路徑 `@217653502`/`@217997317`；同一檔的 `userID`（64 hex，`Rs` `@217681129`）由 `BO` `@217681149` 讀取並經 `nUe` 送作 `device_id` |
| 憑證讀取時機 | 每次取用都重讀盤面 `.credentials.json`（官方也是每次使用時讀檔），所以換登入（relogin）不用重啟就會換到新帳號的 token；狀態索引的 accountUuid 也同步換新 | 官方 auth 流程每次從檔案取用（`Za` `@218001100` 前讀檔） |
| 401 恢復 | 推論 401 時先採納盤面新 token，否則 refresh，**只重試一次** | 官方亦為單次恢復，不無限重試 |
| 永久失敗 | `invalid_grant` 等 401 記為該 refresh token 的永久失敗，後續不再 POST，並提示 `CLAUDE_CONFIG_DIR=<home> claude` 後 `/login` | 官方提示 `/login`（`name:"login"` `@224978795`） |

[v] **跨 process 鎖與官方相容。** gateway 用同一把 `.oauth_refresh.lock`（外加舊版 `<home>.lock`），所以同一個 Claude home 同時給官方 CLI 與 gateway 時，兩邊會互相等鎖，不會互搶一次性 refresh token。gateway 另外只讀 `.config.json`/`.claude.json` 的帳號 uuid，不寫官方 transcript 或 `settings.json`。

## 5. 模型目錄與內建能力資料

- gateway 每次 `/v1/models` 會呼叫上游（5 分鐘快取、single-flight），並用 pinned 內建能力表補 `max_output_tokens`、thinking 形式與 effort 支援。
- pinned 表取自官方內建模型表 `@215969375`（`src/claude/modelMetadata.ts`，22 個模型：id、`provider_ids.first_party`、context window、`max_output_tokens` default/upper、`default_effort`、capabilities）。比對時會去掉日期後綴與 `[1m]` 後綴。
- 能力查詢是三態：表格有該項 → true；表格沒這一列/沒有該項 → `undefined`，改走官方的名稱規則 fallback（`MPe` `@217927847` 是環境變數覆寫、`X_` 查模型表）。gateway 沒有實作環境變數覆寫，但實作了名稱規則本身：thinking 支援 `WIs` `@217930405`（非 `claude-3-*`）、effort 支援 `bb` `@218701764`（固定排除名單之外預設 true，所以 `claude-opus-4-5` 雖不在 raw 表也有 effort）、`max_effort` `cse` `@218702215`、`xhigh_effort` `Qdt` `@218702663`（各自有排除名單）。default effort 依 pinned `default_effort`，沒有則 `high`（`Je` `@218713474`）；home 的 effort 值會先依模型可用層級過濾（`jBn` `@218712820` 逐一驗證候選），並照 `U` `@218711050` 正規化：該模型跑不了的 `max`/`xhigh` 落回 `high`（如 Opus4.6 的 `xhigh`），其他不被支援的 home 值則丟掉，都不會送出去。
- [v] 官方 2.1.299 的 `/v1/models` 能力抓取被 `Dzn(){return!1}` `@217921071` 關閉。gateway 保留這項額外請求；2026-10-15 實測回傳 14 個模型。`has_more` 多頁游標流程仍僅單元測試驗證。
- `/v1/models` 給 client 的清單：Codex 帳號在前、Claude 帳號在後；Claude 條目 `owned_by: "anthropic"`、`description` 標明所屬 home、`context_length` 來自 `--context-length`（僅標示，不限制請求）。

## 6. 請求成形（OpenAI → Claude）

| 項目 | agent-gateway 送到 Claude | 官方依據 |
|---|---|---|
| `stream` | 一律 `true`（client 要非串流時由 gateway 聚合） | 主推論呼叫 `@226675303` |
| `system` | basic billing 文字塊（opt-out 時缺席、不掛快取）、互動 CLI 前綴掛 ephemeral。caller 的 `instructions` 與 developer/system 文字依序用兩個換行 join 成一個 cached block；支援的模型將它移到第一個 user 回合後的 `role:system`，legacy 模型保留 top-level | billing／前綴仍依 native `K_o`；caller 位置依 CLIProxyAPI v8.0.29 `insertClaudeMidConversationSystemBlocks`。native 2.1.299 模型 gate 與 GA、不加 beta 的依據見重新比對報告；這是經完整 OpenCode 請求驗證的代理適配 |
| `messages` | user/assistant 文字、base64 與 https 圖片、`tool_use`、`tool_result`；同 role 相連後，按模型能力插入 caller system 訊息 | Messages API 區塊形狀 `@216812970`；caller placement 同上 |
| `tools` | 只接受 `function`：`{name, description, input_schema}`；`parameters` **整份 JSON Schema 原樣轉送**（`$defs`、`additionalProperties`、combinator、`required` 都保留），只是補上 `type:"object"` 與 `properties:{}` 預設 | 官方 tools 形狀；丟掉 `$defs` 會讓 `$ref` 悬空 |
| `tool_choice` | `auto`→省略、`required`→`{type:"any"}`、指定 function→`{type:"tool",name}`、`none`→連 tools 一起省略；`parallel_tool_calls:false`→`{type:"auto",disable_parallel_tool_use:true}` | Messages API 表單 |
| thinking 支援 | 名稱規則：`claude-3-*` 家族完全沒有 thinking；其他模型有。有 `adaptive_thinking` 能力（`$Eo` `@217931450` 的排除清單之外）→ `thinking:{type:"adaptive"}`；否則 → `{type:"enabled",budget_tokens}`（下限 1024、上限 `min(upper-1, max_tokens-1)`）。budget 形式模型若 `max_output_tokens` 小到放不下 1024 下限（`max_output_tokens<=1024`）→ **400**，不發請求；adaptive 模型沒有 budget 下限，小 `max_output_tokens` 照常接受（模型特定） | 支援與否 `WIs` `@217930307`（`MPe` 覆寫，否則 `!canonical.includes("claude-3-")`）、adaptive 與否 `$Eo` `@217931450`、budget 上下限 `@226635226` |
| thinking 關閉 | 模型允許關閉時送**明確的** `thinking:{type:"disabled"}`（effort 仍照 `Zdt` cap 送）；不允許關閉的模型（`rejects_disabled_thinking`）明確要求 `reasoning.effort:"none"` → **400**，home 的 `alwaysThinkingEnabled:false` 對它無效（保持開啟並 warn） | 明確 disabled 區塊 `@226633000`；`rejects_disabled_thinking` 判定 `HPe` `@217930405` + `uS` `@217930832`，home 設定無效的規則 `V3e` `@217931012` |
| effort | 送在 `output_config.effort`；可用值依模型能力**名稱規則**（§5：`bb`/`cse`/`Qdt` fallback，不是只看 raw 表 flag）；預設值是 pinned `default_effort ?? "high"`（`Je` `@218713474`）；`settings.effortLevel` 只接受 `low/medium/high/xhigh`，`maxEffortLevel` 與 per-model `modelSettings` 做 clamp（`K8` `@218704757`），clamp 後的值再照 `U` `@218711050` 正規化：模型跑不了的 `max`/`xhigh` 落回 `high`，所以 HOME cap `xhigh` 配 Opus4.6 不會把 `xhigh` 放上線；top-level `effortLevel` 只套在 `Te` 白名單 `@218706100` 內的模型與官方不認識的模型（`Nyo` `@218707546`）；home 層級不被該模型支援時照 `U` 落回 `high`（`max`/`xhigh`）或**丟掉**（其他值），不送、也不報錯；thinking 關閉且有 `thinking_disabled_effort_cap` 的模型把 effort **clamp 到 `high`**（不是丟掉） | effort 合併 `@218709369`、settings 過濾 `@218706528`、能力 fallback `bb` `@218701764`/`cse` `@218702215`/`Qdt` `@218702663`、預設 `Je` `@218713474`、候選驗證 `jBn` `@218712820`、cap clamp `K8` `@218704757`、最終正規化 `U` `@218711050`、關閉時 cap `Zdt` `@218703811` |
| 強制 tool_choice + thinking | **400**，不降級（官方會降為 `auto`） | 官方降級 `@226635226`；gateway 選擇保留呼叫端語意並回報（§9） |
| `max_tokens` | 客戶端 `max_output_tokens` > 上游目錄值 > pinned default；非正整數或超過 pinned upper → 400；未知模型且無目錄值 → 400 要求帶 `max_output_tokens` | 內建表 `@215969375` |
| 結構化輸出 | `text.format.type:"json_schema"`（或 Chat 的 `response_format`）→ `output_config.format:{type:"json_schema",schema}`，並加 `structured-outputs-2025-12-15` beta；`json_object` → 400；`claude-opus-4-1` 不支援 → 400 | 設定 `output_config.format` 的 `rNr` `@226584133`，條件 `jzn` `@217932977`（firstParty 且非 `claude-opus-4-1`）與 `tge` `@224806672`（`V6e` `@219062856` 是 foundry 的 capability-strip，預設為空 → 不影響）；format 形狀 `@216817066`。beta 與 format **同步**加入：`rNr` `@226584124` 在 `outputFormat` 存在時加入 `_ie`，主推論 builder `@226632695` 呼叫它，`LCr` `@217938246` 保留；`SL` `@217936056` 的 `tengu_tool_pear` 開關只限制**全域**清單，不影響這條路徑 |
| `metadata` | `metadata.user_id` = JSON 字串 `{"device_id":"<home 的 userID，若有>","account_uuid":"<home 的 accountUuid>","session_id":"<gateway session>"}`。`device_id` 就是同一個 home 全域設定裡的 `userID`（`BO` `@217681149` 讀 `Rs` `@217681129` 驗證的 64-hex 值）：有就轉送；沒有時**省略**，因為官方的備援是**生成並寫回**官方設定檔，gateway 不寫官方檔案、也不發明識別碼（§9.4） | `nUe` `@218996645`：`user_id` 為含 `device_id`/`account_uuid`/`session_id` 的 JSON 字串，`device_id` 直接取 `BO()` |
| `cache_control` | billing 不掛；CLI 前綴、joined caller 各掛 ephemeral。先標記原 user/assistant 歷史的最後合格尾塊，再插入 caller system；不改變原標記位置，tools 不掛、一律不帶 ttl | `NNr` / `ryn` / `oyn` / `E7e` 與 `sNr` / `iNr` 的主推論標記規則，詳 §8.2；caller 位置依 §6 system 列 |
| 不送 | `store`、`include`、`prompt_cache_key`、`service_tier`、`previous_response_id`、Responses Lite `additional_tools`、Codex `ultra`→`max` | 這些是 Codex 路徑專屬或官方另有條件（§8.2、§9） |

## 7. Thinking 狀態持久化（gateway 自有）

官方 CLI 自己保存完整 transcript，因此沒有對應機制；OpenAI 相容 client 也不會把簽章區塊帶回，所以 gateway 必須自己保存：

- 位置：`<claude-home>/.agent-gateway/claude-state/<sha256(stateKey)>.json`，目錄 `0700`、檔 `0600`、暫存檔 + rename。
- `stateKey = accountIdentity\0model\0(prefixIdentity\0visibleAssistantIdentity)`：
  - `accountIdentity`：`home 路徑 + 該 home 的 `oauthAccount.accountUuid`（**不**代用 `organizationUuid`）的雜湊，**每個請求重讀**，所以同一 home 換帳號（relogin）後不會撿到、也不會回放舊帳號的簽章區塊。accountUuid **是必要條件**：讀不到時整個請求 400（`claude_account_required`），因為沒有可佐證的帳號身分時，新舊登入的狀態鍵會相同，回放隔離無法保證；官方正常登入的 home 一定有這筆記錄。
  - `prefixIdentity`：該 assistant 回合**之前**的可見對話前綴結構化雜湊。`reasoning` 不列入（不是每個 client 都會回送）、`additional_tools` 忽略；`function_call` 與 `function_call_output` **列入**；tool 參數先解析再按 key 排序序列化（深層），避免 key 順序/空白造成比對失敗；結構化序列化避免文字內容偽造出 part 邊界。
  - `visibleAssistantIdentity`：該 assistant 回合**自己外顯**的可見文字 + 依序的 tool calls `[call_id, name, 正規化參數]`。因此同一前綴的兩個分支（不同 tool id/參數）各自成鍵、互不覆蓋；Claude 的 Chat 聚合把多個 text 項目**不加分隔符**串接（與原生 text 區塊的串接一致），所以 client 把收到的 content 原樣 echo 回來就能對上；Codex 的聚合仍保留空行分隔。邊界掃描把 `reasoning`/`additional_tools` 當中性項目，不會把一個原生 assistant 回合（文字+thinking+工具交錯）切成兩段。
- 內容：`{version, alias, model, accountIdentity, identity, thinking(該回合釘住的設定，含最終 budget_tokens), savedAtMs, assistantContent(原生區塊，含 thinking/signature/redacted_thinking), callIds}`。
- 觸發（單一原子存檔）：只有含 tool call 或隱藏區塊的回合會寫，而且**只在通過驗證的 `message_stop` 一次性寫入完整原生內容**。所有 tool 的 `function_call_arguments.done`/`output_item.done` 延遲到存檔成功後才發出；提前上游錯誤、壞尾、截斷或寫入失敗 → 沒有可回放的部分記錄、也沒有已完成的 tool（參數 delta 仍照常串流）。
- 讀取驗證：`parseState` 驗證每個原生區塊的必填欄位（thinking 的 `signature`、tool_use 的 `name`/`id`/object `input`、redacted 的 `data`…）、`callIds` 與 tool_use 一一對應、thinking 設定形式，以及**記錄內容與它所存的 key 一致**（複製/改名到他鍵的記錄直接拒絕）。準備回放時再比對可見 echo 與記錄的原生內容（文字與 call 依同一規則正規化），並拒絕與模型模式不相容的 thinking 記錄。
- 回放：每個 assistant 回合依自己的 `prefixIdentity+visibleAssistantIdentity` 各自查找、各自還原，原生內容在原本位置**只出現一次**（不會先送可見文字、又補一份相同的原生文字）。只有**未結束的 tool 回合**釘住 thinking 設定（含 `budget_tokens`）；已結束的 tool 回合不需要狀態，所以之後的新 user 回合可以用新的 home 設定繼續。釘住的設定與重複的**相同**顯式請求（含被 clamp 的 `maxEffortLevel`、`none`→disabled）比對的是解析後的設定，不會誤判成中途改變；真正的中途改變仍 400。
- 比對：可見文字/參數/指令/歷史前綴被改 → 找不到記錄 → 400（需要回放但狀態缺失/損毀也是 400，即使 home 之後把 thinking 關掉也不重建未簽章內容），狀態檔損毀的錯誤訊息不帶出檔案內容。
- 沒有自動過期/清理；刪除該目錄即清除（README 有說明）。gateway 不寫官方的 transcript 或 `settings.json`。

## 8. SSE 與事件轉換

| 項目 | 處理 | 官方依據 |
|---|---|---|
| SSE 讀取 | Claude 走嚴格解析器：`data` 不是 JSON、或事件沒有 `type` → 502（不略過）；註解行、`ping`、`[DONE]` 忽略 | Codex 路徑的 `utils/sse.ts` 是寬鬆解析，Claude 不能沿用：略過事件會把壞掉的串流變成看起來成功的回應 |
| 事件集合 | `message_start`、`content_block_start/delta/stop`、`message_delta`、`message_stop`、`ping`、`error` | 官方事件 allowlist `@239430414` |
| delta 集合 | `text_delta`、`input_json_delta`、`thinking_delta`、`signature_delta`、`citations_delta`(忽略)、`compaction_delta`(只存不顯示)；其他 → 502 | 官方 delta allowlist `@239430414`、累加語意 `@218919418` |
| 串流順序 | 區塊 index 必須遞增、不可重複開或重複關、delta 類型必須符合區塊類型、`message_delta` 前所有區塊要已關閉且要有 `stop_reason`、`message_stop` 前要有 `message_delta`、`message_start` 只能一次且要有 `id`/`role`/`content`、`tool_use` 要有 `name` 且 id 不可重複、`message_delta` 之後不能再開區塊、`message_stop` 之後不能再有事件、delta 欄位型別（`text`/`partial_json`/`thinking`/`signature` 必須是字串）逐一驗證 → 違反即 502 | 官方串流驗證器 `@226691155` |
| 區塊類型 | `text`→message、`tool_use`→function_call、`thinking`/`redacted_thinking`/`compaction`→reasoning（內容不外顯、原樣保存）；pinned release 已知的**非語意/未建模**區塊（官方 server tools 等）→ 明確 502，不靜默變成空 reasoning；比建模清單更新的**未知**類型 → log warn 後當 opaque 保留（官方 tolerance） | 官方 schema 註解：只建模 text/tool_use/thinking，「consumers must tolerate types newer than this list」`@216812970` |
| 起點欄位保留 | `content_block_start` 帶的非空 `text`/tool `input` 會直接種進累加器（不會被之後的 delta 流程丟掉），原生區塊原樣保留（含 citations 等附加欄位） | 官方累加語意 `@218919418` |
| tool 參數 | 只累加 `input_json_delta`；結尾解析失敗 → 502（不修成 `{}`、不完成回應） | 官方不修復壞掉的 tool JSON |
| 簽章/思考不外顯 | client 只看到 `reasoning` 空殼；thinking 文字與 signature 只進狀態檔 | — |
| usage | `input_tokens = input + cache_read + cache_creation`，`cached_tokens = cache_read`，`thinking_tokens`（若有）→ `output_tokens_details.reasoning_tokens`；`message_delta` 的 usage 是**累計**值，但只覆蓋它實際帶來的欄位，`message_start` 的計數保留 | usage 驗證器 `@218437250`、`thinking_tokens` 為 optional `@216812970` |
| 結束 | `stop_reason`：`max_tokens`→`response.incomplete/max_output_tokens`、`refusal`→`incomplete/content_filter`、其他→`completed` | 官方 stop_reason 列舉 `@218437250` |
| 異常 | 缺 `message_start` 或缺 `message_stop` → 502 `stream_incomplete`；`error` 事件 → 502；delta 指向未知區塊 → 502。已輸出部分內容後**不重送**；翻譯器在 headers 已送出後拋錯時，handler 會補發標準失敗：Responses 發 `response.failed`（不發成功 terminal）、Chat 發 error payload（不發 `[DONE]`），client 不會只看到 HTTP 200 + 無訊息 EOF。client 斷線時 `finally` 取消上游串流；`writeText` 在背壓等待期間遇到 `close` 會立刻結束等待（不會卡死在不會來的 drain），讓 handler 走到取消上游的清理 | 官方串流驗證器 `@226691155` |

### 8.1 retry 與 timeout

| 項目 | agent-gateway | 官方 2.1.299 |
|---|---|---|
| 推論 retry | 只有一次 401 憑證恢復，其他狀態碼直接回報 | 推論 client 用 `jF({maxRetries:0,…})` `@226673293`，**不重試推論**；side query 才用 1、quota check 0、verify_api_key 3 |
| SDK retry 政策 | 不適用（不用 SDK） | `shouldRetry()` `@218989461`：`x-should-retry` header 優先，其後 408/409/429/≥500，並依 `retry-after(-ms)` 退避；因推論 `maxRetries:0` 而不生效 |
| timeout | 600s（`AbortSignal.timeout`） | SDK client `timeout: skr() ?? 600000` `@219079599` |

### 8.2 prompt caching

官方**主推論**路徑的標記政策：builder 於 `@226637540`–`@226638142` 呼叫 `NNr`（定義 `@226725197`），`NNr` 先用 `ryn` `@226486727` 算出標記索引，再由 `sNr` `@226585288`（user）/`iNr` `@226586013`（assistant）帶 `z4` `@226582681` 掛上 `cache_control`。default 形狀是：**從最後一則訊息往回**找第一則「合格」的訊息（`oyn` `@226486225`：user 一律合格；assistant 只看**最後一個區塊**是否過 `E7e` `@226486043`——空 text、thinking、redacted_thinking、`fallback`（`j2` `@223419032`）不合格，**tool_use 合格**），在該訊息的**最後一個區塊**掛 `cache_control:{type:"ephemeral"}`；assistant 尾塊不合格時**整則跳過**，不會退回該則內更早的區塊。system 側另有標記（`$Nr` `@226727459` 對 `K_o` `@218995076` 尾部映射的逐塊規則：billing 塊 `cacheScope:null` **不掛**、互動 CLI 前綴塊 `cacheScope:"org"` 掛、其餘 caller 文字 `join("\n\n")` 成一個塊 `cacheScope:"org"` 掛；`z4` 只在 scope 為 `global` 時才把 scope 放上線，`org` 段在線上就是 `{type:"ephemeral"}`）。tools 不掛標記（main builder 不傳 cacheControl，`@226609101`）。早前 `@224930741` 的標記是 classifier 專屬路徑，不是主推論政策，本報告不以其為準。

TTL：`z4` 只在 ttl 有值時才送 `ttl`，而主推論只把 `ttl:"1h"` 傳進去（`Nb` `@226618976`：`dL.ttl==="1h"?"1h":void 0`），`dL` 由 `Whe` `@226582855` 依訂閱者/allowlist/overage 情境決定；非該情境線上就是**不帶 ttl**（伺服端 default 5m）。

[v] gateway 保留上述標記形狀：CLI 前綴與 joined caller 各掛 ephemeral、billing 不掛；原 user/assistant 歷史最後合格尾塊掛 ephemeral，tools 不掛。支援的模型再把 caller 塊移到第一個 user 後的 system 訊息（§6），不挪動原歷史的標記。**gateway 一律不帶 ttl**：沒有實作 `Whe` 的訂閱者/overage/allowlist 情境，也沒有 `DISABLE_PROMPT_CACHING*` 開關，不能宣稱與官方所有情境完全相同。上游 cache hit 未實測。

## 9. 明確偏離官方之處

1. **User-Agent 照抄官方 `$0()`（用戶核准的例外，不再是偏離）**：用戶明確指示 Claude 路徑的 UA 完全跟官方環境感知產生器（pin 版本 `CLAUDE_CLI_VERSION=2.1.299`），推翻先前 AGENTS.md「UA 用自身身分」對 Claude 的適用。仍記錄的剩餘差異：gateway 無官方內部 async context，一律走 workload 缺席分支（不帶 `, workload/…`）。此例外**只適用於 Claude 路徑**；Codex 路徑的 UA 不受影響。
2. **`X-Stainless-*` 已改為照抄（不再是偏離）**：用戶核准 native identity 範圍後，gateway 照 bundled SDK 0.128.0 送八個 `x-stainless-*` 加 `anthropic-dangerous-direct-browser-access`（§3.2）。仍存的運行時差距：gateway 只走 node 分支（不模擬 Deno/browser/edge），`x-stainless-runtime-version` 是 gateway 进程的 node 版本、非官方打包環境值。
3. **`structured-outputs-2025-12-15` beta 不是偏離**（更正先前版本的錯誤記載）：`SL` `@217936056` 把該 beta 的**全域**清單放在 `tengu_tool_pear` 開關後，但 `rNr` `@226584124` 在 `outputFormat` 存在時獨立加入 `_ie`，主推論 builder `@226632695` 走的就是這條路，`LCr` `@217938246` 保留它。gateway「送 `output_config.format` 時一併送 beta」與該路徑一致；上游是否接受這個組合仍未實測（§11）。
4. **`metadata.user_id` 的 `device_id` 只在 home 有 `userID` 時轉送**：官方 `nUe` `@218996645` 的 `device_id` 直接取 `BO()` `@217681149`，而 `BO` 優先讀 home 全域設定裡經 `Rs` `@217681129` 驗證的 64-hex `userID`。gateway 讀同一個欄位並照送；**只有該欄位缺失/格式不符時才省略** `device_id`，因為官方的備援是生成隨機 32 bytes 並**寫回官方設定檔**，gateway 不寫官方檔案、也不發明識別碼。這是與官方的有限偏差（官方在該情境仍會帶 device_id），正常登入過的 home 都有這個值。
5. **`x-claude-code-session-id` 的值**是自製雜湊（同一對話穩定），不是官方 CLI 的 session UUID。
6. **多送 `/v1/models`**（§5）：官方 2.1.299 該路徑被關閉。
7. **強制 tool_choice + thinking 回 400**：官方降級為 `auto`（`@226635226`），gateway 不悄悄改寫呼叫端語意。
8. **home 的 `alwaysThinkingEnabled:false` 對 `rejects_disabled_thinking` 模型無效**：與官方相同（`V3e` `@217931012`），但 gateway 會多印一行 warn；明確要求 `reasoning.effort:"none"` 則回 400。
9. **沒有官方 CLI 的附加功能**：subagent/remote 容器 headers、attestation、`tool_search`/`context_management`/compaction 請求參數、`countTokens`、非流式 `stream:false` 路徑（gateway 一律串流上游）、prompt caching 的 1h TTL 情境與 `DISABLE_PROMPT_CACHING*` 開關（gateway 一律不帶 ttl，§8.2）。
10. **狀態檔是 gateway 自有目錄**，官方不會讀，gateway 也不碰官方檔案（憑證檔除外，那是共用的登入來源）。
11. **caller 指令位置**：支援的模型依 CLIProxyAPI 放進第一個 user 後的 system 訊息，保留全文與 system 角色；legacy 模型仍留 top-level，沒有降成 user reminder。這是代理適配，不宣稱完全複製官方每種 prompt builder。OpenCode 的修正前後實測、GA 依據與未驗證項目見重新比對報告。
12. **`previous_response_id` 由 gateway 本機展開（上游請求不變，不是偏離）**：Claude Messages API 沒有伺服器端對話狀態，client 每輪都要重送完整 `messages`。gateway 把已完成的 response 存在記憶體（LRU 最多 1000 筆，重啟即失；`store:false` 不存），收到 id 時先展開成完整 input，再走同一條 Claude 路徑，所以上游 `messages`（含簽章 thinking 回放）與 client 重送完整歷史時相同。`instructions`／`tools` 不沿用（OpenAI 語意），必須同一個帳號（alias 與 `accountUuid` 都要相同，同一 home 換登入後舊 id 不能續接）；回應物件沒有 `previous_response_id` 欄位。

## 10. 支援邊界（一律 400，不猜等價寫法）

- `text.format.type:"json_object"` 與 Chat `response_format` 的 `json_object`（pinned release 沒有可佐證的等價寫法；`json_schema` 有，見 §6）。
- 非 `function` 工具（內建 web search、MCP、custom、namespace 等）。
- 不支援的 `tool_choice`、不支援的 effort 值、`rejects_disabled_thinking` 模型要求關閉 thinking。
- thinking 生效時強制 `tool_choice`（`any`/`tool`）。
- 不支援的圖片 media type、http（非 https）圖片 URL、assistant 訊息內圖片。
- 無法表示的 input item 類型、空對話、首則不是 user。
- 形狀不良的輸入一律 400（不拋 JS 例外、不靜默丟內容）：`input` 裡的 null/非物件、`content` 裡的 null/缺 `type`/非字串 `text`、`tools` 裡的 null/非物件、`function_call` 的 `arguments` 不是 JSON **物件**、`function_call_output` 陣列輸出裡的不良 part、system/developer 訊息帶圖片等非文字語意內容。
- budget 形式 thinking 模型（如 `claude-sonnet-4-5`）的 `max_output_tokens <= 1024`（放不下 thinking 下限）→ 400，不發請求。
- 未知模型且無法決定 `max_tokens`。
- 需要回放但狀態缺失/損毀，或可見內容與存下的不一致。
- `claude1/` 這類只有 prefix、沒有模型名的 model id。

## 11. 驗證狀態

2026-10-15 重新校正後：`npm run typecheck`、`npm test`（493 tests / 30 files）、`npm run build` 與 `git diff --check` 通過。新增的 CCH / beta / request ID / system placement 測試與真實 OpenCode 驗證範圍以 [重新比對報告](CLAUDE_EASYCLIPROXY_COMPARISON.md) 為準；下表 447 項為前次驗證紀錄。

| 檢查 | 結果 | 能證明／不能證明 |
|---|---|---|
| [v] `npm run typecheck`、`npm test`、`npm run build` | 通過（447 tests / 27 files） | 型別與離線行為（headers、UA 產生器預設/啟動期 entrypoint 解析（missing/empty/local_agent/whitespace/ACTION）/SDK 與 client-app truthy/後綴順序/workload 缺席分支、Messages 與 Models 的 `Accept: application/json`、八個 `x-stainless-*` 加 `anthropic-dangerous-direct-browser-access`（Messages 九個、Models 八個；含 OS/arch 別名與 unknown 回退、timeout 僅明確 truthy 才送：Messages 600/Models 省略/0 與小數語意、retry 0 在 401 恢復與各頁不變、平台六欄快取一次）、basic billing 區塊（字面指紋向量含 Unicode/surrogate、opt-out `ys` 值、可選欄位省略、絕不進 HTTP header）、system 三塊形狀與 caller join、Messages 維持 JSON content-type 與 body `stream:true`、上游非串流 JSON 成功回包明確失敗、鎖、refresh、scope、normalization、分頁、SSE fixtures、兩端點串/非串流、thinking 工具回合與歷史回放、分支各自存檔與重啟後續接、狀態讀寫/帳號隔離/複製記錄拒絕、串流驗證與失敗送達、輸入驗證 400、relogin 後 token/metadata/狀態身分一致、背壓時 client 斷線、text+tool 回合經 Chat 原樣 echo（含重啟）、`output_text.delta` 為字串且客戶端文字只組一次、缺帳號記錄 400、HOME cap/層級依模型正規化） |
| [v] 官方鎖相容性 | `test/claude/refreshLock.test.ts` + `test/claude/auth.test.ts` | 鎖檔名稱/形態（目錄）、stale 視窗、update 重 stamp、被搶走時不刪、鎖被拿時不 POST、鎖被搶走時中止進行中 refresh 且不寫入輪替憑證 |
| [v] SSE fixtures | `test/fixtures/claude-{text,tool-call,tool-call-branch,parallel-tools,redacted-thinking,max-tokens,refusal,error,broken-stream}.sse` | 事件/區塊名稱取自 pinned release 字串與 schema；**全部是 gateway 手寫的合成回包，不是官方實際回包存檔** |
| [v] 靜態偏移 | 本報告全部 `@offset` 已逐一 dump 確認 | 偏移屬於該 SHA256 的該版本；升級即失效 |
| [v] 真實上游與 HTTP 路徑 | 原有 credential 的 OAuth refresh 與 profile 成功；Sonnet 5 文字、工具呼叫、工具結果續接與下一回合 completed；建置後 `/v1/responses` 與 `/v1/chat/completions` HTTP 200 | 證據：`.tmp/claude-poc-results.json`、`.tmp/claude-http-smoke-results.json`；本次模型清單 14 個；接受此次 header/beta/CCH 組合，不證明舊錯誤的唯一成因 |
| [ ] 未實測範圍 | 真實 thinking 簽章回放（此次工具回合沒有 thinking 區塊）、JSON Schema、其他模型推論、多頁目錄、cache hit、refresh 競爭/CAS、額度/限流情境 | 不能從本次文字／工具回合成功推定這些分支也已驗證 |

## 12. 對應原始碼

- `src/claude/index.ts`（模組邊界：`createClaudeAccount` 與請求路徑）、`auth.ts`（憑證/refresh/scope）、`refreshLock.ts`（官方鎖）、`client.ts`（headers、`/v1/messages?beta=true`、`/v1/models`）、`sse.ts`（嚴格 SSE 解析）、`modelMetadata.ts`（pinned 能力表）、`settings.ts`（settings.json、thinking/effort）、`normalizeRequest.ts`（OpenAI→正規化原生輸入，含簽章狀態回放）、`assembleRequest.ts`（system、cache marker、metadata、betas、thinking、`output_config` 的官方形狀組裝，§14 的降轉路徑共用）、`toResponsesEvents.ts`（Claude SSE→Responses 事件）、`state.ts`（回放狀態）、`handleClaude.ts`（兩端點共用路徑）、`models.ts`（目錄快取）。每個模組檔頭註解都寫明對應的官方來源與偏移。
- 測試：`test/claude/{auth,refreshLock,client,sse,settings,modelMetadata,state,normalizeRequest,toResponsesEvents,endToEnd}.test.ts`、`test/chat/{toChatCompletion,reduceChatStream}.test.ts`（Claude 的 text 合併不插分隔符、Codex 維持空行）、`test/utils/http.test.ts`（`writeText` 背壓/斷線）。全部為 gateway 依 pinned 原始碼證據獨立撰寫的測試與 SSE fixtures。官方 repo 隨附的測試只有 `mods/{diff,sec-default,agents-md,telemetry}/` 等 mod 測試（supervisor-evidence.md 已盤點）：本報告檢查過其相關性，**沒有**可直接重用的核心 Messages/OAuth 傳輸測試套件；這些 mod 測試與 gateway 的傳輸實作無關，不構成對本節行為的驗證。
- 手動 PoC：`scripts/claudePoC.ts`（`npm run poc:claude`）。腳本標頭寫明它實際驗證的項目與**不**涵蓋的項目（JSON Schema 請求、真實鎖競爭/CAS）。

## 13. 原生轉送路徑（`POST /v1/messages` 與 `count_tokens`，只給官方 Claude Code）

本節既有原樣轉送與 400 規則以預設 `--relay-fallback=reject` 為準；選擇 `degrade` 的例外見 §13.5。

這條路徑上游看到的是 **client 自己產生的官方請求**：body 逐 byte 相同，headers 只換掉 `Authorization`（`host` 和 `content-length` 是這一段連線本身的值，見 §13.2）。gateway 不組請求，所以 §3.3、§6、§7、§8 的請求成形規則都不適用於這條路徑。

### 13.1 基線與證據

| 項目 | 內容 |
|---|---|
| 官方 Claude Code | native release `2.1.302`：`/home/scott/.local/share/claude/versions/2.1.302`，SHA256 `60d7eb7f12fbb28a52533fe8be5884097403562aa02dc73991a021c7067e29a5`，`GIT_SHA 2ef144e6f98c1c99d082b735e4b38f50e3391e55`，`BUILD_TIME 2026-10-16T15:52:41Z`。唯讀讀取，沒有執行。下列偏移屬於這個檔，和 §2 的 2.1.299 偏移不同。 |
| client 偵測 | `references/CLIProxyAPI` v8.0.29 `internal/runtime/executor/helps/claude_client_detection.go` |

- `GPo` @237985931：billing builder。`cch=00000;`，以及 2.1.302 新增的 `cc_prev_req`、`cc_prompt_id`、`cc_turn_origin`、`cc_prompt_index`／`cc_turn_index`，都只在 `provider==="firstParty" && xi()` 時加入。
- `xi` @235237156：`_CLAUDE_CODE_ASSUME_FIRST_PARTY_BASE_URL`（或 clientData 的 `assumesFirstPartyBaseUrl`）為真時直接回 true；否則只有沒設 `ANTHROPIC_BASE_URL`，或 host 是 `api.anthropic.com` 時才回 true。
- `mUs` @238472365：SDK client 的建構。`defaultHeaders` 會併入 `ANTHROPIC_CUSTOM_HEADERS` 解析出的 headers（解析器 @236024731，每行一個 `Name: value`）。gateway API key 就是靠這條路從 client 送到 gateway。
- count_tokens：`DFe` @243429208 用 `GU({source:"count_tokens",...})` @243429486 建 client，再呼叫 `K.beta.messages.countTokens` @243429649；body 只有 model、messages、tools、betas、thinking，**沒有 `metadata.user_id`**。失敗時記 log、回傳 null。
  - session header：`GU` @238463851 的 `be={...Wl(),...}` @238464554，first-party 分支 `eu={...be,...$l(de,be)}` @238472426 成為 `defaultHeaders` @238473115。`Wl` @238462490 回傳 `{"x-app":…,"User-Agent":V0(),[J$t]:q()}`，`J$t="X-Claude-Code-Session-Id"` @237071983；`q()` 也是 `metadata.user_id.session_id` 的來源（@238382089）。`$l` 只會清掉 `Bs` @238455744 比對到的單一 header，fetch wrapper `Qw` @238481199 只加 header，所以這個 header 會送出。
  - OAuth beta：count_tokens 的 betas 經 `lUt` @236024090 過濾，`lUt` 含 `Ake=k("oauth_auth","oauth-2025-04-20")` @236021122；訂閱者的 `NU` 規則 @237184217 會加入 `Ake`。
- 擷取（全部只連本機 capture server，沒有打上游）：
  1. 未登入、用 `ANTHROPIC_AUTH_TOKEN`，分別跑預設模式和加了 assume 變數。加了 assume 才有 `cch`、`cc_prompt_id` 等 billing 欄位，`advanced-tool-use`、`thinking-binding-controls`、`cache-diagnosis` 三個 beta，`x-claude-code-prompt-id`、`x-claude-code-request-class`、`x-client-request-id` 三個 header，以及 body 的 `diagnostics`；tools 也從 20 個變成 12 個。
  2. 訂閱者（OAuth 登入）加 assume 變數：多了 `oauth-2025-04-20`（排第 2 個）、`extended-cache-ttl-2025-04-11`、`afk-mode-2026-01-31`、`dangerous-tool-use-2026-09-03` 四個 beta；system 的 `cache_control` 帶 `ttl:"1h"`；`metadata.user_id` 的 `account_uuid` 有值。
- 判讀：這些差異全部由 client 依 `xi()` 和登入狀態自己決定，proxy 補不回來。所以判定為官方 Claude Code 的請求，只有「已用 OAuth 登入、設了 assume 變數、而且和 gateway home 同帳號」才轉送，其他情況一律 400，不嘗試補形狀。不符合官方 client 判定的請求不在這條路徑，改走 §14 的降轉。

### 13.2 gateway 的做法（`src/claude/relayMessages.ts`、`client.ts` 的 `postRawMessages`）

| 項目 | 做法 |
|---|---|
| 判斷官方 client | `x-app: cli`、UA 以 `claude-cli/` 開頭（不分大小寫，同 CPA 的 `(?i)^claude-cli/`）、`metadata.user_id` 是含 `device_id`、`session_id` 的 JSON 字串。取自 CLIProxyAPI 的 strong signals，但不要求 `claude-code-20250219` beta，因為官方的 helper 請求可能不帶。 |
| first-party | `system[0].text` 以 `x-anthropic-billing-header:` 開頭，而且含 ` cch=`。 |
| OAuth 登入 | `anthropic-beta` 含 `oauth-2025-04-20`。 |
| 選帳號 | `metadata.user_id.account_uuid` 對每個 home 的 `oauthAccount.accountUuid`；model alias 不參與。 |
| 送出前復核帳號 | 每次真正送出前（第一次，以及 401 恢復後的重送），在 token 確定之後重新讀 home 的 `accountUuid`（只讀本機檔案，不發 OAuth preflight）。不等於 client 的 `account_uuid` 就回 400、不送出，不改 metadata 也不重簽。 |
| body | 原始 bytes。只有 model 帶了指向同一 home 的 alias 時，才替換 top-level `model` 值的那段 bytes；`cch` 計算時 model 會被清空，所以不需要重簽。 |
| transport | `node:https.request`（測試注入 `http://` base URL 時用 `node:http`），`setHost:false`，headers 以 rawHeaders 陣列送出。轉換路徑（`/v1/responses`、`/v1/chat/completions`）仍用 `fetch`。 |
| headers | client 的 rawHeaders 原樣送出：名稱大小寫、順序、重複項都不變。`Authorization` 在原位置換成 home 的 token；`host` 換成上游 host；`content-length` 填上實際 body 長度（只有改寫 alias 時才會和 client 不同）；移除 `transfer-encoding`、`keep-alive`、`upgrade`、`x-agent-gateway-api-key`。UA 照轉 client 的值（使用者核准的例外，見 `AGENTS.md`）。 |
| path 與 query | 用 `req.url` 原文，不重新編碼；URL 解析只用來判斷路由。只接受路徑形式的請求行。 |
| 上游 | `CLAUDE_BASE_URL` 加上原文 path 與 query；401 時恢復憑證，用同一份 body 重送一次；timeout 沿用 `CLAUDE_REQUEST_TIMEOUT_MS`；client 斷線時中止上游。 |
| 回應 | status、status 訊息、headers（rawHeaders，含重複的 `Set-Cookie`）、body 原樣轉回：不解壓（`content-encoding`、`content-length` 照轉）、不跟隨 redirect（3xx、`Location`、body 照轉），錯誤也一樣。只有 `connection`、`keep-alive`、`transfer-encoding`、`upgrade`、`proxy-authenticate`、`trailer`、`te` 由 gateway 自己的連線重設。 |
| gateway key | 從 `x-agent-gateway-api-key` 取；錯誤回 `403 permission_error`。不用 401，因為 native 2.1.302 @246047850 在 HTTP 401 且持有 OAuth token 時會呼叫 `Xb` 做強制 refresh，client 的 OAuth 其實沒問題。debug log 會遮掉這個 header 的整個值。 |
| count_tokens | `/v1/messages` 通過上面全部檢查後，記錄 `x-claude-code-session-id` → home 的 alias 與 `accountUuid`（記憶體 LRU，上限 `CLAUDE_RELAY_SESSION_MAX_ENTRIES` = 1000，專案自訂）。`POST /v1/messages/count_tokens` 只在 header 判定為官方 client（`x-app: cli` 加 `claude-cli/` UA，不要求 metadata）、帶 OAuth beta、session 查得到紀錄時轉送；body、headers、transport、alias 規則、送出前復核帳號（比對紀錄的 `accountUuid`）都和 `/v1/messages` 相同。不符合就回 400，不送上游。 |
| 不使用 | `state.ts`、`prepareClaudeRequest`、`toResponsesEvents`。 |

### 13.3 transport 差異

改用 raw `node:https` 之後，`fetch` 帶來的差異都已消除，並以本機 loopback wire-level 測試確認：不會多送 `accept-language`、`sec-fetch-mode`；gzip body 和 `content-encoding`、`content-length` 原樣轉回；302 原樣轉回而不跟隨；query 原文（例如 `?literal=a'b&escaped=%2f`）不被重新編碼。

仍未比對或已知不同的地方：

- `host` 必然是上游的 host；改寫 alias 時 `content-length` 會跟著變。
- TLS 指紋、HTTP 版本與連線重用行為（Node `https` 對官方 client 的 runtime）沒有比對。
- `--debug 1`／`3` 的上游紀錄不包含這條路徑（只包住 `fetch`）；`--debug 2`／`3` 的 incoming 紀錄就是上游看到和送回的內容（只差 token）。

### 13.4 驗證狀態

- [v] `test/claude/relayMessages.test.ts`（本機 loopback wire-level，上游是 `http.createServer`）：
  - 上游收到的 rawHeaders 和 client 送的相同，只差 `Authorization`、`host`、`content-length` 這一段的值，沒有 `accept-language`、`sec-fetch-mode`；body 逐 byte 相同（含非標準格式的 JSON）；query 原文。
  - SSE、gzip 錯誤 body、302 redirect、`Set-Cookie` 重複項逐 byte 或逐項相同；上游 401 恢復後用同一份 body 重送一次，重試仍 401 就原樣轉回；client 斷線時上游連線關閉。
  - 用真正的 `createClaudeAuthManager` 加假 home：入口檢查後、第一次送出前換成 B 帳號登入，或第一次送出得到 401 時換成 B 帳號登入，都回 400，沒有任何用 B 帳號 token 送出的推論請求；同帳號正常 refresh 仍會用同一份 body 重送一次。
  - 四種入口 400 都沒有上游請求（原本「不是官方 Claude Code」的 400 已移除，這類請求改走 §14）；gateway key 錯誤回 403 `permission_error`；debug level 2、3 在 key 正確和錯誤時都只印 `***`。
  - fixture 照 2.1.302 訂閱者擷取的形狀改寫，所有 id、token 和文字都是假的。
  - count_tokens：綁定的 session 逐 byte 轉送、只換 token；alias 只能指向綁定的 home；沒綁定、別的 session、沒帶 session header、沒有 OAuth beta、不是官方 client、`/v1/messages` 被拒的 session，都回 400 且沒有上游請求；綁定後 home 換帳號（包括 401 期間換）都回 400；gateway key 沿用 403 規則；LRU 淘汰最久沒用到的 session。
- [v] 真實上游端對端（使用者手動執行，2026-10-18）：`CLAUDE_CONFIG_DIR=~/.claude-personal ANTHROPIC_BASE_URL=http://127.0.0.1:8765 _CLAUDE_CODE_ASSUME_FIRST_PARTY_BASE_URL=1 claude -p "say ok"` 回 `ok`。
- [ ] 未驗證：TLS 指紋、互動模式（entrypoint `cli`）、helper 請求（例如 title、quota）、count_tokens 的實際擷取（目前只有靜態查證，見 §13.1）、其他路徑（目前回 404）。

### 13.5 可選 relay fallback（`--relay-fallback=degrade`）

已通過官方 client 偵測的請求，若缺 `cch`、OAuth beta、帳號不符、alias 不符、count_tokens session 未綁定，或送出前帳號已換，可改走 `degradeMessages.ts` / `degradeRelay.ts`；預設 `reject` 完全不變。非物件 JSON、非路徑 target、gateway key 的錯誤不降轉。目標依 alias 或第一個 Claude home 選擇。

這是 **gateway-built**，不是官方 client 的原樣請求：用既有組裝層、gateway 自己釘住的 UA/headers、目標 home metadata/token，重簽 `cch`。移除 client billing 和下一塊精確前綴；native 2.1.302 的完整集合為：`nl` @238379007（CLI）、`zd` @238379070（CLI running within SDK）、`qd` @238379170（Claude agent built on SDK）；`I_=[nl,zd,qd]` @238379238、`AKn` @238379267 使用 Set.has 完全比對。

保留原位置的 `role:"system"`、deferred tools、`tool_reference`、其他 blocks、`output_config` 所有鍵與 `safeguards`；client cache markers 拿掉後套 gateway 標記；metadata 和 thinking 設定重建。未知頂層欄位、`context_management`、`diagnostics` 丟掉並記 `ignored=`；`degraded=` 記降轉原因。工具延遲載入／reference 加 `advanced-tool-use-2025-11-20`，safeguards 加 `dangerous-tool-use-2026-09-03`。2b 的嚴格規則不變。

Session header 存在時也用作 Messages 重建的 metadata session id；否則用 2b seed。只保留此 server 已在目標 alias 降轉回應記錄的 thinking 最後 signature／redacted data（SHA256 LRU 1000 筆，重啟清空）；過濾後空掉的 assistant 整則省略，不造假文字。stream 原樣回傳，在每個 `content_block_stop` 記錄；nonstream 用既有 collector。count_tokens 另用官方 count 形狀送 `/v1/messages/count_tokens?beta=true`，status/body 照轉。

count body 僅含 slug `model`、同一 normalizer 清理的 `messages`、非空 `tools`，以及 client 有帶才照轉的 `thinking`。不經 Messages 組裝，不帶 top-level system／billing／metadata／max_tokens／stream／safeguards／output_config／context_management／diagnostics，也不增加 generation cache markers。UA、token、session header 仍由 gateway／目標帳號提供。依據 native 2.1.302 `DFe` @243429208 與 references/CLIProxyAPI `5fc580b` 的 `claude_executor_tokens.go:174-178,206-228`；後者記錄 metadata 會被真實上游拒絕。

count beta：`DFe` 對 `kte(model)` 套 `lUt` @236024090，`TMe` @236023941 取 header 字串，SDK countTokens @238319444 再加 `token-counting-2024-11-01`（字串 @238319639）。四個 allowlist 值是 `rUt`→`claude-code-20250219` @236021078、`Fdn`→`interleaved-thinking-2025-05-14` @236021145、`kMe`→`context-management-2025-06-27` @236021254、`Ake`→OAuth @236021122（`Ep="oauth-2025-04-20"` @234107965）。gateway 保留模型條件：非 Haiku 才加 CLI；interleaved 與 context-management 依第一方模型能力，加 OAuth 與 token-counting。不因 deferred tools 或 tool_reference 加 advanced-tool-use：native 的 `sLo` 不在 lUt；也不加 safeguards／effort 等 generation beta。

相似度沿用自組 Claude **65** 基準，不是原樣轉送的 100。沒有新真實上游證據：本次只跑 mock/wire 測試、唯讀靜態分析，使用者要求不連真實上游。尤其 R1（未完成 tool turn 刪舊 thinking 可能造成 ordering/signature 400）、前綴綁定與 count_tokens 重建接受度仍未驗證。

## 14. 降轉路徑（`POST /v1/messages`，其他 Anthropic client）

不符合 §13.2 官方 client 判斷的 Anthropic Messages 請求走這條路徑（`src/claude/cloakMessages.ts`）。上游看到的是 **gateway 組的請求**：和 §6 的 OpenAI 轉換路徑共用同一個組裝層 `src/claude/assembleRequest.ts`，所以 §3 的 headers、UA、billing 與 `cch`，§6 的 system、cache marker、`metadata.user_id`、betas、thinking、`output_config`，以及 §8.1 的 timeout 都相同。差別只在輸入是 Anthropic 原生格式（`src/claude/nativeMessages.ts`），以及回應不轉成 OpenAI 事件。

### 14.1 依據

- `references/CLIProxyAPI` v8.0.29 `internal/runtime/executor/claude_executor_cloaking.go`：`detectIncomingClaudeCodeRequest` 判定不是 Claude Code 的請求才 cloak；`checkSystemInstructionsWithSigningModeAt` 把 system 換成 billing 加 Claude Code 身分兩塊，caller system 用 `insertClaudeMidConversationSystemBlocks` 移到對話中；`injectFakeUserID` 補上 `metadata.user_id`。
- 官方形狀的錨點同 §2 到 §8（native 2.1.299）。非串流聚合比照 native 2.1.302 的 SDK accumulator @238304387：`text_delta`、`input_json_delta`、`thinking_delta` 累加，`signature_delta` 直接覆寫，`message_delta` 的 usage 覆寫有值的計數。

### 14.2 和 CPA cloaking 的差異

| 項目 | CPA | gateway |
|---|---|---|
| `metadata.user_id` | 產生假的 user id（可快取） | 用 home 真實的 `userID`、`accountUuid` 和 gateway 的 session id，形狀同 §6（`nUe`） |
| client 的 `cache_control` | system block 保留 client 的 cache_control | 全部拿掉，依官方 `NNr`、`$Nr` 規則重放 |
| caller system（舊模型） | `prependClaudeSystemReminderBlocksToFirstUserMessage` 放進第一個 user 訊息 | 留在 top-level system，不降成 user reminder（和 §6 相同） |
| 不支援的欄位 | 大多原樣送出 | 依 §10 的支援邊界回 400；`temperature`、`top_p`、`top_k` 和非 disabled 的 `thinking` 拿掉，記入 `ignored=` |
| `count_tokens` | 也降轉（`relocateClaudeSystemPromptForCountTokens`） | 回 400，不送上游。native 2.1.302 確實有 count_tokens 呼叫（`DFe`，`source:"count_tokens"`，@243429665），遇到錯誤只記 log、回傳 null。官方 Claude Code 的 count_tokens 走 §13.2 的 session 綁定轉送 |

### 14.3 和 §13 原樣轉送的差異

| 項目 | §13 原樣轉送 | 降轉 |
|---|---|---|
| 和官方相同的程度 | body 與 headers 是官方 client 自己產生的 | 只有形狀和 gateway 已對齊官方的那套相同；tools、system 文字、messages 是 client 的 |
| 帳號 | `metadata.user_id.account_uuid` 對 home | model alias，或 bare `claude-*` 對第一個 Claude home（同 `/v1/responses`） |
| session | client 的 `x-claude-code-session-id` 與 `metadata.user_id` 原樣 | gateway 用 alias、model 和第一則原始訊息（合併相鄰訊息前、拿掉 `cache_control`）產生，同一段對話不變 |
| transport | raw `node:https`，headers 照 client | `fetch`，headers 由 gateway 產生（§3.2） |
| gateway key | `x-agent-gateway-api-key`，錯誤 403 | `x-api-key`、`Authorization: Bearer` 或 `x-agent-gateway-api-key`，錯誤 401 `authentication_error`。驗 key 在讀 body 之前，所以只用 `x-app: cli` 加 `claude-cli/` UA 兩個 header 判斷要套哪一條 |
| 回應 | 上游 status、headers、bytes 原樣 | 2xx 時 SSE bytes 原樣（headers 是 gateway 自己的 SSE headers），`stream:false` 由 gateway 聚合；錯誤由 gateway 組 Anthropic envelope |
| thinking 簽章 | client 送回 | client 送回，不使用 `state.ts` |

### 14.4 驗證狀態

- [v] `test/claude/assembleRequest.test.ts`：組裝層單元測試。拆層前後 `test/claude/normalizeRequest.test.ts` 等既有測試未修改即全部通過。
- [v] `test/claude/nativeMessages.test.ts`：每一條接受或拒絕規則。
- [v] `test/claude/collectMessage.test.ts`：聚合（文字、工具、thinking 簽章覆寫、usage）與事件順序檢查。
- [v] `test/claude/cloakMessages.test.ts`（真的 server，上游是 mock fetch）：上游 body 的 system、metadata、cache marker、betas、thinking 和 UA；SSE 原樣轉回與中途斷線；非串流聚合；帶 thinking block 的續接；401；上游錯誤；官方 Claude Code 請求不走降轉。
- [ ] 未驗證：真實上游（沒有跑 poc）、各家 SDK 實際送出的欄位組合。
