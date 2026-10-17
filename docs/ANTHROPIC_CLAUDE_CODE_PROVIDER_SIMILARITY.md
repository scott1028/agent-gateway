# Anthropic Provider 對官方 Claude Code 的行為相似度

評估日期：2026-10-17（首次評估 2026-10-15；本次依 pinned references 重評，分數不變）。

**本報告以官方 Claude Code 為唯一基準，分別評估其他實作與官方的相似程度：agent-gateway 為 65／100，CLIProxyAPI 為 42.78／100。** 官方基準由 `references/claude-code` 的固定版本識別，未公開的 CLI transport 邏輯以固定官方 native release 補充；分數使用 30 項中的 25 項共同可確認證據。

| 對象 | 比較基準 | 行為相似度 |
|---|---|---:|
| 官方 Claude Code | 基準本身 | **100（定義值）** |
| agent-gateway | 官方 Claude Code | **65／100** |
| CLIProxyAPI | 官方 Claude Code | **42.78／100** |

官方的 100 是參考原點，不表示已掌握官方所有分支。**不再計算 gateway 與 CPA 彼此的相似度。** 前版的「CPA 33 分」是 gateway 對 CPA 的分數，不能解讀為 CPA 對官方的分數，本版已逐項重新判定。

這是依實作證據人工標註、再套公式計算的**行為相似度**，不是程式碼文字相似度、測試覆蓋率、API 成功率或品質評分。兩個分數獨立計算，不需要加總為 100；差異也不必然是錯誤。

## 1. 比較範圍與固定版本

比較範圍是 Anthropic provider 的認證、prompt、模型設定、HTTP、串流與狀態管理。先定義官方各項行為，再各自追蹤 `src/claude/` 與 CPA 的對應路徑，包括共用常數及 session ID 來源。從各部分選取 30 個可辨識的比較點，**不表示已窮舉每一行程式或所有條件分支**。Codex provider、UI、部署與管理介面不計分。

比較基準是第一方 Anthropic OAuth、Linux 檔案憑證及一般互動推論路徑。各列另外指定適用情境；不將 macOS Keychain、企業政策、所有環境變數或 CPA 的全部可選模式默認為相同。

| 對象 | 本次固定參考點 |
|---|---|
| 官方公開 repository（基準來源入口） | `references/claude-code`，`9b4f0d6ef8ceaf62f6b46babb9a4d84bec541a2e` |
| agent-gateway（受評對象） | `dfb0d6ca8243e9d1ff5d5e4643ffe135f7d41fc3`（branch `feat/previous-response-id`；前版 `d6ce854`）；本次只修改報告 |
| 使用者指定的修正 | `6e07ec63c759a3c6e8e3b408e901e874906a43ab`；與前版 `d6ce854` 的 `src/claude/` 沒有差異，與 `dfb0d6c` 的差異見本節重評註記 |
| CLIProxyAPI，以下簡稱 CPA（受評對象） | `references/CLIProxyAPI`，`5fc580b1d72d87a7bcfe5cfb6f479c1aea5625b3`，實際 tag `v8.0.29` |
| 官方執行邏輯補充證據 | 本機 Claude Code native `2.1.299`，`/home/scott/.local/share/claude/versions/2.1.299`（執行檔已不在本機，見本節重評註記） |
| native SHA256 | `2d894a4b1bfaaa9aab72aeff7803e3c73bc2510f279a171f6b8f59f72d17d077` |
| native 內嵌版本資訊 | `GIT_SHA c416f56ec7eca27e49747c35af51d5c92c856ba1`；`BUILD_TIME 2026-10-13T21:37:33Z` |

官方證據分兩層：

1. **repository 直接證據**：`references/claude-code` 的 README、changelog 及實際公開內容。例如 Sonnet 5 的 harness reminder 變更、thinking 顯示能力可直接查核。
2. **官方發行物補充證據**：公開 repository 沒有完整 CLI transport 原始碼，OAuth、request builder、SDK accumulator 等使用上表 native 執行檔的內嵌邏輯。它不是由該 submodule 在本地建置的產物，也不能把 binary 內的 commit 與公開 repo commit 視為同一個 SHA。

**本次分數包含第二層證據，不能標示成「僅由 `references/claude-code` 原始碼得出」。** 若限定只能使用該公開資料夾、不接受官方發行物補充，目前不足以計算這份 provider 層級總分。plugin 的 HTTP 範例不能代替主 CLI；CPA 的註解或測試向量也不能代替官方證據。native byte offset 只適用於上表 SHA256。

EasyCLIProxyAPI 是先前調查的入口，其 `core-version.txt` 指向 CPA `8.0.29`；本次直接比較真正執行 Anthropic 請求的 CPA 核心，不另給桌面包裝層分數。

### 2026-10-17 重評註記

gateway 由 `d6ce854` 改評 `dfb0d6c`。`git diff d6ce854 dfb0d6c -- src/claude` 只有兩處：`src/claude/normalizeRequest.ts` 移除「`previous_response_id` 回 400」的 guard，改由 `handleResponses` 先展開；`src/claude/index.ts` 多 export `readClaudeAccountMetadata`。`src/responses/handleResponses.ts` 在 Claude 路徑另外讀本機 `.claude.json`，並展開或保存 response。逐項對照 A1–F5，這些變更都沒有改到任何一項描述的 wire 行為或狀態方案：上游 `messages` 與帶完整 history 的請求相同（`test/claude/endToEnd.test.ts:472-496`），cache prefix 與 session id 跨輪穩定（`endToEnd.test.ts:498-541`）。因此 30 項標記、A–F 分組分數與總分都不變。

1. **`previous_response_id` 是 gateway 本機的功能**：官方 Messages API 沒有伺服器端狀態，Claude Code 每輪都重送完整 `messages`。gateway 把 response 展開後再送出，所以上游 wire 與完整 history 請求相同。這項不在 30 項範圍內，也不計分。
2. **新增的 response store 與 F4 無關**：它是記憶體 LRU（1000 筆），存放 OpenAI 相容層的 response，不是 F4 的簽章狀態儲存。F4 仍是 `state.ts` 的檔案方案，判定不變。
3. **native 執行檔狀態**：本機 `~/.local/share/claude/versions/` 已自動更新，只剩 2.1.300、2.1.301、2.1.302，2.1.299 執行檔已刪除。本次沒有重新開啟 native 證據，沿用 2026-10-15 依上表 SHA256 記錄的 offset，也沒有重新驗證官方規則。下次換基準時，要用新版 native 重找每個 offset。

cache 實際命中率尚未驗證，限制記在第 6 節。

## 2. 計分演算法

對每個比較點，先固定官方規則，再分別標記 agent-gateway、CPA **與官方**的關係：

| 標記 | 意義 |
|---|---|
| `1` | 在該列明訂的情境與粒度下，受評對象符合官方規則 |
| `0` | 已找到受評對象與官方規則不同的證據 |
| `?` | 官方規則或受評對象的證據不足，尚不能判定；不是零分 |

不給主觀的「半分」。只確認 wire 欄位形狀時，該列就只評形狀，不延伸成整套功能一致。若無法確認該列定義的完整範圍，就保留 `?`。

六組各占總分的 `1/6`。為避免兩個對象用不同證據集合競爭，每組僅使用**官方規則及兩個受評對象都已確認**的共同集合；組內每項等權重。官方規則未知時，兩個對象都必須是 `?`，不能因兩個代理彼此相同就算符合官方。

```text
O = 固定版本的官方 Claude Code（唯一基準）
R = agent-gateway 或 CPA（受評對象）
m(g, i, R | O) = R 對官方規則 O 的標記，為 1、0 或 ?
C_g = { i | m(g, i, gateway | O) != ? 且 m(g, i, CPA | O) != ? }

組分數(g, R | O) = Σ[i ∈ C_g] m(g, i, R | O) / |C_g|
總分(R | O) = (100 / 6) × Σ[g = A..F] 組分數(g, R | O)
共同證據覆蓋率 = Σ[g = A..F] |C_g| / 30
```

若某組 `C_g` 為空，總分暫不成立；不可偷偷算成零分或重新分配權重。需補足證據，或明確發布另一版計分規則。

這是自訂的特徵匹配指標，沒有使用 embedding、字串 edit distance 或 AST 相似度。跨 TypeScript、Go 與 native bundle 比較時，文字近似無法直接回答「實際行為比較像誰」。六組等權重是本次分析選擇，並非產業標準或依流量校準的權重。

## 3. 計算結果

下表兩個分數欄的基準都是官方。

| 組別 | gateway 匹配／共同項目 | gateway 對官方 | CPA 匹配／共同項目 | CPA 對官方 | 共同證據／預定項目 |
|---|---:|---:|---:|---:|---:|
| A 認證與身分 | 4／5 | 80% | 0／5 | 0% | 5／5 |
| B Prompt 與快取 | 3／5 | 60% | 0／5 | 0% | 5／5 |
| C 模型與請求控制 | 3／5 | 60% | 2／5 | 40% | 5／5 |
| D HTTP 與簽章 | 3／3 | 100% | 2／3 | 66.7% | 3／5 |
| E 串流與工具 | 2／5 | 40% | 5／5 | 100% | 5／5 |
| F 恢復與狀態 | 1／2 | 50% | 1／2 | 50% | 2／5 |
| **六組等權重總分** | — | **65／100** | — | **42.78／100** | **25／30，83.3%** |

```text
gateway 對官方 = (100 / 6) × (4/5 + 3/5 + 3/5 + 3/3 + 2/5 + 1/2) = 65
CPA 對官方     = (100 / 6) × (0/5 + 0/5 + 2/5 + 2/3 + 5/5 + 1/2) = 42.777…
```

D 組的 gateway 100% 只代表三個已共同確認的項目，**不代表 CCH 或 TLS 指紋已證實完全相同**。E 組的 CPA 100% 也只限表列五項，不是整個串流模組完全一致。F 組只採兩項，因此每個已知項目的總分影響較大。83.3% 是這張清單的共同證據覆蓋率，不是整份 provider 的程式碼覆蓋率或信賴機率。

### 未知項目的上下界

若未來補齊所有 30 項，六組各五項、各組等權重，便等同每項占 `100/30` 分。把各對象自己的未知項目全部設為 0 或全部設為 1，可得到下列範圍：

| 受評對象（均對官方） | 已知匹配 | 已知不同 | 未知 | 完整 30 項的可能總分 |
|---|---:|---:|---:|---:|
| agent-gateway | 17 | 10 | 3 | `100 × 17/30` 至 `100 × 20/30`，即 **56.67–66.67** |
| CPA | 10 | 15 | 5 | `100 × 10/30` 至 `100 × 15/30`，即 **33.33–50.00** |

這是「補齊未知後」的界限，不是目前共同集合分數的統計信賴區間。以本文件固定的項目、既有判定及權重，補齊未知也不會逆轉 gateway 比 CPA 更接近官方的排序；改選項目、權重或比較路徑則可能改變結果。

## 4. 三方比較與 30 項評分明細

每列由「官方規則」開始，最後兩欄是 **gateway 對官方／CPA 對官方** 的匹配標記。來源代號見第 7 節；任一 `?` 所在的整列會從當前共同計分集合排除。

### A. 認證與身分

| ID | 比較點 | 官方規則（基準） | agent-gateway | CPA | gateway 對官方 | CPA 對官方 |
|---|---|---|---|---|---:|---:|
| A1 | Linux 檔案憑證 schema | 原生 `claudeAiOauth` | 讀寫相同 schema | 扁平 `access_token`／`refresh_token` 等欄位 | 1 | 0 |
| A2 | refresh scope 與拒絕處理 | 展開 scope；符合條件的 `invalid_scope` 改用已存 scope 重試 | 相同展開及 fallback 規則 | 使用固定 scope 清單，沒有同一套分支 | 1 | 0 |
| A3 | 提前 refresh 時間 | 到期前 5 分鐘 | 到期前 5 分鐘 | `RefreshLead()` 為 4 小時 | 1 | 0 |
| A4 | 同 home 的跨程序輪替保護 | 新舊雙檔案鎖，加重讀與 CAS 寫回 | 相同雙鎖及 CAS 協調方式 | refresh singleflight；非官方雙檔案鎖流程 | 1 | 0 |
| A5 | 本地新會話的 session ID 生成政策 | CLI 配置隨機 session UUID，重設會話時可重新產生 | 依輸入識別資訊產生確定性雜湊 | 優先沿用輸入 UUID 或將會話識別轉為 SHA1 UUID；無識別才隨機產生 | 0 | 0 |

證據：[O-A]、[G-A]、[P-A]。A1 不表示所有 OS 的憑證儲存都一致。A5 比較會話識別的配置政策，不是字串是否看起來像 UUID，也不是每次 HTTP send 的 `x-client-request-id`；CPA 的隨機 fallback 不能代表其完整生成政策與官方相同。

### B. Prompt 與快取

| ID | 比較點／適用情境 | 官方規則（基準） | agent-gateway | CPA | gateway 對官方 | CPA 對官方 |
|---|---|---|---|---|---:|---:|
| B1 | 現代模型、一般 system builder 的位置 | 保留頂層 system；其他 mid-system 用途另有分支 | 將 caller 移到第一個合併 user 回合後的 `role:system` | 一般非 strict、非 advisor 特例路徑將 caller 插入 mid-system | 0 | 0 |
| B2 | 預設 system 文字區塊組合 | `K_o` 預設尾部分支以兩個換行合併為一塊 | 同樣合併 | 保留多個 forwarded blocks | 1 | 0 |
| B3 | legacy caller system 位置 | 一般路徑保留頂層 system | 相同 | 降為 user 內的 `system-reminder` | 1 | 0 |
| B4 | GA 後的 mid-system beta | GA feature 的 header 為 null，略過舊 beta | 不送舊 beta | 2.1.280 profile 仍有舊 beta | 1 | 0 |
| B5 | 訂閱快取 1h 的選用政策 | 依訂閱／query allowlist／overage 等條件選擇 | 一律不送 `ttl` | 依 CLI profile／helper／subagent 等條件升級，未實作同一套官方 eligibility | 0 | 0 |

證據：[O-B]、[G-B]、[P-B]。B1 只比較指定一般路徑；兩個代理採相同適配不會得到對官方的加分。B2 只評文字合併，不重複計入位置差異。B5 評官方的選用政策；CPA 有 1h 功能，但條件不同，不能只看輸出的 `ttl:"1h"` 就給 1。

**官方支援 mid-conversation system，不等於官方會把任意 caller system 全部移入對話。** 公開 changelog 的 `2.1.201` 另外記錄 Sonnet 5 不再使用 mid-system role 放置 harness reminders；那是特定提醒用途，不能直接等同第三方 caller prompt 政策。B1 的依據是官方 system builder 與兩個代理的實際位置差異，因此兩個代理都記為 `0`。

### C. 模型與請求控制

| ID | 比較點／適用情境 | 官方規則（基準） | agent-gateway | CPA | gateway 對官方 | CPA 對官方 |
|---|---|---|---|---|---:|---:|
| C1 | 模型目錄是否額外呼叫 Anthropic `/v1/models` | 對應動態能力抓取被 `Dzn(){return!1}` 關閉 | 額外呼叫並快取 | 使用 registry 目錄，不走該 Anthropic 端點 | 0 | 1 |
| C2 | home 的 effort／modelSettings／maxEffortLevel | 讀取 home 設定，套用模型預設、上限與正規化 | 對應支援設定的路徑相同 | 沒有同一套 Claude home 設定流程 | 1 | 0 |
| C3 | adaptive／budget thinking 的 wire 形狀 | `adaptive` 或 `enabled` 加 `budget_tokens` | 相同形狀 | 相同形狀 | 1 | 1 |
| C4 | thinking 開啟且指定具名工具的衝突處理 | 將指定工具降為 `auto` | 回 400，要求 caller 調整 | 移除 thinking 與 effort | 0 | 0 |
| C5 | JSON Schema 的上游表達；代理比較 Responses 轉換路徑 | 原生 structured output 使用 `output_config.format` | 轉成相同欄位 | 該 translator 將 schema 轉為 system instruction | 1 | 0 |

證據：[O-C]、[G-C]、[P-C]。C1 只評是否產生該額外上游呼叫，不表示目錄內容或 metadata 更新方式完全一致。C2 不含完整組織政策與環境覆寫；C3 不表示全部模型 gate、預設值及 budget 邊界一致。C4 的官方證據限定具名 `{type:"tool"}`，不外推至 `any`。C5 的 CPA 結論限定 OpenAI Responses translator，不外推至 Anthropic 原格式 passthrough。

### D. HTTP 與簽章

| ID | 比較點／適用情境 | 官方規則（基準） | agent-gateway | CPA | gateway 對官方 | CPA 對官方 |
|---|---|---|---|---|---:|---:|
| D1 | 第一方主推論串流端點 | `POST /v1/messages?beta=true`、`stream:true` | 相同 | 相同 | 1 | 1 |
| D2 | OAuth 及基本協定 headers | Bearer、`anthropic-version:2023-06-01`、`x-app:cli`、JSON content type／accept | 相同基本集合 | 相同基本集合 | 1 | 1 |
| D3 | 預設 CLI／SDK 版本標記 | `2.1.299`／`0.128.0` | 相同版本 | `2.1.280`／`0.112.1` | 1 | 0 |
| D4 | 官方最終 body 的完整 CCH 規則 | 已找到 native seed；完整正規化未逐一證明 | body 歸零、排除欄位、seeded XXH64、低 20 bits | 有實作及固定向量，尚不足以獨立證實符合本版官方全部規則 | ? | ? |
| D5 | 官方 TLS／HTTP wire 指紋 | 完整指紋未確認 | Node `fetch` | 自訂 uTLS、header 順序等 | ? | ? |

證據：[O-D]、[G-D]、[P-D]。D2 不評完整 header 集合與全部條件；D3 只評版本字串，不表示 OS、runtime version 或其他身分欄位完全一致。D4 中兩個代理的實作或向量互相符合，不能作為符合官方的獨立證明。D5 也不能因 CPA 宣稱模擬官方、或因 gateway 使用不同 transport，就在官方指紋未知時給分。

### E. 串流與工具

| ID | 比較點／適用情境 | 官方規則（基準） | agent-gateway | CPA | gateway 對官方 | CPA 對官方 |
|---|---|---|---|---|---:|---:|
| E1 | 基本文字／tool input delta 累積 | 累加文字與部分 JSON | 相同基本語意 | 相同基本語意 | 1 | 1 |
| E2 | 連續非空 `signature_delta` | 以最新 signature 覆寫 | 串接到已有 signature 後 | 以最新 signature 覆寫 | 0 | 1 |
| E3 | 累計 usage 欄位合併 | 合併已有與後續 usage 欄位 | 相同累計語意 | 相同累計語意 | 1 | 1 |
| E4 | Web Search 的 server-tool 回應支援 | 可處理 `server_tool_use` 與 `web_search_tool_result` | 對這些已知未支援區塊回錯誤 | 有對應接收與轉換 | 0 | 1 |
| E5 | 上游 thinking 文字的對外呈現能力 | 可依設定呈現 thinking／summary | 保存供回放；目前 reasoning 輸出沒有該文字 | 可發出 reasoning summary delta | 0 | 1 |

證據：[O-E]、[G-E]、[P-E]。E2 限非空 signature，CPA 有空值 guard，未將該分支視為完全相同。E3 比較累計更新語意，不要求 native 與 OpenAI 欄位名稱相同。E4 僅評 Web Search 支援，不涵蓋所有 server tools。E5 比較功能能力，不宣稱官方每次請求都會顯示 thinking，也不要求 UI 與 SSE 的呈現方式相同。本文件沒有修改 E2 的實作，也沒有證明所有真實上游回應都會出現多個 signature delta。

### F. 恢復與狀態

| ID | 比較點／適用情境 | 官方規則（基準） | agent-gateway | CPA | gateway 對官方 | CPA 對官方 |
|---|---|---|---|---|---:|---:|
| F1 | 取消訊號向上游傳遞 | signal 傳入 Messages create | `AbortSignal` 傳入 fetch | request context 傳入上游 | 1 | 1 |
| F2 | 完整 401 恢復策略 | 完整分支與外層策略未完成確認 | 已知有重讀／refresh 後重試路徑 | 完整外層策略未完成確認 | ? | ? |
| F3 | mid-system 被拒後 fallback | 有重試移除 system role 並記錄拒絕的分支 | 沒有對應自動 fallback | 完整 wrapper 路徑未確認 | 0 | ? |
| F4 | 簽章狀態儲存及留存方式 | 保存在 CLI transcript | 自有原子 JSON 檔、無自動過期 | replay cache 的 TTL 為 1 小時；記憶體／可選 HomeKV | 0 | 0 |
| F5 | 預設推論 timeout | 600 秒 | 相同 | 最終 transport timeout 未確認 | 1 | ? |

證據：[O-F]、[G-F]、[P-F]。F2 的 `?` 不表示「沒有 401 重試」，而是目前證據不足以比較整套策略。F3、F5 雖能判定 gateway 是否符合官方，仍因 CPA 未知而不納入目前共同集合。

## 5. 哪個實作更接近官方

在本次指標中，**gateway 整體比 CPA 更接近官方**。gateway 的主要匹配來自原生憑證、refresh scope、五分鐘刷新、雙鎖與 CAS、home 設定、一般 system 文字合併，以及目前採用的 CLI／SDK 版本。

**CPA 也有比 gateway 更接近官方的部分**：不額外呼叫 Anthropic 模型目錄、連續非空 signature delta 以最新值覆寫、Web Search 回應支援，以及 thinking 文字對外輸出。這些必須算成 CPA 對官方的匹配，不能因 gateway 沒有做而扣分。

`6e07ec63c759a3c6e8e3b408e901e874906a43ab` 的 caller system 搬移使用 CPA 的代理適配方式；在官方基準下，**兩個代理的這項一般路徑都屬偏差**。先前 OpenCode 實測成功可以支持該適配的必要性，不能把它轉成「符合官方」的證據。

兩個代理都與官方不同的項目，還包括 session ID 配置政策、1h cache eligibility、thinking 加具名強制工具時的處置，以及簽章狀態儲存方案。是否要調整，需另依產品需求及上游證據決定。此處的分數衡量官方行為匹配，不是代理產品的功能完整度。

## 6. 證據限制與重算方式

本次是靜態比較，沒有執行官方 CLI 推論、讀取私人對話或新增上游呼叫。先前完整 OpenCode 請求修正前 HTTP 400、修正後文字與工具續接成功，屬於既有實測紀錄，見 [Anthropic 串接重新比對](CLAUDE_EASYCLIPROXY_COMPARISON.md)。該紀錄不能證明全部 30 項或所有模型均可用。

官方基準本身尚未確認 D4、D5、F2，因此 gateway 與 CPA 在這三項都記 `?`。CPA 另有 F3、F5 未確認：gateway 共 3 項未知，CPA 共 5 項未知。取得同版本完整 CCH／wire 證據，以及完整錯誤恢復與 transport 路徑後，才能補齊。

cache 實際命中率也未驗證：billing header 裡的 `cch` 每次依最終 body 計算，是確定性的 checksum（`src/claude/attribution.ts:82-96`）。body 相同時值相同（例如 401 重送）；跨輪內容改變時 `cch` 可能不同，但計算前會先排除 `max_tokens`、`fallbacks`、`fallback_credit_token`，並把字串型的 `model` 換成 `""`（`attribution.ts:68-74`），所以 body 不同不保證 checksum 不同。帶 `cch` 是官方行為：CPA `internal/runtime/executor/claude_signing.go:180-201` 引用的 native gate，firstParty 打 `api.anthropic.com` 時會帶 `cch`。上游計算 cache 時會不會忽略它，mock 測試證明不了。

重算時：

1. 記錄 gateway、兩個 reference 的 commit，以及官方 binary 版本與 SHA256；不要只寫「最新」。
2. 先從官方來源確認 A1–F5 的規則，再分別開啟兩個受評實作的對應路徑；官方證據失效時，兩邊都標 `?`。
3. 更新每列標記，按第 2 節共同集合公式重算總分及證據覆蓋率。
4. 同時更新各受評對象「對官方」的 30 項未知上下界；若改選項目或權重，另記為新版 rubric，避免與本次分數直接比較。

本版是官方基準版 rubric：除修正比較方向，也明訂 A5 的配置政策、B5 的官方 eligibility、C1 的特定上游呼叫、E2 的非空 signature 及 E4 的 Web Search 範圍。不能將前版的 gateway–CPA 分數直接換標題沿用。

## 7. 來源索引

官方來源入口為 [references/claude-code/README.md](../references/claude-code/README.md) 與 [CHANGELOG.md](../references/claude-code/CHANGELOG.md)。以下 `[O-*]` 是官方規則的證據；`[G-*]`、`[P-*]` 僅是受評對象的證據，不能反過來定義官方行為。

以下路徑均以第 1 節固定 commit 為準。native 的 `@數字` 為該 SHA256 執行檔的十進位 byte offset；符號是該版本的壓縮名稱。來源索引也保留既有詳細報告，方便查閱未在本文件展開的分支。

| 代號 | 可查核來源／定位 |
|---|---|
| [G-A] | [auth.ts](../src/claude/auth.ts)：`getClaudeRefreshScopes`、`requestClaudeTokenRefresh`、`createClaudeAuthManager`；[refreshLock.ts](../src/claude/refreshLock.ts)；[handleClaude.ts](../src/claude/handleClaude.ts) 的 session ID 呼叫 |
| [P-A] | [token.go](../references/CLIProxyAPI/internal/auth/claude/token.go)；[anthropic_auth.go](../references/CLIProxyAPI/internal/auth/claude/anthropic_auth.go)：`RefreshTokens`；[sdk/auth/claude.go](../references/CLIProxyAPI/sdk/auth/claude.go)：`RefreshLead`；[claude_credential_identity.go](../references/CLIProxyAPI/internal/runtime/executor/helps/claude_credential_identity.go)：`ClaudeAgentSessionUUIDForRequest`／`claudeAgentSessionUUID`，由 stream executor 呼叫 |
| [O-A] | native：scope `EHo @214897545`、fallback `@218003400`、expiry `OH @217754567`、鎖 `nGn @217997780`／`pOs @217998206`、CAS `KCr @217983336`；session `q @214707218` 及相鄰的會話重設，`randomUUID as hEe @214642236`；憑證與身分細節見[協定差異報告](CLAUDE_UPSTREAM_PROTOCOL_DIFF.md)第 4、6 節 |
| [G-B] | [normalizeRequest.ts](../src/claude/normalizeRequest.ts)：`callerTexts.join`、`messages.splice`、`systemBlocks`；[modelMetadata.ts](../src/claude/modelMetadata.ts)：`supportsClaudeMidConversationSystem` |
| [P-B] | [claude_executor_cloaking.go](../references/CLIProxyAPI/internal/runtime/executor/claude_executor_cloaking.go)：`checkSystemInstructionsWithSigningModeAt`、`collectForwardedClaudeSystemPromptBlocksWithCache`、`insertClaudeMidConversationSystemBlocks`、legacy reminder 與 TTL；[claude_executor_stream.go](../references/CLIProxyAPI/internal/runtime/executor/claude_executor_stream.go)：`upgradeClaudeCacheControlTTL` 呼叫條件；[claude_executor_request.go](../references/CLIProxyAPI/internal/runtime/executor/claude_executor_request.go)：`claudeCodeCLIBetas` |
| [O-B] | native：`K_o @218995076`、`$Nr @226727459`、主 body `system:Nc.system @226638828`、模型 gate `bL @217933672`、GA `Wy @216789062`／`wL @217936548`、Sonnet 5 `HCr @217933927`／`rJo @225818170`、TTL `z4 @226582681`／`Whe @226582855`；公開 [CHANGELOG.md](../references/claude-code/CHANGELOG.md) 的 `2.1.201` |
| [G-C] | [models.ts](../src/claude/models.ts)、[settings.ts](../src/claude/settings.ts)、[modelMetadata.ts](../src/claude/modelMetadata.ts)、[normalizeRequest.ts](../src/claude/normalizeRequest.ts)：thinking、`tool_choice`、`output_config.format` |
| [P-C] | [model_definitions.go](../references/CLIProxyAPI/internal/registry/model_definitions.go)：`GetClaudeModels`；[thinking/apply.go](../references/CLIProxyAPI/internal/thinking/provider/claude/apply.go)；[claude_executor_request.go](../references/CLIProxyAPI/internal/runtime/executor/claude_executor_request.go)：`disableThinkingIfToolChoiceForced`；[Responses request translator](../references/CLIProxyAPI/internal/translator/claude/openai/responses/claude_openai-responses_request.go)：`BuildClaudeStructuredOutputInstruction` |
| [O-C] | native：目錄 `Dzn @217921071`、home settings `@218708338`、default effort `Je @218713474`、能力表 `@215969375`、具名工具降級 `@226634919` 附近、structured output `rNr @226584124` |
| [G-D] | [client.ts](../src/claude/client.ts)：`buildClaudeHeaders`、`postMessages`；[attribution.ts](../src/claude/attribution.ts) 的最終 body CCH |
| [P-D] | [claude_executor_request.go](../references/CLIProxyAPI/internal/runtime/executor/claude_executor_request.go)：profile defaults；[claude_signing.go](../references/CLIProxyAPI/internal/runtime/executor/claude_signing.go)：`signAnthropicMessagesBody`；[utls_transport.go](../references/CLIProxyAPI/internal/auth/claude/utls_transport.go) |
| [O-D] | native：Messages `@218933955`／`@226675303`、headers `@218991503`／`@218991784`、UA `@218027148`、SDK version `@218715152`、request UUID `@219095310`；CCH seed 位於 machine code `0x3b012c9`，完整演算法仍未知 |
| [G-E] | [sse.ts](../src/claude/sse.ts)、[toResponsesEvents.ts](../src/claude/toResponsesEvents.ts)：delta 累積、signature 字串串接、usage、未支援的 server tools |
| [P-E] | [Responses response translator](../references/CLIProxyAPI/internal/translator/claude/openai/responses/claude_openai-responses_response.go)：`signature_delta` 的 `ReasoningSignature = signature.String()`、usage 合併、server tools、reasoning summary |
| [O-E] | native：主串流 signature 覆寫 `@226691155`，SDK accumulator `@218919200`；usage／content accumulator `@218918200` 附近；server-tool 區塊 `@226688593`、Web Search 結果 `@231692177`、`showThinkingSummaries` 設定 `@215538844`；公開 [CHANGELOG.md](../references/claude-code/CHANGELOG.md) 的 thinking summaries／Ctrl+O 顯示紀錄 |
| [G-F] | [client.ts](../src/claude/client.ts)：signal、timeout、401 send；[auth.ts](../src/claude/auth.ts)：`recoverUnauthorized`；[state.ts](../src/claude/state.ts) 的檔案儲存與回放 |
| [P-F] | [claude_executor_stream.go](../references/CLIProxyAPI/internal/runtime/executor/claude_executor_stream.go)：`http.NewRequestWithContext`；[claude_thinking_replay_cache.go](../references/CLIProxyAPI/internal/cache/claude_thinking_replay_cache.go)：`ClaudeThinkingReplayCacheTTL`、HomeKV；完整 401／fallback／timeout 尚未確認 |
| [O-F] | native：取消 `@226675303`、mid-system 拒絕 fallback `@226652450`、預設 timeout `@219078970`／`@219079599`；transcript 與 gateway 狀態方案差異見[協定差異報告](CLAUDE_UPSTREAM_PROTOCOL_DIFF.md)第 7 節；完整 401 策略仍未知 |

相關歷史證據：[CLAUDE_EASYCLIPROXY_COMPARISON.md](CLAUDE_EASYCLIPROXY_COMPARISON.md)、[CLAUDE_UPSTREAM_PROTOCOL_DIFF.md](CLAUDE_UPSTREAM_PROTOCOL_DIFF.md)。本文件採用較窄的情境定義；舊報告中的「一致」不得外推超過上述各列範圍。
