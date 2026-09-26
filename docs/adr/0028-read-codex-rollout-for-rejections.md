# 0028 Codex の実行前の拒否は、ターンの後に rollout を読んで拾う

- 状態: 提案

## 状況

Codex（codex-cli 0.156.1）は承認なしのモード（approvalPolicy `never`。Pleiad の `full`・`yolo`）でも、組み込みの危険コマンドの判定で一部のコマンドをプロセスを作る前に拒否する（`blocked by policy` など。削除に限らない）。issue #24 では、委譲した Codex の子が削除を拒否され、依頼元には子の自由文（「自動承認レビューが拒否」と誤って書いた）でしか伝わらなかった。

拒否は承認に回らず、アイテム（`item/started`・`item/completed`）を作らない。`error` 通知にもならず、ターンは `completed`、`thread/read` にも残らない。Codex の rollout（`~/.codex/sessions/…/rollout-*.jsonl`）の `response_item`（モデルへのツールの出力）にだけ残る。取れる経路は次のどれか:

- A. `thread/start` の `experimentalRawEvents` で `rawResponseItem/completed` を受ける。「internal-only / Codex Cloud 用」・experimental で JSON Schema からも外されている。`thread/resume` では立てられず、Pleiad の Codex の子（`contextRuntime` なら毎ターン別の app-server で `thread/resume`）の 2 ターン目以降・app-server の立て直しの後・`thread/unsubscribe` の後は届かない。届かなかったことも分からない。
- B. ターンの後で rollout を読む。パスは `thread/start`・`thread/resume` の応答の `thread.path`（[UNSTABLE]）。rollout は正本なので再開・プロセスの立て直しに左右されない。
- C. 子の最終発言から拾う（書かないことも、誤って書くこともある）。
- D. app-server の stderr（thread id も call id も無い）。

Pleiad は今まで rollout を直接読んでいなかった。読むと、公開の約束ではないファイルの形（行の種類・`internal_chat_message_metadata_passthrough.turn_id`・拒否の文の Rust の Debug 表示）への依存が増える。

## 決定

- **B を採る。** Codex のバックエンドは `thread/start`・`thread/resume` の応答の `thread.path` を覚え、`turn/start` の直前のファイルの長さから `turn/completed` の後の末尾までだけを読む。このターンの `turn_id` の行だけを見て、出力の先頭か `Script error:\n` の直後にある `exec_command failed: CreateProcess { … Rejected(…) }` を拾う（docs/multi-backend.md「Codex の実行前の拒否」）。ephemeral のスレッドでは読まない。
- **読めない・形が違うときは黙って諦め、ターンの結果は変えない。** 版で形が変わったら、拒否が拾えなくなるだけで、会話と委譲は今までどおり動く。
- 見つけたものは会話にツールのエラーとして出し（開き直すと消える）、委譲の子なら依頼元へ返す結果（`ply_task_status` の `rejections`）と完了通知に載せる。依頼元へ渡す文は形で秘密を伏せ、300 字で切る（docs/agent-delegation.md「実行前に拒否されたコマンド」）。
- Codex の子には既定の指示「Codex の実行前の拒否」（言い換えで回避せず、実行できなかったコマンドと理由・残ったものを報告する）を入れる。特定のコマンドを名指ししない。
- A（`experimentalRawEvents`）は使わない。上流には拒否を `commandExecution`（`declined`）のアイテムとして出すよう求める（E。親が確認してから登録する）。入れば B の読み取りは外す。

## 理由

- 拒否は公開・安定の通知に載らないので、取れるのは raw 通知か rollout だけ。raw 通知は Pleiad の Codex の子の使い方（毎ターン別プロセスでの再開）で穴が大きく、取りこぼしを検知できない。rollout は同じ中身を、再開やプロセスの立て直しに関係なく読める。
- 読む範囲をこのターンの追記分とこのターンの id に絞るので、長い会話でも毎回ファイル全体を読まず、前のターンの拒否を二度拾わない。
- 形への依存は避けられないので、壊れたときの挙動を「拾えないだけ」にして、ターンの結果には触らない。
- 子の自由文だけに頼ると、依頼元は拒否の有無も理由も確かめられない。構造で返せば、依頼元は言い換えて再実行させる前に判断できる。

## 影響

- Codex の版が上がったら、rollout の行の形（`response_item` の `custom_tool_call(_output)`・`function_call(_output)`、`internal_chat_message_metadata_passthrough.turn_id`、`event_msg` の `task_complete`）と拒否の文を確かめ直す。確かめ方は tests/unit/codex-rejections.mjs の行の形と、実際の rollout を読み取りだけで走査すること。
- ターンの終わりに rollout の追記分を読む分だけ、Codex のターンの終わりが遅れる（呼び出しの出力の行がまだ無いときは最大 0.75 秒待つ）。
- 会話を開き直すと、会話の画面からは拒否のカードが消える（履歴は `thread/read` から作る）。委譲の結果には残る。
- 依頼元へ渡す文の伏せ方は形によるので、形を知らない秘密は残りうる。
