// 委譲の子が同じ Chrome プロフィール・同じサイトでログインを待つときの束ね。
// キーは hand_to_user の時点で固定する。origin が読めない依頼は束ねない。
export function createChromeLoginGroups() {
  const groups = new Map();
  return {
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
