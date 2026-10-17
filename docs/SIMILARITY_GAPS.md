# 相似度分數的落差與改進方向

撰寫日期：2026-10-18。本文件解釋 README「跟官方有多像？」表裡的分數為什麼不是 100、落差從哪裡來，以及可以怎麼改進。**這裡只做解釋和建議，不改任何分數或標記。** 分數一律以 [Claude 相似度報告](ANTHROPIC_CLAUDE_CODE_PROVIDER_SIMILARITY.md) 和 [Codex 通訊差異](CODEX_UNSLOTH_PROTOCOL_DIFF.md) §4.1.1 為準。文中標「試算」的數字都不是正式分數。

## 1. 結論

| 組別 | 路徑 | 分數（官方 = 100） | 來源 |
|---|---|---:|---|
| 自組路徑 | Claude：`/v1/responses`、`/v1/chat/completions`，以及共用組裝層的 2b 降轉 | **65** | [Claude 相似度](ANTHROPIC_CLAUDE_CODE_PROVIDER_SIMILARITY.md) §3 |
| 自組路徑 | Codex：`/v1/responses`、`/v1/chat/completions` | **82.35** | [Codex 通訊差異](CODEX_UNSLOTH_PROTOCOL_DIFF.md) §4.1.1 |
| 原樣轉送（另計） | 官方 Claude Code → `/v1/messages` | **100**（可判定 28 項，補齊後 93.33–100） | [Claude 相似度](ANTHROPIC_CLAUDE_CODE_PROVIDER_SIMILARITY.md) §3「2a 原樣轉送的另計分數」 |
| 原樣轉送（另計） | 官方 Codex → `/backend-api/codex/*` | **100**（17／17） | [Codex 通訊差異](CODEX_UNSLOTH_PROTOCOL_DIFF.md) §4.1.1 |
| 參考 | CLIProxyAPI（Claude） | 42.78 | [Claude 相似度](ANTHROPIC_CLAUDE_CODE_PROVIDER_SIMILARITY.md) §3 |
| 參考 | Unsloth（Codex） | 35.29 | [Codex 通訊差異](CODEX_UNSLOTH_PROTOCOL_DIFF.md) §4.1.1 |

**一句話：** 原樣轉送的上游請求由官方 client 自己產生，gateway 只換 token，所以可判定的項目都符合官方；自組路徑的請求由 gateway 依規則重組，凡是 gateway 的規則和官方不同，就會扣分。

- Claude 的 65 和 CLIProxyAPI 取共同集合計分；轉送的 100 只對官方計分，基準版本也不同，所以兩者不能直接比較（[Claude 相似度](ANTHROPIC_CLAUDE_CODE_PROVIDER_SIMILARITY.md) 開頭摘要）。
- 100 不代表行為完全等同官方。TLS 與 HTTP 實作、同帳號的另一份 token、`host` 與 `content-length`，以及 count_tokens 只轉送已綁定的 session，都不在分數內（[README](../README.md)「跟官方有多像？」的註記）。

## 2. 怎麼讀分數

- **標記**：`1` 符合官方、`0` 已知不同、`?` 證據不足。`?` 不是零分（[Claude 相似度](ANTHROPIC_CLAUDE_CODE_PROVIDER_SIMILARITY.md) §2）。
- **Claude**：30 項分成 A–F 六組，每組占總分的 1/6。每組只用「官方、gateway、CLIProxyAPI 三方都已確認」的共同集合，組內每項等權重。目前共同集合是 25 項，公式見 §2，各組分數見 §3。
- **Codex**：§4.1 主表的 17 列 endpoint／header，每列 `1` 或 `0`，沒有 `?`。gateway 14／17 = 82.35。最嚴格算法把官方另外 8 個條件式 header 也算進去，gateway 是 14／25 = 56（[Codex 通訊差異](CODEX_UNSLOTH_PROTOCOL_DIFF.md) §4.1.1）。
- **評的是行為相似度**：不是程式碼文字相似度、測試覆蓋率、API 成功率或品質評分（[Claude 相似度](ANTHROPIC_CLAUDE_CODE_PROVIDER_SIMILARITY.md) 開頭）。分數高也不保證不會被認出是非官方工具（[README](../README.md)、[Codex 通訊差異](CODEX_UNSLOTH_PROTOCOL_DIFF.md) §4.1 判讀）。

## 3. Claude 自組路徑（65）的扣分明細

原因類型分四種：**刻意設計**、**使用者核准的例外**、**尚未實作**、**技術上做不到**（或需要 gateway 拿不到的資訊）。官方規則、兩邊的做法和標記都取自 [Claude 相似度](ANTHROPIC_CLAUDE_CODE_PROVIDER_SIMILARITY.md) §4；`src/` 的行號是目前的程式碼。

### 3.1 標 `0` 的 10 項

| ID | 官方 → gateway | 原因類型與依據 | 改進選項 | 規模 | 風險 |
|---|---|---|---|---|---|
| A5 | 官方：CLI 為每個會話配置隨機 session UUID。gateway：依輸入內容雜湊出固定的 id（[handleClaude.ts:91](../src/claude/handleClaude.ts)） | **刻意設計**：同一段對話的 id 要穩定，prompt cache 才能跨輪命中（[normalizeResponsesRequest.ts:37](../src/responses/normalizeResponsesRequest.ts) 的註解；[協定差異](CLAUDE_UPSTREAM_PROTOCOL_DIFF.md) §9 第 5 點） | 每段對話配一個隨機 UUID。OpenAI 相容請求是無狀態的，gateway 得另存「對話 → UUID」的對應 | 中 | 對應遺失時 session 會換掉，cache 可能失效。不違反 AGENTS.md |
| B1 | 官方：一般 system builder 保留頂層 system。gateway：把 caller 指令移到第一個 user 回合後的 `role:system`（[assembleRequest.ts:155-158](../src/claude/assembleRequest.ts)） | **使用者核准的例外**：使用者指定的修正 `6e07ec6`（[Claude 相似度](ANTHROPIC_CLAUDE_CODE_PROVIDER_SIMILARITY.md) §1 表、§5）。修正前，完整 OpenCode 請求回 HTTP 400；修正後回 200（[EasyCLIProxyAPI 比對](CLAUDE_EASYCLIPROXY_COMPARISON.md) 開頭） | 改回頂層 system | 小 | OpenCode 這類請求可能再被上游拒絕。**需要使用者決策，也要先做 PoC** |
| B5 | 官方：依訂閱者、query allowlist、overage 等條件決定要不要帶 `ttl:"1h"`。gateway：一律不帶 ttl（[assembleRequest.ts:145](../src/claude/assembleRequest.ts)） | **尚未實作**：[協定差異](CLAUDE_UPSTREAM_PROTOCOL_DIFF.md) §8.2 記錄 gateway「沒有實作 `Whe` 的訂閱者/overage/allowlist 情境」。這些條件 gateway 拿得到多少，尚未查證 | 實作官方的 1h 選用條件 | 大 | 條件判斷錯會改變 cache 行為；上游 cache 命中尚未實測（§8.2）。**要先做 PoC** |
| C1 | 官方：動態能力抓取被關閉，不額外呼叫 `/v1/models`。gateway：`/v1/models` 和每個請求的 `findModel` 都可能呼叫上游，有 5 分鐘快取（[handleClaude.ts:67](../src/claude/handleClaude.ts)、[models.ts](../src/claude/models.ts)） | **刻意設計**（依現有用途推論，程式註解和報告都沒有寫明原始的決策理由）：目錄值目前用在 `max_tokens` 預設值（[assembleRequest.ts:132](../src/claude/assembleRequest.ts)；[協定差異](CLAUDE_UPSTREAM_PROTOCOL_DIFF.md) §6 `max_tokens` 列）和 `/v1/models` 清單（§5「gateway 保留這項額外請求」） | 請求成形只用 pinned 能力表（[modelMetadata.ts](../src/claude/modelMetadata.ts)），清單也改由 pinned 表產生 | 中 | pinned 表沒有的新模型會變成未知模型：沒帶 `max_output_tokens` 時回 400（§6）。清單也可能和帳號實際可用的模型不同。**需要使用者決策** |
| C4 | 官方：thinking 開啟又指定具名工具時，把 tool_choice 降為 `auto`。gateway：回 400（[assembleRequest.ts:122-131](../src/claude/assembleRequest.ts)） | **刻意設計**：不悄悄改寫 caller 的語意（[協定差異](CLAUDE_UPSTREAM_PROTOCOL_DIFF.md) §9 第 7 點；同一段程式碼的註解） | 照官方降為 `auto` | 小 | caller 要求強制呼叫工具，結果卻可能沒有呼叫，語意改變。**需要使用者決策** |
| E2 | 官方：連續的非空 `signature_delta` 以最新值覆寫。gateway：串接到既有 signature 後面（[toResponsesEvents.ts:348](../src/claude/toResponsesEvents.ts)） | **尚未實作**（[Claude 相似度](ANTHROPIC_CLAUDE_CODE_PROVIDER_SIMILARITY.md) §4 E 的說明：「本文件沒有修改 E2 的實作」）。2b 的非串流聚合已經改用覆寫（[collectMessage.ts:48](../src/claude/collectMessage.ts)） | 改成覆寫 | 小 | 低。真實上游會不會送出多個 signature delta，尚未證明（§4 E） |
| E4 | 官方：可處理 `server_tool_use` 與 `web_search_tool_result`。gateway：遇到這些區塊直接回錯誤（[toResponsesEvents.ts:76-93](../src/claude/toResponsesEvents.ts)）；請求端的非 function 工具也回 400（[協定差異](CLAUDE_UPSTREAM_PROTOCOL_DIFF.md) §10） | **尚未實作** | 請求端接受 server tools，回應端轉成 Responses 和 Chat 的輸出 | 大 | 要另外設計 OpenAI 相容格式的對應輸出。**需要使用者決策，也要先做 PoC** |
| E5 | 官方：可依設定呈現 thinking 或 summary。gateway：thinking 只保存供回放，reasoning 輸出沒有文字（[toResponsesEvents.ts:9](../src/claude/toResponsesEvents.ts) 的 `TODO`、`:342`） | **尚未實作** | 輸出 reasoning summary 事件 | 中 | 要決定對外的格式。**需要使用者決策** |
| F3 | 官方：mid-system 被拒時，有移除 system role 再重試的分支。gateway：沒有自動 fallback，只有 401 恢復（[client.ts](../src/claude/client.ts) 的 `sendWithAuthRecovery`） | **尚未實作** | 偵測到這種拒絕時，移除 mid-system 重試一次 | 中 | 會多送一次推論請求；拒絕回應的形狀要先用 PoC 確認。F3 目前不在共同集合（CPA 為 `?`），改了也不影響 65，只影響 30 項範圍（§3 未知上下界） |
| F4 | 官方：簽章狀態保存在 CLI transcript。gateway：自有的原子 JSON 檔，沒有自動過期（[state.ts:298](../src/claude/state.ts)） | **技術上做不到**：OpenAI 相容 client 不會把簽章區塊帶回，gateway 也沒有官方 transcript，只能自己保存（[協定差異](CLAUDE_UPSTREAM_PROTOCOL_DIFF.md) §7 開頭） | 無法變成 `1`。能做的只有加上過期或清理政策 | 小 | 清掉還沒結束的 tool 回合，之後的續接會回 400（§7「比對」） |

### 3.2 標 `?` 的 3 項

[Claude 相似度](ANTHROPIC_CLAUDE_CODE_PROVIDER_SIMILARITY.md) §6：官方基準本身還沒確認 D4、D5、F2，所以 gateway 和 CLIProxyAPI 在這三項都記 `?`。

| ID | 為什麼未知 | 要取得什麼證據才能判定 |
|---|---|---|
| D4 | 已找到 native 的 CCH seed，但完整的正規化規則還沒逐一證明（§4 D 列、§7 `[O-D]`） | 同版本完整的 CCH 規則，或可以對照的官方輸出向量（§6「取得同版本完整 CCH／wire 證據」） |
| D5 | 官方完整的 TLS／HTTP wire 指紋還沒確認（§4 D 列） | 同版本官方 client 的實際 TLS／HTTP 擷取，拿來對照 gateway 的 Node `fetch` |
| F2 | 官方完整的 401 分支和外層策略還沒確認（§4 F 列）。gateway 有 401 後重讀或 refresh 再重送一次的路徑 | 官方 401 處理的完整路徑，包括外層重試（§6「完整錯誤恢復與 transport 路徑」） |

### 3.3 試算：做了哪些改進，分數會變成多少

> **以下全部是試算，不是正式分數。** 公式照 [Claude 相似度](ANTHROPIC_CLAUDE_CODE_PROVIDER_SIMILARITY.md) §2：每組的分數是共同集合裡 `1` 的比例，總分 = (100 / 6) × 六組分數的和。CLIProxyAPI 的標記和共同集合都假設不變。「30 項範圍」照 §3「未知項目的上下界」的算法，把 3 項 `?` 全部算 0 或全部算 1。

| 情境 | 假設改成 `1` 的項目 | A、B、C、D、E、F 各組 | 試算總分 | 30 項範圍（試算） |
|---|---|---|---:|---:|
| 現況（正式） | — | 4/5、3/5、3/5、3/3、2/5、1/2 | 65 | 56.67–66.67 |
| 試算 1 | E2 | 4/5、3/5、3/5、3/3、3/5、1/2 | 68.33 | 60.00–70.00 |
| 試算 2 | E2、C1、E5 | 4/5、3/5、4/5、3/3、4/5、1/2 | 75.00 | 66.67–76.67 |
| 試算 3 | 試算 2 加上 B5、E4 | 4/5、4/5、4/5、3/3、5/5、1/2 | 81.67 | 73.33–83.33 |

- 例：試算 2 =（100 / 6）×（4/5 + 3/5 + 4/5 + 3/3 + 4/5 + 1/2）= 75。
- F3 不在共同集合裡，改了不影響總分。試算 3 再加上 F3，30 項範圍變成 76.67–86.67（試算）。
- A5、B1、C4 是刻意設計或使用者核准的做法，F4 技術上做不到，所以這四項沒有放進試算。

## 4. Codex 自組路徑（82.35）的扣分明細

官方規則和兩邊的證據取自 [Codex 通訊差異](CODEX_UNSLOTH_PROTOCOL_DIFF.md) §4.1 與 §4.1.1。

| 列 | 官方 → gateway | 原因類型與依據 | 改進選項 | 規模 | 風險 |
|---|---|---|---|---|---|
| 5 `originator` | 官方：互動 TUI 用 `codex-tui`，`codex exec` 用 `codex_exec`，底層 fallback 是 `codex_cli_rs`。gateway：固定 `codex_cli_rs`（[constants.ts:4](../src/constants.ts)） | **刻意設計**：依 [AGENTS.md](../AGENTS.md) 的身分規則（「we do not pretend to be someone else」），gateway 不假扮成任何官方入口。官方的值取決於入口（TUI、exec，或 app-server 的 client name，§4.1「入口／override 與 UA」），而任意 OpenAI 相容 client 對應哪一個入口，也沒有依據可判斷。技術上可以送別的字串，這是政策上的選擇 | 改送某個官方入口的值，例如 `codex_exec` | 小 | 等於自稱是某個官方入口，違反 AGENTS.md 的身分規則。**需要使用者決策** |
| 6 User-Agent | 官方：`<originator>/<version> (<OS>; <arch>) <terminal>`。gateway：同樣格式，但結尾是 `agent-gateway`（[headers.ts:7](../src/upstream/headers.ts)） | **刻意設計**：[AGENTS.md](../AGENTS.md)「Our proxy still says its own name (`agent-gateway`) in the User-Agent」。Claude 自組路徑的 UA 照抄官方，是使用者核准的例外（[協定差異](CLAUDE_UPSTREAM_PROTOCOL_DIFF.md) §9 第 1 點）。兩條轉送路徑照轉 client 自己的 UA，也是使用者核准的例外（[AGENTS.md](../AGENTS.md) 的 relay paths 段落） | 拿掉 `agent-gateway` 結尾 | 小 | 違反 AGENTS.md 的現行規則。**要使用者先改規則** |
| 16 `x-codex-turn-state` | 官方：自己從上游回應擷取 turn-state，同一個 turn 的後續 HTTP 請求再帶回（§4.1 表）。gateway：只轉送 caller 送來的同名 header（[headers.ts:33](../src/upstream/headers.ts)、[handleResponses.ts:91](../src/responses/handleResponses.ts)）。上游回應的 `x-codex-*` header 會轉回 client（[constants.ts:48-49](../src/constants.ts)、[http.ts:89-97](../src/utils/http.ts)），但 gateway 自己不保存，也不會自己帶回 | **尚未實作** | gateway 自己擷取 turn-state，在同一個 turn 帶回 | 大 | OpenAI 相容請求沒有明確的 turn 邊界，要另外設計「哪些請求屬於同一個 turn」。**要先做 PoC** |

**最嚴格算法的 8 個條件式 header**（§4.1「官方額外 headers」表）：`x-codex-beta-features`、`x-codex-window-id`／`x-codex-turn-metadata`、`x-codex-parent-thread-id`／`x-openai-subagent`、`x-openai-memgen-request`、`x-oai-attestation`、`x-openai-internal-codex-residency`、`OpenAI-Organization`／`OpenAI-Project`、`Content-Encoding: zstd`。官方只在特定條件下才送，gateway 和 Unsloth 都沒送，全部算 `0` 就得到 56／24。subagent、memgen 這類分支不會出現在一般路徑，所以主分數沒有算進去（§4.1.1）。

## 5. rubric 以外、但已知的落差

以下都不計分，但讀者應該知道：

- **自組路徑的 HTTP 送出方式**：Claude 自組路徑用 `fetch` 送出（[client.ts](../src/claude/client.ts) 的 `postMessages`）。同一個檔案的註解寫明 `fetch` 會加上 `accept-language`、`sec-fetch-mode`、自動解壓 gzip、跟隨 redirect，並重新編碼 query，所以 2a 的轉送改用 raw transport（`sendRawMessages` 上方的註解；[協定差異](CLAUDE_UPSTREAM_PROTOCOL_DIFF.md) §13.3）。Codex 自組路徑同樣用 `fetch`（[codexClient.ts:66](../src/upstream/codexClient.ts)）；Codex 報告不把 library 自動產生的 header 當成已擷取的封包（[Codex 通訊差異](CODEX_UNSLOTH_PROTOCOL_DIFF.md) §4.1 開頭）。
- **TLS 與 HTTP 實作**：送出的一律是 gateway 的 Node 實作，不是官方 client 的 runtime；TLS 指紋沒有比對過（[協定差異](CLAUDE_UPSTREAM_PROTOCOL_DIFF.md) §13.3、[Codex WebSocket 傳輸](CODEX_WEBSOCKET_TRANSPORT.md) §11.3、Claude 的 D5）。
- **還沒擷取的模式**：官方 Claude Code 只擷取過 `claude -p`（sdk-cli），互動模式和 helper 請求（例如 title、quota）還沒擷取（[協定差異](CLAUDE_UPSTREAM_PROTOCOL_DIFF.md) §13.4）。
- **Codex 的 OpenAI 相容路徑仍是 HTTP 全量傳送**：每輪都送 `store:false` 加完整 input；官方預設走 WebSocket 增量傳送，gateway 管理上游 WebSocket 的方案 B 沒有實作（[Codex WebSocket 傳輸](CODEX_WEBSOCKET_TRANSPORT.md) §1、§8）。
- **2b 降轉的內容不是官方產生的**：形狀和自組路徑相同，但 tools、system 文字、messages 都是 client 的（[協定差異](CLAUDE_UPSTREAM_PROTOCOL_DIFF.md) §14.3）。

## 6. 改進路線建議

依投入與效益排序。「使用者決策」指要先由使用者決定產品行為；「PoC」指要先用真實上游確認，例如 `scripts/poc.ts` 這類 live check（[AGENTS.md](../AGENTS.md)）。

| 順序 | 項目 | 效益 | 使用者決策 | PoC |
|---:|---|---|---|---|
| 1 | **已經是 100**：官方 Claude Code 或官方 Codex 搭配原樣轉送（[使用指南](GUIDE.md)「官方 Claude Code 連 gateway」「官方 Codex CLI 連 gateway」） | 可判定的項目全部符合官方。已在 2026-10-18 用真實上游端對端測試通過（[協定差異](CLAUDE_UPSTREAM_PROTOCOL_DIFF.md) §13.4、[Codex WebSocket 傳輸](CODEX_WEBSOCKET_TRANSPORT.md) §11.4） | 不需要 | 已完成 |
| 2 | **小改動**：E2 改成覆寫 signature | Claude +3.33（試算 1） | 不需要 | 不需要；mock 測試即可，但真實上游的多個 signature delta 仍未證明 |
| 2 | **小改動**：Claude 自組路徑改用 raw transport（和 2a 共用 [rawRelay.ts](../src/utils/rawRelay.ts)） | 不影響分數（rubric 以外，§5），但少送 `fetch` 加的 header | 需要：`--debug 1`／`3` 的上游紀錄只包住 `fetch`（[使用指南](GUIDE.md)「官方 Claude Code 連 gateway」的轉送行為），要決定改用 raw 後怎麼記錄 | 建議做 |
| 3 | **中改動**：E5 輸出 thinking summary（[toResponsesEvents.ts:9](../src/claude/toResponsesEvents.ts) 已有 `TODO`） | E 組 +1 項 | 需要：決定對外格式 | 建議做 |
| 3 | **中改動**：C1 不再額外呼叫 `/v1/models` | C 組 +1 項（和 E2、E5 一起是試算 2 的 75） | 需要：決定未知模型怎麼處理 | 不需要 |
| 4 | **大改動或高風險**：B5 的 1h cache 選用條件 | B 組 +1 項 | 需要 | 需要（cache 命中尚未實測） |
| 4 | **大改動或高風險**：E4 server tools（Web Search） | E 組 +1 項（和 B5 一起是試算 3 的 81.67） | 需要：決定 OpenAI 相容的輸出格式 | 需要 |
| 4 | **大改動或高風險**：Codex turn-state 自己維護 | Codex +1 列，15／17 = 88.24（試算） | 需要 | 需要 |

不建議為了分數改的項目：A5、C4（刻意設計）、B1（使用者核准的例外，改回去有 OpenCode 被拒的風險）、F4（技術上做不到）、Codex 第 5、6 列（刻意設計，改了會違反 AGENTS.md 的身分規則）。

## 7. 來源

- [Claude 相似度報告](ANTHROPIC_CLAUDE_CODE_PROVIDER_SIMILARITY.md)：開頭摘要、§1（固定版本與 2026-10-17、2026-10-18 重評註記）、§2 計分演算法、§3 計算結果與未知上下界、§3「2a 原樣轉送的另計分數」、§4 30 項明細、§5、§6 證據限制、§7 來源索引。native offset 一律見該報告，本文不重貼。
- [Codex 通訊差異](CODEX_UNSLOTH_PROTOCOL_DIFF.md)：§4.1 主表、「官方額外 headers」表、「入口／override 與 UA」、§4.1.1 17 列評分與註記。
- [Claude 協定差異](CLAUDE_UPSTREAM_PROTOCOL_DIFF.md)：§5、§6、§7、§8.2、§9、§10、§13.3、§13.4、§14.3。
- [Codex WebSocket 傳輸](CODEX_WEBSOCKET_TRANSPORT.md)：§1、§8、§11.3、§11.4。
- [EasyCLIProxyAPI 比對](CLAUDE_EASYCLIPROXY_COMPARISON.md) 開頭：B1 適配的 OpenCode 實測。
- [AGENTS.md](../AGENTS.md)：UA 規則與轉送、降轉的例外。
- 比較基準（沿用上述報告）：
  - Claude 自組路徑：`references/claude-code` `9b4f0d6` 加上 native 2.1.299 已記錄的證據；2a 原樣轉送用 native 2.1.302。
  - CLIProxyAPI：`references/CLIProxyAPI` `5fc580b`（v8.0.29）。
  - Codex 自組路徑：`references/codex` `0d58012`；1A 原樣轉送用 Codex CLI 0.163.0。
  - Unsloth：`references/unsloth` `1fdcdb5`。
