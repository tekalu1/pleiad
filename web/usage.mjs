import { el } from './dom.mjs';

const format = n => n == null ? '不明' : n.toLocaleString(undefined, { maximumFractionDigits: 1 });
export function quotaText(window, now = Date.now()) {
  const expired = window.resetsAt && new Date(window.resetsAt).getTime() <= now;
  return expired ? 'リセット時刻を過ぎています・更新待ち'
    : window.usedPercent == null ? '使用率・残量: 不明'
    : `使用 ${format(window.usedPercent)}% · 残り ${format(window.remainingPercent)}%`;
}
function renderQuota(parent, quota, onUsageLogin) {
  if (quota.plan) parent.append(el('p', 'usage-note', `プラン: ${quota.plan}`));
  for (const w of quota.windows ?? []) {
    const row = el('div', 'usage-window');
    row.append(el('strong', null, w.label), el('span', 'usage-value', quotaText(w)));
    const expired = w.resetsAt && new Date(w.resetsAt).getTime() <= Date.now();
    if (w.usedPercent != null && !expired) {
      const meter = document.createElement('progress');
      meter.max = 100; meter.value = Math.min(100, w.usedPercent);
      meter.setAttribute('aria-label', `${w.label}の使用率`);
      row.append(meter);
    }
    row.append(el('small', 'usage-note', w.resetsAt
      ? `リセット: ${new Date(w.resetsAt).toLocaleString()}` : 'リセット日時: 不明'));
    parent.append(row);
  }
  for (const account of quota.accounts ?? []) {
    parent.append(el('h4', null, account.label)); renderQuota(parent, account, onUsageLogin);
  }
  if (quota.message) parent.append(el('p', 'usage-note', quota.message));
  // 登録したアカウントの使用量は、アカウントごとに「使用量の表示を認可」が済んでから読める（core/backends/claude-usage.mjs）
  if ((quota.needsUsageLogin || quota.reauth) && quota.accountId && onUsageLogin) {
    const button = el('button', 'btn', quota.needsUsageLogin ? '使用量の表示を認可' : '認可をやり直す');
    button.type = 'button'; button.onclick = () => onUsageLogin(quota.accountId);
    parent.append(button);
  }
}
function renderLocal(parent, local) {
  parent.append(el('h4', null, 'Pleiad での使用実績'));
  if (local.error) { parent.append(el('p', 'usage-note', local.error)); return; }
  const table = el('table', 'usage-table');
  const heading = el('tr');
  for (const label of ['期間', '入力 tokens', '出力 tokens', '参考費用']) heading.append(el('th', null, label));
  const head = el('thead'); head.append(heading); table.append(head);
  const body = el('tbody');
  for (const [label, total] of [['直近5時間', local.fiveHour], ['直近7日間', local.sevenDay]]) {
    const row = el('tr'); row.append(el('th', null, label));
    for (const key of ['inputTokens', 'outputTokens', 'costUsd']) {
      const metric = total[key];
      const value = !total.turns ? '記録なし' : metric.value == null ? '不明'
        : key === 'costUsd' ? `$${metric.value.toFixed(4)}` : format(metric.value);
      const cell = el('td', null, value + (metric.measured > 0 && metric.measured < total.turns ? '（一部）' : ''));
      cell.title = `${total.turns} 回の完了した実行のうち ${metric.measured} 回を計測`;
      row.append(cell);
    }
    body.append(row);
  }
  table.append(body); parent.append(table);
  parent.append(el('p', 'usage-note', `${local.since ? '記録開始: ' + new Date(local.since).toLocaleString() : 'まだ使用実績がありません'}。この機能の導入後に Pleiad で完了した実行のみ。入力はキャッシュを含みます。参考費用はエージェントの推計で、サブスクの請求額ではありません。`));
}
/**
 * 互換の接続先ごとの見出しと「使用量は表示できません」（画面 4 の③）。枠（サブスクの使用率）は互換の先から返らない。
 * ローカル（localhost 等）は枠そのものが無い。Pleiad での使用実績はエージェントごとの表に含まれる（接続先ごとには分けていない）
 */
export function renderEndpoints(parent, endpoints) {
  if (!endpoints?.length) return;
  for (const e of endpoints) {
    parent.append(el('h4', null, `接続先 ${e.name}`));
    let local = false;
    try { local = ['localhost', '127.0.0.1', '[::1]'].includes(new URL(e.baseUrl).hostname); } catch {}
    parent.append(el('p', 'usage-note', local
      ? 'この接続先の使用量は表示できません。手元で動いているため枠がありません。'
      : `この接続先の使用量は表示できません。互換の接続先は枠の情報を返さないためです。残高や請求は ${e.name} の管理画面で確認してください。`));
  }
  parent.append(el('p', 'usage-note', '互換の接続先で動かした分も「Pleiad での使用実績」に含まれます。その参考費用はモデルの単価が分からないため当てになりません。'));
}
export function setupUsage({ $, cmd, getBackends, page, isOpen, onUsageLogin, endpoints = async () => [] }) {
  let loading = false;
  async function refresh() {
    if (loading) return;
    loading = true; $('refreshUsage').disabled = true;
    const root = $('usageCards'); root.replaceChildren();
    try {
      if (!getBackends().length) root.append(el('p', 'usage-note', 'エージェントの接続を待っています。接続後に更新してください。'));
      await Promise.all(getBackends().map(async backend => {
        const card = el('section', 'usage-card');
        card.append(el('h3', null, backend.label), el('p', 'usage-note', '取得中…')); root.append(card);
        try {
          const result = await cmd('providerUsage', { backend: backend.id });
          card.replaceChildren(el('h3', null, result.label));
          renderQuota(card, result.quota, onUsageLogin);
          if (result.quota.checkedAt) card.append(el('p', 'usage-note', `最終取得: ${new Date(result.quota.checkedAt).toLocaleString()}`));
          renderEndpoints(card, await endpoints(backend.id).catch(() => []));
          renderLocal(card, result.local);
        } catch { card.replaceChildren(el('h3', null, backend.label), el('p', 'usage-note', '取得できませんでした。接続を確認して更新してください。')); }
      }));
    } finally { loading = false; $('refreshUsage').disabled = false; }
  }
  $('usageTab').onclick = () => { page('usage'); refresh(); };
  $('refreshUsage').onclick = refresh;
  const timer = setInterval(() => {
    if (isOpen() && !$('usagePanel').hidden && !document.hidden) refresh();
  }, 60_000);
  window.addEventListener('pagehide', () => clearInterval(timer), { once: true });
}
