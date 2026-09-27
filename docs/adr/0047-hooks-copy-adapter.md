# 0047 Hooks を他のエージェントへ写すときは、入出力のアダプターを挟み、意味が合わない制御は安全な側に倒す

- 状態: 提案

## 状況

[ADR 0045](0045-hooks-management.md) の第 2 段は「他のエージェントへ写す」。Claude Code・Codex・Antigravity（agy）の hooks は、同じ名前のイベントでも、stdin の JSON の形（`tool_name`／`tool_input` と `toolCall.name`／`toolCall.args`）、ツール名（`Bash` と `run_command`）、答えの書き方（`permissionDecision` と `decision`）、失敗の扱いが違う。実機で次を確かめた（2026-09-27）:

- agy は PreToolUse の hook が exit 1 でも exit 2 でも、壊れた JSON でも、timeout でもツールを止める。`allow` は権限の確認を代わらない。hook は `<作業場所>/.agents` で動き、Windows のパスはスラッシュ形式でしか解決できない。
- Codex は PreToolUse の `ask` を扱えず、返すと hook の失敗としてツールを進める。信頼されていない定義は実行しない。
- Claude Code と Codex の stdin はほぼ同じ形で、exit 2 が止める・ほかの exit は止めない失敗、も同じ。
- agy の同じ名前の定義は、ユーザーと作業場所をまたいで、どちらかの `enabled: false` で両方止まり、両方有効なら両方走る。

コマンドの文字列だけを写すと、元のスクリプトは読めない JSON を受け取り、答えは写した先で別の意味になる（Claude の `ask` が Codex ではツールを進める、など）。

## 決定

- **写すのは command 型の 1 つの定義を、利用者が確認した写し先へだけ。** 管理者・プラグイン・Skill の定義、command 以外の型、写した定義（アダプター越し）からは写さない。元の定義は変えない。
- **イベントは同じ名前のものにだけ写す。** Claude Code ↔ Codex は両方にあるイベントすべて、agy とは PreToolUse・PostToolUse・Stop だけ。対応が無いイベントを別のイベントに読み替えない（SessionStart を PreInvocation にしない）。
- **matcher はツール名の対応表で置き換える。** 意味が一致するのはシェルだけ（`Bash` ↔ `run_command`）で、ほかは警告を付ける。正規表現・知らない名前・一部だけ対応が無いものは自動で訳さず、利用者が写す先の matcher を入れるまで選べない。
- **Antigravity との間と、Claude Code → Codex の PreToolUse には、入出力のアダプターを挟む。** アダプターは Node の標準モジュールだけを使う 1 つのスクリプト（`core/hook-adapter.mjs` をそのまま）で、写した先の設定ファイルの隣の `pleiad-hooks/hook-adapter-<中身の hash>.mjs` に書き出す。写した定義のコマンドは `node <アダプター> <元> <先> <イベント> <元の timeout> <元のコマンドの base64url>`。アダプターは、写した先の stdin を元の形に直し、元のエージェントと同じ作業フォルダー（agy なら `.agents`）と環境変数（`CLAUDE_PROJECT_DIR`・`ANTIGRAVITY_CONVERSATION_ID`）で元のコマンドを動かし、答えを写した先の形に直して、いつも exit 0 と JSON で返す。外側の timeout は元の秒数に 5 秒足す。ほかの Claude Code ↔ Codex はコマンドをそのまま写す。
- **意味が一致しない制御は、黙って別の意味に変えない。** アダプターで安全な側（ツールを止める・何もしない・止まらせる）に倒すか、写せないとして選べなくする。
  - PreToolUse: 写した先が扱えない `ask`（Codex）、agy で使えない `updatedInput`、timeout・起動できない・エージェントの入力が壊れている → deny。agy の元のコマンドの失敗（exit ≠ 0・壊れた JSON・決まっていない答え）は agy と同じく deny。agy の `allow` は Claude Code・Codex では何も言わない扱い（権限の確認はそのまま）、Claude Code・Codex の `allow` は agy の `allow`（agy の確認は残る）。
  - Stop: 失敗したら止まらせる（続けない）。「続ける」は `decision: block` ↔ `decision: continue` を互いに直す。
  - PostToolUse: agy は答えを読まないので、agy との間では何も返さない。Claude Code の PostToolUse は成功したときだけなので、agy の失敗したツールでは元のコマンドを動かさない。
  - 写せないもの: 実行の条件や止め方を変えるキー（`if`・`asyncRewake`・`once`・`commandWindows` など）・知らないキー・matcher group のほかのキー、agy への `async`、Codex の `apply_patch` と agy のファイル操作の間（入力を相互に直せない）、プラグインの環境変数を使うコマンド、アダプター無しで `CLAUDE_PROJECT_DIR` を使うコマンド、写す先の同じイベントに同じコマンドが既にあるもの。
- **写す前に確認の面を通す。** 写す先ごとに、元 → 写した後、実際に書く本文の差分（伏せ字）、書き先、写せない・確認が必要な理由、意味の違い（警告）を並べる。スイッチは既定オフ、写せる行だけ選べ、実行範囲（Pleiad 以外から起動する会話にも効く）の確認を入れるまで書かない。agy の写しには名前を付け、既にある名前には写さない。Codex に写した定義は「未審査」で、`/hooks` で信頼するまで動かないことを出す。
- **スクリプト本体・秘密・Codex の信頼状態は写さない。** コマンドが指すスクリプトが無い、または相対パスの基準が変わるときは警告する。

## 理由

- 写した先で動くのはコマンドの文字列だけで、スクリプトは自分が書かれたエージェントの JSON を前提にしている。スクリプトを書き換えずに動かすには、間で形を直すしかない。
- アダプターを写し先の設定の隣に置くのは、Pleiad の置き場所（インストールの場所・更新・起動の有無）に頼らずに、エージェントを Pleiad 以外から起動しても動くようにするため。名前に中身の hash を入れ、版が変わっても前の写しが指すファイルを書き換えない（同じ名前で中身が違えば上書きせず写さない）。Node にしたのは、Pleiad の利用者の環境に必ずあり、シェル（cmd・PowerShell・bash）ごとの違いを避けられるから。
- 元のコマンドを base64url の引数にするのは、どのシェルでも引用符を気にせず 1 つの引数で渡せ、写した定義の文字列に含まれるので Codex の信頼の hash にも入るから（別ファイルに置くと、審査の後に中身を差し替えられる）。
- hooks は許可・拒否を決める。意味の違う答えをそのまま通すと、止めるつもりの hook がツールを通す（Claude の `ask` を Codex に渡すと進む、agy の `updatedInput` を無視すると書き換える前の入力で動く）。止める側に倒せば、利用者は止まったことに気付いて直せる。逆に倒すと気付けない。
- 写せないものを「警告に同意」で通さないのは、実行の範囲や止め方が変わることを、確認の面の一行で利用者に判断させるのは重すぎるため（UX 提案 ④）。

## 影響

- 変換は `core/hooks-copy.mjs`（純粋な関数）、アダプターは `core/hook-adapter.mjs`、書き込みは `core/hooks-config.mjs` の `copy`（`copyHooks`）。確認の面は `web/hooks-card.mjs` の `openCopySheet`。動きは docs/context-management.md「Hooks」、形は docs/design-system.md「Hooks」。
- 一覧・差分では、アダプターのコマンドの base64url の引数も伏せ字にかける（元のコマンドに伏せる値があれば引数ごと伏せる）。写した定義の行は元のコマンドと「<元のエージェント> から写した定義」を出す。
- アダプターは写した先のエージェントが `node` を PATH から起動する。写すときに Pleiad が `node` を見つけられなければ写せない。写した後に `node` やアダプターのファイルが無くなると、Claude Code と Codex は止めない失敗として扱う（ツールは進む）。agy は止める。
- Codex の `/hooks` の審査では、元のコマンドは base64url の形で見える。Pleiad の行の詳細の「元のコマンド」で読める。
- 写した定義を元の定義に合わせて直す（同期）、写した定義をまとめて消す、は第 2 段では行わない。
