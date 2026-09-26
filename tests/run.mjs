// LLM もサーバも要らないテスト。CI で常時回す。数秒で終わること。
//
//   npm test                 全部
//   npm test -- markdown     名前で絞る（部分一致）
//
// 落ちたテストは末尾にまとめて出る。終了コードで成否を返す。
//
// 画面とサーバーの言語は日本語に固定する（テストは日本語の文言に依存している。CI の OS の言語で変わらないように）。
// 英語のケースは i18n のテストが明示的に切り替えて見る。起動するサーバーにも環境変数で引き継がれる。
process.env.AGENT_HOST_LOCALE ||= "ja";
import { installDomStub } from "./lib/dom-stub.mjs";
import { runCase, summarize, pick } from "./lib/harness.mjs";

// web/render.mjs はブラウザ前提なので、読み込む**前**に DOM を差し替える。
installDomStub();

const cases = [
  await import('./unit/file-preview.mjs'),
  // パスの自動リンク・画像の所在・ファイルの操作メニュー・OS で開く口（OS の窓は開かない）
  await import('./unit/file-actions.mjs'),
  // 右パネルの枠（web/side-panel.mjs）: モードごとの部品・渡さない部品は隠す・可視化の ⋯
  await import('./unit/side-panel.mjs'),
  await import('./unit/modes.mjs'),
  await import('./unit/agent-tasks.mjs'),
  await import('./unit/background-model.mjs'),
  await import('./unit/server-agent-tasks.mjs'),
  // 委譲先の自動振り分け: 規則・段・使用量で飛ばす・Claude のアカウント・判定器（偽の fetch）・使用量の取り置き
  await import('./unit/delegation-routing.mjs'),
  // 同じくサーバー全体: kind の検査・自動で選んで子を作る・記録・設定とキーの口（偽の判定器と偽の agy）
  await import('./unit/server-delegation-routing.mjs'),
  // 同じく画面: 委譲カードの理由・内訳の文、やり直しの候補の並び、設定の差分（web/delegation-routing-view.mjs）
  await import('./unit/delegation-routing-view.mjs'),
  // Pleiad の指示: 担当によらず届く・依頼元と子で違う・足した指示・既定の編集・前の版のスイッチ・Codex のロード済みスレッド
  await import('./unit/server-added-context.mjs'),
  await import('./unit/usage.mjs'),
  await import('./unit/antigravity-usage.mjs'),
  // 会話のヘッダーの使用量のチップ（web/header-usage.mjs）: 枠の選び方・アカウント・上限・グループのまとめ
  await import('./unit/header-usage.mjs'),
  await import('./unit/effort.mjs'),
  await import('./unit/composer-agy.mjs'),
  // 互換の接続先（保存・確認・キーを出さない・env と Codex の上書き）。偽の互換 API とだけ話す
  await import('./unit/compat-endpoints.mjs'),
  // リモート接続の暗号・フレーム・チャネル（core/remote/）。Noise の公式ベクトルと、メモリの管でつないだ往復
  await import('./unit/remote-noise.mjs'),
  await import('./unit/remote-frames.mjs'),
  await import('./unit/remote-channel.mjs'),
  // 互換の接続先のモデルの表示名（anthropic/ と [1m]）・検索（AND・件数の上限・自由入力）・display_name の保存と旧形式
  await import('./unit/compat-models.mjs'),
  // 入力欄の設定のチップ: フォルダーの一覧（listDirs）・「既定」の解決・エフォートの既定の段
  await import('./unit/composer-settings.mjs'),
  await import('./unit/context-transports.mjs'),
  await import('./unit/context-runtime.mjs'),
  // 外部 MCP の認証（担当が Pleiad のとき）。秘密の置き場、OAuth はローカルのモックの認可サーバー・MCP だけと話す
  await import('./unit/mcp-secret-store.mjs'),
  await import('./unit/mcp-oauth.mjs'),
  await import('./unit/mcp-oauth-more.mjs'),
  await import('./unit/mcp-registry-more.mjs'),
  // データ置き場を共有する 2 つのプロセス。本物の子プロセスを 2 本起動する
  await import('./unit/mcp-oauth-processes.mjs'),
  await import('./unit/desktop-updates.mjs'),
  await import('./unit/message-queue.mjs'),
  await import('./unit/message-steer.mjs'),
  await import('./unit/visualize.mjs'),
  await import('./unit/server-visualize.mjs'),
  await import('./unit/mcp-config.mjs'),
  await import('./unit/context-scan.mjs'),
  // コンテキストの設定の形式 2 と、形式 1 からの移行（意味が変わらないこと）
  await import('./unit/context-settings.mjs'),
  // 探す場所を足す（追加ルート）: 種類ごと・探す形式に従う・形式 2 からの移行
  await import('./unit/context-roots.mjs'),
  await import('./unit/server-context.mjs'),
  await import('./unit/context-ui.mjs'),
  await import('./unit/slash-skills.mjs'),
  await import('./unit/notifications.mjs'),
  await import("./unit/onboarding.mjs"),
  await import("./unit/tree.mjs"),
  await import("./unit/family.mjs"),
  await import("./unit/pending-sidebar.mjs"),
  // 入力欄の待ち（web/composer-wait.mjs）: 会話を開く・初めての接続・読み込みの失敗・作成中の送信の予約
  await import("./unit/composer-wait.mjs"),
  // 接続の状態（web/connection-status.mjs）: 切れた一行・読み上げ・古いトークンの案内と再確認、開くボタンの印、/auth-check
  await import("./unit/connection-status.mjs"),
  // 新しい会話を作っている間に書いた字が消えない・作成中の送信の予約・読み込み失敗で欄が戻る（client.mjs を vm で流す）
  await import("./unit/composer-new-session.mjs"),
  await import("./unit/server-groups.mjs"),
  await import("./unit/audit-self.mjs"),
  await import("./unit/markdown-xss.mjs"),
  await import("./unit/tools-render.mjs"),
  await import("./unit/timeline-images.mjs"),
  await import("./unit/attachment-order.mjs"),
  // 添付の件数に上限が無い（下書き・送信）。出どころの印。1 件 8MB の上限は残る
  await import("./unit/attach-no-limit.mjs"),
  // 添付を断片で送る（1 件 100MB まで）: 境目・抜け・やめる・切れても続きから・大きな画像は会話にパスだけ
  await import("./unit/attach-chunked.mjs"),
  // 入力欄と上端の見直し: 字の欄の上限・チップの字・添付の出どころ・パンくず・規則
  await import("./unit/composer-layout.mjs"),
  await import("./unit/unread.mjs"),
  // 確認済み（既読）の置き場と、2 本の接続で共有されること（fake バックエンド）
  await import("./unit/read-store.mjs"),
  await import("./unit/server-read.mjs"),
  // 開いている会話の宣言（流れの出来事を絞る）と、会話の一覧の使い回し（ADR 0024）
  await import("./unit/server-watch.mjs"),
  await import("./unit/desktop-port.mjs"),
  // デスクトップ版の端末（リモートの窓）: 窓ごとの信頼・preload の出し分け・バッジ。Electron は起こさない
  await import("./unit/desktop-remote.mjs"),
  // スマホの画面（docs/remote.md §8.3・§8.4）: UUID の代わり・長押し・「…」・狭い画面の規則
  await import("./unit/mobile-web.mjs"),
  await import("./unit/stream-routing.mjs"),
  await import("./unit/stream-prefix.mjs"),
  await import("./unit/session-stream.mjs"),
  await import("./unit/work-attribution.mjs"),
  await import('./unit/work-status.mjs'),
  await import('./unit/background-labels.mjs'),
  await import("./unit/ask-answers.mjs"),
  await import("./unit/title-clean.mjs"),
  await import("./unit/claude-normalize.mjs"),
  await import("./unit/claude-background.mjs"),
  // Claude の途中送信の渡った合図（uuid・まとめ取り出し・次の内部ターン）と中断の interrupt。SDK の query を身代わりにする
  await import("./unit/claude-steer-stop.mjs"),
  await import("./unit/codex-background.mjs"),
  await import("./unit/codex-terminals.mjs"),
  await import("./unit/event-session-id.mjs"),
  await import("./unit/lineage.mjs"),
  await import("./unit/branches.mjs"),
  // 見た目の規則。web/ の CSS と index.html を lint する（docs/design-system.md §5）
  await import("./unit/design-lint.mjs"),
  // 多言語対応。翻訳漏れの lint（直書きの日本語のラチェット・辞書の揃い）と、言語の解決・書式・setPref locale
  await import("./unit/i18n-lint.mjs"),
  await import("./unit/i18n.mjs"),
  // core・desktop の文言の言語切り替えと、保存される文言（変更の理由・添付の見出し・既定のタイトル）
  await import("./unit/i18n-server.mjs"),
  // エージェントに渡す文（指示・ツールの説明・完了通知・タイトル生成・承認の拒否の理由）が会話の言語になる
  await import("./unit/i18n-agent.mjs"),
  await import("./unit/codex-mode.mjs"),
  // model/list のページ送り・覚える長さ・ログイン / ログアウトで捨てる・タイトル生成のモデル選び
  await import("./unit/codex-models.mjs"),
  await import("./unit/codex-child-routing.mjs"),
  // fake バックエンドでサーバを立てる。LLM は呼ばないので、ここに入れてよい
  await import("./unit/server-fake.mjs"),
  // 中断の順序（実際の中断が先、Pleiad タスクの後始末は後）と「中断している」の知らせ。fake バックエンドだけ
  await import("./unit/server-abort.mjs"),
  // Claude のアカウント切り替え（会話ごとのトークン）。env の組み立てと、server の配線を fake で通す
  await import('./unit/claude-accounts.mjs'),
  await import('./unit/server-claude-accounts.mjs'),
  // アカウントの認可を Pleiad から回す（疑似端末の偽物と、偽の CLI を本物の疑似端末で）
  await import('./unit/claude-login.mjs'),
  await import('./unit/server-claude-login.mjs'),
  await import("./unit/server-background.mjs"),
  await import("./unit/server-handoff.mjs"),
  // 対応を終えた procway-code の会話・設定が残っていても安全に動く
  await import("./unit/server-retired.mjs"),
  await import("./unit/server-fork.mjs"),
  await import("./unit/server-ux.mjs"),
  await import("./unit/conversations.mjs"),
  await import("./unit/conversations-storage.mjs"),
  // codex バックエンド。app-server の身代わり（tests/lib/fake-codex.mjs）と話すだけで、
  // 本物の codex もネットワークも要らない
  await import("./unit/server-codex.mjs"),
  // 互換の接続先の配線。codex の身代わりと偽の互換 API だけと話す
  await import("./unit/server-compat-endpoints.mjs"),
  // 同じことを本物の Claude Code・Codex の CLI で（送り先は偽の互換 API。入っていなければとばす）
  await import("./unit/server-compat-real-cli.mjs"),
  // antigravity バックエンド。agy の身代わり（tests/lib/fake-agy.mjs）と話すだけで、
  // 本物の agy も Google のログインも要らない
  await import("./unit/server-antigravity.mjs"),
  // Pleiad の MCP 登録と認証の API、1 件つながらなくても会話が進むこと、antigravity では Pleiad 担当を開かないこと
  await import("./unit/server-mcp-auth.mjs"),
  await import("./unit/server-agy-context.mjs"),
  // インストールからログインまでの導線（未インストール -> 再起動なしで発見 -> 認可コード）
  await import("./unit/antigravity-onboarding.mjs"),
  // 孤児の agy の掃除。**名前を確かめてからでないと落とさない**
  await import("./unit/antigravity-pids.mjs"),
  // 同じ身代わりで、ターン途中の送信をその区切りへ差し込む（serve の steer）
  // リモートの中継（relay/server.mjs）。空きポートで立て、素の WebSocket で照合・行き先・上限を叩く
  await import("./unit/relay.mjs"),
  // リモートのホスト側（core/remote/connector.mjs）。中継をこのプロセスで、fake のサーバーを別プロセスで立て、試験用の端末で往復する
  await import("./unit/remote-host.mjs"),
  // 設定 › リモートの部品と常駐（トレイ・スリープ。Electron は差し替える）、setRemoteResident
  await import("./unit/remote-settings.mjs"),
  // リモートの端末側（core/remote/device*.mjs）。中継とホストを立て、端末内プロキシの URL を素の HTTP と ws で叩く
  await import("./unit/remote-device.mjs"),
  // 手元のフォルダーを送る口（core/folder-uploads.mjs）: パスの検査・送り先・続きから・中断・上書きの確認・掃除、WS での往復
  await import("./unit/folder-uploads.mjs"),
  // 同じ口を端末内プロキシ → 中継 → ホストで。50 MiB・2000 件が流量の制御の下で届くこと、中継が落ちても続きから送れること
  await import("./unit/remote-upload.mjs"),
  // モバイルの殻（mobile/）の取り決め: plyRemote の形・平文はループバックだけ・依存の版の固定・殻の辞書
  await import("./unit/mobile-shell.mjs"),
];

const selected = pick(cases, process.argv.slice(2));
if (!selected.length) process.exit(1);

const t0 = Date.now();
const suites = [];
for (const mod of selected) suites.push(await runCase(mod));

const code = summarize(suites);
console.log(`  ${((Date.now() - t0) / 1000).toFixed(1)} 秒`);
process.exit(code);
