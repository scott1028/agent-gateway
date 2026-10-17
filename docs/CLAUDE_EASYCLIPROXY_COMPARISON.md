# Anthropic 串接重新比對：EasyCLIProxyAPI

2026-10-15：以使用者提供的可用實作重新校正。先修正 final-body CCH、四個缺漏的 subscription beta 與 request ID，簡短 PoC 通過後，使用者回報 OpenCode 仍出現 `Third-party apps now draw from your extra usage...`。此次用完整 OpenCode 請求重現 HTTP 400，確認 caller system 的放置方式會觸發拒絕；修正後，**同一請求重播 HTTP 200，真正 OpenCode CLI 文字回覆及 `read` 工具續接均成功**。沿用 `.tmp/.credentials.json`，沒有重新登入。其他模型／功能不能由此推定已驗證。

## 固定參考點

| 來源 | 固定版本／用途 |
|---|---|
| `references/EasyCLIProxyAPI` | `d64dda6c54c8731d145b1ca74e4901802133d1fe`；`core-version.txt` 指定 `8.0.29` |
| `references/CLIProxyAPI` | `5fc580b1d72d87a7bcfe5cfb6f479c1aea5625b3`，tag **v8.0.29**；與上述核心版本吻合 |
| `references/claude-code` | `9b4f0d6ef8ceaf62f6b46babb9a4d84bec541a2e`；公開 repo 的 plugin transport 不是完整 CLI transport |
| 本機原生 Claude Code | `2.1.299`，SHA256 `2d894a4b1bfaaa9aab72aeff7803e3c73bc2510f279a171f6b8f59f72d17d077`；補充檢查 native 邏輯 |

EasyCLIProxyAPI 的 `scripts/portable.mjs` 依 `core-version.txt` 下載 `router-for-me/CLIProxyAPI` release；桌面程式管理核心程序、設定與帳號，真正的 Anthropic HTTP 實作在 CLIProxyAPI。此次未更新任何 submodule。

## 核心實際怎麼串

主要證據：`references/CLIProxyAPI/internal/runtime/executor/claude_executor_stream.go`、`claude_executor_execute.go`、`claude_executor_request.go`、`claude_executor_cloaking.go`、`claude_signing.go`。

| 項目 | CLIProxyAPI v8.0.29 | 本專案目前狀態 |
|---|---|---|
| 推論端點 | `POST https://api.anthropic.com/v1/messages?beta=true`，串流用 `stream:true` | 一致 |
| 訂閱認證 | OAuth access token 放 `Authorization: Bearer`，不帶 `x-api-key` | 一致；直接讀官方 `claudeAiOauth` |
| 基本 headers | `anthropic-version:2023-06-01`、`x-app:cli`、CLI UA、Stainless headers、`Accept:application/json` | 基本形狀一致；保留本機官方 2.1.299 / SDK 0.128.0 版本，沒有降成核心使用的 2.1.280 / 0.112.1 |
| request ID | 第一方上游每次 send 使用新的 `x-client-request-id` UUID | **此次補上**；401 重試換 request ID，conversation session ID 不變 |
| subscription betas | CLI marker、OAuth marker、thinking、context、cache 等有固定順序與條件 | **此次補上** `redact-thinking-2026-02-12`、`thinking-token-count-2026-05-13`、`context-management-2025-06-27`、`prompt-caching-scope-2026-01-05`；CLI marker 排在 OAuth 前 |
| CCH | 最後才將 billing block 的 `cch=00000` 換成 body checksum | **此次修正**；原本錯把 placeholder 當最終值 |
| system | billing + 精確 CLI identity；caller 指令依模型搬到 mid-conversation system 或 user 的 system-reminder，另加入日期 | **此次修正**：支援的模型將完整 caller 指令移到第一個合併 user 回合後的 `role:system`；維持原有 join／cache。legacy 模型保留 top-level system，不降成 user reminder；未加入日期 |
| cache | 配置各區塊標記、限制數量、OAuth 非 helper/subagent 通常升為 `ttl:1h`，搭配 extended-cache beta | gateway 保持官方 default ephemeral、無 TTL；未複製自動升級政策 |
| account identity | 缺資料時查 `/api/oauth/profile`，維護 device ID pool、conversation UUID，部分失敗路徑合成身分 | gateway 用 home 的真實 account UUID / userID；缺 account UUID 仍明確拒絕，不合成帳號身分 |
| 工具／SSE | 請求與 SSE 做雙向翻譯，部分工具會改名，另維護 thinking / tool state | gateway 維持工具原名；真實 SSE、工具呼叫與結果續接已通過。本次工具回合沒有 thinking 區塊，簽章回放仍只有離線覆蓋 |
| transport | 自訂 uTLS、HTTP/1.1 header 大小寫／順序、壓縮協商 | gateway 使用 Node `fetch`，未仿製此 transport，不能宣稱 wire 完全相同 |
| 模型目錄 | 核心 `internal/registry/model_definitions.go` 的 `GetClaudeModels()` 使用內建目錄 | gateway 仍有 `/v1/models` 請求／快取；實測回傳 14 個模型，尚未遇到多頁 |

以上未複製的策略是明確的相似度限制。簡短 PoC 曾漏掉完整 caller system 導致的失敗；目前的結論限於下述完整 OpenCode 測試，不能推廣為所有第三方客戶端、模型與帳號的保證。

## OpenCode 錯誤的重現與修正

以本機 OpenCode `run --standalone` 配合本地假上游擷取**合成診斷對話**，不讀取使用者原本對話內容。請求是 `/v1/chat/completions`，`claude1/claude-sonnet-5`，有約 53 KB 的 system 指令、12 個工具、`stream:true`、`max_completion_tokens:8192`。同一份憑證逐次重播，其他內容保持一致：

| 變因 | 修正前實測 |
|---|---|
| 完整請求 | HTTP 400，與使用者圖片相同的 extra usage 錯誤 |
| 只拿掉 tools | 同樣 HTTP 400 |
| 只拿掉 caller system | completed，`opencode-probe-ok` |
| 只加 `mid-conversation-system-2026-04-07` beta | 同樣 HTTP 400 |
| 保留所有文字與 tools，caller 改放第一個 user 後的 `role:system`，有 beta | completed，`opencode-probe-ok` |
| 相同位置，**不加 beta** | completed，`opencode-probe-ok` |

單獨使用 OpenCode repo 的短版 `anthropic.txt` 也曾成功，不能只憑「有 system」判定一定失敗。這些實驗證明的是**完整請求中的 system 位置是本次可控制的觸發因素**；上游內部的分類條件、帳號計費規則與未來行為沒有由此得到證明。

正式修正依 `references/CLIProxyAPI/.../claude_executor_cloaking.go` 的 `insertClaudeMidConversationSystemBlocks` 放置位置；gateway 已合併連續 user 訊息，因此插在 index 1。指令全文仍是 system 角色，assistant/tool history 不改；cache marker 先依原歷史配置，再插入 caller system，以免改變原有標記位置。保留原有 caller join，可維持最多三個 cache 標記。

重新核對 native Claude Code 2.1.299：`bL` / `cr` / `lS`（`@217933672` / `@217928457` / `@217928265`）排除已知 pre-4.8 模型和 `claude-3-*`，未知模型預設支援。`jR=Wy("mid_conversation_system")`（`@216790474` 附近）、`Wy`（`@216789062`）的 `header:null`，以及 `wL`（`@217936548` 附近）明確略過已 GA 的舊 beta。因此保留此新版官方行為，**不照搬 CPA 2.1.280 profile 的舊 beta**。遠端 capability override／組織 policy gate 未實作。

明確偏離：不支援對話中 system 的 legacy 模型仍使用 top-level system，未複製 CPA 的 user `system-reminder` 降階策略；這保留原有指令權限，但**不代表 legacy 模型也已修復本次拒絕**，尚未實測。工具別名、日期注入、TLS 模擬沒有加入，因這次已驗證的修正不需要它們。

修正後 `node .tmp/claude-opencode-smoke.mjs` 啟動獨立測試 gateway，依次驗證：完整擷取請求的 HTTP SSE 回覆、真正 OpenCode 文字回覆、真正 OpenCode `read package.json` 與工具結果續接。三項皆通過，結果保存在 `.tmp/claude-opencode-smoke-results.json`，測試 server 已關閉。測試直連 gateway；使用者原本的 agent-switch 中介與既有會話尚未端到端重測。原本 8765 的 gateway 在這次 build 前啟動，需重新啟動才會載入修正。

## CCH 更正與驗證

`claude_signing.go` 的 `signAnthropicMessagesBody`：先將 **system 第一個 billing block** 的 CCH 歸零，再對 hash view 算 seeded XXH64，取低 20 bits、補成五位小寫 hex，最後只改 billing 的五個字元。

- seed：`0x4d659218e32a3268`。
- hash view 保留 JSON 欄位順序；各層字串 `model` 值清空，各層 `max_tokens`、`fallbacks`、`fallback_credit_token` 排除。
- native 的特殊情況：物件尾端連續多個排除欄位，hash view 保留前面的逗號。這是 checksum 規則，不會把無效 JSON 送到上游。
- 本專案只處理由 `JSON.stringify` 產生的 body，因此可從該 serialization 的副本建立 hash view，無須導入核心的任意原始 JSON scanner。
- 完成所有 request shaping 後才簽；原始 request／thinking state 不修改；401 retry 重用相同已簽 body。
- 使用 `xxhash-wasm@1.1.0`，初始化共用一次；API 依套件的[作者文件](https://github.com/jungomi/xxhash-wasm#api)核對。

舊報告只搜尋內嵌 JavaScript，因未找到 CCH rewrite 而宣稱它是固定值，這個結論不成立。本次在原生 2.1.299 執行檔的 machine-code 區 `0x3b012c9` 找到相同 little-endian seed；JavaScript builder 的 placeholder 不能代表最終 wire body。算法以 **CLIProxyAPI v8.0.29 的獨立 native vectors** 驗證，未宣稱已逐指令證明 2.1.299 的所有 native 正規化分支。

新增 beta 的條件重新核對 native `SL @217935458` 與常數 `@216789651` 附近：thinking/context 依現有模型能力；redact 只在 gateway 預設互動 `cli` profile 啟用；prompt-caching-scope 用於第一方。保留 2.1.299 的 legacy/Haiku gate，並未不加區分照搬核心所有模型的 beta。mid-conversation system 已採新版 GA 形狀；inline tools、TTL 等功能仍未實作。

## 原本 account credential 能否沿用

**Token 可以沿用；本專案已原生接受 Claude Code 格式，不必先轉成 CLIProxyAPI JSON。** 但圖片只列出三個 token 欄位，尚不足以提供 gateway thinking 回放所需的 account 身分。

| Claude Code | CLIProxyAPI auth JSON | 說明 |
|---|---|---|
| `claudeAiOauth.accessToken` | `access_token` | 同一 OAuth access token，可原值沿用 |
| `claudeAiOauth.refreshToken` | `refresh_token` | 同一 refresh token；不可將副本當作兩個互不協調的登入使用 |
| `claudeAiOauth.expiresAt` | `expired` | 毫秒 Unix timestamp → UTC RFC3339，例如 `new Date(expiresAt).toISOString()`；缺失／null 不可誤轉成 1970 |
| provider 已由 home 決定 | `type:"claude"` | CLIProxyAPI 用來辨識 provider 的本地欄位，不是上游 Messages 必填欄位 |
| `.claude.json` 的 `oauthAccount.emailAddress`，或 OAuth/profile 回應 | `email` | 不是 Messages 認證依據；**不能假設 access token 是 JWT** |
| `.claude.json` 的 `oauthAccount.accountUuid` | `account_uuid` | gateway 要求真實帳號 UUID 做 state 隔離 |
| `.claude.json` 的 `userID` | 核心管理的 device ID pool | 兩者採用不同保存方式；不能把 email 當 device/account UUID |

核心 `isClaudeOAuthToken` 判斷 `sk-ant-oat`，`anthropic_auth.go` 從 token exchange 的 `account.email_address` 或 `GET https://api.anthropic.com/api/oauth/profile` 的 `account.email` / `account.uuid` 取得身分。`token.go` 雖有 `id_token` 欄位，並不代表 Claude access token 可以像 Codex JWT 一樣解 email。

對已登入的自訂 home，可直接使用：

```bash
npm run build
npm start -- --claude-home /absolute/path/to/existing-claude-home
```

目前需該目錄的 `.credentials.json`，以及 `.config.json` 或 `.claude.json` 中的 `oauthAccount.accountUuid`。`userID` 有則轉送；`settings.json` 可沿用。只有從圖片複製出的 token JSON、缺 account 設定時，仍會回 `claude_account_required`。gateway **沒有新增 CLIProxyAPI snake_case 匯入器或 profile 自動補抓**，避免把「評估能否沿用」擴張成另一套帳號管理。

共用同一原始 home 時，既有官方 refresh lock、每次重讀與 compare-and-swap 邏輯會協調輪替；複製到另一個 home 或另存成 CLIProxyAPI credential，則不共用這把鎖，refresh token 更新也不會自動同步。這是「直接沿用」與「複製匯入」的重要差別。

另有範圍限制：預設 `~/.claude` 的 global config 可能是外層 `~/.claude.json`；目前 metadata reader 僅讀指定 home 內的兩個檔名。此處的直接沿用範例以已具備完整 account metadata 的自訂 home 為準，不宣稱任意 default-home／Keychain 情境都已支援。

## 驗證狀態

- [v] 修改前相關測試：331 項通過；無法據此證明線上可用。
- [v] CCH RED：18 項 wire assertions 在舊實作失敗；修正後 native 固定向量、內容保留、401 重試與 opt-out 通過。
- [v] beta / request ID RED：新測試證明舊請求缺漏；修正後通過。
- [v] 全專案 `npm run typecheck`、`npm test`（493 tests / 30 files）、`npm run build` 與 `git diff --check` 通過；未定義其他 lint／pre-commit 指令。
- [v] system placement RED：7 個 assertion 在舊實作失敗；修正後 24 項含模型 gate、指令全文／角色保留、合併 user、多回合位置、signed tool replay 與 opt-out 通過。
- [v] OpenCode 完整請求修正前 HTTP 400；改變 caller system 位置後通過。修正後真正 OpenCode CLI 文字與 read 工具續接皆 exit 0，沒有 error 事件。
- [v] 真實 OAuth refresh：沿用 `.tmp/.credentials.json` 的 refresh token，刷新成功並寫回同一檔案，權限 `0600`。
- [v] 真實 profile：`GET /api/oauth/profile` HTTP 200，證實可以由現有 access token 取得 account UUID 與 email。臨時準備程式 `.tmp/claude-live-setup.ts` 只保存真實 account UUID 與新測試 home 的隨機 64-hex device ID 到 `.tmp/.claude.json`（`0600`），不輸出 token／email／UUID。
- [v] `npm run poc:claude -- --claude-home /home/scott/workspace/agent-gateway/.tmp`：exit 0；模型清單 14 個，`claude-sonnet-5` 文字 `gateway-ok`、`get_utc_time` 工具呼叫、結果續接、下一回合 `second-turn-ok` 全部 completed。結果保存在 `.tmp/claude-poc-results.json`。
- [v] `node .tmp/claude-http-smoke.mjs`：啟動建置後的 `dist/index.js`，以 CLI 指定上述 home 與預設模型，透過真實 HTTP 呼叫 `/v1/responses`、`/v1/chat/completions`，皆 HTTP 200 且回傳預期文字；結果保存在 `.tmp/claude-http-smoke-results.json`，測完已關閉測試 server。
- [ ] 真實 thinking 簽章回放：此次雖送 adaptive thinking，工具回合未回傳 thinking/redacted_thinking，`isThinkingReplayed:false`；不能把工具續接成功當成簽章回放的實測證據。
- [ ] JSON Schema、其他模型推論、多頁模型清單、cache hit、refresh 競爭／CAS、限流：未實測。

現在可直接啟動已準備好的測試 home：

```bash
npm start -- --claude-home "$PWD/.tmp" --model claude1/claude-sonnet-5
```

本次不需要重新登入；補齊 account metadata 是臨時測試準備，不是 gateway 新增了自動 profile bootstrap 功能。上述測試確實呼叫上游並消耗少量推論額度。

新增測試：`test/claude/signing.tdd.test.ts`、`test/claude/protocol.tdd.test.ts`、`test/claude/systemPlacement.tdd.test.ts`。更新既有測試：`test/claude/normalizeRequest.test.ts`、`test/claude/endToEnd.test.ts`。

後續審查確認原本未追蹤的 attribution／Stainless 測試補足 30 項協定邊界，正式納入為 `test/claude/attribution.test.ts`（23 項）與 `test/claude/stainlessHeaders.test.ts`（7 項）。調整檔名、來源註解及快取案例標題，斷言保持不變。上述 493 項驗證原本就包含這 30 項；納入後，Git 追蹤的測試集合可重現完整數量。
