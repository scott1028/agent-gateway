# agent-gateway 開發與打包

## 本機 Binary 建置與驗證

建置使用 `.node-version` 固定的 Node.js 22.22.3，以及 lockfile 固定的 esbuild／postject。Node.js SEA 保留 Node runtime；打包不改變 HTTP、認證或串流協定。先切換到指定的 Node.js 版本，執行 `npm ci`，再於目標平台原生建置。以下命令只在本機產生檔案，不會推送 GitHub、建立 release 或觸發 Actions：

```bash
npm run typecheck
npm test
npm run build
npm run build:binary

gateway_version=$(node -p "require('./package.json').version")
gateway_sha=$(git rev-parse --short=7 HEAD)
gateway_target=$(node -p "process.platform + '-' + process.arch + (process.platform === 'win32' ? '.exe' : '')")
gateway_binary="dist/release/agent-gateway-${gateway_version}-${gateway_sha}-${gateway_target}"
npm run verify:binary -- "$gateway_binary"
```

`verify:binary` 會把 binary 複製到專案外的暫存目錄，清空其啟動檢查使用的 `PATH`，驗證不依賴外部 Node.js 或 `node_modules`。接著使用假登入資料與本機 mock 上游，檢查啟動、缺少 home 時的錯誤、Codex／Claude 請求，以及內嵌 WASM 簽章。驗證不使用真實帳號，也不消耗上游額度。

Linux x64／arm64 可繼續打包 AppImage，並在不依賴 FUSE 的情況下檢查啟動及解壓後的完整功能：

```bash
npm run build:appimage -- "$gateway_binary"
gateway_appimage="$PWD/$gateway_binary.AppImage"
APPIMAGE_EXTRACT_AND_RUN=1 "$gateway_appimage" --help

gateway_check_dir=$(mktemp -d "$PWD/.tmp/appimage-local-check.XXXXXX")
(
  cd "$gateway_check_dir"
  "$gateway_appimage" --appimage-extract > extract.log
)
npm run verify:binary -- "$gateway_check_dir/squashfs-root/AppRun"

(
  cd dist/release
  sha256sum "$(basename "$gateway_binary")" "$(basename "$gateway_binary").AppImage" > SHA256SUMS.local
  sha256sum -c SHA256SUMS.local
)
```

AppImage 內含 [定稿 icon](../assets/icon.png)；解壓後的 `verify:binary` 也會比對圖示內容，避免打包到舊圖示。AppImage 工具固定為 appimagetool 1.9.1、type2-runtime 20251108，下載時驗證官方 release asset 的 SHA-256；工具快取於 `.tmp/release-tools/`，首次使用需要下載。

建置中間檔放在 `.tmp/`，成品與本機校驗碼放在 `dist/release/`。手動本機建置尚未提交的修改時，檔名仍使用 HEAD SHA，內容包含目前工作目錄的程式與圖示。本機建置只驗證當前作業系統與架構，並沿用打包時的 Node.js runtime；不代表已驗證其他平台或更舊的系統環境。

## GitHub 發佈

正式發佈一律從 Actions checkout 的確切 commit 建置，與上述本機建置分開執行。

- 自動發佈：push 到 repository 預設分支（目前 `master`），且整次 push 前後 `package.json.version` 不同。只改其他欄位不發佈；沒有有效比較基準時跳過，改用手動發佈。
- 手動發佈：GitHub → Actions → **Release binaries** → **Run workflow**，選擇 branch/ref。不需先改版號；也可用 `gh workflow run release.yml --ref <branch-or-tag>`。workflow 必須先存在預設分支，才會出現手動按鈕。
- 同版本、不同 commit 可各自發佈；相同標籤已正式發佈時跳過，不覆寫附件。已有 draft 時可重跑，補齊附件後發布。
- 發佈先通過 typecheck、完整測試、build，再於六個原生 runner 建置並執行 binary smoke check；Linux 另驗證 AppImage。八份成品加 `SHA256SUMS` 全部上傳後才正式發布。
- 使用內建 `GITHUB_TOKEN`，只有發布 job 有 `contents: write`，不需要額外 secrets。repository 必須允許 Actions，並有可用的對應平台 runner／配額。

打包依據：[Node.js 22.22.3 SEA](https://nodejs.org/download/release/v22.22.3/docs/api/single-executable-applications.html)、[AppImage 手動打包](https://docs.appimage.org/packaging-guide/manual.html)、[GitHub Actions 觸發規則](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows)。

## 專案檢查

```bash
npm run typecheck
npm test
npm run poc               # 重新實測 backend 行為（約 50 個小 request，會用到額度）
npm run poc -- --refresh  # 只實測一次 token refresh
npm run poc:claude -- --claude-home ~/.agent-gateway-claude   # 手動實測 Claude 上游（會用到額度；拒絕 ~/.claude）
#   該腳本只跑：模型清單、文字回合、tool call + 續接回放、下一 user 回合；
#   不測 JSON Schema 請求、真實鎖競爭/CAS 輪替或 cache 命中（見 docs §11）。
```
