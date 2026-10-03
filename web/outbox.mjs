import { t } from './i18n.mjs';
import { limitTime } from './interrupt.mjs';
import { el, svgEl, dotsIcon } from './dom.mjs';
import { whenText, leftText } from './schedule-times.mjs';

// i18n-dynamic: outbox.status.
const STATUSES = ['queued', 'sending', 'paused', 'failed', 'unknown'];
const statusLabel = (status) => (STATUSES.includes(status) ? t(`outbox.status.${status}`) : status);

// 送信待ちが何を待っているか（core/message-queue.mjs の waiting）
function queuedLabel(wait) {
  // 次のターンの設定の予約がある間は、main の返答が終わった時点（裏だけを待つ間も含む）で流れる（core/message-queue.mjs）
  if (wait?.reason === 'turn') return wait.detail === 'reserved' ? t('outbox.waitReply') : t('outbox.waitTurn');
  if (wait?.reason === 'order') return t('outbox.waitOrder');
  if (wait?.reason === 'limit') return t('outbox.waitLimit', { time: limitTime(wait.resetsAt) ?? t('interrupt.unknownTime') });
  return statusLabel('queued');
}

// 画面に出した送信予定の id。新しく増えた行だけ、下から滑り込ませる
const seenSchedules = new Set();

/**
 * 送信予定の 1 行（docs/design-system.md「送信日時の指定」）。時刻を強い字、「あと 7 時間」と本文を弱い字にして 1 行に畳む。
 * 操作は［今すぐ送る］［編集］［取り消す］。枠が 540px より狭ければ ⋯ にまとめる。
 * 時刻を過ぎても送らなかった予定（entry.held）は「9:00 を過ぎました」と理由を出し、［今すぐ送る］［取り消す］で確かめさせる。
 */
function scheduleRow(entry, actions, now) {
  const missed = Boolean(entry.held);
  const row = el('div', `sched${missed ? ' missed' : ''}`);
  row.dataset.scheduleId = entry.id;
  const when = el('span', 'when');
  const svg = svgEl('svg', { class: 'i', viewBox: '0 0 24 24', 'aria-hidden': 'true' });
  svg.append(svgEl('circle', { cx: 12, cy: 12, r: 8 }), svgEl('path', { d: 'M12 7v5l3 2' }));
  when.append(svg, document.createTextNode(missed ? t('schedule.rowMissed', { when: whenText(entry.at, now) }) : whenText(entry.at, now)));
  if (!missed) when.append(el('span', 'left', `· ${leftText(entry.at, now)}`));
  const text = el('span', 'txt', missed ? `${t('schedule.rowMissedWhy')} ${entry.args?.prompt ?? ''}` : entry.args?.prompt ?? '');
  text.title = entry.args?.prompt ?? '';
  const acts = el('span', 'acts');
  const button = (name, label, cls) => {
    const b = el('button', `btn${cls ? ` ${cls}` : ''}`, label); b.type = 'button';
    b.onclick = async () => {
      b.disabled = true;
      try { await actions[name](entry); }
      catch (e) { text.textContent = e.message; b.disabled = false; }
    };
    return b;
  };
  acts.append(button('now', t('schedule.sendNow'), 'btn-blue'), ...(missed ? [] : [button('edit', t('schedule.rowEdit'))]), button('cancel', t('schedule.rowCancel')));
  const more = el('button', 'btn more'); more.type = 'button';
  more.setAttribute('aria-label', t('schedule.rowMore')); more.setAttribute('aria-expanded', 'false');
  more.append(dotsIcon());
  more.onclick = () => { const open = row.classList.toggle('open'); more.setAttribute('aria-expanded', String(open)); };
  row.append(when, text, acts, more);
  if (!seenSchedules.has(entry.id)) {
    seenSchedules.add(entry.id);
    row.classList.add('enter');
    requestAnimationFrame(() => requestAnimationFrame(() => row.classList.remove('enter')));
  }
  return row;
}

/**
 * @param {object} [extra]
 * @param {object[]} [extra.schedules] この会話の送信予定（schedule.json の kind: 'send'。時刻順）
 * @param {{ now: Function, edit: Function, cancel: Function }} [extra.scheduleActions]
 */
export function renderOutbox(root, messages, action, shown = new Set(), { schedules = [], scheduleActions = null } = {}) {
  root.replaceChildren();
  for (const item of messages.filter(m => !['sent', 'cancelled'].includes(m.status) && !shown.has(m.id))) {
    const row = document.createElement('div');
    row.className = 'outbox-message';
    const text = document.createElement('div');
    text.className = 'outbox-text';
    text.textContent = item.args.prompt;
    const status = document.createElement('div');
    status.className = 'outbox-status';
    status.textContent = item.status === 'queued' ? queuedLabel(item.waiting) : statusLabel(item.status);
    row.append(text, status);
    if (item.error) {
      const error = document.createElement('div');
      error.className = 'outbox-status';
      error.textContent = item.error;
      row.append(error);
    }
    if (item.status === 'unknown') {
      const hint = document.createElement('div');
      hint.className = 'outbox-status';
      hint.textContent = t('outbox.unknownHint');
      row.append(hint);
    }
    for (const [name, label] of item.status === 'sending' ? [] : [
      ...(item.status !== 'queued' ? [['retry', t('outbox.retry')]] : []), ['cancel', t('outbox.cancel')],
    ]) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'btn';
      button.textContent = label;
      button.onclick = async () => {
        button.disabled = true;
        try { await action(item.id, name); }
        catch (e) { status.textContent = e.message; button.disabled = false; }
      };
      row.append(button);
    }
    root.append(row);
  }
  if (scheduleActions) {
    const now = Date.now();
    for (const entry of schedules) root.append(scheduleRow(entry, scheduleActions, now));
  }
  root.hidden = !root.children.length;
}
