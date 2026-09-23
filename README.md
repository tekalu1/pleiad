# Pleiad

Pleiad は、複数のコーディングエージェント（Claude Code、OpenAI Codex、Google Antigravity）を一つの画面で扱うためのデスクトップアプリ。
Claude Code と Codex は、公式の接続先のほかに互換の接続先（OpenRouter・LiteLLM・ローカルの Ollama など）を登録して会話ごとに選べる。
会話の一覧・状態・分岐・承認・成果物の提示を、エージェントの違いを意識せずに同じ操作で扱える。

> セッションを離れずに済むこと —— 見るために離れる／思い出すために離れる／続けるために離れる、を無くす。

設計と判断の理由は [`docs/design.md`](docs/design.md)。見た目の規則は [`docs/design-system.md`](docs/design-system.md)。

## 状態

**評価版（beta）。** 機能・画面・保存データの形式は予告なく変わることがある。
配布しているのは自己署名の評価版で、公的な認証局によるコード署名はまだ無い。

## 対応 OS

- **配布物（インストーラー）**: Windows 10 / 11（x64・ARM64）
- **ソースからのデスクトップ版**: Windows / macOS（macOS の署名・公証付きの配布物は未提供）
- **ブラウザーで使うサーバー版**（`npm start`）: Node.js 20.19.0 以上が動く Windows / macOS / Linux

## インストール

[Releases](https://github.com/tekalu1/pleiad/releases) から最新の評価版のインストーラー（`Pleiad-<version>-win-<arch>.exe`）を取得する。
評価版は**自己署名**のため、Windows の SmartScreen が警告を出すことがある。
公開証明書（`Pleiad-Evaluation.cer`）の確認・信頼の手順、自動更新の前提（現在は GitHub CLI でのログインが必要）は
[`docs/desktop-releases.md`](docs/desktop-releases.md) の「自己署名での評価」「配布と利用者認証」「自己署名の先行版（現在の運用）」を参照。
`SHA256SUMS.txt` と `SIGNING-INFO.json` で、取得したファイルと証明書の指紋を照合できる。

使うエージェントは、それぞれの CLI とログイン（またはサブスクリプション）を利用者が用意する。Pleiad はそれらの資格情報を代わりに発行しない。

## 開発の始め方

Node.js 20.19.0 以上を使用する。

```bash
npm ci
npm start
```

起動時に URL とトークンが出る。ブラウザで開く。

```
AGENT_HOST_TOKEN   固定トークン（既定: 起動ごとにランダム生成）
AGENT_HOST_PORT    既定 7420。予約済み/使用中なら空きポートへ自動で逃がす
AGENT_HOST_BIND    既定 127.0.0.1
AGENT_HOST_DATA    sidecar の置き場（既定 ~/.agent-host）
AGENT_HOST_BACKENDS 使うバックエンド（カンマ区切り。既定 claude,codex,antigravity。絞るなら例: claude）
AGENT_HOST_CODEX_BIN codex の実行ファイル（既定 codex）
AGENT_HOST_AGY_BIN   Antigravity CLI の実行ファイル（既定 agy）
```

`npm test` は LLM を呼ばない検査（描画の安全性、イベントの選り分け、fake バックエンドでのサーバ往復、見た目の規則の lint）。
`npm run test:e2e` はサーバを立てて実際に LLM を呼ぶ。

デスクトップ版は `npm run desktop`。インストーラー生成は `npm run desktop:dist`（対象 OS で実行）。
配布手順、初期設定・使い方のオンボーディングは [`docs/desktop-onboarding.md`](docs/desktop-onboarding.md)、リリース運用は [`docs/desktop-releases.md`](docs/desktop-releases.md)。
リポジトリでの作業手順は [`AGENTS.md`](AGENTS.md)。

## エージェントごとの認証と挙動

認証は Claude Code のログインをそのまま使う。`ANTHROPIC_API_KEY` が設定されていると
そちら（従量課金）が優先されるので、サブスクで動かすなら未設定にしておく。
Claude のサブスクを複数使い分けるなら、設定の「エージェント設定」→ Claude Code の「アカウント」に `claude setup-token` で発行したトークンを登録すると、
会話ごとに入力欄（モデルの隣）でアカウントを選べる。選ばない会話はログイン中のアカウントで動く。
トークンはブラウザーでログイン中の claude.ai のアカウントで発行されるので、発行前にそのアカウントへ切り替えておく（使用量の表示の認可と別のアカウントのトークンなら、一覧に警告が出る）。
Codex と Antigravity のログインはサイドバー下の「バックエンド認証」から張れる（`~/.codex/auth.json` は codex が書く）。
Antigravity は未インストールなら「インストール」が出る（インストーラは Windows なら `%LOCALAPPDATA%\agy\bin`、
Unix なら `~/.local/bin` へ置く。どちらも Pleiad が直接見るので、入れたあとは「再確認」だけでよく、Pleiad の再起動は要らない）。
**Antigravity のログインは端末で行う。** `agy` は認可コードを端末からしか読まないため、Pleiad からは回せない
（公式も「Authenticate once with an interactive `agy` session first」としている）。
「ログイン」を押すと端末で叩くコマンドが出るので、それを実行して Google にログインする。
済むと Pleiad が気づいて表示が切り替わる（「再確認」を押さなくてよい）。
資格情報は OS の資格情報ストアに入るため、ログアウトも `agy` 側で行う。

Codex の承認モードは「都度確認」「auto」「全部自動」「YOLO」「読むだけ」。
「全部自動」は作業ディレクトリ内の制限を残して確認を省く。
「YOLO」は確認なしで Codex のサンドボックス制限を解除し、全ファイル・ネットワークへのアクセスを許可する。
変更は次のターンから反映され、実行途中のターンや既存の承認待ちは変更しない。
OS や管理者が別途設定した権限制限は YOLO でも解除されない。

Antigravity は **Google のサブスク枠（AI Pro / Ultra）を使える唯一のバックエンド**。
そのかわり `agy` のヘッドレスには**対話承認が無い**ので、選べる承認モードは「全部自動」の1つだけ。
`--dangerously-skip-permissions` を付けない限りツールは黙って拒否されるため、
「計画だけ」「編集は自動」「都度確認」は出さない（選んでも何もできないものを並べないため）。
思考も流れず、ツールは終わってから出る。
本文はデルタで流れるので、会話の見え方そのものは他と変わらない。
`agy` に一覧も履歴も無いため、会話の控えは Pleiad が `AGENT_HOST_DATA` の下に書く。

## 構成

```
core/    Node。WebSocket サーバ。ここはバックエンド非依存
  protocol.mjs   プロトコル定数（protocolVersion）と正規化イベントの一覧
  server.mjs     HTTP + WS、token gate、承認の保留・猶予・中断
  store.mjs      sidecar（バックエンドが持たない差分 + 全バックエンド横断のインデックス）
  history.mjs    present の永続化。会話本文はバックエンドに委譲
  backends/      エージェント1種類 = 1ファイル
    index.mjs            レジストリ（AGENT_HOST_BACKENDS で有効化するものを選ぶ）
    claude.mjs           Agent SDK。**SDK を呼ぶのはここだけ**
    claude-normalize.mjs SDK メッセージ -> 正規化イベント（SDK 非依存・テスト可能）
    codex.mjs            OpenAI Codex（`codex app-server`）
    codex-rpc.mjs        その stdio JSON-RPC クライアント（1プロセスを全スレッドで共有）
    antigravity.mjs      Google Antigravity CLI（`agy` のヘッドレス）
    antigravity-cli.mjs  その NDJSON クライアント（1プロセス = 1会話）
    antigravity-store.mjs 会話の控え（agy に一覧も履歴も無いため Pleiad が書く）
    fake.mjs             テスト用。LLM もネットワークも使わない
web/     ブラウザ。素の ESM。ビルド無し。PDF表示時だけローカル配信のPDF.jsを読む
  tokens.css     配色・余白・角丸・動きのトークン（面 / 塗り / 文字 / 線 の 4 族）
  client.mjs     WS 接続・イベント・会話・入力欄
  side.mjs       脇のパネル（セッション一覧・絞り込み・ドラッグで状態変更・グループのアイコン）
  emoji.mjs      絵文字の一覧（アイコン選択。日本語 / 英語の検索語付き）
  branches.mjs   分岐（系譜・分岐点の曲線と札・枝の動き）
  combo.mjs      独自のプルダウン（候補 + 自由入力）
  arc.mjs        走っている印（回る白い弧）
  dom.mjs        要素を作る定型・SVG・相対時刻（web/ 共通の下請け）
  render.mjs     md / 提示 / ツール呼び出しの描画（自前。XSS 監査対象）
desktop/ Electron main / preload。自動更新
tests/   run.mjs（単体 + fake サーバ + lint-design.mjs）と e2e.mjs（実 LLM）
```

core が web へ流すのは**正規化イベント**だけで、バックエンドごとのプロトコルは漏れない
（`docs/multi-backend.md` §2.2）。

Claude バックエンドではメタ情報の正本が `~/.claude`（SDK ネイティブの tag / customTitle / fork）なので、
ここで付けた状態やタイトルは**公式の CLI・VS Code 拡張からも見える**。
ネイティブに持てないバックエンドでは sidecar が正本になる（書き込みは常に両方）。

## セキュリティの前提

- サーバはローカル bind（既定 `127.0.0.1`）とトークンで守る。誤トークンは 401。リモート公開は想定していない
- md 描画は XSS のパターン（生 script / img onerror / javascript: / data: / 生 iframe / 見出し・表セルへの混入など）を含むケースで検査している
- 提示 HTML は `sandbox=""`（`allow-scripts` 無し）+ CSP + `referrerpolicy=no-referrer`
- 脆弱性の報告は [`SECURITY.md`](SECURITY.md) を参照

## 注意

サーバを再起動すると**実行中のターンは全部死ぬ**。
落とす前に「動いているもの」が 0 件か確認すること
（一覧の行に付く走っている印、または WebSocket の `running` コマンド）。

相対パスで指示すると、モデルが絶対パスを推測して見当違いの場所に書くことがある
（セッション自体は指定 cwd に正しく根付いていて、Glob 等の cwd 起点ツールは正しく効く）。
確実にしたいときは絶対パスで指示する。

## サードパーティ

- `core/auth/oauth-page.mjs`（OAuth のコールバックに出すページ）は pi-ai（MIT）に由来する。表記は [`core/auth/LICENSE-pi-ai.md`](core/auth/LICENSE-pi-ai.md)
- `web/brand/` のエージェントのロゴは各社の商標で、それぞれの権利者に帰属する。LobeHub の lobe-icons（MIT）由来のものは [`web/brand/lobe-icons-LICENSE`](web/brand/lobe-icons-LICENSE)、出典は [`web/brand/README.md`](web/brand/README.md)
- Claude バックエンドは Anthropic の [Claude Agent SDK](https://github.com/anthropics/claude-agent-sdk-typescript)（`@anthropic-ai/claude-agent-sdk`）を使う。SDK と Claude の利用は Anthropic の利用規約に従う
- そのほかの npm 依存は、それぞれのライセンスに従う（`package-lock.json`）

## ライセンス

[Apache License 2.0](LICENSE)。著作権表示は [NOTICE](NOTICE)。

「Pleiad」の名前とロゴはこのライセンスの対象外で、利用を許諾しない（Apache License 2.0 第 6 条）。フォークして配布する場合は別の名前を使うこと。
