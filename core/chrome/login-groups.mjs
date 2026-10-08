// 委譲の子が同じ Chrome プロフィール・同じサイトでログインを待つときの束ね。
// キーは hand_to_user の時点で固定する。origin が読めない依頼は束ねない。
const KEYS_MAX = 50;
const profileOk = profile => profile && typeof profile.browser === 'string' && typeof profile.dir === 'string' && profile.browser.length <= 40 && profile.dir.length <= 200;

/** @param [options.changed] 更新を越える預かり物（snapshot）が変わった */
export function createChromeLoginGroups({ changed = () => {} } = {}) {
  const groups = new Map();
  // 待っている子ごとの、束ねの鍵の材料（選んだプロフィールと開いているサイト）。更新の後に承認を出し直すとき、中継の窓の記録がまだ戻っていなくても同じ束ねに入れる
  const keys = new Map();
  return {
    /** 待ち始めた子の鍵の材料を覚える（更新を越えて持ち越す） */
    remember(sessionId, { profile, origin }) {
      if (!sessionId || !profileOk(profile) || !/^https?:\/\//.test(origin ?? '')) return;
      if (!keys.has(sessionId) && keys.size >= KEYS_MAX) return;
      keys.set(sessionId, { profile: { browser: profile.browser, dir: profile.dir }, origin });
      changed();
    },
    recall: sessionId => keys.get(sessionId) ?? null,
    /** 待ちが決着した・中断された */
    forget(sessionId) { if (keys.delete(sessionId)) changed(); },
    snapshot: () => [...keys].map(([sessionId, value]) => ({ sessionId, ...value })),
    restore(list) {
      for (const item of Array.isArray(list) ? list : []) {
        if (typeof item?.sessionId !== 'string' || !item.sessionId || item.sessionId.length > 200 || keys.has(item.sessionId) || !profileOk(item.profile) || !/^https?:\/\//.test(item.origin ?? '') || String(item.origin).length > 2000 || keys.size >= KEYS_MAX) continue;
        keys.set(item.sessionId, { profile: { browser: item.profile.browser, dir: item.profile.dir }, origin: item.origin });
      }
    },
    key({ parent, profile, origin, reason }) {
      return reason === 'login' && parent && profile?.browser && profile?.dir && /^https?:\/\//.test(origin ?? '')
        ? JSON.stringify([parent, profile.browser, profile.dir, origin]) : null;
    },
    prepare(key) {
      if (!key) return { group: null, joined: false };
      const existing = groups.get(key);
      if (existing) return { group: existing, joined: true };
      const group = { members: new Map(), parentCardId: null };
      groups.set(key, group);
      return { group, joined: false };
    },
    /** カードに出す待ちの一覧。操作に開く窓（target）の子に current を付ける（どの子の窓かが分かるように） */
    tasks(group, target) {
      return [...group.members.values()].map(({ sessionId, taskId, title }) => ({ taskId, title, current: sessionId === target }));
    },
    finish(key, group, sessionId, answer) {
      if (!key || groups.get(key) !== group) return null;
      if (answer?.allow === true || answer?.messageKey === 'userDenied') {
        groups.delete(key);
        for (const member of group.members.values()) if (member.sessionId !== sessionId) member.settle(answer);
        return null;
      }
      group.members.delete(sessionId);
      if (!group.members.size) { groups.delete(key); return null; }
      return group.members.values().next().value;
    },
  };
}
