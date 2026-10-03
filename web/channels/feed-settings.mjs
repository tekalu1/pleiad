// チャンネルのメモ・設定（見出しの ⋯ から。channels.update / channels.archive）。予算（ADR 0119）は channels.get が既定を埋めた budget と今日の spentToday を見せる。
// 追加・編集のシートと同じ白い <dialog>（docs/design-system.md「追加・編集のシート」）。メンバーは「一覧に載る bot」で、起こすには投稿の @ が要る。
import { el } from '../dom.mjs';
import { t } from '../i18n.mjs';

const field = (label, control, hint) => {
  const wrap = el('label', 'cs-field');
  wrap.append(el('span', 'cs-label', label), control);
  if (hint) wrap.append(el('span', 'cs-hint', hint));
  return wrap;
};
const numberInput = (value, min, max, label) => {
  const i = el('input', 'cs-input');
  i.type = 'number';
  i.min = String(min);
  i.max = String(max);
  i.step = '0.1';
  i.inputMode = 'decimal';
  i.value = value ?? '';
  i.setAttribute('aria-label', label);
  return i;
};
const textInput = (value, max) => {
  const i = el('input', 'cs-input');
  i.type = 'text';
  i.value = value ?? '';
  i.maxLength = max;
  return i;
};

/**
 * @param {object} o
 * @param {object} o.host
 * @param {object} o.channel Channel
 * @param {object[]} o.bots bots.list の定義
 * @param {(channel: object) => void} [o.onSaved] 保存・アーカイブの結果（channelsChanged の出来事でも画面は更新される）
 * @param {HTMLElement} [o.returnTo] 閉じたときにフォーカスを返す先
 */
export function openChannelSettings({ host, channel, bots, onSaved = () => {}, returnTo }) {
  const dlg = el('dialog', 'ch-settings');
  dlg.setAttribute('aria-labelledby', 'chSettingsTitle');
  const form = el('form', 'cs-form');
  form.method = 'dialog';
  const title = el('h2', 'cs-title', t('channels:feed.settings.title', { name: channel.name }));
  title.id = 'chSettingsTitle';
  form.append(title);

  const isDm = channel.kind === 'dm';
  const name = textInput(channel.name, 60);
  const purpose = textInput(channel.purpose, 300);
  const cwd = textInput(channel.cwd ?? '', 1000);
  const memo = el('textarea', 'cs-input cs-memo');
  memo.rows = 5;
  memo.maxLength = 4000;
  memo.value = channel.memo ?? '';
  const members = new Set(channel.members ?? []);
  if (!isDm) {
    form.append(field(t('channels:feed.settings.name'), name), field(t('channels:feed.settings.purpose'), purpose),
      field(t('channels:feed.settings.cwd'), cwd, t('channels:feed.settings.cwdHint')));
    const list = el('div', 'cs-members');
    for (const bot of bots) {
      const row = el('label', 'cs-member');
      const box = el('input');
      box.type = 'checkbox';
      box.checked = members.has(bot.id);
      box.onchange = () => (box.checked ? members.add(bot.id) : members.delete(bot.id));
      row.append(box, el('span', 'cs-member-icon', bot.icon), el('span', 'cs-member-name', bot.name));
      list.append(row);
    }
    if (!bots.length) list.append(el('span', 'cs-hint', t('channels:feed.settings.noBots')));
    const wrap = el('div', 'cs-field');
    wrap.append(el('span', 'cs-label', t('channels:feed.settings.members')), list, el('span', 'cs-hint', t('channels:feed.settings.membersHint')));
    form.append(wrap);
  }
  // 予算: 1 日（週の使用枠に対する %。空なら予算なし）と 1 スレッドまで（1 日に対する %）
  let daily = null, perThread = null;
  if (!isDm) {
    const budget = channel.budget ?? {};
    daily = numberInput(budget.daily, 0, 100, t('channels:feed.settings.budgetDailyLabel'));
    perThread = numberInput(budget.perThread, 1, 100, t('channels:feed.settings.budgetPerThreadLabel'));
    const row = el('div', 'cs-budget');
    row.append(el('span', null, t('channels:feed.settings.budgetDaily')), daily, el('span', null, '%'),
      el('span', 'cs-budget-gap', t('channels:feed.settings.budgetPerThread')), perThread, el('span', null, '%'));
    const wrap = el('div', 'cs-field');
    const spent = Math.round((Number(channel.spentToday) || 0) * 100) / 100;
    wrap.append(el('span', 'cs-label', t('channels:feed.settings.budget')), row,
      el('span', 'cs-hint', `${t('channels:feed.settings.budgetHint')} ${t('channels:feed.settings.budgetToday', { spent })}`));
    form.append(wrap);
  }
  form.append(field(t('channels:feed.settings.memo'), memo, t('channels:feed.settings.memoHint')));

  const error = el('p', 'cs-error');
  error.setAttribute('role', 'alert');
  const actions = el('div', 'cs-actions');
  const archive = el('button', 'btn btn-quiet cs-archive', channel.archivedAt ? t('channels:feed.settings.unarchive') : t('channels:feed.settings.archive'));
  archive.type = 'button';
  const cancel = el('button', 'btn btn-quiet', t('channels:feed.settings.cancel'));
  cancel.type = 'button';
  const save = el('button', 'btn btn-primary', t('channels:feed.settings.save'));
  save.type = 'submit';
  actions.append(...(isDm ? [] : [archive]), el('span', 'cs-sp'), cancel, save);
  form.append(error, actions);
  dlg.append(form);
  document.body.append(dlg);

  const close = () => { dlg.close(); };
  dlg.addEventListener('close', () => { dlg.remove(); returnTo?.focus?.({ preventScroll: true }); });
  dlg.addEventListener('click', (e) => { if (e.target === dlg) close(); });   // 背後の押下
  cancel.onclick = close;

  const run = async (fn) => {
    error.textContent = '';
    save.disabled = archive.disabled = true;
    try { onSaved(await fn()); close(); }
    catch (err) { error.textContent = t('channels:feed.settings.failed', { error: err?.message ?? String(err) }); }
    finally { save.disabled = archive.disabled = false; }
  };
  archive.onclick = () => run(() => host.invoke('channels.archive', { channelId: channel.id, on: !channel.archivedAt }));
  form.onsubmit = (e) => {
    e.preventDefault();
    const args = { channelId: channel.id, memo: memo.value };
    if (!isDm) {
      Object.assign(args, { name: name.value.trim() || channel.name, purpose: purpose.value, cwd: cwd.value.trim() || null, members: [...members],
        budget: { daily: daily.value.trim() === '' ? null : Number(daily.value), perThread: Number(perThread.value) } });
    }
    run(() => host.invoke('channels.update', args));
  };
  dlg.showModal();
  (isDm ? memo : name).focus();
  return dlg;
}
