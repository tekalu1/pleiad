// bot を起こす・配る（S4。ADR 0109・0108）。投稿の @ から会話を決め、途中送信・ターンの投稿の更新・止める・トークンの集計までを持つ。
// core/bots-host.mjs がこれを束ね、core/server.mjs のつなぎ目（turnExtras・onTurnEvent・onTurnEnd・onPermission・onCompacted・start）はここへ届く。
//
// createDispatcher({ channels, bots, memory, host, emit, now }) → Dispatcher
//   channels / bots / memory … 各サービス（core/channels/service.mjs ほか）
//   host … core/server.mjs が createBotHost に渡す道具の束（core/bots-host.mjs の HostTools）。会話を走らせる・止める・途中送信するのに使う
//   emit … 全接続へ出す（sessionId: null）。会話ごとの出来事は host.emitSession
//
// Dispatcher（どれも例外を外へ出さない）:
//   start(): Promise<void>                                          … 届ける前の出来事の戻し（delivering → unknown、pending を配り直す）・前の起動で残った作業中の印の片付け
//   stop(): void
//   onPosted(post, channel, extra?): Promise<void>                  … channels.post の後。@ で bot を起こす（ChannelService.hooks.posted）。extra は { hold?, checked?, origin? }（ops の channels.post が渡す）
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
//   - スレッドで @ の無い人の投稿は 1 体へ渡す（ADR 0117）: 今作業中（始めかけを含む）の bot が 1 体だけならそれ、そうでなければそのスレッドで最後に話した bot
//     （いちばん新しい bot の投稿の bot）、bot の投稿がまだ無ければスレッドの会話を持つ bot が 1 体だけならそれ。決まらなければ誰も起こさない。
//     bot・Chats の AI の @ の無い投稿は誰も起こさない（暗黙の宛先は人の投稿だけ。bot 同士が起こし合わない）。
//   - ThreadState.stopped があれば、人が次に書くまで起こさない。ThreadState.calls は数えるだけ。
//   - bot が bot を起こす（返事・channels.post の @、呼んだ bot へ返す返事）のは、チャンネルの予算が残っている間だけ（ADR 0119。回数の上限は置かない）。
//     使い切ったら起こさない（Pleiad はお知らせを出さない。人が呼べば起きる）。数えるのは core/bots/budget.mjs。残りは毎ターン末尾の文脈で bot に渡す。
//   - 使用量の上限に当たった bot は休憩中（core/bots/resting.mjs）。休憩中の @ は配らず、その場所に 1 回だけ Pleiad のお知らせを出す（ADR 0119）。
//   - bot の投稿で bot を呼ぶのは行頭の半角の @名前 だけ（mentions.mjs の strict）。人は全角の ＠ も文中も数える。どちらも括弧・コード・引用の中は数えない。
//   - 動く承認モードが投稿した bot より強い bot（範囲・自律のどちらかが上）は、bot の返事の @ では起こさない（起こさなかったことをスレッドの投稿で知らせる。人が @ すると起きる）。
//     channels.post の @ は ops が決め済み（extra.hold・checked）で、承認（channels.wake）が出る。人の投稿は確認しない。
// 配る: inbox.json（core/bots/inbox.mjs）へ pending で保存してから、走っているターンがあり途中送信できれば control.steer、
//   無ければ新しいターン、途中送信できない（Antigravity・圧縮・人の送信待ち）・忙しいときはターンの終わりにまとめて渡す。結果不明は自動では送り直さない。
// ターンの投稿: ターンが始まると、そのスレッドに bot の投稿を 1 つ作り（state: working）、本文を 1 秒に 1 回まで書き換える。
//   終わりに最終の返答（最後の道具の呼び出しより後の文。前の独り言は入れない）と提示を入れて state を決める。
//   ターンの中で bot が channels.post で自分のスレッドへ書いたら、それがこのターンの返事（ADR 0117）: 最初の 1 件はターンの投稿に入り、2 件目からは新しい投稿。
//   最終の返答（「投稿しました」のような作業の報告）は、そのときは投稿に書かない。
//   途中送信が届いたら、これまでの返事と提示を確定し、次の返事は新しい投稿に入れる。
//   生の流れ（text.delta）はチャンネルへ流さず、サーバーで投稿に畳む（ADR 0024 の 1 接続 1 購読）。
import path from 'node:path';
import crypto from 'node:crypto';
import { agentT } from '../i18n.mjs';
import { channelEnvelope, channelThreadEnvelope, channelEventRows, turnContextEnvelope } from '../channels/types.mjs';
import { TURN_CONTEXT_TAG } from '../system-messages.mjs';
import { createInboxStore } from './inbox.mjs';
import { strongerMode } from './approval.mjs';
import { createBudget } from './budget.mjs';
import { createResting, restKey } from './resting.mjs';

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
/**
 * ターンの投稿の途中経過の本文。出すのは、今書いている文章の「文の切れ目まで」か、書き終えた文章（道具を呼ぶ前のものは入らない）のうち、
 * 十分に長いもの。短い独り言や 1 文字の断片は '' で、投稿は「…」のまま。最終の返事は終わりに lastReply で書き換わる（finalizePost）
 */
export function progressBody(rec) {
  const settled = rec.cur ? (rec.cur.match(SENTENCE_END)?.[0] ?? '') : '';
  for (const text of [settled, rec.last]) {
    const body = String(text ?? '').trim();
    if ([...body].length >= PROGRESS_MIN_CHARS) return body;
  }
  return '';
}
const RETRY_MS = 3000;
/** 始められなかったターンの後に、たまった出来事を配り直す回数（失敗が続くなら止める。次の @ でまとめて渡る） */
const START_RETRIES = 3;
/** スレッドのトークンの足し算を書く間隔（ms）。スレッドの状態の書き込みと全接続への配信を毎秒にしない。ターンの終わりには必ず書く */
export const CREDIT_INTERVAL_MS = 5000;
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

export function createDispatcher({ channels, bots, memory, episodes, host, emit = () => {}, now = Date.now } = {}) {
  const inbox = createInboxStore({ dir: channels?.dir ?? path.join(host?.dataDir ?? '.', 'channels'), now });
  const active = new Map();        // sessionId → ターンの記録（begin から onTurnEnd まで）
  const starting = new Map();      // sessionId → 自分が始めたターンのうち、まだ turnExtras に届いていないもの
  const liveSteers = new Map();    // 途中送信の item id → 「渡った」合図を待っているもの
  const pumps = new Map();         // sessionId → 配る処理の直列化
  const retries = new Map();       // sessionId → 忙しいときの再試行のタイマー
  const sidecarChains = new Map(); // sessionId → sidecar `bot` の書き換えの直列化
  const threadChains = new Map();  // threadKey → スレッドの状態の書き換えの直列化
  const threadStates = new Map();  // threadKey → 最後に書いた ThreadState.state
  const creating = new Map();      // threadKey/botId → スレッドの会話を作っている最中
  const startFailures = new Map(); // sessionId → 始められなかった回数（配り直しの上限用。始まったら消す）
  const stoppedKeys = new Set();   // 止めたスレッド（canStart の同期の判定用。人が書いたら外す）
  const failedKeys = new Set();    // 最後のターンが失敗で終わったスレッド
  const budget = createBudget({ channels, host, now, log });
  const resting = createResting({ now, onChange: (key) => restingChanged(key) });
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
      if (threadStates.get(key) === state) return;
      await channels.threads.update(channelId, threadId, { state });
      threadStates.set(key, state);
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
   * bot の会話へ渡す文。items は同じ会話宛ての起こした投稿（trigger）。
   * 文脈 = postCursor より後の（無ければスレッドの）投稿のうち、いちばん後ろの trigger より前にあって、trigger ではなく、書き途中でなく、
   * この会話自身のターンの投稿でないもの（30 件・2 万字まで）。trigger より後ろの投稿は、次に渡す（二重に渡さない）。
   * 返りの cursor は、ここまでを渡した印にする投稿の id（書き途中の他の bot の投稿の手前まで。後で書き上がった分を取りこぼさない）
   */
  async function buildPrompt({ sessionId, sb, channel, threadId, items, lng }) {
    const [botList, page] = await Promise.all([bots.list(), channels.read({ channelId: channel.id, ...(threadId ? { threadId } : {}), limit: 100 })]);
    // 消した投稿もカーソルの位置を探す材料に残す。消された投稿を境に古い文脈を再送しない。
    const posts = page.posts;
    const triggerIds = new Set(items.map((i) => i.postId));
    const from = sb?.postCursor ? posts.findIndex((p) => p.id === sb.postCursor) : -1;
    const afterCursor = from >= 0 ? posts.slice(from + 1) : posts;
    const lastTrigger = afterCursor.reduce((at, p, i) => (triggerIds.has(p.id) ? i : at), -1);
    const fresh = afterCursor.slice(0, lastTrigger + 1);     // いちばん後ろの trigger まで
    const own = (p) => p.turn?.sessionId === sessionId || (p.author?.kind === 'bot' && p.author.botId === sb?.botId);
    // 書き途中の他の bot の投稿は文脈に入れず、その手前までしか進めない
    let cut = fresh.findIndex((p) => p.state === 'working' && !own(p) && !triggerIds.has(p.id));
    if (cut < 0) cut = fresh.length;
    const settled = fresh.slice(0, cut).filter((p) => !p.deletedAt && !triggerIds.has(p.id) && !own(p) && p.state !== 'working');
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
    for (const item of items) {
      const p = posts.find((x) => x.id === item.postId) ?? await channels.getPost({ channelId: channel.id, postId: item.postId }).catch(() => null);
      if (p && !p.deletedAt) triggers.push(p);
    }
    const parts = [];
    if (picked.length) parts.push(channelThreadEnvelope({ ...common, posts: await Promise.all(picked.map(env)) }));
    // 呼んだ bot の返事（reply）は、包みに reply="true" を付ける（固定文: 呼んだ bot の返事は reply の付いた包みで返ってくる）
    const replies = new Set(items.filter((i) => i.reply).map((i) => i.postId));
    for (const p of triggers) parts.push(channelEnvelope({ ...(await env(p)), ...(replies.has(p.id) ? { reply: 'true' } : {}) }));
    const payloadNotes = triggers.filter((p) => p.author.kind === 'routine' && p.taint === 'webhook' && p.routine?.payload).map((p) => p.routine.payload);
    const cursor = (cut >= fresh.length ? fresh.at(-1) : cut > 0 ? fresh[cut - 1] : null)?.id ?? sb?.postCursor ?? null;
    return { prompt: parts.join('\n'), payloadNotes, cursor, incomingText: triggers.map((p) => p.text).join('\n'), triggers };
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
    const rec = post?.author?.kind === 'bot' ? [...active.values()].find((r) => r.spoke && !r.ended && r.botId === post.author.botId && r.channelId === post.channelId && (r.threadId ?? null) === (post.threadId ?? null)) : null;
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
        if (post.threadId === null) {
          if (!mentioned.length) return;
          threadId = post.id;                                  // チャンネルの流れへの投稿で @ されたら、その投稿を根にスレッドを作る
          targets = mentioned;
          origin = extra.origin ?? null;                       // bot が自分のスレッドから書いたなら、新しいスレッドは元のスレッドの［止める］に結ばれる
        } else {
          if (await threadStopped(channel.id, post.threadId)) return;
          if (mentioned.length) targets = mentioned;
          else if (kind === 'human' && !groupRequested) {
            // @ の無い人の投稿は、そのスレッドで最後に話した bot へ（作業中なら途中送信、そうでなければ新しいターン）。bot・AI の @ の無い投稿は誰も起こさない
            const botId = await conversingBot(channel.id, post.threadId, post.id);
            if (!botId) return;
            targets = [botId];
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
      for (const botId of unique) {
        if (held.has(botId)) continue;
        await wake({ botId, channel, threadId, post }).catch((e) => log(`${botId} could not be woken:`, errText(e)));
      }
    } catch (e) { log('failed to handle a post:', errText(e)); }
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
    const asked = channel.kind === 'dm' ? channel.botId === botId : (post.mentions ?? []).includes(botId);
    if (!asked) return { woken: false, reason: 'notMentioned' };
    const threadId = channel.kind === 'dm' ? null : (post.threadId ?? post.id);
    if (await threadStopped(channel.id, threadId)) return { woken: false, reason: 'stopped' };
    await wake({ botId, channel, threadId, post, approved: true });
    return { woken: true };
  }

  /** この bot の、このスレッド（DM なら DM）の会話。無ければ作る */
  async function sessionFor({ bot, channel, threadId, post }) {
    if (channel.kind === 'dm') return (await bots.ensureDmSession({ botId: bot.id })).sessionId;
    const key = `${threadKeyOf(channel.id, threadId)}/${bot.id}`;
    const running = creating.get(key);
    if (running) return running;
    const work = (async () => {
      const th = await channels.threads.get(channel.id, threadId);
      const known = th?.sessions?.[bot.id];
      if (known && (await sidecarOf(known))?.botId === bot.id) return known;
      const rootText = threadId === post.id ? post.text : (await channels.getPost({ channelId: channel.id, postId: threadId }).catch(() => null))?.text ?? '';
      const made = await bots.createSession({ botId: bot.id, channel, threadId, kind: 'thread', rootText });
      await channels.threads.update(channel.id, threadId, { sessions: { [bot.id]: made.sessionId } });
      return made.sessionId;
    })().finally(() => creating.delete(key));
    creating.set(key, work);
    return work;
  }

  /** 1 体の bot を、この投稿で起こす（届ける前の出来事を保存してから配る） */
  async function wake({ botId, channel, threadId, post, approved = false }) {
    const bot = await getBot(botId);
    if (!bot) return;
    // 使用量の上限で休憩中なら配らない（解除の後にもう一度呼んでもらう）。その場所で初めてなら知らせる
    if (await restingWake(bot, channel, threadId)) return;
    // bot が bot を起こすのは、チャンネルの予算が残っている間だけ（人が承認した channels.wake は人の操作なので止めない）。使い切っても知らせない
    if (post.author?.kind === 'bot' && !approved && !(await budget.allows({ channelId: channel.id, threadId }))) return;
    const sessionId = await sessionFor({ bot, channel, threadId, post });
    // 呼んだのが別の bot なら、この会話のターンが終わったときに返事を返す相手として残す（人・ルーティン・外から来た文には返さない）
    const caller = post.author?.kind === 'bot' && post.author.botId !== botId ? post.author.botId : null;
    await inbox.add({ sessionId, botId, channelId: channel.id, threadId, postId: post.id, ...(caller ? { caller } : {}) });
    if (threadId) await bumpCalls(channel.id, threadId);
    await pump(sessionId);
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
    if (!live.length) return;
    const turn = rt()?.turns?.get(sessionId);
    if (turn || starting.has(sessionId)) return steerAll(sessionId, live, turn);
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
      if (!built.triggers.length) { await inbox.remove(ids); continue; }
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
    if (rec && !rec.ended) { rotateReply(rec); rec.receivedSteer = true; }
    await inbox.mark(ids, 'sent');
    if (rec && !rec.committed && cursor) rec.cursor = cursor;
    if (rec) for (const c of callers) rec.callers.set(c.botId, c);   // 渡った呼び出しの返事も、このターンの終わりに返す
    if (cursor) await updateSidecar(sessionId, (sb) => ({ ...sb, postCursor: cursor }));
    host.emitSession?.(sessionId, { type: 'channelEvent', rows: channelEventRows(text) });
  }

  /** 途中送信が実際に届いた位置で、それまでの返事を確定して次の返事の投稿を用意する。 */
  function rotateReply(rec) {
    const hasReply = rec.spoke || rec.presents.length || rec.cur.trim() || rec.last.trim() || rec.narration.trim();
    if (!hasReply || !rec.postReady) return;
    clearTimeout(rec.timer);
    rec.timer = null;
    const previous = { ...rec, presents: rec.presents, callers: rec.callers };
    const priorPost = rec.postReady;
    rec.postId = null;
    rec.cur = ''; rec.last = ''; rec.narration = '';
    rec.sawText = false; rec.sinceTool = ''; rec.lastSeg = ''; rec.sawTool = false;
    rec.presents = []; rec.spoke = false; rec.filled = false; rec.explicit = null; rec.explicitMentions = new Set();
    rec.callers = new Map();
    rec.lastWritten = PLACEHOLDER; rec.postedState = 'working'; rec.botControlled = false;
    rec.dirty = false;
    rec.postReady = rec.chain.then(async () => {
      previous.postId = await priorPost;
      try {
        const { woke, reply } = await finalizePost(previous, rec.abandoned ? 'stopped' : 'done', !rec.abandoned, { boundary: true });
        if (!rec.abandoned && woke) await route(woke, await channels.get({ channelId: rec.channelId }));
        if (!rec.abandoned && reply && previous.callers.size) await returnReply(previous, reply, woke);
      } catch (e) { log('could not finalize a reply before a steer:', errText(e)); }
      if (rec.abandoned) return null;
      const post = await channels.post({ channelId: rec.channelId, threadId: rec.threadId, text: PLACEHOLDER,
        state: rec.state, taint: rec.taint, turn: { botId: rec.botId, sessionId: rec.sessionId }, new: true }, botAuthor(rec.botId));
      if (rec.abandoned) { await channels.edit({ channelId: rec.channelId, postId: post.id, state: 'stopped' }, botAuthor(rec.botId)); return null; }
      if (rec.postReady === ready) { rec.postId = post.id; rec.postedState = rec.state; }
      if (rec.dirty || rec.cur || rec.last || rec.presents.length) progress(rec, { immediate: true });
      return post.id;
    }).catch((e) => log('could not separate replies after a steer:', errText(e)));
    const ready = rec.postReady;
    rec.chain = ready.then(() => {}, () => {});
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
    if (!built.triggers.length) { await inbox.remove(ids); return; }
    await inbox.mark(ids, 'delivering');
    starting.set(sessionId, { itemIds: ids, payloadNotes: built.payloadNotes, incomingText: built.incomingText, cursor: built.cursor, channelId: channel.id, threadId, botId: items[0].botId, callers: callersOf(items) });
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
      sessionId, botId: bot.id, kind: sb.kind, channelId, threadId: sb.threadId ?? null, taint: sb.taint, postId: null, postReady: null,
      itemIds: pre?.itemIds ?? [], cursor: pre?.cursor ?? null, tail: null, callers: new Map((pre?.callers ?? []).map((c) => [c.botId, c])),
      cur: '', last: '', narration: '', sawText: false, presents: [],
      // 最後の道具の呼び出しより後の文（sinceTool）と、道具の前で終わった最後の文（lastSeg）。最終の返答から前の独り言を外すのに使う（finalReplyText）
      sinceTool: '', lastSeg: '', sawTool: false,
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
    try {
      const tail = await memory.turnContext({ bot, session: sb, sessionId, incomingText: pre?.incomingText ?? turn.stream?.user?.text ?? '', locale: turn.agentLocale });
      rec.tail = tail;
      notes = tail.notes ?? [];
    } catch (e) { log('could not build the turn tail:', errText(e)); }
    if (sb.kind === 'thread' && !sb.recentDelivered) {
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
    if (channelId && POST_KINDS.has(sb.kind) && (sb.kind === 'dm' || rec.threadId)) {
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
        rec.sinceTool += String(event.text ?? '');
        progress(rec);
        break;
      case 'text.end':
        rec.sawText = true;
        if (rec.cur.trim()) rec.last = rec.cur;
        rec.cur = '';
        progress(rec);
        break;
      case 'tool.start':
        // 途中送信の後に見えていた返事は、後続の道具呼び出しで「…」へ戻さず、その投稿に残す。
        if (rec.receivedSteer && ((rec.lastWritten !== PLACEHOLDER && rec.lastWritten.trim()) || rec.presents.length)) rotateReply(rec);
        // 道具を呼ぶ前の文章は、最終の返事ではなく独り言。本文には出さず、出していたら「…」に戻す。終わりの本文（止めた・失敗）の控えには残す
        rec.narration = (rec.cur || rec.last || rec.narration);
        rec.cur = ''; rec.last = '';
        rec.sawTool = true;
        if (rec.sinceTool.trim()) rec.lastSeg = rec.sinceTool;
        rec.sinceTool = '';
        progress(rec);
        break;
      case 'usage':
        rec.usage = { ...rec.usage, ...event };
        progress(rec);
        break;
      case 'present':
        collectPresent(rec, event);
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

  /** ターンの投稿の本文・状態を 1 秒に 1 回まで書き換える（immediate は待たずに書く） */
  function progress(rec, { immediate = false } = {}) {
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
    // 出していた独り言を引っ込めたら、投稿は「…」に戻す（本文を持たないまま、前の本文が残らないように）
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
    await budget.charge({ channelId: rec.channelId, threadId: rec.threadId, backend: turn.info?.backend, model: turn.info?.model, usage: rec.usage })
      .catch((e) => log('could not charge the budget:', errText(e)));
    // 使用量の上限に当たった: 休憩中にして、Pleiad のお知らせを出す（bot の発言には上限の文を書かない）
    if (limited) await limitReached(rec, Number(interrupted?.resetsAt)).catch((e) => log('could not record a usage limit:', errText(e)));
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
    // 終わるまでにたまった出来事をまとめて渡す
    await pump(sessionId);
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
   * B のターンが ok で終わったとき、B を呼んだ bot（A。B の投稿の @ ・channels.post の @ で起こした側）の会話へ、B の返事を「返事」の包みで届けて A を起こす。
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

  /** ターンの投稿に最終の返答と提示を入れて state を決める。返事で ok なら { woke: @ を含む投稿（次の bot を起こすため）, reply: 確定した返事の投稿（呼んだ bot へ返すため） } */
  async function finalizePost(rec, state, ok, { limited = false, boundary = false } = {}) {
    const lng = locale();
    // bot が channels.post で自分のスレッドへ返事を書いたターンは、それが返事。最終の返答（作業の報告）は投稿に書かない（ADR 0117）
    let text = rec.spoke ? '' : (rec.cur || rec.last || rec.narration).trim();
    if (ok && rec.sawText && !rec.spoke) text = finalReplyText(rec, boundary ? null : await host.lastReply?.(rec.sessionId).catch(() => null)) || text;
    const none = { woke: null, reply: null };
    const current = await channels.getPost({ channelId: rec.channelId, postId: rec.postId }).catch(() => null);
    if (!current || current.deletedAt) return none;
    const bodyByBot = rec.filled || (current.text !== PLACEHOLDER && current.text !== rec.lastWritten);
    if (!text && state === 'failed' && !rec.filled) text = agentT(lng, 'channel.turn.failed', { error: rec.error ?? '' });
    // 使用量の上限で終わったターンは、bot の発言に「止めました」も上限の文も書かない（知らせは Pleiad の投稿。ADR 0119）。bot が書いた分は残す
    if (!text && state === 'stopped' && !bodyByBot && !rec.presents.length && !limited) text = agentT(lng, 'channel.turn.stopped');
    // 何も言わずに終わった（文章を書かずにリアクションだけ・黙ってやめる。ADR 0119）・上限で何も書けなかった: 投稿は残さない
    if (!text && !bodyByBot && !rec.presents.length && (state === 'done' || limited)) { await channels.remove({ channelId: rec.channelId, postId: rec.postId }, botAuthor(rec.botId)); return none; }
    const edit = { channelId: rec.channelId, postId: rec.postId, state };
    // bot がこのターンの投稿に付けた「要確認」（channels.post の state: 'checking'。ルーティンの実行の状態になる）は、終わりで done に戻さない
    if (state === 'done' && current.state === 'checking') edit.state = 'checking';
    if (text) edit.text = text; else if (!bodyByBot && current.text === PLACEHOLDER) edit.text = '';
    if (rec.presents.length) edit.presents = rec.presents;
    const saved = await channels.edit(edit, botAuthor(rec.botId));
    const done = ok && !rec.stopped;
    // 返事を何件かに分けて書いたなら、呼んだ bot へ返すのは最後の 1 件（その前の投稿は文脈として一緒に渡る）
    // bot が channels.post で入れた返事の @ は、書いたときに解いてある（onPosted の extra.filled）。ここで重ねて起こさない
    return { woke: done && !rec.filled && saved?.mentions?.some((m) => m !== 'you') ? saved : null, reply: done && saved ? (rec.explicit ?? saved) : null };
  }

  /**
   * 最終の返答の文。lastReply（会話の最後の AI の発言）が、最後の道具の呼び出しより後の文（無ければ道具の前で終わった最後の文）で終わるなら、その部分だけにする。
   * Antigravity は 1 ターンの文を 1 つの発言に続けて書くので、lastReply に道具の前の独り言（「Let me check the schema.」）まで入る。
   * Claude・Codex は道具の前後で発言が分かれるので、lastReply と同じになる。lastReply が無ければ流れの文
   */
  function finalReplyText(rec, reply) {
    const full = typeof reply === 'string' ? reply.trim() : '';
    const seg = (rec.sinceTool.trim() || rec.lastSeg.trim());
    if (!full) return seg;
    return rec.sawTool && seg && full !== seg && full.endsWith(seg) ? seg : full;
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
      await channels.threads.update(th.channelId, th.threadId, { state: 'idle' }).catch(() => {});
    }
    for (const ch of (await channels.list().catch(() => [])).filter((c) => c.kind === 'dm')) await stale(ch.id, null);
  }

  async function start() {
    closed = false;
    try {
      await inbox.load();
      const { sessions } = await inbox.recover();
      await recoverStale();
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
    resting.stop();
  }

  return {
    channels, bots, memory, host, emit, now, inbox,
    start, stop, onPosted, claimPost, wake, wakePost, stopThread, turnExtras, onTurnEvent, onTurnEnd, onPermission, onCompacted,
    /** テスト・診断用: 走っている bot のターンの数 */
    activeCount: () => active.size,
    /** 使用量の上限で休んでいれば解除の時刻（ms）。bots.overview の restingUntil（ADR 0119） */
    restingUntil: (bot) => resting.until(bot),
  };
}
