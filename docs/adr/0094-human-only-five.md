# 0094 人だけ（human-only）の操作を 5 つに限る

- 状態: 承認（2026-10-03）。設定 limitResume を write にする決定は置換（0132）。「秘密の値」の組に API キーのコマンド（`setApiKey`・`deleteApiKey`・`setApiKeyUse`・`resolveApiKeyGuide`）を足した（0154。組の数は 5 のまま）
- 置き換えられた: 0132（設定 limitResume）
- 追記: 端末ごとの「AI からの依頼を受ける」（`setRemoteDeviceAgent`）は 5 つのうちの「リモートのペアリング」の組に入れる。5 つの数は変わらない（[ADR 0146](0146-remote-agent-delegation.md)）

## 状況

[ADR 0082](0082-control-surface-principals-and-risk.md) は、操作の危険度の 4 段目 human-only を「承認モード・秘密の値・アカウント・互換の接続先の鍵と既定・リモートの有効化とペアリング」とした。ところが移行の途中で、どの危険度にするか決めていない WS のコマンドも、`tests/ops-baseline.json` の除外表で human-only に置かれていた。分けた作業場所（[ADR 0089](0089-worktree-on-demand.md)）・通知の設定・Hooks の定義の読み出し・互換の接続先の確認し直しと削除・モデルの切り替え・コンピューターの操作の停止がそうで、AI は画面の人と同じことができなかった（思想 §2.2、[ADR 0007](0007-symmetric-ai-and-human.md)）。上限後の再開の設定 `limitResume`（[ADR 0093](0093-resume-after-usage-limit.md)）も human-only だった。

## 決定

- **human-only は次の 5 つに限る。** Pleiad の機能はほかは全部 AI も使える（危険度は read・write・guarded から選ぶ）。5 つは `core/ops/policy.mjs` の `HUMAN_ONLY` に WS のコマンドと設定のキーで書く。

  | 5 つ | WS のコマンド | 設定 |
  |---|---|---|
  | 承認モード | `setMode`・`resolvePermission`（承認カードへの応答） | `mode` |
  | 秘密の値 | `setDelegationRoutingKey`・`deleteDelegationRoutingKey`・`compatEndpointCheck`・`compatEndpointSave`・`mcpAuthStart`・`mcpAuthLogout` | |
  | アカウント | `saveClaudeAccount`・`deleteClaudeAccount`・`claudeLoginStart`・`claudeLoginCode`・`claudeLoginCancel`・`authLogin`・`authLogout`・`authSubmit`・`claudeAccounts`（一覧） | `claudeAccount` |
  | 接続先の既定 | `compatEndpointDefault` | |
  | リモートのペアリング | `remotePairingStart`・`remotePairingCancel`・`remotePairingApprove`・`remotePairingDeny`・`remoteRevoke`・`remoteDevices`（端末の一覧）・`setRemoteSettings` | |

- 5 つに当たらない 14 のコマンドは操作にし、WS のコマンドはその操作を呼ぶ薄い外側にする。

  | 操作 | 危険度 | 元のコマンド |
  |---|---|---|
  | `worktrees.split`・`keep`・`archive`・`restore`・`setSettings` | write | `worktreeSplit`・`worktreeKeep`・`worktreeArchive`・`worktreeRestore`・`setWorktreeSettings` |
  | `worktrees.discard` | write | `worktreeDiscard` |
  | `notify.setPc`・`notify.setDevice` | write | `setNotifyPc`・`setNotifyDevice` |
  | `hooks.read`・`hooks.readPly` | read | `readHook`・`readPlyHook` |
  | `compatEndpoints.recheck` | write | `compatEndpointRecheck` |
  | `compatEndpoints.delete` | guarded | `compatEndpointDelete` |
  | `sessions.setModel` | write | `setModel` |
  | `computer.stop` | write（`modeGate: false`） | `computerStop` |

  - `worktrees.discard` は guarded の案だったが write にする。消すのは変更が無いか取り込み済みのときだけで、未取り込みの変更・使っている会話やシェルがあれば残す（`action: kept`）。自動の片付けと同じ規則で、作業は失われない。
  - `compatEndpoints.recheck` は保存済みの URL とキーで確かめ直すだけで、秘密を入力しない。結果とモデルの一覧を記録するので write。
  - `compatEndpoints.delete` は保存したキーも消え、人がキーを入れ直さないと戻せないので guarded。
  - `computer.stop` は止める側だけで、始める・許可することはできない。読み取り専用の会話からも止められるよう `modeGate: false` にする。
  - `sessions.setModel` の、新しい会話の既定のモデル（prefs）として覚える動きは人の変更だけに残す。AI が自分の会話で替えたモデルを、黙って全体の既定にしない。
  - `hooks.read`・`hooks.readPly` が AI に返すコマンドの文字列は、形で分かる秘密を伏せる。画面の編集のシートには元の文字列を返す。
- `notifyRegister`（スマホの画面が自分の通知の鍵を登録する）は画面の内部（ui-internal）にする。
- `claudeAccounts`（アカウントの一覧）と `remoteDevices`（端末の一覧）は todo から human-only にする（アカウント・リモートのペアリングに当たる）。
- 設定 `limitResume` は write にする。上限で止まった会話の続け方・同時に動かす数・使用率の歯止めを選ぶだけで、アカウントを切り替えず（それは human-only）、承認モードと権限に触れない。既定はもともと自動で再開する。
- `tests/lint-ops.mjs` が、除外表の human-only・操作の risk・設定の risk を `HUMAN_ONLY` と突き合わせる。5 つに当たらないものを human-only にしても、5 つに当たるものを human-only から外しても落ちる。5 つを増やすときは ADR で決める。

## 理由

- 5 つは、AI が自分で変えられると関所や契約の意味が無くなるものに限る。承認モードと承認カードへの応答は承認フローそのもの（design.md §8.5）。秘密の値・アカウントは、入力した人と契約・課金の主体を AI が替えることになる。接続先の既定は、新しい会話の送り先を人が確かめていない先へ替える。リモートのペアリングは、外の端末にこの PC を開く。
- 残りは、関所を緩めないなら write、緩める・取り返しがつかないなら guarded で、会話の承認モードに従って AI も使える（ADR 0082 の表）。人にだけできることを残すと、AI はその作業を人に頼むしかなく、思想 §2.2 に反する。
- 範囲を一覧で持って検査すると、決めていないものを human-only に置く逃げ道が無くなる。

## 影響

- ADR 0082 の human-only の行は、この ADR の 5 つを指す。
- `tests/ops-baseline.json` の human-only は 38 件から 25 件、todo は 61 件から 59 件に減る。human-only の設定は `mode`・`claudeAccount` の 2 件。
- AI の `ply_control` の直接のツールは増やさない（操作は `list_ops`・`call_op` と CLI に出る）。
