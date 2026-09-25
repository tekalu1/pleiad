# 0012 互換の接続先のキーの渡し方

- 状態: 承認（2026-09-26）

## 状況

互換の接続先（0011）の URL とキーを、会話ごとに Claude Code と Codex へ渡す必要がある。プロセスの引数（argv）と環境はプロセス一覧から見え、利用者の設定ファイルは Pleiad の値を上書きしうる。
2026-09-23 に、codex-cli 0.153.2 と Agent SDK 0.3.258 をダミーのサーバーに向けて確かめた（実 LLM は呼ばない）。

## 観測

- Claude: `options.env` の値で `/v1/messages` がダミーに届く。ただし利用者の `~/.claude/settings.json` の `env` が `options.env` に勝ち、フラグ設定（`--settings`）の `env` はそれにも勝つ。`options.settings` をオブジェクトで渡すと argv に JSON のまま載る。
- Codex: 共有の app-server のまま、スレッドごとの `modelProvider` と `config` で別の接続先に届き、並べた公式のスレッドは公式のまま。ロード済みのスレッドの resume は provider の変更を無視し、`thread/unsubscribe` の後の resume なら効く。

## 決定

- Claude: 親の `ANTHROPIC_*` などを外したうえで、同じ値を**フラグ設定のファイル**にも書く。ファイルはデータ置き場の `run/claude-compat-<uuid>.json`（0600）で、パスだけを渡し、ターンの終わりに消す（消し損ねは起動時に片付ける）。キーの無い先にもダミーの Bearer を入れる（ログイン中の OAuth が送られないように）。
- Codex: app-server は全会話で 1 本の共有のまま、スレッドごとに `modelProvider` と `config['model_providers.<id>']` を渡す。キーは JSON-RPC の stdin に載り、argv・環境に出ない。接続先が変わったスレッドは unsubscribe してから resume する。
- 思考とエフォートは既定で送らない（CLI が自分で送るのを環境変数で止める）。接続先の「思考を送る」をオンにした先だけ送る。

## 理由

- フラグ設定なら利用者の設定に負けず、argv にキーが出ない。
- 接続先ごとに app-server を分けなくてよいので、プロセスが増えない。

## 影響

- 仕様は design.md「互換の接続先」。利用者の `apiKeyHelper` がある場合の振る舞いは未確認（既知の制約）。
