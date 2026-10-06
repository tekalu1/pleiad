// Site approvals share the ordinary permission wait lifecycle (including delegation).
// 「このサイトは常に」の鍵はエージェント・origin。
// カードに「ログイン済み」（アカウント名）は出さない: Chrome の Cookie を読まないため、内蔵ブラウザーの道でも同じ形にした（ADR 0153）
export function createBrowserSiteApprovals({ getPrefs, getAgent, askPermission, remember, translate: t }) {
  const pending = new Map();
  return async function authorize({ sessionId, url }, signal) {
    let origin;
    try { const parsed = new URL(url); if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password) return { allow: false }; origin = parsed.origin; }
    catch { return { allow: false }; }
    const prefs = await getPrefs();
    if (prefs.confirmAgentSites !== true) return { allow: true };
    const agent = await getAgent(sessionId);
    if (!agent || agent.signal?.aborted || signal?.aborted) return { allow: false };
    if ((prefs.agentSitePermissions ?? []).some(row => row.agent === agent.id && row.origin === origin && row.mode === 'always')) return { allow: true };
    const key = `${sessionId}\n${agent.id}\n${origin}`;
    if (pending.has(key)) return pending.get(key);
    const work = (async () => {
      const title = t('permission.browserSite', { agent: agent.label, site: origin });
      const answer = await askPermission({ sessionId: agent.sessionId || sessionId, title, toolName: agent.label, input: { url: origin }, kind: 'tool',
        browserSite: { agent: agent.label, origin }, canAlways: true,
        signal: signal && agent.signal ? AbortSignal.any([signal, agent.signal]) : signal || agent.signal, locale: agent.locale });
      if (answer.allow && answer.always) await remember({ agent: agent.id, origin, mode: 'always' });
      return { allow: !!answer.allow, message: answer.message };
    })();
    pending.set(key, work);
    try { return await work; } finally { pending.delete(key); }
  };
}
