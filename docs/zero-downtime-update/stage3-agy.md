# 無停止の更新 段階 3（agy）: 実測と実装のメモ

[plan.md](plan.md) の「段階 3」のうち agy（Antigravity）の部分。段階 0 の実測（[stage0-codex-agy.md](stage0-codex-agy.md) §3）は保持役の身代わり（`holder-sim`）で測ったので、ここでは**本物の保持役（`core/holder/`）に本物の agy を載せて**測り直し、そのうえで実装した。Codex と `!` の行は別の作業（この文書の範囲外）。

- 印: **実測** = 動かして確かめた。**テスト** = `tests/unit/` の試験が通る。**未確認** = 動かしていない
- 測った版: `agy 1.3.0`（段階 0 は 1.2.17）、`gemini-3.8-flash-low`、Node v24.14.0、Windows 11（x64）、保持役は `core/holder/`（規約 v1）

## 1. 実測: 本物の agy を本物の保持役で付け直す

スクリプト: `scripts/zero-downtime/agy/held-swap.mjs`（置き場は `temporary/zdu-agy-held/`。LLM は短い 2 ターン。シェルは `echo` 1 回）。親 A（`HolderClient`）が `spawn`（policy `none`）→ 印（`turn`）→ 1 行目の順で agy を起こし、ターンの途中（ツールの行 `tool/ACTIVE` が出た時点）で `ack`・`label`・`detach` して接続ごと閉じる。2.5 秒おいて親 B が別の接続で付け直す。

**実測（2 回流して同じ結果）**

| 場面 | 結果 |
|---|---|
| A が手を離した時点 | `init` → `user_input/DONE` → `agent_response/DONE` → `tool/ACTIVE(run_command)` の 4 行（seq 1〜4）を処理し、ack 4 |
| 親が居ない 2.5 秒 | 子は進む（保持役の seq が 4 → 8。`tool/DONE`・`agent_response`・`result` が溜まった） |
| B の付け直し | `welcome.children` に子が居る（`alive`・`seq`・`first: 1`・`acked: 4`・`marks.turn: 1`・`label`）。印〜ack の再生で A と同じ 4 行（**`init` を含む**ので、会話 id・モデルは再生から分かる）、続き（`attach(ack + 1)`）で `tool/DONE` → `agent_response/ACTIVE`・`DONE` → `result SUCCESS`（本文 `finished`）。**ツールの結果（`echo` の出力）も欠けず 1 回** |
| 会話 id | `init`・`result` とも同じ（`conversation_id` が付け直しの前後で変わらない） |
| 同じプロセスの 2 ターン目 | B が印を打ち直して（`mark`、位置は次の行）次の行を書くと、`result SUCCESS`（本文 `second`）。**`init` は 2 ターン目には出ない**（最初のターンの前に 1 回だけ）。保持役の記録は ack と印の小さい方より前を捨てる（`first` 1 → 9、`marks.turn` 1 → 9）。印が 2 ターン目の始まりに移ったので、1 ターン目の行は記録に残らない |
| 木ごと止める | `kill { tree: true }` で agy の pid が居なくなる（`tasklist` で agy.exe が 0 件）。保持役の `shutdown` で保持役も消える。**親が接続していない（attach していない）子への `kill` は保持役が無視する**ので、止める側は先に `attach` する |

**分かったこと**

- 付け直しに握手は要らず、記録の再生だけで足りる（段階 0 の結論が本物の保持役でも成り立つ）
- **ターンの印は、ターンごとに打ち直す**（agy の子は会話のあいだ生きる。`init` は最初のターンの再生にだけ入る。2 ターン目以降の会話 id は札の `sessionId` が持つ）
- 付け直したターンが終わったあとの子は、そのまま会話の次のターンに使える（記録の再生は要らず、新しいサーバーが同じ子に次の行を書く）

## 2. 実測: 中継の再試行（口を閉じて確かめる）

`core/agy-context-relay.mjs` は、Pleiad の口（`/mcp/context` など）へ POST する前の**つながる前の失敗**（`ECONNREFUSED`・`EHOSTUNREACH`・`ENETUNREACH`・`ENOTFOUND`・`EAI_AGAIN`・`UND_ERR_CONNECT_TIMEOUT`）を、150 ms おきに最長 6 秒（`PLY_RELAY_RETRY_MS`。`0` で再試行しない）やり直す。**つながった後の切れ（`ECONNRESET` など）はやり直さない**（呼び出しが二重に走りうる）。HTTP のエラー（401 など）もやり直さない。

- **テスト**（`tests/unit/agy-relay-retry.mjs`。本物の中継プロセス・本物の HTTP の口を閉じて開き直す）: 0.7 秒後に開き直すと返事が返る（856 ms）／開かないまま上限（600 ms）で「つながらない」のエラー（中継は落ちない）／`PLY_RELAY_RETRY_MS=0` は即エラー／つながった後の切れは再試行せず呼び出しは 1 回だけ届く／401 は再試行しない
- **実測**（`scripts/zero-downtime/agy/relay-retry.mjs`。本物の agy・本物の中継・本物の MCP の口 `core/mcp-bridge.mjs`。LLM は 2 ターン）: 口を閉じたままターンを送り、4.5 秒後に同じポートで開き直す。**再試行なし（`PLY_RELAY_RETRY_MS=0`）は `FAILED: calling "tools/call": Cannot reach Pleiad context: fetch failed`（開き直した口が受けた呼び出し 0）、再試行あり（既定 6 秒）は `pong-token-2`（受けた呼び出し 1）**。1.5 秒後に開き直すと再試行の有無によらず通る（agy が最初のツールの呼び出しを出すまでに数秒かかり、その前に開き直るため）ので、確かめるなら 4〜5 秒にする
- 引き継ぎの間（旧サーバーが口を閉じてから新しいサーバーが待ち受けるまで 0.8〜1.6 秒）の**呼び出しの前**の不通は、これで agy に見えない。**呼び出しの最中**に口が切れた分（`ECONNRESET`）は今までどおり 1 回失敗する（段階 4 の根拠の数え方は plan.md 2d のまま）

## 3. 実装

保持役の載せ方・付け直しの流れは Claude（`core/backends/claude-held.mjs`・`claude.mjs` の `adoptTurn`）と fake（`fake-held.mjs`）と同じ形。agy 固有の点は、**agy の子が会話のあいだ生きる（1 プロセス = 1 会話）**ことと、**握手も SDK も無く、行を書くだけ**なこと。

### 3.1 載せ方（`core/backends/antigravity-held.mjs`）

- **載せるか**（`heldPlan`）: `AGENT_HOST_AGY_HOLDER`（`on`・`off`。**無ければ `AGENT_HOST_RUNTIME_ROOT`（パッケージ版の main が渡す実行場所の置き場）があるときだけ載せる**。置き場の無い起動・テストは今の流れ）・shell 無しで起こせる実行ファイル（`.cmd`・`.bat` は載せない）・bot の会話でない（付け直さないので）・保持役につなげる。外れたら今の流れ（サーバーが agy を直に起こす。`antigravity-pids.mjs` の孤児の掃除も今のまま）。起動用の変数（`core/boot-env.mjs`）なので会話のシェルへ渡さない
- **子は policy `none`**（保持役は agy のプロトコルを知らない）。`AgySession`（`antigravity-cli.mjs`）に `held` を足した: `start()` が `spawnCli` の代わりに `held.start()` を呼び、出力の行は `feedLine`（旧 `#feed` の 1 行の処理）、stderr は `onStderr`（未ログインの URL・print timeout の印）へ届く。`proc` は ChildProcess の最小の写し（`stdin.write/end`・`kill`・`close`/`exit` の出来事）で、`die`・`#gone` の流れはそのまま
- **印はターンごとに、最初の行の直前に打つ**（`held.markTurn()`。位置は次の行）。agy の子は次のターンも使われるので、2 ターン目からは印を打ち直す（古い行は記録から捨てられる）
- **読みは行ごとに処理し終えてから ack する**。`onEvent` が Promise を返したら（本文の無い SUCCESS の確定待ち `EMPTY_SUCCESS_GRACE_MS`）、それを待ってから ack する（待つ間に手を離しても、新しいサーバーが同じ `result` を読み直す）
- **付け直しの再生**: 印から ack までを `handle(ev, { replay: true })`（server の `makeEmit` の再生の道。画面へ流さず実行中のスナップショットとメモリの状態だけを作る）で流し、続きは普通に流して行ごとに ack（`core/adopt.mjs` の `replayRecord`）。本文・ツール・結果・使用量・`turnResult` は再生で作り直る。`result` が再生の側に入っていれば付け直しの直後に締まる。**子が `result` の前に終わっていれば**、`die` → 失敗の `turnResult`（`agy が終了した`）で締める

### 3.2 札のバックエンドの欄（`backendCard`）

`{ held: true, agy: { sentAt, resumed, sentHash, home, keys, hookRuns } }`。**再生では作れないものだけ**: 発言の時刻（控えの発言の uuid が送信の時刻から決まる）・再開した会話か（控えを作るか）・発言のハッシュ（本文は札に入れず、旧サーバーが控えに書いた発言から引く。引けなければ発言を書き換えない）・agent の置き場（`home`）・**次のターンの印の比べ（`keys`）**・hooks の発火の記録の読み位置。`keys` は、起動時にしか渡せないもの（Pleiad のコンテキスト・ブラウザー・Hooks・ply_computer・ply_control・bot の人格）の印で、**トークンを含むものはダイジェスト**にした（`session.contextKey` などの個別のプロパティを `session.keys` に畳んだ。札に置いても秘密が出ず、付け直した先が同じ印で比べられる）。会話の id は札の `sessionId`、ツール・本文は再生。**`control.holder = { label, handOff }`**（server の `touchCard`・`holdable`・`handoverRun` の detach が使う）と `control.backendCard` を、agy を起こした直後・付け直した直後に渡す。付け直した後の `control` にも渡すので、次の引き継ぎでまた手を離せる

### 3.3 手を離す・idle の子・終わり

- **手を離す**（`control.holder.handOff`）: 控え（会話の記録）を最新に書いてから、札を子に置いて `detach`（答えが来た時点で以後の書き込みは転送されない）→ 読みを止める → ターンを `handedOff` で終える（server が締めない）。手を離している最中に `result` が届いてターンが終わっても、**札と印は外さない**（`handingOff`。終わった直後のターンを付け直す側が、記録の結果から締める）
- **idle の子**（ターンが終わった agy）: ターンの終わりに**札と印を 1 回の書き込みで外す**（`held.endTurn()`。付け直す対象から外す）。次のターンは同じ子を使う。外す人が居なくなる経路ごとに片付ける:
  - **引き継ぎ**: 新しいサーバーは idle の子を知らない（札が無い）ので、旧サーバーが **`backend.releaseIdle()`** で止める。**`core/server.mjs` の `handoverRun.stash` が、預かり物を置く前（`detach()` の前。後は旧サーバーの書き込みが転送されない）に、全バックエンドの `releaseIdle` を呼ぶ**（1 か所の追加）。次のターンは agy を起こし直す（会話は `--conversation` で続く）
  - **普通の終了**（`process.once('exit')`）: 手を離していない子を木ごと止める。**止める依頼は `HolderClient.sendBatch` で 1 回の書き込みにまとめる**（続けて `write` すると、`process.exit` までに最初の 1 つしか出ない。実測: 3 つの idle の子のうち 1 つだけが止まった。Windows の名前付きパイプ）。手を離した子には触れない（agent の置き場も残す）
  - **サーバーが落ちた後**: 次の起動の**最初の保持役の使用**（`sweepIdle`。`antigravity.mjs` の `fresh` の始め）が、札か印の欠けた agy の子を止める（付け直せる子＝札と印の両方がある子には触れない）。保持役を使う前（起動の途中・agy を使わない間）は動かさない（`holderLink` が保持役の親の座を取るので、データ置き場のロックを取る前に呼べない）。**agy を使わないまま終わると、落ちたサーバーが残した idle の子は残る**（残り）
- **孤児の掃除（`antigravity-pids.mjs`）・終了時の片付け**: 保持役の子は pid を持たず（`pids.remember(undefined)` は何もしない）、控えない。`process.once('exit')` は手を離した子を止めない
- **agent の置き場**: 保持役に載せる agy の置き場は **`held-<乱数>`**（`prepareAgent({ held: true })`）。サーバーの pid の名前（`<pid>-<乱数>`）では、旧サーバーが終わった後に `sweep()` が走る agy の置き場を消してしまうので、`sweep()` は `held-*` に触れない。消すのは agy が終わったとき（`cleanup`・付け直した側は札の `home` を `adoptHome` で受けて消す関数にする）と、前のサーバーが残した分（`sweepHeldHomes`。このプロセスのもの・生きている子の札が指すものは残す）

### 3.4 切り替え（`desktop/switch.cjs`）

**変更なし**。切り替えが数える「保持役に載ったターン」は server の `holdable(turn)`（`control.holder.handOff` を持つ、バックエンドを呼んだ後のターン）で、`running` の `held` / `handover.blocking` として届く。agy が `control.holder` を渡せば Claude と同じ数え方になる（`tests/unit/adopt-agy.mjs` の引き継ぎで `handover.blocking` が 0 になることを見る）。agy のターンが載らない場合（`AGENT_HOST_AGY_HOLDER=off`・置き場なし・bot・`.cmd`・保持役につなげない）は、今までどおり `blocking` に入って先送り。**承認待ちの時点は無い**（agy には対話承認が無い）。

## 4. テスト

- `tests/unit/adopt-agy.mjs`（偽の agy `tests/lib/fake-agy.mjs` に、ゲートで止める台本 `gated:<名前>` を足した。ツールの実行中（ACTIVE）でゲートが開くまで待ち、`result` を出し終えたら `<ゲート>.done` の印を置く。待ちは実時間でなくゲートと印のファイル）: 切り替え（置き場なし・off・既定 on。ターンが終わった子は札も印も無い）・ツールの実行中（A で手を離し、B が付け直す）・終わった直後（A の読みを止めて agy が `result` まで出してから手を離す）・中断（木ごと止まり、記録が捨てられ、次のターンは起こし直す）・強制終了（A を SIGKILL。札の置き直しで B が付け直す）・引き継ぎ（偽の main の `handover` の依頼 → 新サーバー `--handover`。`handover.blocking` が 0・idle の agy は旧サーバーが止める・同じポート・トークンなので付け直した agy を次のターンも使う・idle だった会話の次のターンは起こし直す）・普通の終了（main の shutdown。idle の agy が保持役に残らない）・後片付け（保持役・偽の agy が残らない）。**どの時点も `turnEnd`・`completedAt`・使用量（`presentKey` の 1 件）が 1 回、本文・ツールの結果・人の発言は履歴に 1 回、`restart` の中断にならない**。A の最初の保持役の使用が前のサーバーが残した idle の子を止めることも見る
- `tests/unit/antigravity-held.mjs`（部品。偽の source）: 切り替え・`.cmd` は載せない・置き場（`held-*` の掃除・`adoptHome`）・付け直し（再生は `{ replay: true }`・続きは普通に流して行ごとに ack・`result` の再生で付け直しの直後に締まる・控えは再生で作り直す・終わったら札と印を外す・`result` の無いまま終わっていれば失敗・控えに発言が無ければ作らない）
- `tests/unit/agy-relay-retry.mjs`（上の §2）
- **Linux**: WSL（Ubuntu-24.04、Node 22）で `adopt-agy`・`antigravity-held`・`agy-relay-retry` が通る（unix ソケットの保持役・`process.kill(-pid)` の木ごとの停止）
- **実機**（本物の agy 1.3.0・本物のサーバー。`scripts/zero-downtime/agy/held-server.mjs`。LLM は 2 ターン）: 会話を作ってから、`ping -n 7`（約 6 秒のシェル）のターンを、ツールの実行中（`tool/ACTIVE` の直後）に A が手を離し、B（`AGENT_HOST_ADOPT_HOLDER=1`）が付け直した。保持役の子は alive・seq 8・ack 8・印 6（2 ターン目の印）。**B で `turnEnd` 1 回（outcome ok）・`interrupted` 無し・`completedAt`・使用量 1 件・本文 `finished`・ツールの結果 1 件・人の発言は 2 ターン分 1 回ずつ**（B が起きてから 10 秒。ping の残りの時間）

## 5. 共有のファイルへの変更

並行する Codex・`!` の行の作業と後で合わせるために、最小にした分:

| ファイル | 変更 |
|---|---|
| `core/server.mjs` | `handoverRun.stash` の先頭で、全バックエンドの `releaseIdle?.()` を呼ぶ（3 行。agy だけが持つ） |
| `core/boot-env.mjs` | 起動用の変数に `AGENT_HOST_AGY_HOLDER` を足した |
| `core/holder/client.mjs` | `HolderClient.sendBatch(frames)`（複数の依頼を 1 回の書き込みで送る）を足した。agy の終わり・ターンの終わりの取り外しが使う |
| `desktop/switch.cjs` | **変更なし**（数え方は `held` / `blocking` のまま） |
| `tests/run.mjs` | `adopt-agy`・`antigravity-held`・`agy-relay-retry` を登録 |
| `tests/lib/adopt-server.mjs` | 場面 `handOffAgy`・`pauseAgy` |
| `AGENTS.md` | 環境変数の表に `AGENT_HOST_AGY_HOLDER`・`PLY_RELAY_RETRY_MS` |

## 6. 残り・申し送り

- **既定の `on` の書き方**: `heldEnabled`（`antigravity-held.mjs`）は `AGENT_HOST_AGY_HOLDER` の `on`・`off`・無し（置き場があれば on）。Claude（`claude-held.mjs`）は今は「`on` を明示したときだけ」で、既定 on は別の作業が直している。合わせるときは、置き場の有無を見る読み口（`heldEnabled(env, boot)` の `boot` で差し替えられる）を揃える
- **agy を使わないまま終わると、落ちたサーバーが残した idle の子は残る**（保持役の idle 終了は「生きた子が居ない」ときだけなので、保持役ごと残る）。次に agy を使う起動の最初の保持役の使用が止める。agy を使わない起動でも片付けたいなら、サーバーの起動（`restoreAdoptedTurns` の後）から呼ぶ口が要る（`core/server.mjs` の変更。Claude の付け直せなかった子の扱い（stage2-server-state.md 2b-7 の注意 (3)(4)）と一緒に決める）
- **付け直せなかった agy の子**（札があって付け直しをあきらめた・ポートが取れない）は保持役に残る。Claude と同じ扱い（`sweepIdle` は札と印の両方がある子に触れない）
- **ターンが終わった直後（`result` を処理し、`endTurn` で札と印を外した後）にサーバーが強制終了**されると、そのターンは完了していても `restart` の中断になる（札が無い）。窓は `turnEnd` の前後の数 ms
- **stderr は再生されない**: 保持役は stderr を記録しない。付け直しの前に出た `print timeout` の印・未ログインの URL は新しいサーバーに届かない（付け直した後の分は届く）
- **委譲の子の agy**（`agentTasks` が `execute` で動かす子）・Pleiad の Hooks（`hooksRuntime`）を持つ agy・`--agent` の置き場（`held-*`）を持つ会話の付け直しは、部品の単体（置き場・hooks の読み位置の札）まで。サーバーを通した確かめは `adopt-agy` に無い（fake の `held:` と同じ道で、server 側は共通）
- **複数の中継の束ね（`--context --computer --browser --control`）の不通**は実測していない。再試行は束ねても同じ `post()` を通る
- **`updates.handoverWork_other`（更新の確認の文）**: agy が載れば Claude と同じに「止めずに切り替わります」へ合わせる（plan.md 2d の残り (3)）。載るのは置き場があるときだけ（既定 on）

## 後始末

agy の会話は `~/.gemini/antigravity-cli` に残る（すべて短い試験の発話だけ）。要らなければ agy の側で消す（`docs/dev-verification.md` の `annotations`・`brain`・`conversations`・`presence`・`cache/last_conversations.json` の該当行）: `dc154e98-26ac-4161-b4f7-72eb0957b024`・`73a48898-8b95-4d7e-bc50-49abd37c3af8`（held-swap）、`ba00e081-39f4-4ff2-b92a-e059d6cc0c73`・`82a9a459-0cc1-4996-be32-d7de5648ce91`・`c12a8adc-0d9c-482b-9ec2-35dbbb3abfc2`・`22f1e3fe-5b28-4dfc-a52e-27b569a6d425`（relay-retry）、`31da5e0f-cbda-4091-9882-8d4263decda5`（held-server）。
