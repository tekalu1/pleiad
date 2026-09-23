# procway-code の接続設定

設定 → エージェント設定 → procway-code の「接続先を設定」で、アカウントログイン、OpenAI、Anthropic、互換 API（OpenAI / Anthropic 形式）を登録できる。既存の procway-code の providers と資格情報ファイルも読み込む。Pleiad の追加接続先は `~/.agent-host/procway-connections.json`（`AGENT_HOST_DATA` に従う）に保存し、元の設定・プロファイルを書き換えない。

会話の入力欄では、モデルのチップ（「接続先 · モデル」）の面で接続先とモデルを別々に選ぶ（`web/composer-controls.mjs` と `web/procway.mjs` の `view()`。見た目は `docs/design-system.md`「入力欄の設定」）。モデル ID は自由入力でき、接続先の既定のモデルと接続確認で取れた一覧を候補に出す。変更は既存の `nextSettings` に予約し、次の送信で適用する。キャンセル、再読み込み、別画面からの設定変更は既存の予約フローに従う。新しい会話には接続先とモデルを確定して保存し、既定変更で既存の会話の接続先が動かないようにする。

## 資格情報と確認

- Windows のキー入力は DPAPI CurrentUser で暗号化する。平文をコマンド引数、通常の設定 JSON、ブラウザーの永続ストレージ、応答に出さない。ほかの OS では環境変数・procway-code の既存資格情報を使う。
- 資格情報の保護処理は子プロセスの標準入力・出力だけを使い、エラーに内容を載せない。
- API 接続確認はモデル一覧を取得し、指定 ID が含まれることを確かめる。推論・課金対象の生成リクエストは送らない。モデル一覧 API 非対応のサービスは、この登録フローでは確認済みとして保存しない。
- 確認済みの設定に対する短命な receipt が必要。確認後に名前、モデル、キー、URL などを変えると再確認する。HTTP リダイレクトで別の接続先に資格情報を転送しない。
- ChatGPT は既存 OAuth プロファイルの存在を確認する。モデル利用可否は送信時に確かめるため、「モデル確認済み」とは表示しない。
- WebSocket のコマンド応答は要求元だけへ送る。ID が同じ別タブへ応答や確認 receipt を配らない。設定変更イベントは全タブへ通知する。

## 容量

モデルのチップの面の「コンテキスト…」から最大コンテキスト長、最大出力、自動要約の基準、直近の保持件数、ツール結果の短縮を変更する。「この会話」は次の送信へ予約、「接続先・モデルの既定」は新しい会話向けに保存する。

最大コンテキスト長はモデルをロードし直す設定ではなく、Pleiad が送信前に確認する入力と出力の予算。空欄ではこの予算による制限を設けない。モデルやローカル推論サーバー自身の上限を拡張するものではない。対応上限は確実なメタデータがないため「未確認」と表示する。

入力は各プロバイダーのリクエストへ整形した後、指示・会話・ツール定義を含めて推定する。厳密な tokenizer の計数ではなく、実際の上限はサービス側が判定する。出力予約と入力の推定量が予算を超えた場合は履歴を削除せず、設定変更を案内する。

OpenAI は `max_completion_tokens`、互換 API は通常 `max_tokens`（gpt-5 / o-series は `max_completion_tokens`）、Anthropic は `max_tokens` を送る。thinking の予算が出力上限以上の場合は上限変更を案内する。ChatGPT OAuth は出力上限指定を送らず、「入力計算に予約する出力」と表示する。

自動要約は procway-code の `session.autoCompact` に反映し、有効にした場合は `llm-summary` を使う。古いツール結果の短縮は `tools.staleToolResults` に反映する。要約前の内容を設定変更だけで復元することはできない。

API パラメーターの参照: [OpenAI Chat Completions](https://platform.openai.com/docs/api-reference/chat/create)、[Anthropic extended thinking](https://platform.claude.com/docs/en/build-with-claude/extended-thinking)。

## 実行の分離

`core/procway-serve.mjs` は子プロセスで procway-code の設定ローダー・資格情報ローダー・ネイティブ WebSocket server を利用する。Pleiad 本体にエージェントの依存を読み込まない。インストール済み `src/cli.mjs` の隣にある公開モジュール構成を確認し、非対応構成では明示的にエラーにする。

会話ごとにプロセスを分離し、同じ会話の通常の次ターンでは再利用する。接続・モデル・容量・設定が変わると、その会話の次の送信時に再起動する。別会話の実行中プロセスや認証情報を借用しない。プロセスはホスト終了まで保持するため、多数の会話を実行するとメモリー使用量も増える。

容量が指定されている場合だけ、同じ子プロセス内に loopback のリクエストアダプターを作る。予測不能な外部 URL へ転送できる汎用プロキシではなく、その接続先とランダムな内部パスに限定する。ネイティブの添付処理、OAuth 更新、SSE、承認の挙動を保持し、上流への送信直前に予算検査と出力パラメーター適用を行う。

## 検証

`npm test` で資格情報の保護・receipt・API リクエスト・並行実行・設定予約・既存 procway serve・デザイン規則を確認する。`npm run test:e2e -- procway-settings` は既存 API 資格情報で実サービスへ短い接続確認を送る。必要なら `E2E_PROCWAY_PROVIDER` で既存 provider ID を指定する。
