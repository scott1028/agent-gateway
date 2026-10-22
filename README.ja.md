[繁體中文](README.md) | [English](README.en.md) | **日本語**

# <img src="assets/icon.png" width="40" alt="" /> agent-gateway

![agent-gateway の看板娘：ミントグリーンのショートヘアの受付係が赤レンガの台に座り、高い柱が並ぶ地下ホールで何層もの緑のパイプが交差・合流している](assets/banner.png)

agent-gateway は、あなたのパソコンで動く小さな中継所です。ほかの AI ツールが、ログイン済みの ChatGPT（Codex）や Claude Code のアカウントを借りて使えるようにします。

万能の変換プラグだと思ってください。ツールは OpenAI の「言葉」しか話せませんが、agent-gateway がそれを Codex や Claude のアカウントにつなぎます。ツール側は OpenAI の `base_url` を `http://127.0.0.1:8765/v1` に変えるだけです。

> これは非公式な使い方です。公開されていない内部 API に接続するため、いつ変更・ブロックされてもおかしくありません。利用量はあなた自身の ChatGPT／Claude プランの枠から差し引かれます。使う前に OpenAI と Anthropic の利用規約を自分で確認してください。

## 特長

| 特長 | かんたんな説明 |
|---|---|
| OpenAI 互換 | OpenAI 形式に対応したツールなら、`base_url` を変えるだけで使えます |
| 2 種類のアカウント | 1 つの gateway で ChatGPT（Codex）と Claude Code のサブスクリプションログインを同時に扱えます |
| 5 つの endpoint | `/v1/models`、`/v1/responses`、`/v1/chat/completions`。ストリーミングと tool calls に対応。ほかに `/v1/messages`（公式 Claude Code はそのまま転送、その他の client は公式の形に組み直す降轉）と、公式 Codex CLI 専用の `/backend-api/codex/*`（そのまま転送）があります（[利用ガイド](docs/GUIDE.md)の「官方 Claude Code 連 gateway」「其他 Anthropic client（降轉）」「官方 Codex CLI 連 gateway」を参照） |
| 複数アカウント | アカウントごとに home を 1 つ用意し、`codex1`、`codex2`、`claude1`… と自動で名前が付きます。model の接頭辞でアカウントを選びます（例：`codex2/gpt-5.6-terra`） |
| 公式のルールどおりに接続 | リクエスト形式、header、token の更新方法は公式 CLI のやり方に合わせています。下の「公式とどれくらい似ている？」を参照 |
| 基本はローカル専用 | 初期設定では `127.0.0.1` だけで待ち受け、API key は不要です。ほかのマシンから使うときは `--host` と `AGENT_GATEWAY_API_KEY` を設定します（[利用ガイド](docs/GUIDE.md)の「對外開放」を参照） |
| token の自動更新 | 401 が返ると token を更新して 1 回だけ再試行します。Claude アカウントは公式 CLI と同じ更新ロックを使うので、取り合いになりません |
| ツールのターンを再開できる | Claude の thinking 署名をローカルに保存するので、gateway を再起動しても同じツールのターンを続けられます |
| デバッグレベル | `--debug 0`〜`3` で表示する詳しさを選べます。token は表示されませんが、prompt はそのまま表示されます |
| 単一の実行ファイル | Linux、macOS、Windows の実行ファイルと AppImage を用意。Node.js 入りなので追加インストールは不要です |

## 公式とどれくらい似ている？

公式 CLI を「模範解答」と考え、いつも 100 点とします。接続の細かい点（URL、header、ログイン方法など）を 1 問ずつ答え合わせし、同じなら得点、違えば 0 点、まだ確認できない問題は数えません。

| 上流 | 対象 | スコア（公式 = 100） | 比較したバージョン | 詳細レポート |
|---|---|---:|---|---|
| Claude | 公式 Claude Code | **100**（基準） | `references/claude-code` `9b4f0d6`＋native 2.1.299 | [Claude 類似度](docs/ANTHROPIC_CLAUDE_CODE_PROVIDER_SIMILARITY.md) |
| Claude | **agent-gateway** | **65** | `dfb0d6c` | 同上 |
| Claude | CLIProxyAPI | 42.78 | `references/CLIProxyAPI` v8.0.29（`5fc580b`） | 同上 |
| Claude | EasyCLIProxyAPI | 別途採点なし | デスクトップ用の外側の殻で、接続の中核は CLIProxyAPI v8.0.29 | [EasyCLIProxyAPI 比較](docs/CLAUDE_EASYCLIPROXY_COMPARISON.md) |
| Codex | 公式 Codex CLI | **100**（基準） | `references/codex` `0d58012` | [Codex 通信差異 §4.1.1](docs/CODEX_UNSLOTH_PROTOCOL_DIFF.md) |
| Codex | **agent-gateway** | **82.35** | `dfb0d6c` | 同上 |
| Codex | Unsloth | 35.29 | `references/unsloth` `1fdcdb5` | 同上 |
| Claude | Claude そのまま転送（公式 Claude Code → `/v1/messages`） | **100**（別計算：判定できる 28 項目はすべて一致。30 項目がそろうと 93.33–100） | native 2.1.302 | [Claude 類似度 §3](docs/ANTHROPIC_CLAUDE_CODE_PROVIDER_SIMILARITY.md)、[Claude 通信差異 §13](docs/CLAUDE_UPSTREAM_PROTOCOL_DIFF.md) |
| Codex | Codex そのまま転送（公式 Codex → `/backend-api/codex/*`） | **100**（別計算：17／17） | Codex CLI 0.163.0 | [Codex 通信差異 §4.1.1](docs/CODEX_UNSLOTH_PROTOCOL_DIFF.md)、[Codex WebSocket 転送 §11](docs/CODEX_WEBSOCKET_TRANSPORT.md) |

- Claude と Codex では問題が違います。Claude は 30 問・6 グループ、Codex は endpoint／header の 17 項目だけを比べています。両者のスコアは比べられません。
- スコアは「公式と同じ接続のしかたか」だけを見ています。品質の点数ではなく、非公式ツールだと見抜かれないことも保証しません。
- Codex 経路の User-Agent にはあえて自分の名前 `agent-gateway` を入れているため、その問題は 0 点です。
- Codex の最も厳しい数え方：公式が条件付きで送る 8 つの header も含めると（どちらも送っていません）、gateway は 56、Unsloth は 24 です。
- 2b の降轉（ほかの Anthropic client → `/v1/messages`）は Claude の 65 点を基準として使います。`/v1/responses` の Claude 経路と同じ組み立て層を共有しているためです。
- 2 つのそのまま転送の 100 点は別計算です。上流へのリクエストは公式 client 自身が組み立てるため、判定できる項目はすべて公式と一致します。Claude は同じ 30 項目の rubric を使い、client が実際に使う native 2.1.302 を基準にしています。判定できる 28 項目はすべて一致し、D5（TLS 指紋）と F2（401 からの回復方針の全体）は公式側のルールが未確認のため不明のままです。30 項目がそろった場合の範囲は 93.33–100 です。Codex は 17／17 です。公式に対してだけ採点したもので、CLIProxyAPI と共通集合を取る方法ではないため、65／42.78 と直接比べることはできません。
- 100 点に含まれないもの：TLS と HTTP の実装が違います（gateway は Node `https`、公式は Bun、reqwest、tungstenite）。token は同じアカウントの別の認証情報です。`host` と `content-length` はこの区間の接続の値です。Claude の count_tokens は紐付け済みの session だけを転送します。このスコアは公式と挙動が完全に同じという意味ではありません。
- 評価日と基準：もとの採点は 2026-10-17 で、Claude の公式側の証拠は native 2.1.299 の記録をそのまま使っています。2 つのそのまま転送の行は 2026-10-18 に追加したもので、基準は native 2.1.302 と Codex CLI 0.163.0 です（Claude の A1–A4 は 2.1.299 での判定をそのまま使っています）。
- 2026-10-22 更新：3 つの上流参照 pin を更新し、Claude の 2 項目と Codex の 1 項目の挙動を合わせました。上のスコアと歴史的な基準はそのままです。詳細は [上流更新と整合の報告](docs/UPSTREAM_UPDATE_2026-10-22.md) を見てください。

## クイックスタート

1. [GitHub Releases](https://github.com/scott1028/agent-gateway/releases) から自分の環境の実行ファイルをダウンロードするか、ソースコードを使います（Node.js 22 以上が必要）。
2. 公式 CLI で**専用の** home にログインします。ふだん使う `~/.codex` をそのまま使うと、token の取り合いになります。
3. gateway を起動し、home の場所を指定します。gateway にはデフォルトの home がありません。

```bash
# Codex（ChatGPT アカウント）
mkdir -p ~/.agent-gateway && chmod 700 ~/.agent-gateway
CODEX_HOME=~/.agent-gateway codex login        # ブラウザがない環境では --device-auth を付ける

./agent-gateway-<バージョン>-linux-x64 --codex-home ~/.agent-gateway
# ソースコードから：npm install && npm run build && npm start -- --codex-home ~/.agent-gateway
# agent-gateway listening on http://127.0.0.1:8765/v1
```

```bash
# Claude（Claude Code のサブスクリプション）。Codex と同時に使えます
mkdir -p ~/.agent-gateway-claude && chmod 700 ~/.agent-gateway-claude
CLAUDE_CONFIG_DIR=~/.agent-gateway-claude claude     # 起動後に /login と入力

./agent-gateway-<バージョン>-linux-x64 --codex-home ~/.agent-gateway --claude-home ~/.agent-gateway-claude
```

```bash
# すぐ使う：$HOME 直下のログイン済み .codex、.codex-*、.claude、.claude-* をまとめて使う
./agent-gateway-<バージョン>-linux-x64 --auto
#   codex1 -> /home/you/.codex
#   claude1 -> /home/you/.claude
```

`--auto` は普段の `codex` CLI と同じ home を使います。gateway の実行中は同じ home で `codex` を動かさないでください。どちらかがログアウトされます。詳しくは[利用ガイド](docs/GUIDE.md)の「自動掃描 home（`--auto`）」を見てください。

既定で `--relay-fallback=degrade` が有効（`--relay-fallback=reject` で無効化）。公式 relay のアカウント／形状チェック失敗時に gateway 自身の組み立てへ切り替えます。CLI の再起動は不要です。類似度の基準は Claude 65／Codex 82.35 で、100 ではありません。推論の記録は gateway 再起動で消え、Codex が 426 を受けた後はその session が HTTP のみを使います。WS の alias 制限と未検証の R1 リスクは[利用ガイド](docs/GUIDE.md#relay-檢查失敗時降轉--relay-fallback)を参照してください。

checksum の確認、macOS／Windows の初回起動時の警告、AppImage の使い方、環境変数とすべてのオプションは[利用ガイド](docs/GUIDE.md)（中国語）を見てください。旧 codex-proxy から移行する場合は、先にガイドの移行手順を読んでください。

## ツールをつなぐ

`AGENT_GATEWAY_API_KEY` を設定していなければ、`apiKey` は何でもかまいません。gateway はチェックしません。設定している場合は同じ key を指定します。

```js
// OpenAI SDK
const client = new OpenAI({ baseURL: 'http://127.0.0.1:8765/v1', apiKey: 'unused' });
```

```bash
# aider
aider --model openai/codex1/gpt-5.6-terra --openai-api-base http://127.0.0.1:8765/v1 --openai-api-key unused

# Codex 本体
codex exec -c 'model_providers.agent-gateway={ name = "agent-gateway", base_url = "http://127.0.0.1:8765/v1", wire_api = "responses" }' \
  -c model_provider=agent-gateway -m codex1/gpt-5.6-terra "your prompt"
```

## 注意すること

- 1 つの home は 1 つの gateway だけで使い、同時に `codex` も動かさないでください。refresh token は 1 回しか使えないため、同時に更新すると互いを無効にしてしまいます。
- `previous_response_id` は gateway 内で処理します。完了した response をメモリに保存し（最大 1000 件、再起動で消えます）、id を会話全体の input に展開してから上流に送るため、上流へのリクエストは会話全体を送った場合と完全に同じです。`store:false` の response は保存しません。`instructions` と `tools` は引き継がないので毎回送ってください。続けるときは同じアカウントの model を使ってください。同じ home で別のアカウントにログインし直した後は、古い id では続けられません。
- 利用枠を使い切ると 429、Codex を含まないプランでは 403、token を回復できないときは 401 を返し、再ログインのコマンドを表示します。
- そのほかの制限や変換ルールは[利用ガイド](docs/GUIDE.md)を見てください。

## その他のドキュメント

以下のドキュメントは繁体字中国語で書かれています。

| ドキュメント | 内容 |
|---|---|
| [利用ガイド](docs/GUIDE.md) | 詳しい設定、環境変数、デバッグレベル、複数アカウント、Claude の詳細、変換ルール、既知の制限、移行手順 |
| [開発とパッケージング](docs/DEVELOPMENT.md) | ローカルでのビルドと検証、AppImage、GitHub でのリリース、プロジェクトのチェック |
| [Claude 類似度](docs/ANTHROPIC_CLAUDE_CODE_PROVIDER_SIMILARITY.md) | 公式 Claude Code を基準にした 30 項目の採点 |
| [Claude 通信差異](docs/CLAUDE_UPSTREAM_PROTOCOL_DIFF.md) | Claude 上流の header、OAuth、SSE と、公式との違い |
| [EasyCLIProxyAPI 比較](docs/CLAUDE_EASYCLIPROXY_COMPARISON.md) | EasyCLIProxyAPI／CLIProxyAPI の接続方法と認証情報の評価 |
| [Codex 通信差異](docs/CODEX_UNSLOTH_PROTOCOL_DIFF.md) | Codex 上流を Unsloth・公式 Codex CLI と比べた結果と類似度 |
| [Codex WebSocket 転送](docs/CODEX_WEBSOCKET_TRANSPORT.md) | 公式 Codex CLI のそのまま転送経路（`/backend-api/codex/*`）では WebSocket を実装済み。OpenAI 互換経路（`/v1/responses`）は今も HTTP で、方式 B（gateway が上流の WebSocket を管理する方式）は未実装。評価、選択肢、リスクも記載 |
| [類似度の差と改善](docs/SIMILARITY_GAPS.md) | 「公式とどれくらい似ている？」の各スコアが 100 でない理由、差の原因、改善の方向（試算は正式スコアを変えません） |
| [動作フロー図](docs/ARCHITECTURE_FLOWS.md) | agent client、agent-gateway、公式 BE の三者のルーティング判断と swimlane のフロー図 |
| [看板娘とアイコン](assets/README.md) | 画像素材、ComfyUI workflow、作り直す手順 |

## 開発

```bash
npm run typecheck
npm test
```

`npm run poc` は実際に上流を呼び出して利用枠を消費します。上流の動作を変えたあとに手動で実行するときだけ使ってください。詳しくは[開発とパッケージング](docs/DEVELOPMENT.md)を見てください。
