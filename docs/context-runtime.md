# 共通コンテキストの実行

2026-09-12。設定 › コンテキストで、指示・Skills・外部 MCP ごとに「エージェントに任せる」か「Pleiad がそろえる」を選ぶ。既定はエージェント任せ。2026-09-20 から設定は種類ごとに「すべての場所（既定）」と場所ごとの上書きで持つ（`docs/context-management.md`「保存と継承（形式 2）」）。外部 MCP については Pleiad 自身の登録（`<data>/mcp-servers.json`）も持つ。エージェント側の設定ファイルは書き換えない。

## セッションと適用範囲

担当は種類ごと・場所ごとに継承する（一番近い上書き、無ければ既定）。1 つの種類の担当は、その場所の home 側と作業場所側の探索結果に共通。片方だけをネイティブ、もう片方を Pleiad にすると二重読み込みになるため分割しない。

最初の送信時に担当・探索の計画・cwd を `store` の `contextSession.policy` に記録する（`{ version: 2, cwd, at, owners, plan, removedMcp?, refreshedAt? }`。形式 1 の `{ user, directory }` の記録も読める）。`at` は方針を決めた時刻で、会話の右パネルの「開始時（…）に決まり」に使う。既存の送信済み会話で記録がない場合は native を維持する（`policy.keepNative`。以後のターンも変えない）。

**設定の変更は次のターンから効く**（2026-09-23、issue #19）。以前は担当と探索の計画を会話の開始時に固定していたため、外部 MCP を登録したり MCP の担当を Pleiad に変えたりしても今の会話には出ず、「登録したのに使えない」と見えた。今はターンの開始ごとに、今の設定と作業場所で担当（owners）・探索の計画（plan）・`policy.cwd` を解き直す（`followSettings`。再開・バックエンド切り替え・分岐も同じ）。引き継ぐのは会話ごとの決めごとだけ: 開始時刻 `at`・`refreshedAt`・「この会話では外す」MCP（`removedMcp`）・`keepNative`。設定の変更で渡し方が変わった種類（担当か Pleiad が探す範囲。作業場所の変更だけなら数えない）があれば、履歴に `field: 'context'`（理由 `contextSettingsApplied`）を残し、`contextRefreshed`（`settings: true`）で会話に一行出し、`refreshedAt` を取り直す。渡し方はもともとターンごとに組み立てている（Claude はターンごとに `query()` を起こして `strictMcpConfig` などを渡し、Codex は Pleiad 担当のターンごとに app-server を起こす。ply_context の橋渡しもターンごとに開き、`tools/list` はその時点の登録を返す）ので、ターンの途中の反映は要らない。会話のあいだ agy を 1 本生かす antigravity だけは、担当と渡すツールの名前（橋渡しの `shape`）が前のターンと違えば agy を起こし直す（会話は `--conversation` で続く）。再開時に作業場所（cwd）を変えた場合も止めない。新しい場所の設定で解き直し、探し直した結果が変われば、下の自動の読み込み直しと同じく記録・pin・`refreshedAt` を取り直して知らせる。以前は cwd を固定して送信前にエラーにしていた（`共通コンテキストを使う会話の作業場所は固定です`）が、指示は毎ターン解き直して渡しているため技術的な必然性がなく、2026-09-23 に撤廃した。

指示と Skills は固定（pin）するが、**変わっていても送信は止めない**。送信時は毎ターン今のファイルで解き直しているので、違っていればそのまま新しい内容で続け、記録・pin・`policy.refreshedAt` を取り直したうえで、何が変わったかを変更履歴（`field: 'context'`）と会話の一行（`contextRefreshed` イベント）に残す（`core/server.mjs` の `runTurn`）。止める必然性が無いのは、指示本文は毎ターン指示欄へ渡し直しており、Skills はカタログ（名前・説明・ID）しか渡していないため。pin が守っているのは「右パネルの記録＝実際に渡したもの」という一貫性だけなので、記録を取り直して知らせれば足りる。

固定の対象は**指示の本文と、Skills のカタログ（名前・説明）**（`contextPin`）。Skill 本文のハッシュは含めない（`load_skill` が呼ばれるたびに今の本文を読んで渡すので、本文だけの編集では会話に何も起きない）。MCP は接続先の設定なので固定しない。毎ターン登録を読み直して接続するため認証の更新を反映できる。

### 新しい内容で会話を続ける（`refreshContext`）

送信を待たずに**今すぐ**最新の内容を読み込み直す操作（次の送信でも自動で読み込み直すので、右パネルで内容を確かめてから反映したいとき用）。今までのやり取りは引き継ぐ。会話の方針（担当・探索の計画）はそのままに、今のファイルで解き直して pin と記録を取り直し、`policy.refreshedAt` を残す。次のターンから新しい指示がバックエンドの指示欄（Claude の append・Codex の developerInstructions）に渡る。MCP の行は次のターンでつなぎ直すまで直前のターンの様子を残す。返答中は受け付けない（ターンの終わりに古い記録で上書きされるため）。

既存の仕組みとの関係: fork（分岐）は元の会話の `contextSession` を引き継ぐので、分岐した直後の pin は古いまま。バックエンドの切り替え（引き継ぎ）も方針と pin を保つ。どちらも次の送信で自動的に読み込み直される。

#### pin が動いたときの調べ方

固定の対象はその会話が使ったものではなく**探索結果すべて**（`contextPin`）なので、`~/.claude/skills/**` や `~/.codex/AGENTS.md` のような home 側の編集 1 件で、その内容と無関係な会話でも「変更あり」が出て、次の送信で読み込み直しが走る（送信は止まらない）。Skill 本文だけの編集では pin は動かない。

どのファイルが変わったかは `pinChanges` をそのまま呼んで確かめる（引数は `sessions.json` の `contextSession`）。送信時の自動の読み込み直しは、探索を二度走らせないために前後の記録を突き合わせる（`pinnedChanges`）。

```js
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pinChanges } from '../core/context-runtime.mjs';
const all = JSON.parse(await fs.readFile(path.join(os.homedir(), '.agent-host', 'sessions.json'), 'utf8'));
console.log(await pinChanges(all['<sessionId>'].contextSession, {}));
// -> { differs, paths, files: [{ path, before, after, modifiedAt }] }
```

`before` のハッシュで `<data>/context-snapshots/<sha256>.txt` を引けば開始時の本文が出るので、`diff` で中身の変化まで追える。

### 差分（`contextDiff`）

固定する指示・Skills の本文は、解いたときに `<data>/context-snapshots/<sha256>.txt`（内容のハッシュを名前にして 1 つずつ。0600）に残す。`contextDiff` は変わったファイルごとに開始時の中身（スナップショット）と今の中身を返す（256 KiB まで）。この版より前に始めた会話は開始時の中身が無く、`beforeMissing: true`。

### この会話では外す（`setSessionMcp`）

`{ sessionId, name, removed }`。方針の `removedMcp` に名前を足し（外す）、記録の行を `removed` にする。次のターンから、その MCP には接続せず（stdio なら起動もしない）、`ply_context` にもツールを出さない。ほかの会話・設定は変えない。返答中なら、走っているターンの記録も同じに直す（ターンの終わりに記録を書き戻すので）。`removed: false` で戻す（次のターンからつなぐ）。

ログインが要る MCP（要ログイン）は、ログインが済めば次のターンで自動でつなぎ直す（接続はターンごとに作り直すため。会話を作り直す必要はない）。返答の途中で追加されたツールをエージェントが読み直す口は無いので、走っているターンにはつなぎ足さない。

解析不正・探索上限・未展開の参照がある場合は、指示を落としたまま送信しない。同名の別 Skill / MCP は勝手に上書きせず、除外パスで選ぶよう案内する。同じ実体・適用範囲は重複排除し、CLAUDE.md の import は参照元の行を除いて展開先を一度だけ渡す。

## 指示と Skills

指示本文はバックエンドのシステム／developer 指示へ渡し、ユーザー発言や会話本文に混ぜない。合計128 KiBを上限とする。子階層の指示には `instructions_for_path` ツールを使うよう初期指示に明記し、実体パスが cwd 配下であることを検証してその範囲の指示を返す。Claude の rules のうち `paths` の無いものは `CLAUDE.md` と同じく開始時に渡す。`paths` 付きのもの（記録の状態は `conditional`）は開始時に本文を渡さず、glob の一覧と「当たるファイルを扱う前に `instructions_for_path` を呼ぶ」ことだけを初期指示に書く。`instructions_for_path` は求められたパスそのもの（まだ無いファイルでもよい。在る親の実体パスにつなぐ）が glob に当たる rules を、frontmatter を除いた本文と `Scope: files matching …（起点）` の範囲付きで返し、記録の行を `loaded` にする。ユーザーの rules の glob は会話の作業場所から見る。これはモデルが必要時にツールを呼ぶ方式であり、すべての任意のシェル内ファイルアクセスをフックする仕組みではない。

Skills は名前・説明・ID・元のディレクトリのみを一覧として渡す。`load_skill` は選択済み ID のファイルを必要時に読み、**そのときの本文**を返して記録の行のハッシュを渡した内容へ直す（開始時と違っても止めない。固定しているのはカタログだけなので、本文の編集はそのまま次の読み込みに効く）。スクリプト・参照は元のディレクトリを基準にし、コピーは作らない。ツール権限は緩和しない。`disable-model-invocation` はユーザーの依頼に `$名前` があるターンだけ公開。`context: fork` などネイティブ固有の実行設定は適用したことにせず、未対応として記録し公開しない。

`instructions_for_path` と `load_skill` は、同じ会話で渡し済みの本文を繰り返さない。渡した本文のハッシュを行の id ごとに `contextSession.delivered`（`{ backend, entries }`）へ残してターンをまたいで持ち越し、同じ本文なら `Already provided in this conversation: <パス> (scope: …). Not repeated. …` の一行だけを返す（記録の行は `loaded` のまま、`calls` に頼まれた回数）。ファイルが変わっていれば本文を「変わった」の一言付きで渡し直し、`full: true` なら必ず本文を返す。控えを捨てる（次は本文を渡し直す）のは、文脈の圧縮（Claude の `activity: compacting`）、履歴を引き継ぎの文で渡し直すターン（バックエンドの切り替え・ホスト側で写した分岐の最初のターン。`pendingHandoff`）、「新しい内容で会話を続ける」、編集して再送信（`fork` の `beforeMessageId`）。Codex・antigravity の圧縮は Pleiad から見えないので、エージェントが `full: true` で取り直す。**控えは指示欄のプロンプト（`contextTools` の `prompt`）に一切影響させない**。ファイルが同じならプロンプトはターンをまたいで同じバイト列のままにし、prompt caching を外さない（変わるのは末尾に積まれるツールの返りだけ）。

## MCP

公式 TypeScript SDK のクライアントで stdio / Streamable HTTP / SSE に接続する。Claude・Codex の既存登録を読み、command / args / cwd / env、URL / headers、Codex の環境変数ヘッダー・bearer token 環境変数をメモリ内で解決する。環境変数参照は `${VAR}` / `${VAR:-fallback}` / `${env:VAR}` に対応。Codex の enabled_tools / disabled_tools を反映する。不明な設定を黙って落とさずエラーにする。

接続はターンごとに1回。つながらない 1 件（要ログイン・起動失敗・接続失敗）はその場で外して会話を進め、状態と理由を記録する（`connected` / `needs-auth` / `failed`）。サーバー数32、公開ツール500（超える 1 件は外す）、初期接続の待機は最大60秒。同じ名前の外部 MCP が複数あるときは、設定で選んだ定義（`prefer`）、無ければ先に見つかった方を使い、残りは `shadowed`（`shadowedBy: 'choice'`）にする。Pleiad に登録した同名があれば Pleiad の登録が優先（`shadowedBy: 'ply'`）。終了・中断時に接続を閉じる。Pleiad と各バックエンド間の接続は `/mcp/context`。ターン限定のランダムな資格情報で認証し、別会話からの利用や終了後の利用を拒否する。サーバー名・ツール名の衝突を避けるため安定した ID を使い、説明には元の名前を添える。

ツールに加えて resources / prompts の一覧・取得を中継する。ツールしか使わないバックエンドにも `mcp_resources` / `mcp_prompts` で提供する。外部 MCP の stdout / stderr や認証値を利用記録には保存しない。認証が要る MCP は Pleiad に登録して Pleiad でログインする（OAuth 2.1: 保護リソースメタデータ・認可サーバーの探索、動的クライアント登録、PKCE、リフレッシュ。トークンは OS の鍵の保管庫で暗号化して保存。詳細は `core/mcp-oauth.mjs` の先頭のコメントと `docs/context-management.md`「外部 MCP の画面」）。エージェントのネイティブ登録の OAuth 設定や、他クライアントが持つトークン保管庫は読まない（「Pleiad に取り込む」で登録を写し、Pleiad でログインし直す）。ネイティブ登録の HTTP MCP が 401 を返したときは `needs-auth` とし、取り込みを案内する。sampling・elicitation・タスク・リソース購読は共通接続のクライアント能力として宣言しない。

Claude はネイティブの承認経路を使う。Codex の共通 MCP は Pleiad 側で外部ツール呼び出しを承認し、full / yolo のみ確認を省略する。ask / auto / readonly は呼び出しごとに元のサーバー名・ツール名・引数を表示して確認する。共通の指示・Skill 読み込みツールは選択済みファイルの読み取りだけを行う。

## バックエンドの抑止

| 対象 | Claude | Codex |
|---|---|---|
| 指示 | claudeMdExcludes（CLAUDE.md・CLAUDE.local.md・AGENTS.md・.claude/rules）、autoMemoryEnabled=false | project_doc_max_bytes=0 |
| Skills | skills=[]、disable-slash-commands、Skill を非公開 | 発見済み SKILL.md の skills.config.enabled=false |
| MCP | strictMcpConfig=true | ネイティブ登録を無効なプレースホルダーに置換 |
| 指示の注入 | claude_code preset append | thread developerInstructions |

Claude は設定ソースと権限を保持し、Pleiad 管理時は初期化結果を確認するまでユーザー入力を送らない。Codex は管理対象のターン専用 app-server を作り、共有 RPC や他会話の設定を書き換えない。Skills または MCP の共通管理では plugins を無効にするため、その影響を設定画面に明示する。元の設定ファイルを書き換える抑止は行わない。

Antigravity（agy）は、会話ごとのカスタムエージェント（Pleiad の置き場の `.agents/agents/ply-context/agent.md`、`--add-dir <置き場> --agent ply-context`）で Pleiad のコンテキストを受け取る（`core/backends/antigravity-context.mjs`）。本文に指示と Skills の一覧、`mcpServers` に ply_context への stdio 中継（`core/agy-context-relay.mjs`）を書き、Skills・MCP がエージェント担当なら `inheritCustomizations` / `inheritMcp` で agy 自身の読み込みを残す。カスタムエージェントはワークスペースの AGENTS.md・GEMINI.md を読まないため、**指示も Pleiad 担当のときだけ**受け取る。指示がエージェント担当のまま Skills か MCP だけを Pleiad にした組み合わせは、その会話をエージェント任せにして理由を記録に残す（`guardedBackend` / `reason`。設定画面の Skills・MCP のカードと会話の右パネルにも出る）。

## 利用記録と検証

`sessionContext {sessionId}` と会話の右パネル「この会話のコンテキスト」（会話の頭の札・タイトル行の入口から開く）で、指示の供給元、Skills の案内／使ったもの、MCP の接続成否・ツール数・呼び出し回数、要ログイン・失敗の理由、除外理由を確認できる。記録は「モデルが理解した」という推定ではなく、Pleiad が渡した／接続した事実。ネイティブ担当の内部一覧を共通記録に含めたとは扱わない。エージェント任せの MCP は、そのエージェントの設定に登録されているもの（`agentMcp`）を読み取りのみで並べ、接続の成否は Pleiad から見えないと書く。antigravity で Pleiad 担当を扱わなかった会話は、記録の `guardedBackend` と `reason` を出す。

戻りは `{ report, owners, pinned, changed, startedAt, refreshedAt, removedMcp }`。`report` が記録（外部 MCP の行には Pleiad の登録の認証方式 `auth` も付く）、`owners` はその会話が始まった時点の担当、`pinned` は固定の有無。`changed` は固定された会話でだけ行う今のファイルとの突き合わせで、`{ differs, paths, files }`（`differs` が正否、`paths` は変わったと分かったファイルの手掛かり、`files` は `{ path, name, kind, before, after, modifiedAt }`。会話中に `instructions_for_path` で読み足した子階層の指示が混じることがある）。ネイティブ担当の会話では探索を走らせず `null` を返す（`docs/design-system.md` §9）。

- `npm test -- context-runtime`：実 MCP クライアントと fixture、セッション分離・永続化・遅延読み込み。
- `npm test -- context-settings server-context`：形式 1 からの移行（意味が変わらない）、種類ごとの継承と即時保存、この会話では外す・読み込み直し・差分・エージェント任せの MCP。
- `node tests/manual/context-runtime-probe.mjs`：インストール済み3バックエンドの初期化・抑止を検証。モデルへの送信なし。
- `npm run test:e2e -- context-runtime`：3バックエンドの実サービスで共通指示・Skills・MCP の往復を確認。

一次資料：[Claude SDK](https://platform.claude.com/docs/en/agent-sdk/typescript)、[Codex configuration](https://learn.chatgpt.com/docs/config-file/config-reference)、[Agent Skills](https://agentskills.io/client-implementation/adding-skills-support)、[MCP TypeScript SDK](https://github.com/modelcontextprotocol/typescript-sdk/tree/v1.x)。
