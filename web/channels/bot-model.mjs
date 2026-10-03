// bot のページの、DOM に触れない決まりごと（テストから直接呼ぶ。ADR 0109・docs/channels.md）。
// 画面の部品は bot-page.mjs・memory-list.mjs。

/** 読み書きの範囲を限れないモードか。範囲 full（Claude の YOLO・Antigravity の yolo・Codex の sandbox なしの yolo）だけ。
 *  Codex の「全部自動」(full) は sandbox が作業場所に書き込みを限るので、限れる扱いのまま（実際の動きと表示を合わせる。計画 §7.2-2） */
export const foldersUnlimited = (mode) => mode?.scope === 'full';

/** 承認モードの id が語彙に無いとき、その語彙の既定（default があれば default、無ければ先頭） */
export function validMode(modes, id) {
  const ids = Object.keys(modes ?? {});
  if (id in (modes ?? {})) return id;
  return ids.includes('default') ? 'default' : ids[0] ?? '';
}

/** 承認モードが 1 つしか選べないバックエンドか（Antigravity は全部自動だけ）。その 1 つの id を返す。複数あれば null */
export function onlyMode(modes) {
  const ids = Object.keys(modes ?? {});
  return ids.length === 1 ? ids[0] : null;
}

/** バックエンドを替えたときの新しい承認モード。同じ id があれば保ち、無ければ語彙の既定（bots.update の backend の動きに合わせる） */
export function modeAfterBackend(modes, current) {
  return validMode(modes, current);
}

/** トークン数の短い書き方: 1.42M・312k・980 */
export function tokensText(n) {
  const v = Number(n) || 0;
  if (v >= 1_000_000) return `${(v / 1_000_000).toFixed(2).replace(/0$/, '')}M`;
  if (v >= 10_000) return `${Math.round(v / 1000)}k`;
  if (v >= 1000) return `${(v / 1000).toFixed(1).replace(/\.0$/, '')}k`;
  return String(Math.round(v));
}

/** 今週の使用量の行の材料。cacheRatio は 0〜1 か null（読み出しが無い・分からない）。9 割を切ったら注意（提案 2.4） */
export function usageView(usage) {
  const tokens = Number(usage?.weekTokens) || 0;
  const ratio = usage?.cacheRatio;
  const cache = typeof ratio === 'number' && Number.isFinite(ratio) ? Math.round(ratio * 100) : null;
  return { tokens: tokensText(tokens), cache, warn: cache != null && cache < 90, empty: tokens === 0 };
}

/** 「M/D」。今日は null を返す（呼び出し側が「今日」と書く） */
export function shortDate(at, now = Date.now()) {
  const d = new Date(at);
  const n = new Date(now);
  if (d.getFullYear() === n.getFullYear() && d.getMonth() === n.getMonth() && d.getDate() === n.getDate()) return null;
  return `${d.getMonth() + 1}/${d.getDate()}`;
}

/** 時刻の短い書き方: 今日は「HH:MM」、ほかの日は「M/D HH:MM」 */
export function shortTime(at, now = Date.now()) {
  const d = new Date(at);
  const hm = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  const date = shortDate(at, now);
  return date ? `${date} ${hm}` : hm;
}

/**
 * 夜の記憶の整理の様子（memory.learnStatus の返り）を、記憶の見出しの下の 1 行の材料にする（ADR 0117）。
 * 返りは辞書の部品の並び [{ key, params }]（channels:memory.learn.<key>）と、目立たせるか（warn: 失敗・飛ばした）。null は出さない
 */
export function learnStatusView(status, now = Date.now()) {
  if (!status) return null;
  const parts = [];
  const result = status.lastResult;
  if (status.running) parts.push({ key: 'running' });
  else if (status.lastRunAt && result) parts.push({ key: result.changed ? 'ran' : 'ranNone', params: { when: shortTime(result.at ?? status.lastRunAt, now), n: result.changed } });
  else if (!status.lastRunAt) parts.push({ key: 'never' });
  if (result?.more) parts.push({ key: 'more' });
  if (result?.deferred) parts.push({ key: 'deferred', params: { n: result.deferred } });
  if (status.failure) parts.push({ key: 'failed', params: { error: status.failure.message } });
  if (status.skip?.count) parts.push({ key: 'skipped', params: { n: status.skip.count, reasonKey: status.skip.reason } });
  if (status.paused) parts.push({ key: 'paused' });
  else if (status.nextAt) parts.push({ key: 'next', params: { when: shortTime(status.nextAt, now) } });
  return { parts, warn: Boolean(status.failure || status.skip?.count) };
}

/** 記憶の出どころ 1 件の行き先と、字の材料。
 *  返り: { kind: 'post'|'message'|'none', where, date, target } 。target は { channelId, threadId?, postId? } か { sessionId }（開けるとき）か null */
export function sourceView(src, { channels = new Map(), bots = new Map(), sessions = new Map() } = {}, now = Date.now()) {
  if (!src) return { kind: 'none', where: '', date: null, target: null };
  const date = shortDate(src.at ?? 0, now);
  if (src.kind === 'post') {
    const ch = channels.get(src.channelId);
    const dmBot = ch?.kind === 'dm' ? bots.get(ch.botId) : null;
    return {
      kind: 'post',
      where: ch ? { type: ch.kind === 'dm' ? 'dm' : 'channel', name: ch.name, icon: dmBot?.icon ?? '' } : { type: 'channel', name: '' },
      date,
      target: src.channelId ? { channelId: src.channelId, ...(src.threadId ? { threadId: src.threadId } : {}), ...(src.postId ? { postId: src.postId } : {}) } : null,
    };
  }
  const s = sessions.get(src.sessionId);
  return { kind: 'message', where: { type: 'chat', name: s?.title ?? '' }, date, target: s ? { sessionId: src.sessionId } : null };
}

/** 作る画面の下書きの初期値。backend は呼び出し側が決める（利用できる最初のもの） */
export function newDraft(backend, modes) {
  return { name: '', icon: '🤖', persona: '', backend, model: '', effort: '', mode: validMode(modes, 'default'), isNew: true };
}

/** フォルダー 1 行の読み書きを切り替えた新しい配列（bots.update の folders は置き換え） */
export function toggleAccess(folders, path) {
  return folders.map((f) => (f.path === path ? { ...f, access: f.access === 'rw' ? 'ro' : 'rw' } : f));
}

/** フォルダーを足した新しい配列。同じパスは足さない（大文字小文字を区別せず、末尾の区切りは無視） */
export function addFolder(folders, path, access = 'rw') {
  const key = (p) => String(p).replace(/[\\/]+$/, '').toLowerCase();
  if (!path || folders.some((f) => key(f.path) === key(path))) return folders;
  return [...folders, { path, access }];
}

export const removeFolder = (folders, path) => folders.filter((f) => f.path !== path);
