# agent-gateway 與 Unsloth：ChatGPT Codex backend 通訊差異報告

## 1. 結論

**核心通訊模式相似，但 agent-gateway 並不是 Unsloth 的等價實作；部分行為反而更接近本機較新版官方 Codex。**

共同點是 ChatGPT OAuth、相同的 `/backend-api/codex/responses` 與 `/models`、上游 `stream=true`／`store=false`、完整對話回送、encrypted reasoning include，以及 HTTP 401 後嘗試恢復憑證。

與你的目的最相關的差異：

1. **兩者都可明確識別為自己的 client。** proxy 的 User-Agent 含 `agent-gateway`、OS/kernel/architecture；Unsloth 直接宣告 `unsloth_studio`、`unsloth-studio/1`，還有 Studio instructions 與 `msg_unsloth_*` message ID。因此 Unsloth 不是「隱藏非官方 client」的基準。
2. **proxy 的 caller-controlled 出站面較寬。** `/v1/responses` 只做頂層 allowlist，不清理允許欄位內的任意額外資料；caller 的 `prompt_cache_key` 及 `x-codex-turn-state` 亦可原樣出站。不能把頂層移除 `metadata` 解讀成完整的資訊清理。
3. **session/cache 分群不相同。** proxy 預設根據對話開頭內容雜湊，Unsloth 根據 provider/account/thread；相同開場的不同對話在 proxy 可能得到同一 session。這是可關聯性差異，不是已證實的對話內容串線。
4. **多輪資訊保留不相同。** proxy 的 Chat Completions 路徑丟棄 encrypted reasoning；Unsloth 有回傳／回放機制。proxy 的 Responses 路徑則可保留原始 reasoning items。
5. **Lite、token cap、工具正規化與 transport policy 有實質差異。** 特別是 proxy 會送出 Unsloth 刻意不送的 `max_output_tokens`，以及 proxy 預設允許 HTTP redirects，而 Unsloth 明確拒絕。

**本次未發現預設啟動路徑會額外枚舉並上傳本機環境變數／專案檔案、上傳整份登入檔，或轉送 caller 的 Authorization/Cookie。** 這個結論限於已審查的原始碼：prompt、工具 schema／結果、圖片 URL／內容，以及允許欄位中的資料，本來就會送到 provider。Unsloth 開啟 Studio tool loop 時，還可能主動加入 RAG／skill／工具結果。

**無法由原始碼比對或離線測試保證「provider 不會發現非官方 client／逆向工程」。** 沒有觀測 provider 偵測規則、真實 wire 封包、TLS 指紋或帳號處置，也沒有驗證使用條款合規性。

## 2. 基線、範圍與證據

| 基線 | 固定版本 |
|---|---|
| agent-gateway | `91c7d185d79447fbfc1d48c4fb2ba0e65be78474` |
| 本機 Unsloth（使用者指定版本，不代表 upstream main） | `9706a2b22ea5aa551df5c06f80e0fc372f3de977` |
| 本機官方 Codex CLI（§4.1 三方比較；其餘僅校驗爭議差異） | `cc7ba33601286a751477832b01de7b6f8de0dd9c` |
| proxy runtime | Node.js `v22.22.3`，內建 Undici `6.24.1` |

> 更名說明：本專案已更名，UA 尾碼同步改為 `agent-gateway`。本報告全文改用現名，文中 UA 字串顯示的是更名後現況；上表固定 commit 為更名前快照，當時的專案名稱與 UA 尾碼皆非現行字串，勿將新字串歸因於該 commit。

> 重評說明：§4.1.1 已改對 pinned references 重評（2026-10-17），固定版本見該節；上表與 §4.1 主表的值仍是舊快照。

範圍包含 proxy 的兩個 inference endpoint、model catalog、refresh，以及 Unsloth Studio 的 Codex transport／實際呼叫端。§4.1 另比對官方 Codex CLI 的 endpoint／headers，並註明 HTTP／WebSocket 差異；不是 frontend review，也不是完整官方 Codex／WebSocket 審查。

- **靜態確認**：production code 可直接確定送出／省略的欄位或控制流程。
- **測試確認**：既有 mock／fixture tests 通過；不代表真實上游接受該行為。
- **條件式風險**：已確認的機制，在指定 caller 資料或上游回應下有風險；不是已觀測事件。
- **未實測**：provider 行為、真實 wire／TLS／HTTP 指紋、實際 cache 命中率。

下文 `[v]` 表示該審查項目已確認或已記錄範圍限制，**不表示程式已修正**。依要求，本報告不包含修正計畫。

## 3. 互動流程與責任邊界

### agent-gateway：caller 擁有對話與本機工具執行

```text
Time ───────────────────────────────────────────────────────────────────►
角色          | 準備                     | 第 1 輪            | 第 2 輪
--------------|--------------------------|--------------------|---------------------
Caller        | 完整對話／工具 schema     | 接收 tool_calls     | 執行工具，回送 history
agent-gateway   | 轉換／Lite／cache ID       | POST、轉送或轉換 SSE | 再送完整 input
Auth server   | 必要時 refresh            | HTTP 401 可再 refresh| 必要時 refresh
Codex backend |                          | 生成內容／工具呼叫   | 讀取 history／結果
```

proxy 不執行 caller 的工具。Responses streaming 原樣轉送；Chat Completions streaming 轉成 OpenAI chat chunks。

### Unsloth：可由 Studio 自己執行工具並續接

```text
Time ───────────────────────────────────────────────────────────────────►
角色          | 準備                     | 第 1 輪            | 第 2 輪
--------------|--------------------------|--------------------|---------------------
Caller／UI    | 對話、thread、tool policy | 顯示內容／批准工具   | 接收最終回應
Studio        | 模型／帳號檢查、日期等    | 接收 SSE            | 整理 history
Tool loop*    | schema／skill／RAG        | 本機執行／拒絕工具   | 加入結果／reasoning
Codex client  | instructions／affinity   | POST、轉 chat SSE    | 再送完整 input
Auth server   | resolve／refresh          | 必要時 refresh      | 必要時 refresh
Codex backend |                          | 生成內容／工具呼叫   | 讀取 history／結果
```

`*` 僅在 Studio tool loop 啟用時；未啟用時可把 caller 的工具呼叫交回 caller。這是產品責任差異，不是 transport 異常。[^P-handlers] [^U-route] [^U-loop]

## 4. 逐欄對照

### 4.1 Endpoint 與 headers

以下為原始碼明確設定／準備的 headers；不把 library 自動產生的 headers 當成已擷取 wire 封包。官方欄以 §2 固定版本、**ChatGPT OAuth 登入＋內建 OpenAI provider、未自訂 endpoint／headers** 為基準，不混入 API-key 模式的 `api.openai.com/v1`。主表的 session／thread／Lite／turn-state 描述 **HTTP Responses**；Models 的差異另列，不能解讀為 Models 也送出這些 Responses 專用 headers。

| 項目 | agent-gateway | Unsloth | 官方 Codex CLI | 判讀 |
|---|---|---|---|---|
| Responses URL | `https://chatgpt.com/backend-api/codex/responses` | 相同 | 相同 HTTP endpoint；另支援同路徑 WebSocket | HTTP 目的地相同，transport 不完全相同 |
| Models URL | `/backend-api/codex/models?client_version=…` | 相同 endpoint/query | 相同預設 endpoint/query | 相同用途；官方另可設定 catalog URL |
| Authorization | saved Codex access token，Bearer | OAuth bundle access token，Bearer | 登入 auth 的 access token，Bearer | 此基準皆非 inference caller 的 API key |
| `chatgpt-account-id` | saved `tokens.account_id` 優先，否則解讀 **id_token**；可以省略 | 從 **access_token** 解讀並驗證非空 account ID | saved auth 的 `token_data.account_id`；有值且可作 header 才加入 | proxy／官方使用已保存的 account ID；Unsloth 的 claim 來源／驗證不同 |
| `originator` | `codex_cli_rs` | `unsloth_studio` | 互動式入口初始化 `codex-tui`，`codex exec` 初始化 `codex_exec`；底層 fallback 為 `codex_cli_rs` | 官方亦非所有入口都固定 `codex_cli_rs`；override 見下文 |
| User-Agent | `codex_cli_rs/<version> (<os.type> <os.release>; <os.arch>) agent-gateway` | `unsloth-studio/1` | `<process-originator>/<build-version> (<os_info type> <OS version>; <architecture>) <terminal-token>`，可加 client suffix | 官方也送 OS／arch／終端識別；不等於 proxy 的 Node/kernel 字串 |
| `version` header | 預設 `0.162.1`，可由 `CODEX_CLIENT_VERSION` 改變 | Responses/models 的 header 均未明設 | 內建 provider 設 `CARGO_PKG_VERSION`（實際 build version） | 不可把 proxy 預設版本當成官方 build version |
| models `client_version` query | 同上，預設 `0.162.1` | 固定 `0.156.0` | build 的 `major.minor.patch`，移除 prerelease 部分 | 可能取得不同模型目錄；官方 query 不一定與完整 `version` header 字串相同 |
| `OpenAI-Beta` | 未明設 | Responses：`responses=experimental` | HTTP Responses 未明設；WebSocket handshake 另有值，見下文 | 不應把 Unsloth 的 experimental 值當成官方 HTTP 的必需 header |
| Responses Accept／Content-Type | `text/event-stream`／`application/json` | 相同 | HTTP：相同；Content-Type 由 JSON request preparation 加入 | HTTP 語意相同，非 byte-for-byte wire 保證 |
| Models Accept | 未明設 | `application/json` | 此 ModelsClient 路徑未明設 | runtime 自動值未擷取 |
| `session-id` | session/cache ID | affinity，48 hex chars | 由 metadata session／cache affinity 決定；root 可受 prompt-cache-key override 影響，non-root agent 保留 metadata session ID | 官方 session 與 thread 不保證同值；proxy／Unsloth 演算法見下一節 |
| `thread-id` | 同 session ID | 未明設 | metadata 的 thread ID | proxy 合併兩種識別；官方可分開 |
| `x-client-request-id` | 同 session ID，跨輪可重用 | affinity + `time_ns` 的 SHA-256 前 32 hex chars | thread ID，亦可跨輪重用 | proxy 的重用本身不偏離官方；Unsloth 每次 invocation 生成，retry 仍重用 |
| Lite header | metadata 指定 Lite 時送 `x-openai-internal-codex-responses-lite: true` | 沒有該分支 | HTTP：model 的 `use_responses_lite=true` 時送同名 header／值 | proxy 與官方有此模型分支；WebSocket 的放置位置不同 |
| `x-codex-turn-state` | 只轉發 caller 同名 header | 未明設，也未保留上游 turn-state | 擷取上游回應的 state，同一 turn 的後續 HTTP request 可帶回 | 官方自行維護 sticky state；proxy 不自行維護 |
| `x-openai-fedramp` | id_token claim 為 true 時送 `true` | 未明設 | saved ChatGPT auth 的 id_token FedRAMP claim 為 true 時送 `true` | proxy／官方皆有帳號條件分支 |

證據：[^P-headers] [^P-transport] [^P-auth] [^U-constants] [^U-request] [^U-models] [^C-headers] [^C-cli-provider] [^C-cli-identity] [^C-cli-auth-headers] [^C-cli-models] [^C-cli-http] [^C-cli-session] [^C-cli-ws]

**官方額外 headers／條件分支：**以下亦屬這份 checkout 的明確實作；proxy／Unsloth 的對應 request builder 均未明設。它們不是所有官方 request 都會帶，也不是已證實的 provider 最低必需 header 集合。

| Header | 官方 Codex CLI 的條件／內容 |
|---|---|
| `x-codex-beta-features` | session 有非空、可作 header 的 beta-feature 字串時加入 |
| `x-codex-window-id`／`x-codex-turn-metadata` | 前者取 metadata 的 window ID；後者在有 turn/request-kind metadata 且能編碼時送 JSON compatibility projection，header 版本不含 tool inventory |
| `x-codex-parent-thread-id`／`x-openai-subagent` | 有 parent／subagent 資訊時加入；HTTP endpoint 亦可依 session source 加入 subagent header |
| `x-openai-memgen-request: true` | memory-consolidation internal session 分支 |
| `x-oai-attestation` | 啟用 attestation、存在 attestation provider 且成功生成 header 時加入 |
| `x-openai-internal-codex-residency: us` | managed residency requirement 為 US 時加入 |
| `OpenAI-Organization`／`OpenAI-Project` | 對應 `OPENAI_ORGANIZATION`／`OPENAI_PROJECT` 環境值非空且可作 header 時加入；不是枚舉／上傳整份環境 |
| `Content-Encoding: zstd` | HTTP request compression 啟用、auth 使用 Codex backend、provider 為 OpenAI 時壓縮 request body |

證據：[^C-cli-provider] [^C-cli-http] [^C-cli-metadata]

**入口／override 與 UA：**互動式 TUI／exec 的 app-server initialize 會用 client name 設定 process originator，並可把 `<client-name>; <client-version>` 作為 UA 的括號 suffix；`CODEX_INTERNAL_ORIGINATOR_OVERRIDE` 可覆蓋 process 值。Responses 的 thread-scoped originator 另可能採用既存／繼承的 thread 身分或特定 service-name 映射，故其 header 不保證等於 process UA 的 prefix。終端 token 由 terminal detection 取得，例如終端名稱／版本或 `TERM`；這是有限的環境識別資訊，不能等同上傳所有環境變數。[^C-cli-identity] [^C-headers]

**WebSocket 不是 HTTP header 集合的直接複製：**官方在 provider／執行條件允許時可優先使用 Responses WebSocket，亦有 HTTP fallback。handshake 明設 `OpenAI-Beta: responses_websockets=2026-02-06`，並可按條件加入 `x-codex-routing-hint`、`x-responsesapi-include-timing-metrics: true`。Lite 則在 request frame 的 `client_metadata` 放 `ws_request_header_x_openai_internal_codex_responses_lite: "true"`，不是上述 HTTP Lite header。另，`x-codex-installation-id` 在本版是 `client_metadata` 的 key，不能只看名稱就當成獨立 HTTP header。這裡僅校驗與本表相關的 assembly，不是完整 WebSocket／wire 審查。[^C-cli-ws] [^C-cli-metadata]

**判讀：**proxy 的 version／FedRAMP／Lite／thread/request-ID 分支比 Unsloth 更接近這份官方實作，但身份字串、session 規則、turn-state 維護與額外 metadata 仍不同。**不能因 request ID 與 Unsloth 不同就判定 provider 去重錯誤；也不能因部分 headers 接近官方就保證不會被識別為非官方 client。**

### 4.1.1 官方基準相似度分數（依 §4.1 推算）

2026-10-17 重評：以 §4.1 主表 17 列為題目（題目不變）、官方 Codex CLI 為 100，套用 [Claude provider 相似度報告](ANTHROPIC_CLAUDE_CODE_PROVIDER_SIMILARITY.md) §2 的標記規則：`1` 符合官方、`0` 已知不同、`?` 證據不足；不給半分，每列只評該列描述的形狀。本節已改對 pinned references，重新開啟原始碼逐列判定。

| 基線 | 本節固定版本 | 前版 |
|---|---|---|
| 官方 Codex CLI | `references/codex` `0d58012`（比前版多 101 個 commit） | `cc7ba33` |
| agent-gateway | `dfb0d6c` | `91c7d18` |
| Unsloth | `references/unsloth` `1fdcdb5` | `9706a2b`（不在 `references/unsloth` 的歷史中，無法重新開啟） |

證據路徑：官方相對於 `references/codex/codex-rs/`；gateway 為 repo 內的 `src/`；Unsloth 的 `U` 代表 `studio/backend/core/inference/openai_codex_client.py`，`UA` 代表同目錄的 `openai_codex_auth.py`。

| # | 項目 | 官方規則（基準；`0d58012` 證據） | gateway（`dfb0d6c`） | Unsloth（`1fdcdb5`） | gateway | Unsloth |
|---:|---|---|---|---|:-:|:-:|
| 1 | Responses URL | HTTP `…/codex/responses`：`model-provider-info/src/lib.rs:80`、`codex-api/src/endpoint/responses.rs:67,106` | `src/upstream/codexClient.ts:59` | `U:204` | 1 | 1 |
| 2 | Models URL | `…/models?client_version=`：`codex-api/src/endpoint/models.rs:37-42` | `codexClient.ts:80` | `U:413` | 1 | 1 |
| 3 | Authorization | Bearer：`model-provider/src/bearer_auth_provider.rs:33-37`（ChatGPT auth 走這裡，見 `model-provider/src/auth.rs:316-323`） | `src/upstream/headers.ts:20` | `U:886` | 1 | 1 |
| 4 | `chatgpt-account-id` | 已保存的 account id，有值才送：`bearer_auth_provider.rs:38-42` | `headers.ts:25` | 從 access_token 解出並要求非空：`UA:193-208,229` | 1 | 0 |
| 5 | `originator` | TUI `codex-tui`（`tui/src/lib.rs:512`）、exec `codex_exec`（`exec/src/lib.rs:263`），fallback `codex_cli_rs`（`login/src/auth/default_client.rs:42`） | 固定 `codex_cli_rs`：`src/constants.ts:4` | `unsloth_studio`：`UA:42` | 0 | 0 |
| 6 | User-Agent | UA 格式：`default_client.rs:154-171` | 結尾 `agent-gateway`：`headers.ts:8` | 固定 `unsloth-studio/1`：`UA:46` | 0 | 0 |
| 7 | `version` header | 送 `version` header（`CARGO_PKG_VERSION`）：`model-provider-info/src/lib.rs:539-541` | `headers.ts:23`（`0.162.1`） | 沒送 | 1 | 0 |
| 8 | models `client_version` | `client_version` 為 major.minor.patch：`models-manager/src/lib.rs:19-25` | `0.162.1` | `0.162.1`（`UA:49`；`9706a2b` 時是 `0.156.0`） | 1 | 1 |
| 9 | `OpenAI-Beta`（HTTP） | HTTP 不送 `OpenAI-Beta`：`core/src/client.rs:2466-2484`；只有 WebSocket 握手才送，見 `client.rs:1409-1412` | 沒送 | `responses=experimental`：`U:890` | 1 | 0 |
| 10 | Responses Accept／Content-Type | Accept 用 event-stream：`responses.rs:144-145` | `codexClient.ts:70` | `U:891` | 1 | 1 |
| 11 | Models Accept | Models 不明設 Accept：`models.rs` | 不明設 | `application/json`：`U:405` | 1 | 0 |
| 12 | `session-id` | `session-id`：`codex-api/src/requests/headers.rs:7-9` | `headers.ts:28` | `U:893` | 1 | 1 |
| 13 | `thread-id` | `thread-id`：`requests/headers.rs:10-12` | `headers.ts:29` | 沒送 | 1 | 0 |
| 14 | `x-client-request-id` | `x-client-request-id` 用 thread id：`responses.rs:88` | `headers.ts:30` | 每次呼叫重新雜湊：`U:884,894` | 1 | 0 |
| 15 | Lite header | Lite header：`client.rs:2486-2490` | `headers.ts:32` | 沒有 | 1 | 0 |
| 16 | `x-codex-turn-state` | 自己擷取上游的 turn-state 再帶回：`client.rs:2477-2482`、`codex-api/src/sse/responses.rs:33` | 只轉發 caller 送來的值：`headers.ts:33` | 沒有 | 0 | 0 |
| 17 | `x-openai-fedramp` | FedRAMP：`bearer_auth_provider.rs:43-45` | `headers.ts:26` | 沒有 | 1 | 0 |
| | **合計** | 官方 = 100 | | | **14／17 = 82.35** | **6／17 = 35.29** |

- 合計與上一版相同；17 列皆可判定，沒有 `?`。每列的判定範圍也與上一版相同：第 7 列只評有送版本 header；第 8 列只評格式，兩者都是固定值，不隨 build 變動；第 12 列只評有送且穩定，演算法差異見 §4.2；第 1 列見下方註記 1。
- 本分數只涵蓋 §4.1 的 endpoint／header 主表，不含 §4.2 之後的 session 演算法、payload、SSE 與 retry；不能與 Claude 報告的 30 項六組分數直接比較。
- 官方另有 8 列條件式 headers（上方「官方額外 headers」表），gateway 與 Unsloth 都沒送。若把它們全記為 `0`，最嚴格算法為 gateway 14／25 = 56、Unsloth 6／25 = 24。其中 subagent、memgen 等分支不會出現在一般路徑，因此主分數未計入。在 `0d58012` 沒有找到新的 HTTP header：`x-client-policy` 只出現在 `login/src/oauth/client_tests.rs`；`x-openai-actor-authorization` 只在 `!requires_openai_auth` 時才用，不在 ChatGPT OAuth 路徑上，所以最嚴格算法維持不變。
- 固定版本見本節開頭的表；更新 submodule 或修改上游 header 後，需重新逐列判定。
- **官方 Codex 原樣轉送（`/backend-api/codex/*`，2026-10-18 另計）：17／17 = 100。** 基準是 client 實際使用的 Codex CLI 0.163.0。17 列的 header 全由官方 client 自己送出，gateway 只把 `authorization` 換成同帳號 home 的 token；第 16 列 turn-state 由 client 自己維護；最嚴格算法的 8 個條件式 header 也由 client 依條件決定。100 沒有涵蓋：TLS 與 HTTP 實作不同（Node `https` 對 reqwest、tungstenite）；token 是同帳號的另一份憑證；`host`、`content-length` 是這段連線的值。分數不代表行為完全等同官方。轉送做法見 [Codex WebSocket 傳輸](CODEX_WEBSOCKET_TRANSPORT.md) 第 11 節。

**2026-10-17 重評註記：**

1. **官方預設走 WebSocket**：ChatGPT backend 預設 `supports_websockets: true`（`model-provider-info/src/lib.rs:561`）。增量傳送是有條件的：只有請求屬性不變（`core/src/client.rs:410-460`），而且新 input 延伸自「上一輪 input + output」（`client.rs:1500-1531`），兩者同時成立時才只送增量 input 並帶 `previous_response_id`；首次請求或條件不成立時，同一條連線仍會送完整 input、不帶 id（`client.rs:2117,2137-2157`）。HTTP 是退路：426 或重試用完時才改走（`client.rs:1620-1625`、`core/src/responses_retry.rs:120-135`）。gateway 的 OpenAI 相容路徑只走 HTTP，第 1 列只評 HTTP 目的地。2026-10-18 補充：官方預設的 WS 增量傳輸已透過 1A 轉送路徑支援：官方 Codex CLI 直接連 gateway 時（`/backend-api/codex/*`），HTTP 與 WebSocket 都原樣轉送，見 [Codex WebSocket 傳輸](CODEX_WEBSOCKET_TRANSPORT.md) 第 11 節。17 列的 82.35／35.29 只評 gateway 自己的 HTTP 路徑；轉送路徑的上游收到的是官方 client 自己的請求，另計 17／17 = 100（見上方合計說明的最後一點）。
2. **`previous_response_id` 是 gateway 本機的功能**：上游仍是 `store:false` 加完整 input，不帶這個 id（`test/responses/previousResponse.test.ts:80-96`）。cache key、session headers 和 input prefix 跨輪穩定（`previousResponse.test.ts:168-192`）。
3. **401 重送前的 auth owner guard（只用在 `previous_response_id` 續接）**：gateway 只在用 `previous_response_id` 續接已保存的 response 時檢查登入身分（`src/responses/responseStore.ts:74-77`）：每次實際送出前（包含 401 恢復後的重送）確認身分沒換，換了就不重送 history。一般的完整 history 請求不檢查，401 恢復後換成新身分時，會照常用新身分重送；這和官方前景 HTTP 的行為相同，`expected_auth_owner` 傳 `None`（`core/src/client.rs:2402-2404`）。官方的對應做法是：HTTP 的 expected-owner guard（`client.rs:1787-1791`）只用在背景 compaction（`core/src/compact_remote_v2.rs:308`）；WebSocket 在 auth owner 改變時，丟棄增量狀態和 turn-state（`client.rs:1688-1695`；模組說明 `:14-15`）。gateway 的檢查是參考這些做法的類比，屬於 §6 的範圍，不是 header 列。
4. **§4.1 主表與 §2 基準表的值仍是舊快照**：例如 Unsloth 的 `0.156.0`、gateway `91c7d18`。這次只更新 §4.1.1，並在 §2 註明 §4.1.1 已改對 pinned references 重評；沒有重寫整份文件。

### 4.2 Session/cache 演算法

| 項目 | agent-gateway | Unsloth |
|---|---|---|
| seed | JSON `[model, instructions, 首個 developer 文字, 首個 user 文字]` | `provider_id + NUL + account_id + NUL + conversation_id` |
| conversation ID | 不用 caller 的 thread/session header 生成 seed | caller `thread_id`；沒有就隨機 `token_urlsafe(24)` |
| hash/output | SHA-256 前 128 bits，格式化成 UUID-like 字串 | SHA-256 前 192 bits，48 hex chars |
| caller cache key | 非空 `prompt_cache_key` **直接採用** | 由程式生成 affinity，無此直接 passthrough |
| 放置位置 | body cache key + session/thread/request-ID headers | body cache key + session header；request ID 另生成 |
| 納入 account/provider | 不納入 | 納入 |
| 納入圖片／工具 schema | 預設 seed 不納入 | seed 也不直接納入；以 thread 區隔 |

[v] **中：跨邏輯對話的可關聯性不同。** 相同 model／instructions／首則文字會產生同一 proxy ID，即使後續內容、工具或圖片不同；這是 seed 相同，不是 SHA-256 碰撞。Unsloth 使用相同 thread 時穩定，沒有 thread 時則每次新 affinity。不能因此聲稱 backend 會合併對話、串出其他使用者內容或必定命中 cache。[^P-normalize] [^U-request]

[v] **中：caller 的 cache key 可成為原樣送出的識別資料。** 若 caller 放入 email、專案名稱或其他可作合法 HTTP header 的字串，proxy 會在四個位置送出它，並非只用於內部快取。Unsloth 的 affinity 會雜湊本機識別碼，而非把原碼直接送出。雜湊也不等於匿名保證。

另：README 的「client 有給 session-id 就用」不應解讀為 HTTP `session-id` passthrough；目前 handler 只讀 `x-codex-turn-state`，session ID 取自 body `prompt_cache_key` 或上述 seed。[^P-handlers]

### 4.3 Payload、instructions 與模型分支

| 項目 | agent-gateway | Unsloth |
|---|---|---|
| `stream`／`store` | 上游強制 `true`／`false` | 同樣固定 |
| `include` | 保留 caller 陣列，再補 `reasoning.encrypted_content` | 固定該 reasoning include |
| `input` | Responses：保留 item/subfields，system→developer；Chat：重建 | 從 chat messages 重建可辨識 items |
| system instructions | Chat 轉 developer message；Responses 的 instructions 可直接傳 | system messages 合併入頂層 instructions |
| developer message | 保留／轉送 developer | `_responses_input` 跳過 developer role；不能宣稱相同語意 |
| 額外 instructions | 不注入 Studio 文句／日期／RAG | 固定 Studio compatibility 文句；呼叫端依條件加日期、工具提示等 |
| `tool_choice` | caller 提供才送；Lite 不另外補 default | default `auto`；只接受指定的 string/function 格式 |
| `parallel_tool_calls` | 非 Lite 保留 caller 值或省略；Lite 固定 false | 固定 true |
| `reasoning.effort` | caller 或模型 default；`ultra`→`max` | 有 effort 才送，原值轉交 |
| `reasoning.summary` | caller 提供才送 | 有 reasoning effort 時固定 `auto` |
| `reasoning.context` | Lite 固定 `all_turns`；非 Lite 保留 caller 值 | 未設定 |
| `text.verbosity` | caller 有設定才送 | 固定 `low` |
| `text.format` | 支援 json_object/json_schema | 同類功能；欄位 defaults 不同 |
| json_schema `strict` | Chat 缺省 false；Responses 保留 caller 物件 | 缺省 true |
| `service_tier` | 可轉送 | 不放入 subscription body |
| `max_output_tokens` | allowlist 保留；Chat 的 token cap 轉為此欄位 | 刻意不送，即使 stream() 收到 max_tokens |
| `previous_response_id` | gateway 本機記憶體保存已完成的 response（最多 1000 筆，重啟即失，`store:false` 不存；綁定 alias 與登入的 `account_id`，換登入後舊 id 不能續接），展開成完整 history 再送；上游仍是 `store:false` 加完整 input，不送此欄位 | 不構造此欄位，使用完整 history |
| Lite tools | top-level tools 移入 developer `additional_tools`；function/custom 包 `functions` namespace | 一律建 top-level function tools，無 Lite 分支 |

證據：[^P-normalize] [^P-chat] [^U-input] [^U-request] [^U-route]

[v] **中：`max_output_tokens` 是已確認的相容性歧異，不是已證實的上游 bug。** Unsloth 的註解與 mock assertion 認為 subscription 不接受；proxy 的註解／README 聲稱 PoC 接受，但本次僅確認 PoC source 在 **Lite model** 上包含該 probe，沒有重跑或用真實紀錄驗證。兩者的模型、版本及時間條件不同，不能把任何一方註解當成目前所有模型的實測事實。官方本機 `ResponsesApiRequest` 也沒有該欄位。[^T-max] [^C-request]

[v] **中：Lite 差異與 model lookup 綁定。** proxy 只有拿到 `use_responses_lite=true` 才切換；catalog lookup 失敗或找不到 slug 時仍送非 Lite shape，也不補模型 reasoning default。Unsloth 不使用這個 metadata 切換協定。因此「同 model 名」不保證兩者 tools/context/header 相同，也不能只根據 Unsloth 無 Lite 分支就判 proxy 不正常。官方本機 Codex 確有 additional-tools／all-turns／parallel=false 的 Lite 機制。[^P-models] [^C-request]

### 4.4 Tools、圖片與多輪 reasoning

| 項目 | agent-gateway | Unsloth | 影響 |
|---|---|---|---|
| function schema | Chat 只補缺省 root schema；已有 object schema 不補 properties | 遞迴為 object schema 補 `properties`，包含 combinators／`$defs` | 避免不完整 schema 的能力不同 |
| function `strict` | Chat 明設 boolean，缺省 false | 不構造 strict 欄位 | default/語意不能假設完全相同 |
| tool call ID | Chat 原樣回送，不限制長度 | 超過 64 chars 時穩定縮短，call/result 同步映射 | 長 ID 的上游相容性差異 |
| tool arguments | 預期 caller 提供 string，未做 runtime JSON stringify | 非 string 時 `json.dumps` | 非標準 caller 值的形狀不同 |
| tool result | Chat 收 string／text parts | transport 可 JSON serialize 非 string output | 內容保留／正規化不同 |
| tools 類型 | Chat 僅 function；Responses 可保留 custom/namespace/其他 | subscription body 只挑 function | Responses 的出站工具面較寬 |
| user image | Chat 保留 URL/data URL 與 caller detail；未檢查 catalog vision | 呼叫端檢查 vision；transport detail 固定 auto | capability 防護與送出資訊不同 |
| unsupported content | Chat 不支援的 user parts 本機 400；Responses input 無同樣重建 | 未辨識的 message/content types 被忽略或呼叫端處理 | 不可把 Chat 限制套到 Responses |
| assistant message item | Chat 通常無 id/status/annotations | `msg_unsloth_<index>`、status completed、annotations=[] | Unsloth 亦有明確產品識別資料 |
| encrypted reasoning 回傳 | Responses 保留；Chat streaming／non-streaming 不輸出 | terminal chat chunk 的 `extra_content.openai_codex_reasoning` | 可否續接 opaque state 不同 |
| encrypted reasoning 回送 | Responses input 可保留；Chat 忽略 message extra_content | 只回放 type=reasoning 且有 encrypted_content 的 item，含 summary/可用 id | Chat 多輪狀態不等價 |
| 本機工具／RAG | 不執行、不自動注入 | 啟用 Studio loop 時依 policy 執行、加入 skill/RAG/tool results | 請求次數及 prompt 來源不同 |

證據：[^P-chat] [^P-normalize] [^P-output] [^U-input] [^U-schema] [^U-events] [^U-loop]

[v] **中：Chat Completions 路徑不具 Unsloth 的 reasoning round-trip。** 正常文字／tool call 可續接，但不能說具有相同的多輪 encrypted state。此限制不適用於 proxy 的 raw Responses input/output。Unsloth 也需要 caller 保存 `extra_content`，或由 Studio loop 保留；不是每個標準 OpenAI chat client 都自動支援。

## 5. 實際出站資訊與最小化邊界

| 資訊 | proxy 來源／送往何處 | caller 可控制？ | 與 Unsloth 的差別 |
|---|---|---|---|
| access token | saved login → Codex responses/models Authorization | HTTP caller 不能直接覆蓋 | 皆為 OAuth Bearer |
| refresh token + public client ID | auth manager → `auth.openai.com/oauth/token` body | 不取 caller Authorization | 相同用途；encoding/redirect 見 §6 |
| account ID | auth file/id_token claim → Codex header | 不取 caller header | Unsloth 從 access token 驗證 |
| prompt／完整 history | caller input/messages/instructions → responses body | 是 | 皆送完整對話；不是只送新增訊息 |
| tools schema／description／arguments／results | caller 或 history → responses body | 是 | Unsloth 部分重建／正規化，也可能自行加入工具結果 |
| 圖片 | URL（包含 query）或 data URL → responses input | 是 | caller 自帶 URL 資訊也會出站；不是本機自動抓圖後上傳 |
| reasoning item／summary | Responses input → body | Responses caller 可提供 | Chat proxy 不回放；Unsloth 篩選 opaque item |
| cache key | caller 原字串，否則 prompt-seed hash → body/headers | 是 | Unsloth 用 provider/account/thread affinity hash |
| turn state | caller 同名 header → Codex header | 是 | Unsloth 不轉送 |
| client/OS 資訊 | constants/env version、node:os → Codex headers | version 可由部署環境設定 | Unsloth 使用簡單固定身分字串 |
| 允許欄位內的其他資料 | caller nested JSON → responses body | 是 | proxy passthrough 比 Unsloth 重建面寬 |
| caller API key/Cookie、一般 headers | 不複製到 upstream headers | 無一般 passthrough | 不能把 inbound 與出站 headers 混為一談 |
| 本機路徑、request logs | startup/error/log 的本機或 downstream 資訊 | URL/model 等可影響本機 log | 審查範圍未見自動傳到 provider 的 telemetry 路徑 |

證據：[^P-headers] [^P-transport] [^P-auth] [^P-normalize] [^P-chat] [^P-http] [^U-input] [^U-loop]

[v] **中／條件式：頂層 allowlist 不是遞迴清理。** 例如 caller 在一個合法 `input` item 放入額外 `metadata: { local_project: "demo" }`，目前 Responses normalization 會保留該 subfield，再由 `JSON.stringify(request)` 出站；backend 是否接受是另一回事。`tools`、`text`、`reasoning` 等允許物件亦未完整 schema 校驗。頂層 `metadata` 被移除，並不能防止這類內容出站。

Unsloth 重建固定 request/items，減少未辨識欄位，但 tools parameters、文字、reasoning summary 等仍可包含 caller 資料；**它也不是敏感資訊 sanitizer**。

頂層 proxy allowlist 是：

```text
model, input, instructions, tools, tool_choice, parallel_tool_calls,
reasoning, include, prompt_cache_key, text, service_tier, max_output_tokens
```

其他 root keys（例如 metadata/user/safety_identifier）被忽略，不是自動轉成其他識別資訊。剔除欄位名可進本機 log；欄位值不因此自動上傳。[^P-http]

## 6. Auth、重試、redirect、timeout、取消

| 行為 | agent-gateway | Unsloth | 判讀 |
|---|---|---|---|
| 登入擁有者 | 使用者透過 Codex CLI login；proxy 不實作 browser/device flow | 自行實作 PKCE/browser/device flow | 正常架構差異 |
| refresh endpoint/client ID | `auth.openai.com/oauth/token`／`app_EMoamEEZ73f0CkXaXp7hrann` | 相同 | 共同點 |
| refresh encoding | `application/json` | form `data=…`，即 URL-encoded | **官方 Codex ChatGPT refresh 亦用 JSON**，不能判 proxy JSON 異常 |
| refresh 時機 | JWT exp 前 5 分；未知 exp 則依 last_refresh 8 天 fallback | bundle expires_at 前 5 分，取 expires_in | 大致類似，expiry 資料來源不同 |
| refresh response validation | 可保留舊欄位，2xx 缺 token 不會由此函式嚴格拒絕 | 要求 access/refresh/account，檢查／限制 lifetime | malformed response 處理不同，未實測上游畸形回應 |
| 同 process refresh | shared Promise single-flight；讀磁碟辨識外部 rotation | provider asyncio lock；重讀 bundle/expected token | 皆避免部分重複 refresh |
| 跨 process refresh | **沒有跨 process lock** | provider file lock + DB guards | proxy README 限定一個 home 一個 instance；不可推論多 instance 同樣安全 |
| proactive refresh transient failure | 警告後仍嘗試舊 access token | resolve_access error，不會由該函式回傳舊 token | 失效 token 的請求／重試次數可不同 |
| Responses HTTP 401 | recover credentials，一次重送；最多兩個 Responses HTTP attempts | 一次 forced refresh，但與 transient retries **共用三個 attempt slots** | 並非完全同樣 retry budget |
| models HTTP 401 | 同 sendWithAuth，一次重送 | 一次 forced refresh；再 401 記錄 reconnect 狀態 | 大致相似；state persistence 不同 |
| 429／500／502／503／504 | 不自動 retry；回 error | Responses 在成功取得 SSE 前，非 terminal quota 可 retry | 請求節奏不同；最多總計 3 attempts，不是 401 加三次 |
| backoff | proxy 不做上述 backoff | retry-after-ms 優先，其次 retry-after，否則 2^attempt；最多 60 秒 | 差異 |
| terminal quota | 特定 quota code/type mapping | structured detail/code + 關鍵字判斷，terminal 不 retry | 錯誤分類並非同一套 |
| Retry-After 對 caller | usage_limit_reached 的 resets_at 可生成；一般 upstream headers 不交給 error mapper | quota metadata 保留 retry_after/reset headers/terminal | caller 的等待資訊不同 |
| SSE 開始後失敗 | 不自動重送 generation | 亦不自動重送已 yield 的 SSE request | 避免重複輸出的共同點 |
| Responses timeout | 無明示應用層 deadline，接 caller AbortSignal；runtime 仍有自身限制 | connect=20 秒，其他 httpx timeout=120 秒 | 不應把 proxy 描述為完全沒有 timeout |
| models／refresh timeout | AbortSignal 60 秒 | models 用上述 httpx timeout；OAuth 30 秒 | total deadline／階段 timeout 語意不同 |
| caller 取消 | downstream 非正常 close 時 abort Responses fetch/body | pre-header enter task 可取消；之後 watcher 關 response | 都支援，但模型查詢／refresh 不保證一起立即取消 |
| redirects | fetch 呼叫不設 policy；此 runtime default `follow` | Responses 明拒 3xx；models 不跟隨且非 200 報錯；OAuth 不跟隨 | credential/prompt 目的地邊界不同 |
| endpoint 驗證 | 預設 config 固定 URLs，啟動路徑無 caller base_url | 固定 URL 並驗證 scheme/host/path 等 | caller 不能直接改 proxy 目的地 |
| env proxy | 未在應用層設定 transport proxy policy | inference httpx 通常 trust_env；不支援 proxy scheme 時可 fallback false；OAuth trust_env=false | Node 完整 dispatcher/部署代理行為未審查，不能宣稱兩者相同 |

證據：[^P-transport] [^P-auth] [^P-models] [^P-http] [^P-errors] [^U-auth] [^U-http] [^U-models] [^U-route] [^C-auth]

[v] **中／條件式：redirect 邊界弱於 Unsloth。** 離線確認 `new Request(...).redirect === "follow"`，並檢視此 Node 內建 Undici 的 redirect 實作：POST 301/302 或適用的 303 會改 GET／移除 body，307/308 不走此改寫；跨 origin 會移除 Authorization、Proxy-Authorization、Cookie、Host，但不是清掉所有 custom headers，也不是移除保留的 POST body。若固定上游回傳可跟隨的 307/308，body 中的 prompt／refresh credential 可能隨 redirect 改變目的地。**未觀測到實際 redirect 或外洩，也不能說 Authorization 必然跨 origin 轉送。** Unsloth 則根本不跟隨這類 redirect。[^N-fetch]

[v] **中／部署條件式：refresh concurrency 邊界不同。** proxy 的 single-flight 僅限同一 process，不能等同 Unsloth 的跨 worker lock。此差異主要是 token rotation/可用性風險，不是「會額外送奇怪 metadata」的證據。

## 7. SSE 與回應轉換

| 行為 | agent-gateway | Unsloth |
|---|---|---|
| raw Responses streaming | 原樣轉送 bytes，不使用 JSON parser 解讀 | 對外主路徑為重建 chat SSE，沒有等價 raw passthrough |
| non-streaming caller | Responses/chat 均可聚合上游 SSE | subscription route 要求 stream=true |
| SSE message framing | parser 合併 multiline data、處理 CRLF/comments/tail | 逐行解析 data JSON；不合併 multiline data |
| event type | proxy parser 要 JSON 內有 type；不採 event field fallback | JSON type 或 SSE event name |
| malformed JSON | proxy parser 靜默忽略，可能最後變 incomplete | 明確 malformed stream error |
| text output | text delta；done item 無 delta 時可 fallback，跨 message 加換行 | text delta／refusal delta 直接轉內容 |
| refusal delta | Chat reducer 無對應分支 | 轉為 content |
| reasoning text delta | Chat reducer 無對應分支 | 轉為 reasoning_content |
| tool argument streaming | Chat 等 output_item.done，送完整 arguments | added + arguments.delta；done 有 fallback |
| encrypted reasoning | Chat 不回傳；Responses 原始輸出可保留 | done reasoning item 收集後放進 terminal extra_content |
| completed/incomplete | Chat finish_reason 依 max_output_tokens/content_filter/tool_calls/stop | incomplete 一律 length；completed 依 tools/stop |
| usage | Chat streaming 依 include_usage 發獨立 choices=[] chunk | terminal chunk 可含 usage；Studio loop 可聚合多輪 |
| failure／[DONE] | Chat failed/error 發 error、不附 [DONE]；truncated stream 發 incomplete error | client raise，route 接住後發 error 和 [DONE]；client 本身不發 [DONE] |
| upstream response headers | 特定 x-oai/openai-model/etag/x-codex headers 交給 caller | 外層主要設定 SSE cache/buffering headers | 不同 downstream contract |

證據：[^P-sse] [^P-output] [^P-handlers] [^P-http] [^U-events] [^U-route]

[v] **低至中：SSE parser 與工具 chunk 節奏不同。** malformed/event-name-only/multiline SSE 在兩者有不同結果；proxy Chat 的 tool-call arguments 要等 item.done 才出現。不應將 raw Responses 的原樣轉送，誤當成 Chat 路徑也保留所有事件。這些多為 downstream 相容性／資訊保留差異，不是額外出站 metadata。

## 8. Model catalog 對通訊的影響

| 項目 | agent-gateway | Unsloth |
|---|---|---|
| cache TTL | 5 分鐘，process 內 shared single-flight | 10 分鐘、provider-keyed；另保留 account/catalog 證據 |
| listable models | 顯示 visibility=list，priority 排序 | 保留 metadata；listed 標示供 picker／invoke gate 使用 |
| raw catalog 使用 | slug、default_reasoning_level、use_responses_lite | context/modality/reasoning levels、listed／account 驗證；未用 Lite flag |
| model invocation gate | findModel 主要決定 Lite shape/default effort；失敗或未知仍發請求 | route 依 seed/catalog/saved-model/account 規則先檢查 |
| account rebind | catalog 不以 account 分群／即時 invalidate | 會 drop/stale catalog、判斷 account proof／並發讀取 ticket |
| models fetch 失敗 | `/models` 回 error；inference 的 findModel 可吞錯後續送 | picker 可有 curated fallback；inference 是否能送由 route gate 決定 |

[v] **低至中：版本、cache 與 admission policy 會改變實際出站請求。** proxy 可以把未知／hidden model 交由 backend 判斷；Unsloth 對計畫模型與帳號較積極檢查。這是不同產品邊界，不等於 proxy 自動越權，也不等於 Unsloth 永遠不會請求退場模型。切換登入／catalog 失敗時，proxy 可能沿用舊 catalog 或非 Lite shaping；未實測該情境的上游結果。[^P-models] [^U-models] [^U-route]

## 9. 驗證結果與限制

| 檢查 | 結果 | 能證明／不能證明 |
|---|---|---|
| [v] `npm run typecheck` | 通過 | TypeScript 型別檢查；不等於 runtime input validation |
| [v] `TMPDIR="$PWD/.tmp" npm test -- --no-cache --fsModuleCachePath "$PWD/.tmp/vitest-protocol-audit-cache"` | **11 files、60 tests 通過** | auth、headers、normalization、chat/SSE/fixtures 等既有行為 |
| [v] Unsloth subscription test file | **86 tests 通過**，14 個 torch deprecation warnings | fake transport/auth、headers/body、reasoning/call-ID/schema、catalog/reconnect、cancel、Studio loop 等 |
| [v] Node Request/內建 Undici 檢視 | default follow；redirect 移除特定 headers／body 改寫分支已確認 | 無 socket／provider request；未模擬真實 wire redirect |
| [v] 三個 repo tracked diff | 審查／測試後無 production code 變更 | 只新增規劃與報告 Markdown；既有未追蹤內容不動 |
| [v] 真實 provider／PoC／TLS／封包 | **未執行，屬本次範圍外** | 不能證明欄位接受率、cache 命中、偵測或封鎖機率 |

Unsloth 使用已存在的 `unsloth/.studio/unsloth_studio/bin/python`，不安裝依賴、不啟動 Studio server；設定獨立 `UNSLOTH_STUDIO_HOME`／HF cache/token path、禁止 attention installer、停用 pytest 外掛自動載入及 cache。既有 pytest network guard 封鎖非允許的 outbound 連線；此 test file 使用 fake/mocked provider。

首次測試的 dependency import 另產生 CWD-relative `unsloth_compiled_cache`。確認是本次生成後，已移到該次 `.tmp/` 目錄保存；額外設定 `UNSLOTH_COMPILE_LOCATION=<獨立 .tmp 路徑>/compiled-cache` 再跑一次，仍為 **86 passed**，且確認根目錄沒有再產生此快取。沒有刪除或移動既有使用者檔案。

對應測試命令的核心為：

```text
unsloth/.studio/unsloth_studio/bin/python -m pytest \
  unsloth/studio/backend/tests/test_openai_codex_subscription.py \
  -q -p no:cacheprovider --basetemp=<獨立 .tmp 路徑>/pytest
```

最終測試紀錄：`.tmp/unsloth-protocol-audit-cUFeZ1/pytest.log`；首次紀錄及移入的快取在 `.tmp/unsloth-protocol-audit-3AoIjb/`。上面的核心命令不是完整隔離命令；本次執行另設定 studio/compiler/HF/Torch/Triton/TMPDIR 路徑、offline／禁止 installer 等環境值，不應省略這些隔離措施直接重跑。

### 尚未被測試覆蓋為完整 wire contract 的部分

- proxy 現有 tests 沒有獨立 `codexClient` HTTP transport／server-to-backend 整合 test；60 個測試通過不等於所有 headers/body/401/redirect 組合已動態校驗。
- 預設 UA 中 `agent-gateway` suffix、nested passthrough、任意 cache-key 的多位置使用，以及 catalog fallback 邊界以 production code 為證；不宣稱這些都有專門 regression test。
- HTTP 自動 headers/order、compression、TLS／ALPN／HTTP version、真實部署 proxy/network path，未做 wire 封包比較。
- 「Unsloth 能使用」不提供 provider 授權、允許、無偵測或免封鎖的證據。
- 未讀取真實 `auth.json`、access/refresh token、私人 prompt；未執行 build／`npm run poc`、未修改任何 production code 或測試。

## 10. 原始碼與測試來源

以下路徑相對於 agent-gateway 根目錄；行號對應 §2 的固定版本。所有結論來源為本機 checkout，未使用外部網站／既有筆記作為判定依據。

[^P-headers]: `src/upstream/headers.ts:5–32`；`src/constants.ts:1–16`。出站身份／session／Lite／turn-state headers。
[^P-transport]: `src/upstream/codexClient.ts:26–83`。fetch、401、Responses JSON、models query/timeout。
[^P-auth]: `src/auth/authManager.ts:34–160`；`src/auth/authFile.ts:23–52`；`src/auth/jwt.ts:19–26`。refresh encoding/single-flight、credentials/expiry。
[^P-normalize]: `src/responses/normalizeResponsesRequest.ts:21–125`；`src/constants.ts:21–37`。allowlist、seed、Lite、reasoning/defaults。
[^P-chat]: `src/chat/toResponsesRequest.ts:23–135`。roles、images、tools/schema、token cap、format。
[^P-handlers]: `src/responses/handleResponses.ts:7–32`；`src/chat/handleChatCompletions.ts:12–56`。兩種 endpoint 的實際入口與 caller-header 讀取。
[^P-models]: `src/models.ts:9–55`；`src/config.ts:12–26`。catalog/fallback、固定目的地／client version。
[^P-http]: `src/server.ts:30–72`；`src/utils/http.ts:58–71`；`src/index.ts:7–23`。caller input/header、logs、啟動路徑。
[^P-sse]: `src/utils/sse.ts:6–46`。SSE framing、type 檢查、忽略 malformed data。
[^P-output]: `src/chat/reduceChatStream.ts:44–90`；`src/chat/toChatCompletion.ts:16–63`；`src/responses/collectResponse.ts:5–19`。Chat 事件／finish／usage／reasoning 保留差異。
[^P-errors]: `src/errors.ts:57–114`。HTTP/SSE quota/error mapping、Retry-After。
[^U-constants]: `unsloth/studio/backend/core/inference/openai_codex_auth.py:31–52`。endpoint/client ID／版本／身分與 Studio instructions。
[^U-input]: `unsloth/studio/backend/core/inference/openai_codex_client.py:61–167`。input whitelist、call ID、system/developer、reasoning replay、images。
[^U-request]: `unsloth/studio/backend/core/inference/openai_codex_client.py:812–906`。affinity/request ID、payload/defaults、headers。
[^U-events]: `unsloth/studio/backend/core/inference/openai_codex_client.py:913–1084`。SSE line/event、tools/reasoning/errors/terminal。
[^U-http]: `unsloth/studio/backend/core/inference/openai_codex_client.py:188–228`、`:537–783`。host validation、timeout/proxy、quota/retry/cancel/redirect。
[^U-models]: `unsloth/studio/backend/core/inference/openai_codex_client.py:230–534`。account-keyed catalog 證據、TTL、model normalize/401。
[^U-auth]: `unsloth/studio/backend/core/inference/openai_codex_auth.py:103–124`、`:192–230`、`:297–326`、`:402–581`、`:849–905`。file lock／JWT/token validation、form refresh、登入、rotation guards。
[^U-schema]: `unsloth/studio/backend/core/inference/openai_responses_shared.py:11–89`。遞迴 schema normalization 與 SSE event fallback。
[^U-route]: `unsloth/studio/backend/routes/inference.py:26241–26700`、`:6647–6705`、`:37998–38017`。subscription admission、messages/tools/date、refresh/rebind、SSE errors/[DONE]；另 `:25445–25800` 為相關 message/extra-content 重建。
[^U-loop]: `unsloth/studio/backend/core/inference/openai_codex_tool_loop.py:29–128`；`unsloth/studio/backend/core/inference/studio_tool_loop.py:1259–1403`、`:1453–1455`、`:1988–1998`。工具執行責任、RAG/skills、reasoning／results 回放。
[^C-headers]: `codex/codex-rs/codex-api/src/requests/headers.rs:5–13`；`codex/codex-rs/codex-api/src/endpoint/responses.rs:69–96`；`codex/codex-rs/login/src/auth/default_client.rs:152–211`。官方 session/thread/request-ID 與 UA 校驗。
[^C-cli-provider]: `codex/codex-rs/model-provider-info/src/lib.rs:41`、`:80`、`:411–472`、`:523–565`；`codex/codex-rs/login/src/auth/default_client.rs:416–420`、`:456–469`。官方 ChatGPT backend 預設 URL、provider version／環境 headers、managed residency、共用 originator／UA。
[^C-cli-identity]: `codex/codex-rs/login/src/auth/default_client.rs:40–135`；`codex/codex-rs/tui/src/lib.rs:715–735`；`codex/codex-rs/exec/src/lib.rs:730–750`；`codex/codex-rs/app-server/src/request_processors/initialize_processor.rs:130–195`；`codex/codex-rs/core/src/thread_manager.rs:373–400`；`codex/codex-rs/terminal-detection/src/lib.rs:152–185`、`:233–240`。官方 CLI 入口、process／thread originator、UA suffix 與終端 token。
[^C-cli-auth-headers]: `codex/codex-rs/model-provider/src/auth.rs:306–325`；`codex/codex-rs/model-provider/src/bearer_auth_provider.rs:31–45`；`codex/codex-rs/login/src/auth/manager.rs:613–636`。官方 saved ChatGPT token／account ID／FedRAMP header 組合。
[^C-cli-models]: `codex/codex-rs/codex-api/src/endpoint/models.rs:35–113`；`codex/codex-rs/model-provider/src/models_endpoint.rs:103–135`；`codex/codex-rs/models-manager/src/lib.rs:18–26`；`codex/codex-rs/models-manager/src/manager.rs:585–597`。官方 models URL/query、catalog override、whole client version 與 GET request builder。
[^C-cli-http]: `codex/codex-rs/codex-api/src/endpoint/responses.rs:129–149`；`codex/codex-rs/core/src/client.rs:1437–1468`、`:1704–1713`、`:2415–2447`；`codex/codex-rs/http-client/src/request.rs:184–235`。官方 HTTP Responses Accept／Content-Type、Lite／beta／turn-state／attestation headers 及 zstd request compression。
[^C-cli-session]: `codex/codex-rs/core/src/client.rs:641–663`；`codex/codex-rs/codex-api/src/sse/responses.rs:64–72`。官方 cache affinity／non-root session 分支與上游 turn-state 擷取。
[^C-cli-metadata]: `codex/codex-rs/core/src/responses_metadata.rs:311–411`；`codex/codex-rs/core/src/client.rs:865–898`、`:900–910`；`codex/codex-rs/core/src/attestation.rs:7`。官方 metadata body／compatibility-header 分工、memory-consolidation 與 attestation 條件。
[^C-cli-ws]: `codex/codex-rs/core/src/client.rs:173–176`、`:1375–1410`、`:2313–2371`；`codex/codex-rs/codex-api/src/endpoint/responses_websocket/connector.rs:25–43`。官方 Responses WebSocket endpoint/auth、handshake beta／routing／timing headers，以及 transport 選擇；Lite frame metadata 另見 C-cli-metadata。
[^C-request]: `codex/codex-rs/core/src/client.rs:932–994`、`:1058–1083`；`codex/codex-rs/codex-api/src/common.rs:279–307`。官方 Lite/context/body/request type。
[^C-auth]: `codex/codex-rs/login/src/oauth/client.rs:14–20`、`:92–116`；`codex/codex-rs/login/src/auth/manager.rs:1638`。官方 ChatGPT refresh JSON encoding。
[^T-max]: `unsloth/studio/backend/tests/test_openai_codex_subscription.py:292–353`（本次通過）；`unsloth/studio/backend/tests/test_provider_max_output_tokens_contract.py:315–343`（僅閱讀）；`scripts/poc.ts:401–439`（僅閱讀，不執行）。token cap 接受與否的證據邊界。
[^N-fetch]: Node.js `v22.22.3`／Undici `6.24.1`：離線 `Request.redirect`，及內建 `internal/deps/undici/undici` 的 `httpRedirectFetch`。檢視執行環境實作，未發送網路請求。
