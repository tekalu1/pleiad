# マルチバックエンド設計（v3）

途中のバックエンド切り替えは [backend-handoff.md](backend-handoff.md) を参照。
切り替え済み会話では会話IDとネイティブIDを分離し、本文の正本をアプリに移す（本書 §2.1 の例外）。

作成 2026-09-11。`design.md` §3「やらない: マルチプロバイダ」を**改訂する**。
Claude Agent SDK に加えて **OpenAI Codex**（公式 `codex` CLI の app-server）をバックエンドとして駆動できるようにする。
2026-09 に **Antigravity CLI**（`agy`）を足した（§2.8）。
同時期に入れた Gemini CLI（ACP）は、個人向けログインの終了により廃止した。

元になった調査: `temporary/inv-agent-host.md`（追跡外）。

---

## 1. 何が問題か

SDK は 2 つの役割を兼ねていた（棚卸しの結論）。

1. **実行エンジン** — `query()` を回してストリームを吐く。差し替えは `runTurn` 1 本で済む。
2. **セッション管理データベース** — 一覧・タイトル・状態タグ・履歴・fork・サブエージェントを
   `~/.claude` の JSONL に外注していた。codex には等価物が無い。

さらに `core/session.mjs` が **生の SDK メッセージを web へ素通し**しており、
`web/client.mjs` が Anthropic の API ストリーム型（`content_block_start` / `text_delta` …）を直接パースしていた。
これが唯一かつ致命的な境界の穴で、ここを塞げば web の 2800 行はほぼ無傷で残る。

## 2. 決めたこと

### 2.1 正本の所在（design.md §5 の再改訂）

| | 旧（v1） | 新（v3） |
|---|---|---|
| セッションの存在・一覧 | `~/.claude`（SDK `listSessions`） | **各バックエンドのネイティブ一覧 ∪ sidecar**。sidecar `sessions.json` が全バックエンド横断のインデックス |
| タイトル / 状態 | `~/.claude`（customTitle / tag） | **バックエンドがネイティブに持てるならそれが正本**（Claude: customTitle/tag、Codex: thread name）。持てないものは sidecar が正本。書くときは両方に書く |
| cwd / createdAt | SDK | ネイティブ優先、無ければ sidecar |
| 変更履歴・parent・statusChangedAt・mode・model・present | sidecar | 変わらず sidecar |

「ネイティブに持てるなら持たせる」を残す理由: Claude で公式 CLI / VS Code とタイトル・状態が共有される利点（design.md §5）は捨てない。
Codex も `thread/name/set` で公式クライアントとタイトルを共有できる。

**セッション id はバックエンドのネイティブ id をそのまま使い、行に `backend` を付ける。**
複合キーにしない（web の `s.id` 依存を壊さない）。衝突は実質起きない
（Claude: UUID、Codex: UUIDv7、Antigravity: UUID）。
サーバは `sessionId → backend` を sidecar で引き、無ければ各バックエンドの `getSession` を順に当てる。

### 2.2 core → web は正規化イベントだけを流す（プロトコル v2）

`sdk` イベントを廃止し、以下に置き換える。`PROTOCOL_VERSION` は **2**。

| type | ペイロード（`sessionId` は emitGlobal が必ず補う） | 置き換える旧経路 |
|---|---|---|
| `text.delta` | `{ text }` | `stream_event/text_delta` |
| `text.end` | `{ uuid? }` 確定した発言の id。走っている最中でも分岐の起点にできる（v3） | `assistant`（streamEl リセット） |
| `thinking.start` | `{ }` | `content_block_start(thinking)` |
| `thinking.delta` | `{ text?, estimatedTokens? }` | `thinking_delta` |
| `tool.start` | `{ id, name, input }` | `assistant` の `tool_use` |
| `tool.result` | `{ id, text, isError, truncated }` | `user` の `tool_result` |
| `activity` | `{ state: "thinking"\|"writing"\|"compacting"\|"waiting"\|"running"\|"idle", label? }` | `system/status`, `session_state_changed` |
| `turnResult` | `{ outcome: "ok"\|"error"\|"aborted", turns?, costUsd?, error? }` | `result` |
| `permission` | `{ id, kind: "tool"\|"question", toolName, input, title?, canAlways, questions? }` | 既存 + AskUserQuestion の特別扱い |
| `auth` | `{ backend, phase: "url"\|"done"\|"error", url?, message? }` | 新規（ログイン誘導） |
| `session` | `{ sessionId, first?, model? }` | 既存 + モデル通知 |
| `background` | `{ tasks: [{ id, kind: "agent"\|"shell"\|"terminal"\|"other", label, waitable? }] }` 裏で生きているタスクの**全量**。受けたら丸ごと置き換える。`ambient` のタスクは含めない。`waitable: true` = 終わりの通知が必ず来るので待てる（下の kind の表） | Claude `system/background_tasks_changed`（保険に `task_started` / `task_updated` / `task_notification`） |
| `phase` | `{ state: "active"\|"waiting" }` `waiting` = main は返答を終えて止まっていて、かつ裏のタスクが 1 本以上生きている。それ以外は `active` | 新規（main の区切りと上の一覧から導く） |
| `userMessage.delivered` | `{ messageId }` 途中送信が**エージェントに渡った**（走っているターンの会話に入った）。`messageId` は outbox の item の id | 新規（2026-09。Claude の replay、Codex の `item/started`） |
| `userMessage.dropped` | `{ messageId }` 受理した途中送信を、エージェントが読まないままターンが死んだ。server は送信待ちの保留へ戻す | 新規（2026-09。ターンの終わりより後に届くことがある。受け口は server と web に残るが、今これを出すバックエンドは無い） |

`present` / `status` / `title` / `fork` / `mode` / `model` / `running` / `turnEnd` はそのまま。

**`background` / `phase`（2026-09）**: どちらも変わったときだけ出る。ターンの中の裏（Claude: main がターンを保持したまま待つ）の印で、
`phase` を出さないバックエンド（Codex・Antigravity）はずっと `active` のまま扱う。server はターンごとに `phase` と `background` を持ち、`running` のターン行
（`{ kind: "turn", …, phase, background }`）に載せ、変わった時点で `running` を配り直す（4 秒ごとの定期便を待たない）。
web はこれを見て、一覧の行・畳んだ見出し・稼働表示の弧を衛星（design-system.md §6）に替える。
`waiting` の間もターンは終わっていない。同じ会話への送信は途中送信（`control.steer`）で届く。
**ターンが終わった後も裏が残る**バックエンド（Codex）は、これではなく §2.7 の会話単位の background を使う。

**`kind` の語彙（2026-09）**: web が衛星に数えるかどうかがここで決まる（`behindOfTasks`）。

| kind | 何 | 衛星に数えるか |
|---|---|---|
| `agent` | サブエージェント（Claude `local_agent`） | 数える |
| `terminal` | ターンをまたいで生きる端末（Codex `unified_exec`） | **数えない**（ターンの終わった後の設備。会話末尾の「バックグラウンド N」から開く） |
| `shell` | 裏のシェル（Claude `local_bash`） | `waitable: true` のときだけ数える |
| `other` | 上のどれでもない（ワークフロー・MCP タスクなど） | 数える |

`shell` の扱いは**終わりの合図があるかどうか**で分かれる（2026-09 に直した）。

- **Claude の `local_bash` は数える**。終わると必ず `system/task_notification`（と `background_tasks_changed`）が来て、
  CLI がそれで main を自動で再開させる。以前は数えずに入力を閉じていたが、**入力を閉じると CLI は数秒でそのコマンドを
  kill する**（`tasks/<id>.output` に `[killed]` だけが残り、「完了の通知が来たら報告します」が果たされない）。
  いまは `canCloseInput` が shell も待つので入力は開いたまま、完了通知で main が再開して報告できる。
  タスクには `waitable: true` を付けて出す。終わらないコマンド（`npm run dev`）の逃げ道はタイムアウトではなく
  作業ダイアログの**停止ボタン**（`stopBackground` → SDK の `Query.stopTask`）
- 見出し（`behindOfTasks` の `label`）は、全部 `agent` なら「サブエージェントを待っている」、
  全部 `shell` なら「バックグラウンドのコマンドを待っている」、混在なら「裏の作業を待っている」

**`running` の形（2026-09）**: `{ turns, permissions, subagents, background, count }`。
`background` は `[{ kind: "background", sessionId, backend, tasks, since }]`
（ターンの外で裏に残っている作業、§2.7）。`count` に `background` は入れない（下の理由）。
`subagents` の行は `{ id, kind: "subagent", sessionId, messages, description, saying, lastAt, status, startedAt, endedAt }`（2026-09-22 に後ろの 3 つを足した）。
`status` は `"running" | "completed" | "failed" | "stopped" | null`。`getSubagentState` を持たないバックエンド・分からない子は `null`。
`startedAt` / `endedAt` は ISO 文字列か `null`。終わった子もターンが終わるまでは一覧に残る（履歴化はしていない）。
`count` のサブエージェント分は **`status` が `"running"` か `null` の行だけ**を数える。終わった子を数えると更新のゲート
（web の `count > 0`）が閉じたままになる。`null` を数えるのは、状態を出さないバックエンドでゲートを緩めないため。
`turnEnd` は `{ completedAt, requeued? }`。`requeued: true` は完了ではない（§2.7 の requeue。`completedAt` は `null`）。

Claude の判定は `core/backends/claude-background.mjs`（SDK 非依存、`tests/unit/claude-background.mjs`）。
実測（`output/bg-tasks/claude-report.md` §3、2026-09、SDK 0.3.258 / Claude Code 2.1.268）に沿う:
main の開始は 2 回目以降の `system/init` とトップレベルの `message_start`、停止は `message_delta.stop_reason` が
`tool_use` / `pause_turn` / null 以外のときと `result`。`result` だけに頼らないのは、裏が残っている間の
`result` が保留されうるため。

**Claude CLI の事実（2026-09、SDK 0.3.258 / Claude Code 2.1.268 で実測）**:

- Pleiad は 1 ターン = 1 回の `query()`。文字列のプロンプトや 1 件で終わる generator では、SDK は最初の `result` の直後に CLI の stdin を閉じる
- 入力が閉じた CLI は裏の subagent を `CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS`（既定 600000）までしか待たない。超えると stderr に
  `Background tasks still running after 600s; terminating…` を出し、subagent を殺して終わる（実際の会話で 600 秒ちょうどで殺された）。
  `0` は上限なし。上限は**入力が閉じているときだけ**効く（入力を開けたままなら 15 秒の上限でも 43 秒の subagent は殺されなかった）
- 待っている間、CLI は完了した subagent 1 本ごとに main を自動で再開する（`system/init` → 返答 → `result`）。2 つ目以降の `result` は保留されうる
- 入力を閉じると、裏の Bash は main の最後のターンから約 5 秒後に止められる。
  出力ファイル（`%TEMP%/claude/<project>/<session>/tasks/<id>.output`）には `[killed]` だけが残る
- 裏の Bash（`local_bash`）も終われば `system/task_notification` を出し、CLI はそれで main を自動で再開させる。
  subagent と同じ扱いでよい（2026-09 に確認）
- SDK の `env` は環境を**置き換える**（足し算ではない）。`process.env` を必ず広げる
- そこで Pleiad は入力を async generator で開けたままにし、main が止まっている・裏のタスクが 1 本も無い・流し込んだメッセージが残っていない、
  の 3 つが揃ったとき（と中断のとき）だけ閉じる。上限も `0` にして外し、CLI の stderr はサーバのコンソールへ出す
- **閉じた入力は開き直せない。まだ続くターンで閉じると host の口だけが黙って死ぬ**（2026-09 実測）。
  SDK MCP サーバ（`mcp__host__*`）の結果も `canUseTool` の返事も、ホストから CLI へは stdin で戻る。
  閉じた後の書き込みは SDK が黙って捨てる（`ProcessTransport: Dropping write to ended stdin stream`）ので、
  CLI 側は答えを待てず `The tool call was interrupted before a result was received` /
  `Tool permission request failed: AbortError: Stream closed` になる。CLI 内蔵のツールは stdin を使わないので動き続け、
  **fork / set_status / set_title と承認だけが落ちる**。SDK は最初の `result` まで閉じるのを遅らせる（`waitForFirstResult`）ため、
  事故は「`result` を 1 回見た後＝CLI が main を自動で再開しうる場面」に限られる
- そのため Pleiad は (1) host ツール・承認が走っている間は閉じない、(2) 裏の作業を一度でも見たターンでは、
  3 つが揃ってからさらに `RESUME_GRACE_MS`（5 秒）待ってから閉じる。main の自動再開は実測 0〜80ms だが、
  混んだセッション（agent teams・長い履歴）では 2.5 秒かかるのを観測した。ambient のタスクは一覧には出さないが
  「再開がありうる」印としては数える（ただし終わらないものがあるので、閉じる判定そのものは止めない）
- 開いた入力への途中送信（既定の priority = `next`）: main が作業中なら**次のツール結果の区切り**で同じターンに折り込まれ、
  そのターンの中で答える。承認を待っている間に流した分も、承認が返った区切りで同じターンに入る。
  main が止まっていれば（裏の subagent が走っていても）止まっていること自体が区切りになり、約 1.6 秒で折り込まれてすぐ答える
  （`priority: "later"` と同じ速さ。実測 2026-09、CLI 2.1.273）。どの場面でも遅れないので、Pleiad は場面で出し分けず常に `next` で流す
- 折り込まれた瞬間はストリームに合図が無い。`--replay-user-messages`（`extraArgs`）を付けると、折り込みと同時に
  `{ type:'user', isReplay:true, message:{ role:'user', content:'<文字列>' } }` が流れる。流れるのは最初のプロンプトと
  自分が流し込んだ分だけで、CLI 内部の通知（task-notification など）は replay されない。Pleiad は流し込むフレームに毎回新しい
  `uuid` を付け、replay の `uuid` で突き合わせて `userMessage.delivered` を出す（画面の「まだ渡っていない」はこれで消える）。
  区切りが来ないまま内部ターンが終わると、CLI は溜まった分を**まとめて**次の内部ターンとして取り出し、本文を `
` でつないだ
  replay を最後のメンバーの `uuid` で 1 本出す（メンバーごとの replay は `uuid` 付きのフレームにだけ出る。実測 2026-09-23、CLI 2.1.280）。
  答えは同じ Pleiad ターンの中で流れる。本文だけで照合していたころはこれを取りこぼし、答えが返っても「渡します」が残った。
  保険として本文の一致・つないだ本文の分解でも拾い、それでも残った分は `result` の後の `system/init`（次の内部ターン）で渡ったことにする
- 折り込まれた発言は transcript に `attachment`（`{ type:'queued_command', prompt, commandMode:'prompt' }`）として残り、
  `getSessionMessages` は返さない（`includeSystemMessages` でも返さない）。`timestamp` は流し込んだ時刻で直前の行より古く、
  時刻では並べ直せない。Pleiad は `parentUuid` の鎖を遡って `getSessionMessages` に出ている最初の祖先を探し、その直後へ差し戻す
  （`claude-normalize.mjs` の `mergeQueuedCommands`）。区切りが来ないままターンが終わった分は待ち行列から外れ、
  普通の user 行として残って次のターンで答えられる（両方に残る形は観測していない＝二重にならない）
- 入力を閉じた後も、CLI は stdin で受け取り済みのメッセージを処理してから終わる。閉じる判定で「取りかかった」と早めに数えても取りこぼさない
- 中断は `Query.interrupt({ cancelQueued: true })`（Esc と同じ。d.ts の型に引数は無いが SDK 0.3.258 の実装は受ける）。stdin を閉じるだけでは
  CLI は今の仕事と待ち行列を片付けてから終わり、Windows の SDK は abort から 2 秒 + 5 秒後に claude.exe を kill するまで動き続けていた
  （2026-09-23 調査）。そのため SDK には server の AbortController を渡さず、自前のものを渡す（渡すと中断の瞬間に stdin が閉じ、
  interrupt を書けない）。interrupt の応答か `result` が 2.5 秒のうちに来なければ、入力を閉じて SDK の abort に落とす。受領の後は入力を閉じ、
  3 秒のうちに終わらなければ同じく落とす。結果はどちらでも `turnResult aborted`。応答の `cancelled` にある `uuid`（折り込まれる前に取り消された
  途中送信）は `userMessage.dropped` にする。プロセスツリーごとの強制終了はしない（pid は `spawnClaudeCodeProcess` で自前に起動したときしか取れない）
- `result` は 1 回の query で何度も出る。`total_cost_usd` と `modelUsage` は query 全体の累計で単調に増える（上書きで二重計上にならない）。
  turnResult は「ターンが終わった」の合図なので、Claude は成功の turnResult を query の終わりに 1 回だけ出す
  （途中で出すと server がターンを終わりかけと見なし、途中送信を止める）
- 裏の subagent の完了通知は、main を再開させるための user メッセージ（`<task-notification>…`、`origin.kind: task-notification`）として
  transcript に残る。`getSessionMessages` は `origin` を落とすので、履歴では中身で見分けて発言にしない

**`session` の `first`**: 「このターンで id が確定した」ときにだけ `true` を付ける。
新規セッションの 1 本目と、再開したつもりの id が変わったときだけ。
モデルが分かっただけの 2 本目や、再開ターンが形を揃えるために出す 1 本には**付けない**。
web の `isMine` は新規セッションの id を `first` の付いた session からしか採用しない
（付いていないものまで採ると、別タブが新規の id を待っている最中に
再開ターンの id を掴んで、自分が始めた会話が行き先を失う）。`model` の有無では判別できない
（新規でも init が最初に来れば id とモデルが同時に確定する）。

v3 で `statusIcon { status, icon }`（状態グループのアイコン。sidecar `statuses.json`）、`lineage`、`setStatusIcon`、runTurn の `status`、`text.end` の `uuid` を足した。`PROTOCOL_VERSION` は **3**。

**`permission.kind === "question"` の `questions` の形**（web の questionCard が読む形。Claude の AskUserQuestion 入力をそのまま正規形にする）:

```jsonc
questions: [{ question, header?, multiSelect?, options: [{ label, description?, preview? }] }]
```

回答は `resolvePermission { id, allow: true, answers: { [question]: "a, b" }, annotations? }`。
バックエンドが自分の形（Codex なら `item/tool/requestUserInput` の response）へ戻す。

### 2.3 `AgentBackend` インターフェース

`core/backends/<id>.mjs` が 1 つずつ export する。`core/backends/index.mjs` がレジストリ。

```js
export const backend = {
  id: "claude" | "codex" | "antigravity" | "fake",
  label: "Claude Code",
  capabilities: {
    title: bool,        // ネイティブにタイトルを持てる（持てなければ sidecar が正本）
    tag: bool,          // ネイティブに状態タグを持てる
    fork: bool,
    subagents: bool,
    liveModel: bool,    // 実行中にモデルを切り替えられる
    liveMode: bool,
    hostTools: bool,    // set_status / set_title / fork を AI 側から呼べる。present は §2.6
    alwaysAllow: bool,  // 「常に許可」を返せる
    login: bool,        // auth.login がある
  },

  // ---- 語彙（UI はこれを <select> に流し込むだけ。値の意味は知らない）
  modes(): { [id]: { label, note } },          // 承認モード。id はバックエンドごとに違ってよい
  models(): Promise<{ [id]: { label, note } }>,// "" は「既定に従う」

  // ---- 実行
  runTurn({ prompt, sessionId, cwd, mode, model, emit, askPermission, signal, control })
    : Promise<{ sessionId }>,   // 新規なら確定した id を返す。途中で `session` イベントも出す
                                // 新規に最初から付ける状態（web の runTurn args.status）は server が session イベントで書く。バックエンドは知らない
  abort?(handle),                // signal で足りるなら省略
  setModelLive?(handle, model): Promise<boolean>,
  setModeLive?(handle, mode): Promise<boolean>,

  // ---- セッション管理
  listSessions({ limit }): Promise<Array<{ sessionId, title, cwd, createdAt, lastModified, tag?, parent? }>>,
  getSession(id): Promise<{ sessionId, title, cwd, createdAt, lastModified, tag? } | null>,
  getMessages(id): Promise<NormalizedMessage[]>,   // history.mjs の messages と同じ形
  setTitle?(id, title): Promise<void>,
  setTag?(id, tag | null): Promise<void>,
  fork?(id, { upToMessageId?, title? }): Promise<{ sessionId }>,
  listSubagents?(id): Promise<string[]>,
  getSubagentMessages?(id, agentId, { limit }): Promise<NormalizedMessage[]>,
  getSubagentOrigin?(id, agentId): Promise<string | null>,  // 生んだ委譲ツールの tool_use id。実行中一覧の見出しを引く
  getSubagentState?(id, agentId): Promise<{            // 2026-09-22。実行中一覧の状態の印（design-system.md §2.2）
    status: "running" | "completed" | "failed" | "stopped",
    startedAt: string | null, endedAt: string | null,   // ISO 文字列
  } | null>,                                            // null は「分からない」。describeBackends の capabilities.subagentState
  suggestTitle?({ transcript }): Promise<string>,  // 小さいモデルで 1 発

  // ---- 認証
  auth?: {
    status(): Promise<{ loggedIn: bool, account?: string, detail?: string }>,
    login({ emit }): Promise<void>,   // emit({type:"auth", phase:"url", url}) で URL を出し、完了まで待つ
    logout(): Promise<void>,
    submitCode?(input): Promise<void>, // コールバックが取れないときの手貼り（今これを持つバックエンドは無い）
  },

  // ---- 表示ヒント（web/render.mjs の TOOL_LABEL を補う）
  toolHints?: { [toolName]: { label, shape: "shell"|"read"|"write"|"edit"|"search"|"delegate"|"web"|"generic" } },
};
```

`askPermission(req) → Promise<{ allow, always?, message?, answers?, annotations? }>` の形は現状のまま。
承認の保留・猶予・中断（design.md §8.5）は `server.mjs` に残し、**バックエンドは触らない**。

`getSubagentState` は 4 秒ごとの `runningWork()` から呼ばれる。**重い I/O をしない**こと。Claude は
そのターンで流れている SDK メッセージだけで答える（`claude-background.mjs` の `createTurnTracker` が
`task_started` / `task_updated` の `patch.status`・`patch.end_time` / `task_notification` の `status` を記録し、
task_id = agentId で引く。SDK の語彙は completed→completed、failed→failed、killed・stopped→stopped、
pending・running・paused→running）。前面で待った子で task 系の終わりが来ない場合に備え、委譲ツールの
`tool_use_result`（`sdk-tools.d.ts` の `AgentOutput`）の `status: "completed"` でも完了とみなす。
裏に回した子の結果は起動直後に `status: "async_launched"`（本文は "Async agent launched successfully."）が来るので完了にしない。
親 transcript は読まない（走っている間は mtime が毎回変わり、最悪 9MB を 4 秒ごとに読み直すことになる）。
`core/conversations.mjs` が Pleiad の会話 id をネイティブ id に訳して渡し、合成会話では `null` を返す。

`NormalizedMessage` は `history.mjs` が既に返している
`{ role, text, uuid, at, thinking?, toolCalls?: [{ id, name, input, result }] }`。

### 2.4 sidecar の拡張

`~/.agent-host/sessions.json` の Entry に足す: `backend`, `title`, `status`, `cwd`, `createdAt`, `lastModified`。
`title` / `status` は capabilities に応じて「ミラー」か「正本」かが変わるが、**書き込みは常に両方**。
読み出し規則: どちらも「持てる方が正本、無ければもう片方へ落ちる」で揃える。
`capabilities.title ? (native.title ?? sidecar.title) : (sidecar.title ?? native.title)`、
`capabilities.tag ? native.tag : sidecar.status`。
`capabilities.title` / `capabilities.tag` は `describeBackends` が `setTitle` / `setTag` の実在と AND する
（書き口の無い宣言は「持てない」と同じ）。

sidecar 側の `setMode` / `setModel` は `exclusive()` を通す（既存の read-modify-write 交錯を直す）。

### 2.5 バックエンド別の対応表

| | Claude | Codex |
|---|---|---|
| プロセス | in-process SDK | `codex app-server`（stdio JSON-RPC 2.0、**1 プロセスを全セッションで共有**、threadId で多重化、落ちたら再起動） |
| 新規 | `query({prompt})` | `thread/start {cwd, model, approvalPolicy, sandbox}` → `turn/start` |
| 再開 | `resume` | `thread/resume {threadId}` → `turn/start` |
| 本文 | `text_delta` | `item/agentMessage/delta` |
| 思考 | `thinking_delta` | `item/reasoning/summaryTextDelta` |
| ツール | `tool_use` / `tool_result` | `item/started` / `item/completed`（`commandExecution`, `fileChange`, `mcpToolCall`, `webSearch` …）+ `item/commandExecution/outputDelta` |
| 承認 | `canUseTool` | server request `item/commandExecution/requestApproval`, `item/fileChange/requestApproval`, `item/permissions/requestApproval` → response で返す |
| 質問 | `AskUserQuestion` | `item/tool/requestUserInput` |
| 中断 | `Query.interrupt({ cancelQueued })`（応答が無ければ AbortController） | `turn/interrupt` |
| 完了 | `result` | `turn/completed` |
| 一覧 | `listSessions` | `thread/list`（name, cwd, createdAt, updatedAt, forkedFromId） |
| 履歴 | `getSessionMessages` | `thread/read {includeTurns:true}` |
| タイトル | `renameSession` | `thread/name/set` |
| 状態タグ | `tagSession` | 無し → sidecar |
| fork | `forkSession` | `thread/fork` |
| モード | `default/auto/acceptEdits/plan/bypass`（`bypass` は SDK の `bypassPermissions`。`allowDangerouslySkipPermissions: true` を同時に渡す） | `approvalPolicy` × `sandbox` の組を id 化: `ask`(untrusted/workspace-write) / `auto`(on-request/workspace-write) / `full`(never/workspace-write) / `yolo`(never/danger-full-access) / `readonly`(on-request/read-only)。各 turn/start にも承認と sandbox の設定を送る |
| モデル | fable/opus/sonnet/haiku（SDK のエイリアス。実 ID への解決は SDK） | `model/list` |
| host ツール | in-process MCP。可視化は共通参照 | 可視化は共通参照（§2.6） |
| 認証 | Claude Code のログイン | `account/read` / `account/login/start {type:"chatgpt"}` → `authUrl` → `account/login/completed` / `account/logout`。**`~/.codex/auth.json` は codex が書く** |

#### 承認モードの2軸

モード名はバックエンドごとに違って比べられないので、各 `modes()` は**軸の値**も一緒に返す。
強さの比較と委譲の規則は `core/modes.mjs` にまとめてあり、エージェントを足すときに触るのは
そのバックエンドの `MODES` だけで済む（`docs/agent-delegation.md` の「会話・権限・作業場所」）。

- **範囲 (`scope`)**: どこまで触れるか。`none` < `readonly` < `workspace` < `full`
- **自律 (`autonomy`)**: 人にどれだけ聞くか。`ask` < `judge` < `never`
- **強制 (`enforced`)**: その範囲を sandbox 等で機械的に強制できるか。できないなら「約束」にすぎない

| バックエンド | モード | 範囲 | 自律 | 強制 |
|---|---|---|---|---|
| Claude | `default` | workspace | ask | – |
| Claude | `auto` | workspace | judge | – |
| Claude | `acceptEdits` | workspace | judge | – |
| Claude | `plan` | none | ask | – |
| Claude | `bypass` | full | never | – |
| Codex | `ask` | workspace | ask | ✓ |
| Codex | `auto` | workspace | judge | ✓ |
| Codex | `full` | workspace | never | ✓ |
| Codex | `yolo` | full | never | – |
| Codex | `readonly` | readonly | judge | ✓ |
| Antigravity | `yolo` | full | never | – |

強制できるのは sandbox を持つ Codex だけ。Claude・Antigravity の範囲は宣言であり、
超えたことを機械的に止める手段が無い。委譲の規則はこの違いを見て「聞くかどうか」を変える。

Codex の app-server プロトコルは `codex app-server generate-json-schema --out <dir>` で得られる
（`temporary/codex-schema/`、追跡外）。`ClientRequest` / `ServerRequest` / `ServerNotification` の `method` を正とする。

**P2a の実装で分かった、この表からの実際のずれ**（codex-cli 0.153.2 で確認）:

- `AskForApproval` に **`on-failure` は無い**（`untrusted` / `on-request` / `never` / `granular` の4つ）。
  上の表の auto を `on-failure` としていたのは古い。聞く回数の順が保たれるよう
  `ask`=untrusted / `auto`=on-request / `full`=never / `readonly`=on-request+read-only に割り当てた。
- **`Thread` / `Turn` の時刻は「秒」**。スキーマは `int64` としか言わないので ms と読めてしまうが、
  そのまま使うと一覧が全部 1970 年になる（実機で確認）。`startedAtMs` のように名前に `Ms` が付くものだけミリ秒。
- 承認の応答は**種類ごとに形が違う**。`item/commandExecution` と `item/fileChange` は `decision`
  （`accept` / `acceptForSession` / `decline` / `cancel`）だが、
  **`item/permissions/requestApproval` は `decision` を持たず** `{ permissions, scope: "turn"|"session" }` を返す。
- `item/fileChange/requestApproval` の params は `itemId` しか運ばない。何を許すのかを承認カードに出すには、
  先行する `item/started` で見た item を覚えておく必要がある。
- `account/login/completed` 通知は **`threadId` を持たない**。スレッドへの振り分けでは拾えない。
- **サブエージェント（multi_agent。版はモデルごとに決まり、gpt-6-astra は v2）は子スレッドで動き、承認と質問は子の `threadId` で来る**
  （`item/*/requestApproval`、`item/tool/requestUserInput`、`mcpServer/elicitation/request`）。`codex-rpc` は
  `thread/started`（`parentThreadId`、`source.subAgent.thread_spawn.parent_thread_id`）、`collabAgentToolCall`（spawnAgent の
  `receiverThreadIds`）、`subAgentActivity`（`agentThreadId`）から子 → 親を覚え、孫もたどって、attach 済みの親の会話へ回す。
  承認カードの `title` に「サブエージェント <agent_path から `/root/` を外したもの>」を添える。親が外れていれば（ターン終了後）
  今までどおりエラーを返す。子の通知（本文・ツール・turn）は親の本文やツールとして出さない。承認カードに載せるアイテムだけ覚える。
  子の通知が親と同じ接続に流れることは、スキーマからの推定で、実機ではまだ確かめていない。
- **サブエージェント一覧（実行中一覧・子の会話ダイアログ）に載せる**（2026-09、`capabilities.subagents: true`）。
  - `listSubagents(threadId)` = `thread/list { parentThreadId, limit: 100 }` の子と、実行時に覚えた子（`rpc.parents`、
    親の `subAgentActivity` / `collabAgentToolCall`）の**和**。前者は app-server の永続化の間合いに、後者は子の通知が
    この接続に流れるかに依存するので、どちらにも寄りかからない。**返ってきた行は `parentThreadId` で絞り直す**
    （このパラメータを知らない版は黙って無視して普通の一覧を返しうる）。行が `parentThreadId` を持たない・パラメータを撥ねられた
    版では以後 `thread/list` を使わず、実行時に覚えた子だけに落ちる。`sourceKinds` は不要（`parentThreadId` だけで子が返る）。
    既定の `thread/list`（左の一覧）には子は出ない。
  - `getSubagentMessages` = `thread/read { threadId: 子, includeTurns: true }` → `threadToMessages`。子であること
    （`parentThreadId` / `thread_spawn.parent_thread_id`、無ければ実行時に覚えた親）を確かめてから返す。`agentId` は形も確かめる。
    `limit` を超えたら先頭と末尾を残す（Claude と同じ）。子には `userMessage` が無い（依頼文は親から注入されて item にならない）。
  - `getSubagentOrigin` = 親の `subAgentActivity(kind=started, agentThreadId)` の `id`（= spawn の function call id `call_…`）、
    無ければ spawnAgent の `collabAgentToolCall` の `id`。どちらも `tool.start` の `event.id` と同じ item id。
  - `getSubagentState` = `subAgentActivity.kind`（started/interacted → running、completed → completed、interrupted → stopped）と
    `collabAgentToolCall.agentsStates`（pendingInit/running → running、completed、errored → failed、shutdown/interrupted → stopped、
    notFound は分からない）。後から来たものが勝つ。時刻は実行時なら通知の `startedAtMs` / `completedAtMs`、履歴なら子の Thread の
    `createdAt` / `updatedAt`（無ければ親のターンの時刻）。
  - server は 4 秒ごとに全部を呼ぶ。一覧は 2 秒、親の items（origin / 状態を通知で見ていない子のため）は 10 秒覚える。
    親が native の接続で走っている間の状態は通知だけで答える。終わった子の本文は `updatedAt` が変わらなければ読み直さない。
    `useStateDbOnly` は付けない（走っている子が state DB に入る間合いが未確認。実機 0.153.2・rollout 875 本の環境で、
    付けなくても `thread/list { parentThreadId }` は 1〜2ms で返った）。
  - 委譲カード: `subAgentActivity` / `collabAgentToolCall` を `{ label: "委譲", shape: "delegate" }` で描く（`subagentTools` も同じ 2 つ）。
    `description` は `agent_path` から `/root/` を外したもの（started 以外は「（完了）」などを添える）。
    `collabAgentToolCall` は `prompt` / `model` も渡す（spawn の開始時は `receiverThreadIds` が空なので、見出しは prompt の 1 行目）。
- **thread/start の応答待ちの間は、見知らぬ `threadId` の frame を預かる。** 応答の id と一致したものだけを、届いた順に新しいセッションへ渡す（`adopt`）。
  残りは捨て、request にはエラーを返す。`threadId` を持たない通知は受け皿に渡さない。

**codex の実行ファイル**は `AGENT_HOST_CODEX_BIN`（既定 `codex`）。
**agy の実行ファイル**は `AGENT_HOST_AGY_BIN`（既定 `agy`）。
**agy の `--print-timeout`** は `AGENT_HOST_AGY_PRINT_TIMEOUT`（既定 `24h`。Go の duration 文字列。§2.8）。

### 2.7 ターンの外: 会話に残る裏の作業（2026-09）

Claude は裏の subagent を待つ間ターンを保持する（§2.2 の `phase: waiting`）。Codex は違い、
**バックグラウンド端末（issue #6）がターンの終わった後も残る。**
ターンの外に残る作業を扱うために、server はバックエンドに口を渡す。バックエンド非依存で、今は Codex が使う。

```js
backend.attachHost?.(host)   // server の起動時に 1 回。wrapBackend の後の各バックエンドに渡す
host = {
  background(sessionId, tasks),  // その会話でターンの外に残っている裏の作業の全量（tasks は §2.2 background と同じ形）。空で消える
  event(sessionId, event),       // ターンの外で起きた、会話に属する正規化イベント
}

backend.stopBackground?.(sessionId, taskId)   // その裏の作業を 1 本止める -> { stopped }。WS の stopBackground コマンドから
backend.getBackgroundTask?.(sessionId, taskId) // WS loadBackground から端末の詳細を読む。停止や再開はしない
```

`stopBackground` / `loadBackground` が探す先は 2 つある（server の `findBackgroundTask`）。
ターンの外に残っているもの（`runtime.background`。Codex）と、**走っているターンが抱えているもの**
（`turn.info.background`。Claude の `phase: waiting`）。画面はどちらも作業ダイアログの同じ行として並べる。

**Claude の停止**（`core/backends/claude.mjs`、2026-09）: バックグラウンドのコマンドはターンが保持しているので、
止める相手は走っている `query` そのもの。会話 id → `Query` の表（`liveQueries`）を持ち、`Query.stopTask(taskId)` を叩く。
CLI は `status: "stopped"` の `task_notification` を返し、tracker がそれで一覧から消す（**先回りして印を消さない**）。
SDK の `perTaskStopAffordance` は**宣言しない**。宣言すると中断（interrupt）がバックグラウンドのタスクを
殺さなくなり、「中断はターンごと」の約束が変わってしまう。`stopTask` はこの宣言なしで効く。
出力の取得（`getBackgroundTask`）は持たないので、詳細は「出力の取得に対応していません」と出る。

`sessionId` は**Pleiad の会話 id**（`runTurn` の `hostSessionId`）。バックエンドを乗り換えた会話では
ネイティブ id と別物なので、通知を引く鍵と報告先を分けて持つこと。

**`event`（2026-09）**: ターンを作らずに正規化イベントを 1 件だけ会話へ流す。`running` にも使用量にも出ない。
通せるのは `tool.result` だけ（server の `OUTSIDE_TURN_EVENTS`）。用途は 1 つで、Codex のバックグラウンド端末が
ターンの終わったずっと後に終わったとき、走ったままに見えているツールカードへ結果を差し込むこと。
何でも流せる口にはしない（本文や `turnResult` をターンの外から出すと、web の吹き出しと稼働表示の前提が崩れる）。

**会話単位の background**（`setBackground`）:
- server は `runtime.background` に会話ごとに持ち、`running.background` に載せる。変わったらすぐ `running` を配る。これがある間は 4 秒の定期便も回る
- `count` には入れない。デスクトップは `count > 0` の間は終了させない。ターンの外の作業（dev サーバの端末など）に終了を塞がせない
- web: ターンが走っていない会話でも、待てるもの（§2.2 の `behindOfTasks`）が 1 本以上あれば衛星（一覧の行・畳んだ見出し・稼働表示）。
  ターンが走っていればターン行が優先（弧、または Claude の `waiting` なら衛星）。中断は出さない。
  Codex の端末は `kind: "terminal"` で待てるものに数えないので、端末だけなら衛星は出ない（会話末尾の「バックグラウンド N」から開く）

**requeue**（送れなかった）:
- server がターンを始められない（同じ会話が走っている・裏の作業が残っている・同時ターンの上限）とき、委譲の依頼と完了通知は `'requeue'` を返し、
  後で送り直す（[agent-delegation.md](agent-delegation.md)）
- バックエンドの `runTurn` が `{ requeue: true }`（相手が別のターンを走らせていて何も届かなかった）を返す口も残っている。今これを返すバックエンドは無い
- その場合 server は完了として扱わない: 使用量も `completedAt` も残さない、後続の送信待ちも保留しない。`turnEnd { requeued: true, completedAt: null }` を出す
- message-queue はその送信を `queued` に戻し、会話が空いたら改めて kick する
- web は出していた吹き出し（`userMessage` の `messageId`）を引っ込め、送信待ちの側に出す（届いてから改めて出る）

procway-code への対応は 2026-09 に終了した（旧会話は読むだけ。`core/backends/index.mjs` の `RETIRED`）。

**Codex での対応**（`core/backends/codex.mjs`、`core/backends/codex-background.mjs`、issue #6）:
- Codex の `unified_exec`（既定で有効）が起こした端末は、**ターンが終わっても動き続ける**（dev サーバ、`python -m http.server` など）。
  `turn/completed` は端末の終了を待たずに届き、端末の `item/completed` は**終わったターンの turnId のまま**、数分〜数十時間後に届く
- 見張りは**スレッドごと**で、`runTurn` の attach / detach とは独立に `rpc.onNotify`（全通知の聞き手）で受ける。
  以前は detach 以降の通知を捨てていたので、ターンが終わると同時に印が消え、ツールカードは「実行中」のまま残っていた
- 数え方: `item/started` で見た `commandExecution` のうち、`turn/completed` の時点で終わっておらず、`processId` を持つか
  `source` が `unifiedExec*`（`CommandExecutionSource` = `agent` / `userShell` / `unifiedExecStartup` / `unifiedExecInteraction`）のものを
  `kind: "terminal"` として持つ。`processId` は `item/started` で null のことがあるので `item/commandExecution/terminalInteraction` で補う
- 引くのは遅れて届いた `item/completed`。同時にその結果を `host.event` で会話へ流し、終わったターンのツールカードに差し込む
- `turn/completed` が来ない終わり方（`error` 通知・中断）でも `runTurn` の `finally` が裏へ回す
- **全部消す**のは app-server が落ちた・入れ替わったとき（`CodexRpc.onDown`。走っていた端末は道連れ）。
  contextRuntime のターンはターンの終わりに app-server ごと落とすので見張らない。`ephemeral`（タイトル生成）も数えない
- 見張るのは Pleiad が 1 度でもターンを回したスレッドだけ。子スレッド（サブエージェント）の通知も同じ接続に流れてくるが、
  会話を持たないので数えない（親のターンをまたぐ子は、親スレッド 18 本・親ターン 208 本の記録で 0 件。出てきたら同じ仕組みに `kind: "agent"` で足す）
- **`waiting` には数えない**。Codex は `phase` を出さず、端末が残るのはターンが終わった後。`running.background` には残すが、端末だけなら衛星もAIの経過時間も出さない。会話ヘッダーの「端末 · 件数」から開く。
  `ThreadStatus.activeFlags` は `waitingOnApproval` / `waitingOnUserInput` の 2 つだけで、「裏で走っている」を表す値が無い
- **照合**（`thread/backgroundTerminals/list`）: 取りこぼした終了を引くために、端末を数えている間だけ 60 秒ごとに問い合わせる
  （`AGENT_HOST_CODEX_RECONCILE_MS`）。**`generate-json-schema` の出力には現れない**（experimental）。
  実機に直接問い合わせ、端末を 1 本起こして確かめた形（codex-cli 0.154.0-alpha.6.2、2026-09-16）:

  | method | 引数 | 応答 |
  |---|---|---|
  | `thread/backgroundTerminals/list` | `{ threadId, cursor? }`（cursor は数字の文字列） | `{ data: [...], nextCursor: string\|null }` |
  | `thread/backgroundTerminals/terminate` | `{ threadId, processId }`（processId は数字の文字列） | `{ terminated: boolean }` |
  | `thread/backgroundTerminals/clean` | `{ threadId }` | `{}` |

  `data` の要素: `{ itemId, processId, command, cwd, osPid, cpuPercent, rssKb }`。
  `itemId` は `commandExecution` の id そのものなので、数えているものとそのまま突き合わせられる。

  一覧は**ページング**なので `nextCursor` を最後まで追う。**途中までのページで引いてはいけない**
  （次のページに居るだけの生きている端末を消すと、issue #6 の症状に戻る）。読み切れなければ何もしない。
  スレッドが**ロード済み**でないと `thread not found` になる（Pleiad は毎ターン resume するので通る）。
  古い版（0.147.0 で確認）はこの method を持たない。**「そんな method は無い」は `-32601` ではなく `-32600` +
  `unknown variant`** で返るので、そちらで見分ける。`-32600` でも `thread not found` は一時的な事情なので、
  そのスレッドを 1 回飛ばすだけにして、照合そのものは止めない
- **読む**（`loadBackground`）: 一覧の行を押すとコマンド・作業場所・起動時刻・出力を開く。Codex の出力は `item/commandExecution/outputDelta` をターン前後とも追跡し、末尾64K文字まで保持する。詳細を開いている間だけ取得する。終了後は最後に取得した内容であると明記する。
- **止める**（`stopBackground`）: 一覧・詳細の独立した停止ボタンから 1 本ずつ止める。行クリックでは停止しない。
  `background` の tasks の id は `commandExecution` の itemId だが、codex が求めるのは **processId** なので、
  見張りが覚えているものへ引き直す（`processIdOf`）。止めた後は**先回りして印を消さず**、codex に数え直させる
  （止めたつもりで生きている端末の印を落とす方が、消え遅れるより悪い）。
  web は作業ダイアログ（「裏で動いているもの」）に行として出し、`capabilities.stopBackground` のあるバックエンドにだけ
  「止める」を出す。中断（`abort`）はターンを止めるもので、これとは別物
- `thread/backgroundTerminals/clean` は使っていない（何をどこまで消すのかが実機で確かめられていない）
- **古い codex での振る舞い**: `backgroundTerminals` は 0.147.0 には無い（0.153 以降にある）。
  数えること自体は遅れて届く `item/completed` だけでできるので、**印は出る**。
  効かなくなるのは「取りこぼしの照合」と「止める」の 2 つだけ。止めようとしたときは生のプロトコルエラーを見せず、
  `codex update` で直せると伝える。Pleiad が使う codex は PATH の `codex`（`AGENT_HOST_CODEX_BIN` で上書きできる）で、
  ChatGPT デスクトップアプリが自前で持つ copy とは**別の install**（アプリを更新しても PATH の方は上がらない）

### 2.8 Antigravity CLI（`agy`、2026-09）

**Google のサブスク枠（AI Pro / Ultra）を正規の手段で使える唯一の道。** 経緯:

- 2026-06-18、Google は**個人向けの Gemini CLI を終了**し Antigravity へ移した。
  個人アカウントの `oauth-personal` は `This client is no longer supported for
  Gemini Code Assist for individuals … migrate to the Antigravity suite` で撥ねられる
  （利用者の実機で確認）。Code Assist Standard / Enterprise ならまだ通る
- Gemini API キーは**別建ての従量課金**で、サブスクの枠は流れない
- 公式の Antigravity SDK（Python）も **API キーか Vertex しか受けない**
  （[antigravity-sdk-python#20] が OAuth 対応の要望として open）
- そこで一度入れた gemini-cli（ACP）バックエンドは**廃止した**

**接続口**は `agy --print= --input-format stream-json --output-format stream-json`。
行区切り JSON（NDJSON）を stdin から受け、stdout へ流す。ACP は話さない
（[antigravity-cli#31] が要望のまま）。

実機（agy 1.2.4 / windows-x64）で確かめたこと:

- **`--print` は次のフラグを prompt として飲み込む。** `--print` と書くと `--input-format` が
  prompt 扱いになり、agy 自身がそう警告する。**`--print=`（空値）が正しい**
- 未ログインだと stderr に OAuth の URL を出し「Or, paste the authorization code here and press
  Enter:」と促す。**ただしその入力は端末からしか読まない。** パイプした stdin に認可コードを
  書いても完全に無視され、60 秒で `authentication failed or timed out` になる（実測）。
  公式も同じことを書いている: *Headless mode uses your cached credentials. Authenticate once
  with an interactive `agy` session first.*
  **だから Pleiad はログインを自分で回さない**（§下）
- 認証に失敗しても `result` は必ず出る（下の形は実機の観測）
- `agy models` は未ログインだと `Please sign in to view available models` で落ちる。
  資格情報は **OS の資格情報ストア**（macOS のキーチェーン: service `gemini` / account `antigravity`）に
  あってファイルとして読めないので、**ログイン判定は `agy models` に聞く**
- `agy models` の出力は `id<TAB>表示名`（例 `gemini-3.8-flash-high<TAB>Gemini 3.8 Flash (High)`）。段違いは別の id で並ぶ（1.2.8 で確認）。
  既定のモデルは設定ファイルに出ない。agy は起動のたびにログへ `Propagating selected model override to backend: label="…"` を書くので、
  Pleiad は `agy --log-file <一時ファイル> models` で呼び、その label を既定として読む（公開の口ではないので、取れなければ「既定（agy の設定）」）
- 1.2.8 では `agy -p "/model"` などの slash コマンドは**通常のプロンプトとして LLM に送られる**（changelog 1.1.11 の「quota を使わずに答える」は当てはまらなかった。実測）。調べるのに使わない
- サブコマンドは `agent(s)` / `models` / `mcp` / `plugin` / `remote-control` / `update` /
  `changelog` / `install` / `help`。**会話を列挙するものが無い**
- **`--print-timeout`（既定 5m0s）がターンを打ち切る**（2026-09-16 に実測）。5 分を超えたターンは
  stderr に `[agy] print timeout after 5m0s with turn in progress; returning partial output` を出し、
  **`status:"SUCCESS"` / `response:""` / `usage` 全 0 の `result` を吐いて出力を止める**。
  SUCCESS をそのまま信じると「本文が空のまま正常に終わった」ターンになり、会話が途中で止まって見える。
  **しかも agy 本体は打ち切りの後も裏で走り続ける**（打ち切り後も `streamGenerateContent` を
  叩き続けるのをログで確認。3 時間動き続けた実例あり）。Pleiad が見ていない間もファイルは書き換えられ、
  Google の枠も減る。→ **Pleiad は `--print-timeout` を明示的に長く渡し**（既定 `24h`。
  `AGENT_HOST_AGY_PRINT_TIMEOUT` で上書き）、**それでも打ち切られたら失敗として畳み、その agy を落とす**。
  打ち切りは stderr の上の文言で見分ける（`duration_seconds: 0` / `usage` 全 0 も同じ印だが、
  短いターンと区別が付かない）。落とすのは、Pleiad が見ていない所で走り続けさせないため。
  会話は `--conversation <id>` で拾い直せるので失われない
- **ツールの `step_update` は同じ `step_index` で `state: "ACTIVE"` → `"DONE"` の 2 回来る。**
  ACTIVE 側には `tool_info.output` が無い。両方を同じに扱うとツールが二重に並び、1 つ目は結果が空になる。
  → **ACTIVE を `tool.start`・DONE を `tool.result` に分ける**。
  他のバックエンドと同じく「実行中」も出る。`state` が未知・欠落のときは
  `tool_info.output` の有無で開始／完了を決める（取りこぼさないため）
- 調べるときのログは `~/.gemini/antigravity-cli/log/cli-<日時>.log`（`cli.log` が最新への symlink）。
  打ち切りは `poll.go:204] Print mode: print timeout` で引ける

| | Antigravity CLI |
|---|---|
| プロセス | `agy` のヘッドレス。**1 プロセス = 1 会話**（codex / claude の共有 1 プロセスとは違う） |
| 新規 | 引数なしで起動 → `init` の `conversation_id` |
| 再開 | `--conversation <id>` |
| 本文 | `step_update` の `step_type: "agent_response"` + `text_delta`（**真のデルタ**） |
| 思考 | **無し**（`thinking_tokens` は完了時の集計だけ） |
| ツール | `step_type: "tool"` + `tool_info{name,parameters,output}`。**`state` が ACTIVE / DONE の 2 回**（上の実測。開始と完了に分ける） |
| 承認 | **無し**（§下） |
| 中断 | **無し** → プロセスを落とす。会話は `--conversation` で拾い直せる |
| 完了 | `result` の `status`（SUCCESS / ERROR / CANCELED / INTERRUPTED / INVALID / WAITING / RUNNING） |
| 使用量 | `result.usage`（`input_tokens` / `output_tokens` / `cache_read_tokens` / `thinking_tokens`） |
| 一覧・履歴 | **無し** → Pleiad が控える（§下） |
| タイトル・状態タグ・fork | 無し → sidecar / Pleiad の写し（分岐は [message-fork.md の「Antigravity の境界調査」](message-fork.md#antigravity-の境界調査)） |
| モード | **`--dangerously-skip-permissions` の 1 つだけ**（§下） |
| モデル・effort | `--model` だけを渡す。**起動時のみ**（liveModel / liveMode は false）。effort は段違いの id（`gemini-3.8-flash-low` / `-medium` / `-high`）を選ぶことと同じなので、段は同じ系統の id に解決して `--model` に載せ、`--effort` と同時には渡さない（agy 1.2.8 で確認。`core/backends/antigravity-models.mjs`） |
| 認証 | **端末でのサインインが要る**（Pleiad からは回せない。§下） |

イベントの形:

```jsonc
{"event":"init","conversation_id":"…","init":{"cwd","tools","permission_mode","model","agent"}}
{"event":"step_update","step_update":{"conversation_id","step_index","state":"ACTIVE|DONE","step_type","text_delta"}}
{"event":"result","result":{"conversation_id","status","response","error","duration_seconds","num_turns","usage"}}
```

**承認を持てない**: ターン中の対話承認は**公式に非対応**。許可が取れないツールは soft-deny され
（ターンは止まらず、stderr に通知が出るだけ）。そのため:

- `capabilities.alwaysAllow` は **false**。askPermission を一度も呼ばない
- **選べる承認モードは「全部自動」（`--dangerously-skip-permissions`）の 1 つだけ。**

`agy --help` には `--mode plan` と `--mode accept-edits` もあるが、**ヘッドレスでは選ばせない**。
`--dangerously-skip-permissions` を付けない限りツールは soft-deny されるうえ、
`--print` モードは settings.json の `permissions.allow` を見ない（[antigravity-cli#548]）ので
事前付与で埋めることもできない。並べると「モードを選んだのにエージェントが黙って何もできない」
だけになる。「都度確認」を出さないのも同じ理由（聞くと言って聞かないものを作らない）。

[antigravity-cli#548]: https://github.com/google-antigravity/antigravity-cli/issues/548

**ただし「ツールを呼ばない」の原因は承認とは限らない**: Pleiad 担当のコンテキストを渡す会話は
`--agent ply-context` で走る。agy のカスタムエージェントは frontmatter に `tools` を書かないと
書き込み系ツールを一切持たず、`--dangerously-skip-permissions` を付けても（`permission_mode` は
always-proceed のまま）読むだけになる。そこで定義に `tools` を明示する。
名前を書ける範囲と、`tools: "*"` を採らない理由は `core/backends/antigravity-context.mjs` の `TOOLS`。

**一覧と履歴を Pleiad が控える**（`core/backends/antigravity-store.mjs`）:
gemini では本体が書いた記録を**読んだ**が、agy には読めるものが無い
（会話を列挙するサブコマンドが無く、`conversation_summaries.db` は非公開スキーマの SQLite）。
そこで**ターンの最中に見た正規化メッセージをそのまま控える**。置き場は sidecar と同じ
`AGENT_HOST_DATA` の下の `antigravity/<conversation_id>.json`。
控えなので agy 側で消えた会話が残りうる。`--conversation` が撥ねられた時点で落とす。

**ログインの導線**: Pleiad は OAuth を回さず、**端末で叩くコマンドを案内して、終わるのを見張る**。

- `auth.login` は `agy models` が通るようになるまで見張る（既定 3 秒間隔 / 10 分）。
  利用者は端末でログインするだけでよく、「再確認」を押さなくても画面が切り替わる
- 案内に出すコマンドは `cliCommand` が解決した**絶対パス**。インストーラが PATH を書いても、
  起動済みの端末や Pleiad には届いていないことがある
- **貼り付け欄を出さない。** `capabilities.submitCode`（`auth.submitCode` の実在）を web に渡し、
  受け取れるバックエンドにだけ入力欄を出す。受け取る口が無いのに出すと、
  貼っても何も起きない欄になる（実際にそうなっていた）
- ログアウトも口が無い。資格情報は OS の資格情報ストア（macOS のキーチェーン:
  service `gemini` / account `antigravity`）にあり、Pleiad からは消せない

**インストールの導線**（`core/cli-installation.mjs`）:

- `installation()` は **backend.id で引かれる**ので、`INSTALL_URLS` の鍵も `antigravity` にする。
  実行ファイル名が `agy` だからと鍵を `agy` にすると、`installation("antigravity")` が
  「URL を持たない = 常にインストール済み」になり、**インストール導線が一度も出ない**
- 実行ファイル名だけが違うので、既定のコマンド名は `{ antigravity: "agy" }` で引く
- Windows のインストーラ（`install.ps1`）は `%LOCALAPPDATA%gyin` へ置き、PATH はそのあと
  `agy install` が書く。**起動済みの Pleiad は PATH の変更を拾えない**ので、
  findExecutable はこの置き場を直接見る。見ないと「入れたのに未インストールのまま」になり、
  Pleiad の再起動が要る。Unix 版（`install.sh`）は `$HOME/.local/bin` なので元から見ている

**孤児の `agy` を残さない**（`core/backends/antigravity-pids.mjs`）:
1 プロセス = 1 会話なので、Pleiad が落ちると agy が裏に取り残される（前の起動のものが走り続けていた実例あり）。

- サーバ終了時に、生かしている AgySession を全部落とす（`process.once("exit")`）。
  **`SIGINT` / `SIGTERM` のハンドラは足さない**（server はワーカースレッドでも動くので、既定の終了挙動を変えない）
- それでは強制終了・クラッシュで取り残されるので、生かしている pid を
  `AGENT_HOST_DATA/antigravity/pids.json` に控え、**次の起動で生き残りを落とす**
- **pid は使い回される。** 落とす前にその pid の実行ファイル名を引き（win32 は `tasklist`、
  posix は `ps -p`）、起動に使う実行ファイルと同じ名前だと確かめる。
  確かめられなければ落とさない（無関係のプロセスを殺さないため）
- **他の Pleiad が使っているものは孤児ではない。** 控えは `AGENT_HOST_DATA` ごとに 1 つなので、
  Pleiad を 2 つ動かす（worktree ごとの開発サーバなど）と、後から起きた方が先の agy を落としかねない。
  控えには起こした Pleiad の pid（`owner`）も残し、**それが生きているうちは触らない**

実行ファイルは `AGENT_HOST_AGY_BIN`（既定 `agy`）。
`--print-timeout` の値は `AGENT_HOST_AGY_PRINT_TIMEOUT`（既定 `24h`。**Go の duration 文字列**）。

**まだ確かめていないこと**: `step_update` は `agent_response` と `tool` と `user_input` しか
実機で見ていない。知らない `step_type` と `event` は黙って落とす作りにしてある。

[antigravity-cli#31]: https://github.com/google-antigravity/antigravity-cli/issues/31
[antigravity-sdk-python#20]: https://github.com/google-antigravity/antigravity-sdk-python/issues/20

### 2.6 host ツールの非対称（v3 の既知の穴）

公開 `present` MCP は廃止した。Claude・Codex 共通の Visualize 参照で表示・保存する。詳細は [可視化仕様](visualize.md)。
Codexの新規・再開スレッドは `config['mcp_servers.ply']`、Claudeは `mcpServers.ply` で接続する。
Codexの `set_status / set_title / fork` は未接続なので、
`capabilities.hostTools: false` は維持する。成果物提示の詳細は [共有仕様](artifact-sharing-investigation.md) を参照。

## 3. 段階

| 段 | 内容 | 検証 |
|---|---|---|
| **P1** | `AgentBackend` 導入。Claude 実装を `core/backends/claude.mjs` へ移す。正規化イベント + プロトコル v2。`web/client.mjs` の `onSdk` を正規化ハンドラに置き換え。`fake` バックエンドで **LLM 無しに server 全体をテスト**。sidecar 拡張。web に backend 選択（新規時）と一覧の backend 表示、capabilities による出し分け（fork / suggestTitle / subagents / 常に許可） | `npm test` に server 経由の unit を足す。既存 e2e が通る |
| **P2a** | `core/backends/codex.mjs`（app-server クライアント）+ 認証 UI（`authStatus` / `authLogin` / `authLogout` コマンド、`auth` イベント） | fake の app-server 相当をテストで stub。実機で 1 ターン |
| **P3** | host ツールの MCP ブリッジ（§2.6） | — |
| **P4** | `core/backends/antigravity.mjs` + `antigravity-cli.mjs`（ヘッドレスの stream-json）+ `antigravity-store.mjs`（Pleiad が控える一覧と履歴）。§2.8 | agy の身代わり（`tests/lib/fake-agy.mjs`）と話す `tests/unit/server-antigravity.mjs`。実機の 1 ターンは Google のログインが要るので未実施 |

P1 が土台。

## 4. 変えないこと

- 承認の保留・猶予・中断（design.md §8.5）。`server.mjs` の
  `graceExpired` / `giveUp` / `attach` / `detach` / `settleAll` / `askPermission` は触らない
  （行番号で書くとすぐずれる。関数名で探すこと）
- 「接続が来ても古い接続を閉じない」
- md レンダリング・CSP・提示の永続化
- `tests/unit/stream-routing.mjs` などの「規則の写経」は、写経元を動かしたら同時に直す
