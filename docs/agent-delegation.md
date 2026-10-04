# Pleiad のエージェント間委譲

Claude・Codex の会話から、`ply_agents` MCP の `ply_delegate` で別の子会話を作成できる。
`kind`（仕事の種類）は必ず書く。`backend`（`claude` / `codex` / `antigravity`）を書けばその委譲先に固定し、
省けば Pleiad が委譲先を選ぶ（下の「委譲先の自動振り分け」）。同じバックエンドへの委譲もできる。
エージェントがシェルから別の CLI を起動する必要はなく、Pleiad の既存バックエンド接続を使う。

## ツール

| ツール | 引数 | 動作 |
|---|---|---|
| `ply_delegate` | `kind`, `task`, 任意の `title`, `backend`, `context`, `cwd`, `model`, `effort`, `isolate` | 子会話を作り、すぐ `taskId`・短い `title`・`routing`（どう選んだか）・分けた作業場所なら `worktree`（`{ id, branch, path, origin, baseBranch }`）を返す。`title` は一覧と子会話の見出しに使い、無ければ依頼の最初の空でない行。`model` / `effort` は `backend` を書いたときだけ。`isolate`（真偽）は下の「分けた作業場所」 |
| `ply_task_status` | `taskId`, 任意の `offset` | 状態と結果。結果は16,000文字ずつ返し、`nextOffset` で続きへ進む。子で実行前に拒否されたコマンドは `rejections`（下の「実行前に拒否されたコマンド」） |
| `ply_task_wait` | `taskId`, 任意の `seconds`（1〜30、既定30） | 上限まで待つ。承認待ちになったらすぐ戻る。未完了なら現在の状態を返す |
| `ply_task_send` | `taskId`, 任意の `message`, `backend`, `model`, `effort` | `backend` / `model` / `effort` を書くと子の設定を替える（下の「子の設定を替える」。設定だけなら `message` を省ける）。`message` は同じ子会話に追加指示。子のターンが走っていて途中送信を受けられるなら、今のターンへ途中送信（`control.steer`）で渡す（下の「追加指示の配送」）。渡せなければ順番に待ち、次のターンで送る。完了後・停止後なら再開する（止まった直後に送った指示も捨てずに走らせる）。止めている途中（`cancelling`）は断る |
| `ply_task_cancel` | `taskId` | タスクと、その配下の Pleiad タスクを停止する |
| `ply_task_list` | なし | 呼び出し元が作成した Pleiad タスクだけを列挙する。結果の本文は載せず、拒否は件数（`rejectionCount`）だけ |
| `ply_usage` | 任意の `backend` | 各バックエンドの使用枠（枠ごとの `usedPercent`・`resetsAt`、`plan`、`checkedAt`、`message`）。省略時は使用枠を読めるバックエンドすべて |

**子の設定を替える**（`ply_task_send` の `backend`・`model`・`effort`。[ADR 0135](adr/0135-parent-changes-child-settings.md)。`core/server.mjs` の `taskSettingsPlan` / `applyTaskSettings`）:
- 子の会話の「次のターンから適用」（`nextSettings`。人の入力欄と同じ予約）に入れる。子が走っていても今のターンは止めない。走っていなければ次に走るとき（設定だけでは走らせない。例外: 使用枠の上限で止まっている子のエージェントを替えると、人の切り替えと同じく上限の待ちが解け、送信待ちが流れる）。一緒に積んだ `message` は、予約がある間は走っているターンへ途中送信しない（`canSteerNotice`）ので、替えた後のターンで読まれる。同じエージェントのモデルだけは、`sessions.setModel` と同じく走っているターンにも即時に伝える（できるエージェントだけ。返り値の `settings.modelLive`）。返り値はタスクの状態と `settings`（`{ backend, model, effort, mode, appliesTo: 'nextTurn', modelLive? }`）
- エージェントを替えると、子の次のターンで引き継ぎ（`docs/backend-handoff.md`）を通って会話の履歴を渡す。作業場所はそのまま。子の承認モードは `resolveDelegatedMode` で、親の強さと子の今の強さ（人が下げていればそれ）の弱い方を上限にして決め、収まらなければ親の会話で 1 回承認を求め、断ったら何も変えない。元のエージェントへ戻したときは子の会話の今のモードのまま
- アカウントは替えない（子の会話のアカウントのまま。[ADR 0094](adr/0094-human-only-five.md)）。接続先は `ply_delegate` と同じ規則
- モデルが子の作業場所の一覧に無い（`model_unknown`。選べるものを添える）・そのモデルで選べない思考の強さ（`effort_unknown`）・使用量の取り置きで使用枠が満杯（`quota_full`）・自分が委譲していないタスク・止めている途中・子のターンが始まるところ（`agent:tasks.childStarting`）・`message` が空白だけか長すぎる・承認カードを待つ間に子の設定やタスクの状態が変わった（`agent:tasks.settingsMoved`。承認の後に計画を作り直して比べる）は断り、何も変えない。断る理由はすべて書く前に確かめる。書くのは子の予約 → タスクの記録 → 指示の順で、後の失敗（保存・受け付け）では書いた分を前に戻す
- 記録: 子の会話の変更の記録（`backend`・`model`・`effort`。by: `agent`・via・bySession、理由「依頼元の AI が変更」）。タスクの `backend`・`model`・`effort`（替えたなら `mode`）を新しい値にし、`routing.target` を新しい委譲先に、`routing.changed`（`{ by: 'parent', at, from, count }`。`from` は最初の委譲先）を足す（今と同じ値なら書かず、最初の委譲先へ戻したら印を外す）。`ply_task_status` の値は子の次のターンからのもの。子のターンが始まるときは、タスクの記録を子が実際に走る値に合わせる（`agentTasks.sync`。人が子の予約を取り消した・替えたとき）。画面へは `agentTaskChanged { taskId }` で知らせ、委譲カードは新しい委譲先と「依頼元が変更（元: …）」を出す

`ply_usage` は重い委譲・並列委譲の前に、使用率の高いバックエンドを避けるために呼ぶ。読むだけなので、読み取り・計画モードの会話からも呼べる（`ply_delegate` / `ply_task_send` だけが `DELEGATING_TOOLS` として制限される）。
取得は設定の「使用量」（`providerUsage`）と同じ `quotaCache` を通すので、値は最大60秒古く、何度呼んでも各サービスへの問い合わせは増えない。リセット時刻を過ぎた枠の `usedPercent` は、画面と同じく今の値ではないので `null`（不明）にする。
ローカルの使用実績（トークン数・参考費用）は返さない。Claude でアカウントを登録していれば `accounts` にアカウントごとの枠を並べ、表示名にメールアドレスが含まれる場合はローカル部を1文字残して伏せる。アカウント ID・資格情報は返さない。
不明な `backend` はエラー。1つのバックエンドの取得失敗はそのバックエンドの `message` に入れ、他は返す。

**委譲の指示**: 委譲の使い方は、利用者の指示ファイルではなく Pleiad の指示の既定の項目として Pleiad が入れる（[ADR 0023](adr/0023-pleiad-added-delegation-instructions.md) を [ADR 0026](adr/0026-context-global-settings-and-ply-instructions.md) で置き換え）。`ply_agents` の instructions の後ろに毎ターン足す。依頼元の会話には「委譲の進め方」（委譲を基本にする・この会話でやること。編集できる）と「委譲の振り分けの使い方」（`kind` を付けて `backend` を書かない。同じリポジトリを同時に書く子は Pleiad が分けた作業場所に分けること・完了通知や `ply_task_status` に「作業場所: 分けた作業場所 …（未取り込み）」とあればそのブランチを元の作業場所へ取り込むのは自分の仕事で競合も自分で解くことも書く。委譲と連動で編集できず、振り分けが無効なら入れない）、委譲された子の会話には「委譲した会話では任せない」（さらに委譲しない・コマンドには時間上限を付ける・常駐するサーバーやアプリはバックグラウンドで起動して PID を控え、自分で止める・`Start-Process -Wait` のような無期限待機をしない。編集できる）、Codex の子にだけ「Codex の実行前の拒否」（承認なしのモードでも Codex 自身の安全判定で拒否されることがある。言い換えで回避せず、実行できなかったコマンドと理由・残ったものを報告する。編集・切り替えできる）。項目・スイッチ・記録は context-runtime.md「Pleiad の指示」。Antigravity の子にも、コマンドの時間上限と PID の管理の指示をカスタムエージェントの本文に足す。親とユーザーの会話には足さない（[ADR 0048](adr/0048-delegation-silence-notice.md)）。編集済みの子向け指示は上書きせず、既定に戻すと新しい文面になる。

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
| `visual` | 3D モデリング、生成画像のベクター化、イラスト・ロゴなど、見た目の出来栄えが成果を決める高度なクリエイティブ作業（図・グラフ・画面のモックは含めない。形が決まっていれば `implement`、形を子が決めるなら `ux_change` / `ux_new`） |

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
   | ux_change / ux_new | t4 | t4 | t4 |
   | visual | tv | tv | tv |

   段の候補（既定、左から）: t1 = antigravity `gemini-3.8-flash-high` → claude `haiku`。t2 = antigravity `gemini-3.8-flash-high` → codex `gpt-6-luna` → antigravity `claude-opus-4-6-thinking` → claude `sonnet`。t3 = codex `gpt-6-sol` → claude `sonnet`。t4 = claude `opus` → claude `fable`。tv = codex `gpt-6-astra`（クリエイティブ作業＝`visual` だけに使う。新しい画面の `ux_new` は t4 の opus で足りる。[ADR 0058](adr/0058-delegation-creative-tier.md)）。
5. **候補を 3 組に分ける。** Claude はアカウントごとに判定する（[ADR 0040](adr/0040-delegation-routing-headroom.md)）。
   - **使えない（外す）:** `unavailable`（バックエンドが有効でない・CLI が無い・Claude の登録アカウントにトークンが無い）、`model_unknown`（今のモデル一覧に無い）、委譲先でのモデル再確認による `rejected`、効く枠の今の使用率が 100% 以上の `quota_full`。`unavailable` の中身は `skipped[].detail`（`disabled`・`not_installed`・`no_token`。使用量をまだ一度も取っていないときは付けない）で、画面は「使えない（未インストール）」と添える。
   - **余裕が少ない（後回し）:** `usage_unknown`（取得失敗・取得中・枠なし・不明な枠あり）、`usage_stale`（取得間隔の 3 倍＝15 分を超えて古い。閾値は設定にはなく内部の定数）、`quota_high`（効く 5 時間以外の枠のどれかが後回しの線、既定 80%、以上）、`pace_high`、`pace_unknown`。`avoidPercent` は候補を除く線ではなく後回しにする線。5 時間の枠（`minutes === 300`）は 100% 以上のときだけ使えないと判定し、100% 未満なら後回しの判定には使わない。5 時間の使用率が不明でも、それだけでは `usage_unknown` にしない。
   - **余裕あり:** 上記のどれにも当たらない候補。
   - `pace_high`: 週次の枠のペース（使用率 ÷ 経過率）が 1.2 を超える。経過率はリセット時刻と期間から出し、20% 未満は見ない。
   - `pace_unknown`: 経過率が出せない週次の枠で、使用率が 20% × 1.2 = 24% を超える（24% 以下なら、経過率がいくつでもペースで落ちないので通す）。
   - リセット時刻を過ぎた枠は、使い直しが始まっているので使用率 0 とみなす。
   - 候補に効く枠: claude は 5 時間・週次と、そのモデルの系統の週次（`seven_day_opus` など。`seven_day_oauth_apps` も念のため全モデルに効かせる）。codex は主の枠と、名前がそのモデルに当たる追加の枠。antigravity はモデル名の語をいちばん多く含むグループ（`gemini-*` → Gemini のグループ、`claude-*` / `gpt-*` → Claude and GPT のグループ）。グループが見つからなければ `usage_unknown`。
6. **Claude のアカウント。** 余裕ありのアカウントがあれば 5 時間以外の効く枠の最大使用率が低い順、同じなら週次のペースが低い順、最後の同点決めだけ 5 時間の使用率が低い順。無ければ余裕が少ないアカウントを次の苦しさの順で選ぶ。同じ人の重複は、**組織（`.claude.json` の `oauthAccount.organizationUuid`）とメールアドレスの両方が分かって一致するものだけ**まとめる。残す順は余裕あり → 余裕が少ない → 使えない、同じ組なら苦しくない方、なお同じならログイン中の方。どちらかが分からなければまとめない。重複をまとめた後の各認証を、カード・設定・再試行・エラーでは別々の行にする。選ばれなかった余裕ありの認証には `lower_priority` を付ける。
7. **段を選ぶ。** 基準の段から上へ、各段の候補を左から見て余裕ありを先に選ぶ。無ければ基準の段から上へ 1 段ずつ余裕が少ない候補を選ぶ。同じ段では使用量が分かるもの（`usage_unknown` / `usage_stale` 以外）→ 5 時間以外の効く枠の最大使用率が低い順 → 週次のペースが低い順 → 5 時間の使用率が低い順 → 段の候補の順。基準から上がすべて使えないときは 1 段ずつ下り、各段で余裕あり、次に余裕が少ない候補を選ぶ。tv は tv だけを見る。見たすべての段で全候補が使えないときだけエラー。エラー文は後回しの線と Claude のアカウントごとの理由を含む。行は言語によらない `- backend:model [認証の表示名] (段): 理由 (中身) 枠 使用率% pace ペース` の形（Claude 以外と認証情報の無い Claude は角括弧なし）にし、画面はこの行を読む。
8. 選んだ backend / model / account で子の会話を作る（`prepare`）。**自動で選んだ子は親の会話の接続先を継がず公式で走る**（候補を公式の使用枠で選んでいるため）。Claude を選んだときは選んだアカウント（`''` はログイン中）。選んだ候補のモデルは、委譲先の作業場所（`cwd`）で一覧にあるかを確かめ直し、無ければ `model_unknown` として次の候補から選び直す。それでも子の会話を作る時点で使えなければ、既定に落とさずエラー。

**使用量の取り置き。** 振り分けのたびに使用量を取りに行って待たない。サーバーは待ち受けを始めてから、既存の使用量の取得（`providerQuota`。設定の「使用量」・`ply_usage` と同じ 1 分のキャッシュを通す）を 5 分ごとと委譲の直後に呼び直し、振り分けはその値を同期的に読む。起動直後でまだ一度も取れていない、または有効なバックエンドのどれかの値が古い（取得間隔の 3 倍を超える。取得中ならそれに相乗り）ときだけ、取り直しを判定と同じ 3 秒まで待つ（`createUsageMonitor` の `ensureFresh`）。それでも間に合わなければ、これまで通り `usage_stale` / `usage_unknown` で後回しになる。候補のモデルが一覧に無いバックエンド（agy はログインの確認でモデル一覧を覚える）は、30 分に 1 回までログインの確認で一覧を引き直す。振り分けが無効なら取らない。

**`routing`**（返り値・DB（`agent_tasks`）のタスク・子の会話のメタデータ `routing`・会話の一覧の行に同じ形）:

```jsonc
{ "mode": "auto" | "pinned" | "manual", "kind": "implement",   // manual は人が「別の候補でやり直す」で選んだもの（下）
  "judge": "jev" | "cerebras" | "none" | null,          // 答えを使った判定器。固定なら null
  "signals": { "diagnose": false, … } | null, "probabilities": { "diagnose": 0.12, … } | null,  // 確率は Jev のとき
  "difficulty": "low" | "mid" | "high" | null, "baseTier": "t2", "tier": "t3",   // baseTier は表の段、tier は選んだ候補の段（自動のときだけ）
  "target": { "backend": "claude", "model": "opus", "account": "oz", "accountLabel": "OZ" }, // accountLabel は伏せた表示名。account の '' はログイン中
  "targetWindows": [{ "label": "…", "minutes": 10080, "usedPercent": 11 }],      // 選んだ候補に効いた枠の、選んだ時点の使用率（委譲カードの内訳）
  "selectedWithLowHeadroom": { "reason": "quota_high", "window": { "label": "週次", "minutes": 10080, "usedPercent": 83 }, "avoidPercent": 70 }, // 余裕が少ない候補を選んだときだけ
  "skipped": [{ "candidate": "claude:opus", "tier": "t4", "account": "", "accountLabel": "ログイン中", "reason": "quota_high",
                "window": { "label": "週次", "minutes": 10080, "usedPercent": 85 }, "windows": [ … ] }], // Claude は認証ごとに 1 行
  "usageAt": "2026-09-26T03:00:00.000Z",   // 選んだ候補の使用量の取得時刻（選べなければ見た中で最も古いもの）。skipped[] にも各自の checkedAt
  "fallback": null,                        // 判定器を使えなかった理由（no_key など）
  "escalated": true,                       // 「Jev が迷ったら Cerebras」で聞き直したときだけ
  "retry": { "of": "ply-task-…", "from": { "backend": "…", "model": "…", "account": null }, "by": "user" } }  // manual のときだけ
```

依頼文・判定器の生の応答・キーは保存しない。アカウントの見出しに含まれるメールアドレスは `ply_usage` と同じく伏せる。
固定（`mode: "pinned"`）の `target` は実際に使う値（モデルが既定に戻った、継いだアカウント）で書く。
後で規則を見直すため、失敗はタスクの `status`（`failed`）と `routing` で数えられる。人が別の候補でやり直したことは、やり直したタスクの `routing.retry`（`of` が元のタスク、`from` が元の委譲先）で数え、元のタスクの `routing` と `of` で結び付ける。集計の画面はまだ無い。

**別の候補でやり直す**（委譲カードの操作。画面は design-system.md「委譲カード」、WebSocket の `retryAgentTask { taskId, candidate, account?, stop?, approved? }`。`core/server.mjs` の `retryAgentTask`）:
- 自動で選んだ委譲のカードからだけ出す。候補は設定 › 委譲と同じ一覧（`delegationRouting` の `candidates`）のうち、余裕あり・余裕が少ないもの（使用量の取り置きで確かめる）。Claude は使える認証ごとに並べ、`account` に認証の id（ログイン中は `''`）を渡す。元の委譲先と同じ backend・model・account の組だけ除く。サーバーでも認証を含めて確かめ、使えない・元と同じ・形が不正なら断る
- 同じ依頼（`task` と `context`）で**新しいタスク**を作る。元のタスクは書き換えない。タスクは最初の `context` を持つ（タスクの記録の `context`。一覧・`ply_task_status` には載せない）。`context` を持つ前に作ったタスクは `task` だけを渡す
- 依頼元は元のタスクと同じ会話（`parentSessionId`）。依頼元のターンの外で作る（`prepare` は `routing.mode: manual` のときだけ依頼元のターンを求めない）。作業場所は元のタスクの `cwd`。自動のときと同じく接続先は継がず公式で走り、Claude なら明示して選んだ認証
- 子の承認モードは `ply_delegate` と同じく依頼元の会話の強さまで（`resolveDelegatedMode`）。それを超えるなら作らずに `{ confirm: { agent, mode } }` を返し、画面が 1 行で示して `approved: true` で頼み直す。依頼元の会話が読み取り・計画モードなら断る
- 元のタスクが動いている（`queued` / `running` / `cancelling`）ときは `stop`（真偽）が要る。画面で「止めて◯◯でやり直す」「止めずにやり直す」を選ばせる。`stop: true` なら元のタスクを止めてから作る（止めたタスクの完了通知は出さない）
- やり直したタスクの完了通知は依頼元のエージェントに届く。依頼元が作ったタスクではないので、通知の 2 行目に「利用者が <元の taskId> を別の委譲先でやり直したタスク」を添える（`agent:delegation.noticeRetry`）。依頼元は `ply_task_*` で同じように読める

**設定**（`prefs.json` の `delegationRouting`。未設定の項目は既定値。画面から `null` を送った項目は既定に戻す。読むときに不正な項目は既定に戻し、保存のときは全体を断る）:

```jsonc
{ "enabled": true,
  "judgeByKind": { "trivial": "jev", …, "ux_change": "none", "ux_new": "none", "visual": "none" },
  "escalateToCerebras": false,
  "avoidPercent": 80, "paceLimit": 1.2,
  "tiers": { "t1": ["antigravity:gemini-3.8-flash-high", "claude:haiku"], … },   // 候補は "backend:model"
  "table": { "trivial": ["t1", "t1", "t2"], … } }                               // low・mid・high の段
```

画面（委譲カード・設定 › 委譲。design-system.md）が使う WebSocket のコマンド（`core/protocol.mjs`）: `delegationRouting { refresh? }`（設定・既定値・一覧・キーの `hasKey`・秘密の置き場の状態・今のモデル一覧に無い候補と使えないバックエンド `warnings`・候補ごとの今の使用量と使えるかどうか `candidates`）、`setDelegationRouting { settings }`、`setDelegationRoutingKey { service, key }`・`deleteDelegationRoutingKey { service }`（`service` は `openrouter`（Jev）/ `cerebras`）。変わったら `delegationRoutingChanged` イベント（`change: 'settings'`）。使用量の取り直しが終わったときは同じイベントの `change: 'usage'`。種類のない旧イベントは設定の変更として扱える。設定保存は使用量の取得を待たない。自動選択をオンにしたとき、または使用量をまだ持たない候補を増やしたときだけ裏で取り直す。タスクごとの `routing` は `agentTasks` の各行（`running` の配信の `tasks` には載せない。下の「保存・画面・再起動」）。やり直しは `retryAgentTask`（上）。

**鍵と外部送信。** 判定器のキーは互換の接続先と同じ秘密の置き場（`compat-endpoint-secrets.json`。`delegation-routing:openrouter` / `delegation-routing:cerebras`）に置き、画面には `hasKey` だけ返す。キーの中身は確かめない（確かめると登録の時点で外へ送ることになる）。キーをログ・タスク・会話の記録・エラーに出さない。**外部送信の同意はキーの登録**: キーが無ければ外へは何も送らず、難しさは `mid`。送り先の URL は固定で、リダイレクトは追わない。

## 会話・権限・作業場所

子は新しい Pleiad 管理会話。親の会話全文や非公開の思考はコピーせず、`task` と明示された `context` を渡す。
`cwd` の既定は親の作業場所。相対指定は親の作業場所から解決する。

**分けた作業場所（2026-10-03、[ADR 0089](adr/0089-worktree-on-demand.md)）。** 同じリポジトリに書く子が並ぶとき、Pleiad が子ごとに分けた作業場所（`git worktree`）を作って子の `cwd` にし、終わった後の片付けまで持つ。**取り込み（マージ）は依頼元のエージェントがする**（Pleiad はマージしない）。
- **いつ分けるか**（`ply_delegate` の `isolate`。省略時の自動判定は `core/worktree-host.mjs` の `decideIsolation`）: `isolate: false` は分けない。`isolate: true` は書き手が居なくても分ける（git でなければ分けない）。省略なら、子が書く（書き込みの範囲のモード・種類が `trivial` `mechanical` `implement` `ux_change` `ux_new` `visual`。`investigate` `review` `design` は分けない）うえで、同じリポジトリに依頼元以外の書き手（走っている別の会話・子、依頼元が今のターンでファイルを変えている）が居るときだけ分ける。同じターンから並列に呼ばれた委譲は 250ms ほど待ってまとめて数える（書き手が 1 つなら今の場所のまま）。
- **置き場**: `<リポジトリの親>/<リポジトリ名>.pleiad/<id>`、ブランチ `pleiad/<id>`、ベースは今の HEAD。依存（`node_modules` など）は張らない。作れなければ（git でない・コミットが無い・失敗）今の場所のまま走らせる。
- **子への指示**（最初の依頼に足す。`agent:tasks.worktreeInstruction`）: 作業はこの作業場所の中だけ・元の場所の絶対パスに書かない・依存は入っていないので必要なら自分で入れる・終わったらこのブランチにコミットする。
- **依頼元へ返す**: タスクの記録に `worktree`（上の形）と、完了時の状態 `workspace`（`{ state: unmerged | merged | empty | unknown, files, ahead, dirty, removed }`）。完了通知の結果の後に `作業場所: 分けた作業場所 <branch>（未取り込み · N ファイル）`（`agent:delegation.noticeWorkspace*`。取り込み済み・変更なしで片付けたものはその旨、もう無いものは「片付け済み」）。`ply_task_status` / `ply_task_wait` は今の状態の 1 行 `workspaceSummary` と構造 `workspace` を返す。
- **片付け**: 子が終わったとき（変更なし・取り込み済みなら消す。子の会話の cwd は元の場所へ戻してから）・ターンの終わり・起動時・右パネルを開いたときに状態を見る。未取り込みは残り、右パネル「git」の「残っている作業場所」に出る（取り込みを頼む相手は依頼元の会話）。追加の指示（`ply_task_send`）で片付け済みの子が再開したときは、元の場所から新しい分けた作業場所を作り直す。
- **一覧**: `agentTasks`（と `running` の `tasks`）の行の `worktree` に、台帳にまだあるか（`live`）。画面は作業場所が変わった（`worktreesChanged`）ら会話の分を読み直す。委譲カードの開いた内訳の「作業場所」は `⑂ 分けた作業場所 <branch>`、終わって取り込まれていなければ閉じた行の右端に「未取り込み」。

子の作業場所の git の変更は、Pleiad が事実として依頼元へ返す（2026-10-03、[ADR 0085](adr/0085-host-reads-git-and-turn-snapshots.md)）。子のタスクの完了時に、子の会話の間（その会話の最初のターンの始まりの撮影から今まで）に変わったファイルかコミットがあれば、タスクの記録の `git`（`{ branch, detached, head, linked, files, add, del, commits }`）に持つ。完了通知の結果の後に 1 行 `変更: <branch> · N ファイル +a −d · コミット k`（`agent:delegation.noticeGit`。変更が無ければ載せない）を添え、`ply_task_status` / `ply_task_wait` は `git` と同じ 1 行の `gitSummary` を返す。人の画面では、委譲カードの内訳の「変更」の行（押すとその作業場所の右パネル「git」）。親は子の報告文を信じる代わりに、事実で確かめられる。

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

Pleiad タスクには件数・深さの上限を置かない。同時に活動できる件数、1会話で作れる件数、委譲の深さ、追加指示の件数のどれも制限しない（2026-09-27 に、同時8件・1会話100件・深さ4階層・追加指示20件の上限を廃止）。会話をまたいだターンの同時実行数にも上限は無い（`docs/design.md`「送信待ち」）。

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

## 無音と長いコマンドの通知

実行中の子の最後の動き（バックエンドのイベント、ツールの開始・結果、本文差分、承認待ちの開始・再開）を `lastActivityAt` に持つ。Antigravity は履歴に残さない `step_update`、Claude は SDK の `tool_progress`、Codex は `item/commandExecution/outputDelta` も数える。これらの活動だけで画面の表示を増やさない。`ply_task_status` / `ply_task_list` はこの時刻と `silenceMinutes`（実行中の無音分数。承認待ちは `null`）を返す。
既定で 5 分、子から動きが無ければ、親が受け取れるときに専用の無音通知で親のターンを 1 回始める。`AGENT_HOST_TASK_SILENCE_MINUTES` で分数を変えられ、`0` で無効。子は止めない。同じ無音期間には重ねて通知せず、動きが戻った後に再び無音になれば知らせ直す。人間の承認待ちは数えず、再開時から数え直す。親が忙しい間は通知を保留し、送ったか不明な失敗では自動再送しない（[ADR 0048](adr/0048-delegation-silence-notice.md)）。

コマンドの時間は無音とは別に数える。`AGENT_HOST_TASK_COMMAND_MINUTES`（既定 5 分、`0` で無効）に達すると、そのコマンドについて一度だけ親へ通知する。コマンド出力・思考・別のツールの活動では時計を延ばさず、人間の承認待ちだけを差し引く。親が忙しい間は保留し、未受領（`requeue`）だけ再送する。受領が不明な失敗は再送しない。通知はコマンド固有の ID を持ち、無音通知や完了通知とは区別する。

`ply_task_status` / `ply_task_list` の `activeCommands` は、コマンドごとに `toolCallId`、`command`、`cwd`、`observedAt`、`startedAt`、`startKnown`、`elapsedMinutes`、`state`、分かれば `turnId`・`nativeTaskId`・`processId` を返す。本文と cwd は既存の秘密値の伏せ方を使い、本文は台帳で 2000 字、通知で 200 字に切る。既知の形式以外の秘密は伏せきれない。開始時刻がないものは最初の観測から数え、開始を推定して埋めない。`processId` はバックエンドの識別子であり OS の PID とは限らない。`stopSupported` はこの台帳が個別停止を提供するかを表し、現在は false。

| バックエンド | 開始 | 完了 |
|---|---|---|
| Antigravity | `run_command` の ACTIVE を正規化した `tool.start` | 同じ ID の DONE を正規化した `tool.result` |
| Claude | Bash / PowerShell の `tool_use` を正規化した `tool.start` | 前景の `tool_result`、または task ID を結んだ `task_notification` / 終了状態の `task_updated` |
| Codex | `commandExecution` の `item/started` を正規化した `tool.start`（`startedAtMs` があれば保持） | 同じ item の `item/completed`。元のターンの終了後も受け取る |

Claude の background 起動結果（`backgroundTaskId` または起動を示す本文）は完了ではない。`task_started` / `task_updated` で background に移ったものも、実際の終了まで残す。Codex の端末は子タスクが `completed` になっても通知対象で、終了を確認するまで台帳に残る。台帳の通知は子を再実行しない。サーバー再起動後は保存済みコマンドの生存を確認できないため `state: unknown`・経過 `null` とし、再通知や自動停止はしない。

## 完了通知

Pleiad は結果を保存し、完了した時点で依頼元へ専用の完了通知を届ける（[ADR 0057](adr/0057-deliver-completion-notice-live.md)）。届け方は 2 通り。

- **走っている依頼元のターンへ途中送信（`control.steer`）で渡す。** 依頼元がターンを実行中で、`control.steer` を持ち、次ターンの設定の予約と人の送信待ち（outbox の未送・失敗・保留・結果不明）が無いとき。判定は `core/completion-notices.mjs` の `canSteerNotice`。圧縮のターン・中断や終了に向かっているターン・途中送信を持たないバックエンド（Antigravity）には渡さない。人の送信を優先する決まりは変えない。
- **空いたときに新しいターンで送る。** 上の条件を満たさず、依頼元が走っておらず・裏の作業が残っておらず・送信待ちも無いとき。渡せなかった通知（途中送信が受理されない）もこちらへ戻る。

子がさらに Pleiad の子を作った場合は、その結果通知と子の回答が終わるまで待ち、最終回答を依頼元へ返す。
OS の完了通知は依頼元の会話に出す。依頼元のターン後も子が動いている間は保留し、結果の配送で始まったターンが終わるか、キャンセルなどで結果が届かないまま作業がなくなった時点で 1 回出す。走っているターンへ渡した通知は新しいターンを作らないので、その依頼元のターンの終わりに 1 回出る。子の承認・質問が人間の返事待ちになったときは、その子の会話名で OS 通知を出す。
通知は画面で「Pleiad タスクの結果を受け取って再開しました」と表示し、人間の発言と区別する。走っているターンへ渡した通知も同じ 1 行（`taskNotice`）で、人間の吹き出し・送信待ち（outbox）にはしない。
通知の文は依頼元の会話の言語（`[Pleiad タスク完了通知 / <taskId>]` / `[Pleiad task completion notice / <taskId>]`。docs/design.md「多言語対応」）。人間の発言との区別は文言ではなく、送った本文のハッシュ（セッションの記録の `taskNotices`。`core/server.mjs` の `recordTaskNotice`。新しいターンの通知も途中送信の通知も同じ）で行う。子の会話は親の会話の言語を継ぎ、ply_agents の instructions・ツールの説明・エラーも会話の言語で返す。
バックエンドのネイティブ履歴には、この通知が入力メッセージとして残る。

### まとめて届ける

同じ依頼元へ届ける `pending` が複数あるときは 1 つの通知（1 ターン、または 1 回の途中送信）にまとめる。同じ依頼元への配送は同時に 1 つだけで、その間に完了した分は次の配送でまとめる。別の依頼元の通知は混ぜない。
1 件のときの文は今までどおり。2 件以上は `[Pleiad タスク完了通知 / N 件]` の見出し（`agent:delegation.noticeBatch`）の後に、`--- <taskId> ---` から始まる節（`agent:delegation.noticeSection`。実行先・状態・依頼・結果・拒否など、1 件の文と同じ中身）を完了の早い順に並べ、最後に「元の依頼に必要な作業を続けてください。」を 1 度だけ置く。結果は 1 件 16000 字までで、まとめたときは全体で 16000 字ほどに分け（1 件あたり 2000 字を下限）、切った分は `ply_task_status` の `offset` で読める。子の報告後に Pleiad が止めた裏の作業と、実行前に拒否されたコマンドの段落は、各節の中に入る。

### 受け取り済みの通知は送らない

依頼元が `ply_task_status` / `ply_task_wait` で終了状態（`completed` / `failed`）と結果を受け取ったら、通知を `read` にして送らない。結果が長く `nextOffset` が残っていても、受け取った時点で配達済み。
`ply_task_list` は結果を返さないので対象にしない。実行中の `status` も対象にしない。終わった直後で通知がまだ始まっていない（`none`）ときに受け取っても `read` にし、直後の `run.notice` が `pending` に戻さない。`delivering` 以降（送っている最中・送り終えた・不明・止めた）は変えない。`ply_task_send` は `none` に戻し、次に走る回の結果は通知する（走っている回に途中送信で渡した指示は、その回の結果が新しい指示も反映するので、通知はその回の完了で 1 回）。依頼元が `ply_task_wait` でそのタスクを待っている間は、終わっても通知を送らない（結果は待ちの戻り値で渡る。走っているターンへ同じ結果を重ねないため）。

### 状態と待つ条件

通知の状態は `none` → `pending`（届ける結果がある）→ `delivering`（送っている）→ `sent` / `unknown`（受領が不明）。止めたタスクは `suppressed`。依頼元が結果を先に受け取ったものは `read`。

| 状態 | いつ | 次 |
|---|---|---|
| `none` | 実行中・追加指示の受け付け直後 | 終わって `pending` / `suppressed`（止めた）/ `read`（受け取り済み） |
| `pending` | 届ける結果がある。親が受け取れない間はここで待つ | 送る直前に `delivering`。受け取り済みなら `read` |
| `delivering` | 送っている（保存してから渡す） | 受理なら `sent`。受理されない（`requeue`）ならメモリだけ `pending` へ。結果不明・例外は `unknown` |
| `sent` | 渡した | 走っているターンへ渡した分が、読まれないままターンが死んだら `pending`（`renotify`。同じ回のものだけ） |
| `unknown` | 受領が不明（再起動で `delivering` だったものも） | 自動で再送しない |
| `suppressed` | 止めた。`ply_task_cancel`・人の取り消しでは走っている・待っているタスクだけ（終わって `pending` のものは止めるものが無いので、そのまま届ける）。依頼元の会話の中断では、終わって届いていない結果も止める（勝手に新しいターンを始めない）が、次のターンで一覧にして伝える（design.md「中断と再開」） | — |
| `read` | 依頼元が結果を受け取った | `ply_task_send` で `none` |

親が受け取れない間は `pending` のまま何も書かない。「受け取れる」は、新しいターンを受けられる（`ready`。上の 2 つ目の条件）か、走っているターンへ渡せる（`steerable`。1 つ目）のどちらか。無音・コマンドの通知は前者だけを使う（[ADR 0048](adr/0048-delegation-silence-notice.md)）。
裏の作業に数えるのは終わりを待つものだけ（画面の衛星と同じ基準。`core/server.mjs` の `awaitedBackground`）。Codex のバックグラウンド端末（`kind: terminal`。dev サーバーなど）は数えない。以前は端末のある親には通知が届かなかった（2026-09-27）。裏の作業が残っているだけで依頼元のターンが走っていないときは、今までどおり保留する。
送る直前に `delivering` を保存し、保存できなければ送らない（同じ依頼元の分は 1 回の保存）。送ったか分からないまま落ちたときに、再起動で `unknown` にして再送しないため。
`deliver` が `requeue` を返したら（受け取る直前に親が動き出した・走っているターンが途中送信を受理しなかった）、メモリだけ `pending` に戻し、ファイルは `delivering` のまま書かない。
次に送るとき、ファイルがすでに `delivering` なら書き直さない。以前は親が忙しい間、500ms ごとにファイル全体を 2 回ずつ書き直していた（2026-09-27）。

走っているターンへ渡す道（`core/server.mjs` の `steerNotice`）は、outbox を通さず、item id `task-notice-<uuid>` で `control.steer` を呼ぶ。本文のハッシュを先に記録する。`true` は `sent`、`false` は `requeue`、例外は `unknown`。「渡った」合図を後から出すバックエンド（`steerConfirms`）では、合図（`userMessage.delivered`）で通知の 1 行を出し、捨てられた（`userMessage.dropped`）か、合図が来ないままターンが終わったら、`pending` に戻して送り直す（人間の発言と違い、通知は送り直してよい）。合図の無いバックエンドでは受理した時点で 1 行を出す。

子の報告後も終わらず Pleiad が止めた裏の作業があれば、通知の本文の最後に 1 段落足す（`agent:delegation.noticeStoppedBackground`。件数、待った分数、先頭 3 件の見出し）。全件は `ply_task_status` の `stoppedBackground` で読める。

子で実行前に拒否されたコマンドがあれば、通知の本文の最後（「元の依頼に必要な作業を続けてください。」の前）に 1 段落足す（`agent:delegation.noticeRejections`）。
件数と、先頭 3 件の `command`（伏せて切ったもの）と `reason` だけを並べ、全件は `ply_task_status` の `rejections` で読むよう案内する。拒否が無ければ何も足さない。

## 追加指示の配送

決定は [ADR 0065](adr/0065-steer-task-instructions.md)（[ADR 0044](adr/0044-task-instruction-delivery.md) の配送の規則を、走っている子のターンにも広げる）。

`ply_task_send` は指示を `queued` で受け付けた（保存できなければ断る）後、次の条件がそろえば待たずに**子の走っているターンへ途中送信**する。

- タスクが `running` で、子が委譲の実行中のターンとして走っている。
- 子が `control.steer` を持ち、`canSteerNotice`（`core/completion-notices.mjs`）を満たす。圧縮のターン・中断や終了に向かっているターン・途中送信を持たないバックエンド（Antigravity）・次ターンの設定の予約・子の会話に人の送信待ちがあるときは渡さない。
- 後ろに待機の指示が無い（順序を守る）。前の途中送信が「渡った」合図を待っている間の次の指示も待機する（渡らなかった前の指示が次のターンで後ろに回ることを避ける）。

渡す道は完了通知の `steerNotice` と同じ形（`core/server.mjs` の `steerInstruction`）。outbox は通さず、item id `task-send-<指示 ID>` で `control.steer` を呼ぶ。子の会話には通常の user 発言（`userMessage`）として出し、履歴にはバックエンドの記録が入る。

| `steer` の返り | 指示の状態 | 意味 |
|---|---|---|
| true、合図の無いバックエンド | `delivered` | 受理した時点で渡ったものとして扱う。新しいターンは走らない |
| true、`steerConfirms`（Claude・Codex） | `sending` | 受理しただけ。`userMessage` は `pending: true`。`userMessage.delivered` で `delivered` |
| false | `queued` | 受理されない。待機のまま次のターンで送る |
| throw | `dropped` | 結果不明。自動で送り直さない（届いているかもしれない）。`ply_task_send` の返り値に `warning`（`agent:tasks.steerUnknown`。送り直さず `ply_task_status` と子の結果で確かめる）を添える |

`sending`（合図待ち）の指示は、`userMessage.dropped` が来たか、合図が来ないまま子のターンが終わったら（`endTurn` が結果の確定より先に片付ける）`queued` に戻し、次のターンで送る。指示の ID で照合するので、渡った後に遅れて来た捨てられた合図では戻さず、二重に送らない。人の発言と違い親からの指示なので、送り直してよい。戻した後に子の回が失敗・停止で終わったときは、待機の指示と同じく `dropped` になる。止めたタスク（`cancelled`）へ戻すときも生き返らせず `dropped`。

走っている回に途中送信で渡した指示は、その回の結果が新しい指示への返答も含む（結果にするのは回の最後の返答。「子の結果」）。ターンが終わってから待機を新しいターンで送る道は今までどおりで、その回の結果が指示の結果になる。再起動では、合図待ちだった `sending` は渡ったものとして `delivered` に残し（子は `interrupted`）、走らせ直さない。

## 子の結果

結果にするのは、子の会話のこの回（最後の user の発言より後）の assistant の返答のうち、最後のもの（`core/agent-tasks.mjs` の `finalReply`）。
ただし、バックエンドが `stopHookFollowUp` の印を付けた返答は飛ばす。飛ばすと何も残らないときは、今までどおり最後の返答。

印は、Stop フックに止められて（exit 2・`decision: block`）main が続けた分のうち、**中身の仕事をしていない**ものに付く。何を続きとみなし、何を中身の仕事とするかは文面ではなくバックエンドが決める（docs/multi-backend.md §2.3 の `NormalizedMessage`）。

- **Claude**（`claude-normalize.mjs` の `stopHookFollowUps`）: transcript の `stop_hook_summary` の行で `hookErrors` があり `preventedContinuation` でないものを「止めた」とし、その後の assistant 行を続きとする。続きは次の人の発言・途中送信・裏の作業の完了通知で切れる。続きで呼んだツールが全部「調べるだけ」（ToolSearch・Skill・Read・Grep・Glob・LS・TodoWrite・WebSearch・WebFetch・MCP のリソースの読み出し・`ply_context` の load_skill / instructions_for_path など）なら、続きの返答に印を付ける。Edit・Write・Bash・PowerShell・ほかの MCP・サブエージェントを 1 回でも呼んだ続きは中身の仕事として扱い、印を付けない（Bash は読むだけのこともあるが、変えたかを見分けられないので仕事をした側に倒す。倒れた先は今までどおりの「最後の返答」）。
- **Codex・Antigravity**: 印を付けない。結果は最後の返答。

理由: 2026-09-27、Claude の子が報告を書いた後に、ナレッジの棚卸しを促す Stop フックで ToolSearch と load_skill を呼んで「ナレッジ化対象なし」と書いて終わり、その一言が依頼元への結果になって報告が届かなかった。フックの出力は isMeta の user として transcript にだけ残り、会話の記録からは続きだと分からない。本文で見分けると、フックの文面や子の言い回しが変わるたびに外れる。続きで直して報告し直した（フックが不備を指摘する型）なら、そちらが本当の結果なので選ぶ。
子の会話そのもの（画面）には続きの返答も残る。

## 子に残った裏の作業

子の結果は、子のターンが終わり、子が待つ裏の作業と子が作った Pleiad タスクが片付いてから確定する（`execute`）。**main がまだ結果を待っているコマンドは、5 分で知らせるだけで自動停止しない。完了報告後の裏の作業は、10 分待って片付ける。** この片付けは委譲の子だけに適用し、ユーザーの会話では行わない（[ADR 0048](adr/0048-delegation-silence-notice.md)）。

- **Claude**: main が返答を終えても、裏のタスクが生きている間はターンを保持する（`phase: waiting`）。委譲の子では、この状態が `AGENT_HOST_DELEGATION_BACKGROUND_WAIT_MS`（既定 600000 ミリ秒＝10 分）続いたら、サブエージェント以外の裏の作業を `stopBackground` → `Query.stopTask` で止める。CLI は停止の完了通知で main を再開させ、ターンを終える。main が再開したら時計を解除し、再び `waiting` に入ってから数え直す。サブエージェントは止めない。
- 停止後に main が足した一言だけが結果にならないよう、停止前の報告を結果の先頭に残す。止めた作業は台帳から外し、タスクの `stoppedBackground`（`[{ kind, label }]`。見出しは秘密を伏せて 300 字で切る）と完了通知に残す。その回で止めたものがなければ `stoppedBackground` を消す。
- **Codex**: 端末はターンの外に残り、終わっても main は再開しない。子の結果と完了通知は端末を待たず、コマンドの監視は続ける。子の完了後も `ply_task_cancel` で、台帳とバックグラウンド一覧の ID が一致する端末を明示的に止められる。
- **Antigravity**: バックグラウンド移行の情報がなくても、`run_command` の ACTIVE から DONE まで監視する。

コマンドの 5 分通知は開始から数え、片付けの 10 分は報告後の待機から数える。コマンド通知を無効にしても片付けは有効。再起動時、実行中だった子タスクは従来どおり `interrupted` にし、再実行しない。

## 実行前に拒否されたコマンド

Codex は承認なしのモード（`full`・`yolo`）でも、Codex 自身の安全判定で一部のコマンドをプロセスを作る前に拒否する（`blocked by policy` など。削除に限らず `Stop-Process`・`Start-Process` なども）。
この拒否はアイテムにならず、通知にも `thread/read` にも出ないので、Pleiad は Codex の rollout から拾う（docs/multi-backend.md「Codex の実行前の拒否」、[ADR 0035](adr/0035-read-codex-rollout-for-rejections.md)）。
委譲の子で拾ったものは、`execute` がターンの `tool.result` の `rejection` から集め、タスクの行の `rejections` に保存する。

```json
"rejections": [
  {
    "tool": "exec_command",
    "via": "code_mode",
    "command": "Remove-Item -LiteralPath 'C:\\work\\tmp\\cache.bin' -Force",
    "shell": "powershell.exe",
    "kind": "policy",
    "reason": "blocked by policy",
    "raw": "exec_command failed: CreateProcess { message: \"Rejected(…)\" }",
    "approvalRequested": false,
    "callId": "call_…",
    "turnId": "01a0…"
  }
]
```

- `via`: `code_mode`（custom tool の `exec` の中の `tools.exec_command`、またはその続きを待つ `wait`）/ `direct`（`exec_command` を直接）。
- `kind`: `policy`（ポリシーの拒否。`reason` は Codex の理由）/ `spawn`（プロセス作成の失敗。同じ形に包まれて来る）/ `other`。`command` は描かれたコマンドを `[shell, -Command, script]` に戻せれば script、戻せなければ描かれた文字列。分からなければ `null`。
- `approvalRequested`: 同じターンで同じ call id の承認を求められたか。`never` の拒否は承認を経ないので、今は `false` になる。
- 依頼元は別のエージェント・別の提供元のモデルのこともあるので、`command`・`reason`・`raw` は形で秘密を伏せてから 300 字で切る（`core/redact.mjs`。URL の userinfo とクエリの値、`Bearer …`、`sk-…`、`ghp_…`・`github_pat_…` などの既知のトークン、`password=` などの名前付きの値）。形を知らない秘密は残りうる。子の会話の画面は今までどおり伏せない。
- 1 タスク 50 件まで（超えた分は `rejectionsDropped` に数だけ）。
- 前の完了通知の後に走った回の分を足していく。`ply_task_send` を受けたとき、前の回の分をすでに依頼元へ渡していれば（通知が `delivering` / `sent` / `unknown` / `suppressed` / `read`）、次の回の分で置き換える。まだ渡していなければ（走っている・通知の前）足す。
- 拾えないもの: code mode のスクリプトが例外を握りつぶしたとき（形が崩れる）、1 つのセルで複数拒否されたときの 2 件目以降（最初の例外で止まる）、rollout を読めないとき（読めなければ黙って空）。

## 保存・画面・再起動

`AGENT_HOST_DATA/pleiad.db` の `agent_tasks`（1 タスク 1 行。[ADR 0115](adr/0115-records-in-sqlite.md)）にタスク、管理元、親会話、実行先、子会話、待機メッセージ、結果、通知状態、振り分けの記録（`routing`）、最初の `context`（やり直し用）、実行前に拒否されたコマンド（`rejections`。伏せて切ったもの）、実行中コマンド（`activeCommands`）と通知済みの印、子の報告後に Pleiad が止めた裏の作業（`stoppedBackground`）を保存する。
追加指示は各タスクの `instructions: [{ id, text, at, state }]` に受け付け順で保存する（[ADR 0044](adr/0044-task-instruction-delivery.md)）。`queue` は初回依頼の本文または `{ instructionId }` の FIFO。旧ファイルの文字列 `queue` は読み込み時に追加指示へ移し、初回依頼は区別する。`state` は `queued` → `sending` → `delivered`、受領前の再投入なら `queued`。途中送信で渡した指示は受け付け直後に `queue` から外して `sending` にし、渡れば `delivered`、渡らなければ `queued`（`queue` の先頭）へ戻る（「追加指示の配送」）。失敗・停止・再起動で待機中だったものは `dropped` として残す。子のターンに渡した `sending` は、中断や再起動でも `delivered` とし、実行の例外では渡る前に失敗したものとして `dropped` にする。件数上限は設けない。
`ply_task_status` / `ply_task_list` は本文を含めず `pendingMessages` を保つ。`running` も待機件数と `instructionRevision` だけを含む。画面が選んだタスクの詳細を開くと `agentTaskInstructions` でそのタスクの本文を読み、まだ渡っていない指示を「追加の指示」の発言として示す（途中送信の合図待ち＝`sending` は会話の末尾の稼働表示の前に、メインパネルの作業中の送信と同じ状態の行「次の区切りで AI に渡します」つきで。渡れば子の履歴の user 発言に代わる。待機＝`queued` は末尾に時計の印で、未配送＝`dropped` は「✕ 届かずに終わった」を残す。画面は design-system.md「バックグラウンド」）。配送済みは子の通常の user 発言として履歴から描く。同じ本文を複数回送れるので、指示 ID・状態・配送順を使い、本文の一致では重複を判定しない。現状「会話として開く」の通常画面には待機中の指示を表示しない。
会話メタデータの `delegation` に親とタスク ID を、`routing` にどう選ばれたかを記録する。会話の分岐を表す `parent` とは別にする。
`running`（全部の端末へ配る）の `tasks` は、終わっていないタスク（`queued`・`running`・`cancelling`）と、完了通知がまだ依頼元に届いていない（`notification` が `none`・`pending`・`delivering`）タスクだけの短い行（`agentTasks.running()`。題・状態・依頼元・子の会話・委譲先・モデル・時刻・通知・失敗の理由（500 字まで）・`pendingMessages`・`instructionRevision`・`worktree`・やり直しの元 `retryOf`）。依頼文・振り分けの記録・結果は載せない。
以前は消さない全部の記録（依頼文と振り分けの記録付き）を載せていて、実データで 1 回 3.26MB になり、中継経由のスマホで帯域を埋めていた（2026-10-03）。
委譲カードとバックグラウンドの一覧が使う過去のタスクは、画面が会話を開いたとき（つなぎ直したとき・一覧を開いたとき・作業場所が変わったときも）に `agentTasks { sessionId, tree: true }`（操作 `delegation.tasks` の `parentSessionId`・`tree`。子の会話がさらに委譲した子孫まで）でその会話の分だけを読み、`running` の行を重ねて使う（`web/task-cards.mjs`）。
`running` に新しく現れた行と、`running` から外れた行（終わって通知が届いた）は `agentTasks { taskIds }` でその行だけを読み直す。`tree`・`taskIds` で読む行は結果の本文と拒否の記録を載せない（結果は `delegation.status`）。
入力欄の上の「バックグラウンド N」（全件終了後は「バックグラウンド · 完了 M」。design-system.md「バックグラウンド」）で子の会話を読む・停止する・承認に答える。「会話として開く」で子の会話そのものへ移り、子からはヘッダーの「依頼元の会話」で戻れる。完了後も札と、依頼元の会話の `ply_delegate` のカードの「開く」から確認できる。

保存は、書き換えたタスクの行だけを 1 つのトランザクションで書く（保存した JSON から変わった行だけ。変わっていない行は起動でも書き直さない）。書けなかったときの扱いは下のとおり。一時ファイルに書いてから置き換える保存（`core/atomic-file.mjs`）は、設定の台帳・`conversations/`・`presents/` に使う。
Windows では、別のプロセス（ウイルス対策・PowerShell の `Get-Content` など）が置き換え先を開いている間だけ rename が `EPERM` / `EBUSY` / `EACCES` になる。
この 3 つに限り、20ms から伸ばして合計 1.1 秒ほどやり直す。やり直すのは保存であり、子の実行や完了通知ではない。

それでも保存できないとき（保存障害）も、委譲の管理は閉じない。閉じるのはサーバーの終了（`close()`）だけ。
以前は 1 回の失敗で閉じ、再起動するまで全部の会話で委譲が「実行は中断されています」になっていた（2026-09-27）。

- 先へ進む前に保存が要る書き換え（新しい委譲・追加指示の受け付け、子の実行の開始、通知を送る前の `delivering`）は、失敗したらメモリを戻して進まない。
  依頼元には `ply_delegate` / `ply_task_send` のエラーとして理由を返す（`agent:tasks.storageFailed`）。障害中は、子の会話を作る前に書けるかを確かめる。
- 起きたことの記録（子の結果、送った通知、止めたこと）は取り消せないので、メモリはそのままにしてファイルを後で書き直す。
  利用者・依頼元の停止は、保存できなくても子に届く。
- 障害の間、スケジューラーは子の開始と通知の配送を止め、保存だけを間隔を空けて（500ms から倍にして最大 15 秒）やり直す。書けたら次のタイマーから再開する。
- `ply_task_list` / `ply_task_status` / `ply_task_wait` はメモリの状態を返し、障害中は `storageFault`（理由の文・`code`・`since`）を添える。所有権の制限は変わらない。
- 元の例外は errno・操作・タスク ID・時刻だけを stderr と `AGENT_HOST_DATA/agent-tasks-errors.log`（64KB を超えたら新しい半分を残す）に書く。パス・依頼文・結果・秘密は書かない。デスクトップ版はサーバーの stderr をファイルに残さないため。

再起動時に実行中・待機中だったタスクは `interrupted` にする。未確認の変更を自動再実行しない。
サーバーの正常終了（`close()`。更新の適用でアプリを閉じるときなど）で走っていた子は、終了の abort を `cancelled` として書かない。
走っていた状態のままファイルに残し、完了通知も作らず、次を走らせもしない。再起動で `interrupted` になり、依頼元の「止めたもの」に載る（2026-09-30）。
閉じる前に始まった保存・通知は、閉じた後も書き終えるまで続く。`close()` が返す Promise は、それらが書き終えると解ける。データ置き場を消す前（テストの後片付け）は、これを待つ（2026-10-03）。
利用者・依頼元の取り消し（`ply_task_cancel`・会話の中断）は先に `cancelling` にするので、これまでどおり `cancelled` を書く。
通知は、渡ったか分からない `delivering` だけを `unknown` にする。まだ親に渡っていない `pending` はそのまま、親が空いたら送り直す。
メモリだけにあった記録は再起動で失われるが、ファイルに残った状態から上の規則で安全な側に落ちる（実行中なら `interrupted`、送っている途中なら `unknown`）。
実際のファイルと子の会話を確認した後、`ply_task_send` で明示的に再開できる。
更新・終了の稼働判定には Pleiad タスクも含める。

## 検証

`npm test` でタスクの管理と SDK MCP クライアント接続、fake を使ったサーバー全体の委譲・継続・停止と、承認の中継・`waiting` を検証する。
完了通知は `tests/unit/agent-tasks-notice.mjs`（受け取り済み `read` は送らない・`ply_task_wait` の間は途中送信しない・同じ親の分を 1 回の配送にまとめる・`steerable` の途中送信で `sent`・受理されない/不明/捨てられた場合の状態・`canSteerNotice` の条件）と `tests/unit/server-delegation-notice.mjs`（fake の `bg` 台本で、依頼元のターンの中へ届く・人間の発言にしない・`ply_task_wait` の後は届かない・途中送信を止めている間に溜まった 2 件が 1 通・`steerConfirms` の合図と受理されない場合）。
追加指示の途中送信は `tests/unit/agent-tasks-steer.mjs`（受理・合図待ち・合図が先に来る・捨てられた・合図なしでターンが終わった・受理されない・結果不明・渡せない・順序・合図待ちの間の次の指示・止めた後・再起動。管理側だけを身代わりで）と `tests/unit/server-delegation-steer.mjs`（fake の `bg` 台本で、同じターンに入り新しいターンを走らせない・`DECLINE_STEER`/`THROW_STEER`/次ターンの設定の予約で待機か未配送・`steerConfirms` の送信中と `DROP_STEER`/`SILENT_STEER` が次のターンで 1 回だけ）。
保存障害は `tests/unit/agent-tasks-storage.mjs`（rename に EPERM を差し込む。回復・閉じない・障害中の読み取りと断り・requeue を書かない・再起動後の送り直し）。
実行前の拒否は `tests/unit/codex-rejections.mjs`（rollout の解析・読む範囲・伏せ方）と `tests/unit/server-codex-rejections.mjs`（身代わりの Codex が rollout に拒否を書き、会話・`ply_task_status`・完了通知・`ply_task_send` の次の回まで）。
子に残った裏の作業と子の結果は `tests/unit/server-delegation-background.mjs`（fake の台本 `bg-shell` / `active-shell` / `bg` / `term` / `hook-follow` で、報告後のコマンドを上限まで待って止める・台帳を閉じて完了通知に載せる・結果に止める前の報告を残す・返答前とユーザーの会話では止めない・サブエージェントは止めない・端末は子でも親でも待たない・Stop フックの続きの一言を結果にしない）と `tests/unit/delegation-result.mjs`（2026-09-27 の transcript と同じ行の形で、続きの印・中身の仕事をした続き・区切り・結果の選び方）と `tests/unit/claude-turn-end.mjs`（SDK の身代わりで、Stop フックの続きではターンが終わり、裏へ回ったまま終わらないコマンドがあると終わらず、`stopTask` で終わる）。
振り分けは `tests/unit/delegation-routing.mjs`（規則・段・使用量・アカウント。判定器は偽の fetch）と `tests/unit/server-delegation-routing.mjs`（偽の Jev と偽の agy でサーバー全体。別の候補でやり直す・承認モードの確かめ・動いている元のタスク・完了通知の一行も）、画面の文と並びは `tests/unit/delegation-routing-view.mjs`。テストのサーバーは使用量を定期的に取らず（`AGENT_HOST_ROUTING_USAGE=off`）、判定器の送り先を手元に向ける（`AGENT_HOST_OPENROUTER_API` / `AGENT_HOST_CEREBRAS_API`。本物へは送らない）。
子の設定を替えるのは `tests/unit/server-delegation-settings.mjs`（fake・身代わりの Codex と agy で、走っている子のモデル・思考の強さ、message なしと一緒、無いモデル・選べない思考の強さ、走っていない子のエージェントの切り替えと引き継ぎ、親より緩くなる切り替えの承認、他人のタスク、変更の記録）。
`npm run test:e2e -- agent-delegation` は実サービスを呼び、Claude → Codex、Codex → Claude と結果通知による再開を確認する。
単独確認には `E2E_DELEGATION_PARENT=codex` などを使える。
