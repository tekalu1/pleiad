# Pleiad のエージェント間委譲

Claude・Codex の会話から、`ply_agents` MCP の `ply_delegate` で別の子会話を作成できる。
`kind`（仕事の種類）は必ず書く。`backend`（`claude` / `codex` / `antigravity`）を書けばその委譲先に固定し、
省けば Pleiad が委譲先を選ぶ（下の「委譲先の自動振り分け」）。同じバックエンドへの委譲もできる。
エージェントがシェルから別の CLI を起動する必要はなく、Pleiad の既存バックエンド接続を使う。

## ツール

| ツール | 引数 | 動作 |
|---|---|---|
| `ply_delegate` | `kind`, `task`, 任意の `title`, `backend`, `context`, `cwd`, `model`, `effort` | 子会話を作り、すぐ `taskId`・短い `title`・`routing`（どう選んだか）を返す。`title` は一覧と子会話の見出しに使い、無ければ依頼の最初の空でない行。`model` / `effort` は `backend` を書いたときだけ |
| `ply_task_status` | `taskId`, 任意の `offset` | 状態と結果。結果は16,000文字ずつ返し、`nextOffset` で続きへ進む |
| `ply_task_wait` | `taskId`, 任意の `seconds`（1〜30、既定30） | 上限まで待つ。承認待ちになったらすぐ戻る。未完了なら現在の状態を返す |
| `ply_task_send` | `taskId`, `message` | 同じ子会話に追加指示。実行中なら順番に待ち、完了後なら再開する |
| `ply_task_cancel` | `taskId` | タスクと、その配下の Pleiad タスクを停止する |
| `ply_task_list` | なし | 呼び出し元が作成した Pleiad タスクだけを列挙する |
| `ply_usage` | 任意の `backend` | 各バックエンドの使用枠（枠ごとの `usedPercent`・`resetsAt`、`plan`、`checkedAt`、`message`）。省略時は使用枠を読めるバックエンドすべて |

`ply_usage` は重い委譲・並列委譲の前に、使用率の高いバックエンドを避けるために呼ぶ。読むだけなので、読み取り・計画モードの会話からも呼べる（`ply_delegate` / `ply_task_send` だけが `DELEGATING_TOOLS` として制限される）。
取得は設定の「使用量」（`providerUsage`）と同じ `quotaCache` を通すので、値は最大60秒古く、何度呼んでも各サービスへの問い合わせは増えない。リセット時刻を過ぎた枠の `usedPercent` は、画面と同じく今の値ではないので `null`（不明）にする。
ローカルの使用実績（トークン数・参考費用）は返さない。Claude でアカウントを登録していれば `accounts` にアカウントごとの枠を並べ、表示名にメールアドレスが含まれる場合はローカル部を1文字残して伏せる。アカウント ID・資格情報は返さない。
不明な `backend` はエラー。1つのバックエンドの取得失敗はそのバックエンドの `message` に入れ、他は返す。

**委譲の指示**: 委譲の使い方（委譲を基本にする・この会話でやること・`kind` を付けて `backend` を書かない）は、利用者の指示ファイルではなく Pleiad が入れる（[ADR 0023](adr/0023-pleiad-added-delegation-instructions.md)）。`ply_agents` の instructions の後ろに毎ターン足し、依頼元の会話と委譲された子の会話（「さらに委譲しない」だけ）で中身を変える。振り分けが無効なら `backend` の項を入れない。切り替えと記録は context-runtime.md「Pleiad が入れる指示」。

タスク ID は `ply-task-<UUID>`。Claude / Codex のネイティブサブエージェントとは別に管理する。
`ply_agents` は専用の接続で注入するため、外部 MCP 中継のハッシュ化されたツール名にならない。

## 委譲先の自動振り分け

決定は [ADR 0022](adr/0022-delegation-routing.md)。コードは `core/delegation-routing.mjs`（規則・段・候補・使用量の判定。純粋な関数）、`core/delegation-judges.mjs`（判定器の HTTP）、`core/delegation-usage.mjs`（使用量の取り置き）。

**`kind`**（9 種類。ツールの説明に定義と境目の例を会話の言語で載せる。`kind` の値は訳さない）:

| kind | 定義 |
|---|---|
| `trivial` | 1 手で、確かめることが無い（決まった文字列の置き換え、ファイルの移動） |
| `mechanical` | 決まった数手で、結果をコマンドや比較で確かめられる（テストを流して要約、ログ集め、1 つの規則での一括置換、手順の決まったブラウザー操作） |
| `investigate` | 成果物が事実・原因・今の状態の説明 |
| `implement` | 仕様が決まっている変更（画面に触れるものでも） |
| `review` | 差分や成果物を確かめる |
| `design` | 成果物が推奨・計画・選んだやり方（作業の大半が事実集めでも） |
| `ux_change` | 既存の画面の見た目や流れを変え、形を子が決める。複雑ではないもの |
| `ux_new` | 新しい画面や製品の UX、または複雑な UX の作り直し |
| `visual` | 画像・ロゴ・図 |

`kind` が無い・不正なら、9 種類の一覧（定義つき）を付けたエラーを返す。`backend` を書いたときも `kind` は記録する。
振り分けが無効な設定で `backend` が無ければ、`backend` を求めるエラー。`backend` 無しで `model` / `effort` を書いたらエラー（黙って捨てない）。

**流れ**（`backend` が無いとき。`core/server.mjs` の `routeDelegation`。選んだ後は、書いた `backend` と同じく承認の強さの判定・承認カードを通る）:

1. **判定器を選ぶ。** 設定の種類ごとの判定器（`jev` / `cerebras` / `none`）。既定は `ux_change` `ux_new` `visual` が `none`、ほかは `jev`。
2. **難しさの手がかりを得る。** 判定器へ送るのは `kind` と依頼文（`task`。8,000 文字で切る）だけ。`context`・使用量・振り分けの表・会話の記録は送らない。答えは 6 つの手がかりの真偽。
   - `jev`: OpenRouter `POST https://openrouter.ai/api/alpha/decisions`、`typesafe/jev-1.13`、Noul 6 つ。はいの確率を手がかりごとの閾値で真偽にする（`diagnose` 0.50・`choose` 0.31・`long_procedure` 0.685・`many_parts` 0.68・`writes_shared` 0.50・`security_gate` 0.19）。問いの文面（英語）と閾値は検証で決めたもので、`core/delegation-routing.mjs` の `QUESTIONS` / `JEV_THRESHOLDS`。Noul の false 側は「The statement for <id> is false for this task.」（閾値を選んだときと同じ文面）。
   - `cerebras`: `POST https://api.cerebras.ai/v1/chat/completions`、`qwen-3.8-27b`、`reasoning_effort: "none"`、JSON schema strict（6 つの boolean）。
   - 「Jev が迷ったら Cerebras に聞き直す」（既定 OFF）: どれかの確率が閾値 ± 0.15 以内で、Cerebras のキーがあれば Cerebras の答えを使う（Jev の確率も残す）。
   - 時間切れは 1 回 3 秒。選んだ判定器が使えなければ、もう一方にキーがあればそちらを試し、それも無理なら難しさ `mid` で続ける。`fallback` に最初の理由のコード: `no_key` `key_unreadable` `timeout` `network` `http_<status>` `bad_response` `judge_none`（判定しない種類）。
3. **難しさの規則（v3・規則 A）。** `security_gate` → `high`。それ以外は `diagnose` `choose` `long_procedure` `many_parts` のはいの数 0 → `low`、1〜2 → `mid`、3〜4 → `high`。`writes_shared` がはいで `low` なら `mid`。
4. **段。** 種類 × 難しさの表（既定）:

   | kind | low | mid | high |
   |---|---|---|---|
   | trivial | t1 | t1 | t2 |
   | mechanical | t1 | t2 | t3 |
   | investigate / implement / review | t2 | t3 | t4 |
   | design | t3 | t4 | t4 |
   | ux_change | t4 | t4 | t4 |
   | ux_new / visual | tv | tv | tv |

   段の候補（既定、左から）: t1 = antigravity `gemini-3.8-flash-high` → claude `haiku`。t2 = antigravity `gemini-3.8-flash-high` → codex `gpt-6-luna` → antigravity `claude-opus-4-6-thinking` → claude `sonnet`。t3 = codex `gpt-6-sol` → claude `sonnet`。t4 = claude `opus` → claude `fable`。tv = codex `gpt-6-astra`。
5. **候補を左から試す。** 飛ばす理由（`skipped[].reason`）:
   - `unavailable`: バックエンドが有効でない・CLI が入っていない（Claude の登録アカウントはトークンが無い）。
   - `model_unknown`: 今のモデル一覧に無い（黙って既定に落とさず次の候補へ）。
   - `usage_unknown`: 使用量の取得に失敗・取得中・枠が 1 つも無い・使用率が不明な枠がある。`usage_stale`: 取得から 15 分を超えた。
   - `quota_high`: 効く枠のどれかが避ける線（80%）以上。
   - `pace_high`: 週次の枠のペース（使用率 ÷ 経過率）が 1.2 を超える。経過率はリセット時刻と期間から出し、20% 未満は見ない。
   - `pace_unknown`: 経過率が出せない週次の枠で、使用率が 20% × 1.2 = 24% を超える（24% 以下なら、経過率がいくつでもペースで落ちないので通す）。
   - リセット時刻を過ぎた枠は、使い直しが始まっているので使用率 0 とみなす。
   - 候補に効く枠: claude は 5 時間・週次と、そのモデルの系統の週次（`seven_day_opus` など。`seven_day_oauth_apps` も念のため全モデルに効かせる）。codex は主の枠と、名前がそのモデルに当たる追加の枠。antigravity はモデル名の語をいちばん多く含むグループ（`gemini-*` → Gemini のグループ、`claude-*` / `gpt-*` → Claude and GPT のグループ）。グループが見つからなければ `usage_unknown`。
6. **Claude のアカウント。** アカウントを登録していれば、どれか 1 つが使えれば候補は使える。複数使えるなら週次のペースが最も低いもの、同じなら 5 時間の使用率が低いもの。使用量の一覧では「ログイン中のアカウント」と、同じ人の登録アカウントが同じ値で並ぶことがあるので、**組織（`.claude.json` の `oauthAccount.organizationUuid`）とメールアドレスの両方が分かって一致するものだけ**を同じアカウントとして 1 つにまとめる。残すのは使える方（片方だけ使用量の取得に失敗していることがある）で、両方使えるか両方だめならログイン中の方（登録アカウントの手がかりは、使用量の認可をした設定フォルダの `.claude.json`）。どちらかが分からなければまとめない（同じ人が 2 つの候補として並ぶだけで、どちらを選んでも同じ枠を使う）。
7. **全部飛んだら** 1 つ上の段へ（t1 → t2 → t3 → t4）。t4 と tv が全部だめならエラー（種類・難しさと、飛ばした候補と理由の一覧つき。エージェントは `backend` を書いて固定で頼み直すか、ユーザーに聞く）。
8. 選んだ backend / model / account で子の会話を作る（`prepare`）。**自動で選んだ子は親の会話の接続先を継がず公式で走る**（候補を公式の使用枠で選んでいるため）。Claude を選んだときは選んだアカウント（`''` はログイン中）。選んだ候補のモデルは、委譲先の作業場所（`cwd`）で一覧にあるかを確かめ直し、無ければ `model_unknown` として次の候補から選び直す。それでも子の会話を作る時点で使えなければ、既定に落とさずエラー。

**使用量の取り置き。** 振り分けのたびに使用量を取りに行って待たない。サーバーは待ち受けを始めてから、既存の使用量の取得（`providerQuota`。設定の「使用量」・`ply_usage` と同じ 1 分のキャッシュを通す）を 5 分ごとと委譲の直後に呼び直し、振り分けはその値を同期的に読む。起動直後でまだ一度も取れていないときだけ、判定と同じ 3 秒まで待つ。候補のモデルが一覧に無いバックエンド（agy はログインの確認でモデル一覧を覚える）は、30 分に 1 回までログインの確認で一覧を引き直す。振り分けが無効なら取らない。

**`routing`**（返り値・`agent-tasks.json` のタスク・子の会話のメタデータ `routing`・会話の一覧の行に同じ形）:

```jsonc
{ "mode": "auto" | "pinned" | "manual", "kind": "implement",   // manual は人が「別の候補でやり直す」で選んだもの（下）
  "judge": "jev" | "cerebras" | "none" | null,          // 答えを使った判定器。固定なら null
  "signals": { "diagnose": false, … } | null, "probabilities": { "diagnose": 0.12, … } | null,  // 確率は Jev のとき
  "difficulty": "low" | "mid" | "high" | null, "baseTier": "t2", "tier": "t3",   // baseTier は表の段、tier は選んだ候補の段（自動のときだけ）
  "target": { "backend": "codex", "model": "gpt-6-sol", "account": null },       // account は Claude のときだけ（'' = ログイン中）
  "targetWindows": [{ "label": "…", "minutes": 10080, "usedPercent": 11 }],      // 選んだ候補に効いた枠の、選んだ時点の使用率（委譲カードの内訳）
  "skipped": [{ "candidate": "antigravity:gemini-3.8-flash-high", "tier": "t2", "reason": "quota_high",
                "window": { "label": "…", "minutes": 300, "usedPercent": 85 }, "accounts": [ … ] }],
  "usageAt": "2026-09-26T03:00:00.000Z",   // 選んだ候補の使用量の取得時刻（選べなければ見た中で最も古いもの）。skipped[] にも各自の checkedAt
  "fallback": null,                        // 判定器を使えなかった理由（no_key など）
  "escalated": true,                       // 「Jev が迷ったら Cerebras」で聞き直したときだけ
  "retry": { "of": "ply-task-…", "from": { "backend": "…", "model": "…", "account": null }, "by": "user" } }  // manual のときだけ
```

依頼文・判定器の生の応答・キーは保存しない。アカウントの見出しに含まれるメールアドレスは `ply_usage` と同じく伏せる。
固定（`mode: "pinned"`）の `target` は実際に使う値（モデルが既定に戻った、継いだアカウント）で書く。
後で規則を見直すため、失敗はタスクの `status`（`failed`）と `routing` で数えられる。人が別の候補でやり直したことは、やり直したタスクの `routing.retry`（`of` が元のタスク、`from` が元の委譲先）で数え、元のタスクの `routing` と `of` で結び付ける。集計の画面はまだ無い。

**別の候補でやり直す**（委譲カードの操作。画面は design-system.md「委譲カード」、WebSocket の `retryAgentTask { taskId, candidate, stop?, approved? }`。`core/server.mjs` の `retryAgentTask`）:
- 自動で選んだ委譲のカードからだけ出す。候補は設定 › 委譲と同じ一覧（`delegationRouting` の `candidates`）のうち、今使えるもの（使用量の取り置きで確かめる）で、元の委譲先は除く。サーバーでも同じ確かめをし、使えない・元と同じ・形が不正なら断る
- 同じ依頼（`task` と `context`）で**新しいタスク**を作る。元のタスクは書き換えない。タスクは最初の `context` を持つ（`agent-tasks.json` の `context`。一覧・`ply_task_status` には載せない）。`context` を持つ前に作ったタスクは `task` だけを渡す
- 依頼元は元のタスクと同じ会話（`parentSessionId`）。依頼元のターンの外で作る（`prepare` は `routing.mode: manual` のときだけ依頼元のターンを求めない）。作業場所は元のタスクの `cwd`。自動のときと同じく接続先は継がず公式で走り、Claude なら使用量で選んだアカウント
- 子の承認モードは `ply_delegate` と同じく依頼元の会話の強さまで（`resolveDelegatedMode`）。それを超えるなら作らずに `{ confirm: { agent, mode } }` を返し、画面が 1 行で示して `approved: true` で頼み直す。依頼元の会話が読み取り・計画モードなら断る
- 元のタスクが動いている（`queued` / `running` / `cancelling`）ときは `stop`（真偽）が要る。画面で「止めて◯◯でやり直す」「止めずにやり直す」を選ばせる。`stop: true` なら元のタスクを止めてから作る（止めたタスクの完了通知は出さない）
- やり直したタスクの完了通知は依頼元のエージェントに届く。依頼元が作ったタスクではないので、通知の 2 行目に「利用者が <元の taskId> を別の委譲先でやり直したタスク」を添える（`agent:delegation.noticeRetry`）。依頼元は `ply_task_*` で同じように読める

**設定**（`prefs.json` の `delegationRouting`。未設定の項目は既定値。画面から `null` を送った項目は既定に戻す。読むときに不正な項目は既定に戻し、保存のときは全体を断る）:

```jsonc
{ "enabled": true,
  "judgeByKind": { "trivial": "jev", …, "ux_change": "none", "ux_new": "none", "visual": "none" },
  "escalateToCerebras": false,
  "avoidPercent": 80, "paceLimit": 1.2, "staleMinutes": 15,
  "tiers": { "t1": ["antigravity:gemini-3.8-flash-high", "claude:haiku"], … },   // 候補は "backend:model"
  "table": { "trivial": ["t1", "t1", "t2"], … } }                               // low・mid・high の段
```

画面（委譲カード・設定 › 委譲。design-system.md）が使う WebSocket のコマンド（`core/protocol.mjs`）: `delegationRouting { refresh? }`（設定・既定値・一覧・キーの `hasKey`・秘密の置き場の状態・今のモデル一覧に無い候補と使えないバックエンド `warnings`・候補ごとの今の使用量と使えるかどうか `candidates`）、`setDelegationRouting { settings }`、`setDelegationRoutingKey { service, key }`・`deleteDelegationRoutingKey { service }`（`service` は `openrouter`（Jev）/ `cerebras`）。変わったら `delegationRoutingChanged` イベント（使用量を取り直したときも）。タスクごとの `routing` は `agentTasks` の各行（`running` の配信の `tasks` にも同じ形）。やり直しは `retryAgentTask`（上）。

**鍵と外部送信。** 判定器のキーは互換の接続先と同じ秘密の置き場（`compat-endpoint-secrets.json`。`delegation-routing:openrouter` / `delegation-routing:cerebras`）に置き、画面には `hasKey` だけ返す。キーの中身は確かめない（確かめると登録の時点で外へ送ることになる）。キーをログ・タスク・会話の記録・エラーに出さない。**外部送信の同意はキーの登録**: キーが無ければ外へは何も送らず、難しさは `mid`。送り先の URL は固定で、リダイレクトは追わない。

## 会話・権限・作業場所

子は新しい Pleiad 管理会話。親の会話全文や非公開の思考はコピーせず、`task` と明示された `context` を渡す。
`cwd` の既定は親の作業場所。相対指定は親の作業場所から解決する。並行編集では別 worktree の絶対パスを指定する。
Pleiad が自動的に worktree を作成・マージする機能ではない。

子の承認モードは**親の強さまで継ぎ、それを超えない**。
承認モードは範囲（`none` < `readonly` < `workspace` < `full`）と自律（`ask` < `judge` < `never`）の
2軸で表してあり（`docs/multi-backend.md` §2.5、規則は `core/modes.mjs`）、
委譲先のモードのうち親の位置に収まるもののなかで、いちばん強いものを選ぶ。
どちらが強いとも言えないときは範囲を先に見る。読むだけに落とすと、書き込みを含む依頼をそもそも果たせないため。
たとえば Codex の `full` から Claude へ委譲すると子は `auto`、Claude の `auto` から Codex へなら子は `auto`。
親が `default`（都度確認）なら、子も都度確認の側で始まる。

収まるモードが無い、あるいは範囲を機械的に強制できないエンジンに「誰にも聞かない」を渡すことになる場合は、
**委譲した瞬間に1回だけ親の会話で承認を求める**。承認カードには、どのバックエンドをどのモードで動かすことになるかを表示する。
拒否すると委譲は失敗する。コマンドのたびに聞かれるのとは負担が違うので、1回に畳んでいる。
Antigravity は対話承認を持たず常に全部自動（`yolo`）なので、親が無制限（Codex の `yolo`、Claude の `bypass`）でない限りこの確認が出る。
Codex の親は `full` / `yolo` 以外では必ず確認する。Codex は MCP のツール呼び出しを自前の承認に通さず、これが無いと委譲が起きたことに気づけないため。

親の自動許可・承認済み操作そのものは引き継がない。実行中の承認は子の会話で通常の Pleiad カードとして表示する。
範囲が `none` / `readonly` の親（Claude の `plan`、Codex の `readonly`）から
`ply_delegate` / `ply_task_send` は受け付けない。異なるエンジンの子による権限の拡大を防ぐため。
タスクを操作できる MCP 接続は作成元の会話に限定する。接続資格情報は会話にひもづく能力であり、バックエンドがそれをネイティブ子に継承する場合も同じ作成元として扱う。
接続は会話ごとに使い回し、ターンが終わっても閉じない。再開したセッションが同じ URL とトークンを持ち続けるため、ターン終了で閉じると次のターンの委譲が 401 になる。閉じるのは会話を削除したときだけ。接続にターンそのものを持たせず、呼ばれた時点で走っているターンを鍵から引く（持たせると終わったターンが回収されない）。

同時に活動できる Pleiad タスクは8件、1会話100件、委譲の深さは4階層。各会話の追加指示は20件まで。
実際のターン開始はサーバー全体の同時実行数にも従う。

## 承認の中継と承認待ちの伝達

子の会話で承認が要るとき、その会話の祖先（委譲の親、さらにその親…最上位まで）にも同じ承認を出す。
人間は最上位の会話に居るので、1段だけ上げても誰も見ない場所に出るだけになる。
どれか1つで答えれば全部が決着し、残りのカードは消える。子の会話のカードは今までどおり出る。

中継したカードの見出しには委譲先のタイトル（委譲したときの `task` の先頭）を出す。どの会話の承認か分からないため。
中継したカードには「常に許可」を出さない。「常に許可」は子の会話で今後も通す約束で、
依頼元の画面からは子が今後何をするのか見えないまま恒久的な許可を与えることになる。子の会話を開けば従来どおり押せる。
中継の複製は、その会話のターンが終わっても取り下げない。元の会話が決着した（答えた・中断した・止めた）ときに一緒に消える。

子が人間の承認を待っているあいだ、`ply_task_status` と `ply_task_wait` は `status` に `waiting` を返し、
`ply_task_wait` は上限まで待たずにすぐ戻る。依頼元のエージェントには、どの会話で承認すればよいかを利用者へ伝えさせる。
`waiting` は「いま承認を待っているか」から導く見せかけの状態で、保存する状態（`queued` / `running` …）は変えない。
`ACTIVE` の集合と、再起動時に実行中を `interrupted` にする扱いを壊さないため。

## 完了通知

Pleiad は結果を保存し、親が空いたときに専用の完了通知で次のターンを開始する。
子がさらに Pleiad の子を作った場合は、その結果通知と子の回答が終わるまで待ち、最終回答を依頼元へ返す。
親の人間からの送信待ちを優先する。通知は画面で「Pleiad タスクの結果を受け取って再開しました」と表示し、人間の発言と区別する。
通知の文は依頼元の会話の言語（`[Pleiad タスク完了通知 / <taskId>]` / `[Pleiad task completion notice / <taskId>]`。docs/design.md「多言語対応」）。人間の発言との区別は文言ではなく、送った本文のハッシュ（セッションの記録の `taskNotices`）で行う。子の会話は親の会話の言語を継ぎ、ply_agents の instructions・ツールの説明・エラーも会話の言語で返す。
バックエンドのネイティブ履歴には、この通知が入力メッセージとして残る。

親が走っている・裏の作業が残っている・送信待ちがあるときは通知を送らない。
送信が `requeue`（未受領）で返った場合だけ再送し、受領が不明な失敗は自動再送しない。

## 保存・画面・再起動

`AGENT_HOST_DATA/agent-tasks.json` にタスク、管理元、親会話、実行先、子会話、待機メッセージ、結果、通知状態、振り分けの記録（`routing`）、最初の `context`（やり直し用）を保存する。
会話メタデータの `delegation` に親とタスク ID を、`routing` にどう選ばれたかを記録する。会話の分岐を表す `parent` とは別にする。
入力欄の上の「バックグラウンド N」（全件終了後は「バックグラウンド · 完了 M」。design-system.md「バックグラウンド」）で子の会話を読む・停止する・承認に答える。「会話として開く」で子の会話そのものへ移り、子からはヘッダーの「依頼元の会話」で戻れる。完了後も札と、依頼元の会話の `ply_delegate` のカードの「開く」から確認できる。

再起動時に実行中・待機中だったタスクは `interrupted`、配送途中の通知は `unknown` にする。未確認の変更を自動再実行しない。
実際のファイルと子の会話を確認した後、`ply_task_send` で明示的に再開できる。
更新・終了の稼働判定には Pleiad タスクも含める。

## 検証

`npm test` でタスクの管理と SDK MCP クライアント接続、fake を使ったサーバー全体の委譲・継続・停止と、承認の中継・`waiting` を検証する。
振り分けは `tests/unit/delegation-routing.mjs`（規則・段・使用量・アカウント。判定器は偽の fetch）と `tests/unit/server-delegation-routing.mjs`（偽の Jev と偽の agy でサーバー全体。別の候補でやり直す・承認モードの確かめ・動いている元のタスク・完了通知の一行も）、画面の文と並びは `tests/unit/delegation-routing-view.mjs`。テストのサーバーは使用量を定期的に取らず（`AGENT_HOST_ROUTING_USAGE=off`）、判定器の送り先を手元に向ける（`AGENT_HOST_OPENROUTER_API` / `AGENT_HOST_CEREBRAS_API`。本物へは送らない）。
`npm run test:e2e -- agent-delegation` は実サービスを呼び、Claude → Codex、Codex → Claude と結果通知による再開を確認する。
単独確認には `E2E_DELEGATION_PARENT=codex` などを使える。
