// bot の定義の保存と操作（S2。ADR 0109）。core/ops/bots.mjs の handler は `ctx.bots` としてこれを呼ぶ。
// 形の正本は core/channels/types.mjs の Bot。bot の会話を作る部分・人格の文・フォルダーの渡し方は core/bots/sessions.mjs。
//
// createBotService({ dataDir, channels, host, emit, now }) → BotService
//   dataDir … <data>（bots.json はここ）
//   channels … ChannelService（bot を作ると DM のチャンネルを作る。createDm({ bot })。まだ無い・失敗なら dmChannelId は空のままで、
//             start()・ensureDm() が後から作る）
//   host    … createBotHost の道具（store・createConversation・getBackend・listBackends・resolveModel・resolveEffort・currentLocale・
//             runtime・usageStore）。無くても定義の保存だけは動く（会話を作る・使用量・状態は host が要る）
//   emit    … botsChanged を出す
//
// BotService（author は types.mjs の Author）:
//   start(): Promise<void>・stop(): void
//   list(): Promise<Bot[]>・get({ botId }): Promise<Bot|null>
//   byName(name): Promise<Bot|null>               … @ の解析（core/channels/mentions.mjs）が使う。名前はチャンネルを通して一意（NFKC・大小を区別しない）
//   create({ name, icon?, persona?, backend?, model?, effort? }, author): Promise<Bot>
//   update({ botId, name?, icon?, persona?, backend?, model?, effort?, folders?, sendToOthers?, sendTargets? }, author): Promise<Bot>
//                                                 … フォルダー・送る先を広げる向きは ops が guarded にする（riskOf。planUpdate().loosens）
//   planUpdate(input): Promise<{ bot, next, loosens, rows }>   … update の検査と、承認カードに出す前後。riskOf・confirm・update が同じ結果を使う
//   setMode({ botId, mode }, author): Promise<Bot>                 … 承認モード。human-only の操作から（Antigravity は 'yolo' だけ）。既存の会話の承認モードも揃える
//   remove({ botId }, author): Promise<void>      … DM のチャンネルは archive。会話は消さず、bot の印を外して Chats の一覧に戻す
//   usage({ botId }): Promise<{ weekTokens: number, cacheRatio: number|null }>   … 使用量の記録（DB の usage_records）を sessionId で引く
//   overview({ botId? }): Promise<(Bot & { usage, state })[]>      … bots.list / get の返り。state は 'working' | 'waiting' | 'idle'
//   --- S4（dispatch）・host が使う口
//   ensureDm({ botId }): Promise<Bot>             … DM のチャンネルが無ければ作る
//   ensureDmSession({ botId }): Promise<{ sessionId: string, created: boolean }>   … DM の会話（最初のターンの前に呼ぶ）。backend を変えた bot は新しく作る
//   createSession({ botId, channel, threadId, kind, routineId?, rootText? }): Promise<{ sessionId, backend, model, effort, cwd, mode }>
//                                                 … スレッド・ルーティン・学習の会話。ThreadState.sessions への登録は呼び出し側
//   turnSetup(turn): Promise<{ botInstructions, folders }|null>   … bot の会話のターンに足す人格とフォルダー（bots-host の turnExtras が足す）
//   modesOf(backendId): object|null
//   approvalOf({ botId }): Promise<{ id, name, icon, mode, label, entry }|null>   … その bot が動く承認モード（modes() のエントリ・表示名）。起こす確認の強さの比較・承認カードの文に使う
//   planCreate(input): Promise<{ mode, label, loosens }|null>   … create が作る bot の承認モード（backend の既定）と、弱くないか。create の承認カードに出す
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { inspectFile } from '../file-preview.mjs';
import { newId } from '../channels/types.mjs';
import { modePosition, scopeRank, autonomyRank } from '../modes.mjs';
import { createBotStore, BotStoreError, nameProblem, iconProblem, personaProblem, normalizeFolders, folderKey, FOLDERS_MAX, SEND_TARGETS_MAX } from './store.mjs';
import { createBotSessions, defaultMode, botTurnSetup, botInstructions } from './sessions.mjs';
import { referencedSessions, shownTo } from './send-targets.mjs';
import { looserThanDefault } from './approval.mjs';

const WEEK_MS = 7 * 24 * 3600_000;
const DEFAULT_ICON = '🤖';
const ICON_INPUT_MAX = 1024 * 1024;
const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const iconFormat = (bytes) => {
  if (bytes.length >= 8 && bytes.subarray(0, 8).equals(PNG_MAGIC)) return 'png';
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'jpg';
  if (bytes.length >= 12 && bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP') return 'webp';
  return null;
};

/** ops が OpError にする。code は INVALID（detail に理由）・BOT_NOT_FOUND・BOT_NAME_TAKEN（保存の側と同じ BotStoreError） */
const BotError = BotStoreError;
const invalid = (detail) => new BotError('INVALID', detail, { detail });

/** モードの強さの順（範囲 → 自律）。backend を変えたとき、承認モードが強くなるかの判定に使う */
const strength = (entry) => { const p = modePosition(entry); return scopeRank(p.scope) * 10 + autonomyRank(p.autonomy); };

export function createBotService({ dataDir, channels, host = null, emit = () => {}, now = Date.now } = {}) {
  const store = createBotStore({ file: path.join(dataDir ?? '', 'bots.json') });
  const sessions = host ? createBotSessions({ host, now }) : null;
  const locks = new Map();          // 同じ bot への DM の作成を重ねない
  const once = (key, fn) => { const running = locks.get(key); if (running) return running; const p = fn().finally(() => locks.delete(key)); locks.set(key, p); return p; };
  const log = (...a) => console.error('  bots:', ...a);

  const backendOf = (id) => host?.getBackend?.(id) ?? null;
  const modesOf = (id) => backendOf(id)?.modes?.() ?? null;
  const send = (event) => { try { emit(event); } catch { /* 配信の失敗で保存を巻き戻さない */ } };
  const getBot = (botId) => { const b = store.get(botId); if (!b) throw new BotError('BOT_NOT_FOUND', `no such bot: ${botId}`, { id: String(botId) }); return b; };
  const requireStore = () => { if (store.problem) throw store.problem; };
  const iconDir = path.join(dataDir, 'uploads', 'bot-icons');
  const iconUploadDir = path.join(dataDir, 'uploads', 'bot-icon-upload');
  const ownIcon = (file) => typeof file === 'string' && path.dirname(file) === iconDir;
  const removeFile = async (file) => {
    for (const delay of [0, 80, 250, 700]) {
      if (delay) await new Promise((resolve) => setTimeout(resolve, delay));
      try { await fs.unlink(file); return; }
      catch (e) { if (e.code === 'ENOENT') return; if (!['EBUSY', 'EACCES', 'EPERM'].includes(e.code)) throw e; }
    }
  };
  async function makeIcon(source, botId) {
    const { file, stat } = await inspectFile(source, { dataDir, uploadDir: path.join(dataDir, 'uploads') }).catch(() => { throw invalid('iconImage: file cannot be read'); });
    if (!stat.isFile() || !stat.size || stat.size > ICON_INPUT_MAX) throw invalid(`iconImage: image must be at most ${ICON_INPUT_MAX} bytes`);
    const buffer = await fs.readFile(file).catch(() => { throw invalid('iconImage: file cannot be read'); });
    if (!buffer.length || buffer.length > ICON_INPUT_MAX) throw invalid(`iconImage: image must be at most ${ICON_INPUT_MAX} bytes`);
    const format = iconFormat(buffer);
    if (!format) throw invalid('iconImage: PNG, JPEG or WebP image required');
    await fs.mkdir(iconDir, { recursive: true });
    const target = path.join(iconDir, `${botId}-${crypto.randomUUID()}.${format}`);
    await fs.writeFile(target, buffer, { flag: 'wx' });
    if (path.dirname(file) === iconUploadDir) await removeFile(file);
    return target;
  }
  const removeIcon = async (file) => {
    if (!ownIcon(file)) return;
    await removeFile(file);
  };

  /** bot の会話（sidecar の bot.botId が一致）の id の一覧 */
  async function sessionIdsOf(botId) {
    if (!host?.store?.getAll) return [];
    const all = await host.store.getAll();
    return Object.entries(all).filter(([, v]) => v?.bot?.botId === botId).map(([id]) => id);
  }

  async function checkFolders(list) {
    const folders = normalizeFolders(list);
    if (Array.isArray(list) && list.length > FOLDERS_MAX) throw invalid(`folders: at most ${FOLDERS_MAX}`);
    for (const f of folders) {
      if (!path.isAbsolute(f.path)) throw invalid(`folders: not an absolute path: ${f.path}`);
      const stat = await fs.stat(f.path).catch(() => null);
      if (!stat?.isDirectory()) throw invalid(`folders: not a folder: ${f.path}`);
    }
    return folders;
  }

  /** モデル・エフォートの検査（明示したものだけ。無効なら INVALID）。host が無ければ形だけ */
  async function checkModelEffort(backendId, model, effort, cwd) {
    const backend = backendOf(backendId);
    if (!host || !backend) return;
    if (model) {
      const resolved = await host.resolveModel(null, model, backend, cwd, '').catch(() => null);
      if (resolved !== model) throw invalid(`model: unknown for ${backendId}: ${model}`);
    }
    if (effort) {
      try { await host.resolveEffort(null, effort, backend, model || '', cwd, null); }
      catch (e) { throw invalid(`effort: ${String(e?.message ?? e)}`); }
    }
  }

  // 早めに断る（最終の重複の検査は store の直列化の中）
  const uniqueName = (name, exceptId = null) => {
    const hit = store.byName(name);
    if (hit && hit.id !== exceptId) throw new BotError('BOT_NAME_TAKEN', `the name is already used: ${name}`, { name });
  };

  async function ensureDm({ botId }) {
    return once(`dm:${botId}`, async () => {
      let bot = getBot(botId);
      if (bot.dmChannelId) return bot;
      if (typeof channels?.createDm !== 'function') return bot;
      let channel;
      try { channel = await channels.createDm({ bot }); }
      catch (e) { log(`cannot create the DM channel yet (${bot.name}):`, String(e?.message ?? e)); return bot; }
      if (!channel?.id) return bot;
      bot = await store.update(botId, (b) => ({ ...b, dmChannelId: channel.id, updatedAt: now() }));
      send({ type: 'botsChanged', bot });
      return bot;
    });
  }

  /** 名前を変えたら DM のチャンネルの表示名も揃える（正本は bot。S1 が断っても保存は成功） */
  async function renameDm(bot) {
    if (!bot.dmChannelId || typeof channels?.update !== 'function') return;
    try { await channels.update({ channelId: bot.dmChannelId, name: bot.name }, { kind: 'system' }); }
    catch (e) { log(`could not rename the DM channel (${bot.name}):`, String(e?.message ?? e)); }
  }

  async function syncSessions(bot) {
    if (!sessions) return;
    for (const id of await sessionIdsOf(bot.id)) await sessions.sync(id, bot).catch((e) => log('could not apply the change to a conversation:', String(e?.message ?? e)));
  }

  // ---- 使用量・状態
  async function usageFor(bot, sessionIdsByBot) {
    const ids = sessionIdsByBot.get(bot.id) ?? [];
    if (!ids.length || !host?.usageStore?.records) return { weekTokens: 0, cacheRatio: null };
    const rows = await host.usageStore.records({ sessionIds: ids, since: now() - WEEK_MS }).catch(() => []);
    let input = 0, output = 0, cached = 0;
    for (const r of rows) { input += r.inputTokens ?? 0; output += r.outputTokens ?? 0; cached += r.cachedTokens ?? 0; }
    return { weekTokens: input + output, cacheRatio: input > 0 ? Math.min(1, cached / input) : null };
  }

  async function stateByBot() {
    const out = new Map();
    const mark = async (sessionId, state) => {
      const botId = (await host.store.get(sessionId).catch(() => null))?.bot?.botId;
      if (botId && (state === 'waiting' || !out.has(botId))) out.set(botId, state);
    };
    const runtime = host?.runtime;
    for (const turn of runtime?.turns?.values?.() ?? []) { const id = turn?.info?.sessionId; if (id) await mark(id, 'working'); }
    for (const w of runtime?.waiting?.values?.() ?? []) { const id = w?.payload?.sessionId; if (id) await mark(id, 'waiting'); }
    return out;
  }

  const service = {
    dataDir, channels, emit, now,
    get problem() { return store.problem; },

    async start() {
      try { await store.load(); }
      catch (e) {
        if (e instanceof BotStoreError) { log(String(e.message)); return; }   // 読めない bots.json は上書きしない。画面へは problem で出す
        throw e;
      }
      for (const bot of store.list()) if (!bot.dmChannelId) await ensureDm({ botId: bot.id }).catch(() => {});
    },
    stop() {},

    async list() { return store.list(); },
    async get({ botId }) { return store.get(botId); },
    async byName(name) { return store.byName(name); },

    /** Trusted host path only; ops callers change the effective list through bots.update. */
    async addSendTargets({ botId, sessionIds, source }) {
      requireStore();
      const current = getBot(botId);
      const fresh = sessionIds.filter((id) => !Object.hasOwn(current.sendTargetSources ?? {}, id) && !current.sendTargets.includes(id));
      if (!fresh.length || current.sendTargets.length >= SEND_TARGETS_MAX) return current;
      const bot = await store.update(botId, (b) => {
        const sendTargets = [...b.sendTargets], sendTargetSources = { ...b.sendTargetSources };
        for (const id of fresh) {
          if (Object.hasOwn(sendTargetSources, id) || sendTargets.includes(id) || sendTargets.length >= SEND_TARGETS_MAX) continue;
          sendTargets.push(id); sendTargetSources[id] = source;
        }
        return { ...b, sendTargets, sendTargetSources, updatedAt: now() };
      });
      send({ type: 'botsChanged', bot });
      return bot;
    },

    async noteShown(post, channel) {
      const recipients = await shownTo(post, channel, channels);
      if (!recipients.length || !host?.store?.getAll) return;
      const rows = Object.entries(await host.store.getAll()).map(([id, row]) => ({ ...row, id }));
      const sessionIds = referencedSessions(post.text, rows);
      if (!sessionIds.length) return;
      for (const botId of recipients) if (store.get(botId)) await service.addSendTargets({ botId, sessionIds, source: 'shown' });
    },
    modesOf,

    async approvalOf({ botId }) {
      const bot = store.get(botId);
      if (!bot) return null;
      const modes = modesOf(bot.backend);
      const mode = modes ? (modes[bot.mode] ? bot.mode : defaultMode(modes)) : bot.mode;
      const entry = modes?.[mode];
      return { id: bot.id, name: bot.name, icon: bot.icon, mode, label: entry?.label ?? mode, entry };
    },

    async planCreate(input) {
      const backendId = input?.backend ?? host?.listBackends?.()[0]?.id ?? '';
      const modes = modesOf(backendId);
      if (!modes) return null;
      const mode = defaultMode(modes);
      return { mode, label: modes[mode]?.label ?? mode, loosens: looserThanDefault(modes[mode]) };
    },

    async create(input, _author) {
      requireStore();
      const name = String(input?.name ?? '');
      const icon = input?.icon ?? DEFAULT_ICON, persona = input?.persona ?? '';
      const problem = nameProblem(name) ?? iconProblem(icon) ?? personaProblem(persona);
      if (problem) throw invalid(problem);
      uniqueName(name);
      const backendId = input?.backend ?? host?.listBackends?.()[0]?.id ?? '';
      const backend = backendOf(backendId);
      if (host && !backend) throw invalid(`backend: unknown or disabled: ${backendId || '(none)'}`);
      if (!backendId) throw invalid('backend: required');
      await checkModelEffort(backendId, input?.model ?? '', input?.effort ?? '', os.homedir());
      const t = now();
      const id = newId('bot', t);
      const iconImage = input?.iconImage ? await makeIcon(input.iconImage, id) : '';
      let bot;
      try { bot = await store.put({
        id, name, icon, iconImage, persona, backend: backendId, model: input?.model ?? '', effort: input?.effort ?? '',
        mode: backend ? defaultMode(backend.modes()) : '', folders: [], sendToOthers: true, sendTargets: [],
        dmChannelId: '', dmSessionId: null, createdAt: t, updatedAt: t,
      });
      } catch (e) { await removeIcon(iconImage); throw e; }
      send({ type: 'botsChanged', bot });
      return await ensureDm({ botId: bot.id }).catch(() => bot);
    },

    /** update の検査。変更後の bot と、範囲を広げる向きか（承認が要るか）・承認カードの前後を返す。何も書かない */
    async planUpdate(input) {
      requireStore();
      const bot = getBot(input?.botId);
      const next = { ...bot };
      const rows = [];
      const row = (p, before, after) => rows.push({ path: p, before, after });
      const reasons = [];
      const clip = (s) => { const a = [...String(s ?? '')]; return a.length > 80 ? `${a.slice(0, 79).join('')}…` : a.join(''); };

      if (input.name !== undefined && input.name !== bot.name) {
        const problem = nameProblem(input.name);
        if (problem) throw invalid(problem);
        uniqueName(input.name, bot.id);
        next.name = input.name; row('name', bot.name, next.name);
      }
      if (input.icon !== undefined && input.icon !== bot.icon) {
        const problem = iconProblem(input.icon);
        if (problem) throw invalid(problem);
        next.icon = input.icon; row('icon', bot.icon, next.icon);
      }
      if (input.iconImage !== undefined && input.iconImage !== bot.iconImage) {
        if (input.iconImage !== null && (typeof input.iconImage !== 'string' || !path.isAbsolute(input.iconImage))) throw invalid('iconImage: absolute path or null required');
        next.iconImage = input.iconImage || '';
        row('iconImage', bot.iconImage ? path.basename(bot.iconImage) : '', next.iconImage ? path.basename(next.iconImage) : '');
      }
      if (input.persona !== undefined && input.persona !== bot.persona) {
        const problem = personaProblem(input.persona);
        if (problem) throw invalid(problem);
        next.persona = input.persona; row('persona', clip(bot.persona), clip(next.persona));
      }
      if (input.backend !== undefined && input.backend !== bot.backend) {
        const backend = backendOf(input.backend);
        if (host && !backend) throw invalid(`backend: unknown or disabled: ${input.backend}`);
        next.backend = input.backend;
        // モデルとエフォートは backend ごとの語彙。明示がなければ既定に戻す。承認モードは同じ id があれば保ち、無ければ新しい backend の既定
        next.model = ''; next.effort = '';
        const modes = backend?.modes?.();
        if (modes && !modes[bot.mode]) next.mode = defaultMode(modes);
        row('backend', bot.backend, next.backend);
        if (modes && next.mode !== bot.mode) {
          row('mode', bot.mode, next.mode);
          const before = modesOf(bot.backend)?.[bot.mode];
          if (strength(modes[next.mode]) > strength(before)) reasons.push('mode');   // 承認モードが強くなる（例: Antigravity は yolo だけ）
        }
      }
      if (input.model !== undefined && input.model !== next.model) { next.model = input.model; row('model', bot.model, next.model); }
      if (input.effort !== undefined && input.effort !== next.effort) { next.effort = input.effort; row('effort', bot.effort, next.effort); }
      if (input.model !== undefined || input.effort !== undefined || input.backend !== undefined) {
        await checkModelEffort(next.backend, next.model, next.effort, bot.folders[0]?.path ?? os.homedir());
      }
      if (input.folders !== undefined) {
        next.folders = await checkFolders(input.folders);
        const old = new Map(bot.folders.map((f) => [folderKey(f.path), f.access]));
        const widened = next.folders.some((f) => !old.has(folderKey(f.path)) || (f.access === 'rw' && old.get(folderKey(f.path)) !== 'rw'));
        if (widened) reasons.push('folders');
        const show = (list) => list.map((f) => `${f.path}${f.access === 'ro' ? ' (ro)' : ''}`).join(', ') || '-';
        if (show(bot.folders) !== show(next.folders)) row('folders', show(bot.folders), show(next.folders));
      }
      if (input.sendToOthers !== undefined && input.sendToOthers !== bot.sendToOthers) {
        next.sendToOthers = input.sendToOthers;
        if (input.sendToOthers === true) reasons.push('sendToOthers');
        row('sendToOthers', String(bot.sendToOthers), String(next.sendToOthers));
      }
      if (input.sendTargets !== undefined) {
        const targets = [...new Set(input.sendTargets)].slice(0, SEND_TARGETS_MAX);
        if (input.sendTargets.length > SEND_TARGETS_MAX) throw invalid(`sendTargets: at most ${SEND_TARGETS_MAX}`);
        next.sendTargets = targets;
        if (targets.some((id) => !bot.sendTargets.includes(id))) reasons.push('sendTargets');
        if (targets.join() !== bot.sendTargets.join()) row('sendTargets', bot.sendTargets.join(', ') || '-', targets.join(', ') || '-');
      }
      return {
        bot, next, rows, reasons, loosens: reasons.length > 0, changed: rows.length > 0,
        // 受領証の元（承認のあとに読み直して、承認した変更と同じか確かめる）
        before: { name: bot.name, icon: bot.icon, iconImage: bot.iconImage, persona: bot.persona, backend: bot.backend, model: bot.model, effort: bot.effort, mode: bot.mode,
          folders: bot.folders, sendToOthers: bot.sendToOthers, sendTargets: bot.sendTargets },
      };
    },

    async update(input, _author) {
      const plan = await service.planUpdate(input);
      if (!plan.changed) return plan.bot;
      const nameChanged = plan.next.name !== plan.bot.name;
      // 変わった欄だけを重ねる（DM の id など、検査のあとに別の操作が書いた欄を巻き戻さない）
      const patch = Object.fromEntries(Object.keys(plan.before).filter((k) => JSON.stringify(plan.next[k]) !== JSON.stringify(plan.bot[k])).map((k) => [k, plan.next[k]]));
      const oldIcon = plan.bot.iconImage;
      if (Object.hasOwn(patch, 'iconImage') && patch.iconImage) patch.iconImage = await makeIcon(patch.iconImage, plan.bot.id);
      let bot;
      try { bot = await store.update(plan.bot.id, (b) => {
        const sendTargetSources = { ...b.sendTargetSources };
        if (input.sendTargets !== undefined) {
          for (const id of b.sendTargets) sendTargetSources[id] ??= 'manual';
          for (const id of input.sendTargets) if (!b.sendTargets.includes(id)) sendTargetSources[id] = 'manual';
        }
        return { ...b, ...patch, sendTargetSources, updatedAt: now() };
      }); } catch (e) { if (patch.iconImage && patch.iconImage !== oldIcon) await removeIcon(patch.iconImage); throw e; }
      if (bot.iconImage !== oldIcon) await removeIcon(oldIcon);
      send({ type: 'botsChanged', bot });
      if (nameChanged) await renameDm(bot);
      await syncSessions(bot);
      return bot;
    },

    async setMode({ botId, mode }, _author) {
      requireStore();
      const bot = getBot(botId);
      const modes = modesOf(bot.backend);
      if (modes && !modes[mode]) throw invalid(`mode: unknown for ${bot.backend}: ${mode}`);
      // Antigravity は途中で人に聞けないので、承認モードは yolo の 1 つだけ（決定 4。modes() もそれしか持たない）
      if (bot.backend === 'antigravity' && mode !== 'yolo') throw invalid('mode: antigravity bots can only use yolo');
      if (mode === bot.mode) return bot;
      const next = await store.update(botId, (b) => ({ ...b, mode, updatedAt: now() }));
      send({ type: 'botsChanged', bot: next });
      await syncSessions(next);
      return next;
    },

    async remove({ botId }, _author) {
      requireStore();
      const bot = getBot(botId);
      const ids = await sessionIdsOf(botId);
      await store.remove(botId);
      await removeIcon(bot.iconImage);
      send({ type: 'botsChanged', removed: botId });
      if (bot.dmChannelId && typeof channels?.archive === 'function') {
        await channels.archive({ channelId: bot.dmChannelId, on: true }, { kind: 'system' }).catch((e) => log('could not archive the DM channel:', String(e?.message ?? e)));
      }
      // 会話は消さない。bot の印を外して Chats の一覧に戻す（履歴は残る）
      for (const id of ids) await host.store.setSessionData(id, 'bot', null, { durable: true }).catch(() => {});
    },

    async usage({ botId }) {
      const bot = getBot(botId);
      return usageFor(bot, new Map([[botId, await sessionIdsOf(botId)]]));
    },

    async overview({ botId } = {}) {
      const bots = botId ? [getBot(botId)] : store.list();
      const byBot = new Map();
      if (host?.store?.getAll) {
        const all = await host.store.getAll();
        for (const [id, v] of Object.entries(all)) if (v?.bot?.botId) (byBot.get(v.bot.botId) ?? byBot.set(v.bot.botId, []).get(v.bot.botId)).push(id);
      }
      const states = host?.runtime ? await stateByBot() : new Map();
      // restingUntil: 使用量の上限で休憩中なら解除の時刻（ms）。画面は作業中・あなた待ちを優先し、それ以外を「休憩中」と出す（ADR 0119）
      return Promise.all(bots.map(async (bot) => ({ ...bot, usage: await usageFor(bot, byBot), state: states.get(bot.id) ?? 'idle', restingUntil: host?.restingUntil?.(bot) ?? null,
        sendTargetDetails: await Promise.all(bot.sendTargets.map(async (sessionId) => ({ sessionId,
          title: (await host?.store?.get?.(sessionId))?.title || sessionId, source: bot.sendTargetSources?.[sessionId] ?? 'manual' }))) })));
    },

    ensureDm,

    async ensureDmSession({ botId }) {
      if (!sessions) throw new Error('bots: ensureDmSession needs the host');
      return once(`dmsession:${botId}`, async () => {
        let bot = await ensureDm({ botId });
        if (bot.dmSessionId) {
          const meta = await host.store.get(bot.dmSessionId).catch(() => null);
          if (meta?.backend === bot.backend && meta?.bot?.botId === bot.id) return { sessionId: bot.dmSessionId, created: false };
        }
        let channel = null;
        if (bot.dmChannelId && typeof channels?.get === 'function') channel = await channels.get({ channelId: bot.dmChannelId }).catch(() => null);
        channel ??= { id: bot.dmChannelId || null, kind: 'dm', name: bot.name, cwd: null };
        const made = await sessions.create({ bot, channel, threadId: null, kind: 'dm' });
        bot = await store.update(botId, (b) => ({ ...b, dmSessionId: made.sessionId, updatedAt: now() }));
        send({ type: 'botsChanged', bot });
        return { sessionId: made.sessionId, created: true };
      });
    },

    async createSession({ botId, channel = null, threadId = null, kind, routineId, rootText = '' }) {
      if (!sessions) throw new Error('bots: createSession needs the host');
      return sessions.create({ bot: getBot(botId), channel, threadId, kind, routineId, rootText });
    },

    async turnSetup(turn) {
      if (!host) return null;
      return botTurnSetup({ host, bots: service, turn });
    },
    instructions: botInstructions,
  };
  return service;
}
