# 0048 Hooks を「Pleiad がそろえる」: ネイティブを会話ごとに止め、Pleiad の登録を渡す

- 状態: 承認（2026-09-28）。ただし「決定 B」は実装で決めたことで、ユーザーの承認の範囲の外（状態は提案）。

## 状況

[ADR 0045](0045-hooks-management.md) の第 3 段は「Pleiad がそろえる」: Pleiad 独自の登録を、選んだエージェントの Pleiad から始める会話へ渡し、各エージェント自身の設定の hooks（ネイティブ）は二重に動かないよう止める。第 2 段（[ADR 0047](0047-hooks-copy-adapter.md)）で、エージェントの間の入出力を直すアダプターはできている。

2026-09-28 に 3 つのエージェントで実機を確かめた（Claude Code 2.1.282 / Agent SDK 0.3.258、Codex CLI 0.156.1 の app-server、agy 1.2.12）。

- Claude Code: フラグ設定の `disableAllHooks: true` で、ユーザー・プロジェクト・ローカルに加えて**プラグインの hooks も止まる**。SDK の `hooks` コールバックは止まらずに走り、`permissionDecision: 'deny'` を返せば `bypassPermissions` でもツールを止める。SessionStart のコールバックは呼ばれない。管理者以外の `disableAllHooks` では管理者の hooks は止まらない（CLI の中身で確認。実行は未確認）。Skills・MCP・CLAUDE.md・プラグインの読み込みは変わらない。
- Codex: `thread/start`・`thread/resume` の `config` に `hooks`（hooks.json と同じ形）を渡せる。出どころは `sessionFlags` で、**未信頼として扱われ、`hooks.state` の `trusted_hash` が無いと動かない**。同じ `config` の `hooks.state` で、ユーザー・プロジェクトの定義の key に `enabled: false` を入れると、その thread だけで止まる（同じ app-server の他の thread には漏れない）。ロード済みの thread への resume は `config` を無視する。`features.hooks=false` は渡したものも含めて全部止める。
- agy: `--add-dir` で足した置き場の `.agents/hooks.json` に書いた定義は動き、`{"<名前>": {"enabled": false}}` を書くと、ユーザーと作業場所の同じ名前の定義が止まる。custom agent の frontmatter の `hooks:` は動かず、書き違えると既定のエージェントに黙って戻る。置き場の hook は置き場の `.agents` で動く。PreToolUse の hook が何も言わない（`{}`）と、ツールは拒否される。

## 決定

### A. ユーザーが決めたこと（2026-09-28）

1. **Claude Code はフラグ設定の `disableAllHooks: true` でネイティブを止める。** プラグインの hooks も一緒に止まる（ADR 0045 の「プラグインの定義は抑止しない」の、この担当での例外）。そのため切り替える前の確認の面に、止まるプラグインの hooks も並べ、必要なものは Pleiad の登録に取り込んで引き続き動かせるようにする（外部 MCP を統一するとき〔[ADR 0031](0031-confirm-before-unifying-mcp.md)〕と同じ考え方）。管理者の hooks は止めない。
2. **Codex の信頼**: Pleiad に登録し、Pleiad の確認の面で内容を確かめた hook に限り、Pleiad から起動する会話の thread の `config` で `hooks.state` の `trusted_hash` を付けて渡す。hash は、同じ表を起動の `-c hooks=…` で渡した app-server（プローブ）の `hooks/list` の `currentHash`（`source: sessionFlags`）から取る。ユーザー自身の Codex の hooks の信頼は今まで通り代行しない（ADR 0045）。
3. **agy は、Pleiad の一時の置き場（`--add-dir`）の `.agents/hooks.json` に、Pleiad の登録（名前は `pleiad-<id>`、アダプター越し）と、ネイティブの名前ごとの `{"enabled": false}` を書く。** プラグインの名前は入れない。`inheritCustomizations` は hooks のために変えない（custom agent に頼らない）。Pleiad の PreToolUse は、元のコマンドが何も言わないとき `{"decision":"allow"}` を返す。

### B. 実装で決めたこと（状態は提案。ユーザーの承認の範囲の外）

- **正本と担当の保存の置き場は `<data>/hooks.json`（形式 1）。`context-scans.json`（形式 3）の `kinds` に `hook` を足さない。** 中身は Pleiad の登録（`hooks`）と担当（`defaults` と場所ごとの上書き `places`。`{ owner: native|ply, disabled: [登録の id] }`）。継承は他の種類と同じ（一番近い上書き、無ければ既定。受け継ぐ値と同じ上書きは持たない）。
- **登録の形は「コマンドが話すエージェントの形」＋コマンド。** `{ id, name, agent, event, matcher, command, timeout?, async?, targets, matchers?, enabled, importedFrom? }`。`agent` はコマンドが読み書きする JSON の形、`targets` は渡すエージェント。別のエージェントへは第 2 段の変換（`convertHook`）とアダプターをそのまま使う（イベントは同じ名前だけ、matcher は対応表、意味の違う答えは安全な側）。
- **担当はエージェントごとに分けない。** 「Pleiad がそろえる」の場所では、Claude Code・Codex・Antigravity のどの会話でもネイティブを止め、そのエージェントを `targets` に持つ登録を渡す。
- **切り替えの確認は ADR 0031 に倣い、戻す向きでも確かめる**（MCP と違い、戻すと止めていたネイティブのコマンドが再び自動で動くため）。担当と取り込みは 1 回の書き込みで保存し、取り込む定義はサーバーが元のファイルから読み直す（画面から来たコマンドは使わない）。取り込めない定義（`if` などの実行の条件・command 以外・Skill・プラグインのデータの置き場を使うもの）は理由を出して選べなくする。プラグインのコマンドの `${CLAUDE_PLUGIN_ROOT}` は取り込むときに実際のパスへ置き換える。
- **Codex のアダプターは `<data>/hooks-runtime/` に置き、PATH の `node` で動かす**（Windows の Codex は PowerShell で動かすので、引用付きの実行ファイルを先頭に置けない）。agy のアダプターは置き場の `.agents/pleiad-hooks/` に置き、相対パスで動かす。アダプターは同じ形のまま通す使い方（`<元>` = `<先>`）と、6 番目の引数（登録の id）で発火を置き場の `runs.jsonl` に記録する使い方を足した。
- **組み立てられないときは送らない。** 担当が Pleiad の場所で、ターンの準備（登録・止める一覧）が失敗したら、そのターンを始めない。Codex で `hooks/list` を取れない・ロード済みの thread を外せないときも同じ。

### C. 二重実行を防ぐ条件と、残る制約

- Claude Code: フラグ設定に `disableAllHooks` を必ず入れる（互換先のときはフラグ設定のファイル、そうでないときは `settings` のオブジェクト）。`hook_started` が届いたら、止まらなかったネイティブとして会話の記録に残す（漏れ）。一覧に頼らないので、起動後に足された定義も止まる。
- Codex: ターンごとに、その会話の app-server の `hooks/list`（その cwd）を取り直し、`source` が `user`・`project` の key に `enabled: false` を入れる。ロード済みの thread で hooks の config の指紋が変われば `thread/unsubscribe` してから resume し、外せなければターンを始めない。`features.hooks=false` は使わない。`hook/started` の `source` が `user`・`project` なら漏れとして記録する。
- agy: 会話を起こすたびにユーザーと作業場所の定義の名前を読み直し、変わっていれば起こし直す。**起動後に足された名前は止まらず、漏れも観測できない。** 発火はアダプターの記録（Pleiad が渡した分）だけ。
- 3 者とも、エージェントのユーザー設定ファイルは書き換えない。効くのは Pleiad から起動した会話だけ。止められないもの: Claude の管理者の hooks、Codex のプラグイン・管理者の hooks、agy のプラグインの hooks（名前を入れないため）、Claude の SessionStart の登録（渡せない）。

## 理由

- 正本を別ファイルにしたのは、形式 3 を読む前の版の Pleiad が形式 4 の `context-scans.json` を読めずに止まると、指示・Skills・外部 MCP の設定まで使えなくなるため。`<data>/hooks.json` なら前の版は黙って無視し、hooks は元のファイルどおり（エージェント任せ）に戻るだけで済む。担当の中身も、他の種類の探索の形（`sources`・`excludePaths`）とは合わない。登録と担当を同じファイルに置けば、切り替えの「担当」と「取り込み」を 1 回の書き込みで保存できる。
- Claude のプラグインの hooks を止めるのは、`disableAllHooks` のほかに、プラグインだけを残して止める確かな方法が無いため（`managedSettings` の `strictPluginOnlyCustomization` は管理者の層があるマシンで黙って捨てられ、効いたかを確かめる手段が要る）。止まることを確認の面で見せ、取り込めるようにすれば、利用者が知らないうちに処理を失わない。
- Codex の `trusted_hash` を Pleiad が入れなければ、Pleiad の登録は利用者が `/hooks` で信頼するまで動かない。Pleiad の画面でコマンドを確かめてから登録したものに限れば、信頼の審査は Pleiad の画面で済んでいる。
- agy に custom agent（`inheritCustomizations: false`）を使わないのは、hooks だけを止める組み合わせが無く、Skills も消え、書き違えると黙って既定のエージェントに戻るため。名前で止める方式は既定のエージェントのまま効く。

## 影響

- 正本と担当は `core/ply-hooks.mjs`、渡し方の組み立ては `core/hooks-plan.mjs`（純粋）、ターンの準備・確認・Claude のコールバックは `core/hooks-unify.mjs`。バックエンドは `claude.mjs`（`claudeContextOptions` の `hooks`・`query()` の `hooks`）、`codex.mjs`（`codexHooksConfig`・`loadedHooks`・`hook/started`）、`antigravity.mjs` と `antigravity-context.mjs`（置き場の `.agents/hooks.json`・`runs.jsonl`）。
- Claude のプラグインの hooks を読むようになった（`installed_plugins.json` と `enabledPlugins`。読み取りのみの行）。
- Codex の会話の発火（`hook/started`・`hook/completed`）を、担当によらず会話の右パネルの「発火の記録」に出すようになった。
- 画面は設定 › コンテキストの Hooks のカード（担当の 2 択・確認の面・Pleiad の登録）と、会話の右パネル（そろえた会話の記録・「この場所だけ変える」）。形は docs/design-system.md「Hooks」、動きは docs/context-management.md・docs/context-runtime.md の「Hooks」。
- 前の版の Pleiad に戻すと、`<data>/hooks.json` は読まれず、hooks はエージェント任せになる（ネイティブが動く）。
