// bot のページの決まりごと（web/channels/bot-model.mjs。DOM に触れない）: どのモードでフォルダーを限れないか（計画 §7.2-2）・
// 承認モードの選び直し・使用量の字・記憶の出どころの行き先・フォルダーの足し引き。
import { foldersUnlimited, validMode, onlyMode, modeAfterBackend, tokensText, usageView, sourceView, shortDate, shortTime, learnStatusView, newDraft, toggleAccess, addFolder, removeFolder } from '../../web/channels/bot-model.mjs';

export const name = 'bot-page-model';
export const title = 'bot のページ: 全部自動でフォルダーを限れないのは範囲 full だけ・承認モードの選び直し・使用量・出どころの行き先';

// core/backends/*.mjs の MODES の軸だけを写したもの
const CLAUDE = { default: { scope: 'workspace', autonomy: 'ask' }, plan: { scope: 'none', autonomy: 'ask' }, bypass: { scope: 'full', autonomy: 'never' } };
const CODEX = { ask: { scope: 'workspace', autonomy: 'ask' }, full: { scope: 'workspace', autonomy: 'never' }, yolo: { scope: 'full', autonomy: 'never' }, readonly: { scope: 'readonly', autonomy: 'judge' } };
const AGY = { yolo: { scope: 'full', autonomy: 'never' } };

export default async function (t) {
  t.ok('Claude の YOLO は書き込みの範囲を限れない', foldersUnlimited(CLAUDE.bypass));
  t.ok('Claude の都度確認・計画は限れる', !foldersUnlimited(CLAUDE.default) && !foldersUnlimited(CLAUDE.plan));
  t.ok('Codex の全部自動は sandbox が作業場所に限るので、限れる扱いのまま（決定 5 の変更）', !foldersUnlimited(CODEX.full));
  t.ok('Codex の YOLO（sandbox なし）は限れない', foldersUnlimited(CODEX.yolo));
  t.ok('Antigravity の yolo は限れない', foldersUnlimited(AGY.yolo));
  t.ok('モードが分からないときは限れる扱い（誤って無効にしない）', !foldersUnlimited(undefined));

  t.ok('語彙にある承認モードはそのまま', validMode(CODEX, 'full') === 'full');
  t.ok('語彙に無ければ default、無ければ先頭', validMode(CLAUDE, 'ask') === 'default' && validMode(CODEX, 'default') === 'ask' && validMode({}, 'x') === '');
  t.ok('バックエンドを替えても、同じ id があれば承認モードを保つ', modeAfterBackend(CODEX, 'ask') === 'ask' && modeAfterBackend(AGY, 'default') === 'yolo');
  t.ok('選べるモードが 1 つのバックエンドだけ onlyMode が返す（Antigravity）', onlyMode(AGY) === 'yolo' && onlyMode(CLAUDE) === null && onlyMode({}) === null);

  t.ok('トークンの短い字', [tokensText(0), tokensText(980), tokensText(1500), tokensText(312000), tokensText(1420000), tokensText(2100000)].join(' ') === '0 980 1.5k 312k 1.42M 2.1M',
    [tokensText(0), tokensText(980), tokensText(1500), tokensText(312000), tokensText(1420000), tokensText(2100000)].join(' '));
  const u = usageView({ weekTokens: 1420000, cacheRatio: 0.94 });
  t.ok('使用量: キャッシュ読み出しの割合', u.tokens === '1.42M' && u.cache === 94 && !u.warn && !u.empty);
  t.ok('使用量: 9 割を切ったら注意', usageView({ weekTokens: 10, cacheRatio: 0.89 }).warn && !usageView({ weekTokens: 10, cacheRatio: 0.9 }).warn);
  t.ok('使用量: 読み出しが無い（null）ときは割合を出さない・注意もしない', usageView({ weekTokens: 310000, cacheRatio: null }).cache === null && !usageView({ weekTokens: 5, cacheRatio: null }).warn);
  t.ok('使用量: 無いときも壊れない', usageView(undefined).tokens === '0' && usageView(undefined).empty);

  const now = new Date(2026, 9, 3, 12).getTime();
  t.ok('日付: 今日は null、昨日までは M/D', shortDate(new Date(2026, 9, 3, 1).getTime(), now) === null && shortDate(new Date(2026, 9, 2, 23).getTime(), now) === '10/2');

  // 夜の記憶の整理の 1 行（ADR 0117）
  t.ok('時刻: 今日は HH:MM、ほかの日は M/D HH:MM', shortTime(new Date(2026, 9, 3, 2, 5).getTime(), now) === '02:05' && shortTime(new Date(2026, 9, 2, 23, 0).getTime(), now) === '10/2 23:00');
  const keys = (v) => v.parts.map((p) => p.key).join();
  t.ok('整理: まだ走っていない・次の予定', keys(learnStatusView({ lastRunAt: null, lastResult: null, nextAt: now + 3600000, paused: false }, now)) === 'never,next');
  const ran = learnStatusView({ lastRunAt: now - 3600000, lastResult: { at: now - 3600000, read: 4, changed: 3, deferred: 1 }, nextAt: now + 86400000, paused: false }, now);
  t.ok('整理: 覚えた件数・後に回した会話・次の予定（目立たせない）', keys(ran) === 'ran,deferred,next' && ran.parts[0].params.n === 3 && ran.parts[0].params.when === '11:00' && !ran.warn, JSON.stringify(ran));
  t.ok('整理: 何も覚えなかった回', keys(learnStatusView({ lastRunAt: now, lastResult: { at: now, read: 0, changed: 0 }, nextAt: null, paused: false }, now)) === 'ranNone');
  const bad = learnStatusView({ lastRunAt: null, lastResult: null, nextAt: now, paused: false, failure: { message: 'down', count: 1 }, skip: { reason: 'failed', count: 2 } }, now);
  t.ok('整理: 失敗と飛ばした回数（理由）は目立たせる', keys(bad) === 'never,failed,skipped,next' && bad.warn && bad.parts[2].params.reasonKey === 'failed');
  t.ok('整理: 止めているときは次の予定の代わりに「止めている」', keys(learnStatusView({ lastRunAt: null, lastResult: null, nextAt: null, paused: true, skip: { reason: 'paused', count: 1 } }, now)) === 'never,skipped,paused');
  t.ok('整理: 様子が無ければ出さない', learnStatusView(null) === null);

  const channels = new Map([['c1', { id: 'c1', kind: 'channel', name: 'checkout-perf' }], ['c2', { id: 'c2', kind: 'dm', name: 'Owl', botId: 'b1' }]]);
  const bots = new Map([['b1', { id: 'b1', name: 'Owl', icon: '🦉' }]]);
  const sessions = new Map([['s1', { id: 's1', title: 'p95 の調査' }]]);
  const look = { channels, bots, sessions };
  const post = sourceView({ kind: 'post', channelId: 'c1', threadId: 'p_1', postId: 'p_2', at: new Date(2026, 9, 2).getTime() }, look, now);
  t.ok('出どころ（投稿）: チャンネル名・日付・行き先（スレッドと投稿まで）', post.where.type === 'channel' && post.where.name === 'checkout-perf' && post.date === '10/2'
    && JSON.stringify(post.target) === JSON.stringify({ channelId: 'c1', threadId: 'p_1', postId: 'p_2' }), JSON.stringify(post));
  const dm = sourceView({ kind: 'post', channelId: 'c2', postId: 'p_3', at: now }, look, now);
  t.ok('出どころ（DM）: bot のアイコンと名前、今日', dm.where.type === 'dm' && dm.where.icon === '🦉' && dm.where.name === 'Owl' && dm.date === null);
  const chat = sourceView({ kind: 'message', sessionId: 's1', at: now }, look, now);
  t.ok('出どころ（Chats の会話）: 題と行き先', chat.where.type === 'chat' && chat.where.name === 'p95 の調査' && chat.target.sessionId === 's1');
  const gone = sourceView({ kind: 'message', sessionId: 'nope', at: now }, look, now);
  t.ok('出どころ（消えた会話）: 開けない（行き先なし）', gone.target === null && gone.where.name === '');
  t.ok('出どころ（無い）: none', sourceView(undefined).kind === 'none');

  const d = newDraft('claude', CLAUDE);
  t.ok('作る画面の下書き: 既定のアイコンと承認モード', d.isNew && d.icon === '🤖' && d.mode === 'default' && d.backend === 'claude' && d.name === '');

  const f = [{ path: 'D:/dev/a', access: 'rw' }, { path: 'D:/dev/b', access: 'ro' }];
  t.ok('フォルダー: 読み書き/読み取りを切り替える', JSON.stringify(toggleAccess(f, 'D:/dev/a').map((x) => x.access)) === '["ro","ro"]' && toggleAccess(f, 'D:/dev/b')[1].access === 'rw');
  t.ok('フォルダー: 足す（同じパスは大文字小文字・末尾の区切りを無視して足さない）', addFolder(f, 'D:/dev/c').length === 3 && addFolder(f, 'd:/DEV/a/').length === 2 && addFolder(f, '').length === 2);
  t.ok('フォルダー: 外す', JSON.stringify(removeFolder(f, 'D:/dev/a').map((x) => x.path)) === '["D:/dev/b"]');
  t.ok('フォルダー: 元の配列は変えない', f.length === 2 && f[0].access === 'rw');
}
