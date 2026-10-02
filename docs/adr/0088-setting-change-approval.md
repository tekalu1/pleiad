# 0088 設定の変更は settings.set に集め、承認が要る会話では受領証つきの承認カードで聞く

- 状態: 提案

## 状況

[ADR 0081](0081-control-surface-registry.md)・[0082](0082-control-surface-principals-and-risk.md) の段階 2。AI が Pleiad の設定を変えられるようにし、関所を緩める変更は会話の承認モードで決める。0082 が決めたのは判定の表と「承認カードを出す」までで、次は決まっていなかった。

- 承認カードの流れ（待ち方・拒否・時間切れ・会話の終了・呼び出した側が切れたとき）
- 「同じ変更の取り違え・再送を防ぐ」受領証の具体
- 設定の変更をどこに集めるか（画面の `setPref` は 80 行の `if` の連なりで、AI の口と検査も配信もずれる）
- 各設定の危険度と、秘密・human-only の扱い

## 決定

- **設定の変更は設定の一覧（`defineSetting`）に集める。** 書ける設定は `normalize`（値の検査と書いたあとの値）と `write`（保存と配信）を持つ。`settings.set { key, value, reason?, backend? }` と、画面の WS コマンド `setPref`（`settings.set` の `legacyCommand`）は同じ定義を通る。`setPref` の中の個別の検査は持たない。
  - `store.setPref` を直に呼ぶのは、`savePref`（prefs.json への書き込みの出口）・起動時の修復・自動圧縮の 3 か所だけにし、印（`ops-allow-setpref`）を数えて増やせなくする（`tests/lint-ops.mjs`）。prefs に書くキーは全部設定の一覧にあり、「未移行」の欄は持たない。
- **危険度は設定ごとに決め、関所を緩める向きだけ guarded にする。** 承認モードと既定のアカウント（`claudeAccount`）は human-only（agent には無い設定と同じ）。全体の構成（ブラウザーのプロフィール・委譲の振り分け・Pleiad の指示・コンテキストの既定）は guarded。表示・既定の選択・自動圧縮は write。確認の切り替え・サイトの許可・computer use は write で、`riskOf` が緩める向き（オン → オフ・「常に許可」が増える・有効にする / 全アプリ / 常に許可を足す）だけ guarded に上げる。`riskOf` を持つ設定は向きごとの例（`riskExamples`）を書き、テストが突き合わせる。値が変わらない呼び出しは危険度を上げず、承認も聞かない。
  - 既定のアカウントを human-only にするのは、変えると新しい会話が別の契約・課金で動くため（0082 の表の「アカウント」）。0081 の段階 1 は write にしていた。
- **承認カードは会話の `askPermission` に `settingChange` を足して出す。**
  - 中身は `{ op, key, rows, note?, loosens, reason?, receipt, agent }`。`rows` は変わった項目の前後（JSON の文字列）、`loosens` は `riskOf` が上げた変更か、`reason` は AI が書いた理由。`toolName` は `ply_control`、「常に許可」は出さない。
  - 型は [ADR 0073](0073-computer-use-ui.md) の computer use の承認カードと同じ（見出し「{エージェント名} が設定を変えようとしています」・設定画面と同じ名前と値・「理由: …」・確認を減らす変更のときだけ ⚠ と 1 行・ボタンは「拒否」「変更を許可」）。リモート・モバイルは同じ `permission` イベントと `resolvePermission` なので同じカードが出る。委譲の子の承認は既存の仕組みで祖先の会話へ写る。
- **呼び出しは答えが出るまで待つ。** 待つのは、会話のターンが続き、呼び出した側がつながっていて、300 秒以内のあいだ。
  - 許可: 実行して結果を返す。
  - 拒否: `DENIED`。やり直さずユーザーに理由を尋ねるよう文で伝える。
  - 答えが無いまま 300 秒（`AGENT_HOST_OPS_APPROVAL_MS` でテストが縮める）: `APPROVAL_TIMEOUT`。カードは取り下げ、設定は変えない。
  - ターンの中断・会話の終了・呼び出した側（MCP の HTTP・CLI）が切れた: `APPROVAL_ABORTED`。カードを取り下げる。
  - host が居ないときは拒否せず待つ（design.md §8.5。上の時間切れの範囲で）。
  - 呼び出しの待ち上限は、MCP（Claude の `timeout`・Codex の `tool_timeout_sec`・agy の中継）と CLI で 330 秒にそろえ、300 秒の承認待ちより長くする。
- **受領証で変更を照合する。** 受領証は `sha256(操作 + 引数 + 承認時の前の値)`。カードに添えて出し、(1) 画面の `resolvePermission` は出したカードの受領証を返さなければ受け取らない（`RECEIPT_MISMATCH`。別の変更への答え・再送を防ぐ）、(2) 許可のあと実行の直前に前の値を読み直して受領証を作り直し、合わなければ別の変更として聞き直す（2 回まで。変わり続けたら `STALE` で行わない）。
- **配信と記録。** 設定を変えたら、既存の配信（`prefs`・`autoCompactionSettings`・`delegationRoutingChanged`）に加えて `settingsChanged { keys, by, via?, bySession? }` を全画面へ配る（配信の無かったコンテキストの既定のため）。会話に束縛された呼び出しは、その会話の変更の記録に `field: 'setting'`（前後の値は 300 字まで。画面の変更の記録には出さない）を残す。
- **CLI。** `pleiad settings set <key> <value>`（value は JSON として読み、読めなければ文字列）。会話に束縛された CLI は会話の規則（承認カードを待つ）、束縛されない CLI の guarded は `NEEDS_UI`（終了コード 4）。`DENIED` などの断りも 4。
- `sessions.fork`・`statuses.setIcon`・`statuses.create` は write（人間は全部に触れるので agent も同じ）。画面の `fork`・`setStatusIcon`・`createStatus` と同じ関数を通る。

## 理由

- 検査・保存・配信を設定の一覧に 1 つだけ持てば、口を増やしても（画面・MCP・CLI）ずれない。0081 の「一覧から生成すれば定義は 1 つで済む」の続き。
- 緩める向きだけを聞くのは [ADR 0031](0031-confirm-before-unifying-mcp.md) の「広げる向きだけ確認」と 0082 の決定の具体化で、狭める変更や無害な既定の選択で人を止めない。
- 待つ上限と取り下げを決めておかないと、諦めた呼び出し（クライアントの時間切れ・プロセスの終了）の承認カードが残り、後で許可しても何も起きない、という食い違いになる。呼び出した側より先に自分から断る長さ（300 秒 < 330 秒）にすると、エージェントが文で結果を受け取れる。
- 受領証は [ADR 0049](0049-hooks-pleiad-managed.md) の確認票と同じ考えで、承認した内容と実際に書く内容を同じものに保つ。承認の間に別の口が値を変えたとき、古い前提への許可で書かない。

## 影響

- 設定を足すときは `defineSetting` に危険度（と `riskOf`・`riskExamples`）・`normalize`・`write` を書く。足し忘れは `ops-coverage` が落とす。危険度の変更は `ops-surface` の snapshot（`settingPolicy`）の差分に出る。
- 承認カードの `settingChange` は、走っている `ply_control` のツールの行の下に出す（コンピューターの承認カードと同じ。権限を聞く呼び出しはツール呼び出しの id を持たないので、画面が「今の塊の、走っていて承認をまだ持たない最新の `ply_control` の行」を選ぶ）。行が見つからない承認（委譲の子から中継された分・開き直した会話）は単独のカード。
- `ply_control` の文の量（T4）は ja 約 1710・en 約 1620 トークンで、上限 1800 は上げない。
- 承認なしのモードの会話からの guarded は黙って通る（記録は残る）。0082 のとおり。
