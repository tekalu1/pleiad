# 発言単位の分岐（issue #3）

`wrapBackend().fork(id, { upToMessageId, title })` は指定発言を含むところまで引き継ぐ。
指定IDが見つからない場合、空の履歴、読み出し・保存失敗はエラーにする。実行中も保存済みの発言から
分岐でき、元のターンは継続する。切り替え・送信準備・重複分岐はロックで保護する。
分岐と実行中ターンは別のロックを持つ。「ここから分岐」は末尾でも必ず発言IDを送る。
画面は子の作成と履歴取得が成功してから選択を切り替える。

## 編集して再送信・再送信

ユーザー発言の操作は `fork(..., { beforeMessageId })` で対象発言の直前までを複製する。
`upToMessageId` との同時指定と、見つからない発言IDはエラー。最初の発言の場合だけ履歴・提示が0件の分岐になる。
この経路は全エージェントでホストの履歴複製を使い、親に `beforeMessage` と直前の `atMessage` を保存する。
根の分岐は同じ本文を再送しても位置が変わらず、空の子からも親へ戻れる。

編集は吹き出し内で行い、Ctrl+Enter（または ⌘+Enter）で送信、Escで取り消す。元の入力欄の下書きは保持する。
添付は元の発言に結び付いたものを復元し、自動挿入された添付行を編集本文から外す。
分岐先に本文・添付を下書きとして保存してから切り替え、既存の送信処理へ渡す。
送信の受領に失敗した場合は分岐先の入力欄に保持する。分岐・保存・履歴取得の失敗では元の会話を表示したまま案内する。

実行中は全エージェントでホスト側の履歴複製を使う。保存前の発言IDや選択範囲に未完了ツールがある場合は
再試行を案内する。ID省略時は保存済みの末尾まで。送信待ち・承認待ち・下書きはコピーしない。

停止中でネイティブが `capabilities.forkMessage` を宣言する Claude の未切り替え会話は SDK の指定メッセージ分岐を使う。Codex / procway とホスト管理会話は
正規化済みの履歴を複製する。SDK・実行アダプターは継続して使い、初回の再開だけ文脈を渡す。
内部推論・実行中のツール・プロセス・作業ファイルの過去の状態は複製しない。作業場所は同じ。

## Codex の境界調査

2026-09-11、インストール済み `codex-cli 0.153.2` の
`codex app-server generate-json-schema` が出す `v2/ThreadForkParams.json` と
[公式 App Server 仕様](https://learn.chatgpt.com/docs/app-server) を確認した。
`lastTurnId` は完了ターンを含むところまで指定できる。一方、UI の UUID は userMessage / agentMessage
の item.id、ツールだけの発言は先頭ツールの item.id、思考だけの発言は turn.id に接尾辞を付けた値。
1ターンに複数の確定発言があるため、任意の発言IDを turn.id に置き換えると後続の情報が混ざる。
Codex の分岐は末尾も含めホスト経路へ統一し、ネイティブ `thread/fork` 実装は残す。

## Antigravity の境界調査

2026-09-17、実機の `agy` で確かめた。分岐の口は無いままなので `capabilities.fork` は `false` で、
写しの経路に相乗りする。相乗りしているだけで固有の実装を持たないから、共通契約を
`tests/unit/server-antigravity.mjs` からも回す。

発言の時刻は**送信時**に取る（`core/backends/antigravity.mjs`）。控えはターンの終わりに書くが、
終了時刻で両方打つと、ターンの途中で出た提示（生成時刻を持つ）がユーザー発言より前に並び、
その発言で切った枝に、まだ走っていないはずの成果物が入る。ユーザー発言は送信時、AI の発言は完了時。

ネイティブ分岐の見込み（**未実装**）:

- 会話は `~/.gemini/antigravity-cli/conversations/<conversation_id>.db`。1 会話 1 SQLite
- `trajectory_meta.cascade_id` が `--conversation` に渡す id（`trajectory_id` は別の内部 id）
- `steps(idx INTEGER PRIMARY KEY, step_type, status, step_payload BLOB, …)` の `idx` は、
  バックエンドが既に受け取っている `step_update.step_index` と同じ番号
- db を新しい id へ複製して `cascade_id` を書き換えると、`agy --conversation <新id>` が記憶を保ったまま再開する。
  `delete from steps where idx > <切り口>` で切ると**切った先の記憶だけが消える**（合言葉を2つ覚えさせ、
  片方だけ落ちることで確認）。元の会話は無傷。protobuf のペイロードは解かなくてよい（行ごと落とすだけ）
- `conversation_summaries` へ自分で登録する必要は無い。初回の再開で `agy` 自身が書く。
  同じ表に `parent_conversation_id` / `nesting_depth` / `group_id` があり、agy 側にも親子の概念がある
- 実装に要るのは**発言 -> step 番号の対応**。今の控えは `step_index` を捨てているので、
  分岐点の発言がどの `idx` までかを控えに残すことから始まる（ユーザー発言は `step_type` 14、本文は 15 だった）
- 未確認: `agy` の更新でスキーマが変わったときの壊れ方と、走っているプロセスが db を掴んでいる間の複製

## 状態とグループ

分岐した子は**親の状態を引き継いで生まれる**。脇の一覧では、親子でつながり・状態が同じ・人が外していない会話が
ひとつのグループに入る（docs/design-system.md §4.1）。状態を引き継がないと、生まれた瞬間に親のグループから外れる。
人がグループから外した／解除したことだけを sidecar の `ungrouped` に覚える。

## 保存と引き継ぎ

`conversations.json` の索引に子レコード1件（ホストID、backend、親IDと分岐点、タイトル、状態、cwd、
作成・更新時刻）、`conversations/<子のID>.json` に完全なメッセージと提示を保存する（→ [backend-handoff.md](backend-handoff.md)）。
どちらも一時ファイルの rename 成功後に一覧へ公開する。
子作成に sidecar の複数書き込みは必要ない。子の実行区間は一覧に重複して出さない。
新しい実行区間のメッセージIDにはバックエンドと実行IDを付け、エンジンが item.id を再利用しても区別する。

ツール結果は `fullResults` で複製し、画面用の短縮はコピーにだけ行う。
添付は UI と同じ配置規則で所属発言までを選ぶ。新規添付は完了時に発言UUIDへ結び付け、
時刻を持たない procway でも同じファイルの再送を区別する。dataUri/content/path は保持する。
既存の添付記録に対する8 MiB制限は変えない。参照先ファイルの削除や外部URLの失効は復元できない。
旧履歴のAI提示に時刻がなく境界を決められない場合は、欠落させず途中分岐をエラーにする。末尾分岐は可能。

再開時は分岐点までの履歴と添付を `handoff-<hash>.json` に保存する。
6万文字以内なら本文にも入れ、長ければ指示の抜粋・直近の発言と完全版ファイルへの参照を渡す。
思考フィールドはモデルへ再入力しない。履歴上のツール呼び出しは過去の記録と明記し、再実行を指示しない。
新規実行のユーザー発言には引き継ぎ用プロンプトを表示せず、元の入力を表示する。
作成・保存・引き継ぎのエラーは画面に表示し、親の履歴と実行IDは変更しない。

## 検証

- `npm test`: 共通境界、元の会話の保持、メタ情報、再起動、保存失敗、添付、完全なツール結果、
  長い引き継ぎ、初回起動失敗からの再試行、入れ子の分岐。procway の serve と保存は実物を使う。
  共通契約（`tests/lib/fork-contract.mjs`）は codex / procway / antigravity から回す。
  antigravity では発言の時刻が送信時であることも測る（提示の並び、ひいては切り口に効くため）。
- `npm run test:e2e -- fork`: 実際の Codex と procway モデルに、前半のコードだけを引き継げることを確認。
  使用モデルは `AGENT_HOST_E2E_CODEX_MODEL` / `AGENT_HOST_E2E_PROCWAY_MODEL` で指定可能。
- Playwright CLI: 「ここから分岐」による子への切り替え、元の会話への枝、保存失敗時の選択維持とエラー表示。
