import { el } from './dom.mjs';
import { fmt, t } from './i18n.mjs';

const format = n => n == null ? t('usage.unknown') : fmt.number(n, { maximumFractionDigits: 1 });
export function quotaText(window, now = Date.now()) {
  const expired = window.resetsAt && new Date(window.resetsAt).getTime() <= now;
  return expired ? t('usage.expired')
    : window.usedPercent == null ? t('usage.percentUnknown')
    : t('usage.percent', { used: format(window.usedPercent), remaining: format(window.remainingPercent) });
}
function renderQuota(parent, quota, onUsageLogin) {
  if (quota.plan) parent.append(el('p', 'usage-note', t('usage.plan', { plan: quota.plan })));
  for (const w of quota.windows ?? []) {
    const row = el('div', 'usage-window');
    row.append(el('strong', null, w.label), el('span', 'usage-value', quotaText(w)));
    const expired = w.resetsAt && new Date(w.resetsAt).getTime() <= Date.now();
    if (w.usedPercent != null && !expired) {
      const meter = document.createElement('progress');
      meter.max = 100; meter.value = Math.min(100, w.usedPercent);
      meter.setAttribute('aria-label', t('usage.meter', { label: w.label }));
      row.append(meter);
    }
    row.append(el('small', 'usage-note', w.resetsAt
      ? t('usage.resetsAt', { when: fmt.dateTime(w.resetsAt) }) : t('usage.resetsUnknown')));
    parent.append(row);
  }
  for (const account of quota.accounts ?? []) {
    parent.append(el('h4', null, account.label)); renderQuota(parent, account, onUsageLogin);
  }
  if (quota.message) parent.append(el('p', 'usage-note', quota.message));
  // 登録したアカウントの使用量は、アカウントごとに「使用量の表示を認可」が済んでから読める（core/backends/claude-usage.mjs）
  if ((quota.needsUsageLogin || quota.reauth) && quota.accountId && onUsageLogin) {
    const button = el('button', 'btn', quota.needsUsageLogin ? t('accounts.authorizeUsage') : t('usage.redoAuth'));
    button.type = 'button'; button.onclick = () => onUsageLogin(quota.accountId);
    parent.append(button);
  }
}
function renderLocal(parent, local) {
  parent.append(el('h4', null, t('usage.local.title')));
  if (local.error) { parent.append(el('p', 'usage-note', local.error)); return; }
  const table = el('table', 'usage-table');
  const heading = el('tr');
  for (const label of [t('usage.local.period'), t('usage.local.input'), t('usage.local.output'), t('usage.local.cost')]) heading.append(el('th', null, label));
  const head = el('thead'); head.append(heading); table.append(head);
  const body = el('tbody');
  for (const [label, total] of [[t('usage.local.fiveHour'), local.fiveHour], [t('usage.local.sevenDay'), local.sevenDay]]) {
    const row = el('tr'); row.append(el('th', null, label));
    for (const key of ['inputTokens', 'outputTokens', 'costUsd']) {
      const metric = total[key];
      const value = !total.turns ? t('usage.local.none') : metric.value == null ? t('usage.unknown')
        : key === 'costUsd' ? `$${metric.value.toFixed(4)}` : format(metric.value);
      const cell = el('td', null, value + (metric.measured > 0 && metric.measured < total.turns ? t('usage.local.partial') : ''));
      cell.title = t('usage.local.measured', { count: total.turns, measured: metric.measured });
      row.append(cell);
    }
    body.append(row);
  }
  table.append(body); parent.append(table);
  parent.append(el('p', 'usage-note', local.since ? t('usage.local.noteSince', { when: fmt.dateTime(local.since) }) : t('usage.local.noteEmpty')));
}
/**
 * 互換の接続先ごとの見出しと「使用量は表示できません」（画面 4 の③）。枠（サブスクの使用率）は互換の先から返らない。
 * ローカル（localhost 等）は枠そのものが無い。Pleiad での使用実績はエージェントごとの表に含まれる（接続先ごとには分けていない）
 */
export function renderEndpoints(parent, endpoints) {
  if (!endpoints?.length) return;
  for (const e of endpoints) {
    parent.append(el('h4', null, t('usage.endpoint', { name: e.name })));
    let local = false;
    try { local = ['localhost', '127.0.0.1', '[::1]'].includes(new URL(e.baseUrl).hostname); } catch {}
    parent.append(el('p', 'usage-note', local ? t('usage.endpointLocal') : t('usage.endpointRemote', { name: e.name })));
  }
  parent.append(el('p', 'usage-note', t('usage.endpointCost')));
}
export function setupUsage({ $, cmd, getBackends, page, isOpen, onUsageLogin, endpoints = async () => [] }) {
  let loading = false;
  async function refresh() {
    if (loading) return;
    loading = true; $('refreshUsage').disabled = true;
    const root = $('usageCards'); root.replaceChildren();
    try {
      if (!getBackends().length) root.append(el('p', 'usage-note', t('usage.waiting')));
      await Promise.all(getBackends().map(async backend => {
        const card = el('section', 'usage-card');
        card.append(el('h3', null, backend.label), el('p', 'usage-note', t('usage.loading'))); root.append(card);
        try {
          const result = await cmd('providerUsage', { backend: backend.id });
          card.replaceChildren(el('h3', null, result.label));
          renderQuota(card, result.quota, onUsageLogin);
          if (result.quota.checkedAt) card.append(el('p', 'usage-note', t('usage.checkedAt', { when: fmt.dateTime(result.quota.checkedAt) })));
          renderEndpoints(card, await endpoints(backend.id).catch(() => []));
          renderLocal(card, result.local);
        } catch { card.replaceChildren(el('h3', null, backend.label), el('p', 'usage-note', t('usage.failed'))); }
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
