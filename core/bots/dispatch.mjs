// bot を起こす・配る（S4。ADR 0109・0108）。投稿の @ から会話を決め、途中送信・ターンの投稿の更新・止める・トークンの集計までを持つ。
// core/bots-host.mjs がこれを束ね、core/server.mjs のつなぎ目（turnExtras・onTurnEvent・onTurnEnd・onPermission・onCompacted・start）はここへ届く。
//
// i18n-dynamic: agent:brain.line.
// createDispatcher({ channels, bots, memory, host, emit, now }) → Dispatcher
//   channels / bots / memory … 各サービス（core/channels/service.mjs ほか）
//   host … core/server.mjs が createBotHost に渡す道具の束（core/bots-host.mjs の HostTools）。会話を走らせる・止める・途中送信するのに使う
//   emit … 全接続へ出す（sessionId: null）。会話ごとの出来事は host.emitSession
//
// Dispatcher（どれも例外を外へ出さない）:
//   start(): Promise<void>                                          … 届ける前の出来事の戻し（delivering → unknown、pending を配り直す）・前の起動で残った作業中の印の片付け
//   stop(): void
//   onPosted(post, channel, extra?): Promise<void>                  … channels.post の後。@ で bot を起こす（ChannelService.hooks.posted）。extra は { hold?, checked?, origin? }（ops の channels.post が渡す）
//   onReacted(post, channel, { emoji, on, by }): Promise<void>       … bot の投稿のリアクションが変わった（ChannelService.hooks.reacted）。次に起きたときに渡し、問いへの答えなら起こす
//   claimPost({ channelId, threadId, botId, sessionId }): { postId } | undefined   … bot が channels.post で書く前（ChannelService.hooks.botPost）。
//        そのターンの会話が自分のスレッドへ書くなら、最初の 1 件はターンの投稿に入れ（postId）、2 件目からは新しい投稿（postId: null）。会話が分からなければ undefined
//   stopThread({ channelId, threadId }, author): Promise<void>      … [止める]（ChannelService.hooks.stopThread）。origin で結ばれた派生のスレッド（bot が起こして新しくできたもの）も止める
//   wakePost({ channelId, postId, botId }): Promise<{ woken, reason? }>   … 承認された起こし方（channels.wake の本体）。止めたスレッド・@ していない投稿は起こさない
//   wake({ botId, channel, threadId, post }): Promise<void>         … 1 体の bot を起こす（onPosted と、ルーティンの実行が使う）
//   turnExtras(turn): Promise<{ botInstructions: null, notes: string[] }>   … bot の会話のターンの始まり。末尾（memory.turnContext の notes）とターンの投稿の作成
//   onTurnEvent(turn, event): void                                  … bot の会話の分だけ。本文の積み上げ・usage・present・渡った合図
//   onTurnEnd(turn, { outcome, interrupted, requeued }): Promise<void>   … ターンの投稿を確定し、返事の @ で次の bot を起こし、たまった出来事をまとめて渡す
//   onPermission(card, phase): void                                 … 承認待ちの開始・決着（phase: 'open' | 'settled'）
//   onCompacted(sessionId): Promise<void>                           … 圧縮が終わった → snapshotDue = true・delivered = []
//
// 起こす規則（承認済み。docs/channels.md「起こし方」）:
//   - 投稿の本文の明示的な @ だけで起こす（自分自身への @ は、書いた会話のスレッドの中では数えない。別のスレッドへ書いたものは、そのスレッドの自分の会話を起こす）。
//     チャンネルの流れの投稿で @ されたら、その投稿を根にスレッドを作る。
//   - DM は人の投稿がすべてその bot 宛て（@ 不要）。スレッドは作らず、会話は bot ごとに 1 本（Bot.dmSessionId）。DM の中の他の bot への @ は起こさない。
//   - スレッドで @ の無い人の投稿は、宛先の 1 体が受ける（ADR 0117）: 投稿の `>` の引用がスレッドの bot の投稿と一致すればその bot（ADR 0128 の追記）、
//     当たらなければ、今作業中（始めかけを含む）の bot が 1 体だけならそれ、そうでなければそのスレッドで最後に話した bot
//     （いちばん新しい bot の投稿の bot）、bot の投稿がまだ無ければスレッドの会話を持つ bot が 1 体だけならそれ。
//     スレッドの会話を持つほかの bot には、聞こえた投稿（包みに heard="true"）として届く（ADR 0128）。宛先がこの投稿で新しいターンを始めたら、その返事が
//     書き終わってから、返事も添えて届ける。返事をするかは各 bot が決め、文章を書かずに終えたら投稿は残らない（聞こえただけのターンは、見せるものができるまで「…」を作らない）。
//     聞こえた投稿は予算（ADR 0119）が残っている間だけ届ける（使い切ったら宛先の 1 体だけ）。休憩中の bot には知らせずに届けない。
//     聞こえた投稿の包みには、誰との話の続きかを to="<宛先の bot の名前>" で付ける（ADR 0128 の追記。引用した bot か、最後に話した bot）。
//     足すのは bot の名前だけ（bot の思考は渡さない）。@ のある投稿は @ の相手が受け、引用では宛先を変えない。
//     bot・Chats の AI の @ の無い投稿は誰も起こさない（暗黙の宛先は人の投稿だけ。bot 同士が起こし合わない）。
//   - ThreadState.stopped があれば、人が次に書くまで起こさない。ThreadState.calls は数えるだけ。
//   - bot の投稿へのリアクションは、その bot の会話へ次に起きたときに渡す（包みに reaction="👍"）。起こすのは、問いかけの投稿に付いた答えのリアクション（👍 👎 など）だけで、
//     その投稿・付けた者ごとに 1 回まで。付けたのが人でも bot・Chats の AI でも同じに起こす。ただし人でない者のリアクションは予算が残っている間だけ（使い切っても知らせない）で、
//     DM では起こさない（予算の数え先が無い。DM への bot の書き込みで起こさないのと同じ）。外したら、まだ渡していない同じリアクションを取り消す（ADR 0109 の追記）。
//   - bot が bot を起こす（返事・channels.post の @、呼んだ bot へ返す返事）のは、チャンネルの予算が残っている間だけ（ADR 0119。回数の上限は置かない）。
//     使い切ったら起こさない（Pleiad はお知らせを出さない。人が呼べば起きる）。数えるのは core/bots/budget.mjs。残りは毎ターン末尾の文脈で bot に渡す。
//   - 使用量の上限に当たった bot は休憩中（core/bots/resting.mjs）。休憩中の @ は配らず、その場所に 1 回だけ Pleiad のお知らせを出す（ADR 0119）。
//   - bot の投稿で bot を呼ぶのは行頭の半角の @名前 だけ（mentions.mjs の strict）。人は全角の ＠ も文中も数える。どちらも括弧・コード・引用の中は数えない。
//   - 動く承認モードが投稿した bot より強い bot（範囲・自律のどちらかが上）は、bot の返事の @ では起こさない（起こさなかったことをスレッドの投稿で知らせる。人が @ すると起きる）。
//     channels.post の @ は ops が決め済み（extra.hold・checked）で、承認（channels.wake）が出る。人の投稿は確認しない。
// 配る: inbox.json（core/bots/inbox.mjs）へ pending で保存してから、走っているターンがあり途中送信できれば control.steer、
//   無ければ新しいターン、途中送信できない（Antigravity・圧縮・人の送信待ち）・忙しいときはターンの終わりにまとめて渡す。結果不明は自動では送り直さない。
// ターンの投稿: ターンが始まると、そのスレッドに bot の投稿を 1 つ作り（state: working）、本文を 1 秒に 1 回まで書き換える。
//   終わりにターン中の assistant の文章を順番どおりまとめ、提示と state を決める。
//   ターンの中で bot が channels.post で自分のスレッドへ書いたら、最初の 1 件はターンの投稿に入り、2 件目からは新しい投稿（ADR 0117）。
//   assistant の文章は道具や Stop フックを挟んでも、順番どおりにターンの投稿へまとめる。途中送信でも投稿は分けない。
//   生の流れ（text.delta）はチャンネルへ流さず、サーバーで投稿に畳む（ADR 0024 の 1 接続 1 購読）。
import path from 'node:path';
import crypto from 'node:crypto';
import { agentT } from '../i18n.mjs';
import { authorKey, channelEnvelope, channelThreadEnvelope, channelEventRows, turnContextEnvelope, innerEnvelope } from '../channels/types.mjs';
import { TURN_CONTEXT_TAG } from '../system-messages.mjs';
import { innerTail, WORK_NOTES_VERSION } from '../brain/inner.mjs';
import { createInboxStore } from './inbox.mjs';
import { strongerMode } from './approval.mjs';
import { createBudget } from './budget.mjs';
import { inputWithCache } from '../usage.mjs';
import { createResting, restKey } from './resting.mjs';
import { LIMITS as CHANNEL_LIMITS } from '../channels/service.mjs';
import { isSilentReply, speakingParts, stripSilentMark } from './silence.mjs';
import { answerOf, asksQuestion, excerpt } from './reactions.mjs';
import { quotedPost } from './quotes.mjs';

/** ターンの投稿の本文を書き換える間隔の下限（ms）。全接続へ配る間隔と同じ */
export const PROGRESS_INTERVAL_MS = 1000;
/** 新しい会話・再開に渡す、スレッドのそれまでの投稿の上限 */
export const CONTEXT_POSTS = 30;
export const CONTEXT_CHARS = 20000;
/** ターンの投稿を作った直後の本文（言語を持たない印。本文が出たら置き換わる） */
export const PLACEHOLDER = '…';
/** 途中経過の本文に出す最小の長さ（文字数）。これより短い文・断片（`a`・`12`・短い独り言）は、最終の返事で置き換わるまで本文に出さない */
export const PROGRESS_MIN_CHARS = 40;
// 途中経過に出す区切り: 文の終わり（。！？ . ! ?）か改行。書きかけの文は出さない（1 秒おきの更新が文の途中に当たって、1 文字の断片が一瞬出るため）
const SENTENCE_END = /^[\s\S]*(?:[。．！？!?]|\n|\.(?=\s))/;
const postText = (value) => {
  const text = String(value ?? '').trim();
  if (text.length <= CHANNEL_LIMITS.text) return text;
  let end = CHANNEL_LIMITS.text - 1;
  if (/[\uD800-\uDBFF]/.test(text[end - 1])) end--;
  return `${text.slice(0, end)}…`;
};
/**
 * ターンの投稿の途中経過。書き終えた文章と、今書いている文の切れ目までを出す。
 * 短い断片は途中では表示せず、ターンの終わりに全ての文章を入れる。
 */
export function progressBody(rec) {
  // 黙る印（[[no-reply]]）は途中経過にも出さない
  const settled = stripSilentMark(rec.cur ? (rec.cur.match(SENTENCE_END)?.[0] ?? '') : '');
  if (rec.parts?.length) {
    const body = postText(speakingParts([...rec.parts, settled]).join('\n\n'));
    return [...body].length >= PROGRESS_MIN_CHARS ? body : '';
  }
  for (const text of [settled, rec.last]) {
    const body = stripSilentMark(text);
    if ([...body].length >= PROGRESS_MIN_CHARS) return body;
  }
  return '';
}
const RETRY_MS = 3000;
/** 起こさずに次のターンへ回すリアクションの、会話ごとの上限（古いものから捨てる） */
export const QUIET_REACTIONS = 20;
/** 始められなかったターンの後に、たまった出来事を配り直す回数（失敗が続くなら止める。次の @ でまとめて渡る） */
const START_RETRIES = 3;
/** スレッドのトークンの足し算を書く間隔（ms）。スレッドの状態の書き込みと全接続への配信を毎秒にしない。ターンの終わりには必ず書く */
export const CREDIT_INTERVAL_MS = 5000;
/** チャンネルの「ここでの決まり」を bot へ渡す長さの上限（字）。保存の上限（LIMITS.memo = 4000）より短く、超えたぶんは channels.get で読ませる */
const MEMO_PROMPT_CHARS = 2000;
const PRESENT_MAX = 8;
const PRESENT_BYTES = 1_000_000;
// バックエンドが入力を受け取ったあとにしか出せない出来事（core/server.mjs の ANSWER_EVENTS と同じ）。最初のものが「渡った」の目印
const ANSWER_EVENTS = new Set(['text.delta', 'text.end', 'thinking.delta', 'tool.start']);
const POST_KINDS = new Set(['thread', 'dm', 'routine']);

const pad = (n) => String(n).padStart(2, '0');
/** 包みの at: 現地時刻の分まで */
export const stamp = (ms) => { const d = new Date(ms); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`; };
const sum = (a, b) => ({ input: (a?.input ?? 0) + (b?.input ?? 0), output: (a?.output ?? 0) + (b?.output ?? 0), cached: (a?.cached ?? 0) + (b?.cached ?? 0) });
const botAuthor = (botId) => ({ kind: 'bot', botId });
const threadKeyOf = (channelId, threadId) => (threadId ? `${channelId}/${threadId}` : null);
const log = (...a) => console.error('  dispatch:', ...a);
/** 末尾の文脈（<pleiad-turn-context>。記憶の tail が作る）の最後のものに text を足す。無ければ新しく足す（末尾を 1 つの包みに保つ） */
function withTail(notes, text) {
  const open = `<${TURN_CONTEXT_TAG}>\n`, close = `\n</${TURN_CONTEXT_TAG}>`, env = turnContextEnvelope(text);
  const at = notes.findLastIndex((n) => n.startsWith(open) && n.endsWith(close));
  if (at < 0) return [...notes, env];
  return notes.map((n, i) => (i === at ? `${n.slice(0, -close.length)}\n\n${env.slice(open.length)}` : n));
}
const errText = (e) => String(e?.message ?? e);

export function createDispatcher({ channels, bots, memory, episodes, brain = null, host, emit = () => {}, now = Date.now } = {}) {
  const inbox = createInboxStore({ dir: channels?.dir ?? path.join(host?.dataDir ?? '.', 'channels'), now });
  const active = new Map();        // sessionId → ターンの記録（begin から onTurnEnd まで）
  const starting = new Map();      // sessionId → 自分が始めたターンのうち、まだ turnExtras に届いていないもの
  const liveSteers = new Map();    // 途中送信の item id → 「渡った」合図を待っているもの
  const pumps = new Map();         // sessionId → 配る処理の直列化
  const retries = new Map();       // sessionId → 忙しいときの再試行のタイマー
  const sidecarChains = new Map(); // sessionId → sidecar `bot` の書き換えの直列化
  const threadChains = new Map();  // threadKey → スレッドの状態の書き換えの直列化
  const threadStates = new Map();  // threadKey → 最後に書いた ThreadState.state と live の印
  const creating = new Map();      // threadKey/botId → スレッドの会話を作っている最中
  const startFailures = new Map(); // sessionId → 始められなかった回数（配り直しの上限用。始まったら消す）
  const stoppedKeys = new Set();   // 止めたスレッド（canStart の同期の判定用。人が書いたら外す）
  const failedKeys = new Set();    // 最後のターンが失敗で終わったスレッド
  const followers = new Map();     // sessionId → その会話のターンが終わったら、ほかの bot に聞かせる処理（@ の無い人の投稿。ADR 0128）
  const budget = createBudget({ channels, host, now, log, brain });
  const resting = createResting({ now, onChange: (key) => restingChanged(key) });
  let reactionChain = Promise.resolve();   // リアクションの出来事は 1 件ずつ（連打・付け外しの重なりを見分ける）
  let closed = false;

  const rt = () => host?.runtime;
  const locale = () => host?.currentLocale?.() ?? 'ja';
  const getBot = (botId) => bots.get({ botId }).catch(() => null);
  const readSidecar = async (sessionId) => (sessionId ? (await host.store.get(sessionId).catch(() => null))?.bot ?? null : null);
  /** sidecar の `bot`。書き換え（updateSidecar）が進行中なら、それが終わってから読む（commit の直後の startTurn が古い postCursor・memRev を読まないため） */
  const sidecarOf = async (sessionId) => { await sidecarChains.get(sessionId); return readSidecar(sessionId); };

  /** sidecar の `bot` を読んで書き換える（同じ会話の更新は 1 本ずつ）。fn が null を返したら書かない */
  function updateSidecar(sessionId, fn) {
    const prev = sidecarChains.get(sessionId) ?? Promise.resolve();
    const run = prev.then(async () => {
      const sb = await readSidecar(sessionId);
      if (!sb) return null;
      const next = fn({ ...sb });
      if (next) await host.store.setSessionData(sessionId, 'bot', next, { durable: true });
      return next;
    }).catch((e) => { log('could not write the bot field of a conversation:', errText(e)); return null; });
    const tail = run.then(() => {}, () => {});
    sidecarChains.set(sessionId, tail);
    tail.then(() => { if (sidecarChains.get(sessionId) === tail) sidecarChains.delete(sessionId); });
    return run;
  }

  // ------------------------------------------------------------ スレッドの状態

  /** スレッドの状態を、走っているターン・承認待ち・最後の失敗から決めて書く（変わったときだけ） */
  function refreshThread(channelId, threadId) {
    const key = threadKeyOf(channelId, threadId);
    if (!key) return Promise.resolve();
    const prev = threadChains.get(key) ?? Promise.resolve();
    const run = prev.then(async () => {
      const recs = [...active.values()].filter((r) => r.channelId === channelId && r.threadId === threadId && !r.ended);
      const going = recs.length > 0 || [...starting.values()].some((s) => s.channelId === channelId && s.threadId === threadId);
      const state = recs.some((r) => r.waiting.size) ? 'waiting' : going ? 'working' : failedKeys.has(key) ? 'failed' : 'idle';
      // どの bot が動いているか（state はスレッド全体の集計）。始めたばかりのターンは作業中として数える
      const live = {};
      for (const s of starting.values()) if (s.channelId === channelId && s.threadId === threadId && s.botId) live[s.botId] = 'working';
      for (const r of recs) live[r.botId] = r.waiting.size ? 'waiting' : 'working';
      const mark = JSON.stringify([state, Object.entries(live).sort(([x], [y]) => x.localeCompare(y))]);
      if (threadStates.get(key) === mark) return;
      await channels.threads.update(channelId, threadId, { state, live });
      threadStates.set(key, mark);
    }).catch((e) => log('could not write the thread state:', errText(e)));
    const tail = run.then(() => {}, () => {});
    threadChains.set(key, tail);
    tail.then(() => { if (threadChains.get(key) === tail) threadChains.delete(key); });
    return run;
  }

  const bumpCalls = (channelId, threadId) => channels.threads.update(channelId, threadId, (cur) => ({ calls: (cur.calls ?? 0) + 1 })).catch((e) => log('could not write the wake count:', errText(e)));

  /** 使ったトークンを、この記録が足し終えた分との差だけスレッドへ足す（usage は 1 ターンの累計なので、差分で足せば二重にならない） */
  function credit(rec) {
    if (!rec.threadId) return Promise.resolve();
    const live = { input: rec.usage.inputTokens ?? 0, output: rec.usage.outputTokens ?? 0, cached: rec.usage.cachedTokens ?? 0 };
    const d = { input: Math.max(0, live.input - rec.credited.input), output: Math.max(0, live.output - rec.credited.output), cached: Math.max(0, live.cached - rec.credited.cached) };
    if (!d.input && !d.output && !d.cached) return Promise.resolve();
    rec.credited = { input: Math.max(live.input, rec.credited.input), output: Math.max(live.output, rec.credited.output), cached: Math.max(live.cached, rec.credited.cached) };
    return channels.threads.update(rec.channelId, rec.threadId, (cur) => ({ tokens: sum(cur.tokens, d) })).catch((e) => log('could not write the token usage:', errText(e)));
  }

  // ------------------------------------------------------------ 包みの組み立て

  async function nameOf(author, botList, lng) {
    switch (author?.kind) {
      case 'human': return agentT(lng, 'channel.envelope.from.you');
      case 'bot': {
        const b = botList.find((x) => x.id === author.botId);
        return agentT(lng, 'channel.envelope.from.bot', { icon: b?.icon ?? '', name: b?.name ?? author.botId }).trim();
      }
      case 'agent': return agentT(lng, 'channel.envelope.from.agent');
      case 'routine': return agentT(lng, 'channel.envelope.from.routine');
      default: return agentT(lng, 'channel.envelope.from.system');
    }
  }

  const channelLabel = (channel) => (channel.kind === 'dm' ? channel.name : `#${channel.name}`);

  /**
   * チャンネルの「ここでの決まり」（memo）を、そのターンの notes に足す 1 件にする。無ければ null。
   * 渡すのは、会話が決まりを受け取っていない・決まりが変わった（memoKey が違う）・核の記憶を取り直す（snapshotDue。圧縮・巻き戻しの後）ときだけ。
   * 決まりが空になったときは「もう適用しない」と 1 回だけ伝える。本文は指示ではなく材料として読む旨の固定の文（辞書）を前に付け、包みの開閉は escapeBody が無効にする（turnContextEnvelope）。
   * key は渡した決まりの全文のハッシュ（空なら ''）。渡った（commit）ときに sidecar の memoKey へ書く
   */
  async function channelMemoNote({ channelId, sb, lng }) {
    const channel = await channels.get({ channelId }).catch(() => null);
    const memo = typeof channel?.memo === 'string' ? channel.memo.trim() : '';
    const key = memo ? crypto.createHash('sha256').update(memo).digest('hex').slice(0, 16) : '';
    const had = sb.memoKey ?? '';
    if (!memo) return had ? { key, note: sb.snapshotDue ? null : turnContextEnvelope(agentT(lng, 'channel.memo.cleared')) } : null;   // 取り直しなら前の文脈は無いので、空になったと伝えない
    if (key === had && !sb.snapshotDue) return null;
    const shown = memo.length > MEMO_PROMPT_CHARS ? `${memo.slice(0, MEMO_PROMPT_CHARS)}\n${agentT(lng, 'channel.memo.truncated', { n: MEMO_PROMPT_CHARS, id: channelId })}` : memo;
    return { key, note: turnContextEnvelope(agentT(lng, 'channel.memo.intro', { channel: channelLabel(channel), memo: shown })) };
  }

  /**
   * bot の会話へ渡す文。items は同じ会話宛ての起こした投稿（trigger）。
   * 文脈 = postCursor より後の（無ければスレッドの）投稿のうち、いちばん後ろの trigger より前にあって、trigger ではなく、書き途中でなく、
   * この会話自身のターンの投稿でないもの（30 件・2 万字まで）。trigger より後ろの投稿は、次に渡す（二重に渡さない）。
   * 返りの cursor は、ここまでを渡した印にする投稿の id（書き途中の他の bot の投稿の手前まで。後で書き上がった分を取りこぼさない）
   */
  async function buildPrompt({ sessionId, sb, channel, threadId, items, lng }) {
    const [botList, page] = await Promise.all([bots.list(), channels.read({ channelId: channel.id, ...(threadId ? { threadId } : {}), limit: 100 })]);
    // 消した投稿もカーソルの位置を探す材料に残す。消された投稿を境に古い文脈を再送しない。
    const posts = page.posts;
    // 自分の心拍から起きた出来事（inner。ADR 0126）は投稿を持たない。本文は <pleiad-inner> の包みで渡す
    const postItems = items.filter((i) => i.postId && !i.reaction);
    // bot の投稿に付いたリアクション（ADR 0109 の追記）。投稿は文脈ではなく、リアクションの包みの本文に書き出しを入れる
    const reactionItems = items.filter((i) => i.postId && i.reaction);
    const innerItems = items.filter((i) => i.inner?.workNotesVersion === WORK_NOTES_VERSION);
    const triggerIds = new Set(postItems.map((i) => i.postId));
    // 聞こえただけの投稿（@ の無い人の投稿の、宛先でない bot。ADR 0128）。包みに heard="true" を付ける。
    // 渡すのが聞こえた投稿だけなら、その後に書き上がった投稿（宛先の bot の返事など）も後ろに渡す（それを見て、言うことがあるかを決める）
    const heardIds = new Set(postItems.filter((i) => i.heard && !postItems.some((o) => o.postId === i.postId && !o.heard)).map((i) => i.postId));
    const heardOnly = postItems.length > 0 && !innerItems.length && postItems.every((i) => heardIds.has(i.postId));
    // 聞こえた投稿が誰との話の続きか（ADR 0128 の追記）。自分なら付けない。消えた bot の名前は出さない
    const heardTo = new Map(postItems.filter((i) => heardIds.has(i.postId) && i.heardTo && i.heardTo !== sb?.botId && botList.some((b) => b.id === i.heardTo)).map((i) => [i.postId, i.heardTo]));
    const from = sb?.postCursor ? posts.findIndex((p) => p.id === sb.postCursor) : -1;
    const afterCursor = from >= 0 ? posts.slice(from + 1) : posts;
    const lastTrigger = afterCursor.reduce((at, p, i) => (triggerIds.has(p.id) ? i : at), -1);
    const fresh = heardOnly ? afterCursor : afterCursor.slice(0, lastTrigger + 1);     // いちばん後ろの trigger まで（聞こえた投稿だけなら最後まで）
    const own = (p) => p.turn?.sessionId === sessionId || (p.author?.kind === 'bot' && p.author.botId === sb?.botId);
    // 書き途中の他の bot の投稿は文脈に入れず、その手前までしか進めない
    let cut = fresh.findIndex((p) => p.state === 'working' && !own(p) && !triggerIds.has(p.id));
    if (cut < 0) cut = fresh.length;
    const usable = (p) => !p.deletedAt && !triggerIds.has(p.id) && !own(p) && p.state !== 'working';
    const settled = fresh.slice(0, Math.min(cut, lastTrigger + 1)).filter(usable);
    const following = heardOnly ? fresh.slice(lastTrigger + 1, cut).filter(usable).slice(0, CONTEXT_POSTS) : [];
    // 上限は新しい方から数える
    const picked = [];
    let chars = 0;
    for (const p of [...settled].reverse()) {
      if (picked.length >= CONTEXT_POSTS || (chars += p.text.length) > CONTEXT_CHARS) break;
      picked.push(p);
    }
    picked.reverse();
    const common = { channel: channelLabel(channel), channelId: channel.id, thread: threadId ?? undefined };
    const env = async (p) => ({ ...common, post: p.id, from: await nameOf(p.author, botList, lng), at: stamp(p.at), text: p.text });
    const triggers = [];
    for (const item of postItems) {
      const p = posts.find((x) => x.id === item.postId) ?? await channels.getPost({ channelId: channel.id, postId: item.postId }).catch(() => null);
      if (p && !p.deletedAt) triggers.push(p);
    }
    const parts = [];
    if (picked.length) parts.push(channelThreadEnvelope({ ...common, posts: await Promise.all(picked.map(env)) }));
    for (const item of innerItems) parts.push(innerEnvelope({ kind: item.inner.kind === 'wake' ? 'wake' : 'pulse', at: stamp(item.at) }, item.inner.text));
    // 呼んだ bot の返事（reply）は、包みに reply="true" を付ける（固定文: 呼んだ bot の返事は reply の付いた包みで返ってくる）
    const replies = new Set(postItems.filter((i) => i.reply).map((i) => i.postId));
    let reactions = 0;
    for (const item of [...reactionItems].sort((a, b) => (a.reaction.at ?? 0) - (b.reaction.at ?? 0))) {
      const p = posts.find((x) => x.id === item.postId) ?? await channels.getPost({ channelId: channel.id, postId: item.postId }).catch(() => null);
      if (!p || p.deletedAt) continue;
      // 渡す前に外された（今は付いていない）リアクションは渡さない
      if (!(p.reactions?.[item.reaction.emoji] ?? []).some((a) => authorKey(a) === item.reaction.byKey)) continue;
      reactions++;
      parts.push(channelEnvelope({ ...common, post: p.id, from: await nameOf(item.reaction.by, botList, lng), at: stamp(item.reaction.at ?? now()), reaction: item.reaction.emoji,
        text: agentT(lng, 'channel.envelope.reaction', { emoji: item.reaction.emoji, text: excerpt(p.text) }) }));
    }
    for (const p of triggers) {
      const to = heardTo.has(p.id) ? await nameOf({ kind: 'bot', botId: heardTo.get(p.id) }, botList, lng) : undefined;
      parts.push(channelEnvelope({ ...(await env(p)), ...(replies.has(p.id) ? { reply: 'true' } : {}), ...(heardIds.has(p.id) ? { heard: 'true' } : {}), ...(to ? { to } : {}) }));
    }
    if (following.length) parts.push(channelThreadEnvelope({ ...common, posts: await Promise.all(following.map(env)) }));
    const payloadNotes = triggers.filter((p) => p.author.kind === 'routine' && p.taint === 'webhook' && p.routine?.payload).map((p) => p.routine.payload);
    const cursor = (cut >= fresh.length ? fresh.at(-1) : cut > 0 ? fresh[cut - 1] : null)?.id ?? sb?.postCursor ?? null;
    // 引き継ぎで起きたターンの印（予算の数え先・流れに残す結果の行・外から来た文の印）。複数なら最初のもの
    const inner = innerItems.length ? { ...innerItems[0].inner } : null;
    return { prompt: parts.join('\n'), payloadNotes, cursor, incomingText: [...triggers.map((p) => p.text), ...innerItems.map((i) => i.inner.why ?? '')].join('\n'), triggers, inner, heardOnly, reactions };
  }

  // ------------------------------------------------------------ 起こす

  async function threadStopped(channelId, threadId) {
    if (!threadId) return false;
    return Boolean((await channels.threads.get(channelId, threadId).catch(() => null))?.stopped);
  }

  /** 投稿の後。ターンの投稿（作りたての「…」・進捗の更新）では起こさない。誰を起こすかは route */
  function onPosted(post, channel, extra) {
    // ターンの投稿の作成・進捗では起こさない。bot が channels.post で書いた返事が入ったとき（extra.filled）は、新しい投稿と同じく @ を解く
    if (post?.turn && !extra?.filled) return Promise.resolve();
    // bot が自分のスレッドへ書いた返事を、そのターンの記録に残す（呼んだ bot へ返す返事・@ の重なりの判断）
    const rec = post?.author?.kind === 'bot' ? [...active.values()].find((r) => r.spoke && !r.ended && r.botId === post.author.botId && r.channelId === post.channelId
      && (r.threadId ?? null) === (post.threadId ?? null) && (!extra?.bySession || r.sessionId === extra.bySession)
      && (!post.turn?.sessionId || r.sessionId === post.turn.sessionId)) : null;
    if (rec) { if (!post.turn) rec.explicit = post; for (const m of post.mentions ?? []) rec.explicitMentions.add(m); }
    return route(post, channel, extra);
  }

  /**
   * bot が channels.post で書く前に、ChannelService が聞く（hooks.botPost）。sessionId はその操作を呼んだ会話。
   * その会話の走っているターンが同じスレッド（DM なら DM）へ書くなら、それがこのターンの返事: 最初の 1 件はターンの投稿に入れ、2 件目からは新しい投稿にする。
   * 返事を書いた印（spoke）が立つと、終わりの最終の返答は投稿に書かない（作業の報告で返事を上書きしない。ADR 0117）。
   * 会話が分からない（sessionId なし）なら undefined（service がこれまでの規則で決める）
   */
  function claimPost({ channelId, threadId = null, botId, sessionId } = {}) {
    if (!sessionId) return undefined;
    const rec = active.get(sessionId);
    if (!rec || rec.ended || rec.botId !== botId || rec.channelId !== channelId || (rec.threadId ?? null) !== (threadId ?? null)) return { postId: null };
    rec.spoke = true;
    if (rec.postId && !rec.filled) {
      rec.filled = true;
      rec.botControlled = true;   // 途中経過の本文で上書きしない
      return { postId: rec.postId };
    }
    return { postId: null };
  }

  /**
   * スレッドで @ の無い人の投稿を渡す bot（ADR 0117）。今作業中（始めかけを含む）の bot が 1 体だけならそれ（途中送信で書き足す）。
   * そうでなければ、そのスレッドで最後に話した bot（その投稿より前の、いちばん新しい bot の投稿の bot）。bot の投稿がまだ無ければ、スレッドの会話を持つ bot が 1 体だけならそれ。決まらなければ null
   */
  async function conversingBot(channelId, threadId, postId) {
    const working = new Set([...active.values(), ...starting.values()].filter((r) => r.channelId === channelId && r.threadId === threadId && !r.ended).map((r) => r.botId));
    if (working.size === 1) return [...working][0];
    const page = await channels.read({ channelId, threadId, limit: 100 }).catch(() => null);
    const before = page?.posts ?? [];
    const upto = before.findIndex((p) => p.id === postId);
    const last = (upto >= 0 ? before.slice(0, upto) : before).findLast((p) => !p.deletedAt && p.author?.kind === 'bot' && p.author.botId);
    if (last) return last.author.botId;
    const known = Object.keys((page?.threads?.[0] ?? await channels.threads.get(channelId, threadId).catch(() => null))?.sessions ?? {});
    return known.length === 1 ? known[0] : null;
  }

  /**
   * 人の投稿の `>` の引用が、同じスレッドのそれより前の bot の投稿の本文と一致するなら、その bot（ADR 0128 の追記。core/bots/quotes.mjs）。
   * @ の無い人の投稿の宛先の 1 体にし、聞こえた投稿の包みの to にもする。引用が無い・当たらなければ null（conversingBot に任せる）
   */
  async function quotedBot(channelId, threadId, post) {
    if (!String(post.text ?? '').includes('>')) return null;
    const page = await channels.read({ channelId, threadId, limit: 100 }).catch(() => null);
    const posts = page?.posts ?? [];
    const upto = posts.findIndex((p) => p.id === post.id);
    const said = (upto >= 0 ? posts.slice(0, upto) : posts).filter((p) => p.author?.kind === 'bot' && p.author.botId && p.state !== 'working');
    const botId = quotedPost(post.text, said)?.author.botId ?? null;
    // 消えた bot を引用しても宛先にしない（最後に話した bot に任せる）
    return botId && await getBot(botId) ? botId : null;
  }

  /** その bot の会話（sessionId）が、自分のスレッドでない所（threadId。チャンネルの流れへの投稿ならその投稿が根になる）へ書いたか。会話が引けなければ false（自分への @ を数えない） */
  async function writtenElsewhere(sessionId, botId, channelId, threadId) {
    const sb = await sidecarOf(sessionId).catch(() => null);
    if (!sb || sb.botId !== botId) return false;
    return !(sb.channelId === channelId && (sb.threadId ?? null) === (threadId ?? null));
  }

  /** その bot（targetId）の動く承認モードが、投稿した bot（subjectId）より強いか。モードが引けなければ強いとは見なさない */
  async function strongerThan(targetId, subjectId) {
    const [target, subject] = await Promise.all([bots.approvalOf?.({ botId: targetId }), bots.approvalOf?.({ botId: subjectId })]);
    return Boolean(target && subject && strongerMode(target.entry, subject.entry));
  }

  /**
   * @ の宛先を決めて起こす。ターンの終わりに確定した返事も、同じ規則でここを通る。
   * extra: ops の channels.post が渡す。hold = 起こさない bot（承認の channels.wake に回した）・checked = 強さの確認は済み・origin = 起こして新しくできるスレッドの元
   */
  async function route(post, channel, extra = {}) {
    try {
      if (closed || !post || post.deletedAt || !channel) return;
      const kind = post.author?.kind;
      if (kind !== 'human' && kind !== 'bot' && kind !== 'agent') return;
      const key = threadKeyOf(channel.id, post.threadId);
      if (kind === 'human' && key) stoppedKeys.delete(key);   // 人が書いた（service が ThreadState.stopped を外している）
      if (channel.archivedAt) return;
      const ownBot = kind === 'bot' ? post.author.botId : null;
      let threadId = post.threadId;
      let targets = [];
      let heard = [];                                          // 宛先のほかに、聞こえた投稿として届ける bot（@ の無い人の投稿。ADR 0128）
      let origin = null;
      if (channel.kind === 'dm') {
        if (kind === 'bot') return;
        threadId = null;
        targets = channel.botId ? [channel.botId] : [];
      } else {
        // 自分への @ は、書いた会話のスレッドの中では数えない（呼び合いの輪にならない）。別のスレッドへ書いた自分への @ は、そのスレッドの自分の会話を起こす（別の会話なので）
        const selfElsewhere = ownBot && extra.bySession ? await writtenElsewhere(extra.bySession, ownBot, channel.id, post.threadId ?? post.id) : false;
        const groupRequested = kind === 'human' && (post.mentions ?? []).some((m) => m === 'here' || m === 'everyone');
        const mentioned = (post.mentions ?? []).filter((m) => !['you', 'here', 'everyone'].includes(m) && (m !== ownBot || selfElsewhere));
        // 入力欄の宛先のチップで選んだ bot（人の投稿だけ）。本文の @ が先に効き、@ が無いときの宛先になる（ADR 9101）
        const chosen = kind === 'human' && typeof post.to === 'string' && post.to ? post.to : null;
        if (post.threadId === null) {
          if (!mentioned.length && !chosen) return;
          threadId = post.id;                                  // チャンネルの流れへの投稿で @ されたら（宛先を選んでいたら）、その投稿を根にスレッドを作る
          targets = mentioned.length ? mentioned : [chosen];
          origin = extra.origin ?? null;                       // bot が自分のスレッドから書いたなら、新しいスレッドは元のスレッドの［止める］に結ばれる
        } else {
          if (await threadStopped(channel.id, post.threadId)) return;
          if (mentioned.length) targets = mentioned;
          else if (kind === 'human' && !groupRequested) {
            // @ の無い人の投稿は、`>` で引用した投稿の bot が受ける（ADR 0128 の追記）。引用が当たらなければ、そのスレッドで最後に話した bot が受ける
            // （作業中なら途中送信、そうでなければ新しいターン）。スレッドにいるほかの bot にも、聞こえた投稿として届く（返事をするかは各 bot が決める。
            // 包みの to に宛先の名前を付ける。ADR 0128）。bot・AI の @ の無い投稿は誰も起こさない
            const botId = chosen ?? (await quotedBot(channel.id, post.threadId, post)) ?? await conversingBot(channel.id, post.threadId, post.id);
            heard = (await threadBots(channel.id, post.threadId)).filter((id) => id !== botId);
            if (!botId && !heard.length) return;
            targets = botId ? [botId] : [];
          } else return;
        }
      }
      const unique = [...new Set(targets)];
      const held = new Set(extra.hold ?? []);
      // 確認を通っていない bot の投稿（返事の @）は、動くモードが自分より強い bot を起こさない。起こさなかったことを知らせる
      if (ownBot && !extra.checked) {
        for (const botId of unique) {
          if (!(await strongerThan(botId, ownBot))) continue;
          held.add(botId);
          await announceHeld(channel, post, botId, ownBot);
        }
      }
      if (origin && unique.length) await channels.threads.update(channel.id, threadId, { origin }).catch((e) => log('could not write the thread origin:', errText(e)));
      let addressed = null;
      for (const botId of unique) {
        if (held.has(botId)) continue;
        const woken = await wake({ botId, channel, threadId, post }).catch((e) => { log(`${botId} could not be woken:`, errText(e)); return null; });
        if (heard.length) addressed = woken;
      }
      if (heard.length) await overhear({ addressed, heard, channel, threadId, post, talkingTo: targets[0] ?? null });
    } catch (e) { log('failed to handle a post:', errText(e)); }
  }

  /** スレッドにいる bot（そのスレッドの会話を持つ bot。ThreadState.sessions の鍵）。消えた bot は wake が飛ばす */
  async function threadBots(channelId, threadId) {
    const th = await channels.threads.get(channelId, threadId).catch(() => null);
    return Object.keys(th?.sessions ?? {});
  }

  /**
   * @ の無い人の投稿を、宛先でない bot（heard）に聞こえた投稿として届ける（ADR 0128）。宛先の bot がこの投稿で新しいターンを始めたなら、
   * そのターンが終わってから届ける（宛先の返事も見たうえで、付け足すことがあるかを決められる。全員が同じことを言わない）。
   * 宛先が無い・作業中で途中送信した・起こせなかったときは、すぐ届ける。talkingTo = 誰との話の続きか（包みの to。受け取る bot 自身には付けない）
   */
  async function overhear({ addressed, heard, channel, threadId, post, talkingTo = null }) {
    const deliver = async () => {
      for (const botId of heard) await wake({ botId, channel, threadId, post, heard: true, talkingTo }).catch((e) => log(`${botId} could not hear a post:`, errText(e)));
    };
    const sid = addressed?.sessionId;
    const fresh = sid && addressed.itemId && [starting.get(sid), active.get(sid)].some((r) => r?.itemIds?.includes(addressed.itemId) && !r.ended);
    if (!fresh) return deliver();
    followers.set(sid, [...(followers.get(sid) ?? []), deliver]);
  }

  /** 宛先の bot のターンが終わった（始まらなかった）: 待たせていた聞こえた投稿を届ける */
  async function releaseFollowers(sessionId) {
    const waiting = followers.get(sessionId);
    if (!waiting) return;
    followers.delete(sessionId);
    for (const deliver of waiting) await deliver();
  }

  /** 強いモードの bot を返事の @ では起こさなかったことを、そのスレッドの投稿で知らせる（人が @ すれば起きる） */
  async function announceHeld(channel, post, targetId, subjectId) {
    const target = await bots.approvalOf({ botId: targetId });
    const subject = await bots.approvalOf({ botId: subjectId });
    const label = (b) => `${b?.icon ?? ''} ${b?.name ?? ''}`.trim();
    await systemPost(channel.id, post.threadId ?? null, agentT(locale(), 'channel.heldWake', { bot: label(target), mode: target?.label ?? '', from: label(subject) }));
  }

  /**
   * 承認された起こし方（channels.wake の本体）。投稿の @（DM なら DM の bot）が確かめられるものだけ起こす。止めたスレッドは起こさない。
   * 返りは { woken: true } か { woken: false, reason: 'notFound' | 'notMentioned' | 'stopped' | 'archived' }
   */
  async function wakePost({ channelId, postId, botId }) {
    if (closed) return { woken: false, reason: 'closed' };
    const channel = await channels.get({ channelId }).catch(() => null);
    const post = channel ? await channels.getPost({ channelId, postId }).catch(() => null) : null;
    if (!channel || !post || post.deletedAt) return { woken: false, reason: 'notFound' };
    if (channel.archivedAt) return { woken: false, reason: 'archived' };
    const asked = channel.kind === 'dm' ? channel.botId === botId : (post.mentions ?? []).includes(botId) || post.to === botId;
    if (!asked) return { woken: false, reason: 'notMentioned' };
    const threadId = channel.kind === 'dm' ? null : (post.threadId ?? post.id);
    if (await threadStopped(channel.id, threadId)) return { woken: false, reason: 'stopped' };
    await wake({ botId, channel, threadId, post, approved: true });
    return { woken: true };
  }

  /**
   * bot の投稿のリアクションが変わった（ChannelService.hooks.reacted）。by = 付けた・外した者、on = 付けたか。
   * 付けたリアクションは、その投稿を書いた bot の会話へ出来事（inbox の reaction）として積み、次に起きたときに `reaction` の包みで渡す（それだけでは起こさない）。
   * 問いかけの投稿に付いた答えのリアクション（👍 👎 など。reactions.mjs の answerOf）だけは、その bot を起こす（その投稿・付けた者ごとに 1 回まで）。
   * 付けたのが人でも、ほかの bot・Chats の AI でも同じに起こす。ただし人でない者のリアクションは、予算が残っている間だけ起こし、DM では起こさない（次に渡す）。
   * 自分のリアクションは渡さない。外したら、まだ渡していない同じ出来事を取り消す（付け外しで重ねない）
   */
  function onReacted(post, channel, change) {
    const run = reactionChain.then(() => reacted(post, channel, change));
    reactionChain = run.then(() => {}, () => {});
    return run;
  }
  async function reacted(post, channel, { emoji, on, by } = {}) {
    try {
      if (closed || !post || post.deletedAt || !channel || post.author?.kind !== 'bot' || !emoji || !by) return;
      const botId = post.author.botId;
      const byKey = authorKey(by);
      if (!byKey || byKey === authorKey(post.author)) return;
      const target = await reactionTarget(post, channel);
      if (!target) return;
      const same = (i) => i.postId === post.id && i.reaction?.emoji === emoji && i.reaction?.byKey === byKey;
      const items = (await inbox.list({ sessionId: target.sessionId })).filter((i) => i.postId === post.id && i.reaction);
      const waiting = items.filter((i) => i.status === 'pending' && same(i));
      if (!on) { if (waiting.length) await inbox.remove(waiting.map((i) => i.id)); return; }
      // まだ渡していない・もう渡した同じリアクションがある（連打・外して付け直した）
      if (waiting.length || items.some((i) => i.status !== 'pending' && same(i))) return;
      // 起こすのは: 問いかけの投稿に・答えのリアクションが付いた・その投稿をその者のリアクションでまだ起こしていない・止めた/アーカイブのスレッドでない。
      // 付けたのが人でも bot・Chats の AI でも同じ。「その者ごとに 1 回」なので、bot の 👍 が先に起こしても、人の答えはまた起こす
      const stopped = Boolean(target.threadId) && (stoppedKeys.has(threadKeyOf(channel.id, target.threadId)) || await threadStopped(channel.id, target.threadId));
      let wakes = Boolean(answerOf(emoji)) && asksQuestion(post.text) && !channel.archivedAt && !stopped
        && !items.some((i) => i.reaction.byKey === byKey && !i.reaction.quiet);
      // 人でない者（bot・Chats の AI）のリアクションで起こすのは、bot の @ と同じく予算が残っている間だけ（使い切っても知らせない。人の操作は止めない）。
      // DM には予算の数え先が無いので起こさない（route() が DM への bot の書き込みで起こさないのと同じ。予算で止まらない起こし合いを作らない）
      if (wakes && by.kind !== 'human' && (channel.kind === 'dm' || !(await budget.allows({ channelId: channel.id, threadId: target.threadId })))) wakes = false;
      // 休憩中なら起こさない（その場所で初めてならお知らせを出す）。リアクションは次に起きたときに渡す
      if (wakes) { const bot = await getBot(botId); if (!bot || await restingWake(bot, channel, target.threadId)) wakes = false; }
      await inbox.add({ sessionId: target.sessionId, botId, channelId: channel.id, threadId: target.threadId, postId: post.id, reaction: { emoji, by: structuredClone(by), byKey, at: now(), ...(wakes ? {} : { quiet: true }) } });
      if (!wakes) {
        // 起こさずに待たせるリアクションは、会話ごとに新しい QUIET_REACTIONS 件まで（起きない bot に溜め続けない）
        const quiet = (await inbox.list({ sessionId: target.sessionId, status: 'pending' })).filter((i) => i.reaction?.quiet);
        if (quiet.length > QUIET_REACTIONS) await inbox.remove(quiet.slice(0, quiet.length - QUIET_REACTIONS).map((i) => i.id));
        return;
      }
      if (target.threadId) await bumpCalls(channel.id, target.threadId);
      await pump(target.sessionId);
    } catch (e) { log('failed to handle a reaction:', errText(e)); }
  }

  /**
   * リアクションを渡す先の会話（作らない）。ターンの投稿ならそのターンの会話。DM なら bot の DM の会話。
   * スレッドの投稿（根を含む）なら、そのスレッドの bot の会話。チャンネルの流れの投稿でスレッドが無ければ渡さない
   */
  async function reactionTarget(post, channel) {
    const botId = post.author.botId;
    if (channel.kind === 'dm') {
      const bot = await getBot(botId);
      const sessionId = post.turn?.botId === botId ? post.turn.sessionId : bot?.dmSessionId;
      return sessionId && channel.botId === botId ? { sessionId, threadId: null } : null;
    }
    const threadId = post.threadId ?? post.id;
    if (post.turn?.botId === botId && post.turn.sessionId && (await sidecarOf(post.turn.sessionId))?.botId === botId) return { sessionId: post.turn.sessionId, threadId };
    const sessionId = (await channels.threads.get(channel.id, threadId).catch(() => null))?.sessions?.[botId];
    return sessionId && (await sidecarOf(sessionId))?.botId === botId ? { sessionId, threadId } : null;
  }

  /**
   * スレッドの bot の会話の設定を、このスレッドだけ変える（channels.threadSettings。ADR 9101）。会話がまだ無ければ作る。
   * 走っていれば次のターンから（予約 nextSettings）。変えた欄は sidecar の overrides に印を付け、bot の既定を変えても上書きしない
   */
  async function threadSettings({ channelId, threadId, botId, backend, model, effort, mode, cwd }) {
    const channel = await channels.get({ channelId });
    if (channel.kind === 'dm') throw Object.assign(new Error('a DM has no thread settings'), { code: 'INVALID' });
    const root = await channels.getPost({ channelId, postId: threadId });
    if (!root || root.threadId !== null) throw Object.assign(new Error(`thread not found: ${threadId}`), { code: 'POST_NOT_FOUND' });
    const bot = await getBot(botId);
    if (!bot) throw Object.assign(new Error(`bot not found: ${botId}`), { code: 'BOT_NOT_FOUND' });
    // 組み込みの bot の会話は、最初の設定（backend・作業場所）で作る。backend は作った後は変えない
    const sessionId = await sessionFor({ bot, channel, threadId, post: root, ...(bot.plain ? { backend, cwd } : {}) });
    const patch = { ...(model !== undefined ? { model } : {}), ...(effort !== undefined ? { effort } : {}), ...(mode !== undefined ? { mode } : {}), ...(cwd !== undefined ? { cwd } : {}) };
    if (Object.keys(patch).length) await host.reserveTurnSettings({ sessionId, backend: bot.backend, ...patch });
    await updateSidecar(sessionId, (sb) => ({ ...sb, overrides: { ...(sb.overrides ?? {}), ...Object.fromEntries(Object.keys(patch).map((k) => [k, true])) } }));
    const meta = await host.store.get(sessionId);
    const next = meta.nextSettings ?? {};
    return { sessionId, backend: meta.backend, model: next.model ?? meta.model ?? '', effort: next.effort ?? meta.effort ?? '', mode: next.mode ?? meta.mode ?? '', cwd: next.cwd ?? meta.cwd ?? '' };
  }

  /**
   * スレッドを atPostId のところで分ける（channels.branchThread。ADR 9101 の 4.4）。
   * bot ごとに、atPostId より後の投稿を最初に含むまとまりの手前で会話を分ける（無ければ末尾まで）。atPostId より後に呼ばれた bot（残す配達が無い）は連れて行かない。
   * 子の会話の sidecar は親の写しで、スレッドは新しい根・postCursor は残した配達のうち最後の投稿の写し（P と後ろの投稿を 1 通にまとめて渡していたら P の前。次のターンで P を渡し直す）。
   * 投稿を黙って写し（channels.branchCopy）、新しいスレッドの状態（会話・利用者の状態）を作る。予算・呼んだ回数・申し送り・止めた印は写さない
   */
  async function branchThread({ channelId, threadId, atPostId }) {
    const all = [];
    let before;
    do {
      const page = await channels.read({ channelId, threadId, ...(before ? { before } : {}), limit: 100 });
      all.unshift(...page.posts);
      before = page.nextBefore;
    } while (before);
    const at = all.findIndex((p) => p.id === atPostId);
    if (at < 0) throw Object.assign(new Error(`post not found: ${atPostId}`), { code: 'POST_NOT_FOUND' });
    const order = new Map(all.map((p, i) => [p.id, i]));
    const th = await channels.threads.get(channelId, threadId).catch(() => null);
    const children = {};   // botId → { sessionId, cursor }
    for (const [botId, sessionId] of Object.entries(th?.sessions ?? {})) {
      const messages = await host.readMessages(sessionId);
      let cut = null, cursor = -1, kept = 0;
      for (const m of messages) {
        if (m?.kind !== 'channelEvent') continue;
        const ids = m.history ? [...String(m.body ?? '').matchAll(/post="([^"]+)"/g)].map((x) => x[1]) : [m.postId].filter(Boolean);
        const idx = ids.map((id) => order.get(id)).filter((i) => i !== undefined);
        if (idx.some((i) => i > at)) {
          cut = m.groupUuid ?? m.uuid ?? null;
          if (!cut) throw new Error('could not find where to cut the conversation');
          break;
        }
        kept++;
        cursor = Math.max(cursor, ...idx);
      }
      if (!kept) continue;
      const made = await host.forkSession({ sessionId, ...(cut ? { beforeMessageId: cut } : {}) });
      children[botId] = { sessionId: made.sessionId, parent: sessionId, cursor: cursor >= 0 ? all[cursor].id : null };
    }
    const sessions = Object.fromEntries(Object.values(children).map((c) => [c.parent, c.sessionId]));
    const { root, idMap } = await channels.branchCopy({ channelId, threadId, atPostId, sessions });
    for (const [botId, child] of Object.entries(children)) {
      const parent = await sidecarOf(child.parent);
      const sb = { ...(parent ?? {}), botId, kind: 'thread', channelId, threadId: root.id, postCursor: child.cursor ? idMap.get(child.cursor) ?? null : null,
        snapshotDue: true, delivered: [] };
      delete sb.recentDelivered;
      await host.store.setSessionData(child.sessionId, 'bot', sb, { durable: true });
    }
    if (Object.keys(children).length) await channels.threads.update(channelId, root.id, { sessions: Object.fromEntries(Object.entries(children).map(([botId, c]) => [botId, c.sessionId])) });
    if (th?.status) await channels.setThreadStatus({ channelId, threadId: root.id, status: th.status }, { kind: 'human' }).catch(() => {});
    return { channelId, threadId: root.id };
  }

  /**
   * スレッドのあなたの投稿 H を送り直す（channels.resend。ADR 9101 の 4.5。ADR 0102 の順: 全部確かめてから変える）。
   * bot ごとに、H 以後の投稿を最初に含むまとまりの手前まで会話を巻き戻す（巻き戻せない bot・H 以後に会話が始まった bot はスレッドから外す。
   * 次に呼ばれたら新しい会話で始まる）。走っていれば stopRunning で止める（無ければ SESSION_RUNNING で断る）。届ける前の出来事は捨てる。
   * sidecar を戻し（postCursor = H の直前・snapshotDue）、H とその後ろを取り下げ、新しい本文を人の投稿として書く（宛先は決まり直す）
   */
  async function resendThread({ channelId, threadId, postId, text, attachments, stopRunning = false, clientId, to }) {
    const all = [];
    let before;
    do {
      const page = await channels.read({ channelId, threadId, ...(before ? { before } : {}), limit: 100 });
      all.unshift(...page.posts);
      before = page.nextBefore;
    } while (before);
    const at = all.findIndex((p) => p.id === postId);
    if (at <= 0) throw Object.assign(new Error(`not a reply in this thread: ${postId}`), { code: 'POST_NOT_FOUND' });
    const order = new Map(all.map((p, i) => [p.id, i]));
    const th = await channels.threads.get(channelId, threadId).catch(() => null);
    const plans = [];   // { botId, sessionId, cut | null（外す） }
    for (const [botId, sessionId] of Object.entries(th?.sessions ?? {})) {
      const messages = await host.readMessages(sessionId);
      let cut = null, kept = 0;
      for (const m of messages) {
        if (m?.kind !== 'channelEvent') continue;
        const ids = m.history ? [...String(m.body ?? '').matchAll(/post="([^"]+)"/g)].map((x) => x[1]) : [m.postId].filter(Boolean);
        if (ids.some((id) => (order.get(id) ?? -1) >= at)) { cut = m.groupUuid ?? m.uuid ?? null; break; }
        kept++;
      }
      if (!cut) continue;                                         // H を受けていない: そのまま
      if (!kept) { plans.push({ botId, sessionId, cut: null }); continue; }   // H 以後に始まった会話: 外す
      try { await host.rewindPlan({ sessionId, beforeMessageId: cut }); plans.push({ botId, sessionId, cut }); }
      catch (e) { log('a bot conversation cannot be rewound; it leaves the thread:', errText(e)); plans.push({ botId, sessionId, cut: null }); }
    }
    const running = plans.filter((p) => host.sessionBusy?.(p.sessionId));
    if (running.length && !stopRunning) throw Object.assign(new Error('a bot is still working in this thread'), { code: 'SESSION_RUNNING' });
    const cursor = all[at - 1].id;
    const leave = [];
    for (const plan of plans) {
      const pending = await inbox.list({ sessionId: plan.sessionId });
      const drop = pending.filter((i) => i.status === 'pending' || i.status === 'delivering').map((i) => i.id);
      if (drop.length) await inbox.remove(drop);
      if (!plan.cut) {
        if (host.sessionBusy?.(plan.sessionId)) await host.abortSessions?.({ sessionId: plan.sessionId, reason: 'user' }).catch(() => {});
        leave.push(plan.botId);
        continue;
      }
      await host.rewindSession({ sessionId: plan.sessionId, beforeMessageId: plan.cut, stopRunning });
      await updateSidecar(plan.sessionId, (sb) => {
        const next = { ...sb, postCursor: cursor, snapshotDue: true, delivered: [] };
        delete next.memoKey; delete next.personaKey; delete next.recentDelivered;
        return next;
      });
    }
    if (leave.length) await channels.threads.update(channelId, threadId, { sessions: Object.fromEntries(leave.map((botId) => [botId, null])) });
    await channels.withdraw({ channelId, postIds: all.slice(at).map((p) => p.id) });
    return channels.post({ channelId, threadId, text, ...(attachments?.length ? { attachments } : {}), ...(clientId ? { clientId } : {}), ...(to ? { to } : {}) }, { kind: 'human' });
  }

  /** この bot の、このスレッド（DM なら DM）の会話。無ければ作る */
  async function sessionFor({ bot, channel, threadId, post, backend = null, cwd = null }) {
    if (channel.kind === 'dm') return (await bots.ensureDmSession({ botId: bot.id })).sessionId;
    const key = `${threadKeyOf(channel.id, threadId)}/${bot.id}`;
    const running = creating.get(key);
    if (running) return running;
    const work = (async () => {
      const th = await channels.threads.get(channel.id, threadId);
      const known = th?.sessions?.[bot.id];
      if (known && (await sidecarOf(known))?.botId === bot.id) return known;
      const rootText = threadId === post.id ? post.text : (await channels.getPost({ channelId: channel.id, postId: threadId }).catch(() => null))?.text ?? '';
      const made = await bots.createSession({ botId: bot.id, channel, threadId, kind: 'thread', rootText, ...(backend ? { backend } : {}), ...(cwd ? { cwd } : {}) });
      await channels.threads.update(channel.id, threadId, { sessions: { [bot.id]: made.sessionId } });
      return made.sessionId;
    })().finally(() => creating.delete(key));
    creating.set(key, work);
    return work;
  }

  /**
   * 1 体の bot を、この投稿で起こす（届ける前の出来事を保存してから配る）。届けたら { sessionId, itemId }、配らなかったら null。
   * heard: @ の無い人の投稿を、宛先でない bot に聞こえた投稿として届ける（ADR 0128）。予算を使い切っていたら配らず、休憩中なら知らせずに配らない。
   * talkingTo: 聞こえた投稿が誰との話の続きか（bot の id。自分なら残さない。ADR 0128 の追記）
   */
  async function wake({ botId, channel, threadId, post, approved = false, heard = false, talkingTo = null }) {
    const bot = await getBot(botId);
    if (!bot) return null;
    // 使用量の上限で休憩中なら配らない（解除の後にもう一度呼んでもらう）。その場所で初めてなら知らせる（聞こえただけの投稿では知らせない）
    if (heard ? resting.until(bot) : await restingWake(bot, channel, threadId)) return null;
    // bot が bot を起こすのは、チャンネルの予算が残っている間だけ（人が承認した channels.wake は人の操作なので止めない）。使い切っても知らせない。
    // 聞こえただけの投稿も、人が宛てた相手ではないので、予算が残っている間だけ届ける（使い切ったら宛先の 1 体だけが受ける）
    if ((heard || (post.author?.kind === 'bot' && !approved)) && !(await budget.allows({ channelId: channel.id, threadId }))) return null;
    const sessionId = await sessionFor({ bot, channel, threadId, post });
    // 呼んだのが別の bot なら、この会話のターンが終わったときに返事を返す相手として残す（人・ルーティン・外から来た文には返さない）
    const caller = post.author?.kind === 'bot' && post.author.botId !== botId ? post.author.botId : null;
    const item = await inbox.add({ sessionId, botId, channelId: channel.id, threadId, postId: post.id, ...(caller ? { caller } : {}), ...(heard ? { heard: true } : {}), ...(heard && talkingTo && talkingTo !== botId ? { heardTo: talkingTo } : {}) });
    if (threadId) await bumpCalls(channel.id, threadId);
    await pump(sessionId);
    return { sessionId, itemId: item?.id ?? null };
  }

  // ------------------------------------------------------------ 配る

  function pump(sessionId) {
    const prev = pumps.get(sessionId) ?? Promise.resolve();
    const run = prev.then(() => pumpOnce(sessionId)).catch((e) => log('could not deliver:', errText(e)));
    pumps.set(sessionId, run);
    run.then(() => { if (pumps.get(sessionId) === run) pumps.delete(sessionId); });
    return run;
  }

  function retryLater(sessionId) {
    if (closed || retries.has(sessionId)) return;
    const timer = setTimeout(() => { retries.delete(sessionId); pump(sessionId); }, RETRY_MS);
    timer.unref?.();
    retries.set(sessionId, timer);
  }

  async function pumpOnce(sessionId) {
    if (closed) return;
    const pending = await inbox.list({ sessionId, status: 'pending' });
    if (!pending.length) return;
    // 止めたスレッドの出来事は捨てる
    const live = [];
    const dropped = [];
    for (const item of pending) (await threadStopped(item.channelId, item.threadId) ? dropped : live).push(item);
    if (dropped.length) await inbox.remove(dropped.map((i) => i.id));
    // 起こさないリアクション（reaction.quiet）だけなら配らない。次に起きたときに一緒に渡す
    if (!live.some((i) => !i.reaction?.quiet)) return;
    const turn = rt()?.turns?.get(sessionId);
    // 自分の心拍から起きた出来事（inner）は途中送信しない。走っているターンが終わってから、新しいターンで渡す（ADR 0126）
    if (turn || starting.has(sessionId)) { const steerable = live.filter((i) => !i.inner); return steerable.length ? steerAll(sessionId, steerable, turn) : undefined; }
    if (await host.noticeBlocked?.(sessionId)) { retryLater(sessionId); return; }
    return startTurn(sessionId, live);
  }

  /** 走っているターンへ書き足す（Claude・Codex）。渡せなければ pending のまま、ターンの終わりにまとめて渡す（Antigravity・圧縮・人の送信待ち） */
  async function steerAll(sessionId, items, turn) {
    if (!turn) return;
    const rec = active.get(sessionId);
    if (!rec) return;                                           // ターンの記録ができる前（turnExtras の前）。ターンの終わりに渡す
    const target = await host.noticeTarget?.(sessionId);
    if (!target) return;
    // 始めの投稿が「渡った」と確かめられる前は、始めの投稿の文脈（rec.cursor）を基準にする（commit が同じ値を書く）
    const stored = await sidecarOf(sessionId);
    const sb = stored && !rec.committed ? { ...stored, postCursor: rec.cursor ?? stored.postCursor ?? null } : stored;
    for (const group of groupByThread(items)) {
      const channel = await channels.get({ channelId: group[0].channelId }).catch(() => null);
      if (!channel) { await inbox.remove(group.map((i) => i.id)); continue; }
      const ids = group.map((i) => i.id);
      const built = await buildPrompt({ sessionId, sb, channel, threadId: group[0].threadId, items: group, lng: await lngOf(sessionId) });
      if (!built.triggers.length && !built.reactions) { await inbox.remove(ids); continue; }
      const message = { id: `channel-${group[0].id}`, args: { prompt: built.prompt } };
      const confirms = Boolean(target.control?.steerConfirms);
      await inbox.mark(ids, 'delivering');
      const callers = callersOf(group);
      if (confirms) liveSteers.set(message.id, { sessionId, ids, text: built.prompt, cursor: built.cursor, callers });
      let accepted = false;
      try { accepted = await target.control.steer(message); }
      catch (e) {
        liveSteers.delete(message.id);
        await inbox.mark(ids, 'unknown', { error: errText(e) });   // 結果不明。自動では送り直さない（ADR 0057 と同じ）
        continue;
      }
      if (!accepted) { liveSteers.delete(message.id); await inbox.mark(ids, 'pending'); return; }
      if (!confirms) await steered(sessionId, ids, built.prompt, built.cursor, callers);
    }
  }

  /** この出来事を起こした bot（呼んだ側）。bot ごとに最初の 1 件 */
  const callersOf = (items) => [...new Map(items.filter((i) => i.caller).map((i) => [i.caller, { botId: i.caller, postId: i.postId }])).values()];
  const groupByThread = (items) => {
    const groups = new Map();
    for (const i of items) { const k = `${i.channelId}/${i.threadId ?? ''}`; if (!groups.has(k)) groups.set(k, []); groups.get(k).push(i); }
    return [...groups.values()];
  };
  const lngOf = async (sessionId) => (await Promise.resolve(host.agentLocaleFor?.(sessionId)).catch(() => null)) ?? locale();

  /** 途中送信が渡った: 渡した印を残し、会話の画面へ出す */
  async function steered(sessionId, ids, text, cursor, callers = []) {
    const rec = active.get(sessionId);
    if (rec && !rec.ended) rec.receivedSteer = true;
    await inbox.mark(ids, 'sent');
    if (rec && !rec.committed && cursor) rec.cursor = cursor;
    if (rec) for (const c of callers) rec.callers.set(c.botId, c);   // 渡った呼び出しの返事も、このターンの終わりに返す
    if (cursor) await updateSidecar(sessionId, (sb) => ({ ...sb, postCursor: cursor }));
    host.emitSession?.(sessionId, { type: 'channelEvent', rows: channelEventRows(text) });
  }

  /** 新しいターンで渡す */
  async function startTurn(sessionId, items) {
    const sb = await sidecarOf(sessionId);
    const channel = sb ? await channels.get({ channelId: items[0].channelId }).catch(() => null) : null;
    if (!channel || channel.archivedAt) { await inbox.remove(items.map((i) => i.id)); return; }   // アーカイブされたチャンネルには、ターンの投稿も作れない
    const threadId = items[0].threadId;
    const lng = await lngOf(sessionId);
    const built = await buildPrompt({ sessionId, sb, channel, threadId, items, lng });
    const ids = items.map((i) => i.id);
    if (!built.triggers.length && !built.inner && !built.reactions) { await inbox.remove(ids); return; }
    await inbox.mark(ids, 'delivering');
    starting.set(sessionId, { inner: built.inner, heardOnly: built.heardOnly, itemIds: ids, payloadNotes: built.payloadNotes, incomingText: built.incomingText, cursor: built.cursor, channelId: channel.id, threadId, botId: items[0].botId, callers: callersOf(items) });
    refreshThread(channel.id, threadId);
    const key = threadKeyOf(channel.id, threadId);
    // 待たない（ターンが終わるまで返らない）。始められなかったときだけここで片付ける
    Promise.resolve(host.runTurn({ sessionId, prompt: built.prompt }, () => {}, { internal: true, canStart: () => !(key && stoppedKeys.has(key)) }))
      .then((result) => notStarted(sessionId, ids, result), (err) => notStarted(sessionId, ids, 'error', err));
  }

  /** runTurn が返った。ターンが始まらなかった（相手が忙しい・止めた・失敗）ものを片付ける */
  async function notStarted(sessionId, ids, result, err) {
    const pre = starting.get(sessionId);
    if (!pre || pre.itemIds !== ids) {
      // ターンの記録ができた（turnExtras が受け取った）後に、始まらずに戻された（canInvoke・requeue）。終わりは onTurnEnd へ届かないので、ここで片付ける
      const rec = active.get(sessionId);
      if (result === 'requeue' && rec && !rec.ended && !rec.committed && rec.itemIds === ids) {
        try { await abandon(rec, { requeue: true }); retryLater(sessionId); } catch (e) { log('could not clean up a requeued turn:', errText(e)); }
      }
      return;
    }
    starting.delete(sessionId);
    try {
      if (result === 'requeue') { await inbox.mark(ids, 'pending'); retryLater(sessionId); }
      else if (result === 'cancelled') await inbox.remove(ids);
      else {
        await inbox.mark(ids, 'unknown', { error: errText(err) });
        const failedKey = threadKeyOf(pre.channelId, pre.threadId);
        if (failedKey) failedKeys.add(failedKey);
        await systemPost(pre.channelId, pre.threadId, agentT(locale(), 'channel.turn.failed', { error: errText(err) }));
      }
      // 始められない間にたまった出来事（途中送信できず pending のまま）を取り残さない。止めた・失敗が続くときは配り直さない（次の @ でまとめて渡る）
      if (result !== 'requeue' && (await inbox.list({ sessionId, status: 'pending' })).length) {
        const failures = result === 'cancelled' ? 0 : (startFailures.get(sessionId) ?? 0) + 1;
        if (failures) startFailures.set(sessionId, failures);
        if (failures <= START_RETRIES) retryLater(sessionId);
      }
    } catch (e) { log('could not clean up a turn that did not start:', errText(e)); }
    await refreshThread(pre.channelId, pre.threadId);
    // 始まらなかった（戻して後で始めるときを除く）: 返事を待たせていた聞こえた投稿は、待たずに届ける（ADR 0128）
    if (result !== 'requeue') await releaseFollowers(sessionId).catch((e) => log('could not deliver a heard post:', errText(e)));
  }

  const systemPost = (channelId, threadId, text) => channels.post({ channelId, threadId, text }, { kind: 'system' }).catch((e) => log('could not write a system post:', errText(e)));

  // ------------------------------------------------------------ 休憩中（使用量の上限。ADR 0119）

  const botLabel = (bot) => `${bot?.icon ?? ''} ${bot?.name ?? ''}`.trim();
  /** 解除の時刻: 今日なら「14:20」、別の日なら「10/5 14:20」 */
  const whenOf = (ms) => {
    const d = new Date(ms), hm = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
    return d.toDateString() === new Date(now()).toDateString() ? hm : `${d.getMonth() + 1}/${d.getDate()} ${hm}`;
  };

  /** 休憩中の bot を起こそうとした: 配らずに true（依頼は預からない。解除の後にもう一度呼んでもらう）。その場所（スレッド・DM）で休憩中に初めてなら、Pleiad のお知らせを出す */
  async function restingWake(bot, channel, threadId) {
    const until = resting.until(bot);
    if (!until) return false;
    if (resting.noticeOnce(bot, `${channel.id}/${threadId ?? ''}`)) await systemPost(channel.id, threadId ?? null, agentT(locale(), 'channel.resting.wake', { bot: botLabel(bot), time: whenOf(until) }));
    return true;
  }

  /** ターンが使用量の上限で終わった: その bot（同じバックエンド・モデルの bot も）を解除の時刻まで休ませ、このスレッド（DM）に知らせる */
  async function limitReached(rec, resetsAt) {
    const bot = await getBot(rec.botId);
    if (!bot) return;
    const until = resting.rest(bot, resetsAt) ?? resting.until(bot);
    if (until) resting.noticeOnce(bot, `${rec.channelId}/${rec.threadId ?? ''}`);   // この後の @ で同じ知らせを重ねない
    await systemPost(rec.channelId, rec.threadId, until
      ? agentT(locale(), 'channel.resting.limited', { bot: botLabel(bot), time: whenOf(until) })
      : agentT(locale(), 'channel.resting.limitedNoTime', { bot: botLabel(bot) }));
  }

  /** 休み始めた・休み終えた: 同じバックエンド・モデルの bot の画面を描き直させる（bots.overview の restingUntil） */
  async function restingChanged(key) {
    try {
      for (const bot of await bots.list()) if (restKey(bot) === key) emit({ type: 'botsChanged', bot: { ...bot, restingUntil: resting.until(bot) } });
    } catch (e) { log('could not announce a resting bot:', errText(e)); }
  }

  // ------------------------------------------------------------ ターン

  async function turnExtras(turn) {
    const none = { botInstructions: null, notes: [] };
    const sessionId = turn?.info?.sessionId;
    if (!sessionId || turn.compactTrigger) return none;
    const sb = await sidecarOf(sessionId);
    if (!sb) return none;
    // 心拍の安いモデルの隠れた会話（ADR 0126）は、末尾の文脈も投稿も作らない（人格は bots の turnSetup が足す）
    if (sb.kind === 'pulse') return none;
    const bot = await getBot(sb.botId);
    if (!bot) return none;
    if (!sb.taint && sb.threadId && sb.channelId) {
      const root = await channels.getPost({ channelId: sb.channelId, postId: sb.threadId });
      if (root?.taint === 'webhook') {
        sb.taint = 'webhook';
        await updateSidecar(sessionId, (cur) => ({ ...cur, taint: 'webhook' }));
      }
    }
    const pre = starting.get(sessionId);
    if (pre) starting.delete(sessionId);
    startFailures.delete(sessionId);
    // 前のターンの記録が残っている（始まらずに戻された・終わりが届かなかった）。作業中の印を外す
    const old = active.get(sessionId);
    if (old && !old.ended) await abandon(old);
    const channelId = sb.channelId ?? (sb.kind === 'dm' ? bot.dmChannelId : null);
    const rec = {
      sessionId, botId: bot.id, kind: sb.kind, channelId, threadId: sb.threadId ?? null, taint: sb.taint ?? pre?.inner?.taint ?? undefined, postId: null, postReady: null,
      // 自分の心拍から起きたターン（inner: 予算の数え先・結果の行の印）と、心拍が動いている bot か（呼ばれたターンの後にも流れへ 1 行足す。ADR 0126）
      inner: pre?.inner ?? null, pulseBot: Boolean(brain && bot.pulse?.on),
      itemIds: pre?.itemIds ?? [], cursor: pre?.cursor ?? null, tail: null, callers: new Map((pre?.callers ?? []).map((c) => [c.botId, c])),
      // 聞こえた投稿だけで始まったターン（ADR 0128）は、見せるもの（文・提示・承認待ち）ができるまでターンの投稿（「…」）を作らない。黙って終えたら何も残らない
      deferPost: Boolean(pre?.heardOnly),
      cur: '', last: '', parts: [], sawText: false, presents: [],
      // bot が channels.post で自分のスレッドへ書いた（spoke）・そのうち最初の 1 件がターンの投稿に入った（filled）・2 件目からの新しい投稿の最後（explicit）
      spoke: false, filled: false, explicit: null, explicitMentions: new Set(), usage: {}, credited: { input: 0, output: 0, cached: 0 }, waiting: new Set(),
      state: 'working', postedState: 'working', lastWritten: PLACEHOLDER, botControlled: false, error: null,
      committed: false, compactedDuring: false, ended: false, stopped: false, receivedSteer: false, abandoned: false,
      timer: null, lastFlush: 0, dirty: false, chain: Promise.resolve(),
    };
    active.set(sessionId, rec);
    const key = threadKeyOf(channelId, rec.threadId);
    if (key) failedKeys.delete(key);
    // 止めたスレッドの、自分が始めたターンは始めない（canStart と turnExtras の間に止められたとき）
    if (pre && key && stoppedKeys.has(key)) { rec.stopped = true; host.abortSessions?.({ sessionId, reason: 'user' }).catch(() => {}); }
    let notes = [];
    // 組み込みの bot（bot なし）は記憶もスレッドの申し送りも持たない（ADR 9101）
    if (!bot.plain) {
      try {
        const tail = await memory.turnContext({ bot, session: sb, sessionId, incomingText: pre?.incomingText ?? turn.stream?.user?.text ?? '', locale: turn.agentLocale });
        rec.tail = tail;
        notes = tail.notes ?? [];
      } catch (e) { log('could not build the turn tail:', errText(e)); }
    }
    if (sb.kind === 'thread' && !sb.recentDelivered && !bot.plain) {
      try {
        const recent = await episodes?.recent(bot.id, channelId, rec.threadId, turn.agentLocale);
        if (recent) notes.splice(notes[0]?.startsWith('<pleiad-memory-core>') ? 1 : 0, 0, recent);
        rec.recentAttempted = true;
      } catch (e) { log('could not build the recent-thread handoff:', errText(e)); }
    }
    // Antigravity は、会話を続けるときに人格（エージェント定義）を渡し直しても、最初の指示のまま動く（実機の確認。2026-10-03）。
    // 人格を直した後の最初のターンに、新しい人格を末尾の文脈として渡す（会話の始めに渡した人格はこれに置き換わる）。
    // 会話が最後に受け取った人格のハッシュは、渡った（commit）ときに sidecar へ残す
    try {
      const meta = await host.store.get(sessionId);
      const text = meta?.backend === 'antigravity' ? bots.instructions?.(bot, turn.agentLocale ?? meta.agentLocale ?? locale()) : null;
      if (text) {
        rec.personaKey = crypto.createHash('sha256').update(text).digest('hex').slice(0, 32);
        if (sb.personaKey && sb.personaKey !== rec.personaKey) notes = [turnContextEnvelope(agentT(turn.agentLocale ?? meta.agentLocale ?? locale(), 'channel.personaUpdated', { persona: text })), ...notes];
      }
    } catch (e) { log('could not check the persona of a conversation:', errText(e)); }
    // チャンネルの予算の残り（ADR 0119）。毎ターン末尾の文脈で渡し、続けるか・ここでやめるかは bot が決める（型は付けない）
    if (rec.threadId) {
      try {
        const left = await budget.left({ channelId, threadId: rec.threadId, backend: turn.info?.backend ?? bot.backend, model: turn.info?.model ?? bot.model });
        const lng = turn.agentLocale ?? locale();
        const pct = (n) => String(Math.round(n * 100) / 100);
        if (left) notes = withTail(notes, left.known ? agentT(lng, 'channel.budget.left', { thread: pct(left.thread), channel: pct(left.channel) }) : agentT(lng, 'channel.budget.unknown'));
      } catch (e) { log('could not read the budget:', errText(e)); }
    }
    // 思考の流れの末尾と気がかり（自分の下書き。呼ばれたときも続きから始める。ADR 0126）。引き継ぎのターンは本文に入っているので重ねない
    if (rec.pulseBot && !rec.inner && (sb.kind === 'thread' || sb.kind === 'dm')) {
      try {
        const text = innerTail({ locale: turn.agentLocale ?? locale(), now: now(), stream: brain.tail(bot.id, 30), loops: brain.loops(bot.id, 'open') });
        if (text) notes = [...notes, innerEnvelope({ kind: 'tail', at: stamp(now()) }, text)];
      } catch (e) { log('could not build the inner tail:', errText(e)); }
    }
    // チャンネルの「ここでの決まり」（memo）。渡すのは会話の始まり・圧縮や巻き戻しの後（snapshotDue）と、決まりが変わったときだけ
    if (channelId && POST_KINDS.has(sb.kind)) {
      try {
        const memo = await channelMemoNote({ channelId, sb, lng: turn.agentLocale ?? locale() });
        if (memo) {
          rec.memoKey = memo.key;
          const lead = notes.findLastIndex((n) => n.startsWith('<pleiad-memory-core>') || n.startsWith('<pleiad-bot-recent>')) + 1;
          if (memo.note) notes = [...notes.slice(0, lead), memo.note, ...notes.slice(lead)];
        }
      } catch (e) { log('could not build the channel memo note:', errText(e)); }
    }
    if (channelId && POST_KINDS.has(sb.kind) && (sb.kind === 'dm' || rec.threadId) && !rec.deferPost) {
      try {
        const post = await channels.post({ channelId, threadId: rec.threadId, text: PLACEHOLDER, state: 'working', taint: sb.taint, turn: { botId: bot.id, sessionId }, new: true }, botAuthor(bot.id));
        rec.postId = post.id;
        rec.postReady = Promise.resolve(post.id);
      } catch (e) { log('could not create the turn post:', errText(e)); }
    }
    if (rec.threadId) {
      await channels.threads.update(channelId, rec.threadId, { sessions: { [bot.id]: sessionId } }).catch(() => {});
      await refreshThread(channelId, rec.threadId);
    }
    return { botInstructions: null, notes: [...notes, ...(pre?.payloadNotes ?? [])] };
  }

  /** 終わりの届かなかったターンの記録を片付ける: 投稿は stopped にして、書き換えの予約を止める */
  async function abandon(rec, { requeue = false } = {}) {
    rec.ended = true;
    rec.abandoned = true;
    clearTimeout(rec.timer);
    rec.timer = null;
    if (active.get(rec.sessionId) === rec) active.delete(rec.sessionId);
    if (rec.postId) await channels.edit({ channelId: rec.channelId, postId: rec.postId, state: 'stopped' }, botAuthor(rec.botId)).catch(() => {});
    // 渡った合図が無かった途中送信は次のターンで送り直す。始めの出来事も requeue なら未送のまま戻す。
    for (const [id, live] of [...liveSteers]) if (live.sessionId === rec.sessionId) { liveSteers.delete(id); await inbox.mark(live.ids, 'pending').catch(() => {}); }
    if (!rec.committed && rec.itemIds.length) {
      const stuck = (await inbox.list({ sessionId: rec.sessionId, status: 'delivering' }).catch(() => [])).filter((i) => rec.itemIds.includes(i.id)).map((i) => i.id);
      if (stuck.length) await inbox.mark(stuck, requeue ? 'pending' : 'unknown', requeue ? {} : { error: 'the turn ended without reporting' }).catch(() => {});
    }
    await refreshThread(rec.channelId, rec.threadId);
  }

  /** 最初の「渡った」で、末尾の進み・渡した出来事・投稿の進みを確定する（始める前に失敗したら進めない） */
  function commit(rec) {
    if (rec.committed) return;
    rec.committed = true;
    const tail = rec.tail;
    updateSidecar(rec.sessionId, (sb) => ({
      ...sb,
      ...(tail ? { memRev: tail.memRev, delivered: rec.compactedDuring ? [] : tail.delivered, snapshotDue: rec.compactedDuring ? true : tail.snapshotDue } : {}),
      ...(rec.recentAttempted ? { recentDelivered: true } : {}),
      ...(rec.cursor ? { postCursor: rec.cursor } : {}),
      ...(rec.personaKey ? { personaKey: rec.personaKey } : {}),
      ...(rec.memoKey !== undefined ? { memoKey: rec.memoKey } : {}),
    }));
    const marked = rec.itemIds.length ? inbox.mark(rec.itemIds, 'sent').catch((e) => log('could not record a delivered event:', errText(e))) : Promise.resolve();
    // 渡る前にたまっていた出来事は、ここから途中送信で渡せる
    marked.then(() => pump(rec.sessionId));
  }

  function onTurnEvent(turn, event) {
    const sessionId = turn?.info?.sessionId;
    const rec = sessionId ? active.get(sessionId) : null;
    if (!rec || rec.ended || !event?.type) return;
    if (ANSWER_EVENTS.has(event.type)) commit(rec);
    switch (event.type) {
      case 'text.delta':
        rec.sawText = true;
        rec.cur += String(event.text ?? '');
        progress(rec);
        break;
      case 'text.end':
        rec.sawText = true;
        if (rec.cur.trim()) { rec.last = rec.cur; rec.parts.push(rec.cur.trim()); }
        rec.cur = '';
        progress(rec);
        break;
      case 'tool.start':
        // agy は道具の前後の文章を同じ assistant 発言で流す。境界で控え、どちらも投稿に残す。
        if (rec.cur.trim()) { rec.last = rec.cur; rec.parts.push(rec.cur.trim()); rec.cur = ''; }
        progress(rec);
        break;
      case 'usage':
        rec.usage = { ...rec.usage, ...event };
        progress(rec);
        break;
      case 'present':
        collectPresent(rec, event);
        break;
      case 'tool.result':
        // Chats は画像生成を tool.result.images に描く。スレッドの投稿にも同じ画像を提示する。
        for (const image of Array.isArray(event.images) ? event.images : []) {
          if (!image?.path && !image?.dataUri) continue;
          collectPresent(rec, { type: 'present', by: 'ai', kind: 'image', path: image.path, dataUri: image.dataUri, caption: image.caption });
        }
        break;
      case 'turnResult':
        if (event.outcome === 'error') rec.error = event.error ?? rec.error;
        break;
      case 'compaction':
        if (event.phase === 'complete') rec.compactedDuring = true;
        break;
      case 'userMessage.delivered': case 'userMessage.dropped': {
        const live = liveSteers.get(event.messageId);
        if (!live) break;
        liveSteers.delete(event.messageId);
        if (event.type === 'userMessage.delivered') steered(live.sessionId, live.ids, live.text, live.cursor, live.callers).catch((e) => log('could not record a delivered event:', errText(e)));
        else inbox.mark(live.ids, 'pending').catch(() => {});   // 読まれずに捨てられた。ターンの終わりに送り直す
        break;
      }
      default:
    }
  }

  /** 提示（可視化・添付）のうち、スレッドに畳む分。人の添付と、git・作業場所の行は入れない。大きすぎるものは中身を落とす */
  function collectPresent(rec, event) {
    if (event.by === 'human' || event.kind === 'git' || event.kind === 'worktree') return;
    if (rec.presents.length >= PRESENT_MAX) return;
    const { type, sessionId, turnKey, ...rest } = event;
    const size = Buffer.byteLength(JSON.stringify(rest));
    const used = rec.presents.reduce((n, p) => n + Buffer.byteLength(JSON.stringify(p)), 0);
    if (used + size > PRESENT_BYTES) { delete rest.dataUri; delete rest.content; rest.truncated = true; }
    rec.presents.push(rest);
  }

  /**
   * 投稿を後で作るターン（deferPost）で、見せるもの（途中経過の本文・提示・承認待ち）ができたら、ターンの投稿を作る。
   * 作った後は、ふつうのターンと同じく progress が書き換える
   */
  function openDeferredPost(rec) {
    if (!rec.deferPost || rec.postReady || rec.ended) return;
    if (!progressBody(rec) && !rec.presents.length && rec.state === 'working') return;
    rec.deferPost = false;
    const ready = rec.chain.then(async () => {
      if (rec.ended || rec.abandoned) return null;
      const post = await channels.post({ channelId: rec.channelId, threadId: rec.threadId, text: PLACEHOLDER, state: 'working', taint: rec.taint,
        turn: { botId: rec.botId, sessionId: rec.sessionId }, new: true }, botAuthor(rec.botId));
      rec.postId = post.id;
      progress(rec, { immediate: true });
      return post.id;
    }).catch((e) => { log('could not create the turn post:', errText(e)); return null; });
    rec.postReady = ready;
    rec.chain = ready.then(() => {}, () => {});
  }

  /** ターンの投稿の本文・状態を 1 秒に 1 回まで書き換える（immediate は待たずに書く） */
  function progress(rec, { immediate = false } = {}) {
    if (rec.deferPost) openDeferredPost(rec);
    if (!rec.postId || rec.ended) return;
    rec.dirty = true;
    const wait = immediate ? 0 : Math.max(0, PROGRESS_INTERVAL_MS - (now() - rec.lastFlush));
    if (rec.timer) { if (!immediate) return; clearTimeout(rec.timer); }
    rec.timer = setTimeout(() => { rec.timer = null; rec.chain = rec.chain.then(() => flush(rec)).catch((e) => log('could not write the progress:', errText(e))); }, wait);
    rec.timer.unref?.();
  }

  async function flush(rec) {
    if (!rec.dirty || rec.ended || !rec.postId) return;
    rec.dirty = false;
    rec.lastFlush = now();
    // トークンの足し算は間引く（足すたびにスレッドの行を書き直し、全接続へ配る）。ターンの終わり（onTurnEnd）には必ず足す
    if (now() - (rec.lastCredit ?? 0) >= CREDIT_INTERVAL_MS) { rec.lastCredit = now(); await credit(rec); }
    // 短い断片しかない間は「…」を保ち、終わりにはその断片も全て残す。
    const body = progressBody(rec) || (rec.lastWritten !== PLACEHOLDER ? PLACEHOLDER : '');
    const patch = { channelId: rec.channelId, postId: rec.postId };
    if (body && body !== rec.lastWritten && !rec.botControlled) {
      const post = await channels.getPost({ channelId: rec.channelId, postId: rec.postId });
      if (!post || post.deletedAt) { rec.postId = null; return; }
      // bot 自身が channels.post で書いた本文（進捗のチェックリストなど）は、こちらの途中経過で上書きしない
      if (post.text !== rec.lastWritten) rec.botControlled = true;
      else patch.text = body;
    }
    if (rec.state !== rec.postedState) patch.state = rec.state;
    if (patch.text === undefined && patch.state === undefined) return;
    await channels.edit(patch, botAuthor(rec.botId));
    if (patch.text !== undefined) rec.lastWritten = patch.text;
    if (patch.state !== undefined) rec.postedState = patch.state;
  }

  function onPermission(card, phase) {
    const rec = card?.sessionId ? active.get(card.sessionId) : null;
    if (!rec || rec.ended) return;
    if (phase === 'open') rec.waiting.add(card.id); else rec.waiting.delete(card.id);
    rec.state = rec.waiting.size ? 'waiting' : 'working';
    progress(rec, { immediate: true });
    refreshThread(rec.channelId, rec.threadId);
  }

  async function onCompacted(sessionId) {
    const rec = active.get(sessionId);
    if (rec) rec.compactedDuring = true;
    await updateSidecar(sessionId, (sb) => ({ ...sb, snapshotDue: true, delivered: [] }));
  }

  async function onTurnEnd(turn, { outcome, interrupted } = {}) {
    const sessionId = turn?.info?.sessionId;
    const rec = sessionId ? active.get(sessionId) : null;
    if (!rec) {
      // 圧縮のターン（記録は作らない）の間にたまった出来事は、ここで渡す
      if (sessionId && turn.compactTrigger) await pump(sessionId);
      return;
    }
    let woke = null, reply = null;
    const limited = outcome === 'limited';
    try {
      rec.ended = true;
      clearTimeout(rec.timer);
      rec.timer = null;
      await rec.chain.catch(() => {});
      rec.usage = { ...rec.usage, ...turn.usage };
      await credit(rec);
      const ok = outcome === 'ok';
      const state = ok ? 'done' : outcome === 'error' && !interrupted ? 'failed' : 'stopped';
      if (ok && !rec.committed) commit(rec);
      if (!rec.committed && rec.itemIds.length) await inbox.mark(rec.itemIds, 'unknown', { error: rec.error ?? String(outcome) });
      // 聞こえた投稿だけのターンでも、assistant の文章があれば道具の前後を問わず残す（ADR 0128）。
      if (rec.deferPost && !rec.postId && ((!rec.spoke && !isSilentReply(speakingParts([...rec.parts, rec.cur]).join('\n\n'))) || rec.presents.length || state === 'failed')) {
        rec.deferPost = false;
        const post = await channels.post({ channelId: rec.channelId, threadId: rec.threadId, text: PLACEHOLDER, state: 'working', taint: rec.taint,
          turn: { botId: rec.botId, sessionId: rec.sessionId }, new: true }, botAuthor(rec.botId)).catch((e) => { log('could not create the turn post:', errText(e)); return null; });
        rec.postId = post?.id ?? null;
      }
      if (rec.postId) ({ woke, reply } = await finalizePost(rec, state, ok, { limited }));
      const key = threadKeyOf(rec.channelId, rec.threadId);
      if (key) { if (state === 'failed') failedKeys.add(key); else failedKeys.delete(key); }
    } catch (e) { log('could not finalize the turn post:', errText(e)); }
    finally {
      // 次のターンの記録が先にできていたら、それは消さない
      if (active.get(sessionId) === rec) active.delete(sessionId);
      // 渡った合図が来ないまま終わった途中送信は、読まれたか分からない。次のターンで送り直す
      for (const [id, live] of [...liveSteers]) if (live.sessionId === sessionId) { liveSteers.delete(id); inbox.mark(live.ids, 'pending').catch(() => {}); }
    }
    await refreshThread(rec.channelId, rec.threadId);
    // 使ったトークンをチャンネルの予算に数える（人が呼んだターンも。次の bot を起こす前に）
    // 自分の心拍・予約から起きたターンは、スレッドではなく bot の家のチャンネルの予算に数える（自発の分も数える。ADR 0126）。
    // 家が無い DM だけの bot の予約は、bot の 1 日のトークンにだけ数える（homeChannelId が null。ADR 0140）
    if (rec.inner) {
      await budget.chargeBrain({ channelId: rec.inner.homeChannelId, botId: rec.botId, backend: turn.info?.backend, model: turn.info?.model, usage: rec.usage })
        .catch((e) => log('could not charge the brain budget:', errText(e)));
    } else {
      await budget.charge({ channelId: rec.channelId, threadId: rec.threadId, backend: turn.info?.backend, model: turn.info?.model, usage: rec.usage })
        .catch((e) => log('could not charge the budget:', errText(e)));
    }
    if (rec.pulseBot && (rec.kind === 'thread' || rec.kind === 'dm')) await noteResult(rec, { outcome, interrupted, reply }).catch((e) => log('could not write the stream line:', errText(e)));
    // 使用量の上限に当たった: 休憩中にして、Pleiad のお知らせを出す（bot の発言には上限の文を書かない）
    if (limited) await limitReached(rec, Number(interrupted?.resetsAt)).catch((e) => log('could not record a usage limit:', errText(e)));
    if (outcome === 'ok') {
      const bot = await getBot(rec.botId).catch(() => null);
      if (bot) resting.clear(bot);
    }
    if (rec.kind === 'thread' && rec.threadId) {
      try { episodes?.onTurnEnd(rec.channelId, rec.threadId); }
      catch (e) { log('could not schedule the thread episode:', errText(e)); }
    }
    // 返事の中の @ で、次の bot を起こす（止められたスレッドは起こさない）
    if (woke) {
      try {
        const channel = await channels.get({ channelId: rec.channelId });
        await route(woke, channel);
      } catch (e) { log('could not handle an @ in a reply:', errText(e)); }
    }
    // 呼ばれて答えたなら、返事を呼んだ bot の会話へ返す（暗黙のメンションではなく「呼んだ相手が答えた」こと）
    if (reply && rec.callers.size) await returnReply(rec, reply, woke).catch((e) => log('could not return a reply to the caller:', errText(e)));
    // このターンの返事を待っていた、ほかの bot への聞こえた投稿を届ける（ADR 0128）
    await releaseFollowers(sessionId).catch((e) => log('could not deliver a heard post:', errText(e)));
    // 終わるまでにたまった出来事をまとめて渡す
    await pump(sessionId);
  }

  // ------------------------------------------------------------ 頭の中（ADR 0126）

  const oneLine = (text, max) => { const a = [...String(text ?? '').replace(/\s+/g, ' ').trim()]; return a.length > max ? `${a.slice(0, max - 1).join('')}…` : a.join(''); };

  /**
   * ターンが終わったら、結果を思考の流れに 1 行足す（呼ばれたターンも、自分で起きたターンも）。自分で起きたターンは、頼んだ行（actSeq）につなぐ。
   * 話しかけた・黙った・失敗・止められた。外から来た文のターンの行には taint が付く
   */
  async function noteResult(rec, { outcome, interrupted, reply }) {
    const lng = locale();
    const state = outcome === 'ok' ? 'done' : outcome === 'error' && !interrupted ? 'failed' : 'stopped';
    const channel = await channels.get({ channelId: rec.channelId }).catch(() => null);
    const where = channel ? channelLabel(channel) : '';
    const text = oneLine(reply?.text, 100);
    const key = state === 'failed' ? 'failed' : state === 'stopped' ? 'stopped'
      : rec.inner ? (text ? 'spoke' : 'silent') : (text ? 'answered' : 'answeredSilent');
    brain.append(rec.botId, {
      kind: 'result', text: agentT(lng, `brain.line.${key}`, { where, text }), taint: rec.taint ?? null,
      ...(rec.inner?.actSeq ? { refs: [String(rec.inner.actSeq)] } : {}),
      meta: { channelId: rec.channelId, threadId: rec.threadId, ...(rec.inner ? { by: rec.inner.kind === 'wake' ? 'wake' : 'pulse' } : {}), state },
    });
  }

  /**
   * 心拍からの引き継ぎ（安いモデルが「確かめる・話す」と決めた）。where のスレッドにこの bot の会話があればそこ、無ければ bot の DM の会話へ、
   * 「自分で起きた」出来事（投稿を持たない inner）を inbox に積んで、ふつうの道（pump → startTurn → turnExtras → onTurnEnd）に乗せる。
   * 承認・強い bot の確認・［止める］はそのまま効く。投稿するかしないかは賢いモデルが決める（黙って終えてもよい）。
   * 休憩中・止めたスレッド・DM が引けないときは断る（お知らせは出さない）。返りは { ok: true, sessionId, channelId, threadId } | { ok: false, reason }
   */
  async function handoff({ botId, why = '', where = null, text, actSeq = null, homeChannelId, taint = null } = {}) {
    if (closed) return { ok: false, reason: 'closed' };
    const bot = await getBot(botId);
    if (!bot) return { ok: false, reason: 'no such bot' };
    if (resting.until(bot)) return { ok: false, reason: 'resting' };
    let target = null;
    if (where) {
      for (const th of (await channels.threads.list?.().catch(() => [])) ?? []) {
        const sessionId = th.threadId === where ? th.sessions?.[botId] : null;
        if (!sessionId || th.stopped || stoppedKeys.has(threadKeyOf(th.channelId, th.threadId))) continue;
        const channel = await channels.get({ channelId: th.channelId }).catch(() => null);
        if (channel && !channel.archivedAt && (await sidecarOf(sessionId))?.botId === botId) { target = { sessionId, channelId: th.channelId, threadId: th.threadId }; break; }
      }
    }
    if (!target) {
      const dm = await bots.ensureDmSession({ botId });
      const fresh = await getBot(botId);
      if (!fresh?.dmChannelId) return { ok: false, reason: 'no DM' };
      target = { sessionId: dm.sessionId, channelId: fresh.dmChannelId, threadId: null };
    }
    await inbox.add({ ...target, botId, postId: null, inner: { workNotesVersion: WORK_NOTES_VERSION, why: oneLine(why, 300), text: String(text ?? '').slice(0, 6000), actSeq, homeChannelId, taint } });
    await pump(target.sessionId);
    return { ok: true, ...target };
  }

  /**
   * 予約した時刻になった bot を、予約した会話で起こす（core/brain/wakes.mjs。ADR 0140）。handoff と同じく、投稿を持たない出来事（inner。kind: 'wake'）を
   * inbox に積んでふつうの道に乗せる。承認・強い bot の確認・［止める］はそのまま効き、走っているターンには途中送信しない。
   * 止めたスレッド・その bot の会話でなくなったものは断る。返りは { ok: true, sessionId, channelId, threadId } | { ok: false, reason }（resting・closed は待てば起こせる）
   */
  async function wakeReserved({ botId, sessionId, channelId, threadId = null, why = '', text, homeChannelId = null, taint = null } = {}) {
    if (closed) return { ok: false, reason: 'closed' };
    const bot = await getBot(botId);
    if (!bot) return { ok: false, reason: 'nobot' };
    if (resting.until(bot)) return { ok: false, reason: 'resting' };
    if (!sessionId || (await sidecarOf(sessionId))?.botId !== botId) return { ok: false, reason: 'nosession' };
    if (threadId && (stoppedKeys.has(threadKeyOf(channelId, threadId)) || (await threadStopped(channelId, threadId)))) return { ok: false, reason: 'stopped' };
    await inbox.add({ sessionId, channelId, threadId, botId, postId: null, inner: { kind: 'wake', workNotesVersion: WORK_NOTES_VERSION, why: oneLine(why, 300), text: String(text ?? '').slice(0, 6000), actSeq: null, homeChannelId, taint } });
    await pump(sessionId);
    return { ok: true, sessionId, channelId, threadId };
  }

  /** この bot（B）を呼んだ bot（A）の、このスレッド（無ければ派生元のスレッド）の会話。無ければ null */
  async function callerSession(rec, callerId) {
    const sessionOf = async (channelId, threadId) => {
      const th = await channels.threads.get(channelId, threadId).catch(() => null);
      const id = th?.sessions?.[callerId];
      return id && (await sidecarOf(id))?.botId === callerId ? { sessionId: id, channelId, threadId, origin: th.origin ?? null } : null;
    };
    const own = await sessionOf(rec.channelId, rec.threadId);
    if (own) return own;
    const th = await channels.threads.get(rec.channelId, rec.threadId).catch(() => null);
    return th?.origin ? sessionOf(th.origin.channelId, th.origin.threadId) : null;
  }

  /**
   * B が本文を書いて ok または failed で終わったとき、B を呼んだ bot（A。B の投稿の @ ・channels.post の @ で起こした側）の会話へ、B の返事を「返事」の包みで届けて A を起こす。
   * 人が直接 @B で起こしたときは返さない。A（と A のスレッド）が止められているときも返さない。B の返事が A への @ を含むときは、その @ で起こるので重ねない。
   * 回数の上限は置かず、チャンネルの予算を使い切ったら返さない（ADR 0119）
   */
  async function returnReply(rec, reply, woke) {
    if (closed || rec.stopped || !reply?.text?.trim()) return;
    const channel = await channels.get({ channelId: rec.channelId }).catch(() => null);
    if (!channel || channel.archivedAt) return;
    for (const caller of rec.callers.values()) {
      // 返事（2 件目からの投稿を含む）が呼んだ bot への @ を含むなら、その @ で起きる
      if (caller.botId === rec.botId || woke?.mentions?.includes(caller.botId) || rec.explicitMentions.has(caller.botId)) continue;
      const target = await callerSession(rec, caller.botId);
      if (!target || !(await getBot(caller.botId))) continue;
      if ((await threadStopped(rec.channelId, rec.threadId)) || (await threadStopped(target.channelId, target.threadId))) continue;
      const key = threadKeyOf(target.channelId, target.threadId);
      if (key && stoppedKeys.has(key)) continue;
      // 返事を返して呼んだ bot を起こすのも bot どうしの呼びかけ: 予算を使い切っていたら起こさない（知らせない）。休憩中なら知らせて配らない
      if (!(await budget.allows({ channelId: target.channelId, threadId: target.threadId }))) continue;
      if (await restingWake(await getBot(caller.botId), { id: target.channelId }, target.threadId)) continue;
      await inbox.add({ sessionId: target.sessionId, botId: caller.botId, channelId: target.channelId, threadId: target.threadId, postId: reply.id, reply: rec.botId });
      if (target.threadId) await bumpCalls(target.channelId, target.threadId);
      await pump(target.sessionId);
    }
  }

  /** ターンの投稿に assistant の文章と提示を入れて state を決める。本文のある返事なら failed でも @ と呼び元へ届ける */
  async function finalizePost(rec, state, ok, { limited = false } = {}) {
    const lng = locale();
    let text = postText(speakingParts([...rec.parts, rec.cur]).join('\n\n'));
    // 黙ったことを表すだけの文（印・「（なし）」のような括弧だけの一言）は、文章を書かずに終えたのと同じ（ADR 0119 の追記）
    if (isSilentReply(text)) text = '';
    const none = { woke: null, reply: null };
    const current = await channels.getPost({ channelId: rec.channelId, postId: rec.postId }).catch(() => null);
    if (!current || current.deletedAt) return none;
    const bodyByBot = rec.filled || (current.text !== PLACEHOLDER && current.text !== rec.lastWritten);
    // channels.post で明示的に書いた本文も残し、assistant の文章をその後ろに置く。
    if (rec.spoke && bodyByBot && text) text = postText(`${current.text}\n\n${text}`);
    const hasBody = Boolean(text || (bodyByBot && current.text !== PLACEHOLDER && current.text.trim()));
    if (!text && state === 'failed' && !bodyByBot) text = agentT(lng, 'channel.turn.failed', { error: rec.error ?? '' });
    // 使用量の上限で終わったターンは、bot の発言に「止めました」も上限の文も書かない（知らせは Pleiad の投稿。ADR 0119）。bot が書いた分は残す
    if (!text && state === 'stopped' && !bodyByBot && !rec.presents.length && !limited) text = agentT(lng, 'channel.turn.stopped');
    // 何も言わずに終わった（文章を書かずにリアクションだけ・黙ってやめる。ADR 0119）・上限で何も書けなかった: 投稿は残さない
    if (!text && !bodyByBot && !rec.presents.length && (state === 'done' || limited)) { await channels.remove({ channelId: rec.channelId, postId: rec.postId }, botAuthor(rec.botId)); return none; }
    const edit = { channelId: rec.channelId, postId: rec.postId, state };
    if (state === 'failed' && hasBody) edit.failedWithBody = true;
    // bot がこのターンの投稿に付けた「要確認」（channels.post の state: 'checking'。ルーティンの実行の状態になる）は、終わりで done に戻さない
    if (state === 'done' && current.state === 'checking') edit.state = 'checking';
    if (text) edit.text = text; else if (!bodyByBot && current.text === PLACEHOLDER) edit.text = '';
    if (rec.presents.length) edit.presents = rec.presents;
    const saved = await channels.edit(edit, botAuthor(rec.botId));
    const deliver = (ok || state === 'failed') && !rec.stopped && !limited && hasBody;
    // 返事を何件かに分けて書いたなら、呼んだ bot へ返すのは最後の 1 件（その前の投稿は文脈として一緒に渡る）
    // bot が channels.post で入れた返事の @ は、書いたときに解いてある（onPosted の extra.filled）。ここで重ねて起こさない
    return { woke: deliver && !rec.filled && saved?.mentions?.some((m) => m !== 'you') ? saved : null, reply: deliver && saved ? (rec.explicit ?? saved) : null };
  }

  // ------------------------------------------------------------ 止める

  /** このスレッドから bot が起こして新しくできたスレッド（origin で結ばれたもの。孫も）。止める対象を広げるのに使う */
  async function derivedThreads(channelId, threadId) {
    const all = (await channels.threads.list?.(channelId).catch(() => [])) ?? [];
    const found = [];
    const seen = new Set([threadId]);
    for (let queue = [threadId]; queue.length;) {
      const from = queue.shift();
      for (const th of all) {
        if (seen.has(th.threadId) || th.origin?.channelId !== channelId || th.origin?.threadId !== from) continue;
        seen.add(th.threadId); found.push(th.threadId); queue.push(th.threadId);
      }
    }
    return found;
  }

  async function stopThread({ channelId, threadId }, author) {
    if (!threadKeyOf(channelId, threadId)) return;
    // 元のスレッドの stopped は channels の service が先に残している。派生のスレッドは、ここで同じ印を残してから止める
    const derived = await derivedThreads(channelId, threadId);
    for (const id of derived) await channels.threads.update(channelId, id, { stopped: { by: author, at: now() } }).catch((e) => log('could not mark a derived thread stopped:', errText(e)));
    for (const id of [threadId, ...derived]) await stopOne(channelId, id, author);
  }

  async function stopOne(channelId, threadId, author) {
    const key = threadKeyOf(channelId, threadId);
    stoppedKeys.add(key);
    const lng = locale();
    try {
      // 保留中の出来事を取り消す（渡している最中のものは、止めるターンの中で扱う）
      const pending = (await inbox.list({ channelId, threadId, status: 'pending' })).map((i) => i.id);
      if (pending.length) await inbox.remove(pending);
      const running = [...active.values()].filter((rec) => rec.channelId === channelId && rec.threadId === threadId && !rec.ended);
      for (const rec of running) rec.stopped = true;
      // 走っているターンの有無にかかわらず、このスレッドの bot の会話を止める。abortSessions はその会話が委譲（ply_delegate）で作った子のタスクも取り消す。
      // ターンはもう終わっていて、委譲の子だけが走り続けているときも、［止める］で止まる
      const th = await channels.threads.get(channelId, threadId).catch(() => null);
      const sessionIds = new Set([...running.map((rec) => rec.sessionId), ...Object.values(th?.sessions ?? {}).filter((id) => typeof id === 'string')]);
      await Promise.all([...sessionIds].map((sessionId) => host.abortSessions?.({ sessionId, reason: 'user' })));
      const botList = await bots.list();
      await systemPost(channelId, threadId, agentT(lng, 'channel.stopped', { who: await nameOf(author, botList, lng) }));
    } finally { await refreshThread(channelId, threadId); }
  }

  // ------------------------------------------------------------ 起動

  /** 前の起動で終わらなかった作業中の印（ターンの投稿・スレッドの状態）を片付ける */
  async function recoverStale() {
    const stale = async (channelId, threadId) => {
      try {
        const page = await channels.read({ channelId, ...(threadId ? { threadId } : {}), limit: 100 });
        for (const p of page.posts) {
          if (p.deletedAt || !p.turn || (p.state !== 'working' && p.state !== 'waiting')) continue;
          if (active.get(p.turn.sessionId)) continue;
          await channels.edit({ channelId, postId: p.id, state: 'stopped' }, botAuthor(p.turn.botId));
        }
      } catch (e) { log('could not clear a stale working mark:', errText(e)); }
    };
    for (const th of (await channels.threads.list?.()) ?? []) {
      if (th.state !== 'working' && th.state !== 'waiting') continue;
      await stale(th.channelId, th.threadId);
      await channels.threads.update(th.channelId, th.threadId, { state: 'idle', live: {} }).catch(() => {});
    }
    for (const ch of (await channels.list().catch(() => [])).filter((c) => c.kind === 'dm')) await stale(ch.id, null);
  }

  /**
   * キャッシュを入力と分けて数えていた頃の Antigravity の分（2026-10-04 に usage の数え方をそろえた）が混ざったスレッドは、
   * cached が input を超えて見分けがつく。その tokens を、使用量の記録（会話ごと）から数え直す。数え直すと cached は input を超えないので、2 回目からは触らない。
   * 記録が見つからないスレッドはそのまま
   */
  async function repairTokens() {
    if (!host.usageStore?.records) return;
    const legacy = ((await channels.threads.list?.()) ?? []).filter((th) => (th.tokens?.cached ?? 0) > (th.tokens?.input ?? 0) && Object.keys(th.sessions ?? {}).length);
    if (!legacy.length) return;
    const rows = await host.usageStore.records({ sessionIds: [...new Set(legacy.flatMap((th) => Object.values(th.sessions)))] });
    const by = new Map();
    for (const r of rows) {
      const sum = by.get(r.sessionId) ?? { input: 0, output: 0, cached: 0 };
      const input = inputWithCache(r);
      sum.input += input; sum.output += r.outputTokens ?? 0; sum.cached += Math.min(r.cachedTokens ?? 0, input);
      by.set(r.sessionId, sum);
    }
    for (const th of legacy) {
      const total = { input: 0, output: 0, cached: 0 };
      for (const id of Object.values(th.sessions)) for (const k of Object.keys(total)) total[k] += by.get(id)?.[k] ?? 0;
      if (total.input || total.output) await channels.threads.update(th.channelId, th.threadId, { tokens: total }).catch((e) => log('could not repair the token usage:', errText(e)));
    }
  }

  async function start() {
    closed = false;
    try {
      await inbox.load();
      const { sessions } = await inbox.recover();
      await recoverStale();
      await repairTokens().catch((e) => log('could not repair the token usage:', errText(e)));
      // サーバーが立ち上がりきってから配り直す
      const timer = setTimeout(() => { for (const id of sessions) pump(id); }, 0);
      timer.unref?.();
    } catch (e) { log('start failed:', errText(e)); }
  }

  function stop() {
    closed = true;
    for (const rec of active.values()) clearTimeout(rec.timer);
    for (const timer of retries.values()) clearTimeout(timer);
    retries.clear();
    followers.clear();
    resting.stop();
  }

  return {
    channels, bots, memory, host, emit, now, inbox, budget,
    start, stop, onPosted, onReacted, claimPost, wake, wakePost, handoff, wakeReserved, stopThread, turnExtras, onTurnEvent, onTurnEnd, onPermission, onCompacted, threadSettings, branchThread, resendThread,
    /** テスト・診断用: 走っている bot のターンの数 */
    activeCount: () => active.size,
    /** 使用量の上限で休んでいれば解除の時刻（ms）。bots.overview の restingUntil（ADR 0119） */
    restingUntil: (bot) => resting.until(bot),
    /** スレッドの帯の「予算」の内訳（channels.threadBudget。ADR 0119）。チャンネルでなければ null */
    threadBudget: async ({ channelId, threadId }) => budget.snapshot({ channelId, threadId, bots: await bots.list(), restingOf: (bot) => resting.until(bot) }),
  };
}
