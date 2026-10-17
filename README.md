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
| 三個 endpoint | `/v1/models`、`/v1/responses`、`/v1/chat/completions`，支援串流和 tool calls |
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
| Claude | **agent-gateway** | **65** | `d6ce854` | 同上 |
| Claude | CLIProxyAPI | 42.78 | `references/CLIProxyAPI` v8.0.29（`5fc580b`） | 同上 |
| Claude | EasyCLIProxyAPI | 不另計分 | 桌面外殼，連線核心就是 CLIProxyAPI v8.0.29 | [EasyCLIProxyAPI 比對](docs/CLAUDE_EASYCLIPROXY_COMPARISON.md) |
| Codex | 官方 Codex CLI | **100**（基準） | `cc7ba33` | [Codex 通訊差異 §4.1.1](docs/CODEX_UNSLOTH_PROTOCOL_DIFF.md) |
| Codex | **agent-gateway** | **82.35** | `91c7d18` | 同上 |
| Codex | Unsloth | 35.29 | `9706a2b` | 同上 |

- Claude 和 Codex 的題目不一樣：Claude 有 30 題、分 6 組；Codex 只比 17 個 endpoint／header。兩邊的分數不能互相比。
- 分數只看「連線方式像不像官方」。它不是品質分數，也不保證不會被認出是非官方工具。
- Codex 路徑的 User-Agent 刻意寫自己的名字 `agent-gateway`，所以那一題不得分。
- Codex 的最嚴格算法：把官方另外 8 個條件式 header 也算進去（兩邊都沒送），gateway 為 56、Unsloth 為 24。
- Codex 分數用的是報告當時的版本。目前 submodule 已更新為 `references/codex` `0d58012`、`references/unsloth` `1fdcdb5`，需要重新核對。

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
- 不支援 `previous_response_id`，每次都要送完整對話。
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
| [看板娘與 icon](assets/README.md) | 圖片素材、ComfyUI workflow 與重做步驟 |

## 開發

```bash
npm run typecheck
npm test
```

`npm run poc` 會真的呼叫上游並用掉額度，只在改了上游行為後手動執行。細節見[開發與打包](docs/DEVELOPMENT.md)。
