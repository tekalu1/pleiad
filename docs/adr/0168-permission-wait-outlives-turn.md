# 0168 ターンが終わっても残る承認の待ち（`outlivesTurn`）と、カードの中身の差し替え（`permissionUpdate`）

- 状態: 承認（2026-10-08）

## 状況

[ADR 0148](0148-agent-browser-in-chrome.md) と [ADR 0153](0153-chrome-connection-waits-indefinitely-behind-os-layer.md) で、エージェントのブラウザーには人を待つ場面が 2 つある。Chrome の許可の確認を待つ（接続の案内、0153 の A〜D）と、ログインなどを人に頼んで Chrome で操作してもらう（`hand_to_user`）。どちらも待ちは無期限で、エージェントがターンを終えた後も続き、人が済ませたら「続けてください」の 1 文で会話を起こす（0153 の決定 1）。待っている間、カードの中身は変わる（A → B → C、「依頼」→「あなたが操作中」→ 済み）。

今の承認の待ち（`askPermission`、`core/server.mjs` L4422-4541）は 2 種類しか無い。待ちは `runtime.waiting` に `{ settle, payload, askedAt, relay, notified, detached }` で入る（L4489）。

| 欲しいこと | 普通の待ち（`detached: false`） | `detached: true`（設定の変更の承認、[ADR 0088](0088-setting-change-approval.md)） |
|---|---|---|
| ターンの終わりで取り下げない | ✗ `settleAll('turnEnded')`（L6329）で取り下げる | ✓ |
| 人の「止める」で「中断しました」 | ✓ `abortSessions` の `settleAll('aborted')`（L6654）＋ signal | ✗ `settleAll` が飛ばす |
| 委譲の `waiting`・待機時計を止める（0148 の委譲の決まり） | ✓ `blockingWaits()`（L4345）に入り、`agentTasks` の `waiting`（L4953）が効く | ✗ 入らない |
| 中断で「止めたもの」に残す | ✓ `captureStops`（L6611-6616） | ✗ |
| 端末（スマホ）から答えられる | ✓ | ✗ `hostOnly`（L4491）で「ホストの画面で答えてください」だけ |

どちらでも足りない。また、出したカードの中身を同じ id のまま替える口が無い。前例は端末の中継の状態の差し替え（`permissionRelayState`、L4932-4937。画面は `registerRelayCard` の `setOnline`、`web/client.mjs` L2366）だけで、承認の payload そのものは替えられない。

第 7 段の計画（§2.1）は `blockingWaits`・`count`・`captureStops`・`openWaitIds`・`blockers` を挙げていたが、`blockingWaits` や `!w.detached` で待ちを数える所はほかにもある（決定 2 の表）。

## 決定

### 1. 第 3 の種類 `outlivesTurn`

`askPermission` に `outlivesTurn: true` を足す。`detached` は設定の変更の承認のまま残す（2 つを同時には付けない）。

- **ターンが走っている間は、普通の待ちと同じ**（ターンを止めている。委譲の `waiting`・待機時計・無停止の更新の `blockers`・「止める」の中断・「止めたもの」に効く）。
- **ターンが終わっても取り下げない**。終わった後は何も止めない（委譲の `waiting` にならない、無停止の更新を待たせない、画面の「実行中」の数に入らない）。カードは出たまま、人が答えるのを待つ。
- 「ターンが走っている」は、**承認を求めた会話**（祖先へ中継した複製でも、元の子の会話）のターンで見る。待ちの記録に `origin: sessionId` を足す（複製の `payload.sessionId` は祖先の会話なので使えない）。

### 2. 判定を 1 つにまとめる

待ちが今ターンを止めているかを 1 つの関数にする。

```js
const liveTurn = sessionId => Boolean(sessionId) && runtime.turns.has(sessionId);
const blocksTurn = w => w.outlivesTurn ? liveTurn(w.origin) : !w.detached;
const blockingWaits = () => [...runtime.waiting.values()].filter(blocksTurn);
```

`!w.detached` で数えている所を、全部 `blocksTurn` に寄せる。

| 所（`core/server.mjs`） | 今 | 変えた後 |
|---|---|---|
| `blockingWaits`（L4345） | `!w.detached` | `blocksTurn` |
| 実行中の一覧の `permissions`（L4195）と `count`・`heldCount`（L4246・L4249） | `!p.relay && !p.detached` | 一覧に `blocking: blocksTurn(w)` を載せ、`!p.relay && p.blocking` で数える。`outlivesTurn: true` も載せる（画面の見分け） |
| `captureStops`（L6611-6616） | `!w.detached` | `blocksTurn` |
| `openWaitIds`（L5769-5770。引き継ぐターンの札の waits） | `!w.relay && !w.detached && !w.remote` | `!w.relay && blocksTurn(w) && !w.remote` |
| 引き継ぎの `blockers`（L5899-5909。承認の行 L5906） | `!w.relay && !w.detached` | `!w.relay && blocksTurn(w)` |
| 人の画面が居なくなった後の `giveUp`（L2022） | `if (!w.detached) w.settle(hostAway)` | `if (blocksTurn(w))`（ターンの終わった後のカードは、人が戻るまで残す） |
| `detach(ws)` の猶予の始め（L4330） | `blockingWaits().length === 0` | そのまま（`blockingWaits` が変わる） |
| 端末に任されたタスクの `remoteWaiting`（L813） | `blockingWaits()` | そのまま |
| 委譲の `waiting`（L4953） | `blockingWaits()` | そのまま |
| 自動の圧縮の予約と実行の確かめ（L6352・L6415） | `blockingWaits()` | そのまま（ターンの終わった後のカードは圧縮を止めない） |
| `update-lock` の断る理由（L7852） | `blockingWaits()` | そのまま |

### 3. 片付ける時

- `settleAll(messageKey, sessionId)`（L4351-）: `outlivesTurn` の待ちは、`messageKey === 'turnEnded'` のときだけ飛ばす。`aborted`（人の「止める」L6654・巻き戻しの `stopTurnForRewind` L2818）では片付ける。
- **ターンが走っていないとき**の「止める」は `abortSessions` を通らない（L6654 は走っているターンにだけ効く）。ターンの終わった後のカードには「止める」が無いので、カードの「断る」で終える。
- **巻き戻しと会話の削除**では、ターンが走っていなくても、その会話（と中継の複製の元の会話がその会話）の `outlivesTurn` の待ちを `aborted` で片付ける。今の会話の削除（L3125-3150 付近）は待ちを片付けていないので、`outlivesTurn` のために足す（普通の待ちはターンの止まりで片付いている）。
- サーバーが入れ替わる（無停止の更新・異常終了）と、ターンの終わった後の `outlivesTurn` の待ちは**残らない**（`runtime.waiting` はメモリにだけある。カードは画面から消える）。ターンが走っている間は、ターンと一緒に引き継ぎを待たせる（`blockers`）か、保持役に載ったターンの札（`openWaitIds`）で引き継がれる（今の普通の待ちと同じ）。

### 4. 端末への中継

`outlivesTurn` の待ちは `hostOnly` にしない（L4491 の `hostOnly = Boolean(settingChange) || detached` のまま）。端末から答えられる（第 7 段の §8）。

### 5. 中身の差し替え `permissionUpdate`

`askPermission` に `onOpen(handle)` を足す。`runtime.waiting.set`（L4489）の直後、最初の送信より前に同期で呼ぶ。

```js
handle = {
  id,                 // 元のカードの id（cards[0].id）
  ids,                // 元と祖先の複製の id
  update(patch),      // 決着していなければ、全部のカードの payload に patch を重ね、カードごとに permissionUpdate を出す
  settle(answer),     // 外から決着させる（resolvePermission を通さない。操作待ちの「戻した」「つながった」）
}
```

- `update(patch)`: 差し替えられるのは、種類ごとに決めた 1 つの鍵の中身だけ（第 7 段では `browserHandoff`）。`w.payload.browserHandoff = { ...旧, ...patch }` を書き、`emitGlobal({ type: 'permissionUpdate', id, sessionId, browserHandoff })`。`attach()`（L4306-4323。送り直しは L4318-4321）は新しい payload を送るので、つなぎ直した画面も最新になる。
- `permissionUpdate` は `core/protocol.mjs` のイベントの並び（`permissionSettled` の隣、L297）と、`core/server.mjs` の `LIST_NEUTRAL_EVENTS`（L2031）に足す。
- 画面: `openCards`（`web/card-roll.mjs`）の項目に `update(ev)` を足す。置き方は `registerRelayCard`（`web/client.mjs` L2355。`setOnline` は L2366、L2398）と同じ。受け口は `onRelayCardEvent`（L2403、扱いは L3180-3181）の隣。`state.pendingPerms` の写しも書き替える。

## 理由

- **`detached` を広げない**: `detached` は「ターンを止めない」承認で、止める・委譲の待ち・中断の記録のどれにも効かない。操作待ちはターンの間は普通にターンを止めるので、意味が違う。`detached` に条件を足すと、設定の変更の承認（0088）の振る舞いまで変わりうる。
- **判定を 1 つの関数にする**: `!w.detached` で数える所が 10 か所以上あり、計画で挙げた 5 か所のほかに、`giveUp` の `hostAway`・巻き戻し・端末の `remoteWaiting`・圧縮・`update-lock` の理由があった。1 か所ずつ条件を足すと漏れる（漏れると、ターンの終わった後のカードが委譲の子を「待っている」に固定する・人が戻らない間に `hostAway` で黙って断られる）。
- **承認を求めた会話のターンで見る**: 委譲の子の依頼は、親の会話に複製が出る（0148）。複製の会話（親）のターンで見ると、親のターンが終わった時に子のターンが走っていても止めないことになる。
- **ターンの終わった後の待ちを引き継がない**: 引き継ぐには待ちを保持役の札かサーバーの外に残す仕組みが要る。`blockers` に入れると、答えの来ないカードが無停止の更新を何時間でも止める。カードが消えても、操作待ちはエージェントが呼び直せば出し直せる（第 7 段の handoff は台帳の無い依頼を新しく出す）。
- **カードの id を替えない**: 「ターンの間は普通の待ち、終わったら別の台帳でカードを出し直す」案は、id が替わり、画面のカードとスマホの通知（`pushNotifier.approval`）が二重になる。同じ id で中身を差し替えるほうが、通知・通知の一覧（0149）・中継の複製をそのまま使える。

## 影響

- `core/server.mjs`: `askPermission`（`outlivesTurn`・`onOpen`・`origin`）、`blocksTurn` と上の表の所、`settleAll`、巻き戻しと会話の削除の片付け。約 70 行。
- `core/protocol.mjs`: `permissionUpdate`。`web/card-roll.mjs`・`web/client.mjs`: `update` の受け口。約 30 行。
- 使い手は第 7 段の `core/chrome/handoff.mjs`（接続の案内と `hand_to_user`）だけ。ほかの承認は変わらない。
- 試験: `tests/unit/server-permission-update.mjs`（新）で、`outlivesTurn` がターンの間だけ `blockingWaits`・委譲の `waiting`・`blockers`・`count` に入る、ターンが終わっても残る、`giveUp` で断られない、`aborted` と巻き戻しと会話の削除で片付く、`update` が祖先の複製にも届く、つなぎ直した画面に新しい中身が届く、`permissionSettled` で畳む、を確かめる。
- [ADR 0088](0088-setting-change-approval.md) の `detached` は変えない。
- [ADR 0148](0148-agent-browser-in-chrome.md): 進め方の節への追記で、上位の計画の「`detached` の待ち」を `outlivesTurn` にしたことを書く（第 7 段の計画 §10.3）。
