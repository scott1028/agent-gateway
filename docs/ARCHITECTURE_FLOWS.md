# agent client、agent-gateway、官方 BE 的運作流程

撰寫日期：2026-10-18，以目前的程式碼為準。本文件用 ASCII 圖說明各種 client 經過 gateway 到官方 backend 的流程：每條路徑上 gateway 做了什麼、沒做什麼。設定方式見[使用指南](GUIDE.md)，和官方的逐項差異見[Claude 協定差異](CLAUDE_UPSTREAM_PROTOCOL_DIFF.md)與[Codex WebSocket 傳輸](CODEX_WEBSOCKET_TRANSPORT.md)。

圖的讀法：swimlane 由左到右是時間；每條泳道是一個參與者；空格表示那一方在這一步沒有動作。格子裡的標籤一律用簡短英文。

## 1. 元件總覽

```text
Agent client                       agent-gateway (src/)                        官方 BE
+-----------------------------+    +--------------------------------------+    +------------------------------------+
| OpenAI-compatible client    |--->| server.ts      route, key/Host check |--->| chatgpt.com/backend-api/codex      |
|   /v1/responses             |    | responses/     /v1/responses         |    |   /responses (HTTP, WS), /models   |
|   /v1/chat/completions      |    | chat/          /v1/chat/completions  |--->| api.anthropic.com                  |
| Official Claude Code        |--->| claude/        assemble, relay,      |    |   /v1/messages, /v1/models         |
|   /v1/messages              |    |                downgrade, state      |    +------------------------------------+
|   /v1/messages/count_tokens |    | upstream/      codexClient (fetch),  |
| Other Anthropic client      |--->|                codexRelay (HTTP, WS) |    OAuth server
|   /v1/messages              |    | utils/rawRelay.ts  raw node:https    |    +------------------------------------+
| Official Codex CLI          |--->| auth/          Codex token refresh   |--->| auth.openai.com/oauth/token        |
|   /backend-api/codex/*      |    | claude/auth.ts Claude token refresh  |--->| platform.claude.com/v1/oauth/token |
+-----------------------------+    +--------------------------------------+    +------------------------------------+
```

- 所有 HTTP 請求都先進 `src/server.ts` 的 `handleRequest`，WebSocket upgrade 則進 `handleUpgrade`；兩者都先做 key／Host 檢查，再分流（§2）。
- 自組路徑（`responses/`、`chat/`、`claude/` 的組裝）用 `fetch` 送上游。三條原樣轉送（Claude Code、count_tokens、Codex CLI）用 `src/utils/rawRelay.ts` 的 raw `node:https`。
- token refresh 由各 home 的 auth manager 處理：Codex 是 `src/auth/authManager.ts`，Claude 是 `src/claude/auth.ts`（§3.8）。

| Client | 設定方式 | endpoint | 流程 |
|---|---|---|---|
| OpenAI 相容 client（OpenAI SDK、aider、Codex 自訂 provider 等） | base URL `http://127.0.0.1:8765/v1`；model 用 `codex1/...`、`claude1/...` 這種帶 alias 的 id，或 bare id | `/v1/models`、`/v1/responses`、`/v1/chat/completions` | §3.1、§3.2 |
| 官方 Claude Code | `ANTHROPIC_BASE_URL=http://127.0.0.1:8765` 加上 `_CLAUDE_CODE_ASSUME_FIRST_PARTY_BASE_URL=1`；有 gateway key 時用 `ANTHROPIC_CUSTOM_HEADERS="x-agent-gateway-api-key: <key>"` | `/v1/messages`、`/v1/messages/count_tokens` | §3.3、§3.4 |
| 其他 Anthropic client（例如 Anthropic SDK） | `base_url="http://127.0.0.1:8765"`（不帶 `/v1`）；gateway key 放在 `x-api-key`、`Authorization: Bearer` 或 `x-agent-gateway-api-key` | `/v1/messages` | §3.5 |
| 官方 Codex CLI | `openai_base_url = "http://127.0.0.1:8765/backend-api/codex"`；不能設 `AGENT_GATEWAY_API_KEY` | `/backend-api/codex/*`（HTTP 與 WebSocket） | §3.6、§3.7 |

設定細節見[使用指南](GUIDE.md)「Client 設定範例」「官方 Claude Code 連 gateway」「其他 Anthropic client（降轉）」「官方 Codex CLI 連 gateway」。

## 2. 路由判斷

```text
request
│
├─ WebSocket upgrade? ── yes ──► handleUpgrade
│                                  ├─ path not under /backend-api/codex/ ──► 404
│                                  ├─ AGENT_GATEWAY_API_KEY set ──────────► 403 api_key_unsupported
│                                  ├─ Host not loopback ──────────────────► 403
│                                  └─ else ───────────────────────────────► 1A WebSocket relay (§3.7)
│ no
▼
key / Host check
├─ key set
│    ├─ /backend-api/codex/* ─────────────────────► 403 api_key_unsupported
│    ├─ Anthropic route with (1) ─────────────────► only x-agent-gateway-api-key, else 403
│    ├─ other Anthropic route ────────────────────► x-api-key, Bearer or gateway header, else 401
│    └─ other routes ─────────────────────────────► Bearer, else 401
├─ no key: Host not loopback ─────────────────────► 403
│
▼
method and path
├─ /backend-api/codex/* (any method) ─────────────► 1A HTTP relay (§3.6)
├─ GET /v1/models ────────────────────────────────► model list
├─ POST /v1/messages/count_tokens, no (1) ────────► 400
├─ other route ───────────────────────────────────► 404
├─ Content-Type not application/json ─────────────► 415
├─ POST /v1/messages/count_tokens ────────────────► 2a count_tokens relay (§3.4)
├─ POST /v1/messages
│    ├─ (1) and metadata.user_id with ids (2) ────► 2a relay (§3.3)
│    └─ else ─────────────────────────────────────► 2b downgrade (§3.5)
└─ POST /v1/responses, POST /v1/chat/completions
     └─ model -> account (3)
          ├─ Codex account ───────────────────────► §3.1
          └─ Claude account ──────────────────────► §3.2

(1) x-app: cli and a claude-cli/ User-Agent (headers only)
(2) metadata.user_id is a JSON string with device_id and session_id;
    a body that is not a JSON object stays on the 2a path, which answers 400
(3) alias prefix (codex1/, claude1/), or a bare id: claude-* -> first Claude home,
    anything else -> first Codex home
```

- 順序照 `src/server.ts`：key／Host 檢查（`:140-162`）、Codex 轉送（`:163`）、`/v1/models`（`:171`）、count_tokens 的非 Claude Code 400（`:176`）、404（`:182`）、415（`:186`）、Anthropic 路由（`:189-202`）、Responses 與 Chat（`:204-208`）；upgrade 在 `:217-235`。
- (1) 只看 header，因為 key 檢查發生在讀 body 之前（`server.ts` 的 `isClaudeCodeClient`）；(2) 是 `src/claude/relayMessages.ts:138` 的 `getIsClaudeCodeRequest`。
- 選帳號：自組路徑和 2b 看 model（`src/accounts.ts:43-68`）；2a 看 `metadata.user_id.account_uuid`；count_tokens 看綁定的 session；1A 看 `chatgpt-account-id`。

## 3. 各路徑的 swimlane

### 3.1 OpenAI 相容 client → Codex

```text
Time ─────────────────────────────────────────────────────────────────────────────────────────────►

              | 1 request          | 2 prepare          | 3 send               | 4 reply           |
--------------|--------------------|--------------------|----------------------|-------------------|
Agent client  | POST /v1/responses |                    |                      | Responses: SSE    |
              | or /v1/chat/       |                    |                      | as sent, or JSON  |
              | completions        |                    |                      | Chat: chunks      |
              |                    |                    |                      | or JSON           |
--------------|--------------------|--------------------|----------------------|-------------------|
agent-gateway |                    | model -> account   | fetch POST           | Responses: pipe   |
              |                    | expand prev id (a) | /responses           | SSE chunks        |
              |                    | allowlist fields   | token, session,      | Chat: translate   |
              |                    | store:false,       | Lite, turn-state (b) | or collect        |
              |                    | stream:true,       | 401: recover,        | save response (a) |
              |                    | full input,        | resend once          |                   |
              |                    | cache key          |                      |                   |
--------------|--------------------|--------------------|----------------------|-------------------|
官方 BE       |                    |                    | Responses SSE        |                   |
--------------|--------------------|--------------------|----------------------|-------------------|
```

- (a) 只有 `/v1/responses`：`previous_response_id` 先在本機展開成完整 input，完成的 response 存進記憶體 LRU；client 送 `store:false` 時不存（`src/responses/handleResponses.ts:41-48`、`src/responses/responseStore.ts:50,82`）。用 id 續接時，每次送出前都會確認登入身分沒換（`handleResponses.ts:94-97`）。
- 正規化：只留 allowlist 欄位，其餘記成 `ignored=`；`system` 改成 `developer`；固定 `stream:true`、`store:false`，加上 `reasoning.encrypted_content`；cache key 用 client 的 `prompt_cache_key`，沒給就用 model 和第一則 developer／user 訊息算出（`src/responses/normalizeResponsesRequest.ts:81-117`）。模型要求 Lite 時改成 Lite 形狀。
- (b) headers 由 gateway 產生（`src/upstream/headers.ts:11-35`）；`x-codex-turn-state` 只轉送 caller 送來的值。401 時恢復 token、重送一次（`src/upstream/codexClient.ts:42-61`）。
- 回應：`/v1/responses` 串流時 SSE chunk 原樣轉回，否則聚合成一個 response；Chat 把事件轉成 chat chunk 或 completion（`src/chat/handleChatCompletions.ts:56-89`）。上游的 `x-oai-request-id`、`openai-model`、`x-models-etag` 和 `x-codex-*` header 會轉回 client（`src/constants.ts:48-49`）。

### 3.2 OpenAI 相容 client → Claude

```text
Time ────────────────────────────────────────────────────────────────────────────────────────►

              | 1 request          | 2 prepare             | 3 send        | 4 reply          |
--------------|--------------------|-----------------------|---------------|------------------|
Agent client  | POST /v1/responses |                       |               | Responses or     |
              | or /v1/chat/       |                       |               | Chat: SSE        |
              | completions        |                       |               | or JSON          |
--------------|--------------------|-----------------------|---------------|------------------|
agent-gateway |                    | read accountUuid      | fetch POST    | translate Claude |
              |                    | settings, catalog (a) | /v1/messages  | SSE to Responses |
              |                    | look up signed        | ?beta=true    | (Chat: chunks)   |
              |                    | state (optional)      | stream:true   | save state at    |
              |                    | assemble: system,     | 401: recover, | message_stop (b) |
              |                    | cache marks,          | resend once   |                  |
              |                    | metadata, betas,      |               |                  |
              |                    | thinking, cch         |               |                  |
--------------|--------------------|-----------------------|---------------|------------------|
官方 BE       |                    |                       | Messages SSE  |                  |
--------------|--------------------|-----------------------|---------------|------------------|
```

- `/v1/responses` 一樣先展開 `previous_response_id`（§3.1 的 (a)），並用 home 的 `accountUuid` 確認是同一個登入（`handleResponses.ts:41,50-53`）。每個請求都重讀 `accountUuid`，讀不到就回 400（`src/claude/handleClaude.ts:58-65`）。
- (a) 模型目錄可能呼叫上游 `/v1/models`（5 分鐘快取，`handleClaude.ts:67`）。
- 簽章狀態是可選的查找：每個 assistant 回合依自己的前綴找記錄，找不到就用 client 回送的可見文字和 tool call 重建（`handleClaude.ts:79`、`normalizeRequest.ts:360-367`）。只有這些情況回 400：模型有 thinking，而還沒結束的 tool 回合找不到記錄（`normalizeRequest.ts:311-318`）；記錄存在但屬於別的帳號、model 或鍵，或可見內容和記錄不一致（`handleClaude.ts:80-86`、`normalizeRequest.ts:275`）；狀態檔讀不到或損毀（`state.ts`）；釘住的 thinking 設定不能在這個 model 上回放（`normalizeRequest.ts:321-328`）。
- 組裝走共用的 `src/claude/assembleRequest.ts:117`：billing（含 `cch`）、CLI 前綴、caller 指令、cache marker、`metadata.user_id`、betas、thinking、`output_config`。`cch` 在序列化時計算（`src/claude/attribution.ts:84`），送出用 `fetch`（`src/claude/client.ts` 的 `postMessages`）。
- (b) Claude SSE 翻成 Responses 事件（`src/claude/toResponsesEvents.ts:145`）；只有含 tool call 或隱藏區塊的回合，會在通過驗證的 `message_stop` 存一次狀態（`:441`，存在 `src/claude/state.ts`）。標頭送出後才失敗時，Responses 送 `response.failed`（`handleResponses.ts:16-35`），Chat 送錯誤 payload。

### 3.3 官方 Claude Code → `/v1/messages`（2a）

```text
Time ─────────────────────────────────────────────────────────────────────────────────►

              | 1 request         | 2 checks       | 3 send           | 4 reply        |
--------------|-------------------|----------------|------------------|----------------|
Agent client  | POST /v1/messages |                |                  | bytes as       |
              | ?beta=true        |                |                  | upstream sent  |
              | own body and      |                |                  |                |
              | headers           |                |                  |                |
--------------|-------------------|----------------|------------------|----------------|
agent-gateway |                   | 1 Claude Code? | get token        | pipe status,   |
              |                   | 2 cch billing? | re-check account | headers, bytes |
              |                   | 3 OAuth beta?  | raw send: only   |                |
              |                   | 4 account_uuid | host, auth,      |                |
              |                   |   = a home?    | length change    |                |
              |                   | 5 model alias  | 401: recover,    |                |
              |                   |   = that home? | re-check, resend |                |
              |                   | any fails: 400 |                  |                |
              |                   | bind session   |                  |                |
              |                   |   -> home      |                  |                |
--------------|-------------------|----------------|------------------|----------------|
官方 BE       |                   |                | Messages SSE     |                |
--------------|-------------------|----------------|------------------|----------------|
```

- 檢查都在 `src/claude/relayMessages.ts:187` 的 `getClaudeRelayRequest`（另外也檢查請求行是路徑形式、body 是 JSON 物件），任一項不過就回 400，不呼叫上游，也不綁定 session。帳號由 `account_uuid` 比對各 home 的全域帳號 metadata 決定：`readClaudeAccountMetadata` 先讀 `.config.json`，沒有有效的 accountUuid 才讀 `.claude.json`（`src/claude/auth.ts:65-81`、`src/constants.ts:218`）。
- 第 5 項：選出 home 之後，model 若帶 alias，必須等於這個 home 的 alias，否則回 400；alias 不能用來改選帳號。相符時只把 `model` 的值換成去掉 alias 的 id（`relayMessages.ts:173-185,232`）。
- 五項全過、而且請求帶了 `x-claude-code-session-id` 時，記下「session → home 與 accountUuid」（`relayMessages.ts:293-294`），供 §3.4 使用。
- 送出時 body 和 headers 照 client 原樣，只換 `host`、`authorization`、`content-length`，並移除 `transfer-encoding`、`keep-alive`、`upgrade`、`x-agent-gateway-api-key`（`src/utils/rawRelay.ts:12`）。每次送出前（包括 401 恢復後）都重新確認 home 的帳號（`src/claude/client.ts` 的 `postRawMessages`）。
- 回應的 status、headers、bytes 原樣轉回，只有連線用的 header 由 gateway 重設（`rawRelay.ts:72`）。

### 3.4 官方 Claude Code → `count_tokens`（2a）

```text
Time ─────────────────────────────────────────────────────────────────────────────────────────────────────►

              | 0 earlier         | 1 request         | 2 checks       | 3 send           | 4 reply        |
--------------|-------------------|-------------------|----------------|------------------|----------------|
Agent client  | POST /v1/messages | POST /v1/messages |                |                  | JSON as sent   |
              | (session S)       | /count_tokens     |                |                  |                |
              |                   | (session S,       |                |                  |                |
              |                   | no metadata)      |                |                  |                |
--------------|-------------------|-------------------|----------------|------------------|----------------|
agent-gateway | 2a checks pass    |                   | Claude Code    | re-check bound   | pipe status,   |
              | bind S -> home    |                   | headers?       | accountUuid      | headers, bytes |
              |                   |                   | OAuth beta?    | raw send         |                |
              |                   |                   | S bound?       | 401: recover,    |                |
              |                   |                   | model alias    | re-check, resend |                |
              |                   |                   | = bound home?  |                  |                |
              |                   |                   | any fails: 400 |                  |                |
--------------|-------------------|-------------------|----------------|------------------|----------------|
官方 BE       | Messages SSE      |                   |                | input_tokens     |                |
--------------|-------------------|-------------------|----------------|------------------|----------------|
```

- count_tokens 沒有 `metadata.user_id`，所以帳號只能靠 §3.3 的 session 綁定：記憶體 LRU，最多 1000 個 session（`src/claude/relayMessages.ts:55`）。
- 不是 Claude Code headers 的請求，在 `src/server.ts:176` 就回 400；其他檢查在 `relayMessages.ts:239` 的 `getClaudeCountTokensRequest`。查到綁定之後、送出之前，model 若帶 alias，必須等於綁定 home 的 alias，否則回 400（`relayMessages.ts:257`）。
- 送出前比對的是**綁定時**記下的 accountUuid（`relayMessages.ts:264` 的 `sendClaudeRelay`），home 換了帳號就回 400。

### 3.5 其他 Anthropic client → `/v1/messages`（2b）

```text
Time ──────────────────────────────────────────────────────────────────────────────────────────►

              | 1 request         | 2 normalize        | 3 assemble, send  | 4 reply            |
--------------|-------------------|--------------------|-------------------|--------------------|
Agent client  | POST /v1/messages |                    |                   | stream: native SSE |
              | Anthropic SDK     |                    |                   | else one Message   |
--------------|-------------------|--------------------|-------------------|--------------------|
agent-gateway |                   | rebuild blocks     | accountUuid,      | stream: pipe bytes |
              |                   | drop cache_control | settings, catalog | (cut: destroy)     |
              |                   | and metadata       | session id        | else collect       |
              |                   | unsupported: 400   | shared assembly   | one Message        |
              |                   | drop sampling      | fetch POST        |                    |
              |                   | model -> account   | stream:true       |                    |
--------------|-------------------|--------------------|-------------------|--------------------|
官方 BE       |                   |                    | Messages SSE      |                    |
--------------|-------------------|--------------------|-------------------|--------------------|
```

- 原生輸入在 `src/claude/nativeMessages.ts:211` 重建：清掉 client 的 `cache_control` 和 `metadata`，不支援的欄位或區塊回 400，`temperature`、`top_p`、`top_k` 拿掉並記成 `ignored=`。
- 帳號由 model 決定；非 Claude 的 model、home 沒有 accountUuid 都回 400。session id 由 alias、model 和第一則原始訊息算出（`src/claude/cloakMessages.ts:35-69`）。
- 組裝和 §3.2 共用同一個 `assembleClaudeRequest`；headers 和 UA 由 gateway 產生。
- 回應：串流時上游 SSE bytes 原樣轉回（headers 是 gateway 自己的 SSE headers），中途斷線就切斷 client 連線（`cloakMessages.ts:82-90`）；非串流由 `src/claude/collectMessage.ts:74` 聚合成一個 Message。不使用 `claude-state/`。

### 3.6 官方 Codex CLI → `/backend-api/codex/*` 的 HTTP（1A）

```text
Time ────────────────────────────────────────────────────────────────────────────────────►

              | 1 request          | 2 match account  | 3 send           | 4 reply        |
--------------|--------------------|------------------|------------------|----------------|
Agent client  | GET /backend-api/  |                  |                  | bytes as       |
              | codex/models?...   |                  |                  | upstream sent  |
              | own token and      |                  |                  |                |
              | chatgpt-account-id |                  |                  |                |
--------------|--------------------|------------------|------------------|----------------|
agent-gateway |                    | path under       | get token        | pipe status,   |
              |                    | relay prefix?    | re-check id      | headers, bytes |
              |                    | account id =     | raw send: host,  |                |
              |                    | a home?          | authorization    |                |
              |                    | else 400         | 401: recover,    |                |
              |                    | account_mismatch | re-check, resend |                |
--------------|--------------------|------------------|------------------|----------------|
官方 BE       |                    |                  | response         |                |
--------------|--------------------|------------------|------------------|----------------|
```

- 帳號由 client 的 `chatgpt-account-id` 比對各 Codex home 的 account id，對不上回 `400 account_mismatch`，不呼叫上游（`src/upstream/codexRelay.ts:66-90`）。
- 每次送出前（包括 401 恢復後）都用這次的 credentials 再比一次 account id（`codexRelay.ts:94-132`）。headers 只換 `host`、`authorization`；`content-length` 只在 client 有送或有 body 時才填（`codexRelay.ts:134-174`）。
- 回應原樣轉回（`src/utils/rawRelay.ts:72`）。

### 3.7 官方 Codex CLI → `/backend-api/codex/responses` 的 WebSocket（1A）

```text
Time ──────────────────────────────────────────────────────────────────────────────────────►

              | 1 upgrade          | 2 handshake    | 3a 101: tunnel    | 3b non-101        |
--------------|--------------------|----------------|-------------------|-------------------|
Agent client  | GET /backend-api/  |                | prewarm frame     | 426: fall back to |
              | codex/responses    |                | incremental frame | HTTP POST         |
              | Upgrade: websocket |                | (previous_        | /responses (1A)   |
              |                    |                | response_id)      |                   |
--------------|--------------------|----------------|-------------------|-------------------|
agent-gateway | 15 s deadline      | match account  | write 101 as sent | same status,      |
              | starts             | get token      | pipe both sockets | headers, body     |
              |                    | re-check id    | no frame parsing  | (<= 16 KB)        |
              |                    | raw handshake: |                   |                   |
              |                    | host, auth     |                   |                   |
              |                    | 401: recover,  |                   |                   |
              |                    | re-handshake   |                   |                   |
--------------|--------------------|----------------|-------------------|-------------------|
官方 BE       |                    | 101 with       | frames end        |                   |
              |                    | turn-state     | to end            |                   |
              |                    | or 426 / 429   |                   |                   |
--------------|--------------------|----------------|-------------------|-------------------|
```

- 入口是 `src/server.ts:217` 的 `handleUpgrade`，轉送在 `src/upstream/codexRelay.ts:249` 的 `relayCodexUpgrade`。選帳號、取得 token、401 恢復、兩次握手都在同一個 15 秒期限內，逾時回 504（`codexRelay.ts:257-278`）。
- 3a：上游回 101 時，101 的 headers（含 `x-codex-turn-state`）原樣寫回，之後兩條 socket 直接對接（`codexRelay.ts:318-329`）。prewarm 與帶 `previous_response_id` 的增量 frame 都是 Codex 自己的 bytes（[Codex WebSocket 傳輸](CODEX_WEBSOCKET_TRANSPORT.md) §11.1）。
- 3b：上游回 426、429 等非 101 時，以相同的 status、headers 和 body（上限 16 KB）回給 client，連線用的 header 和 `content-length` 由 gateway 重設，不 upgrade；Codex 收到 426 會照官方規則改走 HTTP（`codexRelay.ts:311-316`，§11.2）。

### 3.8 token refresh 與 401 恢復

Codex（`src/auth/authManager.ts`）：

```text
Time ───────────────────────────────────────────────────────────────────────────────────────►

              | 1 before send     | 2 send          | 3 on 401            | 4 resend         |
--------------|-------------------|-----------------|---------------------|------------------|
Agent client  | any Codex         |                 |                     | response         |
              | request           |                 |                     |                  |
--------------|-------------------|-----------------|---------------------|------------------|
agent-gateway | getCredentials    | send with token | recoverUnauthorized | owner check:     |
              | expires < 5 min?  | owner check:    | token changed in    | 1A and prev-id   |
              | single-flight:    | 1A and prev-id  | memory or disk:     | resume only (a)  |
              | re-read auth.json | resume only (a) | use it              | resend once      |
              | rotated: adopt    |                 | else refresh        | 401 again: error |
              | else refresh      |                 | write auth.json     | (1A: as sent)    |
              | write auth.json   |                 |                     |                  |
--------------|-------------------|-----------------|---------------------|------------------|
官方 BE       |                   | 401             |                     | response         |
--------------|-------------------|-----------------|---------------------|------------------|
OAuth server  | refresh grant     |                 | refresh grant       |                  |
              | -> new tokens     |                 | -> new tokens       |                  |
--------------|-------------------|-----------------|---------------------|------------------|
```

- 到期判斷：access token 的 JWT 在 5 分鐘內到期；沒有到期時間時，`last_refresh` 超過 8 天（`src/auth/authFile.ts:35-42`）。refresh 是 single-flight，先重讀磁碟：refresh token 已被別人換掉就直接採用，否則 POST `auth.openai.com/oauth/token`，再寫回 `auth.json`（`authManager.ts:104-133`）。
- 暫時性失敗沿用舊 token；永久失敗回 401 並提示重新登入（`authManager.ts:135-146`）。
- 401 時先看記憶體和磁碟上的 token 是否已經換過，換過就直接用，否則才 refresh（`authManager.ts:148-158`）；之後只重送一次。
- (a) 身分檢查依路徑而定：1A 每次送出前（包括重送）比對 account id（§3.6）；`/v1/responses` 用 `previous_response_id` 續接時比對登入身分（§3.1）。一般的 Codex 自組請求（包括 Chat）沒有身分檢查：401 恢復後 home 換成新登入時，照常用新 token 重送（`src/responses/responseStore.ts:74-77`；[Codex 通訊差異](CODEX_UNSLOTH_PROTOCOL_DIFF.md) §4.1.1 註記 3）。

Claude（`src/claude/auth.ts`）：

```text
Time ────────────────────────────────────────────────────────────────────────────────────────►

              | 1 before send      | 2 send          | 3 on 401            | 4 resend         |
--------------|--------------------|-----------------|---------------------|------------------|
Agent client  | any Claude         |                 |                     | response         |
              | request            |                 |                     |                  |
--------------|--------------------|-----------------|---------------------|------------------|
agent-gateway | read credentials   | send with token | disk token differs: | account check:   |
              | every use          | account check:  | adopt               | 2a and count     |
              | expires < 5 min?   | 2a and count    | else forced         | only (a)         |
              | take refresh lock  | only (a)        | refresh (lock)      | resend once      |
              | re-read under lock |                 | CAS write           | 401 again: error |
              | busy: use disk     |                 |                     | (relay: as sent) |
              | else refresh       |                 |                     |                  |
              | CAS write          |                 |                     |                  |
--------------|--------------------|-----------------|---------------------|------------------|
官方 BE       |                    | 401             |                     | response         |
--------------|--------------------|-----------------|---------------------|------------------|
OAuth server  | refresh grant      |                 | refresh grant       |                  |
              | -> new tokens      |                 | -> new tokens       |                  |
--------------|--------------------|-----------------|---------------------|------------------|
```

- 每次使用都重讀 `.credentials.json`，到期前 5 分鐘才 refresh（`src/claude/auth.ts:371-382`）。refresh 先取得和官方相同的鎖（`<home>/.oauth_refresh.lock`，另加舊版鎖，`src/claude/refreshLock.ts`）；拿不到鎖就採用磁碟上的 token，不花掉一次性的 refresh token。
- 鎖內重讀後，才 POST `platform.claude.com/v1/oauth/token`；鎖在 POST 期間被搶走就中止。寫回用 compare-and-swap，最多試 3 次（`auth.ts:259-352`）。
- 401 時磁碟上的 token 已換就直接採用，否則強制 refresh（`auth.ts:384-388`）；之後只重送一次。
- (a) 只有 2a 與 count_tokens 會在每次送出前（包括 401 後的重送）比對 accountUuid（`src/claude/client.ts` 的 `postRawMessages`）。自組路徑和 2b 只在送出前讀一次 accountUuid，401 後的重送不再確認（`client.ts` 的 `sendWithAuthRecovery`）。

## 4. 重點對照：gateway 會改和不改的東西

| 項目 | Codex 自組（§3.1） | Claude 自組（§3.2） | 2a 與 count_tokens（§3.3、§3.4） | 2b 降轉（§3.5） | 1A HTTP（§3.6） | 1A WebSocket（§3.7） |
|---|---|---|---|---|---|---|
| body | **重組**：allowlist、`store:false`、完整 input | **重組**成 Messages | **不改**；只有帶相符的 alias（選出或綁定的 home）時換掉 `model` 的值，不符回 400 | **重組**成 Messages | **不改** | frame **不改** |
| headers | gateway 產生 | gateway 產生 | client 原樣；換 `host`、`authorization`、`content-length` | gateway 產生 | client 原樣；換 `host`、`authorization`，`content-length` 只在 client 有送或有 body 時填 | 握手原樣；換 `host`、`authorization` |
| UA | `codex_cli_rs/… agent-gateway` | 照官方格式，釘住 `2.1.299` | client 自己的 | 照官方格式，釘住 `2.1.299` | client 自己的 | client 自己的 |
| token | home 的 | home 的 | 同帳號 home 的 | home 的 | 同帳號 home 的 | 同帳號 home 的 |
| session | client 的 `prompt_cache_key`，或 gateway 算出 | gateway 算出 | client 的 | gateway 算出 | client 的 | client 的 |
| transport | `fetch` | `fetch` | raw `node:https` | `fetch` | raw `node:https` | raw 握手後 byte tunnel |
| 回應 | Responses SSE 原樣；Chat 翻譯 | 翻譯成 Responses 或 Chat | 原樣 | SSE bytes 原樣，或聚合 | 原樣 | 101 原樣，之後 bytes 原樣 |
| gateway 狀態 | `previous_response_id` LRU（只有 `/v1/responses`） | `claude-state/` 簽章檔；`/v1/responses` 另有 `previous_response_id` LRU | session 綁定 LRU | 無 | 無 | 無 |

UA 依據：`src/upstream/headers.ts:7`、`src/claude/client.ts` 的 `getClaudeUserAgent`、`src/constants.ts:73`；轉送路徑照轉 client 的 UA 是使用者核准的例外（[AGENTS.md](../AGENTS.md)）。

## 5. 來源

- 程式碼：
  - `src/server.ts`、`src/accounts.ts`
  - `src/responses/handleResponses.ts`、`normalizeResponsesRequest.ts`、`responseStore.ts`
  - `src/chat/handleChatCompletions.ts`
  - `src/upstream/codexClient.ts`、`headers.ts`、`codexRelay.ts`
  - `src/claude/handleClaude.ts`、`assembleRequest.ts`、`attribution.ts`、`client.ts`、`toResponsesEvents.ts`、`state.ts`、`relayMessages.ts`、`nativeMessages.ts`、`cloakMessages.ts`、`collectMessage.ts`、`auth.ts`、`refreshLock.ts`
  - `src/auth/authManager.ts`、`authFile.ts`
  - `src/utils/rawRelay.ts`、`http.ts`
- [使用指南](GUIDE.md)：「支援的 endpoint」「Client 設定範例」「Claude 帳號（Claude Code 登入）」「官方 Claude Code 連 gateway」「其他 Anthropic client（降轉）」「官方 Codex CLI 連 gateway」。
- [Claude 協定差異](CLAUDE_UPSTREAM_PROTOCOL_DIFF.md)：§4 憑證與 OAuth refresh、§6 請求成形、§7 Thinking 狀態、§13 原樣轉送、§14 降轉。
- [Codex 通訊差異](CODEX_UNSLOTH_PROTOCOL_DIFF.md)：§4.1 endpoint 與 headers、§6 auth 與重試。
- [Codex WebSocket 傳輸](CODEX_WEBSOCKET_TRANSPORT.md)：§11 透明轉送。
- [相似度落差](SIMILARITY_GAPS.md)：各路徑和官方的分數差異。
