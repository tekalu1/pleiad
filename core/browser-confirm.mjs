// Site approvals share the ordinary permission wait lifecycle (including delegation).
// 鍵はエージェント・プロフィール・origin（ADR 0077）。プロフィールを持たない古い「このサイトは常に」はメインのものとして読む。
// 確認の文には、プロフィールが 2 つ以上あるときだけ「プロフィール: <名前>」を添える（1 つなら見分ける必要が無い）
import { siteProfile, MAIN_PROFILE, profileList } from '../web/browser-profiles.mjs';

export function createBrowserSiteApprovals({ getPrefs, getAgent, askPermission, remember, translate: t, profileLabel = async id => id }) {
  const pending = new Map();
  return async function authorize({ sessionId, url, account, profile: rawProfile }, signal) {
    let origin;
    try { const parsed = new URL(url); if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password) return { allow: false }; origin = parsed.origin; }
    catch { return { allow: false }; }
    const prefs = await getPrefs();
    if (prefs.confirmAgentSites !== true) return { allow: true };
    const agent = await getAgent(sessionId);
    if (!agent || agent.signal?.aborted || signal?.aborted) return { allow: false };
    const profile = siteProfile({ profile: rawProfile });
    if ((prefs.agentSitePermissions ?? []).some(row => row.agent === agent.id && row.origin === origin && siteProfile(row) === profile && row.mode === 'always')) return { allow: true };
    const key = `${sessionId}\n${agent.id}\n${profile}\n${origin}`;
    if (pending.has(key)) return pending.get(key);
    const work = (async () => {
      const many = profileList(prefs).length > 1;
      const name = many ? await profileLabel(profile, agent.locale) : null;
      const notes = [name ? t('permission.browserProfile', { profile: name }) : null, account ? t('permission.browserAccountName', { account: String(account).slice(0, 200) }) : null].filter(Boolean);
      const title = t('permission.browserSite', { agent: agent.label, site: origin }) + (notes.length ? t('permission.browserNotes', { notes: notes.join(' · ') }) : '');
      const answer = await askPermission({ sessionId: agent.sessionId || sessionId, title, toolName: agent.label, input: { url: origin }, kind: 'tool',
        browserSite: { agent: agent.label, origin, ...(account ? { account } : {}), ...(name ? { profile: name } : {}) }, canAlways: true,
        signal: signal && agent.signal ? AbortSignal.any([signal, agent.signal]) : signal || agent.signal, locale: agent.locale });
      if (answer.allow && answer.always) await remember({ agent: agent.id, origin, mode: 'always', ...(profile !== MAIN_PROFILE ? { profile } : {}) });
      return { allow: !!answer.allow, message: answer.message };
    })();
    pending.set(key, work);
    try { return await work; } finally { pending.delete(key); }
  };
}
