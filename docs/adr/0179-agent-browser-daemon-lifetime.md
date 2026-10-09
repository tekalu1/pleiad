# 0179 agent-browser のデーモンと置き場の寿命（暇なら 24 時間で落とし、子の終わり・会話の削除・掃除で止めて消す）

- 状態: 提案（2026-10-10）
- 日付: 2026-10-10
- 関連: [ADR 0148](0148-agent-browser-in-chrome.md)（Chrome の中継とエージェントへの渡し方。未確認の 1 の `agent-browser close` をこの ADR で確かめた）、[ADR 0147](0147-delete-sent-conversations.md)（会話を消したときの片付け）、docs/inapp-browser.md「中継とエージェントへの渡し方」

## 状況

エージェントのブラウザー（agent-browser 0.38）は、会話ごとに 1 つデーモンを起こす。デーモンは最初の `agent-browser` の呼び出しで起き、Pleiad の子のプロセスではない（Pleiad が落ちても残る）。次の問題があった。

- **デーモンが落ちない。** agent-browser の既定の暇の時間切れ（1 時間）は、`--cdp`（`agent-browser.json` の `cdp`）でつないだデーモンには効かない。委譲の子は数十〜数百の会話になり、終わった子のデーモンが何日も残る。
- **置き場が残る。** ターンの初めに、ブラウザーを使うかどうかにかかわらず、`<data>/agent-browser/<sha256>/agent-browser.json` と一時領域の `ply-ab-<hash>`（ソケットの置き場）を作っていた。会話を消しても消えず、消すと残ったデーモンを止める手がかり（`<セッション名>.pid`）も失う。

試験用の Chromium と CDP を記録する中継で確かめたこと（2026-10-09・10。利用者の Chrome には触れていない）:

1. `AGENT_BROWSER_IDLE_TIMEOUT_MS` を**明示して渡すと、`--cdp` のデーモンにも効く**（8000 ms で約 8.2 秒後に終わった）。落ちるときに CDP には何も送らず、Chrome もタブも残る。渡さないと既定の 1 時間を過ぎても落ちない。
2. `agent-browser close` は CDP に `Browser.getVersion` しか送らず、Chrome もタブも閉じない（`Browser.close` を送らない）。ただし、デーモンが居ないときは**新しいデーモンを起こして**から閉じ、中継が切れた後は「閉じた」と返しても**デーモンが落ちない**ことがある。`.config`・`.target` も残る。
3. デーモンのプロセスを落とす（Windows の TerminateProcess）と、CDP には何も送らず、Chrome もタブも残る。pid の記録（`.pid`）は残る。
4. Windows では、ソケットの置き場が無くてもデーモンが自分で作る。

## 決定

1. **暇なデーモンは 24 時間で落とす。** 会話の環境変数に `AGENT_BROWSER_IDLE_TIMEOUT_MS=86400000` を渡す（Claude の env・Codex の `shell_environment_policy.set`・Antigravity のプロセスの env）。人が続けて使う依頼元の会話の縛り（タブ）を、短い暇で失わない長さにする。
2. **止め方は `close` ではなく、確かめた pid を落とす。** `<ソケットの置き場>/<セッション名>.pid` の pid が生きていて、実行ファイルの名前が agent-browser（`agent-browser.exe`・`agent-browser-win32-x64.exe` など）のときだけ落とす（pid は使い回される）。プロセスの一覧が引けないとき・落ちないときは何も消さない（pid の記録を消すと、残ったデーモンを誰も止められない）。止めてから、ソケットの置き場と設定の置き場の両方を消す。
3. **止める時。**
   - 委譲の子が止まったとき（完了・失敗・取り消し）。続きの指示で動き直せば、次のターンが作り直す。その間にその会話のターンが始まっていたら止めない。
   - 会話を消したとき（依頼元の会話もこのときだけ止める）。
   - 掃除（起動の 1 分後と 1 時間ごと）で、持ち主の会話が記録に無い・終わった委譲の子と分かったとき。走っている会話・人が引き継いでいる会話は触らない。
4. **使わなかった置き場を残さない。**
   - Windows ではソケットの置き場を前もって作らない（デーモンが作る）。Unix は確かめていないので今どおり作る。
   - ターンの終わりに、そのターンでデーモンが一度も起きていなければ（ソケットの置き場にそのセッション名の記録が無ければ）、両方の置き場を消す。使った会話は縛りの記録（`.target`）を次のターンへ残すため消さない。
   - 掃除は、持ち主が居てデーモンが起きていない置き場のうち、1 時間より古いものを消す。この Pleiad の置き場に当たらない `ply-ab-*`（前の版が前もって作ったもの・別のデータの置き場の Pleiad のもの）は、空で 10 分より古いものだけ消す（中身があれば消さない）。

## 理由

- `close` は止めたい時（デーモンが居ないかもしれない・中継が切れた後）にこそ当てにならず、居なければ逆にデーモンを増やす。プロセスを落としても Chrome とタブには何も起きないことを確かめたので、落とす方が確実で安全。
- 実行ファイルの名前を確かめるので、使い回された pid のほかのプロセスを落とさない。
- 暇の時間切れだけに頼らず、子の終わりで止めるのは、委譲の子が多く、24 時間のあいだに溜まるため。依頼元の会話を止めないのは、人が続きにタブを使うため。

## 影響

- `core/agent-browser.mjs`: `BROWSER_IDLE_TIMEOUT_MS`・`listProcesses`・`stopBrowserDaemon`・`discardBrowserEnvironment`・`forgetBrowserEnvironment`（止めてから消す）・`settleBrowserEnvironment`・`sweepBrowserEnvironments`。`chromeRelayBrowser` は `bindings`・`forget` を持つ。
- `core/agent-tasks.mjs`: 子が止まったら `ended(sessionId)` を呼ぶ。`finishedSessions()` を返す。
- `core/server.mjs`: 子の終わり・会話の削除・ターンの終わり・掃除をつなぐ。busy は走っているターンと、中継の引き継ぎ（操作中・一時停止）。
- `core/backends/codex.mjs`: `shell_environment_policy.set` に `AGENT_BROWSER_IDLE_TIMEOUT_MS` を足す。
- 試験: `tests/unit/agent-browser-lifetime.mjs`（偽のプロセス表と kill。本物のプロセスは落とさない）、`tests/unit/agent-browser-env.mjs`。

残る課題:

- Unix で、入れ子のソケットの置き場（`/tmp/ply-ab-<uid>/<hash>`）をデーモンが自分で作るかは確かめていない。
- 当たらない `ply-ab-*` に生きたデーモンが居る（前の版で起きた・別のデータの置き場の Pleiad）場合、持ち主を引けないので止めない。前の版が暇の時間切れ無しで起こしたデーモンは、この版の掃除がその置き場の持ち主の居ないことを見つけるまで残る。
- 委譲の子がターンの外で（背景のジョブで）ブラウザーを使い続けると、子の終わりで止まる。
