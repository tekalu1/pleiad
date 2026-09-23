# コンテキスト管理：標準配置の探索と MCP 登録

2026-09-12。第1段階として、設定の「コンテキスト」ページから探索元を保存し、指示ファイル・Skills・MCP の候補を確認できる。
2026-09-15 にツリーとプレビューの 2 列にした画面は、2026-09-20 に承認済みモック `docs/mockups/context-unified.html` の 1 画面へ置き換えた（ツリー・「読み込み担当」「探索の設定」・保存ボタン 4 つを廃止）。範囲（すべての場所／場所ごと）を選び、種類ごと（指示ファイル・Skills・外部 MCP）に「エージェントに任せる／Pleiad がそろえる」、探す形式、渡すもの（スイッチ）を決める。変更はその場で保存し「保存しました · 次のターンから反映」を出す（2026-09-23 から、始まっている会話にも次のターンから効く。`docs/context-runtime.md`）。見た目の規則は `docs/design-system.md` §9「コンテキスト」。
探索 API は `previewOnly: true` の候補一覧。Pleiad がそろえる種類は実行時に解決して会話へ渡す。実行時の抑止・適用時期・利用記録・会話の右パネルは [共通コンテキストの実行](context-runtime.md) を参照。既定はエージェント任せのまま。

## 保存と継承（形式 2）

- `${AGENT_HOST_DATA}/context-scans.json`（既定 `~/.agent-host/`）に `version: 2` で保存する。
  ```jsonc
  { "version": 2,
    "defaults": { "roots": [ /* どの場所でも探す追加ルート（ユーザー共通の範囲） */ ],
                  "kinds": { "instruction": K, "skill": K, "mcp": K } },
    "places": { "<pathKey>": { "path": "<表示用の実体パス>", "roots": [ /* その場所から下で探す追加ルート */ ],
                               "kinds": { /* 上書きした種類だけ */ "skill": K } } } }
  // K = { owner: "native" | "ply",
  //       user:      { sources: ["common"|"claude"|"codex"], excludePaths: [...] } | null,   // home の探索。対応を終えたエージェントの探索元（RETIRED_SOURCES）は読んだところで落とす
  //       directory: { sources: [...], excludePaths: [...] } | null,                                   // Git ルート〜作業場所の探索
  //       disabled?: ["名前"],            // 外部 MCP だけ。名前で外す（同じ設定ファイルの他の登録は残す）
  //       prefer?:   { "名前": "設定ファイル" } }  // 外部 MCP だけ。同じ名前の定義が複数あるときに使う方（無ければ先に見つかった方）
  ```
- **種類ごとに継承する。** 作業場所に一番近い（深い）上書きを持つ場所の値、無ければ既定。追加ルートも同じ（`roots` を持つ一番近い場所）。場所の上書きを消す（「全体の設定に戻す」。上の場所に上書きがあれば「上のフォルダーの設定に戻す」）と上の値に戻る。画面では「全体の設定どおり／<親の場所> の設定どおり／このフォルダーだけの設定」。
- **受け継ぐ値と同じ上書きは持たない**（2026-09-23、issue #19）。`set` は保存のたびに、変えた場所の上書きのうち上の場所（または既定）から受け継ぐ値と同じものを消す（`pruneInherited`。移行の `migrateV1` と同じ規則）。この保存で作った場所に上書きが残らなければ場所も作らない（一覧に足した場所は残す）。違いの無い上書きが残ると、その場所は「個別に変更」扱いになり、あとで既定を変えてもその場所に効かない。前の版で保存された同じ上書きは、読み込んだときに消して書き戻す（`pruneAll`。上書きが無くなった場所は一覧からも外す。はじめから上書きの無い場所は残す）。
- `user` / `directory` が `null` の種類はその範囲を探さない。形式 1 の「対象（kinds）」から外していた種類を移行で表すためだけに残る（画面の札を押すと両方が同じ探す形式にそろう）。
- **旧 `kinds` は廃止。** 実行時に Pleiad が探すのは担当が Pleiad の種類だけ（`runtimeSettings`）。
- `excludePaths` はファイルまたはディレクトリのパス（glob ではない）。ディレクトリ配下にも適用し、リンクの参照元・実体の両方で照合する。画面のスイッチは、その行が見つかった範囲（home なら `user`、それ以外は `directory`）の除外を出し入れする。スイッチを入れるとき、その行を含むフォルダーごとの除外も外す。
- 相対パスは保存時に絶対パス化する。既定はホーム、場所は保存先ディレクトリが基準。継承先で意味が変わらない。
- 書き込みは読み込みと同じ列に直列化し、一時ファイルから rename。壊れた JSON はエラーにして保存を拒否し、ファイルはそのまま残す。
- これらはサーバーのファイルシステム上のパス。別端末のブラウザーで操作しても、ブラウザー側のファイルは探索しない。

### 形式 1 からの移行

形式 1（`version: 1`）は、読み込み担当（`owners` と場所ごとの `directoryOwners`）と探索設定（`user` と場所ごとの `directories`。`sources` / `kinds` / `additionalRoots` / `excludePaths`）を**別々の場所から**継承していた。読み込んだときに次の手順で形式 2 へ移す（`docs/desktop-releases.md` の「データ形式変更」）。

1. 読み込み・保存の列の中で行う（同じプロセスの書き込みと重ならない）。
2. 元のバイト列を `context-scans.v1-backup.json` に書く（既にあれば残す）。
3. メモリ上のコピーで変換する（`migrateV1`）。既定 = ユーザーの担当とユーザーの探索設定（home の範囲）＋ Pleiad の既定の探索設定（Git ルート〜作業場所の範囲）。担当か探索設定のどちらかを上書きしていた場所は、すべて「その場所で効いていた担当と探索設定」を持つ場所にする。`kinds` から外していた種類は、その範囲を `null` にする。最後に、上から受け継ぐ値と同じ上書きは消す（結果は変わらない）。
4. 検証（`sameMeaning`）: 既定と、形式 1 で上書きを持っていたすべての場所で、担当と探索の計画（`legacyEffective` と `resolveConfig`）が同じか。違えば止める。
5. 一時ファイルに書いて読み直し、もう一度検証する。読んでから置き換えるまでに元ファイルが変わっていたらやり直す。
6. rename で置き換える。どこかで失敗したら元のファイルは変えず、「元の設定は変更していません」と返す。

旧 `ply` 探索元は `common` に読み替える（従来どおり）。会話に記録された方針（`contextSession.policy`）は移行しない。形式 1 の方針（`user` / `directory`）はそのまま読める（`legacyPlan`）。`tests/unit/context-settings.mjs` が、担当と探索設定を別々の場所で上書きした形式 1 から、既定・各場所・その子の場所で担当・探索結果（候補と状態）・実行時の記録が移行前と同じになることを確かめる。

## 現在の探索範囲

ディレクトリは Git ルートから cwd まで。`.git` はディレクトリ・worktree のファイルの双方を認識。Git ルートが無ければ cwd のみ。子ディレクトリを無条件で再帰走査しない。

| 形式 | ユーザー | ディレクトリ |
|---|---|---|
| 共通配置 | `~/.agents/skills/*/SKILL.md` | `AGENTS.md`, `.agents/skills/*/SKILL.md` |
| Claude | `CLAUDE_CONFIG_DIR` または `~/.claude` の `CLAUDE.md`, `rules/**/*.md`, `skills/*/SKILL.md`。MCP は `~/.claude.json` の `mcpServers` | `CLAUDE.md`, `CLAUDE.local.md`, `.claude/CLAUDE.md`, `.claude/rules/**/*.md`, `.claude/skills/*/SKILL.md`, `.mcp.json`。cwd に一致する `~/.claude.json` の project MCP |
| Codex | `CODEX_HOME` または `~/.codex` の `AGENTS.override.md`, `AGENTS.md`, `skills/*/SKILL.md`, `config.toml`。加えて `~/.agents/skills` | `AGENTS.override.md`, `AGENTS.md`, `.codex/skills`, `.agents/skills`, `.codex/config.toml` |

これは候補の一覧であり、各エージェントの有効プロンプトの完全再現ではない。元の `enabled: false` の MCP と override に隠される AGENTS.md は状態付きで残す。

Agent Skills の仕様は `SKILL.md` の形式を定め、`.agents/skills/` は公式実装ガイドで紹介される共有用の慣習。共通のユーザー指示ファイルや MCP 登録場所は仮定しない。Claude 単体でも AGENTS.md を使う場合は CLAUDE.md の `@AGENTS.md` import を利用できる。Pleiad はそのファイルを自動生成しない。

出典：[Agent Skills 実装ガイド](https://agentskills.io/client-implementation/adding-skills-support)、[Claude memory](https://code.claude.com/docs/en/memory#agentsmd)、[Claude MCP](https://code.claude.com/docs/en/mcp)、[Codex MCP](https://learn.chatgpt.com/docs/extend/mcp?surface=cli)。

- 同じ実体ファイル・同じ適用範囲は1行にまとめ、複数の出典を保持する。
- 同じ本文でも適用範囲が異なれば残す。別定義の同名 Skill / MCP は統合せず競合候補として表示する。
- 指示本文と Skill 本文はテキストとして返す。画面は Skill の frontmatter を表に起こし、残りを markdown として描く。
- Claude の rules（`.claude/rules/` の下の `.md`。下位フォルダーも探す）は、frontmatter の `paths` が無ければ同じ場所の `CLAUDE.md` と同じ範囲の指示の行になる。`paths`（glob の配列、または `,` 区切りの文字列）があれば行の状態を `conditional` とし、`paths` と glob の起点 `pathsBase`（プロジェクトは `.claude` のある場所、ユーザーの rules は `null` = 会話の作業場所）を返す。glob は `**`・`*`・`?`・`{a,b}` を扱い、win32 では大文字小文字を区別しない。frontmatter や `paths` が解釈できなければ診断にする。rules の中の `@path` の参照先は同じ `paths` を引き継ぐ。
- Claude の独立した行の `@path` / `@"path with spaces"` は参照を追う。深さ5まで、循環は診断する。複雑な inline import の解決は未対応。
- MCP は設定を解析するだけで、接続・コマンド実行はしない。サーバー名・方式・無効状態に加え、画面の表に出す `command` / `args` / `envKeys`（環境変数はキーだけ）を返す。環境変数の値と URL は返さない。
- MCP の登録には接続先 `endpoint`（ホストとパスだけ。ユーザー名・パスワード・クエリは落とす）を返す。画面が同じ名前の定義を見比べるのに使う。
- 解析できた MCP 設定ファイルは `configs[]` に `path` / `source` / `scope` / `bytes` / `content` を返す。画面は外部 MCP の行を開いたときに、その登録の部分を伏せ字のままコードとして出す。
- **`content` は元ファイルの全文ではない。** 読み取った MCP 登録だけをサーバー側で書き出し直したもの（JSON は `{ "mcpServers": … }`、TOML は `[mcp_servers.*]` のテーブルだけ）で、`env` と `headers` の値は `••••` に置き換え、`url` はクエリ文字列（`?` 以降）を `?••••` に伏せる（鍵をクエリに置く登録があるため）。`command` / `args` と接続先そのものは残す。元ファイルの他の項目（`~/.claude.json` の OAuth アカウント情報・プロジェクト履歴、`config.toml` のエージェント設定など）はクライアントへ送らない。`bytes` は書き出した本文の長さで、元ファイルの大きさではない。任意のパスを読むコマンドは増やさず、探索で既に読んだファイルに限る。パースエラーのファイルは本文を返さない。
- `home`（ホーム）と `root`（Git ルート）も返す。
- 1ファイル256 KiB、読み取り合計4 MiB、候補1000件、操作5000回まで。上限・読み取り失敗・構文エラーを表示する。

未対応：plugin・管理者設定・自動メモリ・子階層の遅延ロード、Claude の Git ルート外の親ファイル、Codex の trust / profile / fallback / skill 無効化設定の最終解決。画面の「探索範囲と制限」にも示す。

## API と構成

- `contextSettings { cwd? }`：画面の形。`defaults` と `places[]`（保存した場所と今の場所）それぞれで、種類ごとの `{ value, override, from }`、追加ルート、「個別に変更」の数（`overrides`）、`current`（今の場所）、`saved`。
- `setContextSettings`：1 か所だけ変えて即時保存し、`contextSettings` と同じ形（と `place`）を返す。`{ place: null | パス, kind, value: K | null }`（場所で `null` は既定に戻す）、`{ place, roots: [...] | null }`、`{ place, add: true }` / `{ place, remove: true }`。
- `scanContext { cwd, place?: "default" }`：保存済み設定から候補・出典・診断・探索場所・根（`home` / `root`）・MCP 設定ファイルごとの登録の書き出し（`configs`）を返す。`place: "default"` は場所の上書きを使わず既定だけで探す（設定の「すべての場所」）。同一接続の重複スキャンは拒否する。
- `agentMcp { cwd }`：各エージェント（Claude・Codex）の設定に登録されている外部 MCP。探索の設定に関係なく読むだけ（接続・起動しない）。設定の「エージェントに任せる」と会話の右パネルが見比べに使う。
- `slashSkills { cwd }`：同じ探索結果から、入力欄の先頭 `/` に出すスキルだけを名前順に返す（`skillList()`）。各項目は `{ name, description, hint, from }`。同名は先に見つかった置き場所だけを返し、除外・shadowed は含めない。`hint` は frontmatter の `argument-hint`、または引数の定義から作る。
- `sessionContext { sessionId }`：その会話の読み込み記録・担当・固定の有無と、固定された会話だけ行う今のファイルとの突き合わせ（`changed`）を返す。詳細は `docs/context-runtime.md`。
- `listMcpConfig { cwd, format, scope }`：保存先・リビジョン・登録名のみを返す。
- `readMcpServer { cwd, format, scope, name }`：明示的に開いた1件の定義を返す。認証情報を含むことがあるため一覧・探索・ログに流用しない。
- `saveMcpServer { cwd, format, scope, name, value, revision, mode, allowReformat? }`：`mode` は add / edit。既存登録を誤って上書きしないよう区別する。
- Pleiad 自身の登録（`listPlyMcp` など）は `docs/context-runtime.md`「MCP」。

## 外部 MCP の画面（2026-09-20）

設定 › コンテキストの「外部 MCP」カードに集約した（旧「MCP 管理」の JSON 直書き画面は廃止）。
- **エージェントに任せる**: `agentMcp` で各エージェントの登録を 2 列で見比べる。片方にしか無いものに「Claude だけ」。Pleiad は読むだけで変えない。
- **Pleiad がそろえる**: この場所でつなぐものを名前ごとに 1 行。手元で動かす／URL の区別、どの設定由来か（Pleiad に登録・Claude だけに登録・両方に登録）、ログインの状態と「ログイン」、同じ名前で中身の違う定義があれば「どちらの定義を使いますか」（`prefer`）、スイッチ（オフ = `disabled`）。行を押すと中身: Pleiad の登録は編集・名前を変える・ログイン／ログアウト・接続を確認・削除、エージェントの登録は伏せ字の定義と「Pleiad に取り込む」（`importPlyMcp`。トークンは引き継がない）。「読み込む設定ファイル」（Claude・Codex）と「ログインの詳細設定」（Client ID Metadata Document の URL。既定は空）は折りたたみの奥。暗号化されない起動では平文で保存することを注記する。
- **名前を変えたとき**（`renamePlyMcp`）: 既定と各場所の設定で名前で指したものも追随させる（`contextSettings.renameMcp`）。`disabled` は新しい名前も外す（古い名前は残す。同じ名前のエージェント側の登録は前と同じく外れたまま）。`prefer` は Pleiad の登録を選んでいたものだけ新しい名前へ移す。戻り値の `settingsUpdated` は書き換えた箇所の数。始まっている会話も次のターンから今の設定（`plan.mcp`）に従う。「この会話では外す」（`removedMcp`）は会話の方針なので名前のまま変えない。
- **同じ名前の定義が複数あるとき**: 選んだ定義（`prefer`）、無ければ先に見つかった方を使い、残りは `shadowedBy: 'choice'` で渡さない（以前は実行時に「同名の MCP があります」で止めていた）。どれを使ったかは設定の行（「〜の定義を使っています」）と会話の右パネル（「渡していないもの」に理由）に出す。Pleiad の登録と同じ名前のエージェント側の登録は、従来どおり Pleiad の登録が優先。
- **＋ MCP を追加**（シート）: 名前（エージェントの登録から候補を出し、選ぶとつなぎ方を写す）、つなぎ方（URL につなぐ／手元で動かす）、コマンド・環境変数、または URL・認証（ブラウザでログイン／トークン／ヘッダー／なし。アプリ登録が要るときの clientId は折りたたみ）、使う範囲（この場所だけ／すべての場所。この場所だけは「既定では名前で外し、この場所では外さない」で表す）、保存先と暗号化の説明、「追加してログイン」（OAuth）または「追加して試しにつなぐ」。JSON で直接書きたいときは「JSON で編集（上級者向け）」を開く。

以下はエージェント側の設定ファイルを書く API（`saveMcpServer`）の仕様。画面からは使わなくなったが、API は残している。

同じMCP管理欄に、Claude・Codex共通の「Pleiadの成果物提示」を内蔵機能として表示する。既定は有効で、切り替えはPleiadの設定に保存し、すべての作業場所の次ターンから反映する。`plyMcpSettings` / `setPlyMcpSettings` で読み書きする。外部MCPの形式・保存スコープ選択とは独立している。

可視化の共通スキル本文はターン開始時に注入する。提示用の内蔵 `ply.present` MCP は廃止した。外部登録の `ply` と `host` は予約名として拒否する。Codex の再開済みスレッドの旧 `ply` 接続は無効化する。外部MCPの探索・編集仕様は以下のとおり。

保存形式（claude / codex）と保存スコープ（user / directory）は会話の実行バックエンドとは独立。directory の保存先は画面で選んだ cwd そのもの（Git ルートへの暗黙の変更なし）。Claude は `~/.claude.json` のトップレベル `mcpServers` または cwd の `.mcp.json`、Codex は `CODEX_HOME/config.toml`（既定 `~/.codex`）または cwd の `.codex/config.toml` の `mcp_servers` に保存する。Claude のプロジェクト個人用登録は探索対象だが、この編集画面の保存先には含めない。

名前と1件のサーバー定義を JSON で編集する。stdio / HTTP のひな形を用意し、保存先形式の追加オプションを保持する。基本的な command / url / args / env の型を検証するが、認証・接続成功は保証しない。登録の削除・名前変更はこの画面の対象外。

JSON は他のキーを保持して整形保存。通常の TOML テーブルでは編集対象のテーブルだけを再生成し、他の設定とコメントは保持する。インライン・dotted key 等で局所的な置換ができない場合は、ファイル全体の再整形（コメントは失われる）を画面で明示的に許可する必要がある。保存前後の意味を TOML パーサーで照合する。

保存は直列化し、読み込んだファイル全体の SHA-256 リビジョンと保存直前に再照合する。一時ファイルへの書き込み後に rename。既存ファイルのアクセスモードとシンボリックリンクの実体を保持する。外部プロセスとの OS レベルの協調ロックではないため、最終確認と rename の間の競合まで保証するものではない。構文不正のファイルは上書きしない。読込・保存上限は1 MiB、1件の入力定義は64 KiB。

登録の保存だけでは接続しない。Pleiad 管理の場合は、次の実行時に登録を解決して接続する。

`core/context-settings.mjs` が設定の保存・継承・移行、`core/context-scan.mjs` が探索、`core/mcp-config.mjs` がエージェント側の登録の読み書き、`core/context-session.mjs` が会話ごとの操作。UI は `web/context.mjs`（設定 › コンテキスト）、`web/mcp-config.mjs`（外部 MCP のカードとシート）、`web/session-context.mjs`（会話の右パネル）。実行時は `core/context-runtime.mjs` と `core/context-bridge.mjs` を介して各バックエンドに供給し、会話に利用記録を保存する。TOML / YAML は `smol-toml` / `yaml` で解析し、設定を正規表現だけで読まない。

## 初期調査時のネイティブ抑止の実機確認

以下は実装前の観測。現在の抑止方式と追加検証は [context-runtime.md](context-runtime.md) を参照。

`node tests/manual/context-probe.mjs` を明示実行する。通常の `npm test` には含めない。
使い捨ての設定・指示・Skill と、固定応答のローカル MCP サーバーで初期化を確認する。ユーザーターンは送信しない。Claude のコンテキスト照会は `detail: "summary"` でトークン計数 API を呼ばない。ネイティブ初期化自体のネットワーク通信を完全に遮断するテストではない。

確認環境：Windows、Claude Agent SDK 0.3.258、Codex CLI 0.153.2。

| 経路 | 観測 |
|---|---|
| Claude 通常 | ユーザー・プロジェクトの memoryFiles、fixture Skill が一覧とコンテキストに存在。ディスク由来の fixture MCP が connected |
| Claude `settingSources: []`, `skills: []`, `strictMcpConfig: true` | memoryFiles は空。fixture Skill は一覧に無い。ディスク MCP は無い |
| Claude settingSources を維持し `claudeMdExcludes`、`skills: []`、strict MCP と明示 MCP | memoryFiles は空。ディスク MCP は無く、明示した MCP のみ connected。ただし fixture Skill は supportedCommands に残った。summary の Skill 情報は欠落したため、Skill ツールの実行拒否までは確認できていない |
| Codex `skills.config.path` にフォルダーを指定して enabled=false | skills/list は enabled=true のまま |
| Codex 同じ設定でパスを `SKILL.md` まで指定 | skills/list は enabled=false |
| Codex `project_doc_max_bytes=0` | config/read で 0 を確認。最終プロンプトから全スコープの指示が消えることは未検証 |

Claude の通常初期化は一時ホーム以外の祖先 CLAUDE.md も検出した。ホームだけを変更して完全隔離できるとは扱わない。

公式資料：[Claude memory](https://code.claude.com/docs/en/memory)、[SDK system prompts](https://code.claude.com/docs/en/agent-sdk/modifying-system-prompts)、[Codex config](https://learn.chatgpt.com/docs/config-file/config-reference)、[Codex Skills](https://learn.chatgpt.com/docs/build-skills)。公式設定説明とローカルバージョンの観測が違う箇所は、対応バージョン別に検証する。

## 実行段階へ進める際の確認事項（実装済みの詳細は context-runtime.md）

1. 指示・Skills・MCP ごとに所有者とバックエンドの対応能力を持たせる。抑止が未確認なら共通管理を有効にしない。
2. Claude の設定維持時の Skill フィルター、再開・subagent・plugin 経由の読み込みと、Codex の全スコープ指示抑止・スレッド間分離を検証する。
3. 解決済みマニフェストをセッションに記録し、指示の適用範囲・優先順位・Skill の遅延ロードと MCP の明示接続をバックエンドへ渡す。
4. 既存セッションの指示履歴を消したことにはせず、設定変更の反映方式（新規セッションを含む）を決める。

検証：`npm test` に探索・参照循環・リンク・競合・秘密値非公開・保存継承・同時保存・再起動復元・通常ターン非干渉のテストを追加。ブラウザーで両スコープの未保存変更の保持、保存・スキャン、390px 幅、明暗表示、コンソールエラー無しを確認した。
