# 上游參考更新與行為對齊報告（2026-10-22）

**結論：三個上游參考 pin 已更新到當時 fetch 的預設分支最新頭（audit cutoff 2026-10-22），並據此實作 Codex `refresh_reason` 與 Claude 兩項支援路徑行為。`npm run typecheck`、`npm test`（878 通過）、`npm run build`、`git diff --check` 全部通過。本報告不宣稱已達最新官方 CLI 的完整對齊，也不產生新的相似度分數；舊有分數與歷史基準一律不變。**

## 1. Submodule pin 新舊對照

audit cutoff：`git fetch` 與 Phase A／A2 稽核完成於 2026-10-22；checkout（detach 到下列新 SHA）同日完成。

| submodule | 舊 pin（HEAD 記錄） | 新 pin（本次） |
|---|---|---|
| `references/codex` | `0d58012ec20d0f42ea1c11056815e4a0c5122e99`（無 release tag，main 血統，2026-10-14T12:07:20Z） | `b4ad33d1a3c10c9652dd57f7afd7a949f8f26895`（`origin/main` 頭，2026-10-22T04:59:19Z） |
| `references/claude-code` | `9b4f0d6ef8ceaf62f6b46babb9a4d84bec541a2e`（= `v2.1.299-1-g9b4f0d6`，2026-10-14T04:30:05Z） | `5ed799e5cc56bea9efff57398ca43e31d82784ff`（= tag **v2.1.308**，2026-10-22T04:34:32Z） |
| `references/CLIProxyAPI` | `5fc580b1d72d87a7bcfe5cfb6f479c1aea5625b3`（= tag **v8.0.29**，2026-10-15T00:00:59+08:00） | `0db19025571684b198a2ef508f99b41c717337e8`（= tag **v8.0.38**，2026-10-21T23:04:23+08:00） |

未動：`references/EasyCLIProxyAPI`、`references/unsloth`、`.gitmodules`。

## 2. 參考分支 vs `DEFAULT_CLIENT_VERSION`：兩種版本來源要分開

- 參考政策（用戶核准）：submodule 取**最新 fetch 的預設分支頭**，不是穩定 release 回退點。
- `references/codex` pin 住的 `b4ad33d1`（main 頭）是 §3.1 Codex 行為的**抄寫來源**（submodule 就固定在這個 SHA），不是只有稽核／參考用途。
- 只有「對外宣告的版本」例外：`DEFAULT_CLIENT_VERSION`（`src/constants.ts`）0.162.1 → **0.163.0** 取自**穩定 release tag `rust-v0.163.0`**（commit `83086188ae0614bd882818ff1aa23f3194962012`，2026-10-15T18:57:07Z；Cargo workspace version 0.163.0，官方 UA／版本 header 用 `CARGO_PKG_VERSION`），不用 main 頭的開發版本。
- 該版本對 backend 模型目錄的實際效果**未 live 驗證**（本批依規定未跑 PoC）。

## 3. 已實作行為與來源錨點

### 3.1 Codex token refresh（`src/auth/authManager.ts`、`src/auth/authFile.ts`）

| 行為 | 說明 |
|---|---|
| `refresh_reason` JSON 欄位 | refresh 的 JSON 請求 body 帶 `proactive_expiry` / `scheduled` / `unauthorized_recovery`；**無 `forced`**（gateway 沒有對應入口），不新增公開 API |
| 大小寫不敏感的 rejection code 分類 | 對齊上游 lowercase 後比對 |
| auth 檔寫入保留未知欄位 | 只覆寫回傳的 token 欄位，`account_id` 與未知 key 原樣保留（既有行為，測試遷移後覆蓋不變） |
| `DEFAULT_CLIENT_VERSION` 0.163.0 | 見 §2 |

錨點（pinned `references/codex` @ `b4ad33d1`）：`codex-rs/login/src/oauth/client.rs` `RefreshReason::as_str`（:55，值 :57-59）；`codex-rs/login/src/auth/manager.rs` `request_chatgpt_token_refresh`（:1695，`TokenEncoding::Json`）、`classify_refresh_token_failure`（:1750）、`proactive_refresh_reason`（:3300）。

### 3.2 Claude 空 user text 清理（Ahn；`src/claude/assembleRequest.ts`）

- 位置：**共享自組裝層**（OpenAI 與 Anthropic 降轉兩種輸入都走這裡），在 `markLastEligibleMessage` 與 caller mid-conversation system 插入**之前**執行一次。組裝順序（指紋來源在上游已由原始輸入算出，清理不會改動它）：

```text
原始輸入（firstUserText／帳單指紋來源，維持不動） ─► user text 清理（Ahn） ─► cache 標記 ─► caller mid-system 插入
```
- 規則：user 陣列 content 中 `text` 非字串或 trim 後為空的 text block 移除；全移除時**恰為** `[{type:"text",text:"(no content)"}]`；非空白 text 逐 byte 保留；image／tool_result 與順序不動；assistant signed 內容、raw relay、count-only、firstUserText／帳單指紋 provenance 皆不觸及。
- 證據：native 2.1.307 `Ahn` @ byte 250597395、`Fu="(no content)"` @ 238571783（靜態唯讀）；CLIProxyAPI `df07b1e59877e255cefef4eda9a246952f05ba11` 及現行符號 `isEmptyClaudeTextBlock` / `claudeContentBlockCanHostCacheControl` / `lastCacheableClaudeMessageContentBlockIndex`（`claude_executor_cloaking.go` 與兩個 translator）。

### 3.3 Claude 上下文耗盡必須失敗（`src/claude/toResponsesEvents.ts`）

- `stop_reason: model_context_window_exceeded` 的 `message_stop` → `response.failed`（`status:"failed"`、`error.code:"context_length_exceeded"`，公開 400 走既有 `fromFailedEvent`），**never** `response.completed`。
- 終端 `response.output` 內 message／function_call 項目 `status:"incomplete"`（無 status 的 reasoning 項目不動）。
- **不**存 replay state、**不**放出 deferred 的 completed tool 事件；仍要求完整 `message_stop`。
- 只改 OpenAI 轉譯層；native Anthropic relay／降轉的 stop_reason 照原樣透傳。
- 證據：CLIProxyAPI `aadb34f9161a7d4f1b5a3e30cd286452206d5188` 及現行符號 `claudeStopReasonContextWindowExceeded` / `claudeResponsesTerminalState` / `claudeResponsesOutputStatus`（`internal/translator/claude/openai/responses/claude_openai-responses_response.go`）；官方文件 handling-stop-reasons；native 2.1.307 schema 列有同一 stop_reason。

## 4. Claude 版本身分澄清（避免誤讀）

- 公開 `references/claude-code` repo 現為 **v2.1.308**；它是公開 repo（完整 CLI 邏輯未公開發布），**不是**執行檔身分來源。
- 補充證據 native **2.1.307**（本機 `/home/scott/.local/share/claude/versions/2.1.307`，SHA256 `6021eb72d20d0682b720bdc63acd2a5cd2270895d1f10d9ca2a88cbfa7b9dd0e`，embedded GIT_SHA `b208bbbc9ae5dc87a1a0a7f964be47e27a0543ab`，BUILD_TIME 2026-10-21T19:40:02Z）**僅作 §3.2／§3.3 選定行為的證據**，全程靜態唯讀，未執行。
- 既存**身分／模型表／UA／salt 基線維持 native 2.1.299 + SDK 0.128.0**（`src/constants.ts`；歷史 binary offset 見 [CLAUDE_UPSTREAM_PROTOCOL_DIFF.md](CLAUDE_UPSTREAM_PROTOCOL_DIFF.md)，全部不動）。

## 5. 對齊分類（明確區分四類）

### 5.1 已核實一致項目（按基準性質區分）

| 行為 | 基準性質 |
|---|---|
| Codex `refresh_reason` 與大小寫不敏感錯誤分類 | 官方原始碼確實程式路徑（§3.1，抄寫來源 @b4ad33d1） |
| Claude Ahn 空 text 清理＋佔位符（wire 規則） | 官方 native binary 確實程式路徑（§3.2，native 2.1.307） |
| Claude 上下文耗盡 → `context_length_exceeded` | **專案自有的 OpenAI 轉譯層**：官方 Claude CLI 不發佈 OpenAI endpoint；此映射由官方文件的截斷語義＋CLIProxyAPI 同向二手實作佐證，**不宣稱**對上官方 OpenAI endpoint 直抄（§3.3） |

### 5.2 保留且已記錄的偏離（有意為之，非本批變更）

- Codex 路徑自報 `agent-gateway` UA／自身身分（不偽裝官方 CLI）。
- Claude 既有 caller system 放置、cache 標記策略、session 綁定、models 查詢等與官方的已記錄差異（見 [CLAUDE_UPSTREAM_PROTOCOL_DIFF.md](CLAUDE_UPSTREAM_PROTOCOL_DIFF.md)、[SIMILARITY_GAPS.md](SIMILARITY_GAPS.md)）。
- gateway 自有 reasoning／tool replay 機制。

### 5.3 未採納（本批明確評估後拒絕）

- **CLIProxyAPI `block_binding` 注入**：官方 native `Emn` @ 250525862 需 `CLAUDE_CODE_POLISHED_DEWDROP`／model flag／feature flag，`Cmn` @ 250526041 控制 beta latch，`Pi` @ 239689003 要求 firstParty + first-party base URL，builder @ 250634000／250648707 僅在 `_O` 有定義且 thinking 為 adaptive/enabled 時才加；runtime flag 值 gateway 端未知。CLIProxyAPI 則按 model/history predicate 注入 `drop_block`——**兩套激活政策不同**，且官方 preserved-thinking 文件描述預設為 error、`drop_block` 會丟棄後續 thinking，與 gateway fail-closed replay 相衝。
- **`between_tools` 與新模型表**：`between_tools` 也見於官方 preserved-thinking 文件（非僅二手證據），但與既存 profile 對應的官方 native 能力／完整 profile 激活證據仍缺席，故不採納，維持既存 profile。

### 5.4 未驗證（明確列為 unknown，不計入任何分數）

- live／TLS／backend 目錄層面：本批用戶禁止真實憑證 E2E 與 PoC，故 0.163.0 的模型目錄效果、TLS 指紋差異、AuthAPI 對 `refresh_reason` 的實際接受度均**未 live 驗證**。**本報告不產生新的相似度分數**。

## 6. Codex provenance 欄位的範圍聲明

送出 `refresh_reason` 與保留未知欄位，**不代表** gateway 支援任意 issuer／client 設定，也**不代表**覆蓋上游新增的 EMA／managed auth 語義（如 main 頭上的 decrypted auth 快取 #56081）。支援的仍限第一方認證範圍：自家 `auth.json`、固定 OAuth client id、單次使用 refresh token 輪換。

## 7. 本批實際驗證

| 檢查 | 結果 |
|---|---|
| `npm run typecheck` | [v] exit 0 |
| `npm test` | [v] 50 files / **878** passed（測試一律使用合成憑證與 mock，不讀真實憑證、不呼叫 provider） |
| `npm run build` | [v] exit 0 |
| `git diff --check` | [v] 乾淨 |
| 變更/新增文件相對連結 | [v] 腳本檢查通過 |

Supervisor 獨立複核（sanitized 臨時 HOME，移除 auth／provider 環境變數，npm config 獨立且為空）：[v] typecheck 0；[v] 全量 50 files / **878** 通過；[v] 排除 `*.tdd.test.ts` 後 47 files / **860** 通過；[v] build 0；[v] 9 個 markdown／223 條相對連結與 anchor 全通過；[v] 五個 submodule 頭與內部乾淨度、`.gitmodules` 未變、暫存區為空。

### 7.1 修改過的既有測試（僅兩處）

- `test/auth/authFile.test.ts`：`shouldRefresh` → `getRefreshReason` 政策斷言遷移；5 分鐘到期界線為**含**（`<=`）、8 天年齡界線為**不含**（`<`）；覆蓋意圖不變。
- `test/config.test.ts`：`DEFAULT_CLIENT_VERSION` 預期 0.162.1 → 0.163.0。

### 7.2 開發用回歸產物（`*.tdd.*`，非交付規格）

| 檔案 | 建議 | 內容 |
|---|---|---|
| `test/auth/authManager.tdd.test.ts` | keep | 涵蓋三個 `refresh_reason` 值帶入 refresh 請求 body 的斷言、5 分鐘到期界線（含相等驗證）、8 天 fallback 路徑（用超過 8 天的 age，未斷言恰等等於 8 天）、大小寫不敏感錯誤分類、auth.json 重寫時新欄位保留 |
| `test/claude/assembleRequest.tdd.test.ts` | keep | Ahn 清理＋佔位符＋marker 落點的回歸護欄 |
| `test/claude/toResponsesEvents.tdd.test.ts` | keep | 上下文耗盡失敗語義（終端、狀態、no-save、no-deferred） |
| `test/fixtures/claude-context-window.tdd.sse` | keep | 僅供上一列使用的合成 SSE fixture |

以上四檔為開發用產物：使用者可自行選擇 keep、rewrite 或 delete（刪除僅使對應行為失去專屬回歸護欄，不影響執行）；表中「建議」欄僅供參考，非待辦事項。

## 8. 來源連結（取用日期 2026-10-22）

- codex main 頭：<https://github.com/openai/codex/commit/b4ad33d1a3c10c9652dd57f7afd7a949f8f26895>
- codex 穩定 tag rust-v0.163.0：<https://github.com/openai/codex/releases/tag/rust-v0.163.0>（commit `83086188ae0614bd882818ff1aa23f3194962012`）
- claude-code v2.1.308：<https://github.com/anthropics/claude-code/commit/5ed799e5cc56bea9efff57398ca43e31d82784ff>
- CLIProxyAPI v8.0.38：<https://github.com/router-for-me/CLIProxyAPI/commit/0db19025571684b198a2ef508f99b41c717337e8>
- CLIProxyAPI 空 text 修正 `df07b1e5`：<https://github.com/router-for-me/CLIProxyAPI/commit/df07b1e59877e255cefef4eda9a246952f05ba11>
- CLIProxyAPI stop reason 修正 `aadb34f9`：<https://github.com/router-for-me/CLIProxyAPI/commit/aadb34f9161a7d4f1b5a3e30cd286452206d5188>
- 官方文件：stop reason <https://platform.claude.com/docs/en/build-with-claude/handling-stop-reasons>；preserved thinking <https://platform.claude.com/docs/en/build-with-claude/preserved-thinking>
- native 2.1.307 binary（本機證據，非 URL）：SHA256/GIT_SHA/BUILD_TIME 見 §4；offset 見 §3。
