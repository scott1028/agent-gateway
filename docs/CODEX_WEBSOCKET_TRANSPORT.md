# Codex Responses WebSocket 傳輸：未實作

評估日期：2026-10-17。

## 1. 結論

**狀態：未實作。** agent-gateway 的 Codex 上游只走 HTTP（`src/upstream/codexClient.ts:61`），每輪送上游的都是 `store:false` 加完整 input（`src/responses/normalizeResponsesRequest.ts:104`）。`previous_response_id` 只在 gateway 本機展開成完整 input（`src/responses/responseStore.ts:50-71`），上游看不到這個 id（`test/responses/previousResponse.test.ts:80-96`）。

官方 Codex 連 ChatGPT backend 時預設走 Responses WebSocket，HTTP 是退路。在同一條連線上，條件成立時官方只送增量 input 並帶 `previous_response_id`（第 3、5 節）。這是 gateway 與官方在傳輸上的差異。

目前能減輕全量重送成本的只有 prompt cache：

- mock 測試證明跨輪的 cache key、session headers 與 input prefix 是穩定的（`test/responses/previousResponse.test.ts:168-192` 的 cache 穩定性 cases）。
- 真實上游的 cache 命中**尚未驗證**。

Claude 無法比照：Messages API 沒有伺服器端狀態，只能靠 prompt cache 降低成本。

## 2. 固定版本

| 對象 | 固定版本 |
|---|---|
| 官方 Codex CLI | `references/codex` `0d58012ec2`；下文官方路徑都相對於 `references/codex/codex-rs/` |
| CLIProxyAPI，以下簡稱 CPA | `references/CLIProxyAPI` `5fc580b1`（v8.0.29）；下文 CPA 路徑都相對於該資料夾 |
| agent-gateway | `1c47015` |
| Node.js | `v22.22.3` |
| 評估日期 | 2026-10-17 |

本文件是原始碼的靜態比對，沒有連真實 backend。WebSocket 協議細節仍要用 `npm run poc` 實測確認（第 9、10 節）。

## 3. 官方什麼時候走 WebSocket

| 事實 | 證據 |
|---|---|
| ChatGPT backend 的 base URL 是 `https://chatgpt.com/backend-api/codex` | `model-provider-info/src/lib.rs:80` |
| 內建 OpenAI provider 設 `supports_websockets: true`；Amazon Bedrock 與 OSS provider 設 false，自訂 provider 的欄位預設 false | `lib.rs:561`；`lib.rs:601`（Bedrock）、`:775`（OSS）、`:198-199`（`#[serde(default)]`） |
| `responses_websocket_enabled()` 的條件：provider 支援，而且這個 session 還沒退回 HTTP | `core/src/client.rs:1112-1120` |
| `stream()` 先試 WebSocket，結果是 `FallbackToHttp` 才改走 HTTP | `client.rs:2377-2415` |
| 退回 HTTP 對整個 session 永久生效：`disable_websockets.swap(true)`，並清掉快取的 WebSocket session | `client.rs:719-738`、`:2420-2436` |
| 退回 HTTP 只有兩種情況：連線時回 `426 Upgrade Required`，或重試次數用完 | 426：`client.rs:1620-1625`（啟動時預先連線）、`:2052-2055`（請求時連線）；重試用完：`core/src/responses_retry.rs:120-135` |

## 4. 連線

- **URL**：base URL 的 `https` 換成 `wss`（`codex-client/src/provider.rs:91-102`），路徑是 `/responses`（`codex-api/src/endpoint/responses_websocket.rs:464`），也就是 `wss://chatgpt.com/backend-api/codex/responses`。
- **握手 headers**（`core/src/client.rs:1386-1420`），在 auth headers 之外還有：
  - `OpenAI-Beta: responses_websockets=2026-02-06`（常數 `client.rs:160,175`，插入 `:1409-1412`）。
  - `originator`、`x-client-request-id`（值是 thread id）、session 與 thread headers、相容性 headers（`:1394-1402`）。
  - 選擇性的：routing hint、attestation、timing metrics（`:1403-1408,1413-1418`）。
- **握手回應**：可能帶回 `x-codex-turn-state`，官方會記下來（`codex-api/src/endpoint/responses_websocket.rs:560-566`）。之後每個請求把它放在 `client_metadata` 裡，不是放在 HTTP header（`client.rs:2088-2090`）。
- **Prewarm**：是 best-effort 步驟（`client.rs:20-21`）。WebSocket 未啟用、或連線已經預熱時直接跳過（`client.rs:2312-2316`；啟動時的 prewarm 見 `core/src/session/startup_prewarm.rs:310-329`）。真的執行 prewarm 時，先送一個 `generate=false` 的 `response.create`（`client.rs:2158`），等它 `Completed` 才送正式請求（`:2335-2344`）。
- **連線壽命**：
  - 連線快取在 session 層級的 `ModelClient` 上（`client.rs:221`）。每個 turn 在 `new_session` 取出（`:674-684`），結束時存回（`:1423-1428`），所以跨 turn 重用。
  - server 端每條連線最多 60 分鐘，到了會回 `websocket_connection_limit_reached`（`responses_websocket.rs:166-167`）。

## 5. 增量請求

- **payload 型別**：`ResponseCreateWsRequest`，內含 `model`、`stream`、`service_tier`、`previous_response_id`、`input`、`tools`、`generate` 等欄位（`codex-api/src/common.rs:330-360`）。
- **只送增量需要同時滿足三個條件**（`client.rs:1500-1561`）：
  1. 同一條連線上有上一輪的 request（`:1505-1509`），也有上一輪的 response，而且 response id 不是空的（`:1547-1554`）。
  2. 這一輪的請求屬性和上一輪相同。比對欄位有 model、tools、tool_choice、parallel_tool_calls、reasoning、store、stream、include、service_tier、prompt_cache_key、text（`client.rs:389-455`）。
  3. 新 input 等於「上一輪 input + 上一輪 output 的 items」再接上新的 items，比對時忽略內部 metadata（`client.rs:1514-1530`）。
- **送出內容**（`client.rs:2091-2118,2137-2160`）：
  - 條件都成立：只送新增的 items，加上 `previous_response_id = 上一輪 response id`。
  - 首次請求或任一條件不成立：同一條連線改送完整 input，不帶 `previous_response_id`，並記錄原因（模式 `"full"`，`:2117`）。

## 6. 失敗處理

- `previous_response_not_found` 和 `websocket_connection_limit_reached` 都被歸類成 `Retryable`（`responses_websocket.rs:670-686`），但預設訊息不同（`:166-170`）；上游有提供 `error.message` 時，以上游的為準（`:681-684`）：
  - `websocket_connection_limit_reached`：「Responses websocket connection limit reached (60 minutes). Create a new websocket connection to continue.」
  - `previous_response_not_found`：「Previous response was not found. Retrying the full request.」
- 串流出錯時，這條 socket 會被丟棄（`responses_websocket.rs:361-367`）；下一個請求發現連線已關閉，就重建連線並清掉續接狀態（`client.rs:1677-1715`；`reset` 見 `:478-489`），所以改送完整 input。
- 重試次數用完，就永久退回 HTTP（`responses_retry.rs:120-135`）。
- auth owner 改變時：
  - WebSocket 會丟棄快取的連線、增量狀態和 turn-state（`client.rs:677-680,1688-1700`；模組說明 `:14-15`）。
  - HTTP 的 expected-owner guard（`client.rs:1787-1791`）只用在背景 compaction（`core/src/compact_remote_v2.rs:308`）；前景 HTTP 傳 `None`（`client.rs:2402-2404`）。
  - gateway 只在用 `previous_response_id` 續接已保存的 response 時檢查登入身分（`src/responses/responseStore.ts:74-77`），這是參考官方做法的類比，見 [Codex 通訊差異](CODEX_UNSLOTH_PROTOCOL_DIFF.md) §4.1.1 註記 3。

## 7. CLIProxyAPI 的對照

- `CodexAutoExecutor` 只有在「下游本身就是 WebSocket」**而且**「這個帳號啟用了 websockets」時，才走上游 WebSocket；下游是 HTTP 的請求一律走 HTTP（`internal/runtime/executor/codex_websockets_executor.go:36-40`）。WebSocket executor 本身也保留 HTTP 實作，作為 `/responses/compact` 與 upgrade 失敗時的退路（`:19-22`）。
- 也就是說，CPA **沒有**做「下游 HTTP 加 `previous_response_id` → 上游 WebSocket」的轉接：
  - HTTP Codex executor 直接刪掉 `previous_response_id`（`internal/runtime/executor/codex_executor_stream.go:66`）。
  - 下游是 WebSocket 時，`sdk/api/handlers/openai/openai_responses_websocket_requests.go` 依序判斷：
    1. **transcript replacement**：符合下列任一分支時，直接採用新的 transcript，不合併舊 history（`:95-101`；條件見 `:191-219`）。兩個分支的共同前提是請求類型為 `response.create` 或 `response.append`，而且 input 是陣列（`:192-201`）。
       - **模型輸出分支**：`previous_response_id` 為空（沒有這個欄位或是空字串都算），而且 input 含 assistant message 或 function／custom tool call（`:197-199,206-216`）。
       - **本機 compaction summary 分支**：只在 `response.create` 時觸發，而且 `previous_response_id` 欄位必須完全不存在；summary 的形狀由 helper 判斷（`:203`，helper 見 `:221-254`）。`response.append` 不會觸發這個 reset，帶著 `previous_response_id` 欄位（即使是空字串或 null）也不會（`openai_responses_websocket_test.go:1660-1680`）。
    2. **一般增量續接**：上游帳號啟用了 websockets 時，保留增量 input 與 `previous_response_id` 往上游送（`openai_responses_websocket_requests.go:103-135`；帳號是否啟用的判斷見 `sdk/api/handlers/openai/openai_responses_websocket_session.go:15-30`）。
    3. **full-transcript／compaction replay bypass**：允許 bypass 且 input 已是完整 transcript 時，直接採用該 input（`openai_responses_websocket_requests.go:137-145`）。
    4. 其餘情況才在 proxy 端合併 `lastRequest + lastResponseOutput + 新 input`（`openai_responses_websocket_requests.go:146-160`）。

    佐證：`sdk/api/handlers/openai/openai_responses_websocket_test.go:1588-1658` 在增量與 compaction bypass 都關閉的設定下，仍斷言保留新的 transcript、排除舊 items。
- 規模參考：`internal/runtime/executor/codex_websockets_*.go` 共 21 個檔、9,875 行，其中 13 個是測試檔。測試名稱涵蓋 duplex、interrupt、斷線、lifecycle、credential 失敗、連線重用與重試等情境，可以看出這塊的坑很多。

## 8. 套用到 gateway 的設計選項

| | A：下游 WS ↔ 上游 WS，1:1 | B：下游 HTTP + id ↔ gateway 管理上游 WS |
|---|---|---|
| 誰受惠 | Codex CLI 這類會講 Responses WebSocket 的 client | OpenAI Agents SDK 這類用 HTTP 呼叫 `previous_response_id` 的 client |
| 連線生命週期 | 跟著 client 的連線，和官方一致 | gateway 要自己決定：每個 conversation 一條？閒置多久關？60 分鐘到期怎麼換？ |
| 和官方行為的相似度 | 高：client 本身就是官方 CLI，gateway 只做轉送與換憑證 | 低：「多條長連線 + 自己決定何時增量」是 gateway 自創的行為 |
| 和現有 `responseStore` 的關係 | 不需要；增量在連線內處理 | 需要：用 response id 找到對應的連線，對不上就送完整 input |
| 分支（同一個 id 被續接兩次） | 由 client 決定 | 只有連線上的最後一輪能走增量，其他只能送完整 input |
| 並行 | 一條連線同時只有一個 response | 同一個 conversation 的並行請求要排隊，或另開連線 |
| 退回 HTTP | 照官方規則：426 或重試用完 | 自己定：沒有對應的連線、斷線、找不到 id，就走現有的 HTTP 全量路徑 |

**技術前提：**

- Node `v22.22.3` 內建的 `WebSocket`（undici）接受 `new WebSocket(url, { headers })`，建構時不會丟錯（本機只驗證到建構這一步）。**自訂 headers 實際有沒有在握手時送出、上游有沒有收到，尚未驗證。** 驗證不了就得加 `ws` 套件；目前 `package.json` 的 dependencies 只有 `xxhash-wasm`。
- 下游 WebSocket endpoint 需要處理 HTTP upgrade。`node:http` 的 `upgrade` 事件做得到，但 frame 解析仍需要 `ws` 之類的套件。

## 9. 風險

- **AGENTS.md「只模仿官方」**：
  - A 要逐項比照官方：beta header、`client_metadata`（包含 turn-state 與 Lite 旗標）、prewarm、重試與退回規則。
  - B 的連線管理是官方沒有的行為，違反「不要發明 back door 沒看過的東西」的精神。
- **封號風險**：B 會從一個 gateway 開很多條長連線，連線模式和官方 CLI 不一樣。
- **必須實測**：WebSocket 協議細節只能靠 `npm run poc` 打真實 backend 確認，會花額度，而且要由使用者觸發。
- **預估改動量（估計，未實作驗證）**：
  - A：約 800 到 1,500 行，含測試與 fixture，可能新增 `ws` 依賴。
  - B：再加上連線池與生命週期管理，約 1,500 到 3,000 行。
- **效益未經驗證**：
  - 省下的是上傳量；上游的 token 計費本來就有 prompt cache 折扣。
  - 增量對延遲（TTFT）和額度的實際影響，要實測才知道。

## 10. 建議與實作前的 PoC 清單

1. 先用現有的 cache 穩定性 mock 測試（`test/responses/previousResponse.test.ts:168-192`），加上一次手動實測（第 2 輪 `usage.input_tokens_details.cached_tokens > 0`），確認目前「全量 + cache」的成本是否已經可以接受。
2. 如果確實需要省上傳量，做 **A：WebSocket 對 WebSocket 的 1:1 轉送**。動工前先寫 PoC，再依官方比照清單做實作與測試。PoC 要確認：
   - 握手 headers：auth、`originator`、`OpenAI-Beta: responses_websockets=2026-02-06`、session 與 thread headers 實際有送出，且上游接受（第 4 節）。
   - prewarm：`generate=false` 的 `response.create` 會回 `Completed`，之後的請求能沿用同一條連線（第 4 節）。
   - 增量請求：條件成立時只送新 items 加 `previous_response_id`，上游接受並正確續接（第 5 節）。
   - 426 退回：握手回 `426 Upgrade Required` 時，改走現有的 HTTP 全量路徑（第 3 節）。
   - `previous_response_not_found`：收到時丟棄連線，重建連線後送完整 input（第 6 節）。
3. B 暫緩。只有在「HTTP client 加 `previous_response_id`」是主要用例，而且量大到 cache 也撐不住時才重新評估，並且要接受偏離官方行為的風險。
