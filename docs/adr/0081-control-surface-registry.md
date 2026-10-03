# 0081 操作の一覧を core の正本にし、画面・MCP・CLI をそこから作る

- 状態: 承認（2026-10-03）

## 状況

AI が Pleiad の機能と設定（セッションの検索・一覧・名前・設定の読み書き など）を MCP から使えるようにしたい。
さらに、機能や設定を足したときに MCP や CLI へ自動で出るようにしたい。

今の状態:

- 画面と core の口は WebSocket のコマンド 150 個。一覧は `core/protocol.mjs` の `COMMANDS` で、処理は `core/server.mjs` の 1 つの `switch`。
  入力の検査は case ごとの手書き。一覧と case を手で揃えている。
- AI 向けの口は口ごとに別に書いている。
  - `host` の set_status・set_title・fork は Claude のバックエンドの中に、人間のコマンドと同じ処理をもう一度書いている。そのため Codex と agy には渡っていない。
  - HTTP の MCP（ply_agents・ply_browser など）は同じ骨格のコピーが 4 本ある。
- 設定は `prefs.json` の `setPref` の if の連なりと、モジュールごとのファイルに散っている。検査の流儀も配信の有無もまちまち。

この形のまま MCP のツールを足すと、思想 §2.2「機能を二重に設計しない」に反する二重の実装が増える。足し忘れも防げない。

## 決定

- **`core/ops/` に操作の一覧（レジストリ）を置き、これを外へ出す操作の正本にする。** 1 件の定義は次のものを持つ。
  - `id`（`<領域>.<動詞>`）
  - 説明の辞書キー（`agent:` 名前空間）
  - 入力の zod スキーマ（JSON Schema は `z.toJSONSchema` で作る）
  - 出力の形
  - 危険度（[ADR 0082](0082-control-surface-principals-and-risk.md)）。write には、なぜ guarded でないかの理由（`riskReason`）を書かせる
  - `scope`（会話か全体か）
  - `hostScreenOnly`
  - 出す口（`ui` / `mcp: direct｜catalog｜false` / `cli`）
  - handler
- **設定は設定の一覧（`defineSetting`）に書き、`settings.list / get / set / schema` の 4 操作をそこから作る。** 設定を持つモジュールが自分の定義を出す。設定を 1 つ足しても、MCP のツールと CLI のサブコマンドは増えない。
- **口はすべて `registry.invoke(主体, id, args)` を通る。** 入力の検査・権限・承認・記録（`store.recordChange`）・伏せ字はここで 1 回だけ行う。handler は人間の操作と同じ store・同じイベントを使う（[ADR 0007](0007-symmetric-ai-and-human.md)）。
  - 失敗は `code`（`NOT_FOUND`・`INVALID`・`HOST_SCREEN_ONLY`・`READ_ONLY_MODE`・`NEEDS_UI`・`NEEDS_APPROVAL` など）で見分ける。文は呼び出し元の言語。
- 画面は新しい WS コマンド `invoke { op, args }` で呼ぶ。互換のある追加なので `PROTOCOL_VERSION` は据え置く。昔のコマンドは消さず、移したものから `registry.invoke` を呼ぶ形にする。
- **AI には、新しい会話ごとの HTTP の MCP `ply_control` で渡す。** 既定で全会話、3 つのエージェントに渡す。
  - 直に出すツールは少数（検索・会話のメタ・設定の get / set・`list_ops`・`call_op`）。
  - 残りは `list_ops`（説明と入力のスキーマ）と `call_op` で呼ぶ。
  - ply_context と ply_computer は役割が違うので混ぜない。ply_agents と ply_browser はツール名と返り値の形を保ったまま、後でレジストリへ移す。
- HTTP の MCP の骨格は `core/mcp-bridge.mjs` にくくり出し、`ply_control` から使う。
- **載せ忘れは `npm test` で落とす。**
  - (1) `COMMANDS` の各名前は、どれかの操作の `legacyCommand` か、理由の種類付きの除外表（`tests/ops-baseline.json`）に載っていなければならない。除外表の「未移行（todo）」は増やせない。
  - (2) `prefs.json` に書くキーは設定の一覧に載っていなければならない。
  - (3) 口ごとの一覧（危険度・出す口・入力のスキーマ・権限の表。段階 1 以降は MCP の tools/list・CLI の形）を snapshot に取る。
  - (4) `ply_control` の文の量に上限を置く。
  - (5) 主体ごとの見え方が [ADR 0082](0082-control-surface-principals-and-risk.md) の表どおりかを検査する。
  - (6) 秘密に目印を入れた置き場で、全 read 操作の返りに目印が出ないことを確かめる。
  - (7) 説明のキーが全言語にあることを確かめる。
- 名前は `ply_control`（MCP）・`pleiad`（CLI）・`/api/ops`（HTTP）・`control.json`（データ置き場）で確定。アーカイブはこの一覧の範囲に入れない。

## 理由

- **一覧から生成すれば、口が増えても定義は 1 つで済む。** 人間と AI の非対称（Codex と agy に host の口が無い）も、同じ定義から渡すことで消える。
- **正本を `COMMANDS` に格上げしない理由**: 150 個の多くは画面の内部（断片の送信・screencast・既読）で、外に出す意味が無い。それらにスキーマと危険度を書かせるより、出すものだけを定義し、出さないものには除外の理由を書かせる方が、質と漏れの両方を保てる。
- **ツールを操作ごとに 1 本にしない理由**: 操作が増えるほど全会話の文脈を食う。Codex と agy にはツールの遅延読み込みを前提にできない。少数を直に出し、残りをカタログで呼べば、量は一定のまま新しい操作も自動で使える。
- **zod にする理由**: 直接の依存にあり、context-settings・ply-instructions・host のツールで使っている。JSON Schema を生成できる。新しい依存は要らない。

採らなかった案:

- MCP のツールを手で足し続ける案（要望の「自動で反映」を満たさない）。
- 機能群ごとに action の enum で束ねる案（スキーマが太り、引数を間違えやすい）。
- list・describe・invoke の 3 本だけにする案（よく使う検索まで手数が増える）。

## 影響

- 新しい機能の外への口は、WS の case ではなくレジストリに書く。WS の case だけ足すと、テスト (1) が落ちる。
- `core/ply-mcp.mjs` の `RESERVED` に `ply_control` を足す（`ply_browser` は先に足した）。
- 「指示の量」の内訳（`PLY_PARTS`）に `control` を足す。
- `setPref` は段階的に設定の一覧からの生成へ置き換える。
- 配信の無かった設定（context・hooks・Pleiad の MCP）は `settingsChanged` で配る。
- 移行の段階: 0 で枠とテスト（`app.status` だけ）、1 で読むこと中心と検索、2 で設定を書くことと承認、3 で host・ply_browser・ply_agents の移行。
- 段階 3 の既存ツールの互換と操作の危険度は [ADR 0091](0091-control-surface-host-delegation-browser.md) に定める。
- セッションの検索は `sessions.search` 1 つとして定義し、索引は `core/session-search.mjs` が持つ。画面・MCP・CLI は同じ操作を呼ぶ。
