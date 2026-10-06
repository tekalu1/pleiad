# 0082 操作の権限は「主体 × 危険度 × 会話の承認モード」で決め、関所を緩める変更は人間か承認を通す

- 状態: 承認（2026-10-03）
- 追記: 主体 agent に、会話に束縛されない `via: remote`（端末の AI。依頼元は端末の会話）を足す。口に出す操作は委譲の 6 つだけで、人の答えは `via: remote-device`・受領証つき（[ADR 0146](0146-remote-agent-delegation.md)）
- 追記: 端末の画面（人）が、ホストに任せた子の会話の経過を読む（`/agent` の `view`）。主体は答えと同じ `by: human`・`via: remote-device`・`byDevice`。端末側は画面だけの操作 `delegation.hostView`（MCP・CLI には出さない）からだけ作り、端末の AI の道具には無い（[ADR 0146](0146-remote-agent-delegation.md)「経過の読み出し」）

## 状況

[ADR 0081](0081-control-surface-registry.md) で、AI が Pleiad の設定を変えられるようになる。いま決まっていることは次のとおり。

- 設定の中には、AI 自身の関所を緩めるものがある。承認モード・computer use の許可・サイトの確認・Hooks・MCP の登録・Pleiad の指示。
- design.md §8.5 は承認モードを「人間だけが変える。AI 用のツールは生やさない」と決めている。理由は「AI が自分の承認モードを緩められるなら、承認フローそのものが意味を失う」。
- 一方、思想 §2.2（[ADR 0007](0007-symmetric-ai-and-human.md)）は、AI と人間を非対称にしない・制約は能力でなく、やり方にかけると決めている。
- history の `by` は可読性のためで、「この値で権限を分岐させない」（design.md §5）。
- 承認なしのモード（Claude の bypass・Codex の yolo など。`core/modes.mjs` で範囲が full・自律が never のもの）の会話は、エージェント自身のファイル操作で Pleiad のデータ置き場を直接書き換えられる。このモードの会話に設定の変更だけ承認カードを出しても、防壁にならない。

## 決定

- **権限は、呼び出しの主体・操作の危険度・（会話に束縛されていれば）その会話の承認モードで、`registry.invoke` の 1 か所で決める。** 判定は `core/ops/policy.mjs` の純関数。記録の `by` は権限に使わない。
- 主体は 2 つ。
  - `human`: 画面（PC・リモートの端末・モバイル）。WS の画面のトークン。
  - `agent`: Pleiad の中の AI の MCP（`ply_control`）・CLI・`pleiad mcp` をまとめたもの。どこから来たかは `via: mcp | cli | mcp-stdio`、会話に束縛されていれば `sessionId`。
    - 会話ごとの接続情報（HTTP の MCP の Bearer・環境変数）で束縛されたものは、その会話の承認モードに従う。
    - 外のターミナルの CLI・外の AI の `pleiad mcp` は会話に束縛されない。
- 記録には `by: 'agent'`・`via`・`sessionId` を残す。人間は `by: 'human'`。昔のホストのツール（Claude の `host`）が残した `by: 'ai'` は、画面では `agent` と同じ AI の印で扱う。
- 危険度は 4 段。

  | 危険度 | human | agent |
  |---|---|---|
  | read（検索・一覧・設定の現在値。秘密は伏せる） | 通す | 通す |
  | write（タイトル・状態・分岐・圧縮の閾値・表示の言語・人間が作った選択肢から選ぶ） | 通す | 通す。会話の範囲（scope）が none / readonly なら断る（`READ_ONLY_MODE`） |
  | guarded（MCP の登録・Hooks の追加と有効化・computer use とサイトの確認を緩める向き・Pleiad の指示・委譲先の振り分け） | 通す | 下の表 |
  | human-only（5 つだけ: 承認モード・秘密の値・アカウント・接続先の既定・リモートのペアリング。[ADR 0094](0094-human-only-five.md)） | 通す | 出さない（呼ばれたら `NOT_FOUND` と同じに見せる） |

- **agent の guarded は、束縛された会話の承認モードで決める。**

  | 呼び出し | 判定 |
  |---|---|
  | 会話の範囲が none / readonly | 断る（`READ_ONLY_MODE`） |
  | 範囲が full かつ自律が never（Claude の bypass・Codex の yolo など） | 通す。記録（`by: 'agent'`・`via`・`sessionId`）は残す |
  | それ以外（ask・judge、または sandbox で workspace に閉じた never＝Codex の full） | 会話の承認カード（`ask`） |
  | 会話に束縛されていない | 実行せず、画面へ誘導する（`NEEDS_UI`） |

  - 承認カードは既存の `askPermission` に `settingChange { op, before, after, reason }` を足して出す（段階 2）。カードの形は [ADR 0073](0073-computer-use-ui.md) に合わせ、「常に許可」は出さない。承認した内容のハッシュ（受領証）を、書く直前に今の値と照合し、合わなければ聞き直す（[ADR 0049](0049-hooks-pleiad-managed.md) の確認票と同じ考え）。host が居なければ拒否せず待つ（design.md §8.5）。
  - 判定の入力になる承認モードが引けない会話は、弱い側（workspace・ask）に倒す。
- **同じ設定でも、関所を緩める向きだけ guarded にする**（オンにする・許可を足す）。狭める向きは write にする（[ADR 0031](0031-confirm-before-unifying-mcp.md) の「広げる向きだけ確認」）。操作ごとの `riskOf` は定義の危険度を下げられない。
- **他の会話への書き込み**（題・状態など write）は通し、どの会話の AI が変えたかを `sessionId` で記録する。人間は別の会話の題も変えられるので、非対称にしない。
- human-only は、承認モードに関わらず agent に出さない。承認モードそのものは今までどおり人間だけが変える。
- **human-only は 5 つに限る**（2026-10-03、[ADR 0094](0094-human-only-five.md)）。承認モード・秘密の値・アカウント・接続先の既定・リモートのペアリングで、当たる操作と設定は `core/ops/policy.mjs` の `HUMAN_ONLY`。Pleiad の機能はほかは全部 agent も使える（read・write・guarded のどれか）。
- 書く操作の既定は guarded に倒す。write にするときは理由（`riskReason`）を書き、危険度の表は snapshot に載せる。

## 理由

- 思想 §2.2 の括弧書きのとおり、権限の層は対称の思想と直交する。
  - **能力は対称にする**: AI も設定を読めるし、多くを変えられる。
  - **関所を緩める変更は、その会話が持つ強さを超えさせない**: 承認が要る会話では承認カード、確認なし・制限なしを自分で選んだ会話では、すでに持っている強さの範囲として通す。§8.5 の「承認モードは人間だけ」は、同じ理由を持つ human-only として残す。
- 確認なしのモードの会話にまで承認を求めると、承認を飛ばす選択をした人に毎回聞くことになり、それでもデータ置き場のファイルを直接書けるので守りにならない。記録を残すことで、黙って変わることは防ぐ（思想 §2.2「黙って変わると人間が追えなくなる」）。
- sandbox で workspace に閉じた never（Codex の full）はデータ置き場を書けない。この会話が設定を通すと、sandbox の外へ権限を広げることになる。だから承認を挟む。
- 会話に束縛されない呼び出しは、会話の承認カードを出す先が無く、どの会話の強さで通すかも決められない。画面へ誘導するのが安全で、迂回の抜け道にもならない（CLI を呼べるエージェントは、環境変数の接続情報で自分の会話に束縛されて呼ぶ）。
- 承認カードと受領証は既存の仕組み（`askPermission`・Hooks の確認票・互換の接続先の受領証）の組み合わせで済み、新しい UI の型を作らない。

## 影響

- 新しい操作と設定は危険度を必ず持つ。危険度の表と全操作の判定は `npm test` の snapshot に載る。危険度を下げる変更は差分に出る。
- 主体 × 危険度 × 会話の承認モードの全組み合わせを、`tests/unit/ops-policy.mjs` が表で固定する。
- design.md §5・§8.5 から、この ADR を指す。
- 承認なしのモードの会話からの guarded は黙って通る。履歴の `by: 'agent'` と `via`・`sessionId` で追える。
- 会話に束縛されない CLI から guarded の設定は変えられない。人が CLI から変えたい場合の会話を持たない承認（画面の全体のカード）は、必要になったら別に決める。
- 段階 0 は `ask` を `NEEDS_APPROVAL`（判定は ask）として返すところまで。承認カードは段階 2。
- human-only の範囲（5 つと、当たる操作）は [ADR 0094](0094-human-only-five.md) に定める。
- 段階 3 の host・委譲・ブラウザー各操作への危険度の割り当てと、既存ツールの可用性を保つ `modeGate: false` は [ADR 0091](0091-control-surface-host-delegation-browser.md) に定める。
