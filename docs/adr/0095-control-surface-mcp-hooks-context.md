# 0095 MCP・Hooks・コンテキスト・リモートの操作を一覧に通し、任意のコマンドを動かせる書き込みは承認カードで聞く

- 状態: 提案

## 状況

[ADR 0081](0081-control-surface-registry.md)〜[0083](0083-control-surface-cli.md)・[0088](0088-setting-change-approval.md)・[0091](0091-control-surface-host-delegation-browser.md) で、会話・設定・委譲・ブラウザーの操作は操作の一覧（`core/ops/`）を通るようになった。MCP の登録・Hooks・コンテキストの設定・Pleiad の指示・リモートの状態・互換の接続先は WS のコマンドのまま（`tests/ops-baseline.json` の `todo`）で、AI（`ply_control`）・CLI・HTTP からは使えなかった。

ユーザーの決定（2026-10-03）: Pleiad の全機能を AI も使えるようにする。例外は承認モード・秘密の値・アカウント・接続先の既定・リモートのペアリングだけ。

これらの機能には、次の性質がある。

- MCP の登録と Hooks は、保存すると会話の始まり・エージェントの操作のたびに任意のコマンドが動く。
- コンテキストの設定と Pleiad の指示は、全部の会話のエージェントに渡る文脈を変える。同じ値を `settings.set` の `context.default`・`plyInstructions` が guarded で持っている（ADR 0088）。
- 返す値の中に秘密がある。env・ヘッダーの値・bearer・OAuth のクライアントシークレット・URL のクエリ、コマンドの引数（`--token 値`）、OAuth のログインの途中の承認の URL（state・PKCE）、ペアリングの確認の番号。

## 決定

- **WS のコマンド 31 個を操作にし、WS のコマンドはその操作を呼ぶ薄い外側にする。** 外側は操作を人間（`{ by: 'human', via: 'ui' }`）として呼び、引数のうち操作の入力に無い欄は今までどおり無視する（昔の呼び出しは前の返りを重ねて渡すことがある）。返りと失敗の文は今までと同じ（モジュールの失敗は人にはそのまま投げ、WS の外側が今までの文と `code` で返す。agent には `code` 付きの失敗にする）。本体の処理はサーバーが `ctx.mcp`・`ctx.hooks`・`ctx.context`・`ctx.remote`・`ctx.endpoints` で渡す。

| 操作 | WS | 危険度 | 理由・追加の判定 |
|---|---|---|---|
| `mcp.nativeList`・`mcp.nativeRead` | `listMcpConfig`・`readMcpServer` | read | 各エージェントの設定ファイルの登録。 |
| `mcp.nativeSave` | `saveMcpServer` | guarded | 任意のコマンドを動かせる。 |
| `mcp.list`・`mcp.read`・`mcp.authStatus` | `listPlyMcp`・`readPlyMcp`・`mcpAuthStatus` | read | Pleiad の登録と OAuth の状態。トークンは返さない。 |
| `mcp.save`・`mcp.import`・`mcp.rename`・`mcp.setSettings` | `savePlyMcp`・`importPlyMcp`・`renamePlyMcp`・`setPlyMcpSettings` | guarded | 任意のコマンド・接続先・OAuth の設定を変える。 |
| `mcp.delete` | `deletePlyMcp` | guarded | 消すもの。 |
| `mcp.reconnect` | `mcpReconnect` | write | 保存済みの登録で 1 回つなぐだけ（毎ターンの始まりと同じ）。 |
| `hooks.scan`・`hooks.session`・`hooks.list` | `scanHooks`・`sessionHooks`・`plyHooks` | read | コマンドは形で伏せる。 |
| `hooks.saveNative`・`hooks.copy` | `saveHooks`・`copyHooks` | write（`riskOf`） | 書く前の確認（`dryRun: true`）は書かないので write、書くときは guarded。 |
| `hooks.save`・`hooks.setOwner`・`hooks.repair` | `savePlyHook`・`setHooksOwner`・`repairPlyHooks` | guarded | 任意のコマンドを動かせる・担当を変える。 |
| `hooks.remove` | `removePlyHook` | guarded | 消すもの。 |
| `hooks.toggle` | `togglePlyHook` | write（`riskOf`） | 無効にする向きは関所を狭めるので write、有効にする向きは guarded。 |
| `context.settings`・`context.plyInstructions` | `contextSettings`・`plyInstructions` | read | |
| `context.setSettings`・`context.setPlyInstructions` | `setContextSettings`・`setPlyInstructions` | guarded | 全部の会話に渡る文脈を変える（下の「依頼からの変更」）。 |
| `context.refresh` | `refreshContext` | write | 1 つの会話の固定した文脈を、同じ場所から読み直すだけ。 |
| `context.setSessionMcp` | `setSessionMcp` | write（`riskOf`） | 外す向きは write、戻す向き（`removed: false`）は guarded（次のターンでつなぎ直す）。 |
| `remote.status` | `remoteStatus` | read | |
| `remote.setResident` | `setRemoteResident` | write | 窓を閉じても続けるか・スリープを止めるかだけ。ペアリング・中継は触らない。 |
| `endpoints.list` | `compatEndpoints` | read | API キーは返さない（`hasKey` だけ）。 |

- **依頼からの変更（危険度）。** 依頼の目安ではコンテキストの設定と Pleiad の指示は write だったが、guarded にする。同じ値を変える `settings.set` の `context.default`・`plyInstructions` が guarded で、こちらだけ write にすると、承認が要る会話でも承認なしで同じ変更ができる抜け道になる。指示は AI の振る舞いを変え、担当を Pleiad にすると Pleiad の MCP の登録（コマンド）がつながる。逆に、関所を狭める向き（Hook を無効にする・会話の MCP を外す）と書く前の確認は write にし（`riskOf` で緩める向きだけ guarded）、人を止めない（ADR 0088 の「緩める向きだけ聞く」と同じ）。
- **guarded の承認は ADR 0088 の承認カードと同じ仕組みに乗せる。** 汎用の操作も `registry.invoke` の承認（`confirm` → 受領証 → `deps.approve` → 待たずに `PENDING_APPROVAL` → 人が許可したら受領証を作り直して実行 → 結果を会話へ届ける）をそのまま使う。各操作の `confirm` は `{ key: null, before, rows, note, loosens }` を返す。
  - `before`（受領証の元）は登録・ファイルの版（`revision`）か今の値。承認と実行の間に別の口が変えたら、同じ `requestId` で聞き直す。
  - `rows` は変わる項目の前後（`mcp.<名前>.<欄>`・`hooks.<名前>`・`context.default.<種類>` など。値は agent に見せる形で伏せる）。`note` は何が起きるかの 1 文（server 辞書の `opsApproval.*`。画面の言語）。`loosens` はコマンドを動かせるようになる・文脈を変える変更で立てる（消す・名前を変えるは立てない）。
  - `key` は持たない。同じ会話の同じ操作の承認待ちは、新しい要求で置き換える（ADR 0088 の「設定でない操作は同じ操作」）。結果の文の対象は「操作「mcp.save」」。
  - カードの節は「設定 › プラグイン」（`web/setting-change.mjs` の `SECTION_OF_ROOT` に `mcp`・`hooks`・`context`・`plyInstructions`）。
  - 結果の届け先は設定の承認と同じ（承認を求めた会話）。委譲の子のタスクが終わっていたら依頼元の会話へ届ける共通の関数（ブランチ `fix/approval-to-requester`）は、この変更を入れる時点で main に無い。その関数は `registry.invoke` と承認の置き場（`core/setting-approvals.mjs`）の共通の道に入るので、入れば汎用の操作の承認にもそのまま効く。
- **秘密は返さない。** 3 段にする。
  1. モジュールが画面へ返す形はもう伏せてある（`core/mcp-config.mjs`・`core/ply-mcp.mjs`・`core/hooks-config.mjs` の `maskText`・`core/ply-hooks.mjs` の `publicHook`・接続先の `hasKey`）。それを使い回す。
  2. 操作の層（`core/ops/redact.mjs`）が、どの主体にも同じ伏せ字をもう一度掛ける（env・ヘッダーの値・bearer・clientSecret・URL の userinfo とクエリ。伏せ字は冪等）。agent にはさらに、コマンドの引数の秘密（`--token 値`・`--api-key=…`・形で分かるトークン）、OAuth のログインの途中の承認の URL のクエリ、ペアリングの確認の番号、中継・接続先の URL のクエリ、会話の記録に残った Hook のコマンドを伏せる。人（画面）には引数・承認の URL・ペアリングの番号を返す（編集欄・ログイン・端末との見比べに要る。画面の振る舞いは変えない）。
  3. registry の最後の網（秘密らしい名前の欄）。
  - 元の値を返す `readHook`・`readPlyHook`、ログインとログアウト（`mcpAuthStart`・`mcpAuthLogout`）は human-only のまま。
- **伏せ字の書き戻し。** agent が読んだ値（伏せ字入り）をそのまま保存したら、伏せ字の所は今の値を残す。agent に見せた形と同じ場所で同じ値なら伏せる前の値に戻し、伏せ字を含むのに合わなければ `MASKED` で断る（伏せ字そのものを値として保存しない）。並びは位置で突き合わせる。Pleiad の MCP の秘密（env・bearer・ヘッダー・clientSecret）は登録のモジュールが前の値を残すので、操作の層は引数だけ戻す。
- **会話から呼ぶときの既定。** 会話に束縛された agent が `cwd` を省けばその会話の作業場所、`sessionId` を省けばその会話（`hooks.session` は会話のエージェントも）。人の画面からの呼び出しは今までどおり省いたまま。
- **出す口。** 全部 `ui: true`・`mcp: 'catalog'`（直のツールは増やさない）・CLI。CLI の最初の語は `mcp-servers`（`pleiad mcp` は stdio の MCP の起動に使っている）・`hooks`・`context`・`remote`・`endpoints`。
- **移さなかったもの。** 承認モード・秘密の値・アカウント・接続先の保存と既定・リモートのペアリングと端末の取り消し・中継の設定・OAuth のログインとログアウト・元のコマンドを返す読み出しは human-only のまま（除外表）。範囲の分け直しは別の作業で行う。

## 理由

- 画面と AI が同じ操作を通れば、検査・保存・配信・記録が口ごとにずれない（ADR 0081）。WS のコマンドを外側に残すので、画面は変えずに移せる。
- 任意のコマンドを動かせる変更を承認なしで通すと、承認が要る会話でも AI が自分の手の届く範囲を広げられる。承認カードは ADR 0088 で確かめた仕組み（待たずに返る・期限なし・受領証・結果を会話へ届ける）を汎用の操作にもそのまま使える。
- 秘密は、モジュールが伏せる形を正本にし、操作の層で重ねて伏せる。agent は会話の記録や別のエージェント（別の提供元のモデルのこともある）へ値を渡しうるので、人に見せるより広く伏せる。書き戻しで伏せ字を値として保存しない規則は、`core/mcp-config.mjs` の `restoreMasked` と同じ考え。

## 影響

- `tests/ops-baseline.json` の `todo` は 61 → 30。操作の一覧の snapshot（`tests/ops-surface.snap.json`）に 31 の操作が載る。
- `ply_control` の指示と tools/list の量は変わらない（ja 1733・en 1632 トークン。上限 1800）。新しい操作は `list_ops`・`call_op` から呼ぶ。
- 失敗の code に `MASKED`（伏せ字の書き戻しが合わない）が増える。agent へのモジュールの失敗は、モジュールの `code`（大文字）か `FAILED`。
- 検査: `ops-mcp-hooks`（依存を差し替えて、agent への伏せ字・書き戻し・guarded と `riskOf`）、`ops-control`（使い捨ての home とデータ置き場に秘密の目印を入れ、全 read 操作の返りに出ないこと・Hook の登録の承認カードと許可・MCP の登録の拒否・bypass の記録）、`ops-surface`（T6 の依存に MCP・Hooks・コンテキスト・リモート・接続先）。
