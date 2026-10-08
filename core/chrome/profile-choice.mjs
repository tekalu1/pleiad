// 会話の Chrome のプロフィール（docs/inapp-browser.md「プロフィール」、第 10 段）。
// 会話のメタの chromeProfile（{ browser, dir }）に持ち、窓を開くとき（core/chrome/windows.mjs の profileFor）に引く。
//   - 新しい会話は、設定の chromeNewProfile（一覧にまだあるもの）で始まる。id が決まるまでは仮の id（ターンの key）で持ち、rebind で本物へ移す
//   - 選んでいない会話は今まで通り Chrome の最後に使ったプロフィールで最初の窓を開き、そのプロフィールを used で会話に覚える
//   - 切り替えは一覧にあるプロフィールだけ（知らないフォルダー名を --profile-directory に渡さない）。切り替えても開いている窓は閉じず、次に開く窓から効く
//   - エージェントが操作中（人の画面・端末から）・人への依頼の待ち・人が引き継いでいる間は断る（code: BUSY、reason: operating | waiting | human）
//   - エージェントが切り替えたら会話に 1 行残す（present kind: 'chromeProfile'）
import { validProfileRef, profileKey } from '../../web/chrome-profile-model.mjs';

export class ProfileChoiceError extends Error {
  /** @param {'BUSY' | 'NOT_FOUND' | 'AMBIGUOUS' | 'UNSUPPORTED'} code */
  constructor(code, detail = {}) { super(code); this.code = code; this.detail = detail; }
}

const PENDING_MAX = 50;
const sameRef = (a, b) => !!a && !!b && a.browser === b.browser && a.dir === b.dir;

/**
 * @param {object} deps
 * @param deps.list      () → Promise<{ browser, dir, name }[]>（core/chrome/profiles.mjs の listBrowserProfiles。開けるブラウザーだけ）
 * @param deps.peek      会話の id → 会話のメタ（同期。読み込み前・無ければ null。core/store.mjs の peek）
 * @param deps.save      (会話の id, { browser, dir }) → Promise（会話のメタの chromeProfile に書く）
 * @param deps.getPrefs  () → Promise<prefs>（chromeNewProfile・chromeProfileNotes）
 * @param [deps.control]  core/chrome/control.mjs（state(id).state: running | idle | stopped | paused）
 * @param [deps.handoffs] core/chrome/handoff.mjs（current(id) が人への依頼の待ち）
 * @param [deps.changed]  仮の id の選択（メモリだけにある分）が変わった（更新を越える預かり物を預け直す。pending）
 * @param [deps.record]   エージェントが切り替えたときの会話の行（({ sessionId, profile: { browser, dir, name }, agent }) → Promise）
 */
export function createProfileChoice({ list, peek, save, getPrefs, control = null, handoffs = null, operating = () => false, record = async () => {}, changed = () => {}, log = () => {} }) {
  const chosen = new Map();    // 会話の id -> { browser, dir }（メタへの書き込みを待たずに引く。仮の id もここ）

  function current(sessionId) {
    if (!sessionId) return null;
    if (chosen.has(sessionId)) return chosen.get(sessionId);
    const meta = peek(sessionId)?.chromeProfile;
    return validProfileRef(meta) ? { browser: meta.browser, dir: meta.dir } : null;
  }

  /** 切り替えられない理由。エージェント自身の会話のターン（running）はエージェントの切り替えを止めない */
  function busyOf(sessionId, by) {
    if (handoffs?.current(sessionId)) return 'waiting';
    const state = control?.state(sessionId)?.state;
    if (state === 'paused') return 'human';
    if (operating(sessionId) || (state === 'running' && by !== 'agent')) return 'operating';
    return null;
  }

  async function remember(sessionId, ref) {
    chosen.set(sessionId, ref);
    try { if (peek(sessionId)) await save(sessionId, ref); }
    catch (error) { log(`chrome-profile: saving failed: ${error?.message ?? error}`); }   // 仮の id は書けない（rebind で書く）
    changed();
  }

  /** 一覧から 1 つ選ぶ。profile はフォルダー名か表示名（フォルダー名が先）。browser を省けばどのブラウザーからでも */
  function pick(profiles, browser, profile) {
    const pool = browser ? profiles.filter(p => p.browser === browser) : profiles;
    const byDir = pool.filter(p => p.dir === profile);
    if (byDir.length === 1) return byDir[0];
    const folded = String(profile).trim().toLowerCase();
    const byName = byDir.length ? byDir : pool.filter(p => p.name.toLowerCase() === folded);
    if (byName.length === 1) return byName[0];
    throw new ProfileChoiceError(byName.length ? 'AMBIGUOUS' : 'NOT_FOUND', { profile: String(profile).slice(0, 100) });
  }

  return {
    current,
    busyOf,
    /** 会話の一覧の答え: { profiles: [{ browser, dir, name, note }], current, busy } */
    async list({ sessionId = null, by = 'human' } = {}) {
      const [profiles, prefs] = await Promise.all([list(), getPrefs()]);
      const notes = Array.isArray(prefs.chromeProfileNotes) ? prefs.chromeProfileNotes : [];
      const noteOf = p => notes.find(row => row && profileKey(row) === profileKey(p))?.note ?? '';
      return {
        profiles: profiles.map(p => ({ ...p, note: noteOf(p) })),
        current: sessionId ? current(sessionId) : null,
        busy: sessionId ? busyOf(sessionId, by) : null,
      };
    },
    /**
     * 会話のプロフィールを切り替える。by: 'agent' のときは agent（表示名）を会話の行に載せる。
     * @returns {Promise<{ browser, dir, name, changed: boolean }>}
     */
    async use({ sessionId, browser = null, profile, by = 'human', agent = null }) {
      const busy = busyOf(sessionId, by);
      if (busy) throw new ProfileChoiceError('BUSY', { reason: busy });
      const target = pick(await list(), browser, profile);
      const afterRead = busyOf(sessionId, by);
      if (afterRead) throw new ProfileChoiceError('BUSY', { reason: afterRead });
      const ref = { browser: target.browser, dir: target.dir };
      const before = current(sessionId);
      if (sameRef(before, ref)) return { ...ref, name: target.name, changed: false };
      await remember(sessionId, ref);
      if (by === 'agent') {
        try { await record({ sessionId, profile: { ...ref, name: target.name }, agent }); }
        catch (error) { log(`chrome-profile: recording the switch failed: ${error?.message ?? error}`); }
      }
      return { ...ref, name: target.name, changed: true };
    },
    /** 新しい会話（仮の id）を始めるとき: 設定の chromeNewProfile が一覧にあれば、その会話のプロフィールにする */
    async startNew(tempId) {
      if (!tempId || current(tempId)) return;
      const want = (await getPrefs()).chromeNewProfile;
      if (!validProfileRef(want)) return;
      if (!(await list()).some(p => sameRef(p, want))) return;   // 消したプロフィールは選ばない（今まで通り最後に使ったもの）
      await remember(tempId, { browser: want.browser, dir: want.dir });
    },
    /** 委譲の子は作成時点の親の選択を写す。親が未選択なら新しい会話の既定を使う。 */
    async inherit(parentId, childId) {
      if (!childId || current(childId)) return;
      const parent = current(parentId);
      if (parent) await remember(childId, { ...parent });
      else await this.startNew(childId);
    },
    /** windows.mjs の profileFor */
    profileFor: sessionId => current(sessionId),
    /** 本物の会話メタができた後に、仮 id から移した選択を保存する */
    async flush(sessionId) {
      const ref = current(sessionId);
      if (ref) await save(sessionId, ref);
    },
    /** windows.mjs の profileUsed: 選んでいない会話の最初の窓のプロフィールを覚える */
    used(sessionId, ref) {
      if (!validProfileRef(ref) || current(sessionId)) return;
      void remember(sessionId, { browser: ref.browser, dir: ref.dir });
    },
    /** 新しい会話の id が決まった（仮の id → 本物）。仮の id の分を本物のメタに書く */
    rebind(from, to) {
      if (!from || !to || from === to || !chosen.has(from)) return;
      const ref = chosen.get(from);
      chosen.delete(from);
      if (!current(to)) void remember(to, ref); else changed();
    },
    /** 会話を消した・ターンが id を持たずに終わった */
    forget(sessionId) { if (chosen.delete(sessionId)) changed(); },
    /**
     * 更新を越えて持ち越す分: まだ会話のメタに書けていない選択（仮の id のもの）。メモリにしか無いので、新しいサーバーへ渡さないと
     * 付け直したターンの窓が、選んだプロフィールでなく「最後に使ったもの」で開く。数を絞る
     */
    pending() {
      const out = [];
      for (const [id, ref] of chosen) if (!peek(id) && out.length < PENDING_MAX) out.push({ id, browser: ref.browser, dir: ref.dir });
      return out;
    },
    /** pending() の写しを受ける（前のサーバーの預かり物。既にある選択は上書きしない） */
    restorePending(list) {
      for (const item of Array.isArray(list) ? list : []) {
        if (typeof item?.id !== 'string' || !item.id || item.id.length > 200 || chosen.has(item.id) || !validProfileRef({ browser: item.browser, dir: item.dir })) continue;
        chosen.set(item.id, { browser: item.browser, dir: item.dir });
      }
    },
  };
}
