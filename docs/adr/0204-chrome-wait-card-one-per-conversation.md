# ADR 0204: 依頼元の Chrome の操作待ちは、1 会話 1 枚のカードにして状態の変わりを同じカードで見せる

- 状態: 提案
- 日付: 2026-10-11
- 関連: [remote.md](../remote.md) §4.5、[design-system.md](../design-system.md)「依頼元の Chrome の操作待ちのカード」、[inapp-browser.md](../inapp-browser.md)「操作待ちのカードと hand_to_user」、[ADR 0146](0146-remote-agent-delegation.md)、[ADR 0168](0168-permission-wait-outlives-turn.md)

## 状況

端末の AI がホスト（別の PC）の子に Chrome を使う仕事を任せると、ホストの Chrome の準備・許可・操作の待ちが、依頼元の会話に承認のカードとして中継されていた。調べると次の問題があった（調査: `temporary/reports/chrome-connect-wait-card.md`）。

1. カードの中身が「承認を求める道具の呼び出し」の形（`ply_browser` と JSON）で、どの PC の Chrome で何をするのかが読めない。
2. 「許可」を押すと、ホストの Chrome につながっていないのに「つながりました」と決着して進んでしまう（0.13.12 で別に直した）。
3. 子が `hand_to_user` を呼び直すたびに、同じ会話にカードが重なる。
4. 状態（準備 → 許可の確認 → 断られた）が変わっても、依頼元のカードは古いまま。
5. 待ちが一覧でただの「承認待ち」になり、通知が何度も出る。

## 決定

1. **依頼元には Chrome の操作待ち専用のカード**（`web/chrome-wait-card.mjs`）を出す。見出しは「Chrome の操作待ち ⇄ ホスト名」。最初の 1 行は「<ホスト名> の Chrome で〜してください」。生の JSON・「承認」・「許可しないと止まったまま」は出さない。
2. **1 会話に 1 枚。** ホストの状態の変わり（setup → permission → denied、依頼 → 操作中）は、ホストの口の新しい便り `relayUpdate`（承認の id と `chromeWait`）で運び、依頼元は `permissionUpdate` として**同じカードの中身を差し替える**。つなぎ直しの `relays` の再送は、開いているカードを更新するだけで新しく開かない。
3. **依頼元のカードに「許可」は置かない。** 押せるのは「Chrome を使わずに続けてもらう」の 1 つで、拒否として決着し、子へは「人が Chrome を使わずに続けるよう選んだ」と返す（失敗ではない）。ホストの側のカードは「断る」「もう一度」「許可」のまま（ホストの人は自分の PC で答えられる）。依頼元から答えられるのは、厳しくする（断る）向きだけ。
4. **決着したらカードは「◇ <ホスト名> の Chrome につながりました · 時刻」の 1 行に縮む**（断った・子が待つのをやめた・取り下げも 1 行）。本文と足は外す。
5. **待ちの数え方**: 一覧と通知は「承認待ち」ではなく「Chrome の操作待ち」と言う（その会話の待ちがすべて Chrome の待ちのとき）。通知は 1 枚につき 1 回で、状態が変わっても出し直さない。受信箱の行は「…が Chrome の操作を待っています」→ 済むと「…待っていました」（「承認済み」とは付けない）。設定 › ブラウザーの Chrome の行には「待っている会話: <題>」を出す。
6. **子の待ち**: `hand_to_user` の呼び直しは今のまま（待ちの区切りごとに子が呼び直す）。戻りの文に待った分数と「Chrome を使わずに進めてよい」を入れ、子が待ち続けるか別の道に切り替えるかを自分で決められるようにする。

## 理由

- 「つながっていないのに進む」と「同じ待ちのカードが積もる」は、依頼元の人が「何をすればよいか」を読めないことが根にある。1 行目で場所とやることを言い、状態は同じカードの中で替えれば、人は 1 枚だけを見ればよい。
- 依頼元の端末からは、ホストの Chrome の許可の確認を押せない。押せないものを「許可」と呼ぶと、押した人は進んだと思う。押せるのは「待つのをやめる」だけなので、それだけを置く。
- 厳しくする向きだけを依頼元に任せるのは、ホストの PC の持ち主の許可を依頼元の端末が代わりに出さない、という既存の決まり（[ADR 0146](0146-remote-agent-delegation.md)）に沿う。
- 便りを足すだけで、古い端末は `relayUpdate` を無視して今までのカードのまま動く（互換）。

## 影響

- `core/remote/agent-port.mjs`（`relayOpen` の戻りの `update`、`relayUpdate` の送出）、`core/remote/agent-link.mjs`、`core/remote-delegation.mjs`（`relayUpdate` の受け取り・再送の更新・`relayEnd` の `abort`）、`core/server.mjs`（`chromeWait` の印・`remoteCards.update`）、`core/notification-sources.mjs`（`ask: 'chrome'`）、`core/chrome/handoff.mjs`・`core/browser-bridge.mjs`（待った分数の戻り）。
- 画面は `web/chrome-wait-card.mjs`・`web/client.mjs`（`chromeWaitCard`）・`web/side.mjs`・`web/browser-settings.mjs`・`web/notification-inbox.mjs`・`web/style.css`。
- 依頼元の見た目の承認（2026-10-11）の差分: ホストが Chrome を使えない場合（`handoff.connect` が何も返さず、カードが出ない）の「◇ <ホスト名> では Chrome を使えません」の 1 行は、今回は出さない。受信箱の行にホスト名は入れない。
- 解決していないこと: 接続した直後に Chrome 154 が落ちる件の原因は、このADRの範囲外（推測のまま残す）。
