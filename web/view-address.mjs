// いま見ている場所のアドレス（会話・チャンネル・スレッド・投稿・bot のページ・ルーティン）を 1 つの形にまとめる。
// 開く口（通知の一覧・脇の検索・脇の行・スレッドの開閉）はここの go() を通し、見ている場所は note() で控えて
// 再読み込みでも戻れるように localStorage へ 1 つで残す（会話は今までどおり agent-host-current にも残る）。
// アドレス: { channelId: 'home' | チャンネルの id, sessionId?, uuid?, threadId?, postId?, botId?, routineId? }
//   会話（一時チャットのスレッド）は channelId 'home' と sessionId。発言へ送るなら uuid。
//   スレッドは channelId と threadId。投稿へ送るなら postId。bot のページは botId、ルーティンは routineId。
// web/view-state.mjs（バックグラウンドの詳細の開閉の引き継ぎ）とは別物。
export const HOME = 'home';
export const VIEW_KEY = 'agent-host-view';
const LEGACY_SESSION_KEY = 'agent-host-current';

const str = (v) => (typeof v === 'string' && v ? v : null);

/**
 * いろいろな形の行き先を 1 つの形にする。受けるもの: アドレスそのもの・通知の一覧の target（{ sessionId, uuid } / { channelId, threadId, postId }）・
 * channels:show の detail（{ kind: 'channel'|'bot'|'routine', id, threadId?, postId? }）。わからなければ null
 */
export function toAddress(input) {
  if (!input || typeof input !== 'object') return null;
  if (input.kind === 'bot' && str(input.id)) return { botId: input.id };
  if (input.kind === 'routine' && str(input.id)) return { routineId: input.id };
  if (input.kind === 'channel' && str(input.id)) input = { channelId: input.id, threadId: input.threadId, postId: input.postId };
  if (str(input.botId)) return { botId: input.botId };
  if (str(input.routineId)) return { routineId: input.routineId };
  if (str(input.sessionId)) return { channelId: HOME, sessionId: input.sessionId, ...(str(input.uuid) ? { uuid: input.uuid } : {}) };
  const channelId = str(input.channelId);
  if (!channelId || channelId === HOME) return channelId ? { channelId: HOME } : null;
  return { channelId, ...(str(input.threadId) ? { threadId: input.threadId } : {}), ...(str(input.postId) ? { postId: input.postId } : {}) };
}

/** 会話（一時チャットのスレッド）のアドレスか */
export const isSession = (a) => Boolean(a?.sessionId);

/** チャンネルの面で開くアドレスを channels:show の detail にする。会話なら null */
export function toShowDetail(a) {
  if (!a) return null;
  if (a.botId) return { kind: 'bot', id: a.botId };
  if (a.routineId) return { kind: 'routine', id: a.routineId };
  if (isSession(a) || !a.channelId || a.channelId === HOME) return null;
  return { kind: 'channel', id: a.channelId, ...(a.threadId ? { threadId: a.threadId } : {}), ...(a.postId ? { postId: a.postId } : {}) };
}

/** 残す形（着いた後に送る先 uuid・postId は残さない: 再読み込みで同じ発言へ送り直さない） */
export function storedAddress(a) {
  if (!a) return null;
  const { uuid, postId, ...rest } = a;
  return rest;
}

/** 同じ場所か（送る先の uuid・postId は見ない） */
export function sameAddress(a, b) {
  return JSON.stringify(storedAddress(a)) === JSON.stringify(storedAddress(b));
}

/** 残したアドレスを読む。無ければ前の版の「開いていた会話」から作る */
export function readAddress(storage) {
  try {
    const saved = toAddress(JSON.parse(storage.getItem(VIEW_KEY) ?? 'null'));
    if (saved) return saved;
  } catch { /* 壊れていたら前の版の印へ */ }
  try {
    const id = storage.getItem(LEGACY_SESSION_KEY);
    return id ? { channelId: HOME, sessionId: id } : null;
  } catch { return null; }
}

/**
 * @param {object} o
 * @param {Storage} o.storage
 * @param {(a: { sessionId: string, uuid?: string }) => any} o.openSession 会話を開く（uuid があればその発言へ送る）
 * @param {(detail: object) => any} o.openChannels チャンネルの面で開く（channels:show の detail）
 */
export function createViewAddress({ storage, openSession, openChannels }) {
  let current = null;
  const save = () => { try { storage.setItem(VIEW_KEY, JSON.stringify(storedAddress(current))); } catch { /* 覚えられなくても開ける */ } };
  return {
    get current() { return current; },
    /** 行き先へ開く。開けないもの（形がわからない）は何もしない */
    go(input) {
      const a = toAddress(input);
      if (!a) return undefined;
      if (isSession(a)) return openSession(a);
      const detail = toShowDetail(a);
      return detail ? openChannels(detail) : undefined;
    },
    /** 見ている場所が替わった（開いた側が知らせる）。残す */
    note(input) {
      const a = toAddress(input);
      if (!a || sameAddress(a, current)) return;
      current = storedAddress(a);
      save();
    },
  };
}
