**繁體中文** | [English](README.en.md) | [日本語](README.ja.md)

# <img src="assets/icon.png" width="40" alt="" /> agent-gateway

![agent-gateway 看板娘：薄荷青短髮的接待員坐在紅磚平台前，地下高柱大廳內的多層綠色管線交錯匯流](assets/banner.png)

agent-gateway 是一個跑在你電腦上的小轉接站。它讓其他 AI 工具借用你已登入的 ChatGPT（Codex）或 Claude Code 帳號。

把它想成萬用轉接頭：你的工具只會講 OpenAI 的「語言」，agent-gateway 幫它接到 Codex 或 Claude 的帳號。工具那邊只要把 OpenAI `base_url` 改成 `http://127.0.0.1:8765/v1`。

> 這是非官方用法。它連的是沒有公開的內部 API，隨時可能改變或被封鎖。用量算在你自己的 ChatGPT／Claude 方案額度裡。使用前請自己確認 OpenAI 與 Anthropic 的使用條款。

## 特點

| 特點 | 白話說明 |
|---|---|
| OpenAI 相容 | 支援 OpenAI 格式的工具，改 `base_url` 就能用 |
| 兩種帳號 | 同一個 gateway 可以同時接 ChatGPT（Codex）和 Claude Code 的訂閱登入 |
| 五個 endpoint | `/v1/models`、`/v1/responses`、`/v1/chat/completions`，支援串流和 tool calls；另有 `/v1/messages`：官方 Claude Code 原樣轉送，其他 client 走降轉；以及 `/backend-api/codex/*`，只支援官方 Codex CLI，原樣轉送（見[使用指南](docs/GUIDE.md)的「官方 Claude Code 連 gateway」、「其他 Anthropic client（降轉）」、「官方 Codex CLI 連 gateway」） |
| 多帳號 | 每個帳號一個 home，自動取名 `codex1`、`codex2`、`claude1`…；用 model 前綴選帳號，例如 `codex2/gpt-5.6-terra` |
| 照官方規矩連線 | request 格式、header、token 更新方式照官方 CLI 的做法，見下方「跟官方有多像？」 |
| 預設只在本機 | 預設只聽 `127.0.0.1`，不需要 API key；要給其他機器用時，用 `--host` 加 `AGENT_GATEWAY_API_KEY`（見[使用指南](docs/GUIDE.md)的「對外開放」） |
| 自動換 token | 遇到 401 會更新 token 再試一次；Claude 帳號和官方 CLI 共用同一把更新鎖，不會互搶 |
| 工具回合能接續 | Claude 的 thinking 簽章存在本機，重啟 gateway 後仍能接著做同一個工具回合 |
| 分級除錯 | `--debug 0`～`3` 控制要印多少細節；token 不會印出，prompt 會原文印出 |
| 單一執行檔 | 提供 Linux、macOS、Windows 執行檔與 AppImage，內含 Node.js，不用另外安裝 |

## 跟官方有多像？

把官方 CLI 想成「標準答案」，固定是 100 分。我們把每個連線細節（網址、header、登入方式……）當成一題，逐題對答案：一樣就得分，不一樣就不得分，看不出來的題目先不算。

| 上游 | 對象 | 分數（官方 = 100） | 比較版本 | 詳細報告 |
|---|---|---:|---|---|
| Claude | 官方 Claude Code | **100**（基準） | `references/claude-code` `9b4f0d6`＋native 2.1.299 | [Claude 相似度](docs/ANTHROPIC_CLAUDE_CODE_PROVIDER_SIMILARITY.md) |
| Claude | **agent-gateway** | **65** | `dfb0d6c` | 同上 |
| Claude | CLIProxyAPI | 42.78 | `references/CLIProxyAPI` v8.0.29（`5fc580b`） | 同上 |
| Claude | EasyCLIProxyAPI | 不另計分 | 桌面外殼，連線核心就是 CLIProxyAPI v8.0.29 | [EasyCLIProxyAPI 比對](docs/CLAUDE_EASYCLIPROXY_COMPARISON.md) |
| Codex | 官方 Codex CLI | **100**（基準） | `references/codex` `0d58012` | [Codex 通訊差異 §4.1.1](docs/CODEX_UNSLOTH_PROTOCOL_DIFF.md) |
| Codex | **agent-gateway** | **82.35** | `dfb0d6c` | 同上 |
| Codex | Unsloth | 35.29 | `references/unsloth` `1fdcdb5` | 同上 |
| Claude | Claude 原樣轉送（官方 Claude Code → `/v1/messages`） | **100**（另計：可判定 28 項全部符合，補齊後 93.33–100） | native 2.1.302 | [Claude 相似度 §3](docs/ANTHROPIC_CLAUDE_CODE_PROVIDER_SIMILARITY.md)、[Claude 通訊差異 §13](docs/CLAUDE_UPSTREAM_PROTOCOL_DIFF.md) |
| Codex | Codex 原樣轉送（官方 Codex → `/backend-api/codex/*`） | **100**（另計：17／17） | Codex CLI 0.163.0 | [Codex 通訊差異 §4.1.1](docs/CODEX_UNSLOTH_PROTOCOL_DIFF.md)、[Codex WebSocket 傳輸 §11](docs/CODEX_WEBSOCKET_TRANSPORT.md) |

- Claude 和 Codex 的題目不一樣：Claude 有 30 題、分 6 組；Codex 只比 17 個 endpoint／header。兩邊的分數不能互相比。
- 分數只看「連線方式像不像官方」。它不是品質分數，也不保證不會被認出是非官方工具。
- Codex 路徑的 User-Agent 刻意寫自己的名字 `agent-gateway`，所以那一題不得分。
- Codex 的最嚴格算法：把官方另外 8 個條件式 header 也算進去（兩邊都沒送），gateway 為 56、Unsloth 為 24。
- 2b 降轉（其他 Anthropic client → `/v1/messages`）沿用 Claude 的 65 分基準：它和 `/v1/responses` 的 Claude 路徑共用同一個組裝層。
- 兩條原樣轉送的 100 是另計的：上游請求由官方 client 自己產生，可判定的項目都符合官方。Claude 用同一份 30 項 rubric，以 client 實際使用的 native 2.1.302 為基準：可判定的 28 項全部符合，D5（TLS 指紋）和 F2（完整 401 策略）因官方規則未確認維持未知，30 項補齊後的範圍是 93.33–100。Codex 是 17／17。這是只對官方計分，不是和 CLIProxyAPI 取共同集合的算法，不能直接和 65／42.78 比較。
- 100 沒有涵蓋：TLS 與 HTTP 實作不同（gateway 用 Node `https`，官方是 Bun、reqwest、tungstenite）；token 是同帳號的另一份憑證；`host`、`content-length` 是這段連線的值；Claude 的 count_tokens 只轉送已綁定的 session。分數不代表行為完全等同官方。
- 評估日期與基準：原有評分是 2026-10-17，Claude 官方證據沿用 native 2.1.299 的記錄；兩條原樣轉送列是 2026-10-18 新增，基準是 native 2.1.302 和 Codex CLI 0.163.0（Claude 的 A1–A4 仍沿用 2.1.299 的判定）。
- 2026-10-22 更新：三個上游參考 pin 已更新並對齊兩項 Claude 與一項 Codex 行為，上方分數與歷史基準不變，細節見 [上游更新與對齊報告](docs/UPSTREAM_UPDATE_2026-10-22.md)。

## 快速開始

1. 下載 [GitHub Releases](https://github.com/scott1028/agent-gateway/releases) 中對應平台的執行檔，或用原始碼（需要 Node.js 22+）。
2. 用官方 CLI 登入到一個**專用** home。不要直接用平常的 `~/.codex`，以免兩邊互搶 token。
3. 啟動 gateway，並告訴它 home 在哪裡。gateway 沒有預設 home。

```bash
# Codex（ChatGPT 帳號）
mkdir -p ~/.agent-gateway && chmod 700 ~/.agent-gateway
CODEX_HOME=~/.agent-gateway codex login        # 沒有瀏覽器時加 --device-auth

./agent-gateway-<版本>-linux-x64 --codex-home ~/.agent-gateway
# 或從原始碼：npm install && npm run build && npm start -- --codex-home ~/.agent-gateway
# agent-gateway listening on http://127.0.0.1:8765/v1
```

```bash
# Claude（Claude Code 訂閱帳號），可以和 Codex 一起掛
mkdir -p ~/.agent-gateway-claude && chmod 700 ~/.agent-gateway-claude
CLAUDE_CONFIG_DIR=~/.agent-gateway-claude claude     # 進入後輸入 /login

./agent-gateway-<版本>-linux-x64 --codex-home ~/.agent-gateway --claude-home ~/.agent-gateway-claude
```

```bash
# 快速啟動：自動掛上 $HOME 下已登入的 .codex、.codex-*、.claude、.claude-*
./agent-gateway-<版本>-linux-x64 --auto
#   codex1 -> /home/you/.codex
#   claude1 -> /home/you/.claude
```

`--auto` 會用到平常 `codex` CLI 的 home。gateway 執行期間不要用同一個 home 跑 `codex`，否則其中一邊會被登出。細節見[使用指南](docs/GUIDE.md)的「自動掃描 home（`--auto`）」。

預設開啟 `--relay-fallback=degrade`（用 `--relay-fallback=reject` 關閉）：官方 relay 帳號／形狀檢查失敗時改由 gateway 自組，不用重開 CLI；相似度基準為 Claude 65／Codex 82.35，不是 100。推理記錄重啟後清空，Codex 426 後該 session 只走 HTTP；WS alias 限制與未驗證的 R1 風險見[使用指南](docs/GUIDE.md#relay-檢查失敗時降轉--relay-fallback)。

checksum 驗證、macOS／Windows 首次執行提示、AppImage 用法、環境變數與所有選項，請看[使用指南](docs/GUIDE.md)。從舊版 codex-proxy 升級的人，先看指南裡的搬遷步驟。

## 接上你的工具

沒設定 `AGENT_GATEWAY_API_KEY` 時，`apiKey` 填什麼都可以，gateway 不檢查；有設定時要填同一把 key。

```js
// OpenAI SDK
const client = new OpenAI({ baseURL: 'http://127.0.0.1:8765/v1', apiKey: 'unused' });
```

```bash
# aider
aider --model openai/codex1/gpt-5.6-terra --openai-api-base http://127.0.0.1:8765/v1 --openai-api-key unused

# Codex 本身
codex exec -c 'model_providers.agent-gateway={ name = "agent-gateway", base_url = "http://127.0.0.1:8765/v1", wire_api = "responses" }' \
  -c model_provider=agent-gateway -m codex1/gpt-5.6-terra "your prompt"
```

## 要注意的事

- 一個 home 只給一個 gateway 用，也不要同時拿它跑 `codex`。refresh token 只能用一次，同時更新會互相踢掉。
- `previous_response_id` 由 gateway 在本機處理：已完成的 response 存在記憶體（最多 1000 筆，重啟就沒了），收到時展開成完整 input 再送上游，上游看到的請求和送完整對話完全相同。`store:false` 的 response 不保存；`instructions`、`tools` 不會沿用，每次要重送；必須用同一個帳號的 model 續接，同一個 home 換登入後，舊的 id 也不能續接。
- 額度用完回 429；方案不含 Codex 回 403；token 救不回來時回 401，並提示重新登入的指令。
- 更多限制與轉換規則見[使用指南](docs/GUIDE.md)。

## 更多文件

| 文件 | 內容 |
|---|---|
| [使用指南](docs/GUIDE.md) | 完整設定、環境變數、除錯等級、多帳號、Claude 細節、轉換規則、已知限制、搬遷 |
| [開發與打包](docs/DEVELOPMENT.md) | 本機建置與驗證、AppImage、GitHub 發佈、專案檢查 |
| [Claude 相似度](docs/ANTHROPIC_CLAUDE_CODE_PROVIDER_SIMILARITY.md) | 官方 Claude Code 為基準的 30 項評分 |
| [Claude 通訊差異](docs/CLAUDE_UPSTREAM_PROTOCOL_DIFF.md) | Claude 上游的 header、OAuth、SSE 與偏離項目 |
| [EasyCLIProxyAPI 比對](docs/CLAUDE_EASYCLIPROXY_COMPARISON.md) | EasyCLIProxyAPI／CLIProxyAPI 串接與憑證評估 |
| [Codex 通訊差異](docs/CODEX_UNSLOTH_PROTOCOL_DIFF.md) | Codex 上游與 Unsloth、官方 Codex CLI 的對照與相似度 |
| [Codex WebSocket 傳輸](docs/CODEX_WEBSOCKET_TRANSPORT.md) | 官方 Codex CLI 的轉送路徑（`/backend-api/codex/*`）已實作 WebSocket；OpenAI 相容路徑（`/v1/responses`）仍走 HTTP，方案 B（gateway 自己管理上游 WebSocket）沒有實作。另含評估、選項與風險 |
| [相似度落差與改進](docs/SIMILARITY_GAPS.md) | 「跟官方有多像？」各分數為什麼不是 100、落差從哪裡來、可以怎麼改進（試算不改正式分數） |
| [運作流程圖](docs/ARCHITECTURE_FLOWS.md) | agent client、agent-gateway、官方 BE 三方的路由判斷與 swimlane 流程圖 |
| [看板娘與 icon](assets/README.md) | 圖片素材、ComfyUI workflow 與重做步驟 |

## 開發

```bash
npm run typecheck
npm test
```

`npm run poc` 會真的呼叫上游並用掉額度，只在改了上游行為後手動執行。細節見[開發與打包](docs/DEVELOPMENT.md)。
