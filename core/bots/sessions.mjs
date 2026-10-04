// bot の会話の作り方・人格の文・触れてよいフォルダーの渡し方（S2。ADR 0109）。SDK も DOM も import しない。
//
//   botInstructions(bot, locale)          … 人格の文。各バックエンドの指示の最後に足す。**決定的**（時刻・件数・順序の揺れを入れない）。
//                                            同じ bot・同じ言語なら毎ターン同じバイト列。人格・名前・アイコンを直したときだけ変わる
//   folderPlan(bot, modeEntry, cwd)       … フォルダーの渡し方（下）
//   botTurnSetup(...)                     … ターンの組み立てに足す { botInstructions, folders }（bots-host の turnExtras が使う）
//   createBotSessions({ host, now })      … bot の会話を作る。委譲の prepare（core/server.mjs）と同じ手順
//
// フォルダー: bot の `folders`（先頭が既定の作業場所）を、バックエンドごとに次のように渡す。
//   Claude        cwd 以外の全部を Agent SDK の additionalDirectories。ro は readOnlyRoots にして、Edit（Write・NotebookEdit を含む）の deny ルールで書き換えを断る
//                 （acceptEdits は cwd と追加フォルダーの編集を聞かずに通すため）。シェルの rm・mv・sed などは断れない（acceptEdits の自動承認の対象）
//   Codex         rw のうち cwd 以外を turn/start の sandboxPolicy.workspaceWrite.writableRoots（ro は書き込みに入れないだけ。cwd そのものは sandbox が常に書ける）
//   Antigravity   cwd 以外の全部を --add-dir（ワークスペースに見せるだけ。書き込みは範囲を限れない）
//   書き込みの範囲を限れないモード（modes() の scope が full。Claude の YOLO・Codex の YOLO・Antigravity の yolo）では、
//   フォルダーの選択は無効で「すべてのフォルダー」（all: true。ADR 0109・計画 §7.2-2）。Codex の full は sandbox で書き込みを
//   作業場所に限るので scope が workspace のまま、選択は有効
import path from 'node:path';
import os from 'node:os';
import { agentT } from '../i18n.mjs';
import { modePosition, scopeRank } from '../modes.mjs';
import { folderKey } from './store.mjs';
import { WORK_NOTES_VERSION } from '../brain/inner.mjs';

/** bot の名前・本人の人格・操作の要点・予算の残りの届き方。区切りは空行 1 つ、末尾の改行なし */
export function botInstructions(bot, locale) {
  const persona = String(bot?.persona ?? '').replace(/\r\n/g, '\n').trim();
  return [
    agentT(locale, 'guide.bot.heading', { icon: bot?.icon ?? '', name: bot?.name ?? '' }),
    persona || null,
    agentT(locale, 'guide.bot.tools'),
    // 黙る自由（ADR 0119）: 文章を書かずに終えたターンは投稿を残さない（core/bots/dispatch.mjs の finalizePost）
    agentT(locale, 'guide.bot.quiet'),
    // @ の無い人の投稿は、スレッドのほかの bot にも聞こえた投稿として届く（ADR 0128）。答えるかは bot が決める
    agentT(locale, 'guide.bot.heard'),
  ].filter(Boolean).join('\n\n');
}

/** 心拍の安いモデル（隠れた会話）の指示。人格は入れる（独り言の口調のもと）。投稿・道具の使い方は書かない（ADR 0126。使わせない） */
export function pulseInstructions(bot, locale) {
  const persona = String(bot?.persona ?? '').replace(/\r\n/g, '\n').trim();
  return [agentT(locale, 'guide.pulse.heading', { icon: bot?.icon ?? '', name: bot?.name ?? '' }), persona || null, agentT(locale, 'guide.pulse.rules')].filter(Boolean).join('\n\n');
}

/** そのモードが書き込みの範囲を限れないか（フォルダーを「すべて」と見せるモード）。modes() の 1 エントリで見る */
export const unrestrictedMode = (modeEntry) => scopeRank(modePosition(modeEntry).scope) >= scopeRank('full');

/**
 * フォルダーの渡し方。cwd はこのターンの作業場所（無ければ先頭のフォルダー）。
 * 返り: { all, additionalDirectories, writableRoots, readOnlyRoots }。all のときも additionalDirectories は返す（Antigravity が使う）。
 * writableRoots は all でないときの rw（cwd 以外）。Codex の sandbox が使う。readOnlyRoots は all でないときの ro（cwd 自身を含む）。Claude が編集を断るのに使う
 */
export function folderPlan(bot, modeEntry, cwd = null) {
  const folders = bot?.folders ?? [];
  const base = cwd ?? folders[0]?.path ?? null;
  const baseKey = base ? folderKey(base) : null;
  const others = folders.filter((f) => folderKey(f.path) !== baseKey);
  const all = unrestrictedMode(modeEntry);
  return {
    all,
    additionalDirectories: others.map((f) => f.path),
    writableRoots: all ? [] : others.filter((f) => f.access === 'rw').map((f) => f.path),
    readOnlyRoots: all ? [] : folders.filter((f) => f.access === 'ro').map((f) => f.path),
  };
}

/** 作業場所を決める: チャンネルの cwd が bot のフォルダーの中ならそれ（すべてのモードでは bot のフォルダーに限らない）、無ければ先頭のフォルダー、それも無ければホーム */
export function pickCwd(bot, channel, modeEntry) {
  const folders = bot?.folders ?? [];
  const wanted = channel?.cwd ? String(channel.cwd) : null;
  if (wanted) {
    if (unrestrictedMode(modeEntry) || !folders.length) return wanted;
    const inside = folders.some((f) => {
      const rel = path.relative(folderKey(f.path), folderKey(wanted));
      return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
    });
    if (inside) return wanted;
  }
  return folders[0]?.path ?? os.homedir();
}

/** 新しい bot の既定のモード: 作業場所に書けて毎回聞くもの（Claude の default・Codex の ask）。無ければ先頭（Antigravity は yolo だけ） */
export function defaultMode(modes) {
  const entries = Object.entries(modes ?? {});
  const weak = entries.find(([, m]) => { const p = modePosition(m); return p.scope === 'workspace' && p.autonomy === 'ask'; });
  return (weak ?? entries[0])?.[0] ?? 'default';
}

const clip = (s, n) => { const a = [...String(s ?? '').replace(/\s+/g, ' ').trim()]; return a.length > n ? `${a.slice(0, n).join('')}…` : a.join(''); };

/** 会話の題。通知・承認カードに出る名前: 「🦉 Owl · #checkout-perf › <根の投稿の頭>」（DM は「🦉 Owl」） */
export function sessionTitle(bot, channel, rootText) {
  const who = `${bot.icon} ${bot.name}`;
  if (!channel || channel.kind === 'dm') return who;
  const head = clip(rootText, 40);
  return `${who} · #${channel.name}${head ? ` › ${head}` : ''}`;
}

/**
 * bot の会話を作る。host は createBotHost の道具（store・createConversation・getBackend・resolveModel・resolveEffort・currentLocale）。
 *   create({ bot, channel, threadId, kind, routineId?, rootText? }) → { sessionId, backend, model, effort, cwd, mode }
 *     kind: 'thread' | 'dm' | 'routine' | 'learner'。channel は Channel（DM・スレッド。learner は null でよい）
 *     作るのは会話と sidecar（`bot`）だけ。ThreadState.sessions[botId]・Bot.dmSessionId への登録は呼び出し側（dispatch・bots service）
 *   sync(sessionId, bot) … bot の変更（承認モード・モデル・エフォート）を既存の会話へ反映する（承認モードは人が bots.setMode で決めたものに揃える）
 */
export function createBotSessions({ host, now = Date.now } = {}) {
  const lang = () => host.currentLocale?.() ?? 'ja';

  async function resolve(bot, channel, cwdHint) {
    const backend = host.getBackend(bot.backend);
    if (!backend) throw new Error(agentT(lang(), 'delegation.backendDisabled'));
    const modes = backend.modes();
    const mode = modes[bot.mode] ? bot.mode : defaultMode(modes);
    const cwd = cwdHint ?? pickCwd(bot, channel, modes[mode]);
    const model = await host.resolveModel(null, bot.model || undefined, backend, cwd, '');
    const effort = await host.resolveEffort(null, bot.effort || undefined, backend, model, cwd, null);
    return { backend, mode, cwd, model, effort };
  }

  return {
    async create({ bot, channel = null, threadId = null, kind, routineId, rootText = '', cwd: cwdHint = null }) {
      const { backend, mode, cwd, model, effort } = await resolve(bot, channel, cwdHint);
      const info = { title: sessionTitle(bot, channel, rootText), cwd, createdAt: now(), lastModified: now() };
      const sessionId = await host.createConversation(backend, info);
      const sidecar = {
        botId: bot.id, kind, channelId: channel?.id ?? null, threadId: threadId ?? null,
        ...(routineId ? { routineId } : {}),
        memRev: 0, snapshotDue: true, delivered: [], postCursor: null, workNotesVersion: WORK_NOTES_VERSION,
      };
      try {
        const { store } = host;
        await store.setMeta(sessionId, { ...info, backend: backend.id, unsent: true });
        await store.setMode(sessionId, mode); await store.setModel(sessionId, model);
        await store.setSessionData(sessionId, 'effort', effort);
        await store.setSessionData(sessionId, 'agentLocale', lang());
        await store.setSessionData(sessionId, 'bot', sidecar, { durable: true });
      } catch (e) {
        // 作りかけの会話を残さない（委譲の prepare と同じ片付け）
        const dropUnsent = host.deleteUnsent ?? (await import('../conversations.mjs')).deleteUnsentConversation;
        await dropUnsent(sessionId).catch(() => {});
        await host.store.removeSession(sessionId).catch(() => {});
        throw e;
      }
      return { sessionId, backend: backend.id, model, effort, cwd, mode };
    },

    async sync(sessionId, bot) {
      const backend = host.getBackend(bot.backend);
      const meta = await host.store.get(sessionId);
      if (!backend || meta.backend !== backend.id) return false;   // backend を変えた bot の古い会話は、次の新しい会話から（そのままにする）
      const modes = backend.modes();
      // ルーティンの会話の承認モードはルーティンの mode（core/routines/runner.mjs）。人が bot のモードを変えても、実行中・過去の実行の強さは変えない
      // 心拍の会話は読み取りのモードで作る（ADR 0126）。人が bot のモードを変えても替えない
      if (modes[bot.mode] && meta.mode !== bot.mode && meta.bot?.kind !== 'routine' && meta.bot?.kind !== 'pulse') await host.store.setMode(sessionId, bot.mode);
      const cwd = meta.cwd ?? bot.folders?.[0]?.path ?? os.homedir();
      const model = await host.resolveModel(null, bot.model || undefined, backend, cwd, '');
      if (meta.model !== model) await host.store.setModel(sessionId, model);
      const effort = await host.resolveEffort(null, bot.effort || undefined, backend, model, cwd, null);
      if (meta.effort !== effort) await host.store.setSessionData(sessionId, 'effort', effort);
      return true;
    },
  };
}

/**
 * ターンの組み立てに足すもの。bot の会話でなければ null。
 *   turn … server.mjs の Turn（info.sessionId・info.cwd・agentLocale）
 * 人格はセッションの言語（会話を作った時の agentLocale）で作る。言語は会話の間変わらないので、バイト列も変わらない
 */
export async function botTurnSetup({ host, bots, turn }) {
  const sessionId = turn?.info?.sessionId ?? null;
  if (!sessionId) return null;
  const meta = await host.store.get(sessionId);
  const botId = meta?.bot?.botId;
  if (!botId) return null;
  const bot = await bots.get({ botId });
  if (!bot) return null;
  const backend = host.getBackend(meta.backend ?? bot.backend);
  const modeEntry = backend?.modes?.()[meta.mode ?? bot.mode];
  const locale = turn.agentLocale ?? meta.agentLocale ?? host.currentLocale?.() ?? 'ja';
  if (meta.bot.kind === 'pulse') return { botInstructions: pulseInstructions(bot, locale), folders: null };
  return { botInstructions: botInstructions(bot, locale), folders: folderPlan(bot, modeEntry, turn.info?.cwd ?? meta.cwd ?? null) };
}
