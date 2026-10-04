// bot・Channels・ルーティンの画面の入口（docs/channels.md「画面の口」、ADR 0106〜0114）。
// web/client.mjs が持つのはここの setupChannels(host) の 1 つの口だけ。各パッケージは自分のファイルを書き、
// 下の「部品の一覧」へ 1 か所ずつ足す（client.mjs には触らない）。
//
//   setupChannels(host) → { onEvent(ev, replay), show(view), hide(), sideTabChanged(tab), contextForPanel(anchor), tab, setTab(tab), tabs }
//
//   host（client.mjs が渡す道具の束）:
//     cmd(command, args)            … WS のコマンド
//     invoke(op, args)              … 操作の一覧（cmd('invoke', { op, args }) の短縮。失敗は throw）
//     state                         … client の state（読むだけ。current・sessions・runningIds・waitingIds など）
//     filePreview                   … web/file-preview.mjs の返り。open(ref, element)・openPanel・close・panelOpen
//     browser                       … 内蔵ブラウザーの部品（web/browser-panel.mjs の返り。使えない画面では null。スレッドの見出しの入口が使う）
//     permissionCard(ev, into)      … 承認のカードを入れ物へ描く（client.mjs の permissionCard。質問は質問のカード。決着は resolvePermission と同じ）
//     openSession(id)               … Chats の会話を開く（Chats のタブへ戻して select）
//     openThread(channelId, threadId) … スレッドを開く。setupChannels が足す（部品の openThread へ配る）。呼ぶのは W2（要約の行・「スレッドで返信」）、受けるのは W3
//     openSidebar()                 … 脇を開く（狭い画面は引き出し）
//     showMenu(x, y, items, title)  … 右クリックのメニュー（web/context-menu.mjs と同じ見え方）
//     renderAssistantMarkdown(text, refs?)・renderPresent(ev)  … web/render.mjs
//     side                          … web/side.mjs の返り（Chats の脇。行の描き方・バックエンドのロゴ）
//     t                             … 訳（'channels:feed.empty' のように名前空間を付ける）
//
//   部品（part）: { onEvent?(ev, replay): void, show?(view): void, hide?(): void, sideTabChanged?(tab): void, contextForPanel?(anchor): { sessionId, at } | null,
//                  openThread?(channelId, threadId): void }
//     - show(view) … メインに出す面。view = { kind: 'channel' | 'bot' | 'routine', id, threadId? }
//     - contextForPanel(anchor) … 右パネルの作業場所の基準（そのスレッドの bot の会話）。分からなければ null（Chats と同じ基準へ）
//
//   DOM（web/index.html）: #sideTabs・#tabChats・#tabChannels・#channelsSide・.cs-sec[data-sec]・#channelsView・#channelsBody。
//   スレッドの空間モデル（.deck・#chFeed・#chThread）・投稿・入力欄・bot のページ・ルーティンの編集は、各パッケージが #channelsBody の中に作る。
import { createSideTabs } from './side-tabs.mjs';
import { createFeed } from './feed.mjs';
import { createSidebar } from './sidebar.mjs';
import { createThread } from './thread.mjs';

/** WS の出来事のうち、この画面が受けるもの（core/protocol.mjs の EVENTS）。ほかの出来事も部品の onEvent には全部届く（permission など） */
export const CHANNEL_EVENTS = new Set([
  'channelsChanged', 'channelPost', 'channelReaction', 'channelThread', 'channelRead', 'botsChanged', 'memoryChanged', 'brainChanged', 'routinesChanged',
]);

import { createBotPage } from './bot-page.mjs';
import { createRoutineSheet } from './routine-sheet.mjs';

export function setupChannels(host) {
  const parts = [];
  // スレッドを開く口。投稿の要約の行・「スレッドで返信」が呼ぶ（部品の openThread(channelId, threadId)。W3 が受ける。受ける部品が無ければ何も起きない）
  host.openThread ??= (channelId, threadId) => {
    each('openThread', channelId, threadId);
    document.dispatchEvent(new CustomEvent('channels:openthread', { detail: { channelId, threadId } }));   // 部品を持たない画面・テストが聞ける
  };

  // ---- 部品の一覧。1 行 = 1 パッケージ。足すのは自分の行だけ（行の間を空けてあるのは、並列の変更が競合しないため）

  // W1 脇（タブはこの一覧の後で作るので、関数で渡す）
  parts.push(createSidebar(host, () => tabs));

  // W2 チャンネルの流れ
  parts.push(createFeed(host));

  // W3 スレッドと空間モデル（流れの板を #chDeck へ移すので、流れの後に置く）
  parts.push(createThread(host));

  // W4 bot のページ（show({ kind: 'bot', id })。id が 'new' なら作る画面）
  parts.push(createBotPage(host));

  // W5 ルーティンの編集（P2。document の channels:routine で開く。bot のページに「ルーティン」の節を足す）
  parts.push(createRoutineSheet(host));

  const each = (name, ...args) => { for (const part of parts) part[name]?.(...args); };
  const tabs = createSideTabs({ onChange: (tab) => each('sideTabChanged', tab) });
  // 狭い画面で脇を閉じている間の入口（#openSidebar と同じ働き。メインの頭が Channels の見出しに替わっている間だけ見える）
  document.getElementById('chOpenSidebar')?.addEventListener('click', () => host.openSidebar());

  const api = {
    /** 出来事を部品へ渡す。この画面の出来事なら true（client.mjs の onEvent はそこで終わる） */
    onEvent(ev, replay = false) {
      each('onEvent', ev, replay);
      return CHANNEL_EVENTS.has(ev?.type);
    },
    show(view) { tabs.set('channels'); each('show', view); },
    hide() { each('hide'); tabs.set('chats'); },
    sideTabChanged(tab) { each('sideTabChanged', tab); },
    /** 右パネルの作業場所の基準。Channels の中の要素でなければ null */
    contextForPanel(anchor) {
      if (!anchor?.closest?.('#channelsView')) return null;
      for (const part of parts) { const ctx = part.contextForPanel?.(anchor); if (ctx) return ctx; }
      return { sessionId: null, at: undefined };
    },
    get tab() { return tabs.tab; },
    setTab: (tab) => tabs.set(tab),
    tabs,
  };
  // どこからでも開ける入口（脇の行・通知・テスト）: document へ new CustomEvent('channels:show', { detail: { kind: 'channel', id } })
  document.addEventListener('channels:show', (e) => api.show(e.detail));
  return api;
}
