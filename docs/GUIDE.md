# agent-gateway 使用指南

完整的設定、行為與限制說明。快速開始請看 [README](../README.md)。

## 支援的 endpoint

| Endpoint | 說明 |
|---|---|
| `GET /v1/models` | 模型清單（Codex 只列 `visibility=list`、依 priority 排序；Claude 列上游 `/v1/models`；id 帶帳號 prefix，見「多帳號」） |
| `POST /v1/responses` | Codex 帳號近似 passthrough；`stream:true` 時原樣轉送 SSE，`stream:false` 時聚合成單一回應。Claude 帳號則把原生 Messages SSE 轉成完整 Responses 事件 |
| `POST /v1/chat/completions` | 轉成 Responses API；支援串流、`stream_options.include_usage`、tools / tool_calls（兩個上游都支援） |
| `POST /v1/messages` | 官方 Claude Code：原樣轉送給 Claude 上游，只換成 gateway home 的 token（見「官方 Claude Code 連 gateway」）；其他 Anthropic client 走降轉，由 gateway 重組成官方形狀（見「其他 Anthropic client（降轉）」） |
| `/backend-api/codex/*` | 只給官方 Codex CLI（`openai_base_url`）：HTTP 與 WebSocket 原樣轉送給 ChatGPT backend，只換成 gateway home 的 token；有設 API key 時一律回 403（見「官方 Codex CLI 連 gateway」） |

## 從舊版 codex-proxy 搬遷（手動）

本專案已更名為 agent-gateway，環境變數改為 `AGENT_GATEWAY_*`。程式不會自動搬遷，也不支援舊 `CODEX_PROXY_*` 環境變數；現在也沒有預設 home，啟動時要用 `--codex-home ~/.agent-gateway`（或 `AGENT_GATEWAY_HOME=~/.agent-gateway`）指定 home。

1. 先停止所有共用舊 auth home（`~/.codex-proxy`）的程序（gateway、`codex`、PoC），避免 refresh token 互搶。
2. 若 `~/.agent-gateway` 已存在，**不要**執行下一步的 `mv`（會把舊目錄塞進新目錄變成 `~/.agent-gateway/codex-proxy`）；直接沿用既有 `~/.agent-gateway`，或照下方「安裝與登入」在新 home 重新登入。
3. 確認 `~/.agent-gateway` 不存在後才搬移：`mv ~/.codex-proxy ~/.agent-gateway`。

搬遷完成後直接跳到「啟動」；尚未使用舊版者照下方「安裝與登入」進行。

## 安裝與登入

可使用 GitHub Releases 提供的獨立執行檔，或從原始碼安裝。登入仍需對應的官方 CLI（`codex` 或 `claude`）。

### 下載執行檔

Release 標籤格式為 `v0.1.0-abc1234`，版本取自 `package.json`，後綴為來源 commit SHA 前七碼；完整 SHA 記錄在 release 說明。每個 release 提供：

| 作業系統 | 架構 | 下載檔名後綴 |
|---|---|---|
| Linux | x64、arm64 | `linux-x64`、`linux-arm64`，另附 `.AppImage` |
| macOS | Intel、Apple Silicon | `darwin-x64`、`darwin-arm64` |
| Windows | x64、arm64 | `win32-x64.exe`、`win32-arm64.exe` |

這些檔案內含 Node.js，不需另外安裝 runtime 或 npm dependencies。Linux 原生 binary 以 Ubuntu 22.04 建置，需要 glibc 2.35+；AppImage 也沿用相同 runtime，不能用於 Alpine/musl。macOS 以 macOS 15 建置，Windows 在 Windows Server 2022／Windows 11 ARM 上驗證。

以下以 Linux x64 為例，檔名請替換成實際下載版本：

```bash
sha256sum --ignore-missing -c SHA256SUMS
chmod +x agent-gateway-0.1.0-abc1234-linux-x64
./agent-gateway-0.1.0-abc1234-linux-x64 --help
./agent-gateway-0.1.0-abc1234-linux-x64 --codex-home ~/.agent-gateway
```

macOS 可用 `shasum -a 256 <檔名>`，Windows PowerShell 可用 `Get-FileHash <檔名> -Algorithm SHA256`，與 `SHA256SUMS` 核對。macOS 使用 ad-hoc 簽章，沒有 Apple 公證；Windows 沒有憑證簽章，因此首次執行可能出現系統提示。macOS 可於「系統設定 → 隱私權與安全性」允許開啟；Windows 確認檔案來源與 checksum 後，可從 SmartScreen 的「其他資訊」繼續。

AppImage 使用專案的看板娘圖示，仍是 CLI 工具，需在終端機指定 home；先 `chmod +x <檔名>.AppImage`。沒有 FUSE 時可用：

```bash
APPIMAGE_EXTRACT_AND_RUN=1 ./agent-gateway-0.1.0-abc1234-linux-x64.AppImage --codex-home ~/.agent-gateway
# 或解壓後執行，所有原有 CLI 參數都可使用
./agent-gateway-0.1.0-abc1234-linux-x64.AppImage --appimage-extract
./squashfs-root/AppRun --codex-home ~/.agent-gateway
```

### 從原始碼安裝

需求：Node.js 22+、已安裝 `codex` CLI。

```bash
npm install
# gateway 使用獨立的 CODEX_HOME，避免和平常的 ~/.codex 互搶 refresh token
mkdir -p ~/.agent-gateway && chmod 700 ~/.agent-gateway
CODEX_HOME=~/.agent-gateway codex login        # 無瀏覽器環境改用 --device-auth
```

## 啟動

```bash
npm run build && npm start -- --codex-home ~/.agent-gateway     # 或開發時用 npm run dev -- --codex-home ~/.agent-gateway
# agent-gateway listening on http://127.0.0.1:8765/v1
#   codex1 -> /home/you/.agent-gateway

npm start -- --help     # 列出選項與環境變數
```

沒有指定任何 home（`--codex-home`、`AGENT_GATEWAY_CODEX_HOMES`、`AGENT_GATEWAY_HOME`、`--claude-home`、`AGENT_GATEWAY_CLAUDE_HOMES` 都沒有）時，gateway 會印出設定方式並結束（exit 1）。沒有預設 home，也不會讀 `CODEX_HOME`、`CLAUDE_CONFIG_DIR`；只有加 `--auto` 時才會讀 `~/.codex`、`~/.claude` 這類目錄，見「自動掃描 home（`--auto`）」。

| 環境變數 | 預設 | 說明 |
|---|---|---|
| `AGENT_GATEWAY_PORT` | `8765` | listen port |
| `AGENT_GATEWAY_HOST` | `127.0.0.1` | listen 位址；沒給 `--host` 時才生效。`127.0.0.1`、`::1` 以外的位址（含 `localhost`）需要 `AGENT_GATEWAY_API_KEY`，見「對外開放」 |
| `AGENT_GATEWAY_API_KEY` | 未設定 | 設定後每個請求都要帶 `Authorization: Bearer <key>`，否則回 401；只能用環境變數設定，限可列印 ASCII 且不含空白 |
| `AGENT_GATEWAY_HOME` | 未設定 | 單一 Codex home，讀寫其中的 `auth.json` |
| `AGENT_GATEWAY_CODEX_HOMES` | 未設定 | 多個 Codex home，用 `:` 分隔（例：`$HOME/.agent-gateway:$HOME/.agent-gateway-2`）；沒給 `--codex-home` 時與 `AGENT_GATEWAY_HOME` 同時設定會啟動報錯 |
| `AGENT_GATEWAY_CLAUDE_HOMES` | 未設定 | 多個 Claude home，用 `:` 分隔；沒給 `--claude-home` 時才生效 |
| `CODEX_CLIENT_VERSION` | `0.162.1` | backend 依此版本過濾模型清單，太舊會只剩少數模型 |

也可以用 CLI 參數 `--codex-home <path>`、`--claude-home <path>`（皆可重複，也支援 `--flag=<path>`），例如 `npm start -- --codex-home ~/.agent-gateway --claude-home ~/.agent-gateway-claude`。

home 的優先序：`--codex-home` > `AGENT_GATEWAY_CODEX_HOMES` > `AGENT_GATEWAY_HOME` > 都沒設定 → 啟動報錯。有給 `--codex-home` 時，Codex 的環境變數 home 一律被忽略（兩個環境變數同時設也不報錯）。Claude 同理：`--claude-home` > `AGENT_GATEWAY_CLAUDE_HOMES`。至少要有其中一個 provider 的 home。`--auto` 不能和以上任何一種 home 設定同時使用。

環境變數裡的 home 請寫絕對路徑或用 `$HOME`（gateway 不展開 `~`，`"~/a:~/b"` 會被當成相對路徑）。

除錯時加 `--debug`（等於 `--debug 0`）或 `--debug 0`～`--debug 3`（也支援 `--debug=N`，其他等級會報錯），把「上游」（Gateway → provider）與「下游」（agent CLI → Gateway）的 log 細節分開控制：

| 等級 | 上游（Gateway ↔ provider） | 下游（agent tool ↔ Gateway） |
|---|---|---|
| 0 | method + URL | method + URL |
| 1 | method + URL + 完整 header + request/response body | method + URL |
| 2 | method + URL | method + URL + 完整 header + request/response body |
| 3 | 完整 header + request/response body | 完整 header + request/response body |

header 含 request 與 response header，`authorization` 只留 scheme，token 完全不印。**注意：這是破壞性變更，原本的 `--debug 1`（印 request body）現在是 `--debug 3`。**

```bash
npm start -- --codex-home ~/.agent-gateway --debug        # 與 --debug 0 相同
npm start -- --codex-home ~/.agent-gateway --debug 1      # 看 Gateway 實際送上游的內容（system prompt、reasoning effort 等）
npm start -- --codex-home ~/.agent-gateway --debug 2      # 看 agent CLI 送進 Gateway 的內容
npm start -- --codex-home ~/.agent-gateway --debug 3      # 兩側都完整印出
```

每一行 debug log 都帶 UTC 時間前綴 `[debug:2026-10-15T11:56:40Z]`（取印出那一刻的時間；response body 在串流結束後才印，時間就是結束時間，可當時間軸看）。等級 1～3 會在每個有印 header/body 的「跳」之前先印一個空行加分隔線（40 個 `─`）；只印一行 method + URL 的跳（例如等級 1 的 incoming 行、等級 0 的所有行）沒有分隔線。

`--debug 3` 的輸出範例：

```text

[debug:2026-10-15T11:56:40Z] ────────────────────────────────────────
[debug:2026-10-15T11:56:40Z] incoming POST /v1/responses
[debug:2026-10-15T11:56:40Z]   content-type: application/json
[debug:2026-10-15T11:56:40Z]   authorization: Bearer ***
[debug:2026-10-15T11:56:40Z] incoming POST /v1/responses body:
{ ...agent tool 送來的原始 body... }

[debug:2026-10-15T11:56:40Z] ────────────────────────────────────────
[debug:2026-10-15T11:56:40Z] codex1 POST https://chatgpt.com/backend-api/codex/responses
[debug:2026-10-15T11:56:40Z]   authorization: Bearer ***
[debug:2026-10-15T11:56:40Z]   originator: codex_cli_rs
[debug:2026-10-15T11:56:40Z] codex1 upstream POST https://chatgpt.com/backend-api/codex/responses body:
{ ...轉換後的 body... }

[debug:2026-10-15T11:56:41Z] ────────────────────────────────────────
[debug:2026-10-15T11:56:41Z] codex1 upstream POST https://chatgpt.com/backend-api/codex/responses response 200
[debug:2026-10-15T11:56:41Z]   content-type: text/event-stream
[debug:2026-10-15T11:56:44Z] codex1 upstream POST https://chatgpt.com/backend-api/codex/responses response body:
event: response.created ...

[debug:2026-10-15T11:56:44Z] ────────────────────────────────────────
[debug:2026-10-15T11:56:44Z] incoming POST /v1/responses response 200
[debug:2026-10-15T11:56:44Z]   content-type: text/event-stream; charset=utf-8
[debug:2026-10-15T11:56:44Z] incoming POST /v1/responses response body:
data: ...
POST /v1/responses 200 812ms model=codex1/gpt-5.6
```

`--debug 0` 只有單行、沒有分隔線：

```text
[debug:2026-10-15T11:56:40Z] incoming POST /v1/responses
[debug:2026-10-15T11:56:40Z] codex1 POST https://chatgpt.com/backend-api/codex/responses
```

- response body 等整個 response 結束後一次印出：可解析的 JSON 會縮排，SSE 保留原始文字；不影響送給 client 的串流。
- 上游的 body（request 和 response）只印推論請求（路徑結尾是 `/responses` 或 `/messages` 的 POST）；OAuth refresh 的 body 含有 token，一律不印。
- body 內容包含 system／developer prompt、`instructions`、`messages`／`input`、工具定義與工具呼叫／結果等欄位；prompt 文字不截斷、不遮罩，直接輸出到 stdout。
- `--debug` 只加印 log，不會改變送出去的內容；沒加時 stdout 不會出現 `[debug:` 行，每個請求原本就有的 access log（例：`POST /v1/responses 200 812ms model=...`）維持不變。`codexN`／`claudeN` 表示那個上游 request 是哪個 home 送的（含該 home 的 token refresh headers）。

選填參數：

- `--model <id>`：request 沒帶 `model` 時使用的預設 model（例：`--model codex1/gpt-5.6-terra`；不寫 prefix 就是第一個 home）。`/v1/models` 會把它排在第一筆；沒給 `--model` 時預設是 `/v1/models` 排序後的第一筆。request 有帶 model 時仍以 request 為準，agent CLI 可隨時切換。
- `--context-length <n>`：只在 `/v1/models` 每筆 model 標示 `context_length`（預設 `250000`），讓 agent CLI 讀 context window；**不會**限制實際 request。
- `--host <addr>`：listen 位址（預設 `127.0.0.1`，優先於 `AGENT_GATEWAY_HOST`），見「對外開放」。
- `--auto`：自動使用 `$HOME` 下所有已登入的 Codex／Claude home，見下一節。

## 自動掃描 home（`--auto`）

不想逐一指定 home 時，加 `--auto`。gateway 只掃描 `$HOME` 第一層，使用所有已登入的 home：

| 目錄名稱 | provider | 視為已登入的條件 |
|---|---|---|
| `.codex`、`.codex-*` | Codex | 目錄內有 `auth.json` |
| `.claude`、`.claude-*` | Claude | 目錄內有 `.credentials.json` |

```bash
npm start -- --auto
# warning: codex1 (/home/you/.codex): do not run the codex CLI on this home while the gateway runs; ...
# agent-gateway listening on http://127.0.0.1:8765/v1
#   codex1 -> /home/you/.codex
#   codex2 -> /home/you/.codex-work
#   claude1 -> /home/you/.claude
```

- alias 依目錄名稱排序，所以 `~/.codex` 一定是 `codex1`、`~/.claude` 一定是 `claude1`。新增或刪除目錄後，排在後面的 alias 會跟著變。
- 名稱符合但沒有憑證檔（必須是一般檔案）的目錄會跳過，並印出 `--auto skipped <path>: not logged in`；一個都沒找到就報錯結束。
- 透過 symlink 指向同一份憑證檔的 home 只保留排序較前的那個，其他的印出 `--auto skipped <path>: same home as <path>`，避免兩個 gateway 帳號用掉同一個 refresh token。`.codexfoo`（沒有 `-`）、`.agent-gateway` 和 `.claude.json` 這類檔案都不會被比對到。
- 不能和 `--codex-home`、`--claude-home`、`AGENT_GATEWAY_CODEX_HOMES`、`AGENT_GATEWAY_HOME`、`AGENT_GATEWAY_CLAUDE_HOMES` 同時使用，否則啟動報錯。
- **`~/.codex*` 通常也是官方 `codex` CLI 在用的 home。** gateway 執行期間不要用同一個 home 跑 `codex`，否則兩邊會用掉同一個一次性 refresh token，其中一邊會被登出，必須重新 `codex login`。因此每個 Codex home 在啟動時都會印出警告。Claude home 和官方 CLI 共用 refresh 鎖，沒有這個問題。

## 對外開放（`--host`）

預設只綁 `127.0.0.1`，只有本機能連。要讓其他機器使用時，用 `--host` 指定位址，並**必須**設定 `AGENT_GATEWAY_API_KEY`；沒有 key 時，綁定 `127.0.0.1`、`::1` 以外的位址會直接報錯並結束。`localhost` 也需要 key，因為它實際綁到哪個位址由 DNS／`/etc/hosts` 決定。

```bash
(umask 077; openssl rand -hex 32 > ~/.agent-gateway-key)   # 只有自己能讀，重啟後沿用同一把 key
AGENT_GATEWAY_API_KEY="$(cat ~/.agent-gateway-key)" npm start -- --codex-home ~/.agent-gateway --host 0.0.0.0
# agent-gateway listening on http://0.0.0.0:8765/v1
#   api key: required
```

client 端把 `base_url` 改成 `http://<主機IP>:8765/v1`，`apiKey` 填 `~/.agent-gateway-key` 的內容。用 `scp` 等加密管道把 key 複製到 client 機器，不要貼到聊天室或 issue。

- 有設 key 時，每個請求（含 `GET /v1/models`）都要帶 `Authorization: Bearer <key>`，不帶或不對都回 401（`code: invalid_api_key`），且不再限制 `Host` 標頭。沒設 key 時維持原本的 `Host` 白名單，擋下 DNS rebinding。例外是 `POST /v1/messages`：官方 Claude Code 的 `Authorization` 是它自己的 Claude token，key 改用 `x-agent-gateway-api-key` 帶，錯誤時回 403（見「官方 Claude Code 連 gateway」）；其他 Anthropic client 可以用 `x-api-key`、`Authorization: Bearer` 或 `x-agent-gateway-api-key` 帶，錯誤時回 401 `authentication_error`（見「其他 Anthropic client（降轉）」）。`/backend-api/codex/*` 則是有設 key 時一律回 403，因為 Codex 沒辦法帶 key（見「官方 Codex CLI 連 gateway」）。
- key 只能用環境變數設定，因為 CLI 參數會出現在 `ps` 等程序列表；debug log 也會遮蔽 `authorization`。client 的 key 只用來驗證，不會轉送到上游。
- 拿到 key 的人就能用你的 ChatGPT／Claude 帳號。請使用夠長的隨機 key，只在信任的網路開放，必要時用防火牆限制來源。
- gateway 沒有 TLS，key 和對話內容都以明文傳送。跨不信任的網路時，改用 SSH tunnel：gateway 維持預設的 `127.0.0.1`，在 client 機器執行 `ssh -N -L 8765:127.0.0.1:8765 <主機>`，再連 `http://127.0.0.1:8765/v1`。

## 多帳號（多個 Codex home）

一個 gateway process 可以同時 proxy 多個 ChatGPT 帳號，每個帳號用各自的 Codex home：

```bash
mkdir -p ~/.agent-gateway-2 && chmod 700 ~/.agent-gateway-2
CODEX_HOME=~/.agent-gateway-2 codex login
npm start -- --codex-home ~/.agent-gateway --codex-home ~/.agent-gateway-2
```

- home 依設定的順序取得 alias：`codex1`、`codex2`…。啟動 log 會列出每個 `codexN -> <home>`。
- model id 用 alias 當 prefix 選帳號：`codex1/gpt-5.6-terra`、`codex2/gpt-5.6-terra`。
- `GET /v1/models` 一律列出 prefixed id，並在 `description` 標明該模型來自哪個 home。
- model id 沒有 prefix 時一律走 `codex1`，舊 client 設定不用改（例外：`claude-*` 走第一個 Claude 帳號，見下一節）。
- 送給 backend 的 `model` 是去掉 prefix 的模型名，backend 看不到 alias。
- 啟動時任一 home 讀不到或 login 失效，會先印出該 home 的 `codex login` 指令再結束；`/v1/models` 則只略過讀取失敗的 home（log 會 warn）。

## Claude 帳號（Claude Code 登入）

也可以用 Claude Code 的訂閱登入當第二個上游。gateway 讀該 home 的 `.credentials.json`（`claudeAiOauth`），必要時自行 refresh 並寫回（`0600`，未知頂層欄位原樣保留）。

已登入且含 account metadata 的自訂 home 可直接傳給 `--claude-home`，不必另轉成 CLIProxyAPI 的 snake_case 憑證。Token 可沿用，但 email 不能假設從 JWT 取得；只有 token JSON 而缺 `oauthAccount.accountUuid` 時仍不足以啟動推論。詳細對照見 [EasyCLIProxyAPI 串接與憑證評估](CLAUDE_EASYCLIPROXY_COMPARISON.md)。

```bash
mkdir -p ~/.agent-gateway-claude && chmod 700 ~/.agent-gateway-claude
CLAUDE_CONFIG_DIR=~/.agent-gateway-claude claude     # 進入後輸入 /login
npm start -- --claude-home ~/.agent-gateway-claude
#   claude1 -> /home/you/.agent-gateway-claude
```

- 跨 process 的 refresh 鎖照抄官方同一把：`<home>/.oauth_refresh.lock`（外加舊版 `realpath(<home>) + ".lock"`），因此 gateway 與官方 `claude` CLI 共用同一 home 時會互相等鎖，不會互搶一次性 refresh token。鎖被搶走時進行中的 refresh 會被中止，輪替後的憑證不會寫到別人的鎖下。gateway 只讀該 home 的 `.credentials.json`、`.config.json`/`.claude.json`（帳號記錄：`oauthAccount.accountUuid` 與 `userID`）與 `settings.json`，不寫官方 transcript。`/login` 過的 home 一定有帳號記錄；讀不到 `accountUuid` 時 Claude 請求一律 400（沒有可佐證的帳號身分就無法保證簽章回放隔離），不會用不明身分鍵狀態。
- 憑證與帳號 uuid 每個請求都重讀：在 gateway 運行中用官方 CLI 換登入（relogin），下一個請求就會換成新帳號的 token、metadata 與狀態索引，不需要重啟。
- alias 依設定順序為 `claude1`、`claude2`…。model id 用 prefix 選帳號：`claude1/claude-opus-5`。
- 沒有 prefix 時：`claude-*` 走第一個 Claude 帳號，其他 id 走 `codex1`（舊 client 設定不用改）。該 provider 沒掛時回 400，不會悄悄換到另一個 provider。`--model` 的預設 model 也用同一條規則，不會跨 provider。
- `GET /v1/models` 先列 Codex 再列 Claude，Claude 條目 `owned_by: "anthropic"`。
- gateway 呼叫上游一律用 `POST /v1/messages?beta=true` 且 body 帶 `stream:true`（與官方推論呼叫一致）；client 要非串流時由 gateway 聚合後回單一回應。User-Agent 照官方 `$0()` 產生器（pin 版本 2.1.299，用戶明確核准的 Claude 專屬例外；entrypoint 依官方啟動期規則解析），`Accept: application/json` 與官方 SDK 預設一致（Messages 與 Models 皆同），並照 bundled SDK 0.128.0 送八個 `x-stainless-*` header 加 `anthropic-dangerous-direct-browser-access`（Messages 九個、Models 不帶 timeout 八個）。
- 請求帶官方 `metadata.user_id`（home 的 `userID`、account uuid 與 gateway session）、billing 文字塊及互動 CLI 前綴。Sonnet 5 等支援對話中 system 的模型，將完整 caller 指令放在第一個 user 回合後的 `role:system`；舊模型仍保留 top-level system。billing 可用 `CLAUDE_CODE_ATTRIBUTION_HEADER=0` 關閉。CLI 前綴與 caller 指令塊各掛 ephemeral、billing 不掛；原歷史中最後一則「合格」訊息的尾塊掛 ephemeral；tools 不掛，一律不帶 ttl。詳細規則見通訊差異報告。
- gateway 會讀該 home 的 `settings.json`：`alwaysThinkingEnabled`、`effortLevel`、`maxEffortLevel`、`modelSettings[<model>].*`。改動在下一個新回合生效；home 的 effort 層級與 `maxEffortLevel` cap 都會依模型能力正規化（該模型跑不了的 `max`/`xhigh` 落回 `high`，其他不支援的值丟掉），不會送出不支援的 effort。
- 上游行為、headers 與偏離項目完整記錄在 [`CLAUDE_UPSTREAM_PROTOCOL_DIFF.md`](CLAUDE_UPSTREAM_PROTOCOL_DIFF.md)。
- 依 CLIProxyAPI v8.0.29 校正 CCH、subscription betas、request ID 與 caller system 位置。2026-10-15 已重現 OpenCode 完整請求的 extra usage 拒絕，修正後沿用原有 credential，真正 OpenCode CLI 文字與 `read` 工具續接均成功。相似度、單一變因實驗及尚未驗證的範圍見 [比較報告](CLAUDE_EASYCLIPROXY_COMPARISON.md)。更新 build 後需重啟 gateway。

### Claude 的 thinking 狀態

Claude 的 thinking 區塊帶簽章，工具回合續接時必須原樣送回，但 OpenAI 相容 API 不會把這些內容給 client，所以 gateway 自己在該 home 下存一份：

- 位置：`<claude-home>/.agent-gateway/claude-state/`（目錄 `0700`、檔 `0600`）。
- 索引鍵：帳號身分（`.config.json`/`.claude.json` 的 `accountUuid`，每個請求重讀，**讀不到整個請求 400**；不拿 `organizationUuid` 代用）+ model + 「該 assistant 回合之前的可見對話前綴」+「該 assistant 回合自己外顯的文字與 tool calls」。所以換帳號、換模型、同一前綴的兩個分支（不同 tool call）都各自成鍵，不會互相覆蓋或拿到別人的簽章區塊。
- 內容：該回合的原生 assistant 區塊（含 thinking 文字與簽章）、model、帳號 alias 與 uuid、釘住的 thinking 設定（含最終 `budget_tokens`）。記錄的欄位與它所存的鍵會逐一驗證，複製到別鍵的記錄會被拒絕。**沒有**自動過期；要清就刪該目錄。
- 只有含 tool call（或隱藏區塊）的回合會寫，而且只在通過驗證的 `message_stop` **一次性原子寫入完整原生內容**；所有 tool 的完成事件延遲到存檔成功後才發出。提前錯誤、壞尾或寫入失敗時：不會出現已完成的 tool call，也不會留下可回放的一半狀態。
- 因為狀態存在本機，**重啟 gateway 也能繼續同一個工具回合**，同一前綴的兩個分支重啟後也各自可續；歷史的 assistant 回合也會各自回放（不會重複輸出可見文字）。Claude 回合在 Chat 端把多個 text 區塊**不加分隔符**串成一個 content（與原生區塊串接一致），client 把收到的 content 原樣 echo 回來就能續接（Responses 端則是原樣回送 output items）；同一回合的可見內容被改動（例如改 assistant 文字、tool 參數、指令或更早的歷史前綴）或狀態遺失/損毀，會回 400，不會偽造簽章。
- 已結束的 tool 回合不需要回放狀態，所以之後的新 user 回合可以用新的 home 設定繼續；重複送**相同**的顯式 reasoning 設定（含被 clamp 的值）不會被誤判成中途改變。
- thinking 文字與簽章不會出現在給 client 的輸出裡（只出現空的 `reasoning` item）。

### Claude 不支援（一律 400，不猜等價寫法）

- `text.format.type: "json_object"`（上游沒有等價寫法）；`json_schema` 會轉成 `output_config.format` 送出，不支援結構化輸出的模型則回 400。
- 非 `function` 的工具（內建 web search、MCP、custom、namespace）。
- 不支援的 `tool_choice`、不支援的 effort 值、不允許關閉 thinking 的模型要求關閉（`reasoning.effort:"none"`）。
- thinking 生效時強制 `tool_choice`（`required` 或指定 function）：官方會降級，gateway 選擇回報 400，不悄悄改寫語意。
- 不支援的圖片格式、`http://` 圖片 URL、assistant 訊息內的圖片。
- 未知模型且無法決定輸出上限時，請帶 `max_output_tokens`。

## 官方 Claude Code 連 gateway（`POST /v1/messages`）

官方 Claude Code 也可以把 `ANTHROPIC_BASE_URL` 指向 gateway。這條路徑**不做格式轉換**：client 自己組好的官方請求原樣轉給 `https://api.anthropic.com`，gateway 只把 `Authorization` 換成 gateway Claude home 的 OAuth token。不符合下面判定的請求不會被拒絕，而是走降轉（見「其他 Anthropic client（降轉）」）。

先決條件：

1. Claude Code 已用 OAuth 登入（執行 `claude` 後輸入 `/login`）。不要用 `ANTHROPIC_AUTH_TOKEN` 或 `ANTHROPIC_API_KEY`。
2. client 登入的帳號，要和某個 gateway Claude home **是同一個帳號**。gateway 拿請求 `metadata.user_id` 裡的 `account_uuid`，去比對每個 home 的 `oauthAccount.accountUuid`；對上的 home 就是這次用的帳號。model alias 不參與帳號選擇。

gateway 沒設 `AGENT_GATEWAY_API_KEY`（預設只聽本機）時：

```bash
ANTHROPIC_BASE_URL=http://127.0.0.1:8765 \
_CLAUDE_CODE_ASSUME_FIRST_PARTY_BASE_URL=1 \
claude
```

gateway 有設 `AGENT_GATEWAY_API_KEY` 時，三個變數都要帶到同一個 `claude` 指令上（或先 `export`）：

```bash
ANTHROPIC_BASE_URL=http://<主機>:8765 \
_CLAUDE_CODE_ASSUME_FIRST_PARTY_BASE_URL=1 \
ANTHROPIC_CUSTOM_HEADERS="x-agent-gateway-api-key: $(cat ~/.agent-gateway-key)" \
claude
```

- `ANTHROPIC_BASE_URL` 不要帶 `/v1`，Claude Code 會自己接上 `/v1/messages?beta=true`。
- `_CLAUDE_CODE_ASSUME_FIRST_PARTY_BASE_URL=1` 讓 client 把 gateway 當成 first-party。沒設的話，client 自己就會送出降級的形狀：沒有 `cch` 簽章，beta 和 tools 也不同。gateway 補不回來，所以直接拒絕。這是底線開頭、沒有公開文件的內部變數，之後的版本可能改掉。
- 這條路由的 `Authorization` 是 client 自己的 token，所以 gateway key 改用 `ANTHROPIC_CUSTOM_HEADERS` 帶，格式是每行一個 `Name: value`。gateway 驗證後會移除這個 header，不會轉給上游。
- key 沒帶或不對時回 **403**（`permission_error`），訊息會指出 `x-agent-gateway-api-key`。刻意不用 401：Claude Code 收到 401 會以為自己的 OAuth token 失效，去做 refresh 或要求重新登入。上游真正回的 401 不受影響，照下面的規則處理。
- debug log（任何等級）只會印 `x-agent-gateway-api-key: ***`，不論 key 對錯，整個值都會遮掉。

轉送行為：

- body 逐 byte 轉送，不重新序列化。唯一的例外是 model 帶了 gateway alias，例如 `claude1/claude-opus-5`：alias 必須指向上面選出的 home，接著只把 `model` 的值換成去掉 alias 的 id，其他 bytes 不動。`cch` 計算時 model 會被清成空字串，所以不需要重新簽。
- 轉送用 Node 的 `node:https` 直接送，不經過 `fetch`，所以不會多出 header、不會自動解壓，也不會自動跟隨 redirect。
- headers 照 client 送來的名稱大小寫、順序和重複項轉送，包括 UA、`x-app`、`anthropic-*`、`x-stainless-*`、`x-claude-code-*`、`x-client-request-id`、`accept-encoding`、`connection`。只換 `Authorization`；`host` 和 `content-length` 在原位置填上這一段的值（只有改寫 alias 時長度才會變）；移除 `transfer-encoding`、`keep-alive`、`upgrade` 和 `x-agent-gateway-api-key`。UA 照轉 client 自己的值，這是使用者核准的例外（見 `AGENTS.md`）。
- path 和 query 用 client 送來的原文，不重新編碼。
- 每次真正送出前（第一次，以及 401 恢復後的重送），gateway 都會重新讀 home 的 `accountUuid`，確認仍是 client 的帳號。home 在這期間換成別的登入，就回 400、不送出，也不會改 metadata 或重新簽章去遷就新帳號。
- 上游回 401 時，gateway 會更新 home 的 token，用同一份 body 重試一次；重試仍是 401 就原樣轉回。
- 上游的 status、status 訊息、headers 和 body 原樣轉回，錯誤、壓縮內容（`content-encoding`、`content-length` 照轉）和 redirect（`Location` 照轉）都一樣；串流照樣串流。只有 `connection`、`keep-alive`、`transfer-encoding` 這類連線用的 header 由 gateway 自己重設。client 斷線時會中止上游請求。
- 不使用 gateway 的 thinking 狀態（`claude-state/`），thinking 簽章由 client 自己送回。
- `--debug 1`／`3` 的上游紀錄不包含這條路徑（轉送不經過 `fetch`）。要看內容請用 `--debug 2`／`3`：incoming 的請求和回應，和上游看到、送回的內容相同，只差 token。
- 只轉送 `POST /v1/messages` 和 `POST /v1/messages/count_tokens`（後者要先綁定 session，見下面），其他路徑回 404。目前只擷取過 `claude -p`（sdk-cli）模式，互動模式尚未驗證。

判定為官方 Claude Code 的條件：同時有 `x-app: cli`、`claude-cli/` 開頭的 UA，以及含 `device_id`、`session_id` 的 JSON 字串 `metadata.user_id`。符合之後才套用下面的檢查。

`POST /v1/messages/count_tokens`：Claude Code 會呼叫它估算 token 數（native 2.1.302 的 `DFe`；失敗時只記 log、回傳 null，對話照常進行）。這個請求沒有 `metadata.user_id`，無法直接比對帳號，所以改用 session 綁定：

- 同一個 session（`x-claude-code-session-id`）的 `/v1/messages` 通過上面全部檢查之後，gateway 會記住「這個 session → 選出的 home 和帳號」。紀錄只放在記憶體，最多 1000 個 session，最久沒用到的先淘汰；gateway 重啟後就清空。
- count_tokens 只在以下條件全部成立時轉送：`x-app: cli` 加 `claude-cli/` 開頭的 UA（只看 header，因為沒有 metadata）、`anthropic-beta` 含 `oauth-2025-04-20`、`x-claude-code-session-id` 查得到紀錄。
- 轉送方式和 `/v1/messages` 相同：path、query、body 原樣（model alias 一樣只能指向綁定的 home），headers 只換 token。每次送出前（包括 401 恢復後的重送）都會確認 home 現在的帳號仍是紀錄裡的帳號，不一致就回 400、不送出。
- 不符合時回 400，不送上游，Claude Code 只是少了這次估算。不是官方 Claude Code 的 client 打 count_tokens 一律回 400（見降轉一節）。

400 的原因與處理（錯誤一律用 Anthropic 格式 `{"type":"error","error":{...}}`，而且不會送出推論請求）：

| 訊息關鍵字 | 原因 | 處理 |
|---|---|---|
| `_CLAUDE_CODE_ASSUME_FIRST_PARTY_BASE_URL=1` | `system[0]` 不是帶 ` cch=` 的 billing 區塊 | 啟動 Claude Code 時加上這個環境變數 |
| `oauth-2025-04-20` | `anthropic-beta` 沒有 OAuth beta，表示 client 是用 auth token 或 API key 登入 | 拿掉 `ANTHROPIC_AUTH_TOKEN`／`ANTHROPIC_API_KEY`，用 `/login` 以訂閱帳號登入 |
| `same account as a gateway Claude home` | client 的 `account_uuid` 對不上任何 gateway home，包括 client 尚未登入 | 讓 client 和某個 gateway home 登入同一個帳號 |
| `now logged in to a different account` | 檢查通過之後、送出之前，gateway home 被換成別的帳號登入 | 把該 home 登回和 Claude Code 相同的帳號，再重試 |
| `does not match the gateway Claude home` | model alias 指向的 home，不是這次依登入選出的 home | 改用對應的 alias，或用不帶 alias 的 model id |
| `request target must be a path` | 請求行不是 `/v1/messages?...` 這種路徑形式 | 用官方 Claude Code 連線（它一律送路徑形式） |
| `same-account check on /v1/messages` | count_tokens 的 session 還沒有通過檢查的 `/v1/messages`：沒帶 `x-claude-code-session-id`、gateway 重啟過，或紀錄已被淘汰 | 在同一個 session 繼續對話；下一個轉送成功的 `/v1/messages` 會重新綁定 |

## 其他 Anthropic client（降轉，`POST /v1/messages`）

不是官方 Claude Code 的 Anthropic Messages API client（例如 Anthropic SDK）也可以打 `POST /v1/messages`。不符合上一節官方 Claude Code 判定的請求，都走這條「降轉」路徑：gateway 不轉送 client 的請求，而是用 `/v1/responses` Claude 路徑同一套官方形狀組裝邏輯重組（做法參考 CLIProxyAPI 的 cloaking）。

- headers 由 gateway 產生：釘住版本的 UA、`x-app: cli`、`anthropic-beta`、`x-stainless-*`，以及 home 的 OAuth token。client 自己的 `x-api-key`、`Authorization`、`anthropic-beta` 都不會送到上游。
- system 依官方順序重組：billing 區塊（含 `cch` 簽章）、Claude Code 前綴；client 的 system 文字合併成一塊，放在對話中（舊模型放在 system）。
- cache marker、`metadata.user_id`、betas、thinking、`output_config` 都依官方規則產生；client 帶的 `cache_control` 和 `metadata` 會拿掉。
- 上游一律用 `stream:true`。

**和官方 Claude Code 原樣轉送的差別**：tools、system 文字和 messages 仍是 client 自己的內容，不是官方 Claude Code 產生的。只有上一節的原樣轉送能保證和官方完全相同；降轉只保證形狀和 gateway 已對齊官方的那一套相同。

連線範例（Python SDK）：

```python
import anthropic

client = anthropic.Anthropic(
    base_url="http://127.0.0.1:8765",
    api_key="<gateway API key；沒設 AGENT_GATEWAY_API_KEY 時任意值>",
)
message = client.messages.create(
    model="claude1/claude-opus-5",
    max_tokens=1024,
    messages=[{"role": "user", "content": "hello"}],
)
```

- `base_url` 不要帶 `/v1`。
- model 選帳號的方式和 `/v1/responses` 相同：帶 alias 的 id（例如 `claude1/claude-opus-5`），或不帶 alias 的 `claude-*`（用第一個 Claude 帳號）。
- 有設 `AGENT_GATEWAY_API_KEY` 時，gateway key 可以放在 `x-api-key`（SDK 的 `api_key`）、`Authorization: Bearer`（SDK 的 `auth_token`）或 `x-agent-gateway-api-key`。沒帶或不對時回 **401**（`authentication_error`）。帶了 `x-app: cli` 和 `claude-cli/` UA 的 client 會被當成 Claude Code，key 只認 `x-agent-gateway-api-key`，錯誤回 403（見上一節）。沒設 key 時沿用本機 `Host` 檢查。
- debug log 會把 `x-api-key` 和 `x-agent-gateway-api-key` 的值整個遮成 `***`。

欄位處理：

| 欄位 | 處理 |
|---|---|
| `system` | 字串或 text block 陣列；非 text block 回 400 |
| `messages` | 接受 text、image（base64 或 `https://` URL）、tool_use、tool_result（content 是字串或 text／image block），以及 thinking 和 redacted_thinking（只限 assistant，原樣保留簽章）。其他 block（document、search_result、server tool 的結果、container_upload、`mcp_*` 等）回 400 |
| `tools` | 只收自訂工具（`name`、`description`、`input_schema`，可以帶 `type: "custom"`）；server 或內建工具回 400 |
| `tool_choice` | `auto`、`any`、`tool`、`none`。thinking 開啟時用強制工具（`any`、`tool`）回 400，請改送 `thinking: {"type":"disabled"}` 或 `tool_choice: {"type":"auto"}` |
| `max_tokens` | 必填，套用模型上限與 thinking budget 檢查 |
| `output_config` | `effort` 當成 reasoning effort；`format` 只收 `json_schema`；其他欄位回 400 |
| `thinking` | `{"type":"disabled"}` 等於 effort `"none"`（同時送非 `none` 的 `output_config.effort` 回 400）。其他形狀不轉送，thinking 由 home 設定和 effort 決定，並記入 `ignored=` |
| `metadata` | 拿掉，由 gateway 產生 |
| `stream` | 保留，見下方 |
| `temperature`、`top_p`、`top_k` | 官方不送，拿掉並記入 `ignored=` |
| `stop_sequences`、`service_tier`、`container`、`mcp_servers`、`context_management`、`inference_geo`，以及其他不認得的欄位 | 回 400，訊息列出欄位名稱 |

`ignored=`：拿掉的欄位會出現在 gateway 的請求紀錄，例如 `POST /v1/messages 200 812ms model=claude1/claude-opus-5 ignored=temperature,thinking`；回應本身不會提示。

回應：

- `stream:true`：上游的原生 SSE 原樣轉回，不翻譯。上游串流中途斷掉時，gateway 直接切斷連線，不會讓 client 以為串流正常結束。
- `stream:false`：gateway 把上游 SSE 聚合成單一 Message JSON。文字和 tool input 依序累加，thinking 簽章以最新的 `signature_delta` 為準，usage 合併；事件順序不對時回 502。
- thinking 簽章由 client 在下一個請求自己帶回（原樣保留 assistant 的 thinking block 即可），gateway 不使用 `claude-state/`。
- session id 由 alias、model 和第一個 message 決定，所以同一段對話的 `x-claude-code-session-id` 和 `metadata.user_id` 的 `session_id` 都不變。這裡的「第一個 message」是 client 送來的第一則原始訊息（拿掉 `cache_control` 之後）；後面再接一則 user 訊息時，送上游時會合併成同一則，但 session 不變。
- 錯誤一律用 Anthropic 格式 `{"type":"error","error":{...}}`。上游的 HTTP 錯誤保留 status；`stream:false` 時上游送來 `error` 事件會回 502，`error.type` 沿用上游的值（例如 `overloaded_error`）。
- `POST /v1/messages/count_tokens` 回 400，不送上游。

## 官方 Codex CLI 連 gateway（`/backend-api/codex/*`）

官方 Codex CLI 也可以直接把 gateway 當成 ChatGPT backend。這條路徑**不做格式轉換**：Codex 用內建的 OpenAI provider 和自己的 ChatGPT 登入，照官方方式送出 HTTP 與 WebSocket，包括 prewarm 和帶 `previous_response_id` 的增量 frame。gateway 原樣轉給 `https://chatgpt.com/backend-api/codex`，只把 `authorization` 換成 gateway Codex home 的 token。

設定方式：寫進 Codex 的 `config.toml`，或每次用 `-c` 帶上。

```toml
openai_base_url = "http://127.0.0.1:8765/backend-api/codex"
```

```bash
codex -c 'openai_base_url="http://127.0.0.1:8765/backend-api/codex"' "your prompt"
```

先決條件與限制：

1. Codex 已用 ChatGPT 帳號登入（`codex login`），而且和某個 gateway Codex home 是**同一個帳號**。gateway 拿 Codex 送來的 `chatgpt-account-id`，比對每個 home 的 account id。
2. Codex 和 gateway 要用**不同的 home**，各自登入同一個帳號，例如 Codex 用平常的 `~/.codex`，gateway 用 `~/.agent-gateway`。共用同一個 home 時，兩邊會 refresh 同一把 token；refresh token 只能用一次，其中一邊會被登出。
3. 不能設 `AGENT_GATEWAY_API_KEY`。Codex 的內建 OpenAI provider 不能另外加 header（官方只允許 Bedrock provider 覆寫 headers），沒辦法帶 gateway key。所以有設 key 時這組路由一律回 403，只能在 loopback、不設 key 的情況下使用。

轉送行為：

- **HTTP**（`GET /models`、HTTP 退路的 `POST /responses`，以及 `/backend-api/codex/` 底下的其他路徑）：headers 照 client 送來的名稱大小寫和順序轉送，`host`、`authorization` 在原位置換值，`content-length` 只在 client 有送或有 body 時才填；body、path 和 query 都是原文。回應不解壓、不跟隨 redirect，原樣轉回。上游回 401 時，更新 home 的 token 重送一次。
- **WebSocket**（`/backend-api/codex/responses`）：client 的握手原樣轉給上游，只換 `host` 和 `authorization`。上游回 101 才完成握手，101 的 headers（包括 `x-codex-turn-state`）原樣回給 client。之後 gateway 只在兩端之間搬 bytes：frame、壓縮、ping／pong 和 close code 都由 Codex 和上游直接處理。上游回 426 時原樣轉回，Codex 會照官方規則退回 HTTP。上游握手 15 秒內沒完成就回 504。
- 每次真正送出前（包括 401 恢復後的重送和 WebSocket 重新握手），都會確認 home 仍是 Codex 的帳號；home 換成別的帳號就回 400，不會送出。
- UA 照轉 Codex 自己的值，這是使用者核准的轉送例外（見 `AGENTS.md`）。
- 不使用 gateway 的 `previous_response_id` 本機展開（那是 `/v1/responses` 的功能）：增量續接由 Codex 和上游在 WebSocket 連線上自己處理。
- debug log 一律遮罩 `authorization`。

狀態碼（gateway 自己產生的錯誤用 OpenAI 格式 `{"error":{...}}`；WebSocket 在 upgrade 之前就以 HTTP 狀態碼回應）：

| 狀態 | `code` | 原因 | 處理 |
|---|---|---|---|
| 400 | `account_mismatch` | Codex 沒送 `chatgpt-account-id`、對不上任何 gateway Codex home，或送出前 home 已換成別的帳號 | 讓 Codex 和某個 gateway home 登入同一個帳號 |
| 400 | — | 請求行不是 `/backend-api/codex/...` 這種路徑形式 | 用官方 Codex 連線 |
| 403 | `api_key_unsupported` | gateway 設了 `AGENT_GATEWAY_API_KEY` | 拿掉 key，只在 loopback 使用 |
| 403 | — | Host 不是 loopback（沒設 key 時的 DNS rebinding 防護） | 用 `127.0.0.1` 連線 |
| 404 | — | WebSocket upgrade 的路徑不在 `/backend-api/codex/` 底下 | — |
| 502 | `upstream_unreachable` | 連不到上游 | 檢查網路 |
| 504 | `upstream_timeout` | 上游 WebSocket 握手（含取得 credentials 與 401 恢復）15 秒內沒有完成 | 稍後重試 |
| 其他 | — | 上游自己的回應（包括 401、426、429），原樣轉回 | 依上游的訊息處理 |

## Client 設定範例

多帳號時 model 改用 `codex1/gpt-5.6-terra` 這種帶 prefix 的 id；舊的 bare id（`gpt-5.6-terra`）仍然可用，一律走 `codex1`。client 也可以完全不帶 `model`，此時用 `--model` 指定的預設 model（沒給則用 `/v1/models` 第一筆）。

OpenAI SDK（沒設 `AGENT_GATEWAY_API_KEY` 時 `apiKey` 任意值，proxy 不檢查；有設時填同一把 key）：

```js
const client = new OpenAI({ baseURL: 'http://127.0.0.1:8765/v1', apiKey: 'unused' });
```

aider：

```bash
aider --model openai/codex1/gpt-5.6-terra --openai-api-base http://127.0.0.1:8765/v1 --openai-api-key unused
```

Codex 本身（`wire_api = "responses"`）：

```bash
codex exec -c 'model_providers.agent-gateway={ name = "agent-gateway", base_url = "http://127.0.0.1:8765/v1", wire_api = "responses" }' \
  -c model_provider=agent-gateway -m codex1/gpt-5.6-terra "your prompt"
```

## 轉換行為

以下行為由 `npm run poc` 對 backend 實測得出：

- 一律送 `stream:true`、`store:false`，並加上 `include: ["reasoning.encrypted_content"]`。
- backend 不接受的參數直接移除，並在 log 的 `ignored=` 欄位列出，例如 `temperature`、`top_p`、`metadata`、`user`、`truncation`、`top_logprobs`、`safety_identifier`、`stop`。
- `system` role 改成 `developer`，因為 backend 會回 `System messages are not allowed`。
- `reasoning.effort: "ultra"` 改成 `max`。沒指定 effort 時，用模型的預設值。
- `previous_response_id` 由 gateway 在本機處理（Codex 與 Claude 帳號共用；這是 gateway 自有行為，不是 backend 實測結果）：
  - 已完成的 response 存在記憶體（LRU，最多 1000 筆），重啟 gateway 就沒了；OpenAI 官方是保存 30 天。
  - 收到 `previous_response_id` 時，把該 response 的 input、output 和這次的新 input 接成完整 input 再送上游。上游看到的請求和「每次送完整對話」完全相同：Codex 仍是 `store:false` 加完整 input，Claude 仍是完整 `messages`（含簽章 thinking 回放）。
  - `store:false` 的請求不保存，之後拿它的 id 續接會回 400 `previous_response_not_found`；id 不存在、已被淘汰或 gateway 重啟過也一樣。
  - `instructions`、`tools` 不會沿用（同 OpenAI 語意），每次要重送。
  - 必須用同一個帳號的 model 續接；換帳號（例如 `codex1` 的 response id 配 `claude1/...`）回 400。同一個 home 不重啟就換登入（Codex 看憑證的 `account_id`，Claude 看 `accountUuid`）之後，舊的 id 也回 400，不會把舊帳號的對話送給新帳號。
  - 回應物件裡的 `previous_response_id` 欄位維持上游原值（Codex 為 `null`，Claude 沒有這個欄位）。
  - 不提供 `GET`／`DELETE /v1/responses/{id}`。
  - 上游仍然每輪全量重送。官方 Codex 預設用 WebSocket 增量傳送，gateway 尚未實作，見 [Codex WebSocket 傳輸](CODEX_WEBSOCKET_TRANSPORT.md)；Claude 沒有對應機制。
- 對 Responses Lite 模型（目前的 `gpt-6-*`、`gpt-5.6-*`），比照 Codex 做以下處理：
  - tools 包進 `additional_tools` 的 `functions` namespace。
  - `parallel_tool_calls:false`。
  - `reasoning.context:"all_turns"`。
  - 加上 Lite header。
- `prompt_cache_key` 與 `session-id`：client 有給就用；沒給就用「模型 + 第一則 developer/user 訊息」產生穩定 id，讓同一段對話能命中 prompt cache。
- Chat Completions 的對應：
  - `max_tokens` / `max_completion_tokens` → `max_output_tokens`
  - `response_format` → `text.format`
  - `reasoning_effort` → `reasoning.effort`
  - `n > 1`、audio/file 內容回 400。

## 互動與錯誤

- remote backend 不會發起任何需要使用者互動的事件。tool call 會原樣（或轉成 `tool_calls`）交回 client，由 client 自己決定是否執行、要不要先問使用者。
- 401 時先 refresh token 重試一次，仍失敗才回 401，訊息會附上 `codex login` 指令。這是唯一需要人介入的情況。
- 用量用完（`usage_limit_reached`）回 429，並帶 `Retry-After`。方案不含 Codex（`usage_not_included`）回 403。

## 注意事項與已知限制

- **一個 Codex home 只能有一個 gateway instance**，也不要同時用同一個 home 跑 `codex`。refresh token 只能用一次，同時 refresh 會讓彼此的 token 失效。同一個 home 重複寫在 `--codex-home` 或 `AGENT_GATEWAY_CODEX_HOMES` 裡會啟動報錯。
- alias 由 home 的順序決定：調整 `--codex-home` 或 `AGENT_GATEWAY_CODEX_HOMES` 的順序就會改變 `codexN` 對應到哪個帳號。
- Chat Completions 無法在多輪之間帶回 reasoning item。`/v1/responses` 的 client 回送 output item 時會保留。
- Lite 模型搭配 `tool_choice: "none"` 時，模型可能把 tool call 的語法當成一般文字輸出。
- `x-codex-turn-state` 只有在 client 自己送來時才會轉發。
- 用 Codex 當 client 時，log 會出現一次 `failed to decode models response`。原因是 `/v1/models` 回的是 OpenAI 格式，不影響使用。
- Claude 帳號：`--debug` 也會 log 送往 `api.anthropic.com` 的 request（細節依等級，見上方對照表；`authorization` 同樣只留 scheme）。上游行為細節與未實測項目見 [`CLAUDE_UPSTREAM_PROTOCOL_DIFF.md`](CLAUDE_UPSTREAM_PROTOCOL_DIFF.md)。
- Claude 帳號的 Chat Completions 多輪可以續接 thinking（靠本機狀態檔），但 thinking 文字本身不外顯；換成另一個 Claude home 或刪掉狀態目錄後，進行中的工具回合會回 400，需要重新開始該回合。
