// 脇の Channels 側（web/channels/side-model.mjs・sidebar.mjs、web/side.mjs の bot の会話の行と検索の横断）の、画面を持たない判定と配線。
// 描画・キー操作は tests/browser/session-list-keys.cjs（Chats の一覧）と目視（temporary/screenshots/bots-w1-side-*）。
import { readFileSync } from 'node:fs';
import { sideChannels, botState, tabDots, channelNameRows, postRows, showDetail, selectedRow } from '../../web/channels/side-model.mjs';
import { parseTerms } from '../../web/session-find.mjs';

export const name = 'channels-side-ui';
export const title = '脇の Channels: 並べ方・bot の状態・タブの点・検索の行・開く先・配線';

const read = (p) => readFileSync(new URL(`../../${p}`, import.meta.url), 'utf8');

export default function (t) {
  // ---- 並べ方
  const channels = [
    { id: 'c_3', kind: 'channel', name: 'mobile-release', archivedAt: 5 },
    { id: 'c_1', kind: 'channel', name: 'daily', unread: 2 },
    { id: 'c_d', kind: 'dm', name: 'Owl', botId: 'b_owl', unread: 1, mentions: 1 },
    { id: 'c_2', kind: 'channel', name: 'Checkout-perf', unread: 1, mentions: 2 },
    { id: 'c_4', kind: 'channel', name: 'checkout10' },
    { id: 'c_5', kind: 'channel', name: 'checkout9' },
  ];
  const names = sideChannels(channels).map((c) => c.name).join(',');
  t.ok('DM は出さない・名前順（大小を区別せず、数は数として）・アーカイブは後ろ', names === 'Checkout-perf,checkout9,checkout10,daily,mobile-release', names);
  t.ok('入力を変えない・空でも落ちない', channels[0].name === 'mobile-release' && sideChannels(undefined).length === 0);

  // ---- bot の状態（一覧の会話の印から。会話が無ければ bots.list の state）
  const owl = { id: 'b_owl', state: 'idle' }, lynx = { id: 'b_lynx', state: 'waiting' }, kit = { id: 'b_kit', state: 'working' };
  const sessions = [{ id: 's1', bot: { botId: 'b_owl' } }, { id: 's2', bot: { botId: 'b_owl' } }, { id: 's3', bot: { botId: 'b_lynx' } }, { id: 's4' }];
  t.ok('走っている会話があれば作業中', botState(owl, { sessions, runningIds: new Set(['s1']) }) === 'working');
  t.ok('あなたを待っている会話があれば、走っていてもあなた待ちが先', botState(owl, { sessions, runningIds: new Set(['s1']), waitingIds: new Set(['s2']) }) === 'waiting');
  t.ok('会話が一覧にあって動いていなければ待機（bots.list の古い state を使わない）', botState(lynx, { sessions }) === 'idle');
  t.ok('会話が一覧に 1 つも無ければ bots.list の state', botState(kit, { sessions }) === 'working' && botState({ id: 'b_x' }, {}) === 'idle');

  // ---- タブの点（見ていない側にだけ）
  const dots = (o) => tabDots({ channels: [], botStates: [], chats: {}, ...o });
  t.ok('Chats を見ていて bot があなた待ち → Channels に mark', dots({ tab: 'chats', botStates: ['idle', 'waiting'] }).channels === 'mark');
  t.ok('あなた宛ての投稿も mark。未読だけなら unread', dots({ tab: 'chats', channels: [{ mentions: 1 }] }).channels === 'mark' && dots({ tab: 'chats', channels: [{ unread: 3 }] }).channels === 'unread');
  t.ok('アーカイブしたチャンネルの未読は数えない', dots({ tab: 'chats', channels: [{ unread: 3, mentions: 1, archivedAt: 1 }] }).channels === null);
  t.ok('見ている側には点を付けない', dots({ tab: 'channels', botStates: ['waiting'], chats: { waiting: true } }).channels === null
    && dots({ tab: 'channels', chats: { waiting: true } }).chats === 'mark');
  t.ok('Chats 側: あなた待ちが先、未読だけなら unread、無ければ null', dots({ tab: 'channels', chats: { waiting: true, unread: true } }).chats === 'mark'
    && dots({ tab: 'channels', chats: { unread: true } }).chats === 'unread' && dots({ tab: 'channels' }).chats === null && dots({ tab: 'chats', chats: { waiting: true } }).chats === null);

  // ---- 検索の行
  const rows = channelNameRows(channels, parseTerms('check'));
  t.ok('名前の一致: 全角・大小を畳んで部分一致。DM は出さない', rows.map((r) => r.channelName).join(',') === 'Checkout-perf,checkout9,checkout10'
    && channelNameRows(channels, parseTerms('ＣＨＥＣＫ　perf')).length === 1 && channelNameRows(channels, parseTerms('owl')).length === 0);
  t.ok('名前の一致: 語が無ければ出さない・"…" は畳まない', channelNameRows(channels, []).length === 0 && channelNameRows(channels, parseTerms('"Check"')).length === 1);
  t.ok('名前の一致の行の形（id は投稿と重ならない）', rows[0].id === 'channel:c_2' && rows[0].channelId === 'c_2' && !rows[0].postId);
  const hits = [{ channelId: 'c_2', channelName: 'checkout-perf', postId: 'p_1', threadId: 'p_0', author: { kind: 'bot', botId: 'b_owl' }, at: 9, snippet: '…N+1 を直した' },
    { channelId: 'c_1', channelName: 'daily', postId: 'p_2', threadId: null, author: { kind: 'human' }, at: 7, snippet: 'おはよう' }];
  const posts = postRows(hits, (a) => (a.kind === 'bot' ? 'Owl' : 'あなた'));
  t.ok('投稿の行: 誰の発言か・抜粋・時刻・スレッド', posts[0].who === 'Owl' && posts[1].who === 'あなた' && posts[0].snippet === '…N+1 を直した'
    && posts[0].lastModified === 9 && posts[0].threadId === 'p_0' && posts[1].threadId === null && posts[0].id === 'post:c_2:p_1');
  t.ok('開く先: スレッドの中の投稿はスレッドも開く（channels:show の detail）', JSON.stringify(showDetail(posts[0])) === '{"kind":"channel","id":"c_2","threadId":"p_0"}'
    && JSON.stringify(showDetail(posts[1])) === '{"kind":"channel","id":"c_1"}' && JSON.stringify(showDetail(rows[0])) === '{"kind":"channel","id":"c_2"}');

  // ---- 脇で選ばれて見える行
  const bots = [{ id: 'b_owl', dmChannelId: 'c_d' }];
  t.ok('チャンネル → その行。DM → bot の行。bot のページ → bot の行。作る画面・無し → 無し',
    selectedRow({ kind: 'channel', id: 'c_1' }, bots)?.id === 'c_1' && JSON.stringify(selectedRow({ kind: 'channel', id: 'c_d' }, bots)) === '{"kind":"bot","id":"b_owl"}'
    && selectedRow({ kind: 'bot', id: 'b_owl' }, bots)?.kind === 'bot' && selectedRow({ kind: 'bot', id: 'new' }, bots) === null && selectedRow(null, bots) === null);

  // ---- 配線（文字列で）
  const index = read('web/channels/index.mjs');
  t.ok('部品の一覧に脇が入っている（タブは関数で渡す。一覧の後で作られるため）', /parts\.push\(createSidebar\(host, \(\) => tabs\)\)/.test(index) && /from '\.\/sidebar\.mjs'/.test(index));
  const sidebar = read('web/channels/sidebar.mjs');
  t.ok('読むのは channels.list・bots.list・channels.search、作るのは channels.create（invoke だけ。新しい WS コマンドは足さない）',
    ['channels.list', 'bots.list', 'channels.search', 'channels.create'].every((op) => sidebar.includes(`invoke('${op}'`)) && !/host\.cmd\(/.test(sidebar));
  t.ok('受ける出来事', ['channelsChanged', 'channelPost', 'channelRead', 'channelThread', 'botsChanged'].every((e) => sidebar.includes(`'${e}'`)));
  t.ok('開くのは channels:show（チャンネル・DM・bot を作る画面）', /new CustomEvent\('channels:show'/.test(sidebar) && /kind: 'bot', id: 'new'/.test(sidebar) && /b\.dmChannelId/.test(sidebar));
  t.ok('web/client.mjs・core/server.mjs には依存を足していない', !/client\.mjs|server\.mjs/.test(sidebar + read('web/channels/side-model.mjs')));
  const side = read('web/side.mjs');
  t.ok('Chats の木: bot の会話は状態のグループに入れず、全グループの上に「あなたを待っている」の見出しで置く', /visible\.filter\(\(s\) => s\.bot\)/.test(side)
    && /familiesOf\(visible\.filter\(\(s\) => !s\.bot\)/.test(side) && /"grp bot-waits"/.test(side) && /channels:side\.botWaitsHead/.test(side)
    && side.indexOf('"grp bot-waits"') < side.indexOf('for (const st of visibleGroups)'));
  t.ok('bot の会話の印: 一覧が無くても会話の題からチャンネル名を取り、id は出さない', /botTitleParts\(s\)\.channel/.test(side) && !/s\.bot\.channelId \?\? |#\$\{s\.bot\.channelId/.test(side));
  t.ok('bot の会話の行は状態へ落とせない・印（.row-ch）が付く', /if \(!interactive \|\| s\.bot\) return r;/.test(side) && /botChannelMark\(s\)/.test(side));
  t.ok('検索: チャンネルの当たりを混ぜ、出どころを添える', /connectChannels\(link\)/.test(side) && /channelsLink\.matchNames/.test(side) && /"row-src"/.test(side));
}
