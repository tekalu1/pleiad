# コンテキスト管理：標準配置の探索と MCP 登録

2026-09-12。第1段階として、設定の「コンテキスト」ページから探索元を保存し、指示ファイル・Skills・MCP の候補を確認できる。
2026-09-15 にツリーとプレビューの 2 列にした画面は、2026-09-20 に承認済みの 1 画面へ置き換えた（ツリー・「読み込み担当」「探索の設定」・保存ボタン 4 つを廃止）。2026-09-27 から設定の画面は**全体の設定だけ**を扱う（範囲のプルダウンを廃止）。種類ごと（指示・Skills・外部 MCP）に「エージェントに任せる／Pleiad がそろえる」を選び、その下の 2 段で、ユーザー（home と足した場所）の探す形式・見つかったもの（スイッチ）・探す場所、作業場所（Git ルート〜作業フォルダー）の探す形式を決める。場所ごとの設定は会話の右パネルの「この場所だけ変える」から（`docs/context-runtime.md`「利用記録と検証」）。変更はその場で保存し「保存しました · 次のターンから反映」を出す（2026-09-23 から、始まっている会話にも次のターンから効く）。見た目の規則は `docs/design-system.md` §9「コンテキスト」。理由は [ADR 0014](adr/0014-context-default-agent-managed.md)・[ADR 0026](adr/0026-context-global-settings-and-ply-instructions.md)。
「指示」のカードの上には「Pleiad の指示」（Pleiad が毎ターン入れる指示の一覧。種類の担当・場所によらない）。仕様は [共通コンテキストの実行](context-runtime.md)「Pleiad の指示」。
探索 API は `previewOnly: true` の候補一覧。Pleiad がそろえる種類は実行時に解決して会話へ渡す。実行時の抑止・適用時期・利用記録・会話の右パネルは [共通コンテキストの実行](context-runtime.md) を参照。既定はエージェント任せのまま。

## 保存と継承（形式 3）

- `${AGENT_HOST_DATA}/context-scans.json`（既定 `~/.agent-host/`）に `version: 3` で保存する。
  ```jsonc
  { "version": 3,
    "defaults": { "roots": { "instruction": [], "skill": [], "mcp": [] },   // どの場所でも探す追加ルート（ユーザーの範囲）。種類ごと
                  "kinds": { "instruction": K, "skill": K, "mcp": K } },
    "places": { "<pathKey>": { "path": "<表示用の実体パス>", "roots": { /* 上書きした種類だけ */ "skill": [] },  // その場所から下で探す追加ルート
                               "kinds": { /* 上書きした種類だけ */ "skill": K } } } }
  // K = { owner: "native" | "ply",
  //       user:      { sources: ["common"|"claude"|"codex"], excludePaths: [...] } | null,   // home の探索。対応を終えたエージェントの探索元（RETIRED_SOURCES）は読んだところで落とす
  //       directory: { sources: [...], excludePaths: [...] } | null,                                   // Git ルート〜作業場所の探索
  //       disabled?: ["名前"],            // 外部 MCP だけ。名前で外す（同じ設定ファイルの他の登録は残す）
  //       prefer?:   { "名前": "設定ファイル" } }  // 外部 MCP だけ。同じ名前の定義が複数あるときに使う方（無ければ先に見つかった方）
  ```
- **追加ルート（探す場所を足す）は種類ごと**（2026-09-27、[ADR 0026](adr/0026-context-global-settings-and-ply-instructions.md)）。足した場所はその種類だけを、その範囲の探す形式（`sources`）で、プロジェクトと同じ置き方（`AGENTS.md`・`.claude/`・`.codex/`・`.agents/skills`・`.mcp.json`）で探す。見つかった行には `root`（足した場所）が付き、画面は「追加した場所」として分ける。既定の追加ルートの行はユーザーの範囲（`scope: 'user'`）、場所の追加ルートの行は作業場所の範囲。
- **種類ごとに継承する。** 作業場所に一番近い（深い）上書きを持つ場所の値、無ければ既定。追加ルートも種類ごとに同じ（`roots[kind]` を持つ一番近い場所）。場所の上書きを消す（「全体の設定に戻す」。上の場所に上書きがあれば「上のフォルダーの設定に戻す」）と上の値に戻る。画面では「全体の設定どおり／<親の場所> の設定どおり／このフォルダーだけの設定」。
- **受け継ぐ値と同じ上書きは持たない**（2026-09-23、issue #19）。`set` は保存のたびに、変えた場所の上書きのうち上の場所（または既定）から受け継ぐ値と同じものを消す（`pruneInherited`。移行の `migrateV1` と同じ規則）。この保存で作った場所に上書きが残らなければ場所も作らない（一覧に足した場所は残す）。違いの無い上書きが残ると、その場所は「個別に変更」扱いになり、あとで既定を変えてもその場所に効かない。前の版で保存された同じ上書きは、読み込んだときに消して書き戻す（`pruneAll`。上書きが無くなった場所は一覧からも外す。はじめから上書きの無い場所は残す）。
- `user` / `directory` が `null` の種類はその範囲を探さない。形式 1 の「対象（kinds）」から外していた種類を移行で表すためだけに残る（画面の札を押すと両方が同じ探す形式にそろう）。
- **旧 `kinds` は廃止。** 実行時に Pleiad が探すのは担当が Pleiad の種類だけ（`runtimeSettings`）。
- `excludePaths` はファイルまたはディレクトリのパス（glob ではない）。ディレクトリ配下にも適用し、リンクの参照元・実体の両方で照合する。画面のスイッチは、その行が見つかった範囲（home なら `user`、それ以外は `directory`）の除外を出し入れする。スイッチを入れるとき、その行を含むフォルダーごとの除外も外す。
- 相対パスは保存時に絶対パス化する。既定はホーム、場所は保存先ディレクトリが基準。継承先で意味が変わらない。
- 書き込みは読み込みと同じ列に直列化し、一時ファイルから rename。壊れた JSON はエラーにして保存を拒否し、ファイルはそのまま残す。
- これらはサーバーのファイルシステム上のパス。別端末のブラウザーで操作しても、ブラウザー側のファイルは探索しない。

### 形式 2 からの移行（2026-09-27）

形式 2（`version: 2`）は追加ルートを種類によらない並び 1 つ（`defaults.roots: [...]`、`places[].roots: [...]`）で持ち、足した場所をすべての種類・すべての形式で探していた。読み込んだときに、形式 1 と同じ手順で形式 3 へ移す: 元のバイト列を `context-scans.v2-backup.json` に書き（既にあれば残す）、メモリ上のコピーで並びを 3 種すべてへ写し（`migrateV2`。今までどおりすべての種類で探す）、既定と保存されていたすべての場所で担当と探索の計画（種類ごとの追加ルートを含む）が同じかを確かめ（`sameMeaningV2`）、一時ファイルに書いて読み直してもう一度確かめてから rename で置き換える。失敗したら元のファイルは変えない。移したあとの足した場所は、その種類のその範囲の探す形式に従う（既定のすべての形式なら今までと同じものが見つかる）。会話に記録された形式 2 の計画（`roots` が並び）は、読むときに種類ごとへ直す（`normalizePlan`）。`tests/unit/context-roots.mjs` が、移行の前後で既定・場所の探索結果が同じこと、バックアップ、壊れたファイルを変えないこと、種類ごと・形式に従う探索を確かめる。

### 形式 1 からの移行

形式 1（`version: 1`）は、読み込み担当（`owners` と場所ごとの `directoryOwners`）と探索設定（`user` と場所ごとの `directories`。`sources` / `kinds` / `additionalRoots` / `excludePaths`）を**別々の場所から**継承していた。読み込んだときに次の手順で形式 2 へ移す（`docs/desktop-releases.md` の「データ形式変更」）。

1. 読み込み・保存の列の中で行う（同じプロセスの書き込みと重ならない）。
2. 元のバイト列を `context-scans.v1-backup.json` に書く（既にあれば残す）。
3. メモリ上のコピーで変換する（`migrateV1`。直接形式 3 にする。追加ルートは 3 種すべてへ）。既定 = ユーザーの担当とユーザーの探索設定（home の範囲）＋ Pleiad の既定の探索設定（Git ルート〜作業場所の範囲）。担当か探索設定のどちらかを上書きしていた場所は、すべて「その場所で効いていた担当と探索設定」を持つ場所にする。`kinds` から外していた種類は、その範囲を `null` にする。最後に、上から受け継ぐ値と同じ上書きは消す（結果は変わらない）。
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

- `contextSettings { cwd? }`：画面の形。`defaults` と `places[]`（保存した場所と今の場所）それぞれで、種類ごとの `{ value, override, from }`、種類ごとの追加ルート `roots: { <kind>: { value, override, from } }`、「個別に変更」の数（`overrides`。種類と種類ごとの追加ルートの上書きの数）、`current`（今の場所）、`saved`。設定の画面は `defaults` だけ、会話の右パネルは今の場所（`current`）を使う。
- `setContextSettings`：1 か所だけ変えて即時保存し、`contextSettings` と同じ形（と `place`）を返す。`{ place: null | パス, kind, value: K | null }`（場所で `null` は既定に戻す）、`{ place, kind?, roots: [...] | null }`（`kind` を省くと 3 種すべて）、`{ place, add: true }` / `{ place, remove: true }`（右パネルの「全体の設定に戻す」は `remove`）。
- `scanContext { cwd, place?: "default", scope?: "user" }`：保存済み設定から候補・出典・診断・探索場所・根（`home` / `root`）・MCP 設定ファイルごとの登録の書き出し（`configs`）を返す。`place: "default"` は場所の上書きを使わず既定だけで探す。`scope: "user"` はユーザーの範囲（home と既定の追加ルート）だけを探す（設定の画面のユーザーの段。作業場所のファイルを混ぜない）。同一接続の重複スキャンは拒否する。
- `agentMcp { cwd }`：各エージェント（Claude・Codex）の設定に登録されている外部 MCP。探索の設定に関係なく読むだけ（接続・起動しない）。設定の「エージェントに任せる」と会話の右パネルが見比べに使う。
- `slashSkills { cwd }`：同じ探索結果から、入力欄の先頭 `/` に出すスキルだけを名前順に返す（`skillList()`）。各項目は `{ name, description, hint, from }`。同名は先に見つかった置き場所だけを返し、除外・shadowed は含めない。`hint` は frontmatter の `argument-hint`、または引数の定義から作る。
- `sessionContext { sessionId }`：その会話の読み込み記録・担当・固定の有無と、固定された会話だけ行う今のファイルとの突き合わせ（`changed`）、Pleiad が入れた指示（`added`）を返す。詳細は `docs/context-runtime.md`。
- `plyInstructions {}` / `setPlyInstructions { action, … }`：Pleiad の指示の一覧（画面の言語の文・項目ごとと合計のトークン数）と、足す・編集・スイッチ・削除・既定に戻す・並べ替え。`docs/context-runtime.md`「Pleiad の指示」。
- `listMcpConfig { cwd, format, scope }`：保存先・リビジョン・登録名のみを返す。
- `readMcpServer { cwd, format, scope, name }`：明示的に開いた1件の定義を返す。認証情報を含むことがあるため一覧・探索・ログに流用しない。
- `saveMcpServer { cwd, format, scope, name, value, revision, mode, allowReformat? }`：`mode` は add / edit。既存登録を誤って上書きしないよう区別する。
- Pleiad 自身の登録（`listPlyMcp` など）は `docs/context-runtime.md`「MCP」。

## 外部 MCP の画面（2026-09-20）

設定 › プラグインの「外部 MCP」カードに集約した（旧「MCP 管理」の JSON 直書き画面は廃止）。
- **エージェントに任せる**: `agentMcp` で各エージェントの登録を 2 列で見比べる。片方にしか無いものに「Claude だけ」。Pleiad は読むだけで変えない。
- **Pleiad がそろえる**: ユーザーの段に、どの場所でもつなぐもの（Pleiad の登録と、ユーザーの範囲のエージェントの登録）を名前ごとに 1 行。作業場所の `.mcp.json` などは場所ごとなので、会話の右パネルで見る。手元で動かす／URL の区別、どの設定由来か（Pleiad に登録・Claude だけに登録・両方に登録）、ログインの状態と「ログイン」、同じ名前で中身の違う定義があれば「どちらの定義を使いますか」（`prefer`）、スイッチ（オフ = `disabled`）。行を押すと中身: Pleiad の登録は編集・名前を変える・ログイン／ログアウト・接続を確認・削除、エージェントの登録は伏せ字の定義と「Pleiad に取り込む」（`importPlyMcp`。トークンは引き継がない）。読み込む設定ファイルは段の探す形式（ユーザーは Claude の設定・Codex の設定、作業場所は `.mcp.json`・`.codex/config.toml`）。「ログインの詳細設定」（Client ID Metadata Document の URL。既定は空）は折りたたみの奥。暗号化されない起動では平文で保存することを注記する。
- **名前を変えたとき**（`renamePlyMcp`）: 既定と各場所の設定で名前で指したものも追随させる（`contextSettings.renameMcp`）。`disabled` は新しい名前も外す（古い名前は残す。同じ名前のエージェント側の登録は前と同じく外れたまま）。`prefer` は Pleiad の登録を選んでいたものだけ新しい名前へ移す。戻り値の `settingsUpdated` は書き換えた箇所の数。始まっている会話も次のターンから今の設定（`plan.mcp`）に従う。「この会話では外す」（`removedMcp`）は会話の方針なので名前のまま変えない。
- **同じ名前の定義が複数あるとき**: 選んだ定義（`prefer`）、無ければ先に見つかった方を使い、残りは `shadowedBy: 'choice'` で渡さない（以前は実行時に「同名の MCP があります」で止めていた）。どれを使ったかは設定の行（「〜の定義を使っています」）と会話の右パネル（「渡していないもの」に理由）に出す。Pleiad の登録と同じ名前のエージェント側の登録は、従来どおり Pleiad の登録が優先。
- **＋ MCP を追加**（シート）: 名前（エージェントの登録から候補を出し、選ぶとつなぎ方を写す）、つなぎ方（URL につなぐ／手元で動かす）、コマンド・環境変数、または URL・認証（ブラウザでログイン／トークン／ヘッダー／なし。アプリ登録が要るときの clientId は折りたたみ）、保存先と暗号化の説明（登録はすべての場所に効く。この場所だけ外すのは会話の右パネルの「この場所だけ変える」）、「追加してログイン」（OAuth）または「追加して試しにつなぐ」。JSON で直接書きたいときは「JSON で編集（上級者向け）」を開く。

以下はエージェント側の設定ファイルを書く API（`saveMcpServer`）の仕様。画面からは使わなくなったが、API は残している。

同じMCP管理欄に、Claude・Codex共通の「Pleiadの成果物提示」を内蔵機能として表示する。既定は有効で、切り替えはPleiadの設定に保存し、すべての作業場所の次ターンから反映する。`plyMcpSettings` / `setPlyMcpSettings` で読み書きする。外部MCPの形式・保存スコープ選択とは独立している。

可視化の共通スキル本文はターン開始時に注入する。提示用の内蔵 `ply.present` MCP は廃止した。外部登録の `ply` と `host` は予約名として拒否する。Codex の再開済みスレッドの旧 `ply` 接続は無効化する。外部MCPの探索・編集仕様は以下のとおり。

保存形式（claude / codex）と保存スコープ（user / directory）は会話の実行バックエンドとは独立。directory の保存先は画面で選んだ cwd そのもの（Git ルートへの暗黙の変更なし）。Claude は `~/.claude.json` のトップレベル `mcpServers` または cwd の `.mcp.json`、Codex は `CODEX_HOME/config.toml`（既定 `~/.codex`）または cwd の `.codex/config.toml` の `mcp_servers` に保存する。Claude のプロジェクト個人用登録は探索対象だが、この編集画面の保存先には含めない。

名前と1件のサーバー定義を JSON で編集する。stdio / HTTP のひな形を用意し、保存先形式の追加オプションを保持する。基本的な command / url / args / env の型を検証するが、認証・接続成功は保証しない。登録の削除・名前変更はこの画面の対象外。

JSON は他のキーを保持して整形保存。通常の TOML テーブルでは編集対象のテーブルだけを再生成し、他の設定とコメントは保持する。インライン・dotted key 等で局所的な置換ができない場合は、ファイル全体の再整形（コメントは失われる）を画面で明示的に許可する必要がある。保存前後の意味を TOML パーサーで照合する。

保存は直列化し、読み込んだファイル全体の SHA-256 リビジョンと保存直前に再照合する。一時ファイルへの書き込み後に rename。既存ファイルのアクセスモードとシンボリックリンクの実体を保持する。外部プロセスとの OS レベルの協調ロックではないため、最終確認と rename の間の競合まで保証するものではない。構文不正のファイルは上書きしない。読込・保存上限は1 MiB、1件の入力定義は64 KiB。

登録の保存だけでは接続しない。Pleiad 管理の場合は、次の実行時に登録を解決して接続する。

`core/context-settings.mjs` が設定の保存・継承・移行、`core/context-scan.mjs` が探索、`core/mcp-config.mjs` がエージェント側の登録の読み書き、`core/context-session.mjs` が会話ごとの操作。UI は `web/context.mjs`（設定 › プラグイン）、`web/mcp-config.mjs`（外部 MCP のカードとシート）、`web/session-context.mjs`（会話の右パネル）。実行時は `core/context-runtime.mjs` と `core/context-bridge.mjs` を介して各バックエンドに供給し、会話に利用記録を保存する。TOML / YAML は `smol-toml` / `yaml` で解析し、設定を正規表現だけで読まない。

## Hooks（2026-09-27）

設定 › コンテキストの「Hooks」カードと会話の右パネルの Hooks の面（[ADR 0045](adr/0045-hooks-management.md)、画面は design-system.md「Hooks」）。第 1 段は見える化とネイティブ編集、第 2 段は他のエージェントへ写す、第 3 段は Pleiad がそろえる（下の節）。探索と書き込みは `core/hooks-config.mjs`。hooks の担当と Pleiad の登録は `context-scans.json` ではなく `<data>/hooks.json` に持つ（下の「Pleiad がそろえる」。[ADR 0049](adr/0049-hooks-pleiad-managed.md)）。

**探す場所**（ユーザーは home、作業場所は Git のルートから cwd までの各フォルダー）:

| エージェント | ユーザー | 作業場所 | 形 |
|---|---|---|---|
| Claude Code | `CLAUDE_CONFIG_DIR`（既定 `~/.claude`）の `settings.json` | `.claude/settings.json`（プロジェクト）・`.claude/settings.local.json`（プロジェクトローカル） | `hooks` → イベント → matcher group → handler |
| Codex | `CODEX_HOME`（既定 `~/.codex`）の `hooks.json` と `config.toml` の `[hooks]` | `.codex/hooks.json`・`.codex/config.toml` | 同上（TOML は `[[hooks.<イベント>]]`） |
| Antigravity | `~/.gemini/config/hooks.json`（最上位が名前）・`~/.gemini/antigravity-cli/settings.json` の `hooks` | `.agents/hooks.json` | 名前 → イベント → ツールのイベントは matcher group、それ以外は handler を直接。名前に `enabled` |

Claude の Skill の frontmatter の `hooks`（ユーザーの `skills/*/SKILL.md` と作業場所の `.claude/skills/*/SKILL.md`）は読み取りのみの行にする。Claude のプラグインの hooks は、`<CLAUDE_CONFIG_DIR>/plugins/installed_plugins.json`（形式 2）の置き場所のうち、設定の `enabledPlugins`（ユーザー → プロジェクト → プロジェクトローカルの順で後が勝つ）で `true` のものの `hooks/hooks.json` と `.claude-plugin/plugin.json` の `hooks`（パスかインライン）を、読み取りのみの行（`scope: plugin`、`plugin`・`pluginRoot`）にする。プロジェクトに入れたプラグインは、その場所の会話だけ。Claude と agy の管理者の設定、agy のプラグインの hooks はまだ読まない。

**Codex の信頼状態**: Codex は定義の hash ごとに信頼を審査し、信頼されていない定義を実行しない（`codex exec` では確認も出ずに飛ばす。実機で確認、2026-09-27）。`scanHooks`・`sessionHooks` は、まず信頼状態なしで一覧を返し（Codex の行には `trustPending`、画面は「信頼状態を確かめています…」）、画面が `trust: true` でもう一度頼んだときに、Codex の会話と同じ app-server（`core/backends/codex-rpc.mjs` の共有の接続。`initialize` は `experimentalApi: true`）に `hooks/list { cwds }` を送り、返った各 hook の `trustStatus`（`trusted`・`untrusted`・`modified`・`managed`）・`enabled`・`currentHash` を、`key`（`<sourcePath>:<イベントの snake_case>:<group>:<handler>`）で行に `trust` として付ける（`applyCodexHooks`）。ユーザー・プロジェクト以外（プラグイン・管理者）の hooks は `hooks/list` の定義から読み取りのみの行を足す。Codex の行も Codex の設定ファイルも無ければ `hooks/list` を呼ばない（app-server を起こさない）。Codex を使わない構成・8 秒で返らない・失敗したときは `trust: null`（「信頼状態を取得できません」）。個別の停止・信頼の RPC は無い（`hooks/list` だけ）ので、Pleiad は信頼を代行せず、停止のスイッチも出さない。

**agy の enabled は名前単位でスコープをまたぐ**: ユーザーと作業場所に同じ名前の定義があるとき、有効なものは両方走り、どちらか一方の `enabled: false` で両方止まる（実機で確認）。探索は、止めている同じ名前の定義がある行に `stoppedBySameName` を付ける。agy は引用符付きのバックスラッシュのパスを解決できない（スラッシュ形式なら動く）ので、シートは agy に書くコマンドにバックスラッシュがあれば知らせ、スラッシュに直せる。

**行**（`scanHooks` の `entries`）: `{ id, agent, scope: user|project|local|skill|plugin|managed, base, path, format, event, matcher, name?（agy）, enabled?（agy）, stoppedBySameName?（agy）, trust?（Codex）, group, handler, type, command（伏せ字の要約）, timeout, async, editable, readOnly, definition（伏せ字の handler 全体）, unknownKeys }`。`group` / `handler` は元の並びの番号で、編集の指し先になる（agy の非ツールのイベントは `group: -1`）。ファイルごとの状態は `files`（`missing` = 無い、`none` = あるが登録 0 件、`ok`、`error` = 壊れている・形が違う。`partial` は一部の定義を飛ばした）で、登録 0 件と読み取り失敗を分ける。一覧の値は伏せる: `env`・`headers` の値、URL のクエリ・資格情報、トークンらしい形（`core/redact.mjs`）、`--token 値` のような引数。伏せるのは表示だけで、元のファイルの値は変えない。

**書き込み**（`saveHooks`）: `op` は `add`・`edit`・`delete`・`enable`（agy の名前単位）。command 型だけを追加・編集・削除でき、http・prompt・agent・mcp_tool の定義と知らないキーはそのまま残す（編集は `command`・`timeout`・`async` だけを差し替える）。イベントがそのエージェントに無ければ断る。agy には `async` を書かない。書き先はエージェント・スコープ・場所から決まるファイルだけ（任意のパスへは書かない）。追加の書き先は、Codex は既存の定義が `config.toml` にあればそこ（`hooks.json` を足して二重に登録しない）、agy のユーザーは CLI の `settings.json` に `hooks` があればそこ、ほかは `hooks.json`。`dryRun: true` は書かずに、書き先・形式（`toml`／`json`）・**実際に書く本文の前後**（伏せ字済み。`before`／`after`）・書き直しの要否（`reformatsFile` と理由 `reason: comments|jsonValues|rewrite`、消えるコメントの行数 `lostComments`）・伏せた部分だけが変わるか（`hiddenChange`）を返し、画面はこれを行の差分として見せてから書く。伏せ字は前後の本文に同じように通す（`maskFileText`: env・headers などの表とインラインの表の値、秘密らしい名前のキーの文字列の値、形で分かる秘密）ので、変わらない行は同じになる。agy の改名は名前の `enabled` を引き継ぎ、移し先の名前が別の `enabled` を持っていれば断る。予約の名前（`__proto__`・`constructor`・`prototype`）は名前・イベントのどちらにも使わない。matcher を変えた handler が他と group を共有していれば、取り出して新しい group に入れる。空になった group・イベント・名前は消す。

保存は `core/mcp-config.mjs` と同じ: 直列化、読んだ本文の SHA-256 revision を保存直前にもう一度照合、一時ファイルから rename、既存ファイルのアクセスモードとリンクの実体を保つ、構文の壊れたファイルは上書きしない、上限 1 MiB。改行コード（CRLF／LF）・BOM・JSON の字下げ（幅・タブ）は読んだ本文に合わせる。JSON は他のキーを残して整形保存し、読み直して値が変わるところ（有効桁を超える整数・重複したキー。`jsonLossy`）があれば書き直しの許可を求める。TOML（`renderToml`）は、追加なら既存の表に触らず末尾に `[[hooks.<イベント>]]` の 1 ブロックだけを足す。編集・削除（と、足すだけでは合わないとき）は hooks の表（`[hooks…]`・`[[hooks.…]]`。見出しから次の見出しの手前まで、ただし末尾のコメント行と空行は次の表の側に残す）を抜き、最初の hooks の表の位置に書き直す。抜く範囲にコメント（行末のものを含む）があれば、消える行数を出して画面で許可を取る。どちらも読み直した結果が期待どおりのときだけ使い、インライン・ドットの定義で合わなければ、ファイル全体の書き直し（コメントが消える）を画面で明示的に許可させる。プロジェクト・プロジェクトローカルのスコープでは、置き場所（`.claude`・`.codex`・`.agents` やファイル）の実体が作業場所の外にあれば（リンク）、読まず書かない（一覧では読めないファイルとして出す）。ユーザーのスコープのリンク（dotfiles の管理）は確かめない。複数の書き先は 1 件ずつ書き、失敗した先だけ理由を返す（書けた先は戻さない）。編集のシートを開くときだけ、`readHook` がその handler の `command`・`timeout`・`async` とキーの名前を返す（env・headers などの値は返さない）。元の `timeout` がシートの欄で扱えない値（文字列・小数）なら、欄を空のまま保存すれば元の値を残す（`keepTimeout`）。

### Pleiad がそろえる（第 3 段、2026-09-28）

担当を「Pleiad がそろえる」にした場所では、Pleiad から起動する Claude Code・Codex・Antigravity の会話で、各エージェント自身の設定の hooks（ネイティブ）を止め、Pleiad の登録だけを渡す（[ADR 0049](adr/0049-hooks-pleiad-managed.md)。渡し方は [共通コンテキストの実行](context-runtime.md)「Hooks」）。エージェントの設定ファイルは書き換えず、Pleiad 以外から起動する会話は今までどおり。

- **保存**（`core/ply-hooks.mjs`）: `<data>/hooks.json`（形式 1、0600）。`context-scans.json`（形式 3）には入れない（前の版がそのファイルごと読めなくなるのを避ける。前の版は `hooks.json` を無視し、hooks はエージェント任せに戻る）。
  ```jsonc
  { "version": 1,
    "hooks": [ { "id": "h-<12 桁>", "name": "…", "agent": "claude|codex|antigravity",   // コマンドが読み書きする JSON の形
                 "event": "PreToolUse", "matcher": "Bash", "command": "…", "timeout"?: 秒, "async"?: true,
                 "targets": ["claude", "codex"],                 // 渡すエージェント
                 "matchers"?: { "codex": "…" },                   // 自動で訳せない先の matcher
                 "enabled": true, "importedFrom"?: { "agent", "scope", "path", "event", "plugin"? }, "createdAt", "updatedAt" } ],
    "defaults": { "owner": "native|ply", "disabled": [] },         // 担当と、渡さない登録の id
    "places": { "<pathKey>": { "path": "…", "owner": "…", "disabled": [] } } }   // 場所ごとの上書き（一番近いものが勝つ）
  ```
  受け継ぐ値と同じ場所の上書きは持たない。登録を消すと `disabled` からも外す。登録は 1 件ずつ検査し、壊れた 1 件だけを読み飛ばす。ファイルが壊れていれば読めないとして止まり、書き換えない。
- **API**: `plyHooks { cwd? }`（担当と登録。コマンドは伏せ字）、`readPlyHook { id }`（編集のシートだけ元のコマンド）、`savePlyHook { value }`、`removePlyHook { id }`、`togglePlyHook { id, enabled }`、`plyHookPreview { value }`（エージェントごとの渡し方。保存しない）、`hooksUnifyPreview { cwd?, direction: ply|native }`、`setHooksOwner { place, value, imports? }`。
- **切り替えの確認**（`hooksUnifyPreview`。ADR 0031 に倣う。戻す向きでも出す）: 設定の画面はユーザーの範囲、右パネルの「この場所だけ変える」はその場所（ユーザーと Git のルートから cwd まで）を探し、Codex は `hooks/list` のプラグイン・管理者の定義を重ねる。行を `stops`（止まる。戻すときは再開する）と `keeps`（止め方の無い出どころ: Codex・agy のプラグイン、管理者）に分け、`stops` には取り込めるか（`importable` と理由）を付ける。Claude はプラグインと Skill の hooks も `stops`（Skill は止まる見込み・未確認）。`registry` は登録ごとの、エージェントごとの渡し方（`deliverable`）。
- **取り込み**（`setHooksOwner` の `imports`）: 画面が送るのは行の id だけで、サーバーが元のファイルを読み直して登録にする（`hooksConfig.raw`）。取り込めないもの: command 以外、実行の条件や知らないキー（`if`・`once` など）、matcher group のほかのキー、Skill、管理者・Codex の `hooks/list` だけの行、プラグインのデータの置き場（`CLAUDE_PLUGIN_DATA`）を使うもの、複数行のコマンド、取り込み済みのもの。プラグインの `${CLAUDE_PLUGIN_ROOT}` は実際のパスに置き換える。取り込んだ登録は元のエージェントだけに渡す（`targets` は元のエージェント）。担当と取り込みは 1 回の書き込みで、取り込みに失敗したら担当も変えない。

### 他のエージェントへ写す（第 2 段）

1 つの command 型の定義を、ほかのエージェントの設定ファイルへ写す（[ADR 0047](adr/0047-hooks-copy-adapter.md)）。`copyHooks { source: { agent, scope, base?, file, loc, revision? }, targets: [{ agent, scope, base?, name?, matcher?, revision? }], dryRun?, allowReformat? }`。元の定義はサーバーがファイルから読み直す（画面から来たコマンドは使わない）。写す先ごとに `{ status: ready|review|blocked, reasons, warnings, event, matcher, matcherStatus, name?, adapter?: { path, exists }, timeout, innerTimeout, path, format, before, after, revision }` を返し、`dryRun` なら書かない。書くのは、確認画面で見た revision と今の revision が同じで `ready` の先だけ。管理者・プラグイン・Skill・command 以外・写した定義（アダプター越し）からは写さない。

- **変換**（`core/hooks-copy.mjs`、純粋な関数）: イベントは同じ名前だけ（Claude Code ↔ Codex は共通のイベントすべて、agy とは PreToolUse・PostToolUse・Stop）。matcher はツール名の対応表（`Bash` ↔ `Bash` ↔ `run_command` だけが一致、`Edit`／`Write` ↔ `apply_patch` ↔ `replace_file_content`・`write_to_file` などは警告付き、`apply_patch` と agy のファイル操作の間は写せない）。正規表現・知らない名前・一部だけ無いものは `review`（写す先の `matcher` を入れると写せる）。実行の条件を変えるキー・知らないキー・group のほかのキー・agy への `async`・プラグインの環境変数は `blocked`。timeout は元のエージェントで効いていた秒数を保つ。
- **アダプター**（`core/hook-adapter.mjs`）: agy との間と Claude Code ↔ Codex の PreToolUse に挟む。写した先の設定ファイルの隣 `pleiad-hooks/hook-adapter-<中身の hash 12 桁>.mjs` に同じ中身を書き出し、起動時に自分の hash を照合する。コマンドは `node <アダプター（スラッシュ区切り）> <元> <先> <イベント> <内側の timeout> <元のコマンドの base64url>`。プロジェクトでは agy は `.agents` からの相対パス、Claude Code は `$CLAUDE_PROJECT_DIR` を使う。Windows の agy へは、空白とシェルの特殊文字を含まないアダプターパスを引用せずに書き、PATH の `node` で動かす。ほかの写し先のアダプターパスは引用する。Codex は作業フォルダーを確定できないためプロジェクトへのアダプター越しの写しを止める。Windows の元が Claude Code なら Git Bash、Codex なら PowerShell で元のコマンドを動かす。元のシェルが未確認の組み合わせは写さない。内側は最大 86395 秒、外側は内側 + 5 秒。意味が合わない答え・失敗は安全な側（PreToolUse は deny、Stop は止まらせる、PostToolUse は何もしない）。Stop の連続した「続け」は会話ごとに数え、5 回で止まらせる。対応表は ADR 0047。`node` が見つからないか、コマンドに書くアダプターパスに安全でない文字があれば写せない。
- **確かめること**: 同じイベントに同じコマンドが既にあれば写さない（`duplicate`）。agy の名前は既定でスクリプト名から（`claude-<名前>`）作り、ユーザー・作業場所に同じ名前があれば `review`（別の名前を入れる）。コマンドが指すスクリプトが無ければ `scriptMissing`、相対パスで基準の場所が変わるなら `scriptRelative` の警告。
- **伏せ字**: アダプターのコマンドの base64url の引数も、元のコマンドに伏せる値があれば引数ごと伏せる（`maskText`）。一覧の行は写した定義に `adapter: { from, event, timeout, command（元のコマンド、伏せ字） }` を付け、行の要約も元のコマンドにする。

## 検証

`npm test` に探索・参照循環・リンク・競合・秘密値非公開・保存継承・同時保存・再起動復元・通常ターン非干渉のテストを追加。ブラウザーで両スコープの未保存変更の保持、保存・スキャン、390px 幅、明暗表示、コンソールエラー無しを確認した。
