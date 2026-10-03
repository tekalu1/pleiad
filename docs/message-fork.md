# 発言単位の分岐（issue #3）

`wrapBackend().fork(id, { upToMessageId, title })` は指定発言を含むところまで引き継ぐ。
指定IDが見つからない場合、空の履歴、読み出し・保存失敗はエラーにする。実行中も保存済みの発言から
分岐でき、元のターンは継続する。切り替え・送信準備・重複分岐はロックで保護する。
分岐と実行中ターンは別のロックを持つ。「ここから分岐」は末尾でも必ず発言IDを送る。
画面は子の作成と履歴取得が成功してから選択を切り替える。
自分の発言の「編集して再送信」「再送信」は分岐ではなく同じ会話の中での巻き戻し（次の節）で、分岐を使うのは「ここから分岐」と、送り方の帯の［分岐して送る］だけ。

## 編集して再送信・再送信: 同じ会話の中で巻き戻して送り直す（承認済み（2026-10-03）、[ADR 0102](adr/0102-rewind-in-place.md)）

自分の発言の「編集して再送信」「再送信」は、分岐ではなく**同じ会話の中で、対象の発言の手前まで巻き戻して送り直す**。
会話の id・脇の一覧の行・画面は変わらない。対象の発言とその後ろ（返答だけでも）は消え、新しい本文が続く。画面の決まり
（送り方の帯・キーボード・実行中の形）は docs/design-system.md「発言の操作」。分岐して残したいときは帯の［分岐して送る］で、
こちらは下の「分岐して送る」（今の経路）を使う。「元に戻す」と版の切り替え（‹ 1/2 ›）は作らない。

### 操作

`sendMessage { sessionId, messageId, prompt, attachments?, rewind: { beforeMessageId, stopRunning? } }` の 1 つ（`core/server.mjs` の
`rewindConversation`）。`beforeMessageId` は自分の発言（スラッシュコマンド・`!` の行・システム側の行・返答は断る）。

- `forkConversation` と同じ排他（`forking`）で、実行中のターン・分岐・別の送り直しと重ならない。**検証（`wrapped.rewindPlan`。起点が見つかる・同じ id の発言が
  複数無い・自分の発言・AI の提示に時刻がある）は、止める・取り消すより前に済ませる**（止めてから断られると戻せない）。実行中のターンがあれば、`stopRunning: true`
  のときだけ止めてから巻き戻す（止まり終えるまで最大 20 秒待つ）。`stopRunning` が無ければ断る（`SESSION_RUNNING`）。
  止めたことは中断として残さない（中断の印・止めたものを消す）。委譲の子の取り消し・裏作業の停止は、巻き戻せたあとに行う。
- 委譲された作業の会話（`delegation` を持つ子）は、同じ会話では送り直せない（`rewind.delegated`）。委譲タスクの結果・状態が、巻き戻した履歴と食い違うため。画面は［分岐して送る］だけを出す。
- 同じ `messageId` の再送（応答が届かなかった）は巻き戻し直さず、受け付け済みの項目を返す。
- 画面の失敗時: 巻き戻しは済んで受け付けだけが失敗したとき（履歴が変わっている）は、`rewind` を外して**同じ `messageId` で**送り直す（起点の発言はもう無い）。それも失敗したら本文をクリップボードに写す。
- 返り値は受け付けた項目に `rewind: { mode: 'resume' | 'thread' | 'host', renumbered, removed: { messages, userMessages, replies } }`。
  完了は `rewind` イベント（`renumbered`・`removed`）で他の画面にも知らせ、画面は履歴を静かに読み直す
  （自分が送り直した画面は、送り終えてから自分で読み直す）。
- 送れなかったら（受け付けの前の失敗）画面は畳んだ行を戻して理由を出す。受け付けた後の失敗は、送信待ちの「失敗」として残る（再送か取り消し）。

### 巻き戻し方（`core/conversations.mjs` の `wrapped.rewind` / `wrapped.runTurn`）

| 会話 | 巻き戻し方 | 落とし先 |
|---|---|---|
| Claude（`capabilities.rewind: 'resumeAt'`） | 次のターンが `resume + resumeSessionAt + resumeDropsTurn`。JSONL は次のターンまで動かないので、sidecar の `rewind { backend, nativeId, at, drops }`（保留の印）で履歴を見かけ上切って返す | 最初の発言・今のネイティブの区間の外・切り口が見つからない・`resumeDropsTurn` の拒否（`Resume rejected by --resume-drops-turn:`）→ ホスト管理。拒否は繰り返し再試行しない |
| Codex（`'thread'`） | 今すぐ `thread/revert { beforeTurnId }`（paginated のスレッド） | legacy は `thread/fork { beforeTurnId }` で別スレッドに差し替え（`nativeId` を替える。残す発言の uuid は付け直し）→ ターンの途中の発言・どちらもだめならホスト管理 |
| Antigravity・ホスト管理・引き継ぎ済み | Pleiad の履歴を切り、`nativeId = null` にして次のターンで引き継ぐ。生きている agy のプロセスは手放す | — |

- **Claude の切り口は、本文のある返答（assistant）の直後のときだけ使う。** ツール呼びだけの発言は連続するエントリを 1 つに束ねて先頭の uuid を持つので、その後ろが落ちて
  中途半端な枝から続く。ツール呼びで終わった・中断した会話の後ろの発言を起点にしたときは、ホスト管理に落とす。
- **拒否は文面に依らず拾う。** 巻き戻しを伴うターンが、CLI から最初のメッセージが届く前に失敗したら（resume の拒否。`Resume rejected by --resume-drops-turn:` の文は SDK の例外に載るとは限らない）、
  バックエンドが `rewindRejected` を付け、`wrapped.runTurn` がホスト管理に落として 1 度だけ送り直す。同じ印で 3 回続けて失敗したら（印の `tries`）、印を渡さずホスト管理に落とす。
- **保留の印は、捨てる発言がまだ鎖にある間だけ効く。** 次のターンが葉を付け替えれば、鎖から捨てる発言が消えて印は効かなくなる
  （古い印で今の会話を切らない。送信が取り消されても、次のターンは必ず印を渡すので、画面から消した発言をモデルが見ることもない）。
  ネイティブの uuid は、ホスト記録のある会話の `<backend>:<nativeId>:<uuid>` から接頭辞を外して渡す。
- **ホスト管理に落とす**とは、履歴を切って `nativeId = null`・`base = 残した件数` にし、次のターンが引き継ぎの文（上の「保存と引き継ぎ」）で新しい
  ネイティブの会話を起こすこと。ネイティブだけだった会話は、同じ id の記録を作る（`segments` に元のネイティブの id を持つので一覧に二重に出ない）。
  最初の発言をやり直したときは、その発言から付いた題を付け直す（人が付けた題は残す）。
- **書き込みの順は、落ちても残すほうに倒れる順**: 記録の写しを切って保存 → 提示（JSONL）→ 保留の印。途中で落ちたら記録を元に戻して失敗にする（ホスト管理に落とす作り替えも複製の上で行う）。
  Codex は先にネイティブが切れているので、記録はメモリを切った形に持ち、保存に失敗しても次の保存が直す。
- 切り口は「対象の発言の直前の発言」。提示（添付・可視化・git の行）は「ここから分岐」と同じ選び方（`buildItems` の並びで、残す発言より前に並ぶものと、
  残す発言に結び付いた添付）で切る。AI の提示に時刻が無く決められないときは、何も変える前に断る。

### 整合を取るもの

| もの | 扱い |
|---|---|
| 送信待ち（outbox） | 送れていないものは全部取り消す（どれも切り口より後に送ったもの） |
| 委譲した子 | 切り口より後に作られた子は取り消す（完了通知も届けない）。子の会話そのものは残る（`cancelOwner(owner, { since })`） |
| ターンの外の裏の作業 | 止める（Codex の端末など） |
| 渡し済みの控え `contextSession.delivered` | 捨てる（巻き戻した先のモデルは、捨てたターンで渡された本文を持っていない） |
| 中断の印・止めたもの | 消す（中断した位置が消える） |
| 圧縮の記録・渡さなかった `!` の行（`shellKept`）・hooks の発火（`hookRuns`） | 切り口より後を捨てる |
| 文脈量の表示（`contextWindow`） | 捨てる（次のターンの値で上書きされるまで、巻き戻す前の量を出さない） |
| 渡していない `!` の結果（`shellPending`）・`taskNotices`・`shellExits` | 残す（次の発言と一緒に渡る／照合の控え） |
| 提示・添付 | 切り口より後を捨てる（ホスト記録の分と sidecar の JSONL の分） |
| 下書き | 触らない。編集した本文は送信に直接渡す |
| 脇の一覧の状態・グループ | 変わらない（同じ会話） |
| 分岐した子（既存の枝） | 切り口より後を指す枝は、`branches.load` が共通接頭辞で分岐点を決める（コードを読んだだけで、画面での確認は未） |

### 分岐して送る

帯の［分岐して送る］は今の経路そのまま: `fork(…, { beforeMessageId })` が対象の発言の直前までを複製した子を作り（親に `beforeMessage` と直前の `atMessage`
を保存）、子へ切り替えて送る。`upToMessageId` との同時指定と、見つからない発言 ID はエラー。最初の発言の場合だけ履歴・提示が 0 件の分岐になる。
この経路は全エージェントでホストの履歴複製を使う。添付は元の発言に結び付いたものを復元し、自動挿入された添付行を編集本文から外す。分岐先に本文・添付を
下書きとして保存してから切り替え、既存の送信処理へ渡す。送信の受領に失敗した場合は分岐先の入力欄に保持する。分岐・保存・履歴取得の失敗では元の会話を表示した
まま案内する。

### 分岐（ここから分岐）

実行中は全エージェントでホスト側の履歴複製を使う。保存前の発言 ID や選択範囲に未完了ツールがある場合は再試行を案内する。ID 省略時は保存済みの末尾まで。
送信待ち・承認待ち・下書きはコピーしない。

停止中でネイティブが `capabilities.forkMessage` を宣言する Claude の未切り替え会話は SDK の指定メッセージ分岐を使う。Codex とホスト管理会話は
正規化済みの履歴を複製する。SDK・実行アダプターは継続して使い、初回の再開だけ文脈を渡す。
内部推論・実行中のツール・プロセス・作業ファイルの過去の状態は複製しない。作業場所は同じ。

## Codex の境界

Codex の UI の発言 ID は 1 ターンに複数ある（userMessage / agentMessage の item.id、ツールだけの発言は先頭ツールの item.id、思考だけの発言は turn.id に接尾辞を付けた値）が、ネイティブの `thread/fork` は `lastTurnId`（ターン単位）でしか切れない。任意の発言をターンに置き換えると後続が混ざるので、Codex の分岐は末尾も含めホスト経路に統一し、ネイティブの `thread/fork` の実装は残す（codex-cli 0.153.2、2026-09-11 に確認）。

同じ会話の中で巻き戻す口（2026-10-03、codex-cli 0.156.1 を実機で確認）: `thread/rollback` は無い（`unknown variant`）。
`thread/revert { threadId, beforeTurnId }` がターン単位で履歴を置き換える（`thread/reverted` 通知。続けて `turn/start` もできる）が、
`historyMode: "paginated"` のスレッドだけで、以前に作った legacy のスレッドは `thread/revert only supports paginated threads` で断られる。
`thread/start` の既定は paginated。legacy の `thread/fork { beforeTurnId }` は効くが、子も legacy のまま。
巻き戻した後にモデルが捨てた内容を見ないことは、実モデル（gpt-6-luna）で確かめた（2026-10-03。`tests/e2e/rewind.mjs`）: paginated のスレッドは `thread/revert`（thread id は変わらない）、
`historyMode: "legacy"` で作ったスレッドは `thread/revert` を断られて `thread/fork { beforeTurnId }` に差し替わり（会話の id は同じ・uuid は付け直し）、どちらも続きのターンまで捨てた内容を覚えていない。
legacy のスレッドの item id は `item-1`・`item-2`… とスレッド内で連番。

Claude は `query({ resume, resumeSessionAt, resumeDropsTurn })` で同じ session id・同じ JSONL のまま巻き戻せる（SDK 0.3.258 で確認）。
JSONL は消さずに追記され、`getSessionMessages` は最新の葉の鎖を返す。切り口を間違えると `resumeDropsTurn` が `Resume rejected by --resume-drops-turn:` を投げる。
最初の発言の手前には切り口にできる UUID が無い。

## Antigravity の境界

2026-09-17、実機の `agy` で確かめた。分岐の口は無いままなので `capabilities.fork` は `false` で、
写しの経路に相乗りする。相乗りしているだけで固有の実装を持たないから、共通契約を
`tests/unit/server-antigravity.mjs` からも回す。

発言の時刻は**送信時**に取る（`core/backends/antigravity.mjs`）。控えはターンの途中から書き足すが、
ユーザー発言まで後の時刻で打つと、ターンの途中で出た提示（生成時刻を持つ）がユーザー発言より前に並び、
その発言で切った枝に、まだ走っていないはずの成果物が入る。ユーザー発言は送信時、AI の発言は書くたびにその時刻で、
終わりで完了時に打ち直す。

ネイティブの分岐（会話の SQLite を複製して切り口の先の step を落とす）は見込みを調べたが未実装。

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
発言の時刻に頼らず、同じファイルの再送を区別する。dataUri/content/path は保持する。
既存の添付記録に対する8 MiB制限は変えない。参照先ファイルの削除や外部URLの失効は復元できない。
旧履歴のAI提示に時刻がなく境界を決められない場合は、欠落させず途中分岐をエラーにする。末尾分岐は可能。

再開時は分岐点までの履歴と添付を `handoff-<hash>.json` に保存する。
6万文字以内なら本文にも入れ、長ければ指示の抜粋・直近の発言と完全版ファイルへの参照を渡す。
思考フィールドはモデルへ再入力しない。履歴上のツール呼び出しは過去の記録と明記し、再実行を指示しない。
新規実行のユーザー発言には引き継ぎ用プロンプトを表示せず、元の入力を表示する。
作成・保存・引き継ぎのエラーは画面に表示し、親の履歴と実行IDは変更しない。

## 検証

- `npm test`: 共通境界、元の会話の保持、メタ情報、再起動、保存失敗、添付、完全なツール結果、
  長い引き継ぎ、初回起動失敗からの再試行、入れ子の分岐。
  共通契約（`tests/lib/fork-contract.mjs`）は codex / antigravity から回す。
  antigravity では発言の時刻が送信時であることも測る（提示の並び、ひいては切り口に効くため）。
- `npm run test:e2e -- fork`: 実際の Codex モデルに、前半のコードだけを引き継げることを確認。
  使用モデルは `AGENT_HOST_E2E_CODEX_MODEL` で指定可能。
- Playwright CLI: 「ここから分岐」による子への切り替え、元の会話への枝、保存失敗時の選択維持とエラー表示。
- 同じ会話での巻き戻し: `tests/lib/rewind-storage-worker.mjs`（身代わりのネイティブで、保留の印・履歴の見かけ上の切り取り・提示の切り取り・拒否のホスト管理への落とし先・
  Codex の revert / fork / 失敗・Antigravity の形）、`tests/unit/server-rewind.mjs`（fake の 4 つの形と、本物の Codex アダプター + 身代わりの app-server で、
  同じ会話・件数・送信待ちの取り消し・実行中・検査）、`tests/lib/fork-contract.mjs` の `checkRewind`（Antigravity から回す共通契約）、
  `tests/unit/server-context.mjs`（渡し済みの控えを捨てる）、`tests/unit/resend-band.mjs`。
- `npm run test:e2e -- rewind`: 実際の Claude（既定 haiku）・Codex で、巻き戻した先のモデルが捨てた発言のコードを覚えていないこと（続きのターンでも）。
  Claude・Codex（paginated と、legacy のスレッドの差し替え）とも 2026-10-03 に通した（legacy のスレッドは e2e が app-server で `historyMode: "legacy"` を指定して作り、最初のターンまで走らせてから Pleiad が resume する）。
- Playwright CLI（`tests/browser/message-actions.cjs`）: 編集・再送信の帯の出る条件と文・薄くする範囲・キーボード・同じ会話での送り直し（会話・一覧が増えない）・
  後ろが無いときは帯なし・実行中の止めて送り直し・分岐して送る・送れなかったときの復帰・360px。
